import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  POSTGRES_POSTGREST_IMAGE,
  POSTGREST_IMAGE,
  applySqlFile,
  assertSecretsAbsent,
  cleanupHarness,
  createHarnessState,
  createNetwork,
  httpJson,
  jwt,
  jwtClaims,
  prepareState,
  psql,
  queryJson,
  queryScalar,
  quoteLiteral,
  registerSecret,
  scanRuntimeSafety,
  startPostgres,
  startPostgrest
} from "./test-support/local-database-harness.mjs";

const repoDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(repoDirectory, "SUPABASE-HEYGEN-DURABLE-PERSISTENCE.sql");
const hardeningMigrationPath = path.join(repoDirectory, "SUPABASE-HEYGEN-DURABLE-PERSISTENCE-HARDENING.sql");
const migrationSql = await readFile(migrationPath, "utf8");
const hardeningMigrationSql = await readFile(hardeningMigrationPath, "utf8");
const state = createHarnessState("heygen-postgrest");
const passed = [];
let externalRequests = 0;
let loopbackRequests = 0;

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "127.0.0.1") {
    externalRequests += 1;
    throw new Error("Only the local HeyGen PostgREST endpoint is allowed.");
  }
  loopbackRequests += 1;
  return nativeFetch(input, init);
};

const rawStateCanary = registerSecret(state, "HEYGEN_POSTGREST_RAW_STATE_CANARY_17F2");
const plaintextTokenCanary = registerSecret(state, "HEYGEN_POSTGREST_PLAINTEXT_TOKEN_CANARY_51C8");
const malformedEnvelopeCanary = registerSecret(state, "HEYGEN_POSTGREST_MALFORMED_ENVELOPE_CANARY_8B31");
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const actorA = randomUUID();
const memberA = randomUUID();
const actorB = randomUUID();
const sourceAssetId = randomUUID();
const connectedAccountId = randomUUID();
const stateDigest = createHash("sha256").update(rawStateCanary).digest("base64url");

const baseFixtureSql = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator login noinherit password ${quoteLiteral(state.postgresPassword)};
grant anon, authenticated, service_role to authenticator;

create schema auth;
create function auth.uid()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb->>'sub'
  )::uuid;
$function$;

create table public.workspaces (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  owner_user_id uuid,
  name text not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  role text not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (workspace_id, user_id)
);

create table public.billing_entitlements (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  source text not null default 'fixture',
  access text not null default 'paid',
  status text not null default 'active',
  current_period_end timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (workspace_id, user_id)
);

create table public.media_assets (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  provider text not null default 'upload',
  kind text not null default 'image',
  title text,
  prompt text,
  storage_path text,
  preview_url text,
  created_at timestamptz not null default pg_catalog.now()
);

create table public.audit_logs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  workspace_id uuid,
  user_id uuid,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now()
);

create or replace function public.social_cues_has_active_entitlement(
  target_workspace_id uuid,
  target_user_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select exists (
    select 1 from public.billing_entitlements be
    where be.workspace_id = target_workspace_id
      and be.user_id = target_user_id
      and be.status = 'active'
      and be.access <> 'unpaid'
      and (be.current_period_end is null or be.current_period_end > pg_catalog.now())
  );
$function$;

grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function public.social_cues_has_active_entitlement(uuid, uuid) to authenticated, service_role;

insert into public.workspaces(id, owner_user_id, name) values
  (${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(actorA)}::uuid, 'Workspace A'),
  (${quoteLiteral(workspaceB)}::uuid, ${quoteLiteral(actorB)}::uuid, 'Workspace B');
insert into public.workspace_members(workspace_id, user_id, role) values
  (${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(actorA)}::uuid, 'owner'),
  (${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(memberA)}::uuid, 'member'),
  (${quoteLiteral(workspaceB)}::uuid, ${quoteLiteral(actorB)}::uuid, 'owner');
insert into public.billing_entitlements(workspace_id, user_id, access, status) values
  (${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(actorA)}::uuid, 'paid', 'active'),
  (${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(memberA)}::uuid, 'paid', 'active'),
  (${quoteLiteral(workspaceB)}::uuid, ${quoteLiteral(actorB)}::uuid, 'paid', 'active');
`;

const postMigrationFixtureSql = `
alter table public.workspace_members enable row level security;
alter table public.workspace_members force row level security;
alter table public.billing_entitlements enable row level security;
alter table public.billing_entitlements force row level security;
drop policy if exists "fixture members can read own memberships" on public.workspace_members;
create policy "fixture members can read own memberships"
  on public.workspace_members for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "fixture members can read entitlements" on public.billing_entitlements;
create policy "fixture members can read entitlements"
  on public.billing_entitlements for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = billing_entitlements.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );
grant select on public.workspace_members, public.billing_entitlements to authenticated;

alter table public.media_assets enable row level security;
alter table public.media_assets force row level security;
drop policy if exists "fixture members can read media" on public.media_assets;
create policy "fixture members can read media"
  on public.media_assets for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = media_assets.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
    and public.social_cues_has_active_entitlement(media_assets.workspace_id, (select auth.uid()))
  );
grant select, insert, update, delete on public.media_assets to authenticated;

insert into public.media_assets(id, workspace_id, owner_user_id, provider, kind, title)
values (${quoteLiteral(sourceAssetId)}::uuid, ${quoteLiteral(workspaceA)}::uuid,
  ${quoteLiteral(actorA)}::uuid, 'upload', 'video', 'Source asset');
