import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXPECTED_MIGRATION_BLOB = "71cf307fc059c32a017c4b53aaa9a774ec83bd11";
const EXPECTED_MIGRATION_SHA256 = "3a34d91e4217d66f86ed1e54dbdd6675796c4410ea7ab43d2637d0bb7e63a9bc";
const POSTGRES_IMAGE = "postgres:15-alpine";
const repoDir = path.dirname(fileURLToPath(import.meta.url));
const migrationRelativePath = "SUPABASE-VIZARD-CONNECTION-MANAGEMENT.sql";
const starterSchemaRelativePath = "supabase-schema.sql";
const perUserMigrationRelativePath = "SUPABASE-PER-USER-MIGRATION.sql";
const runId = `${process.pid}-${randomBytes(5).toString("hex")}`;
const containerName = `social-cues-vizard-runtime-${runId}`;
const temporaryDirectory = path.join(tmpdir(), `social-cues-vizard-runtime-${runId}`);
const committedMigrationPath = path.join(temporaryDirectory, migrationRelativePath);
const databasePrefix = `vzr_${process.pid}_${randomBytes(3).toString("hex")}`;
const syntheticPassword = randomBytes(24).toString("base64url");
const redactions = new Set([syntheticPassword]);
const capturedOutputs = [];
const activeChildren = new Set();
const passed = [];
const createdDatabases = new Set();
let databaseCounter = 0;
let imageWasPresent = false;
let imagePulledByHarness = false;
let postgresVersion = null;
let postgresLogSafety = null;
let cleanupPromise = null;
let shutdownRequested = false;

globalThis.fetch = async () => {
  throw new Error("External HTTP requests are forbidden in the Vizard PostgreSQL runtime contract.");
};

function redact(value) {
  let result = String(value ?? "");
  for (const secret of redactions) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function registerRedactions(value) {
  if (typeof value === "string") {
    if (value.length >= 8) redactions.add(value);
    return;
  }
  if (value && typeof value === "object") {
    const serialized = JSON.stringify(value);
    if (serialized.length >= 8) redactions.add(serialized);
    for (const nested of Object.values(value)) registerRedactions(nested);
  }
}

function assertSecretsAbsent(value, context) {
  const text = String(value ?? "");
  for (const secret of redactions) {
    assert.equal(text.includes(secret), false, `${context} exposed synthetic secret material`);
  }
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

function quoteLiteral(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function jsonbLiteral(value) {
  return `${quoteLiteral(JSON.stringify(value))}::jsonb`;
}

function lastOutputLine(value) {
  const lines = String(value).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? "";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runProcess(command, args, {
  input = null,
  timeoutMs = 30_000,
  allowFailure = false,
  captureOutput = true,
  cwd = repoDir
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      if (captureOutput) capturedOutputs.push(`${command} startup error: ${error.message}`);
      reject(new Error(`${command} could not start: ${redact(error.message)}`));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      const result = { code: code ?? -1, signal, stdout, stderr, timedOut };
      if (captureOutput) capturedOutputs.push(`${command}\n${stdout}\n${stderr}`);
      if (timedOut) {
        reject(new Error(`${command} exceeded the ${timeoutMs}ms timeout`));
      } else if (result.code !== 0 && !allowFailure) {
        reject(new Error([
          `${command} exited with code ${result.code}`,
          redact(stderr),
          redact(stdout)
        ].filter(Boolean).join("\n")));
      } else {
        resolve(result);
      }
    });

    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function runDocker(args, options = {}) {
  return runProcess("docker", args, options);
}

async function psql(database, sql, { allowFailure = false, timeoutMs = 20_000 } = {}) {
  const script = `\\set VERBOSITY verbose\n${sql.trim()}\n`;
  return runDocker([
    "exec", "-i",
    "-e", "PGOPTIONS=-c statement_timeout=15000 -c lock_timeout=10000 -c client_min_messages=warning",
    containerName,
    "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    "-U", "postgres", "-d", database
  ], { input: script, allowFailure, timeoutMs });
}

async function queryScalar(database, sql) {
  const result = await psql(database, sql);
  return lastOutputLine(result.stdout);
}

async function queryJson(database, sql) {
  const value = await queryScalar(database, sql);
  assert.ok(value, "expected a JSON query result");
  return JSON.parse(value);
}

function databaseError(result) {
  const combined = `${result.stderr}\n${result.stdout}`;
  const match = combined.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\r\n]+)/u);
  return {
    raw: combined,
    sqlState: match?.[1] ?? null,
    message: match?.[2]?.trim() ?? null
  };
}

function assertDatabaseFailure(result, expectedState, expectedMessage) {
  assert.notEqual(result.code, 0, "database operation unexpectedly succeeded");
  const error = databaseError(result);
  assert.equal(error.sqlState, expectedState);
  assert.equal(error.message, expectedMessage);
  for (const secret of redactions) {
    assert.equal(error.raw.includes(secret), false, "database error exposed synthetic secret material");
  }
  return error;
}

async function check(name, fn) {
  await fn();
  passed.push(name);
  console.log(`PASS ${name}`);
}

function extractTable(source, tableName) {
  const expression = new RegExp(
    `create table if not exists public\\.${tableName} \\([\\s\\S]*?^\\);`,
    "mu"
  );
  const match = source.match(expression);
  assert.ok(match, `canonical ${tableName} definition is missing`);
  return match[0];
}

function buildBaseFixture(starterSchema, perUserMigration) {
  const tables = [
    extractTable(starterSchema, "workspaces"),
    extractTable(perUserMigration, "workspace_members"),
    extractTable(perUserMigration, "connected_accounts"),
    extractTable(perUserMigration, "provider_tokens"),
    extractTable(perUserMigration, "billing_entitlements"),
    extractTable(perUserMigration, "audit_logs")
  ];
  const canonicalIndexes = [
    "create index if not exists workspace_members_user_idx on public.workspace_members(user_id);",
    "create index if not exists connected_accounts_workspace_idx on public.connected_accounts(workspace_id);",
    "create index if not exists connected_accounts_user_idx on public.connected_accounts(user_id);",
    "create index if not exists provider_tokens_account_idx on public.provider_tokens(connected_account_id);",
    "create index if not exists provider_tokens_workspace_idx on public.provider_tokens(workspace_id);",
    "create index if not exists audit_logs_workspace_idx on public.audit_logs(workspace_id, created_at desc);"
  ];
  for (const statement of canonicalIndexes) {
    assert.ok(perUserMigration.includes(statement), `canonical index statement is missing: ${statement}`);
  }

  return `
create extension if not exists pgcrypto;

create schema if not exists auth;
create or replace function auth.uid()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

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

-- Supabase-managed public-schema defaults grant table access to API roles.
-- The canonical migration then revokes provider-token access from browser roles.
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

create policy "members can read own memberships"
  on public.workspace_members for select
  to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.social_cues_has_active_entitlement(
  target_workspace_id uuid,
  target_user_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.billing_entitlements be
    where be.workspace_id = target_workspace_id
      and (be.user_id is null or be.user_id = target_user_id)
      and be.status = 'active'
      and coalesce(be.access, 'unpaid') <> 'unpaid'
      and (be.current_period_end is null or be.current_period_end > now())
  );
$$;

revoke all on function public.social_cues_has_active_entitlement(uuid, uuid) from public;
grant execute on function public.social_cues_has_active_entitlement(uuid, uuid) to authenticated;

create policy "members can read connected accounts"
  on public.connected_accounts for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members
      where workspace_members.workspace_id = connected_accounts.workspace_id
        and workspace_members.user_id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(
      connected_accounts.workspace_id,
      (select auth.uid())
    )
  );

create policy "members can read audit logs"
  on public.audit_logs for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members
      where workspace_members.workspace_id = audit_logs.workspace_id
        and workspace_members.user_id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(
      audit_logs.workspace_id,
      (select auth.uid())
    )
  );

${canonicalIndexes.join("\n")}
`;
}

async function createDatabase(baseFixture, label) {
  databaseCounter += 1;
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/gu, "_").slice(0, 20);
  const database = `${databasePrefix}_${databaseCounter}_${safeLabel}`.slice(0, 63);
  await runDocker([
    "exec", containerName, "createdb", "-U", "postgres",
    "--template=template0", "--encoding=UTF8", database
  ]);
  createdDatabases.add(database);
  await psql(database, baseFixture, { timeoutMs: 30_000 });
  return database;
}

async function dropDatabase(database) {
  if (!createdDatabases.has(database)) return;
  await runDocker([
    "exec", containerName, "dropdb", "-U", "postgres", "--if-exists", "--force", database
  ], { allowFailure: true, timeoutMs: 15_000 });
  createdDatabases.delete(database);
}

async function applyMigration(database, { allowFailure = false } = {}) {
  return runDocker([
    "exec",
    "-e", "PGOPTIONS=-c statement_timeout=15000 -c lock_timeout=10000 -c client_min_messages=warning",
    containerName,
    "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose",
    "-U", "postgres", "-d", database,
    "-f", "/tmp/SUPABASE-VIZARD-CONNECTION-MANAGEMENT.sql"
  ], { allowFailure, timeoutMs: 25_000 });
}

function makeEnvelope(plaintext, key = randomBytes(32)) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const value = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope = {
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    value: value.toString("base64url")
  };
  registerRedactions(plaintext);
  registerRedactions(key.toString("base64url"));
  registerRedactions(envelope);
  return { envelope, key };
}

