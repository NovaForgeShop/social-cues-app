import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(root, "server.mjs");
const seedPath = path.join(root, "social-cues-model-seed.json");
const authSessionSecret = "synthetic-meta-health-session-secret";
const tokenEncryptionKey = "synthetic-meta-health-encryption-key";
const metaAppId = "123456789012345";
const metaAppSecret = "synthetic-meta-health-app-secret";
const metaTokenA = "synthetic-meta-health-user-token-a";
const metaTokenB = "synthetic-meta-health-user-token-b";
const pageTokenA = "synthetic-meta-health-page-token-a";
const bearerA = "synthetic-meta-health-session-a";
const revokedBearer = "synthetic-meta-health-session-revoked";
const expiredBearer = "synthetic-meta-health-session-expired";
const invalidBearer = "synthetic-meta-health-session-invalid";
const userA = Object.freeze({
  id: "meta-health-user-a",
  email: "meta-health-a@example.test",
  name: "Meta Health User A",
  role: "Member",
  workspaceId: "meta-health-workspace-a",
  entitlement: {
    access: "promo",
    source: "contract",
    active: true,
    grantedAt: "2026-08-30T12:00:00.000Z",
    expiresAt: "2036-08-30T12:00:00.000Z"
  }
});
const userB = Object.freeze({
  id: "meta-health-user-b",
  email: "meta-health-b@example.test",
  name: "Meta Health User B",
  role: "Member",
  workspaceId: "meta-health-workspace-b",
  entitlement: {
    access: "promo",
    source: "contract",
    active: true,
    grantedAt: "2026-08-30T12:00:00.000Z",
    expiresAt: "2036-08-30T12:00:00.000Z"
  }
});
const protectedValues = [
  authSessionSecret,
  tokenEncryptionKey,
  metaAppSecret,
  metaTokenA,
  metaTokenB,
  pageTokenA,
  bearerA,
  revokedBearer,
  expiredBearer,
  invalidBearer
];
const categoryCounts = {
  sourceOrdering: 0,
  anonymous: 0,
  invalidSessions: 0,
  authenticated: 0,
  crossWorkspace: 0,
  safety: 0
};
let checkCount = 0;
let hostileMutationCount = 0;

function check(category, condition, message) {
  assert.ok(condition, message);
  categoryCounts[category] += 1;
  checkCount += 1;
}

function equal(category, actual, expected, message) {
  assert.equal(actual, expected, message);
  categoryCounts[category] += 1;
  checkCount += 1;
}

function deepEqual(category, actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  categoryCounts[category] += 1;
  checkCount += 1;
}

function hashSessionToken(token) {
  return createHmac("sha256", authSessionSecret).update(token).digest("base64url");
}

function encryptedCredential(value) {
  const key = createHash("sha256").update(tokenEncryptionKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    value: ciphertext.toString("base64url")
  };
}

function deviceSession({ id, token, user, revokedAt = null, expiresAt = "2036-08-30T12:00:00.000Z" }) {
  return {
    id,
    deviceId: id,
    userId: user.id,
    workspaceId: user.workspaceId,
    sessionTokenHash: hashSessionToken(token),
    sessionProvider: "local-password",
    trusted: true,
    lastSeenAt: "2026-08-30T12:00:00.000Z",
    expiresAt,
    revokedAt
  };
}

function metaAccount({ id, user, providerAccountId, token, name }) {
  return {
    id,
    platform: "meta",
    oauthProvider: "meta",
    ownerUserId: user.id,
    workspaceId: user.workspaceId,
    providerAccountId,
    name,
    handle: name,
    status: "connected",
    connectedAt: "2026-08-30T12:00:00.000Z",
    scopes: ["public_profile", "pages_show_list", "pages_read_engagement", "business_management"],
    credential: encryptedCredential(token),
    tokenType: "bearer",
    tokenExpiresAt: "2036-08-30T12:00:00.000Z"
  };
}

