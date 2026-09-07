import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const requestTimeoutMs = 5_000;
const startupTimeoutMs = 20_000;
const contractApiKey = "social-cues-contract-api-key";

function ensure(condition, message) {
  assert.ok(condition, message);
}

function json(res, status, body = null) {
  const value = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(value)
  });
  res.end(value);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5_000_000) throw new Error("Mock request body exceeded the contract limit.");
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function tableRows(state, table) {
  if (!state.tables.has(table)) state.tables.set(table, []);
  return state.tables.get(table);
}

function filterMatches(row, field, expression) {
  const value = row?.[field];
  if (expression.startsWith("eq.")) return String(value ?? "") === expression.slice(3);
  if (expression === "is.null") return value === null || value === undefined;
  if (expression === "not.is.null") return value !== null && value !== undefined;
  if (expression.startsWith("in.(") && expression.endsWith(")")) {
    const accepted = expression.slice(4, -1).split(",").map(item => item.replace(/^"|"$/g, ""));
    return accepted.includes(String(value ?? ""));
  }
  return true;
}

function filteredRows(rows, url) {
  const controls = new Set(["select", "order", "limit", "offset", "on_conflict"]);
  let result = rows.filter(row => {
    for (const [field, expression] of url.searchParams.entries()) {
      if (controls.has(field) || field === "or") continue;
      if (!filterMatches(row, field, expression)) return false;
    }
    return true;
  });
  const order = url.searchParams.get("order") || "";
  if (order) {
    const [field, direction] = order.split(".");
    result = [...result].sort((left, right) => String(left?.[field] ?? "").localeCompare(String(right?.[field] ?? "")));
    if (direction === "desc") result.reverse();
  }
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const limit = Math.max(0, Number(url.searchParams.get("limit") || result.length));
  return result.slice(offset, offset + limit);
}

const naturalConflicts = {
  app_state: ["id"],
  workspaces: ["id"],
  profiles: ["id"],
  workspace_members: ["workspace_id", "user_id"],
  workspace_models: ["workspace_id"],
  billing_entitlements: ["workspace_id", "user_id"],
  device_sessions: ["user_id", "device_id"],
  notification_outbox: ["workspace_id", "idempotency_key"]
};

