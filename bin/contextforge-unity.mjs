#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";

const RELAY_SEGMENTS = [".unity", "relay", "relay_win.exe"];

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

export async function runUnityRelay({
  relayPath = resolveUnityRelayPath(),
  spawnImpl = spawn
} = {}) {
  await assertUnityRelay(relayPath);

  const child = spawnImpl(relayPath, ["--mcp"], {
    stdio: "inherit",
    windowsHide: true,
    detached: false
  });

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
    process.removeListener("SIGINT", stopChild);
    process.removeListener("SIGTERM", stopChild);
  }
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
