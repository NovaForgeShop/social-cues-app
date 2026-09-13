import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createHeyGenApplication, sanitizeHeyGenApplicationError } from "./heygen-application.mjs";
import { resolveHeyGenConfiguration, HEYGEN_MCP_ENDPOINT, HEYGEN_OAUTH_CALLBACK } from "./heygen-integration.mjs";
import { createHeyGenOAuthStateManager } from "./heygen-oauth-client.mjs";

const metadata = {
  resource: HEYGEN_MCP_ENDPOINT,
  issuer: "https://auth.heygen.com",
  authorizationEndpoint: "https://auth.heygen.com/oauth/authorize",
  tokenEndpoint: "https://auth.heygen.com/oauth/token",
  registrationEndpoint: null,
  revocationEndpoint: "https://auth.heygen.com/oauth/revoke",
  scopesSupported: ["mcp:tools"],
  tokenEndpointAuthMethods: ["client_secret_basic"]
};

const advertisedTools = [
  { name: "get_current_user", inputSchema: { type: "object", properties: {} } },
  { name: "video_agent", inputSchema: { type: "object", properties: { prompt: { type: "string" }, operation_id: { type: "string" } }, required: ["prompt"] } }
];

function fixture({ identityAccountId = "provider-user-a", failIdentity = false } = {}) {
  const events = [];
  let mcpCalls = 0;
  const configuration = resolveHeyGenConfiguration({
    HEYGEN_MCP_URL: HEYGEN_MCP_ENDPOINT,
    HEYGEN_INTEGRATION_MODE: "mcp-oauth",
    HEYGEN_DOMAIN_WHITELISTED: "true",
    HEYGEN_OAUTH_CLIENT_ID: "client-r48",
    HEYGEN_OAUTH_CLIENT_SECRET: "client-secret-r48"
  });
  const oauthClient = {
    async discover() { events.push("discover"); return metadata; },
    authorizationUrl(discovered, input) {
      events.push("authorization-url");
      assert.equal(discovered, metadata);
      assert.equal(input.clientId, "client-r48");
      assert.match(input.codeChallenge, /^[A-Za-z0-9_-]{43,128}$/);
      return `${metadata.authorizationEndpoint}?state=${encodeURIComponent(input.state)}`;
    },
    async exchangeCode(discovered, input) {
      events.push("exchange");
      assert.equal(discovered.issuer, metadata.issuer);
      assert.equal(input.code, "authorization-code-r48");
      return { accessToken: "access-token-r48", refreshToken: "refresh-token-r48", tokenType: "Bearer", expiresIn: 3600, scope: "mcp:tools" };
    },
    async refresh() {
      events.push("refresh-token");
      return { accessToken: "access-token-refreshed", refreshToken: "refresh-token-refreshed", tokenType: "Bearer", expiresIn: 7200, scope: "mcp:tools" };
    },
    async revoke(discovered, input) {
      events.push("revoke");
      assert.equal(discovered.revocationEndpoint, metadata.revocationEndpoint);
      assert.equal(input.token, "access-token-r48");
      return { attempted: true, state: "remote_revocation_confirmed" };
    }
  };
  const mcpClientFactory = accessToken => ({
    async getCurrentUser() {
      events.push(`current-user:${accessToken}`);
      mcpCalls += 1;
      if (failIdentity) throw new Error("identity fixture failed");
      return {
        identity: { accountId: identityAccountId, displayName: "Fixture Creator", plan: "Creator", credits: { available: true, remaining: 23 } },
        tools: advertisedTools
      };
    },
    async callAction(action, args) {
      events.push(`action:${action}`);
      mcpCalls += 1;
      return {
        outcome: { status: "processing", providerJobId: "provider-job-r48", sessionId: "session-r48" },
        capability: { id: action, toolName: "video_agent" },
        receivedArgs: args
      };
    }
  });
  const protectToken = value => ({ sealed: Buffer.from(String(value)).toString("base64url") });
  const unprotectToken = value => value?.sealed ? Buffer.from(value.sealed, "base64url").toString("utf8") : "";
  const stateManager = createHeyGenOAuthStateManager({
    secret: "heygen-application-state-secret",
    protectVerifier: protectToken,
    unprotectVerifier: unprotectToken
  });
  const application = createHeyGenApplication({
    configuration,
    oauthClient,
    mcpClientFactory,
    stateManager,
    protectToken,
    unprotectToken,
    persistStateLedger: async ({ reason }) => { events.push(reason); },
    clock: () => new Date("2026-09-13T12:00:00.000Z"),
    createId: () => "account-r48"
  });
  return { application, events, counts: () => ({ mcpCalls }) };
}