function upsertRows(state, table, input, url, prefer = "") {
  const rows = tableRows(state, table);
  const incoming = Array.isArray(input) ? input : [input];
  const conflictFields = (url.searchParams.get("on_conflict") || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const keys = conflictFields.length ? conflictFields : naturalConflicts[table] || [];
  const ignoreDuplicates = /resolution=ignore-duplicates/i.test(prefer);
  const saved = [];

  for (const value of incoming.filter(Boolean)) {
    const next = {
      ...value,
      id: value.id || crypto.randomUUID(),
      created_at: value.created_at || new Date().toISOString()
    };
    const existingIndex = keys.length
      ? rows.findIndex(row => keys.every(key => String(row?.[key] ?? "") === String(next?.[key] ?? "")))
      : -1;
    if (existingIndex >= 0 && ignoreDuplicates) continue;
    if (existingIndex >= 0) {
      rows[existingIndex] = { ...rows[existingIndex], ...next, id: rows[existingIndex].id || next.id };
      saved.push(rows[existingIndex]);
    } else {
      rows.push(next);
      saved.push(next);
    }
  }
  return saved;
}

function authUserRecord(user) {
  return {
    id: user.id,
    email: user.email,
    email_confirmed_at: user.confirmedAt,
    confirmed_at: user.confirmedAt,
    user_metadata: { name: user.name },
    raw_user_meta_data: {
      role: "owner",
      workspace_id: user.forgedWorkspaceId,
      promo_code: "FORGED-METADATA-PROMO",
      entitlement: { active: true, access: "owner-full-access" }
    }
  };
}

function createMockSupabase() {
  const state = {
    authUsers: new Map(),
    accessTokens: new Map(),
    failures: [],
    requests: [],
    tables: new Map(),
    loginBehavior: { mode: "normal" },
    signupBehavior: { mode: "unconfirmed" }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      state.requests.push({ method: req.method || "GET", pathname: url.pathname });
      if (req.headers.apikey !== contractApiKey) return json(res, 401, { message: "Contract API key required." });

      if (url.pathname === "/auth/v1/signup" && req.method === "POST") {
        const body = await readJsonBody(req);
        const email = String(body?.email || "").trim().toLowerCase();
        const behavior = state.signupBehavior || { mode: "unconfirmed" };
        if (behavior.mode === "disconnect") {
          req.socket.destroy();
          return;
        }
        if (behavior.mode === "timeout") {
          await delay(Number(behavior.delayMs || 1_000));
          if (res.destroyed) return;
        }
        if (behavior.mode === "raw") {
          const payload = String(behavior.body || "not-json");
          res.writeHead(Number(behavior.status || 200), { "Content-Type": "application/json; charset=utf-8" });
          res.end(payload);
          return;
        }
        if (behavior.mode === "response") {
          return json(res, Number(behavior.status || 200), behavior.body);
        }
        const user = {
          id: crypto.randomUUID(),
          email,
          password: String(body?.password || ""),
          name: String(body?.data?.name || "Contract tester"),
          confirmedAt: null,
          forgedWorkspaceId: crypto.randomUUID(),
          accessToken: "",
          refreshToken: ""
        };
        state.authUsers.set(email, user);
        if (behavior.mode === "confirmed") {
          user.confirmedAt = new Date().toISOString();
          user.accessToken = `contract-access-${crypto.randomBytes(24).toString("base64url")}`;
          user.refreshToken = `contract-refresh-${crypto.randomBytes(24).toString("base64url")}`;
          state.accessTokens.set(user.accessToken, user.id);
          return json(res, 200, {
            access_token: user.accessToken,
            refresh_token: user.refreshToken,
            expires_in: 3600,
            token_type: "bearer",
            user: authUserRecord(user)
          });
        }
        return json(res, 200, { user: authUserRecord(user), access_token: null, refresh_token: null });
      }

      if (url.pathname === "/auth/v1/token" && req.method === "POST" && url.searchParams.get("grant_type") === "password") {
        const body = await readJsonBody(req);
        const email = String(body?.email || "").trim().toLowerCase();
        const behavior = state.loginBehavior || { mode: "normal" };
        if (behavior.mode === "disconnect") {
          req.socket.destroy();
          return;
        }
        if (behavior.mode === "timeout") {
          await delay(Number(behavior.delayMs || 1_000));
          if (res.destroyed) return;
        }
        if (behavior.mode === "raw") {
          const payload = String(behavior.body || "not-json");
          res.writeHead(Number(behavior.status || 200), { "Content-Type": "application/json; charset=utf-8" });
          res.end(payload);
          return;
        }
        if (behavior.mode === "response") {
          return json(res, Number(behavior.status || 200), behavior.body);
        }
        if (behavior.mode === "http-error") {
          return json(res, Number(behavior.status || 503), { message: "Synthetic provider failure body must stay private." });
        }
        const user = state.authUsers.get(email);
        if (!user || user.password !== String(body?.password || "")) {
          return json(res, 400, { message: "Invalid login credentials." });
        }
        if (!user.confirmedAt) {
          return json(res, 400, { message: "Email not confirmed. Check the verification email before signing in." });
        }
        if (!user.accessToken) {
          user.accessToken = `contract-access-${crypto.randomBytes(24).toString("base64url")}`;
          user.refreshToken = `contract-refresh-${crypto.randomBytes(24).toString("base64url")}`;
          state.accessTokens.set(user.accessToken, user.id);
        }
        return json(res, 200, {
          access_token: user.accessToken,
          refresh_token: user.refreshToken,
          expires_in: 3600,
          token_type: "bearer",
          user: authUserRecord(user)
        });
      }

      if (url.pathname === "/auth/v1/user" && req.method === "GET") {
        const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        const userId = state.accessTokens.get(token);
        const user = [...state.authUsers.values()].find(item => item.id === userId);
        if (!user) return json(res, 401, { message: "Invalid session." });
        return json(res, 200, { user: authUserRecord(user) });
      }

      if (url.pathname === "/rest/v1/rpc/social_cues_claim_auth_rate_limit" && req.method === "POST") {
        await readJsonBody(req);
        return json(res, 200, [{ allowed: true, remaining: 20, retry_after_seconds: 0 }]);
      }

      if (url.pathname.startsWith("/rest/v1/")) {
        const table = url.pathname.slice("/rest/v1/".length).split("/")[0];
        const rows = tableRows(state, table);
        if (req.method === "GET") return json(res, 200, filteredRows(rows, url));
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const prefer = String(req.headers.prefer || "");
          const saved = upsertRows(state, table, body, url, prefer);
          return /return=representation/i.test(prefer) ? json(res, 201, saved) : json(res, 201);
        }
        if (req.method === "PATCH") {
          const body = await readJsonBody(req);
          const matches = new Set(filteredRows(rows, url));
          const updated = [];
          rows.forEach((row, index) => {
            if (!matches.has(row)) return;
            rows[index] = { ...row, ...body };
            updated.push(rows[index]);
          });
          return /return=representation/i.test(String(req.headers.prefer || "")) ? json(res, 200, updated) : json(res, 204);
        }
        if (req.method === "DELETE") {
          const matches = new Set(filteredRows(rows, url));
          state.tables.set(table, rows.filter(row => !matches.has(row)));
          return json(res, 204);
        }
      }

      state.failures.push(`${req.method || "GET"} ${url.pathname}: not implemented`);
      return json(res, 404, { message: "Mock route not implemented." });
    } catch (error) {
      state.failures.push(`${req.method || "GET"} ${req.url || "/"}: ${String(error?.message || "mock failure").slice(0, 160)}`);
      return json(res, 500, { message: "Mock Supabase contract failure." });
    }
  });

  return {
    server,
    state,
    confirm(email) {
      const user = state.authUsers.get(String(email).toLowerCase());
      ensure(user, "The mock identity must exist before confirmation.");
      user.confirmedAt = new Date().toISOString();
      return user;
    }
  };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  ensure(address && typeof address === "object", "The mock server did not receive a local address.");
  return `http://127.0.0.1:${address.port}`;
}

async function availablePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise(resolve => probe.close(resolve));
  ensure(port > 0, "Could not reserve a local application port.");
  return port;
}

async function blankRepositoryEnvKeys(env) {
  const source = await readFile(path.join(root, ".env.example"), "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    if (key) env[key] = "";
  }
  return env;
}

