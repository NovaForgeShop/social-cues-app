import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

export const DOCKER_CONTEXT = "desktop-linux";
export const LOCAL_DOCKER_HOST = "npipe:////./pipe/dockerDesktopLinuxEngine";
export const POSTGRES_RUNTIME_IMAGE = "postgres:15-alpine";
export const POSTGRES_POSTGREST_IMAGE = "postgres:17-alpine";
export const POSTGREST_IMAGE = "postgrest/postgrest:v14.12";

const REMOTE_DATABASE_ENV = /^(?:DATABASE_URL|DIRECT_URL|POSTGRES_URL|POSTGRES_URL_NON_POOLING|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|SUPABASE_URL|SUPABASE_DB_URL|SUPABASE_PROJECT_ID|SUPABASE_PROJECT_REF|SUPABASE_ACCESS_TOKEN)$/iu;

export function hermeticChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (REMOTE_DATABASE_ENV.test(name)) delete env[name];
  }
  return { ...env, ...overrides };
}

export function createHarnessState(label) {
  const suffix = `${process.pid}-${randomBytes(5).toString("hex")}`;
  const prefix = `social-cues-stripe-b0-${label}-${suffix}`.toLowerCase();
  return {
    label,
    prefix,
    postgresContainer: `${prefix}-db`,
    postgrestContainer: `${prefix}-api`,
    network: `${prefix}-net`,
    tempDirectory: null,
    port: null,
    postgresPassword: randomBytes(24).toString("base64url"),
    jwtSecret: randomBytes(32).toString("base64url"),
    redactions: new Set(),
    captured: [],
    activeChildren: new Set(),
    created: { postgres: false, postgrest: false, network: false },
    cleanupComplete: false,
    imagePulls: []
  };
}

export function registerSecret(state, value) {
  const secret = String(value || "");
  if (secret.length >= 6) state.redactions.add(secret);
  return value;
}

