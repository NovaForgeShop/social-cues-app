import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { html, records } from "./evidence-draft.contract.test.mjs";

export { html };
const test = process.argv[1] === fileURLToPath(import.meta.url) ? nodeTest : () => {};
const ctx = vm.createContext({ URL });
for (const [start, end] of [
  ["// Posting pack: pure projection", "// End posting pack pure helpers."],
  ["// Manual proof: pure validation", "// End manual proof pure helpers."],
  ["// Self-launch evidence: pure selected-record projection", "// End self-launch evidence pure helpers."],
  ["// Content recovery: strict projection", "// End content recovery pure helpers."]
]) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a > 0 && b > a);
  vm.runInContext(html.slice(a, b), ctx);
}
export const project = value => JSON.parse(JSON.stringify(ctx.recoveryContent(value)));
export const conflict = (current, content, rows = []) => ctx.recoveryConflict(current, content, rows);
export const fixture = {
  version: "0.2.0-local", activeCampaignId: "recovered-draft",
  campaigns: [
    { id: "manual-campaign", title: "SYNTHETIC source history", brief: "Exact source copy",
      variants: [{ id: "manual-post", platform: "facebook", status: "published", copy: "Recorded historical copy", tags: [],
        publishedAt: "2026-09-01T13:30:00Z" }] },
    { id: "other", title: "SYNTHETIC approved content", brief: "Review only",
      variants: [{ id: "other-post", campaignId: "other", platform: "linkedin", status: "approved", copy: "Exact approved copy", tags: [],
        approvedAt: "2026-09-01T13:00:00Z", scheduledFor: "2026-12-01T13:30:00+05:45" }] },
    { id: "recovered-draft", title: "SYNTHETIC frozen evidence", brief: "Editable draft",
      variants: [{ id: "recovered-variant", platform: "facebook", status: "draft", copy: "Draft from manual facts", tags: [] }],
      evidenceSnapshot: JSON.parse(JSON.stringify(ctx.buildSelfLaunchEvidence(records, ["receipt-only", "observed-zero"], "2026-09-06T21:00:00Z"))) }
  ],
  proof: structuredClone([records[0], records[1], records[3]])
};
export const envelope = source => ({ schemaVersion: "social-cues.campaign-content.v1", content: project(source) });

