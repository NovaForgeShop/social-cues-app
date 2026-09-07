import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoDir = path.dirname(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = "postgres:17-alpine";
const POSTGREST_IMAGE = "postgrest/postgrest:v14.12";
const EXPECTED_MIGRATION_BLOB = "71cf307fc059c32a017c4b53aaa9a774ec83bd11";
const EXPECTED_MIGRATION_SHA256 = "3a34d91e4217d66f86ed1e54dbdd6675796c4410ea7ab43d2637d0bb7e63a9bc";
const EXPECTED_RUNTIME_HARNESS_BLOB = "ad730ae48874294d7512b016c8e500acf1f039b9";
const MIGRATION_PATH = "SUPABASE-VIZARD-CONNECTION-MANAGEMENT.sql";
const STARTER_SCHEMA_PATH = "supabase-schema.sql";
const PER_USER_MIGRATION_PATH = "SUPABASE-PER-USER-MIGRATION.sql";
const RUNTIME_HARNESS_PATH = "vizard-connection-management.runtime.test.mjs";
const POSTGREST_HARNESS_PATH = "vizard-connection-management.postgrest.test.mjs";
const PACKAGE_PATH = "package.json";
const API_CLIENT_HARNESS_PATH = "vizard-api-client.contract.test.mjs";
const SERVICE_HARNESS_PATH = "vizard-connection-service.contract.test.mjs";
const CONTRACT_HARNESS_PATH = "vizard-connection-management.contract.test.mjs";
const REQUIRED_VIZARD_SCRIPTS = Object.freeze({
  "test:vizard": Object.freeze({
    command: `node ${API_CLIENT_HARNESS_PATH}`,
    target: API_CLIENT_HARNESS_PATH
  }),
  "test:vizard-connection-service": Object.freeze({
    command: `node ${SERVICE_HARNESS_PATH}`,
    target: SERVICE_HARNESS_PATH
  }),
  "test:vizard-connection-management": Object.freeze({
    command: `node ${CONTRACT_HARNESS_PATH}`,
    target: CONTRACT_HARNESS_PATH
  }),
  "test:vizard-connection-management:runtime": Object.freeze({
    command: `node ${RUNTIME_HARNESS_PATH}`,
    target: RUNTIME_HARNESS_PATH
  }),
  "test:vizard-connection-management:postgrest": Object.freeze({
    command: `node ${POSTGREST_HARNESS_PATH}`,
    target: POSTGREST_HARNESS_PATH
  })
});
const COMMITTED_PREFLIGHT_ARTIFACTS = Object.freeze([
  MIGRATION_PATH,
  STARTER_SCHEMA_PATH,
  PER_USER_MIGRATION_PATH,
  RUNTIME_HARNESS_PATH,
  API_CLIENT_HARNESS_PATH,
  SERVICE_HARNESS_PATH,
  CONTRACT_HARNESS_PATH
]);
const RESOURCE_LABEL = "social-cues.test=vizard-postgrest";
const RPC_PATH = "/rpc/social_cues_manage_vizard_connection";
const SAFE_RETURN_FIELDS = [
  "connected_account_id",
  "workspace_id",
  "provider",
  "platform",
  "connection_state",
  "verification_state",
  "connected_at",
  "created_at",
  "updated_at"
];
const RPC_ARGUMENTS = ["p_actor_user_id", "p_workspace_id", "p_action", "p_encrypted_token"];
const USERS = Object.freeze({
  ownerA: "10000000-0000-4000-8000-000000000001",
  adminA: "10000000-0000-4000-8000-000000000002",
  memberA: "10000000-0000-4000-8000-000000000003",
  viewerA: "10000000-0000-4000-8000-000000000004",
  outsider: "10000000-0000-4000-8000-000000000005",
  ownerB: "10000000-0000-4000-8000-000000000006",
  multi: "10000000-0000-4000-8000-000000000007"
});
const WORKSPACES = Object.freeze({
  a: "20000000-0000-4000-8000-000000000001",
  b: "20000000-0000-4000-8000-000000000002",
  metadataOnly: "20000000-0000-4000-8000-000000000003",
  missing: "20000000-0000-4000-8000-000000000099"
});
const CLEANUP_FAULTS = [
  "after_temp_directory",
  "after_network_creation",
  "after_postgres_container_creation",
  "after_postgres_start",
  "after_schema_setup",
  "after_postgrest_container_creation",
  "after_postgrest_start",
  "during_first_http_assertion"
];

const redactions = new Set();
const globalCapturedOutput = [];
const globalActiveChildren = new Set();
const activeContexts = new Set();
const passedCategories = [];
let assertionCount = 0;
let shutdownRequested = false;

function expectEqual(actual, expected, message) {
  assertionCount += 1;
  assert.equal(actual, expected, message);
}

function expectNotEqual(actual, expected, message) {
  assertionCount += 1;
  assert.notEqual(actual, expected, message);
}

function expectDeepEqual(actual, expected, message) {
  assertionCount += 1;
  assert.deepEqual(actual, expected, message);
}

function expectOk(value, message) {
  assertionCount += 1;
  assert.ok(value, message);
}

function expectMatch(value, expression, message) {
  assertionCount += 1;
  assert.match(value, expression, message);
}

function expectPreflightFailure(fn, expression, message) {
  assertionCount += 1;
  assert.throws(fn, expression, message);
}

function registerSecret(value) {
  if (typeof value === "string") {
    if (value.length >= 8) redactions.add(value);
    return value;
  }
  if (value && typeof value === "object") {
    const serialized = JSON.stringify(value);
    if (serialized.length >= 8) redactions.add(serialized);
    for (const [key, nested] of Object.entries(value)) {
      if (key !== "alg") registerSecret(nested);
    }
  }
  return value;
}

function redact(value) {
  let result = String(value ?? "");
  for (const secret of redactions) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function assertSecretsAbsent(value, context) {
  const text = String(value ?? "");
  for (const secret of redactions) {
    expectEqual(text.includes(secret), false, `${context} exposed synthetic secret material`);
  }
}

async function check(name, fn) {
  await fn();
  passedCategories.push(name);
  console.log(`PASS ${name}`);
}

function lastOutputLine(value) {
  return String(value)
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";
}

function quoteLiteral(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function jsonbLiteral(value) {
  return `${quoteLiteral(JSON.stringify(value))}::jsonb`;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function preflightRequirement(value, message) {
  if (!value) throw new Error(`Vizard PostgREST preflight: ${message}`);
}

function validateVizardPostgrestPreflight({
  packageSource,
  targetStates,
  artifactStates,
  migrationIdentity
}) {
  let manifest;
  try {
    manifest = JSON.parse(packageSource);
  } catch {
    throw new Error("Vizard PostgREST preflight: package.json is malformed");
  }
  preflightRequirement(isPlainObject(manifest), "package.json must contain an object");
  preflightRequirement(isPlainObject(manifest.scripts), "package.json scripts must be an object");
  preflightRequirement(isPlainObject(targetStates), "required target state is unavailable");
  preflightRequirement(isPlainObject(artifactStates), "owned artifact state is unavailable");

  for (const [scriptName, requirement] of Object.entries(REQUIRED_VIZARD_SCRIPTS)) {
    preflightRequirement(Object.hasOwn(manifest.scripts, scriptName), `${scriptName} is missing`);
    preflightRequirement(
      manifest.scripts[scriptName] === requirement.command,
      `${scriptName} must remain ${requirement.command}`
    );
    const targetState = targetStates[requirement.target];
    preflightRequirement(isPlainObject(targetState), `${requirement.target} state is missing`);
    preflightRequirement(targetState.exists === true, `${requirement.target} does not exist`);
    preflightRequirement(targetState.tracked === true, `${requirement.target} must be tracked`);
    preflightRequirement(
      targetState.insideRepository === true,
      `${requirement.target} must resolve inside the repository`
    );
  }

  for (const artifactPath of COMMITTED_PREFLIGHT_ARTIFACTS) {
    const artifactState = artifactStates[artifactPath];
    preflightRequirement(isPlainObject(artifactState), `${artifactPath} state is missing`);
    preflightRequirement(artifactState.exists === true, `${artifactPath} does not exist`);
    preflightRequirement(artifactState.tracked === true, `${artifactPath} must be tracked`);
    preflightRequirement(
      artifactState.insideRepository === true,
      `${artifactPath} must resolve inside the repository`
    );
    preflightRequirement(artifactState.clean === true, `${artifactPath} must remain committed and unchanged`);
  }

  preflightRequirement(isPlainObject(migrationIdentity), "migration identity is unavailable");
  preflightRequirement(migrationIdentity.path === MIGRATION_PATH, "Vizard migration path is not approved");
  preflightRequirement(
    migrationIdentity.blob === EXPECTED_MIGRATION_BLOB,
    "Vizard migration Git object is not approved"
  );
  preflightRequirement(
    migrationIdentity.sha256 === EXPECTED_MIGRATION_SHA256,
    "Vizard migration SHA-256 is not approved"
  );

  return Object.freeze({
    scripts: Object.freeze(Object.fromEntries(
      Object.entries(REQUIRED_VIZARD_SCRIPTS).map(([name, requirement]) => [name, requirement.command])
    )),
    targets: Object.freeze(Object.fromEntries(
      Object.entries(REQUIRED_VIZARD_SCRIPTS).map(([name, requirement]) => [name, requirement.target])
    )),
    migration: Object.freeze({ ...migrationIdentity })
  });
}

function pathResolvesInside(repositoryRoot, targetPath) {
  const relative = path.relative(repositoryRoot, targetPath);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function collectPathState(relativePath, { requireClean = false } = {}) {
  const repositoryRoot = await realpath(repoDir);
  const candidatePath = path.resolve(repoDir, relativePath);
  const lexicalInside = pathResolvesInside(repositoryRoot, candidatePath);
  let exists = false;
  let insideRepository = false;
  if (lexicalInside) {
    try {
      const resolvedTarget = await realpath(candidatePath);
      exists = true;
      insideRepository = pathResolvesInside(repositoryRoot, resolvedTarget);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const trackedResult = await git(["ls-files", "--error-unmatch", "--", relativePath], {
    allowFailure: true,
    captureOutput: false
  });
  let clean = true;
  if (requireClean) {
    const status = await git(["status", "--porcelain=v1", "--", relativePath], { captureOutput: false });
    clean = status.stdout.trim() === "";
  }
  return Object.freeze({
    exists,
    tracked: trackedResult.code === 0,
    insideRepository,
    clean
  });
}

async function collectPathStates(paths, options = {}) {
  return Object.fromEntries(await Promise.all(
    paths.map(async relativePath => [relativePath, await collectPathState(relativePath, options)])
  ));
}

function cloneStateMap(states) {
  return Object.fromEntries(Object.entries(states).map(([name, state]) => [name, { ...state }]));
}

function packageVariant(packageSource, mutate) {
  const manifest = JSON.parse(packageSource);
  mutate(manifest);
  return JSON.stringify(manifest);
}

function runScopedPreflightRegressionTests(inputs) {
  const validate = ({
    packageSource = inputs.packageSource,
    targetStates = inputs.targetStates,
    artifactStates = inputs.artifactStates,
    migrationIdentity = inputs.migrationIdentity
  } = {}) => validateVizardPostgrestPreflight({
    packageSource,
    targetStates,
    artifactStates,
    migrationIdentity
  });

  expectOk(validate(), "current repaired-B0 package must pass scoped preflight");
  expectOk(validate({
    packageSource: packageVariant(inputs.packageSource, manifest => {
      manifest.scripts["test:stripe-lifecycle"] = "node stripe-billing-lifecycle.contract.test.mjs";
    })
  }), "unrelated Stripe lifecycle script must not be Vizard-owned");
  expectOk(validate({
    packageSource: packageVariant(inputs.packageSource, manifest => {
      manifest.scripts["test:unrelated-hermetic"] = "node unrelated-hermetic.contract.test.mjs";
    })
  }), "unrelated hermetic test script must not be Vizard-owned");
  expectOk(validate({
    packageSource: packageVariant(inputs.packageSource, manifest => {
      manifest.description = "unrelated package metadata";
    })
  }), "unrelated package metadata must not be Vizard-owned");
  const reorderedManifest = JSON.parse(inputs.packageSource);
  reorderedManifest.scripts = Object.fromEntries(Object.entries(reorderedManifest.scripts).reverse());
  const reorderedPackage = JSON.stringify(Object.fromEntries(Object.entries(reorderedManifest).reverse()));
  expectOk(validate({ packageSource: reorderedPackage }), "unrelated package key ordering must not be Vizard-owned");

  for (const [scriptName, requirement] of Object.entries(REQUIRED_VIZARD_SCRIPTS)) {
    expectPreflightFailure(() => validate({
      packageSource: packageVariant(inputs.packageSource, manifest => { delete manifest.scripts[scriptName]; })
    }), new RegExp(`${scriptName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} is missing`, "u"),
    `${scriptName} deletion must fail`);
    expectPreflightFailure(() => validate({
      packageSource: packageVariant(inputs.packageSource, manifest => {
        manifest.scripts[scriptName] = `${requirement.command} --mutated`;
      })
    }), /must remain/u, `${scriptName} command mutation must fail`);

    for (const [field, value] of [
      ["exists", false],
      ["tracked", false],
      ["insideRepository", false]
    ]) {
      const targetStates = cloneStateMap(inputs.targetStates);
      targetStates[requirement.target][field] = value;
      expectPreflightFailure(() => validate({ targetStates }),
        /does not exist|must be tracked|must resolve inside/u,
        `${requirement.target} ${field} mutation must fail`);
    }
  }

  expectPreflightFailure(() => validate({
    packageSource: packageVariant(inputs.packageSource, manifest => {
      const value = manifest.scripts["test:vizard"];
      delete manifest.scripts["test:vizard"];
      manifest.scripts["test:vizard-renamed"] = value;
    })
  }), /test:vizard is missing/u, "required Vizard script rename must fail");
  expectPreflightFailure(() => validate({
    packageSource: packageVariant(inputs.packageSource, manifest => {
      manifest.scripts["test:vizard-connection-management:postgrest"] =
        "node vizard-connection-management.contract.test.mjs";
    })
  }), /must remain/u, "PostgREST target redirection must fail");
  expectPreflightFailure(() => validate({
    packageSource: packageVariant(inputs.packageSource, manifest => {
      manifest.scripts["test:vizard-connection-management:postgrest"] =
        `node ${POSTGREST_HARNESS_PATH} --production --live`;
    })
  }), /must remain/u, "live or production command mutation must fail");
  expectPreflightFailure(() => validate({
    packageSource: packageVariant(inputs.packageSource, manifest => {
      manifest.scripts["test:vizard-connection-management:postgrest"] =
        "curl https://api.vizard.ai/v1/projects";
    })
  }), /must remain/u, "provider or remote command mutation must fail");
  expectPreflightFailure(() => validate({
    packageSource: packageVariant(inputs.packageSource, manifest => {
      manifest.scripts["test:vizard-connection-management:postgrest"] =
        "node ../vizard-connection-management.postgrest.test.mjs";
    })
  }), /must remain/u, "outside-repository command target must fail");

  for (const artifactPath of COMMITTED_PREFLIGHT_ARTIFACTS) {
    for (const [field, value] of [
      ["exists", false],
      ["tracked", false],
      ["insideRepository", false],
      ["clean", false]
    ]) {
      const artifactStates = cloneStateMap(inputs.artifactStates);
      artifactStates[artifactPath][field] = value;
      expectPreflightFailure(() => validate({ artifactStates }),
        /does not exist|must be tracked|must resolve inside|must remain committed/u,
        `${artifactPath} ${field} mutation must fail`);
    }
  }

  expectPreflightFailure(() => validate({
    migrationIdentity: { ...inputs.migrationIdentity, path: "SUPABASE-VIZARD-REDIRECTED.sql" }
  }), /migration path is not approved/u, "Vizard migration path mutation must fail");
  expectPreflightFailure(() => validate({
    migrationIdentity: { ...inputs.migrationIdentity, blob: "0000000000000000000000000000000000000000" }
  }), /migration Git object is not approved/u, "Vizard migration blob mutation must fail");
  expectPreflightFailure(() => validate({
    migrationIdentity: { ...inputs.migrationIdentity, sha256: "0".repeat(64) }
  }), /migration SHA-256 is not approved/u, "Vizard migration SHA-256 mutation must fail");
  expectPreflightFailure(() => validate({ packageSource: "{" }), /package\.json is malformed/u,
    "malformed package JSON must fail");
  expectPreflightFailure(() => validate({ packageSource: JSON.stringify({ name: "missing-scripts" }) }),
    /scripts must be an object/u, "missing scripts object must fail");
  for (const scripts of [null, [], "not-an-object"]) {
    expectPreflightFailure(() => validate({ packageSource: JSON.stringify({ scripts }) }),
      /scripts must be an object/u, "non-object scripts value must fail");
  }
}

async function runProcess(command, args, {
  context = null,
  input = null,
  timeoutMs = 30_000,
  allowFailure = false,
  captureOutput = true
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoDir,
      windowsHide: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    globalActiveChildren.add(child);
    context?.activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const unregister = () => {
      clearTimeout(timer);
      globalActiveChildren.delete(child);
      context?.activeChildren.delete(child);
    };

    child.once("error", error => {
      if (settled) return;
      settled = true;
      unregister();
      const output = `${command} startup error: ${error.message}`;
      if (captureOutput) {
        globalCapturedOutput.push(output);
        context?.capturedOutput.push(output);
      }
      reject(new Error(redact(output)));
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      unregister();
      const output = `${command}\n${stdout}\n${stderr}`;
      if (captureOutput) {
        globalCapturedOutput.push(output);
        context?.capturedOutput.push(output);
      }
      const result = { code: code ?? -1, signal, stdout, stderr, timedOut };
      if (timedOut) {
        reject(new Error(`${command} exceeded the ${timeoutMs}ms timeout`));
      } else if (result.code !== 0 && !allowFailure) {
        reject(new Error(redact([
          `${command} exited with code ${result.code}`,
          stderr,
          stdout
        ].filter(Boolean).join("\n"))));
      } else {
        resolve(result);
      }
    });

    child.stdin.end(input ?? undefined);
  });
}

function docker(context, args, options = {}) {
  return runProcess("docker", args, { ...options, context });
}

async function git(args, options = {}) {
  return runProcess("git", args, options);
}

async function psql(context, sql, { allowFailure = false, timeoutMs = 25_000 } = {}) {
  return docker(context, [
    "exec", "-i",
    "-e", "PGOPTIONS=-c statement_timeout=20000 -c lock_timeout=12000 -c client_min_messages=warning",
    context.postgresContainer,
    "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    "-U", "postgres", "-d", "postgres"
  ], {
    input: `\\set VERBOSITY verbose\n${sql.trim()}\n`,
    allowFailure,
    timeoutMs
  });
}

async function queryScalar(context, sql) {
  const result = await psql(context, sql);
  return lastOutputLine(result.stdout);
}

async function queryJson(context, sql) {
  const value = await queryScalar(context, sql);
  expectOk(value, "expected a JSON query result");
  return JSON.parse(value);
}

function createContext(label) {
  const suffix = `${process.pid}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const prefix = `social-cues-vizard-postgrest-${label}-${suffix}`.toLowerCase();
  const context = {
    label,
    suffix,
    postgresContainer: `${prefix}-db`,
    postgrestContainer: `${prefix}-api`,
    network: `${prefix}-network`,
    volume: `${prefix}-volume`,
    tempDirectory: path.join(tmpdir(), `${prefix}-tmp`),
    postgresPassword: registerSecret(randomBytes(24).toString("base64url")),
    jwtSecret: registerSecret(randomBytes(32).toString("base64url")),
    port: null,
    activeChildren: new Set(),
    capturedOutput: [],
    httpResponses: [],
    cleanupComplete: false,
    workspaceCounter: 100,
    postgresReady: false,
    postgrestReady: false
  };
  activeContexts.add(context);
  return context;
}

function jwt(context, role, subject = USERS.ownerA) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ role, sub: subject, exp: Math.floor(Date.now() / 1000) + 900 });
  const signature = createHmac("sha256", context.jwtSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return registerSecret(`${header}.${payload}.${signature}`);
}

function makeEnvelope(label) {
  const plaintext = registerSecret(`scv-${label}-${randomBytes(12).toString("base64url")}`);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const value = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope = {
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    value: value.toString("base64url")
  };
  registerSecret(envelope);
  return { envelope, plaintext };
}

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function isPortListening(port) {
  if (!port) return false;
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = value => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function api(context, pathname, {
  method = "GET",
  token = "",
  body = null,
  headers = {}
} = {}) {
  expectOk(pathname.startsWith("/"), "PostgREST path must be absolute");
  expectOk(Number.isInteger(context.port) && context.port > 0, "PostgREST loopback port is not registered");
  const value = body === null ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: context.port,
      path: pathname,
      method,
      headers: {
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === null ? {} : {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(value)
        })
      },
      timeout: 10_000
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = text;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        const result = {
          status: response.statusCode || 0,
          headers: response.headers,
          body: parsed,
          text
        };
        context.httpResponses.push(result);
        try {
          assertSecretsAbsent(text, `${method} ${pathname} response`);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("PostgREST request timed out")));
    request.end(value);
  });
}

function rpc(context, token, {
  actor,
  workspace,
  action,
  envelope = null,
  extra = {},
  headers = {}
}) {
  return api(context, RPC_PATH, {
    method: "POST",
    token,
    headers,
    body: {
      p_actor_user_id: actor,
      p_workspace_id: workspace,
      p_action: action,
      p_encrypted_token: envelope,
      ...extra
    }
  });
}

function assertHttpFailure(response, expectedMessage = null) {
  expectOk(response.status >= 400 && response.status < 600, `unexpected HTTP success ${response.status}`);
  if (expectedMessage) expectEqual(response.body?.message, expectedMessage);
  assertSecretsAbsent(response.text, "PostgREST failure response");
}

function collectObjectKeys(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, output);
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      output.add(key);
      collectObjectKeys(nested, output);
    }
  }
  return output;
}

function assertSafeRpcResponse(response, {
  workspace,
  connectionState,
  verificationState,
  accountId = undefined
}) {
  expectEqual(response.status, 200, response.text);
  expectOk(Array.isArray(response.body), "RPC response must be an array");
  expectEqual(response.body.length, 1, "RPC response must contain exactly one row");
  const row = response.body[0];
  expectDeepEqual(Object.keys(row).sort(), [...SAFE_RETURN_FIELDS].sort());
  expectEqual(row.workspace_id, workspace);
  expectEqual(row.provider, "vizard");
  expectEqual(row.platform, "vizard");
  expectEqual(row.connection_state, connectionState);
  expectEqual(row.verification_state, verificationState);
  if (accountId !== undefined) expectEqual(row.connected_account_id, accountId);
  const forbiddenKeys = new Set([
    "apiKey", "api_key", "vizardApiKey", "vizard_api_key", "token", "accessToken",
    "refreshToken", "encryptedToken", "encrypted_token", "encrypted_refresh_token",
    "iv", "tag", "value", "metadata", "public_profile", "fingerprint", "key_length",
    "token_kind", "token_type"
  ]);
  for (const key of collectObjectKeys(row)) {
    expectEqual(forbiddenKeys.has(key), false, `RPC response exposed forbidden key ${key}`);
  }
  assertSecretsAbsent(response.text, "safe RPC response");
  return row;
}

function extractTable(source, tableName) {
  const match = source.match(new RegExp(
    `create table if not exists public\\.${tableName} \\([\\s\\S]*?^\\);`,
    "mu"
  ));
  expectOk(match, `canonical ${tableName} definition is missing`);
  return match[0];
}

function fixtureSql(starterSchema, perUserMigration) {
  const tables = [
    extractTable(starterSchema, "workspaces"),
    extractTable(perUserMigration, "workspace_members"),
    extractTable(perUserMigration, "connected_accounts"),
    extractTable(perUserMigration, "provider_tokens"),
    extractTable(perUserMigration, "billing_entitlements"),
    extractTable(perUserMigration, "audit_logs")
  ];
  return `
create extension if not exists pgcrypto;
create schema if not exists auth;
create or replace function auth.uid()
returns uuid language sql stable security invoker set search_path = ''
as $$ select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid $$;

${tables.join("\n\n")}

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.connected_accounts enable row level security;
alter table public.provider_tokens enable row level security;
alter table public.billing_entitlements enable row level security;
alter table public.audit_logs enable row level security;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant select, insert, update, delete on table
  public.workspaces,
  public.workspace_members,
  public.connected_accounts,
  public.provider_tokens,
  public.billing_entitlements,
  public.audit_logs
to anon, authenticated, service_role;

revoke all on table public.provider_tokens from public, anon, authenticated;
create policy "provider tokens are service role only" on public.provider_tokens
  for all to anon, authenticated using (false) with check (false);

create policy "members can read own memberships" on public.workspace_members
  for select to authenticated using (user_id = (select auth.uid()));
create policy "members can read connected accounts" on public.connected_accounts
  for select to authenticated using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = connected_accounts.workspace_id
        and wm.user_id = (select auth.uid())
    )
  );
create policy "members can read audit logs" on public.audit_logs
  for select to authenticated using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = audit_logs.workspace_id
        and wm.user_id = (select auth.uid())
    )
  );

create index if not exists workspace_members_user_idx on public.workspace_members(user_id);
create index if not exists connected_accounts_workspace_idx on public.connected_accounts(workspace_id);
create index if not exists connected_accounts_user_idx on public.connected_accounts(user_id);
create index if not exists provider_tokens_account_idx on public.provider_tokens(connected_account_id);
create index if not exists provider_tokens_workspace_idx on public.provider_tokens(workspace_id);
create index if not exists audit_logs_workspace_idx on public.audit_logs(workspace_id, created_at desc);
`;
}

async function loadCommittedArtifact(relativePath, { expectedBlob = null, expectedSha256 = null } = {}) {
  const headBlob = lastOutputLine((await git(["rev-parse", `HEAD:${relativePath}`])).stdout);
  const indexBlob = lastOutputLine((await git(["rev-parse", `:${relativePath}`])).stdout);
  const worktreeBlob = lastOutputLine((await git([
    "hash-object", `--path=${relativePath}`, "--", relativePath
  ])).stdout);
  expectEqual(indexBlob, headBlob, `${relativePath} differs in the index`);
  expectEqual(worktreeBlob, headBlob, `${relativePath} differs in the worktree`);
  if (expectedBlob) expectEqual(headBlob, expectedBlob, `${relativePath} Git object is not approved`);
  const unstaged = await git(["diff", "--quiet", "--", relativePath], { allowFailure: true });
  const staged = await git(["diff", "--cached", "--quiet", "--", relativePath], { allowFailure: true });
  expectEqual(unstaged.code, 0, `${relativePath} has an unstaged change`);
  expectEqual(staged.code, 0, `${relativePath} has a staged change`);
  const committed = await git(["show", `HEAD:${relativePath}`], { captureOutput: false });
  const sha256 = createHash("sha256").update(committed.stdout).digest("hex");
  if (expectedSha256) expectEqual(sha256, expectedSha256, `${relativePath} SHA-256 is not approved`);
  return { blob: headBlob, content: committed.stdout, sha256 };
}

async function verifyCommittedInputs() {
  const packageSource = await readFile(path.join(repoDir, PACKAGE_PATH), "utf8");
  const targetPaths = [...new Set(Object.values(REQUIRED_VIZARD_SCRIPTS).map(value => value.target))];
  const targetStates = await collectPathStates(targetPaths);
  const artifactStates = await collectPathStates(COMMITTED_PREFLIGHT_ARTIFACTS, { requireClean: true });
  const migration = await loadCommittedArtifact(MIGRATION_PATH, {
    expectedBlob: EXPECTED_MIGRATION_BLOB,
    expectedSha256: EXPECTED_MIGRATION_SHA256
  });
  const starterSchema = await loadCommittedArtifact(STARTER_SCHEMA_PATH);
  const perUserMigration = await loadCommittedArtifact(PER_USER_MIGRATION_PATH);
  const runtimeHarness = await loadCommittedArtifact(RUNTIME_HARNESS_PATH, {
    expectedBlob: EXPECTED_RUNTIME_HARNESS_BLOB
  });
  await Promise.all([
    loadCommittedArtifact(API_CLIENT_HARNESS_PATH),
    loadCommittedArtifact(SERVICE_HARNESS_PATH),
    loadCommittedArtifact(CONTRACT_HARNESS_PATH)
  ]);
  const migrationIdentity = {
    path: MIGRATION_PATH,
    blob: migration.blob,
    sha256: migration.sha256
  };
  const preflight = validateVizardPostgrestPreflight({
    packageSource,
    targetStates,
    artifactStates,
    migrationIdentity
  });
  return {
    migration,
    starterSchema,
    perUserMigration,
    runtimeHarness,
    packageSource,
    targetStates,
    artifactStates,
    migrationIdentity,
    preflight
  };
}

async function ensureImage(image) {
  const present = await docker(null, ["image", "inspect", image], {
    allowFailure: true,
    timeoutMs: 10_000
  });
  if (present.code !== 0) await docker(null, ["pull", image], { timeoutMs: 180_000 });
}

async function dockerNames(context, type) {
  const argsByType = {
    container: ["ps", "-a", "--format", "{{.Names}}"],
    network: ["network", "ls", "--format", "{{.Name}}"],
    volume: ["volume", "ls", "--format", "{{.Name}}"]
  };
  const result = await docker(context, argsByType[type], { timeoutMs: 15_000 });
  return new Set(result.stdout.split(/\r?\n/u).map(value => value.trim()).filter(Boolean));
}

async function resourceExists(context, type, name) {
  return (await dockerNames(context, type)).has(name);
}

async function verifyResourceAbsence(context) {
  expectEqual(await resourceExists(context, "container", context.postgresContainer), false,
    `${context.postgresContainer} still exists`);
  expectEqual(await resourceExists(context, "container", context.postgrestContainer), false,
    `${context.postgrestContainer} still exists`);
  expectEqual(await resourceExists(context, "network", context.network), false,
    `${context.network} still exists`);
  expectEqual(await resourceExists(context, "volume", context.volume), false,
    `${context.volume} still exists`);
  expectEqual(await pathExists(context.tempDirectory), false, `${context.tempDirectory} still exists`);
  expectEqual(context.activeChildren.size, 0, `${context.label} still has a task child process`);
  expectEqual(await isPortListening(context.port), false, `${context.label} loopback port is still listening`);
}

async function scanDirectorySecrets(directory, label) {
  if (!(await pathExists(directory))) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await scanDirectorySecrets(target, label);
    else assertSecretsAbsent(await readFile(target, "utf8"), `${label} file ${entry.name}`);
  }
}

async function scanContainerLogs(context) {
  for (const name of [context.postgresContainer, context.postgrestContainer]) {
    if (!(await resourceExists(context, "container", name))) continue;
    const logs = await docker(context, ["logs", name], { timeoutMs: 20_000 });
    assertSecretsAbsent(`${logs.stdout}\n${logs.stderr}`, `${name} logs`);
  }
}

async function cleanupContext(context) {
  const cleanupErrors = [];
  for (const child of [...context.activeChildren]) {
    try { child.kill("SIGKILL"); } catch (error) { cleanupErrors.push(redact(error.message)); }
  }
  for (let attempt = 0; attempt < 40 && context.activeChildren.size > 0; attempt += 1) {
    await delay(50);
  }
  if (context.activeChildren.size > 0) cleanupErrors.push("task child process did not terminate");

  try { await scanContainerLogs(context); } catch (error) { cleanupErrors.push(redact(error.message)); }
  try { await scanDirectorySecrets(context.tempDirectory, context.label); } catch (error) { cleanupErrors.push(redact(error.message)); }

  for (const name of [context.postgrestContainer, context.postgresContainer]) {
    try {
      if (await resourceExists(context, "container", name)) {
        await docker(context, ["rm", "-f", name], { timeoutMs: 30_000 });
      }
    } catch (error) {
      cleanupErrors.push(redact(error.message));
    }
  }
  try {
    if (await resourceExists(context, "network", context.network)) {
      await docker(context, ["network", "rm", context.network], { timeoutMs: 30_000 });
    }
  } catch (error) {
    cleanupErrors.push(redact(error.message));
  }
  try {
    if (await resourceExists(context, "volume", context.volume)) {
      await docker(context, ["volume", "rm", context.volume], { timeoutMs: 30_000 });
    }
  } catch (error) {
    cleanupErrors.push(redact(error.message));
  }
  try { await rm(context.tempDirectory, { recursive: true, force: true }); } catch (error) {
    cleanupErrors.push(redact(error.message));
  }
  for (let attempt = 0; attempt < 30 && await isPortListening(context.port); attempt += 1) {
    await delay(100);
  }
  try { await verifyResourceAbsence(context); } catch (error) { cleanupErrors.push(redact(error.message)); }
  try {
    assertSecretsAbsent(context.capturedOutput.join("\n"), `${context.label} captured process output`);
    assertSecretsAbsent(context.httpResponses.map(response => response.text).join("\n"), `${context.label} HTTP responses`);
  } catch (error) {
    cleanupErrors.push(redact(error.message));
  }
  expectDeepEqual(cleanupErrors, [], `cleanup failed for ${context.label}: ${cleanupErrors.join("; ")}`);
  context.cleanupComplete = true;
  activeContexts.delete(context);
}

function checkpoint(faultAt, name) {
  if (faultAt === name) throw new Error(`INJECTED_${name}`);
}

function postgresCreateArgs(context) {
  return [
    "create",
    "--name", context.postgresContainer,
    "--label", RESOURCE_LABEL,
    "--network", context.network,
    "--network-alias", "postgres",
    "--shm-size", "128m",
    "-v", `${context.volume}:/var/lib/postgresql/data`,
    "-e", `POSTGRES_PASSWORD=${context.postgresPassword}`,
    "-e", "POSTGRES_DB=postgres",
    POSTGRES_IMAGE,
    "postgres",
    "-c", "log_statement=none",
    "-c", "log_min_error_statement=panic",
    "-c", "log_parameter_max_length_on_error=0"
  ];
}

function postgrestCreateArgs(context) {
  return [
    "create",
    "--name", context.postgrestContainer,
    "--label", RESOURCE_LABEL,
    "--network", context.network,
    "-p", `127.0.0.1:${context.port}:3000`,
    "-e", `PGRST_DB_URI=postgres://authenticator:${context.postgresPassword}@postgres:5432/postgres`,
    "-e", "PGRST_DB_SCHEMAS=public",
    "-e", "PGRST_DB_ANON_ROLE=anon",
    "-e", `PGRST_JWT_SECRET=${context.jwtSecret}`,
    "-e", "PGRST_LOG_LEVEL=info",
    POSTGREST_IMAGE
  ];
}

async function waitForPostgres(context) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await docker(context, [
      "exec", context.postgresContainer, "pg_isready", "-U", "postgres", "-d", "postgres"
    ], { allowFailure: true, timeoutMs: 5_000 });
    if (result.code === 0) {
      context.postgresReady = true;
      return;
    }
    await delay(250);
  }
  expectOk(false, "PostgreSQL 17 did not become ready");
}