function makeMalformedEnvelopeCases() {
  const valid = makeEnvelope(`synthetic-malformed-template-${randomBytes(8).toString("hex")}`).envelope;
  const without = (key) => {
    const value = { ...valid };
    delete value[key];
    return value;
  };
  const cases = [
    { name: "missing alg", value: without("alg") },
    { name: "missing iv", value: without("iv") },
    { name: "missing tag", value: without("tag") },
    { name: "missing value", value: without("value") },
    { name: "blank alg", value: { ...valid, alg: "" } },
    { name: "blank iv", value: { ...valid, iv: "" } },
    { name: "blank tag", value: { ...valid, tag: "" } },
    { name: "blank value", value: { ...valid, value: "" } },
    { name: "wrong algorithm", value: { ...valid, alg: "synthetic-wrong-algorithm" } },
    { name: "invalid IV encoding", value: { ...valid, iv: `${"A".repeat(15)}+` } },
    { name: "invalid IV length", value: { ...valid, iv: "A".repeat(15) } },
    { name: "invalid authentication-tag encoding", value: { ...valid, tag: `${"B".repeat(21)}+` } },
    { name: "invalid authentication-tag length", value: { ...valid, tag: "B".repeat(21) } },
    { name: "invalid ciphertext encoding", value: { ...valid, value: "synthetic+ciphertext/invalid" } },
    { name: "extra unexpected property", value: { ...valid, unexpected: "synthetic-unexpected-property" } },
    { name: "plaintext-shaped object", value: { apiKey: "synthetic-plaintext-shaped-secret" } },
    { name: "JSON string", value: "synthetic-json-string-secret" },
    { name: "JSON array", value: ["synthetic-json-array-secret"] },
    { name: "JSON null", value: null },
    { name: "empty object", value: {} }
  ];
  for (const malformed of cases) registerRedactions(malformed.value);
  return cases;
}

function rpcSql({ role = "service_role", actor, workspace, action, envelope = null }) {
  assert.match(role, /^(?:anon|authenticated|service_role)$/u);
  return `
set role ${role};
select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(result)), '[]'::jsonb)
from public.social_cues_manage_vizard_connection(
  ${quoteLiteral(actor)}::uuid,
  ${quoteLiteral(workspace)}::uuid,
  ${quoteLiteral(action)}::text,
  ${envelope ? jsonbLiteral(envelope) : "null::jsonb"}
) result;
reset role;
`;
}

async function callRpc(database, options) {
  const result = await queryJson(database, rpcSql(options));
  assertSecretsAbsent(JSON.stringify(result), "RPC result");
  return result;
}

async function callRpcExpectFailure(database, options, expectedState, expectedMessage, prefix = "") {
  const result = await psql(database, `${prefix}\n${rpcSql(options)}`, { allowFailure: true });
  return assertDatabaseFailure(result, expectedState, expectedMessage);
}

const IDS = Object.freeze({
  workspaceA: "10000000-0000-4000-8000-000000000001",
  workspaceB: "10000000-0000-4000-8000-000000000002",
  workspaceMissing: "10000000-0000-4000-8000-000000000099",
  owner: "20000000-0000-4000-8000-000000000001",
  admin: "20000000-0000-4000-8000-000000000002",
  member: "20000000-0000-4000-8000-000000000003",
  viewer: "20000000-0000-4000-8000-000000000004",
  outsider: "20000000-0000-4000-8000-000000000005",
  ownerB: "20000000-0000-4000-8000-000000000006",
  rollbackToken: "10000000-0000-4000-8000-000000000010",
  rollbackAudit: "10000000-0000-4000-8000-000000000011",
  rollbackAccount: "10000000-0000-4000-8000-000000000012",
  concurrentConnect: "10000000-0000-4000-8000-000000000020",
  concurrentReplace: "10000000-0000-4000-8000-000000000021",
  concurrentRace: "10000000-0000-4000-8000-000000000022"
});

function validateArtifactPreconditions(requiredArtifacts, stagedPaths = []) {
  const requiredPaths = new Set(requiredArtifacts.map((artifact) => artifact.path));
  for (const artifact of requiredArtifacts) {
    assert.equal(artifact.headBlob, artifact.indexBlob, `${artifact.path} differs between HEAD and the index`);
    assert.equal(artifact.headBlob, artifact.worktreeBlob, `${artifact.path} differs between HEAD and the worktree`);
    if (artifact.expectedBlob) {
      assert.equal(artifact.headBlob, artifact.expectedBlob, `${artifact.path} is not the approved artifact`);
    }
  }
  return stagedPaths.filter((stagedPath) => !requiredPaths.has(stagedPath));
}

function testArtifactPreconditionRules() {
  const cleanMigration = {
    path: migrationRelativePath,
    headBlob: EXPECTED_MIGRATION_BLOB,
    indexBlob: EXPECTED_MIGRATION_BLOB,
    worktreeBlob: EXPECTED_MIGRATION_BLOB,
    expectedBlob: EXPECTED_MIGRATION_BLOB
  };
  assert.deepEqual(
    validateArtifactPreconditions([cleanMigration], ["vizard-connection-management.runtime.test.mjs"]),
    ["vizard-connection-management.runtime.test.mjs"]
  );
  assert.throws(
    () => validateArtifactPreconditions([{ ...cleanMigration, indexBlob: "staged-migration-change" }]),
    /differs between HEAD and the index/u
  );
}

async function loadCommittedArtifact(relativePath, { expectedBlob = null, expectedSha256 = null } = {}) {
  const headBlob = lastOutputLine((await runProcess("git", ["rev-parse", `HEAD:${relativePath}`])).stdout);
  const indexBlob = lastOutputLine((await runProcess("git", ["rev-parse", `:${relativePath}`])).stdout);
  const worktreeBlob = lastOutputLine((await runProcess("git", [
    "hash-object", `--path=${relativePath}`, "--", relativePath
  ])).stdout);
  validateArtifactPreconditions([{
    path: relativePath,
    headBlob,
    indexBlob,
    worktreeBlob,
    expectedBlob
  }]);

  const committed = await runProcess("git", ["show", `HEAD:${relativePath}`], { captureOutput: false });
  const sha256 = createHash("sha256").update(committed.stdout).digest("hex");
  if (expectedSha256) {
    assert.equal(sha256, expectedSha256, `${relativePath} SHA-256 is not approved`);
  }
  return { blob: headBlob, content: committed.stdout, sha256 };
}

async function verifyCommittedInputs() {
  testArtifactPreconditionRules();
  const migration = await loadCommittedArtifact(migrationRelativePath, {
    expectedBlob: EXPECTED_MIGRATION_BLOB,
    expectedSha256: EXPECTED_MIGRATION_SHA256
  });
  const starterSchema = await loadCommittedArtifact(starterSchemaRelativePath);
  const perUserMigration = await loadCommittedArtifact(perUserMigrationRelativePath);
  return { migration, starterSchema, perUserMigration };
}

function disposableContainerCreateArgs(name) {
  return [
    "create",
    "--name", name,
    "--label", "social-cues.test=vizard-connection-runtime",
    "--network", "none",
    "--shm-size", "128m",
    "--tmpfs", "/var/lib/postgresql/data:rw,size=256m",
    "-e", `POSTGRES_PASSWORD=${syntheticPassword}`,
    "-e", "POSTGRES_DB=postgres",
    POSTGRES_IMAGE,
    "postgres",
    "-c", "log_statement=none",
    "-c", "log_min_error_statement=panic",
    "-c", "log_parameter_max_length_on_error=0"
  ];
}

async function containerExists(name) {
  const inspected = await runDocker(["container", "inspect", name], {
    allowFailure: true,
    timeoutMs: 10_000
  });
  return inspected.code === 0;
}

async function removeContainerExact(name) {
  const removed = await runDocker(["rm", "-f", name], {
    allowFailure: true,
    timeoutMs: 20_000
  });
  if (removed.code !== 0 && !/No such container/iu.test(`${removed.stderr}\n${removed.stdout}`)) {
    throw new Error(`could not remove exact task container ${name}: ${redact(removed.stderr)}`);
  }
}

async function assertResourcesAbsent(name, directory) {
  assert.equal(await containerExists(name), false, `task container ${name} still exists`);
  assert.equal(await pathExists(directory), false, `task directory ${directory} still exists`);
}

async function ensurePostgresImage() {
  const imageCheck = await runDocker(["image", "inspect", POSTGRES_IMAGE], { allowFailure: true });
  imageWasPresent = imageCheck.code === 0;
  if (!imageWasPresent) {
    imagePulledByHarness = true;
    await runDocker(["pull", POSTGRES_IMAGE], { timeoutMs: 180_000 });
  }
}

async function testCleanupFaultInjections() {
  for (const checkpoint of ["after-directory", "after-create", "after-start"]) {
    const suffix = randomUUID().replaceAll("-", "");
    const injectedContainer = `social-cues-vizard-runtime-fault-${suffix}`;
    const injectedDirectory = path.join(tmpdir(), `social-cues-vizard-runtime-fault-${suffix}`);
    let injected = false;
    try {
      await mkdir(injectedDirectory);
      if (checkpoint === "after-directory") throw new Error(`INJECTED_${checkpoint}`);
      await runDocker(disposableContainerCreateArgs(injectedContainer), { timeoutMs: 60_000 });
      if (checkpoint === "after-create") throw new Error(`INJECTED_${checkpoint}`);
      await runDocker(["start", injectedContainer], { timeoutMs: 60_000 });
      if (checkpoint === "after-start") throw new Error(`INJECTED_${checkpoint}`);
    } catch (error) {
      assert.equal(error.message, `INJECTED_${checkpoint}`);
      injected = true;
    } finally {
      await removeContainerExact(injectedContainer);
      await rm(injectedDirectory, { recursive: true, force: true });
    }
    assert.equal(injected, true, `${checkpoint} fault did not execute`);
    await assertResourcesAbsent(injectedContainer, injectedDirectory);
  }
}