export function redact(state, value) {
  let result = String(value ?? "");
  for (const secret of state.redactions) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export function assertSecretsAbsent(state, value, context) {
  const text = String(value ?? "");
  for (const secret of state.redactions) {
    assert.equal(text.includes(secret), false, `${context} exposed synthetic sensitive material`);
  }
}

export async function runProcess(state, command, args, {
  input = null,
  allowFailure = false,
  timeoutMs = 30_000,
  env = hermeticChildEnv()
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    state.activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", error => {
      clearTimeout(timer);
      state.activeChildren.delete(child);
      reject(new Error(redact(state, error.message)));
    });
    child.on("close", code => {
      clearTimeout(timer);
      state.activeChildren.delete(child);
      const result = { code: code ?? 1, stdout, stderr, timedOut };
      state.captured.push(stdout, stderr);
      try {
        assertSecretsAbsent(state, stdout, `${command} stdout`);
        assertSecretsAbsent(state, stderr, `${command} stderr`);
      } catch (error) {
        reject(error);
        return;
      }
      if ((timedOut || result.code !== 0) && !allowFailure) {
        reject(new Error(redact(state, `${command} failed${timedOut ? " (timeout)" : ""}: ${stderr || stdout}`)));
        return;
      }
      resolve(result);
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function docker(state, args, options = {}) {
  return runProcess(state, "docker", ["--context", DOCKER_CONTEXT, ...args], options);
}

export async function assertLocalDockerContext(state) {
  const result = await runProcess(state, "docker", [
    "context", "inspect", DOCKER_CONTEXT, "--format", "{{json .Endpoints.docker.Host}}"
  ]);
  const host = JSON.parse(result.stdout.trim());
  assert.equal(host, LOCAL_DOCKER_HOST, "desktop-linux must resolve to the local Docker Desktop named pipe");
  return host;
}

export async function ensureImage(state, image) {
  const present = await docker(state, ["image", "inspect", image], { allowFailure: true, timeoutMs: 20_000 });
  if (present.code === 0) return false;
  await docker(state, ["pull", image], { timeoutMs: 240_000 });
  state.imagePulls.push(image);
  return true;
}

export async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

export async function prepareState(state) {
  state.tempDirectory = await mkdtemp(path.join(tmpdir(), `${state.prefix}-`));
  registerSecret(state, state.postgresPassword);
  registerSecret(state, state.jwtSecret);
  await assertLocalDockerContext(state);
}

export async function startPostgres(state, {
  image = POSTGRES_RUNTIME_IMAGE,
  networked = false
} = {}) {
  await ensureImage(state, image);
  const args = [
    "create",
    "--name", state.postgresContainer,
    "--label", "social-cues.test=stripe-b0",
    "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=256m",
    "-e", `POSTGRES_PASSWORD=${state.postgresPassword}`,
    "-e", "POSTGRES_DB=postgres",
    "--health-cmd", "pg_isready -U postgres -d postgres",
    "--health-interval", "1s",
    "--health-timeout", "2s",
    "--health-retries", "60"
  ];
  if (networked) args.push("--network", state.network, "--network-alias", "postgres");
  else args.push("--network", "none");
  args.push(
    image,
    "-c", "log_statement=none",
    "-c", "log_min_messages=panic",
    "-c", "log_min_error_statement=panic",
    "-c", "log_parameter_max_length=0",
    "-c", "log_parameter_max_length_on_error=0"
  );
  await docker(state, args, { timeoutMs: 60_000 });
  state.created.postgres = true;
  await docker(state, ["start", state.postgresContainer], { timeoutMs: 60_000 });
  await waitForPostgres(state);
}

export async function waitForPostgres(state) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await docker(state, [
      "exec", state.postgresContainer, "pg_isready", "-U", "postgres", "-d", "postgres"
    ], { allowFailure: true, timeoutMs: 5_000 });
    if (result.code === 0) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("local PostgreSQL did not become ready");
}

export async function createNetwork(state) {
  await docker(state, [
    "network", "create", "--label", "social-cues.test=stripe-b0",
    state.network
  ]);
  state.created.network = true;
}

export async function startPostgrest(state) {
  await ensureImage(state, POSTGREST_IMAGE);
  state.port = await freeLoopbackPort();
  await docker(state, [
    "create",
    "--name", state.postgrestContainer,
    "--label", "social-cues.test=stripe-b0",
    "--network", state.network,
    "-p", `127.0.0.1:${state.port}:3000`,
    "-e", `PGRST_DB_URI=postgres://authenticator:${state.postgresPassword}@postgres:5432/postgres`,
    "-e", "PGRST_DB_SCHEMAS=public",
    "-e", "PGRST_DB_ANON_ROLE=anon",
    "-e", `PGRST_JWT_SECRET=${state.jwtSecret}`,
    "-e", "PGRST_LOG_LEVEL=warn",
    POSTGREST_IMAGE
  ], { timeoutMs: 60_000 });
  state.created.postgrest = true;
  await docker(state, ["start", state.postgrestContainer], { timeoutMs: 60_000 });
  await waitForPostgrest(state);
}

export async function waitForPostgrest(state) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/`, {
        signal: AbortSignal.timeout(2_000)
      });
      if (response.status < 500) return;
    } catch {}
    const containerState = await docker(state, [
      "container", "inspect", "--format", "{{.State.Running}}|{{.State.ExitCode}}",
      state.postgrestContainer
    ], { allowFailure: true, timeoutMs: 5_000 });
    if (containerState.code === 0 && containerState.stdout.trim().startsWith("false|")) {
      const logs = await docker(state, [
        "logs", "--tail", "50", state.postgrestContainer
      ], { allowFailure: true, timeoutMs: 10_000 });
      throw new Error(redact(state, `local PostgREST exited before readiness: ${logs.stderr || logs.stdout}`));
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const logs = await docker(state, [
    "logs", "--tail", "50", state.postgrestContainer
  ], { allowFailure: true, timeoutMs: 10_000 });
  throw new Error(redact(state, `local PostgREST did not become ready: ${logs.stderr || logs.stdout}`));
}

export async function psql(state, sql, {
  database = "postgres",
  role = null,
  allowFailure = false,
  timeoutMs = 30_000
} = {}) {
  const rolePrefix = role ? `set role ${quoteIdentifier(role)};\n` : "";
  const input = `\\set ON_ERROR_STOP on\n\\set VERBOSITY terse\n${rolePrefix}${sql}\n`;
  return docker(state, [
    "exec", "-i", state.postgresContainer,
    "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    "-U", "postgres", "-d", database
  ], { input, allowFailure, timeoutMs });
}

export async function queryScalar(state, sql, options = {}) {
  const result = await psql(state, sql, options);
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) || "";
}

export async function queryJson(state, sql, options = {}) {
  const value = await queryScalar(state, sql, options);
  return JSON.parse(value);
}

export async function applySqlFile(state, filePath, options = {}) {
  const sql = await readFile(filePath, "utf8");
  return psql(state, sql, options);
}

export function quoteLiteral(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function jwtClaims(state, claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode(claims);
  const signature = createHmac("sha256", state.jwtSecret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function jwt(state, role, subject = "00000000-0000-4000-8000-000000000001") {
  return jwtClaims(state, {
    role,
    sub: subject,
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600
  });
}

export async function httpJson(state, pathname, {
  method = "GET",
  token = null,
  body = undefined,
  headers = {},
  timeoutMs = 8_000
} = {}) {
  const requestHeaders = { Accept: "application/json", ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${state.port}${pathname}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  state.captured.push(text);
  assertSecretsAbsent(state, text, `${pathname} response`);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, text, json, headers: response.headers };
}

async function resourceExists(state, type, name) {
  const command = type === "container"
    ? ["container", "inspect", "--format", "{{.Id}}", name]
    : ["network", "inspect", "--format", "{{.Id}}", name];
  const result = await docker(state, command, { allowFailure: true, timeoutMs: 15_000 });
  return result.code === 0;
}

async function scanDirectory(state, directory) {
  let entries = [];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await scanDirectory(state, target);
    else assertSecretsAbsent(state, await readFile(target), `${target} artifact`);
  }
}

export async function scanRuntimeSafety(state) {
  for (const name of [state.postgresContainer, state.postgrestContainer]) {
    if (!await resourceExists(state, "container", name)) continue;
    const logs = await docker(state, ["logs", name], { allowFailure: true, timeoutMs: 20_000 });
    assertSecretsAbsent(state, logs.stdout, `${name} logs`);
    assertSecretsAbsent(state, logs.stderr, `${name} logs`);
  }
  for (const value of state.captured) assertSecretsAbsent(state, value, "captured harness output");
  if (state.tempDirectory) await scanDirectory(state, state.tempDirectory);
}

export async function cleanupHarness(state) {
  const errors = [];
  for (const child of state.activeChildren) {
    try { child.kill("SIGKILL"); } catch (error) { errors.push(redact(state, error.message)); }
  }
  try { await scanRuntimeSafety(state); } catch (error) { errors.push(redact(state, error.message)); }

  for (const name of [state.postgrestContainer, state.postgresContainer]) {
    try {
      if (await resourceExists(state, "container", name)) {
        await docker(state, ["rm", "-f", name], { timeoutMs: 30_000 });
      }
    } catch (error) { errors.push(redact(state, error.message)); }
  }
  try {
    if (await resourceExists(state, "network", state.network)) {
      await docker(state, ["network", "rm", state.network], { timeoutMs: 30_000 });
    }
  } catch (error) { errors.push(redact(state, error.message)); }
  try {
    if (state.tempDirectory) await rm(state.tempDirectory, { recursive: true, force: true });
  } catch (error) { errors.push(redact(state, error.message)); }

  try {
    assert.equal(await resourceExists(state, "container", state.postgresContainer), false);
    assert.equal(await resourceExists(state, "container", state.postgrestContainer), false);
    assert.equal(await resourceExists(state, "network", state.network), false);
    assert.equal(state.activeChildren.size, 0);
  } catch (error) { errors.push(redact(state, error.message)); }

  assert.deepEqual(errors, [], `cleanup failed: ${errors.join("; ")}`);
  state.cleanupComplete = true;
}
