#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { win32 as win32Path } from "node:path";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

export const ADAPTER_VERSION = "2.0.1";
export const UNITY_TOOL_PREFIX = "Unity_";
export const CONTEXTFORGE_UNITY_STATUS_TOOL = "ContextForgeUnity.Status";
export const CAPTURE_VIEWPORT_TOOL = "ContextForgeUnity.CaptureViewport";
export const CAPTURE_EDITOR_IMAGE_TOOL = "ContextForgeUnity.CaptureEditorImage";
export const CAPTURE_ASSET_IMAGE_TOOL = "ContextForgeUnity.CaptureAssetImage";
export const DEFAULT_PIPELINE_TIMEOUT_MS = 15000;
export const MAX_PIPELINE_COMMANDS = 1000;

const IMAGE_DATA_MARKER = "[emitted as MCP image/png]";

const EXACT_READ_ONLY_COMMANDS = new Set([
  "console",
  "console_status",
  "editor_status",
  "capture_editor_element",
  "capture_game_view",
  "capture_scene_view",
  "search"
]);

const READ_ONLY_PREFIXES = ["find_", "get_", "list_", "read_"];
const READ_ONLY_SUFFIXES = ["_status"];

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

const SYNTHETIC_TOOLS = Object.freeze([
  {
    name: CONTEXTFORGE_UNITY_STATUS_TOOL,
    description:
      "Inspect the adapter connection to the active project's Unity Pipeline server.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: CAPTURE_VIEWPORT_TOOL,
    description:
      "Capture Unity's active Scene View or Game View and return it as an MCP image.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["scene", "game"],
          default: "scene",
          description: "Which Unity viewport to capture."
        },
        width: {
          type: "integer",
          minimum: 1,
          maximum: 4096,
          default: 1280
        },
        height: {
          type: "integer",
          minimum: 1,
          maximum: 4096,
          default: 720
        },
        maxResolution: {
          type: "integer",
          minimum: 0,
          maximum: 4096,
          default: 0,
          description: "Optional cap on the longest edge of the inline image."
        },
        source: {
          type: "string",
          enum: ["camera", "screen"],
          default: "camera",
          description:
            "Game View only. camera renders a camera; screen captures the composited Game View in Play Mode."
        },
        camera: {
          type: "string",
          description: "Optional camera name for Game View camera capture."
        }
      },
      additionalProperties: false
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: CAPTURE_EDITOR_IMAGE_TOOL,
    description:
      "Capture the complete main Unity Editor window and return it as an MCP image.",
    inputSchema: {
      type: "object",
      properties: {
        maxResolution: {
          type: "integer",
          minimum: 256,
          maximum: 4096,
          default: 1600,
          description: "Cap the longest edge while preserving aspect ratio."
        }
      },
      additionalProperties: false
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: CAPTURE_ASSET_IMAGE_TOOL,
    description:
      "Capture Unity's preview or icon for a project asset and return it as an MCP image.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: {
          type: "string",
          description: "Project-relative asset path under Assets/."
        },
        size: {
          type: "integer",
          minimum: 16,
          maximum: 512,
          default: 256,
          description: "Square PNG output size in pixels."
        }
      },
      required: ["assetPath"],
      additionalProperties: false
    },
    annotations: READ_ONLY_ANNOTATIONS
  }
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteInteger(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error("UNITY_ARGUMENT_OUT_OF_RANGE");
  }
  return parsed;
}

function normalizePathKey(value) {
  return value.toLowerCase();
}

export function normalizeUnityProjectRoot(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^"+|"+$/g, "");
  if (trimmed === "" || !win32Path.isAbsolute(trimmed)) return null;
  if (trimmed.includes(String.fromCharCode(0)) || /[\r\n]/.test(trimmed)) return null;
  return win32Path.normalize(trimmed).replace(/[\\/]+$/g, "");
}

export function resolveUnityProjectRoot({
  configuredRoot = process.env.CONTEXTFORGE_UNITY_PROJECT_ROOT
} = {}) {
  const configured = normalizeUnityProjectRoot(configuredRoot);
  if (configured !== null) return configured;

  throw new Error(
    "ContextForge Unity requires CONTEXTFORGE_UNITY_PROJECT_ROOT. In ContextForge, bind the required launch input to the active project root."
  );
}