function buildModel(seed) {
  const model = structuredClone(seed);
  model.authUsers = [structuredClone(userA), structuredClone(userB)];
  model.deviceSessions = [
    deviceSession({ id: "meta-health-device-a", token: bearerA, user: userA }),
    deviceSession({ id: "meta-health-device-revoked", token: revokedBearer, user: userA, revokedAt: "2026-08-30T12:30:00.000Z" }),
    deviceSession({ id: "meta-health-device-expired", token: expiredBearer, user: userA, expiresAt: "2020-01-01T00:00:00.000Z" })
  ];
  model.workspaces = [
    {
      id: userA.workspaceId,
      name: "Meta Health Workspace A",
      ownerUserId: userA.id,
      metaHealth: { marker: "workspace-a-health-before" },
      analytics: { marker: "workspace-a-analytics-before" }
    },
    {
      id: userB.workspaceId,
      name: "Meta Health Workspace B",
      ownerUserId: userB.id,
      metaHealth: { marker: "workspace-b-health-before" },
      analytics: { marker: "workspace-b-analytics-before" }
    }
  ];
  model.connectedAccounts = (model.connectedAccounts || [])
    .filter(account => !["meta", "facebook", "instagram"].includes(account.platform));
  model.connectedAccounts.push(
    metaAccount({
      id: "acct-meta-health-a",
      user: userA,
      providerAccountId: "111111111111111",
      token: metaTokenA,
      name: "Synthetic Meta A"
    }),
    metaAccount({
      id: "acct-meta-health-b",
      user: userB,
      providerAccountId: "222222222222222",
      token: metaTokenB,
      name: "Foreign Meta B"
    }),
    {
      id: "acct-facebook-health-b",
      platform: "facebook",
      oauthProvider: "meta",
      ownerUserId: userB.id,
      workspaceId: userB.workspaceId,
      providerAccountId: "333333333333333",
      name: "Foreign Page B",
      handle: "Foreign Page B",
      status: "connected",
      connectedAt: "2026-08-30T12:00:00.000Z",
      scopes: ["pages_show_list", "pages_read_engagement"],
      credential: encryptedCredential(metaTokenB),
      tokenType: "bearer"
    }
  );
  model.activeProviderAccounts = {
    ...(model.activeProviderAccounts || {}),
    meta: "111111111111111"
  };
  model.metaHealth = { marker: "root-health-before" };
  model.analytics = { marker: "root-analytics-before" };
  model.metaConnection = { marker: "root-connection-before" };
  model.integrations = { ...(model.integrations || {}), meta: "root-integration-before" };
  model.activity = [{ id: "activity-before", type: "fixture" }];
  model.actions = [{ id: "action-before", type: "fixture" }];
  model.oauthEvents = [{ id: "oauth-before", provider: "fixture" }];
  return model;
}

const metaCredentialNames = [
  "META_APP_ID",
  "META_CLIENT_ID",
  "FACEBOOK_APP_ID",
  "FACEBOOK_CLIENT_ID",
  "FB_APP_ID",
  "META_APP_SECRET",
  "META_CLIENT_SECRET",
  "FACEBOOK_APP_SECRET",
  "FACEBOOK_CLIENT_SECRET",
  "FB_APP_SECRET"
];

function scenarioEnvironment({ dataDir, requestLogPath, hosted = false }) {
  const env = { ...process.env };
  const removedNames = new Set(metaCredentialNames.map(name => name.toLowerCase()));
  for (const existingName of Object.keys(env)) {
    if (removedNames.has(existingName.toLowerCase())) delete env[existingName];
  }
  return {
    ...env,
    PORT: "0",
    HOST: "127.0.0.1",
    PUBLIC_APP_URL: "https://social-cues-meta-health.example.test",
    META_PUBLIC_APP_URL: "https://social-cues-meta-health.example.test",
    META_APP_ID: metaAppId,
    META_APP_SECRET: metaAppSecret,
    META_API_VERSION: "v23.0",
    AUTH_PROVIDER: "alpha-local",
    AUTH_SESSION_SECRET: authSessionSecret,
    OAUTH_TOKEN_ENCRYPTION_KEY: tokenEncryptionKey,
    SUPABASE_ENABLED: "false",
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    SUPABASE_SECRET_KEY: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    SENTRY_DSN: "",
    VERCEL: hosted ? "1" : "",
    SOCIAL_CUES_DATA_DIR: dataDir,
    SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: requestLogPath,
    SOCIAL_CUES_TEST_META_TOKEN_A: metaTokenA,
    SOCIAL_CUES_TEST_META_TOKEN_B: metaTokenB,
    SOCIAL_CUES_TEST_META_PAGE_TOKEN_A: pageTokenA
  };
}

async function availablePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  probe.close();
  await once(probe, "close");
  return port;
}

async function request(baseUrl, pathname, { method = "GET", bearer = "", body, headers: suppliedHeaders = {} } = {}) {
  const headers = { ...suppliedHeaders };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    redirect: "manual",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, text, body: parsed };
}

