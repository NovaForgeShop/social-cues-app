import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./social-cues-app.html", import.meta.url), "utf8");
const block = (start, end) => {
  const first = html.indexOf(start), last = html.indexOf(end, first);
  assert.ok(first >= 0 && last > first); return html.slice(first, last);
};
const context = vm.createContext({ URL, TextEncoder });
vm.runInContext(block("// Posting pack: pure projection", "// End posting pack pure helpers.")
  + block("// Manual proof: pure validation", "// End manual proof pure helpers.")
  + block("// Manual receipt CSV: strict", "// End manual receipt CSV pure helpers."), context);
const api = vm.runInContext("({parseManualReceiptCsv,reviewManualReceiptRows,manualReceiptFactKey,manualCsvColumns})", context);
const columns = Array.from(api.manualCsvColumns);
const campaigns = [{ id: "campaign-a", title: "Synthetic campaign", variants: [{ id: "variant-a", campaignId: "campaign-a", platform: "facebook", status: "approved" }] },
  { id: "campaign-b", title: "Other campaign", variants: [{ id: "variant-b", campaignId: "campaign-b", platform: "linkedin", status: "draft" }] }];
const input = { campaignId: "campaign-a", variantId: "variant-a", postedUrl: "https://example.test/post-1", postedLocal: "2026-09-01T10:00:00",
  postedTimezone: "-04:00", metric: "", metricValue: "", observedLocal: "", observedTimezone: "", note: 'Operator, "quoted"\nsecond line' };
const cells = patch => columns.map(name => ({ ...input, ...patch })[name]);
const csv = rows => columns.join(",") + "\r\n" + rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(",")).join("\r\n") + "\r\n";
const review = (rows, proof = []) => JSON.parse(JSON.stringify(api.reviewManualReceiptRows(rows, campaigns, proof, Date.parse("2026-09-06T12:00:00Z"))));

test("BOM CRLF commas escaped quotes and multiline text parse without execution", () => {
  const raw = csv([cells({ note: '=HYPERLINK("https://example.test","text")\r\n<img src=x onerror=alert(1)>' })]);
  const parsed = JSON.parse(JSON.stringify(api.parseManualReceiptCsv("\uFEFF" + raw)));
  assert.equal(parsed.length, 1); assert.equal(parsed[0][9], '=HYPERLINK("https://example.test","text")\n<img src=x onerror=alert(1)>');
  assert.equal(review(parsed)[0].eligible, true);
});

test("template header is exact; unsupported columns, order, versions and raw JSON reject", () => {
  assert.deepEqual(Array.from(api.parseManualReceiptCsv(columns.join(",") + "\r\n")), []);
  for (const raw of ["{}", "campaignId,variantId\n", columns.slice().reverse().join(","),
    columns.join(",") + ",platform\n", columns.join(",").replace("note", "token")]) assert.throws(() => api.parseManualReceiptCsv(raw));
});

test("malformed quote sequences reject rather than silently shifting associations", () => {
  for (const line of ['"unclosed', 'plain"quote,tail', '"closed"suffix,tail']) {
    assert.throws(() => api.parseManualReceiptCsv(columns.join(",") + "\n" + line));
  }
});

test("parser bounds bytes cells rows and columns", () => {
  assert.throws(() => api.parseManualReceiptCsv("x".repeat(1024 * 1024 + 1)));
  assert.throws(() => api.parseManualReceiptCsv(columns.join(",") + "\n" + "x".repeat(4001)));
  assert.throws(() => api.parseManualReceiptCsv(csv(Array.from({ length: 201 }, () => cells({})))));
  assert.throws(() => api.parseManualReceiptCsv(columns.join(",") + "\n" + Array(21).fill("").join(",")));
  assert.throws(() => api.parseManualReceiptCsv(columns.join(",") + "\n\0"));
});

test("row width errors remain visible without hiding adjacent valid rows", () => {
  const rows = api.parseManualReceiptCsv(csv([cells({}), cells({}).slice(0, 8), [...cells({}), "extra"]]));
  const result = review(rows);
  assert.equal(result[0].eligible, true);
  assert.equal(result[1].eligible, false); assert.match(result[1].errors.columns, /ten/);
  assert.equal(result[2].eligible, false); assert.equal(result[2].cells.at(-1), "extra");
});

