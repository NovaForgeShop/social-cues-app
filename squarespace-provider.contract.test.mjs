import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";

import { createSquarespaceApiClient } from "./squarespace-api-client.mjs";
import { squarespaceExtensionConfig } from "./squarespace-extension-config.mjs";
import { createSquarespaceOAuthClient } from "./squarespace-oauth-client.mjs";
import { parseSquarespaceNotification, verifySquarespaceWebhook } from "./squarespace-webhook.mjs";

let checkCount = 0;

async function check(name, action) {
  try {
    await action();
    checkCount += 1;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(payload));
}

async function listen(handler) {
  let serverError;
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      serverError = error;
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, "close");
      if (serverError) throw serverError;
    }
  };
}

function callbackUrl(parameters) {
  const url = new URL(squarespaceExtensionConfig.routes.redirectUri);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.href;
}

function deterministicRandomBytes(start = 1, observedSizes = []) {
  let value = start;
  return (size) => {
    observedSizes.push(size);
    const bytes = Buffer.alloc(size, value);
    value = value === 255 ? 1 : value + 1;
    return bytes;
  };
}

function assertSanitizedStateError(action, hiddenValues = []) {
  assert.throws(action, (error) => {
    const serialized = JSON.stringify({ message: error.message, code: error.code, details: error.details });
    for (const value of hiddenValues) assert.equal(serialized.includes(value), false);
    return error.code === "SQUARESPACE_OAUTH_STATE_ERROR";
  });
}

const expectedScopes = [
  "website.products.read",
  "website.inventory.read",
  "website.orders.read",
  "website.transactions.read",
  "website.contacts.read",
  "website.discounts.read"
];

await check("portal manifest is exact, frozen, and read-only", async () => {
  assert.equal(squarespaceExtensionConfig.provider, "squarespace");
  assert.equal(squarespaceExtensionConfig.application.displayName, "Social Cues");
  assert.equal(
    squarespaceExtensionConfig.routes.redirectUri,
    "https://socialcuesapp.com/api/oauth/squarespace/callback"
  );
  assert.equal(squarespaceExtensionConfig.routes.initiateUrl, "https://socialcuesapp.com/api/oauth/squarespace/start");
  assert.deepEqual(squarespaceExtensionConfig.oauth.scopes, expectedScopes);
  assert.equal(squarespaceExtensionConfig.oauth.accessType, "offline");
  assert.equal(squarespaceExtensionConfig.portalRegistration.state, "DEMO");
  assert.equal(squarespaceExtensionConfig.portalRegistration.reviewSubmitted, false);
  assert.match(squarespaceExtensionConfig.webhooks.contactTopicScopeBlocker, /website\.contacts\.read/u);
  assert.ok(Object.isFrozen(squarespaceExtensionConfig));
  assert.ok(Object.isFrozen(squarespaceExtensionConfig.oauth.scopes));
  assert.equal(expectedScopes.some((scope) => !scope.endsWith(".read")), false);
});

const configSource = await readFile(new URL("./squarespace-extension-config.mjs", import.meta.url), "utf8");
const oauthSource = await readFile(new URL("./squarespace-oauth-client.mjs", import.meta.url), "utf8");
const apiSource = await readFile(new URL("./squarespace-api-client.mjs", import.meta.url), "utf8");
const webhookSource = await readFile(new URL("./squarespace-webhook.mjs", import.meta.url), "utf8");
const testSource = await readFile(new URL("./squarespace-provider.contract.test.mjs", import.meta.url), "utf8");

await check("registration values have one source and no server dependency", async () => {
  assert.equal(configSource.split(squarespaceExtensionConfig.routes.redirectUri).length - 1, 1);
  assert.equal(configSource.split(squarespaceExtensionConfig.routes.initiateUrl).length - 1, 1);
  for (const scope of expectedScopes) {
    assert.equal(configSource.split(`\"${scope}\"`).length - 1, 1);
    assert.equal(oauthSource.includes(scope), false);
    assert.equal(apiSource.includes(scope), false);
  }
  for (const source of [configSource, oauthSource, apiSource, webhookSource, testSource]) {
    assert.equal(/from\s+["'][^"']*server\.mjs["']/u.test(source), false);
  }
  assert.equal(/process\.env/u.test(oauthSource), false);
  assert.equal(/process\.env/u.test(apiSource), false);
});

const oauthRequests = [];
const oauthMock = await listen(async (request, response) => {
  const body = await requestBody(request);
  oauthRequests.push({
    method: request.method,
    headers: { ...request.headers },
    body
  });
  const parameters = new URLSearchParams(body);
  if (parameters.get("code") === "providerFailure") {
    sendJson(response, 400, {
      error: "invalid_grant",
      leakedClient: "fake-client-one",
      leakedSecret: "fake-secret-one",
      leakedToken: "fake-refresh-one"
    });
    return;
  }
  sendJson(response, 200, {
    token_type: "bearer",
    access_token: `fake-access-${oauthRequests.length}`,
    access_token_expires_at: "9999999999",
    refresh_token: `fake-refresh-${oauthRequests.length}`,
    refresh_token_expires_at: "9999999999",
    futureField: true
  });
});