async function startDisposableRuntime(inputs) {
  await assertResourcesAbsent(containerName, temporaryDirectory);
  await mkdir(temporaryDirectory);
  await writeFile(committedMigrationPath, inputs.migration.content, "utf8");

  const created = await runDocker(disposableContainerCreateArgs(containerName), { timeoutMs: 60_000 });
  assert.ok(created.stdout.trim(), "Docker did not return a container identifier");
  await runDocker(["start", containerName], { timeoutMs: 60_000 });

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const readiness = await runDocker([
      "exec", containerName, "pg_isready", "-U", "postgres", "-d", "postgres"
    ], { allowFailure: true, timeoutMs: 5_000 });
    if (readiness.code === 0) {
      ready = true;
      break;
    }
    await delay(250);
  }
  assert.equal(ready, true, "disposable PostgreSQL did not become ready");

  await runDocker(["cp", committedMigrationPath, `${containerName}:/tmp/SUPABASE-VIZARD-CONNECTION-MANAGEMENT.sql`]);
  const copiedHash = await runDocker([
    "exec", containerName, "sha256sum", "/tmp/SUPABASE-VIZARD-CONNECTION-MANAGEMENT.sql"
  ]);
  assert.equal(copiedHash.stdout.trim().split(/\s+/u)[0], inputs.migration.sha256);

  await psql("postgres", `
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
end;
$$;
alter role anon nobypassrls;
alter role authenticated nobypassrls;
alter role service_role bypassrls;
`);
  postgresVersion = await queryScalar("postgres", "show server_version;");
  postgresLogSafety = await queryJson("postgres", `
select pg_catalog.jsonb_build_object(
  'log_statement', pg_catalog.current_setting('log_statement'),
  'log_min_error_statement', pg_catalog.current_setting('log_min_error_statement'),
  'log_parameter_max_length_on_error', pg_catalog.current_setting('log_parameter_max_length_on_error')
);
`);
  assert.deepEqual(postgresLogSafety, {
    log_min_error_statement: "panic",
    log_parameter_max_length_on_error: "0",
    log_statement: "none"
  });

  const isolation = await runDocker(["inspect", "--format", "{{json .HostConfig}}", containerName]);
  const hostConfig = JSON.parse(isolation.stdout);
  assert.equal(hostConfig.NetworkMode, "none");
  assert.deepEqual(hostConfig.PortBindings, {});
}

async function cleanupDisposableRuntime() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const cleanupErrors = [];
    for (const child of activeChildren) {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        cleanupErrors.push(redact(error.message));
      }
    }
    for (let attempt = 0; attempt < 20 && activeChildren.size > 0; attempt += 1) {
      await delay(50);
    }
    if (activeChildren.size > 0) cleanupErrors.push("task child process did not terminate");

    try {
      await removeContainerExact(containerName);
    } catch (error) {
      cleanupErrors.push(redact(error.message));
    }
    createdDatabases.clear();

    try {
      await rm(temporaryDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(redact(error.message));
    }

    if (imagePulledByHarness && !imageWasPresent) {
      const removedImage = await runDocker(["image", "rm", POSTGRES_IMAGE], {
        allowFailure: true,
        timeoutMs: 60_000
      });
      if (removedImage.code !== 0 && !/No such image/iu.test(`${removedImage.stderr}\n${removedImage.stdout}`)) {
        cleanupErrors.push(redact(removedImage.stderr));
      }
    }

    try {
      await assertResourcesAbsent(containerName, temporaryDirectory);
    } catch (error) {
      cleanupErrors.push(redact(error.message));
    }
    assert.deepEqual(cleanupErrors, [], `cleanup failed: ${cleanupErrors.join("; ")}`);
  })();
  return cleanupPromise;
}

async function seedNonVizardSentinel(database) {
  await psql(database, `
insert into public.workspaces(id, owner_user_id, name)
values ('80000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'Synthetic sentinel');
insert into public.workspace_members(workspace_id, user_id, role)
values ('80000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'owner');
insert into public.connected_accounts(
  id, workspace_id, user_id, provider, platform, provider_account_id,
  display_name, status, connected_at
) values (
  '82000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001',
  'discord', 'discord', 'synthetic-sentinel', 'Synthetic sentinel', 'connected', pg_catalog.now()
);
insert into public.provider_tokens(
  id, connected_account_id, workspace_id, user_id, provider, token_kind,
  encrypted_token, token_type
) values (
  '83000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001',
  'discord', 'oauth', '{"synthetic":"non-vizard"}'::jsonb, 'bearer'
);
`);
}

function nonVizardSnapshotSql() {
  return `
select pg_catalog.jsonb_build_object(
  'account_count', (
    select pg_catalog.count(*) from public.connected_accounts where provider <> 'vizard'
  ),
  'account_hash', (
    select pg_catalog.md5(pg_catalog.string_agg(pg_catalog.row_to_json(ca)::text, '|' order by ca.id))
    from public.connected_accounts ca where ca.provider <> 'vizard'
  ),
  'token_count', (
    select pg_catalog.count(*) from public.provider_tokens where provider <> 'vizard'
  ),
  'token_hash', (
    select pg_catalog.md5(pg_catalog.string_agg(pg_catalog.row_to_json(pt)::text, '|' order by pt.id))
    from public.provider_tokens pt where pt.provider <> 'vizard'
  )
);
`;
}

async function testFoundationalMigration(baseFixture) {
  const database = await createDatabase(baseFixture, "foundation");
  await seedNonVizardSentinel(database);
  const sentinelBefore = await queryJson(database, nonVizardSnapshotSql());
  await applyMigration(database);
  const sentinelAfter = await queryJson(database, nonVizardSnapshotSql());
  assert.deepEqual(sentinelAfter, sentinelBefore);

  const facts = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'named_functions', (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'social_cues_manage_vizard_connection'
  ),
  'exact_functions', (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'social_cues_manage_vizard_connection'
      and pg_catalog.oidvectortypes(p.proargtypes) = 'uuid, uuid, text, jsonb'
  ),
  'owner', (
    select r.rolname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles r on r.oid = p.proowner
    where n.nspname = 'public'
      and p.proname = 'social_cues_manage_vizard_connection'
  ),
  'secure_search_path', (
    select p.proconfig = array['search_path=""']::text[]
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'social_cues_manage_vizard_connection'
  ),
  'index_count', (
    select pg_catalog.count(*)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'connected_accounts_workspace_vizard_current_uidx'
  ),
  'index_valid', (
    select i.indisunique and i.indisvalid and i.indisready
    from pg_catalog.pg_index i
    where i.indexrelid = 'public.connected_accounts_workspace_vizard_current_uidx'::regclass
  )
);
`);
  assert.deepEqual(facts, {
    owner: "postgres",
    index_count: 1,
    index_valid: true,
    exact_functions: 1,
    named_functions: 1,
    secure_search_path: true
  });

  const indexOidBefore = await queryScalar(database, `
select 'public.connected_accounts_workspace_vizard_current_uidx'::regclass::oid::text;
`);
  await applyMigration(database);
  const indexOidAfter = await queryScalar(database, `
select 'public.connected_accounts_workspace_vizard_current_uidx'::regclass::oid::text;
`);
  assert.equal(indexOidAfter, indexOidBefore);
  assert.deepEqual(await queryJson(database, nonVizardSnapshotSql()), sentinelBefore);
  return database;
}

async function testIndexGuards(baseFixture) {
  const exactDatabase = await createDatabase(baseFixture, "exact_index");
  try {
    await psql(exactDatabase, `
create unique index connected_accounts_workspace_vizard_current_uidx
  on public.connected_accounts(workspace_id)
  where provider = 'vizard' and platform = 'vizard';
`);
    const oidBefore = await queryScalar(exactDatabase, `
select 'public.connected_accounts_workspace_vizard_current_uidx'::regclass::oid::text;
`);
    await applyMigration(exactDatabase);
    const oidAfter = await queryScalar(exactDatabase, `
select 'public.connected_accounts_workspace_vizard_current_uidx'::regclass::oid::text;
`);
    assert.equal(oidAfter, oidBefore);
    assert.equal(await queryScalar(exactDatabase, `
select pg_catalog.count(*)::text
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'connected_accounts_workspace_vizard_current_uidx';
`), "1");
  } finally {
    await dropDatabase(exactDatabase);
  }

  const mismatches = [
    {
      name: "wrong_table",
      sql: `