test("full mocked OAuth lifecycle verifies identity before returning protected account storage", async () => {
  const { application, events, counts } = fixture();
  const ledger = [];
  const started = await application.beginOAuth({ ledger, actorId: "user-a", workspaceId: "workspace-a", scopes: ["mcp:tools"] });
  assert.equal(started.callbackUrl, HEYGEN_OAUTH_CALLBACK);
  assert.equal(new URL(started.authorizationUrl).origin, "https://auth.heygen.com");
  assert.equal(ledger.length, 1);

  const completed = await application.completeOAuth({
    ledger,
    actorId: "user-a",
    workspaceId: "workspace-a",
    state: started.state,
    code: "authorization-code-r48"
  });
  assert.equal(ledger.length, 0);
  assert.equal(completed.account.providerAccountId, "provider-user-a");
  assert.equal(completed.account.ownerUserId, "user-a");
  assert.equal(completed.account.workspaceId, "workspace-a");
  assert.equal(completed.account.profile.billingRelationship, "customer-owned-heygen-plan");
  assert.equal(completed.account.profile.credits.remaining, 23);
  assert.equal(completed.capabilities.some(item => item.id === "current_user"), true);
  const serialized = JSON.stringify(completed.account);
  assert.equal(serialized.includes("access-token-r48"), false);
  assert.equal(serialized.includes("refresh-token-r48"), false);
  assert.equal(events.indexOf("heygen-oauth-state-consumed") < events.indexOf("exchange"), true);
  assert.equal(events.indexOf("exchange") < events.indexOf("current-user:access-token-r48"), true);
  assert.equal(counts().mcpCalls, 1);
  assert.equal(application.readiness({ account: completed.account }).generation.ready, true);
});

test("refresh re-verifies the same current-user account and rejects account switching", async () => {
  const originalFixture = fixture();
  const ledger = [];
  const started = await originalFixture.application.beginOAuth({ ledger, actorId: "user-a", workspaceId: "workspace-a" });
  const completed = await originalFixture.application.completeOAuth({ ledger, actorId: "user-a", workspaceId: "workspace-a", state: started.state, code: "authorization-code-r48" });
  const refreshed = await originalFixture.application.refreshAccount(completed.account);
  assert.equal(refreshed.providerAccountId, completed.account.providerAccountId);
  assert.equal(JSON.stringify(refreshed).includes("access-token-refreshed"), false);
  assert.equal(refreshed.connectionEvidence, "HeyGen access refreshed and current-user identity reverified.");

  const switched = fixture({ identityAccountId: "provider-user-b" });
  await assert.rejects(switched.application.refreshAccount(completed.account), error => error.code === "heygen_account_changed");
});

test("disconnect revokes only through advertised metadata and action calls remain allowlisted by MCP", async () => {
  const { application, events } = fixture();
  const ledger = [];
  const started = await application.beginOAuth({ ledger, actorId: "user-a", workspaceId: "workspace-a" });
  const completed = await application.completeOAuth({ ledger, actorId: "user-a", workspaceId: "workspace-a", state: started.state, code: "authorization-code-r48" });
  const invocation = await application.invokeAccountAction(completed.account, {
    action: "prompt_to_video",
    args: { prompt: "Product launch" },
    operationId: "operation-r48"
  });
  assert.deepEqual(invocation, {
    outcome: { status: "processing", providerJobId: "provider-job-r48", sessionId: "session-r48" },
    capability: { id: "prompt_to_video", toolName: "video_agent" }
  });
  const disconnected = await application.disconnect(completed.account);
  assert.deepEqual(disconnected.remoteRevocation, { attempted: true, state: "remote_revocation_confirmed" });
  assert.equal(events.includes("revoke"), true);
});