async function waitForPostgrest(context) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await api(context, "/");
      if (response.status === 200) {
        context.postgrestReady = true;
        return;
      }
    } catch {}
    await delay(250);
  }
  expectOk(false, "PostgREST v14 did not become ready");
}

async function setupSchema(context, inputs) {
  await psql(context, `
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit nosuperuser nocreatedb nocreaterole noreplication bypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password ${quoteLiteral(context.postgresPassword)}
      nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end;
$$;
grant anon, authenticated, service_role to authenticator;
${fixtureSql(inputs.starterSchema.content, inputs.perUserMigration.content)}
${inputs.migration.content}

insert into public.workspaces(id, owner_user_id, name) values
  ('${WORKSPACES.a}', '${USERS.ownerA}', 'Synthetic Workspace A'),
  ('${WORKSPACES.b}', '${USERS.ownerB}', 'Synthetic Workspace B'),
  ('${WORKSPACES.metadataOnly}', '${USERS.outsider}', 'Synthetic metadata-only workspace');
insert into public.workspace_members(workspace_id, user_id, role) values
  ('${WORKSPACES.a}', '${USERS.ownerA}', 'owner'),
  ('${WORKSPACES.a}', '${USERS.adminA}', 'admin'),
  ('${WORKSPACES.a}', '${USERS.memberA}', 'member'),
  ('${WORKSPACES.a}', '${USERS.viewerA}', 'viewer'),
  ('${WORKSPACES.a}', '${USERS.multi}', 'member'),
  ('${WORKSPACES.b}', '${USERS.ownerB}', 'owner'),
  ('${WORKSPACES.b}', '${USERS.multi}', 'owner');
insert into public.connected_accounts(
  workspace_id, user_id, provider, platform, display_name, status, public_profile
) values (
  '${WORKSPACES.metadataOnly}', '${USERS.outsider}', 'synthetic-metadata', 'synthetic-metadata',
  'Synthetic global owner marker', 'connected', '{"global_role":"owner"}'::jsonb
);
`);
}