`;

function envelope(seed) {
  return {
    alg: "aes-256-gcm",
    iv: seed.repeat(16).slice(0, 16),
    tag: seed.repeat(22).slice(0, 22),
    value: seed.repeat(48).slice(0, 48)
  };
}

const metadata = Object.freeze({
  resource: "https://mcp.heygen.com/mcp/v1/",
  issuer: "https://auth.heygen.com/",
  authorizationEndpoint: "https://auth.heygen.com/oauth/authorize",
  tokenEndpoint: "https://auth.heygen.com/oauth/token",
  registrationEndpoint: null,
  revocationEndpoint: "https://auth.heygen.com/oauth/revoke",
  scopesSupported: ["mcp:tools"],
  tokenEndpointAuthMethods: ["client_secret_post"]
});

const publicProfile = Object.freeze({
  plan: "Creator",
  credits: { available: true, remaining: 25 },
  advertisedTools: [{ name: "get_current_user" }, { name: "video_agent" }],
  capabilities: [
    { id: "current_user", label: "Current user", toolName: "get_current_user" },
    { id: "prompt_to_video", label: "Prompt to video", toolName: "video_agent" }
  ],
  oauthMetadata: metadata,
  billingRelationship: "customer-owned-heygen-plan"
});

const verifierEnvelope = envelope("V");
const accessEnvelope = envelope("A");
const refreshEnvelope = envelope("R");
const rotatedEnvelope = envelope("N");

const rpcArguments = Object.freeze({
  social_cues_heygen_repository_health: [],
  social_cues_heygen_oauth_state_issue: ["p_actor_user_id", "p_workspace_id", "p_state_digest", "p_protected_verifier", "p_metadata", "p_issued_at", "p_expires_at"],
  social_cues_heygen_oauth_state_consume: ["p_actor_user_id", "p_workspace_id", "p_state_digest"],
  social_cues_heygen_oauth_state_cancel: ["p_actor_user_id", "p_workspace_id", "p_state_digest"],
  social_cues_heygen_connection_commit: ["p_actor_user_id", "p_workspace_id", "p_state_digest", "p_connected_account_id", "p_provider_account_id", "p_display_name", "p_scopes", "p_public_profile", "p_encrypted_access_token", "p_encrypted_refresh_token", "p_token_type", "p_expires_at", "p_connected_at"],
  social_cues_heygen_account_context: ["p_actor_user_id", "p_workspace_id"],
  social_cues_heygen_account_operation_begin: ["p_actor_user_id", "p_workspace_id", "p_action", "p_operation_id", "p_request_fingerprint"],
  social_cues_heygen_refresh_complete: ["p_actor_user_id", "p_workspace_id", "p_operation_id", "p_request_fingerprint", "p_provider_account_id", "p_display_name", "p_scopes", "p_public_profile", "p_encrypted_access_token", "p_encrypted_refresh_token", "p_token_type", "p_expires_at", "p_credential_updated_at"],
  social_cues_heygen_disconnect_complete: ["p_actor_user_id", "p_workspace_id", "p_operation_id", "p_request_fingerprint", "p_safe_result"],
  social_cues_heygen_account_operation_fail: ["p_actor_user_id", "p_workspace_id", "p_action", "p_operation_id", "p_request_fingerprint", "p_failure_code"],
  social_cues_heygen_job_reserve: ["p_actor_user_id", "p_workspace_id", "p_action", "p_operation_id", "p_request_fingerprint", "p_request_arguments", "p_source_asset_id", "p_parent_asset_id"],
  social_cues_heygen_job_context: ["p_actor_user_id", "p_workspace_id", "p_job_id"],
  social_cues_heygen_job_transition: ["p_actor_user_id", "p_workspace_id", "p_job_id", "p_state", "p_result_fingerprint", "p_provider_job_id", "p_provider_session_id", "p_capability_id", "p_capability_tool_name", "p_provider_resource_id", "p_preview_url", "p_title", "p_failure_code", "p_public_message"],
  social_cues_heygen_jobs_list: ["p_actor_user_id", "p_workspace_id"],
  social_cues_heygen_versions_list: ["p_actor_user_id", "p_workspace_id"]
});

const rpcSignatures = Object.freeze({
  social_cues_heygen_repository_health: "",
  social_cues_heygen_oauth_state_issue: "p_actor_user_id uuid, p_workspace_id uuid, p_state_digest text, p_protected_verifier jsonb, p_metadata jsonb, p_issued_at timestamp with time zone, p_expires_at timestamp with time zone",
  social_cues_heygen_oauth_state_consume: "p_actor_user_id uuid, p_workspace_id uuid, p_state_digest text",
  social_cues_heygen_oauth_state_cancel: "p_actor_user_id uuid, p_workspace_id uuid, p_state_digest text",
  social_cues_heygen_connection_commit: "p_actor_user_id uuid, p_workspace_id uuid, p_state_digest text, p_connected_account_id uuid, p_provider_account_id text, p_display_name text, p_scopes text[], p_public_profile jsonb, p_encrypted_access_token jsonb, p_encrypted_refresh_token jsonb, p_token_type text, p_expires_at timestamp with time zone, p_connected_at timestamp with time zone",
  social_cues_heygen_account_context: "p_actor_user_id uuid, p_workspace_id uuid",
  social_cues_heygen_account_operation_begin: "p_actor_user_id uuid, p_workspace_id uuid, p_action text, p_operation_id text, p_request_fingerprint text",
  social_cues_heygen_refresh_complete: "p_actor_user_id uuid, p_workspace_id uuid, p_operation_id text, p_request_fingerprint text, p_provider_account_id text, p_display_name text, p_scopes text[], p_public_profile jsonb, p_encrypted_access_token jsonb, p_encrypted_refresh_token jsonb, p_token_type text, p_expires_at timestamp with time zone, p_credential_updated_at timestamp with time zone",
  social_cues_heygen_disconnect_complete: "p_actor_user_id uuid, p_workspace_id uuid, p_operation_id text, p_request_fingerprint text, p_safe_result jsonb",
  social_cues_heygen_account_operation_fail: "p_actor_user_id uuid, p_workspace_id uuid, p_action text, p_operation_id text, p_request_fingerprint text, p_failure_code text",
  social_cues_heygen_job_reserve: "p_actor_user_id uuid, p_workspace_id uuid, p_action text, p_operation_id text, p_request_fingerprint text, p_request_arguments jsonb, p_source_asset_id uuid, p_parent_asset_id uuid",
  social_cues_heygen_job_context: "p_actor_user_id uuid, p_workspace_id uuid, p_job_id uuid",
  social_cues_heygen_job_transition: "p_actor_user_id uuid, p_workspace_id uuid, p_job_id uuid, p_state text, p_result_fingerprint text, p_provider_job_id text, p_provider_session_id text, p_capability_id text, p_capability_tool_name text, p_provider_resource_id text, p_preview_url text, p_title text, p_failure_code text, p_public_message text",
  social_cues_heygen_jobs_list: "p_actor_user_id uuid, p_workspace_id uuid",
  social_cues_heygen_versions_list: "p_actor_user_id uuid, p_workspace_id uuid"
});

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function assertDenied(response, context) {
  assert.ok([401, 403, 404].includes(response.status), `${context} was not denied: ${response.status}`);
}

function assertSafeFailure(response, expectedCode) {
  assert.ok(response.status >= 400 && response.status < 500, `expected a safe client error, received ${response.status}`);
  assert.match(response.text, new RegExp(expectedCode, "u"));
}

function assertSanitizedRejection(response, expectedCode) {
  assert.ok(response.status >= 400, `expected a rejected service request, received ${response.status}`);
  assert.match(response.text, new RegExp(expectedCode, "u"));
  assert.deepEqual(Object.keys(response.json || {}).sort(), ["code", "details", "hint", "message"]);
}

function assertObject(response) {
  assert.equal(response.status, 200, response.text);
  assert.ok(response.json && typeof response.json === "object" && !Array.isArray(response.json));
  return response.json;
}

async function rpc(name, body, token) {
  return httpJson(state, `/rpc/${name}`, { method: "POST", token, body });
}

async function check(name, fn) {
  await fn();
  passed.push(name);
  console.log(`PASS ${name}`);
}

let primaryError = null;
try {
  await prepareState(state);
  const crlfMigrationPath = path.join(state.tempDirectory, "heygen-durable-postgrest-crlf.sql");
  const crlfHardeningMigrationPath = path.join(state.tempDirectory, "heygen-durable-hardening-postgrest-crlf.sql");
  const canonicalMigration = migrationSql.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const canonicalHardeningMigration = hardeningMigrationSql.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  await writeFile(crlfMigrationPath, canonicalMigration.replaceAll("\n", "\r\n"), "utf8");
  await writeFile(crlfHardeningMigrationPath, canonicalHardeningMigration.replaceAll("\n", "\r\n"), "utf8");
  await createNetwork(state);
  await startPostgres(state, { image: POSTGRES_POSTGREST_IMAGE, networked: true });
  await psql(state, baseFixtureSql);
  await applySqlFile(state, crlfMigrationPath, { timeoutMs: 90_000 });
  await applySqlFile(state, crlfHardeningMigrationPath, { timeoutMs: 90_000 });
  await applySqlFile(state, crlfHardeningMigrationPath, { timeoutMs: 90_000 });
  await psql(state, postMigrationFixtureSql);
  await startPostgrest(state);

  const serviceToken = registerSecret(state, jwt(state, "service_role", actorA));
  const ownerToken = registerSecret(state, jwt(state, "authenticated", actorA));
  const memberToken = registerSecret(state, jwt(state, "authenticated", memberA));
  const otherToken = registerSecret(state, jwt(state, "authenticated", actorB));
  const wrongRoleToken = registerSecret(state, jwt(state, "postgres", actorA));
  const missingRoleToken = registerSecret(state, jwtClaims(state, {
    sub: actorA,
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600
  }));

  await check("hardening is rerunnable and adds exact deny-only private catalog state without client grants", async () => {
    const catalog = await queryJson(state, `
      with target_policies as (
        select tablename, policyname, permissive, roles, cmd, qual, with_check
        from pg_catalog.pg_policies
        where schemaname = 'social_cues_private'
          and tablename in ('heygen_oauth_states', 'heygen_operation_receipts')
      )
      select pg_catalog.jsonb_build_object(
        'index_ok', (
          select count(*) = 1
          from pg_catalog.pg_index i
          join pg_catalog.pg_class idx on idx.oid = i.indexrelid
          join pg_catalog.pg_class rel on rel.oid = i.indrelid
          join pg_catalog.pg_namespace ns on ns.oid = rel.relnamespace
          join pg_catalog.pg_am am on am.oid = idx.relam
          where ns.nspname = 'social_cues_private'
            and rel.relname = 'heygen_oauth_states'
            and idx.relname = 'heygen_oauth_states_connected_account_idx'
            and am.amname = 'btree'
            and not i.indisunique
            and i.indisvalid
            and i.indisready
            and i.indnkeyatts = 1
            and i.indnatts = 1
            and i.indpred is null
            and i.indexprs is null
            and pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'connected_account_id'
        ),
        'rls_forced', (
          select count(*) = 2
          from pg_catalog.pg_class rel
          join pg_catalog.pg_namespace ns on ns.oid = rel.relnamespace
          where ns.nspname = 'social_cues_private'
            and rel.relname in ('heygen_oauth_states', 'heygen_operation_receipts')
            and rel.relrowsecurity
            and rel.relforcerowsecurity
        ),
        'policy_count', (select count(*) from target_policies),
        'policies_deny_only', (
          select coalesce(pg_catalog.bool_and(
            permissive = 'RESTRICTIVE'
            and cmd = 'ALL'
            and roles @> array['anon', 'authenticated']::name[]
            and pg_catalog.cardinality(roles) = 2
            and qual = 'false'
            and with_check = 'false'
            and (
              (tablename = 'heygen_oauth_states' and policyname = 'client roles cannot access heygen oauth states')
              or (tablename = 'heygen_operation_receipts' and policyname = 'client roles cannot access heygen operation receipts')
            )
          ), false)
          from target_policies
        ),
        'client_schema_usage', exists (
          select 1
          from pg_catalog.unnest(array['anon', 'authenticated']) role_name
          where pg_catalog.has_schema_privilege(role_name, 'social_cues_private', 'USAGE')
        ),
        'client_table_grants', (
          select count(*)
          from information_schema.table_privileges
          where table_schema = 'social_cues_private'
            and table_name in ('heygen_oauth_states', 'heygen_operation_receipts')
            and grantee in ('PUBLIC', 'anon', 'authenticated')
        ),
        'client_function_grants', (
          select count(*)
          from information_schema.routine_privileges
          where grantee in ('PUBLIC', 'anon', 'authenticated')
            and (
              (specific_schema = 'public' and routine_name like 'social_cues_heygen_%')
              or specific_schema = 'social_cues_private'
            )
        )
      )
    `);
    assert.deepEqual(catalog, {
      client_function_grants: 0,
      client_schema_usage: false,
      client_table_grants: 0,
      index_ok: true,
      policies_deny_only: true,
      policy_count: 2,
      rls_forced: true
    });
    const health = assertObject(await rpc("social_cues_heygen_repository_health", {}, serviceToken));
    assert.deepEqual(health, {
      contract_version: "social-cues.heygen-durable.v1",
      interface_fingerprint: "heygen-durable-v1-oauth-account-job-lineage"
    });
  });

  await check("OpenAPI and PostgreSQL expose only exact service RPC signatures", async () => {
    const response = await httpJson(state, "/", {
      token: serviceToken,
      headers: { Accept: "application/openapi+json" }
    });
    assert.equal(response.status, 200);
    for (const [name, argumentsList] of Object.entries(rpcArguments)) {
      const definition = response.json?.paths?.[`/rpc/${name}`]?.post;
      assert.ok(definition, `${name} missing from service-role OpenAPI`);
      const serialized = JSON.stringify(definition);
      for (const argument of argumentsList) assert.match(serialized, new RegExp(`"${argument}"`, "u"));
      const signature = await queryScalar(state, `
        select pg_catalog.pg_get_function_identity_arguments(p.oid)
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = ${quoteLiteral(name)};
      `);
      assert.equal(signature, rpcSignatures[name], `${name} signature drifted`);
    }
    assert.equal(Object.keys(response.json?.paths || {}).some(value => value.includes("social_cues_private")), false);
  });

  await check("anonymous, authenticated, wrong-role, and missing-role RPC requests are denied", async () => {
    const body = { p_actor_user_id: actorA, p_workspace_id: workspaceA };
    for (const [label, token] of [
      ["anonymous", null],
      ["authenticated", ownerToken],
      ["wrong role", wrongRoleToken],
      ["missing role", missingRoleToken]
    ]) {
      assertDenied(await rpc("social_cues_heygen_account_context", body, token), `${label} RPC`);
    }
  });

  await check("OAuth state is digest-only, owner-bound, single-use, and private", async () => {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 10 * 60 * 1000);
    const issueBody = {
      p_actor_user_id: actorA,
      p_workspace_id: workspaceA,
      p_state_digest: stateDigest,
      p_protected_verifier: verifierEnvelope,
      p_metadata: metadata,
      p_issued_at: issuedAt.toISOString(),
      p_expires_at: expiresAt.toISOString()
    };
    assert.equal(assertObject(await rpc("social_cues_heygen_oauth_state_issue", issueBody, serviceToken)).outcome, "issued");
    const privateRows = await queryScalar(state, "select coalesce(jsonb_agg(to_jsonb(s))::text, '[]') from social_cues_private.heygen_oauth_states s;");
    assertSecretsAbsent(state, privateRows, "OAuth state ledger");
    assert.match(privateRows, new RegExp(stateDigest, "u"));

    const consumeBody = { p_actor_user_id: actorA, p_workspace_id: workspaceA, p_state_digest: stateDigest };
    const [left, right] = await Promise.all([
      rpc("social_cues_heygen_oauth_state_consume", consumeBody, serviceToken),
      rpc("social_cues_heygen_oauth_state_consume", consumeBody, serviceToken)
    ]);
    const successes = [left, right].filter(response => response.status === 200);
    const denials = [left, right].filter(response => response.status !== 200);
    assert.equal(successes.length, 1);
    assert.equal(assertObject(successes[0]).outcome, "consumed");
    assert.equal(denials.length, 1);
    assertSafeFailure(denials[0], "HEYGEN_STATE_NOT_CONSUMABLE");
    assert.equal(await queryScalar(state, `select protected_verifier is null and discovered_metadata is null from social_cues_private.heygen_oauth_states where state_digest = ${quoteLiteral(stateDigest)};`), "t");

    assertDenied(await httpJson(state, "/heygen_oauth_states?select=*", { token: ownerToken }), "private state table");
    assertDenied(await httpJson(state, "/heygen_operation_receipts?select=*", { token: ownerToken }), "private receipt table");
  });

  await check("connection commit is atomic and the client projection excludes credentials", async () => {
    const body = {
      p_actor_user_id: actorA,
      p_workspace_id: workspaceA,
      p_state_digest: stateDigest,
      p_connected_account_id: connectedAccountId,
      p_provider_account_id: "provider-account-a",
      p_display_name: "Fixture Creator",
      p_scopes: ["mcp:tools"],
      p_public_profile: publicProfile,
      p_encrypted_access_token: accessEnvelope,
      p_encrypted_refresh_token: refreshEnvelope,
      p_token_type: "Bearer",
      p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      p_connected_at: new Date().toISOString()
    };
    const committed = assertObject(await rpc("social_cues_heygen_connection_commit", body, serviceToken));
    assert.equal(committed.replayed, false);
    assert.equal(committed.account.id, connectedAccountId);
    assert.equal(assertObject(await rpc("social_cues_heygen_connection_commit", body, serviceToken)).replayed, true);
    assert.equal(await queryScalar(state, `select count(*) from public.provider_tokens where connected_account_id = ${quoteLiteral(connectedAccountId)}::uuid;`), "1");

    const ownerRead = await httpJson(state, "/connected_accounts?provider=eq.heygen&select=*", { token: ownerToken });
    assert.equal(ownerRead.status, 200, ownerRead.text);
    assert.equal(ownerRead.json.length, 1);
    const serialized = JSON.stringify(ownerRead.json);
    for (const forbidden of ["encrypted_token", "encrypted_refresh_token", "request_fingerprint", "result_fingerprint"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    assert.deepEqual((await httpJson(state, "/connected_accounts?provider=eq.heygen&select=*", { token: memberToken })).json, []);
    assert.deepEqual((await httpJson(state, "/connected_accounts?provider=eq.heygen&select=*", { token: otherToken })).json, []);
    assertDenied(await httpJson(state, "/provider_tokens?select=*", { token: ownerToken }), "provider token table");
  });

  await check("malformed envelopes and unsafe nested public data roll back without mutation", async () => {
    const nextRawState = "HEYGEN_SECOND_RAW_STATE_NOT_PERSISTED";
    const nextDigest = createHash("sha256").update(nextRawState).digest("base64url");
    const issuedAt = new Date();
    const commonState = {
      p_actor_user_id: actorA,
      p_workspace_id: workspaceA,
      p_state_digest: nextDigest,
      p_protected_verifier: verifierEnvelope,
      p_metadata: metadata,
      p_issued_at: issuedAt.toISOString(),
      p_expires_at: new Date(issuedAt.getTime() + 600_000).toISOString()
    };
    assert.equal(assertObject(await rpc("social_cues_heygen_oauth_state_issue", commonState, serviceToken)).outcome, "issued");
    assert.equal(assertObject(await rpc("social_cues_heygen_oauth_state_consume", {
      p_actor_user_id: actorA,
      p_workspace_id: workspaceA,
      p_state_digest: nextDigest
    }, serviceToken)).outcome, "consumed");

    const malformed = await rpc("social_cues_heygen_connection_commit", {
      p_actor_user_id: actorA,
      p_workspace_id: workspaceA,
      p_state_digest: nextDigest,
      p_connected_account_id: randomUUID(),
      p_provider_account_id: "provider-account-a",
      p_display_name: "Fixture Creator",
      p_scopes: [],
      p_public_profile: { ...publicProfile, advertisedTools: [{ name: "video_agent", accessToken: plaintextTokenCanary }] },
      p_encrypted_access_token: { alg: "aes-256-gcm", iv: "bad", tag: "bad", value: malformedEnvelopeCanary },
      p_encrypted_refresh_token: null,
      p_token_type: "Bearer",
      p_expires_at: null,
      p_connected_at: new Date().toISOString()
    }, serviceToken);
    assertSafeFailure(malformed, "HEYGEN_CONNECTION_INPUT_INVALID");
    assert.equal(await queryScalar(state, `select completed_at is null from social_cues_private.heygen_oauth_states where state_digest = ${quoteLiteral(nextDigest)};`), "t");
    assert.equal(await queryScalar(state, `select count(*) from public.connected_accounts where workspace_id = ${quoteLiteral(workspaceA)}::uuid and provider = 'heygen';`), "1");
  });

  await check("refresh rotation is replay-safe through the HTTP boundary", async () => {
    const operationId = "refresh-postgrest-1";
    const requestFingerprint = fingerprint({ action: "refresh", accountId: connectedAccountId });
    const beginBody = {
      p_actor_user_id: actorA,
      p_workspace_id: workspaceA,
      p_action: "refresh",
      p_operation_id: operationId,
      p_request_fingerprint: requestFingerprint
    };
    assert.equal(assertObject(await rpc("social_cues_heygen_account_operation_begin", beginBody, serviceToken)).outcome, "acquired");
    const completeBody = {
      p_actor_user_id: actorA,
      p_workspace_id: workspaceA,
      p_operation_id: operationId,
      p_request_fingerprint: requestFingerprint,
      p_provider_account_id: "provider-account-a",
      p_display_name: "Fixture Creator",
      p_scopes: ["mcp:tools"],
      p_public_profile: publicProfile,
      p_encrypted_access_token: rotatedEnvelope,
      p_encrypted_refresh_token: null,
      p_token_type: "Bearer",
      p_expires_at: new Date(Date.now() + 7200_000).toISOString(),
      p_credential_updated_at: new Date().toISOString()
    };
    assert.equal(assertObject(await rpc("social_cues_heygen_refresh_complete", completeBody, serviceToken)).replayed, false);
    assert.equal(assertObject(await rpc("social_cues_heygen_refresh_complete", completeBody, serviceToken)).replayed, true);
    const conflicting = await rpc("social_cues_heygen_account_operation_begin", {
      ...beginBody,
      p_request_fingerprint: fingerprint({ action: "refresh", accountId: "different" })
    }, serviceToken);
    assertSafeFailure(conflicting, "HEYGEN_OPERATION_CONFLICT");
  });

  let jobId;
  let outputAssetId;
  await check("job reservations survive response loss and concurrent duplicate HTTP requests", async () => {
    const responseLossBody = {
      p_actor_user_id: actorA,
      p_workspace_id: workspaceA,
      p_action: "prompt_to_video",
      p_operation_id: "job-response-loss-1",
      p_request_fingerprint: fingerprint({ action: "prompt_to_video", args: { prompt: "Response loss fixture" } }),
      p_request_arguments: { prompt: "Response loss fixture" },
      p_source_asset_id: null,
      p_parent_asset_id: null
    };
    await rpc("social_cues_heygen_job_reserve", responseLossBody, serviceToken);
    const recovered = assertObject(await rpc("social_cues_heygen_job_reserve", responseLossBody, serviceToken));
    assert.equal(recovered.replayed, true);

    const concurrentBody = {
      ...responseLossBody,
      p_operation_id: "job-concurrent-1",
      p_request_fingerprint: fingerprint({ action: "prompt_to_video", args: { prompt: "Concurrent fixture", title: "Concurrent" } }),
      p_request_arguments: { prompt: "Concurrent fixture", title: "Concurrent" }
    };
    const concurrent = await Promise.all([
      rpc("social_cues_heygen_job_reserve", concurrentBody, serviceToken),
      rpc("social_cues_heygen_job_reserve", concurrentBody, serviceToken)
    ]);
    const rows = concurrent.map(assertObject);
    assert.deepEqual(rows.map(row => row.replayed).sort(), [false, true]);
    assert.equal(new Set(rows.map(row => row.job.id)).size, 1);
    jobId = rows[0].job.id;
    assert.equal(await queryScalar(state, `select count(*) from public.heygen_media_jobs where operation_id = 'job-concurrent-1';`), "1");

    const unsafeArgs = await rpc("social_cues_heygen_job_reserve", {
      ...responseLossBody,
      p_operation_id: "job-unsafe-arguments-1",
      p_request_fingerprint: fingerprint({ accessToken: plaintextTokenCanary }),
      p_request_arguments: { prompt: "Unsafe fixture", accessToken: plaintextTokenCanary }
    }, serviceToken);
    assertSafeFailure(unsafeArgs, "HEYGEN_JOB_INPUT_INVALID");
    assert.equal(await queryScalar(state, "select count(*) from public.heygen_media_jobs where operation_id = 'job-unsafe-arguments-1';"), "0");

    const lineageEnvelopeMismatch = await rpc("social_cues_heygen_job_reserve", {
      ...responseLossBody,
      p_action: "translate_video",
      p_operation_id: "job-lineage-envelope-mismatch-1",
      p_request_fingerprint: fingerprint({ action: "translate_video", sourceAssetId: "different" }),
      p_request_arguments: { sourceAssetId: randomUUID(), locale: "fr-FR" },
      p_source_asset_id: sourceAssetId
    }, serviceToken);
    assertSafeFailure(lineageEnvelopeMismatch, "HEYGEN_JOB_INPUT_INVALID");
    assert.equal(await queryScalar(state, "select count(*) from public.heygen_media_jobs where operation_id = 'job-lineage-envelope-mismatch-1';"), "0");
  });

  await check("terminal concurrency creates one immutable output and rejects conflicting results", async () => {
    const processingBody = {
      p_actor_user_id: actorA,
      p_workspace_id: workspaceA,
      p_job_id: jobId,
      p_state: "processing",
      p_result_fingerprint: fingerprint({ state: "processing", providerJobId: "provider-job-1" }),
      p_provider_job_id: "provider-job-1",
      p_provider_session_id: "provider-session-1",
      p_capability_id: "prompt_to_video",
      p_capability_tool_name: "video_agent",
      p_provider_resource_id: null,
      p_preview_url: null,
      p_title: null,
      p_failure_code: null,
      p_public_message: "HeyGen is processing this video."
    };
    assert.equal(assertObject(await rpc("social_cues_heygen_job_transition", processingBody, serviceToken)).job.status, "processing");
    const completeBody = {
      ...processingBody,
      p_state: "completed",
      p_result_fingerprint: fingerprint({ state: "completed", resource: "resource-1", preview: "https://files.heygen.com/result-1.mp4" }),
      p_provider_resource_id: "resource-1",
      p_preview_url: "https://files.heygen.com/result-1.mp4",
      p_title: "Concurrent result",
      p_public_message: "Generated successfully."
    };
    const concurrent = await Promise.all([
      rpc("social_cues_heygen_job_transition", completeBody, serviceToken),
      rpc("social_cues_heygen_job_transition", completeBody, serviceToken)
    ]);
    const rows = concurrent.map(assertObject);
    assert.deepEqual(rows.map(row => row.replayed).sort(), [false, true]);
    assert.equal(new Set(rows.map(row => row.version.id)).size, 1);
    outputAssetId = rows[0].version.id;
    assert.equal(await queryScalar(state, `select count(*) from public.media_assets where operation_id = 'job-concurrent-1' and provider = 'heygen';`), "1");

    const conflict = await rpc("social_cues_heygen_job_transition", {
      ...completeBody,
      p_result_fingerprint: fingerprint({ state: "completed", resource: "different" }),
      p_provider_resource_id: "resource-different"
    }, serviceToken);
    assertSafeFailure(conflict, "HEYGEN_RESULT_TERMINAL_CONFLICT");
    assert.equal(await queryScalar(state, `select provider_resource_id = 'resource-1' from public.media_assets where id = ${quoteLiteral(outputAssetId)}::uuid;`), "t");
  });

  await check("RLS exposes safe owner projections and denies tokens, arguments, and other users", async () => {
    const safeJobColumns = "id,workspace_id,requesting_user_id,connected_account_id,provider,action,operation_id,status,provider_job_id,provider_session_id,capability_id,capability_tool_name,source_asset_id,parent_asset_id,root_asset_id,output_asset_id,failure_code,public_message,created_at,updated_at,completed_at";
    const ownerJobs = await httpJson(state, `/heygen_media_jobs?operation_id=eq.job-concurrent-1&select=${safeJobColumns}`, { token: ownerToken });
    assert.equal(ownerJobs.status, 200, ownerJobs.text);
    assert.equal(ownerJobs.json.length, 1);
    const jobKeys = Object.keys(ownerJobs.json[0]);
    for (const privateName of ["request_arguments", "request_fingerprint", "result_fingerprint"]) {
      assert.equal(jobKeys.includes(privateName), false);
    }
    assert.deepEqual((await httpJson(state, `/heygen_media_jobs?select=${safeJobColumns}`, { token: memberToken })).json, []);
    assert.deepEqual((await httpJson(state, `/heygen_media_jobs?select=${safeJobColumns}`, { token: otherToken })).json, []);
    assertDenied(await httpJson(state, "/heygen_media_jobs?select=*", { token: ownerToken }), "wildcard job projection");
    assertDenied(await httpJson(state, "/heygen_media_jobs?select=request_arguments", { token: ownerToken }), "job arguments");

    const ownerVersions = await httpJson(state, `/media_assets?id=eq.${outputAssetId}&select=id,workspace_id,owner_user_id,provider,immutable`, { token: ownerToken });
    assert.equal(ownerVersions.status, 200, ownerVersions.text);
    assert.equal(ownerVersions.json.length, 1);
    assert.deepEqual((await httpJson(state, `/media_assets?id=eq.${outputAssetId}&select=id`, { token: memberToken })).json, []);
    assert.deepEqual((await httpJson(state, `/media_assets?id=eq.${outputAssetId}&select=id`, { token: otherToken })).json, []);

    const directUpdate = await httpJson(state, `/media_assets?id=eq.${outputAssetId}`, {
      method: "PATCH",
      token: serviceToken,
      body: { title: "Mutated" }
    });
    assertSafeFailure(directUpdate, "HEYGEN_MEDIA_IMMUTABLE");
    const directDelete = await httpJson(state, `/media_assets?id=eq.${outputAssetId}`, { method: "DELETE", token: serviceToken });
    assertSafeFailure(directDelete, "HEYGEN_MEDIA_IMMUTABLE");
  });

  await check("workspace and requester boundaries hold for service-mediated reads", async () => {
    const crossWorkspace = await rpc("social_cues_heygen_job_context", {
      p_actor_user_id: actorB,
      p_workspace_id: workspaceB,
      p_job_id: jobId
    }, serviceToken);
    assertSanitizedRejection(crossWorkspace, "HEYGEN_JOB_NOT_FOUND");
    const crossRequester = await rpc("social_cues_heygen_job_context", {
      p_actor_user_id: memberA,
      p_workspace_id: workspaceA,
      p_job_id: jobId
    }, serviceToken);
    assertSanitizedRejection(crossRequester, "HEYGEN_JOB_NOT_FOUND");
  });

  await check("disconnect deletes credentials atomically and preserves replay-safe history", async () => {
    const operationId = "disconnect-postgrest-1";
    const requestFingerprint = fingerprint({ action: "disconnect" });
    const beginBody = {
      p_actor_user_id: actorA,
      p_workspace_id: workspaceA,
      p_action: "disconnect",
      p_operation_id: operationId,
      p_request_fingerprint: requestFingerprint
    };
    assert.equal(assertObject(await rpc("social_cues_heygen_account_operation_begin", beginBody, serviceToken)).outcome, "acquired");
    const completeBody = {
      p_actor_user_id: actorA,
      p_workspace_id: workspaceA,
      p_operation_id: operationId,
      p_request_fingerprint: requestFingerprint,
      p_safe_result: { remoteRevocation: { attempted: true, state: "remote_revocation_confirmed" } }
    };
    const unsafeReceipt = await rpc("social_cues_heygen_disconnect_complete", {
      ...completeBody,
      p_safe_result: {
        remoteRevocation: {
          attempted: true,
          state: "remote_revocation_confirmed",
          providerDetail: "not-public"
        }
      }
    }, serviceToken);
    assertSafeFailure(unsafeReceipt, "HEYGEN_DISCONNECT_INPUT_INVALID");
    assert.equal(await queryScalar(state, `select status from social_cues_private.heygen_operation_receipts where operation_id = ${quoteLiteral(operationId)};`), "pending");
    assert.equal(await queryScalar(state, `select count(*) from public.provider_tokens where workspace_id = ${quoteLiteral(workspaceA)}::uuid and provider = 'heygen';`), "1");
    await rpc("social_cues_heygen_disconnect_complete", completeBody, serviceToken);
    const replay = assertObject(await rpc("social_cues_heygen_disconnect_complete", completeBody, serviceToken));
    assert.equal(replay.replayed, true);
    assert.equal(await queryScalar(state, `select count(*) from public.provider_tokens where workspace_id = ${quoteLiteral(workspaceA)}::uuid and provider = 'heygen';`), "0");
    assert.equal(await queryScalar(state, `select count(*) from public.connected_accounts where workspace_id = ${quoteLiteral(workspaceA)}::uuid and provider = 'heygen';`), "0");
    assert.equal(await queryScalar(state, `select count(*) from public.heygen_media_jobs where workspace_id = ${quoteLiteral(workspaceA)}::uuid;`), "2");
    assert.equal(await queryScalar(state, `select count(*) from public.media_assets where id = ${quoteLiteral(outputAssetId)}::uuid;`), "1");
  });

  await check("workspace deletion cascades all private state, jobs, receipts, and lineage", async () => {
    await psql(state, `delete from public.workspaces where id = ${quoteLiteral(workspaceA)}::uuid;`);
    assert.equal(await queryScalar(state, `
      select
        (select count(*) from social_cues_private.heygen_oauth_states where workspace_id = ${quoteLiteral(workspaceA)}::uuid) +
        (select count(*) from social_cues_private.heygen_operation_receipts where workspace_id = ${quoteLiteral(workspaceA)}::uuid) +
        (select count(*) from public.heygen_media_jobs where workspace_id = ${quoteLiteral(workspaceA)}::uuid) +
        (select count(*) from public.media_assets where workspace_id = ${quoteLiteral(workspaceA)}::uuid) +
        (select count(*) from public.provider_tokens where workspace_id = ${quoteLiteral(workspaceA)}::uuid) +
        (select count(*) from public.connected_accounts where workspace_id = ${quoteLiteral(workspaceA)}::uuid);
    `), "0");
  });

  await check("PostgreSQL, PostgREST, Docker, HTTP, stdout, stderr, and audit data exclude plaintext canaries", async () => {
    const databaseSnapshot = await queryScalar(state, `
      select pg_catalog.jsonb_build_object(
        'accounts', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ca)), '[]'::jsonb) from public.connected_accounts ca),
        'tokens', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(pt)), '[]'::jsonb) from public.provider_tokens pt),
        'jobs', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(j)), '[]'::jsonb) from public.heygen_media_jobs j),
        'states', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s)), '[]'::jsonb) from social_cues_private.heygen_oauth_states s),
        'receipts', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)), '[]'::jsonb) from social_cues_private.heygen_operation_receipts r),
        'audit', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a)), '[]'::jsonb) from public.audit_logs a)
      )::text;
    `);
    assertSecretsAbsent(state, databaseSnapshot, "PostgreSQL snapshot");
    await scanRuntimeSafety(state);
    assert.equal(externalRequests, 0);
    assert.ok(loopbackRequests > 0);
  });
} catch (error) {
  primaryError = error;
} finally {
  try {
    await cleanupHarness(state);
  } catch (cleanupError) {
    primaryError ??= cleanupError;
  }
}

if (primaryError) throw primaryError;
assert.equal(state.cleanupComplete, true);
assert.equal(externalRequests, 0);

console.log(JSON.stringify({
  ok: true,
  suite: "heygen-durable-persistence-postgrest",
  passed: passed.length,
  checks: passed,
  postgresImage: POSTGRES_POSTGREST_IMAGE,
  postgrestImage: POSTGREST_IMAGE,
  migrationLineEndings: "crlf",
  network: "isolated-local-bridge",
  loopbackRequests,
  externalRequests,
  persistentVolumes: 0,
  cleanupComplete: state.cleanupComplete
}));