async function waitForServer(baseUrl, child, output) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Meta health contract server exited early (${child.exitCode}).\n${output()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Meta health contract server.\n${output()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    delay(3_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    })
  ]);
}

async function readRequestLog(logPath) {
  try {
    const source = await readFile(logPath, "utf8");
    return source.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function startScenario({ temporaryRoot, label, model, hosted = false, guardPath }) {
  const dataDir = path.join(temporaryRoot, label);
  const requestLogPath = path.join(dataDir, "external-requests.ndjson");
  const modelPath = path.join(dataDir, "model.json");
  await mkdir(dataDir, { recursive: true });
  await writeFile(modelPath, JSON.stringify(model, null, 2), "utf8");
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = scenarioEnvironment({ dataDir, requestLogPath, hosted });
  env.PORT = String(port);
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [`--import=${pathToFileURL(guardPath).href}`, serverPath], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  await waitForServer(baseUrl, child, () => `${stdout}\n${stderr}`);
  return {
    baseUrl,
    child,
    dataDir,
    modelPath,
    requestLogPath,
    output: () => `${stdout}\n${stderr}`
  };
}

function snapshotSideEffectCollections(model) {
  return Object.fromEntries([
    "activity",
    "actions",
    "jobs",
    "queue",
    "publishQueue",
    "auditLog",
    "oauthEvents"
  ].map(key => [key, structuredClone(model[key])]));
}

function assertProtectedValuesAbsent(category, value, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) || "";
  for (const protectedValue of protectedValues) {
    check(category, !serialized.includes(protectedValue), `${label} exposed a protected value`);
  }
}

function assertDenial(response, category, label) {
  equal(category, response.status, 401, `${label} did not return HTTP 401`);
  deepEqual(category, response.body, {
    ok: false,
    error: "Sign in to Social Cues before using this API."
  }, `${label} did not use the sanitized authentication denial`);
  const serialized = JSON.stringify(response.body);
  for (const identifier of [userA.id, userB.id, userA.workspaceId, userB.workspaceId, "111111111111111", "222222222222222", "333333333333333"]) {
    check(category, !serialized.includes(identifier), `${label} disclosed a user, workspace, or provider identifier`);
  }
  assertProtectedValuesAbsent(category, response.body, label);
}

function metaHealthRouteSection(source) {
  const start = source.indexOf('if (url.pathname === "/api/meta/health" && ["GET", "POST"].includes(req.method))');
  const end = source.indexOf('if (url.pathname === "/api/meta/sync" && req.method === "POST")', start);
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

function implementationViolations(source) {
  const violations = [];
  const route = metaHealthRouteSection(source);
  if (!route) return ["route missing"];
  const positions = {
    modelLoad: route.indexOf("const sharedModel = await getModel();"),
    session: route.indexOf("await hostedWriteRequiresSession(req, sharedModel)"),
    denial: route.indexOf('if (req.method === "POST" && !session?.user)'),
    workspace: route.indexOf("await modelForSession(session, sharedModel)"),
    repair: route.indexOf("repairTokenBackedMetaAssets("),
    inspection: route.indexOf("await inspectMetaConnection("),
    health: route.indexOf("model.metaHealth = inspection;"),
    analytics: route.indexOf("model.analytics = buildGrowthAnalytics(model);"),
    persistence: route.indexOf("await saveModelForUser(model, session?.user || null);")
  };
  if (Object.values(positions).some(position => position < 0)) violations.push("required boundary missing");
  if (!(positions.modelLoad < positions.session
    && positions.session < positions.denial
    && positions.denial < positions.workspace
    && positions.workspace < positions.repair
    && positions.repair < positions.inspection
    && positions.inspection < positions.health
    && positions.health < positions.analytics
    && positions.analytics < positions.persistence)) {
    violations.push("unsafe operation ordering");
  }
  if (!route.includes('return json(res, 401, { ok: false, error: "Sign in to Social Cues before using this API." });')) {
    violations.push("sanitized denial missing");
  }
  if (!route.includes("accountOwnerPatch(session.user)")) violations.push("trusted workspace owner patch missing");
  if (!route.includes("ownedByUser(account, session.user.id)")) violations.push("response owner filter missing");
  if (!route.includes('if (runtimeMode === "vercel" && !session)')) violations.push("hosted route gate missing");
  if (/bodyJson\(|bodyText\(|body\.(?:workspaceId|workspace_id|userId|ownerUserId|role|email|accountId|providerAccountId|pageId|instagramAccountId|accessToken|token|credential|analytics|metaHealth)|url\.searchParams/u.test(route)) {
    violations.push("browser-controlled authority introduced");
  }
  if (/model\.workspaces\s*\)|for\s*\([^)]*workspaces/u.test(route)) violations.push("multi-workspace mutation introduced");
  if (/metaAppSecret|credential[^\n]*error|error[^\n]*credential/iu.test(route)) violations.push("credential disclosure introduced");
  if (!source.includes("if (!(await enforceHostedApiAccess(req, res, url))) return;")) violations.push("hosted fail-closed gate missing");
  return violations;
}

function rejectHostileMutation(source, label, mutate, { wholeSource = false } = {}) {
  const normalizedSource = source.replace(/\r\n/gu, "\n");
  const target = wholeSource ? normalizedSource : metaHealthRouteSection(normalizedSource);
  const mutatedTarget = mutate(target);
  const mutated = wholeSource ? mutatedTarget : normalizedSource.replace(target, mutatedTarget);
  check("sourceOrdering", mutated !== normalizedSource, `${label} mutation did not alter the source`);
  check("sourceOrdering", implementationViolations(mutated).length > 0, `source contract accepted hostile mutation: ${label}`);
  hostileMutationCount += 1;
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "social-cues-meta-health-auth-"));
const guardPath = path.join(temporaryRoot, "external-request-guard.mjs");
const requestGuardSource = `
import { appendFileSync } from "node:fs";

const originalFetch = globalThis.fetch;
const logPath = process.env.SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG || "";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function record(entry) {
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\\n", "utf8");
}

function tokenOwner(url) {
  const candidate = url.searchParams.get("input_token") || url.searchParams.get("access_token") || "";
  if (candidate === process.env.SOCIAL_CUES_TEST_META_TOKEN_A || candidate === process.env.SOCIAL_CUES_TEST_META_PAGE_TOKEN_A) return "active-workspace";
  if (candidate === process.env.SOCIAL_CUES_TEST_META_TOKEN_B) return "foreign-workspace";
  return "application-or-unknown";
}

globalThis.fetch = async (input, init = {}) => {
  const rawUrl = input instanceof URL || typeof input === "string" ? String(input) : String(input?.url || "");
  const url = new URL(rawUrl);
  if (loopbackHosts.has(url.hostname)) return originalFetch(input, init);
  if (url.hostname === "graph.facebook.com") {
    const owner = tokenOwner(url);
    record({ kind: "meta-mock", method: String(init.method || "GET").toUpperCase(), pathname: url.pathname, owner });
    if (url.pathname.endsWith("/debug_token")) {
      return new Response(JSON.stringify({ data: {
        is_valid: true,
        app_id: "${metaAppId}",
        user_id: owner === "foreign-workspace" ? "222222222222222" : "111111111111111",
        expires_at: 2082758400,
        scopes: ["public_profile", "pages_show_list", "pages_read_engagement", "business_management"]
      } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname.endsWith("/me/permissions")) {
      return new Response(JSON.stringify({ data: [
        { permission: "public_profile", status: "granted" },
        { permission: "pages_show_list", status: "granted" },
        { permission: "pages_read_engagement", status: "granted" },
        { permission: "business_management", status: "granted" }
      ] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname.endsWith("/me/accounts")) {
      return new Response(JSON.stringify({ data: [{
        id: "444444444444444",
        name: "Synthetic Page A",
        category: "Test",
        access_token: process.env.SOCIAL_CUES_TEST_META_PAGE_TOKEN_A,
        tasks: ["ANALYZE"],
        instagram_business_account: {
          id: "555555555555555",
          username: "synthetic_meta_health_a",
          name: "Synthetic Instagram A"
        }
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname.endsWith("/me/businesses")) {
      return new Response(JSON.stringify({ data: [{
        id: "666666666666666",
        name: "Synthetic Business A",
        verification_status: "not_verified"
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    record({ kind: "blocked-meta-request", method: String(init.method || "GET").toUpperCase(), pathname: url.pathname });
    throw new Error("Unexpected Meta request blocked by the Meta health contract.");
  }
  record({ kind: "blocked-external-request", method: String(init.method || "GET").toUpperCase(), host: url.hostname, pathname: url.pathname });
  throw new Error("External requests are disabled by the Meta health contract.");
};
`;

let localScenario = null;
let hostedScenario = null;
let cleanupComplete = false;
let failure = null;
let providerMockRequests = 0;

try {
  await writeFile(guardPath, requestGuardSource, "utf8");
  const seed = JSON.parse(await readFile(seedPath, "utf8"));
  localScenario = await startScenario({
    temporaryRoot,
    label: "local",
    model: buildModel(seed),
    guardPath
  });

  const prime = await request(localScenario.baseUrl, "/api/model", { bearer: bearerA });
  equal("authenticated", prime.status, 200, "authenticated model prime failed");
  const stableBeforeDenied = await readFile(localScenario.modelPath);
  const guardBeforeDenied = await readRequestLog(localScenario.requestLogPath);
  const hostileBody = {
    workspaceId: userB.workspaceId,
    workspace_id: userB.workspaceId,
    userId: userB.id,
    ownerUserId: userB.id,
    role: "owner",
    email: userB.email,
    accountId: "acct-meta-health-b",
    providerAccountId: "222222222222222",
    pageId: "333333333333333",
    instagramAccountId: "777777777777777",
    accessToken: "body-access-token-marker",
    token: "body-token-marker",
    credential: "body-credential-marker",
    analytics: { marker: "body-analytics-marker" },
    metaHealth: { marker: "body-health-marker" }
  };
  const hostileBodyBefore = structuredClone(hostileBody);

  const anonymous = await request(localScenario.baseUrl, "/api/meta/health?workspaceId=meta-health-workspace-b", {
    method: "POST",
    body: hostileBody
  });
  assertDenial(anonymous, "anonymous", "anonymous Meta health POST");
  equal("anonymous", Buffer.compare(await readFile(localScenario.modelPath), stableBeforeDenied), 0, "anonymous denial changed persisted model bytes");
  deepEqual("anonymous", await readRequestLog(localScenario.requestLogPath), guardBeforeDenied, "anonymous denial attempted a provider or external request");

  for (const [label, bearer] of [
    ["invalid", invalidBearer],
    ["revoked", revokedBearer],
    ["expired", expiredBearer]
  ]) {
    const before = await readFile(localScenario.modelPath);
    const beforeRequests = await readRequestLog(localScenario.requestLogPath);
    const denied = await request(localScenario.baseUrl, "/api/meta/health", { method: "POST", bearer, body: hostileBody });
    assertDenial(denied, "invalidSessions", `${label} Meta health session`);
    equal("invalidSessions", Buffer.compare(await readFile(localScenario.modelPath), before), 0, `${label} session changed persisted model bytes`);
    deepEqual("invalidSessions", await readRequestLog(localScenario.requestLogPath), beforeRequests, `${label} session attempted a provider or external request`);
  }

  const authenticatedBeforeSource = await readFile(localScenario.modelPath, "utf8");
  const authenticatedBefore = JSON.parse(authenticatedBeforeSource);
  const foreignWorkspaceBefore = structuredClone(authenticatedBefore.workspaces.find(item => item.id === userB.workspaceId));
  const foreignAccountsBefore = structuredClone(authenticatedBefore.connectedAccounts.filter(item => item.ownerUserId === userB.id));
  const sideEffectsBefore = snapshotSideEffectCollections(authenticatedBefore);
  const metaHealthBefore = structuredClone(authenticatedBefore.metaHealth);
  const analyticsBefore = structuredClone(authenticatedBefore.analytics);
  const metaConnectionBefore = structuredClone(authenticatedBefore.metaConnection);
  const authenticatedRequestsBefore = await readRequestLog(localScenario.requestLogPath);
  const authenticated = await request(localScenario.baseUrl, "/api/meta/health?workspaceId=meta-health-workspace-b&providerAccountId=222222222222222", {
    method: "POST",
    bearer: bearerA,
    body: hostileBody
  });
  equal("authenticated", authenticated.status, 200, "authenticated Meta health POST did not retain historical success behavior");
  equal("authenticated", authenticated.body?.ok, true, "authenticated Meta health response was not successful");
  check("authenticated", Array.isArray(authenticated.body?.accounts), "authenticated Meta health response omitted accounts");
  check("authenticated", Array.isArray(authenticated.body?.capabilities), "authenticated Meta health response omitted capabilities");
  check("authenticated", Boolean(authenticated.body?.health), "authenticated Meta health response omitted health");
  check("authenticated", Boolean(authenticated.body?.analytics), "authenticated Meta health response omitted analytics");
  check("authenticated", Object.keys(authenticated.body || {}).every(key => ["ok", "metaConnection", "health", "diagnostic", "accounts", "capabilities", "analytics"].includes(key)), "authenticated Meta health response added an unapproved top-level field");
  check("authenticated", !Object.prototype.hasOwnProperty.call(authenticated.body?.health || {}, "token"), "authenticated Meta health response exposed the raw token-health key");
  const authenticatedAfter = JSON.parse(await readFile(localScenario.modelPath, "utf8"));
  check("authenticated", JSON.stringify(authenticatedAfter.metaHealth) !== JSON.stringify(metaHealthBefore), "authenticated Meta health did not update health state");
  check("authenticated", JSON.stringify(authenticatedAfter.analytics) !== JSON.stringify(analyticsBefore), "authenticated Meta health did not update analytics state");
  check("authenticated", JSON.stringify(authenticatedAfter.metaConnection) !== JSON.stringify(metaConnectionBefore), "authenticated Meta health did not update connection state");
  check("authenticated", authenticatedAfter.integrations?.meta !== "root-integration-before", "authenticated Meta health did not update integration readiness");
  check("authenticated", authenticatedAfter.connectedAccounts.some(item => item.platform === "facebook" && item.ownerUserId === userA.id && item.workspaceId === userA.workspaceId && item.providerAccountId === "444444444444444"), "authenticated Meta health did not sync the active workspace Page");
  check("authenticated", authenticatedAfter.connectedAccounts.some(item => item.platform === "instagram" && item.ownerUserId === userA.id && item.workspaceId === userA.workspaceId && item.providerAccountId === "555555555555555"), "authenticated Meta health did not sync the active workspace Instagram account");
  deepEqual("authenticated", snapshotSideEffectCollections(authenticatedAfter), sideEffectsBefore, "authenticated Meta health unexpectedly changed queue or audit collections");
  const authenticatedRequestsAfter = await readRequestLog(localScenario.requestLogPath);
  const authenticatedMockRequests = authenticatedRequestsAfter.slice(authenticatedRequestsBefore.length);
  providerMockRequests += authenticatedMockRequests.filter(item => item.kind === "meta-mock").length;
  equal("authenticated", authenticatedMockRequests.filter(item => item.kind === "meta-mock").length, 4, "authenticated Meta inspection did not use the bounded four-request mock");
  check("authenticated", authenticatedMockRequests.every(item => item.kind === "meta-mock"), "authenticated Meta inspection attempted a non-mocked external request");
  check("authenticated", authenticatedMockRequests.every(item => item.owner === "active-workspace" || item.owner === "application-or-unknown"), "authenticated Meta inspection selected a foreign credential");

  deepEqual("crossWorkspace", authenticatedAfter.workspaces.find(item => item.id === userB.workspaceId), foreignWorkspaceBefore, "hostile body changed the foreign workspace record");
  deepEqual("crossWorkspace", authenticatedAfter.connectedAccounts.filter(item => item.ownerUserId === userB.id), foreignAccountsBefore, "hostile body changed a foreign provider account");
  check("crossWorkspace", authenticatedAfter.metaHealth?.marker !== "body-health-marker", "body metaHealth overwrote trusted inspection state");
  check("crossWorkspace", authenticatedAfter.analytics?.marker !== "body-analytics-marker", "body analytics overwrote calculated state");
  const authenticatedSerialized = JSON.stringify(authenticated.body);
  for (const foreignMarker of [userB.id, userB.workspaceId, userB.email, "222222222222222", "333333333333333", "Foreign Meta B", "Foreign Page B"]) {
    check("crossWorkspace", !authenticatedSerialized.includes(foreignMarker), "authenticated response disclosed foreign workspace state");
  }
  for (const hostileMarker of ["body-access-token-marker", "body-token-marker", "body-credential-marker", "body-analytics-marker", "body-health-marker"]) {
    check("crossWorkspace", !JSON.stringify(authenticatedAfter).includes(hostileMarker), "hostile browser field was persisted");
    check("crossWorkspace", !authenticatedSerialized.includes(hostileMarker), "hostile browser field was reflected");
  }
  deepEqual("safety", hostileBody, hostileBodyBefore, "request fixture input was mutated");
  assertProtectedValuesAbsent("safety", authenticated.body, "authenticated response");
  assertProtectedValuesAbsent("safety", localScenario.output(), "local stdout or stderr");
  assertProtectedValuesAbsent("safety", authenticatedMockRequests, "mock request log");

  const hostedFixturePrime = await request(localScenario.baseUrl, "/api/model", { bearer: bearerA });
  equal("safety", hostedFixturePrime.status, 200, "hosted fixture normalization failed");
  const hostedFixtureModel = JSON.parse(await readFile(localScenario.modelPath, "utf8"));

  hostedScenario = await startScenario({
    temporaryRoot,
    label: "hosted",
    model: hostedFixtureModel,
    hosted: true,
    guardPath
  });
  const hostedBefore = await readFile(hostedScenario.modelPath);
  const hostedRequestsBefore = await readRequestLog(hostedScenario.requestLogPath);
  const hostedHeaders = { Origin: "https://social-cues-meta-health.example.test" };
  const hostedAnonymous = await request(hostedScenario.baseUrl, "/api/meta/health", { method: "POST", body: hostileBody, headers: hostedHeaders });
  assertDenial(hostedAnonymous, "invalidSessions", "hosted anonymous Meta health session");
  const hostedInvalid = await request(hostedScenario.baseUrl, "/api/meta/health", { method: "POST", bearer: invalidBearer, body: hostileBody, headers: hostedHeaders });
  assertDenial(hostedInvalid, "invalidSessions", "hosted invalid Meta health session");
  equal("invalidSessions", Buffer.compare(await readFile(hostedScenario.modelPath), hostedBefore), 0, "hosted authentication failure changed persisted model bytes");
  deepEqual("invalidSessions", await readRequestLog(hostedScenario.requestLogPath), hostedRequestsBefore, "hosted authentication failure attempted a provider or external request");
  assertProtectedValuesAbsent("safety", hostedScenario.output(), "hosted stdout or stderr");

  const serverSource = await readFile(serverPath, "utf8");
  deepEqual("sourceOrdering", implementationViolations(serverSource), [], "Meta health source boundary is unsafe");
  const route = metaHealthRouteSection(serverSource);
  check("sourceOrdering", !/bodyJson\(|bodyText\(|url\.searchParams/u.test(route), "Meta health route reads browser-controlled authority");
  check("sourceOrdering", route.indexOf('if (req.method === "POST" && !session?.user)') < route.indexOf("repairTokenBackedMetaAssets("), "authentication is not before provider-state repair");
  check("sourceOrdering", route.indexOf('if (req.method === "POST" && !session?.user)') < route.indexOf("await inspectMetaConnection("), "authentication is not before provider inspection and credential resolution");
  check("sourceOrdering", route.indexOf('if (req.method === "POST" && !session?.user)') < route.indexOf("model.metaHealth = inspection;"), "authentication is not before health calculation");
  check("sourceOrdering", route.indexOf('if (req.method === "POST" && !session?.user)') < route.indexOf("await saveModelForUser("), "authentication is not before persistence");
  check("sourceOrdering", route.includes("accountOwnerPatch(session.user)"), "Meta inspection does not use the trusted session owner patch");
  check("sourceOrdering", route.includes("ownedByUser(account, session.user.id)"), "Meta response does not use the authenticated owner filter");
  check("sourceOrdering", serverSource.includes("if (!(await enforceHostedApiAccess(req, res, url))) return;"), "hosted fail-closed boundary changed");

  rejectHostileMutation(serverSource, "authentication after inspection", source => source.replace(
    '    if (req.method === "POST" && !session?.user) {\n      return json(res, 401, { ok: false, error: "Sign in to Social Cues before using this API." });\n    }\n',
    ""
  ).replace(
    "    const inspection = await inspectMetaConnection(model, session?.user ? accountOwnerPatch(session.user) : {});",
    '    const inspection = await inspectMetaConnection(model, session?.user ? accountOwnerPatch(session.user) : {});\n    if (req.method === "POST" && !session?.user) {\n      return json(res, 401, { ok: false, error: "Sign in to Social Cues before using this API." });\n    }'
  ));
  rejectHostileMutation(serverSource, "authentication after persistence", source => source.replace(
    '    if (req.method === "POST" && !session?.user) {\n      return json(res, 401, { ok: false, error: "Sign in to Social Cues before using this API." });\n    }\n',
    ""
  ).replace(
    "    await saveModelForUser(model, session?.user || null);",
    '    await saveModelForUser(model, session?.user || null);\n    if (req.method === "POST" && !session?.user) {\n      return json(res, 401, { ok: false, error: "Sign in to Social Cues before using this API." });\n    }'
  ));
  rejectHostileMutation(serverSource, "accept missing session", source => source.replace('if (req.method === "POST" && !session?.user)', 'if (false && req.method === "POST" && !session?.user)'));
  rejectHostileMutation(serverSource, "trust body workspace", source => source.replace("    const model = session?.user ?", "    const body = { workspaceId: url.searchParams.get(\"workspaceId\") };\n    const model = body.workspaceId ? sharedModel : session?.user ?"));
  rejectHostileMutation(serverSource, "trust body provider account", source => source.replace("    repairTokenBackedMetaAssets(model, session?.user || null);", "    const body = { providerAccountId: url.searchParams.get(\"providerAccountId\") };\n    repairTokenBackedMetaAssets(model, body.providerAccountId || session?.user || null);"));
  rejectHostileMutation(serverSource, "trust body token", source => source.replace("    repairTokenBackedMetaAssets(model, session?.user || null);", "    const body = { token: url.searchParams.get(\"token\") };\n    model.token = body.token;\n    repairTokenBackedMetaAssets(model, session?.user || null);"));
  rejectHostileMutation(serverSource, "write body metaHealth", source => source.replace("    model.metaHealth = inspection;", "    const body = { metaHealth: {} };\n    model.metaHealth = body.metaHealth;"));
  rejectHostileMutation(serverSource, "write body analytics", source => source.replace("    model.analytics = buildGrowthAnalytics(model);", "    const body = { analytics: {} };\n    model.analytics = body.analytics;"));
  rejectHostileMutation(serverSource, "mutate every workspace", source => source.replace("    model.metaHealth = inspection;", "    for (const workspace of model.workspaces) workspace.metaHealth = inspection;\n    model.metaHealth = inspection;"));
  rejectHostileMutation(serverSource, "remove hosted fail closed", source => source.replace("  if (!(await enforceHostedApiAccess(req, res, url))) return;", "  await enforceHostedApiAccess(req, res, url);"), { wholeSource: true });
  rejectHostileMutation(serverSource, "expose credential in denial", source => source.replace('error: "Sign in to Social Cues before using this API."', 'error: `Credential ${metaAppSecret} is required.`'));
  rejectHostileMutation(serverSource, "remove owner filter", source => source.replace("const accounts = realMetaAccounts(model).filter(account => !session?.user || ownedByUser(account, session.user.id));", "const accounts = realMetaAccounts(model);"));

  const allLocalRequests = await readRequestLog(localScenario.requestLogPath);
  const allHostedRequests = await readRequestLog(hostedScenario.requestLogPath);
  check("safety", allLocalRequests.every(item => item.kind === "meta-mock"), "local scenario recorded a real or blocked external request");
  equal("safety", allHostedRequests.length, 0, "hosted denied scenarios recorded an external request");
  equal("safety", allLocalRequests.filter(item => item.kind === "blocked-external-request" || item.kind === "blocked-meta-request").length, 0, "contract encountered an unexpected external request");
  const hermeticEnvironment = scenarioEnvironment({ dataDir: "synthetic-data", requestLogPath: "synthetic-log" });
  check("safety", ["AUTH_PROVIDER", "AUTH_SESSION_SECRET", "OAUTH_TOKEN_ENCRYPTION_KEY", "META_APP_ID", "META_APP_SECRET", "SUPABASE_ENABLED", "SOCIAL_CUES_DATA_DIR"].every(name => Object.prototype.hasOwnProperty.call(hermeticEnvironment, name)), "contract child environment is not explicit and hermetic");
  check("safety", !serverSource.includes("SOCIAL_CUES_TEST_META_HEALTH_AUTH_BYPASS"), "application contains a Meta-health test bypass");
} catch (error) {
  failure = error;
} finally {
  await stopChild(localScenario?.child);
  await stopChild(hostedScenario?.child);
  await rm(temporaryRoot, { recursive: true, force: true });
  cleanupComplete = !existsSync(temporaryRoot);
}

if (!cleanupComplete) throw new Error("Meta health contract cleanup did not complete");
if (failure) throw failure;

console.log(JSON.stringify({
  ok: true,
  checks: checkCount,
  categories: categoryCounts,
  hostileMutations: hostileMutationCount,
  providerMockRequests,
  externalRequests: 0,
  productionRequests: 0,
  realMetaRequests: 0,
  secretsExposed: 0,
  inputsMutated: 0,
  envDependency: false,
  cleanupComplete
}));