create table public.index_guard_decoy(workspace_id uuid);
create unique index connected_accounts_workspace_vizard_current_uidx
  on public.index_guard_decoy(workspace_id);`
    },
    {
      name: "non_unique",
      sql: `create index connected_accounts_workspace_vizard_current_uidx
        on public.connected_accounts(workspace_id)
        where provider = 'vizard' and platform = 'vizard';`
    },
    {
      name: "wrong_column",
      sql: `create unique index connected_accounts_workspace_vizard_current_uidx
        on public.connected_accounts(user_id)
        where provider = 'vizard' and platform = 'vizard';`
    },
    {
      name: "expression",
      sql: `create unique index connected_accounts_workspace_vizard_current_uidx
        on public.connected_accounts((workspace_id::text))
        where provider = 'vizard' and platform = 'vizard';`
    },
    {
      name: "wrong_predicate",
      sql: `create unique index connected_accounts_workspace_vizard_current_uidx
        on public.connected_accounts(workspace_id)
        where provider = 'vizard';`
    },
    {
      name: "wrong_lifecycle",
      sql: `create unique index connected_accounts_workspace_vizard_current_uidx
        on public.connected_accounts(workspace_id)
        where provider = 'vizard' and platform = 'vizard' and status <> 'not_connected';`
    },
    {
      name: "wrong_access_method",
      sql: `create index connected_accounts_workspace_vizard_current_uidx
        on public.connected_accounts using hash(workspace_id)
        where provider = 'vizard' and platform = 'vizard';`
    }
  ];

  for (const mismatch of mismatches) {
    const database = await createDatabase(baseFixture, mismatch.name);
    try {
      await seedNonVizardSentinel(database);
      await psql(database, mismatch.sql);
      const indexBefore = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'oid', c.oid::text,
  'definition', pg_catalog.pg_get_indexdef(c.oid)
)
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'connected_accounts_workspace_vizard_current_uidx';
`);
      const sentinelBefore = await queryJson(database, nonVizardSnapshotSql());
      const result = await applyMigration(database, { allowFailure: true });
      assertDatabaseFailure(result, "23514", "VIZARD_CONNECTION_INDEX_DEFINITION_CONFLICT");
      const indexAfter = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'oid', c.oid::text,
  'definition', pg_catalog.pg_get_indexdef(c.oid)
)
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'connected_accounts_workspace_vizard_current_uidx';
`);
      assert.deepEqual(indexAfter, indexBefore);
      assert.deepEqual(await queryJson(database, nonVizardSnapshotSql()), sentinelBefore);
    } finally {
      await dropDatabase(database);
    }
  }
}

async function testExistingDataConflict(baseFixture) {
  const database = await createDatabase(baseFixture, "data_conflict");
  const first = makeEnvelope("synthetic-conflict-one").envelope;
  const second = makeEnvelope("synthetic-conflict-two").envelope;
  try {
    await seedNonVizardSentinel(database);
    await psql(database, `
