import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import vm from "node:vm";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";

const test = process.argv[1] === fileURLToPath(import.meta.url) ? nodeTest : () => {};

export const html = await readFile(new URL("./social-cues-app.html", import.meta.url), "utf8");
const start = html.indexOf("// Posting pack: pure projection and text serialization.");
const end = html.indexOf("// End posting pack pure helpers.", start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({ URL });
vm.runInContext(html.slice(start, end), context);
export const build = campaign => JSON.parse(JSON.stringify(context.buildPostingPack(campaign)));
export const fixture = {
  id: "pilot-001", title: "Social Cues pilot",
  privateAccount: { token: "never-export-account-token" },
  variants: [
    { id: "post-approved", platform: "facebook", status: "approved", copy: 'First line, "approved".\n\nSecond line.\r\n#SocialCues',
      scheduledFor: "2026-09-08T09:30:00-04:00", media: { name: "pilot-master.mp4", publicUrl: "https://media.example.test/pilot-master.mp4", accessToken: "never-export-media-token" } },
    { id: "post-queued", platform: "linkedin", status: "queued", copy: "Ready for manual review.\nNo schedule assigned.",
      media: { name: "pilot-image.png", url: "https://media.example.test/pilot-image.png?signature=never-export-signed-link" } },
    { id: "post-formula", platform: "threads", status: "approved", copy: "=This is approved copy, not a formula",
      scheduledFor: "2026-09-09T10:15", media: { url: "blob:local-preview" } },
    { id: "post-draft", platform: "facebook", status: "draft", copy: "DRAFT-EXCLUDED" },
    { id: "post-other", campaignId: "different-campaign", platform: "facebook", status: "approved", copy: "OTHER-CAMPAIGN-EXCLUDED" },
    { id: "post-published", platform: "threads", status: "published", copy: "PUBLISHED-EXCLUDED" }
  ]
};

// Independent CSV reader: quotes, doubled quotes, commas and embedded line endings.
export function parseCsv(source) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  source = source.replace(/^\ufeff/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (!quoted && char === ",") { row.push(cell); cell = ""; }
    else if (!quoted && (char === "\r" || char === "\n")) {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  assert.equal(quoted, false, "CSV quote enclosure");
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

test("all inline application JavaScript remains syntactically valid", () => {
  for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
});
test("exports only approved/queued active-campaign variants and explicit fields", () => {
  const result = build(fixture);
  assert.deepEqual(result.posts.map(p => p.variantId), ["post-approved", "post-queued", "post-formula"]);
  for (const sentinel of ["never-export", "DRAFT-EXCLUDED", "OTHER-CAMPAIGN-EXCLUDED", "PUBLISHED-EXCLUDED"]) {
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  }
  assert.deepEqual(Object.keys(result.posts[0]), ["campaignId", "campaignTitle", "variantId", "platform", "copy", "date", "time", "timezone", "media", "status"]);
});
test("copy, multiline text, commas and quotes survive both formats", () => {
  const result = build(fixture);
  assert.ok(result.markdown.includes(fixture.variants[0].copy));
  assert.equal(parseCsv(result.csv)[1][4], fixture.variants[0].copy);
  assert.equal(parseCsv(result.csv)[2][4], fixture.variants[1].copy);
  assert.ok(parseCsv(result.csv).every(row => row.length === 14));
});
test("known offsets export UTC and unzoned times remain explicitly unknown", () => {
  const result = build(fixture);
  assert.deepEqual([result.posts[0].date, result.posts[0].time, result.posts[0].timezone], ["2026-09-08", "13:30:00.000", "UTC"]);
  assert.deepEqual([result.posts[2].date, result.posts[2].time, result.posts[2].timezone], ["2026-09-09", "10:15", "Not recorded"]);
});
test("missing and invalid schedules are labelled, never invented", () => {
  for (const scheduledFor of [undefined, "", "tomorrow", "2026-02-31T10:15Z", "2026-09-08T25:00Z", "2026-09-08T10:99", "2026-09-08T10:00:99Z"]) {
    const result = build({ ...fixture, variants: [{ ...fixture.variants[0], scheduledFor }] });
    assert.deepEqual([result.posts[0].date, result.posts[0].time, result.posts[0].timezone], ["Not scheduled", "Not scheduled", "Not recorded"]);
  }
});
test("formula-like CSV cells are inert; Markdown retains exact copy", () => {
  for (const copy of ["=1+2", "+SUM(A1)", "-1+2", "@value", "  =1", "\tvalue", "\nvalue", "\rvalue", "\u0001=1"]) {
    const result = build({ ...fixture, variants: [{ ...fixture.variants[0], copy }] });
    assert.equal(parseCsv(result.csv)[1][4], "'" + copy);
    assert.ok(result.markdown.includes(copy));
  }
});
test("formula protection covers every exported field", () => {
  const result = build({ id: "=campaign", title: "@title", variants: [{ id: "+post", platform: "-platform", status: "approved", copy: "plain" }] });
  assert.deepEqual(parseCsv(result.csv)[1].slice(0, 5), ["'=campaign", "'@title", "'+post", "'-platform", "plain"]);
});
test("private, signed, local and credential-bearing media URLs are omitted whole", () => {
  for (const url of ["https://x.example/a?token=private-value", "https://x.example/a#private-value", "https://u:p@x.example/a", "https://x.example/storage/v1/object/sign/a", "https://x.example/storage/v1/object/authenticated/a", "https://x.example/api/media/a", "https://x.example/private/a", "https://intranet/a", "https://localhost/a", "https://127.0.0.1/a", "https://[::1]/a", "data:image/png;base64,local", "blob:local", "/api/media/private/a", "file:///C:/private/a"]) {
    const result = build({ ...fixture, variants: [{ ...fixture.variants[0], media: { url } }] });
    assert.deepEqual(result.posts[0].media, []);
  }
});
test("operator filenames and public media references are deduplicated", () => {
  const result = build({ ...fixture, variants: [{ ...fixture.variants[0], videoUrl: fixture.variants[0].media.publicUrl }] });
  assert.deepEqual(result.posts[0].media, ["File: pilot-master.mp4", "https://media.example.test/pilot-master.mp4"]);
});
test("Markdown treats user text as literal, including embedded code fences", () => {
  const tick = String.fromCharCode(96);
  const copy = tick.repeat(3) + "\n<script>not executable</script>\n" + tick.repeat(5);
  const result = build({ ...fixture, variants: [{ ...fixture.variants[0], copy }] });
  assert.ok(result.markdown.includes(tick.repeat(6) + "\n" + copy + "\n" + tick.repeat(6)));
});
test("empty campaign downloads contain a clear empty state and CSV headers only", () => {
  for (const campaign of [null, { id: "empty", title: "Empty", variants: [] }, { ...fixture, variants: [fixture.variants[3]] }]) {
    const result = build(campaign);
    assert.equal(result.posts.length, 0);
    assert.equal(parseCsv(result.csv).length, 1);
    assert.match(result.markdown, /No approved or queued posts in the active campaign/);
  }
});
test("exports never mutate campaign, approvals, queue or proof", () => {
  const before = JSON.stringify(fixture);
  function freeze(value) { Object.values(value).filter(v => v && typeof v === "object").forEach(freeze); Object.freeze(value); }
  freeze(fixture);
  build(fixture); build(fixture);
  assert.equal(JSON.stringify(fixture), before);
});
test("manual evidence columns begin blank and checklist makes no publishing claim", () => {
  const result = build(fixture);
  for (const row of parseCsv(result.csv).slice(1)) assert.deepEqual(row.slice(10), ["", "", "", ""]);
  assert.match(result.markdown, /This export does not post or change approval\/queue status/);
  assert.match(result.markdown, /avoid duplicate delivery/);
  assert.match(result.markdown, /Open Results from Plan and delivery/);
  assert.match(result.markdown, /Leave unknown results blank/);
});
test("source wiring retains JSON backup and isolates the download from persistence/network", () => {
  assert.match(html, /id="exportContent">Export content bundle \(JSON\)/);
  assert.match(html, /function exportContent\(\)/);
  const download = html.slice(html.indexOf("function exportPostingPack("), html.indexOf("function exportJson("));
  assert.equal(/fetch\(|saveModel\(|setStatus\(|\.status\s*=/.test(download), false);
  for (const id of ["exportPostingMarkdown", "exportPostingCsv"]) assert.ok(html.includes('$("#' + id + '").addEventListener("click"'));
});
test("writes synthetic sample output for operator inspection", async () => {
  const dir = new URL("./test-results/posting-pack/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const result = build(fixture);
  await writeFile(new URL("sample-posting-pack.md", dir), result.markdown);
  await writeFile(new URL("sample-posting-calendar.csv", dir), "\ufeff" + result.csv);
});