const bindingOne = Object.freeze({ workspaceId: "workspace-one", connectionId: "connection-one" });
const oauthFetch = async (url, init) => {
  assert.equal(url, squarespaceExtensionConfig.oauth.tokenEndpoint);
  return fetch(`${oauthMock.origin}/tokens`, init);
};
const oauthClient = createSquarespaceOAuthClient({
  clientId: "fake-client-one",
  clientSecret: "fake-secret-one",
  fetchImpl: oauthFetch,
  randomBytesImpl: deterministicRandomBytes(1),
  binding: bindingOne
});

await check("authorize URL uses manifest values and offline access", async () => {
  const authorization = oauthClient.buildAuthorizeUrl();
  const url = new URL(authorization.url);
  assert.equal(url.origin + url.pathname, squarespaceExtensionConfig.oauth.authorizeEndpoint);
  assert.equal(url.searchParams.get("client_id"), "fake-client-one");
  assert.equal(url.searchParams.get("redirect_uri"), squarespaceExtensionConfig.routes.redirectUri);
  assert.equal(url.searchParams.get("scope"), expectedScopes.join(","));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("state"), authorization.state);
  assert.equal(url.searchParams.has("website_id"), false);
  const generated = oauthClient.buildAuthorizeUrl();
  assert.equal(new URL(generated.url).searchParams.get("state"), generated.state);
  assert.notEqual(generated.state, authorization.state);
});

await check("website ID is forwarded only from an intentional Squarespace initiate", async () => {
  assert.throws(
    () => oauthClient.buildAuthorizeUrl({ websiteId: "site-one" }),
    (error) => error.code === "SQUARESPACE_OAUTH_WEBSITE_CONTEXT_ERROR"
  );
  const result = oauthClient.buildAuthorizeUrl({
    websiteId: "site-one",
    websiteIdSource: "squarespace_initiate"
  });
  assert.equal(new URL(result.url).searchParams.get("website_id"), "site-one");
});

await check("state is generated internally from at least 256 bits of secure randomness", async () => {
  const observedSizes = [];
  const entropy = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const entropyClient = createSquarespaceOAuthClient({
    clientId: "client",
    clientSecret: "secret",
    fetchImpl: oauthFetch,
    randomBytesImpl: (size) => {
      observedSizes.push(size);
      return Buffer.from(entropy);
    },
    binding: bindingOne
  });
  const generated = entropyClient.buildAuthorizeUrl();
  assert.deepEqual(observedSizes, [32]);
  assert.equal(generated.state, entropy.toString("base64url"));
  assert.match(generated.state, /^[A-Za-z0-9_-]{43}$/u);
  for (const identifier of [bindingOne.workspaceId, bindingOne.connectionId, "site-one"]) {
    assert.equal(generated.state.includes(identifier), false);
  }
  assertSanitizedStateError(() => entropyClient.buildAuthorizeUrl(), [generated.state]);
  assert.deepEqual(observedSizes, [32, 32]);
  assertSanitizedStateError(() => entropyClient.buildAuthorizeUrl({ state: "caller-controlled-state-value-1234" }));
  assert.throws(
    () =>
      createSquarespaceOAuthClient({
        clientId: "client",
        clientSecret: "secret",
        fetchImpl: oauthFetch,
        generateState: () => "legacy-caller-controlled-state-value",
        binding: bindingOne
      }),
    (error) => error.code === "SQUARESPACE_OAUTH_CONFIGURATION_ERROR"
  );
  const shortEntropyClient = createSquarespaceOAuthClient({
    clientId: "client",
    clientSecret: "secret",
    fetchImpl: oauthFetch,
    randomBytesImpl: () => Buffer.alloc(31),
    binding: bindingOne
  });
  assertSanitizedStateError(() => shortEntropyClient.buildAuthorizeUrl());
  const unavailableEntropyClient = createSquarespaceOAuthClient({
    clientId: "client",
    clientSecret: "secret",
    fetchImpl: oauthFetch,
    randomBytesImpl: () => {
      throw new Error("random source unavailable");
    },
    binding: bindingOne
  });
  assertSanitizedStateError(() => unavailableEntropyClient.buildAuthorizeUrl(), ["random source unavailable"]);

  const productionDefault = createSquarespaceOAuthClient({
    clientId: "client",
    clientSecret: "secret",
    fetchImpl: oauthFetch,
    binding: bindingOne
  });
  const first = productionDefault.buildAuthorizeUrl();
  const second = productionDefault.buildAuthorizeUrl();
  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(first.state, second.state);
  assert.match(oauthSource, /randomBytes as secureRandomBytes/u);
  assert.match(oauthSource, /STATE_ENTROPY_BYTES = 32/u);
  assert.equal(oauthSource.includes("Math.random"), false);
  assert.equal(/Date\.now\(\).*state|state.*Date\.now\(\)/u.test(oauthSource), false);
  assert.equal(oauthSource.includes("input.state ??"), false);
});

