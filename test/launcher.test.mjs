import assert from "node:assert/strict";
import test from "node:test";

import {
  addUnityRoutingTargetToTool,
  commandToTool,
  discoverUnityProjectRoots,
  isReadOnlyPipelineCommand,
  normalizeUnityProjectRoot,
  openLivePipeline,
  resolveUnityProjectRoot,
  pipelineCommandName,
  pipelineResponseToToolResult,
  selectUnityRoute,
  splitUnityRoutingArguments,
  unityProjectPathWithinRoot,
  unityToolName,
  validatePipelineDescriptor
} from "../src/contextforge-unity.mjs";

function fakeResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() {
      return JSON.stringify(payload);
    }
  };
}

const ROOT = "C:\\Unity Projects\\My Project";

test("normalizes Unity project roots", () => {
  assert.equal(
    normalizeUnityProjectRoot("C:\\Unity Projects\\My Project\\"),
    ROOT
  );
  assert.equal(normalizeUnityProjectRoot("relative"), null);
});

test("requires an explicit ContextForge project-root binding", () => {
  assert.equal(resolveUnityProjectRoot({ configuredRoot: ROOT }), ROOT);
  assert.throws(
    () => resolveUnityProjectRoot({ configuredRoot: "" }),
    /requires CONTEXTFORGE_UNITY_PROJECT_ROOT/
  );
});

test("discovers Unity projects inside a ContextForge workspace without descending into project internals", async () => {
  const WORKSPACE = "C:\\Workspace";
  const tree = new Map([
    [WORKSPACE.toLowerCase(), ["GameA", "Group", "node_modules"]],
    ["c:\\workspace\\gamea", ["Assets", "ProjectSettings", "Library"]],
    ["c:\\workspace\\group", ["GameB"]],
    ["c:\\workspace\\group\\gameb", ["Assets", "ProjectSettings"]],
    ["c:\\workspace\\node_modules", ["ShouldNotBeVisited"]]
  ]);
  const visited = [];
  const roots = await discoverUnityProjectRoots(WORKSPACE, {
    readdirImpl: async (directory) => {
      visited.push(directory.toLowerCase());
      return (tree.get(directory.toLowerCase()) ?? []).map((name) => ({
        name,
        isDirectory: () => true
      }));
    }
  });

  assert.deepEqual(roots, [
    "C:\\Workspace\\GameA",
    "C:\\Workspace\\Group\\GameB"
  ]);
  assert.equal(visited.includes("c:\\workspace\\gamea\\library"), false);
  assert.equal(visited.includes("c:\\workspace\\node_modules"), false);
});

test("routes calls by Unity project identity and strips adapter metadata", () => {
  const scope = "C:\\Workspace";
  const gameA = { descriptor: { projectPath: "C:\\Workspace\\GameA", port: 7801 } };
  const gameB = { descriptor: { projectPath: "C:\\Workspace\\GameB", port: 7802 } };
  const routes = [gameA, gameB];

  assert.equal(unityProjectPathWithinRoot(gameA.descriptor.projectPath, scope), true);
  assert.throws(() => selectUnityRoute(routes, null, scope), /UNITY_TARGET_REQUIRED/);
  assert.equal(
    selectUnityRoute(
      routes,
      { projectPath: gameB.descriptor.projectPath, port: 7802 },
      scope
    ),
    gameB
  );
  assert.equal(selectUnityRoute(routes, null, gameA.descriptor.projectPath), gameA);

  const split = splitUnityRoutingArguments({
    tail: 20,
    _contextforgeUnity: { projectPath: gameB.descriptor.projectPath }
  });
  assert.deepEqual(split.arguments, { tail: 20 });
  assert.equal(split.target.projectPath, gameB.descriptor.projectPath);

  const routedTool = addUnityRoutingTargetToTool({
    name: "Unity_console",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  });
  assert.equal(
    routedTool.inputSchema.properties._contextforgeUnity.required[0],
    "projectPath"
  );
});