export function pipelineDescriptorPath(projectRootValue) {
  const projectRoot = normalizeUnityProjectRoot(projectRootValue);
  if (projectRoot === null) throw new Error("UNITY_PROJECT_ROOT_INVALID");
  return win32Path.join(projectRoot, "Library", "Pipeline", ".unity-pipeline-port");
}

export function validatePipelineDescriptor(value, projectRootValue) {
  if (!isRecord(value)) throw new Error("UNITY_PIPELINE_DESCRIPTOR_INVALID");

  const projectRoot = normalizeUnityProjectRoot(projectRootValue);
  const descriptorProject = normalizeUnityProjectRoot(value.projectPath);
  const port = Number(value.port);

  if (projectRoot === null || descriptorProject === null) {
    throw new Error("UNITY_PIPELINE_DESCRIPTOR_INVALID");
  }
  if (normalizePathKey(projectRoot) !== normalizePathKey(descriptorProject)) {
    throw new Error("UNITY_PIPELINE_PROJECT_MISMATCH");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("UNITY_PIPELINE_DESCRIPTOR_INVALID");
  }
  if (typeof value.evalToken !== "string" || value.evalToken.length < 16) {
    throw new Error("UNITY_PIPELINE_DESCRIPTOR_INVALID");
  }

  return Object.freeze({
    pid: Number.isInteger(Number(value.pid)) ? Number(value.pid) : null,
    port,
    projectPath: descriptorProject,
    projectName: typeof value.projectName === "string" ? value.projectName : null,
    unityVersion: typeof value.unityVersion === "string" ? value.unityVersion : null,
    mode: typeof value.mode === "string" ? value.mode : null,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    lastHeartbeat: typeof value.lastHeartbeat === "string" ? value.lastHeartbeat : null,
    evalToken: value.evalToken,
    capabilities: Array.isArray(value.capabilities) ? [...value.capabilities] : []
  });
}

export async function readPipelineDescriptor(projectRootValue, readFileImpl = readFile) {
  const descriptorPath = pipelineDescriptorPath(projectRootValue);
  let raw;
  try {
    raw = await readFileImpl(descriptorPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "Unity Pipeline descriptor was not found at " + descriptorPath +
          ". Open the Unity project and ensure com.unity.pipeline is running."
      );
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("UNITY_PIPELINE_DESCRIPTOR_INVALID");
  }

  return validatePipelineDescriptor(parsed, projectRootValue);
}

function pipelineUrl(descriptor, pathname) {
  return "http://127.0.0.1:" + descriptor.port + pathname;
}