insert into public.workspaces(id, owner_user_id, name)
values ('90000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'Synthetic conflict');
insert into public.connected_accounts(
  id, workspace_id, user_id, provider, platform, provider_account_id, status
) values
  ('92000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'vizard', 'vizard', null, 'not_connected'),
  ('92000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'vizard', 'vizard', null, 'pending_verification');
insert into public.provider_tokens(
  id, connected_account_id, workspace_id, user_id, provider, token_kind,
  encrypted_token, token_type
) values
  ('93000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'vizard', 'api_key', ${jsonbLiteral(first)}, 'api_key'),
  ('93000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'vizard', 'api_key', ${jsonbLiteral(second)}, 'api_key');
`);
    const before = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'accounts', (select pg_catalog.jsonb_agg(id::text order by id) from public.connected_accounts where provider = 'vizard'),
  'account_count', (select pg_catalog.count(*) from public.connected_accounts where provider = 'vizard'),
  'token_count', (select pg_catalog.count(*) from public.provider_tokens where provider = 'vizard'),
  'token_hash', (select pg_catalog.md5(pg_catalog.string_agg(pg_catalog.row_to_json(pt)::text, '|' order by pt.id)) from public.provider_tokens pt where provider = 'vizard'),
  'sentinel', (${nonVizardSnapshotSql().replace(/^\s*select\s+/u, "").replace(/;\s*$/u, "")})
);
`);
    const result = await applyMigration(database, { allowFailure: true });
    assertDatabaseFailure(result, "23505", "VIZARD_CONNECTION_MIGRATION_REQUIRES_CLEANUP");
    const after = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'accounts', (select pg_catalog.jsonb_agg(id::text order by id) from public.connected_accounts where provider = 'vizard'),
  'account_count', (select pg_catalog.count(*) from public.connected_accounts where provider = 'vizard'),
  'token_count', (select pg_catalog.count(*) from public.provider_tokens where provider = 'vizard'),
  'token_hash', (select pg_catalog.md5(pg_catalog.string_agg(pg_catalog.row_to_json(pt)::text, '|' order by pt.id)) from public.provider_tokens pt where provider = 'vizard'),
  'sentinel', (${nonVizardSnapshotSql().replace(/^\s*select\s+/u, "").replace(/;\s*$/u, "")})
);
`);
    assert.deepEqual(after, before);
  } finally {
    await dropDatabase(database);
  }
}

async function testFunctionPrivileges(database) {
  const privileges = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'public_execute', exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    where n.nspname = 'public'
      and p.proname = 'social_cues_manage_vizard_connection'
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  'anon_execute', pg_catalog.has_function_privilege(
    'anon',
    'public.social_cues_manage_vizard_connection(uuid, uuid, text, jsonb)',
    'EXECUTE'
  ),
  'authenticated_execute', pg_catalog.has_function_privilege(
    'authenticated',
    'public.social_cues_manage_vizard_connection(uuid, uuid, text, jsonb)',
    'EXECUTE'
  ),
  'service_execute', pg_catalog.has_function_privilege(
    'service_role',
    'public.social_cues_manage_vizard_connection(uuid, uuid, text, jsonb)',
    'EXECUTE'
  ),
  'service_table_dml', (
    select pg_catalog.bool_and(
      pg_catalog.has_table_privilege('service_role', relation_name, privilege_name)
    )
    from pg_catalog.unnest(array[
      'public.workspace_members',
      'public.connected_accounts',
      'public.provider_tokens',
      'public.audit_logs'
    ]) relation_name
    cross join pg_catalog.unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege_name
  )
);
`);
  assert.deepEqual(privileges, {
    anon_execute: false,
    authenticated_execute: false,
    public_execute: false,
    service_execute: true,
    service_table_dml: true
  });

  for (const role of ["anon", "authenticated"]) {
    await callRpcExpectFailure(database, {
      role,
      actor: IDS.owner,
      workspace: IDS.workspaceA,
      action: "disconnect"
    }, "42501", "permission denied for function social_cues_manage_vizard_connection");
  }
}

async function seedLifecycleActors(database) {
  await psql(database, `
insert into public.workspaces(id, owner_user_id, name) values
  (${quoteLiteral(IDS.workspaceA)}::uuid, ${quoteLiteral(IDS.owner)}::uuid, 'Synthetic workspace A'),
  (${quoteLiteral(IDS.workspaceB)}::uuid, ${quoteLiteral(IDS.ownerB)}::uuid, 'Synthetic workspace B');
insert into public.workspace_members(workspace_id, user_id, role) values
  (${quoteLiteral(IDS.workspaceA)}::uuid, ${quoteLiteral(IDS.owner)}::uuid, 'owner'),
  (${quoteLiteral(IDS.workspaceA)}::uuid, ${quoteLiteral(IDS.admin)}::uuid, 'admin'),
  (${quoteLiteral(IDS.workspaceA)}::uuid, ${quoteLiteral(IDS.member)}::uuid, 'member'),
  (${quoteLiteral(IDS.workspaceA)}::uuid, ${quoteLiteral(IDS.viewer)}::uuid, 'viewer'),
  (${quoteLiteral(IDS.workspaceB)}::uuid, ${quoteLiteral(IDS.ownerB)}::uuid, 'owner');
`);
}

async function testMembershipAuthorization(database) {
  const deniedActors = [IDS.member, IDS.viewer, IDS.outsider];
  for (const actor of deniedActors) {
    await callRpcExpectFailure(database, {
      actor,
      workspace: IDS.workspaceA,
      action: "disconnect"
    }, "42501", "VIZARD_CONNECTION_NOT_AUTHORIZED");
  }

  const foreign = await callRpcExpectFailure(database, {
    actor: IDS.owner,
    workspace: IDS.workspaceB,
    action: "disconnect"
  }, "42501", "VIZARD_CONNECTION_NOT_AUTHORIZED");
  const absent = await callRpcExpectFailure(database, {
    actor: IDS.owner,
    workspace: IDS.workspaceMissing,
    action: "disconnect"
  }, "42501", "VIZARD_CONNECTION_NOT_AUTHORIZED");
  assert.deepEqual(
    { sqlState: foreign.sqlState, message: foreign.message },
    { sqlState: absent.sqlState, message: absent.message }
  );

  await callRpcExpectFailure(database, {
    actor: IDS.outsider,
    workspace: IDS.workspaceA,
    action: "disconnect"
  }, "42501", "VIZARD_CONNECTION_NOT_AUTHORIZED", `
set request.jwt.claim.sub = ${quoteLiteral(IDS.outsider)};
set request.jwt.claims = '{"role":"owner","global_role":"owner"}';
`);
}

async function testProviderTokenDirectAccess(database) {
  const statements = [
    "select pg_catalog.count(*) from public.provider_tokens;",
    "update public.provider_tokens set token_type = token_type where false;",
    "delete from public.provider_tokens where false;",
    `insert into public.provider_tokens(
      connected_account_id, workspace_id, user_id, provider, token_kind, encrypted_token
    ) values (
      pg_catalog.gen_random_uuid(), pg_catalog.gen_random_uuid(), pg_catalog.gen_random_uuid(),
      'vizard', 'api_key', '{}'::jsonb
    );`
  ];
  for (const role of ["anon", "authenticated"]) {
    for (const statement of statements) {
      const result = await psql(database, `set role ${role};\n${statement}`, { allowFailure: true });
      assertDatabaseFailure(result, "42501", "permission denied for table provider_tokens");
    }
  }

  const rls = await queryJson(database, `
select pg_catalog.jsonb_object_agg(c.relname, c.relrowsecurity order by c.relname)
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'workspaces', 'workspace_members', 'connected_accounts',
    'provider_tokens', 'audit_logs'
  );
`);
  assert.deepEqual(rls, {
    audit_logs: true,
    connected_accounts: true,
    provider_tokens: true,
    workspace_members: true,
    workspaces: true
  });
}

async function testLifecycle(database) {
  const plaintext = `synthetic-runtime-credential-${randomBytes(8).toString("hex")}`;
  const firstEncrypted = makeEnvelope(plaintext);
  const reencrypted = makeEnvelope(plaintext, firstEncrypted.key).envelope;
  const replacement = makeEnvelope(`${plaintext}-replacement`).envelope;
  const expectedKeys = [
    "connected_account_id",
    "connected_at",
    "connection_state",
    "created_at",
    "platform",
    "provider",
    "updated_at",
    "verification_state",
    "workspace_id"
  ];

  const connectResult = await callRpc(database, {
    actor: IDS.owner,
    workspace: IDS.workspaceA,
    action: "connect",
    envelope: firstEncrypted.envelope
  });
  assert.equal(connectResult.length, 1);
  assert.deepEqual(Object.keys(connectResult[0]).sort(), expectedKeys);
  assert.equal(connectResult[0].workspace_id, IDS.workspaceA);
  assert.equal(connectResult[0].provider, "vizard");
  assert.equal(connectResult[0].platform, "vizard");
  assert.equal(connectResult[0].connection_state, "pending_verification");
  assert.equal(connectResult[0].verification_state, "pending");
  assert.equal(connectResult[0].connected_at, null);
  assert.ok(connectResult[0].created_at);
  assert.ok(connectResult[0].updated_at);
  const accountId = connectResult[0].connected_account_id;

  const connected = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'account_count', (
    select pg_catalog.count(*) from public.connected_accounts
    where workspace_id = ${quoteLiteral(IDS.workspaceA)}::uuid
      and provider = 'vizard' and platform = 'vizard'
  ),
  'account_id_matches', (
    select id = ${quoteLiteral(accountId)}::uuid from public.connected_accounts
    where workspace_id = ${quoteLiteral(IDS.workspaceA)}::uuid
      and provider = 'vizard' and platform = 'vizard'
  ),
  'account_shape', (
    select provider = 'vizard'
      and platform = 'vizard'
      and status = 'pending_verification'
      and public_profile = '{"connection_method":"api_key","verification_state":"pending"}'::jsonb
      and connected_at is null
      and last_sync_at is null
      and created_at is not null
      and updated_at is not null
    from public.connected_accounts
    where id = ${quoteLiteral(accountId)}::uuid
  ),
  'token_count', (
    select pg_catalog.count(*) from public.provider_tokens
    where connected_account_id = ${quoteLiteral(accountId)}::uuid and token_kind = 'api_key'
  ),
  'token_shape', (
    select provider = 'vizard'
      and token_kind = 'api_key'
      and token_type = 'api_key'
      and encrypted_token = ${jsonbLiteral(firstEncrypted.envelope)}
      and encrypted_refresh_token is null
      and created_at is not null
      and updated_at is not null
    from public.provider_tokens
    where connected_account_id = ${quoteLiteral(accountId)}::uuid and token_kind = 'api_key'
  ),
  'audit_count', (
    select pg_catalog.count(*) from public.audit_logs
    where workspace_id = ${quoteLiteral(IDS.workspaceA)}::uuid
      and event_type = 'vizard.connection.connected'
  ),
  'audit_safe', not exists (
    select 1 from public.audit_logs
    where workspace_id = ${quoteLiteral(IDS.workspaceA)}::uuid
      and (
        metadata ?| array['iv', 'tag', 'value', 'encrypted_token', 'credential']
        or pg_catalog.strpos(metadata::text, ${quoteLiteral(firstEncrypted.envelope.iv)}) > 0
        or pg_catalog.strpos(metadata::text, ${quoteLiteral(firstEncrypted.envelope.tag)}) > 0
        or pg_catalog.strpos(metadata::text, ${quoteLiteral(firstEncrypted.envelope.value)}) > 0
      )
  ),
  'plaintext_absent',
    not exists (
      select 1 from public.connected_accounts ca
      where pg_catalog.strpos(pg_catalog.row_to_json(ca)::text, ${quoteLiteral(plaintext)}) > 0
    )
    and not exists (
      select 1 from public.provider_tokens pt
      where pg_catalog.strpos(pg_catalog.row_to_json(pt)::text, ${quoteLiteral(plaintext)}) > 0
    )
    and not exists (
      select 1 from public.audit_logs al
      where pg_catalog.strpos(pg_catalog.row_to_json(al)::text, ${quoteLiteral(plaintext)}) > 0
    )
);
`);
  assert.deepEqual(connected, {
    account_count: 1,
    account_id_matches: true,
    account_shape: true,
    audit_count: 1,
    audit_safe: true,
    plaintext_absent: true,
    token_count: 1,
    token_shape: true
  });

  const repeated = await callRpc(database, {
    actor: IDS.owner,
    workspace: IDS.workspaceA,
    action: "connect",
    envelope: firstEncrypted.envelope
  });
  assert.equal(repeated[0].connected_account_id, accountId);
  const repeatFacts = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'accounts', (select pg_catalog.count(*) from public.connected_accounts where workspace_id = ${quoteLiteral(IDS.workspaceA)}::uuid and provider = 'vizard'),
  'tokens', (select pg_catalog.count(*) from public.provider_tokens where connected_account_id = ${quoteLiteral(accountId)}::uuid and token_kind = 'api_key'),
  'audits', (select pg_catalog.count(*) from public.audit_logs where workspace_id = ${quoteLiteral(IDS.workspaceA)}::uuid and event_type = 'vizard.connection.connected'),
  'latest_result', (select metadata->>'result' from public.audit_logs where workspace_id = ${quoteLiteral(IDS.workspaceA)}::uuid and event_type = 'vizard.connection.connected' order by created_at desc, id desc limit 1)
);
`);
  assert.deepEqual(repeatFacts, {
    accounts: 1,
    audits: 2,
    latest_result: "already_stored",
    tokens: 1
  });

  await callRpcExpectFailure(database, {
    actor: IDS.owner,
    workspace: IDS.workspaceA,
    action: "connect",
    envelope: reencrypted
  }, "23505", "VIZARD_CONNECTION_ALREADY_STORED");
  assert.equal(await queryScalar(database, `
select pg_catalog.count(*)::text from public.audit_logs
where workspace_id = ${quoteLiteral(IDS.workspaceA)}::uuid
  and event_type = 'vizard.connection.connected';
`), "2");

  await testProviderTokenDirectAccess(database);

  await psql(database, `
update public.connected_accounts
set status = 'connected',
    connected_at = pg_catalog.now(),
    last_sync_at = pg_catalog.now(),
    public_profile = '{"connection_method":"api_key","verification_state":"verified"}'::jsonb
where id = ${quoteLiteral(accountId)}::uuid;
`);
  const replaced = await callRpc(database, {
    actor: IDS.admin,
    workspace: IDS.workspaceA,
    action: "replace",
    envelope: replacement
  });
  assert.equal(replaced[0].connected_account_id, accountId);
  assert.equal(replaced[0].connection_state, "pending_verification");
  assert.equal(replaced[0].verification_state, "pending");
  const replaceFacts = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'account_id_stable', (select id = ${quoteLiteral(accountId)}::uuid from public.connected_accounts where workspace_id = ${quoteLiteral(IDS.workspaceA)}::uuid and provider = 'vizard'),
  'account_reset', (select status = 'pending_verification' and connected_at is null and last_sync_at is null from public.connected_accounts where id = ${quoteLiteral(accountId)}::uuid),
  'token_count', (select pg_catalog.count(*) from public.provider_tokens where connected_account_id = ${quoteLiteral(accountId)}::uuid and token_kind = 'api_key'),
  'new_ciphertext', (select encrypted_token = ${jsonbLiteral(replacement)} from public.provider_tokens where connected_account_id = ${quoteLiteral(accountId)}::uuid and token_kind = 'api_key'),
  'old_ciphertext_count', (select pg_catalog.count(*) from public.provider_tokens where connected_account_id = ${quoteLiteral(accountId)}::uuid and encrypted_token = ${jsonbLiteral(firstEncrypted.envelope)}),
  'audit_count', (select pg_catalog.count(*) from public.audit_logs where workspace_id = ${quoteLiteral(IDS.workspaceA)}::uuid and event_type = 'vizard.connection.replaced')
);
`);
  assert.deepEqual(replaceFacts, {
    account_id_stable: true,
    account_reset: true,
    audit_count: 1,
    new_ciphertext: true,
    old_ciphertext_count: 0,
    token_count: 1
  });

  const disconnected = await callRpc(database, {
    actor: IDS.admin,
    workspace: IDS.workspaceA,
    action: "disconnect"
  });
  assert.equal(disconnected[0].connected_account_id, accountId);
  assert.equal(disconnected[0].connection_state, "not_connected");
  assert.equal(disconnected[0].verification_state, "not_verified");
  const disconnectedAgain = await callRpc(database, {
    actor: IDS.admin,
    workspace: IDS.workspaceA,
    action: "disconnect"
  });
  assert.equal(disconnectedAgain[0].connected_account_id, accountId);
  const disconnectFacts = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'account_count', (select pg_catalog.count(*) from public.connected_accounts where id = ${quoteLiteral(accountId)}::uuid),
  'account_disconnected', (select status = 'not_connected' and connected_at is null and last_sync_at is null and public_profile->>'verification_state' = 'not_verified' from public.connected_accounts where id = ${quoteLiteral(accountId)}::uuid),
  'token_count', (select pg_catalog.count(*) from public.provider_tokens where connected_account_id = ${quoteLiteral(accountId)}::uuid and token_kind = 'api_key'),
  'audit_count', (select pg_catalog.count(*) from public.audit_logs where workspace_id = ${quoteLiteral(IDS.workspaceA)}::uuid and event_type = 'vizard.connection.disconnected'),
  'audit_safe', not exists (select 1 from public.audit_logs where workspace_id = ${quoteLiteral(IDS.workspaceA)}::uuid and metadata ?| array['iv', 'tag', 'value', 'encrypted_token', 'credential'])
);
`);
  assert.deepEqual(disconnectFacts, {
    account_count: 1,
    account_disconnected: true,
    audit_count: 2,
    audit_safe: true,
    token_count: 0
  });
}

