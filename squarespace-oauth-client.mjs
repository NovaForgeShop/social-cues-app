import { createHash, randomBytes as secureRandomBytes } from "node:crypto";

import { squarespaceExtensionConfig } from "./squarespace-extension-config.mjs";

const STATE_PATTERN = /^[A-Za-z0-9._~-]{32,256}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const STATE_ENTROPY_BYTES = 32;
const STATE_ERROR_MESSAGE = "OAuth state is missing, expired, mismatched, or already used.";

class SquarespaceOAuthError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "SquarespaceOAuthError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, code, details) {
  throw new SquarespaceOAuthError(message, code, details);
}

function requiredCredential(value, name) {
  if (typeof value !== "string" || !value) {
    fail(`${name} must be explicitly injected.`, "SQUARESPACE_OAUTH_CONFIGURATION_ERROR");
  }
  if (/\r|\n/u.test(value)) {
    fail(`${name} contains unsupported characters.`, "SQUARESPACE_OAUTH_CONFIGURATION_ERROR");
  }
  return value;
}

function requiredIdentifier(value, name) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    fail(`${name} is invalid.`, "SQUARESPACE_OAUTH_BINDING_ERROR");
  }
  return value;
}

function normalizeBinding(binding, { requireWebsiteId = false } = {}) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    fail("A workspace connection binding is required.", "SQUARESPACE_OAUTH_BINDING_ERROR");
  }
  const normalized = {
    workspaceId: requiredIdentifier(binding.workspaceId, "workspaceId"),
    connectionId: requiredIdentifier(binding.connectionId, "connectionId")
  };
  if (binding.websiteId !== undefined && binding.websiteId !== null) {
    normalized.websiteId = requiredIdentifier(binding.websiteId, "websiteId");
  } else if (requireWebsiteId) {
    fail("websiteId is required for token refresh.", "SQUARESPACE_OAUTH_BINDING_ERROR");
  }
  return Object.freeze(normalized);
}

function sameBinding(expected, actual, requireWebsiteId) {
  const candidate = normalizeBinding(actual, { requireWebsiteId });
  if (
    candidate.workspaceId !== expected.workspaceId ||
    candidate.connectionId !== expected.connectionId ||
    (requireWebsiteId && candidate.websiteId !== expected.websiteId)
  ) {
    fail("The OAuth token binding does not match this client.", "SQUARESPACE_OAUTH_BINDING_ERROR");
  }
  return candidate;
}

function normalizeState(value) {
  if (typeof value !== "string" || !STATE_PATTERN.test(value)) {
    fail(
      "OAuth state must be a high-entropy, URL-safe value between 32 and 256 characters.",
      "SQUARESPACE_OAUTH_STATE_ERROR"
    );
  }
  return value;
}

function failState() {
  fail(STATE_ERROR_MESSAGE, "SQUARESPACE_OAUTH_STATE_ERROR");
}

function generateSecureState(randomBytesImpl) {
  let bytes;
  try {
    bytes = randomBytesImpl(STATE_ENTROPY_BYTES);
  } catch {
    fail("OAuth state could not be generated securely.", "SQUARESPACE_OAUTH_STATE_ERROR");
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < STATE_ENTROPY_BYTES) {
    fail("OAuth state could not be generated securely.", "SQUARESPACE_OAUTH_STATE_ERROR");
  }
  return normalizeState(Buffer.from(bytes).toString("base64url"));
}

function normalizeTimeout(value) {
  const timeoutMs = value === undefined ? 10_000 : value;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    fail("timeoutMs must be an integer from 1 through 30000.", "SQUARESPACE_OAUTH_CONFIGURATION_ERROR");
  }
  return timeoutMs;
}

function normalizeDuration(value, name, fallback, maximum) {
  const duration = value === undefined ? fallback : value;
  if (!Number.isInteger(duration) || duration < 1 || duration > maximum) {
    fail(`${name} must be an integer from 1 through ${maximum}.`, "SQUARESPACE_OAUTH_CONFIGURATION_ERROR");
  }
  return duration;
}

function normalizeCallbackUrl(value) {
  let callbackUrl;
  try {
    callbackUrl = new URL(String(value));
  } catch {
    fail("The OAuth callback URL is malformed.", "SQUARESPACE_OAUTH_CALLBACK_ERROR");
  }
  const registered = new URL(squarespaceExtensionConfig.routes.redirectUri);
  if (callbackUrl.origin !== registered.origin || callbackUrl.pathname !== registered.pathname) {
    fail("The OAuth callback URL does not match the registered redirect URI.", "SQUARESPACE_OAUTH_CALLBACK_ERROR");
  }
  return callbackUrl;
}

