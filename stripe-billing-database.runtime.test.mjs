import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
  quoteIdentifier,
  quoteLiteral,
  registerSecret,
  scanRuntimeSafety,
  startPostgres
} from "./test-support/local-database-harness.mjs";

const repoDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(repoDirectory, "SUPABASE-STRIPE-BILLING-LIFECYCLE.sql");
const trackedMigrationSql = await readFile(migrationPath, "utf8");
const state = createHarnessState("runtime");
const databases = new Set();
const passed = [];
let databaseCounter = 0;
let externalRequests = 0;

globalThis.fetch = async () => {
  externalRequests += 1;
  throw new Error("External HTTP requests are forbidden in the Stripe B0 PostgreSQL harness.");
};

const stripeSecretCanary = registerSecret(state, ["sk", "test", "B0RuntimeSecretCanary", "93b7d1"].join("_"));
const webhookSecretCanary = registerSecret(state, ["whsec", "B0RuntimeWebhookCanary", "7a29e4"].join("_"));
const rawEnvelopeCanary = registerSecret(state, '{"type":"invoice.paid","secret":"B0RawEnvelopeCanary"}');
const customerA = registerSecret(state, "cus_B0RuntimeCustomerA123");
const customerB = registerSecret(state, "cus_B0RuntimeCustomerB456");
const subscriptionA = registerSecret(state, "sub_B0RuntimeSubscriptionA123");
const subscriptionB = registerSecret(state, "sub_B0RuntimeSubscriptionB456");
const subscriptionC = registerSecret(state, "sub_B0RuntimeSubscriptionC789");
const checkoutSession = registerSecret(state, "cs_test_B0RuntimeCheckoutSession123");
const checkoutSessionReplacement = registerSecret(state, "cs_test_B0RuntimeCheckoutReplacement456");

void stripeSecretCanary;
void webhookSecretCanary;
void rawEnvelopeCanary;

const baseFixtureSql = `
create table public.workspaces (
  id uuid primary key default pg_catalog.gen_random_uuid()
);

create table public.audit_logs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  workspace_id uuid,
  user_id uuid,
  event_type text not null,
  provider text,
  platform text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default pg_catalog.now()
);

create table public.webhook_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text,
  status text not null default 'processing'::text,
  attempts integer not null default 1,
  received_at timestamp with time zone not null default pg_catalog.now(),
  processed_at timestamp with time zone,
  last_error text,
  constraint webhook_events_provider_event_id_key unique (provider, event_id)
);

alter table public.webhook_events enable row level security;
revoke all on table public.webhook_events from public, anon, authenticated;
create policy "webhook events are service role only"
  on public.webhook_events for all to anon, authenticated
  using (false) with check (false);

grant usage on schema public to anon, authenticated, service_role;
`;