async function provisionRuntime(context, inputs, { faultAt = null } = {}) {
  await verifyResourceAbsence(context);
  await mkdir(context.tempDirectory);
  await writeFile(path.join(context.tempDirectory, MIGRATION_PATH), inputs.migration.content, "utf8");
  checkpoint(faultAt, "after_temp_directory");

  await docker(context, ["network", "create", "--label", RESOURCE_LABEL, context.network]);
  checkpoint(faultAt, "after_network_creation");
  await docker(context, ["volume", "create", "--label", RESOURCE_LABEL, context.volume]);

  await docker(context, postgresCreateArgs(context), { timeoutMs: 60_000 });
  checkpoint(faultAt, "after_postgres_container_creation");
  await docker(context, ["start", context.postgresContainer], { timeoutMs: 60_000 });
  checkpoint(faultAt, "after_postgres_start");
  await waitForPostgres(context);

  const copiedMigration = path.join(context.tempDirectory, MIGRATION_PATH);
  await docker(context, ["cp", copiedMigration, `${context.postgresContainer}:/tmp/${MIGRATION_PATH}`]);
  const copiedHash = await docker(context, [
    "exec", context.postgresContainer, "sha256sum", `/tmp/${MIGRATION_PATH}`
  ]);
  expectEqual(copiedHash.stdout.trim().split(/\s+/u)[0], inputs.migration.sha256);
  await setupSchema(context, inputs);
  checkpoint(faultAt, "after_schema_setup");

  context.port = await freeLoopbackPort();
  expectEqual(await isPortListening(context.port), false, "allocated loopback port is unexpectedly occupied");
  await docker(context, postgrestCreateArgs(context), { timeoutMs: 60_000 });
  checkpoint(faultAt, "after_postgrest_container_creation");
  await docker(context, ["start", context.postgrestContainer], { timeoutMs: 60_000 });
  await waitForPostgrest(context);
  checkpoint(faultAt, "after_postgrest_start");

  if (faultAt === "during_first_http_assertion") {
    const marker = registerSecret(`scv-fault-${randomBytes(12).toString("base64url")}`);
    const response = await rpc(context, jwt(context, "anon", USERS.ownerA), {
      actor: USERS.ownerA,
      workspace: WORKSPACES.a,
      action: "connect",
      envelope: makeEnvelope("fault-first-http").envelope,
      headers: { "X-Social-Cues-Synthetic-Marker": marker }
    });
    expectOk([401, 403, 404].includes(response.status), `unexpected fault-mode status ${response.status}`);
    checkpoint(faultAt, "during_first_http_assertion");
  }
}

