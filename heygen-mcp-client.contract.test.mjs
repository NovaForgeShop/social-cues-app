import assert from "node:assert/strict";
import test from "node:test";

import {
  createHeyGenMcpClient,
  normalizeHeyGenIdentity,
  normalizeHeyGenToolResult,
  sanitizeHeyGenMcpError
} from "./heygen-mcp-client.mjs";
import { HEYGEN_MCP_ENDPOINT } from "./heygen-integration.mjs";

const tools = [
  { name: "get_current_user", inputSchema: { type: "object", properties: {} } },
  { name: "video_agent", inputSchema: { type: "object", properties: { prompt: { type: "string" }, operation_id: { type: "string" } }, required: ["prompt"] } },
  { name: "translate_video", inputSchema: { type: "object", properties: { video_id: { type: "string" }, target_language: { type: "string" }, glossary_id: { type: "string" } }, required: ["video_id", "target_language"] } },
  { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } } } }
];

function rpcResponse(id, result, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function mcpFixture() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    assert.equal(String(url), HEYGEN_MCP_ENDPOINT);
    const payload = JSON.parse(init.body);
    calls.push({ url: String(url), headers: { ...init.headers }, payload });
    if (payload.method === "initialize") return rpcResponse(payload.id, { protocolVersion: "2025-06-18", capabilities: {} }, { headers: { "mcp-session-id": "session-r48" } });
    if (payload.method === "notifications/initialized") return new Response("", { status: 202 });
    if (payload.method === "tools/list") return rpcResponse(payload.id, { tools });
    if (payload.method === "tools/call" && payload.params.name === "get_current_user") {
      return rpcResponse(payload.id, { structuredContent: { user: { id: "heygen-user-1", display_name: "Fixture Creator", plan: { name: "Creator" }, credits: { remaining: 19 } } } });
    }
    if (payload.method === "tools/call" && payload.params.name === "video_agent") {
      return rpcResponse(payload.id, { structuredContent: { status: "processing", job_id: "job-r48", session_id: "session-video-r48" } });
    }
    if (payload.method === "tools/call" && payload.params.name === "translate_video") {
      return rpcResponse(payload.id, { structuredContent: { status: "completed", resource_id: "resource-r48", video_url: "https://files.heygen.com/video-r48.mp4" } });
    }
    throw new Error(`Unexpected MCP fixture method ${payload.method}`);
  };
  return { calls, client: createHeyGenMcpClient({ accessToken: "fixture-access-token", fetchImpl }) };
}

test("MCP initializes once, lists tools, and verifies current-user identity", async () => {
  const fixture = mcpFixture();
  const current = await fixture.client.getCurrentUser();
  assert.deepEqual(current.identity, {
    accountId: "heygen-user-1",
    displayName: "Fixture Creator",
    plan: "Creator",
    credits: { available: true, remaining: 19 }
  });
  assert.equal(current.tools.length, 4);
  assert.deepEqual(fixture.calls.map(call => call.payload.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  assert.equal(fixture.calls.every(call => call.headers.Authorization === "Bearer fixture-access-token"), true);
  assert.equal(fixture.calls.at(-1).headers["Mcp-Session-Id"], "session-r48");
});

test("MCP maps bounded logical arguments and carries idempotency metadata", async () => {
  const fixture = mcpFixture();
  const created = await fixture.client.callAction("prompt_to_video", { prompt: "Create a product walkthrough", operationId: "operation-r48" });
  assert.equal(created.outcome.status, "processing");
  assert.equal(created.outcome.providerJobId, "job-r48");
  const call = fixture.calls.find(item => item.payload.method === "tools/call" && item.payload.params.name === "video_agent");
  assert.deepEqual(call.payload.params.arguments, { prompt: "Create a product walkthrough", operation_id: "operation-r48" });
  assert.deepEqual(call.payload.params._meta, { operationId: "operation-r48" });

  const translated = await fixture.client.callAction("translate_video", { sourceAssetId: "asset-r48", locale: "fr-FR", glossaryId: "glossary-r48" });
  assert.equal(translated.outcome.status, "completed");
  assert.equal(translated.outcome.previewUrl, "https://files.heygen.com/video-r48.mp4");
});

test("MCP refuses unadvertised tools, arbitrary URLs, nested values, and missing schema fields", async () => {
  const fixture = mcpFixture();
  await assert.rejects(fixture.client.callAction("browser_navigate", { url: "https://example.com" }), error => error.code === "mcp_action_unsupported");
  await assert.rejects(fixture.client.callAction("prompt_to_video", { url: "https://example.com" }), error => error.code === "mcp_arguments_invalid");
  await assert.rejects(fixture.client.callAction("prompt_to_video", { prompt: { text: "nested" } }), error => error.code === "mcp_arguments_invalid");
  await assert.rejects(fixture.client.callAction("prompt_to_video", {}), error => error.code === "mcp_required_argument_missing");
  await assert.rejects(fixture.client.callAction("prompt_to_video", { prompt: "x".repeat(8001) }), error => error.code === "mcp_arguments_invalid");
  assert.equal(fixture.calls.some(item => item.payload.params?.name === "browser_navigate"), false);
});

test("MCP rejects endpoint confusion, oversized responses, and timeouts", async () => {
  assert.throws(() => createHeyGenMcpClient({ accessToken: "token", endpoint: "https://mcp.heygen.com.evil.example/mcp/v1/", fetchImpl: async () => null }), error => error.code === "mcp_endpoint_invalid");

  const oversized = createHeyGenMcpClient({
    accessToken: "token",
    maxResponseBytes: 1024,
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": "2048" } })
  });
  await assert.rejects(oversized.initialize(), error => error.code === "mcp_response_too_large");

  const timedOut = createHeyGenMcpClient({
    accessToken: "token",
    timeoutMs: 250,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    })
  });
  await assert.rejects(timedOut.initialize(), error => error.code === "mcp_timeout");
});

test("identity and media normalization expose only bounded safe fields", () => {
  assert.throws(() => normalizeHeyGenIdentity({ structuredContent: { user: { id: "https://not-an-id.example" } } }), error => error.code === "mcp_identity_unverified");
  const outcome = normalizeHeyGenToolResult({
    structuredContent: {
      status: "completed",
      resource_id: "resource-1",
      video_url: "https://evil.example/video.mp4#secret",
      message: "done\u0000now"
    }
  });
  assert.equal(outcome.previewUrl, null);
  assert.equal(outcome.message, "done now");

  const signedUrl = normalizeHeyGenToolResult({
    structuredContent: {
      status: "completed",
      resource_id: "resource-2",
      video_url: "https://files.heygen.com/video-r48.mp4?token=fixture-secret"
    }
  });
  assert.equal(signedUrl.previewUrl, null);

  const secret = "fixture-provider-secret";
  const failure = sanitizeHeyGenMcpError(new Error(secret));
  assert.equal(JSON.stringify(failure).includes(secret), false);
  assert.deepEqual(failure, { ok: false, code: "mcp_unavailable", error: "HeyGen MCP is unavailable.", status: 503 });
});
