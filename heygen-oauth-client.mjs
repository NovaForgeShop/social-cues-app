import crypto from "node:crypto";
import {
  HEYGEN_MCP_ENDPOINT,
  HEYGEN_OAUTH_CALLBACK
} from "./heygen-integration.mjs";

const metadataMaxBytes = 64 * 1024;
const tokenMaxBytes = 64 * 1024;
const stateLifetimeMs = 10 * 60 * 1000;

export class HeyGenOAuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "HeyGenOAuthError";
    this.code = code;
    this.status = status;
  }
}

function cleanText(value = "", max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function oauthError(code, message, status = 400) {
  return new HeyGenOAuthError(code, message, status);
}

function isAllowedHeyGenHost(hostname = "") {
  const host = String(hostname).toLowerCase();
  return host === "heygen.com" || host.endsWith(".heygen.com");
}

function strictHttpsUrl(value, { resource = false, issuerOrigin = "" } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw oauthError("oauth_metadata_invalid", "HeyGen OAuth metadata returned an invalid URL.", 502);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !isAllowedHeyGenHost(url.hostname)) {
    throw oauthError("oauth_metadata_invalid", "HeyGen OAuth metadata returned an unapproved URL.", 502);
  }
  if (resource && url.href.replace(/\/+$/, "/") !== HEYGEN_MCP_ENDPOINT) {
    throw oauthError("oauth_resource_mismatch", "HeyGen OAuth metadata described a different MCP resource.", 502);
  }
  if (issuerOrigin && url.origin !== issuerOrigin) {
    throw oauthError("oauth_endpoint_origin_mismatch", "HeyGen OAuth metadata crossed an unapproved issuer boundary.", 502);
  }
  return url;
}

function protectedResourceMetadataUrl(endpoint = HEYGEN_MCP_ENDPOINT) {
  const resource = strictHttpsUrl(endpoint, { resource: true });
  const suffix = resource.pathname === "/" ? "" : resource.pathname.replace(/^\//, "");
  return new URL(`/.well-known/oauth-protected-resource/${suffix}`, resource.origin).href;
}

function authorizationServerMetadataUrl(issuer) {
  const issuerUrl = strictHttpsUrl(issuer);
  const suffix = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/^\//, "");
  const path = suffix
    ? `/.well-known/oauth-authorization-server/${suffix}`
    : "/.well-known/oauth-authorization-server";
  return new URL(path, issuerUrl.origin).href;
}

async function boundedJson(response, maxBytes, code) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maxBytes) throw oauthError(code, "HeyGen returned an oversized OAuth response.", 502);
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maxBytes) throw oauthError(code, "HeyGen returned an oversized OAuth response.", 502);
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
    return parsed;
  } catch {
    throw oauthError(code, "HeyGen returned an invalid OAuth response.", 502);
  }
}

async function fetchMetadata(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "error"
  });
  if (!response.ok) throw oauthError("oauth_discovery_failed", "HeyGen OAuth discovery is unavailable.", 503);
  return boundedJson(response, metadataMaxBytes, "oauth_metadata_invalid");
}

