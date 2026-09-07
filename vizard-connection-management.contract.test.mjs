import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("./SUPABASE-VIZARD-CONNECTION-MANAGEMENT.sql", import.meta.url);
const testUrl = new URL("./vizard-connection-management.contract.test.mjs", import.meta.url);
const [sql, testSource] = await Promise.all([
  readFile(migrationUrl, "utf8"),
  readFile(testUrl, "utf8")
]);

let externalRequests = 0;
globalThis.fetch = async () => {
  externalRequests += 1;
  throw new Error("External requests are forbidden in the Vizard connection migration contract.");
};

const passedCategories = [];
async function check(name, fn) {
  await fn();
  passedCategories.push(name);
  console.log(`PASS ${name}`);
}

function normalizeStatement(value) {
  return value.replace(/\s+/gu, " ").replace(/;\s*$/u, "").trim().toLowerCase();
}

function stripLineComments(value) {
  return value.replace(/--.*$/gmu, "");
}

function parseCommaList(value) {
  return value.split(",").map((entry) => normalizeStatement(entry));
}

function splitTopLevelList(value) {
  const entries = [];
  let current = "";
  let depth = 0;
  let inString = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];

    if (inString) {
      current += character;
      if (character === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (character === "'") {
        inString = false;
      }
      continue;
    }

    if (character === "'") {
      inString = true;
      current += character;
    } else if (character === "(") {
      depth += 1;
      current += character;
    } else if (character === ")") {
      depth -= 1;
      current += character;
    } else if (character === "," && depth === 0) {
      entries.push(normalizeStatement(current));
      current = "";
    } else {
      current += character;
    }
  }

  if (current.trim()) entries.push(normalizeStatement(current));
  return entries;
}

const uncommentedSql = stripLineComments(sql);
const functionMatch = uncommentedSql.match(
  /create or replace function public\.social_cues_manage_vizard_connection\s*\(([\s\S]*?)\)\s*returns table\s*\(([\s\S]*?)\)\s*language plpgsql\s*security invoker\s*set search_path = ''\s*as \$function\$([\s\S]*?)\$function\$;/u
);
assert.ok(functionMatch, "the exact Vizard RPC declaration is present");

const [, parameterBlock, returnFieldBlock, body] = functionMatch;
const expectedParameters = [
  "p_actor_user_id uuid",
  "p_workspace_id uuid",
  "p_action text",
  "p_encrypted_token jsonb default null"
];
const expectedReturnFields = [
  "connected_account_id uuid",
  "workspace_id uuid",
  "provider text",
  "platform text",
  "connection_state text",
  "verification_state text",
  "connected_at timestamptz",
  "created_at timestamptz",
  "updated_at timestamptz"
];
const expectedReturnQueries = [
  [
    "null::uuid",
    "p_workspace_id",
    "'vizard'::text",
    "'vizard'::text",
    "'not_connected'::text",
    "'not_verified'::text",
    "null::timestamptz",
    "null::timestamptz",
    "null::timestamptz"
  ],
  [
    "v_account.id",
    "v_account.workspace_id",
    "'vizard'::text",
    "'vizard'::text",
    "v_account.status",
    "case when v_account.status = 'pending_verification' then 'pending' else 'not_verified' end",
    "v_account.connected_at",
    "v_account.created_at",
    "v_account.updated_at"
  ]
];
const exactSignature = "public.social_cues_manage_vizard_connection(uuid, uuid, text, jsonb)";

await check("transaction and provider-specific migration structure", () => {
  assert.match(sql, /^--[\s\S]*\nbegin;/u);
  assert.match(sql, /commit;\s*$/u);
  assert.equal((sql.match(/\$migration\$/gu) || []).length, 2);
  assert.equal((sql.match(/\$index_guard\$/gu) || []).length, 2);
  assert.equal((sql.match(/\$function\$/gu) || []).length, 2);
  assert.equal((uncommentedSql.match(/create(?: or replace)? function\s+public\.social_cues_manage_vizard_connection/giu) || []).length, 1);
  assert.doesNotMatch(uncommentedSql.slice(0, uncommentedSql.indexOf("create or replace function")), /delete from|update public\.|insert into public\./iu);
  assert.doesNotMatch(uncommentedSql, /drop\s+index|drop\s+function|alter\s+table[\s\S]*disable\s+row\s+level\s+security/iu);
});

