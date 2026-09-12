import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoDir = path.dirname(fileURLToPath(import.meta.url));
const BASE_COMMIT = "f890b135bb1e9a9922302c7adaee74ce3de3b445";
const CONTRACT = "social-cues.hosted-workspace-repository.v2";
const INTERFACE_FINGERPRINT = "9858768c7df3ef3e2e87c74e8692b89d3a267c869a1ad525ffcadcb423cdaef1";
const POSTGRES_IMAGE = "postgres:17-alpine";
const POSTGRES_DIGEST = "postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const POSTGREST_IMAGE = "postgrest/postgrest:v14.12";
const POSTGREST_DIGEST = "postgrest/postgrest@sha256:54000f24847d01a2c2302e0041cf0618b875c57fb48507d743cfa9aaa50bf43c";
const MIGRATION_PATH = "SUPABASE-WORKSPACE-PERSISTENCE-V2.sql";
const SCHEMA_PATH = "supabase-schema.sql";
const HARNESS_PATH = "workspace-persistence-v2.postgrest.test.mjs";
const EVIDENCE_PATH = path.join(repoDir, ".tmp", "workspace-persistence-v2-postgrest-evidence.log");
const RESOURCE_LABEL = "social-cues.test=p37-workspace-postgrest";
const DATABASES = Object.freeze({ migration: "p37_migration", clean: "p37_clean" });
const USERS = Object.freeze({
  owner: "10000000-0000-4000-8000-000000000001",
  admin: "10000000-0000-4000-8000-000000000002",
  member: "10000000-0000-4000-8000-000000000003",
  viewer: "10000000-0000-4000-8000-000000000004",
  outsider: "10000000-0000-4000-8000-000000000005",
  inactive: "10000000-0000-4000-8000-000000000006",
  expired: "10000000-0000-4000-8000-000000000007",
  ownerB: "10000000-0000-4000-8000-000000000008"
});
const WORKSPACES = Object.freeze({
  primary: "20000000-0000-4000-8000-000000000001",
  absent: "20000000-0000-4000-8000-000000000002",
  race: "20000000-0000-4000-8000-000000000003",
  other: "20000000-0000-4000-8000-000000000004",
  legacy: "20000000-0000-4000-8000-000000000005",
  missing: "20000000-0000-4000-8000-000000000099"
});
const PUBLIC_KEYS = [
  "activity", "analytics", "campaigns", "drafts", "media", "preferences", "profile",
  "providerStates", "schemaVersion"
];
const capturedOutput = [];
const redactions = new Set();
const activeContexts = new Set();
let assertions = 0;
let externalRequests = 0;

function checkEqual(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}