export function createHeyGenOAuthClient({
  fetchImpl = globalThis.fetch,
  endpoint = HEYGEN_MCP_ENDPOINT,
  callbackUrl = HEYGEN_OAUTH_CALLBACK
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  strictHttpsUrl(endpoint, { resource: true });
  if (callbackUrl !== HEYGEN_OAUTH_CALLBACK) throw oauthError("oauth_callback_invalid", "The HeyGen OAuth callback must use the approved Social Cues URL.");

  async function discover() {
    const resourceDocument = await fetchMetadata(fetchImpl, protectedResourceMetadataUrl(endpoint));
    const resource = strictHttpsUrl(resourceDocument.resource, { resource: true });
    const issuers = Array.isArray(resourceDocument.authorization_servers)
      ? resourceDocument.authorization_servers.map(value => strictHttpsUrl(value).href.replace(/\/$/, ""))
      : [];
    if (!issuers.length) throw oauthError("oauth_issuer_missing", "HeyGen OAuth discovery did not advertise an authorization server.", 502);
    const issuer = issuers[0];
    const authorizationDocument = await fetchMetadata(fetchImpl, authorizationServerMetadataUrl(issuer));
    const issuerUrl = strictHttpsUrl(authorizationDocument.issuer);
    if (issuerUrl.href.replace(/\/$/, "") !== issuer) {
      throw oauthError("oauth_issuer_mismatch", "HeyGen OAuth issuer metadata did not match discovery.", 502);
    }
    const authorizationEndpoint = strictHttpsUrl(authorizationDocument.authorization_endpoint, { issuerOrigin: issuerUrl.origin }).href;
    const tokenEndpoint = strictHttpsUrl(authorizationDocument.token_endpoint, { issuerOrigin: issuerUrl.origin }).href;
    const registrationEndpoint = authorizationDocument.registration_endpoint
      ? strictHttpsUrl(authorizationDocument.registration_endpoint, { issuerOrigin: issuerUrl.origin }).href
      : null;
    const revocationEndpoint = authorizationDocument.revocation_endpoint
      ? strictHttpsUrl(authorizationDocument.revocation_endpoint, { issuerOrigin: issuerUrl.origin }).href
      : null;
    const challengeMethods = Array.isArray(authorizationDocument.code_challenge_methods_supported)
      ? authorizationDocument.code_challenge_methods_supported.map(String)
      : [];
    if (!challengeMethods.includes("S256")) {
      throw oauthError("oauth_pkce_unsupported", "HeyGen OAuth discovery did not advertise PKCE S256.", 503);
    }
    return Object.freeze({
      resource: resource.href,
      issuer: issuerUrl.href.replace(/\/$/, ""),
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      revocationEndpoint,
      scopesSupported: Array.isArray(authorizationDocument.scopes_supported)
        ? authorizationDocument.scopes_supported.map(value => cleanText(value, 120)).filter(Boolean).slice(0, 50)
        : [],
      tokenEndpointAuthMethods: Array.isArray(authorizationDocument.token_endpoint_auth_methods_supported)
        ? authorizationDocument.token_endpoint_auth_methods_supported.map(String).slice(0, 20)
        : []
    });
  }

  function authorizationUrl(metadata, { clientId, state, codeChallenge, scopes = [] } = {}) {
    const endpointUrl = strictHttpsUrl(metadata?.authorizationEndpoint, { issuerOrigin: strictHttpsUrl(metadata?.issuer).origin });
    if (!cleanText(clientId, 500) || !cleanText(state, 4000) || !/^[A-Za-z0-9_-]{43,128}$/.test(String(codeChallenge || ""))) {
      throw oauthError("oauth_start_invalid", "HeyGen OAuth could not start with incomplete PKCE state.");
    }
    const supported = new Set(Array.isArray(metadata.scopesSupported) ? metadata.scopesSupported : []);
    const requestedScopes = (Array.isArray(scopes) ? scopes : []).map(String).filter(scope => !supported.size || supported.has(scope));
    endpointUrl.searchParams.set("response_type", "code");
    endpointUrl.searchParams.set("client_id", cleanText(clientId, 500));
    endpointUrl.searchParams.set("redirect_uri", callbackUrl);
    endpointUrl.searchParams.set("state", state);
    endpointUrl.searchParams.set("code_challenge", codeChallenge);
    endpointUrl.searchParams.set("code_challenge_method", "S256");
    endpointUrl.searchParams.set("resource", HEYGEN_MCP_ENDPOINT);
    if (requestedScopes.length) endpointUrl.searchParams.set("scope", requestedScopes.join(" "));
    return endpointUrl.href;
  }

  async function tokenRequest(metadata, form, { clientId, clientSecret = "" } = {}) {
    const issuerOrigin = strictHttpsUrl(metadata?.issuer).origin;
    const tokenEndpoint = strictHttpsUrl(metadata?.tokenEndpoint, { issuerOrigin }).href;
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    };
    const authMethods = new Set(metadata?.tokenEndpointAuthMethods || []);
    if (clientSecret && authMethods.has("client_secret_basic")) {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    } else {
      form.set("client_id", clientId);
      if (clientSecret) form.set("client_secret", clientSecret);
    }
    const response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers,
      body: form.toString(),
      redirect: "error"
    });
    const payload = await boundedJson(response, tokenMaxBytes, "oauth_token_response_invalid");
    if (!response.ok) throw oauthError("oauth_token_exchange_failed", "HeyGen OAuth did not accept the authorization grant.", 502);
    const accessToken = cleanText(payload.access_token, 8192);
    if (!accessToken) throw oauthError("oauth_token_missing", "HeyGen OAuth did not return an access token.", 502);
    return {
      accessToken,
      refreshToken: cleanText(payload.refresh_token, 8192),
      tokenType: cleanText(payload.token_type || "Bearer", 40),
      expiresIn: Number.isFinite(Number(payload.expires_in)) ? Math.max(1, Number(payload.expires_in)) : null,
      scope: cleanText(payload.scope, 4000)
    };
  }

  async function exchangeCode(metadata, { code, verifier, clientId, clientSecret = "" } = {}) {
    if (!cleanText(code, 8192) || !/^[A-Za-z0-9._~-]{43,128}$/.test(String(verifier || ""))) {
      throw oauthError("oauth_callback_invalid", "HeyGen OAuth returned an incomplete authorization grant.");
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: callbackUrl,
      resource: HEYGEN_MCP_ENDPOINT
    });
    return tokenRequest(metadata, form, { clientId, clientSecret });
  }

  async function refresh(metadata, { refreshToken, clientId, clientSecret = "" } = {}) {
    if (!cleanText(refreshToken, 8192)) throw oauthError("oauth_refresh_missing", "Reconnect HeyGen to renew access.", 409);
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource: HEYGEN_MCP_ENDPOINT
    });
    return tokenRequest(metadata, form, { clientId, clientSecret });
  }

  async function revoke(metadata, { token, clientId, clientSecret = "" } = {}) {
    if (!metadata?.revocationEndpoint) return { attempted: false, state: "remote_revocation_unavailable" };
    const issuerOrigin = strictHttpsUrl(metadata.issuer).origin;
    const endpointUrl = strictHttpsUrl(metadata.revocationEndpoint, { issuerOrigin }).href;
    const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    const form = new URLSearchParams({ token, client_id: clientId });
    if (clientSecret) form.set("client_secret", clientSecret);
    const response = await fetchImpl(endpointUrl, { method: "POST", headers, body: form.toString(), redirect: "error" });
    if (!response.ok) return { attempted: true, state: "remote_revocation_failed" };
    return { attempted: true, state: "remote_revocation_confirmed" };
  }

  return Object.freeze({ discover, authorizationUrl, exchangeCode, refresh, revoke });
}

