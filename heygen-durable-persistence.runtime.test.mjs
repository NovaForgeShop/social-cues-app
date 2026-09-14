import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  POSTGRES_POSTGREST_IMAGE,
  POSTGRES_RUNTIME_IMAGE,
  applySqlFile,
  assertSecretsAbsent,
  cleanupHarness,
  createHarnessState,
  prepareState,
  psql,
  queryJson,
  queryScalar,
  quoteLiteral,
  registerSecret,
  scanRuntimeSafety,
  startPostgres
} from "./test-support/local-database-harness.mjs";

const repoDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(repoDirectory, "SUPABASE-HEYGEN-DURABLE-PERSISTENCE.sql");
const hardeningMigrationPath = path.join(repoDirectory, "SUPABASE-HEYGEN-DURABLE-PERSISTENCE-HARDENING.sql");
const images = [POSTGRES_RUNTIME_IMAGE, POSTGRES_POSTGREST_IMAGE];
const passed = [];
let externalRequests = 0;

globalThis.fetch = async () => {
  externalRequests += 1;
  throw new Error("External HTTP requests are forbidden in the HeyGen durable PostgreSQL harness.");
};

const baseFixtureSql = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create function auth.uid()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid;
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

create or replace function public.social_cues_has_active_entitlement(target_workspace_id uuid, target_user_id uuid)
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
`;

function envelope(seed) {
  return { alg: "aes-256-gcm", iv: seed.repeat(16).slice(0, 16), tag: seed.repeat(22).slice(0, 22), value: seed.repeat(48).slice(0, 48) };
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

function jsonLiteral(value) {
  return `${quoteLiteral(JSON.stringify(value))}::jsonb`;
}

function serviceJson(state, sql) {
  return queryJson(state, sql, { role: "service_role" });
}

function serviceScalar(state, sql, options = {}) {
  return queryScalar(state, sql, { role: "service_role", ...options });
}

async function expectFailure(state, sql, expected, options = {}) {
  const result = await psql(state, sql, { role: options.role || "service_role", allowFailure: true });
  assert.notEqual(result.code, 0, "database operation unexpectedly succeeded");
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, new RegExp(expected, "u"));
  assertSecretsAbsent(state, output, "HeyGen database failure");
}

async function check(image, name, fn) {
  await fn();
  passed.push(`${image}: ${name}`);
  console.log(`PASS ${image} ${name}`);
}

async function runImage(image) {
  const state = createHarnessState(`heygen-${image.replaceAll(/[^a-z0-9]/giu, "-")}`);
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const actorA = randomUUID();
  const actorB = randomUUID();
  const connectedAccountId = randomUUID();
  const sourceAssetId = randomUUID();
  const stateDigest = "A".repeat(43);
  const stateDigestB = "B".repeat(43);
  const verifier = envelope("V");
  const access = envelope("T");
  const refresh = envelope("R");
  const rotatedAccess = envelope("N");
  const secretCanary = registerSecret(state, "HEYGEN_RUNTIME_PLAINTEXT_CANARY_4D91C7");
  void secretCanary;

  let primaryError = null;
  try {
    await prepareState(state);
    await startPostgres(state, { image });
    await psql(state, baseFixtureSql);
    await psql(state, `
      insert into public.workspaces(id, owner_user_id, name) values
        (${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(actorA)}::uuid, 'Workspace A'),
        (${quoteLiteral(workspaceB)}::uuid, ${quoteLiteral(actorB)}::uuid, 'Workspace B');
      insert into public.workspace_members(workspace_id, user_id, role) values
        (${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(actorA)}::uuid, 'owner'),
        (${quoteLiteral(workspaceB)}::uuid, ${quoteLiteral(actorB)}::uuid, 'owner');
      insert into public.billing_entitlements(workspace_id, user_id, access, status) values
        (${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(actorA)}::uuid, 'paid', 'active'),
        (${quoteLiteral(workspaceB)}::uuid, ${quoteLiteral(actorB)}::uuid, 'paid', 'active');
      insert into public.media_assets(id, workspace_id, provider, kind, title)
      values (${quoteLiteral(sourceAssetId)}::uuid, ${quoteLiteral(workspaceA)}::uuid, 'upload', 'video', 'Source');
    `);

    await check(image, "base and hardening migrations apply cleanly and are rerunnable", async () => {
      await applySqlFile(state, migrationPath, { timeoutMs: 90_000 });
      await applySqlFile(state, migrationPath, { timeoutMs: 90_000 });
      await applySqlFile(state, hardeningMigrationPath, { timeoutMs: 90_000 });
      await applySqlFile(state, hardeningMigrationPath, { timeoutMs: 90_000 });
      assert.equal(await queryScalar(state, "select count(*) from public.heygen_media_jobs;"), "0");
    });

    await check(image, "hardening adds the exact FK index and deny-only private policies without client grants", async () => {
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
    });

    await check(image, "repository health and RPC grants are service-role-only", async () => {
      const health = await serviceJson(state, "select public.social_cues_heygen_repository_health();");
      assert.deepEqual(health, {
        contract_version: "social-cues.heygen-durable.v1",
        interface_fingerprint: "heygen-durable-v1-oauth-account-job-lineage"
      });
      await expectFailure(state, "select public.social_cues_heygen_repository_health();", "permission denied", { role: "authenticated" });
      assert.equal(await queryScalar(state, `
        select count(*) from information_schema.routine_privileges
        where routine_schema = 'public'
          and routine_name like 'social_cues_heygen_%'
          and grantee in ('PUBLIC', 'anon', 'authenticated');
      `), "0");
    });

    await check(image, "OAuth state stores only a digest and is consumed once", async () => {
      const issue = await serviceJson(state, `select public.social_cues_heygen_oauth_state_issue(
        ${quoteLiteral(actorA)}::uuid,
        ${quoteLiteral(workspaceA)}::uuid,
        ${quoteLiteral(stateDigest)},
        ${jsonLiteral(verifier)},
        ${jsonLiteral(metadata)},
        pg_catalog.now(),
        pg_catalog.now() + interval '10 minutes'
      );`);
      assert.deepEqual(issue, { outcome: "issued" });
      assert.equal(await queryScalar(state, `select count(*) from social_cues_private.heygen_oauth_states where state_digest = ${quoteLiteral(stateDigest)};`), "1");
      await psql(state, `
        create function public.test_heygen_fail_state_consume()
        returns trigger language plpgsql as $function$
        begin
          if new.consumed_at is not null then
            raise exception using errcode = '23514', message = 'HEYGEN_TEST_FAULT_STATE_CONSUME';
          end if;
          return new;
        end;
        $function$;
        create trigger test_heygen_fail_state_consume
        before update on social_cues_private.heygen_oauth_states
        for each row execute function public.test_heygen_fail_state_consume();
      `);
      await expectFailure(state, `select public.social_cues_heygen_oauth_state_consume(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(stateDigest)}
      );`, "HEYGEN_TEST_FAULT_STATE_CONSUME");
      assert.equal(await queryScalar(state, `select consumed_at is null and protected_verifier is not null from social_cues_private.heygen_oauth_states where state_digest = ${quoteLiteral(stateDigest)};`), "t");
      await psql(state, `
        drop trigger test_heygen_fail_state_consume on social_cues_private.heygen_oauth_states;
        drop function public.test_heygen_fail_state_consume();
      `);
      const consumed = await serviceJson(state, `select public.social_cues_heygen_oauth_state_consume(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(stateDigest)}
      );`);
      assert.equal(consumed.outcome, "consumed");
      assert.deepEqual(consumed.protected_verifier, verifier);
      assert.equal(await queryScalar(state, `select protected_verifier is null and discovered_metadata is null from social_cues_private.heygen_oauth_states where state_digest = ${quoteLiteral(stateDigest)};`), "t");
      await expectFailure(state, `select public.social_cues_heygen_oauth_state_consume(${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(stateDigest)});`, "HEYGEN_STATE_NOT_CONSUMABLE");
      await expectFailure(state, `select public.social_cues_heygen_oauth_state_consume(${quoteLiteral(actorB)}::uuid, ${quoteLiteral(workspaceB)}::uuid, ${quoteLiteral(stateDigest)});`, "HEYGEN_STATE_OWNER_MISMATCH");
    });

    await check(image, "connection commit atomically stores one owned account and protected token", async () => {
      await psql(state, `
        create function public.test_heygen_fail_token_insert()
        returns trigger language plpgsql as $function$
        begin
          if new.provider = 'heygen' then
            raise exception using errcode = '23514', message = 'HEYGEN_TEST_FAULT_TOKEN_INSERT';
          end if;
          return new;
        end;
        $function$;
        create trigger test_heygen_fail_token_insert
        before insert on public.provider_tokens
        for each row execute function public.test_heygen_fail_token_insert();
      `);
      await expectFailure(state, `select public.social_cues_heygen_connection_commit(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(stateDigest)},
        ${quoteLiteral(connectedAccountId)}::uuid, 'provider-account-a', 'Fixture Creator',
        array['mcp:tools']::text[], ${jsonLiteral(publicProfile)}, ${jsonLiteral(access)},
        ${jsonLiteral(refresh)}, 'Bearer', pg_catalog.now() + interval '1 hour', pg_catalog.now()
      );`, "HEYGEN_TEST_FAULT_TOKEN_INSERT");
      assert.equal(await queryScalar(state, `select count(*) from public.connected_accounts where workspace_id = ${quoteLiteral(workspaceA)}::uuid and provider = 'heygen';`), "0");
      assert.equal(await queryScalar(state, `select completed_at is null from social_cues_private.heygen_oauth_states where state_digest = ${quoteLiteral(stateDigest)};`), "t");
      await psql(state, `
        drop trigger test_heygen_fail_token_insert on public.provider_tokens;
        drop function public.test_heygen_fail_token_insert();
      `);
      const committed = await serviceJson(state, `select public.social_cues_heygen_connection_commit(
        ${quoteLiteral(actorA)}::uuid,
        ${quoteLiteral(workspaceA)}::uuid,
        ${quoteLiteral(stateDigest)},
        ${quoteLiteral(connectedAccountId)}::uuid,
        'provider-account-a',
        'Fixture Creator',
        array['mcp:tools']::text[],
        ${jsonLiteral(publicProfile)},
        ${jsonLiteral(access)},
        ${jsonLiteral(refresh)},
        'Bearer',
        pg_catalog.now() + interval '1 hour',
        pg_catalog.now()
      );`);
      assert.equal(committed.replayed, false);
      assert.equal(committed.account.id, connectedAccountId);
      assert.deepEqual(committed.account.encrypted_token, access);
      assert.equal(await queryScalar(state, `select count(*) from public.provider_tokens where connected_account_id = ${quoteLiteral(connectedAccountId)}::uuid;`), "1");
      const replayed = await serviceJson(state, `select public.social_cues_heygen_connection_commit(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(stateDigest)},
        ${quoteLiteral(connectedAccountId)}::uuid, 'provider-account-a', 'Fixture Creator',
        array['mcp:tools']::text[], ${jsonLiteral(publicProfile)}, ${jsonLiteral(access)},
        ${jsonLiteral(refresh)}, 'Bearer', pg_catalog.now() + interval '1 hour', pg_catalog.now()
      );`);
      assert.equal(replayed.replayed, true);
      assert.equal(await queryScalar(state, `select count(*) from public.connected_accounts where workspace_id = ${quoteLiteral(workspaceA)}::uuid and provider = 'heygen';`), "1");
    });

    await check(image, "refresh rotation is idempotent and conflicting replays fail", async () => {
      const operationId = "refresh-runtime-1";
      const fingerprint = "C".repeat(43);
      const begun = await serviceJson(state, `select public.social_cues_heygen_account_operation_begin(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, 'refresh',
        ${quoteLiteral(operationId)}, ${quoteLiteral(fingerprint)}
      );`);
      assert.equal(begun.outcome, "acquired");
      await psql(state, `
        create function public.test_heygen_fail_token_refresh()
        returns trigger language plpgsql as $function$
        begin
          if new.provider = 'heygen' then
            raise exception using errcode = '23514', message = 'HEYGEN_TEST_FAULT_TOKEN_REFRESH';
          end if;
          return new;
        end;
        $function$;
        create trigger test_heygen_fail_token_refresh
        before update on public.provider_tokens
        for each row execute function public.test_heygen_fail_token_refresh();
      `);
      await expectFailure(state, `select public.social_cues_heygen_refresh_complete(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid,
        ${quoteLiteral(operationId)}, ${quoteLiteral(fingerprint)}, 'provider-account-a',
        'Fixture Creator', array['mcp:tools']::text[], ${jsonLiteral(publicProfile)},
        ${jsonLiteral(rotatedAccess)}, null, 'Bearer', pg_catalog.now() + interval '2 hours', pg_catalog.now()
      );`, "HEYGEN_TEST_FAULT_TOKEN_REFRESH");
      assert.equal(await queryScalar(state, `select encrypted_token = ${jsonLiteral(access)} from public.provider_tokens where connected_account_id = ${quoteLiteral(connectedAccountId)}::uuid;`), "t");
      assert.equal(await queryScalar(state, `select status from social_cues_private.heygen_operation_receipts where operation_id = ${quoteLiteral(operationId)};`), "pending");
      await psql(state, `
        drop trigger test_heygen_fail_token_refresh on public.provider_tokens;
        drop function public.test_heygen_fail_token_refresh();
      `);
      const completed = await serviceJson(state, `select public.social_cues_heygen_refresh_complete(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid,
        ${quoteLiteral(operationId)}, ${quoteLiteral(fingerprint)}, 'provider-account-a',
        'Fixture Creator', array['mcp:tools']::text[], ${jsonLiteral(publicProfile)},
        ${jsonLiteral(rotatedAccess)}, null, 'Bearer', pg_catalog.now() + interval '2 hours', pg_catalog.now()
      );`);
      assert.equal(completed.replayed, false);
      assert.deepEqual(completed.account.encrypted_token, rotatedAccess);
      const replay = await serviceJson(state, `select public.social_cues_heygen_refresh_complete(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid,
        ${quoteLiteral(operationId)}, ${quoteLiteral(fingerprint)}, 'provider-account-a',
        'Fixture Creator', array['mcp:tools']::text[], ${jsonLiteral(publicProfile)},
        ${jsonLiteral(rotatedAccess)}, null, 'Bearer', pg_catalog.now() + interval '2 hours', pg_catalog.now()
      );`);
      assert.equal(replay.replayed, true);
      await expectFailure(state, `select public.social_cues_heygen_account_operation_begin(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, 'refresh',
        ${quoteLiteral(operationId)}, ${quoteLiteral("D".repeat(43))}
      );`, "HEYGEN_OPERATION_CONFLICT");
    });

    let jobId;
    let versionId;
    await check(image, "job reservation, polling identity, and terminal lineage are replay-safe", async () => {
      const operationId = "job-runtime-1";
      const requestFingerprint = "E".repeat(43);
      const requestArguments = { prompt: "Create a launch video", title: "Launch" };
      await psql(state, `
        create function public.test_heygen_fail_job_reserve()
        returns trigger language plpgsql as $function$
        begin
          raise exception using errcode = '23514', message = 'HEYGEN_TEST_FAULT_JOB_RESERVE';
        end;
        $function$;
        create trigger test_heygen_fail_job_reserve
        before insert on public.heygen_media_jobs
        for each row execute function public.test_heygen_fail_job_reserve();
      `);
      await expectFailure(state, `select public.social_cues_heygen_job_reserve(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, 'prompt_to_video',
        'job-runtime-fault', ${quoteLiteral("Q".repeat(43))}, ${jsonLiteral({ prompt: "Fault fixture" })}, null, null
      );`, "HEYGEN_TEST_FAULT_JOB_RESERVE");
      assert.equal(await queryScalar(state, "select count(*) from public.heygen_media_jobs where operation_id = 'job-runtime-fault';"), "0");
      await psql(state, `
        drop trigger test_heygen_fail_job_reserve on public.heygen_media_jobs;
        drop function public.test_heygen_fail_job_reserve();
      `);
      const reserved = await serviceJson(state, `select public.social_cues_heygen_job_reserve(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, 'prompt_to_video',
        ${quoteLiteral(operationId)}, ${quoteLiteral(requestFingerprint)}, ${jsonLiteral(requestArguments)}, null, null
      );`);
      assert.equal(reserved.replayed, false);
      jobId = reserved.job.id;
      assert.equal(reserved.job.status, "submitted");
      assert.deepEqual(reserved.request_arguments, requestArguments);
      const duplicate = await serviceJson(state, `select public.social_cues_heygen_job_reserve(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, 'prompt_to_video',
        ${quoteLiteral(operationId)}, ${quoteLiteral(requestFingerprint)}, ${jsonLiteral(requestArguments)}, null, null
      );`);
      assert.equal(duplicate.replayed, true);
      assert.equal(duplicate.job.id, jobId);
      await expectFailure(state, `select public.social_cues_heygen_job_reserve(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, 'prompt_to_video',
        ${quoteLiteral(operationId)}, ${quoteLiteral("F".repeat(43))}, ${jsonLiteral({ prompt: "Different" })}, null, null
      );`, "HEYGEN_OPERATION_CONFLICT");

      const processing = await serviceJson(state, `select public.social_cues_heygen_job_transition(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(jobId)}::uuid,
        'processing', ${quoteLiteral("G".repeat(43))}, 'provider-job-1', 'provider-session-1',
        'prompt_to_video', 'video_agent', null, null, null, null, null
      );`);
      assert.equal(processing.job.status, "processing");
      await psql(state, `
        create function public.test_heygen_fail_version_insert()
        returns trigger language plpgsql as $function$
        begin
          if new.provider = 'heygen' then
            raise exception using errcode = '23514', message = 'HEYGEN_TEST_FAULT_VERSION_INSERT';
          end if;
          return new;
        end;
        $function$;
        create trigger test_heygen_fail_version_insert
        before insert on public.media_assets
        for each row execute function public.test_heygen_fail_version_insert();
      `);
      await expectFailure(state, `select public.social_cues_heygen_job_transition(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(jobId)}::uuid,
        'completed', ${quoteLiteral("H".repeat(43))}, 'provider-job-1', 'provider-session-1',
        'prompt_to_video', 'video_agent', 'resource-1', 'https://files.heygen.com/result-1.mp4',
        'Launch', null, 'Generated successfully.'
      );`, "HEYGEN_TEST_FAULT_VERSION_INSERT");
      assert.equal(await queryScalar(state, `select status = 'processing' and output_asset_id is null from public.heygen_media_jobs where id = ${quoteLiteral(jobId)}::uuid;`), "t");
      assert.equal(await queryScalar(state, `select count(*) from public.media_assets where provider = 'heygen' and operation_id = ${quoteLiteral(operationId)};`), "0");
      await psql(state, `
        drop trigger test_heygen_fail_version_insert on public.media_assets;
        drop function public.test_heygen_fail_version_insert();
      `);
      const completed = await serviceJson(state, `select public.social_cues_heygen_job_transition(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(jobId)}::uuid,
        'completed', ${quoteLiteral("H".repeat(43))}, 'provider-job-1', 'provider-session-1',
        'prompt_to_video', 'video_agent', 'resource-1', 'https://files.heygen.com/result-1.mp4',
        'Launch', null, 'Generated successfully.'
      );`);
      assert.equal(completed.replayed, false);
      assert.equal(completed.job.status, "completed");
      assert.equal(completed.version.immutable, true);
      assert.equal(completed.version.version_number, 1);
      assert.equal(completed.version.root_asset_id, completed.version.id);
      versionId = completed.version.id;
      const replay = await serviceJson(state, `select public.social_cues_heygen_job_transition(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(jobId)}::uuid,
        'completed', ${quoteLiteral("H".repeat(43))}, 'provider-job-1', 'provider-session-1',
        'prompt_to_video', 'video_agent', 'resource-1', 'https://files.heygen.com/result-1.mp4',
        'Launch', null, 'Generated successfully.'
      );`);
      assert.equal(replay.replayed, true);
      assert.equal(replay.version.id, versionId);
      await expectFailure(state, `select public.social_cues_heygen_job_transition(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(jobId)}::uuid,
        'failed', ${quoteLiteral("I".repeat(43))}, null, null, null, null, null, null, null,
        'provider_failed', 'Different terminal result'
      );`, "HEYGEN_RESULT_TERMINAL_CONFLICT");
      assert.equal(await queryScalar(state, `select count(*) from public.media_assets where provider = 'heygen' and operation_id = ${quoteLiteral(operationId)};`), "1");
    });

    await check(image, "immutable versions reject update, delete, and direct insertion", async () => {
      await expectFailure(state, `update public.media_assets set title = 'Mutated' where id = ${quoteLiteral(versionId)}::uuid;`, "HEYGEN_MEDIA_IMMUTABLE");
      await expectFailure(state, `delete from public.media_assets where id = ${quoteLiteral(versionId)}::uuid;`, "HEYGEN_MEDIA_IMMUTABLE");
      await expectFailure(state, `insert into public.media_assets(workspace_id, owner_user_id, provider, kind, immutable) values (
        ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(actorA)}::uuid, 'heygen', 'video', true
      );`, "HEYGEN_MEDIA_WRITE_REQUIRES_TRANSACTION");
    });

    await check(image, "cross-workspace reads and malformed writes fail without mutation", async () => {
      await expectFailure(state, `select public.social_cues_heygen_job_context(
        ${quoteLiteral(actorB)}::uuid, ${quoteLiteral(workspaceB)}::uuid, ${quoteLiteral(jobId)}::uuid
      );`, "HEYGEN_JOB_NOT_FOUND");
      await expectFailure(state, `select public.social_cues_heygen_job_reserve(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, 'translate_video',
        'job-lineage-envelope-mismatch', ${quoteLiteral("L".repeat(43))},
        ${jsonLiteral({ sourceAssetId: randomUUID(), locale: "fr-FR" })},
        ${quoteLiteral(sourceAssetId)}::uuid, null
      );`, "HEYGEN_JOB_INPUT_INVALID");
      assert.equal(await queryScalar(state, "select count(*) from public.heygen_media_jobs where operation_id = 'job-lineage-envelope-mismatch';"), "0");
      await serviceJson(state, `select public.social_cues_heygen_oauth_state_issue(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(stateDigestB)},
        ${jsonLiteral(verifier)}, ${jsonLiteral(metadata)}, pg_catalog.now(), pg_catalog.now() + interval '10 minutes'
      );`);
      await serviceJson(state, `select public.social_cues_heygen_oauth_state_consume(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(stateDigestB)}
      );`);
      await expectFailure(state, `select public.social_cues_heygen_connection_commit(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, ${quoteLiteral(stateDigestB)},
        ${quoteLiteral(randomUUID())}::uuid, 'provider-account-a', 'Fixture Creator', array[]::text[],
        ${jsonLiteral(publicProfile)}, ${jsonLiteral({ alg: "aes-256-gcm", iv: "bad", tag: "bad", value: "bad" })},
        null, 'Bearer', null, pg_catalog.now()
      );`, "HEYGEN_CONNECTION_INPUT_INVALID");
      assert.equal(await queryScalar(state, `select completed_at is null from social_cues_private.heygen_oauth_states where state_digest = ${quoteLiteral(stateDigestB)};`), "t");
      assert.equal(await queryScalar(state, `select count(*) from public.connected_accounts where workspace_id = ${quoteLiteral(workspaceA)}::uuid and provider = 'heygen';`), "1");
    });

    await check(image, "disconnect atomically deletes credentials and replays a safe receipt", async () => {
      const operationId = "disconnect-runtime-1";
      const fingerprint = "J".repeat(43);
      const begun = await serviceJson(state, `select public.social_cues_heygen_account_operation_begin(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid, 'disconnect',
        ${quoteLiteral(operationId)}, ${quoteLiteral(fingerprint)}
      );`);
      assert.equal(begun.outcome, "acquired");
      const safeResult = { remoteRevocation: { attempted: true, state: "remote_revocation_confirmed" } };
      await expectFailure(state, `select public.social_cues_heygen_disconnect_complete(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid,
        ${quoteLiteral(operationId)}, ${quoteLiteral(fingerprint)},
        ${jsonLiteral({ remoteRevocation: { attempted: true, state: "remote_revocation_confirmed", detail: "not-allowed" } })}
      );`, "HEYGEN_DISCONNECT_INPUT_INVALID");
      assert.equal(await queryScalar(state, `select status from social_cues_private.heygen_operation_receipts where operation_id = ${quoteLiteral(operationId)};`), "pending");
      await psql(state, `
        create function public.test_heygen_fail_account_delete()
        returns trigger language plpgsql as $function$
        begin
          if old.provider = 'heygen' then
            raise exception using errcode = '23514', message = 'HEYGEN_TEST_FAULT_ACCOUNT_DELETE';
          end if;
          return old;
        end;
        $function$;
        create trigger test_heygen_fail_account_delete
        before delete on public.connected_accounts
        for each row execute function public.test_heygen_fail_account_delete();
      `);
      await expectFailure(state, `select public.social_cues_heygen_disconnect_complete(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid,
        ${quoteLiteral(operationId)}, ${quoteLiteral(fingerprint)}, ${jsonLiteral(safeResult)}
      );`, "HEYGEN_TEST_FAULT_ACCOUNT_DELETE");
      assert.equal(await queryScalar(state, `select count(*) from public.provider_tokens where workspace_id = ${quoteLiteral(workspaceA)}::uuid and provider = 'heygen';`), "1");
      assert.equal(await queryScalar(state, `select count(*) from public.connected_accounts where workspace_id = ${quoteLiteral(workspaceA)}::uuid and provider = 'heygen';`), "1");
      assert.equal(await queryScalar(state, `select status from social_cues_private.heygen_operation_receipts where operation_id = ${quoteLiteral(operationId)};`), "pending");
      await psql(state, `
        drop trigger test_heygen_fail_account_delete on public.connected_accounts;
        drop function public.test_heygen_fail_account_delete();
      `);
      const completed = await serviceJson(state, `select public.social_cues_heygen_disconnect_complete(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid,
        ${quoteLiteral(operationId)}, ${quoteLiteral(fingerprint)}, ${jsonLiteral(safeResult)}
      );`);
      assert.equal(completed.replayed, false);
      assert.deepEqual(completed.safe_result, safeResult);
      assert.equal(await queryScalar(state, `select count(*) from public.provider_tokens where workspace_id = ${quoteLiteral(workspaceA)}::uuid and provider = 'heygen';`), "0");
      assert.equal(await queryScalar(state, `select count(*) from public.connected_accounts where workspace_id = ${quoteLiteral(workspaceA)}::uuid and provider = 'heygen';`), "0");
      const replay = await serviceJson(state, `select public.social_cues_heygen_disconnect_complete(
        ${quoteLiteral(actorA)}::uuid, ${quoteLiteral(workspaceA)}::uuid,
        ${quoteLiteral(operationId)}, ${quoteLiteral(fingerprint)}, ${jsonLiteral(safeResult)}
      );`);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.safe_result, safeResult);
    });

    await check(image, "workspace deletion cascades private state, jobs, receipts, and immutable lineage", async () => {
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

    await check(image, "private and secret-bearing relations have no client grants", async () => {
      assert.equal(await queryScalar(state, `
        select count(*) from information_schema.table_privileges
        where grantee in ('PUBLIC', 'anon', 'authenticated')
          and (
            (table_schema = 'social_cues_private')
            or (table_schema = 'public' and table_name = 'provider_tokens')
          );
      `), "0");
      assert.equal(await queryScalar(state, `
        select count(*) from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'heygen_media_jobs'
          and grantee = 'authenticated'
          and column_name in ('request_arguments', 'request_fingerprint', 'result_fingerprint');
      `), "0");
    });

    await scanRuntimeSafety(state);
    assert.equal(externalRequests, 0);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await cleanupHarness(state);
    } catch (cleanupError) {
      if (!primaryError) primaryError = cleanupError;
      else primaryError = new AggregateError([primaryError, cleanupError], `HeyGen ${image} verification and cleanup failed`);
    }
  }
  assert.equal(state.cleanupComplete, true, `${image} cleanup did not complete`);
  if (primaryError) throw primaryError;
}

for (const image of images) await runImage(image);

assert.equal(externalRequests, 0);
console.log(JSON.stringify({
  ok: true,
  passed: passed.length,
  postgresImages: images,
  externalRequests,
  cleanupComplete: true
}));
