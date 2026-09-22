import assert from "node:assert/strict";
import test from "node:test";

import { resolveUnityRelayPath } from "../bin/contextforge-unity.mjs";

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
