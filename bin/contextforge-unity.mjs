#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import { pathToFileURL } from "node:url";

const RELAY_SEGMENTS = [".unity", "relay", "relay_win.exe"];

const READ_ONLY_TOOL_NAMES = new Set([
  "Unity_AssetGeneration_GetComposit_832d2c69",
  "Unity_AssetGeneration_GetModels",
  "Unity_Camera_Capture",
  "Unity_FindInFile",
  "Unity_FindProjectAssets",
  "Unity_GetConsoleLogs",
  "Unity_GetProjectData",
  "Unity_GetSha",
  "Unity_GetUserGuidelines",
  "Unity_Grep",
  "Unity_ListResources",
  "Unity_ManageScript_capabilities",
  "Unity_PackageManager_GetData",
  "Unity_ReadResource",
  "Unity_SceneView_Capture2DScene",
  "Unity_SceneView_CaptureMultiAngleSceneView",
  "Unity_ValidateScript"
]);

const READ_ONLY_TOOL_PREFIXES = ["Unity_Profiler_"];

export function resolveUnityRelayPath({
  platform = process.platform,
  userProfile = process.env.USERPROFILE
} = {}) {
  if (platform !== "win32") {
    throw new Error(
      "ContextForge Unity 1.x supports Windows because the current ContextForge desktop runtime is Windows-only."
    );
  }
  if (
    typeof userProfile !== "string" ||
    userProfile.trim() === "" ||
    !win32.isAbsolute(userProfile)
  ) {
    throw new Error(
      "ContextForge Unity could not resolve USERPROFILE to locate Unity's official MCP relay."
    );
  }
  return win32.join(userProfile, ...RELAY_SEGMENTS);
}

export async function assertUnityRelay(relayPath) {
  const facts = await lstat(relayPath).catch(() => null);
  if (facts === null || !facts.isFile() || facts.isSymbolicLink()) {
    throw new Error(
      [
        `Unity's official MCP relay was not found at "${relayPath}".`,
        "Open a supported Unity project, install or enable the Unity AI Assistant package,",
        "then confirm Edit > Project Settings > AI > Unity MCP shows Unity Bridge as Running."
      ].join(" ")
    );
  }
}

export function isReadOnlyUnityTool(toolName) {
  if (READ_ONLY_TOOL_NAMES.has(toolName)) return true;
  return READ_ONLY_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

export function decorateUnityTool(tool) {
  if (
    tool === null ||
    typeof tool !== "object" ||
    Array.isArray(tool) ||
    typeof tool.name !== "string" ||
    !isReadOnlyUnityTool(tool.name)
  ) {
    return tool;
  }

  const existingAnnotations =
    tool.annotations !== null &&
    typeof tool.annotations === "object" &&
    !Array.isArray(tool.annotations)
      ? tool.annotations
      : {};

  return {
    ...tool,
    annotations: {
      ...existingAnnotations,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    }
  };
}

export function observeUnityRequestLine(line, pendingToolsListIds) {
  if (!line.includes('"tools/list"')) return line;

  const parsed = tryParseJson(line);
  if (parsed === undefined) return line;

  forEachJsonRpcMessage(parsed, (message) => {
    if (message?.method !== "tools/list") return;
    const key = requestIdKey(message.id);
    if (key !== null) pendingToolsListIds.add(key);
  });
  return line;
}

export function decorateUnityResponseLine(line, pendingToolsListIds) {
  if (pendingToolsListIds.size === 0) return line;

  const parsed = tryParseJson(line);
  if (parsed === undefined) return line;

  let changed = false;
  forEachJsonRpcMessage(parsed, (message) => {
    const key = requestIdKey(message?.id);
    if (key === null || !pendingToolsListIds.has(key)) return;

    pendingToolsListIds.delete(key);
    if (!Array.isArray(message?.result?.tools)) return;

    message.result.tools = message.result.tools.map((tool) => {
      const decorated = decorateUnityTool(tool);
      if (decorated !== tool) changed = true;
      return decorated;
    });
  });

  return changed ? JSON.stringify(parsed) : line;
}

export function createUnityRelayTransforms() {
  const pendingToolsListIds = new Set();
  return {
    toUnity: new JsonLineTransform((line) =>
      observeUnityRequestLine(line, pendingToolsListIds)
    ),
    fromUnity: new JsonLineTransform((line) =>
      decorateUnityResponseLine(line, pendingToolsListIds)
    ),
    pendingToolsListIds
  };
}

export async function runUnityRelay({
  relayPath = resolveUnityRelayPath(),
  spawnImpl = spawn,
  input = process.stdin,
  output = process.stdout
} = {}) {
  await assertUnityRelay(relayPath);

  const child = spawnImpl(relayPath, ["--mcp"], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
    detached: false
  });

  const { toUnity, fromUnity } = createUnityRelayTransforms();
  input.pipe(toUnity).pipe(child.stdin);
  child.stdout.pipe(fromUnity).pipe(output);

  const stopChild = () => {
    if (!child.killed) child.kill();
  };
  process.once("SIGINT", stopChild);
  process.once("SIGTERM", stopChild);

  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => {
        resolvePromise(code ?? (signal === null ? 0 : 1));
      });
    });
  } finally {
    input.unpipe(toUnity);
    toUnity.unpipe(child.stdin);
    child.stdout.unpipe(fromUnity);
    fromUnity.unpipe(output);
    process.removeListener("SIGINT", stopChild);
    process.removeListener("SIGTERM", stopChild);
  }
}

class JsonLineTransform extends Transform {
  constructor(transformLine) {
    super();
    this.transformLine = transformLine;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.buffer += this.decoder.write(chunk);
      this.#drainCompleteLines();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      this.buffer += this.decoder.end();
      if (this.buffer.length > 0) {
        this.push(this.transformLine(this.buffer));
        this.buffer = "";
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  #drainCompleteLines() {
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      const hasCarriageReturn = rawLine.endsWith("\r");
      const logicalLine = hasCarriageReturn ? rawLine.slice(0, -1) : rawLine;
      const transformed = this.transformLine(logicalLine);
      this.push(transformed + (hasCarriageReturn ? "\r\n" : "\n"));

      newlineIndex = this.buffer.indexOf("\n");
    }
  }
}

function tryParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function forEachJsonRpcMessage(value, visit) {
  if (Array.isArray(value)) {
    for (const message of value) visit(message);
    return;
  }
  visit(value);
}

function requestIdKey(id) {
  if (typeof id === "string") return `string:${id}`;
  if (typeof id === "number" && Number.isFinite(id)) return `number:${id}`;
  return null;
}

async function main() {
  try {
    process.exitCode = await runUnityRelay();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ContextForge Unity: ${message}\n`);
    process.exitCode = 1;
  }
}

function isMainModule() {
  const entry = process.argv[1];
  return typeof entry === "string" && pathToFileURL(entry).href === import.meta.url;
}

if (isMainModule()) {
  await main();
}
