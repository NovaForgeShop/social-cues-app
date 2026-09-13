import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  createHeyGenOAuthClient,
  createHeyGenOAuthStateManager,
  createHeyGenPkce,
  sanitizeHeyGenOAuthError
} from "./heygen-oauth-client.mjs";
import { HEYGEN_MCP_ENDPOINT, HEYGEN_OAUTH_CALLBACK } from "./heygen-integration.mjs";

const issuer = "https://auth.heygen.com";
const authorizationMetadata = {
  issuer,
  authorization_endpoint: `${issuer}/oauth/authorize`,
  token_endpoint: `${issuer}/oauth/token`,
  revocation_endpoint: `${issuer}/oauth/revoke`,
  registration_endpoint: `${issuer}/oauth/register`,
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["mcp:tools"],
  token_endpoint_auth_methods_supported: ["client_secret_basic"]
};

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function oauthFixture({ resource = HEYGEN_MCP_ENDPOINT, metadata = authorizationMetadata } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", headers: { ...(init.headers || {}) }, body: String(init.body || "") });
    if (String(url).includes("oauth-protected-resource")) {
      return jsonResponse({ resource, authorization_servers: [issuer] });
    }
    if (String(url).includes("oauth-authorization-server")) return jsonResponse(metadata);
    if (String(url).endsWith("/oauth/token")) {
      return jsonResponse({ access_token: "access-fixture-token", refresh_token: "refresh-fixture-token", token_type: "Bearer", expires_in: 3600, scope: "mcp:tools" });
    }
    if (String(url).endsWith("/oauth/revoke")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  return { calls, client: createHeyGenOAuthClient({ fetchImpl }) };
}

test("runtime discovery enforces the fixed resource, HTTPS issuer, and PKCE S256", async () => {
  const fixture = oauthFixture();
  const metadata = await fixture.client.discover();
  assert.equal(metadata.resource, HEYGEN_MCP_ENDPOINT);
  assert.equal(metadata.issuer, issuer);
  assert.equal(metadata.authorizationEndpoint, `${issuer}/oauth/authorize`);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls.every(call => new URL(call.url).hostname.endsWith("heygen.com")), true);

  const pkce = createHeyGenPkce({ randomBytes: size => Buffer.alloc(size, 7) });
  assert.equal(pkce.method, "S256");
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(pkce.challenge, crypto.createHash("sha256").update(pkce.verifier).digest("base64url"));
  const authorizationUrl = new URL(fixture.client.authorizationUrl(metadata, {
    clientId: "client-r48",
    state: "signed-state",
    codeChallenge: pkce.challenge,
    scopes: ["mcp:tools", "unadvertised"]
  }));
  assert.equal(authorizationUrl.origin, issuer);
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), HEYGEN_OAUTH_CALLBACK);
  assert.equal(authorizationUrl.searchParams.get("resource"), HEYGEN_MCP_ENDPOINT);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("scope"), "mcp:tools");
});

test("OAuth exchange, refresh, and advertised revocation use only injected transport", async () => {
  const fixture = oauthFixture();
  const metadata = await fixture.client.discover();
  const verifier = createHeyGenPkce().verifier;
  const token = await fixture.client.exchangeCode(metadata, {
    code: "fixture-code",
    verifier,
    clientId: "client-r48",
    clientSecret: "client-secret-fixture"
  });
  assert.equal(token.accessToken, "access-fixture-token");
  const exchange = fixture.calls.find(call => call.url.endsWith("/oauth/token"));
  assert.match(exchange.body, /grant_type=authorization_code/);
  assert.match(exchange.body, /code_verifier=/);
  assert.equal(exchange.headers.Authorization.startsWith("Basic "), true);

  await fixture.client.refresh(metadata, {
    refreshToken: token.refreshToken,
    clientId: "client-r48",
    clientSecret: "client-secret-fixture"
  });
  const tokenCalls = fixture.calls.filter(call => call.url.endsWith("/oauth/token"));
  assert.equal(tokenCalls.length, 2);
  assert.match(tokenCalls[1].body, /grant_type=refresh_token/);

  const revoked = await fixture.client.revoke(metadata, { token: token.accessToken, clientId: "client-r48" });
  assert.deepEqual(revoked, { attempted: true, state: "remote_revocation_confirmed" });
  const unavailable = await fixture.client.revoke({ ...metadata, revocationEndpoint: null }, { token: token.accessToken, clientId: "client-r48" });
  assert.deepEqual(unavailable, { attempted: false, state: "remote_revocation_unavailable" });
});