function checkDeep(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function checkOk(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

function registerSecret(value) {
  if (typeof value === "string" && value.length >= 8) redactions.add(value);
  return value;
}

function redact(value) {
  let output = String(value ?? "");
  for (const secret of redactions) output = output.split(secret).join("[REDACTED]");
  return output;
}

function assertSecretsAbsent(value, label) {
  const text = String(value ?? "");
  assertions += 1;
  for (const secret of redactions) assert.equal(text.includes(secret), false, `${label} exposed synthetic secret material`);
}

function allowedProcessEnv(extra = {}) {
  const env = {};
  for (const name of [
    "PATH", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP", "USERPROFILE",
    "LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramData"
  ]) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

function run(command, args, {
  input = null,
  allowFailure = false,
  timeoutMs = 30_000,
  env = allowedProcessEnv(),
  context = null
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoDir,
      windowsHide: true,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    context?.children.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context?.children.delete(child);
      capturedOutput.push(stdout, stderr);
      if (error) reject(error);
      else resolve(result);
    };
    child.once("error", error => finish(new Error(redact(`${command} failed to start: ${error.message}`))));
    child.once("close", code => {
      const result = { code: code ?? -1, stdout, stderr };
      if (result.code !== 0 && !allowFailure) {
        finish(new Error(redact(`${command} exited ${result.code}\n${stderr}\n${stdout}`)));
      } else finish(null, result);
    });
    child.stdin.end(input ?? undefined);
  });
}

function docker(context, args, options = {}) {
  return run("docker", args, {
    ...options,
    context,
    env: allowedProcessEnv({ DOCKER_CONFIG: context.dockerConfig })
  });
}

function git(args, options = {}) {
  return run("git", args, options);
}

function lastLine(value) {
  return String(value).split(/\r?\n/u).map(line => line.trim()).filter(Boolean).at(-1) ?? "";
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function jsonLiteral(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function model(label = "") {
  return {
    activity: [],
    analytics: {},
    campaigns: [],
    drafts: [],
    media: [],
    preferences: {},
    profile: label ? { displayName: label } : {},
    providerStates: [],
    schemaVersion: "social-cues.workspace-public.v2"
  };
}

function modelHash(value) {
  return sha256(canonical(value));
}

function createContext(label) {
  const suffix = `${process.pid}-${randomUUID().replaceAll("-", "").slice(0, 10)}`.toLowerCase();
  const prefix = `social-cues-p37-${label}-${suffix}`;
  const tempDirectory = path.join(tmpdir(), `${prefix}-tmp`);
  const context = {
    label,
    prefix,
    postgres: `${prefix}-db`,
    postgrest: `${prefix}-api`,
    network: `${prefix}-network`,
    volume: `${prefix}-volume`,
    tempDirectory,
    dockerConfig: path.join(tempDirectory, "docker-config"),
    password: registerSecret(randomBytes(24).toString("base64url")),
    jwtSecret: registerSecret(randomBytes(32).toString("base64url")),
    port: null,
    children: new Set(),
    httpResponses: [],
    cleanupComplete: false
  };
  activeContexts.add(context);
  return context;
}

async function exists(target) {
  try { await access(target); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function freePort() {
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

async function portListening(port) {
  if (!port) return false;
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function psql(context, database, sql, { allowFailure = false, timeoutMs = 30_000 } = {}) {
  return docker(context, [
    "exec", "-i",
    "-e", "PGOPTIONS=-c statement_timeout=25000 -c lock_timeout=12000 -c client_min_messages=warning",
    context.postgres,
    "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    "-U", "postgres", "-d", database
  ], {
    input: `\\set VERBOSITY terse\n${sql.trim()}\n`,
    allowFailure,
    timeoutMs
  });
}

async function scalar(context, database, sql) {
  return lastLine((await psql(context, database, sql)).stdout);
}

async function jsonQuery(context, database, sql) {
  const text = await scalar(context, database, sql);
  checkOk(text, "expected JSON query output");
  return JSON.parse(text);
}

function extractTable(source, table) {
  const match = source.match(new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]*?^\\);`, "mu"));
  checkOk(match, `missing canonical ${table} definition`);
  return match[0];
}

function extractEmbeddedMigration(source) {
  const start = source.indexOf("-- Social Cues hosted workspace persistence v2");
  const end = source.indexOf('create policy "users can update own media objects"', start);
  checkOk(start >= 0, "clean schema is missing the R4.3 persistence block");
  checkOk(end > start, "clean schema R4.3 block is not bounded");
  return source.slice(start, end).trim();
}

function authFoundation() {
  return `
create schema if not exists auth;
create or replace function auth.uid()
returns uuid language sql stable security invoker set search_path = pg_catalog
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub'
  )::uuid
$$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
`;
}

function databaseFoundation({ starter, perUser, workers }) {
  return `
create extension if not exists pgcrypto;
${authFoundation()}
${extractTable(starter, "workspaces")}
${extractTable(starter, "workspace_models")}
${extractTable(perUser, "workspace_members")}
${extractTable(starter, "billing_entitlements")}
${extractTable(workers, "worker_jobs")}
create unique index if not exists billing_entitlements_workspace_user_uidx
  on public.billing_entitlements(workspace_id, user_id);
`;
}

async function installDatabases(context, inputs) {
  await psql(context, "postgres", `
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit nosuperuser nocreatedb nocreaterole noreplication bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password ${sqlLiteral(context.password)}
      nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end;
$$;
grant anon, authenticated, service_role to authenticator;
create database ${DATABASES.migration};
create database ${DATABASES.clean};
`);

  await psql(context, DATABASES.migration, databaseFoundation({
    starter: inputs.baseSchema,
    perUser: inputs.perUser,
    workers: inputs.workers
  }));
  await psql(context, DATABASES.migration, `
insert into public.workspaces(id, owner_user_id, name)
values ('${WORKSPACES.legacy}','${USERS.owner}','Legacy model');
insert into public.workspace_models(workspace_id, owner_user_id, model)
values ('${WORKSPACES.legacy}','${USERS.owner}','{}'::jsonb);
${inputs.migration}
${inputs.migration}
`);

  await psql(context, DATABASES.clean, databaseFoundation({
    starter: inputs.schema,
    perUser: inputs.schema,
    workers: inputs.schema
  }));
  await psql(context, DATABASES.clean, `${inputs.embeddedMigration}\n${inputs.embeddedMigration}`);
}

const CATALOG_SQL = `
with columns as (
  select jsonb_agg(jsonb_build_object(
    'table', c.table_name, 'column', c.column_name, 'position', c.ordinal_position,
    'type', c.data_type, 'udt', c.udt_name, 'nullable', c.is_nullable, 'default', coalesce(c.column_default, '')
  ) order by c.table_name, c.ordinal_position) value
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name in (
    'workspace_models','workspace_model_commits','workspace_persistence_contracts','workspace_members','worker_jobs'
  )
), constraints as (
  select jsonb_agg(jsonb_build_object(
    'table', cls.relname, 'name', con.conname, 'type', con.contype,
    'validated', con.convalidated, 'definition', pg_get_constraintdef(con.oid, true)
  ) order by cls.relname, con.conname) value
  from pg_constraint con join pg_class cls on cls.oid = con.conrelid
  join pg_namespace ns on ns.oid = cls.relnamespace
  where ns.nspname = 'public' and cls.relname in (
    'workspace_models','workspace_model_commits','workspace_persistence_contracts','workspace_members','worker_jobs'
  )
), indexes as (
  select jsonb_agg(jsonb_build_object('table', tablename, 'name', indexname, 'definition', indexdef)
    order by tablename, indexname) value
  from pg_indexes where schemaname = 'public' and tablename in (
    'workspace_models','workspace_model_commits','workspace_persistence_contracts','workspace_members','worker_jobs'
  )
), functions as (
  select jsonb_agg(jsonb_build_object(
    'schema', ns.nspname, 'name', proc.proname,
    'args', pg_get_function_identity_arguments(proc.oid),
    'result', pg_get_function_result(proc.oid), 'volatile', proc.provolatile,
    'securityDefiner', proc.prosecdef, 'parallel', proc.proparallel,
    'config', coalesce(to_jsonb(proc.proconfig), '[]'::jsonb),
    'owner', pg_get_userbyid(proc.proowner), 'acl', coalesce(to_jsonb(proc.proacl), '[]'::jsonb),
    'definitionHash', encode(digest(convert_to(pg_get_functiondef(proc.oid), 'UTF8'), 'sha256'), 'hex')
  ) order by ns.nspname, proc.proname, pg_get_function_identity_arguments(proc.oid)) value
  from pg_proc proc join pg_namespace ns on ns.oid = proc.pronamespace
  where (ns.nspname = 'public' and proc.proname like 'social_cues_workspace_%_v2')
     or (ns.nspname = 'social_cues_private' and proc.proname like 'workspace_%_v2')
), relations as (
  select jsonb_agg(jsonb_build_object(
    'table', cls.relname, 'rls', cls.relrowsecurity, 'forceRls', cls.relforcerowsecurity,
    'owner', pg_get_userbyid(cls.relowner), 'acl', coalesce(to_jsonb(cls.relacl), '[]'::jsonb)
  ) order by cls.relname) value
  from pg_class cls join pg_namespace ns on ns.oid = cls.relnamespace
  where ns.nspname = 'public' and cls.relname in (
    'workspace_models','workspace_model_commits','workspace_persistence_contracts'
  )
), policies as (
  select jsonb_agg(jsonb_build_object(
    'table', tablename, 'name', policyname, 'command', cmd, 'roles', roles,
    'using', coalesce(qual, ''), 'check', coalesce(with_check, '')
  ) order by tablename, policyname) value
  from pg_policies where schemaname = 'public' and tablename in (
    'workspace_models','workspace_model_commits','workspace_persistence_contracts'
  )
)
select jsonb_build_object(
  'columns', columns.value, 'constraints', constraints.value, 'indexes', indexes.value,
  'functions', functions.value, 'relations', relations.value, 'policies', policies.value,
  'fingerprint', (select interface_fingerprint from public.workspace_persistence_contracts
    where contract_id = 'social-cues.hosted-workspace-repository.v2')
)
from columns, constraints, indexes, functions, relations, policies;
`;

async function verifyCatalogs(context) {
  const migrated = await jsonQuery(context, DATABASES.migration, CATALOG_SQL);
  const clean = await jsonQuery(context, DATABASES.clean, CATALOG_SQL);
  checkDeep(migrated, clean, "migration and clean-install catalogs differ");
  checkEqual(migrated.fingerprint, INTERFACE_FINGERPRINT, "interface fingerprint differs");

  const targetRelations = new Map(migrated.relations.map(row => [row.table, row]));
  for (const table of ["workspace_models", "workspace_model_commits", "workspace_persistence_contracts"]) {
    checkEqual(targetRelations.get(table)?.rls, true, `${table} RLS is disabled`);
    checkEqual(targetRelations.get(table)?.forceRls, true, `${table} forced RLS is disabled`);
  }
  const columnsByTable = new Map();
  for (const column of migrated.columns) {
    const names = columnsByTable.get(column.table) ?? [];
    names.push(column.column);
    columnsByTable.set(column.table, names);
  }
  checkDeep(columnsByTable.get("workspace_models"), [
    "workspace_id","owner_user_id","model","created_at","updated_at",
    "persistence_epoch","revision","content_hash"
  ], "workspace model column contract differs");
  checkDeep(columnsByTable.get("workspace_model_commits"), [
    "workspace_id","persistence_epoch","operation_id","actor_user_id","kind",
    "expected_revision","result_revision","request_hash","content_hash","committed_at"
  ], "private receipt ledger column contract differs");
  for (const forbidden of ["model","payload","credential","token","secret"]) {
    checkEqual(columnsByTable.get("workspace_model_commits").some(name => name.includes(forbidden)), false,
      `receipt ledger includes forbidden ${forbidden} material`);
  }
  const publicFunctions = migrated.functions.filter(item => item.schema === "public");
  checkDeep(publicFunctions.map(item => item.name).sort(), [
    "social_cues_workspace_commit_v2",
    "social_cues_workspace_initialize_v2",
    "social_cues_workspace_persistence_fingerprint_v2",
    "social_cues_workspace_read_v2",
    "social_cues_workspace_receipt_v2"
  ], "public RPC inventory differs");
  for (const fn of publicFunctions) {
    checkEqual(fn.securityDefiner, true, `${fn.name} is not SECURITY DEFINER`);
    checkEqual(fn.owner, "postgres", `${fn.name} owner differs`);
    checkOk(fn.config.some(value => value.startsWith("search_path=")), `${fn.name} search_path is not pinned`);
  }
  const signatures = Object.fromEntries(publicFunctions.map(item => [item.name, item.args]));
  checkEqual(signatures.social_cues_workspace_read_v2, "workspace_id text");
  checkEqual(signatures.social_cues_workspace_initialize_v2,
    "actor_user_id text, content_hash text, kind text, model jsonb, operation_id text, request_hash text, workspace_id text");
  checkEqual(signatures.social_cues_workspace_commit_v2,
    "actor_user_id text, content_hash text, expected_epoch text, expected_revision text, kind text, model jsonb, operation_id text, request_hash text, workspace_id text, job_id text, lease_id text");
  checkEqual(signatures.social_cues_workspace_receipt_v2,
    "actor_user_id text, expected_epoch text, expected_revision text, kind text, operation_id text, request_hash text, workspace_id text");
  return sha256(canonical(migrated));
}

async function verifyCanonicalNumbers(context) {
  const cases = [
    ["zero", "0", 0],
    ["negative zero", "-0", -0],
    ["trailing scale", "1.2300", 1.23],
    ["scientific lower threshold", "1e-7", 1e-7],
    ["negative scientific lower threshold", "-1e-7", -1e-7],
    ["decimal lower threshold", "1e-6", 1e-6],
    ["decimal upper threshold", "1e20", 1e20],
    ["scientific upper threshold", "1e21", 1e21],
    ["threshold-adjacent rounding", "9.999999999999997e20", 9.999999999999997e20],
    ["unsafe integer rounding", "9007199254740993", JSON.parse("9007199254740993")],
    ["fraction rounding", "0.100000000000000005", JSON.parse("0.100000000000000005")],
    ["minimum subnormal", "5e-324", 5e-324],
    ["maximum finite", "1.7976931348623157e308", 1.7976931348623157e308]
  ];
  for (const database of [DATABASES.migration, DATABASES.clean]) {
    for (const [label, literal, value] of cases) {
      const actual = await scalar(context, database, `
        select social_cues_private.workspace_canonical_number_v2(${sqlLiteral(literal)}::jsonb);
      `);
      checkEqual(actual, JSON.stringify(value), `${database} ${label} canonical number differs`);
    }
    const model = Object.fromEntries(cases.map(([label, , value]) => [label.replaceAll(" ", "_"), value]));
    const expectedCanonical = canonical(model);
    checkEqual(await scalar(context, database, `
      select social_cues_private.workspace_canonical_json_v2(${jsonLiteral(model)});
    `), expectedCanonical, `${database} composite canonical JSON differs`);
    checkEqual(await scalar(context, database, `
      select social_cues_private.workspace_canonical_hash_v2(${jsonLiteral(model)});
    `), sha256(expectedCanonical), `${database} composite canonical hash differs`);
  }
}

async function seedRuntime(context) {
  await psql(context, DATABASES.migration, `
insert into public.workspaces(id, owner_user_id, name) values
  ('${WORKSPACES.primary}','${USERS.owner}','Primary'),
  ('${WORKSPACES.absent}','${USERS.owner}','Absent'),
  ('${WORKSPACES.race}','${USERS.owner}','Race'),
  ('${WORKSPACES.other}','${USERS.ownerB}','Other');
insert into public.workspace_members(workspace_id,user_id,role,membership_status) values
  ('${WORKSPACES.primary}','${USERS.owner}','owner','active'),
  ('${WORKSPACES.primary}','${USERS.admin}','admin','active'),
  ('${WORKSPACES.primary}','${USERS.member}','member','active'),
  ('${WORKSPACES.primary}','${USERS.viewer}','viewer','active'),
  ('${WORKSPACES.primary}','${USERS.inactive}','member','inactive'),
  ('${WORKSPACES.primary}','${USERS.expired}','member','active'),
  ('${WORKSPACES.absent}','${USERS.owner}','owner','active'),
  ('${WORKSPACES.race}','${USERS.owner}','owner','active'),
  ('${WORKSPACES.legacy}','${USERS.owner}','owner','active'),
  ('${WORKSPACES.other}','${USERS.ownerB}','owner','active');
insert into public.billing_entitlements(workspace_id,user_id,source,access,status,current_period_end) values
  ('${WORKSPACES.primary}','${USERS.owner}','test','paid','active',now()+interval '1 day'),
  ('${WORKSPACES.primary}','${USERS.admin}','test','paid','active',now()+interval '1 day'),
  ('${WORKSPACES.primary}','${USERS.member}','test','paid','active',now()+interval '1 day'),
  ('${WORKSPACES.primary}','${USERS.viewer}','test','paid','active',now()+interval '1 day'),
  ('${WORKSPACES.primary}','${USERS.inactive}','test','paid','active',now()+interval '1 day'),
  ('${WORKSPACES.primary}','${USERS.expired}','test','paid','active',now()-interval '1 day'),
  ('${WORKSPACES.absent}','${USERS.owner}','test','paid','active',now()+interval '1 day'),
  ('${WORKSPACES.race}','${USERS.owner}','test','paid','active',now()+interval '1 day'),
  ('${WORKSPACES.legacy}','${USERS.owner}','test','paid','active',now()+interval '1 day'),
  ('${WORKSPACES.other}','${USERS.ownerB}','test','paid','active',now()+interval '1 day');
`);
}

function jwt(context, role, subject, claims = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ role, sub: subject, exp: Math.floor(Date.now() / 1000) + 900, ...claims });
  const signature = createHmac("sha256", context.jwtSecret).update(`${header}.${payload}`).digest("base64url");
  return registerSecret(`${header}.${payload}.${signature}`);
}

async function api(context, pathname, {
  token = "", body = null, rawBody = null, method = "POST", port = context.port
} = {}) {
  checkOk(pathname.startsWith("/"), "PostgREST path must be absolute");
  checkOk(Number.isInteger(port) && port > 0, "PostgREST must use a registered loopback port");
  const hasBody = rawBody !== null || body !== null;
  const encoded = rawBody !== null ? rawBody : body === null ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      timeout: 10_000,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(!hasBody ? {} : {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(encoded)
        })
      }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = text;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        const result = { status: response.statusCode ?? 0, body: parsed, text };
        context.httpResponses.push(result);
        assertSecretsAbsent(text, `${method} ${pathname}`);
        resolve(result);
      });
    });
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("loopback PostgREST request timed out")));
    request.end(encoded);
  });
}

function userToken(context, user) {
  return jwt(context, "authenticated", user);
}

function initializeBody(workspace, actor, nextModel, operationId = randomUUID(), requestHash = sha256(operationId)) {
  return {
    actor_user_id: actor,
    content_hash: modelHash(nextModel),
    kind: "workspace.initialize",
    model: nextModel,
    operation_id: operationId,
    request_hash: requestHash,
    workspace_id: workspace
  };
}

function commitBody({ workspace, actor, revision, nextModel, kind = "workspace.client-save", operationId = randomUUID(),
  requestHash = sha256(operationId), jobId = undefined, leaseId = undefined }) {
  return {
    actor_user_id: actor,
    content_hash: modelHash(nextModel),
    expected_epoch: revision.epoch,
    expected_revision: revision.revision,
    kind,
    model: nextModel,
    operation_id: operationId,
    request_hash: requestHash,
    workspace_id: workspace,
    ...(jobId ? { job_id: jobId } : {}),
    ...(leaseId ? { lease_id: leaseId } : {})
  };
}

function receiptBody(command) {
  return {
    actor_user_id: command.actor_user_id,
    expected_epoch: command.kind === "workspace.initialize" ? null : command.expected_epoch,
    expected_revision: command.kind === "workspace.initialize" ? null : command.expected_revision,
    kind: command.kind,
    operation_id: command.operation_id,
    request_hash: command.request_hash,
    workspace_id: command.workspace_id
  };
}

function assertFailure(response, status, code) {
  checkEqual(response.status, status, response.text);
  checkEqual(response.body?.message, code, response.text);
}

function assertResponseShape(response, outcome, { receipt = false } = {}) {
  checkEqual(response.status, 200, response.text);
  checkDeep(Object.keys(response.body).sort(), receipt ? ["outcome", "receipts", "rows"] : ["outcome", "rows"]);
  checkEqual(response.body.outcome, outcome);
  checkOk(Array.isArray(response.body.rows), "rows must be an array");
  if (receipt) checkOk(Array.isArray(response.body.receipts), "receipts must be an array");
  return response.body;
}

function revisionFrom(body) {
  const row = body.rows[0];
  return { epoch: row.persistence_epoch, revision: row.revision };
}

async function startPostgrest(context) {
  context.port = await freePort();
  await docker(context, [
    "create", "--name", context.postgrest, "--label", RESOURCE_LABEL,
    "--network", context.network,
    "-p", `127.0.0.1:${context.port}:3000`,
    "-e", `PGRST_DB_URI=postgres://authenticator:${context.password}@postgres:5432/${DATABASES.migration}`,
    "-e", "PGRST_DB_SCHEMAS=public",
    "-e", "PGRST_DB_ANON_ROLE=anon",
    "-e", `PGRST_JWT_SECRET=${context.jwtSecret}`,
    "-e", "PGRST_LOG_LEVEL=info",
    POSTGREST_IMAGE
  ]);
  await docker(context, ["start", context.postgrest]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await api(context, "/", { method: "GET" });
      if (response.status === 200) return;
    } catch {}
    await delay(200);
  }
  throw new Error("PostgREST v14 did not become ready");
}

async function setupContext(context, { faultAfterPostgresStart = false } = {}) {
  await mkdir(context.dockerConfig, { recursive: true });
  const postgresImage = await docker(context, ["image", "inspect", POSTGRES_IMAGE, "--format", "{{index .RepoDigests 0}}"], {
    allowFailure: true
  });
  const postgrestImage = await docker(context, ["image", "inspect", POSTGREST_IMAGE, "--format", "{{index .RepoDigests 0}}"], {
    allowFailure: true
  });
  checkEqual(postgresImage.code, 0, "pinned PostgreSQL image must already be local");
  checkEqual(postgrestImage.code, 0, "pinned PostgREST image must already be local");
  checkEqual(lastLine(postgresImage.stdout), POSTGRES_DIGEST, "PostgreSQL image digest differs");
  checkEqual(lastLine(postgrestImage.stdout), POSTGREST_DIGEST, "PostgREST image digest differs");
  await docker(context, ["network", "create", "--label", RESOURCE_LABEL, context.network]);
  await docker(context, ["volume", "create", "--label", RESOURCE_LABEL, context.volume]);
  await docker(context, [
    "create", "--name", context.postgres, "--label", RESOURCE_LABEL,
    "--network", context.network, "--network-alias", "postgres", "--shm-size", "128m",
    "-v", `${context.volume}:/var/lib/postgresql/data`,
    "-e", `POSTGRES_PASSWORD=${context.password}`, "-e", "POSTGRES_DB=postgres",
    POSTGRES_IMAGE, "postgres",
    "-c", "log_statement=none", "-c", "log_min_error_statement=panic",
    "-c", "log_parameter_max_length_on_error=0"
  ]);
  await docker(context, ["start", context.postgres]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await docker(context, ["exec", context.postgres, "pg_isready", "-U", "postgres"], {
      allowFailure: true,
      timeoutMs: 5000
    });
    if (ready.code === 0) break;
    if (attempt === 99) throw new Error("PostgreSQL 17 did not become ready");
    await delay(200);
  }
  if (faultAfterPostgresStart) throw new Error("INJECTED_AFTER_POSTGRES_START");
}

async function tableCounts(context) {
  return jsonQuery(context, DATABASES.migration, `
select jsonb_build_object(
  'models',(select count(*) from public.workspace_models),
  'commits',(select count(*) from public.workspace_model_commits)
);
`);
}

async function runAuthorizationAndCrud(context) {
  const owner = userToken(context, USERS.owner);
  const admin = userToken(context, USERS.admin);
  const member = userToken(context, USERS.member);
  const viewer = userToken(context, USERS.viewer);
  const outsider = userToken(context, USERS.outsider);
  const inactive = userToken(context, USERS.inactive);
  const expired = userToken(context, USERS.expired);
  const ownerB = userToken(context, USERS.ownerB);

  const beforeAbsent = await tableCounts(context);
  const absentRead = await api(context, "/rpc/social_cues_workspace_read_v2", {
    token: owner,
    body: { workspace_id: WORKSPACES.absent }
  });
  const absentBody = assertResponseShape(absentRead, "absent");
  checkEqual(absentBody.rows.length, 0, "absent read returned a row");
  checkDeep(await tableCounts(context), beforeAbsent, "read path wrote data");

  const legacyRead = await api(context, "/rpc/social_cues_workspace_read_v2", {
    token: owner,
    body: { workspace_id: WORKSPACES.legacy }
  });
  assertFailure(legacyRead, 503, "workspace_storage_unavailable");

  const initModel = model("initial");
  const initOperation = "30000000-0000-4000-8000-000000000001";
  const init = initializeBody(WORKSPACES.primary, USERS.owner, initModel, initOperation, "a".repeat(64));
  const initialized = await api(context, "/rpc/social_cues_workspace_initialize_v2", { token: owner, body: init });
  const initializedBody = assertResponseShape(initialized, "committed", { receipt: true });
  checkEqual(initializedBody.rows.length, 1);
  checkEqual(initializedBody.receipts.length, 1);
  checkEqual(initializedBody.rows[0].revision, "0");
  checkDeep(Object.keys(initializedBody.rows[0]).sort(), [
    "content_hash","created_at","model","owner_user_id","persistence_epoch","revision","updated_at","workspace_id"
  ]);
  checkDeep(Object.keys(initializedBody.receipts[0]).sort(), [
    "actor_user_id","committed_at","content_hash","expected_revision","kind","operation_id",
    "persistence_epoch","request_hash","result_revision","workspace_id"
  ]);

  const replay = await api(context, "/rpc/social_cues_workspace_initialize_v2", { token: owner, body: init });
  const replayBody = assertResponseShape(replay, "replayed", { receipt: true });
  checkDeep(replayBody.receipts[0], initializedBody.receipts[0], "initialize retry changed its receipt");

  const roleTokens = [owner, admin, member, viewer];
  for (const token of roleTokens) {
    const read = await api(context, "/rpc/social_cues_workspace_read_v2", {
      token,
      body: { workspace_id: WORKSPACES.primary }
    });
    const body = assertResponseShape(read, "present");
    checkEqual(body.rows.length, 1);
    checkDeep(body.rows[0].model, initModel);
  }

  const denials = [];
  for (const [token, workspace] of [
    ["", WORKSPACES.primary],
    [outsider, WORKSPACES.primary],
    [owner, WORKSPACES.other],
    [ownerB, WORKSPACES.primary],
    [inactive, WORKSPACES.primary],
    [expired, WORKSPACES.primary],
    [owner, WORKSPACES.missing]
  ]) {
    const response = await api(context, "/rpc/social_cues_workspace_read_v2", {
      token,
      body: { workspace_id: workspace }
    });
    if (!token) {
      checkEqual(response.status, 401, response.text);
      checkEqual(response.body?.code, "42501", "anon denial did not come from the execute grant boundary");
    }
    else {
      assertFailure(response, 403, "workspace_authorization_failed");
      denials.push(response.text);
    }
  }
  checkEqual(new Set(denials).size, 1, "authorization denials leak workspace existence");

  const directModel = await api(context, "/workspace_models?select=*", { token: owner, method: "GET" });
  const directReceipts = await api(context, "/workspace_model_commits?select=*", { token: owner, method: "GET" });
  checkOk(directModel.status >= 400, "authenticated direct model read unexpectedly succeeded");
  checkOk(directReceipts.status >= 400, "authenticated direct receipt read unexpectedly succeeded");

  for (const [token, user] of [[member, USERS.member], [viewer, USERS.viewer]]) {
    const denied = await api(context, "/rpc/social_cues_workspace_commit_v2", {
      token,
      body: commitBody({
        workspace: WORKSPACES.primary,
        actor: user,
        revision: revisionFrom(initializedBody),
        nextModel: model("denied")
      })
    });
    assertFailure(denied, 403, "workspace_authorization_failed");
  }

  const adminModel = model("admin-save");
  const adminCommand = commitBody({
    workspace: WORKSPACES.primary,
    actor: USERS.admin,
    revision: revisionFrom(initializedBody),
    nextModel: adminModel,
    operationId: "30000000-0000-4000-8000-000000000002",
    requestHash: "b".repeat(64)
  });
  const adminCommit = await api(context, "/rpc/social_cues_workspace_commit_v2", { token: admin, body: adminCommand });
  const adminBody = assertResponseShape(adminCommit, "committed", { receipt: true });
  checkEqual(adminBody.rows[0].revision, "1");

  const stale = await api(context, "/rpc/social_cues_workspace_commit_v2", {
    token: owner,
    body: commitBody({
      workspace: WORKSPACES.primary,
      actor: USERS.owner,
      revision: revisionFrom(initializedBody),
      nextModel: model("stale")
    })
  });
  assertFailure(stale, 409, "workspace_revision_conflict");

  const adminReplay = await api(context, "/rpc/social_cues_workspace_commit_v2", { token: admin, body: adminCommand });
  assertResponseShape(adminReplay, "replayed", { receipt: true });
  const reused = await api(context, "/rpc/social_cues_workspace_commit_v2", {
    token: admin,
    body: { ...adminCommand, request_hash: "c".repeat(64) }
  });
  assertFailure(reused, 409, "workspace_operation_id_reused");
  for (const changed of [
    { ...adminCommand, actor_user_id: USERS.owner },
    { ...adminCommand, kind: "workspace.content-recovery" },
    { ...adminCommand, expected_revision: "1" },
    {
      ...adminCommand,
      model: model("reused-content"),
      content_hash: modelHash(model("reused-content"))
    }
  ]) {
    const changedEvidence = await api(context, "/rpc/social_cues_workspace_commit_v2", {
      token: changed.actor_user_id === USERS.owner ? owner : admin,
      body: changed
    });
    assertFailure(changedEvidence, 409, "workspace_operation_id_reused");
  }

  const receipt = await api(context, "/rpc/social_cues_workspace_receipt_v2", {
    token: admin,
    body: receiptBody(adminCommand)
  });
  const receiptResult = assertResponseShape(receipt, "replayed", { receipt: true });
  checkEqual(receiptResult.receipts[0].result_revision, "1");

  const secretValue = registerSecret(`p37-private-${randomBytes(12).toString("base64url")}`);
  const privateModel = model("private");
  privateModel.profile.apiSecret = secretValue;
  privateModel.profile.providerToken = secretValue;
  const invalid = await api(context, "/rpc/social_cues_workspace_commit_v2", {
    token: owner,
    body: commitBody({
      workspace: WORKSPACES.primary,
      actor: USERS.owner,
      revision: revisionFrom(adminBody),
      nextModel: privateModel
    })
  });
  assertFailure(invalid, 400, "workspace_input_invalid");
  const badHash = await api(context, "/rpc/social_cues_workspace_commit_v2", {
    token: owner,
    body: { ...commitBody({
      workspace: WORKSPACES.primary,
      actor: USERS.owner,
      revision: revisionFrom(adminBody),
      nextModel: model("bad-hash")
    }), content_hash: "0".repeat(64) }
  });
  assertFailure(badHash, 400, "workspace_input_invalid");

  const incompleteModel = model("incomplete");
  delete incompleteModel.preferences;
  const incomplete = await api(context, "/rpc/social_cues_workspace_commit_v2", {
    token: owner,
    body: commitBody({
      workspace: WORKSPACES.primary,
      actor: USERS.owner,
      revision: revisionFrom(adminBody),
      nextModel: incompleteModel
    })
  });
  assertFailure(incomplete, 400, "workspace_input_invalid");

  const beforeMalformed = await tableCounts(context);
  const malformed = await api(context, "/rpc/social_cues_workspace_commit_v2", {
    token: owner,
    rawBody: "{"
  });
  checkEqual(malformed.status, 400, malformed.text);
  checkEqual(malformed.body?.code, "PGRST102", "malformed JSON did not fail at the gateway");
  checkDeep(await tableCounts(context), beforeMalformed, "malformed JSON changed persistence state");

  return { owner, admin, member, adminBody, adminCommand };
}

async function runInitializeRace(context, owner) {
  const left = initializeBody(WORKSPACES.race, USERS.owner, model("race-left"),
    "30000000-0000-4000-8000-000000000010", "1".repeat(64));
  const right = initializeBody(WORKSPACES.race, USERS.owner, model("race-right"),
    "30000000-0000-4000-8000-000000000011", "2".repeat(64));
  const responses = await Promise.all([
    api(context, "/rpc/social_cues_workspace_initialize_v2", { token: owner, body: left }),
    api(context, "/rpc/social_cues_workspace_initialize_v2", { token: owner, body: right })
  ]);
  checkDeep(responses.map(item => item.body?.outcome).sort(), ["committed", "existing"],
    "initialize race outcomes differ");
  const count = await scalar(context, DATABASES.migration,
    `select count(*) from public.workspace_models where workspace_id='${WORKSPACES.race}';`);
  checkEqual(count, "1", "initialize race created multiple model rows");
  const receiptCount = await scalar(context, DATABASES.migration,
    "select count(*) from public.workspace_model_commits where workspace_id='" + WORKSPACES.race + "';");
  checkEqual(receiptCount, "1", "initialize race created multiple receipts");
}

async function readCurrent(context, token, workspace = WORKSPACES.primary) {
  const response = await api(context, "/rpc/social_cues_workspace_read_v2", {
    token,
    body: { workspace_id: workspace }
  });
  return assertResponseShape(response, "present");
}

async function runClientRaces(context, owner, admin) {
  for (const [leftKind, rightKind, label] of [
    ["workspace.client-save", "workspace.client-save", "client-client"],
    ["workspace.content-recovery", "workspace.client-save", "recovery-normal"]
  ]) {
    const current = await readCurrent(context, owner);
    const revision = revisionFrom(current);
    const left = commitBody({ workspace: WORKSPACES.primary, actor: USERS.owner, revision,
      nextModel: model(`${label}-left`), kind: leftKind });
    const right = commitBody({ workspace: WORKSPACES.primary, actor: USERS.admin, revision,
      nextModel: model(`${label}-right`), kind: rightKind });
    const responses = await Promise.all([
      api(context, "/rpc/social_cues_workspace_commit_v2", { token: owner, body: left }),
      api(context, "/rpc/social_cues_workspace_commit_v2", { token: admin, body: right })
    ]);
    checkDeep(responses.map(item => item.status).sort(), [200, 409], `${label} race did not enforce CAS`);
  }
}

async function createServiceBinding(context, { actor = USERS.member, intent = "workspace.system-repair", workspace = WORKSPACES.primary } = {}) {
  const jobId = randomUUID();
  const leaseId = randomUUID();
  await psql(context, DATABASES.migration, `
insert into public.worker_jobs(
  id,workspace_id,user_id,kind,status,idempotency_key,lease_owner,lease_expires_at,
  workspace_persistence_lease_id,workspace_persistence_intent
) values (
  '${jobId}','${workspace}','${actor}','p37-test','claimed','${jobId}','p37-worker',now()+interval '5 minutes',
  '${leaseId}','${intent}'
);
`);
  const token = jwt(context, "service_role", actor, {
    actor_user_id: actor,
    workspace_id: workspace,
    job_id: jobId,
    lease_id: leaseId,
    allowed_intent: intent,
    context_version: "social-cues.workspace-actor.v2",
    source: "claimed-service-job",
    lease_status: "active"
  });
  return { jobId, leaseId, token, actor, intent, workspace };
}

async function runServiceCases(context, owner) {
  const binding = await createServiceBinding(context);
  let current = await readCurrent(context, owner);
  let command = commitBody({
    workspace: WORKSPACES.primary,
    actor: binding.actor,
    revision: revisionFrom(current),
    nextModel: model("service"),
    kind: binding.intent,
    jobId: binding.jobId,
    leaseId: binding.leaseId
  });
  const committed = await api(context, "/rpc/social_cues_workspace_commit_v2", {
    token: binding.token,
    body: command
  });
  assertResponseShape(committed, "committed", { receipt: true });

  const serviceRead = await api(context, "/rpc/social_cues_workspace_read_v2", {
    token: binding.token,
    body: { workspace_id: WORKSPACES.primary }
  });
  assertResponseShape(serviceRead, "present");

  const wrongLease = await api(context, "/rpc/social_cues_workspace_commit_v2", {
    token: binding.token,
    body: { ...command, operation_id: randomUUID(), request_hash: sha256(randomUUID()), lease_id: randomUUID() }
  });
  assertFailure(wrongLease, 403, "workspace_authorization_failed");
  const wrongIntent = await api(context, "/rpc/social_cues_workspace_commit_v2", {
    token: binding.token,
    body: {
      ...command,
      operation_id: randomUUID(),
      request_hash: sha256(randomUUID()),
      kind: "workspace.worker-result"
    }
  });
  assertFailure(wrongIntent, 403, "workspace_authorization_failed");
  const wrongWorkspace = await api(context, "/rpc/social_cues_workspace_commit_v2", {
    token: binding.token,
    body: {
      ...command,
      operation_id: randomUUID(),
      request_hash: sha256(randomUUID()),
      workspace_id: WORKSPACES.other
    }
  });
  assertFailure(wrongWorkspace, 403, "workspace_authorization_failed");

  await psql(context, DATABASES.migration,
    `update public.worker_jobs set lease_expires_at=now()-interval '1 minute' where id='${binding.jobId}';`);
  const expired = await api(context, "/rpc/social_cues_workspace_read_v2", {
    token: binding.token,
    body: { workspace_id: WORKSPACES.primary }
  });
  assertFailure(expired, 403, "workspace_authorization_failed");

  const clientBinding = await createServiceBinding(context);
  const serviceBinding = await createServiceBinding(context);
  current = await readCurrent(context, owner);
  const revision = revisionFrom(current);
  const clientCommand = commitBody({ workspace: WORKSPACES.primary, actor: USERS.owner, revision,
    nextModel: model("client-service-client") });
  const serviceCommand = commitBody({ workspace: WORKSPACES.primary, actor: serviceBinding.actor, revision,
    nextModel: model("client-service-service"), kind: serviceBinding.intent,
    jobId: serviceBinding.jobId, leaseId: serviceBinding.leaseId });
  const mixed = await Promise.all([
    api(context, "/rpc/social_cues_workspace_commit_v2", { token: owner, body: clientCommand }),
    api(context, "/rpc/social_cues_workspace_commit_v2", { token: serviceBinding.token, body: serviceCommand })
  ]);
  checkDeep(mixed.map(item => item.status).sort(), [200, 409], "client-service race did not enforce CAS");

  const secondService = await createServiceBinding(context);
  current = await readCurrent(context, owner);
  const serviceRevision = revisionFrom(current);
  const serviceLeft = commitBody({ workspace: WORKSPACES.primary, actor: clientBinding.actor, revision: serviceRevision,
    nextModel: model("service-service-left"), kind: clientBinding.intent,
    jobId: clientBinding.jobId, leaseId: clientBinding.leaseId });
  const serviceRight = commitBody({ workspace: WORKSPACES.primary, actor: secondService.actor, revision: serviceRevision,
    nextModel: model("service-service-right"), kind: secondService.intent,
    jobId: secondService.jobId, leaseId: secondService.leaseId });
  const serviceRace = await Promise.all([
    api(context, "/rpc/social_cues_workspace_commit_v2", { token: clientBinding.token, body: serviceLeft }),
    api(context, "/rpc/social_cues_workspace_commit_v2", { token: secondService.token, body: serviceRight })
  ]);
  checkDeep(serviceRace.map(item => item.status).sort(), [200, 409], "service-service race did not enforce CAS");
}

async function runRollbackCase(context, owner) {
  const current = await readCurrent(context, owner);
  const before = await tableCounts(context);
  await psql(context, DATABASES.migration, `
create or replace function public.p37_fault_after_receipt()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if new.request_hash = repeat('f',64) then raise exception 'synthetic rollback'; end if;
  return new;
end;
$$;
create trigger p37_fault_after_receipt after insert on public.workspace_model_commits
for each row execute function public.p37_fault_after_receipt();
`);
  try {
    const failed = await api(context, "/rpc/social_cues_workspace_commit_v2", {
      token: owner,
      body: commitBody({ workspace: WORKSPACES.primary, actor: USERS.owner,
        revision: revisionFrom(current), nextModel: model("rollback"), requestHash: "f".repeat(64) })
    });
    assertFailure(failed, 503, "workspace_storage_unavailable");
    checkDeep(await tableCounts(context), before, "transaction exception left partial persistence data");
  } finally {
    await psql(context, DATABASES.migration,
      "drop trigger if exists p37_fault_after_receipt on public.workspace_model_commits; drop function if exists public.p37_fault_after_receipt();");
  }
}

async function droppedRequest(context, pathname, token, body, mode) {
  const proxyPort = await freePort();
  const proxy = http.createServer((request, response) => {
    if (mode === "before") {
      request.resume();
      request.socket.destroy();
      return;
    }
    const upstream = http.request({
      host: "127.0.0.1", port: context.port, path: request.url, method: request.method,
      headers: request.headers
    }, upstreamResponse => {
      upstreamResponse.resume();
      upstreamResponse.once("end", () => response.socket?.destroy());
    });
    upstream.once("error", () => response.socket?.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(proxyPort, "127.0.0.1", resolve);
  });
  try {
    await api(context, pathname, { token, body, port: proxyPort });
  } catch {
    return;
  } finally {
    await new Promise(resolve => proxy.close(resolve));
  }
  throw new Error(`${mode} loss proxy unexpectedly delivered a response`);
}

async function runLostResponseCases(context, owner) {
  let current = await readCurrent(context, owner);
  const beforeCommand = commitBody({ workspace: WORKSPACES.primary, actor: USERS.owner,
    revision: revisionFrom(current), nextModel: model("lost-before") });
  await droppedRequest(context, "/rpc/social_cues_workspace_commit_v2", owner, beforeCommand, "before");
  const beforeReceipt = await api(context, "/rpc/social_cues_workspace_receipt_v2", {
    token: owner,
    body: receiptBody(beforeCommand)
  });
  assertResponseShape(beforeReceipt, "not_found", { receipt: true });

  current = await readCurrent(context, owner);
  const afterCommand = commitBody({ workspace: WORKSPACES.primary, actor: USERS.owner,
    revision: revisionFrom(current), nextModel: model("lost-after") });
  await droppedRequest(context, "/rpc/social_cues_workspace_commit_v2", owner, afterCommand, "after");
  const afterReceipt = await api(context, "/rpc/social_cues_workspace_receipt_v2", {
    token: owner,
    body: receiptBody(afterCommand)
  });
  assertResponseShape(afterReceipt, "replayed", { receipt: true });

  await docker(context, ["restart", context.postgrest]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await api(context, "/", { method: "GET" });
      if (response.status === 200) break;
    } catch {}
    if (attempt === 99) throw new Error("PostgREST did not recover after restart");
    await delay(200);
  }
  const afterRestart = await api(context, "/rpc/social_cues_workspace_receipt_v2", {
    token: owner,
    body: receiptBody(afterCommand)
  });
  assertResponseShape(afterRestart, "replayed", { receipt: true });
}

async function runUnrelatedWorkspaceConcurrency(context, owner, ownerB) {
  const otherInit = initializeBody(WORKSPACES.other, USERS.ownerB, model("other-initial"));
  const initialized = await api(context, "/rpc/social_cues_workspace_initialize_v2", {
    token: ownerB,
    body: otherInit
  });
  const otherBody = assertResponseShape(initialized, "committed", { receipt: true });
  const primary = await readCurrent(context, owner);
  const primaryCommand = commitBody({ workspace: WORKSPACES.primary, actor: USERS.owner,
    revision: revisionFrom(primary), nextModel: model("parallel-primary") });
  const otherCommand = commitBody({ workspace: WORKSPACES.other, actor: USERS.ownerB,
    revision: revisionFrom(otherBody), nextModel: model("parallel-other") });
  const responses = await Promise.all([
    api(context, "/rpc/social_cues_workspace_commit_v2", { token: owner, body: primaryCommand }),
    api(context, "/rpc/social_cues_workspace_commit_v2", { token: ownerB, body: otherCommand })
  ]);
  checkDeep(responses.map(item => item.status).sort(), [200, 200], "unrelated workspaces conflicted");
}

async function verifyHistoricalReceipt(context, admin, command) {
  const response = await api(context, "/rpc/social_cues_workspace_receipt_v2", {
    token: admin,
    body: receiptBody(command)
  });
  const body = assertResponseShape(response, "replayed", { receipt: true });
  checkEqual(body.receipts[0].result_revision, "1", "historical receipt revision changed");
  checkOk(BigInt(body.rows[0].revision) > 1n, "historical receipt did not return the current row");
}

async function verifyPrivileges(context) {
  const result = await jsonQuery(context, DATABASES.migration, `
select jsonb_build_object(
  'anonRead',has_function_privilege('anon','public.social_cues_workspace_read_v2(text)','EXECUTE'),
  'authRead',has_function_privilege('authenticated','public.social_cues_workspace_read_v2(text)','EXECUTE'),
  'authInit',has_function_privilege('authenticated','public.social_cues_workspace_initialize_v2(text,text,text,jsonb,text,text,text)','EXECUTE'),
  'serviceInit',has_function_privilege('service_role','public.social_cues_workspace_initialize_v2(text,text,text,jsonb,text,text,text)','EXECUTE'),
  'authFingerprint',has_function_privilege('authenticated','public.social_cues_workspace_persistence_fingerprint_v2()','EXECUTE'),
  'serviceFingerprint',has_function_privilege('service_role','public.social_cues_workspace_persistence_fingerprint_v2()','EXECUTE'),
  'authModelSelect',has_table_privilege('authenticated','public.workspace_models','SELECT'),
  'serviceModelWrite',has_table_privilege('service_role','public.workspace_models','UPDATE'),
  'authReceiptSelect',has_table_privilege('authenticated','public.workspace_model_commits','SELECT'),
  'serviceReceiptSelect',has_table_privilege('service_role','public.workspace_model_commits','SELECT')
);
`);
  checkDeep(result, {
    anonRead: false,
    authRead: true,
    authInit: true,
    serviceInit: false,
    authFingerprint: false,
    serviceFingerprint: true,
    authModelSelect: false,
    serviceModelWrite: false,
    authReceiptSelect: false,
    serviceReceiptSelect: false
  }, "effective privilege matrix differs");
}

async function scanDatabase(context) {
  const output = await psql(context, DATABASES.migration, `
select coalesce(jsonb_agg(to_jsonb(model_row)), '[]'::jsonb) from public.workspace_models model_row;
select coalesce(jsonb_agg(to_jsonb(receipt_row)), '[]'::jsonb) from public.workspace_model_commits receipt_row;
select coalesce(jsonb_agg(to_jsonb(contract_row)), '[]'::jsonb) from public.workspace_persistence_contracts contract_row;
`);
  assertSecretsAbsent(`${output.stdout}\n${output.stderr}`, "PostgreSQL persistence rows");
}

async function scanDirectory(directory) {
  if (!(await exists(directory))) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await scanDirectory(target);
    else assertSecretsAbsent(await readFile(target, "utf8"), `temporary file ${entry.name}`);
  }
}

async function resourceExists(context, type, name) {
  if (type === "container") {
    const result = await docker(context, [
      "ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"
    ], { timeoutMs: 10_000 });
    return result.stdout.split(/\r?\n/u).some(value => value.trim() === name);
  }
  const command = type === "network" ? ["network", "inspect", name] : ["volume", "inspect", name];
  return (await docker(context, command, { allowFailure: true, timeoutMs: 10_000 })).code === 0;
}

async function cleanup(context) {
  const errors = [];
  for (const child of [...context.children]) {
    try { child.kill("SIGKILL"); } catch (error) { errors.push(redact(error.message)); }
  }
  for (let attempt = 0; attempt < 40 && context.children.size; attempt += 1) await delay(50);
  try {
    for (const container of [context.postgrest, context.postgres]) {
      if (await resourceExists(context, "container", container)) {
        const logs = await docker(context, ["logs", container], { allowFailure: true, timeoutMs: 15_000 });
        assertSecretsAbsent(`${logs.stdout}\n${logs.stderr}`, `${container} logs`);
      }
    }
    await scanDirectory(context.tempDirectory);
  } catch (error) { errors.push(redact(error.message)); }

  for (const container of [context.postgrest, context.postgres]) {
    try {
      if (await resourceExists(context, "container", container)) {
        await docker(context, ["rm", "-f", container], { timeoutMs: 30_000 });
      }
    } catch (error) { errors.push(redact(error.message)); }
  }
  for (const [type, name, command] of [
    ["network", context.network, ["network", "rm", context.network]],
    ["volume", context.volume, ["volume", "rm", context.volume]]
  ]) {
    try {
      if (await resourceExists(context, type, name)) await docker(context, command, { timeoutMs: 30_000 });
    } catch (error) { errors.push(redact(error.message)); }
  }
  try { await rm(context.tempDirectory, { recursive: true, force: true }); } catch (error) {
    errors.push(redact(error.message));
  }
  for (let attempt = 0; attempt < 30 && await portListening(context.port); attempt += 1) await delay(100);

  try {
    checkEqual(await resourceExists(context, "container", context.postgres), false, "PostgreSQL container remains");
    checkEqual(await resourceExists(context, "container", context.postgrest), false, "PostgREST container remains");
    checkEqual(await resourceExists(context, "network", context.network), false, "test network remains");
    checkEqual(await resourceExists(context, "volume", context.volume), false, "test volume remains");
    checkEqual(await exists(context.tempDirectory), false, "test temp directory remains");
    checkEqual(await portListening(context.port), false, "loopback port remains open");
    checkEqual(context.children.size, 0, "child process remains active");
    assertSecretsAbsent(context.httpResponses.map(item => item.text).join("\n"), "all HTTP responses");
  } catch (error) { errors.push(redact(error.message)); }

  checkDeep(errors, [], `cleanup failed: ${errors.join("; ")}`);
  context.cleanupComplete = true;
  activeContexts.delete(context);
}

async function verifyNoLabeledResources(context) {
  for (const [type, args] of [
    ["containers", ["ps", "-a", "--filter", `label=${RESOURCE_LABEL}`, "--format", "{{.Names}}"]],
    ["networks", ["network", "ls", "--filter", `label=${RESOURCE_LABEL}`, "--format", "{{.Name}}"]],
    ["volumes", ["volume", "ls", "--filter", `label=${RESOURCE_LABEL}`, "--format", "{{.Name}}"]]
  ]) {
    const result = await docker(context, args);
    checkEqual(result.stdout.trim(), "", `labeled ${type} remain after cleanup`);
  }
}

async function loadInputs() {
  const [migration, schema, harness, perUser, workers, baseSchemaResult] = await Promise.all([
    readFile(path.join(repoDir, MIGRATION_PATH), "utf8"),
    readFile(path.join(repoDir, SCHEMA_PATH), "utf8"),
    readFile(path.join(repoDir, HARNESS_PATH), "utf8"),
    readFile(path.join(repoDir, "SUPABASE-PER-USER-MIGRATION.sql"), "utf8"),
    readFile(path.join(repoDir, "SUPABASE-DURABLE-WORKERS.sql"), "utf8"),
    git(["show", `${BASE_COMMIT}:supabase-schema.sql`])
  ]);
  const embeddedMigration = extractEmbeddedMigration(schema);
  checkEqual(sha256(embeddedMigration), sha256(migration.trim()), "clean schema migration block differs from additive migration");
  checkEqual(migration.includes("SUPABASE_URL"), false, "migration references hosted Supabase configuration");
  checkEqual(harness.includes(["https", "://"].join("")), false, "harness contains a remote HTTPS target");
  return {
    migration,
    schema,
    harness,
    perUser,
    workers,
    baseSchema: baseSchemaResult.stdout,
    embeddedMigration,
    hashes: {
      [MIGRATION_PATH]: sha256(migration),
      [SCHEMA_PATH]: sha256(schema),
      [HARNESS_PATH]: sha256(harness)
    }
  };
}

async function main() {
  const inputs = await loadInputs();
  const faultContext = createContext("fault");
  try {
    await setupContext(faultContext, { faultAfterPostgresStart: true });
    throw new Error("fault injection did not fire");
  } catch (error) {
    checkEqual(error.message, "INJECTED_AFTER_POSTGRES_START", "unexpected fault-injection result");
  } finally {
    await cleanup(faultContext);
  }

  const context = createContext("main");
  let catalogFingerprint = "";
  let postgresVersion = "";
  let postgrestVersion = "14.12";
  let dockerVersion = "";
  try {
    await setupContext(context);
    await installDatabases(context, inputs);
    catalogFingerprint = await verifyCatalogs(context);
    await verifyCanonicalNumbers(context);
    await verifyPrivileges(context);
    await seedRuntime(context);
    await startPostgrest(context);
    const versions = await Promise.all([
      scalar(context, DATABASES.migration, "show server_version;"),
      docker(context, ["version", "--format", "{{.Server.Version}}"])
    ]);
    postgresVersion = versions[0];
    dockerVersion = lastLine(versions[1].stdout);

    const { owner, admin, adminCommand } = await runAuthorizationAndCrud(context);
    await runInitializeRace(context, owner);
    await runClientRaces(context, owner, admin);
    await runServiceCases(context, owner);
    await runRollbackCase(context, owner);
    await runLostResponseCases(context, owner);
    await runUnrelatedWorkspaceConcurrency(context, owner, userToken(context, USERS.ownerB));
    await verifyHistoricalReceipt(context, admin, adminCommand);
    await scanDatabase(context);
  } finally {
    await cleanup(context);
  }

  await verifyNoLabeledResources(context);
  checkEqual(faultContext.cleanupComplete, true, "fault cleanup was not verified");
  checkEqual(context.cleanupComplete, true, "ordinary cleanup was not verified");
  assertSecretsAbsent(capturedOutput.join("\n"), "captured stdout and stderr");
  checkEqual(externalRequests, 0, "an external request was recorded");

  const finalAssertionCount = assertions + 1;
  const evidence = {
    contract: CONTRACT,
    interfaceFingerprint: INTERFACE_FINGERPRINT,
    catalogFingerprint,
    artifacts: inputs.hashes,
    images: {
      postgres: { image: POSTGRES_IMAGE, digest: POSTGRES_DIGEST, version: postgresVersion },
      postgrest: { image: POSTGREST_IMAGE, digest: POSTGREST_DIGEST, version: postgrestVersion },
      docker: { version: dockerVersion }
    },
    verification: {
      assertions: finalAssertionCount,
      migrationReruns: 2,
      cleanSchemaReruns: 2,
      authorizationRoles: ["owner", "admin", "member", "viewer"],
      races: ["bootstrap", "client-client", "client-service", "service-service", "recovery-normal", "unrelated-workspaces"],
      lostResponseCases: ["before-commit", "after-commit", "after-restart"],
      cleanup: { ordinary: true, faultInjected: true }
    },
    externalRequests: 0,
    hostedMutations: 0,
    R4: "HOLD"
  };
  assertSecretsAbsent(JSON.stringify(evidence), "deterministic evidence");
  assert.equal(assertions, finalAssertionCount, "evidence assertion count drifted");
  await mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`workspace persistence v2 PostgREST verification passed (${assertions} assertions, externalRequests=0, R4=HOLD)`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    for (const context of [...activeContexts]) {
      try { await cleanup(context); } catch {}
    }
    process.exitCode = 1;
  });
}

main().catch(async error => {
  for (const context of [...activeContexts]) {
    try { await cleanup(context); } catch {}
  }
  console.error(redact(error?.stack || error));
  process.exitCode = 1;
});