export function createHeyGenPkce({ randomBytes = crypto.randomBytes } = {}) {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return Object.freeze({ verifier, challenge, method: "S256" });
}

function stateSignature(secret, payloadText) {
  return crypto.createHmac("sha256", secret).update(payloadText).digest("base64url");
}

function stateHash(state) {
  return crypto.createHash("sha256").update(state).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createHeyGenOAuthStateManager({
  secret,
  clock = () => Date.now(),
  randomBytes = crypto.randomBytes,
  protectVerifier = value => value,
  unprotectVerifier = value => value
} = {}) {
  if (String(secret || "").length < 16) throw new TypeError("A server-only OAuth state secret is required");

  function issue(ledger, { actorId, workspaceId, verifier, metadata } = {}) {
    if (!Array.isArray(ledger) || !actorId || !workspaceId || !verifier || !metadata?.issuer) {
      throw oauthError("oauth_state_invalid", "HeyGen OAuth state could not be issued.");
    }
    const now = clock();
    const payload = {
      provider: "heygen",
      nonce: randomBytes(24).toString("base64url"),
      actorId: String(actorId),
      workspaceId: String(workspaceId),
      issuedAt: now,
      expiresAt: now + stateLifetimeMs
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const state = `${encoded}.${stateSignature(secret, encoded)}`;
    for (let index = ledger.length - 1; index >= 0; index -= 1) {
      if (ledger[index]?.provider === "heygen" && Number(ledger[index].expiresAt || 0) < now) ledger.splice(index, 1);
    }
    ledger.push({
      provider: "heygen",
      stateHash: stateHash(state),
      actorId: payload.actorId,
      workspaceId: payload.workspaceId,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      protectedVerifier: protectVerifier(verifier),
      metadata: {
        resource: metadata.resource,
        issuer: metadata.issuer,
        authorizationEndpoint: metadata.authorizationEndpoint,
        tokenEndpoint: metadata.tokenEndpoint,
        registrationEndpoint: metadata.registrationEndpoint || null,
        revocationEndpoint: metadata.revocationEndpoint || null,
        scopesSupported: [...(metadata.scopesSupported || [])],
        tokenEndpointAuthMethods: [...(metadata.tokenEndpointAuthMethods || [])]
      }
    });
    return state;
  }

  function consume(ledger, { state, actorId, workspaceId } = {}) {
    if (!Array.isArray(ledger) || !state || !actorId || !workspaceId) {
      throw oauthError("oauth_state_rejected", "HeyGen OAuth state was rejected.", 400);
    }
    const [encoded, signature, extra] = String(state).split(".");
    if (!encoded || !signature || extra || !safeEqual(signature, stateSignature(secret, encoded))) {
      throw oauthError("oauth_state_rejected", "HeyGen OAuth state was rejected.", 400);
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw oauthError("oauth_state_rejected", "HeyGen OAuth state was rejected.", 400);
    }
    const index = ledger.findIndex(item => item?.provider === "heygen" && safeEqual(item.stateHash, stateHash(state)));
    if (index < 0) throw oauthError("oauth_state_replayed", "HeyGen OAuth state was already used or is unknown.", 409);
    const record = ledger[index];
    if (payload.provider !== "heygen"
      || String(payload.actorId) !== String(actorId)
      || String(payload.workspaceId) !== String(workspaceId)
      || String(record.actorId) !== String(actorId)
      || String(record.workspaceId) !== String(workspaceId)) {
      throw oauthError("oauth_state_owner_mismatch", "HeyGen OAuth state belongs to a different workspace.", 403);
    }
    if (Number(payload.expiresAt || 0) <= clock() || Number(record.expiresAt || 0) <= clock()) {
      ledger.splice(index, 1);
      throw oauthError("oauth_state_expired", "HeyGen OAuth state expired.", 400);
    }
    ledger.splice(index, 1);
    return Object.freeze({
      actorId: record.actorId,
      workspaceId: record.workspaceId,
      verifier: unprotectVerifier(record.protectedVerifier),
      metadata: Object.freeze({ ...record.metadata })
    });
  }

  return Object.freeze({ issue, consume });
}

export function sanitizeHeyGenOAuthError(error) {
  const known = error instanceof HeyGenOAuthError;
  return Object.freeze({
    ok: false,
    code: known ? error.code : "heygen_oauth_unavailable",
    error: known ? error.message : "HeyGen OAuth is temporarily unavailable.",
    status: known ? error.status : 503
  });
}