async function seedManagedWorkspace(database, workspace, actor, name) {
  await psql(database, `
insert into public.workspaces(id, owner_user_id, name)
values (${quoteLiteral(workspace)}::uuid, ${quoteLiteral(actor)}::uuid, ${quoteLiteral(name)});
insert into public.workspace_members(workspace_id, user_id, role)
values (${quoteLiteral(workspace)}::uuid, ${quoteLiteral(actor)}::uuid, 'owner');
`);
}

async function assertWorkspaceEmpty(database, workspace) {
  const state = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'accounts', (select pg_catalog.count(*) from public.connected_accounts where workspace_id = ${quoteLiteral(workspace)}::uuid and provider = 'vizard'),
  'tokens', (select pg_catalog.count(*) from public.provider_tokens where workspace_id = ${quoteLiteral(workspace)}::uuid and provider = 'vizard'),
  'audits', (select pg_catalog.count(*) from public.audit_logs where workspace_id = ${quoteLiteral(workspace)}::uuid and provider = 'vizard')
);
`);
  assert.deepEqual(state, { accounts: 0, audits: 0, tokens: 0 });
}

async function connectionSnapshot(database, workspace, originalEnvelope, replacementEnvelope = null) {
  const replacementPredicate = replacementEnvelope === null
    ? "false"
    : `pt.encrypted_token = ${jsonbLiteral(replacementEnvelope)}`;
  return queryJson(database, `
select pg_catalog.jsonb_build_object(
  'account_id', (
    select ca.id::text from public.connected_accounts ca
    where ca.workspace_id = ${quoteLiteral(workspace)}::uuid
      and ca.provider = 'vizard' and ca.platform = 'vizard'
  ),
  'account_hash', (
    select pg_catalog.md5(pg_catalog.row_to_json(ca)::text)
    from public.connected_accounts ca
    where ca.workspace_id = ${quoteLiteral(workspace)}::uuid
      and ca.provider = 'vizard' and ca.platform = 'vizard'
  ),
  'status', (
    select ca.status from public.connected_accounts ca
    where ca.workspace_id = ${quoteLiteral(workspace)}::uuid
      and ca.provider = 'vizard' and ca.platform = 'vizard'
  ),
  'verification_state', (
    select ca.public_profile->>'verification_state' from public.connected_accounts ca
    where ca.workspace_id = ${quoteLiteral(workspace)}::uuid
      and ca.provider = 'vizard' and ca.platform = 'vizard'
  ),
  'token_count', (
    select pg_catalog.count(*) from public.provider_tokens pt
    where pt.workspace_id = ${quoteLiteral(workspace)}::uuid
      and pt.provider = 'vizard' and pt.token_kind = 'api_key'
  ),
  'token_hash', (
    select pg_catalog.md5(pg_catalog.string_agg(pg_catalog.row_to_json(pt)::text, '|' order by pt.id))
    from public.provider_tokens pt
    where pt.workspace_id = ${quoteLiteral(workspace)}::uuid
      and pt.provider = 'vizard' and pt.token_kind = 'api_key'
  ),
  'original_token_resolvable', exists (
    select 1 from public.provider_tokens pt
    where pt.workspace_id = ${quoteLiteral(workspace)}::uuid
      and pt.provider = 'vizard'
      and pt.token_kind = 'api_key'
      and pt.encrypted_token = ${jsonbLiteral(originalEnvelope)}
  ),
  'replacement_token_count', (
    select pg_catalog.count(*) from public.provider_tokens pt
    where pt.workspace_id = ${quoteLiteral(workspace)}::uuid
      and pt.provider = 'vizard'
      and pt.token_kind = 'api_key'
      and ${replacementPredicate}
  ),
  'connected_audits', (
    select pg_catalog.count(*) from public.audit_logs al
    where al.workspace_id = ${quoteLiteral(workspace)}::uuid
      and al.event_type = 'vizard.connection.connected'
  ),
  'replacement_audits', (
    select pg_catalog.count(*) from public.audit_logs al
    where al.workspace_id = ${quoteLiteral(workspace)}::uuid
      and al.event_type = 'vizard.connection.replaced'
  ),
  'disconnect_audits', (
    select pg_catalog.count(*) from public.audit_logs al
    where al.workspace_id = ${quoteLiteral(workspace)}::uuid
      and al.event_type = 'vizard.connection.disconnected'
  )
);
`);
}

async function markConnectionVerified(database, workspace) {
  await psql(database, `
update public.connected_accounts
set status = 'connected',
    connected_at = '2026-01-02 03:04:05+00'::timestamptz,
    last_sync_at = '2026-01-02 03:05:06+00'::timestamptz,
    public_profile = '{"connection_method":"api_key","verification_state":"verified"}'::jsonb,
    updated_at = '2026-01-02 03:06:07+00'::timestamptz
where workspace_id = ${quoteLiteral(workspace)}::uuid
  and provider = 'vizard' and platform = 'vizard';
update public.provider_tokens
set updated_at = '2026-01-02 03:06:08+00'::timestamptz
where workspace_id = ${quoteLiteral(workspace)}::uuid
  and provider = 'vizard' and token_kind = 'api_key';
`);
}

async function testMalformedEnvelopes(database) {
  const malformedCases = makeMalformedEnvelopeCases();
  for (const malformed of malformedCases) {
    const workspace = randomUUID();
    await seedManagedWorkspace(database, workspace, IDS.owner, `Malformed connect: ${malformed.name}`);
    const error = await callRpcExpectFailure(database, {
      actor: IDS.owner,
      workspace,
      action: "connect",
      envelope: malformed.value
    }, "22023", "VIZARD_CONNECTION_ENVELOPE_INVALID");
    assertSecretsAbsent(error.raw, `malformed connect ${malformed.name}`);
    await assertWorkspaceEmpty(database, workspace);
  }

  for (const malformed of malformedCases) {
    const workspace = randomUUID();
    const initial = makeEnvelope(`synthetic-malformed-replace-initial-${randomBytes(8).toString("hex")}`).envelope;
    await seedManagedWorkspace(database, workspace, IDS.owner, `Malformed replace: ${malformed.name}`);
    await callRpc(database, {
      actor: IDS.owner,
      workspace,
      action: "connect",
      envelope: initial
    });
    await markConnectionVerified(database, workspace);
    const before = await connectionSnapshot(database, workspace, initial);
    const error = await callRpcExpectFailure(database, {
      actor: IDS.owner,
      workspace,
      action: "replace",
      envelope: malformed.value
    }, "22023", "VIZARD_CONNECTION_ENVELOPE_INVALID");
    assertSecretsAbsent(error.raw, `malformed replace ${malformed.name}`);
    assert.deepEqual(await connectionSnapshot(database, workspace, initial), before);
    assert.equal(before.original_token_resolvable, true);
    assert.equal(before.replacement_audits, 0);
    assert.equal(before.status, "connected");
    assert.equal(before.verification_state, "verified");
  }
}

async function prepareStableConnection(database, label) {
  const workspace = randomUUID();
  const originalEnvelope = makeEnvelope(`synthetic-${label}-original-${randomBytes(8).toString("hex")}`).envelope;
  const replacementEnvelope = makeEnvelope(`synthetic-${label}-replacement-${randomBytes(8).toString("hex")}`).envelope;
  await seedManagedWorkspace(database, workspace, IDS.owner, `Synthetic ${label}`);
  await callRpc(database, {
    actor: IDS.owner,
    workspace,
    action: "connect",
    envelope: originalEnvelope
  });
  await markConnectionVerified(database, workspace);
  const before = await connectionSnapshot(database, workspace, originalEnvelope, replacementEnvelope);
  assert.equal(before.original_token_resolvable, true);
  assert.equal(before.replacement_token_count, 0);
  assert.equal(before.status, "connected");
  assert.equal(before.verification_state, "verified");
  return { workspace, originalEnvelope, replacementEnvelope, before };
}

async function testRollback(database) {
  const tokenEnvelope = makeEnvelope("synthetic-token-rollback").envelope;
  const auditEnvelope = makeEnvelope("synthetic-audit-rollback").envelope;
  const accountEnvelope = makeEnvelope("synthetic-account-rollback").envelope;
  await seedManagedWorkspace(database, IDS.rollbackToken, IDS.owner, "Synthetic token rollback");
  await seedManagedWorkspace(database, IDS.rollbackAudit, IDS.owner, "Synthetic audit rollback");
  await seedManagedWorkspace(database, IDS.rollbackAccount, IDS.owner, "Synthetic account rollback");

  await psql(database, `
create function public.test_vizard_fail_token_write()
returns trigger language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'TEST_TOKEN_WRITE_FAILURE';
end;
$$;
create trigger test_vizard_fail_token_write
before insert or update on public.provider_tokens
for each row execute function public.test_vizard_fail_token_write();
`);
  await callRpcExpectFailure(database, {
    actor: IDS.owner,
    workspace: IDS.rollbackToken,
    action: "connect",
    envelope: tokenEnvelope
  }, "P0001", "TEST_TOKEN_WRITE_FAILURE");
  await assertWorkspaceEmpty(database, IDS.rollbackToken);
  await psql(database, `
drop trigger test_vizard_fail_token_write on public.provider_tokens;
drop function public.test_vizard_fail_token_write();
`);

  await psql(database, `