export async function pipelineRequest(
  descriptor,
  pathname,
  {
    method = "GET",
    body = undefined,
    timeoutMs = DEFAULT_PIPELINE_TIMEOUT_MS,
    fetchImpl = fetch
  } = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(pipelineUrl(descriptor, pathname), {
      method,
      headers: {
        Authorization: "Bearer " + descriptor.evalToken,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });

    const text = await response.text();
    let payload;
    try {
      payload = text === "" ? {} : JSON.parse(text);
    } catch {
      payload = { raw: text };
    }

    if (!response.ok) {
      const detail =
        isRecord(payload) && typeof payload.message === "string"
          ? payload.message
          : response.statusText || "request failed";
      throw new Error("Unity Pipeline HTTP " + response.status + ": " + detail);
    }

    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Unity Pipeline request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function openLivePipeline(
  projectRootValue,
  {
    readFileImpl = readFile,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_PIPELINE_TIMEOUT_MS
  } = {}
) {
  const descriptor = await readPipelineDescriptor(projectRootValue, readFileImpl);

  // Pipeline refreshes lastHeartbeat on status calls. Always probe the server
  // instead of rejecting a descriptor merely because its stored heartbeat is old.
  const status = await pipelineRequest(descriptor, "/api/status", {
    fetchImpl,
    timeoutMs
  });

  return Object.freeze({ descriptor, status });
}

export function unityToolName(commandName) {
  if (typeof commandName !== "string" || commandName.trim() === "") {
    throw new Error("UNITY_PIPELINE_COMMAND_NAME_INVALID");
  }
  return UNITY_TOOL_PREFIX + commandName;
}

export function pipelineCommandName(toolName) {
  if (typeof toolName !== "string" || !toolName.startsWith(UNITY_TOOL_PREFIX)) {
    return null;
  }
  const commandName = toolName.slice(UNITY_TOOL_PREFIX.length);
  return commandName === "" ? null : commandName;
}

export function isReadOnlyPipelineCommand(commandName) {
  if (typeof commandName !== "string") return false;
  if (EXACT_READ_ONLY_COMMANDS.has(commandName)) return true;
  if (READ_ONLY_PREFIXES.some((prefix) => commandName.startsWith(prefix))) return true;
  return READ_ONLY_SUFFIXES.some((suffix) => commandName.endsWith(suffix));
}

function parseCommandSchema(command) {
  if (typeof command?.schema !== "string") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  try {
    const schema = JSON.parse(command.schema);
    return isRecord(schema)
      ? schema
      : { type: "object", properties: {}, additionalProperties: false };
  } catch {
    return { type: "object", properties: {}, additionalProperties: false };
  }
}

export function commandToTool(command) {
  const readOnly = isReadOnlyPipelineCommand(command?.name);
  return {
    name: unityToolName(command.name),
    description:
      typeof command.description === "string"
        ? command.description
        : "Unity Pipeline command " + command.name,
    inputSchema: parseCommandSchema(command),
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: readOnly,
      openWorldHint: false
    }
  };
}

export async function fetchPipelineCatalog(descriptor, options = {}) {
  const payload = await pipelineRequest(
    descriptor,
    "/api/commands?detail=full&limit=" + MAX_PIPELINE_COMMANDS,
    options
  );
  if (!Array.isArray(payload?.commands)) {
    throw new Error("UNITY_PIPELINE_COMMAND_CATALOG_INVALID");
  }
  return payload.commands;
}

export async function executePipelineCommand(descriptor, command, parameters, options = {}) {
  return await pipelineRequest(descriptor, "/api/exec", {
    ...options,
    method: "POST",
    body: {
      command,
      parameters: isRecord(parameters) ? parameters : {}
    }
  });
}

function toolError(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}

function toolPayloadResult(value, { isError = false } = {}) {
  const structuredContent = isRecord(value) ? value : { result: value };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    ...(isError ? { isError: true } : {})
  };
}

function isPngBase64(value) {
  return (
    typeof value === "string" &&
    value.length >= 16 &&
    value.length % 4 === 0 &&
    value.startsWith("iVBORw0KGgo") &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function findImagePayload(value, depth = 0) {
  if (depth > 12) return null;
  if (isRecord(value)) {
    if (
      String(value.encoding ?? "").toLowerCase() === "png" &&
      isPngBase64(value.base64)
    ) {
      return { data: value.base64, mimeType: "image/png" };
    }
    for (const child of Object.values(value)) {
      const match = findImagePayload(child, depth + 1);
      if (match !== null) return match;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const match = findImagePayload(child, depth + 1);
      if (match !== null) return match;
    }
  }
  return null;
}

function sanitizeImagePayload(value, depth = 0) {
  if (depth > 20) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeImagePayload(item, depth + 1));
  }
  if (!isRecord(value)) return value;

  const copy = {};
  const imageObject =
    String(value.encoding ?? "").toLowerCase() === "png" && isPngBase64(value.base64);
  for (const [key, child] of Object.entries(value)) {
    if (imageObject && key === "base64") {
      copy[key] = IMAGE_DATA_MARKER;
    } else {
      copy[key] = sanitizeImagePayload(child, depth + 1);
    }
  }
  return copy;
}

function imageToolResult(value) {
  const image = findImagePayload(value);
  if (image === null) return toolPayloadResult(value);

  const sanitized = sanitizeImagePayload(value);
  const structuredContent = isRecord(sanitized) ? sanitized : { result: sanitized };
  return {
    content: [
      { type: "text", text: JSON.stringify(structuredContent, null, 2) },
      { type: "image", data: image.data, mimeType: image.mimeType }
    ],
    structuredContent
  };
}

