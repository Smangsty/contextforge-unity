# ContextForge Unity

A thin third-party ContextForge Skill that exposes Unity's local **Unity Pipeline** server as MCP tools.

Version 2 removes the Unity AI Assistant relay dependency entirely. The adapter talks directly to the Pipeline server advertised by the active Unity project at:

`<project>/Library/Pipeline/.unity-pipeline-port`

## What it does

ContextForge Unity:

- reads the active project's Pipeline descriptor
- actively probes `/api/status` before using the descriptor, so an old stored heartbeat does not cause false disconnects
- converts Unity Pipeline's live command catalog into MCP tools
- forwards tool calls to Pipeline's authenticated loopback HTTP API
- preserves Pipeline's native JSON schemas and command results
- adds conservative MCP read-only annotations
- promotes PNG capture payloads to real MCP image content
- makes Unity Console warnings and errors visually difficult to miss

The adapter does **not** require Unity AI Assistant, Sentis, or Unity's old `%USERPROFILE%\.unity\relay\relay_win.exe`.

## Prerequisites

- ContextForge on Windows
- a supported Unity project with `com.unity.pipeline` installed and running
- `CONTEXTFORGE_UNITY_PROJECT_ROOT` bound to ContextForge's active Unity project root

Unity Pipeline binds only to loopback and publishes its bearer token in the user-restricted project descriptor. ContextForge Unity reads that descriptor locally and never exposes the token as an MCP result.

## Tool surface

Pipeline commands are exposed with a `Unity_` prefix.

Examples:

- `Unity_editor_status`
- `Unity_console`
- `Unity_console_status`
- `Unity_find_assets`
- `Unity_capture_scene_view`
- `Unity_capture_game_view`
- `Unity_eval`
- `Unity_run_script`

The exact tool count follows the running project's Pipeline command catalog, so package-specific commands appear only when Unity exposes them.

### Adapter tools

The adapter also provides a small ContextForge-specific surface:

- `ContextForgeUnity.Status`
  Shows the selected project, Unity version, Pipeline PID/port, capabilities, and live status without exposing the auth token.

- `ContextForgeUnity.CaptureViewport`
  Captures the active Scene View or Game View and returns a real MCP `image/png`.

- `ContextForgeUnity.CaptureEditorImage`
  Captures the complete main Unity Editor window and returns a real MCP `image/png`.

- `ContextForgeUnity.CaptureAssetImage`
  Captures Unity's preview or icon for an asset under `Assets/` and returns a real MCP `image/png`.

These mirror the useful image-inspection surface of ContextForge Unreal: viewport, editor, and asset imagery.

## Console severity

`Unity_console` and `Unity_console_status` receive special formatting.

Errors and compile failures are surfaced with a prominent red headline:

```text
🟥 UNITY CONSOLE | COMPILATION FAILED | current errors=2 | ...
🟥 ERROR #42: Assets/Foo.cs(17,4): error CS1002 ...
```

A Console result containing an error is also returned with MCP `isError: true`, allowing ContextForge to render the action as failed/red rather than quietly presenting error text as a successful inspection.

Warnings remain successful reads but are surfaced prominently:

```text
🟨 UNITY CONSOLE | compilation ok | current warnings=1 | ...
🟨 WARNING #12: ...
```

Normal logs remain visually quiet.

The formatter uses Pipeline's structured `level`, `logType`, `counts`, `groundTruth`, and `compilationFailed` fields. It does not infer severity from words inside log messages.

## Discovery and reconnect behavior

Pipeline refreshes the descriptor's `lastHeartbeat` when a status request succeeds. ContextForge Unity therefore does **not** reject a descriptor merely because its stored heartbeat is old.

For every connection sequence the adapter:

1. reads the active project's descriptor
2. verifies the descriptor belongs to that exact project
3. calls `/api/status`
4. uses the descriptor only if the live Pipeline server answers

This lets the adapter recover cleanly after Unity domain reloads and avoids the stale-heartbeat deadlock that the old relay-based adapter could hit.

## Effect metadata

The adapter marks only commands that are clearly inspections as read-only. Reviewed read-only groups include:

- `get_*`, `find_*`, `list_*`, and `read_*`
- `*_status`
- Console reads
- editor status
- native Scene/Game/UI capture commands
- Unity Search reads

Unknown or mixed-effect commands remain conservatively mutation-classified.

## Performance model

The adapter remains deliberately thin:

- no runtime npm dependencies
- Node 20 built-in `fetch` for Pipeline HTTP
- one descriptor read and status probe when connecting
- Pipeline supplies the schemas and performs the actual Unity work
- base64 image data is promoted to MCP image content and replaced with a compact marker in text/structured output

## Development

```powershell
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run check-version
npm.cmd pack
```

The unit suite covers project identity, active heartbeat probing, tool mapping, effect classification, Console severity, and image promotion.

Live smoke validation should additionally verify:

- tool catalog listing against a running Unity Editor
- `ContextForgeUnity.Status`
- viewport capture
- editor capture
- asset preview capture
- Console formatting

## License

MIT
