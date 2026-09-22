import assert from "node:assert/strict";
import test from "node:test";

import {
  decorateUnityResponseLine,
  decorateUnityTool,
  isReadOnlyUnityTool,
  observeUnityRequestLine,
  resolveUnityRelayPath
} from "../bin/contextforge-unity.mjs";

test("resolves Unity's official Windows relay path", () => {
  assert.equal(
    resolveUnityRelayPath({
      platform: "win32",
      userProfile: "C:\\Users\\Example"
    }),
    "C:\\Users\\Example\\.unity\\relay\\relay_win.exe"
  );
});

test("rejects unsupported platforms clearly", () => {
  assert.throws(
    () =>
      resolveUnityRelayPath({
        platform: "linux",
        userProfile: "/home/example"
      }),
    /supports Windows/
  );
});

test("rejects missing USERPROFILE clearly", () => {
  assert.throws(
    () =>
      resolveUnityRelayPath({
        platform: "win32",
        userProfile: ""
      }),
    /USERPROFILE/
  );
});

test("marks known inspection tools as read-only", () => {
  for (const name of [
    "Unity_GetProjectData",
    "Unity_GetConsoleLogs",
    "Unity_FindInFile",
    "Unity_ReadResource",
    "Unity_PackageManager_GetData",
    "Unity_Profiler_GetCounterSummary",
    "Unity_Camera_Capture"
  ]) {
    assert.equal(isReadOnlyUnityTool(name), true, name);
  }
});

test("keeps mixed or mutating tools conservative", () => {
  for (const name of [
    "Unity_ManageEditor",
    "Unity_ReadConsole",
    "Unity_ManageAsset",
    "Unity_ManageScript",
    "Unity_CreateScript",
    "Unity_DeleteScript",
    "Unity_RunCommand"
  ]) {
    assert.equal(isReadOnlyUnityTool(name), false, name);
  }
});

test("decorates read-only tools without discarding upstream annotations", () => {
  const decorated = decorateUnityTool({
    name: "Unity_GetProjectData",
    annotations: { title: "Project data" }
  });

  assert.deepEqual(decorated.annotations, {
    title: "Project data",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true
  });
});

test("leaves mutating tools untouched", () => {
  const tool = {
    name: "Unity_CreateScript",
    annotations: null
  };
  assert.equal(decorateUnityTool(tool), tool);
});

test("records tools/list requests while forwarding request text unchanged", () => {
  const pending = new Set();
  const request = '{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}';

  assert.equal(observeUnityRequestLine(request, pending), request);
  assert.deepEqual([...pending], ["number:7"]);
});

test("normal requests stay on the zero-rewrite hot path", () => {
  const pending = new Set();
  const request =
    '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"Unity_GetProjectData"}}';

  assert.equal(observeUnityRequestLine(request, pending), request);
  assert.equal(pending.size, 0);
});

test("decorates only the matching tools/list response", () => {
  const pending = new Set(["string:manifest-1"]);
  const unrelated =
    '{"jsonrpc":"2.0","id":"other","result":{"tools":[{"name":"Unity_GetProjectData","annotations":null}]}}';

  assert.equal(decorateUnityResponseLine(unrelated, pending), unrelated);
  assert.equal(pending.size, 1);

  const matching =
    '{"jsonrpc":"2.0","id":"manifest-1","result":{"tools":[{"name":"Unity_GetProjectData","annotations":null},{"name":"Unity_ManageEditor","annotations":null}]}}';
  const result = JSON.parse(decorateUnityResponseLine(matching, pending));

  assert.equal(result.result.tools[0].annotations.readOnlyHint, true);
  assert.equal(result.result.tools[0].annotations.destructiveHint, false);
  assert.equal(result.result.tools[1].annotations, null);
  assert.equal(pending.size, 0);
});

test("failed tools/list responses clear pending state without rewriting", () => {
  const pending = new Set(["number:5"]);
  const response =
    '{"jsonrpc":"2.0","id":5,"error":{"code":-32603,"message":"failed"}}';

  assert.equal(decorateUnityResponseLine(response, pending), response);
  assert.equal(pending.size, 0);
});
