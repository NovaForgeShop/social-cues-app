import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  HEYGEN_MCP_ENDPOINT,
  HEYGEN_MEDIA_ACTIONS,
  HEYGEN_OAUTH_CALLBACK,
  classifyHeyGenTools,
  heyGenIntakeProjection,
  heyGenReadiness,
  resolveHeyGenConfiguration
} from "./heygen-integration.mjs";
import {
  MOVE_METERING_CONFIGURATION,
  PRICING_CONFIGURATION
} from "./pricing-packaging.mjs";

const approvedEnv = {
  HEYGEN_MCP_URL: HEYGEN_MCP_ENDPOINT,
  HEYGEN_INTEGRATION_MODE: "mcp-oauth",
  HEYGEN_DOMAIN_WHITELISTED: "true",
  HEYGEN_OAUTH_CLIENT_ID: "client-r48"
};

const advertisedTools = [
  { name: "get_current_user", inputSchema: { type: "object", properties: {} } },
  { name: "video_agent", inputSchema: { type: "object", properties: { prompt: { type: "string" }, operation_id: { type: "string" } }, required: ["prompt"] } },
  { name: "translate_video", inputSchema: { type: "object", properties: { video_id: { type: "string" }, target_language: { type: "string" } }, required: ["video_id", "target_language"] } },
  { name: "untrusted_browser", inputSchema: { type: "object", properties: { url: { type: "string" } } } }
];

function connectedAccount(credits = { available: true, remaining: 42 }) {
  return {
    platform: "heygen",
    oauthProvider: "heygen",
    providerAccountId: "heygen-user-1",
    status: "connected",
    tokenStored: true,
    profile: {
      credits,
      oauthMetadata: { issuer: "https://auth.heygen.com" },
      advertisedTools
    }
  };
}

test("configuration is approval-first, fixed-origin, and fail-closed", () => {
  const pending = resolveHeyGenConfiguration({});
  assert.equal(pending.safeReadiness.state, "domain_approval_pending");
  assert.equal(pending.safeReadiness.readyToDiscover, false);
  assert.equal(pending.safeReadiness.callbackUrl, HEYGEN_OAUTH_CALLBACK);
  assert.equal(pending.safeReadiness.socialCuesResellsCredits, false);

  const approved = resolveHeyGenConfiguration(approvedEnv);
  assert.equal(approved.safeReadiness.state, "oauth_discovery_required");
  assert.equal(approved.safeReadiness.readyToDiscover, true);
  assert.equal(approved.safeReadiness.endpoint, HEYGEN_MCP_ENDPOINT);

  const wrongEndpoint = resolveHeyGenConfiguration({ ...approvedEnv, HEYGEN_MCP_URL: "https://mcp.heygen.com.evil.example/mcp/v1/" });
  assert.equal(wrongEndpoint.safeReadiness.state, "mcp_endpoint_invalid");
  assert.equal(wrongEndpoint.safeReadiness.endpoint, null);

  const wrongMode = resolveHeyGenConfiguration({ ...approvedEnv, HEYGEN_INTEGRATION_MODE: "direct-api" });
  assert.equal(wrongMode.safeReadiness.state, "integration_mode_invalid");

  const hostedWithoutEncryption = resolveHeyGenConfiguration({ ...approvedEnv, VERCEL: "1" });
  assert.equal(hostedWithoutEncryption.safeReadiness.state, "token_encryption_missing");
  assert.equal(hostedWithoutEncryption.safeReadiness.secureTokenStorage, false);
});

test("only explicitly mapped MCP tools become Social Cues capabilities", () => {
  const capabilities = classifyHeyGenTools(advertisedTools);
  assert.deepEqual(capabilities.map(item => item.id), ["current_user", "prompt_to_video", "translate_video"]);
  assert.deepEqual(capabilities.map(item => item.mutates), [false, true, true]);
  assert.equal(HEYGEN_MEDIA_ACTIONS.includes("current_user"), false);
  assert.equal(HEYGEN_MEDIA_ACTIONS.includes("session_resources"), false);
  assert.equal(HEYGEN_MEDIA_ACTIONS.includes("prompt_to_video"), true);
});

test("readiness distinguishes OAuth, credits, tools, and durable persistence", () => {
  const configuration = resolveHeyGenConfiguration(approvedEnv);
  const disconnected = heyGenReadiness({ configuration, account: null, durableRepositoryReady: true });
  assert.equal(disconnected.authenticatedAccount.connected, false);
  assert.equal(disconnected.generation.state, "account_not_connected");
  assert.equal(disconnected.connectRoute, "/api/oauth/heygen/start");

  const held = heyGenReadiness({ configuration, account: connectedAccount(), durableRepositoryReady: false });
  assert.equal(held.oauthDiscovery.verified, true);
  assert.equal(held.credits.available, true);
  assert.equal(held.durableRepository.state, "writes_held");
  assert.equal(held.generation.state, "durable_repository_pending");
  assert.equal(held.generation.ready, false);

  const ready = heyGenReadiness({ configuration, account: connectedAccount(), durableRepositoryReady: true });
  assert.equal(ready.durableRepository.ready, true);
  assert.equal(ready.generation.state, "ready");
  assert.equal(ready.supportedTools.some(item => item.id === "prompt_to_video" && item.mutates), true);

  const depleted = heyGenReadiness({ configuration, account: connectedAccount({ available: false, remaining: 0 }), durableRepositoryReady: true });
  assert.equal(depleted.generation.state, "credits_depleted");
  assert.equal(depleted.generation.ready, false);
});

test("intake stays unsubmitted until operator legal fields are resolved", () => {
  const intake = heyGenIntakeProjection();
  assert.equal(intake.submissionAuthorized, false);
  assert.equal(intake.fields.length, 6);
  assert.equal(intake.fields.find(item => item.id === "work_email")?.value, "mr.barton@socialcuesapp.com");
  assert.equal(intake.fields.find(item => item.id === "operator_legal_name")?.value, null);
  assert.equal(intake.fields.find(item => item.id === "company_country")?.value, null);
  assert.match(intake.fields.find(item => item.id === "integration_description")?.value || "", /customers will not handle api keys/i);
});

test("pricing and Move policy remain unchanged and HeyGen has no key path", () => {
  assert.deepEqual(PRICING_CONFIGURATION.plans.map(plan => plan.monthlyPriceCents), [5000, 10000, 15000]);
  assert.equal(MOVE_METERING_CONFIGURATION.weights.find(item => item.id === "rendered-video-minute")?.availability, "planned");
  assert.equal(MOVE_METERING_CONFIGURATION.weights.find(item => item.id === "rendered-video-minute")?.meteringStatus, "planned");

  const sourceFiles = [
    "heygen-integration.mjs",
    "heygen-oauth-client.mjs",
    "heygen-mcp-client.mjs",
    "heygen-media-workflow.mjs",
    "heygen-application.mjs",
    "social-cues-app.html",
    ".env.example"
  ];
  const forbiddenCredentialName = ["HEYGEN", "API", "KEY"].join("_");
  const forbiddenHeader = ["x", "api", "key"].join("-");
  for (const file of sourceFiles) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(source.includes(forbiddenCredentialName), false, `${file} must not expose a provider-key environment path`);
    assert.equal(source.toLowerCase().includes(forbiddenHeader), false, `${file} must not send a provider-key header`);
  }
  assert.equal(fs.readFileSync(new URL("server.mjs", import.meta.url), "utf8").includes(forbiddenCredentialName), false);
});