test("OAuth discovery rejects origin confusion and unsupported metadata", async () => {
  const confusedResource = oauthFixture({ resource: "https://mcp.heygen.com.evil.example/mcp/v1/" });
  await assert.rejects(confusedResource.client.discover(), error => error.code === "oauth_metadata_invalid");

  const mixedOrigin = oauthFixture({
    metadata: { ...authorizationMetadata, token_endpoint: "https://tokens.heygen.com/oauth/token" }
  });
  await assert.rejects(mixedOrigin.client.discover(), error => error.code === "oauth_endpoint_origin_mismatch");

  const noPkce = oauthFixture({
    metadata: { ...authorizationMetadata, code_challenge_methods_supported: ["plain"] }
  });
  await assert.rejects(noPkce.client.discover(), error => error.code === "oauth_pkce_unsupported");
});

test("signed OAuth state is single-use, expiring, and bound to user plus workspace", () => {
  let now = Date.parse("2026-09-13T12:00:00Z");
  const ledger = [];
  const manager = createHeyGenOAuthStateManager({
    secret: "state-secret-for-heygen-r48",
    clock: () => now,
    randomBytes: size => Buffer.alloc(size, 3),
    protectVerifier: value => ({ sealed: Buffer.from(String(value)).toString("base64url") }),
    unprotectVerifier: value => Buffer.from(value.sealed, "base64url").toString("utf8")
  });
  const metadata = {
    resource: HEYGEN_MCP_ENDPOINT,
    issuer,
    authorizationEndpoint: `${issuer}/oauth/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
    registrationEndpoint: null,
    revocationEndpoint: null,
    scopesSupported: [],
    tokenEndpointAuthMethods: []
  };
  const state = manager.issue(ledger, { actorId: "user-a", workspaceId: "workspace-a", verifier: "v".repeat(64), metadata });
  assert.equal(ledger.length, 1);
  assert.equal(JSON.stringify(ledger).includes("v".repeat(64)), false);
  assert.throws(() => manager.consume(ledger, { state, actorId: "user-b", workspaceId: "workspace-a" }), error => error.code === "oauth_state_owner_mismatch");
  assert.equal(ledger.length, 1);
  const consumed = manager.consume(ledger, { state, actorId: "user-a", workspaceId: "workspace-a" });
  assert.equal(consumed.verifier, "v".repeat(64));
  assert.equal(ledger.length, 0);
  assert.throws(() => manager.consume(ledger, { state, actorId: "user-a", workspaceId: "workspace-a" }), error => error.code === "oauth_state_replayed");

  const expiringState = manager.issue(ledger, { actorId: "user-a", workspaceId: "workspace-a", verifier: "z".repeat(64), metadata });
  now += 11 * 60 * 1000;
  assert.throws(() => manager.consume(ledger, { state: expiringState, actorId: "user-a", workspaceId: "workspace-a" }), error => error.code === "oauth_state_expired");
  assert.equal(ledger.length, 0);
});

test("unexpected OAuth failures are sanitized without credential material", () => {
  const secret = "do-not-expose-this-token";
  const failure = sanitizeHeyGenOAuthError(new Error(secret));
  assert.deepEqual(failure, { ok: false, code: "heygen_oauth_unavailable", error: "HeyGen OAuth is temporarily unavailable.", status: 503 });
  assert.equal(JSON.stringify(failure).includes(secret), false);
});