function tokenFingerprint(token) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeTokenPayload(payload, requireRefreshToken) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("Squarespace returned a malformed token response.", "SQUARESPACE_OAUTH_PROVIDER_RESPONSE_ERROR");
  }
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    fail("Squarespace returned a malformed token response.", "SQUARESPACE_OAUTH_PROVIDER_RESPONSE_ERROR");
  }
  if (String(payload.token_type || "").toLowerCase() !== "bearer") {
    fail("Squarespace returned an unsupported token type.", "SQUARESPACE_OAUTH_PROVIDER_RESPONSE_ERROR");
  }
  if (requireRefreshToken && (typeof payload.refresh_token !== "string" || !payload.refresh_token)) {
    fail("Squarespace did not return the required rotating refresh token.", "SQUARESPACE_OAUTH_PROVIDER_RESPONSE_ERROR");
  }
  return Object.freeze({
    tokenType: "bearer",
    accessToken: payload.access_token,
    accessTokenExpiresAt: payload.access_token_expires_at ?? null,
    refreshToken: payload.refresh_token ?? null,
    refreshTokenExpiresAt: payload.refresh_token_expires_at ?? null
  });
}

export function createSquarespaceOAuthClient(options = {}) {
  const clientId = requiredCredential(options.clientId, "clientId");
  const clientSecret = requiredCredential(options.clientSecret, "clientSecret");
  if (typeof options.fetchImpl !== "function") {
    fail("fetchImpl must be explicitly injected.", "SQUARESPACE_OAUTH_CONFIGURATION_ERROR");
  }
  if (Object.prototype.hasOwnProperty.call(options, "generateState")) {
    fail("OAuth state is generated internally.", "SQUARESPACE_OAUTH_CONFIGURATION_ERROR");
  }
  if (options.randomBytesImpl !== undefined && typeof options.randomBytesImpl !== "function") {
    fail("randomBytesImpl must be a function.", "SQUARESPACE_OAUTH_CONFIGURATION_ERROR");
  }
  const fetchImpl = options.fetchImpl;
  const randomBytesImpl = options.randomBytesImpl || secureRandomBytes;
  if (options.nowImpl !== undefined && typeof options.nowImpl !== "function") {
    fail("nowImpl must be a function.", "SQUARESPACE_OAUTH_CONFIGURATION_ERROR");
  }
  const nowImpl = options.nowImpl || Date.now;
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const stateTtlMs = normalizeDuration(options.stateTtlMs, "stateTtlMs", 600_000, 3_600_000);
  const authorizationCodeTtlMs = normalizeDuration(
    options.authorizationCodeTtlMs,
    "authorizationCodeTtlMs",
    120_000,
    120_000
  );
  const binding = normalizeBinding(options.binding);
  const pendingStates = new Map();
  const exchangeableCallbacks = new WeakMap();
  const consumedRefreshTokens = new Set();

  function removeExpiredStates() {
    const now = nowImpl();
    for (const [state, pending] of pendingStates) {
      if (now - pending.createdAt > stateTtlMs) pendingStates.delete(state);
    }
  }

  function consumePendingState(state) {
    const pending = pendingStates.get(state);
    if (!pending || nowImpl() - pending.createdAt > stateTtlMs) {
      pendingStates.delete(state);
      failState();
    }
    pendingStates.delete(state);
    return pending;
  }

  function buildAuthorizeUrl(input = {}) {
    if (Object.prototype.hasOwnProperty.call(input, "state")) {
      fail("OAuth state is generated internally.", "SQUARESPACE_OAUTH_STATE_ERROR");
    }
    removeExpiredStates();
    if (pendingStates.size >= 1_024) {
      fail("Too many OAuth authorization attempts are pending.", "SQUARESPACE_OAUTH_STATE_ERROR");
    }

    let websiteId;
    if (input.websiteId !== undefined) {
      if (input.websiteIdSource !== "squarespace_initiate") {
        fail(
          "websiteId may be forwarded only from a Squarespace-initiated connection.",
          "SQUARESPACE_OAUTH_WEBSITE_CONTEXT_ERROR"
        );
      }
      websiteId = requiredIdentifier(input.websiteId, "websiteId");
      if (binding.websiteId && binding.websiteId !== websiteId) {
        fail("websiteId does not match this connection binding.", "SQUARESPACE_OAUTH_BINDING_ERROR");
      }
    }

    const state = generateSecureState(randomBytesImpl);
    if (pendingStates.has(state)) {
      fail("OAuth state values must be single-use.", "SQUARESPACE_OAUTH_STATE_ERROR");
    }
    pendingStates.set(state, Object.freeze({ binding, websiteId: websiteId ?? null, createdAt: nowImpl() }));
    const url = new URL(squarespaceExtensionConfig.oauth.authorizeEndpoint);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", squarespaceExtensionConfig.routes.redirectUri);
    url.searchParams.set("scope", squarespaceExtensionConfig.oauth.scopes.join(","));
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", squarespaceExtensionConfig.oauth.accessType);
    if (websiteId) url.searchParams.set("website_id", websiteId);
    return Object.freeze({ url: url.href, state });
  }

  function parseAuthorizationCallback(input = {}) {
    const callbackUrl = normalizeCallbackUrl(input.callbackUrl);
    const hasCallbackState = callbackUrl.searchParams.has("state");
    const callbackState = callbackUrl.searchParams.get("state");
    const hasProviderError = callbackUrl.searchParams.has("error");
    const errorCode = callbackUrl.searchParams.get("error");
    const hasExpectedState = input.expectedState !== undefined;

    if (hasProviderError) {
      if (hasCallbackState) {
        const returnedState = normalizeState(callbackState);
        if (hasExpectedState) {
          const expectedState = normalizeState(input.expectedState);
          if (returnedState !== expectedState) failState();
          consumePendingState(expectedState);
        }
      } else if (hasExpectedState) {
        consumePendingState(normalizeState(input.expectedState));
      }
      return Object.freeze({
        status: "denied",
        reason: errorCode === "access_denied" ? "access_denied" : "provider_denied"
      });
    }

    const code = callbackUrl.searchParams.get("code");
    if (!code || !IDENTIFIER_PATTERN.test(code)) {
      fail("The OAuth callback did not include a valid authorization code.", "SQUARESPACE_OAUTH_CALLBACK_ERROR");
    }
    if (!hasExpectedState || !hasCallbackState || !callbackState) failState();
    const expectedState = normalizeState(input.expectedState);
    const returnedState = normalizeState(callbackState);
    if (returnedState !== expectedState) failState();
    const pending = consumePendingState(expectedState);
    const authorization = Object.freeze({
      status: "authorized",
      code,
      workspaceId: pending.binding.workspaceId,
      connectionId: pending.binding.connectionId,
      websiteId: pending.websiteId
    });
    exchangeableCallbacks.set(authorization, nowImpl());
    return authorization;
  }

  async function requestTokens(parameters) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(squarespaceExtensionConfig.oauth.tokenEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": squarespaceExtensionConfig.api.userAgent
        },
        body: new URLSearchParams(parameters),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        fail("The Squarespace token request timed out with an unknown provider outcome.", "SQUARESPACE_OAUTH_TIMEOUT");
      }
      fail("The Squarespace token request failed with an unknown provider outcome.", "SQUARESPACE_OAUTH_NETWORK_AMBIGUITY");
    } finally {
      clearTimeout(timer);
    }

    if (!response || typeof response.ok !== "boolean") {
      fail("Squarespace returned an invalid token transport response.", "SQUARESPACE_OAUTH_PROVIDER_RESPONSE_ERROR");
    }
    if (!response.ok) {
      fail("Squarespace rejected the token request.", "SQUARESPACE_OAUTH_PROVIDER_ERROR", {
        status: Number.isInteger(response.status) ? response.status : null
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      fail("Squarespace returned a malformed token response.", "SQUARESPACE_OAUTH_PROVIDER_RESPONSE_ERROR");
    }
    return normalizeTokenPayload(payload, true);
  }

  async function exchangeAuthorizationCode(input = {}) {
    const authorization = input.authorization;
    if (!authorization || typeof authorization !== "object" || !exchangeableCallbacks.has(authorization)) {
      fail("Authorization codes must come from a verified, unused callback.", "SQUARESPACE_OAUTH_CODE_ERROR");
    }
    const authorizedAt = exchangeableCallbacks.get(authorization);
    exchangeableCallbacks.delete(authorization);
    if (nowImpl() - authorizedAt > authorizationCodeTtlMs) {
      fail("The authorization code is expired.", "SQUARESPACE_OAUTH_CODE_ERROR");
    }
    return requestTokens({
      grant_type: "authorization_code",
      code: authorization.code,
      redirect_uri: squarespaceExtensionConfig.routes.redirectUri
    });
  }

  async function refreshAccessToken(input = {}) {
    if (!binding.websiteId) {
      fail("This OAuth client is not bound to a Squarespace website.", "SQUARESPACE_OAUTH_BINDING_ERROR");
    }
    sameBinding(binding, input.binding, true);
    const refreshToken = requiredCredential(input.refreshToken, "refreshToken");
    const fingerprint = tokenFingerprint(refreshToken);
    if (consumedRefreshTokens.has(fingerprint)) {
      fail("Refresh tokens are rotating and may be submitted only once.", "SQUARESPACE_OAUTH_REFRESH_TOKEN_REUSED");
    }
    consumedRefreshTokens.add(fingerprint);
    return requestTokens({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  return Object.freeze({
    buildAuthorizeUrl,
    parseAuthorizationCallback,
    exchangeAuthorizationCode,
    refreshAccessToken
  });
}
