import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { createLocalPilot, projectRoot, syntheticPromoCode } from "./scripts/run-local-pilot.mjs";

const output = path.join(projectRoot, ".tmp", "p11-two-context-" + Date.now());
await mkdir(output, { recursive: true });
const pilot = await createLocalPilot();
const evidence = { checks: 0, applicationRoutesMocked: false, injectedFailures: ["Browser suppresses one already received successful save response", "Deferred page save queue with a real intervening server read"],
  externalBrowserRequestsDispatched: 0, browserExternalBlocked: 0, phases: [], saveRequests: [], cleanupComplete: false };
const check = (condition, label) => { assert.ok(condition, label); evidence.checks++; };
const phase = label => { evidence.phases.push(label); console.log("P11 browser: " + label); };
const email = "p11-" + randomUUID() + "@example.test", password = "Synthetic-only-" + randomUUID() + "!";
let browser, ca, cb, a, b, failed;
const settle = page => page.evaluate(async () => { await hostedModelSaveChain.catch(() => {}); });
const getModel = page => page.evaluate(async () => (await authedFetch("/api/model")).json());
const choose = async (page, content) => {
  await page.locator('#nav [data-view="settings"]').click();
  const pending = page.waitForEvent("filechooser"); await page.locator("#importModelButton").click();
  await (await pending).setFiles({ name: "synthetic-recovery.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(content)) });
  await page.waitForFunction(() => document.querySelector("#recoveryFeedback").dataset.state === "preview");
};
const state = (page, expected) => page.waitForFunction(value => document.querySelector("#recoveryFeedback").dataset.state === value, expected);
const saveBrief = async (page, value) => {
  await page.locator('#nav [data-view="studio"]').click(); await page.locator('[data-studio-mode="campaign"]').click();
  await page.locator("#briefInput").fill(value);
  await page.locator("#saveCampaign").click(); await settle(page);
};
const diskBrief = async workspaceId => JSON.parse(await readFile(path.join(pilot.dataDir, "model.json"), "utf8")).workspaces[workspaceId].content.campaigns[0].brief;
try {
  await pilot.start(); browser = await chromium.launch({ headless: true });
  const context = async name => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    await ctx.route("**/*", route => {
      if (new URL(route.request().url()).origin === pilot.url) return route.continue();
      evidence.browserExternalBlocked++; return route.abort();
    });
    ctx.on("request", request => {
      if (new URL(request.url()).pathname === "/api/model" && request.method() === "POST") {
        const body = request.postDataJSON();
        evidence.saveRequests.push({ client: name, operationId: body.operationId, kind: body.kind,
          sha256: createHash("sha256").update(request.postData()).digest("hex") });
      }
    });
    return ctx;
  };
  ca = await context("A"); cb = await context("B"); a = await ca.newPage(); b = await cb.newPage();
  phase("fresh signup/onboarding and two actual sessions");
  await a.goto(pilot.url + "/portal?stay=1"); await a.locator("#createBtn").click();
  await a.locator("#nameInput").fill("Synthetic P11"); await a.locator("#emailInput").fill(email);
  await a.locator("#passwordInput").fill(password); await a.locator("#promoInput").fill(syntheticPromoCode);
  await a.locator("#createBtn").click(); await a.waitForURL(/\/app/); await a.waitForLoadState("networkidle");
  await a.locator("#businessNameInput").fill("Synthetic concurrency"); await a.locator("#websiteInput").fill("https://example.test/p11");
  await a.locator("#completeOnboarding").click(); await a.waitForFunction(() => !document.body.classList.contains("onboarding-scene")); await settle(a);
  await a.locator('#nav [data-view="studio"]').click(); await a.locator('[data-studio-mode="campaign"]').click();
  await a.locator("#newCampaign").click(); await a.locator("#campaignTitleInput").fill("Synthetic concurrent content");
  await a.locator("#briefInput").fill("baseline"); await a.locator("#saveCampaign").click(); await settle(a);
  await b.goto(pilot.url + "/portal?stay=1"); await b.locator("#emailInput").fill(email); await b.locator("#passwordInput").fill(password);
  await b.locator("#loginBtn").click(); await b.waitForURL(/\/app/); await b.waitForLoadState("networkidle");
  check((await getModel(b)).campaigns[0].brief === "baseline", "second signed-in browser sees saved baseline");
  await a.reload({ waitUntil: "networkidle" });
  const file = await a.evaluate(() => ({ schemaVersion: recoverySchema, content: recoveryContent({ schemaVersion: recoverySchema, content: model }) }));
  const workspaceId = (await getModel(a)).workspace.id;
  phase("A reviewed recovery, B later save, A conflict");
  await choose(a, file); await saveBrief(b, "B later saved edit");
  check((await getModel(b)).campaigns[0].brief === "B later saved edit", "B save confirmed");
  await a.locator("#applyRecovery").click(); await state(a, "conflict");
  check(await diskBrief(workspaceId) === "B later saved edit", "A stale preview did not overwrite disk");
  check(await a.evaluate(() => workspaceSaveState.current.campaigns[0].brief === "B later saved edit" && recoveryState.content.campaigns[0].brief === "baseline"), "current content loaded separately and imported input retained");
  const count = evidence.saveRequests.length;
  await a.evaluate(async () => { await saveModel().catch(() => {}); await saveModel().catch(() => {}); });
  check(evidence.saveRequests.length === count, "stale queued normal saves stop before HTTP");
  await a.screenshot({ path: path.join(output, "conflict-desktop.png"), fullPage: true });
  await a.setViewportSize({ width: 390, height: 844 });
  check(await a.evaluate(() => [...document.querySelectorAll("#workspaceSaveNotice span,#workspaceSaveNotice button:not([hidden])")].every(element => {
    const box = element.getBoundingClientRect(); return box.width > 0 && box.left >= 0 && box.right <= innerWidth;
  })), "mobile save notice text and controls fit the viewport");
  await a.screenshot({ path: path.join(output, "conflict-mobile.png"), fullPage: true });
  await a.setViewportSize({ width: 1440, height: 1000 });
  await pilot.restart();
  await b.reload({ waitUntil: "networkidle" });
  check((await getModel(b)).campaigns[0].brief === "B later saved edit", "B edit survives real process restart and fresh load");
  phase("explicit current-state review and second confirmation");
  await a.locator("#applyRecovery").click(); await state(a, "preview");
  check(await diskBrief(workspaceId) === "B later saved edit", "re-review is preview only");
  await a.locator("#applyRecovery").click(); await state(a, "success");
  check(await diskBrief(workspaceId) === "baseline", "explicitly re-reviewed recovery commits");
  await a.locator("#cancelRecovery").click();
  phase("reverse ordering: B stale preview cannot overwrite A");
  await b.reload({ waitUntil: "networkidle" }); await choose(b, file);
  await saveBrief(a, "A reverse winner");
  await b.locator("#applyRecovery").click(); await state(b, "conflict");
  check(await diskBrief(workspaceId) === "A reverse winner", "reverse ordering protects A");
  await b.locator("#cancelRecovery").click();
  phase("ordinary same-base editors preserve losing draft");
  await a.reload({ waitUntil: "networkidle" }); await b.reload({ waitUntil: "networkidle" });
  await saveBrief(a, "A normal winner"); await saveBrief(b, "B unsaved input");
  check(await diskBrief(workspaceId) === "A normal winner", "second ordinary editor conflicts");
  check(await b.evaluate(() => workspaceSaveState.blocked === "conflict" && workspaceSaveState.draft.campaigns[0].brief === "B unsaved input"), "losing editor retains its unsaved draft");
  await b.locator("#reviewWorkspaceSave").click();
  await b.waitForFunction(() => workspaceSaveState.blocked === "");
  check(await b.evaluate(() => model.campaigns[0].brief === "A normal winner"), "explicit ordinary review loads current content");
  phase("queued snapshots cannot adopt a later background-read revision");
  await a.reload({ waitUntil: "networkidle" }); await b.reload({ waitUntil: "networkidle" });
  await b.evaluate(() => {
    hostedModelSaveChain = new Promise(resolve => { window.releaseP11Queue = resolve; });
    const snapshot = sanitizedModelSnapshot(model); snapshot.campaigns[0].brief = "B queued obsolete snapshot";
    window.p11QueuedSave = enqueueHostedModelSave(snapshot).catch(error => error.message);
  });
  await saveBrief(a, "A wins before queue dispatch");
  const queuedResult = await b.evaluate(async () => {
    model = normalizeModel(await (await authedFetch("/api/model")).json());
    window.releaseP11Queue(); return window.p11QueuedSave;
  });
  check(queuedResult === "workspace_revision_conflict" && await diskBrief(workspaceId) === "A wins before queue dispatch", "later read cannot rebase an older queued snapshot");
  check(await b.evaluate(() => workspaceSaveState.pending.request.campaigns[0].brief === "B queued obsolete snapshot"), "rejected queued request remains available with the retained draft");
  await b.locator("#reviewWorkspaceSave").click(); await b.waitForFunction(() => workspaceSaveState.blocked === "");
  phase("one page can serialize its own queued edits without adopting other writers");
  const ownResults = await b.evaluate(async () => {
    const one = sanitizedModelSnapshot(model), two = sanitizedModelSnapshot(model);
    one.campaigns[0].brief = "own queued first"; two.campaigns[0].brief = "own queued second";
    return (await Promise.all([enqueueHostedModelSave(one), enqueueHostedModelSave(two)])).map(response => response.status);
  });
  check(ownResults.every(status => status === 200) && await diskBrief(workspaceId) === "own queued second", "own acknowledged revisions advance the existing queue");
  await a.reload({ waitUntil: "networkidle" }); await saveBrief(a, "A later episode winner");
  await saveBrief(b, "B new unsaved episode");
  check(await b.evaluate(() => workspaceSaveState.draft.campaigns[0].brief === "B new unsaved episode"), "new conflict captures the new draft rather than the previous episode");
  phase("injected lost response retries identical original request");
  await b.reload({ waitUntil: "networkidle" }); await choose(b, file);
  await b.evaluate(() => {
    const original = window.fetch; let suppress = true;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (suppress && String(args[0]).endsWith("/api/model") && args[1]?.method === "POST" && response.ok) {
        suppress = false; await response.clone().text(); throw new TypeError("Synthetic lost response");
      }
      return response;
    };
  });
  const prior = evidence.saveRequests.length;
  await b.locator("#applyRecovery").click(); await state(b, "error");
  check(await b.evaluate(() => workspaceSaveState.blocked === "unknown"), "uncertain outcome distinguished from conflict");
  await b.locator("#applyRecovery").click(); await state(b, "success");
  const requests = evidence.saveRequests.slice(prior);
  check(requests.length === 2 && requests[0].operationId === requests[1].operationId && requests[0].sha256 === requests[1].sha256, "original operation ID and exact body reused after lost response");
  await pilot.restart();
  check(await diskBrief(workspaceId) === "baseline", "reconciled recovery survives restart");
  await b.setViewportSize({ width: 390, height: 844 });
  await b.screenshot({ path: path.join(output, "recovery-mobile.png"), fullPage: true });
} catch (error) { failed = error; }
finally {
  await ca?.close(); await cb?.close(); await browser?.close(); await pilot.stop();
  const summary = await pilot.summary();
  evidence.externalProviderRequestsDispatched = summary.externalProviderRequestsDispatched;
  evidence.serverRunning = summary.running;
  evidence.cleanupComplete = !summary.running && await access(path.join(pilot.dataDir, ".workspace-content.lock")).then(() => false, () => true);
  try { check(evidence.cleanupComplete && evidence.externalProviderRequestsDispatched === 0, "server stopped, lock absent, no external dispatch"); }
  catch (error) { failed ||= error; }
  evidence.dataDir = pilot.dataDir; evidence.ok = !failed;
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ ok: !failed, checks: evidence.checks, output, cleanupComplete: evidence.cleanupComplete }));
if (failed) throw failed;