await check("exact RPC parameters and overload", () => {
  assert.deepEqual(parseCommaList(parameterBlock), expectedParameters);
  assert.match(uncommentedSql, /p\.proname = 'social_cues_manage_vizard_connection'[\s\S]*pg_catalog\.oidvectortypes\(p\.proargtypes\) <> 'uuid, uuid, text, jsonb'/u);
  for (const command of ["alter function", "comment on function", "revoke all on function", "grant execute on function"]) {
    assert.match(normalizeStatement(uncommentedSql), new RegExp(`${command} ${exactSignature.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  }
});

await check("exact safe return-field allowlist", () => {
  assert.deepEqual(parseCommaList(returnFieldBlock), expectedReturnFields);
  const returnQueries = [...body.matchAll(/return query\s+select\s+([\s\S]*?);/gu)].map((match) => match[1]);
  assert.deepEqual(returnQueries.map(splitTopLevelList), expectedReturnQueries);
  assert.doesNotMatch(body, /return\s+(next|query)[\s\S]*%rowtype/iu);
});

await check("index creation and exact catalog-definition guard", () => {
  assert.match(uncommentedSql, /create unique index if not exists connected_accounts_workspace_vizard_current_uidx\s+on public\.connected_accounts\(workspace_id\)\s+where provider = 'vizard' and platform = 'vizard';/u);
  const guardMatch = uncommentedSql.match(/do \$index_guard\$([\s\S]*?)\$index_guard\$;/u);
  assert.ok(guardMatch);
  const guard = guardMatch[1];
  for (const catalog of ["pg_class", "pg_namespace", "pg_index", "pg_am", "pg_attribute"]) {
    assert.match(guard, new RegExp(`pg_catalog\\.${catalog}\\b`, "u"));
  }
  for (const required of [
    /index_namespace\.nspname = 'public'/u,
    /index_relation\.relname = 'connected_accounts_workspace_vizard_current_uidx'/u,
    /index_relation\.relkind = 'i'/u,
    /target_relation\.oid = 'public\.connected_accounts'::regclass/u,
    /index_catalog\.indisunique/u,
    /index_catalog\.indisvalid/u,
    /index_catalog\.indisready/u,
    /index_catalog\.indnkeyatts = 1/u,
    /index_catalog\.indnatts = 1/u,
    /index_catalog\.indexprs is null/u,
    /index_catalog\.indpred is not null/u,
    /indexed_attribute\.attname = 'workspace_id'/u,
    /access_method\.amname = 'btree'/u,
    /pg_catalog\.pg_get_expr\(index_catalog\.indpred, index_catalog\.indrelid, true\)/u,
    /= 'provider=''vizard''ANDplatform=''vizard'''/u,
    /if v_index_oid is null or not coalesce\(v_definition_matches, false\) then\s+raise exception using\s+errcode = '23514',\s+message = 'VIZARD_CONNECTION_INDEX_DEFINITION_CONFLICT';\s+end if;/u
  ]) assert.match(guard, required);
  assert.doesNotMatch(uncommentedSql, /drop\s+index|reindex/iu);
});

await check("exact action allowlist and fixed management inputs", () => {
  const allowlistMatch = body.match(/v_action not in\s*\(([^)]*)\)/u);
  assert.ok(allowlistMatch);
  assert.deepEqual([...allowlistMatch[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]), ["connect", "replace", "disconnect"]);
  assert.ok(body.indexOf("v_action not in") < body.search(/insert into|update public\.|delete from/u));
  assert.doesNotMatch(parameterBlock, /provider|platform|token_kind|verification|role/iu);
  assert.doesNotMatch(body, /\bp_(provider|platform|token_kind|verification|role)\b/iu);
  assert.match(body, /v_membership_role not in \('owner', 'admin'\)/u);
  assert.match(body, /'vizard'[\s\S]*'api_key'/u);
});

await check("exact execution security and privileges", () => {
  assert.match(uncommentedSql, /language plpgsql\s+security invoker\s+set search_path = ''\s+as \$function\$/u);
  assert.doesNotMatch(uncommentedSql, /security definer/iu);
  const privilegeStatements = [...uncommentedSql.matchAll(/(?:revoke|grant)[^;]*social_cues_manage_vizard_connection[^;]*;/giu)]
    .map((match) => normalizeStatement(match[0]));
  assert.deepEqual(privilegeStatements, [
    `revoke all on function ${exactSignature} from public, anon, authenticated`,
    `grant execute on function ${exactSignature} to service_role`
  ]);
  assert.doesNotMatch(uncommentedSql, /grant\s+execute\s+on\s+all\s+functions|grant\s+.*social_cues_manage_vizard_connection[\s\S]*\b(public|anon|authenticated)\b/iu);
});

await check("exact actor and workspace membership authorization", () => {
  assert.match(body, /from public\.workspace_members wm[\s\S]*wm\.workspace_id = p_workspace_id[\s\S]*wm\.user_id = p_actor_user_id[\s\S]*for share;/u);
  assert.equal((body.match(/VIZARD_CONNECTION_NOT_AUTHORIZED/gu) || []).length, 2);
  assert.doesNotMatch(body, /raw_user_meta_data|app_metadata|global_role|owner_email|subscription|entitlement|provider_account_id\s*=/iu);
});

await check("comprehensive relation and callable-function qualification", () => {
  const code = stripLineComments(uncommentedSql);
  for (const relation of ["workspace_members", "connected_accounts", "provider_tokens", "audit_logs"]) {
    assert.doesNotMatch(code, new RegExp(`(?<!public\\.)\\b${relation}\\b`, "u"));
  }
  for (const callable of [
    "count", "lower", "btrim", "jsonb_typeof", "jsonb_strip_nulls", "length",
    "pg_advisory_xact_lock", "hashtextextended", "jsonb_build_object", "now",
    "oidvectortypes", "regexp_replace", "pg_get_expr"
  ]) {
    assert.doesNotMatch(code, new RegExp(`(?<!pg_catalog\\.)\\b${callable}\\s*\\(`, "u"));
  }
  const bodyWithoutInsertColumnLists = body.replace(/insert into public\.[a-z_][a-z0-9_]*\s*\(/giu, "");
  assert.doesNotMatch(bodyWithoutInsertColumnLists, /\bpublic\.[a-z_][a-z0-9_]*\s*\(/iu);
  assert.doesNotMatch(body, /\bexecute\b|format\s*\(|quote_ident\s*\(|p_[a-z_]+::reg(class|type)/iu);
});

await check("complete canonical ciphertext-envelope validation", () => {
  const keys = "array['alg', 'iv', 'tag', 'value']";
  assert.ok(body.includes(`?& ${keys}`));
  assert.ok(body.includes(`(p_encrypted_token - ${keys}) <> '{}'::jsonb`));
  assert.match(body, /p_encrypted_token <> pg_catalog\.jsonb_strip_nulls\(p_encrypted_token\)/u);
  for (const key of ["alg", "iv", "tag", "value"]) {
    assert.match(body, new RegExp(`pg_catalog\\.jsonb_typeof\\(p_encrypted_token->'${key}'\\) <> 'string'`, "u"));
  }
  assert.match(body, /p_encrypted_token->>'alg' <> 'aes-256-gcm'/u);
  assert.match(body, /pg_catalog\.length\(p_encrypted_token->>'iv'\) <> 16[\s\S]*\^\[A-Za-z0-9_-\]\{16\}\$/u);
  assert.match(body, /pg_catalog\.length\(p_encrypted_token->>'tag'\) <> 22[\s\S]*\^\[A-Za-z0-9_-\]\{22\}\$/u);
  assert.match(body, /pg_catalog\.length\(p_encrypted_token->>'value'\) not between 1 and 4096[\s\S]*\^\[A-Za-z0-9_-\]\+\$/u);
  assert.match(body, /elsif p_encrypted_token is not null[\s\S]*VIZARD_CONNECTION_ENVELOPE_UNEXPECTED/u);
  assert.doesNotMatch(body, /'version'|plaintext|decrypt|digest\s*\(|sha[0-9]|fingerprint|raise\s+(notice|log|warning)/iu);
});

await check("ciphertext is confined to the token row", () => {
  const accountInsert = body.match(/insert into public\.connected_accounts[\s\S]*?returning \* into v_account;/u);
  assert.ok(accountInsert);
  assert.doesNotMatch(accountInsert[0], /p_encrypted_token|encrypted_token|\biv\b|\btag\b|\bvalue\b/u);
  const auditAndReturnTail = body.slice(body.lastIndexOf("insert into public.audit_logs"));
  assert.doesNotMatch(auditAndReturnTail, /p_encrypted_token|\bencrypted_token\b|\biv\b|\btag\b|\bvalue\b/u);
  assert.doesNotMatch(body, /provider_account_id[\s\S]{0,200}p_encrypted_token|message\s*=\s*p_encrypted_token|raise exception[^;]*%/iu);
});

await check("transaction-scoped locking and stable account behavior", () => {
  assert.match(body, /pg_catalog\.pg_advisory_xact_lock\([\s\S]*p_workspace_id::text \|\| ':vizard'/u);
  assert.doesNotMatch(body, /(?<!_xact)pg_advisory_lock\s*\(/u);
  assert.match(body, /from public\.connected_accounts ca[\s\S]*for update;/u);
  assert.match(body, /from public\.provider_tokens pt[\s\S]*for update;/u);
  assert.match(uncommentedSql, /having pg_catalog\.count\(\*\) > 1[\s\S]*VIZARD_CONNECTION_MIGRATION_REQUIRES_CLEANUP/u);
  assert.match(sql, /provider_tokens already has UNIQUE \(connected_account_id, token_kind\)/u);
  assert.match(uncommentedSql, /comment on constraint provider_tokens_connected_account_id_token_kind_key\s+on public\.provider_tokens/u);
});

await check("connect, replace, and disconnect row-state contracts", () => {
  assert.match(body, /v_action = 'connect' and v_account\.id is null[\s\S]*insert into public\.connected_accounts/u);
  assert.match(body, /insert into public\.provider_tokens[\s\S]*'api_key'[\s\S]*p_encrypted_token/u);
  assert.match(body, /v_action = 'replace' and v_account\.id is null[\s\S]*VIZARD_CONNECTION_UNAVAILABLE/u);
  assert.match(body, /update public\.provider_tokens pt[\s\S]*where pt\.id = v_token\.id/u);
  assert.match(body, /v_action = 'disconnect' and v_account\.id is null[\s\S]*already_disconnected[\s\S]*return;/u);
  assert.match(body, /delete from public\.provider_tokens pt[\s\S]*pt\.connected_account_id = v_account\.id[\s\S]*pt\.token_kind = 'api_key'/u);
  assert.match(body, /status = 'not_connected'[\s\S]*connected_at = null,[\s\S]*last_sync_at = null/u);
});

await check("transactional audit allowlist", () => {
  const auditStatements = [...body.matchAll(/insert into public\.audit_logs\s*\(([\s\S]*?)\)\s*values\s*\(([\s\S]*?)\);/gu)];
  assert.equal(auditStatements.length, 2);
  for (const audit of auditStatements) {
    assert.deepEqual(parseCommaList(audit[1]), ["workspace_id", "user_id", "event_type", "provider", "platform", "target_id", "metadata"]);
    assert.doesNotMatch(audit[2], /p_encrypted_token|\bencrypted_token\b|\biv\b|\btag\b|\bvalue\b|request|exception|credential/iu);
  }
  assert.doesNotMatch(body, /exception\s+when/iu);
});

function assertHermeticTestImplementation(source) {
  const environmentSuffix = String.fromCharCode(46, 101, 110, 118);
  const environmentAccess = `process${environmentSuffix}`;
  assert.match(source, /globalThis\.fetch = async/u, "fetch safeguard is required");
  assert.ok(!source.includes(environmentAccess), "environment access is forbidden");
  assert.doesNotMatch(source, /node:(?:http|https|net)|https?:\/\//iu, "network clients and URLs are forbidden");
}

await check("testSource hermeticity and wrong-source regression", () => {
  assertHermeticTestImplementation(testSource);
  const environmentSuffix = String.fromCharCode(46, 101, 110, 118);
  assert.throws(
    () => assertHermeticTestImplementation(`globalThis.fetch = async () => {}; process${environmentSuffix};`),
    /environment access is forbidden/u
  );
  assert.throws(() => assertHermeticTestImplementation("const sql = 'safe';"), /fetch safeguard is required/u);
  assert.equal(externalRequests, 0);
});

const runtimeUnproven = [
  "migration execution",
  "index creation and catalog comparison",
  "function creation",
  "service_role privileges and SECURITY INVOKER writes",
  "transaction and audit rollback",
  "advisory-lock contention and concurrent calls",
  "PostgREST RPC invocation"
];

console.log(JSON.stringify({
  ok: true,
  staticContractCategories: passedCategories,
  externalRequests,
  runtimeUnproven
}));