create function public.test_vizard_fail_audit_write()
returns trigger language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'TEST_AUDIT_WRITE_FAILURE';
end;
$$;
create trigger test_vizard_fail_audit_write
before insert on public.audit_logs
for each row execute function public.test_vizard_fail_audit_write();
`);
  await callRpcExpectFailure(database, {
    actor: IDS.owner,
    workspace: IDS.rollbackAudit,
    action: "connect",
    envelope: auditEnvelope
  }, "P0001", "TEST_AUDIT_WRITE_FAILURE");
  await assertWorkspaceEmpty(database, IDS.rollbackAudit);
  await psql(database, `
drop trigger test_vizard_fail_audit_write on public.audit_logs;
drop function public.test_vizard_fail_audit_write();
`);

  await psql(database, `
create function public.test_vizard_fail_account_write()
returns trigger language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'TEST_ACCOUNT_WRITE_FAILURE';
end;
$$;
create trigger test_vizard_fail_account_write
before insert or update on public.connected_accounts
for each row execute function public.test_vizard_fail_account_write();
`);
  await callRpcExpectFailure(database, {
    actor: IDS.owner,
    workspace: IDS.rollbackAccount,
    action: "connect",
    envelope: accountEnvelope
  }, "P0001", "TEST_ACCOUNT_WRITE_FAILURE");
  await assertWorkspaceEmpty(database, IDS.rollbackAccount);
  await psql(database, `
drop trigger test_vizard_fail_account_write on public.connected_accounts;
drop function public.test_vizard_fail_account_write();
`);
}

async function testReplaceRollback(database) {
  const tokenFailure = await prepareStableConnection(database, "replace-token-rollback");
  await psql(database, `
create function public.test_vizard_fail_replace_token_write()
returns trigger language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'TEST_REPLACE_TOKEN_WRITE_FAILURE';
end;
$$;
create trigger test_vizard_fail_replace_token_write
before update on public.provider_tokens
for each row execute function public.test_vizard_fail_replace_token_write();
`);
  try {
    await callRpcExpectFailure(database, {
      actor: IDS.owner,
      workspace: tokenFailure.workspace,
      action: "replace",
      envelope: tokenFailure.replacementEnvelope
    }, "P0001", "TEST_REPLACE_TOKEN_WRITE_FAILURE");
    assert.deepEqual(
      await connectionSnapshot(
        database,
        tokenFailure.workspace,
        tokenFailure.originalEnvelope,
        tokenFailure.replacementEnvelope
      ),
      tokenFailure.before
    );
  } finally {
    await psql(database, `
drop trigger if exists test_vizard_fail_replace_token_write on public.provider_tokens;
drop function if exists public.test_vizard_fail_replace_token_write();
`);
  }

  const auditFailure = await prepareStableConnection(database, "replace-audit-rollback");
  await psql(database, `
create function public.test_vizard_fail_replace_audit_write()
returns trigger language plpgsql as $$
begin
  if new.event_type = 'vizard.connection.replaced' then
    raise exception using errcode = 'P0001', message = 'TEST_REPLACE_AUDIT_WRITE_FAILURE';
  end if;
  return new;
end;
$$;
create trigger test_vizard_fail_replace_audit_write
before insert on public.audit_logs
for each row execute function public.test_vizard_fail_replace_audit_write();
`);
  try {
    await callRpcExpectFailure(database, {
      actor: IDS.owner,
      workspace: auditFailure.workspace,
      action: "replace",
      envelope: auditFailure.replacementEnvelope
    }, "P0001", "TEST_REPLACE_AUDIT_WRITE_FAILURE");
    assert.deepEqual(
      await connectionSnapshot(
        database,
        auditFailure.workspace,
        auditFailure.originalEnvelope,
        auditFailure.replacementEnvelope
      ),
      auditFailure.before
    );
  } finally {
    await psql(database, `
drop trigger if exists test_vizard_fail_replace_audit_write on public.audit_logs;
drop function if exists public.test_vizard_fail_replace_audit_write();
`);
  }
}

async function testDisconnectRollback(database) {
  const rollback = await prepareStableConnection(database, "disconnect-rollback");
  await psql(database, `
create function public.test_vizard_fail_disconnect_audit_write()
returns trigger language plpgsql as $$
begin
  if new.event_type = 'vizard.connection.disconnected' then
    raise exception using errcode = 'P0001', message = 'TEST_DISCONNECT_AUDIT_WRITE_FAILURE';
  end if;
  return new;
end;
$$;
create trigger test_vizard_fail_disconnect_audit_write
before insert on public.audit_logs
for each row execute function public.test_vizard_fail_disconnect_audit_write();
`);
  try {
    await callRpcExpectFailure(database, {
      actor: IDS.owner,
      workspace: rollback.workspace,
      action: "disconnect"
    }, "P0001", "TEST_DISCONNECT_AUDIT_WRITE_FAILURE");
    assert.deepEqual(
      await connectionSnapshot(
        database,
        rollback.workspace,
        rollback.originalEnvelope,
        rollback.replacementEnvelope
      ),
      rollback.before
    );
  } finally {
    await psql(database, `
drop trigger if exists test_vizard_fail_disconnect_audit_write on public.audit_logs;
drop function if exists public.test_vizard_fail_disconnect_audit_write();
`);
  }

  await psql(database, `
create function public.test_vizard_fail_disconnect_account_write()
returns trigger language plpgsql as $$
begin
  if new.status = 'not_connected' then
    raise exception using errcode = 'P0001', message = 'TEST_DISCONNECT_ACCOUNT_WRITE_FAILURE';
  end if;
  return new;
end;
$$;
create trigger test_vizard_fail_disconnect_account_write
before update on public.connected_accounts
for each row execute function public.test_vizard_fail_disconnect_account_write();
`);
  try {
    await callRpcExpectFailure(database, {
      actor: IDS.owner,
      workspace: rollback.workspace,
      action: "disconnect"
    }, "P0001", "TEST_DISCONNECT_ACCOUNT_WRITE_FAILURE");
    assert.deepEqual(
      await connectionSnapshot(
        database,
        rollback.workspace,
        rollback.originalEnvelope,
        rollback.replacementEnvelope
      ),
      rollback.before
    );
  } finally {
    await psql(database, `
drop trigger if exists test_vizard_fail_disconnect_account_write on public.connected_accounts;
drop function if exists public.test_vizard_fail_disconnect_account_write();
`);
  }
}

function transactionalRpcSql(options, sleepSeconds) {
  return `
set role service_role;
begin;
select pg_catalog.count(*)
from public.social_cues_manage_vizard_connection(
  ${quoteLiteral(options.actor)}::uuid,
  ${quoteLiteral(options.workspace)}::uuid,
  ${quoteLiteral(options.action)}::text,
  ${options.envelope ? jsonbLiteral(options.envelope) : "null::jsonb"}
);
select pg_catalog.pg_sleep(${Number(sleepSeconds)});
commit;
reset role;
`;
}

async function runOverlappingCalls(database, firstOptions, secondOptions) {
  const first = psql(database, transactionalRpcSql(firstOptions, 0.45), { timeoutMs: 20_000 });
  await delay(100);
  const second = psql(database, transactionalRpcSql(secondOptions, 0), { timeoutMs: 20_000 });
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.code === 0));
}

async function testConcurrency(database) {
  const connectEnvelope = makeEnvelope("synthetic-concurrent-connect").envelope;
  const initialReplaceEnvelope = makeEnvelope("synthetic-concurrent-replace-initial").envelope;
  const replacementOne = makeEnvelope("synthetic-concurrent-replace-one").envelope;
  const replacementTwo = makeEnvelope("synthetic-concurrent-replace-two").envelope;
  const raceEnvelope = makeEnvelope("synthetic-connect-disconnect-race").envelope;

  await seedManagedWorkspace(database, IDS.concurrentConnect, IDS.owner, "Synthetic concurrent connect");
  await seedManagedWorkspace(database, IDS.concurrentReplace, IDS.owner, "Synthetic concurrent replace");
  await seedManagedWorkspace(database, IDS.concurrentRace, IDS.owner, "Synthetic concurrent race");

  await runOverlappingCalls(database, {
    actor: IDS.owner,
    workspace: IDS.concurrentConnect,
    action: "connect",
    envelope: connectEnvelope
  }, {
    actor: IDS.owner,
    workspace: IDS.concurrentConnect,
    action: "connect",
    envelope: connectEnvelope
  });
  const connectState = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'accounts', (select pg_catalog.count(*) from public.connected_accounts where workspace_id = ${quoteLiteral(IDS.concurrentConnect)}::uuid and provider = 'vizard' and platform = 'vizard'),
  'tokens', (select pg_catalog.count(*) from public.provider_tokens where workspace_id = ${quoteLiteral(IDS.concurrentConnect)}::uuid and provider = 'vizard' and token_kind = 'api_key'),
  'complete_envelope', (select encrypted_token = ${jsonbLiteral(connectEnvelope)} from public.provider_tokens where workspace_id = ${quoteLiteral(IDS.concurrentConnect)}::uuid and token_kind = 'api_key')
);
`);
  assert.deepEqual(connectState, { accounts: 1, complete_envelope: true, tokens: 1 });

  await callRpc(database, {
    actor: IDS.owner,
    workspace: IDS.concurrentReplace,
    action: "connect",
    envelope: initialReplaceEnvelope
  });
  const stableAccountId = await queryScalar(database, `
select id::text from public.connected_accounts
where workspace_id = ${quoteLiteral(IDS.concurrentReplace)}::uuid
  and provider = 'vizard' and platform = 'vizard';
`);
  await runOverlappingCalls(database, {
    actor: IDS.owner,
    workspace: IDS.concurrentReplace,
    action: "replace",
    envelope: replacementOne
  }, {
    actor: IDS.owner,
    workspace: IDS.concurrentReplace,
    action: "replace",
    envelope: replacementTwo
  });
  const replaceState = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'account_stable', (select id::text = ${quoteLiteral(stableAccountId)} from public.connected_accounts where workspace_id = ${quoteLiteral(IDS.concurrentReplace)}::uuid and provider = 'vizard'),
  'tokens', (select pg_catalog.count(*) from public.provider_tokens where workspace_id = ${quoteLiteral(IDS.concurrentReplace)}::uuid and token_kind = 'api_key'),
  'complete_envelope', (select encrypted_token in (${jsonbLiteral(replacementOne)}, ${jsonbLiteral(replacementTwo)}) from public.provider_tokens where workspace_id = ${quoteLiteral(IDS.concurrentReplace)}::uuid and token_kind = 'api_key')
);
`);
  assert.deepEqual(replaceState, { account_stable: true, complete_envelope: true, tokens: 1 });

  await runOverlappingCalls(database, {
    actor: IDS.owner,
    workspace: IDS.concurrentRace,
    action: "connect",
    envelope: raceEnvelope
  }, {
    actor: IDS.owner,
    workspace: IDS.concurrentRace,
    action: "disconnect"
  });
  const raceState = await queryJson(database, `