await check("successful callbacks require an exact returned and expected issued state", async () => {
  const issued = oauthClient.buildAuthorizeUrl();
  const wrongState = Buffer.alloc(32, 250).toString("base64url");
  const requestCount = oauthRequests.length;
  assertSanitizedStateError(
    () =>
      oauthClient.parseAuthorizationCallback({
        callbackUrl: callbackUrl({ code: "missingReturnedState" }),
        expectedState: issued.state
      }),
    [issued.state]
  );
  assertSanitizedStateError(
    () =>
      oauthClient.parseAuthorizationCallback({
        callbackUrl: callbackUrl({ code: "blankReturnedState", state: "" }),
        expectedState: issued.state
      }),
    [issued.state]
  );
  assertSanitizedStateError(
    () =>
      oauthClient.parseAuthorizationCallback({
        callbackUrl: callbackUrl({ code: "malformedReturnedState", state: "not valid" }),
        expectedState: issued.state
      }),
    [issued.state, "not valid"]
  );
  assertSanitizedStateError(
    () =>
      oauthClient.parseAuthorizationCallback({
        callbackUrl: callbackUrl({ code: "wrongReturnedState", state: wrongState }),
        expectedState: issued.state
      }),
    [issued.state, wrongState]
  );
  assertSanitizedStateError(
    () => oauthClient.parseAuthorizationCallback({ callbackUrl: callbackUrl({ code: "missingExpectedState", state: issued.state }) }),
    [issued.state]
  );
  assert.equal(oauthRequests.length, requestCount);

  const authorization = oauthClient.parseAuthorizationCallback({
    callbackUrl: callbackUrl({ code: "exactState", state: issued.state }),
    expectedState: issued.state
  });
  assert.equal(authorization.status, "authorized");
  assert.equal(authorization.workspaceId, bindingOne.workspaceId);
  assert.equal(authorization.connectionId, bindingOne.connectionId);
  assert.equal(JSON.stringify(authorization).includes(issued.state), false);
  assertSanitizedStateError(
    () =>
      oauthClient.parseAuthorizationCallback({
        callbackUrl: callbackUrl({ code: "replayedState", state: issued.state }),
        expectedState: issued.state
      }),
    [issued.state]
  );
  assert.equal(oauthRequests.length, requestCount);
});

await check("state and authorization-code lifetimes are bounded", async () => {
  let now = 0;
  const expiring = createSquarespaceOAuthClient({
    clientId: "client",
    clientSecret: "secret",
    fetchImpl: oauthFetch,
    binding: bindingOne,
    randomBytesImpl: deterministicRandomBytes(40),
    nowImpl: () => now,
    stateTtlMs: 5,
    authorizationCodeTtlMs: 5
  });
  const expired = expiring.buildAuthorizeUrl();
  now = 6;
  assertSanitizedStateError(
    () =>
      expiring.parseAuthorizationCallback({
        callbackUrl: callbackUrl({ state: expired.state, code: "expiredState" }),
        expectedState: expired.state
      }),
    [expired.state]
  );
  const expiringCode = expiring.buildAuthorizeUrl();
  const authorization = expiring.parseAuthorizationCallback({
    callbackUrl: callbackUrl({ state: expiringCode.state, code: "expiredCode" }),
    expectedState: expiringCode.state
  });
  now = 12;
  const requestCount = oauthRequests.length;
  await assert.rejects(
    expiring.exchangeAuthorizationCode({ authorization }),
    (error) => error.code === "SQUARESPACE_OAUTH_CODE_ERROR"
  );
  assert.equal(oauthRequests.length, requestCount);
});

await check("concurrent callbacks cannot consume the same state twice", async () => {
  const concurrent = createSquarespaceOAuthClient({
    clientId: "client",
    clientSecret: "secret",
    fetchImpl: oauthFetch,
    randomBytesImpl: deterministicRandomBytes(60),
    binding: bindingOne
  });
  const issued = concurrent.buildAuthorizeUrl();
  const input = {
    callbackUrl: callbackUrl({ state: issued.state, code: "concurrentCode" }),
    expectedState: issued.state
  };
  const requestCount = oauthRequests.length;
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => concurrent.parseAuthorizationCallback(input)),
    Promise.resolve().then(() => concurrent.parseAuthorizationCallback(input))
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const rejection = attempts.find((attempt) => attempt.status === "rejected");
  assert.equal(rejection.reason.code, "SQUARESPACE_OAUTH_STATE_ERROR");
  assert.equal(JSON.stringify(rejection.reason).includes(issued.state), false);
  assert.equal(oauthRequests.length, requestCount);
});

