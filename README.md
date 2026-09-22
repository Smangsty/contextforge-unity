# ContextForge Unity

A deliberately thin third-party ContextForge Skill for Unity Technologies' official Unity MCP relay.

## What it does

ContextForge Unity locates Unity's official Windows relay at:

`%USERPROFILE%\.unity\relay\relay_win.exe`

and launches it with:

`--mcp`

The adapter does not translate MCP traffic. The relay inherits ContextForge's stdio directly, which keeps startup overhead and per-call latency effectively negligible.

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
- The official Unity relay remains the MCP implementation.
- Errors are written to stderr so stdout remains reserved for MCP.
- Missing relay prerequisites fail with a direct, human-readable message.

## Development

`npm test` validates the deterministic launcher logic.

`npm pack` runs tests and version checks before producing the release artifact.

## License

MIT