test("association must exist in the current workspace and platform is derived", () => {
  const result = review([cells({}), cells({ variantId: "variant-b" }), cells({ campaignId: "foreign" }), cells({ campaignId: "", variantId: "" })]);
  assert.equal(result[0].entry.platform, "facebook");
  assert.ok(result.slice(1).every(row => !row.eligible));
  assert.equal(result[0].entry.source, "manual"); assert.equal(result[0].entry.schemaVersion, "social-cues.manual-proof.v1");
});

test("HTTPS dates offsets and measurement ordering reuse existing manual validation", () => {
  for (const patch of [{ postedUrl: "http://example.test/post" }, { postedUrl: "https://user:password@example.test/post" },
    { postedLocal: "2099-01-01T10:00" }, { postedLocal: "2026-02-30T10:00" }, { postedTimezone: "" },
    { metric: "Views", metricValue: "0", observedLocal: "2026-08-01T10:00", observedTimezone: "-04:00" },
    { metric: "Views", metricValue: "0", observedLocal: "2026-09-02T10:00", observedTimezone: "" }]) {
    assert.equal(review([cells(patch)])[0].eligible, false);
  }
});

test("blank observations remain unknown; complete zero is a measured manual value", () => {
  const result = review([cells({}), cells({ metric: "Views", metricValue: "0", observedLocal: "2026-09-02T10:00", observedTimezone: "-04:00" }), cells({ metricValue: "0" })]);
  assert.equal(result[0].entry.type, "posting-receipt"); assert.equal(result[0].entry.metricValue, "");
  assert.equal(result[1].entry.type, "observed-result"); assert.equal(result[1].entry.metricValue, "0");
  assert.equal(result[2].eligible, false);
});

test("exact existing and in-file duplicate facts ignore record IDs and metadata timestamps", () => {
  const existing = { ...review([cells({})])[0].entry, id: "prior", createdAt: "older", updatedAt: "older", campaignTitle: "Renamed" };
  const before = structuredClone(existing);
  const result = review([cells({}), cells({ note: "Different operator fact" }), cells({ note: "Different operator fact" })], [existing]);
  assert.equal(result[0].duplicate, "Exact existing manual record"); assert.equal(result[0].eligible, false);
  assert.equal(result[1].eligible, true); assert.match(result[2].duplicate, /CSV row 3/); assert.equal(result[2].eligible, false);
  assert.deepEqual(existing, before);
});

test("fact keys retain explicit associations, offsets, notes and zero versus blank", () => {
  const entry = review([cells({})])[0].entry, key = api.manualReceiptFactKey(entry);
  for (const patch of [{ variantId: "other" }, { note: "changed" }, { postedTimezone: "+00:00" }, { metricValue: "0" }]) {
    assert.notEqual(api.manualReceiptFactKey({ ...entry, ...patch }), key);
  }
  assert.equal(api.manualReceiptFactKey({ ...entry, metricValue: 0 }), api.manualReceiptFactKey({ ...entry, metricValue: "0" }));
});

test("review is a detached pure projection and never mutates records or campaigns", () => {
  const rows = [cells({})], before = JSON.stringify({ campaigns, rows });
  const result = review(rows);
  result[0].entry.note = "detached change";
  assert.equal(JSON.stringify({ campaigns, rows }), before);
  assert.ok(!("status" in result[0].entry)); assert.ok(!("approvedAt" in result[0].entry));
});

test("complete inline script parses and importer uses text-only rendering and conditional queue", () => {
  for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const controller = block("const manualCsvState =", "const manualProofState =");
  assert.ok(controller.includes("await afterWorkspaceSaves(")); assert.ok(controller.includes("await sendWorkspaceSave(state.operation)"));
  assert.ok(controller.includes("snapshot.proof.push(...records)")); assert.ok(controller.includes("fields.textContent"));
  assert.ok(!controller.includes("innerHTML")); assert.ok(!controller.includes('fetch("https'));
});