await check("denial callbacks never authorize or exchange a code", async () => {
  const withoutReturnedState = oauthClient.buildAuthorizeUrl();
  const requestCount = oauthRequests.length;
  const denial = oauthClient.parseAuthorizationCallback({
    callbackUrl: callbackUrl({ error: "access_denied" }),
    expectedState: withoutReturnedState.state
  });
  assert.deepEqual(denial, { status: "denied", reason: "access_denied" });
  assert.equal(oauthRequests.length, requestCount);
  assertSanitizedStateError(
    () =>
      oauthClient.parseAuthorizationCallback({
        callbackUrl: callbackUrl({ state: withoutReturnedState.state, code: "deniedReplay" }),
        expectedState: withoutReturnedState.state
      }),
    [withoutReturnedState.state]
  );

  const withReturnedState = oauthClient.buildAuthorizeUrl();
  const withState = oauthClient.parseAuthorizationCallback({
    callbackUrl: callbackUrl({ error: "provider_error", state: withReturnedState.state }),
    expectedState: withReturnedState.state
  });
  assert.deepEqual(withState, { status: "denied", reason: "provider_denied" });
  assert.equal(oauthRequests.length, requestCount);

  const noStateContext = oauthClient.parseAuthorizationCallback({ callbackUrl: callbackUrl({ error: "access_denied" }) });
  assert.deepEqual(noStateContext, { status: "denied", reason: "access_denied" });
  assert.equal(oauthRequests.length, requestCount);

  const noExpectedState = oauthClient.buildAuthorizeUrl();
  const unboundDenial = oauthClient.parseAuthorizationCallback({
    callbackUrl: callbackUrl({ error: "access_denied", state: noExpectedState.state })
  });
  assert.deepEqual(unboundDenial, { status: "denied", reason: "access_denied" });
  const stillUsable = oauthClient.parseAuthorizationCallback({
    callbackUrl: callbackUrl({ code: "stillUsable", state: noExpectedState.state }),
    expectedState: noExpectedState.state
  });
  assert.equal(stillUsable.status, "authorized");

  const codeAndErrorState = oauthClient.buildAuthorizeUrl();
  const codeAndError = oauthClient.parseAuthorizationCallback({
    callbackUrl: callbackUrl({ code: "mustNotExchange", error: "access_denied", state: codeAndErrorState.state }),
    expectedState: codeAndErrorState.state
  });
  assert.deepEqual(codeAndError, { status: "denied", reason: "access_denied" });
  await assert.rejects(
    oauthClient.exchangeAuthorizationCode({ authorization: codeAndError }),
    (error) => error.code === "SQUARESPACE_OAUTH_CODE_ERROR"
  );
  assert.equal(oauthRequests.length, requestCount);
});

await check("authorization code exchange uses Basic auth once", async () => {
  const issued = oauthClient.buildAuthorizeUrl();
  const authorization = oauthClient.parseAuthorizationCallback({
    callbackUrl: callbackUrl({ state: issued.state, code: "codeExchange" }),
    expectedState: issued.state
  });
  const tokens = await oauthClient.exchangeAuthorizationCode({ authorization });
  assert.equal(tokens.tokenType, "bearer");
  const recorded = oauthRequests.at(-1);
  const parameters = new URLSearchParams(recorded.body);
  assert.equal(recorded.method, "POST");
  assert.equal(parameters.get("grant_type"), "authorization_code");
  assert.equal(parameters.get("code"), "codeExchange");
  assert.equal(parameters.get("redirect_uri"), squarespaceExtensionConfig.routes.redirectUri);
  assert.equal(parameters.has("client_id"), false);
  assert.equal(parameters.has("client_secret"), false);
  assert.equal(recorded.headers.authorization, `Basic ${Buffer.from("fake-client-one:fake-secret-one").toString("base64")}`);
  assert.equal(recorded.headers["user-agent"], squarespaceExtensionConfig.api.userAgent);
  const requestCount = oauthRequests.length;
  await assert.rejects(
    oauthClient.exchangeAuthorizationCode({ authorization }),
    (error) => error.code === "SQUARESPACE_OAUTH_CODE_ERROR"
  );
  assert.equal(oauthRequests.length, requestCount);
});

