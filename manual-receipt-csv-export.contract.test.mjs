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
const api = vm.runInContext("({manualCsvColumns,manualCsvExportMarker,manualCsvLiteralPrefix,parseManualReceiptCsv,"
  + "reviewManualReceiptRows,manualReceiptFactKey,manualCsvCellNeedsEscape,manualCsvEncodeExportCell,"
  + "manualCsvDecodeExportCell,manualReceiptExportInput,projectManualReceiptExport,manualReceiptExportCsv})", context);
const columns = Array.from(api.manualCsvColumns), now = Date.parse("2026-09-06T12:00:00Z");
const campaigns = [{ id: "campaign-a", title: "Synthetic campaign", variants: [
  { id: "variant-a", campaignId: "campaign-a", platform: "facebook", status: "approved" },
  { id: "variant-b", campaignId: "campaign-a", platform: "linkedin", status: "draft" }
] }];
const input = { campaignId: "campaign-a", variantId: "variant-a", postedUrl: "https://example.test/post-1",
  postedLocal: "2026-09-01T10:00:00", postedTimezone: "-04:00", metric: "", metricValue: "",
  observedLocal: "", observedTimezone: "", note: '=HYPERLINK("https://example.test","quoted, text")\nsecond line' };
const cells = patch => columns.map(name => ({ ...input, ...patch })[name]);
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
const unmarked = rows => columns.join(",") + "\r\n" + rows.map(row => row.map(quote).join(",")).join("\r\n") + "\r\n";
const review = (rows, proof = []) => api.reviewManualReceiptRows(rows, campaigns, proof, now);
const receipt = { ...review([cells({})])[0].entry, id: "manual-receipt" };
const observed = { ...review([cells({ variantId: "variant-b", postedUrl: "https://example.test/zero", metric: "@Views",
  metricValue: "0", observedLocal: "2026-09-02T10:00", observedTimezone: "+00:00", note: "+quoted, \"note\"\nline two" })])[0].entry,
  id: "manual-zero" };

test("projection includes only current associated exact manual records with explicit reasons", () => {
  const proof = [receipt, observed,
    { id: "legacy", type: "action", note: "Legacy private text" },
    { id: "provider", type: "Provider banked", metric: "Meta provider banked", note: "private-provider-receipt" },
    { ...receipt, id: "unassociated", campaignId: "missing" },
    { ...receipt, id: "nonroundtrip", platform: "wrong-platform" }];
  const before = JSON.stringify({ proof, campaigns });
  const result = api.projectManualReceiptExport(proof, campaigns, now);
  assert.deepEqual(Array.from(result.eligible, row => row.id), ["manual-receipt", "manual-zero"]);
  assert.equal(result.excluded.length, 4);
  assert.match(result.excluded.map(item => item.reason).join(" "), /Legacy evidence/);
  assert.match(result.excluded.map(item => item.reason).join(" "), /Provider-derived/);
  assert.match(result.excluded.map(item => item.reason).join(" "), /current-workspace/);
  assert.match(result.excluded.map(item => item.reason).join(" "), /round-trip exactly/);
  assert.equal(JSON.stringify({ proof, campaigns }), before);
  assert.ok(result.excluded.every(item => !Object.hasOwn(item, "entry") && !Object.hasOwn(item, "input")));
});

test("versioned export round-trips exact manual facts including quoting blank and zero", () => {
  const projected = api.projectManualReceiptExport([receipt, observed], campaigns, now).eligible;
  const output = api.manualReceiptExportCsv(projected);
  assert.ok(output.startsWith("\uFEFF\"" + api.manualCsvExportMarker + "\"\r\n"));
  const parsed = api.parseManualReceiptCsv(output), imported = review(parsed);
  assert.equal(parsed.length, 2); assert.ok(imported.every(row => row.eligible));
  assert.deepEqual(imported.map(row => api.manualReceiptFactKey(row.entry)), projected.map(row => api.manualReceiptFactKey(row.entry)));
  assert.equal(parsed[0][5], ""); assert.equal(parsed[0][6], "");
  assert.equal(parsed[1][5], "@Views"); assert.equal(parsed[1][6], "0");
  assert.equal(parsed[0][9], receipt.note); assert.equal(parsed[1][9], observed.note);
});

