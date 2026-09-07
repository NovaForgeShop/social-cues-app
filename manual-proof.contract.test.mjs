import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";

const test = process.argv[1] === fileURLToPath(import.meta.url) ? nodeTest : () => {};
export const html = await readFile(new URL("./social-cues-app.html", import.meta.url), "utf8");
const block = (start, end) => {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a > 0 && b > a);
  return html.slice(a, b);
};
const ctx = vm.createContext({ URL, functionCheckFor: () => ({}), isRealConnectedAccount: () => false,
  liveMetaAssetCount: () => 0, model: { proof: [], integrations: {} }, metaState: {} });
vm.runInContext(block("// Posting pack: pure projection", "// End posting pack pure helpers."), ctx);
vm.runInContext(block("// Manual proof: pure validation", "// End manual proof pure helpers."), ctx);
vm.runInContext(block("function facebookPageEvidence(", "function metaDetectedInstagramAssetCount("), ctx);
export const campaigns = [{ id: "manual-campaign", title: "Manual pilot", variants: [
  { id: "manual-post", platform: "facebook", status: "queued", copy: "Approved synthetic copy", tags: [] },
  { id: "cross-post", campaignId: "other", platform: "facebook", status: "approved", tags: [] }
] }, { id: "other", title: "Other campaign", variants: [
  { id: "other-post", platform: "linkedin", status: "draft", tags: [] }
] }];
export const input = { campaignId: "manual-campaign", variantId: "manual-post",
  postedUrl: "https://www.facebook.com/example/posts/synthetic-001",
  postedLocal: "2026-09-01T09:30:00", postedTimezone: "-04:00",
  metric: "", metricValue: "", observedLocal: "", observedTimezone: "", note: "" };
const now = Date.parse("2026-09-06T12:00:00Z");
const validate = (patch = {}, existing = null) => JSON.parse(JSON.stringify(
  ctx.validateManualProof({ ...input, ...patch }, campaigns, existing, now)));
const observed = { metric: "Views", metricValue: "0", observedLocal: "2026-09-02T10:00", observedTimezone: "-04:00" };