test("validates Pipeline descriptor project identity", () => {
  const descriptor = validatePipelineDescriptor(
    {
      pid: 123,
      port: 7802,
      projectPath: ROOT,
      evalToken: "1234567890abcdef"
    },
    ROOT
  );
  assert.equal(descriptor.port, 7802);

  assert.throws(
    () =>
      validatePipelineDescriptor(
        {
          port: 7802,
          projectPath: "C:\\Other",
          evalToken: "1234567890abcdef"
        },
        ROOT
      ),
    /PROJECT_MISMATCH/
  );
});

test("actively probes Pipeline instead of rejecting an old heartbeat", async () => {
  let requested = null;
  const descriptorJson = JSON.stringify({
    pid: 123,
    port: 7802,
    projectPath: ROOT,
    lastHeartbeat: "2000-01-01T00:00:00Z",
    evalToken: "1234567890abcdef"
  });

  const live = await openLivePipeline(ROOT, {
    readFileImpl: async () => descriptorJson,
    fetchImpl: async (url) => {
      requested = String(url);
      return fakeResponse({ status: "ready" });
    }
  });

  assert.equal(requested, "http://127.0.0.1:7802/api/status");
  assert.equal(live.status.status, "ready");
});

test("maps Pipeline command names to ContextForge Unity tools", () => {
  assert.equal(unityToolName("editor_status"), "Unity_editor_status");
  assert.equal(pipelineCommandName("Unity_editor_status"), "editor_status");
  assert.equal(pipelineCommandName("ContextForgeUnity.Status"), null);
});

test("keeps read-only classification conservative", () => {
  for (const name of [
    "console",
    "console_status",
    "editor_status",
    "get_project_settings",
    "find_assets",
    "list_tests",
    "recompile_status",
    "capture_scene_view"
  ]) {
    assert.equal(isReadOnlyPipelineCommand(name), true, name);
  }

  for (const name of [
    "clear_console",
    "create_gameobject",
    "delete_asset",
    "editor_play",
    "eval",
    "set_transform"
  ]) {
    assert.equal(isReadOnlyPipelineCommand(name), false, name);
  }
});

test("converts Pipeline schemas and annotations", () => {
  const tool = commandToTool({
    name: "editor_status",
    description: "Get status",
    schema: JSON.stringify({
      type: "object",
      properties: {},
      additionalProperties: false
    })
  });

  assert.equal(tool.name, "Unity_editor_status");
  assert.equal(tool.inputSchema.type, "object");
  assert.equal(tool.annotations.readOnlyHint, true);
});

test("marks Console errors red and as MCP errors", () => {
  const result = pipelineResponseToToolResult("console", {
    success: true,
    result: {
      entries: [
        {
          seq: 9,
          level: "error",
          logType: "Error",
          message: "Compiler exploded",
          stackTrace: ""
        }
      ],
      groundTruth: {
        compilationFailed: true,
        consoleErrors: 1,
        consoleWarnings: 0
      }
    }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /🟥 UNITY CONSOLE/);
  assert.match(result.content[0].text, /🟥 ERROR/);
});

test("marks Console warnings yellow without failing the tool", () => {
  const result = pipelineResponseToToolResult("console", {
    success: true,
    result: {
      entries: [
        {
          seq: 10,
          level: "warn",
          logType: "Warning",
          message: "Careful",
          stackTrace: ""
        }
      ],
      groundTruth: {
        compilationFailed: false,
        consoleErrors: 0,
        consoleWarnings: 1
      }
    }
  });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /🟨 UNITY CONSOLE/);
  assert.match(result.content[0].text, /🟨 WARNING/);
});

test("promotes Pipeline PNG payloads to MCP image content", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAAAAAA==";
  const result = pipelineResponseToToolResult("capture_scene_view", {
    success: true,
    result: {
      width: 1,
      height: 1,
      encoding: "png",
      base64: png
    }
  });

  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/png");
  assert.equal(result.content[1].data, png);
  assert.match(result.content[0].text, /emitted as MCP image/);
  assert.doesNotMatch(result.content[0].text, /iVBORw0KGgoAAAANS/);
});
