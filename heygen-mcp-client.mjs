import {
  HEYGEN_CAPABILITY_DEFINITIONS,
  HEYGEN_MCP_ENDPOINT,
  classifyHeyGenTools
} from "./heygen-integration.mjs";

const defaultTimeoutMs = 20_000;
const defaultMaxResponseBytes = 512 * 1024;
const mcpProtocolVersion = "2025-06-18";

export class HeyGenMcpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "HeyGenMcpError";
    this.code = code;
    this.status = status;
  }
}

function mcpError(code, message, status = 400) {
  return new HeyGenMcpError(code, message, status);
}

function exactEndpoint(value) {
  try {
    const parsed = new URL(value);
    const canonical = new URL(HEYGEN_MCP_ENDPOINT);
    return parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.origin === canonical.origin
      && parsed.pathname.replace(/\/+$/, "/") === canonical.pathname;
  } catch {
    return false;
  }
}

function cleanText(value = "", max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

async function boundedBody(response, maxResponseBytes) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maxResponseBytes) throw mcpError("mcp_response_too_large", "HeyGen MCP returned an oversized response.", 502);
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maxResponseBytes) {
    throw mcpError("mcp_response_too_large", "HeyGen MCP returned an oversized response.", 502);
  }
  return body;
}

function parseMcpPayload(body, contentType, expectedId) {
  let payloads = [];
  if (/text\/event-stream/i.test(contentType || "")) {
    payloads = String(body).split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .filter(value => value && value !== "[DONE]")
      .map(value => {
        try { return JSON.parse(value); } catch { return null; }
      })
      .filter(Boolean);
  } else if (String(body).trim()) {
    try { payloads = [JSON.parse(body)]; }
    catch { throw mcpError("mcp_response_invalid", "HeyGen MCP returned an invalid response.", 502); }
  }
  const payload = payloads.find(item => String(item?.id) === String(expectedId)) || payloads.at(-1) || null;
  if (!payload || typeof payload !== "object") throw mcpError("mcp_response_invalid", "HeyGen MCP returned no usable response.", 502);
  if (payload.error) throw mcpError("mcp_tool_failed", "HeyGen MCP could not complete the requested operation.", 502);
  return payload.result;
}

const argumentAliases = Object.freeze({
  prompt: Object.freeze(["prompt", "message", "instructions"]),
  title: Object.freeze(["title", "name"]),
  brandKitId: Object.freeze(["brandKitId", "brand_kit_id"]),
  sessionId: Object.freeze(["sessionId", "session_id"]),
  sourceAssetId: Object.freeze(["sourceAssetId", "source_asset_id", "video_id", "asset_id"]),
  parentVersionId: Object.freeze(["parentVersionId", "parent_version_id"]),
  avatarId: Object.freeze(["avatarId", "avatar_id"]),
  imageAssetId: Object.freeze(["imageAssetId", "image_asset_id"]),
  voiceId: Object.freeze(["voiceId", "voice_id"]),
  templateId: Object.freeze(["templateId", "template_id"]),
  audioAssetId: Object.freeze(["audioAssetId", "audio_asset_id"]),
  locale: Object.freeze(["locale", "language", "target_language"]),
  glossaryId: Object.freeze(["glossaryId", "glossary_id"]),
  providerJobId: Object.freeze(["providerJobId", "provider_job_id", "job_id", "video_id"]),
  operationId: Object.freeze(["operationId", "operation_id", "idempotency_key"])
});

const boundedText = Object.freeze({
  prompt: 8_000,
  title: 200,
  locale: 40
});

function validIdentifier(value, max = 500) {
  const candidate = String(value ?? "");
  return candidate.length > 0 && candidate.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate);
}

