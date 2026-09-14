import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("./SUPABASE-HEYGEN-DURABLE-PERSISTENCE.sql", import.meta.url);
const starterSchemaPath = new URL("./supabase-schema.sql", import.meta.url);
const beginMarker = "-- BEGIN SOCIAL CUES HEYGEN DURABLE PERSISTENCE (exact standalone migration)";
const endMarker = "-- END SOCIAL CUES HEYGEN DURABLE PERSISTENCE";

function normalizeLines(value) {
  return String(value).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

test("clean-install schema embeds the exact durable HeyGen migration", async () => {
  const migration = normalizeLines(await readFile(migrationPath, "utf8"));
  const starterSchema = normalizeLines(await readFile(starterSchemaPath, "utf8"));
  assert.equal(starterSchema.split(beginMarker).length - 1, 1);
  assert.equal(starterSchema.split(endMarker).length - 1, 1);
  const blockStart = starterSchema.indexOf(`${beginMarker}\n`) + beginMarker.length + 1;
  const blockEnd = starterSchema.indexOf(endMarker, blockStart);
  assert.ok(blockStart > beginMarker.length);
  assert.ok(blockEnd > blockStart);
  assert.equal(starterSchema.slice(blockStart, blockEnd), migration);
});

test("migration keeps state, tokens, operation evidence, and request arguments private", async () => {
  const migration = normalizeLines(await readFile(migrationPath, "utf8"));
  for (const required of [
    "create schema if not exists social_cues_private",
    "social_cues_private.heygen_oauth_states",
    "social_cues_private.heygen_operation_receipts",
    "alter table public.provider_tokens force row level security",
    "alter table public.media_assets force row level security",
    "alter table public.heygen_media_jobs force row level security",
    "revoke all on table public.provider_tokens from public, anon, authenticated",
    "social_cues_private.heygen_valid_request_arguments(v_action, p_request_arguments)",
    "social_cues_private.heygen_valid_operation_safe_result(p_safe_result)",
    "p_request_arguments ? 'sourceAssetId'",
    "p_request_arguments ? 'parentVersionId'",
    "interface_fingerprint', 'heygen-durable-v1-oauth-account-job-lineage'"
  ]) assert.match(migration, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));

  assert.doesNotMatch(migration, /\b(?:raw_state|authorization_code|plaintext_token|access_token|refresh_token)\b/iu);
  assert.match(migration, /grant select \([\s\S]*?\) on public\.heygen_media_jobs to authenticated;/u);
  assert.doesNotMatch(
    migration.match(/grant select \([\s\S]*?\) on public\.heygen_media_jobs to authenticated;/u)?.[0] || "",
    /request_arguments|request_fingerprint|result_fingerprint/u
  );
});