await check("provider errors redact credentials, tokens, and codes", async () => {
  const issued = oauthClient.buildAuthorizeUrl();
  const authorization = oauthClient.parseAuthorizationCallback({
    callbackUrl: callbackUrl({ state: issued.state, code: "providerFailure" }),
    expectedState: issued.state
  });
  await assert.rejects(oauthClient.exchangeAuthorizationCode({ authorization }), (error) => {
    const serialized = JSON.stringify({ message: error.message, code: error.code, details: error.details });
    assert.equal(serialized.includes("fake-client-one"), false);
    assert.equal(serialized.includes("fake-secret-one"), false);
    assert.equal(serialized.includes("fake-refresh-one"), false);
    assert.equal(serialized.includes("providerFailure"), false);
    return error.code === "SQUARESPACE_OAUTH_PROVIDER_ERROR";
  });
});

await check("separate OAuth clients cannot inspect or consume each other's state", async () => {
  const first = createSquarespaceOAuthClient({
    clientId: "client-one",
    clientSecret: "secret-one",
    fetchImpl: oauthFetch,
    randomBytesImpl: deterministicRandomBytes(80),
    binding: bindingOne
  });
  const second = createSquarespaceOAuthClient({
    clientId: "client-two",
    clientSecret: "secret-two",
    fetchImpl: oauthFetch,
    randomBytesImpl: deterministicRandomBytes(90),
    binding: { workspaceId: "workspace-two", connectionId: "connection-two" }
  });
  const issued = first.buildAuthorizeUrl();
  const callback = callbackUrl({ state: issued.state, code: "isolatedCode" });
  assertSanitizedStateError(
    () => second.parseAuthorizationCallback({ callbackUrl: callback, expectedState: issued.state }),
    [issued.state]
  );
  const authorization = first.parseAuthorizationCallback({ callbackUrl: callback, expectedState: issued.state });
  assert.equal(authorization.workspaceId, bindingOne.workspaceId);
});

await check("refresh is rotating and cannot cross a workspace or website binding", async () => {
  const bound = Object.freeze({ workspaceId: "workspace-one", connectionId: "connection-one", websiteId: "site-one" });
  const client = createSquarespaceOAuthClient({
    clientId: "fake-client-one",
    clientSecret: "fake-secret-one",
    fetchImpl: oauthFetch,
    binding: bound
  });
  await assert.rejects(
    client.refreshAccessToken({
      refreshToken: "fake-refresh-boundary",
      binding: { ...bound, workspaceId: "workspace-two" }
    }),
    (error) => error.code === "SQUARESPACE_OAUTH_BINDING_ERROR"
  );
  const tokens = await client.refreshAccessToken({ refreshToken: "fake-refresh-boundary", binding: bound });
  assert.equal(tokens.tokenType, "bearer");
  const request = oauthRequests.at(-1);
  const parameters = new URLSearchParams(request.body);
  assert.equal(parameters.get("grant_type"), "refresh_token");
  assert.equal(parameters.get("refresh_token"), "fake-refresh-boundary");
  await assert.rejects(
    client.refreshAccessToken({ refreshToken: "fake-refresh-boundary", binding: bound }),
    (error) => error.code === "SQUARESPACE_OAUTH_REFRESH_TOKEN_REUSED"
  );
});

await check("OAuth clients cannot leak credentials or use environment fallbacks", async () => {
  const originalId = process.env.SQUARESPACE_CLIENT_ID;
  const originalSecret = process.env.SQUARESPACE_CLIENT_SECRET;
  process.env.SQUARESPACE_CLIENT_ID = "environment-client";
  process.env.SQUARESPACE_CLIENT_SECRET = "environment-secret";
  try {
    assert.throws(
      () => createSquarespaceOAuthClient({ fetchImpl: oauthFetch, binding: bindingOne }),
      (error) => error.code === "SQUARESPACE_OAUTH_CONFIGURATION_ERROR"
    );
  } finally {
    if (originalId === undefined) delete process.env.SQUARESPACE_CLIENT_ID;
    else process.env.SQUARESPACE_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.SQUARESPACE_CLIENT_SECRET;
    else process.env.SQUARESPACE_CLIENT_SECRET = originalSecret;
  }
  const second = createSquarespaceOAuthClient({
    clientId: "fake-client-two",
    clientSecret: "fake-secret-two",
    fetchImpl: oauthFetch,
    binding: { workspaceId: "workspace-two", connectionId: "connection-two" }
  });
  const issued = second.buildAuthorizeUrl();
  const authorization = second.parseAuthorizationCallback({
    callbackUrl: callbackUrl({ state: issued.state, code: "clientTwoCode" }),
    expectedState: issued.state
  });
  await second.exchangeAuthorizationCode({ authorization });
  assert.equal(
    oauthRequests.at(-1).headers.authorization,
    `Basic ${Buffer.from("fake-client-two:fake-secret-two").toString("base64")}`
  );
  assert.equal(/console\.(?:log|info|warn|error|debug)/u.test(oauthSource), false);
});

await oauthMock.close();