function minimalSystemEnv() {
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function redactedOutput(value = "") {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[redacted-id]")
    .replace(/sc_session=[^;\s]+/gi, "sc_session=[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .slice(-2_000);
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Social Cues exited before startup. ${redactedOutput(output())}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Social Cues did not become healthy before the bounded timeout. ${redactedOutput(output())}`);
}

async function appRequest(baseUrl, pathname, { method = "GET", body = null, cookie = "" } = {}) {
  const headers = {};
  if (body !== null) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  if (!new Set(["GET", "HEAD", "OPTIONS"]).has(method)) headers.Origin = baseUrl;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return {
    status: response.status,
    body: parsed,
    setCookie: response.headers.get("set-cookie") || ""
  };
}

function sessionCookie(setCookie) {
  return String(setCookie).split(";")[0];
}

function rowsForUser(state, table, userId) {
  return tableRows(state, table).filter(row =>
    String(row.user_id || row.owner_user_id || row.id || "") === String(userId)
    || String(row.workspace_id || "") === String(userId)
  );
}

function tenantCounts(state, userId) {
  return {
    profiles: rowsForUser(state, "profiles", userId).length,
    workspaces: rowsForUser(state, "workspaces", userId).length,
    memberships: rowsForUser(state, "workspace_members", userId).length,
    entitlements: rowsForUser(state, "billing_entitlements", userId).length,
    devices: rowsForUser(state, "device_sessions", userId).length,
    bootstraps: rowsForUser(state, "workspace_models", userId).length
  };
}

function ensureEmptyTenant(counts, label) {
  ensure(Object.values(counts).every(count => count === 0), `${label} must not create tenant bootstrap records.`);
}

function ensureSingleTenant(counts, label) {
  ensure(Object.values(counts).every(count => count === 1), `${label} must resolve exactly one of every tenant bootstrap record.`);
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null) return true;
  const closed = once(child, "close").catch(() => []);
  if (child.connected) child.send({ type: "social-cues-local-shutdown" }); else child.kill();
  await Promise.race([closed, delay(3_000)]);
  if (child.exitCode !== null) return true;
  child.kill("SIGKILL");
  await Promise.race([once(child, "close").catch(() => []), delay(2_000)]);
  return child.exitCode !== null || child.signalCode !== null;
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

async function startAppInstance({ tempDir, name, mockBaseUrl = "", hosted = true, authProvider = "supabase", env = {} }) {
  const appPort = await availablePort();
  const appBaseUrl = `http://127.0.0.1:${appPort}`;
  const dataDir = env.SOCIAL_CUES_DATA_DIR || path.join(tempDir, name);
  const sessionSecret = `contract-session-${crypto.randomBytes(32).toString("base64url")}`;
  const encryptionSecret = `contract-encryption-${crypto.randomBytes(32).toString("base64url")}`;
  const childEnv = await blankRepositoryEnvKeys(minimalSystemEnv());
  Object.assign(childEnv, {
    PORT: String(appPort),
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    AUTH_PROVIDER: authProvider,
    AUTH_SESSION_SECRET: sessionSecret,
    OAUTH_TOKEN_ENCRYPTION_KEY: encryptionSecret,
    SUPABASE_URL: mockBaseUrl,
    SUPABASE_ANON_KEY: contractApiKey,
    SUPABASE_SECRET_KEY: contractApiKey,
    SUPABASE_ENABLED: "true",
    SUPABASE_AUTH_REQUEST_TIMEOUT_MS: "300",
    PUBLIC_APP_URL: appBaseUrl,
    SOCIAL_CUES_DATA_DIR: dataDir,
    SOCIAL_CUES_PROMO_CODES: "[]",
    SENTRY_DSN: "",
    OPENAI_API_KEY: "",
    STRIPE_SECRET_KEY: "",
    RESEND_API_KEY: "",
    SMTP_PASS: "",
    AUTOMATIC_PUBLISHING_ENABLED: "false",
    ...env
  });
  if (authProvider === null) childEnv.AUTH_PROVIDER = "";
  if (hosted) childEnv.VERCEL = "1";
  else delete childEnv.VERCEL;
  const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true
  });
  let childOutput = "";
  child.stdout.on("data", chunk => { childOutput = (childOutput + chunk).slice(-30_000); });
  child.stderr.on("data", chunk => { childOutput = (childOutput + chunk).slice(-30_000); });
  try {
    await waitForHealth(appBaseUrl, child, () => childOutput);
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
  return { child, appBaseUrl, dataDir, secrets: [sessionSecret, encryptionSecret], output: () => childOutput };
}

function persistedModel(state) {
  return tableRows(state, "app_state").find(row => row.id === "primary")?.model || null;
}

function persistedUserByEmail(state, email) {
  return (persistedModel(state)?.authUsers || []).find(user => String(user.email || "").toLowerCase() === String(email || "").toLowerCase()) || null;
}

function persistedDeviceCount(state) {
  return tableRows(state, "device_sessions").length;
}

function normalizedTenantRowCount(state) {
  return ["profiles", "workspaces", "workspace_members", "billing_entitlements", "device_sessions", "workspace_models"]
    .reduce((total, table) => total + tableRows(state, table).length, 0);
}

async function run() {
  const runId = crypto.randomBytes(8).toString("hex");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "social-cues-auth-verification-"));
  const localDataDir = path.join(tempDir, "local-password-fixture");
  const localEmail = `legacy-local-${runId}@example.test`;
  const localPassword = `Local!${crypto.randomBytes(12).toString("base64url")}`;
  const localPromo = `SC-LOCAL-${runId.toUpperCase()}`;
  const firstEmail = `verified-${runId}@example.test`;
  const secondEmail = `unconfirmed-${runId}@example.test`;
  const thirdEmail = `confirmed-signup-${runId}@example.test`;
  const firstPassword = `Verified!${crypto.randomBytes(12).toString("base64url")}`;
  const secondPassword = `Unconfirmed!${crypto.randomBytes(12).toString("base64url")}`;
  const thirdPassword = `Confirmed!${crypto.randomBytes(12).toString("base64url")}`;
  const configurationPassword = `Configuration!${crypto.randomBytes(12).toString("base64url")}`;
  const malformedLoginPassword = `MalformedLogin!${crypto.randomBytes(12).toString("base64url")}`;
  const malformedSignupPassword = `MalformedSignup!${crypto.randomBytes(12).toString("base64url")}`;
  const firstPromo = `SC-CONTRACT-A-${runId.toUpperCase()}`;
  const secondPromo = `SC-CONTRACT-B-${runId.toUpperCase()}`;
  const thirdPromo = `SC-CONTRACT-C-${runId.toUpperCase()}`;
  const unavailableMessage = "Authentication service is temporarily unavailable.";
  const mock = createMockSupabase();
  const childOutputs = [];
  const publicArtifacts = [];
  const sensitiveValues = new Set([
    contractApiKey,
    localPassword,
    firstPassword,
    secondPassword,
    thirdPassword,
    configurationPassword,
    malformedLoginPassword,
    malformedSignupPassword
  ]);
  let checkCount = 0;
  let allChildrenClosed = true;
  let cleanupComplete = false;
  let result = null;
  let failure = null;

  const check = (condition, message) => {
    checkCount += 1;
    ensure(condition, message);
  };

  const request = async (app, pathname, options = {}) => {
    const response = await appRequest(app.appBaseUrl, pathname, options);
    publicArtifacts.push(JSON.stringify({ status: response.status, body: response.body }));
    return response;
  };

  const assertUnavailable = (response, label) => {
    check(response.status === 503, `${label} must fail with status 503.`);
    check(response.body?.ok === false && response.body?.error === unavailableMessage, `${label} must use the sanitized service-unavailable contract.`);
    check(!response.setCookie, `${label} must not issue an application session cookie.`);
    check(!/supabase|environment|configuration|token|secret|stack|key/i.test(String(response.body?.error || "")), `${label} must not expose provider or configuration details.`);
  };

  const assertInvalidCredentials = (response, label) => {
    check(response.status === 401 && response.body?.ok === false, `${label} must return the sanitized 401 contract.`);
    check(response.body?.error === "Email or password did not match a verified Social Cues account.", `${label} must not reveal account or provider state.`);
    check(!response.setCookie, `${label} must not issue an application session cookie.`);
  };

  const withApp = async (options, callback) => {
    let app = null;
    try {
      app = await startAppInstance(options);
      for (const secret of app.secrets || []) sensitiveValues.add(secret);
      return await callback(app);
    } finally {
      if (app) {
        const closed = await terminateChild(app.child);
        childOutputs.push(app.output());
        allChildrenClosed = allChildrenClosed && closed;
        check(closed, `${options.name} must terminate its child server within the bounded cleanup window.`);
      }
    }
  };

  const clone = value => JSON.parse(JSON.stringify(value));
  const authMutationSnapshot = () => {
    const model = persistedModel(mock.state) || {};
    return JSON.stringify({
      authUsers: model.authUsers || [],
      authPromoClaims: model.authPromoClaims || [],
      deviceSessions: model.deviceSessions || [],
      normalized: ["profiles", "workspaces", "workspace_members", "billing_entitlements", "device_sessions", "workspace_models"]
        .map(table => [table, tableRows(mock.state, table)])
    });
  };

  const hostedPromoCodes = JSON.stringify([
    { code: firstPromo, label: "Hosted auth contract A", access: "highest-tier-test", days: 30, active: true },
    { code: secondPromo, label: "Hosted auth contract B", access: "highest-tier-test", days: 30, active: true },
    { code: thirdPromo, label: "Hosted auth contract C", access: "highest-tier-test", days: 30, active: true }
  ]);

  try {
    const mockBaseUrl = await listen(mock.server);
    const localPromoCodes = JSON.stringify([
      { code: localPromo, label: "Explicit local auth fixture", access: "highest-tier-test", days: 30, active: true }
    ]);

    await withApp({
      tempDir,
      name: "explicit-local-provider",
      hosted: false,
      authProvider: "alpha-local",
      env: {
        SOCIAL_CUES_DATA_DIR: localDataDir,
        SOCIAL_CUES_PROMO_CODES: localPromoCodes,
        SUPABASE_URL: "",
        SUPABASE_ANON_KEY: "",
        SUPABASE_SECRET_KEY: "",
        SUPABASE_ENABLED: "false"
      }
    }, async app => {
      const signup = await request(app, "/api/auth/signup", {
        method: "POST",
        body: {
          email: localEmail,
          password: localPassword,
          name: "Explicit local auth fixture",
          promoCode: localPromo,
          device: { deviceId: `local-signup-${runId}`, deviceName: "Local contract browser" }
        }
      });
      check(signup.status === 200 && signup.body?.ok === true, "Explicit alpha-local signup must remain available in local runtime.");
      const login = await request(app, "/api/auth/login", {
        method: "POST",
        body: {
          email: localEmail,
          password: localPassword,
          device: { deviceId: `local-login-${runId}`, deviceName: "Local login browser" }
        }
      });
      check(login.status === 200 && login.body?.ok === true, "Explicit alpha-local login must verify the local password in local runtime.");
    });

    const localModelPath = path.join(localDataDir, "model.json");
    const localModelRaw = await readFile(localModelPath, "utf8");
    const localDocument = JSON.parse(localModelRaw.replace(/^\uFEFF/, ""));
    const localModel = localDocument.format === "social-cues.local-workspace-content.v1" ? localDocument.shared : localDocument;
    const localUser = (localModel.authUsers || []).find(user => String(user.email || "").toLowerCase() === localEmail);
    check(Boolean(localUser?.passwordHash), "The synthetic local fixture must contain a real legacy password hash.");
    sensitiveValues.add(localUser.passwordHash);

    const configurationCases = [
      {
        name: "hosted-missing-url",
        authProvider: "supabase",
        env: { SUPABASE_URL: "" }
      },
      {
        name: "hosted-missing-key",
        authProvider: "supabase",
        env: { SUPABASE_ANON_KEY: "", SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_SECRET_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" }
      },
      {
        name: "hosted-partial-configuration",
        authProvider: "supabase",
        env: { SUPABASE_ANON_KEY: contractApiKey, SUPABASE_SECRET_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" }
      },
      {
        name: "hosted-disabled-supabase",
        authProvider: "supabase",
        env: { SUPABASE_ENABLED: "false" }
      },
      {
        name: "hosted-missing-session-signing",
        authProvider: "supabase",
        env: { AUTH_SESSION_SECRET: "", OAUTH_TOKEN_ENCRYPTION_KEY: "" }
      },
      {
        name: "hosted-wrong-provider",
        authProvider: "unsupported-provider",
        env: {}
      },
      {
        name: "hosted-explicit-local-provider",
        authProvider: "alpha-local",
        env: {}
      }
    ];

    for (const configuration of configurationCases) {
      const requestCountBefore = mock.state.requests.length;
      await withApp({
        tempDir,
        name: configuration.name,
        mockBaseUrl,
        hosted: true,
        authProvider: configuration.authProvider,
        env: {
          SOCIAL_CUES_DATA_DIR: localDataDir,
          SOCIAL_CUES_PROMO_CODES: localPromoCodes,
          ...configuration.env
        }
      }, async app => {
        const login = await request(app, "/api/auth/login", {
          method: "POST",
          body: {
            email: localEmail,
            password: localPassword,
            device: { deviceId: `${configuration.name}-login`, deviceName: "Hosted fallback probe" }
          }
        });
        assertUnavailable(login, `${configuration.name} login`);

        const signup = await request(app, "/api/auth/signup", {
          method: "POST",
          body: {
            email: `${configuration.name}-${runId}@example.test`,
            password: configurationPassword,
            name: "Hosted readiness probe",
            promoCode: localPromo,
            device: { deviceId: `${configuration.name}-signup`, deviceName: "Hosted signup probe" }
          }
        });
        assertUnavailable(signup, `${configuration.name} signup`);
      });
      check(mock.state.requests.length === requestCountBefore, `${configuration.name} must not contact Supabase before readiness succeeds.`);
      check(await readFile(localModelPath, "utf8") === localModelRaw, `${configuration.name} must not read-modify-write the local account model.`);
    }

    const localSupabaseRequestCount = mock.state.requests.length;
    await withApp({
      tempDir,
      name: "local-supabase-incomplete",
      mockBaseUrl,
      hosted: false,
      authProvider: "supabase",
      env: {
        SOCIAL_CUES_DATA_DIR: localDataDir,
        SUPABASE_URL: "",
        SUPABASE_ANON_KEY: "",
        SUPABASE_SECRET_KEY: ""
      }
    }, async app => {
      const login = await request(app, "/api/auth/login", {
        method: "POST",
        body: { email: localEmail, password: localPassword, device: { deviceId: `local-supabase-${runId}` } }
      });
      assertUnavailable(login, "Local runtime with incomplete Supabase configuration");
    });
    check(mock.state.requests.length === localSupabaseRequestCount, "Incomplete local Supabase mode must not contact the provider or switch to local passwords.");
    check(await readFile(localModelPath, "utf8") === localModelRaw, "All fail-closed configuration probes must preserve the seeded local hash and account exactly.");

    await withApp({
      tempDir,
      name: "local-provider-not-selected",
      hosted: false,
      authProvider: null,
      env: {
        SOCIAL_CUES_DATA_DIR: localDataDir,
        SUPABASE_URL: "",
        SUPABASE_ANON_KEY: "",
        SUPABASE_SECRET_KEY: ""
      }
    }, async app => {
      const login = await request(app, "/api/auth/login", {
        method: "POST",
        body: { email: localEmail, password: localPassword, device: { deviceId: `local-no-provider-${runId}` } }
      });
      assertUnavailable(login, "Local runtime without an explicitly selected provider");
    });
    check(await readFile(localModelPath, "utf8") === localModelRaw, "Absent local provider selection must not infer local-password authentication from missing Supabase configuration.");

    mock.state.tables.set("app_state", [{
      id: "primary",
      model: clone(localModel),
      updated_at: new Date().toISOString()
    }]);

    await withApp({
      tempDir,
      name: "hosted-provider-contract",
      mockBaseUrl,
      hosted: true,
      authProvider: "supabase",
      env: { SOCIAL_CUES_PROMO_CODES: hostedPromoCodes }
    }, async app => {
      const localBeforeInvalid = clone(persistedUserByEmail(mock.state, localEmail));
      const invalidProviderCredentials = await request(app, "/api/auth/login", {
        method: "POST",
        body: {
          email: localEmail,
          password: localPassword,
          device: { deviceId: `provider-invalid-${runId}`, deviceName: "Provider invalid probe" }
        }
      });
      assertInvalidCredentials(invalidProviderCredentials, "Provider-invalid credentials with a matching local password");
      const localAfterInvalid = persistedUserByEmail(mock.state, localEmail);
      check(localAfterInvalid?.passwordHash === localBeforeInvalid?.passwordHash, "Invalid provider credentials must not verify or replace the seeded local hash.");
      check(localAfterInvalid?.lastLoginAt === localBeforeInvalid?.lastLoginAt, "Invalid provider credentials must not authenticate the seeded local account.");
      check(persistedDeviceCount(mock.state) === 0 && normalizedTenantRowCount(mock.state) === 0, "Invalid provider credentials must create no hosted device or tenant records.");

      const privateProviderBody = "Synthetic provider failure body must stay private.";
      sensitiveValues.add(privateProviderBody);
      const malformedLoginProviderBody = `{"private":"${runId}"`;
      const malformedSignupProviderBody = `{"private":"signup-${runId}"`;
      sensitiveValues.add(malformedLoginProviderBody);
      sensitiveValues.add(malformedSignupProviderBody);
      const providerFailureCases = [
        { label: "Provider network failure", behavior: { mode: "disconnect" } },
        { label: "Provider timeout", behavior: { mode: "timeout", delayMs: 1_000 } },
        { label: "Provider malformed JSON", behavior: { mode: "raw", body: malformedLoginProviderBody } },
        { label: "Provider HTTP service failure", behavior: { mode: "http-error", status: 503 } }
      ];

      for (const providerFailure of providerFailureCases) {
        const before = authMutationSnapshot();
        mock.state.loginBehavior = providerFailure.behavior;
        const response = await request(app, "/api/auth/login", {
          method: "POST",
          body: {
            email: localEmail,
            password: localPassword,
            device: { deviceId: `${providerFailure.label.replace(/\s+/g, "-").toLowerCase()}-${runId}` }
          }
        });
        assertUnavailable(response, providerFailure.label);
        check(authMutationSnapshot() === before, `${providerFailure.label} must not mutate identity, session, promo, or tenant state.`);
      }
      const beforeRateLimit = authMutationSnapshot();
      mock.state.loginBehavior = { mode: "http-error", status: 429 };
      const providerRateLimit = await request(app, "/api/auth/login", {
        method: "POST",
        body: { email: localEmail, password: localPassword, device: { deviceId: `provider-rate-limit-${runId}` } }
      });
      check(providerRateLimit.status === 429 && providerRateLimit.body?.error === "Too many authentication attempts. Wait and try again.", "Provider rate limiting must retain a sanitized 429 contract.");
      check(!providerRateLimit.setCookie && authMutationSnapshot() === beforeRateLimit, "Provider rate limiting must not fall back locally or mutate auth state.");
      mock.state.loginBehavior = { mode: "normal" };

      const providerUser = (email, overrides = {}) => ({
        id: crypto.randomUUID(),
        email,
        email_confirmed_at: new Date().toISOString(),
        confirmed_at: new Date().toISOString(),
        ...overrides
      });
      const providerToken = label => {
        const token = `contract-${label}-${crypto.randomBytes(18).toString("base64url")}`;
        sensitiveValues.add(token);
        return token;
      };

      const malformedLoginCases = [
        { label: "Login success without user", body: email => ({ access_token: providerToken("missing-user"), email }) },
        { label: "Login success without user id", body: email => ({ access_token: providerToken("missing-id"), user: { email } }) },
        { label: "Login success with blank user id", body: email => ({ access_token: providerToken("blank-id"), user: providerUser(email, { id: "   " }) }) },
        { label: "Login success with malformed UUID", body: email => ({ access_token: providerToken("malformed-id"), user: providerUser(email, { id: "not-a-uuid" }) }) },
        { label: "Login success with malformed user email", body: () => ({ access_token: providerToken("malformed-email"), user: providerUser("not-an-email") }) },
        { label: "Login session for unconfirmed user", body: email => ({ access_token: providerToken("unconfirmed-user"), user: providerUser(email, { email_confirmed_at: null, confirmed_at: null }) }) },
        { label: "Login success without provider session", body: email => ({ user: providerUser(email) }) },
        { label: "Login success without access token", body: email => ({ session: {}, user: providerUser(email) }) },
        { label: "Login success with blank access token", body: email => ({ access_token: "   ", user: providerUser(email) }) },
        { label: "Provider session plus missing user", body: () => ({ access_token: providerToken("session-no-user"), refresh_token: providerToken("refresh-no-user") }) },
        { label: "Array provider success", body: () => [] },
        { label: "Primitive provider success", body: () => "provider-success-primitive" },
        { label: "Unexpected provider success shape", body: email => ({ data: { user: providerUser(email) }, session: { access_token: providerToken("nested-session") } }) },
        { label: "Mismatched provider email", body: email => ({ access_token: providerToken("wrong-email"), user: providerUser(`different-${email}`) }) }
      ];

      for (const [index, malformed] of malformedLoginCases.entries()) {
        const email = `malformed-login-${index}-${runId}@example.test`;
        const before = authMutationSnapshot();
        mock.state.loginBehavior = { mode: "response", status: 200, body: malformed.body(email) };
        const response = await request(app, "/api/auth/login", {
          method: "POST",
          body: {
            email,
            password: malformedLoginPassword,
            device: { deviceId: `malformed-login-${index}-${runId}` }
          }
        });
        assertUnavailable(response, malformed.label);
        check(authMutationSnapshot() === before, `${malformed.label} must create no application user, session, promo claim, or tenant bootstrap.`);
        check(!persistedUserByEmail(mock.state, email), `${malformed.label} must not synthesize an application identity.`);
      }
      mock.state.loginBehavior = { mode: "normal" };

      const malformedSignupCases = [
        { label: "Signup success without user", behavior: () => ({ mode: "response", status: 200, body: {} }) },
        { label: "Signup success without user id", behavior: email => ({ mode: "response", status: 200, body: { user: { email } } }) },
        { label: "Signup success with malformed UUID", behavior: email => ({ mode: "response", status: 200, body: { user: providerUser(email, { id: "not-a-uuid" }) } }) },
        { label: "Signup success without user email", behavior: () => ({ mode: "response", status: 200, body: { user: { id: crypto.randomUUID() } } }) },
        { label: "Signup session without identity", behavior: () => ({ mode: "response", status: 200, body: { access_token: providerToken("signup-no-user") } }) },
        { label: "Signup token with top-level identity", behavior: email => ({ mode: "response", status: 200, body: { ...providerUser(email), access_token: providerToken("signup-top-level") } }) },
        { label: "Signup nested session with identity", behavior: email => ({ mode: "response", status: 200, body: { user: providerUser(email), session: { access_token: providerToken("signup-nested") } } }) },
        { label: "Signup blank access token", behavior: email => ({ mode: "response", status: 200, body: { user: providerUser(email), access_token: "" } }) },
        { label: "Signup non-string access token", behavior: email => ({ mode: "response", status: 200, body: { user: providerUser(email), access_token: { private: true } } }) },
        { label: "Signup array success", behavior: () => ({ mode: "response", status: 200, body: [] }) },
        { label: "Signup primitive success", behavior: () => ({ mode: "response", status: 200, body: "signup-primitive" }) },
        { label: "Signup malformed JSON", behavior: () => ({ mode: "raw", status: 200, body: malformedSignupProviderBody }) }
      ];

      for (const [index, malformed] of malformedSignupCases.entries()) {
        const email = `malformed-signup-${index}-${runId}@example.test`;
        const before = authMutationSnapshot();
        mock.state.signupBehavior = malformed.behavior(email);
        const response = await request(app, "/api/auth/signup", {
          method: "POST",
          body: {
            email,
            password: malformedSignupPassword,
            name: "Malformed signup probe",
            promoCode: firstPromo,
            device: { deviceId: `malformed-signup-${index}-${runId}` }
          }
        });
        assertUnavailable(response, malformed.label);
        check(authMutationSnapshot() === before, `${malformed.label} must create no application user, local hash, session, promo claim, or tenant bootstrap.`);
        check(!persistedUserByEmail(mock.state, email), `${malformed.label} must not generate a substitute application identity.`);
      }
      mock.state.signupBehavior = { mode: "unconfirmed" };

      const firstDeviceId = `contract-device-a-${runId}`;
      const pendingSignup = await request(app, "/api/auth/signup", {
        method: "POST",
        body: {
          email: firstEmail,
          password: firstPassword,
          name: "Verification contract tester",
          promoCode: firstPromo,
          device: { deviceId: firstDeviceId, deviceName: "Contract browser" }
        }
      });
      check(pendingSignup.status === 202, `Unconfirmed signup must return status 202; received ${pendingSignup.status}.`);
      check(pendingSignup.body?.requiresEmailVerification === true, "Unconfirmed signup must require email verification.");
      check(/check.+email|verify.+email/i.test(String(pendingSignup.body?.error || "")), "Unconfirmed signup must provide an actionable verification message.");
      check(!pendingSignup.setCookie, "Unconfirmed signup must not issue an authenticated cookie.");
      const firstUser = mock.state.authUsers.get(firstEmail);
      check(Boolean(firstUser), "Unconfirmed signup must reach only the loopback Supabase Auth mock.");
      check(!persistedUserByEmail(mock.state, firstEmail), "Unconfirmed signup must not create an authenticated application user or local hash.");
      check(persistedDeviceCount(mock.state) === 0, "Unconfirmed signup must not create a normalized device session.");
      ensureEmptyTenant(tenantCounts(mock.state, firstUser.id), "Unconfirmed signup");

      const anonymousSession = await request(app, "/api/auth/session");
      check(anonymousSession.status === 401 && anonymousSession.body?.ok === false, "Unconfirmed signup must leave the application session unauthenticated.");

      mock.confirm(firstEmail);
      const confirmedLogin = await request(app, "/api/auth/login", {
        method: "POST",
        body: {
          email: firstEmail,
          password: firstPassword,
          device: { deviceId: firstDeviceId, deviceName: "Contract browser", platform: "contract" }
        }
      });
      check(confirmedLogin.status === 200 && confirmedLogin.body?.ok === true, "Confirmed provider login must authenticate successfully.");
      check(/^sc_session=/.test(confirmedLogin.setCookie), "Confirmed provider login must issue the application session cookie.");
      check(/;\s*HttpOnly/i.test(confirmedLogin.setCookie) && /;\s*Secure/i.test(confirmedLogin.setCookie), "Hosted session cookies must retain HttpOnly and Secure protection.");
      check(confirmedLogin.body?.session && !("token" in confirmedLogin.body.session), "Hosted session JSON must not expose the provider access token.");
      check(!JSON.stringify(confirmedLogin.body).includes(firstUser.accessToken), "The valid provider access token must stay out of the response body.");
      check(confirmedLogin.body?.user?.id === firstUser.id, "Confirmed login must preserve the exact verified Supabase user id.");
      check(confirmedLogin.body?.workspace?.id === firstUser.id, "Confirmed login must derive the tenant workspace from the verified identity.");
      check(confirmedLogin.body?.workspace?.id !== firstUser.forgedWorkspaceId, "Provider metadata must not select the tenant workspace.");
      check(confirmedLogin.body?.user?.role === "Alpha tester", "Provider metadata must not grant owner application authorization.");
      check(confirmedLogin.body?.entitlement?.promoCode === firstPromo, "Entitlement must come from the server-side promo ledger.");
      const persistedFirstUser = persistedUserByEmail(mock.state, firstEmail);
      check(persistedFirstUser?.id === firstUser.id && persistedFirstUser?.supabaseUserId === firstUser.id, "Provider persistence must retain the validated UUID exactly.");
      check(!persistedFirstUser?.passwordHash, "Provider persistence must never create or retain a local password hash.");
      ensureSingleTenant(tenantCounts(mock.state, firstUser.id), "First confirmed login");

      sensitiveValues.add(firstUser.accessToken);
      sensitiveValues.add(firstUser.refreshToken);
      const persistedAuthState = JSON.stringify({
        appState: tableRows(mock.state, "app_state"),
        profiles: tableRows(mock.state, "profiles"),
        workspaces: tableRows(mock.state, "workspaces"),
        memberships: tableRows(mock.state, "workspace_members"),
        entitlements: tableRows(mock.state, "billing_entitlements"),
        devices: tableRows(mock.state, "device_sessions"),
        bootstraps: tableRows(mock.state, "workspace_models")
      });
      check(!persistedAuthState.includes(firstUser.accessToken) && !persistedAuthState.includes(firstUser.refreshToken), "Raw provider access and refresh tokens must not enter application persistence.");
      const profile = rowsForUser(mock.state, "profiles", firstUser.id)[0];
      const membership = rowsForUser(mock.state, "workspace_members", firstUser.id)[0];
      const entitlement = rowsForUser(mock.state, "billing_entitlements", firstUser.id)[0];
      check(profile?.workspace_id === firstUser.id && profile?.role === "Alpha tester", "The profile must remain tenant-scoped and metadata-independent.");
      check(membership?.workspace_id === firstUser.id && membership?.role === "owner", "The verified tenant must receive one owner membership.");
      check(entitlement?.workspace_id === firstUser.id && entitlement?.source === "promo-code" && entitlement?.promo_code === firstPromo && entitlement?.status === "active", "The durable entitlement must use the validated promo claim.");

      const cookie = sessionCookie(confirmedLogin.setCookie);
      const authenticatedSession = await request(app, "/api/auth/session", { cookie });
      check(authenticatedSession.status === 200 && authenticatedSession.body?.ok === true, "The confirmed device cookie must restore the application session.");
      check(authenticatedSession.body?.user?.id === firstUser.id && authenticatedSession.body?.workspace?.id === firstUser.id, "Restored sessions must stay inside the verified tenant.");
      check(authenticatedSession.body?.devices?.length === 1, "The restored tenant session must expose exactly one remembered device.");

      const repeatedLogin = await request(app, "/api/auth/login", {
        method: "POST",
        body: {
          email: firstEmail,
          password: firstPassword,
          device: { deviceId: firstDeviceId, deviceName: "Contract browser", platform: "contract" }
        }
      });
      check(repeatedLogin.status === 200 && repeatedLogin.body?.ok === true, "Repeated confirmed login must remain successful.");
      ensureSingleTenant(tenantCounts(mock.state, firstUser.id), "Repeated confirmed login");

      const secondDeviceId = `contract-device-b-${runId}`;
      const secondSignup = await request(app, "/api/auth/signup", {
        method: "POST",
        body: {
          email: secondEmail,
          password: secondPassword,
          name: "Unconfirmed contract tester",
          promoCode: secondPromo,
          device: { deviceId: secondDeviceId, deviceName: "Unconfirmed contract browser" }
        }
      });
      check(secondSignup.status === 202 && secondSignup.body?.requiresEmailVerification === true, "The unconfirmed-login fixture must begin with verification required.");
      const secondUser = mock.state.authUsers.get(secondEmail);
      check(Boolean(secondUser), "The second unconfirmed identity must exist only inside the Auth mock.");
      check(!persistedUserByEmail(mock.state, secondEmail), "The second unconfirmed identity must not enter the application registry.");
      ensureEmptyTenant(tenantCounts(mock.state, secondUser.id), "Second unconfirmed signup");

      const failedLogin = await request(app, "/api/auth/login", {
        method: "POST",
        body: {
          email: secondEmail,
          password: secondPassword,
          device: { deviceId: secondDeviceId, deviceName: "Unconfirmed contract browser" }
        }
      });
      assertInvalidCredentials(failedLogin, "Unconfirmed provider login");
      ensureEmptyTenant(tenantCounts(mock.state, secondUser.id), "Unconfirmed login");

      mock.state.signupBehavior = { mode: "confirmed" };
      const thirdDeviceId = `contract-device-c-${runId}`;
      const confirmedSignup = await request(app, "/api/auth/signup", {
        method: "POST",
        body: {
          email: thirdEmail,
          password: thirdPassword,
          name: "Immediate confirmed signup",
          promoCode: thirdPromo,
          device: { deviceId: thirdDeviceId, deviceName: "Confirmed signup browser" }
        }
      });
      check(confirmedSignup.status === 200 && confirmedSignup.body?.ok === true, "Immediately authenticated provider signup must succeed.");
      check(/^sc_session=/.test(confirmedSignup.setCookie) && /;\s*HttpOnly/i.test(confirmedSignup.setCookie), "Confirmed signup must issue only the protected application cookie.");
      const thirdUser = mock.state.authUsers.get(thirdEmail);
      check(confirmedSignup.body?.user?.id === thirdUser?.id, "Confirmed signup must preserve the exact provider identity.");
      const persistedThirdUser = persistedUserByEmail(mock.state, thirdEmail);
      check(persistedThirdUser?.id === thirdUser?.id && !persistedThirdUser?.passwordHash, "Confirmed signup must persist no local password hash or substitute id.");
      ensureSingleTenant(tenantCounts(mock.state, thirdUser.id), "Immediately confirmed signup");
      sensitiveValues.add(thirdUser.accessToken);
      sensitiveValues.add(thirdUser.refreshToken);
      mock.state.signupBehavior = { mode: "unconfirmed" };

      const wrongPassword = await request(app, "/api/auth/login", {
        method: "POST",
        body: { email: firstEmail, password: `${firstPassword}-wrong`, device: { deviceId: `wrong-password-${runId}` } }
      });
      assertInvalidCredentials(wrongPassword, "Invalid provider password");

      mock.state.loginBehavior = { mode: "http-error", status: 503 };
      const serviceFailure = await request(app, "/api/auth/login", {
        method: "POST",
        body: { email: firstEmail, password: firstPassword, device: { deviceId: `service-failure-${runId}` } }
      });
      assertUnavailable(serviceFailure, "Provider service HTTP failure");
      mock.state.loginBehavior = { mode: "normal" };

      const finalAnonymousSession = await request(app, "/api/auth/session");
      check(finalAnonymousSession.status === 401, "Unconfirmed and malformed identities must not create an ambient application session.");
    });

    check(tableRows(mock.state, "app_state").length === 1, "The shared application registry must remain idempotent.");
    check(mock.state.failures.length === 0, `The Supabase mock must cover every requested endpoint (${mock.state.failures.join("; ")}).`);
    check(mock.state.requests.length > 0, "The valid hosted flow must exercise the loopback Supabase contract.");
    check(mock.state.requests.every(requestItem => requestItem.pathname.startsWith("/auth/v1/") || requestItem.pathname.startsWith("/rest/v1/")), "Every Supabase request must stay on the loopback mock surface.");

    for (const user of mock.state.authUsers.values()) {
      if (user.accessToken) sensitiveValues.add(user.accessToken);
      if (user.refreshToken) sensitiveValues.add(user.refreshToken);
    }
    const observableText = `${childOutputs.join("\n")}\n${publicArtifacts.join("\n")}`;
    for (const sensitiveValue of sensitiveValues) {
      if (!sensitiveValue) continue;
      check(!observableText.includes(String(sensitiveValue)), "Passwords, hashes, tokens, and private provider bodies must be absent from logs and public response bodies.");
    }
    check(!/Invalid login credentials|Email not confirmed|Synthetic provider failure body/i.test(observableText), "Provider response bodies must not appear in ordinary logs or public errors.");
    check(!/https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(mock.state.requests.map(item => item.pathname).join("\n")), "The contract must record no production or external provider request.");

    result = {
      ok: true,
      checks: checkCount,
      hermetic: true,
      productionContacted: false,
      tenantRecords: tenantCounts(mock.state, mock.state.authUsers.get(firstEmail)?.id)
    };
  } catch (error) {
    failure = error;
  } finally {
    await closeServer(mock.server);
    await rm(tempDir, { recursive: true, force: true });
    cleanupComplete = allChildrenClosed && !mock.server.listening && !existsSync(tempDir);
    if (!cleanupComplete && !failure) {
      failure = new Error("The authentication contract did not verify complete child, mock-server, and temporary-data cleanup.");
    }
  }

  if (failure) throw failure;
  console.log(JSON.stringify({ ...result, cleanupComplete }));
}

await run();