test("supported legacy model and versioned content project identically without mutation", () => {
  const before = JSON.stringify(fixture), content = project(fixture);
  assert.deepEqual(project(envelope(fixture)), content);
  assert.deepEqual(project({ ...fixture, version: "0.3.0-client-workspace" }), content);
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(content.campaigns.length, 3);
  assert.deepEqual(content.campaigns.map(item => item.variants[0].status), ["published", "approved", "draft"]);
  assert.equal(content.activeCampaignId, "recovered-draft");
});
test("frozen manual facts and zero remain exact while corrected source notes differ", () => {
  const raw = structuredClone(fixture);
  raw.proof[1].note = "Corrected after capture";
  const content = project(raw);
  assert.deepEqual(content.campaigns[2].evidenceSnapshot, fixture.campaigns[2].evidenceSnapshot);
  assert.equal(content.proof[1].metricValue, 0);
  assert.equal(content.proof[1].observedTimezone, "+05:45");
  assert.equal(content.proof[2].metric, "LEGACY SUCCESS CLAIM");
});
test("all imported account and operational fields are excluded, including nested metadata", () => {
  const raw = structuredClone(fixture);
  for (const key of ["currentUser", "workspace", "authUsers", "deviceSessions", "security", "workspaces",
    "memberships", "billing", "connectedAccounts", "integrations", "functionChecks", "publishQueue",
    "quickPosts", "actions", "settings", "onboarding", "mediaAssets", "apiKeys"]) raw[key] = { value: "PRIVATE-SYNTHETIC-OPERATIONAL-SENTINEL" };
  raw.campaigns[0].ownerUserId = "PRIVATE-SYNTHETIC-OPERATIONAL-SENTINEL";
  raw.campaigns[0].variants[0].media = { url: "https://example.test/private-media" };
  raw.campaigns[0].variants[0].providerPostId = "PRIVATE-SYNTHETIC-OPERATIONAL-SENTINEL";
  raw.proof[0].credential = "PRIVATE-SYNTHETIC-OPERATIONAL-SENTINEL";
  raw.campaigns[2].evidenceSnapshot.records[0].token = "PRIVATE-SYNTHETIC-OPERATIONAL-SENTINEL";
  assert.doesNotMatch(JSON.stringify(project(raw)), /PRIVATE-SYNTHETIC|private-media|providerPostId|ownerUserId/);
  assert.deepEqual(project(raw), project(fixture));
});
test("invalid structure and unsupported versions or singular content bundles are rejected", () => {
  for (const value of [null, [], {}, { ...fixture, version: "future" }, { schemaVersion: "future", content: fixture },
    { campaign: fixture.campaigns[0] }, { ...fixture, campaigns: null }, { ...fixture, proof: null },
    { ...fixture, activeCampaignId: "missing" }]) assert.throws(() => project(value));
});
test("all dispatch statuses and live confirmations are rejected rather than resumed", () => {
  for (const status of ["queued", "scheduled", "processing", "submitted", "retrying", "unknown"]) {
    const raw = structuredClone(fixture); raw.campaigns[0].variants[0].status = status;
    assert.throws(() => project(raw), /status/);
  }
  for (const field of ["queuedAt", "nextRetryAt", "approvalConfirmedAt", "handoffReadyAt"]) {
    const raw = structuredClone(fixture); raw.campaigns[0].variants[0][field] = "2026-09-01T00:00:00Z";
    assert.throws(() => project(raw), /Dispatch/);
  }
});
test("duplicate IDs, conflicting associations and dangling snapshots fail the whole import", () => {
  for (const change of [
    raw => raw.campaigns.push(raw.campaigns[0]),
    raw => raw.campaigns[1].variants.push(raw.campaigns[0].variants[0]),
    raw => raw.proof.push(raw.proof[0]),
    raw => raw.campaigns[0].variants[0].campaignId = "other",
    raw => raw.proof[0].campaignId = "absent",
    raw => raw.proof[0].variantId = "other-post",
    raw => raw.proof[0].platform = "discord",
    raw => raw.proof.shift(),
    raw => raw.campaigns[2].evidenceSnapshot.schemaVersion = "future",
    raw => raw.campaigns[0].id = '<img src=x>',
    raw => raw.campaigns[0].variants[0].tags = {},
    raw => raw.campaigns[0].destinationUrl = "javascript:alert(1)",
    raw => raw.proof[0].postedUrl = "https://user:secret@example.test",
    raw => raw.proof[0].postedTimezone = "+05:00"
  ]) {
    const raw = structuredClone(fixture); change(raw); assert.throws(() => project(raw));
  }
});
test("current operational references and quick-post collisions block replacement without mutation", () => {
  const content = project(fixture);
  for (const current of [
    { campaigns: [{ id: "current", variants: [{ id: "live", status: "queued" }] }] },
    { campaigns: [], publishQueue: [{ variantId: "other-post", status: "queued" }] },
    { campaigns: [], actions: [{ campaignId: "other" }] },
    { campaigns: [], mediaAssets: [{ campaignId: "other" }] },
    { campaigns: [], quickPosts: [{ id: "other", variants: [] }] },
    { campaigns: [], quickPosts: [{ id: "quick", variants: [{ id: "other-post" }] }] }
  ]) {
    const before = JSON.stringify(current);
    assert.ok(conflict(current, content));
    assert.equal(JSON.stringify(current), before);
  }
  assert.ok(conflict({ campaigns: [] }, content, [{ campaignId: "other", status: "queued" }]));
  assert.ok(conflict({ campaigns: [] }, content, [{ source: "campaign-variant", campaignId: "other", status: "published", live: true }]));
  assert.equal(conflict({ campaigns: [], publishQueue: [{ campaignId: "unrelated", status: "queued" }] }, content), "");
  assert.equal(conflict({ campaigns: [] }, content, [{ source: "campaign-variant", campaignId: "other", status: "approved" }]), "");
});
test("legacy unassociated proof is preserved but unknown provider evidence is not promoted", () => {
  assert.deepEqual(project(fixture).proof[2], fixture.proof[2]);
  const raw = structuredClone(fixture);
  raw.proof[2].source = "provider-verified";
  assert.throws(() => project(raw), /Unsupported evidence source/);
});
test("whole inline script parses and recovery uses a native modal with awaited save confirmation", () => {
  for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  assert.match(html, /<dialog id="recoveryDialog" aria-labelledby="recoveryHeading"/);
  const start = html.indexOf("async function applyRecovery()");
  const source = html.slice(start, html.indexOf("function saveProfile()", start));
  assert.match(source, /await sendWorkspaceSave\(state\.operation\)/);
  assert.match(source, /expectedRevision: clone\(state\.revision\)/);
  assert.match(source, /await response.json\(\)/);
  assert.doesNotMatch(source, /defaultModel|fetch\(|\/api\/(publish|provider|worker)/);
});