const apiRequests = [];
let retryResponses = 0;
const apiMock = await listen(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const body = await requestBody(request);
  apiRequests.push({ method: request.method, path: url.pathname, query: url.searchParams, headers: { ...request.headers }, body });

  if (url.pathname === "/1.0/authorization/member") return sendJson(response, 200, { id: "member-one", future: true });
  if (url.pathname === "/1.0/authorization/website") {
    const id = request.headers.authorization === "Bearer mismatched-token" ? "site-two" : "site-one";
    return sendJson(response, 200, { id, title: "Test site", future: true });
  }
  if (url.pathname === "/1.0/commerce/store_pages") {
    return sendJson(response, 200, { storePages: [{ id: "store-one" }], pagination: { hasNextPage: false }, future: true });
  }
  if (url.pathname === "/v2/commerce/products") {
    if (url.searchParams.get("query") === "timeout") {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return sendJson(response, 200, { products: [], pagination: { hasNextPage: false } });
    }
    if (url.searchParams.get("query") === "malformed") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{not-json");
      return;
    }
    if (url.searchParams.get("query") === "retry") {
      retryResponses += 1;
      if (retryResponses === 1) return sendJson(response, 429, { private: "customer@example.com" }, { "Retry-After": "0" });
      return sendJson(response, 200, { products: [], pagination: { hasNextPage: false } });
    }
    if (url.searchParams.get("query") === "loop" || url.searchParams.get("cursor") === "loop") {
      return sendJson(response, 200, { products: [], pagination: { hasNextPage: true, nextPageCursor: "loop" } });
    }
    if (url.searchParams.get("cursor") === "product-page-two") {
      return sendJson(response, 200, {
        products: [{ id: "product-two", unknownProductField: true }],
        pagination: { hasNextPage: false },
        unknownEnvelopeField: true
      });
    }
    return sendJson(response, 200, {
      products: [{ id: "product-one", unknownProductField: true }],
      pagination: { hasNextPage: true, nextPageCursor: "product-page-two" },
      unknownEnvelopeField: true
    });
  }
  if (url.pathname.startsWith("/v2/commerce/products/")) {
    return sendJson(response, 200, { products: [{ id: decodeURIComponent(url.pathname.split("/").at(-1)) }] });
  }
  if (url.pathname === "/1.0/commerce/inventory") {
    return sendJson(response, 200, {
      inventory: [{ variantId: "variant-one", isUnlimited: false, quantity: 7 }],
      pagination: { hasNextPage: false }
    });
  }
  if (url.pathname.startsWith("/1.0/commerce/inventory/")) {
    return sendJson(response, 200, { inventory: [{ variantId: "variant-one", isUnlimited: false, quantity: 7 }] });
  }
  if (url.pathname === "/1.0/commerce/orders") {
    return sendJson(response, 200, { orders: [{ id: "order-one" }], pagination: { hasNextPage: false } });
  }
  if (url.pathname.startsWith("/1.0/commerce/orders/")) return sendJson(response, 200, { id: "order-one" });
  if (url.pathname === "/1.0/commerce/transactions") {
    return sendJson(response, 200, { documents: [{ id: "document-one" }], pagination: { hasNextPage: false } });
  }
  if (url.pathname.startsWith("/1.0/commerce/transactions/")) {
    return sendJson(response, 200, { documents: [{ id: "document-one" }] });
  }
  if (url.pathname === "/v1/contacts" && request.method === "GET") {
    return sendJson(response, 200, {
      contacts: [
        {
          id: "contact-one",
          firstName: "Private",
          primaryEmail: { email: "customer@example.com", acceptsMarketing: { acceptsMarketing: true } }
        }
      ],
      pagination: { hasNextPage: false }
    });
  }
  if (url.pathname === "/v1/contacts/query" && request.method === "POST") {
    return sendJson(response, 200, { contacts: [], pagination: { hasNextPage: false } });
  }
  if (url.pathname.startsWith("/v1/contacts/")) {
    return sendJson(response, 200, {
      contact: { id: "contact-one", primaryEmail: { acceptsMarketing: { acceptsMarketing: true } } }
    });
  }
  if (url.pathname === "/v1/analytics/transaction-summaries" && request.method === "POST") {
    return sendJson(response, 200, { transactionsSummaryWrappers: [{ contactId: "contact-one", transactionsSummary: {} }] });
  }
  if (url.pathname === "/v1/commerce/discounts") {
    const offset = Number(url.searchParams.get("offset") || 0);
    return sendJson(response, 200, {
      discounts: [{ id: offset === 0 ? "discount-one" : "discount-two" }],
      hasNextPage: offset === 0,
      hasPreviousPage: offset > 0
    });
  }
  if (url.pathname.startsWith("/v1/commerce/discounts/")) {
    return sendJson(response, 200, { discount: { id: "discount-one" } });
  }
  sendJson(response, 404, { error: "not found" });
});