async function runCleanupFaultInjections(inputs) {
  for (const faultAt of CLEANUP_FAULTS) {
    const context = createContext(`fault-${faultAt.replaceAll("_", "-")}`);
    let observed = null;
    let unexpected = null;
    try {
      await provisionRuntime(context, inputs, { faultAt });
      unexpected = new Error(`${faultAt} did not trigger`);
    } catch (error) {
      if (error.message === `INJECTED_${faultAt}`) observed = error.message;
      else unexpected = error;
    } finally {
      try { await cleanupContext(context); } catch (error) { unexpected ??= error; }
    }
    if (unexpected) throw unexpected;
    expectEqual(observed, `INJECTED_${faultAt}`);
    expectEqual(context.cleanupComplete, true, `${faultAt} cleanup was not verified`);
  }
}

function syntheticWorkspace(context) {
  context.workspaceCounter += 1;
  return `30000000-0000-4000-8000-${String(context.workspaceCounter).padStart(12, "0")}`;
}

async function seedWorkspace(context, workspace, actor = USERS.ownerA, role = "owner") {
  await psql(context, `
insert into public.workspaces(id, owner_user_id, name)
values ('${workspace}', '${actor}', 'Synthetic managed workspace ${workspace}');
insert into public.workspace_members(workspace_id, user_id, role)
values ('${workspace}', '${actor}', '${role}');
`);
}

async function connectionState(context, workspace, expectedEnvelope = null, oldEnvelope = null) {
  return queryJson(context, `
select pg_catalog.jsonb_build_object(
  'account_count', (
    select pg_catalog.count(*) from public.connected_accounts
    where workspace_id = '${workspace}'::uuid and provider = 'vizard' and platform = 'vizard'
  ),
  'account_id', (
    select id::text from public.connected_accounts
    where workspace_id = '${workspace}'::uuid and provider = 'vizard' and platform = 'vizard'
  ),
  'account_status', (
    select status from public.connected_accounts
    where workspace_id = '${workspace}'::uuid and provider = 'vizard' and platform = 'vizard'
  ),
  'verification_state', (
    select public_profile->>'verification_state' from public.connected_accounts
    where workspace_id = '${workspace}'::uuid and provider = 'vizard' and platform = 'vizard'
  ),
  'token_count', (
    select pg_catalog.count(*) from public.provider_tokens
    where workspace_id = '${workspace}'::uuid and provider = 'vizard' and token_kind = 'api_key'
  ),
  'token_matches', ${expectedEnvelope ? `(
    select pg_catalog.count(*) = 1 from public.provider_tokens
    where workspace_id = '${workspace}'::uuid and provider = 'vizard' and token_kind = 'api_key'
      and encrypted_token = ${jsonbLiteral(expectedEnvelope)}
  )` : "null::boolean"},
  'old_token_resolves', ${oldEnvelope ? `(
    select pg_catalog.count(*) from public.provider_tokens
    where workspace_id = '${workspace}'::uuid and provider = 'vizard' and token_kind = 'api_key'
      and encrypted_token = ${jsonbLiteral(oldEnvelope)}
  )` : "null::bigint"},
  'audit_count', (
    select pg_catalog.count(*) from public.audit_logs
    where workspace_id = '${workspace}'::uuid and provider = 'vizard'
  )
);
`);
}