function normalizeLogicalArguments(action, args = {}, tool = {}) {
  const definition = HEYGEN_CAPABILITY_DEFINITIONS[action];
  if (!definition) throw mcpError("mcp_action_unsupported", "That HeyGen media action is not supported.");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw mcpError("mcp_arguments_invalid", "HeyGen media arguments must be an object.");
  const suppliedKeys = Object.keys(args);
  if (suppliedKeys.length > 12 || suppliedKeys.some(key => !definition.allowedArguments.includes(key))) {
    throw mcpError("mcp_arguments_invalid", "HeyGen media arguments include an unsupported field.");
  }
  const schemaProperties = tool.inputSchema?.properties && typeof tool.inputSchema.properties === "object"
    ? tool.inputSchema.properties
    : {};
  if (definition.mutates && !Object.keys(schemaProperties).length) {
    throw mcpError("mcp_schema_missing", "HeyGen did not advertise a bounded input schema for this tool.", 503);
  }
  const normalized = {};
  for (const logicalKey of suppliedKeys) {
    const value = args[logicalKey];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw mcpError("mcp_arguments_invalid", "HeyGen media arguments must use bounded scalar values.");
    }
    const candidate = String(value);
    if (boundedText[logicalKey]) {
      if (!candidate.trim() || candidate.length > boundedText[logicalKey]) {
        throw mcpError("mcp_arguments_invalid", `HeyGen ${logicalKey} is outside the allowed length.`);
      }
    } else if (!validIdentifier(candidate)) {
      throw mcpError("mcp_arguments_invalid", `HeyGen ${logicalKey} is invalid.`);
    }
    const providerKey = (argumentAliases[logicalKey] || [logicalKey]).find(key => Object.prototype.hasOwnProperty.call(schemaProperties, key));
    if (!providerKey) {
      if (!Object.keys(schemaProperties).length && !definition.mutates) continue;
      throw mcpError("mcp_schema_mismatch", `HeyGen did not advertise an input field for ${logicalKey}.`, 503);
    }
    const property = schemaProperties[providerKey] || {};
    normalized[providerKey] = property.type === "number" ? Number(value)
      : property.type === "boolean" ? Boolean(value)
      : candidate;
  }
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  if (required.some(key => normalized[key] === undefined)) {
    throw mcpError("mcp_required_argument_missing", "HeyGen requires an input that Social Cues cannot safely infer.", 422);
  }
  return normalized;
}

function payloadObject(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const textContent = Array.isArray(result?.content)
    ? result.content.find(item => item?.type === "text" && typeof item.text === "string")?.text
    : "";
  if (textContent) {
    try {
      const parsed = JSON.parse(textContent);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return { message: cleanText(textContent, 1000) };
    }
  }
  return result && typeof result === "object" ? result : {};
}

function nestedCandidate(payload = {}) {
  for (const candidate of [payload.user, payload.account, payload.data, payload.result, payload]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  }
  return {};
}