function numeric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function consoleSeverityResult(pipelineResponse) {
  const result = isRecord(pipelineResponse?.result) ? pipelineResponse.result : {};
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const groundTruth = isRecord(result.groundTruth) ? result.groundTruth : result;

  const returnedErrors = entries.filter(
    (entry) =>
      String(entry?.level ?? "").toLowerCase() === "error" ||
      String(entry?.logType ?? "").toLowerCase() === "error" ||
      String(entry?.logType ?? "").toLowerCase() === "exception" ||
      String(entry?.logType ?? "").toLowerCase() === "assert"
  ).length;
  const returnedWarnings = entries.filter(
    (entry) =>
      String(entry?.level ?? "").toLowerCase() === "warn" ||
      String(entry?.logType ?? "").toLowerCase() === "warning"
  ).length;

  const currentErrors = numeric(groundTruth.consoleErrors);
  const currentWarnings = numeric(groundTruth.consoleWarnings);
  const compilationFailed = groundTruth.compilationFailed === true;

  const hasError = compilationFailed || currentErrors > 0 || returnedErrors > 0;
  const hasWarning = currentWarnings > 0 || returnedWarnings > 0;

  const marker = hasError ? "🟥" : hasWarning ? "🟨" : "✅";
  const headline =
    marker +
    " UNITY CONSOLE | " +
    [
      compilationFailed ? "COMPILATION FAILED" : "compilation ok",
      "current errors=" + currentErrors,
      "current warnings=" + currentWarnings,
      "returned errors=" + returnedErrors,
      "returned warnings=" + returnedWarnings
    ].join(" | ");

  const lines = [headline];
  for (const entry of entries) {
    const level = String(entry?.level ?? entry?.logType ?? "log").toLowerCase();
    const entryMarker = level === "error" ? "🟥 ERROR" : level === "warn" || level === "warning" ? "🟨 WARNING" : "LOG";
    lines.push(
      entryMarker +
        (entry?.seq === undefined ? "" : " #" + entry.seq) +
        ": " +
        String(entry?.message ?? "")
    );
    if (typeof entry?.stackTrace === "string" && entry.stackTrace.trim() !== "") {
      lines.push(entry.stackTrace.trim());
    }
  }

  const structuredContent = sanitizeImagePayload(result);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent,
    ...(hasError ? { isError: true } : {})
  };
}

export function pipelineResponseToToolResult(commandName, response) {
  if (!isRecord(response) || response.success !== true) {
    const detail =
      isRecord(response) && typeof response.errorDetails === "string"
        ? response.errorDetails
        : isRecord(response) && typeof response.error === "string"
          ? response.error
          : "Unity Pipeline command failed.";
    return toolError(detail);
  }

  if (commandName === "console" || commandName === "console_status") {
    return consoleSeverityResult(response);
  }

  return findImagePayload(response.result) === null
    ? toolPayloadResult(response.result)
    : imageToolResult(response.result);
}

function validateAssetPath(value) {
  if (typeof value !== "string") throw new Error("UNITY_ASSET_PATH_INVALID");
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    !normalized.startsWith("Assets/") ||
    normalized.includes("..") ||
    normalized.includes(String.fromCharCode(0)) ||
    /[\r\n]/.test(normalized)
  ) {
    throw new Error("UNITY_ASSET_PATH_INVALID");
  }
  return normalized;
}

