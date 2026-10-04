# ContextForge Unity

A thin third-party ContextForge Skill that exposes Unity's local **Unity Pipeline** server as MCP tools.

Version 2 removes the Unity AI Assistant relay dependency entirely. The adapter discovers running Unity Editors, resolves each Editor's authoritative `-projectPath`, and talks directly to the Pipeline server advertised by that project at:

`<project>/Library/Pipeline/.unity-pipeline-port`

## What it does

ContextForge Unity:

- discovers running Unity Editor processes independently of ContextForge project scope
- reads each Editor's `-projectPath` and validates its project-local Pipeline descriptor
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
- one or more supported Unity projects with `com.unity.pipeline` installed and running

`CONTEXTFORGE_UNITY_PROJECT_ROOT` is optional, matching ContextForge Unreal. When present it scopes and auto-selects discovered Editors. When absent, discovery still works and a single running Editor routes automatically.

### Multi-project routing

ContextForge Unity follows the same discovery-first, scope-second model as ContextForge Unreal. It enumerates running `Unity.exe` Editor processes, reads each Editor's `-projectPath`, then accepts the candidate only when the matching project-local `Library/Pipeline/.unity-pipeline-port` descriptor belongs to that process and `/api/status` answers successfully. Asset trees and workspace folders are never crawled to discover Editors.

`ContextForgeUnity.ListEditors` returns the live project path, project name, Unity version, PID, Pipeline port, mode, capabilities, and status for every discovered Editor without exposing the Pipeline bearer token.

Every routable Unity tool receives an optional `_contextforgeUnity` object:

```json
{
  "_contextforgeUnity": {
    "projectPath": "C:\\Workspace\\GameB",
    "port": 7802
  }
}
```

`projectPath` is authoritative. `port` is optional and only disambiguates duplicate live instances of the same project path. The adapter removes `_contextforgeUnity` before forwarding parameters to Pipeline.

When exactly one eligible Unity Editor is running, it is selected automatically even when no ContextForge project root is configured. When the optional ContextForge root exactly matches one Editor, that Editor is preferred. When multiple Editors remain eligible, calls must route explicitly after `ContextForgeUnity.ListEditors`. The tool catalog admitted by ContextForge comes from one live Editor. Calls to another Editor are allowed only when its Pipeline catalog fingerprint matches the admitted catalog; otherwise the adapter requires re-inspection rather than invoking an unreviewed schema.

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

For every discovery/connection sequence the adapter:

1. enumerates running Unity Editor processes
2. extracts each Editor's authoritative `-projectPath`
3. reads that project's Pipeline descriptor
4. verifies the descriptor project path and PID match the discovered Editor
5. calls `/api/status`
6. uses the descriptor only if the live Pipeline server answers

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
- bounded Windows process enumeration using a fixed PowerShell/CIM query
- one descriptor read and status probe per discovered Unity Editor
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

The unit suite covers independent Editor-process discovery, optional project scoping, project/PID identity, active heartbeat probing, tool mapping, effect classification, Console severity, and image promotion.

Live smoke validation should additionally verify:

- tool catalog listing against a running Unity Editor
- `ContextForgeUnity.Status`
- viewport capture
- editor capture
- asset preview capture
- Console formatting

## License

MIT