function apiClient(overrides = {}) {
  return createSquarespaceApiClient({
    accessToken: "token-one",
    fetchImpl: fetch,
    baseUrl: apiMock.origin,
    allowInsecureLocalhostForTests: true,
    binding: { workspaceId: "workspace-one", connectionId: "connection-one", websiteId: "site-one" },
    maxRetries: 0,
    ...overrides
  });
}

const client = apiClient();

await check("API client uses exact versioned read paths", async () => {
  await client.getAuthenticatedMember();
  await client.getAuthenticatedWebsite();
  await client.listStorePages();
  await client.listProducts();
  await client.getProduct({ productId: "product-one" });
  await client.listInventory();
  await client.getInventoryForVariant({ variantId: "variant-one" });
  await client.listOrders();
  await client.getOrder({ orderId: "order-one" });
  await client.listTransactions();
  await client.getTransactionDocuments({ documentIds: ["document-one"] });
  await client.getTransactionsForOrder({ orderId: "order-one" });
  await client.listContacts();
  await client.queryContacts({ query: { acceptsMarketingWithDate: { acceptsMarketing: true } } });
  const contact = await client.getContact({ contactId: "contact-one" });
  assert.equal(client.readMarketingOptIn(contact), true);
  await client.getTransactionSummaries({ contactIds: ["contact-one"] });
  await client.listDiscounts();
  await client.getDiscount({ discountId: "discount-one" });

  const paths = new Set(apiRequests.map((request) => `${request.method} ${request.path}`));
  for (const path of [
    "GET /1.0/authorization/member",
    "GET /1.0/authorization/website",
    "GET /1.0/commerce/store_pages",
    "GET /v2/commerce/products",
    "GET /v2/commerce/products/product-one",
    "GET /1.0/commerce/inventory",
    "GET /1.0/commerce/inventory/variant-one",
    "GET /1.0/commerce/orders",
    "GET /1.0/commerce/orders/order-one",
    "GET /1.0/commerce/transactions",
    "GET /1.0/commerce/transactions/document-one",
    "GET /v1/contacts",
    "POST /v1/contacts/query",
    "GET /v1/contacts/contact-one",
    "POST /v1/analytics/transaction-summaries",
    "GET /v1/commerce/discounts",
    "GET /v1/commerce/discounts/discount-one"
  ]) {
    assert.equal(paths.has(path), true, path);
  }
});

await check("API headers carry only the bound bearer token and User-Agent", async () => {
  for (const request of apiRequests) {
    assert.equal(request.headers.authorization, "Bearer token-one");
    assert.equal(request.headers["user-agent"], squarespaceExtensionConfig.api.userAgent);
  }
});

await check("cursor and offset pagination are bounded and loop-protected", async () => {
  const products = await client.listAllProducts();
  assert.deepEqual(products.items.map((product) => product.id), ["product-one", "product-two"]);
  assert.equal(products.pages, 2);
  assert.equal(products.truncated, false);
  await assert.rejects(
    client.listAllProducts({ query: "loop", maxPages: 4 }),
    (error) => error.code === "SQUARESPACE_API_CURSOR_LOOP"
  );
  const discounts = await client.listAllDiscounts({ limit: 1, maxPages: 3 });
  assert.deepEqual(discounts.items.map((discount) => discount.id), ["discount-one", "discount-two"]);
});

await check("rate limits retry safely with a bounded delay", async () => {
  const delays = [];
  const retrying = apiClient({ maxRetries: 1, sleepImpl: async (duration) => delays.push(duration) });
  const result = await retrying.listProducts({ query: "retry" });
  assert.deepEqual(result.products, []);
  assert.equal(retryResponses, 2);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 0 && delays[0] <= 3_000);
});

await check("timeouts abort and malformed JSON fails without provider content", async () => {
  const timingOut = apiClient({ timeoutMs: 10, maxRetries: 0 });
  await assert.rejects(
    timingOut.listProducts({ query: "timeout" }),
    (error) => error.code === "SQUARESPACE_API_TIMEOUT" && !error.message.includes("token-one")
  );
  await assert.rejects(
    client.listProducts({ query: "malformed" }),
    (error) => error.code === "SQUARESPACE_API_MALFORMED_RESPONSE" && !error.message.includes("customer@example.com")
  );
});

await check("unknown fields are tolerated and inventory exposes variant stock", async () => {
  const page = await client.listProducts();
  assert.equal(page.unknownEnvelopeField, true);
  assert.equal(page.products[0].unknownProductField, true);
  const stock = client.readVariantStock({ variantId: "variant-one", isUnlimited: false, quantity: 7, future: true });
  assert.deepEqual(stock, { variantId: "variant-one", isUnlimited: false, quantity: 7 });
});