function safeHeyGenUrl(value = "") {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (host !== "heygen.com" && !host.endsWith(".heygen.com")) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function normalizeHeyGenIdentity(result) {
  const payload = payloadObject(result);
  const candidate = nestedCandidate(payload);
  const accountId = cleanText(candidate.id || candidate.user_id || candidate.userId || candidate.account_id || candidate.accountId, 500);
  if (!validIdentifier(accountId)) throw mcpError("mcp_identity_unverified", "HeyGen did not return a stable current-user identity.", 502);
  const creditsSource = candidate.credits && typeof candidate.credits === "object"
    ? candidate.credits
    : candidate.plan?.credits && typeof candidate.plan.credits === "object"
      ? candidate.plan.credits
      : {};
  const remaining = Number(creditsSource.remaining ?? creditsSource.balance ?? candidate.credits_remaining);
  const credits = Number.isFinite(remaining)
    ? { available: remaining > 0, remaining }
    : { available: typeof creditsSource.available === "boolean" ? creditsSource.available : null, remaining: null };
  return Object.freeze({
    accountId,
    displayName: cleanText(candidate.display_name || candidate.displayName || candidate.name || "HeyGen account", 200),
    plan: cleanText(candidate.plan?.name || candidate.plan_name || candidate.plan || "", 120),
    credits: Object.freeze(credits)
  });
}

function normalizedStatus(value = "") {
  const status = cleanText(value, 80).toLowerCase().replace(/[\s-]+/g, "_");
  if (["complete", "completed", "succeeded", "success", "ready"].includes(status)) return "completed";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  return "processing";
}

export function normalizeHeyGenToolResult(result) {
  const payload = payloadObject(result);
  const candidate = nestedCandidate(payload);
  const status = normalizedStatus(candidate.status || candidate.state || payload.status || payload.state);
  const providerJobId = cleanText(candidate.job_id || candidate.jobId || candidate.video_id || candidate.videoId || payload.job_id || payload.video_id, 500);
  const sessionId = cleanText(candidate.session_id || candidate.sessionId || payload.session_id, 500);
  const resourceId = cleanText(candidate.resource_id || candidate.resourceId || candidate.asset_id || candidate.assetId || payload.resource_id, 500);
  const previewUrl = safeHeyGenUrl(candidate.preview_url || candidate.previewUrl || candidate.video_url || candidate.videoUrl || candidate.url || payload.preview_url || payload.video_url);
  return Object.freeze({
    status,
    providerJobId: validIdentifier(providerJobId) ? providerJobId : null,
    sessionId: validIdentifier(sessionId) ? sessionId : null,
    resourceId: validIdentifier(resourceId) ? resourceId : null,
    previewUrl,
    message: cleanText(candidate.message || payload.message || "", 500)
  });
}

export function createHeyGenMcpClient({
  accessToken,
  fetchImpl = globalThis.fetch,
  endpoint = HEYGEN_MCP_ENDPOINT,
  timeoutMs = defaultTimeoutMs,
  maxResponseBytes = defaultMaxResponseBytes
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  if (!exactEndpoint(endpoint)) throw mcpError("mcp_endpoint_invalid", "HeyGen MCP must use the approved fixed endpoint.");
  if (!cleanText(accessToken, 8192)) throw mcpError("mcp_not_authenticated", "Connect HeyGen before using video tools.", 401);
  const timeout = Math.max(250, Math.min(Number(timeoutMs) || defaultTimeoutMs, 60_000));
  const responseLimit = Math.max(1024, Math.min(Number(maxResponseBytes) || defaultMaxResponseBytes, 2 * 1024 * 1024));
  let requestId = 0;
  let sessionId = "";
  let initialized = false;
  let advertisedTools = null;

  async function send(method, params = undefined, { notification = false } = {}) {
    const id = notification ? undefined : ++requestId;
    const payload = { jsonrpc: "2.0", method };
    if (id !== undefined) payload.id = id;
    if (params !== undefined) payload.params = params;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      const headers = {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": mcpProtocolVersion
      };
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
      response = await fetchImpl(HEYGEN_MCP_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw mcpError("mcp_timeout", "HeyGen MCP timed out.", 504);
      throw mcpError("mcp_unavailable", "HeyGen MCP is unavailable.", 503);
    } finally {
      clearTimeout(timer);
    }
    const nextSessionId = cleanText(response.headers?.get?.("mcp-session-id"), 200);
    if (nextSessionId && /^[A-Za-z0-9._:-]+$/.test(nextSessionId)) sessionId = nextSessionId;
    if (notification && [200, 202, 204].includes(response.status)) return null;
    const body = await boundedBody(response, responseLimit);
    if (!response.ok) throw mcpError(response.status === 401 ? "mcp_not_authenticated" : "mcp_request_failed", "HeyGen MCP rejected the request.", response.status === 401 ? 401 : 502);
    return parseMcpPayload(body, response.headers?.get?.("content-type") || "", id);
  }

  async function initialize() {
    if (initialized) return;
    const result = await send("initialize", {
      protocolVersion: mcpProtocolVersion,
      capabilities: {},
      clientInfo: { name: "social-cues", version: "r4.8" }
    });
    if (!result?.protocolVersion) throw mcpError("mcp_initialize_invalid", "HeyGen MCP initialization was incomplete.", 502);
    await send("notifications/initialized", {}, { notification: true });
    initialized = true;
  }

  async function listTools({ refresh = false } = {}) {
    await initialize();
    if (advertisedTools && !refresh) return advertisedTools;
    const result = await send("tools/list", {});
    if (!Array.isArray(result?.tools)) throw mcpError("mcp_tools_invalid", "HeyGen MCP did not advertise a tool list.", 502);
    advertisedTools = result.tools.slice(0, 100).map(tool => ({
      name: cleanText(tool?.name, 160),
      description: cleanText(tool?.description, 1000),
      inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : null
    })).filter(tool => tool.name);
    return advertisedTools;
  }

  async function invokeCapability(capabilityId, args = {}) {
    const tools = await listTools();
    const capability = classifyHeyGenTools(tools).find(item => item.id === capabilityId);
    if (!capability) throw mcpError("mcp_capability_unavailable", "That HeyGen capability is not advertised for this account.", 409);
    const tool = tools.find(item => item.name === capability.toolName);
    const result = await send("tools/call", {
      name: capability.toolName,
      arguments: normalizeLogicalArguments(capabilityId, args, tool),
      _meta: args.operationId ? { operationId: String(args.operationId) } : undefined
    });
    if (result?.isError) throw mcpError("mcp_tool_failed", "HeyGen could not complete the requested operation.", 502);
    return { result, tools, capability };
  }

  async function getCurrentUser() {
    const invocation = await invokeCapability("current_user", {});
    return { identity: normalizeHeyGenIdentity(invocation.result), tools: invocation.tools };
  }

  async function callAction(action, args = {}) {
    if (action === "current_user" || !HEYGEN_CAPABILITY_DEFINITIONS[action]) {
      throw mcpError("mcp_action_unsupported", "That HeyGen media action is not supported.");
    }
    const invocation = await invokeCapability(action, args);
    return {
      outcome: normalizeHeyGenToolResult(invocation.result),
      tools: invocation.tools,
      capability: invocation.capability
    };
  }

  return Object.freeze({ initialize, listTools, getCurrentUser, callAction });
}

export function sanitizeHeyGenMcpError(error) {
  return Object.freeze({
    ok: false,
    code: error instanceof HeyGenMcpError ? error.code : "mcp_unavailable",
    error: error instanceof HeyGenMcpError ? error.message : "HeyGen MCP is unavailable.",
    status: error instanceof HeyGenMcpError ? error.status : 503
  });
}