test("all inline JavaScript parses", () => {
  for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
});
test("receipt has explicit association and offsets; unknown results remain blank", () => {
  const { entry, errors } = validate();
  assert.deepEqual(errors, {});
  assert.equal(entry.type, "posting-receipt");
  assert.equal(entry.source, "manual");
  assert.equal(entry.platform, "facebook");
  assert.equal(entry.campaignId, "manual-campaign");
  assert.equal(entry.variantId, "manual-post");
  assert.equal(entry.postedAt, "2026-09-01T09:30:00-04:00");
  for (const key of ["metric", "metricValue", "observedAt", "observedTimezone"]) assert.equal(entry[key], "");
});
test("observations distinguish measured zero from unknown", () => {
  const { entry } = validate(observed);
  assert.equal(entry.type, "observed-result");
  assert.equal(entry.metricValue, "0");
  assert.match(ctx.manualProofSummary(entry), /Views: 0/);
  assert.match(ctx.manualProofSummary(validate().entry), /Results not recorded/);
});
test("clearing an observation preserves receipt identity and deliberate posting facts", () => {
  const existing = Object.freeze({ ...validate(observed).entry, id: "measured-zero", extraLegacyField: "preserved" });
  const { entry, errors } = validate({}, existing);
  assert.deepEqual(errors, {});
  assert.equal(entry.type, "posting-receipt");
  for (const key of ["metric", "metricValue", "observedAt", "observedTimezone"]) assert.equal(entry[key], "");
  for (const key of ["id", "createdAt", "postedUrl", "postedAt", "postedTimezone", "campaignId", "variantId", "source", "extraLegacyField"]) {
    assert.equal(entry[key], existing[key]);
  }
});
test("incomplete or invalid observation matrices are rejected", () => {
  for (const patch of [
    { metric: "Views" }, { metricValue: "0" }, { observedLocal: "2026-09-02T10:00" }, { observedTimezone: "+00:00" },
    { ...observed, metricValue: "NaN" }, { ...observed, metricValue: "Infinity" },
    { ...observed, metricValue: "1e309" }, { ...observed, metricValue: "=1+1" },
    { ...observed, observedLocal: "2026-08-31T12:00" }, { ...observed, observedLocal: "2026-09-07T10:00" }
  ]) assert.equal(validate(patch).entry, null);
});
test("invalid, impossible, future or unzoned posting times are rejected", () => {
  for (const patch of [
    { postedLocal: "" }, { postedLocal: "2026-02-30T09:00" }, { postedLocal: "2026-09-01T24:00" },
    { postedLocal: "2026-09-07T09:00" }, { postedTimezone: "" }, { postedTimezone: "America/New_York" },
    { postedTimezone: "+14:01" }, { postedTimezone: "+03:60" }, { postedLocal: "2026-09-01" }
  ]) assert.equal(validate(patch).entry, null);
  assert.ok(validate({ postedTimezone: "+05:45" }).entry);
});
test("unknown/cross-campaign variants cannot acquire an association", () => {
  for (const patch of [{ campaignId: "" }, { variantId: "cross-post" }, { variantId: "other-post" }]) {
    assert.equal(validate(patch).entry, null);
  }
  assert.equal(validate({ platform: "linkedin" }).entry.platform, "facebook");
});
test("URL validation excludes executable/local/embedded-credential targets without requests", () => {
  for (const postedUrl of ["", "javascript:alert(1)", "http://example.test/a", "file:///tmp/a",
    "https://user:password@example.test/a", "https://127.0.0.1/a", "https://localhost/a",
    "https://example.test/a?access_token=synthetic"]) assert.equal(validate({ postedUrl }).entry, null);
  assert.ok(validate({ postedUrl: "https://www.facebook.com/story.php?story_fbid=123&id=456" }).entry);
});
test("correction preserves identity/legacy extensions and does not mutate inputs", () => {
  const existing = Object.freeze({ ...validate().entry, id: "manual-1", extraLegacyField: "preserved" });
  const before = JSON.stringify({ campaigns, existing });
  const { entry } = validate({ ...observed, note: "Corrected observation" }, existing);
  assert.equal(entry.id, existing.id);
  assert.equal(entry.createdAt, existing.createdAt);
  assert.equal(entry.extraLegacyField, "preserved");
  assert.equal(JSON.stringify({ campaigns, existing }), before);
});
test("note/metric length limits and numeric zero/negative facts remain explicit", () => {
  assert.equal(validate({ note: "x".repeat(2001) }).entry, null);
  assert.equal(validate({ ...observed, metric: "x".repeat(121) }).entry, null);
  assert.equal(validate({ ...observed, metricValue: "-1.5" }).entry.metricValue, "-1.5");
});
test("manual phrases do not establish Facebook evidence; actual provider evidence survives", () => {
  const manual = validate({ note: "Facebook publish dry-run proven. Facebook Pages provider banked." }).entry;
  ctx.model = { proof: [manual], integrations: {} };
  assert.equal(ctx.facebookPageEvidence(null, {}).publishDryRunProven, false);
  ctx.model.proof = [{ ...manual, metric: "Facebook publish dry-run proven" }];
  assert.equal(ctx.facebookPageEvidence(null, {}).publishDryRunProven, false);
  assert.equal(ctx.facebookPageEvidence(null, { acceptanceLedger: { rows: [
    { id: "facebook", gates: { publishDryRunProven: true, oauthConnected: true } }
  ] } }).publishDryRunProven, true);
  ctx.model.proof = [{ type: "provider", metric: "Facebook publish dry-run proven", note: "Existing evidence" }];
  assert.equal(ctx.facebookPageEvidence(null, {}).publishDryRunProven, true);
});
test("manual fact summary labels free text and never turns absent values into metrics", () => {
  const entry = validate({ note: "Operator-provided note" }).entry;
  assert.match(ctx.manualProofSummary(entry), /Manually recorded posting receipt/);
  assert.match(ctx.manualProofSummary(entry), /Operator note \(unverified\)/);
  assert.match(ctx.manualProofSummary({ ...entry, type: "observed-result" }), /Results not recorded/);
  assert.ok(html.includes("escapeHtml(manualProofSummary(item))"));
});
test("form uses the existing save flow and no provider action", () => {
  const save = block("async function saveManualProof(", "function addProof(");
  assert.match(save, /await saveModel\(\)/);
  assert.doesNotMatch(save, /fetch\(|\.status\s*=|approve|publishApproved|enqueueHostedModelSave\(/);
  assert.match(save, /targetModel\.proof = previous/);
  assert.match(html, /id="openManualResults" data-jump="proof"/);
});
