import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("./SUPABASE-STRIPE-BILLING-LIFECYCLE.sql", import.meta.url);
const testUrl = new URL("./stripe-billing-database.contract.test.mjs", import.meta.url);
const packageUrl = new URL("./package.json", import.meta.url);
const [sql, testSource, packageSource] = await Promise.all([
  readFile(migrationUrl, "utf8"),
  readFile(testUrl, "utf8"),
  readFile(packageUrl, "utf8")
]);

let externalRequests = 0;
globalThis.fetch = async () => {
  externalRequests += 1;
  throw new Error("External requests are forbidden in the Stripe B0 static contract.");
};

function withoutComments(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*--.*$/gmu, "");
}

function normalize(value) {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function canonicalizeLineEndings(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

const source = withoutComments(sql);
const normalized = normalize(source);
const categories = [];
let assertions = 0;

function expect(condition, message) {
  assertions += 1;
  assert.ok(condition, message);
}

function expectMatch(value, expression, message) {
  assertions += 1;
  assert.match(value, expression, message);
}

function expectNoMatch(value, expression, message) {
  assertions += 1;
  assert.doesNotMatch(value, expression, message);
}

function check(name, fn) {
  fn();
  categories.push(name);
}

check("encompassing transaction and stable migration lock", () => {
  expectMatch(source, /^\s*begin\s*;/u, "migration must begin explicitly");
  expectMatch(source, /commit\s*;\s*$/u, "migration must commit explicitly");
  expectMatch(source, /pg_catalog\.pg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtextextended\s*\(\s*'social-cues:stripe-b0:v1:migration'/u, "stable transaction migration lock missing");
  expectMatch(source, /set local lock_timeout\s*=\s*'5s'/u, "lock timeout missing");
  expectMatch(source, /set local statement_timeout\s*=\s*'60s'/u, "statement timeout missing");
  expectNoMatch(source, /\bcommit\s*;[\s\S]+\bcommit\s*;/u, "migration contains more than one commit");
});

check("non-destructive additive migration", () => {
  expectNoMatch(source, /\bcascade\b/iu, "CASCADE is forbidden");
  expectNoMatch(source, /\bdrop\s+(?:table|schema|column|constraint|policy|trigger|function|index)\b/iu, "destructive persistent DDL is forbidden");
  expectNoMatch(source, /\btruncate\b|\bdelete\s+from\b/iu, "migration must not delete application data");
  expectNoMatch(source, /\balter\s+table\s+public\.(?:workspaces|billing_entitlements|audit_logs)\b/iu, "unrelated application tables must not be altered");
});

check("catalog-verified same-name objects", () => {
  const preflightEnd = normalized.indexOf("$preflight$;");
  const firstPersistentCreate = normalized.indexOf("create table if not exists public.stripe_billing_bindings");
  const functionFingerprint = source.match(
    /create or replace function pg_temp\.social_cues_b0_function_fingerprint[\s\S]*?\$fingerprint\$;/u
  )?.[0] || "";
  expect(preflightEnd > 0 && preflightEnd < firstPersistentCreate, "preflight must finish before persistent Stripe DDL");
  expectMatch(source, /social_cues_b0_relation_fingerprint[\s\S]*pg_catalog\.pg_get_constraintdef[\s\S]*pg_catalog\.pg_get_indexdef[\s\S]*pg_catalog\.pg_get_triggerdef[\s\S]*pg_catalog\.pg_policy[\s\S]*pg_catalog\.aclexplode/u, "relation fingerprint must include constraints, indexes, triggers, policies, and ACLs");
  expectMatch(source, /acl_entry\.grantee <> relation_catalog\.relowner/u, "version-specific implicit owner ACLs must not destabilize relation fingerprints");
  expectMatch(functionFingerprint, /pg_get_function_identity_arguments[\s\S]*pg_get_function_result[\s\S]*language_catalog\.lanname[\s\S]*owner_role\.rolname[\s\S]*function_catalog\.provolatile[\s\S]*function_catalog\.proparallel[\s\S]*function_catalog\.proisstrict[\s\S]*function_catalog\.prosecdef[\s\S]*function_catalog\.proleakproof[\s\S]*function_catalog\.proconfig[\s\S]*function_catalog\.prosrc[\s\S]*obj_description[\s\S]*aclexplode/u, "function fingerprint must preserve signature, language, ownership, security, settings, body, marker, and ACL coverage");
  expectMatch(source, /STRIPE_B0_(?:BINDINGS|CHECKOUT|FUNCTION|WEBHOOK)_[A-Z_]*CONFLICT/u, "sanitized compatibility failures missing");
  expectMatch(source, /owner_role\.rolname = 'postgres'[\s\S]*relation_catalog\.relrowsecurity/u, "webhook prerequisite owner and RLS validation missing");
  expectMatch(source, /pg_catalog\.aclexplode\([\s\S]*acl_entry\.grantee = 0[\s\S]*grantee_role\.rolname in \('anon', 'authenticated'\)/u, "webhook prerequisite client-grant validation missing");
  expectMatch(source, /policy_catalog\.polname = 'webhook events are service role only'[\s\S]*policy_catalog\.polcmd = '\*'[\s\S]*array\['anon'::name, 'authenticated'::name\][\s\S]*= 'false'[\s\S]*= 'false'/u, "webhook prerequisite deny-policy validation missing");
  expectMatch(source, /STRIPE_B0_WEBHOOK_SECURITY_PREREQUISITE_CONFLICT/u, "webhook prerequisite security conflict must be sanitized");
  expectMatch(source, /social-cues:stripe-b0:v1/u, "version ownership marker missing");
  expectNoMatch(source, /__STRIPE_[A-Z_]+__/u, "unresolved fingerprint placeholder remains");
  expectMatch(source, /do \$postflight\$[\s\S]*social_cues_b0_relation_fingerprint[\s\S]*social_cues_b0_function_fingerprint/u, "postflight verification missing");
});

check("narrow function body line-ending canonicalization", () => {
  const functionFingerprint = source.match(
    /create or replace function pg_temp\.social_cues_b0_function_fingerprint[\s\S]*?\$fingerprint\$;/u
  )?.[0] || "";
  const relationFingerprint = source.match(
    /create or replace function pg_temp\.social_cues_b0_relation_fingerprint[\s\S]*?\$fingerprint\$;/u
  )?.[0] || "";

  expectMatch(
    functionFingerprint,
    /pg_catalog\.md5\(\s*pg_catalog\.replace\(\s*pg_catalog\.replace\(\s*function_catalog\.prosrc,\s*E'\\r\\n',\s*E'\\n'\s*\),\s*E'\\r',\s*E'\\n'\s*\)\s*\)/u,
    "function body fingerprint must canonicalize CRLF first and remaining CR second"
  );
  expectNoMatch(functionFingerprint, /regexp_replace\s*\(\s*function_catalog\.prosrc/iu, "function bodies must not use broad regular-expression normalization");
  expectNoMatch(functionFingerprint, /replace\s*\(\s*function_catalog\.prosrc,\s*E?'(?:\\s|\[\[:space:\]\])'/iu, "function bodies must not collapse general whitespace");
  expectNoMatch(relationFingerprint, /function_catalog\.prosrc|E'\\r\\n'|E'\\r'/u, "relation fingerprints must remain outside function-body line-ending normalization");

  assert.equal(canonicalizeLineEndings("alpha\r\nbeta\rgamma\n"), "alpha\nbeta\ngamma\n");
  assert.equal(canonicalizeLineEndings("  alpha\t \r\n-- comment  \r\n"), "  alpha\t \n-- comment  \n");
  assert.notEqual(canonicalizeLineEndings("begin\n  return new;\nend;"), canonicalizeLineEndings("begin\n  return old;\nend;"));
  assert.notEqual(canonicalizeLineEndings("a  b\n"), canonicalizeLineEndings("a b\n"));
  assertions += 4;

  for (const functionName of [
    "social_cues_enforce_stripe_binding_update",
    "social_cues_enforce_stripe_checkout_identity",
    "social_cues_reconcile_stripe_binding",
    "social_cues_claim_stripe_webhook_event"
  ]) {
    const definitionStart = sql.indexOf(`create or replace function public.${functionName}`);
    const bodyStart = sql.indexOf("as $function$", definitionStart) + "as $function$".length;
    const bodyEnd = sql.indexOf("$function$;", bodyStart);
    expect(definitionStart >= 0 && bodyStart >= "as $function$".length && bodyEnd > bodyStart, `${functionName} body could not be isolated`);
    const bodyWithoutCrLfSeparators = sql.slice(bodyStart, bodyEnd).replaceAll("\r\n", "\n");
    expectNoMatch(bodyWithoutCrLfSeparators, /\r/u, `${functionName} contains an intentional or lone carriage return`);
  }
});

check("workspace and environment customer identity", () => {
  expectMatch(source, /unique\s*\(workspace_id,\s*stripe_environment\)/u, "one binding per workspace/environment missing");
  expectMatch(source, /unique\s*\(stripe_environment,\s*stripe_customer_id\)/u, "customer environment uniqueness missing");
  expectMatch(source, /check\s*\(stripe_environment in \('test', 'live'\)\)/u, "test/live constraint missing");
  expectMatch(source, /foreign key\s*\(workspace_id\) references public\.workspaces\(id\) on delete restrict/u, "workspace binding must not cascade-delete");
  expectMatch(source, /new\.workspace_id is distinct from old\.workspace_id[\s\S]*new\.stripe_environment is distinct from old\.stripe_environment[\s\S]*new\.stripe_customer_id is distinct from old\.stripe_customer_id/u, "durable identity trigger missing");
});

check("mutable current subscription and resubscription", () => {
  const triggerBody = source.match(/create or replace function public\.social_cues_enforce_stripe_binding_update\(\)[\s\S]*?\$function\$([\s\S]*?)\$function\$;/u)?.[1] || "";
  expectNoMatch(triggerBody, /stripe_subscription_id[^;]*immutable/iu, "subscription identity must not be permanently immutable");
  expectMatch(triggerBody, /social_cues\.stripe_reconcile/u, "lifecycle updates must be RPC-confined");
  expectMatch(triggerBody, /current_user <> 'postgres'/u, "lifecycle marker must also require the trusted definer role");
  expectMatch(source, /set stripe_subscription_id = p_stripe_subscription_id,[\s\S]*stripe_price_id = p_stripe_price_id,[\s\S]*plan_id = p_plan_id/u, "reconciliation must replace current subscription state");
  expectMatch(source, /v_subscription_replaced := v_binding\.stripe_subscription_id is distinct from p_stripe_subscription_id/u, "replacement evidence missing");
  expectMatch(source, /when v_terminal then 'current_subscription_cleared'[\s\S]*when v_subscription_replaced then 'current_subscription_replaced'/u, "terminal and replacement results missing");
  expectMatch(source, /p_plan_id not in \('business', 'growth', 'agency'\)/u, "canonical plan validation missing");
  expectMatch(source, /\(p_current_period_start is null\) <> \(p_current_period_end is null\)/u, "optional period boundaries must remain paired");
  expectNoMatch(source, /billing_entitlements/u, "B0 must defer entitlement mutation");
});

check("checkout idempotency storage only", () => {
  expectMatch(source, /create table if not exists public\.stripe_checkout_sessions/u, "checkout ledger missing");
  expectMatch(source, /unique\s*\(workspace_id,\s*stripe_environment,\s*idempotency_key\)/u, "workspace/environment idempotency missing");
  expectMatch(source, /requested_plan_id in \('business', 'growth', 'agency'\)/u, "checkout plan allowlist missing");
  expectMatch(source, /stripe_checkout_sessions_safe_result_check[\s\S]*jsonb_path_exists\([\s\S]*\$\.\*\*[\s\S]*@\.type\(\) == "object"[\s\S]*\.keyvalue\(\)[\s\S]*secret\|token[\s\S]*payload[\s\S]*customer\.\?id/u, "recursive safe-result denylist missing");
  expectMatch(source, /social_cues_enforce_stripe_checkout_identity\(\)[\s\S]*STRIPE_B0_CHECKOUT_SESSION_ID_INVALID[\s\S]*STRIPE_B0_CHECKOUT_RESULT_CODE_INVALID[\s\S]*STRIPE_B0_CHECKOUT_SAFE_RESULT_INVALID/u, "checkout trigger must reject sensitive invalid rows with sanitized errors");
  expectMatch(source, /create trigger enforce_stripe_checkout_session_identity\s+before insert or update on public\.stripe_checkout_sessions/u, "checkout safety trigger must cover inserts and updates");
  expectMatch(source, /old\.stripe_session_id is not null[\s\S]*new\.stripe_session_id is distinct from old\.stripe_session_id/u, "checkout session identity must become immutable after first binding");
  expectNoMatch(source, /checkout\.stripe\.com|api\.stripe\.com|billing\.stripe\.com/iu, "migration must not call or reference Stripe APIs");
});

check("webhook claim idempotency and explicit environment", () => {
  expectMatch(source, /add column if not exists environment text,[\s\S]*workspace_id uuid,[\s\S]*result_code text,[\s\S]*processing_result jsonb/u, "webhook extension incomplete");
  expectMatch(source, /v_ledger_event_id := p_stripe_environment \|\| ':' \|\| p_event_id/u, "event identity must be environment-separated");
  expectMatch(source, /event_row\.provider = 'stripe'/u, "webhook provider must be canonical stripe");
  expectMatch(
    source,
    /pg_catalog\.pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\(\s*'social-cues:stripe-webhook:'\s*\|\|\s*p_stripe_environment\s*\|\|\s*':'\s*\|\|\s*p_event_id,\s*0\s*\)\s*\)/u,
    "webhook claim serialization missing"
  );
  expectMatch(source, /'already_complete'::text[\s\S]*'already_claimed'::text[\s\S]*'reclaimed'::text/u, "claim replay states incomplete");
  expectMatch(source, /v_event\.event_type is distinct from p_event_type/u, "event replay must preserve event-type identity");
  expectMatch(source, /webhook_events_processing_result_safe_check[\s\S]*jsonb_path_exists\([\s\S]*processing_result/u, "Stripe processing-result safety constraint missing");
  expectMatch(source, /webhook_events_result_code_safe_check[\s\S]*pg_catalog\.length\(result_code\) between 1 and 80/u, "Stripe result-code safety constraint missing");
  expectNoMatch(
    source,
    /(?:add column if not exists|^\s*)(?:raw_body|raw_payload|webhook_secret)\s+(?:text|jsonb|bytea)\b/imu,
    "raw webhook material must not be stored"
  );
});

check("service-role-only execution and data access", () => {
  for (const signature of [
    "social_cues_reconcile_stripe_binding",
    "social_cues_claim_stripe_webhook_event"
  ]) {
    expectMatch(source, new RegExp(`revoke all on function public\\.${signature}[\\s\\S]*?from public, anon, authenticated`, "u"), `${signature} client revoke missing`);
    expectMatch(source, new RegExp(`grant execute on function public\\.${signature}[\\s\\S]*?to service_role`, "u"), `${signature} service grant missing`);
  }
  expectMatch(source, /STRIPE_B0_SERVICE_ROLE_REQUIRED/u, "RPC body role defense missing");
  expectMatch(source, /v_database_role := nullif\(pg_catalog\.current_setting\('role', true\), 'none'\)[\s\S]*v_database_role is distinct from 'service_role'/u, "RPCs must verify the effective database role");
  expectMatch(source, /v_jwt_role is not null and v_jwt_role <> 'service_role'/u, "RPCs must reject contradictory JWT roles");
  expectMatch(source, /security definer\s+set search_path = ''/u, "privileged RPC safe search_path missing");
  expectMatch(source, /revoke all on table public\.stripe_billing_bindings from public, anon, authenticated/u, "binding table client revoke missing");
  expectMatch(source, /revoke all on table public\.stripe_checkout_sessions from public, anon, authenticated/u, "checkout table client revoke missing");
  expectMatch(source, /grant select on table public\.stripe_billing_bindings to service_role/u, "binding service grant must be read-only");
  expectMatch(source, /grant select, insert, update on table public\.stripe_checkout_sessions to service_role/u, "checkout service grant missing");
  expectNoMatch(source, /grant[^;]*delete[^;]*public\.stripe_checkout_sessions/iu, "checkout history must not be directly deletable");
});

check("RLS and restrictive client policies", () => {
  for (const table of ["stripe_billing_bindings", "stripe_checkout_sessions"]) {
    expectMatch(source, new RegExp(`alter table public\\.${table} enable row level security`, "u"), `${table} RLS missing`);
    expectMatch(source, new RegExp(`alter table public\\.${table} force row level security`, "u"), `${table} forced RLS missing`);
    expectMatch(source, new RegExp(`create policy ${table}_deny_client_access[\\s\\S]*?as restrictive[\\s\\S]*?to anon, authenticated[\\s\\S]*?using \\(false\\)[\\s\\S]*?with check \\(false\\)`, "u"), `${table} deny policy missing`);
  }
});

check("qualification and environment independence", () => {
  for (const relation of ["workspaces", "audit_logs", "webhook_events", "stripe_billing_bindings", "stripe_checkout_sessions"]) {
    expectMatch(source, new RegExp(`public\\.${relation}`, "u"), `${relation} must be qualified`);
  }
  expectNoMatch(
    source,
    /\b(?:from|join|insert into|update|alter table|on table)\s+(?!public\.)(?:workspaces|audit_logs|webhook_events|stripe_billing_bindings|stripe_checkout_sessions)\b/iu,
    "persistent relation reference is not schema-qualified"
  );
  expectNoMatch(
    source,
    /process\.env|current_setting\s*\(\s*['"](?:database|supabase|stripe_secret)|(?:^|[\\/])\.env(?:\.|$)/imu,
    "migration must not read deployment environment"
  );
  expectNoMatch(source, /sk_(?:test|live)_|whsec_|cus_[A-Za-z0-9]{10,}|sub_[A-Za-z0-9]{10,}|price_[A-Za-z0-9]{10,}/u, "migration embeds provider-like identifier material");
  expectNoMatch(source, /vizard/iu, "Stripe B0 must not depend on Vizard");
});

check("test and package contract", () => {
  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.scripts["test:stripe-database"], "node stripe-billing-database.contract.test.mjs");
  assert.equal(packageJson.scripts["test:stripe-database:runtime"], "node stripe-billing-database.runtime.test.mjs");
  assert.equal(packageJson.scripts["test:stripe-database:postgrest"], "node stripe-billing-database.postgrest.test.mjs");
  assertions += 3;
  expectNoMatch(testSource, /https?:\/\//iu, "static test must remain offline");
  const importedModules = [...testSource.matchAll(/^import[^\n]*?from\s+["']([^"']+)["'];?$/gmu)]
    .map((match) => match[1]);
  assert.deepEqual(importedModules, ["node:assert/strict", "node:fs/promises"]);
  const readTargets = [...testSource.matchAll(/readFile\((\w+),\s*["']utf8["']\)/gu)]
    .map((match) => match[1]);
  assert.deepEqual(readTargets, ["migrationUrl", "testUrl", "packageUrl"]);
  assertions += 2;
  for (const forbiddenToken of [
    "child" + "_process",
    "doc" + "ker",
    "process" + "." + "env"
  ]) {
    expect(!testSource.toLowerCase().includes(forbiddenToken), "static test must not select a runtime or environment");
  }
});

assert.equal(externalRequests, 0);
console.log(JSON.stringify({
  ok: true,
  suite: "stripe-billing-database-static",
  categories,
  assertions,
  externalRequests,
  runtimeClaims: []
}));