test("cancel and failed identity consume state without persisting a connected account", async () => {
  const cancelledFixture = fixture();
  const cancelledLedger = [];
  const cancelled = await cancelledFixture.application.beginOAuth({ ledger: cancelledLedger, actorId: "user-a", workspaceId: "workspace-a" });
  await cancelledFixture.application.cancelOAuth({ ledger: cancelledLedger, actorId: "user-a", workspaceId: "workspace-a", state: cancelled.state });
  assert.equal(cancelledLedger.length, 0);
  await assert.rejects(cancelledFixture.application.cancelOAuth({ ledger: cancelledLedger, actorId: "user-a", workspaceId: "workspace-a", state: cancelled.state }), error => error.code === "oauth_state_replayed");

  const failedFixture = fixture({ failIdentity: true });
  const failedLedger = [];
  const started = await failedFixture.application.beginOAuth({ ledger: failedLedger, actorId: "user-a", workspaceId: "workspace-a" });
  await assert.rejects(failedFixture.application.completeOAuth({ ledger: failedLedger, actorId: "user-a", workspaceId: "workspace-a", state: started.state, code: "authorization-code-r48" }));
  assert.equal(failedLedger.length, 0);
});

test("server and UI expose authenticated workspace routes without a HeyGen credential form", () => {
  const server = fs.readFileSync("server.mjs", "utf8");
  const html = fs.readFileSync("social-cues-app.html", "utf8");
  const vercel = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
  assert.match(server, /async function heygenRequestContext[\s\S]*?sessionFromRequest[\s\S]*?hasActiveAppAccess[\s\S]*?ensureUserWorkspace/);
  for (const route of [
    "/api/heygen/readiness",
    "/api/heygen/account",
    "/api/oauth/heygen/start",
    "/api/oauth/heygen/callback",
    "/api/heygen/refresh",
    "/api/heygen/disconnect",
    "/api/heygen/jobs",
    "/api/heygen/versions"
  ]) assert.equal(server.includes(route), true, `${route} must be present`);
  assert.match(server, /confirmPersistedProviderAccount\([\s\S]*?"heygen"/);
  const callback = server.match(/url\.pathname === "\/api\/oauth\/heygen\/callback"[\s\S]*?return html\(res, 200, oauthReturnBody\("HeyGen"/)?.[0] || "";
  assert.match(callback, /renewOAuthReturnSession\([\s\S]*?context\.session/);
  const providerStack = server.match(/const providerServiceStack = \[[\s\S]*?\n\];/)?.[0] || "";
  const setupFields = server.match(/function providerSetupFields\(\)[\s\S]*?\n\}/)?.[0] || "";
  const integrationStack = html.match(/const integrationStack = \[[\s\S]*?\n    \];/)?.[0] || "";
  assert.match(providerStack, /id: "heygen"[\s\S]*?HEYGEN_DOMAIN_WHITELISTED[\s\S]*?\/api\/heygen\/readiness/);
  assert.match(setupFields, /"heygen"[\s\S]*?Customer billing boundary/);
  assert.match(integrationStack, /id: "heygen"[\s\S]*?\/api\/heygen\/readiness/);
  const heygenCard = html.match(/function renderHeygenAccountCard[\s\S]*?\n\s*function renderAccounts/)?.[0] || "";
  assert.match(heygenCard, /supportedTools/);
  assert.match(heygenCard, /data-heygen-workflow/);
  assert.doesNotMatch(heygenCard, /type="password"|name="apiKey"/);
  assert.equal(JSON.stringify(vercel).includes("server.mjs"), true);
  assert.equal(JSON.stringify(vercel).includes("api/server.mjs"), false);
});

test("unexpected application failures are sanitized", () => {
  const secret = "application-secret-fixture";
  const failure = sanitizeHeyGenApplicationError(new Error(secret));
  assert.equal(JSON.stringify(failure).includes(secret), false);
  assert.deepEqual(failure, { ok: false, code: "heygen_unavailable", error: "HeyGen is temporarily unavailable.", status: 503 });
});