function editorCaptureEval(maxResolution) {
  return [
    'var containerType = typeof(UnityEditor.EditorWindow).Assembly.GetType("UnityEditor.ContainerWindow");',
    'if (containerType == null) throw new System.Exception("Unity main window type was not found.");',
    'var windows = UnityEngine.Resources.FindObjectsOfTypeAll(containerType);',
    'var flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic;',
    'var positionProperty = containerType.GetProperty("position", flags);',
    'var showModeField = containerType.GetField("m_ShowMode", flags);',
    'if (positionProperty == null) throw new System.Exception("Unity main window position is unavailable.");',
    'object main = null;',
    'UnityEngine.Rect captureRect = default(UnityEngine.Rect);',
    'float bestArea = -1f;',
    'foreach (var item in windows) {',
    '  var rect = (UnityEngine.Rect)positionProperty.GetValue(item);',
    '  var mode = showModeField == null ? -1 : (int)showModeField.GetValue(item);',
    '  if (mode == 4) { main = item; captureRect = rect; break; }',
    '  var area = rect.width * rect.height;',
    '  if (area > bestArea) { bestArea = area; main = item; captureRect = rect; }',
    '}',
    'if (main == null) throw new System.Exception("Unity main window was not found.");',
    'var width = UnityEngine.Mathf.Max(1, UnityEngine.Mathf.RoundToInt(captureRect.width));',
    'var height = UnityEngine.Mathf.Max(1, UnityEngine.Mathf.RoundToInt(captureRect.height));',
    'var pixels = UnityEditorInternal.InternalEditorUtility.ReadScreenPixel(new UnityEngine.Vector2(captureRect.x, captureRect.y), width, height);',
    'var texture = new UnityEngine.Texture2D(width, height, UnityEngine.TextureFormat.RGBA32, false);',
    'texture.SetPixels(pixels);',
    'texture.Apply(false, false);',
    'var cap = ' + String(maxResolution) + ';',
    'if (cap > 0 && UnityEngine.Mathf.Max(texture.width, texture.height) > cap) {',
    '  var scale = (float)cap / UnityEngine.Mathf.Max(texture.width, texture.height);',
    '  var targetWidth = UnityEngine.Mathf.Max(1, UnityEngine.Mathf.RoundToInt(texture.width * scale));',
    '  var targetHeight = UnityEngine.Mathf.Max(1, UnityEngine.Mathf.RoundToInt(texture.height * scale));',
    '  var rt = UnityEngine.RenderTexture.GetTemporary(targetWidth, targetHeight, 0, UnityEngine.RenderTextureFormat.ARGB32);',
    '  UnityEngine.Graphics.Blit(texture, rt);',
    '  var previous = UnityEngine.RenderTexture.active;',
    '  UnityEngine.RenderTexture.active = rt;',
    '  var scaled = new UnityEngine.Texture2D(targetWidth, targetHeight, UnityEngine.TextureFormat.RGBA32, false);',
    '  scaled.ReadPixels(new UnityEngine.Rect(0, 0, targetWidth, targetHeight), 0, 0);',
    '  scaled.Apply(false, false);',
    '  UnityEngine.RenderTexture.active = previous;',
    '  UnityEngine.RenderTexture.ReleaseTemporary(rt);',
    '  UnityEngine.Object.DestroyImmediate(texture);',
    '  texture = scaled;',
    '}',
    'var png = UnityEngine.ImageConversion.EncodeToPNG(texture);',
    'var outWidth = texture.width;',
    'var outHeight = texture.height;',
    'UnityEngine.Object.DestroyImmediate(texture);',
    'return new { width = outWidth, height = outHeight, encoding = "png", base64 = System.Convert.ToBase64String(png), source = "editor" };'
  ].join("\n");
}

function assetCaptureEval(assetPath, size) {
  const encodedPath = Buffer.from(assetPath, "utf8").toString("base64");
  return [
    'var assetPath = System.Text.Encoding.UTF8.GetString(System.Convert.FromBase64String("' + encodedPath + '"));',
    'var asset = UnityEditor.AssetDatabase.LoadMainAssetAtPath(assetPath);',
    'if (asset == null) throw new System.Exception("Asset was not found: " + assetPath);',
    'var preview = UnityEditor.AssetPreview.GetAssetPreview(asset);',
    'if (preview == null) preview = UnityEditor.AssetPreview.GetMiniThumbnail(asset);',
    'if (preview == null) throw new System.Exception("Unity did not provide a preview or icon for: " + assetPath);',
    'var size = ' + String(size) + ';',
    'var rt = UnityEngine.RenderTexture.GetTemporary(size, size, 0, UnityEngine.RenderTextureFormat.ARGB32);',
    'UnityEngine.Graphics.Blit(preview, rt);',
    'var previous = UnityEngine.RenderTexture.active;',
    'UnityEngine.RenderTexture.active = rt;',
    'var texture = new UnityEngine.Texture2D(size, size, UnityEngine.TextureFormat.RGBA32, false);',
    'texture.ReadPixels(new UnityEngine.Rect(0, 0, size, size), 0, 0);',
    'texture.Apply(false, false);',
    'UnityEngine.RenderTexture.active = previous;',
    'UnityEngine.RenderTexture.ReleaseTemporary(rt);',
    'var png = UnityEngine.ImageConversion.EncodeToPNG(texture);',
    'UnityEngine.Object.DestroyImmediate(texture);',
    'return new { width = size, height = size, encoding = "png", base64 = System.Convert.ToBase64String(png), source = "assetPreview", assetPath = assetPath };'
  ].join("\n");
}

