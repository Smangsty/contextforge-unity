# ContextForge Unity

A deliberately thin third-party ContextForge Skill for Unity Technologies' official Unity MCP relay.

## What it does

ContextForge Unity locates Unity's official Windows relay at:

`%USERPROFILE%\.unity\relay\relay_win.exe`

and launches it with:

`--mcp`

Unity remains the MCP implementation. The adapter forwards normal MCP tool traffic unchanged and only decorates the `tools/list` response with conservative effect metadata for tools that are known to be read-only.

This lets ContextForge distinguish safe inspection calls from mutations without replacing Unity's native tool surface or adding translation work to normal tool calls.

## Effect metadata

Unity's current relay does not annotate its tools with MCP `readOnlyHint` metadata. ContextForge therefore has to treat every unannotated Unity tool as a write unless this adapter supplies stronger metadata.

ContextForge Unity marks only tools that are unambiguously read-only, including:

- project, resource, console-log, SHA, guideline, and package-data reads
- file and asset search
- profiler queries
- camera and Scene View captures
- script validation and capability inspection

Mixed tools remain conservative. For example, `Unity_ManageEditor` contains both read actions and mutations, and `Unity_ReadConsole` can clear the console, so both remain write-classified.

Unknown tools added by future Unity versions also remain write-classified until reviewed.

## Performance model

The adapter is intentionally off the hot path:

- Normal requests are forwarded unchanged after a cheap string check.
- Normal responses are forwarded unchanged without JSON parsing.
- JSON parsing and rewriting occurs only for a pending `tools/list` response.
- Tool names, schemas, descriptions, arguments, and tool-call results remain Unity-native.
- No network access or additional runtime dependency is introduced by the adapter.

## Prerequisites

- ContextForge on Windows.
- A supported Unity project with Unity's AI Assistant / MCP integration installed.
- In Unity, **Edit > Project Settings > AI > Unity MCP** should show **Unity Bridge: Running**.
- The first connection may require approval inside Unity.

Unity's current official MCP setup documentation:
https://unity.com/blog/unity-ai-mcp-how-to-get-started

## ContextForge installation

This Skill is not bundled with ContextForge.

1. Find the latest release from `Smangsty/contextforge-unity`.
2. Download the release `.tgz` through ContextForge Discovery to `MCP_DOWNLOADS`.
3. Prepare the downloaded artifact with Discovery.
4. Review the exact candidate in ContextForge.
5. Admit and enable it only after human review.

The release artifact is a standard npm package. Discovery can inspect the package without executing candidate code.

## Design constraints

- No Unity binaries are redistributed.
- No network access is requested by the adapter.
- Unity's official relay remains the engine-facing MCP implementation.
- Unknown and mixed-effect Unity tools fail safe as write-classified.
- Errors are written to stderr so stdout remains reserved for MCP.
- Missing relay prerequisites fail with a direct, human-readable message.

## Development

`npm test` validates the launcher, read-only classification, and transparent protocol behavior.

`npm pack` runs tests and version checks before producing the release artifact.

## License

MIT