test("app marker binds reversible formula protection while external CSV behavior is unchanged", () => {
  for (const value of ["=SUM(1,2)", "+cmd", "-formula", "@formula", "  =formula", api.manualCsvLiteralPrefix + "natural"]) {
    const encoded = api.manualCsvEncodeExportCell(value);
    assert.ok(encoded.startsWith(api.manualCsvLiteralPrefix));
    assert.equal(api.manualCsvDecodeExportCell(encoded), value);
  }
  const external = api.parseManualReceiptCsv(unmarked([cells({ metric: "=external formula", note: api.manualCsvLiteralPrefix + "external" })]));
  assert.equal(external[0][5], "=external formula");
  assert.equal(external[0][9], api.manualCsvLiteralPrefix + "external");
});

test("malformed markers and marker-bound escape violations reject", () => {
  const header = columns.map(quote).join(","), marked = quote(api.manualCsvExportMarker) + "\r\n" + header + "\r\n";
  assert.throws(() => api.parseManualReceiptCsv(quote("social-cues-manual-receipts-export.v2") + "\r\n" + header));
  assert.throws(() => api.parseManualReceiptCsv(marked + cells({ metric: "=unescaped" }).map(quote).join(",")));
  assert.throws(() => api.parseManualReceiptCsv(marked + cells({ note: "'social-cues-literal.v2:value" }).map(quote).join(",")));
  assert.throws(() => api.parseManualReceiptCsv(marked + cells({ note: api.manualCsvLiteralPrefix + "ordinary safe text" }).map(quote).join(",")));
  assert.throws(() => api.manualCsvDecodeExportCell(api.manualCsvLiteralPrefix));
});

test("export stays within the import bounds and selection limit", () => {
  const row = api.projectManualReceiptExport([receipt], campaigns, now).eligible[0];
  assert.throws(() => api.manualReceiptExportCsv([]));
  assert.throws(() => api.manualReceiptExportCsv(Array.from({ length: 201 }, () => row)));
  const twoHundred = api.manualReceiptExportCsv(Array.from({ length: 200 }, (_, index) => ({ ...row,
    input: { ...row.input, postedUrl: "https://example.test/post-" + index } })));
  assert.equal(api.parseManualReceiptCsv(twoHundred).length, 200);
});

test("export input derives local wall times without exporting record metadata", () => {
  const value = api.manualReceiptExportInput({ ...observed, accountId: "private", providerReceipt: "private", createdAt: "private" });
  assert.deepEqual(Object.keys(value), columns);
  assert.equal(value.postedLocal, "2026-09-01T10:00:00");
  assert.equal(value.observedLocal, "2026-09-02T10:00");
  assert.equal(value.metricValue, "0");
  assert.ok(!JSON.stringify(value).includes("private"));
});

test("exact reimport review excludes the exported records as existing duplicates", () => {
  const projected = api.projectManualReceiptExport([receipt, observed], campaigns, now).eligible;
  const parsed = api.parseManualReceiptCsv(api.manualReceiptExportCsv(projected));
  const rows = review(parsed, [receipt, observed]);
  assert.ok(rows.every(row => !row.eligible && row.duplicate === "Exact existing manual record"));
});

test("complete source uses a text-only read-only reviewed export boundary", () => {
  for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const controller = block("const manualCsvExportState =", "const manualProofState =");
  assert.ok(controller.includes('await afterWorkspaceSaves('));
  assert.ok(controller.includes('authedFetch("/api/model")'));
  assert.ok(controller.includes("fields.textContent"));
  assert.ok(controller.includes("manualReceiptExportCsv(records)"));
  assert.ok(controller.includes("Download uses this reviewed snapshot"));
  for (const forbidden of ["sendWorkspaceSave", "saveModel(", "persistModelSnapshot", "innerHTML", 'fetch("https']) assert.ok(!controller.includes(forbidden));
  assert.ok(!controller.includes("conditionalSave"));
  assert.ok(html.includes('["\\uFEFF" + manualCsvColumns.join(",") + "\\r\\n"]'));
});
