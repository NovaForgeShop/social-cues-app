import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { html } from "./manual-proof.contract.test.mjs";

export { html };
const test = process.argv[1] === fileURLToPath(import.meta.url) ? nodeTest : () => {};
const block = (start, end) => {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a > 0 && b > a);
  return html.slice(a, b);
};
const ctx = vm.createContext({ URL });
vm.runInContext(block("// Posting pack: pure projection", "// End posting pack pure helpers."), ctx);
vm.runInContext(block("// Manual proof: pure validation", "// End manual proof pure helpers."), ctx);
vm.runInContext(block("// Self-launch evidence: pure selected-record projection", "// End self-launch evidence pure helpers."), ctx);
export const records = [
  { id: "receipt-only", source: "manual", schemaVersion: "social-cues.manual-proof.v1", type: "posting-receipt",
    campaignId: "manual-campaign", variantId: "manual-post", platform: "facebook",
    postedUrl: "https://example.test/synthetic-receipt", postedAt: "2026-09-01T09:30:00-04:00", postedTimezone: "-04:00",
    metric: "", metricValue: "", observedAt: "", observedTimezone: "", note: "SYNTHETIC receipt, no performance measured.",
    createdAt: "2026-09-01T15:00:00Z", updatedAt: "2026-09-01T15:00:00Z" },
  { id: "observed-zero", source: "manual", schemaVersion: "social-cues.manual-proof.v1", type: "observed-result",
    campaignId: "other", variantId: "other-post", platform: "linkedin",
    postedUrl: "https://example.test/synthetic-zero", postedAt: "2026-09-01T10:30:00+05:45", postedTimezone: "+05:45",
    metric: "Synthetic views", metricValue: 0, observedAt: "2026-09-02T10:30:00+05:45", observedTimezone: "+05:45",
    note: "<b>SYNTHETIC operator note</b>", createdAt: "2026-09-02T06:00:00Z", updatedAt: "2026-09-02T06:00:00Z" },
  { id: "unselected-result", source: "manual", type: "observed-result", campaignId: "unselected-campaign",
    platform: "youtube", metric: "UNSELECTED FACT", metricValue: "999", observedAt: "2026-09-02T00:00:00Z", observedTimezone: "+00:00" },
  { id: "legacy-story", type: "customer", metric: "LEGACY SUCCESS CLAIM", note: "Do not silently include me." }
];
const capture = (ids, proof = records) => JSON.parse(JSON.stringify(
  ctx.buildSelfLaunchEvidence(proof, ids, "2026-09-06T21:00:00Z")));
const text = snapshot => ctx.selfLaunchEvidenceText(snapshot);