async function captureViewport(descriptor, args, requestOptions) {
  const view = args?.view === "game" ? "game" : "scene";
  const width = finiteInteger(args?.width, 1280, 1, 4096);
  const height = finiteInteger(args?.height, 720, 1, 4096);
  const maxResolution = finiteInteger(args?.maxResolution, 0, 0, 4096);

  const parameters = {
    width,
    height,
    max_resolution: maxResolution
  };

  let command = "capture_scene_view";
  if (view === "game") {
    command = "capture_game_view";
    parameters.source = args?.source === "screen" ? "screen" : "camera";
    if (typeof args?.camera === "string" && args.camera.trim() !== "") {
      parameters.camera = args.camera.trim();
    }
  }

  const response = await executePipelineCommand(
    descriptor,
    command,
    parameters,
    requestOptions
  );
  return pipelineResponseToToolResult(command, response);
}

async function evalCapture(descriptor, code, requestOptions) {
  const response = await executePipelineCommand(
    descriptor,
    "eval",
    { code, timeout: 10000 },
    requestOptions
  );
  return pipelineResponseToToolResult("eval", response);
}

function connectionError(error, projectRoot) {
  const message = error instanceof Error ? error.message : String(error);
  return toolError(
    "ContextForge Unity could not reach Unity Pipeline for " +
      projectRoot +
      ". " +
      message
  );
}

export async function startContextForgeUnity({
  projectRoot = resolveUnityProjectRoot(),
  readFileImpl = readFile,
  fetchImpl = fetch
} = {}) {
  const server = new Server(
    { name: "contextforge-unity", version: ADAPTER_VERSION },
    { capabilities: { tools: {} } }
  );

  const requestOptions = { fetchImpl, timeoutMs: DEFAULT_PIPELINE_TIMEOUT_MS };

  async function live() {
    return await openLivePipeline(projectRoot, {
      readFileImpl,
      ...requestOptions
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const { descriptor } = await live();
      const commands = await fetchPipelineCatalog(descriptor, requestOptions);
      return {
        tools: [...commands.map(commandToTool), ...SYNTHETIC_TOOLS]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        "ContextForge Unity could not list tools for " +
          projectRoot +
          ". " +
          message
      );
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { descriptor, status } = await live();
      const toolName = request.params.name;
      const args = isRecord(request.params.arguments) ? request.params.arguments : {};

      if (toolName === CONTEXTFORGE_UNITY_STATUS_TOOL) {
        return toolPayloadResult({
          projectPath: descriptor.projectPath,
          projectName: descriptor.projectName,
          unityVersion: descriptor.unityVersion,
          pid: descriptor.pid,
          port: descriptor.port,
          mode: descriptor.mode,
          capabilities: descriptor.capabilities,
          status
        });
      }

      if (toolName === CAPTURE_VIEWPORT_TOOL) {
        return await captureViewport(descriptor, args, requestOptions);
      }

      if (toolName === CAPTURE_EDITOR_IMAGE_TOOL) {
        const maxResolution = finiteInteger(args.maxResolution, 1600, 256, 4096);
        return await evalCapture(
          descriptor,
          editorCaptureEval(maxResolution),
          requestOptions
        );
      }

      if (toolName === CAPTURE_ASSET_IMAGE_TOOL) {
        const assetPath = validateAssetPath(args.assetPath);
        const size = finiteInteger(args.size, 256, 16, 512);
        return await evalCapture(
          descriptor,
          assetCaptureEval(assetPath, size),
          requestOptions
        );
      }

      const commandName = pipelineCommandName(toolName);
      if (commandName === null) {
        return toolError("Unknown ContextForge Unity tool: " + toolName);
      }

      const response = await executePipelineCommand(
        descriptor,
        commandName,
        args,
        requestOptions
      );
      return pipelineResponseToToolResult(commandName, response);
    } catch (error) {
      return connectionError(error, projectRoot);
    }
  });

  await server.connect(new StdioServerTransport());
}

async function main() {
  try {
    await startContextForgeUnity();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write("ContextForge Unity: " + message + "\n");
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
