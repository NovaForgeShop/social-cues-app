import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./social-cues-app.html", import.meta.url), "utf8");
const start = html.indexOf("// Losing campaign: content-only projection"), end = html.indexOf("// End losing campaign pure helpers.", start);
assert.ok(start >= 0 && end > start);
const api = vm.runInNewContext(html.slice(start, end) + "\n({losingCampaignProjection,readLosingCampaignFile,losingCampaignDraft,losingCampaignSchema})", { URL, TextEncoder });
const plain = value => JSON.parse(JSON.stringify(value));
const scope = "a".repeat(64), copyId = "abcdef12-3456-4789-8abc-123456789abc";
const source = () => ({ id: "original", title: "Losing title", brief: "Losing brief <script>inert</script>", goal: "Build demand", tone: "Useful",
  disclosure: "Organic/no material connection", riskPosture: "Balanced growth", destinationUrl: "https://example.test/campaign", destinationCta: "learn_more",
  variants: [{ id: "old-variant", platform: "facebook", copy: "Losing copy", status: "published", approvedAt: "old", scheduledFor: "old", providerReceipt: "secret-sentinel", media: { token: "secret-sentinel" } }],
  evidenceSnapshot: { records: [{ metricValue: 0, source: "manual" }] }, proof: [{ note: "immutable" }], billing: { token: "secret-sentinel" } });
const file = () => ({ schemaVersion: api.losingCampaignSchema, workspaceScope: scope, sourceCampaignId: "original", copyId, campaign: plain(api.losingCampaignProjection(source())) });

test("projection retains only supported editable text without mutating source or facts", () => {
  const input = source(), before = structuredClone(input), projected = plain(api.losingCampaignProjection(input));
  assert.deepEqual(input, before);
  assert.equal(projected.brief, input.brief); assert.equal(projected.variants[0].copy, "Losing copy");
  assert.deepEqual(Object.keys(projected).sort(), ["title", "brief", "goal", "tone", "disclosure", "riskPosture", "destinationUrl", "destinationCta", "variants"].sort());
  assert.deepEqual(Object.keys(projected.variants[0]).sort(), ["copy", "platform"]);
  assert.ok(!JSON.stringify(projected).includes("secret-sentinel"));
});

test("strict versioned file round-trips after serialization with stable copy identity", () => {
  const original = file();
  assert.deepEqual(plain(api.readLosingCampaignFile(JSON.parse(JSON.stringify(original)), scope)), original);
  assert.throws(() => api.readLosingCampaignFile(original, "b".repeat(64)), /different workspace/);
});

test("raw envelopes, credentials, form restoration and unknown versions are rejected", () => {
  for (const key of ["model", "formInputs", "attemptedSave", "currentUser", "provider", "billing", "token", "operation"]) {
    assert.throws(() => api.readLosingCampaignFile({ ...file(), [key]: "secret-sentinel" }, scope));
  }
  assert.throws(() => api.readLosingCampaignFile({ model: source(), formInputs: {} }, scope));
  assert.throws(() => api.readLosingCampaignFile({ ...file(), schemaVersion: "unknown" }, scope));
  assert.throws(() => api.readLosingCampaignFile(JSON.parse('{"__proto__":{},"schemaVersion":"bad"}'), scope));
});

test("file cannot carry operational fields, evidence or media into the trusted projection", () => {
  for (const key of ["id", "evidenceSnapshot", "proof", "approvedAt", "ownerUserId", "workspaceId", "status", "createdAt"]) {
    const input = file(); input.campaign[key] = "ignored-is-not-accepted";
    assert.throws(() => api.readLosingCampaignFile(input, scope));
  }
  for (const key of ["id", "campaignId", "status", "scheduledFor", "queuedAt", "receipt", "approvalConfirmedAt", "media", "destination"]) {
    const input = file(); input.campaign.variants[0][key] = "not-accepted";
    assert.throws(() => api.readLosingCampaignFile(input, scope));
  }
});

test("all copied variants have fresh deterministic IDs and only unapproved draft state", () => {
  const input = file(), before = structuredClone(input), created = plain(api.losingCampaignDraft(input, "2026-09-06T12:00:00Z"));
  assert.notEqual(created.id, input.sourceCampaignId);
  assert.equal(created.id, "camp-copy-" + copyId);
  assert.notEqual(created.variants[0].id, source().variants[0].id);
  assert.equal(created.variants[0].campaignId, created.id);
  assert.equal(created.variants[0].status, "draft");
  assert.ok(!("evidenceSnapshot" in created)); assert.ok(!("approvedAt" in created.variants[0]));
  assert.equal(api.losingCampaignDraft(input, "later").id, created.id);
  assert.deepEqual(input, before);
});

test("malformed identities, executable/credential URLs, oversized text and invalid collections reject", () => {
  for (const copy of ["old-id", "__proto__", "abcdef12-3456-1789-8abc-123456789abc"]) assert.throws(() => api.readLosingCampaignFile({ ...file(), copyId: copy }, scope));
  for (const url of ["javascript:alert(1)", "https://user:secret@example.test", "not a url"]) assert.throws(() => api.losingCampaignProjection({ ...source(), destinationUrl: url }));
  assert.throws(() => api.losingCampaignProjection({ ...source(), brief: "x".repeat(100001) }));
  assert.throws(() => api.losingCampaignProjection({ ...source(), variants: {} }));
  assert.throws(() => api.losingCampaignProjection({ ...source(), variants: Array(201).fill(source().variants[0]) }));
  assert.throws(() => api.losingCampaignProjection({ ...source(), variants: [{ platform: "<img>", copy: "text" }] }));
  const oversized = file(); oversized.campaign.variants = Array.from({ length: 30 }, () => ({ platform: "facebook", copy: "x".repeat(100000) }));
  assert.throws(() => api.readLosingCampaignFile(oversized, scope), /exceeds 2 MB/);
});

test("whole inline script parses and dedicated modal has an independent scroll body and footer", () => {
  const script = html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g).find(item => item.includes("function createLosingCampaign"));
  new vm.Script(script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""));
  assert.ok(html.includes('grid-template-rows:auto minmax(0,1fr) auto'));
  assert.ok(html.includes('document.body.append($("#losingCampaignDialog"))'));
  assert.ok(!html.includes('exportJson("Social-Cues-unsaved-draft.json"'));
});
