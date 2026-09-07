import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit } from "playwright";
import { createLocalPilot, projectRoot, syntheticPromoCode, syntheticSecondPromoCode } from "./scripts/run-local-pilot.mjs";

const output = path.join(projectRoot, ".tmp", "p13-browser-" + Date.now());
await mkdir(output, { recursive: true });
const pilot = await createLocalPilot();
const email = "p13-" + randomUUID() + "@example.test", password = "Synthetic-only-" + randomUUID() + "!";
const evidence = { checks: 0, applicationRoutesMocked: false, phases: [], requests: [], externalBrowserBlocked: 0,
  injectedFailures: ["Suppress a successful local import response once", "Hold then suppress a successful normal queued save",
    "Change in-page workspace context while a real review GET is held", "Remove in-page conditional capability"], cleanupComplete: false };
const check = (ok, label) => { assert.ok(ok, label); evidence.checks++; };
const equal = (a, b) => { assert.deepEqual(a, b); evidence.checks++; };
const phase = label => { evidence.phases.push(label); console.log("P13: " + label); };
const settle = page => page.evaluate(async () => { await hostedModelSaveChain.catch(() => {}); });
const current = page => page.evaluate(async () => (await authedFetch("/api/model")).json());
const bytes = () => readFile(path.join(pilot.dataDir, "model.json"));
const state = (page, expected) => page.waitForFunction(value => document.querySelector("#manualCsvStatus").dataset.state === value && !manualCsvState.busy, expected);
const results = page => page.evaluate(() => jump("proof"));
const select = (page, index) => page.locator('[data-csv-select="' + index + '"]').check();
const confirm = async page => { await page.locator("#confirmManualCsv").click(); await page.waitForFunction(() => !document.querySelector("#manualCsvDialog").open); };
const open = async (page, file, expected = "review") => {
  await results(page); const chooser = page.waitForEvent("filechooser"); await page.locator("#importManualCsv").click();
  await (await chooser).setFiles(file); await state(page, expected);
};
const columns = ["campaignId", "variantId", "postedUrl", "postedLocal", "postedTimezone", "metric", "metricValue", "observedLocal", "observedTimezone", "note"];
const csv = rows => "\uFEFF" + [columns, ...rows].map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(",")).join("\r\n") + "\r\n";
const file = async (name, rows) => { const target = path.join(output, name); await writeFile(target, csv(rows)); return target; };
const signup = async (page, address, promo) => {
  await page.goto(pilot.url + "/portal?stay=1"); await page.locator("#createBtn").click();
  await page.locator("#nameInput").fill("Synthetic P13"); await page.locator("#emailInput").fill(address);
  await page.locator("#passwordInput").fill(password); await page.locator("#promoInput").fill(promo);
  await page.locator("#createBtn").click(); await page.waitForURL(/\/app/); await page.waitForLoadState("networkidle");
  await page.locator("#businessNameInput").fill("Synthetic CSV pilot"); await page.locator("#websiteInput").fill("https://example.test/p13");
  await page.locator("#completeOnboarding").click(); await page.waitForFunction(() => !document.body.classList.contains("onboarding-scene")); await settle(page);
};
let desktop, mobile, ca, cb, cc, a, b, c, failure;
try {
  await pilot.start(); desktop = await chromium.launch({ headless: true }); mobile = await webkit.launch({ headless: true });
  const context = async (browser, client, viewport) => {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin === pilot.url) return route.continue();
      evidence.externalBrowserBlocked++; return route.abort();
    });
    context.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/model") {
        const body = request.postDataJSON(); evidence.requests.push({ client, operationId: body.operationId,
          expectedRevision: body.expectedRevision, sha256: createHash("sha256").update(request.postData()).digest("hex") });
      }
    });
    return context;
  };
  ca = await context(desktop, "A", { width: 1440, height: 1000 }); cb = await context(mobile, "B", { width: 390, height: 844 });
  a = await ca.newPage(); b = await cb.newPage();
  phase("fresh actual signup and saved campaign, queue and frozen evidence fixtures");
  await signup(a, email, syntheticPromoCode);
  await a.evaluate(async () => {
    const campaign = { id: "synthetic-p13-campaign", title: "Synthetic CSV campaign", brief: "Retained original brief", variants: [
      { id: "synthetic-p13-facebook", platform: "facebook", copy: "Retained approved copy", status: "approved", approvedAt: "2026-09-01T12:00:00Z", tags: [], flags: [] },
      { id: "synthetic-p13-linkedin", platform: "linkedin", copy: "Retained draft copy", status: "draft", tags: [], flags: [] }
    ] };
    model.campaigns = [campaign]; model.activeCampaignId = campaign.id;
    model.proof = [{ id: "synthetic-p13-existing", source: "manual", schemaVersion: "social-cues.manual-proof.v1", type: "posting-receipt",
      campaignId: campaign.id, campaignTitle: campaign.title, variantId: campaign.variants[0].id, platform: "facebook",
      postedUrl: "https://example.test/existing", postedAt: "2026-09-01T10:00+00:00", postedTimezone: "+00:00",
      metric: "", metricValue: "", observedAt: "", observedTimezone: "", note: "Already saved", createdAt: "2026-09-02T12:00:00Z", updatedAt: "2026-09-02T12:00:00Z" },
      { id: "synthetic-p13-legacy", type: "action", note: "Untouched legacy evidence" }];
    campaign.evidenceSnapshot = buildSelfLaunchEvidence(model.proof, [model.proof[0].id], "2026-09-03T12:00:00Z");
    model.publishQueue = [{ id: "synthetic-p13-queue", variantId: campaign.variants[0].id, status: "draft" }];
    await saveModel(); render();
  });
  await b.goto(pilot.url + "/portal?stay=1"); await b.locator("#emailInput").fill(email); await b.locator("#passwordInput").fill(password);
  await b.locator("#loginBtn").click(); await b.waitForURL(/\/app/); await b.waitForLoadState("networkidle");
  const initial = await current(b), campaignId = initial.activeCampaignId, variantId = initial.campaigns[0].variants[0].id;
  const row = (slug, overrides = {}) => columns.map(name => ({ campaignId, variantId, postedUrl: "https://example.test/" + slug,
    postedLocal: "2026-09-01T10:00", postedTimezone: "+00:00", metric: "", metricValue: "", observedLocal: "", observedTimezone: "", note: "", ...overrides })[name]);
  const quoted = 'Manual, "quoted"\r\n=1+1 <img src=x onerror=window.p13Executed=true>';
  const rows = [row("receipt", { note: quoted }), row("zero", { variantId: "synthetic-p13-linkedin", metric: "Views", metricValue: "0", observedLocal: "2026-09-02T10:00", observedTimezone: "+00:00" }),
    row("bad-url", { postedUrl: "http://example.test/unsafe" }), row("outsider", { campaignId: "not-this-workspace" }),
    row("partial", { metric: "Views", metricValue: "0" }), row("receipt", { note: quoted }), row("existing", { note: "Already saved" }), row("later-subset")];
  const mixed = await file("mixed.csv", rows);
  phase("template, every mixed row, mobile keyboard, explicit subset and cancel without writes");
  await results(b); const download = b.waitForEvent("download"); await b.locator("#manualCsvTemplate").click();
  const template = path.join(output, "template.csv"); await (await download).saveAs(template);
  check((await readFile(template, "utf8")).replace(/^\uFEFF/, "") === columns.join(",") + "\r\n", "download has exact empty template and no invented facts");
  const before = await bytes(), posts = evidence.requests.length;
  await open(b, mixed);
  check(await b.locator("[data-csv-row]").count() === rows.length, "every parsed row visible");
  check(await b.locator("#confirmManualCsv").isDisabled(), "selection starts empty");
  for (const index of [2, 3, 4, 5, 6]) check(await b.locator('[data-csv-select="' + index + '"]').isDisabled(), "invalid or duplicate row " + index + " disabled");
  check((await b.locator('[data-csv-row="5"]').innerText()).includes("Exact duplicate of CSV row 2"), "in-file duplicate named");
  check((await b.locator('[data-csv-row="6"]').innerText()).includes("Exact existing manual record"), "existing duplicate named");
  check((await b.locator('[data-csv-row="0"]').innerText()).includes(quoted.replaceAll("\r\n", "\n")), "quoted text survives review");
  check(!await b.evaluate(() => window.p13Executed) && await b.locator("#manualCsvRows img").count() === 0, "cell text is inert");
  await b.locator('[data-csv-select="0"]').focus(); await b.keyboard.press("Space");
  check(await b.locator('[data-csv-select="0"]').isChecked() && await b.locator('[data-csv-select="0"]').evaluate(el => el === document.activeElement), "keyboard toggles selection without losing focus");
  await b.locator("#refreshManualCsv").focus(); const reached = new Set();
  for (let n = 0; n < 4; n++) { reached.add(await b.evaluate(() => document.activeElement.id)); await b.keyboard.press("Tab"); }
  check(["refreshManualCsv", "confirmManualCsv", "cancelManualCsv"].every(id => reached.has(id)), "keyboard reaches footer actions");
  check(await b.locator("#manualCsvDialog .losing-footer button").evaluateAll(buttons => buttons.every(button => {
    const r = button.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  })), "mobile actions remain within viewport");
  await b.screenshot({ path: path.join(output, "mixed-mobile.png") }); await b.keyboard.press("Escape");
  check(!await b.locator("#manualCsvDialog").evaluate(el => el.open), "Escape cancels");
  check((await bytes()).equals(before) && evidence.requests.length === posts, "template review selection and cancel write nothing");
  await b.locator("#resumeManualCsv").click(); await select(b, 1); await confirm(b);
  const imported = await current(b), receipt = imported.proof.find(p => p.postedUrl === "https://example.test/receipt"), zero = imported.proof.find(p => p.postedUrl === "https://example.test/zero");
  check(imported.proof.length === initial.proof.length + 2 && !imported.proof.some(p => p.postedUrl === "https://example.test/later-subset"), "only explicit selected two appended");
  equal(imported.proof.slice(0, initial.proof.length), initial.proof); equal(imported.campaigns, initial.campaigns); equal(imported.publishQueue, initial.publishQueue);
  check(receipt.metricValue === "" && receipt.observedAt === "" && zero.metricValue === "0" && zero.platform === "linkedin", "unknown and measured zero distinct; platform derived");
  check([receipt, zero].every(p => p.source === "manual" && p.schemaVersion === "social-cues.manual-proof.v1"), "manual provenance persisted");

  phase("reload duplicate exclusion, ordinary editing and explicit evidence preview");
  await b.reload({ waitUntil: "networkidle" }); const duplicateBefore = await bytes(); await open(b, mixed);
  for (const index of [0, 1, 5, 6]) check(await b.locator('[data-csv-select="' + index + '"]').isDisabled(), "reload duplicate excluded " + index);
  check((await bytes()).equals(duplicateBefore), "repeat review cannot multiply records");
  await select(b, 7); await confirm(b); check((await current(b)).proof.length === imported.proof.length + 1, "new subset appends only remaining row");
  await b.locator('[data-edit-proof="' + zero.id + '"]').click(); await b.locator("#proofNoteInput").fill("Corrected synthetic operator note");
  await b.locator("#saveManualProof").click(); await b.waitForFunction(() => document.querySelector("#proofFeedback").dataset.state === "success"); await settle(b);
  const edited = await current(b), editedZero = edited.proof.find(p => p.id === zero.id);
  check(editedZero.note === "Corrected synthetic operator note" && editedZero.source === "manual" && editedZero.metricValue === "0", "ordinary editor preserves manual identity and zero");
  equal(edited.campaigns, initial.campaigns);
  const previewBefore = await bytes(), previewPosts = evidence.requests.length;
  await b.locator('[data-evidence-proof="' + zero.id + '"]').check(); await b.locator("#previewSelfLaunch").click();
  check((await b.locator("#selfLaunchPreviewText").textContent()).includes("Corrected synthetic operator note"), "import explicitly selectable in evidence preview");
  check((await bytes()).equals(previewBefore) && evidence.requests.length === previewPosts, "evidence preview creates no campaign or save");

  phase("further-client conflict retains CSV and exact lost response retry reconciles");
  const conflictFile = await file("conflict.csv", [row("conflict")]); await open(b, conflictFile); await select(b, 0);
  await a.reload({ waitUntil: "networkidle" }); await a.evaluate(async () => { activeCampaign().brief = "Further client winner"; await saveModel(); }); await settle(a);
  const winner = await current(a); await b.locator("#confirmManualCsv").click(); await state(b, "conflict");
  equal((await current(a)).proof, winner.proof);
  check((await b.locator("#manualCsvRows").textContent()).includes("https://example.test/conflict"), "stale conflict retains original CSV");
  await b.locator("#refreshManualCsv").click(); await state(b, "review");
  await b.evaluate(() => {
    const original = window.fetch; let suppress = true;
    window.fetch = async (...args) => { const response = await original(...args);
      if (suppress && String(args[0]).endsWith("/api/model") && args[1]?.method === "POST" && response.ok) {
        suppress = false; await response.clone().text(); throw new TypeError("Synthetic lost import response");
      } return response; };
  });
  const start = evidence.requests.length; await b.locator("#confirmManualCsv").click(); await state(b, "unknown");
  check(await b.locator("#refreshManualCsv").isDisabled() && await b.locator('[data-csv-select="0"]').isDisabled(), "unknown forbids new intent");
  await b.locator("#cancelManualCsv").click(); await b.locator("#importManualCsv").click(); await state(b, "unknown"); await confirm(b);
  const retried = evidence.requests.slice(start);
  check(retried.length === 2 && retried[0].operationId === retried[1].operationId && retried[0].sha256 === retried[1].sha256, "identical operation and request retried");
  const resolved = await current(b); check(resolved.proof.filter(p => p.postedUrl === "https://example.test/conflict").length === 1, "lost response retry appends once");
  equal(resolved.campaigns, winner.campaigns); equal(resolved.publishQueue, winner.publishQueue);

  phase("normal queue unknown blocks CSV and preserves the original pending operation");
  const pendingFile = await file("pending.csv", [row("after-normal")]); await open(b, pendingFile); await select(b, 0);
  await b.evaluate(() => {
    const original = window.fetch; let held = false;
    window.fetch = async (...args) => { const response = await original(...args);
      if (!held && String(args[0]).endsWith("/api/model") && args[1]?.method === "POST" && response.ok) {
        held = true; await response.clone().text(); window.p13Held = true;
        await new Promise(resolve => { window.p13Release = resolve; }); throw new TypeError("Synthetic lost normal response");
      } return response; };
    const snapshot = sanitizedModelSnapshot(model); snapshot.campaigns[0].brief = "Normal queued winner";
    window.p13Normal = enqueueHostedModelSave(snapshot).catch(error => error.message);
  });
  await b.waitForFunction(() => window.p13Held); const normalStart = evidence.requests.length - 1;
  await b.locator("#confirmManualCsv").click(); await b.waitForFunction(() => manualCsvState.busy);
  check(evidence.requests.length === normalStart + 1, "import waits for normal save");
  await b.evaluate(() => window.p13Release()); await state(b, "pending");
  check(await b.evaluate(() => workspaceSaveState.blocked === "unknown" && manualCsvState.operation === null), "CSV cannot replace unresolved normal operation");
  check(await b.locator("#confirmManualCsv").isDisabled() && evidence.requests.length === normalStart + 1, "no second save while original unknown");
  await b.locator("#cancelManualCsv").click(); await b.locator("#retryWorkspaceSave").click();
  await b.waitForFunction(() => workspaceSaveState.pending === null && workspaceSaveState.blocked === "conflict");
  const normalRetry = evidence.requests.slice(normalStart); check(normalRetry.length === 2 && normalRetry[0].sha256 === normalRetry[1].sha256, "normal operation reconciled identically");
  await b.locator("#resumeManualCsv").click(); await b.locator("#refreshManualCsv").click(); await state(b, "review"); await confirm(b);
  check((await current(b)).campaigns[0].brief === "Normal queued winner", "CSV preserves confirmed normal winner");

  phase("context change during review and unavailable capability fail closed");
  const contextFile = await file("context.csv", [row("context")]);
  await b.evaluate(() => {
    const original = window.fetch; let hold = true;
    window.fetch = async (...args) => { const response = await original(...args);
      if (hold && String(args[0]).endsWith("/api/model") && !args[1]?.method) {
        hold = false; window.p13ReviewHeld = true; await new Promise(resolve => { window.p13ReviewRelease = resolve; });
      } return response; };
  });
  await results(b); const chooseContext = b.waitForEvent("filechooser"); await b.locator("#importManualCsv").click(); await (await chooseContext).setFiles(contextFile);
  await b.waitForFunction(() => window.p13ReviewHeld); const contextPosts = evidence.requests.length, contextBytes = await bytes();
  await b.evaluate(() => { window.p13OriginalWorkspace = model.workspace.id; model.workspace.id = "synthetic-different-context"; window.p13ReviewRelease(); });
  await state(b, "error"); check(await b.locator("#confirmManualCsv").isDisabled() && await b.locator("[data-csv-row]").count() === 0, "changed context hides rows and disables import");
  check((await bytes()).equals(contextBytes) && evidence.requests.length === contextPosts, "context change sends no write");
  await b.evaluate(() => { model.workspace.id = window.p13OriginalWorkspace; renderManualCsv(); });
  await b.locator("#refreshManualCsv").click(); await state(b, "review"); await select(b, 0);
  await b.evaluate(() => { model.persistence.conditionalSave = false; renderManualCsv(); });
  check(await b.locator("#confirmManualCsv").isDisabled(), "missing conditional capability disables confirmation");
  await b.locator("#cancelManualCsv").click(); await b.reload({ waitUntil: "networkidle" });
  cc = await context(desktop, "C", { width: 1200, height: 900 }); c = await cc.newPage();
  await signup(c, "p13-other-" + randomUUID() + "@example.test", syntheticSecondPromoCode);
  const otherBytes = await bytes(), otherPosts = evidence.requests.length; await open(c, mixed);
  check(await c.locator("#confirmManualCsv").isDisabled() && await c.locator("[data-csv-select]:not(:disabled)").count() === 0, "other actual workspace cannot map these campaign IDs");
  check((await bytes()).equals(otherBytes) && evidence.requests.length === otherPosts, "other workspace preview writes nothing");
  await c.locator("#cancelManualCsv").click();

  phase("server restart retains imported manual records and frozen snapshots");
  const beforeRestart = await current(b); await pilot.restart(); await b.reload({ waitUntil: "networkidle" }); const afterRestart = await current(b);
  equal(afterRestart.proof, beforeRestart.proof); equal(afterRestart.campaigns, beforeRestart.campaigns); equal(afterRestart.publishQueue, beforeRestart.publishQueue);
  await open(b, conflictFile); check(await b.locator('[data-csv-select="0"]').isDisabled(), "restart reimport still detects saved exact receipt");
  await b.locator("#cancelManualCsv").click(); await results(a); await a.screenshot({ path: path.join(output, "results-desktop.png") });
  check(await b.evaluate(() => localStorage.getItem(STORAGE_KEY) === null && localStorage.getItem(LEGACY_STORAGE_KEY) === null), "private CSV facts not cached in browser model storage");
  await writeFile(path.join(pilot.dataDir, "pilot-access.json"), JSON.stringify({ email, password }, null, 2), { flag: "wx" });
  evidence.pilotUrl = pilot.url; evidence.importedIds = afterRestart.proof.filter(p => p.id.startsWith("manual-proof-import-")).map(p => p.id);
} catch (error) { failure = error; }
finally {
  await ca?.close(); await cb?.close(); await cc?.close(); await desktop?.close(); await mobile?.close(); await pilot.stop();
  const summary = await pilot.summary(); evidence.dataDir = pilot.dataDir; evidence.server = summary;
  const absent = async name => access(path.join(pilot.dataDir, name)).then(() => false, error => { if (error.code === "ENOENT") return true; throw error; });
  evidence.cleanupComplete = !summary.running && await absent("pilot.lock") && await absent(".workspace-content.lock");
  try { check(evidence.cleanupComplete && summary.externalProviderRequestsDispatched === 0 && summary.blockedProviderAttempts === 0, "processes stopped, locks absent and zero provider dispatch or attempts"); }
  catch (error) { failure ||= error; }
  evidence.ok = !failure; if (failure) evidence.failure = failure.message;
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ ok: !failure, checks: evidence.checks, output, dataDir: pilot.dataDir, cleanupComplete: evidence.cleanupComplete }));
if (failure) throw failure;