async function stableSnapshot(context, workspace, expectedEnvelope) {
  return queryJson(context, `
select pg_catalog.jsonb_build_object(
  'account', (
    select pg_catalog.jsonb_build_object(
      'id', id::text,
      'user_id', user_id::text,
      'status', status,
      'profile', public_profile,
      'connected_at', connected_at,
      'last_sync_at', last_sync_at,
      'created_at', created_at,
      'updated_at', updated_at
    ) from public.connected_accounts
    where workspace_id = '${workspace}'::uuid and provider = 'vizard' and platform = 'vizard'
  ),
  'token', (
    select pg_catalog.jsonb_build_object(
      'id', id::text,
      'user_id', user_id::text,
      'provider', provider,
      'token_kind', token_kind,
      'token_type', token_type,
      'refresh_is_null', encrypted_refresh_token is null,
      'created_at', created_at,
      'updated_at', updated_at,
      'matches_expected', encrypted_token = ${jsonbLiteral(expectedEnvelope)}
    ) from public.provider_tokens
    where workspace_id = '${workspace}'::uuid and provider = 'vizard' and token_kind = 'api_key'
  ),
  'audit_count', (
    select pg_catalog.count(*) from public.audit_logs
    where workspace_id = '${workspace}'::uuid and provider = 'vizard'
  )
);
`);
}

async function testRuntimeVersions(context) {
  const databaseVersion = await queryScalar(context, "show server_version;");
  expectMatch(databaseVersion, /^17\./u);
  const apiVersion = await docker(context, ["exec", context.postgrestContainer, "postgrest", "--version"]);
  expectMatch(apiVersion.stdout, /PostgREST 14\.12/u);
  const logConfiguration = await queryJson(context, `
select pg_catalog.jsonb_build_object(
  'log_statement', pg_catalog.current_setting('log_statement'),
  'log_min_error_statement', pg_catalog.current_setting('log_min_error_statement'),
  'log_parameter_max_length_on_error', pg_catalog.current_setting('log_parameter_max_length_on_error')
);
`);
  expectDeepEqual(logConfiguration, {
    log_min_error_statement: "panic",
    log_parameter_max_length_on_error: "0",
    log_statement: "none"
  });
}

async function testExactRpcAndGrants(context, serviceToken) {
  const catalog = await queryJson(context, `
with target as (
  select p.*
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'social_cues_manage_vizard_connection'
), exact as (
  select * from target where pg_catalog.oidvectortypes(proargtypes) = 'uuid, uuid, text, jsonb'
)
select pg_catalog.jsonb_build_object(
  'function_count', (select pg_catalog.count(*) from target),
  'exact_count', (select pg_catalog.count(*) from exact),
  'identity_arguments', (select pg_catalog.pg_get_function_identity_arguments(oid) from exact),
  'security_definer', (select prosecdef from exact),
  'configuration', (select to_jsonb(proconfig) from exact),
  'public_execute', (
    select exists (
      select 1
      from pg_catalog.aclexplode(coalesce(e.proacl, pg_catalog.acldefault('f', e.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) from exact e
  ),
  'anon_execute', (select pg_catalog.has_function_privilege('anon', oid, 'EXECUTE') from exact),
  'authenticated_execute', (select pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE') from exact),
  'service_execute', (select pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE') from exact)
);
`);
  expectEqual(catalog.function_count, 1);
  expectEqual(catalog.exact_count, 1);
  expectEqual(catalog.identity_arguments, "p_actor_user_id uuid, p_workspace_id uuid, p_action text, p_encrypted_token jsonb");
  expectEqual(catalog.security_definer, false);
  expectOk(Array.isArray(catalog.configuration), "function configuration is missing");
  expectDeepEqual(catalog.configuration, ["search_path=\"\""]);
  expectEqual(catalog.public_execute, false);
  expectEqual(catalog.anon_execute, false);
  expectEqual(catalog.authenticated_execute, false);
  expectEqual(catalog.service_execute, true);

  const openApi = await api(context, "/", {
    token: serviceToken,
    headers: { Accept: "application/openapi+json" }
  });
  expectEqual(openApi.status, 200, openApi.text);
  const operation = openApi.body?.paths?.[RPC_PATH]?.post;
  expectOk(operation, "OpenAPI does not expose the exact RPC route to service_role");
  const operationText = JSON.stringify(operation);
  for (const argument of RPC_ARGUMENTS) expectOk(operationText.includes(argument), `OpenAPI omits ${argument}`);

  const extraEnvelope = makeEnvelope("caller-selected-provider").envelope;
  const workspace = syntheticWorkspace(context);
  await seedWorkspace(context, workspace);
  const unsafeBody = await rpc(context, serviceToken, {
    actor: USERS.ownerA,
    workspace,
    action: "connect",
    envelope: extraEnvelope,
    extra: { p_provider: "other", p_token_kind: "oauth" }
  });
  assertHttpFailure(unsafeBody);
  const state = await connectionState(context, workspace);
  expectEqual(state.account_count, 0);
  expectEqual(state.token_count, 0);
  expectEqual(state.audit_count, 0);
}

async function testBrowserRoleBoundary(context, anonToken, authenticatedToken) {
  const envelope = makeEnvelope("browser-boundary").envelope;
  for (const [role, token] of [["anon", anonToken], ["authenticated", authenticatedToken]]) {
    for (const action of ["connect", "replace", "disconnect"]) {
      const response = await rpc(context, token, {
        actor: USERS.ownerA,
        workspace: WORKSPACES.a,
        action,
        envelope: action === "disconnect" ? null : envelope
      });
      expectOk([401, 403, 404].includes(response.status), `${role} ${action} unexpectedly returned ${response.status}`);
      assertSecretsAbsent(response.text, `${role} ${action} denial`);
    }
  }

  const anonExisting = await rpc(context, anonToken, {
    actor: USERS.ownerA,
    workspace: WORKSPACES.a,
    action: "connect",
    envelope
  });
  const anonMissing = await rpc(context, anonToken, {
    actor: USERS.ownerA,
    workspace: WORKSPACES.missing,
    action: "connect",
    envelope
  });
  expectEqual(anonExisting.status, anonMissing.status);
  expectEqual(anonExisting.body?.message, anonMissing.body?.message);
  expectEqual(anonExisting.text.includes(WORKSPACES.a), false);
  expectEqual(anonMissing.text.includes(WORKSPACES.missing), false);
}

async function testWorkspaceRoleMatrix(context, serviceToken) {
  const initial = makeEnvelope("role-owner-connect").envelope;
  const ownerConnect = await rpc(context, serviceToken, {
    actor: USERS.ownerA,
    workspace: WORKSPACES.a,
    action: "connect",
    envelope: initial
  });
  const ownerRow = assertSafeRpcResponse(ownerConnect, {
    workspace: WORKSPACES.a,
    connectionState: "pending_verification",
    verificationState: "pending"
  });

  const adminConnect = await rpc(context, serviceToken, {
    actor: USERS.adminA,
    workspace: WORKSPACES.a,
    action: "connect",
    envelope: initial
  });
  assertSafeRpcResponse(adminConnect, {
    workspace: WORKSPACES.a,
    connectionState: "pending_verification",
    verificationState: "pending",
    accountId: ownerRow.connected_account_id
  });

  const deniedActors = [USERS.memberA, USERS.viewerA, USERS.outsider, USERS.ownerB, USERS.multi];
  const deniedReplacement = makeEnvelope("role-denied-replacement").envelope;
  for (const actor of deniedActors) {
    for (const action of ["connect", "replace", "disconnect"]) {
      const before = await stableSnapshot(context, WORKSPACES.a, initial);
      const response = await rpc(context, serviceToken, {
        actor,
        workspace: WORKSPACES.a,
        action,
        envelope: action === "disconnect" ? null : (action === "connect" ? initial : deniedReplacement)
      });
      expectEqual(response.status, 403);
      expectEqual(response.body?.message, "VIZARD_CONNECTION_NOT_AUTHORIZED");
      expectDeepEqual(await stableSnapshot(context, WORKSPACES.a, initial), before);
    }
  }

  const ownerAcrossWorkspace = await rpc(context, serviceToken, {
    actor: USERS.ownerA,
    workspace: WORKSPACES.b,
    action: "connect",
    envelope: deniedReplacement
  });
  expectEqual(ownerAcrossWorkspace.status, 403);
  expectEqual(ownerAcrossWorkspace.body?.message, "VIZARD_CONNECTION_NOT_AUTHORIZED");

  const metadataAuthority = await rpc(context, serviceToken, {
    actor: USERS.outsider,
    workspace: WORKSPACES.metadataOnly,
    action: "connect",
    envelope: deniedReplacement
  });
  expectEqual(metadataAuthority.status, 403);
  expectEqual(metadataAuthority.body?.message, "VIZARD_CONNECTION_NOT_AUTHORIZED");

  const foreignFailure = await rpc(context, serviceToken, {
    actor: USERS.ownerA,
    workspace: WORKSPACES.b,
    action: "disconnect",
    envelope: null
  });
  const missingFailure = await rpc(context, serviceToken, {
    actor: USERS.ownerA,
    workspace: WORKSPACES.missing,
    action: "disconnect",
    envelope: null
  });
  expectEqual(foreignFailure.status, missingFailure.status);
  expectEqual(foreignFailure.body?.message, missingFailure.body?.message);
  expectEqual(foreignFailure.body?.message, "VIZARD_CONNECTION_NOT_AUTHORIZED");

  const adminReplacement = makeEnvelope("role-admin-replace").envelope;
  const adminReplace = await rpc(context, serviceToken, {
    actor: USERS.adminA,
    workspace: WORKSPACES.a,
    action: "replace",
    envelope: adminReplacement
  });
  assertSafeRpcResponse(adminReplace, {
    workspace: WORKSPACES.a,
    connectionState: "pending_verification",
    verificationState: "pending",
    accountId: ownerRow.connected_account_id
  });

  const ownerDisconnect = await rpc(context, serviceToken, {
    actor: USERS.ownerA,
    workspace: WORKSPACES.a,
    action: "disconnect",
    envelope: null
  });
  assertSafeRpcResponse(ownerDisconnect, {
    workspace: WORKSPACES.a,
    connectionState: "not_connected",
    verificationState: "not_verified",
    accountId: ownerRow.connected_account_id
  });

  const reconnectEnvelope = makeEnvelope("role-owner-reconnect").envelope;
  const ownerReconnect = await rpc(context, serviceToken, {
    actor: USERS.ownerA,
    workspace: WORKSPACES.a,
    action: "connect",
    envelope: reconnectEnvelope
  });
  assertSafeRpcResponse(ownerReconnect, {
    workspace: WORKSPACES.a,
    connectionState: "pending_verification",
    verificationState: "pending",
    accountId: ownerRow.connected_account_id
  });
  const adminDisconnect = await rpc(context, serviceToken, {
    actor: USERS.adminA,
    workspace: WORKSPACES.a,
    action: "disconnect",
    envelope: null
  });
  assertSafeRpcResponse(adminDisconnect, {
    workspace: WORKSPACES.a,
    connectionState: "not_connected",
    verificationState: "not_verified",
    accountId: ownerRow.connected_account_id
  });
}

