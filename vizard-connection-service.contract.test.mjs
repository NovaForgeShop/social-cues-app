import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { TextEncoder } from "node:util";
import { runInNewContext } from "node:vm";
import {
  VIZARD_API_KEY_MAX_UTF8_BYTES,
  VizardConnectionServiceError,
  createVizardConnectionService,
  encryptVizardApiKey,
  isVizardJsonMediaType,
  normalizeVizardConnectionError,
  publicVizardConnection,
  vizardEncryptionReadiness
} from "./vizard-connection-service.mjs";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const API_KEY = "vizard-contract-api-key-never-return";
const KEY_MATERIAL = "explicit-contract-encryption-key";
const deterministicIv = Buffer.from("00112233445566778899aabb", "hex");
const serverUrl = new URL("./server.mjs", import.meta.url);
const uiUrl = new URL("./social-cues-app.html", import.meta.url);
const migrationUrl = new URL("./SUPABASE-VIZARD-CONNECTION-MANAGEMENT.sql", import.meta.url);

let externalRequests = 0;
globalThis.fetch = async () => {
  externalRequests += 1;
  throw new Error("External requests are forbidden in the Vizard connection service contract.");
};

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

function decryptEnvelope(envelope, keyMaterial = KEY_MATERIAL) {
  const key = crypto.createHash("sha256").update(keyMaterial).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.value, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing UI marker: ${startMarker}`);
  assert.ok(end > start, `Missing UI marker: ${endMarker}`);
  return source.slice(start, end);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character]));
}

function loadUiFunctions(source, functionBlocks, globals = {}) {
  const context = {
    TextEncoder,
    ...globals
  };
  runInNewContext(`${functionBlocks.join("\n")}\nthis.__loaded = true;`, context);
  assert.equal(context.__loaded, true);
  return context;
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

const [serverSource, uiSource, migrationSource] = await Promise.all([
  readFile(serverUrl, "utf8"),
  readFile(uiUrl, "utf8"),
  readFile(migrationUrl, "utf8")
]);

const uiHelpers = sliceBetween(
  uiSource,
  "function vizardPublicErrorMessage(",
  "function renderVizardConnectionCard()"
);
const uiCardFunction = sliceBetween(
  uiSource,
  "function renderVizardConnectionCard()",
  "function renderAccounts()"
);
const uiSubmitFunction = sliceBetween(
  uiSource,
  "async function saveVizardCredential(",
  "async function disconnectVizardConnection("
);
const supabaseRequestFunction = sliceBetween(
  serverSource,
  "async function supabaseRequest(",
  "async function optionalSupabaseRequest("
);
const vizardRouteStart = serverSource.indexOf("const vizardAction = {");
const genericAccountRouteStart = serverSource.indexOf(
  'if (url.pathname.startsWith("/api/accounts/")',
  vizardRouteStart
);
assert.ok(vizardRouteStart > 0);
assert.ok(genericAccountRouteStart > vizardRouteStart);
const vizardRouteBlock = serverSource.slice(vizardRouteStart, genericAccountRouteStart);
const executeVizardRouteBlock = runInNewContext(
  "(async function (dependencies) {\n"
    + "const { url, req, res, getModel, sessionFromRequest, json, isVizardJsonMediaType, bodyJson, requireWorkspaceManagementAccess, vizardConnectionService, vizardConnectionErrorResponse } = dependencies;\n"
    + vizardRouteBlock
    + "\nreturn { fellThrough: true };\n})"
);

async function runVizardRouteScenario({
  pathname = "/api/accounts/vizard/connect",
  method = "POST",
  contentType,
  parsedBody = { apiKey: API_KEY },
  parseError = null
} = {}) {
  let authorizationCalls = 0;
  let bodyJsonCalls = 0;
  let serviceCalls = 0;
  const req = { method, headers: {} };
  if (contentType !== undefined) req.headers["content-type"] = contentType;
  const result = await executeVizardRouteBlock({
    url: new URL(pathname, "https://social-cues.invalid"),
    req,
    res: {},
    getModel: async () => ({}),
    sessionFromRequest: async () => ({ user: { id: USER_ID } }),
    json: (_res, status, body) => ({ status, body }),
    isVizardJsonMediaType,
    bodyJson: async () => {
      bodyJsonCalls += 1;
      if (parseError) throw parseError;
      return parsedBody;
    },
    requireWorkspaceManagementAccess: async () => {
      authorizationCalls += 1;
      return { userId: USER_ID, workspaceId: WORKSPACE_ID };
    },
    vizardConnectionService: () => ({
      status: async () => {
        serviceCalls += 1;
        return { connected: false };
      },
      manage: async () => {
        serviceCalls += 1;
        return { connected: true };
      }
    }),
    vizardConnectionErrorResponse: (_res, error) => {
      throw error;
    }
  });
  return { authorizationCalls, bodyJsonCalls, result, serviceCalls };
}

async function runSanitizedSupabaseFailure(fetchImplementation) {
  let tracedError = null;
  let traceMetadata = null;
  const context = {
    fetch: fetchImplementation,
    supabaseUrl: "https://supabase.invalid",
    supabaseHeaders: extra => extra,
    traceSupabaseOperation: async (metadata, operation) => {
      traceMetadata = metadata;
      try {
        return await operation();
      } catch (error) {
        tracedError = error;
        throw error;
      }
    }
  };
  runInNewContext(`${supabaseRequestFunction}\nthis.__supabaseRequest = supabaseRequest;`, context);
  await assert.rejects(() => context.__supabaseRequest("/rpc/internal-name", {
    method: "POST",
    tracePathname: "/vizard-connection",
    sanitizeError: normalizeVizardConnectionError
  }));
  return { traceMetadata, tracedError };
}

await check("Vizard encryption requires explicit server-side key material", () => {
  assert.deepEqual(vizardEncryptionReadiness({}), {
    ready: false,
    explicitKey: false,
    missingEnv: ["OAUTH_TOKEN_ENCRYPTION_KEY"]
  });
  assert.throws(
    () => encryptVizardApiKey(API_KEY, { keyMaterial: "" }),
    error => error instanceof VizardConnectionServiceError
      && error.code === "VIZARD_ENCRYPTION_KEY_REQUIRED"
      && error.status === 503
  );
});

await check("the UTF-8 boundary exactly fits the committed ciphertext constraint", () => {
  assert.equal(VIZARD_API_KEY_MAX_UTF8_BYTES, 3072);
  const maximum = Buffer.from("a".repeat(VIZARD_API_KEY_MAX_UTF8_BYTES), "utf8").toString("base64url");
  const oversized = Buffer.from("a".repeat(VIZARD_API_KEY_MAX_UTF8_BYTES + 1), "utf8").toString("base64url");
  assert.equal(maximum.length, 4096);
  assert.equal(oversized.length, 4098);
  assert.match(migrationSource, /length\(p_encrypted_token->>'value'\) not between 1 and 4096/u);
});

await check("one-byte and boundary-trimmed keys are accepted without changing interior whitespace", () => {
  const oneByte = encryptVizardApiKey("  x  ", {
    keyMaterial: KEY_MATERIAL,
    randomBytes: () => deterministicIv
  });
  assert.equal(decryptEnvelope(oneByte), "x");

  const interiorWhitespace = encryptVizardApiKey("  alpha beta  ", {
    keyMaterial: KEY_MATERIAL,
    randomBytes: () => deterministicIv
  });
  assert.equal(decryptEnvelope(interiorWhitespace), "alpha beta");
});

await check("exact 3072-byte ASCII and mixed Unicode keys fit the encrypted envelope", () => {
  const ascii = "a".repeat(VIZARD_API_KEY_MAX_UTF8_BYTES);
  const mixed = `${"a".repeat(VIZARD_API_KEY_MAX_UTF8_BYTES - 2)}\u00e9`;
  assert.equal(Buffer.byteLength(ascii, "utf8"), VIZARD_API_KEY_MAX_UTF8_BYTES);
  assert.equal(Buffer.byteLength(mixed, "utf8"), VIZARD_API_KEY_MAX_UTF8_BYTES);
  assert.ok(mixed.length < VIZARD_API_KEY_MAX_UTF8_BYTES);

  for (const value of [ascii, mixed]) {
    const envelope = encryptVizardApiKey(value, {
      keyMaterial: KEY_MATERIAL,
      randomBytes: () => deterministicIv
    });
    assert.ok(envelope.value.length <= 4096);
    const decryptedDigest = crypto.createHash("sha256").update(decryptEnvelope(envelope)).digest("hex");
    const expectedDigest = crypto.createHash("sha256").update(value).digest("hex");
    assert.equal(decryptedDigest, expectedDigest);
  }
});

await check("oversized, Unicode-oversized, whitespace-only, and control-character keys are rejected", () => {
  const rejected = [
    "a".repeat(VIZARD_API_KEY_MAX_UTF8_BYTES + 1),
    "\u00e9".repeat(1537),
    " \t ",
    "valid\nsecond-line",
    "valid\0suffix"
  ];
  assert.ok(rejected[1].length < VIZARD_API_KEY_MAX_UTF8_BYTES);
  assert.ok(Buffer.byteLength(rejected[1], "utf8") > VIZARD_API_KEY_MAX_UTF8_BYTES);
  for (const apiKey of rejected) {
    assert.throws(
      () => encryptVizardApiKey(apiKey, { keyMaterial: KEY_MATERIAL }),
      error => error instanceof VizardConnectionServiceError
        && error.code === "VIZARD_API_KEY_INVALID"
        && error.status === 400
        && !error.message.includes(apiKey.slice(0, 12))
    );
  }
});

await check("oversized input is rejected before encryption persistence or RPC invocation", async () => {
  let requests = 0;
  const rejectedMarker = "synthetic-rejected-key";
  const oversized = `${rejectedMarker}${"z".repeat(VIZARD_API_KEY_MAX_UTF8_BYTES)}`;
  const service = createVizardConnectionService({
    environment: { OAUTH_TOKEN_ENCRYPTION_KEY: KEY_MATERIAL },
    request: async () => {
      requests += 1;
      return [];
    }
  });
  await assert.rejects(
    service.manage({
      action: "connect",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      apiKey: oversized
    }),
    error => error instanceof VizardConnectionServiceError
      && error.code === "invalid_request"
      && error.status === 400
      && !error.message.includes(rejectedMarker)
  );
  assert.equal(requests, 0);
});

await check("the AES-256-GCM envelope exactly matches the migration contract", () => {
  const envelope = encryptVizardApiKey(API_KEY, {
    keyMaterial: KEY_MATERIAL,
    randomBytes: size => {
      assert.equal(size, 12);
      return deterministicIv;
    }
  });
  assert.deepEqual(Object.keys(envelope), ["alg", "iv", "tag", "value"]);
  assert.equal(envelope.alg, "aes-256-gcm");
  assert.match(envelope.iv, /^[A-Za-z0-9_-]{16}$/u);
  assert.match(envelope.tag, /^[A-Za-z0-9_-]{22}$/u);
  assert.match(envelope.value, /^[A-Za-z0-9_-]+$/u);
  assert.ok(envelope.value.length <= 4096);
  assert.equal(JSON.stringify(envelope).includes(API_KEY), false);
  assert.equal(decryptEnvelope(envelope), API_KEY);
});

await check("safe status exposes only connection capabilities and the canonical input limit", async () => {
  const calls = [];
  const service = createVizardConnectionService({
    environment: { OAUTH_TOKEN_ENCRYPTION_KEY: KEY_MATERIAL },
    request: async (pathname, options) => {
      calls.push({ pathname, options });
      return [{
        id: ACCOUNT_ID,
        workspace_id: WORKSPACE_ID,
        provider: "vizard",
        platform: "vizard",
        status: "pending_verification",
        encrypted_token: { value: "must-not-return" },
        user_id: USER_ID,
        public_profile: { unexpected: "must-not-return" }
      }];
    }
  });
  const connection = await service.status({ workspaceId: WORKSPACE_ID });
  assert.equal(calls.length, 1);
  assert.match(calls[0].pathname, /^\/connected_accounts\?/u);
  assert.match(calls[0].pathname, /workspace_id=eq\./u);
  assert.match(calls[0].pathname, /provider=eq\.vizard&platform=eq\.vizard/u);
  assert.doesNotMatch(calls[0].pathname, /provider_tokens|encrypted|user_id|public_profile/u);
  assert.deepEqual(connection, {
    connectedAccountId: ACCOUNT_ID,
    provider: "vizard",
    platform: "vizard",
    connectionState: "pending_verification",
    verificationState: "pending",
    credentialStored: true,
    connected: false,
    canReplace: true,
    canDisconnect: true,
    connectedAt: null,
    createdAt: null,
    updatedAt: null,
    credentialStorageAvailable: true,
    apiKeyMaxUtf8Bytes: VIZARD_API_KEY_MAX_UTF8_BYTES
  });
  const serialized = JSON.stringify(connection);
  for (const forbidden of ["must-not-return", USER_ID, "OAUTH_TOKEN_ENCRYPTION_KEY", "missingEnv", "aes-256-gcm"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

await check("connect and replace send only fixed RPC parameters with JSON headers", async () => {
  for (const action of ["connect", "replace"]) {
    const calls = [];
    const service = createVizardConnectionService({
      environment: { OAUTH_TOKEN_ENCRYPTION_KEY: KEY_MATERIAL },
      randomBytes: () => deterministicIv,
      request: async (pathname, options) => {
        calls.push({ pathname, options });
        return [{
          connected_account_id: ACCOUNT_ID,
          workspace_id: WORKSPACE_ID,
          provider: "vizard",
          platform: "vizard",
          connection_state: "pending_verification",
          verification_state: "pending"
        }];
      }
    });
    const connection = await service.manage({ action, userId: USER_ID, workspaceId: WORKSPACE_ID, apiKey: API_KEY });
    assert.equal(connection.credentialStored, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/rpc/social_cues_manage_vizard_connection");
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(calls[0].options.headers, { "Content-Type": "application/json" });
    assert.equal(calls[0].pathname.includes(API_KEY), false);
    assert.equal(JSON.stringify(calls[0].options.headers).includes(API_KEY), false);
    const payload = JSON.parse(calls[0].options.body);
    assert.deepEqual(Object.keys(payload), ["p_actor_user_id", "p_workspace_id", "p_action", "p_encrypted_token"]);
    assert.equal(payload.p_actor_user_id, USER_ID);
    assert.equal(payload.p_workspace_id, WORKSPACE_ID);
    assert.equal(payload.p_action, action);
    assert.equal(decryptEnvelope(payload.p_encrypted_token), API_KEY);
    assert.equal(calls[0].options.body.includes(API_KEY), false);
  }
});

await check("disconnect sends a null envelope and returns a non-credential state", async () => {
  let payload;
  const service = createVizardConnectionService({
    environment: {},
    request: async (_pathname, options) => {
      payload = JSON.parse(options.body);
      return [{
        connected_account_id: ACCOUNT_ID,
        workspace_id: WORKSPACE_ID,
        provider: "vizard",
        platform: "vizard",
        connection_state: "not_connected",
        verification_state: "not_verified"
      }];
    }
  });
  const connection = await service.manage({ action: "disconnect", userId: USER_ID, workspaceId: WORKSPACE_ID });
  assert.equal(payload.p_encrypted_token, null);
  assert.equal(connection.credentialStored, false);
  assert.equal(connection.canReplace, false);
  assert.equal(connection.canDisconnect, false);
  assert.equal(connection.credentialStorageAvailable, false);
  assert.equal(connection.apiKeyMaxUtf8Bytes, VIZARD_API_KEY_MAX_UTF8_BYTES);
});

await check("JSON media type matching accepts charset and case but rejects unsupported types", () => {
  for (const value of [
    "application/json",
    "application/json; charset=utf-8",
    "Application/JSON; Charset=UTF-8",
    " application/json ; charset=UTF-8 "
  ]) {
    assert.equal(isVizardJsonMediaType(value), true, value);
  }
  for (const value of [undefined, "", "text/plain", "application/x-www-form-urlencoded", "application/problem+json"]) {
    assert.equal(isVizardJsonMediaType(value), false, String(value));
  }
});

await check("service failures normalize to stable browser-safe categories", () => {
  const cases = [
    [
      new VizardConnectionServiceError(
        "VIZARD_ENCRYPTION_KEY_REQUIRED",
        "OAUTH_TOKEN_ENCRYPTION_KEY is missing.",
        503
      ),
      "connection_service_unavailable",
      503
    ],
    [
      new Error("PGRST202 Could not find function public.social_cues_manage_vizard_connection in schema cache"),
      "connection_service_unavailable",
      503
    ],
    [
      new Error("SQLSTATE 42P01 public.provider_tokens migration SUPABASE-VIZARD-CONNECTION-MANAGEMENT.sql constraint failed"),
      "connection_update_failed",
      503
    ],
    [
      new Error("VIZARD_CONNECTION_NOT_AUTHORIZED"),
      "not_authorized",
      403
    ],
    [
      new Error("VIZARD_CONNECTION_ALREADY_STORED"),
      "connection_update_failed",
      409
    ],
    [
      new Error(`unexpected provider failure ${API_KEY} {"iv":"secret","tag":"secret","value":"secret"}`),
      "connection_update_failed",
      503
    ]
  ];
  const forbidden = [
    "OAUTH_TOKEN_ENCRYPTION_KEY",
    "VIZARD_API_KEY",
    "SUPABASE-VIZARD-CONNECTION-MANAGEMENT.sql",
    "social_cues_manage_vizard_connection",
    "SQLSTATE",
    "public.provider_tokens",
    "constraint",
    API_KEY,
    "\"iv\"",
    "\"tag\"",
    "\"value\""
  ];
  for (const [input, code, status] of cases) {
    const normalized = normalizeVizardConnectionError(input);
    assert.equal(normalized.code, code);
    assert.equal(normalized.status, status);
    const serialized = JSON.stringify({ code: normalized.code, message: normalized.message });
    for (const value of forbidden) assert.equal(serialized.includes(value), false);
  }
});

await check("the public serializer never spreads database rows", () => {
  const connection = publicVizardConnection({
    id: ACCOUNT_ID,
    workspace_id: WORKSPACE_ID,
    status: "connected",
    encrypted_token: { value: "ciphertext" },
    token: "plaintext",
    arbitrary_future_secret: "secret"
  }, { ready: true, missingEnv: [] });
  const serialized = JSON.stringify(connection);
  assert.equal(connection.connected, true);
  assert.equal(connection.apiKeyMaxUtf8Bytes, VIZARD_API_KEY_MAX_UTF8_BYTES);
  for (const forbidden of ["ciphertext", "plaintext", "arbitrary_future_secret", WORKSPACE_ID, "missingEnv"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

await check("server routes enforce JSON and workspace management before service calls", () => {
  for (const route of ["connect", "status", "replace", "disconnect"]) {
    assert.ok(vizardRouteBlock.includes(`/api/accounts/vizard/${route}`));
  }
  assert.ok(vizardRouteBlock.includes("sessionFromRequest(sharedModel, req)"));
  assert.ok(vizardRouteBlock.includes("requireWorkspaceManagementAccess(session"));
  assert.ok(vizardRouteBlock.includes("managementAccess.userId"));
  assert.ok(vizardRouteBlock.includes("managementAccess.workspaceId"));
  assert.ok(vizardRouteBlock.includes('isVizardJsonMediaType(req.headers["content-type"])'));
  assert.ok(vizardRouteBlock.includes("code: \"unsupported_media_type\""));
  assert.ok(vizardRouteBlock.includes("code: \"invalid_request\""));
  assert.ok(vizardRouteBlock.includes("vizardAction !== \"disconnect\""));
  assert.ok(vizardRouteBlock.indexOf("isVizardJsonMediaType") < vizardRouteBlock.indexOf("input = await bodyJson(req)"));
  assert.ok(vizardRouteBlock.indexOf("input = await bodyJson(req)") < vizardRouteBlock.indexOf("service.manage("));
  assert.ok(vizardRouteBlock.indexOf("requireWorkspaceManagementAccess(session") < vizardRouteBlock.indexOf("service.manage("));
  assert.equal(vizardRouteBlock.includes("encryptedToken("), false);
  assert.equal(vizardRouteBlock.includes("decryptedToken("), false);
  assert.equal(vizardRouteBlock.includes("OAUTH_TOKEN_ENCRYPTION_KEY"), false);
  assert.equal(vizardRouteBlock.includes("SUPABASE-VIZARD-CONNECTION-MANAGEMENT.sql"), false);
});

await check("route media-type and JSON failures make zero service or RPC-equivalent calls", async () => {
  for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
    const rejected = await runVizardRouteScenario({ contentType });
    assert.equal(rejected.result.status, 415);
    assert.equal(rejected.result.body.code, "unsupported_media_type");
    assert.equal(rejected.bodyJsonCalls, 0);
    assert.equal(rejected.authorizationCalls, 0);
    assert.equal(rejected.serviceCalls, 0);
  }

  const malformed = await runVizardRouteScenario({
    contentType: "application/json",
    parseError: new SyntaxError("synthetic malformed JSON")
  });
  assert.equal(malformed.result.status, 400);
  assert.equal(malformed.result.body.code, "invalid_request");
  assert.equal(malformed.bodyJsonCalls, 1);
  assert.equal(malformed.authorizationCalls, 0);
  assert.equal(malformed.serviceCalls, 0);

  for (const parsedBody of [null, [], "not-an-object"]) {
    const rejected = await runVizardRouteScenario({
      contentType: "application/json; charset=utf-8",
      parsedBody
    });
    assert.equal(rejected.result.status, 400);
    assert.equal(rejected.authorizationCalls, 0);
    assert.equal(rejected.serviceCalls, 0);
  }

  const accepted = await runVizardRouteScenario({
    pathname: "/api/accounts/vizard/replace",
    contentType: "Application/JSON; Charset=UTF-8"
  });
  assert.equal(accepted.result.status, 200);
  assert.equal(accepted.bodyJsonCalls, 1);
  assert.equal(accepted.authorizationCalls, 1);
  assert.equal(accepted.serviceCalls, 1);
});

await check("Vizard Supabase tracing sanitizes every failure before telemetry", async () => {
  const factoryStart = serverSource.indexOf("function vizardConnectionService()");
  const errorResponseStart = serverSource.indexOf("function vizardConnectionErrorResponse", factoryStart);
  const factoryBlock = serverSource.slice(factoryStart, errorResponseStart);
  assert.ok(factoryBlock.includes('tracePathname: "/vizard-connection"'));
  assert.ok(factoryBlock.includes("sanitizeError: normalizeVizardConnectionError"));
  assert.equal(factoryBlock.includes("social_cues_manage_vizard_connection"), false);

  const databaseFailure = await runSanitizedSupabaseFailure(async () => ({
    ok: false,
    status: 500,
    async text() {
      return `PGRST202 SQLSTATE public.provider_tokens ${API_KEY}`;
    }
  }));
  assert.deepEqual(Object.keys(databaseFailure.traceMetadata).sort(), ["area", "method", "pathname"]);
  assert.equal(databaseFailure.traceMetadata.area, "rest");
  assert.equal(databaseFailure.traceMetadata.pathname, "/vizard-connection");
  assert.equal(databaseFailure.traceMetadata.method, "POST");
  assert.equal(databaseFailure.tracedError.code, "connection_service_unavailable");
  assert.equal(databaseFailure.tracedError.message, "The Vizard connection service is temporarily unavailable.");

  const networkFailure = await runSanitizedSupabaseFailure(async () => {
    throw new Error(`OAUTH_TOKEN_ENCRYPTION_KEY internal network failure ${API_KEY}`);
  });
  assert.equal(networkFailure.tracedError.code, "connection_update_failed");
  const serialized = JSON.stringify({
    code: networkFailure.tracedError.code,
    message: networkFailure.tracedError.message
  });
  assert.equal(serialized.includes("OAUTH_TOKEN_ENCRYPTION_KEY"), false);
  assert.equal(serialized.includes(API_KEY), false);
});

async function runUiSubmitScenario({
  apiKey = API_KEY,
  action = "connect",
  fetchResult = response(200, {
    ok: true,
    connection: {
      credentialStored: true,
      verificationState: "pending",
      apiKeyMaxUtf8Bytes: VIZARD_API_KEY_MAX_UTF8_BYTES
    }
  })
} = {}) {
  const calls = [];
  const appResults = [];
  const consoleCalls = [];
  const storageWrites = [];
  let renders = 0;
  const field = { value: apiKey };
  const submit = {
    disabled: false,
    textContent: action === "replace" ? "Replace key" : "Connect Vizard"
  };
  const form = {
    dataset: {
      action,
      apiKeyMaxUtf8Bytes: String(VIZARD_API_KEY_MAX_UTF8_BYTES)
    },
    elements: { apiKey: field },
    querySelector: selector => {
      assert.equal(selector, 'button[type="submit"]');
      return submit;
    }
  };
  const context = loadUiFunctions(uiSource, [uiHelpers, uiSubmitFunction], {
    metaState: { vizardStatus: {} },
    authedFetch: async (...args) => {
      calls.push(args);
      if (fetchResult instanceof Error) throw fetchResult;
      return fetchResult;
    },
    showAppResult: (...args) => appResults.push(args),
    renderAccounts: () => {
      renders += 1;
    },
    localStorage: {
      setItem: (...args) => storageWrites.push(args),
      getItem: () => null
    },
    console: {
      log: (...args) => consoleCalls.push(["log", ...args]),
      warn: (...args) => consoleCalls.push(["warn", ...args]),
      error: (...args) => consoleCalls.push(["error", ...args])
    }
  });
  await context.saveVizardCredential({
    preventDefault() {},
    currentTarget: form
  });
  return {
    apiKey,
    appResults,
    calls,
    consoleCalls,
    field,
    renders,
    storageWrites,
    submit
  };
}

await check("browser submit sends only JSON and clears plaintext after success", async () => {
  const result = await runUiSubmitScenario();
  assert.equal(result.field.value, "");
  assert.equal(result.calls.length, 1);
  const [pathname, options] = result.calls[0];
  assert.equal(pathname, "/api/accounts/vizard/connect");
  assert.equal(pathname.includes(API_KEY), false);
  assert.deepEqual(Object.keys(options.headers), ["Content-Type"]);
  assert.equal(options.headers["Content-Type"], "application/json");
  assert.equal(JSON.stringify(options.headers).includes(API_KEY), false);
  assert.deepEqual(Object.keys(JSON.parse(options.body)), ["apiKey"]);
  assert.equal(result.renders, 1);
  assert.equal(result.submit.disabled, false);
  assert.equal(result.submit.textContent, "Connect Vizard");
  assert.deepEqual(result.storageWrites, []);
  assert.deepEqual(result.consoleCalls, []);
});

await check("browser plaintext clears after every HTTP rejection", async () => {
  const failures = [
    [400, "invalid_request", "Enter a valid Vizard API key."],
    [401, "not_authenticated", "Sign in before managing the Vizard connection."],
    [403, "not_authorized", "You do not have permission to manage this workspace connection."],
    [415, "unsupported_media_type", "Send the Vizard API key as JSON."],
    [500, "connection_update_failed", "The connection could not be updated."],
    [503, "connection_service_unavailable", "The Vizard connection service is temporarily unavailable."]
  ];
  for (const [status, code, expectedMessage] of failures) {
    const result = await runUiSubmitScenario({
      fetchResult: response(status, {
        ok: false,
        code,
        error: `OAUTH_TOKEN_ENCRYPTION_KEY social_cues_manage_vizard_connection SQLSTATE ${API_KEY}`
      })
    });
    assert.equal(result.field.value, "");
    assert.equal(result.calls.length, 1);
    assert.equal(result.appResults.at(-1)?.[1], expectedMessage);
    assert.equal(JSON.stringify(result.appResults).includes(API_KEY), false);
    assert.equal(JSON.stringify(result.appResults).includes("OAUTH_TOKEN_ENCRYPTION_KEY"), false);
    assert.equal(JSON.stringify(result.appResults).includes("social_cues_manage_vizard_connection"), false);
    assert.equal(JSON.stringify(result.appResults).includes("SQLSTATE"), false);
  }
});

await check("browser plaintext clears after network, timeout, and malformed-response failures", async () => {
  const network = await runUiSubmitScenario({
    fetchResult: new Error(`network rejected ${API_KEY}`)
  });
  assert.equal(network.field.value, "");
  assert.equal(JSON.stringify(network.appResults).includes(API_KEY), false);
  assert.equal(network.appResults.at(-1)?.[1], "The connection could not be updated.");

  const timeout = await runUiSubmitScenario({
    fetchResult: new Error(`timeout ${API_KEY}`)
  });
  assert.equal(timeout.field.value, "");
  assert.equal(JSON.stringify(timeout.appResults).includes(API_KEY), false);

  const malformed = await runUiSubmitScenario({
    fetchResult: {
      ok: true,
      async json() {
        throw new Error(`malformed response ${API_KEY}`);
      }
    }
  });
  assert.equal(malformed.field.value, "");
  assert.equal(JSON.stringify(malformed.appResults).includes(API_KEY), false);
});

await check("browser local byte-limit rejection clears plaintext and makes no request", async () => {
  const oversized = "\u00e9".repeat(1537);
  const result = await runUiSubmitScenario({ apiKey: oversized });
  assert.equal(result.field.value, "");
  assert.equal(result.calls.length, 0);
  assert.equal(result.appResults.at(-1)?.[1], "Enter a valid Vizard API key.");
  assert.equal(JSON.stringify(result.appResults).includes(oversized.slice(0, 20)), false);
  assert.deepEqual(result.storageWrites, []);
  assert.deepEqual(result.consoleCalls, []);
  assert.ok(uiSubmitFunction.includes("apiKey = \"\";"));
});

function renderVizardCard(connection, status = { ok: true }) {
  const context = loadUiFunctions(uiSource, [uiHelpers, uiCardFunction], {
    canAccessAdminPanel: () => true,
    escapeHtml,
    metaState: {
      vizardStatus: {
        ...status,
        connection
      }
    }
  });
  return context.renderVizardConnectionCard();
}

await check("disconnected Vizard card has exact copy, command, and official non-affiliate link", () => {
  const html = renderVizardCard({
    credentialStored: false,
    credentialStorageAvailable: true,
    apiKeyMaxUtf8Bytes: VIZARD_API_KEY_MAX_UTF8_BYTES,
    connectedAt: "2099-01-01T00:00:00.000Z"
  });
  assert.match(html, /AI video clipping and editing through your own Vizard account\./u);
  assert.match(html, />Connect Vizard<\/button>/u);
  assert.match(html, /Requires your own Vizard account\./u);
  assert.match(html, /Vizard processing charges are billed by Vizard\./u);
  assert.match(html, />Create a Vizard account<\/a>/u);
  assert.match(html, /target="_blank"/u);
  assert.match(html, /rel="noopener noreferrer"/u);
  assert.match(html, /data-api-key-max-utf8-bytes="3072"/u);
  assert.match(html, /Maximum: 3072 UTF-8 bytes\./u);
  assert.doesNotMatch(html, /\bvalue="/iu);
  assert.doesNotMatch(html, /2099-01-01|affiliate|referral|partner|commission/iu);
  const href = html.match(/href="([^"]+)"[^>]*>Create a Vizard account<\/a>/u)?.[1];
  assert.ok(href);
  const accountUrl = new URL(href);
  assert.equal(accountUrl.protocol, "https:");
  assert.equal(accountUrl.hostname, "vizard.ai");
  assert.equal(accountUrl.search, "");
});

await check("stored Vizard card remains pending and never repopulates or overstates the credential", () => {
  const html = renderVizardCard({
    credentialStored: true,
    credentialStorageAvailable: true,
    apiKeyMaxUtf8Bytes: VIZARD_API_KEY_MAX_UTF8_BYTES,
    verificationState: "pending",
    connected: true,
    tokenId: "must-not-render",
    apiKey: API_KEY
  });
  assert.match(html, /Credential stored\. Verification pending\./u);
  assert.match(html, />Replace key<\/button>/u);
  assert.match(html, />Disconnect<\/button>/u);
  assert.match(html, /Requires your own Vizard account\./u);
  assert.match(html, /Vizard processing charges are billed by Vizard\./u);
  assert.doesNotMatch(html, /\bVerified\b|\bOperational\b|Authenticated with Vizard/iu);
  assert.doesNotMatch(html, /must-not-render|vizard-contract-api-key|token ID|key length|key prefix|key suffix/iu);
  assert.doesNotMatch(html, /\bvalue="/iu);
});

await check("Vizard UI adds no Phase 2B clipping, job, polling, or publishing controls", () => {
  const lower = uiCardFunction.toLowerCase();
  for (const forbidden of [
    "data-vizard-upload",
    "data-vizard-job",
    "data-vizard-poll",
    "data-vizard-publish",
    "/api/vizard/jobs",
    "/api/vizard/publish"
  ]) {
    assert.equal(lower.includes(forbidden), false);
  }
});

assert.equal(externalRequests, 0);
console.log(JSON.stringify({
  ok: true,
  checks: passed,
  externalRequests,
  browserUiBehavior: true,
  productionRequests: 0,
  providerRequests: 0
}));