function canonicalizeLineEndings(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

const canonicalMigrationSql = canonicalizeLineEndings(trackedMigrationSql);
const fingerprintDefinitionsStart = canonicalMigrationSql.indexOf(
  "create or replace function pg_temp.social_cues_b0_relation_fingerprint"
);
const fingerprintDefinitionsEnd = canonicalMigrationSql.indexOf("do $preflight$");
assert.ok(fingerprintDefinitionsStart >= 0 && fingerprintDefinitionsEnd > fingerprintDefinitionsStart);
const fingerprintDefinitions = canonicalMigrationSql.slice(
  fingerprintDefinitionsStart,
  fingerprintDefinitionsEnd
);

function combinedOutput(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function assertFailureForState(harnessState, result, expectedMessage) {
  assert.notEqual(result.code, 0, "operation unexpectedly succeeded");
  assert.match(combinedOutput(result), new RegExp(expectedMessage, "u"));
  assertSecretsAbsent(harnessState, combinedOutput(result), "database error");
}

function assertFailure(result, expectedMessage) {
  assertFailureForState(state, result, expectedMessage);
}

async function check(name, fn) {
  await fn();
  passed.push(name);
  console.log(`PASS ${name}`);
}

async function initializeClusterFor(harnessState) {
  await psql(harnessState, `
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
  `);
}

async function initializeCluster() {
  await initializeClusterFor(state);
}

async function createDatabaseFor(harnessState, label, extraSql = "") {
  databaseCounter += 1;
  const database = `b0_${process.pid}_${databaseCounter}_${label}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/gu, "_")
    .slice(0, 60);
  await psql(harnessState, `create database ${quoteIdentifier(database)};`);
  databases.add(database);
  await psql(harnessState, `${baseFixtureSql}\n${extraSql}`, { database });
  return database;
}

async function createDatabase(label, extraSql = "") {
  return createDatabaseFor(state, label, extraSql);
}

async function dropDatabaseFor(harnessState, database) {
  await psql(harnessState, `drop database if exists ${quoteIdentifier(database)};`);
  databases.delete(database);
}

function applyMigrationFor(harnessState, database, {
  filePath = migrationPath,
  ...options
} = {}) {
  return applySqlFile(harnessState, filePath, { database, timeoutMs: 90_000, ...options });
}

function applyMigration(database, options = {}) {
  return applyMigrationFor(state, database, options);
}

async function writeMigrationVariants(harnessState) {
  assert.ok(harnessState.tempDirectory, "migration variants require a prepared harness state");
  assert.equal(canonicalMigrationSql.includes("\r"), false);
  assert.equal(trackedMigrationSql.replaceAll("\r\n", "").includes("\r"), false,
    "tracked migration contains an intentional or lone carriage return");

  const crlfSql = canonicalMigrationSql.replaceAll("\n", "\r\n");
  const loneCrSql = canonicalMigrationSql.replaceAll("\n", "\r");
  assert.equal(crlfSql.replaceAll("\r\n", "").includes("\n"), false);
  assert.equal(loneCrSql.includes("\n"), false);

  const variants = {
    tracked: migrationPath,
    lf: path.join(harnessState.tempDirectory, "stripe-b0-lf.sql"),
    crlf: path.join(harnessState.tempDirectory, "stripe-b0-crlf.sql"),
    loneCr: path.join(harnessState.tempDirectory, "stripe-b0-lone-cr.sql")
  };
  await writeFile(variants.lf, canonicalMigrationSql, "utf8");
  await writeFile(variants.crlf, crlfSql, "utf8");
  await writeFile(variants.loneCr, loneCrSql, "utf8");
  return variants;
}

async function catalogSnapshot(harnessState, database) {
  return queryJson(harnessState, `
    ${fingerprintDefinitions}
    select pg_catalog.json_build_object(
      'relations', pg_catalog.json_build_object(
        'bindings', pg_temp.social_cues_b0_relation_fingerprint('public.stripe_billing_bindings'::regclass),
        'checkout', pg_temp.social_cues_b0_relation_fingerprint('public.stripe_checkout_sessions'::regclass)
      ),
      'functions', pg_catalog.json_build_object(
        'binding_update', pg_temp.social_cues_b0_function_fingerprint(
          'public.social_cues_enforce_stripe_binding_update()'::regprocedure
        ),
        'checkout_identity', pg_temp.social_cues_b0_function_fingerprint(
          'public.social_cues_enforce_stripe_checkout_identity()'::regprocedure
        ),
        'reconcile', pg_temp.social_cues_b0_function_fingerprint(
          'public.social_cues_reconcile_stripe_binding(uuid,text,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text)'::regprocedure
        ),
        'claim', pg_temp.social_cues_b0_function_fingerprint(
          'public.social_cues_claim_stripe_webhook_event(uuid,text,text,text,integer)'::regprocedure
        )
      ),
      'constraints', (
        select pg_catalog.md5(coalesce(pg_catalog.string_agg(
          pg_catalog.concat_ws('|', relation_catalog.relname, constraint_catalog.conname,
            constraint_catalog.contype::text,
            pg_catalog.pg_get_constraintdef(constraint_catalog.oid, true),
            coalesce(pg_catalog.obj_description(constraint_catalog.oid, 'pg_constraint'), '')),
          E'\n' order by relation_catalog.relname, constraint_catalog.conname
        ), ''))
        from pg_catalog.pg_constraint constraint_catalog
        join pg_catalog.pg_class relation_catalog on relation_catalog.oid = constraint_catalog.conrelid
        join pg_catalog.pg_namespace namespace_catalog on namespace_catalog.oid = relation_catalog.relnamespace
        where namespace_catalog.nspname = 'public'
          and relation_catalog.relname in (
            'stripe_billing_bindings', 'stripe_checkout_sessions', 'webhook_events'
          )
      ),
      'triggers', (
        select pg_catalog.md5(coalesce(pg_catalog.string_agg(
          pg_catalog.concat_ws('|', relation_catalog.relname, trigger_catalog.tgname,
            pg_catalog.pg_get_triggerdef(trigger_catalog.oid, true),
            coalesce(pg_catalog.obj_description(trigger_catalog.oid, 'pg_trigger'), '')),
          E'\n' order by relation_catalog.relname, trigger_catalog.tgname
        ), ''))
        from pg_catalog.pg_trigger trigger_catalog
        join pg_catalog.pg_class relation_catalog on relation_catalog.oid = trigger_catalog.tgrelid
        join pg_catalog.pg_namespace namespace_catalog on namespace_catalog.oid = relation_catalog.relnamespace
        where namespace_catalog.nspname = 'public'
          and relation_catalog.relname in ('stripe_billing_bindings', 'stripe_checkout_sessions')
          and not trigger_catalog.tgisinternal
      ),
      'policies', (
        select pg_catalog.md5(coalesce(pg_catalog.string_agg(
          pg_catalog.concat_ws('|', relation_catalog.relname, policy_catalog.polname,
            policy_catalog.polcmd, policy_catalog.polpermissive::text,
            coalesce(pg_catalog.pg_get_expr(policy_catalog.polqual, policy_catalog.polrelid, true), ''),
            coalesce(pg_catalog.pg_get_expr(policy_catalog.polwithcheck, policy_catalog.polrelid, true), '')),
          E'\n' order by relation_catalog.relname, policy_catalog.polname
        ), ''))
        from pg_catalog.pg_policy policy_catalog
        join pg_catalog.pg_class relation_catalog on relation_catalog.oid = policy_catalog.polrelid
        join pg_catalog.pg_namespace namespace_catalog on namespace_catalog.oid = relation_catalog.relnamespace
        where namespace_catalog.nspname = 'public'
          and relation_catalog.relname in (
            'stripe_billing_bindings', 'stripe_checkout_sessions', 'webhook_events'
          )
      ),
      'indexes', (
        select pg_catalog.md5(coalesce(pg_catalog.string_agg(
          pg_catalog.concat_ws('|', relation_catalog.relname, index_catalog.relname,
            pg_catalog.pg_get_indexdef(index_catalog.oid),
            coalesce(pg_catalog.obj_description(index_catalog.oid, 'pg_class'), '')),
          E'\n' order by relation_catalog.relname, index_catalog.relname
        ), ''))
        from pg_catalog.pg_index index_metadata
        join pg_catalog.pg_class index_catalog on index_catalog.oid = index_metadata.indexrelid
        join pg_catalog.pg_class relation_catalog on relation_catalog.oid = index_metadata.indrelid
        join pg_catalog.pg_namespace namespace_catalog on namespace_catalog.oid = relation_catalog.relnamespace
        where namespace_catalog.nspname = 'public'
          and relation_catalog.relname in (
            'stripe_billing_bindings', 'stripe_checkout_sessions', 'webhook_events'
          )
      ),
      'grants', pg_catalog.md5(pg_catalog.concat_ws(E'\n',
        coalesce((
          select pg_catalog.string_agg(
            pg_catalog.concat_ws('|', relation_catalog.relname,
              coalesce(grantee_role.rolname, 'PUBLIC'), acl_entry.privilege_type,
              acl_entry.is_grantable::text, grantor_role.rolname),
            E'\n' order by relation_catalog.relname,
              coalesce(grantee_role.rolname, 'PUBLIC'), acl_entry.privilege_type
          )
          from pg_catalog.pg_class relation_catalog
          join pg_catalog.pg_namespace namespace_catalog on namespace_catalog.oid = relation_catalog.relnamespace
          cross join lateral pg_catalog.aclexplode(
            coalesce(relation_catalog.relacl, pg_catalog.acldefault('r', relation_catalog.relowner))
          ) acl_entry
          left join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl_entry.grantee
          join pg_catalog.pg_roles grantor_role on grantor_role.oid = acl_entry.grantor
          where namespace_catalog.nspname = 'public'
            and relation_catalog.relname in (
              'stripe_billing_bindings', 'stripe_checkout_sessions', 'webhook_events'
            )
            and acl_entry.grantee <> relation_catalog.relowner
        ), ''),
        coalesce((
          select pg_catalog.string_agg(
            pg_catalog.concat_ws('|', function_catalog.proname,
              pg_catalog.pg_get_function_identity_arguments(function_catalog.oid),
              coalesce(grantee_role.rolname, 'PUBLIC'), acl_entry.privilege_type,
              acl_entry.is_grantable::text, grantor_role.rolname),
            E'\n' order by function_catalog.proname,
              pg_catalog.pg_get_function_identity_arguments(function_catalog.oid),
              coalesce(grantee_role.rolname, 'PUBLIC'), acl_entry.privilege_type
          )
          from pg_catalog.pg_proc function_catalog
          join pg_catalog.pg_namespace namespace_catalog on namespace_catalog.oid = function_catalog.pronamespace
          cross join lateral pg_catalog.aclexplode(
            coalesce(function_catalog.proacl, pg_catalog.acldefault('f', function_catalog.proowner))
          ) acl_entry
          left join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl_entry.grantee
          join pg_catalog.pg_roles grantor_role on grantor_role.oid = acl_entry.grantor
          where namespace_catalog.nspname = 'public'
            and function_catalog.proname in (
              'social_cues_enforce_stripe_binding_update',
              'social_cues_enforce_stripe_checkout_identity',
              'social_cues_reconcile_stripe_binding',
              'social_cues_claim_stripe_webhook_event'
            )
        ), '')
      )),
      'counts', pg_catalog.json_build_object(
        'tables', (select pg_catalog.count(*) from pg_catalog.pg_class relation_catalog
          join pg_catalog.pg_namespace namespace_catalog on namespace_catalog.oid = relation_catalog.relnamespace
          where namespace_catalog.nspname = 'public'
            and relation_catalog.relname in ('stripe_billing_bindings', 'stripe_checkout_sessions')
            and relation_catalog.relkind = 'r'),
        'functions', (select pg_catalog.count(*) from pg_catalog.pg_proc function_catalog
          join pg_catalog.pg_namespace namespace_catalog on namespace_catalog.oid = function_catalog.pronamespace
          where namespace_catalog.nspname = 'public'
            and function_catalog.proname in (
              'social_cues_enforce_stripe_binding_update',
              'social_cues_enforce_stripe_checkout_identity',
              'social_cues_reconcile_stripe_binding',
              'social_cues_claim_stripe_webhook_event'
            )),
        'triggers', (select pg_catalog.count(*) from pg_catalog.pg_trigger trigger_catalog
          where not trigger_catalog.tgisinternal
            and trigger_catalog.tgname in (
              'enforce_stripe_billing_binding_update',
              'enforce_stripe_checkout_session_identity'
            )),
        'policies', (select pg_catalog.count(*) from pg_catalog.pg_policy policy_catalog
          where policy_catalog.polname in (
            'stripe_billing_bindings_deny_client_access',
            'stripe_checkout_sessions_deny_client_access'
          ))
      ),
      'data', pg_catalog.json_build_object(
        'workspaces', (select pg_catalog.count(*) from public.workspaces),
        'bindings', (select pg_catalog.count(*) from public.stripe_billing_bindings),
        'checkout_sessions', (select pg_catalog.count(*) from public.stripe_checkout_sessions),
        'webhook_events', (select pg_catalog.count(*) from public.webhook_events)
      )
    );
  `, { database });
}

async function exerciseMatrixRpcs(harnessState, database) {
  const workspaceId = "00000000-0000-4000-8000-0000000000a1";
  const customerId = registerSecret(harnessState, "cus_B0LineEndingMatrixA123");
  const subscriptionId = registerSecret(harnessState, "sub_B0LineEndingMatrixA123");
  await psql(harnessState, `
    insert into public.workspaces(id) values (${quoteLiteral(workspaceId)}::uuid);
  `, { database });
  const reconcile = await queryJson(harnessState, `
    select pg_catalog.json_build_object(
      'applied', result_row.applied,
      'result_code', result_row.result_code,
      'plan_id', result_row.plan_id,
      'stripe_environment', result_row.stripe_environment,
      'subscription_replaced', result_row.subscription_replaced
    )
    from public.social_cues_reconcile_stripe_binding(
      ${quoteLiteral(workspaceId)}::uuid, 'test', ${quoteLiteral(customerId)},
      ${quoteLiteral(subscriptionId)}, 'price_B0LineEndingMatrixA123', 'business',
      'active', '2026-08-01'::timestamptz, '2026-09-01'::timestamptz,
      false, 1, 'evt_B0LineEndingMatrixReconcileA123'
    ) result_row;
  `, { database, role: "service_role" });
  const claim = await queryJson(harnessState, `
    select pg_catalog.json_build_object(
      'claimed', result_row.claimed,
      'duplicate', result_row.duplicate,
      'event_status', result_row.event_status,
      'event_attempts', result_row.event_attempts,
      'result_code', result_row.result_code
    )
    from public.social_cues_claim_stripe_webhook_event(
      ${quoteLiteral(workspaceId)}::uuid, 'test',
      'evt_B0LineEndingMatrixClaimA123', 'invoice.paid', 300
    ) result_row;
  `, { database, role: "service_role" });
  assert.deepEqual(reconcile, {
    applied: true,
    result_code: "created",
    plan_id: "business",
    stripe_environment: "test",
    subscription_replaced: false
  });
  assert.deepEqual(claim, {
    claimed: true,
    duplicate: false,
    event_status: "processing",
    event_attempts: 1,
    result_code: "claimed"
  });
  return { reconcile, claim };
}

async function runLineEndingMatrix(harnessState, variants, versionLabel) {
  const scenarios = [
    ["lf-to-lf", variants.lf, variants.lf],
    ["crlf-to-crlf", variants.crlf, variants.crlf],
    ["lf-to-crlf", variants.lf, variants.crlf],
    ["crlf-to-lf", variants.crlf, variants.lf],
    ["tracked-to-lf", variants.tracked, variants.lf],
    ["tracked-to-crlf", variants.tracked, variants.crlf],
    ["lone-cr-to-lone-cr", variants.loneCr, variants.loneCr]
  ];
  const results = [];
  for (const [label, firstPath, replayPath] of scenarios) {
    const database = await createDatabaseFor(harnessState, `${versionLabel}_${label}`);
    try {
      await applyMigrationFor(harnessState, database, { filePath: firstPath });
      const rpc = await exerciseMatrixRpcs(harnessState, database);
      const beforeReplay = await catalogSnapshot(harnessState, database);
      await applyMigrationFor(harnessState, database, { filePath: replayPath });
      const afterReplay = await catalogSnapshot(harnessState, database);
      assert.deepEqual(afterReplay, beforeReplay, `${versionLabel} ${label} replay changed protected state`);
      results.push({ label, snapshot: afterReplay, rpc });
    } finally {
      await dropDatabaseFor(harnessState, database);
    }
  }
  for (const result of results.slice(1)) {
    assert.deepEqual(result.snapshot, results[0].snapshot,
      `${versionLabel} ${result.label} catalog differs from LF`);
    assert.deepEqual(result.rpc, results[0].rpc,
      `${versionLabel} ${result.label} RPC behavior differs from LF`);
  }
  return {
    versionLabel,
    scenarios: results.map(result => result.label),
    reference: results[0].snapshot,
    rpc: results[0].rpc
  };
}

async function runMutationScenario(harnessState, variants, {
  label,
  mutationSql,
  replayPath = variants.lf,
  expectedMessage = "STRIPE_B0_FUNCTION_DEFINITION_CONFLICT"
}) {
  const database = await createDatabaseFor(harnessState, `mutation_${label}`);
  try {
    await applyMigrationFor(harnessState, database, { filePath: variants.lf });
    await psql(harnessState, mutationSql, { database });
    const beforeReplay = await catalogSnapshot(harnessState, database);
    const replay = await applyMigrationFor(harnessState, database, {
      filePath: replayPath,
      allowFailure: true
    });
    assert.notEqual(replay.code, 0, `${label} replay unexpectedly accepted the mutation`);
    assertFailureForState(harnessState, replay, expectedMessage);
    const afterReplay = await catalogSnapshot(harnessState, database);
    assert.deepEqual(afterReplay, beforeReplay, `${label} mismatch did not roll back atomically`);
    return label;
  } finally {
    await dropDatabaseFor(harnessState, database);
  }
}

async function runSemanticMutationMatrix(harnessState, variants) {
  const claimSignature = "public.social_cues_claim_stripe_webhook_event(uuid,text,text,text,integer)";
  const cases = [
    {
      label: "body-statement-lf",
      mutationSql: `
        create or replace function public.social_cues_enforce_stripe_binding_update()
        returns trigger language plpgsql set search_path = '' as $mutation$
        begin perform 1; return new; end;
        $mutation$;
      `,
      replayPath: variants.lf
    },
    {
      label: "return-behavior-crlf",
      mutationSql: `
        create or replace function public.social_cues_enforce_stripe_binding_update()
        returns trigger language plpgsql set search_path = '' as $mutation$
        begin return old; end;
        $mutation$;
      `,
      replayPath: variants.crlf
    },
    {
      label: "identity-signature",
      mutationSql: `
        create function public.social_cues_claim_stripe_webhook_event(uuid, text, text, text, bigint)
        returns integer language sql set search_path = '' as 'select 1';
      `,
      expectedMessage: "STRIPE_B0_FUNCTION_OVERLOAD_CONFLICT"
    },
    {
      label: "security-mode",
      mutationSql: `alter function ${claimSignature} security invoker;`
    },
    {
      label: "search-path",
      mutationSql: `alter function ${claimSignature} set search_path = public;`
    },
    {
      label: "volatility",
      mutationSql: `alter function ${claimSignature} stable;`
    },
    {
      label: "strictness",
      mutationSql: `alter function ${claimSignature} strict;`
    },
    {
      label: "execute-grant",
      mutationSql: `grant execute on function ${claimSignature} to authenticated;`
    },
    {
      label: "version-comment",
      mutationSql: `comment on function ${claimSignature} is 'social-cues:stripe-b0:v1:mutated';`
    },
    {
      label: "owner",
      mutationSql: `alter function ${claimSignature} owner to service_role;`
    }
  ];
  const rejected = [];
  for (const mutation of cases) {
    rejected.push(await runMutationScenario(harnessState, variants, mutation));
  }
  return rejected;
}

async function runMatrixInOwnState(image, versionLabel) {
  const matrixState = createHarnessState(`runtime-${versionLabel}`);
  let result = null;
  let primaryError = null;
  try {
    await prepareState(matrixState);
    await startPostgres(matrixState, { image });
    await initializeClusterFor(matrixState);
    const variants = await writeMigrationVariants(matrixState);
    result = await runLineEndingMatrix(matrixState, variants, versionLabel);
    await scanRuntimeSafety(matrixState);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await cleanupHarness(matrixState);
    } catch (cleanupError) {
      primaryError ??= cleanupError;
    }
  }
  if (primaryError) throw primaryError;
  assert.equal(matrixState.cleanupComplete, true);
  return { ...result, image, cleanupComplete: matrixState.cleanupComplete };
}

async function assertNoStripeObjects(database) {
  const stateJson = await queryJson(state, `
    select pg_catalog.json_build_object(
      'bindings', pg_catalog.to_regclass('public.stripe_billing_bindings') is not null,
      'checkout', pg_catalog.to_regclass('public.stripe_checkout_sessions') is not null,
      'reconcile', pg_catalog.to_regprocedure(
        'public.social_cues_reconcile_stripe_binding(uuid,text,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text)'
      ) is not null,
      'claim', pg_catalog.to_regprocedure(
        'public.social_cues_claim_stripe_webhook_event(uuid,text,text,text,integer)'
      ) is not null
    );
  `, { database });
  assert.deepEqual(stateJson, { bindings: false, checkout: false, reconcile: false, claim: false });
}

async function callReconcile(database, {
  workspaceId,
  environment = "test",
  customerId = customerA,
  subscriptionId = subscriptionA,
  priceId = "price_B0RuntimePriceA123",
  planId = "business",
  status = "active",
  periodStart = "2026-08-01T00:00:00Z",
  periodEnd = "2026-09-01T00:00:00Z",
  cancelAtPeriodEnd = false,
  eventCreated = 100,
  eventId = "evt_B0RuntimeEventA123"
}) {
  const result = await queryJson(state, `
    select pg_catalog.row_to_json(result_row)
    from public.social_cues_reconcile_stripe_binding(
      ${quoteLiteral(workspaceId)}::uuid,
      ${quoteLiteral(environment)},
      ${quoteLiteral(customerId)},
      ${quoteLiteral(subscriptionId)},
      ${quoteLiteral(priceId)},
      ${quoteLiteral(planId)},
      ${quoteLiteral(status)},
      ${quoteLiteral(periodStart)}::timestamptz,
      ${quoteLiteral(periodEnd)}::timestamptz,
      ${cancelAtPeriodEnd ? "true" : "false"},
      ${eventCreated},
      ${quoteLiteral(eventId)}
    ) result_row;
  `, { database, role: "service_role" });
  assert.deepEqual(Object.keys(result).sort(), [
    "applied",
    "binding_id",
    "cancel_at_period_end",
    "created_at",
    "current_period_end",
    "current_period_start",
    "plan_id",
    "result_code",
    "stripe_environment",
    "subscription_replaced",
    "subscription_status",
    "updated_at",
    "workspace_id"
  ]);
  return result;
}

async function callClaim(database, {
  workspaceId,
  environment = "test",
  eventId = "evt_B0RuntimeWebhook123",
  eventType = "invoice.paid",
  staleAfterSeconds = 300
}) {
  const result = await queryJson(state, `
    select pg_catalog.row_to_json(result_row)
    from public.social_cues_claim_stripe_webhook_event(
      ${quoteLiteral(workspaceId)}::uuid,
      ${quoteLiteral(environment)},
      ${quoteLiteral(eventId)},
      ${quoteLiteral(eventType)},
      ${staleAfterSeconds}
    ) result_row;
  `, { database, role: "service_role" });
  assert.deepEqual(Object.keys(result).sort(), [
    "claimed", "duplicate", "event_attempts", "event_status", "result_code"
  ]);
  return result;
}

async function proveFaultInjectedCleanup() {
  const faultState = createHarnessState("runtime-fault");
  let injected = false;
  try {
    await prepareState(faultState);
    await startPostgres(faultState, { image: POSTGRES_RUNTIME_IMAGE });
    throw new Error("EXPECTED_B0_FAULT_INJECTION");
  } catch (error) {
    assert.equal(error.message, "EXPECTED_B0_FAULT_INJECTION");
    injected = true;
  } finally {
    await cleanupHarness(faultState);
  }
  assert.equal(injected, true);
  assert.equal(faultState.cleanupComplete, true);
}

let migrationVariants = null;
let pg15Matrix = null;
let pg17Matrix = null;
let semanticMutations = [];
let primaryError = null;
try {
  await prepareState(state);
  await startPostgres(state, { image: POSTGRES_RUNTIME_IMAGE });
  await initializeCluster();

  await check("LF, CRLF, tracked, and lone-CR apply/replay matrix passes on PostgreSQL 15", async () => {
    migrationVariants = await writeMigrationVariants(state);
    pg15Matrix = await runLineEndingMatrix(state, migrationVariants, "pg15");
  });

  await check("semantic function mutations remain rejected and roll back atomically", async () => {
    semanticMutations = await runSemanticMutationMatrix(state, migrationVariants);
    assert.equal(semanticMutations.length, 10);
  });

  await check("LF, CRLF, tracked, and lone-CR apply/replay matrix passes on PostgreSQL 17", async () => {
    pg17Matrix = await runMatrixInOwnState(POSTGRES_POSTGREST_IMAGE, "pg17");
  });

  await check("PostgreSQL 15 and 17 protected fingerprints and RPC behavior agree", async () => {
    assert.deepEqual(pg17Matrix.reference, pg15Matrix.reference);
    assert.deepEqual(pg17Matrix.rpc, pg15Matrix.rpc);
  });

  await check("simultaneous first apply, replay, and exact definitions", async () => {
    const database = await createDatabase("concurrent_migration");
    const applications = await Promise.all([applyMigration(database), applyMigration(database)]);
    assert.deepEqual(applications.map(result => result.code), [0, 0]);
    await applyMigration(database);

    const catalog = await queryJson(state, `
      select pg_catalog.json_build_object(
        'tables', (
          select pg_catalog.count(*) from pg_catalog.pg_class relation_catalog
          join pg_catalog.pg_namespace namespace_catalog on namespace_catalog.oid = relation_catalog.relnamespace
          where namespace_catalog.nspname = 'public'
            and relation_catalog.relname in ('stripe_billing_bindings', 'stripe_checkout_sessions')
            and relation_catalog.relkind = 'r'
        ),
        'functions', (
          select pg_catalog.count(*) from pg_catalog.pg_proc function_catalog
          join pg_catalog.pg_namespace namespace_catalog on namespace_catalog.oid = function_catalog.pronamespace
          where namespace_catalog.nspname = 'public'
            and function_catalog.proname in (
              'social_cues_enforce_stripe_binding_update',
              'social_cues_enforce_stripe_checkout_identity',
              'social_cues_reconcile_stripe_binding',
              'social_cues_claim_stripe_webhook_event'
            )
        ),
        'triggers', (
          select pg_catalog.count(*) from pg_catalog.pg_trigger
          where not tgisinternal and tgname in (
            'enforce_stripe_billing_binding_update',
            'enforce_stripe_checkout_session_identity'
          )
        ),
        'policies', (
          select pg_catalog.count(*) from pg_catalog.pg_policy
          where polname in (
            'stripe_billing_bindings_deny_client_access',
            'stripe_checkout_sessions_deny_client_access'
          )
        ),
        'extension_columns', (
          select pg_catalog.count(*) from pg_catalog.pg_attribute
          where attrelid = 'public.webhook_events'::regclass
            and attname in ('environment', 'workspace_id', 'result_code', 'processing_result')
            and not attisdropped
        )
      );
    `, { database });
    assert.deepEqual(catalog, {
      tables: 2,
      functions: 4,
      triggers: 2,
      policies: 2,
      extension_columns: 4
    });
  });

  await check("compatible partial webhook extension upgrades safely", async () => {
    const database = await createDatabase("compatible_partial", `
      alter table public.webhook_events
        add column environment text,
        add column workspace_id uuid,
        add column result_code text,
        add column processing_result jsonb not null default '{}'::jsonb;
    `);
    await applyMigration(database);
    assert.equal(await queryScalar(state, `
      select pg_catalog.count(*) from pg_catalog.pg_constraint
      where conrelid = 'public.webhook_events'::regclass
        and conname in ('webhook_events_workspace_id_fkey', 'webhook_events_environment_check');
    `, { database }), "2");
  });

  await check("incompatible same-name table fails before mutation", async () => {
    const database = await createDatabase("bad_table", "create table public.stripe_billing_bindings (id text);");
    const result = await applyMigration(database, { allowFailure: true });
    assertFailure(result, "STRIPE_B0_BINDINGS_DEFINITION_CONFLICT");
    assert.equal(await queryScalar(state, `select pg_catalog.count(*) from pg_catalog.pg_attribute where attrelid = 'public.stripe_billing_bindings'::regclass and attnum > 0 and not attisdropped;`, { database }), "1");
    assert.equal(await queryScalar(state, "select pg_catalog.to_regclass('public.stripe_checkout_sessions') is null;", { database }), "t");
  });

  await check("incompatible same-name column fails atomically", async () => {
    const database = await createDatabase("bad_column", "alter table public.webhook_events add column environment integer;");
    const result = await applyMigration(database, { allowFailure: true });
    assertFailure(result, "STRIPE_B0_WEBHOOK_EXTENSION_CONFLICT");
    await assertNoStripeObjects(database);
    assert.equal(await queryScalar(state, `select pg_catalog.to_regtype(pg_catalog.format_type(atttypid, atttypmod))::text from pg_catalog.pg_attribute where attrelid = 'public.webhook_events'::regclass and attname = 'environment';`, { database }), "integer");
  });

  await check("incompatible same-name index fails atomically", async () => {
    const database = await createDatabase("bad_index", "create index webhook_events_provider_environment_received_idx on public.webhook_events(provider, received_at);");
    const result = await applyMigration(database, { allowFailure: true });
    assertFailure(result, "STRIPE_B0_WEBHOOK_INDEX_CONFLICT");
    await assertNoStripeObjects(database);
  });

  await check("incompatible same-signature function fails atomically", async () => {
    const database = await createDatabase("bad_function", `
      create function public.social_cues_claim_stripe_webhook_event(uuid, text, text, text, integer)
      returns integer language sql set search_path = '' as 'select 1';
    `);
    const result = await applyMigration(database, { allowFailure: true });
    assertFailure(result, "STRIPE_B0_FUNCTION_DEFINITION_CONFLICT");
    assert.equal(await queryScalar(state, "select pg_catalog.to_regclass('public.stripe_billing_bindings') is null and pg_catalog.to_regclass('public.stripe_checkout_sessions') is null;", { database }), "t");
    assert.equal(await queryScalar(state, "select public.social_cues_claim_stripe_webhook_event(null, null, null, null, null);", { database }), "1");
  });

  await check("incompatible trigger and policy are rejected on replay", async () => {
    const triggerDatabase = await createDatabase("bad_trigger");
    await applyMigration(triggerDatabase);
    await psql(state, `
      drop trigger enforce_stripe_billing_binding_update on public.stripe_billing_bindings;
      create trigger enforce_stripe_billing_binding_update
        before insert on public.stripe_billing_bindings
        for each row execute function public.social_cues_enforce_stripe_binding_update();
    `, { database: triggerDatabase });
    assertFailure(await applyMigration(triggerDatabase, { allowFailure: true }), "STRIPE_B0_BINDINGS_DEFINITION_CONFLICT");

    const policyDatabase = await createDatabase("bad_policy");
    await applyMigration(policyDatabase);
    await psql(state, `
      drop policy stripe_checkout_sessions_deny_client_access on public.stripe_checkout_sessions;
      create policy stripe_checkout_sessions_deny_client_access
        on public.stripe_checkout_sessions as restrictive for select to authenticated using (true);
    `, { database: policyDatabase });
    assertFailure(await applyMigration(policyDatabase, { allowFailure: true }), "STRIPE_B0_CHECKOUT_DEFINITION_CONFLICT");
  });

  await check("insecure webhook prerequisite RLS, grants, and policies fail before mutation", async () => {
    for (const [label, incompatibleSql] of [
      ["rls", "alter table public.webhook_events disable row level security;"],
      ["grant", "grant select on table public.webhook_events to authenticated;"],
      ["policy", `
        drop policy "webhook events are service role only" on public.webhook_events;
        create policy "webhook events allow authenticated reads"
          on public.webhook_events for select to authenticated using (true);
      `]
    ]) {
      const database = await createDatabase(`bad_webhook_security_${label}`, incompatibleSql);
      const result = await applyMigration(database, { allowFailure: true });
      assertFailure(result, "STRIPE_B0_WEBHOOK_SECURITY_PREREQUISITE_CONFLICT");
      await assertNoStripeObjects(database);
      assert.equal(await queryScalar(state, `
        select not exists (
          select 1 from pg_catalog.pg_attribute
          where attrelid = 'public.webhook_events'::regclass
            and attname = 'environment'
            and not attisdropped
        );
      `, { database }), "t");
    }
  });

  await check("late foreign-key failure rolls back every earlier mutation", async () => {
    const orphanWorkspace = randomUUID();
    const database = await createDatabase("late_rollback", `
      alter table public.webhook_events add column workspace_id uuid;
      insert into public.webhook_events(provider, event_id, workspace_id)
      values ('fixture', 'orphan-event', ${quoteLiteral(orphanWorkspace)}::uuid);
    `);
    const result = await applyMigration(database, { allowFailure: true });
    assert.notEqual(result.code, 0);
    assert.match(combinedOutput(result), /foreign key constraint|is not present in table "workspaces"/iu);
    await assertNoStripeObjects(database);
    const rolledBack = await queryJson(state, `
      select pg_catalog.json_build_object(
        'environment', exists(select 1 from pg_catalog.pg_attribute where attrelid = 'public.webhook_events'::regclass and attname = 'environment' and not attisdropped),
        'result_code', exists(select 1 from pg_catalog.pg_attribute where attrelid = 'public.webhook_events'::regclass and attname = 'result_code' and not attisdropped),
        'processing_result', exists(select 1 from pg_catalog.pg_attribute where attrelid = 'public.webhook_events'::regclass and attname = 'processing_result' and not attisdropped),
        'workspace_preserved', exists(select 1 from pg_catalog.pg_attribute where attrelid = 'public.webhook_events'::regclass and attname = 'workspace_id' and not attisdropped)
      );
    `, { database });
    assert.deepEqual(rolledBack, {
      environment: false,
      result_code: false,
      processing_result: false,
      workspace_preserved: true
    });
  });

  await check("workspace, customer, plan, environment, and role boundaries", async () => {
    const database = await createDatabase("behavior");
    await applyMigration(database);
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const workspaceC = randomUUID();
    await psql(state, `insert into public.workspaces(id) values (${quoteLiteral(workspaceA)}), (${quoteLiteral(workspaceB)}), (${quoteLiteral(workspaceC)});`, { database });

    const created = await callReconcile(database, { workspaceId: workspaceA });
    assert.equal(created.applied, true);
    assert.equal(created.result_code, "created");
    const replayed = await callReconcile(database, { workspaceId: workspaceA });
    assert.equal(replayed.applied, false);
    assert.equal(replayed.result_code, "replayed_or_stale");

    const customerChange = await psql(state, `
      select * from public.social_cues_reconcile_stripe_binding(
        ${quoteLiteral(workspaceA)}::uuid, 'test', ${quoteLiteral(customerB)}, ${quoteLiteral(subscriptionA)},
        'price_B0RuntimePriceA123', 'business', 'active', '2026-08-01'::timestamptz,
        '2026-09-01'::timestamptz, false, 101, 'evt_B0RuntimeCustomerChange123'
      );
    `, { database, role: "service_role", allowFailure: true });
    assertFailure(customerChange, "STRIPE_B0_CUSTOMER_CHANGE_REJECTED");

    const crossWorkspaceCustomer = await psql(state, `
      select * from public.social_cues_reconcile_stripe_binding(
        ${quoteLiteral(workspaceB)}::uuid, 'test', ${quoteLiteral(customerA)}, ${quoteLiteral(subscriptionB)},
        'price_B0RuntimePriceB456', 'growth', 'active', '2026-08-01'::timestamptz,
        '2026-09-01'::timestamptz, false, 102, 'evt_B0RuntimeCrossWorkspace123'
      );
    `, { database, role: "service_role", allowFailure: true });
    assertFailure(crossWorkspaceCustomer, "STRIPE_B0_CUSTOMER_ALREADY_BOUND");

    const liveBinding = await callReconcile(database, {
      workspaceId: workspaceB,
      environment: "live",
      customerId: customerA,
      subscriptionId: subscriptionB,
      priceId: "price_B0RuntimePriceB456",
      planId: "growth",
      eventCreated: 103,
      eventId: "evt_B0RuntimeLive123"
    });
    assert.equal(liveBinding.stripe_environment, "live");

    for (const [fragment, expected] of [
      ["'preview'", "STRIPE_B0_RECONCILIATION_INPUT_INVALID"],
      ["'enterprise'", "STRIPE_B0_SUBSCRIPTION_STATE_INVALID"]
    ]) {
      const invalid = fragment === "'preview'"
        ? await psql(state, `select * from public.social_cues_reconcile_stripe_binding(${quoteLiteral(workspaceC)}::uuid, ${fragment}, ${quoteLiteral(customerB)}, ${quoteLiteral(subscriptionC)}, 'price_B0RuntimePriceC789', 'agency', 'active', '2026-08-01'::timestamptz, '2026-09-01'::timestamptz, false, 104, 'evt_B0RuntimeInvalidEnv123');`, { database, role: "service_role", allowFailure: true })
        : await psql(state, `select * from public.social_cues_reconcile_stripe_binding(${quoteLiteral(workspaceC)}::uuid, 'test', ${quoteLiteral(customerB)}, ${quoteLiteral(subscriptionC)}, 'price_B0RuntimePriceC789', ${fragment}, 'active', '2026-08-01'::timestamptz, '2026-09-01'::timestamptz, false, 105, 'evt_B0RuntimeInvalidPlan123');`, { database, role: "service_role", allowFailure: true });
      assertFailure(invalid, expected);
    }

    const optionalPeriods = await callReconcile(database, {
      workspaceId: workspaceC,
      customerId: customerB,
      subscriptionId: subscriptionC,
      priceId: "price_B0RuntimePriceC789",
      planId: "agency",
      periodStart: null,
      periodEnd: null,
      eventCreated: 106,
      eventId: "evt_B0RuntimeOptionalPeriods123"
    });
    assert.equal(optionalPeriods.current_period_start, null);
    assert.equal(optionalPeriods.current_period_end, null);

    for (const role of ["anon", "authenticated"]) {
      const directRead = await psql(state, "select pg_catalog.count(*) from public.stripe_billing_bindings;", { database, role, allowFailure: true });
      assertFailure(directRead, "permission denied for table stripe_billing_bindings");
      const directWrite = await psql(state, `insert into public.stripe_checkout_sessions(workspace_id, stripe_environment, idempotency_key, requested_plan_id) values (${quoteLiteral(workspaceA)}::uuid, 'test', 'runtime-client-key-0001', 'business');`, { database, role, allowFailure: true });
      assertFailure(directWrite, "permission denied for table stripe_checkout_sessions");
    }
    assert.equal(await queryScalar(state, "select pg_catalog.count(*) >= 1 from public.stripe_billing_bindings;", { database, role: "service_role" }), "t");

    const deniedDelete = await psql(state, "delete from public.stripe_checkout_sessions;", { database, role: "service_role", allowFailure: true });
    assertFailure(deniedDelete, "permission denied for table stripe_checkout_sessions");

    const unauthorizedRpc = await psql(state, `select * from public.social_cues_claim_stripe_webhook_event(${quoteLiteral(workspaceA)}::uuid, 'test', 'evt_B0RuntimeDenied123', 'invoice.paid', 300);`, { database, role: "authenticated", allowFailure: true });
    assertFailure(unauthorizedRpc, "permission denied for function social_cues_claim_stripe_webhook_event");

    const contradictoryRole = await psql(state, `
      select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
      select * from public.social_cues_claim_stripe_webhook_event(
        ${quoteLiteral(workspaceA)}::uuid,
        'test',
        'evt_B0RuntimeContradictoryRole123',
        'invoice.paid',
        300
      );
    `, { database, role: "service_role", allowFailure: true });
    assertFailure(contradictoryRole, "STRIPE_B0_SERVICE_ROLE_REQUIRED");
  });

  await check("subscription replacement, cancellation, and resubscription", async () => {
    const database = await createDatabase("subscription_lifecycle");
    await applyMigration(database);
    const workspace = randomUUID();
    await psql(state, `insert into public.workspaces(id) values (${quoteLiteral(workspace)});`, { database });
    await callReconcile(database, { workspaceId: workspace, eventCreated: 200, eventId: "evt_B0RuntimeLifecycleA123" });
    const replaced = await callReconcile(database, {
      workspaceId: workspace,
      subscriptionId: subscriptionB,
      priceId: "price_B0RuntimePriceB456",
      planId: "growth",
      eventCreated: 201,
      eventId: "evt_B0RuntimeLifecycleB456"
    });
    assert.equal(replaced.subscription_replaced, true);
    assert.equal(replaced.result_code, "current_subscription_replaced");

    const canceled = await callReconcile(database, {
      workspaceId: workspace,
      subscriptionId: null,
      priceId: null,
      planId: null,
      status: "canceled",
      periodStart: null,
      periodEnd: null,
      eventCreated: 202,
      eventId: "evt_B0RuntimeLifecycleCancel789"
    });
    assert.equal(canceled.result_code, "current_subscription_cleared");

    const resubscribed = await callReconcile(database, {
      workspaceId: workspace,
      subscriptionId: subscriptionC,
      priceId: "price_B0RuntimePriceC789",
      planId: "agency",
      eventCreated: 203,
      eventId: "evt_B0RuntimeLifecycleC789"
    });
    assert.equal(resubscribed.subscription_replaced, true);
    assert.equal(resubscribed.result_code, "current_subscription_replaced");
    assert.equal(await queryScalar(state, `select stripe_subscription_id = ${quoteLiteral(subscriptionC)} and plan_id = 'agency' from public.stripe_billing_bindings where workspace_id = ${quoteLiteral(workspace)}::uuid and stripe_environment = 'test';`, { database }), "t");
  });

  await check("reconciliation and checkout writes serialize without unique errors", async () => {
    const database = await createDatabase("write_concurrency");
    await applyMigration(database);
    const workspaceFirst = randomUUID();
    const workspaceCheckout = randomUUID();
    await psql(state, `insert into public.workspaces(id) values (${quoteLiteral(workspaceFirst)}), (${quoteLiteral(workspaceCheckout)});`, { database });

    const firstCalls = await Promise.all([
      callReconcile(database, { workspaceId: workspaceFirst, eventCreated: 300, eventId: "evt_B0RuntimeConcurrentFirst123" }),
      callReconcile(database, { workspaceId: workspaceFirst, eventCreated: 300, eventId: "evt_B0RuntimeConcurrentFirst123" })
    ]);
    assert.deepEqual(firstCalls.map(result => result.result_code).sort(), ["created", "replayed_or_stale"]);
    assert.deepEqual(firstCalls.map(result => result.applied).sort(), [false, true]);

    const checkoutSql = `
      insert into public.stripe_checkout_sessions(
        workspace_id, stripe_environment, idempotency_key,
        requested_plan_id, lifecycle_status, result_code, safe_result
      ) values (
        ${quoteLiteral(workspaceCheckout)}::uuid, 'test',
        'runtime-idempotency-key-00000001', 'growth', 'reserved', 'fixture_reserved',
        '{"outcome":"reserved"}'::jsonb
      )
      on conflict (workspace_id, stripe_environment, idempotency_key)
      do update set updated_at = public.stripe_checkout_sessions.updated_at
      returning 1;
    `;
    const checkoutWrites = await Promise.all([
      psql(state, checkoutSql, { database, role: "service_role" }),
      psql(state, checkoutSql, { database, role: "service_role" })
    ]);
    assert.deepEqual(checkoutWrites.map(result => result.code), [0, 0]);
    assert.equal(await queryScalar(state, `select pg_catalog.count(*) from public.stripe_checkout_sessions where workspace_id = ${quoteLiteral(workspaceCheckout)}::uuid and stripe_environment = 'test' and idempotency_key = 'runtime-idempotency-key-00000001';`, { database, role: "service_role" }), "1");
    await psql(state, `
      update public.stripe_checkout_sessions
      set stripe_session_id = ${quoteLiteral(checkoutSession)},
          lifecycle_status = 'created',
          result_code = 'fixture_created',
          safe_result = '{"outcome":"created"}'::jsonb,
          updated_at = pg_catalog.now()
      where workspace_id = ${quoteLiteral(workspaceCheckout)}::uuid
        and stripe_environment = 'test'
        and idempotency_key = 'runtime-idempotency-key-00000001';
    `, { database, role: "service_role" });
    assert.equal(await queryScalar(state, `select stripe_session_id = ${quoteLiteral(checkoutSession)} from public.stripe_checkout_sessions where workspace_id = ${quoteLiteral(workspaceCheckout)}::uuid and stripe_environment = 'test' and idempotency_key = 'runtime-idempotency-key-00000001';`, { database, role: "service_role" }), "t");

    const sessionReplacement = await psql(state, `
      update public.stripe_checkout_sessions
      set stripe_session_id = ${quoteLiteral(checkoutSessionReplacement)}
      where workspace_id = ${quoteLiteral(workspaceCheckout)}::uuid
        and stripe_environment = 'test'
        and idempotency_key = 'runtime-idempotency-key-00000001';
    `, { database, role: "service_role", allowFailure: true });
    assertFailure(sessionReplacement, "STRIPE_B0_IMMUTABLE_CHECKOUT_IDENTITY_CONFLICT");

    const unsafeCheckoutResult = await psql(state, `
      update public.stripe_checkout_sessions
      set safe_result = ${quoteLiteral(JSON.stringify({ nested: { authorization: stripeSecretCanary } }))}::jsonb
      where workspace_id = ${quoteLiteral(workspaceCheckout)}::uuid
        and stripe_environment = 'test'
        and idempotency_key = 'runtime-idempotency-key-00000001';
    `, { database, role: "service_role", allowFailure: true });
    assertFailure(unsafeCheckoutResult, "STRIPE_B0_CHECKOUT_SAFE_RESULT_INVALID");
    assert.equal(await queryScalar(state, `
      select stripe_session_id = ${quoteLiteral(checkoutSession)}
        and safe_result = '{"outcome":"created"}'::jsonb
      from public.stripe_checkout_sessions
      where workspace_id = ${quoteLiteral(workspaceCheckout)}::uuid
        and stripe_environment = 'test'
        and idempotency_key = 'runtime-idempotency-key-00000001';
    `, { database, role: "service_role" }), "t");

    const deleteHistory = await psql(state, `
      delete from public.stripe_checkout_sessions
      where workspace_id = ${quoteLiteral(workspaceCheckout)}::uuid;
    `, { database, role: "service_role", allowFailure: true });
    assertFailure(deleteHistory, "permission denied for table stripe_checkout_sessions");
  });

  await check("webhook claims are replay-safe and concurrent", async () => {
    const database = await createDatabase("webhook_claims");
    await applyMigration(database);
    const workspace = randomUUID();
    await psql(state, `insert into public.workspaces(id) values (${quoteLiteral(workspace)});`, { database });

    const first = await callClaim(database, { workspaceId: workspace });
    assert.deepEqual(first, {
      claimed: true,
      duplicate: false,
      event_status: "processing",
      event_attempts: 1,
      result_code: "claimed"
    });
    const replay = await callClaim(database, { workspaceId: workspace });
    assert.equal(replay.claimed, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.result_code, "already_claimed");

    const mismatchedType = await psql(state, `
      select * from public.social_cues_claim_stripe_webhook_event(
        ${quoteLiteral(workspace)}::uuid,
        'test',
        'evt_B0RuntimeWebhook123',
        'invoice.payment_failed',
        300
      );
    `, { database, role: "service_role", allowFailure: true });
    assertFailure(mismatchedType, "STRIPE_B0_WEBHOOK_CLAIM_CONFLICT");

    const unsafeProcessingResult = await psql(state, `
      update public.webhook_events
      set processing_result = ${quoteLiteral(JSON.stringify({ nested: { raw_payload: rawEnvelopeCanary } }))}::jsonb
      where provider = 'stripe'
        and event_id = 'test:evt_B0RuntimeWebhook123';
    `, { database, allowFailure: true });
    assertFailure(unsafeProcessingResult, "webhook_events_processing_result_safe_check");
    assert.equal(await queryScalar(state, `
      select processing_result = '{}'::jsonb
      from public.webhook_events
      where provider = 'stripe'
        and event_id = 'test:evt_B0RuntimeWebhook123';
    `, { database }), "t");

    await psql(state, `update public.webhook_events set status = 'complete', processed_at = pg_catalog.now(), result_code = 'processed' where provider = 'stripe' and event_id = 'test:evt_B0RuntimeWebhook123';`, { database });
    const completeReplay = await callClaim(database, { workspaceId: workspace });
    assert.equal(completeReplay.result_code, "already_complete");

    const concurrent = await Promise.all([
      callClaim(database, { workspaceId: workspace, eventId: "evt_B0RuntimeConcurrentWebhook456" }),
      callClaim(database, { workspaceId: workspace, eventId: "evt_B0RuntimeConcurrentWebhook456" })
    ]);
    assert.deepEqual(concurrent.map(result => result.result_code).sort(), ["already_claimed", "claimed"]);
    assert.equal(await queryScalar(state, "select pg_catalog.count(*) from public.webhook_events where provider = 'stripe' and event_id = 'test:evt_B0RuntimeConcurrentWebhook456';", { database }), "1");
  });

  await check("competing subscription events converge on the newest event", async () => {
    const database = await createDatabase("subscription_concurrency");
    await applyMigration(database);
    const workspace = randomUUID();
    await psql(state, `insert into public.workspaces(id) values (${quoteLiteral(workspace)});`, { database });
    await callReconcile(database, { workspaceId: workspace, eventCreated: 400, eventId: "evt_B0RuntimeConcurrentBase123" });

    const updates = await Promise.all([
      callReconcile(database, {
        workspaceId: workspace,
        subscriptionId: subscriptionB,
        priceId: "price_B0RuntimePriceB456",
        planId: "growth",
        eventCreated: 401,
        eventId: "evt_B0RuntimeConcurrentLow456"
      }),
      callReconcile(database, {
        workspaceId: workspace,
        subscriptionId: subscriptionC,
        priceId: "price_B0RuntimePriceC789",
        planId: "agency",
        eventCreated: 402,
        eventId: "evt_B0RuntimeConcurrentHigh789"
      })
    ]);
    assert.equal(updates[1].applied, true, "newest event must always be authoritative");
    assert.ok([true, false].includes(updates[0].applied));
    assert.equal(await queryScalar(state, `select latest_event_created = 402 and stripe_subscription_id = ${quoteLiteral(subscriptionC)} from public.stripe_billing_bindings where workspace_id = ${quoteLiteral(workspace)}::uuid;`, { database }), "t");
  });

  await check("failed transaction can be retried safely", async () => {
    const database = await createDatabase("retry");
    await applyMigration(database);
    const workspace = randomUUID();
    await psql(state, `insert into public.workspaces(id) values (${quoteLiteral(workspace)});`, { database });
    const failed = await psql(state, `select * from public.social_cues_reconcile_stripe_binding(${quoteLiteral(workspace)}::uuid, 'test', 'invalid-customer', ${quoteLiteral(subscriptionA)}, 'price_B0RuntimePriceA123', 'business', 'active', '2026-08-01'::timestamptz, '2026-09-01'::timestamptz, false, 500, 'evt_B0RuntimeRetryBad123');`, { database, role: "service_role", allowFailure: true });
    assertFailure(failed, "STRIPE_B0_RECONCILIATION_INPUT_INVALID");
    const retried = await callReconcile(database, { workspaceId: workspace, eventCreated: 501, eventId: "evt_B0RuntimeRetryGood456" });
    assert.equal(retried.result_code, "created");
    assert.equal(await queryScalar(state, `select pg_catalog.count(*) from public.stripe_billing_bindings where workspace_id = ${quoteLiteral(workspace)}::uuid;`, { database, role: "service_role" }), "1");
  });

  await check("runtime logs and captured output exclude sensitive canaries", async () => {
    await scanRuntimeSafety(state);
    assert.equal(externalRequests, 0);
  });

  await check("fault-injected harness cleanup verifies explicit absence", proveFaultInjectedCleanup);
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
  suite: "stripe-billing-database-runtime",
  passed: passed.length,
  checks: passed,
  postgresImage: POSTGRES_RUNTIME_IMAGE,
  crossVersionImage: POSTGRES_POSTGREST_IMAGE,
  lineEndingScenarios: pg15Matrix.scenarios,
  pg15FunctionFingerprints: pg15Matrix.reference.functions,
  pg17FunctionFingerprints: pg17Matrix.reference.functions,
  semanticMutations,
  crossVersionEquivalent: true,
  network: "none",
  persistentVolumes: 0,
  externalRequests,
  cleanupComplete: state.cleanupComplete
}));