test("selection requires exact saved manual identities and excludes legacy/unselected records", () => {
  for (const ids of [[], ["missing"], ["legacy-story"], ["receipt-only", "legacy-story"]]) assert.throws(() => capture(ids));
  const snapshot = capture(["observed-zero", "receipt-only", "observed-zero"]);
  assert.deepEqual(snapshot.sourceRecordIds, ["observed-zero", "receipt-only"]);
  assert.equal(snapshot.records.length, 2);
  assert.doesNotMatch(text(snapshot), /UNSELECTED FACT|LEGACY SUCCESS CLAIM/);
  assert.throws(() => capture(["receipt-only"], [...records, records[0]]), /ambiguous/);
});
test("receipt-only evidence never becomes a measured win", () => {
  const output = text(capture(["receipt-only"]));
  assert.match(output, /Manual posting receipt/);
  assert.match(output, /Performance: unreported/);
  assert.doesNotMatch(output, /Manual observation:|success story|growth system|proven win/);
  assert.match(output, /No product impact or causal attribution is established/);
});
test("zero and explicit recorded URL platform timestamps and offsets survive", () => {
  const snapshot = capture(["observed-zero"]), output = text(snapshot);
  assert.equal(snapshot.records[0].metricValue, "0");
  for (const fact of ["https://example.test/synthetic-zero", "linkedin", "2026-09-01T10:30:00+05:45",
    "2026-09-02T10:30:00+05:45", "Synthetic views: 0"]) assert.ok(output.includes(fact));
  assert.match(output, /not provider-verified/);
  assert.ok(output.includes('Operator note (unverified; quoted): "<b>SYNTHETIC operator note</b>"'));
});
test("missing or invalid performance is unreported without substituting zero", () => {
  for (const patch of [{metric:""}, {metricValue:""}, {metricValue:"unknown"}, {observedAt:""}, {observedTimezone:""}]) {
    const output = text(capture(["observed-zero"], [{...records[1], ...patch}]));
    assert.match(output, /Performance: unreported/);
    assert.doesNotMatch(output, /Manual observation:/);
  }
  const output = text(capture(["observed-zero"], [{...records[1], platform:"",postedUrl:"",postedAt:"",postedTimezone:""}]));
  assert.match(output, /Platform: Not recorded/);
  assert.match(output, /Recorded posting time: Not recorded/);
  assert.match(output, /Recorded posting UTC offset: Not recorded/);
});
test("snapshot is a factual allowlist detached from later source corrections", () => {
  const source = structuredClone(records);
  source[0].credential = "synthetic-private-sentinel";
  const snapshot = capture(["receipt-only"], source), before = JSON.stringify(snapshot);
  source[0].note = "Changed later";
  source[0].postedUrl = "https://example.test/correction";
  assert.equal(JSON.stringify(snapshot), before);
  assert.doesNotMatch(before, /synthetic-private-sentinel|credential/);
  assert.equal(snapshot.records[0].sourceRecordId, "receipt-only");
  assert.equal(snapshot.records[0].sourceUpdatedAt, records[0].updatedAt);
  assert.equal(snapshot.capturedAt, "2026-09-06T21:00:00Z");
});
test("unsafe embedded-credential URLs are omitted rather than exposed", () => {
  const snapshot = capture(["receipt-only"], [{...records[0],postedUrl:"https://example.test/a?token=synthetic-private"}]);
  assert.equal(snapshot.records[0].postedUrl, "");
  assert.doesNotMatch(text(snapshot), /synthetic-private/);
});
test("draft builder reuses local campaign metadata and never generic success-story copy", () => {
  const source = block("function buildSelfLaunchDraft(", "async function createSelfLaunchCampaign(");
  assert.match(source, /buildCampaignFromIdea\(/);
  assert.match(source, /evidenceSnapshot = clone\(preview.snapshot\)/);
  assert.match(source, /copy: preview.text/);
  assert.match(source, /status: "draft"/);
  assert.doesNotMatch(source, /fetch\(|platformCopy\(|saveModel\(/);
  const save = block("async function createSelfLaunchCampaign(", "function comingSoonCopy(");
  assert.equal((save.match(/await saveModel\(\)/g) || []).length, 1);
  assert.match(save, /state.pending/);
  assert.match(save, /targetModel.campaigns = previous/);
  assert.doesNotMatch(save, /fetch\(|generateVariants\(|publishApproved|\.proof\s*=/);
});
test("campaign extraction retains the existing create-and-save wrapper", () => {
  const builder = block("function buildCampaignFromIdea(", "function createCampaignFromIdea(");
  assert.doesNotMatch(builder, /saveModel\(|campaigns.unshift/);
  const wrapper = block("function createCampaignFromIdea(", "function saveCampaignFromForm(");
  assert.match(wrapper, /buildCampaignFromIdea\(title, brief, goal\)/);
  assert.match(wrapper, /model.campaigns.unshift\(campaign\)/);
  assert.match(wrapper, /saveModel\(/);
});

test("saved inspector uses the persisted snapshot and established factual text without mutation", () => {
  const snapshot = capture(["receipt-only", "observed-zero"]);
  const before = JSON.stringify(snapshot);
  const view = ctx.savedEvidenceView(snapshot);
  assert.equal(view.state, "ready");
  assert.equal(view.text, text(snapshot));
  assert.equal(view.capturedAt, snapshot.capturedAt);
  assert.match(view.message, /Later receipt corrections do not update/);
  assert.match(view.text, /Synthetic views: 0/);
  assert.match(view.text, /Performance: unreported/);
  assert.equal(JSON.stringify(snapshot), before);
});

test("ordinary, malformed and unsupported saved snapshots never present valid evidence", () => {
  for (const value of [null, undefined]) assert.equal(ctx.savedEvidenceView(value).state, "none");
  const valid = capture(["receipt-only"]);
  const cases = [false, 0, "", [], {}, {...valid,schemaVersion:"future"}, {...valid,source:"provider"},
    {...valid,capturedAt:"2026-02-30T10:00:00Z"}, {...valid,capturedAt:"unrecorded"},
    {...valid,sourceRecordIds:[]}, {...valid,sourceRecordIds:["other"]}, {...valid,records:null},
    {...valid,sourceRecordIds:["receipt-only","receipt-only"],records:[valid.records[0],valid.records[0]]},
    {...valid,records:[null]}, {...valid,records:[{...valid.records[0],note:{text:"not a string"}}]},
    {...valid,records:[{...valid.records[0],recordType:"verified"}]},
    {...valid,records:[{...valid.records[0],postedAt:"bad date"}]},
    {...valid,records:[{...valid.records[0],postedTimezone:"+99:00"}]},
    {...valid,records:[{...valid.records[0],postedUrl:"https://example.test/?token=synthetic-private"}]},
    {...valid,records:[{...valid.records[0],metricValue:"not numeric"}]}];
  for (const value of cases) {
    const result = ctx.savedEvidenceView(value);
    assert.equal(result.state, "unavailable");
    assert.equal(result.text, "");
    assert.equal(result.capturedAt, "");
  }
});

test("missing stored facts stay unreported and unknown properties stay out of saved inspection", () => {
  const snapshot = capture(["observed-zero"]);
  Object.assign(snapshot.records[0], {metricValue:"",postedUrl:"",platform:"",observedAt:"",
    observedTimezone:"", credential:"synthetic-private-sentinel"});
  const view = ctx.savedEvidenceView(snapshot);
  assert.equal(view.state, "ready");
  assert.match(view.text, /Platform: Not recorded/);
  assert.match(view.text, /Performance: unreported/);
  assert.doesNotMatch(view.text, /synthetic-private-sentinel|Manual observation:/);
});

test("inspector is native disclosure with text-only render and no transient-preview or save dependency", () => {
  assert.match(html, /<details class="saved-evidence" id="savedEvidenceDisclosure">/);
  const render = block("function renderSavedEvidence(", "const selfLaunchState");
  assert.match(render, /savedEvidenceView\(campaign\?\.evidenceSnapshot\)/);
  assert.match(render, /textContent = view.text/);
  assert.doesNotMatch(render, /innerHTML|saveModel|selfLaunchState|fetch\(|\.value\s*=|renderForms\(/);
  assert.doesNotMatch(html, /savedEvidenceDisclosure[^\r\n]*addEventListener/);
});