async function testBrowserTokenBoundary(context, anonToken, authenticatedToken, serviceToken) {
  const workspace = syntheticWorkspace(context);
  await seedWorkspace(context, workspace);
  const encrypted = makeEnvelope("browser-token-boundary").envelope;
  const connected = await rpc(context, serviceToken, {
    actor: USERS.ownerA,
    workspace,
    action: "connect",
    envelope: encrypted
  });
  assertSafeRpcResponse(connected, {
    workspace,
    connectionState: "pending_verification",
    verificationState: "pending"
  });
  const beforeCount = await queryScalar(context, `select pg_catalog.count(*)::text from public.provider_tokens;`);
  for (const [role, token] of [["anon", anonToken], ["authenticated", authenticatedToken]]) {
    const attempts = [
      ["GET", "/provider_tokens?select=*", null],
      ["POST", "/provider_tokens", { workspace_id: workspace }],
      ["PATCH", `/provider_tokens?workspace_id=eq.${workspace}`, { token_type: "oauth" }],
      ["DELETE", `/provider_tokens?workspace_id=eq.${workspace}`, null]
    ];
    for (const [method, pathname, body] of attempts) {
      const response = await api(context, pathname, {
        method,
        token,
        body,
        headers: { Prefer: "return=representation" }
      });
      expectOk([401, 403, 404, 405].includes(response.status), `${role} ${method} provider_tokens returned ${response.status}`);
      assertSecretsAbsent(response.text, `${role} provider_tokens denial`);
    }
  }
  expectEqual(await queryScalar(context, `select pg_catalog.count(*)::text from public.provider_tokens;`), beforeCount);

  const privileges = await queryJson(context, `
select pg_catalog.jsonb_build_object(
  'rls', (select relrowsecurity from pg_catalog.pg_class where oid = 'public.provider_tokens'::regclass),
  'anon_select', pg_catalog.has_table_privilege('anon', 'public.provider_tokens', 'SELECT'),
  'anon_insert', pg_catalog.has_table_privilege('anon', 'public.provider_tokens', 'INSERT'),
  'anon_update', pg_catalog.has_table_privilege('anon', 'public.provider_tokens', 'UPDATE'),
  'anon_delete', pg_catalog.has_table_privilege('anon', 'public.provider_tokens', 'DELETE'),
  'auth_select', pg_catalog.has_table_privilege('authenticated', 'public.provider_tokens', 'SELECT'),
  'auth_insert', pg_catalog.has_table_privilege('authenticated', 'public.provider_tokens', 'INSERT'),
  'auth_update', pg_catalog.has_table_privilege('authenticated', 'public.provider_tokens', 'UPDATE'),
  'auth_delete', pg_catalog.has_table_privilege('authenticated', 'public.provider_tokens', 'DELETE')
);
`);
  expectDeepEqual(privileges, {
    anon_delete: false,
    anon_insert: false,
    anon_select: false,
    anon_update: false,
    auth_delete: false,
    auth_insert: false,
    auth_select: false,
    auth_update: false,
    rls: true
  });
}

async function testConnectLifecycle(context, serviceToken) {
  const workspace = syntheticWorkspace(context);
  await seedWorkspace(context, workspace);
  const initial = makeEnvelope("connect-initial").envelope;
  const first = await rpc(context, serviceToken, {
    actor: USERS.ownerA, workspace, action: "connect", envelope: initial
  });
  const firstRow = assertSafeRpcResponse(first, {
    workspace, connectionState: "pending_verification", verificationState: "pending"
  });
  let state = await connectionState(context, workspace, initial);
  expectEqual(state.account_count, 1);
  expectEqual(state.token_count, 1);
  expectEqual(state.token_matches, true);
  expectEqual(state.account_status, "pending_verification");

  const repeated = await rpc(context, serviceToken, {
    actor: USERS.ownerA, workspace, action: "connect", envelope: initial
  });
  assertSafeRpcResponse(repeated, {
    workspace,
    connectionState: "pending_verification",
    verificationState: "pending",
    accountId: firstRow.connected_account_id
  });
  state = await connectionState(context, workspace, initial);
  expectEqual(state.account_count, 1);
  expectEqual(state.token_count, 1);

  const disconnected = await rpc(context, serviceToken, {
    actor: USERS.ownerA, workspace, action: "disconnect", envelope: null
  });
  assertSafeRpcResponse(disconnected, {
    workspace,
    connectionState: "not_connected",
    verificationState: "not_verified",
    accountId: firstRow.connected_account_id
  });
  const reconnectEnvelope = makeEnvelope("connect-reuse-disconnected").envelope;
  const reconnected = await rpc(context, serviceToken, {
    actor: USERS.ownerA, workspace, action: "connect", envelope: reconnectEnvelope
  });
  assertSafeRpcResponse(reconnected, {
    workspace,
    connectionState: "pending_verification",
    verificationState: "pending",
    accountId: firstRow.connected_account_id
  });
  state = await connectionState(context, workspace, reconnectEnvelope, initial);
  expectEqual(state.account_count, 1);
  expectEqual(state.token_count, 1);
  expectEqual(state.token_matches, true);
  expectEqual(state.old_token_resolves, 0);
}

async function testReplaceLifecycle(context, serviceToken) {
  const workspace = syntheticWorkspace(context);
  await seedWorkspace(context, workspace);
  const initial = makeEnvelope("replace-initial").envelope;
  const replacement = makeEnvelope("replace-success").envelope;
  const first = await rpc(context, serviceToken, {
    actor: USERS.ownerA, workspace, action: "connect", envelope: initial
  });
  const firstRow = assertSafeRpcResponse(first, {
    workspace, connectionState: "pending_verification", verificationState: "pending"
  });
  const replaced = await rpc(context, serviceToken, {
    actor: USERS.ownerA, workspace, action: "replace", envelope: replacement
  });
  assertSafeRpcResponse(replaced, {
    workspace,
    connectionState: "pending_verification",
    verificationState: "pending",
    accountId: firstRow.connected_account_id
  });
  let state = await connectionState(context, workspace, replacement, initial);
  expectEqual(state.account_count, 1);
  expectEqual(state.token_count, 1);
  expectEqual(state.token_matches, true);
  expectEqual(state.old_token_resolves, 0);
  expectEqual(state.verification_state, "pending");

  const beforeFailure = await stableSnapshot(context, workspace, replacement);
  const malformedMarker = registerSecret(`scv-replace-failure-${randomBytes(10).toString("base64url")}`);
  const failed = await rpc(context, serviceToken, {
    actor: USERS.ownerA,
    workspace,
    action: "replace",
    envelope: { ...replacement, extra: malformedMarker },
    headers: { "X-Social-Cues-Synthetic-Marker": malformedMarker }
  });
  expectEqual(failed.status, 400);
  expectEqual(failed.body?.message, "VIZARD_CONNECTION_ENVELOPE_INVALID");
  expectDeepEqual(await stableSnapshot(context, workspace, replacement), beforeFailure);
}