select pg_catalog.jsonb_build_object(
  'accounts', (select pg_catalog.count(*) from public.connected_accounts where workspace_id = ${quoteLiteral(IDS.concurrentRace)}::uuid and provider = 'vizard' and platform = 'vizard'),
  'status', (select status from public.connected_accounts where workspace_id = ${quoteLiteral(IDS.concurrentRace)}::uuid and provider = 'vizard' and platform = 'vizard'),
  'tokens', (select pg_catalog.count(*) from public.provider_tokens where workspace_id = ${quoteLiteral(IDS.concurrentRace)}::uuid and token_kind = 'api_key')
);
`);
  const validConnected = raceState.accounts === 1
    && raceState.status === "pending_verification"
    && raceState.tokens === 1;
  const validDisconnected = (
    (raceState.accounts === 0 && raceState.status === null && raceState.tokens === 0)
    || (raceState.accounts === 1 && raceState.status === "not_connected" && raceState.tokens === 0)
  );
  assert.equal(validConnected || validDisconnected, true);

  assert.equal(await queryScalar(database, `
select pg_catalog.count(*)::text from pg_catalog.pg_locks where locktype = 'advisory';
`), "0");
}

async function assertAllVizardAuditRowsSafe(database) {
  const sensitiveKeys = [
    "alg",
    "iv",
    "tag",
    "value",
    "encrypted_token",
    "encrypted_refresh_token",
    "credential",
    "api_key_value",
    "token_row"
  ];
  const secretPredicates = [...redactions]
    .filter((secret) => secret.length >= 8)
    .map((secret) => `pg_catalog.strpos(pg_catalog.row_to_json(al)::text, ${quoteLiteral(secret)}) > 0`);
  const unsafeCount = await queryScalar(database, `
select pg_catalog.count(*)::text
from public.audit_logs al
where al.provider = 'vizard'
  and (
    al.metadata ?| array[${sensitiveKeys.map(quoteLiteral).join(", ")}]
    or pg_catalog.row_to_json(al)::text ~ '"(alg|iv|tag|value|encrypted_token|encrypted_refresh_token|credential|api_key_value|token_row)"[[:space:]]*:'
    or exists (
      select 1
      from public.provider_tokens pt
      where pt.provider = 'vizard'
        and (
          pg_catalog.strpos(pg_catalog.row_to_json(al)::text, pt.id::text) > 0
          or pg_catalog.strpos(pg_catalog.row_to_json(al)::text, pt.encrypted_token::text) > 0
          or pg_catalog.strpos(pg_catalog.row_to_json(al)::text, pg_catalog.row_to_json(pt)::text) > 0
        )
    )
    ${secretPredicates.length > 0 ? `or ${secretPredicates.join("\n    or ")}` : ""}
  );
`);
  assert.equal(unsafeCount, "0", "a Vizard audit row contains credential material");
}

async function assertPostgresLogsSafe() {
  const logs = await runDocker(["logs", containerName], { allowFailure: true, timeoutMs: 20_000 });
  assert.equal(logs.code, 0, "could not inspect disposable PostgreSQL logs");
  assertSecretsAbsent(`${logs.stdout}\n${logs.stderr}`, "disposable PostgreSQL logs");
}

async function runRuntimeContract() {
  const inputs = await verifyCommittedInputs();
  await check("artifact-scoped Git preconditions and staged-harness allowance", async () => {
    assert.equal(inputs.migration.blob, EXPECTED_MIGRATION_BLOB);
    assert.equal(inputs.migration.sha256, EXPECTED_MIGRATION_SHA256);
  });
  await ensurePostgresImage();
  await check("cleanup after each partial-start fault-injection checkpoint", async () => {
    await testCleanupFaultInjections();
  });
  await startDisposableRuntime(inputs);
  const baseFixture = buildBaseFixture(inputs.starterSchema.content, inputs.perUserMigration.content);
  let primaryDatabase;

  await check("committed input and isolated PostgreSQL runtime", async () => {
    assert.match(postgresVersion, /^15\./u);
  });
  await check("clean migration execution, exact RPC, index, ownership, and reapply", async () => {
    primaryDatabase = await testFoundationalMigration(baseFixture);
  });
  await check("exact and mismatched index-definition runtime guards", async () => {
    await testIndexGuards(baseFixture);
  });
  await check("existing-data conflict rollback and unrelated-provider preservation", async () => {
    await testExistingDataConflict(baseFixture);
  });
  await check("function privileges and service-role table operations", async () => {
    await testFunctionPrivileges(primaryDatabase);
  });
  await seedLifecycleActors(primaryDatabase);
  await check("membership authorization and non-disclosing denials", async () => {
    await testMembershipAuthorization(primaryDatabase);
  });
  await check("malformed connect and replace envelopes reject without mutation", async () => {
    await testMalformedEnvelopes(primaryDatabase);
  });
  await check("connect, repeat-connect, safe output, replace, disconnect, and RLS", async () => {
    await testLifecycle(primaryDatabase);
  });
  await check("connect account, token, and audit failure rollback", async () => {
    await testRollback(primaryDatabase);
  });
  await check("replace token and audit failure rollback", async () => {
    await testReplaceRollback(primaryDatabase);
  });
  await check("disconnect account and audit failure rollback", async () => {
    await testDisconnectRollback(primaryDatabase);
  });
  await check("advisory-lock concurrency and complete final states", async () => {
    await testConcurrency(primaryDatabase);
  });
  await check("all Vizard audit rows exclude synthetic credential material", async () => {
    await assertAllVizardAuditRowsSafe(primaryDatabase);
  });
  await check("PostgreSQL logs exclude synthetic credential material", async () => {
    await assertPostgresLogsSafe();
  });

  return {
    migrationSha256: inputs.migration.sha256,
    schemaBlobs: {
      starter: inputs.starterSchema.blob,
      perUserMigration: inputs.perUserMigration.blob
    },
    fixtureTables: [
      "workspaces",
      "workspace_members",
      "connected_accounts",
      "provider_tokens",
      "billing_entitlements",
      "audit_logs"
    ]
  };
}

let runtimeResult;
let runtimeFailure = null;
let cleanupFailure = null;
async function handleInterruption(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  try {
    await cleanupDisposableRuntime();
  } finally {
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
}
process.once("SIGINT", () => { void handleInterruption("SIGINT"); });
process.once("SIGTERM", () => { void handleInterruption("SIGTERM"); });

try {
  runtimeResult = await runRuntimeContract();
} catch (error) {
  runtimeFailure = error;
} finally {
  try {
    await cleanupDisposableRuntime();
  } catch (error) {
    cleanupFailure = error;
  }
}

if (!runtimeFailure && !cleanupFailure) {
  try {
    assertSecretsAbsent(capturedOutputs.join("\n"), "captured stdout or stderr");
  } catch (error) {
    runtimeFailure = error;
  }
}

if (runtimeFailure || cleanupFailure) {
  const failures = [runtimeFailure, cleanupFailure].filter(Boolean);
  console.error(`FAIL ${redact(failures.map((error) => error.stack ?? error.message).join("\n"))}`);
  process.exitCode = 1;
} else {
  const report = {
    ok: true,
    runtime: "disposable standalone PostgreSQL",
    postgresVersion,
    postgresImage: POSTGRES_IMAGE,
    postgresLogSafety,
    repositoryHeadRequirement: "none; required committed artifacts are validated independently",
    committedMigrationBlob: EXPECTED_MIGRATION_BLOB,
    committedMigrationSha256: runtimeResult.migrationSha256,
    committedCanonicalSchemaBlobs: runtimeResult.schemaBlobs,
    canonicalFixtureTables: runtimeResult.fixtureTables,
    staticAndRuntimeCategories: passed,
    connectRetryBehavior: "state-stable with an additional safe already_stored audit event",
    reencryptedConnectBehavior: "rejected as VIZARD_CONNECTION_ALREADY_STORED",
    disconnectRetryBehavior: "state-stable with an additional safe disconnected audit event",
    postgrest: "unproven because no local Supabase/PostgREST runtime is installed",
    providerRequests: 0,
    hostPortsPublished: 0,
    cleanupComplete: true
  };
  assertSecretsAbsent(JSON.stringify(report), "harness report");
  console.log(JSON.stringify(report));
}