await check("analytics batch limits and date windows fail closed", async () => {
  await assert.rejects(
    client.getTransactionSummaries({ contactIds: Array.from({ length: 1_001 }, (_, index) => `contact-${index}`) }),
    (error) => error.code === "SQUARESPACE_API_INVALID_REQUEST"
  );
  await assert.rejects(
    client.listOrders({ modifiedAfter: "2026-01-01T00:00:00Z" }),
    (error) => error.code === "SQUARESPACE_API_INVALID_REQUEST"
  );
});

await check("API tokens and website bindings do not leak between clients", async () => {
  const second = apiClient({
    accessToken: "token-two",
    binding: { workspaceId: "workspace-two", connectionId: "connection-two", websiteId: "site-one" }
  });
  await second.getAuthenticatedMember();
  assert.equal(apiRequests.at(-1).headers.authorization, "Bearer token-two");
  const mismatched = apiClient({ accessToken: "mismatched-token" });
  await assert.rejects(
    mismatched.getAuthenticatedWebsite(),
    (error) => error.code === "SQUARESPACE_API_BINDING_ERROR"
  );
});

await check("API client exposes no write surface and emits no PII logs", async () => {
  const forbidden = /^(?:create|update|delete|adjust|fulfill|import|publish|patch|put)/iu;
  assert.deepEqual(Object.keys(client).filter((name) => forbidden.test(name)), []);
  assert.equal(/console\.(?:log|info|warn|error|debug)/u.test(apiSource), false);
  assert.equal(apiSource.includes("customerEmail"), false);
  assert.equal(apiSource.includes("defaultShippingAddress"), false);
});

await apiMock.close();

const webhookSecret = "00112233445566778899aabbccddeeff";
const webhookPayload = JSON.stringify({
  id: "notification-one",
  websiteId: "provider-site-one",
  subscriptionId: "subscription-one",
  topic: "contact.update",
  createdOn: "2026-08-01T00:00:00Z",
  data: { contact: { primaryEmail: { email: "private@example.com" } } }
});
const webhookSignature = createHmac("sha256", Buffer.from(webhookSecret, "hex"))
  .update(Buffer.from(webhookPayload, "utf8"))
  .digest("hex");

await check("webhook HMAC decodes the hexadecimal secret and preserves notification IDs", async () => {
  const verification = verifySquarespaceWebhook({
    rawBody: webhookPayload,
    signature: webhookSignature,
    secret: webhookSecret
  });
  assert.ok(verification);
  const notification = parseSquarespaceNotification({ verification });
  assert.equal(notification.notificationId, "notification-one");
  assert.equal(notification.providerWebsiteId, "provider-site-one");
  assert.equal(notification.providerSubscriptionId, "subscription-one");
  assert.equal(notification.workspaceId, null);
  assert.equal(notification.connectionId, null);
  assert.equal(notification.tenancyResolved, false);
  assert.throws(
    () => parseSquarespaceNotification({ verification }),
    (error) => error.code === "SQUARESPACE_WEBHOOK_UNVERIFIED"
  );
});

await check("altered bodies, wrong secrets, and malformed signatures fail safely", async () => {
  assert.equal(
    verifySquarespaceWebhook({ rawBody: `${webhookPayload} `, signature: webhookSignature, secret: webhookSecret }),
    false
  );
  assert.equal(
    verifySquarespaceWebhook({ rawBody: webhookPayload, signature: webhookSignature, secret: "ffeeddccbbaa9988" }),
    false
  );
  assert.equal(
    verifySquarespaceWebhook({ rawBody: webhookPayload, signature: "aa", secret: webhookSecret }),
    false
  );
  assert.equal(
    verifySquarespaceWebhook({ rawBody: webhookPayload, signature: "z".repeat(64), secret: webhookSecret }),
    false
  );
  assert.equal(
    verifySquarespaceWebhook({ rawBody: webhookPayload, signature: webhookSignature, secret: "not-hex" }),
    false
  );
});

await check("webhook parsing requires verification and duplicate IDs remain visible", async () => {
  assert.throws(
    () => parseSquarespaceNotification({ rawBody: webhookPayload }),
    (error) => error.code === "SQUARESPACE_WEBHOOK_UNVERIFIED"
  );
  const first = verifySquarespaceWebhook({ rawBody: webhookPayload, signature: webhookSignature, secret: webhookSecret });
  const second = verifySquarespaceWebhook({ rawBody: webhookPayload, signature: webhookSignature, secret: webhookSecret });
  assert.equal(parseSquarespaceNotification({ verification: first }).notificationId, "notification-one");
  assert.equal(parseSquarespaceNotification({ verification: second }).notificationId, "notification-one");
  assert.match(webhookSource, /timingSafeEqual/u);
  assert.match(webhookSource, /Buffer\.from\(secret, "hex"\)/u);
});

console.log(JSON.stringify({ ok: true, provider: "squarespace", checks: checkCount }));