async function testDisconnectLifecycle(context, serviceToken) {
  const workspace = syntheticWorkspace(context);
  await seedWorkspace(context, workspace);
  const initial = makeEnvelope("disconnect-initial").envelope;
  const first = await rpc(context, serviceToken, {
    actor: USERS.ownerA, workspace, action: "connect", envelope: initial
  });
  const firstRow = assertSafeRpcResponse(first, {
    workspace, connectionState: "pending_verification", verificationState: "pending"
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const disconnected = await rpc(context, serviceToken, {
      actor: USERS.ownerA, workspace, action: "disconnect", envelope: null
    });
    assertSafeRpcResponse(disconnected, {
      workspace,
      connectionState: "not_connected",
      verificationState: "not_verified",
      accountId: firstRow.connected_account_id
    });
    const state = await connectionState(context, workspace, null, initial);
    expectEqual(state.account_count, 1);
    expectEqual(state.token_count, 0);
    expectEqual(state.account_status, "not_connected");
    expectEqual(state.verification_state, "not_verified");
    expectEqual(state.old_token_resolves, 0);
  }
}

function malformedEnvelopeCases() {
  const makeCase = (name, mutate) => {
    const marker = registerSecret(`scv-malformed-${name}-${randomBytes(9).toString("base64url")}`);
    const valid = makeEnvelope(`malformed-${name}`).envelope;
    return { name, marker, value: mutate(structuredClone(valid), marker) };
  };
  return [
    makeCase("missing-alg", value => { delete value.alg; return value; }),
    makeCase("missing-iv", value => { delete value.iv; return value; }),
    makeCase("missing-tag", value => { delete value.tag; return value; }),
    makeCase("missing-value", value => { delete value.value; return value; }),
    makeCase("blank-fields", () => ({ alg: "", iv: "", tag: "", value: "" })),
    makeCase("wrong-algorithm", (value, marker) => ({ ...value, alg: marker })),
    makeCase("invalid-base64url", (value, marker) => ({ ...value, value: `${marker}!` })),
    makeCase("invalid-iv-length", (value, marker) => ({ ...value, iv: marker })),
    makeCase("invalid-tag-length", (value, marker) => ({ ...value, tag: marker })),
    makeCase("invalid-ciphertext-length", (value, marker) => ({
      ...value,
      value: `${marker}${"A".repeat(Math.max(0, 4097 - marker.length))}`
    })),
    makeCase("extra-property", (value, marker) => ({ ...value, extra: marker })),
    makeCase("plaintext-shaped", (_value, marker) => ({ apiKey: marker })),
    makeCase("empty-object", () => ({})),
    makeCase("array", (_value, marker) => [marker]),
    makeCase("string", (_value, marker) => marker),
    makeCase("json-null", () => null)
  ];
}

async function testMalformedEnvelopeMatrix(context, serviceToken) {
  const cases = malformedEnvelopeCases();
  expectEqual(cases.length, 16);
  for (const testCase of cases) {
    const connectWorkspace = syntheticWorkspace(context);
    await seedWorkspace(context, connectWorkspace);
    const connectFailure = await rpc(context, serviceToken, {
      actor: USERS.ownerA,
      workspace: connectWorkspace,
      action: "connect",
      envelope: testCase.value,
      headers: { "X-Social-Cues-Synthetic-Marker": testCase.marker }
    });
    expectEqual(connectFailure.status, 400, `${testCase.name} connect status`);
    expectEqual(connectFailure.body?.message, "VIZARD_CONNECTION_ENVELOPE_INVALID");
    const connectState = await connectionState(context, connectWorkspace);
    expectEqual(connectState.account_count, 0);
    expectEqual(connectState.token_count, 0);
    expectEqual(connectState.audit_count, 0);

    const replaceWorkspace = syntheticWorkspace(context);
    await seedWorkspace(context, replaceWorkspace);
    const original = makeEnvelope(`malformed-replace-original-${testCase.name}`).envelope;
    const connected = await rpc(context, serviceToken, {
      actor: USERS.ownerA,
      workspace: replaceWorkspace,
      action: "connect",
      envelope: original
    });
    assertSafeRpcResponse(connected, {
      workspace: replaceWorkspace,
      connectionState: "pending_verification",
      verificationState: "pending"
    });
    const before = await stableSnapshot(context, replaceWorkspace, original);
    const replaceFailure = await rpc(context, serviceToken, {
      actor: USERS.ownerA,
      workspace: replaceWorkspace,
      action: "replace",
      envelope: testCase.value,
      headers: { "X-Social-Cues-Synthetic-Marker": testCase.marker }
    });
    expectEqual(replaceFailure.status, 400, `${testCase.name} replace status`);
    expectEqual(replaceFailure.body?.message, "VIZARD_CONNECTION_ENVELOPE_INVALID");
    expectDeepEqual(await stableSnapshot(context, replaceWorkspace, original), before);
  }
}

async function installFailureTrigger(context, {
  triggerName,
  table,
  event,
  condition,
  message,
  timing = "before"
}) {
  const functionName = `${triggerName}_fn`;
  await psql(context, `
create function public.${functionName}()
returns trigger language plpgsql set search_path = '' as $$
begin
  if ${condition} then
    raise exception using errcode = 'P0001', message = '${message}';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger ${triggerName}
${timing} ${event} on public.${table}
for each row execute function public.${functionName}();
`);
  return async () => {
    await psql(context, `
drop trigger ${triggerName} on public.${table};
drop function public.${functionName}();
`);
  };
}

async function expectRpcTriggerFailure(context, serviceToken, options, expectedMessage) {
  const response = await rpc(context, serviceToken, options);
  expectOk([400, 409, 500].includes(response.status), `unexpected rollback status ${response.status}`);
  expectEqual(response.body?.message, expectedMessage);
  assertSecretsAbsent(response.text, expectedMessage);
}

async function testRollbackMatrix(context, serviceToken) {
  const connectScenarios = [
    {
      name: "account",
      table: "connected_accounts",
      event: "insert",
      condition: workspace => `new.workspace_id = '${workspace}'::uuid`,
      message: "TEST_CONNECT_ACCOUNT_WRITE_FAILURE"
    },
    {
      name: "token",
      table: "provider_tokens",
      event: "insert",
      condition: workspace => `new.workspace_id = '${workspace}'::uuid`,
      message: "TEST_CONNECT_TOKEN_WRITE_FAILURE"
    },
    {
      name: "audit",
      table: "audit_logs",
      event: "insert",
      condition: workspace => `new.workspace_id = '${workspace}'::uuid and new.event_type = 'vizard.connection.connected'`,
      message: "TEST_CONNECT_AUDIT_WRITE_FAILURE"
    }
  ];
  for (const scenario of connectScenarios) {
    const workspace = syntheticWorkspace(context);
    await seedWorkspace(context, workspace);
    const envelope = makeEnvelope(`rollback-connect-${scenario.name}`).envelope;
    const dropTrigger = await installFailureTrigger(context, {
      triggerName: `scv_test_connect_${scenario.name}`,
      table: scenario.table,
      event: scenario.event,
      condition: scenario.condition(workspace),
      message: scenario.message
    });
    try {
      await expectRpcTriggerFailure(context, serviceToken, {
        actor: USERS.ownerA, workspace, action: "connect", envelope
      }, scenario.message);
      const state = await connectionState(context, workspace);
      expectEqual(state.account_count, 0);
      expectEqual(state.token_count, 0);
      expectEqual(state.audit_count, 0);
    } finally {
      await dropTrigger();
    }
  }

  for (const scenario of [
    {
      name: "token",
      table: "provider_tokens",
      event: "update",
      condition: workspace => `new.workspace_id = '${workspace}'::uuid`,
      message: "TEST_REPLACE_TOKEN_WRITE_FAILURE"
    },
    {
      name: "audit",
      table: "audit_logs",
      event: "insert",
      condition: workspace => `new.workspace_id = '${workspace}'::uuid and new.event_type = 'vizard.connection.replaced'`,
      message: "TEST_REPLACE_AUDIT_WRITE_FAILURE"
    }
  ]) {
    const workspace = syntheticWorkspace(context);
    await seedWorkspace(context, workspace);
    const original = makeEnvelope(`rollback-replace-${scenario.name}-original`).envelope;
    const replacement = makeEnvelope(`rollback-replace-${scenario.name}-new`).envelope;
    await rpc(context, serviceToken, {
      actor: USERS.ownerA, workspace, action: "connect", envelope: original
    });
    const before = await stableSnapshot(context, workspace, original);
    const dropTrigger = await installFailureTrigger(context, {
      triggerName: `scv_test_replace_${scenario.name}`,
      table: scenario.table,
      event: scenario.event,
      condition: scenario.condition(workspace),
      message: scenario.message
    });
    try {
      await expectRpcTriggerFailure(context, serviceToken, {
        actor: USERS.ownerA, workspace, action: "replace", envelope: replacement
      }, scenario.message);
      expectDeepEqual(await stableSnapshot(context, workspace, original), before);
    } finally {
      await dropTrigger();
    }
  }

  const workspace = syntheticWorkspace(context);
  await seedWorkspace(context, workspace);
  const original = makeEnvelope("rollback-disconnect-original").envelope;
  await rpc(context, serviceToken, {
    actor: USERS.ownerA, workspace, action: "connect", envelope: original
  });
  const before = await stableSnapshot(context, workspace, original);
  const dropTrigger = await installFailureTrigger(context, {
    triggerName: "scv_test_disconnect_audit",
    table: "audit_logs",
    event: "insert",
    condition: `new.workspace_id = '${workspace}'::uuid and new.event_type = 'vizard.connection.disconnected'`,
    message: "TEST_DISCONNECT_AUDIT_WRITE_FAILURE"
  });
  try {
    await expectRpcTriggerFailure(context, serviceToken, {
      actor: USERS.ownerA, workspace, action: "disconnect", envelope: null
    }, "TEST_DISCONNECT_AUDIT_WRITE_FAILURE");
    expectDeepEqual(await stableSnapshot(context, workspace, original), before);
  } finally {
    await dropTrigger();
  }

  expectEqual(await queryScalar(context, `
select pg_catalog.count(*)::text
from pg_catalog.pg_trigger
where not tgisinternal and tgname like 'scv_test_%';
`), "0");
}

async function installSleepTrigger(context, { name, table, event, condition }) {
  const functionName = `${name}_fn`;
  await psql(context, `
create function public.${functionName}()
returns trigger language plpgsql set search_path = '' as $$
begin
  if ${condition} then perform pg_catalog.pg_sleep(0.35); end if;
  return coalesce(new, old);
end;
$$;
create trigger ${name} before ${event} on public.${table}
for each row execute function public.${functionName}();
`);
  return async () => psql(context, `
drop trigger ${name} on public.${table};
drop function public.${functionName}();
`);
}

async function testHttpConcurrency(context, serviceToken) {
  const connectWorkspace = syntheticWorkspace(context);
  await seedWorkspace(context, connectWorkspace);
  const connectEnvelope = makeEnvelope("concurrent-connect").envelope;
  let dropTrigger = await installSleepTrigger(context, {
    name: "scv_test_sleep_connect",
    table: "connected_accounts",
    event: "insert",
    condition: `new.workspace_id = '${connectWorkspace}'::uuid`
  });
  try {
    const results = await Promise.all([
      rpc(context, serviceToken, {
        actor: USERS.ownerA, workspace: connectWorkspace, action: "connect", envelope: connectEnvelope
      }),
      rpc(context, serviceToken, {
        actor: USERS.ownerA, workspace: connectWorkspace, action: "connect", envelope: connectEnvelope
      })
    ]);
    for (const response of results) expectEqual(response.status, 200, response.text);
  } finally {
    await dropTrigger();
  }
  let state = await connectionState(context, connectWorkspace, connectEnvelope);
  expectEqual(state.account_count, 1);
  expectEqual(state.token_count, 1);
  expectEqual(state.token_matches, true);

  const replaceWorkspace = syntheticWorkspace(context);
  await seedWorkspace(context, replaceWorkspace);
  const initial = makeEnvelope("concurrent-replace-initial").envelope;
  const replacementOne = makeEnvelope("concurrent-replace-one").envelope;
  const replacementTwo = makeEnvelope("concurrent-replace-two").envelope;
  const connected = await rpc(context, serviceToken, {
    actor: USERS.ownerA, workspace: replaceWorkspace, action: "connect", envelope: initial
  });
  const stableAccountId = connected.body?.[0]?.connected_account_id;
  dropTrigger = await installSleepTrigger(context, {
    name: "scv_test_sleep_replace",
    table: "provider_tokens",
    event: "update",
    condition: `new.workspace_id = '${replaceWorkspace}'::uuid`
  });
  try {
    const results = await Promise.all([
      rpc(context, serviceToken, {
        actor: USERS.ownerA, workspace: replaceWorkspace, action: "replace", envelope: replacementOne
      }),
      rpc(context, serviceToken, {
        actor: USERS.ownerA, workspace: replaceWorkspace, action: "replace", envelope: replacementTwo
      })
    ]);
    for (const response of results) {
      assertSafeRpcResponse(response, {
        workspace: replaceWorkspace,
        connectionState: "pending_verification",
        verificationState: "pending",
        accountId: stableAccountId
      });
    }
  } finally {
    await dropTrigger();
  }
  const replaceFinal = await queryJson(context, `
select pg_catalog.jsonb_build_object(
  'accounts', (select pg_catalog.count(*) from public.connected_accounts where workspace_id = '${replaceWorkspace}'::uuid and provider = 'vizard'),
  'tokens', (select pg_catalog.count(*) from public.provider_tokens where workspace_id = '${replaceWorkspace}'::uuid and token_kind = 'api_key'),
  'stable_account', (select id::text = '${stableAccountId}' from public.connected_accounts where workspace_id = '${replaceWorkspace}'::uuid and provider = 'vizard'),
  'complete_replacement', (select encrypted_token in (${jsonbLiteral(replacementOne)}, ${jsonbLiteral(replacementTwo)}) from public.provider_tokens where workspace_id = '${replaceWorkspace}'::uuid and token_kind = 'api_key')
);
`);
  expectDeepEqual(replaceFinal, {
    accounts: 1,
    complete_replacement: true,
    stable_account: true,
    tokens: 1
  });

  const raceWorkspace = syntheticWorkspace(context);
  await seedWorkspace(context, raceWorkspace);
  const raceEnvelope = makeEnvelope("connect-disconnect-race").envelope;
  dropTrigger = await installSleepTrigger(context, {
    name: "scv_test_sleep_race",
    table: "connected_accounts",
    event: "insert",
    condition: `new.workspace_id = '${raceWorkspace}'::uuid`
  });
  try {
    const results = await Promise.all([
      rpc(context, serviceToken, {
        actor: USERS.ownerA, workspace: raceWorkspace, action: "connect", envelope: raceEnvelope
      }),
      rpc(context, serviceToken, {
        actor: USERS.ownerA, workspace: raceWorkspace, action: "disconnect", envelope: null
      })
    ]);
    for (const response of results) expectEqual(response.status, 200, response.text);
  } finally {
    await dropTrigger();
  }
  state = await connectionState(context, raceWorkspace, raceEnvelope);
  const validConnected = state.account_count === 1
    && state.account_status === "pending_verification"
    && state.token_count === 1
    && state.token_matches === true;
  const validDisconnected = (state.account_count === 0 && state.token_count === 0)
    || (state.account_count === 1 && state.account_status === "not_connected" && state.token_count === 0);
  expectEqual(validConnected || validDisconnected, true, "connect/disconnect race left an invalid state");
  expectEqual(await queryScalar(context, `
select pg_catalog.count(*)::text from pg_catalog.pg_locks where locktype = 'advisory';
`), "0");
  expectEqual(await queryScalar(context, `
select pg_catalog.count(*)::text from pg_catalog.pg_trigger
where not tgisinternal and tgname like 'scv_test_%';
`), "0");
}

async function testRlsState(context) {
  const state = await queryJson(context, `
select pg_catalog.jsonb_object_agg(c.relname, c.relrowsecurity order by c.relname)
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('workspaces', 'workspace_members', 'connected_accounts', 'provider_tokens', 'billing_entitlements', 'audit_logs');
`);
  expectDeepEqual(state, {
    audit_logs: true,
    billing_entitlements: true,
    connected_accounts: true,
    provider_tokens: true,
    workspace_members: true,
    workspaces: true
  });
}

async function testAuditSafety(context) {
  const sensitiveKeys = [
    "alg", "iv", "tag", "value", "encrypted_token", "encrypted_refresh_token",
    "credential", "api_key", "apiKey", "token_row", "fingerprint", "key_length"
  ];
  const secretPredicates = [...redactions]
    .filter(secret => secret.length >= 8)
    .map(secret => `pg_catalog.strpos(pg_catalog.row_to_json(al)::text, ${quoteLiteral(secret)}) > 0`);
  const unsafe = await queryScalar(context, `
select pg_catalog.count(*)::text
from public.audit_logs al
where al.provider = 'vizard'
  and (
    al.metadata ?| array[${sensitiveKeys.map(quoteLiteral).join(", ")}]
    or pg_catalog.row_to_json(al)::text ~ '"(alg|iv|tag|value|encrypted_token|encrypted_refresh_token|credential|api_key|apiKey|token_row|fingerprint|key_length)"[[:space:]]*:'
    or exists (
      select 1 from public.provider_tokens pt
      where pt.provider = 'vizard'
        and (
          pg_catalog.strpos(pg_catalog.row_to_json(al)::text, pt.id::text) > 0
          or pg_catalog.strpos(pg_catalog.row_to_json(al)::text, pt.encrypted_token::text) > 0
          or pg_catalog.strpos(pg_catalog.row_to_json(al)::text, pg_catalog.row_to_json(pt)::text) > 0
        )
    )
    ${secretPredicates.length ? `or ${secretPredicates.join("\n    or ")}` : ""}
  );
`);
  expectEqual(unsafe, "0", "audit rows contain credential material");
}

async function writeAndScanReport(context) {
  const report = {
    ok: true,
    runtime: "disposable Docker PostgreSQL and PostgREST",
    runtimeHttpProof: true,
    runtimePostgresCatalogProof: true,
    staticContractProof: false,
    productionSupabaseRequests: 0,
    providerRequests: 0,
    malformedEnvelopeCases: 16,
    rollbackCases: 6,
    concurrencyCases: 3,
    cleanupFaultModes: CLEANUP_FAULTS.length,
    productionOnlyUnknowns: [
      "Supabase advisor state",
      "production schema drift",
      "production logging configuration",
      "production JWT gateway behavior"
    ]
  };
  const serialized = JSON.stringify(report, null, 2);
  assertSecretsAbsent(serialized, "generated report");
  await writeFile(path.join(context.tempDirectory, "postgrest-runtime-report.json"), serialized, "utf8");
  await scanDirectorySecrets(context.tempDirectory, "generated test report");
}

async function cleanupAllContexts() {
  const failures = [];
  for (const context of [...activeContexts]) {
    try { await cleanupContext(context); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new Error(redact(failures.map(error => error.message).join("\n")));
}

async function handleSignal(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  try { await cleanupAllContexts(); } finally { process.exit(signal === "SIGINT" ? 130 : 143); }
}

async function runHarness() {
process.once("SIGINT", () => { void handleSignal("SIGINT"); });
process.once("SIGTERM", () => { void handleSignal("SIGTERM"); });

let runtimeFailure = null;
let cleanupFailure = null;
let primaryContext = null;
let inputs = null;

try {
  inputs = await verifyCommittedInputs();
  await check("approved committed migration and unchanged prerequisite artifacts", async () => {
    expectEqual(inputs.migration.blob, EXPECTED_MIGRATION_BLOB);
    expectEqual(inputs.migration.sha256, EXPECTED_MIGRATION_SHA256);
    expectEqual(inputs.runtimeHarness.blob, EXPECTED_RUNTIME_HARNESS_BLOB);
  });
  await check("scoped Vizard package preflight accepts unrelated changes and rejects owned mutations", async () => {
    runScopedPreflightRegressionTests(inputs);
  });
  await Promise.all([ensureImage(POSTGRES_IMAGE), ensureImage(POSTGREST_IMAGE)]);
  await check("verified cleanup after eight injected partial-start failures", async () => {
    await runCleanupFaultInjections(inputs);
  });

  primaryContext = createContext("matrix");
  await provisionRuntime(primaryContext, inputs);
  const serviceToken = jwt(primaryContext, "service_role", USERS.ownerA);
  const anonToken = jwt(primaryContext, "anon", USERS.ownerA);
  const authenticatedToken = jwt(primaryContext, "authenticated", USERS.ownerA);

  await check("PostgreSQL and PostgREST versions with non-echoing database logs", async () => {
    await testRuntimeVersions(primaryContext);
  });
  await check("exact HTTP RPC signature, catalog grants, invoker mode, and search path", async () => {
    await testExactRpcAndGrants(primaryContext, serviceToken);
  });
  await check("anonymous and authenticated roles cannot bypass the service-role RPC boundary", async () => {
    await testBrowserRoleBoundary(primaryContext, anonToken, authenticatedToken);
  });
  await check("owner, admin, member, viewer, outsider, and cross-workspace authorization matrix", async () => {
    await testWorkspaceRoleMatrix(primaryContext, serviceToken);
  });
  await check("browser roles cannot read or mutate provider token rows", async () => {
    await testBrowserTokenBoundary(primaryContext, anonToken, authenticatedToken, serviceToken);
  });
  await check("connect, repeat-connect, disconnected-account reuse, and stable identity through HTTP", async () => {
    await testConnectLifecycle(primaryContext, serviceToken);
  });
  await check("replace preserves identity, rotates one token, and rolls back malformed input", async () => {
    await testReplaceLifecycle(primaryContext, serviceToken);
  });
  await check("disconnect retains identity, removes tokens, and is idempotent", async () => {
    await testDisconnectLifecycle(primaryContext, serviceToken);
  });
  await check("sixteen malformed-envelope connect and replace cases roll back through HTTP", async () => {
    await testMalformedEnvelopeMatrix(primaryContext, serviceToken);
  });
  await check("account, token, and audit trigger failures roll back connect, replace, and disconnect", async () => {
    await testRollbackMatrix(primaryContext, serviceToken);
  });
  await check("concurrent HTTP connect, replace, and connect-disconnect calls leave complete states", async () => {
    await testHttpConcurrency(primaryContext, serviceToken);
  });
  await check("RLS remains enabled on every fixture table", async () => {
    await testRlsState(primaryContext);
  });
  await check("audit rows, HTTP responses, reports, and runtime logs exclude credential material", async () => {
    await testAuditSafety(primaryContext);
    await scanContainerLogs(primaryContext);
    await writeAndScanReport(primaryContext);
    assertSecretsAbsent(primaryContext.httpResponses.map(response => response.text).join("\n"), "all HTTP responses");
    assertSecretsAbsent(primaryContext.capturedOutput.join("\n"), "all primary child output");
  });
} catch (error) {
  runtimeFailure = error;
} finally {
  if (primaryContext) {
    try { await cleanupContext(primaryContext); } catch (error) { cleanupFailure = error; }
  }
  try { await cleanupAllContexts(); } catch (error) { cleanupFailure ??= error; }
}

if (!runtimeFailure && !cleanupFailure) {
  try {
    assertSecretsAbsent(globalCapturedOutput.join("\n"), "all captured process stdout and stderr");
    expectEqual(globalActiveChildren.size, 0, "task child processes remain active");
    expectEqual(activeContexts.size, 0, "task runtime contexts remain active");
    expectEqual(primaryContext?.cleanupComplete, true, "primary cleanup was not verified");
  } catch (error) {
    runtimeFailure = error;
  }
}

if (runtimeFailure || cleanupFailure) {
  const failures = [runtimeFailure, cleanupFailure].filter(Boolean);
  console.error(`FAIL ${redact(failures.map(error => error.stack ?? error.message).join("\n"))}`);
  process.exitCode = 1;
} else {
  const report = {
    ok: true,
    runtime: {
      postgres: POSTGRES_IMAGE,
      postgrest: POSTGREST_IMAGE,
      hostBinding: "temporary loopback-only port (verified closed)"
    },
    committedMigrationBlob: EXPECTED_MIGRATION_BLOB,
    committedMigrationSha256: EXPECTED_MIGRATION_SHA256,
    categories: passedCategories.length,
    assertions: assertionCount,
    coverage: {
      malformedEnvelopeCases: 16,
      rollbackCases: 6,
      concurrencyCases: 3,
      cleanupFaultModes: CLEANUP_FAULTS.length
    },
    proof: {
      postgrestHttpRuntime: true,
      postgresCatalogRuntime: true,
      productionSupabaseAdvisors: false,
      productionSchemaDrift: false,
      productionLogging: false,
      productionJwtGateway: false
    },
    providerRequests: 0,
    productionRequests: 0,
    cleanupComplete: true
  };
  assertSecretsAbsent(JSON.stringify(report), "final harness report");
  console.log(JSON.stringify(report));
}
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await runHarness();
}

export {
  COMMITTED_PREFLIGHT_ARTIFACTS,
  REQUIRED_VIZARD_SCRIPTS,
  validateVizardPostgrestPreflight
};
