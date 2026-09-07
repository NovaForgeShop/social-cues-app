import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit } from "playwright";
import { createLocalPilot, projectRoot, syntheticPromoCode, syntheticSecondPromoCode } from "./scripts/run-local-pilot.mjs";

const output = path.join(projectRoot, ".tmp", "p12-browser-" + Date.now());
await mkdir(output, { recursive: true });
const pilot = await createLocalPilot();
const email = "p12-" + randomUUID() + "@example.test", password = "Synthetic-only-" + randomUUID() + "!";
const evidence = { checks: 0, applicationRoutesMocked: false, injectedFailures: ["Browser suppresses an actually successful creation response once",
  "During each copy-preview phase, queue a real normal save and delay then suppress its successful response"],
  phases: [], requests: [], externalBrowserDispatched: 0, externalBrowserBlocked: 0, cleanupComplete: false };
const check = (ok, label) => { assert.ok(ok, label); evidence.checks++; };
const phase = label => { evidence.phases.push(label); console.log("P12: " + label); };
let desktop, mobile, ca, cb, cc, a, b, c, failure;
const settle = page => page.evaluate(async () => { await hostedModelSaveChain.catch(() => {}); });
const current = page => page.evaluate(async () => (await authedFetch("/api/model")).json());
const bytes = () => readFile(path.join(pilot.dataDir, "model.json"));
const modalState = (page, phase) => page.waitForFunction(value => document.querySelector("#losingCampaignStatus").dataset.state === value, phase);
const studio = async page => { await page.evaluate(() => { jump("studio"); setStudioMode("campaign"); }); };
const saveBrief = async (page, brief) => { await studio(page); await page.locator("#briefInput").fill(brief); await page.locator("#saveCampaign").click(); await settle(page); };
const openRetained = async page => { await page.locator("#exportUnsavedWorkspace").click(); await modalState(page, "review"); };
const create = async page => { await page.locator("#createLosingCampaign").click(); await page.waitForFunction(() => !document.querySelector("#losingCampaignDialog").open); };
const download = async (page, name) => {
  const pending = page.waitForEvent("download"); await page.locator("#downloadLosingCampaign").click();
  const file = path.join(output, name); await (await pending).saveAs(file);
  return { path: file, data: JSON.parse(await readFile(file, "utf8")) };
};
const importFile = async (page, file, expected = "review") => {
  await page.evaluate(() => jump("settings"));
  const chooser = page.waitForEvent("filechooser"); await page.locator("#importLosingCampaignButton").click();
  await (await chooser).setFiles(file); await modalState(page, expected);
};
const signup = async (page, address, promo) => {
  await page.goto(pilot.url + "/portal?stay=1"); await page.locator("#createBtn").click();
  await page.locator("#nameInput").fill("Synthetic P12"); await page.locator("#emailInput").fill(address);
  await page.locator("#passwordInput").fill(password); await page.locator("#promoInput").fill(promo);
  await page.locator("#createBtn").click(); await page.waitForURL(/\/app/); await page.waitForLoadState("networkidle");
  await page.locator("#businessNameInput").fill("Synthetic P12 local pilot"); await page.locator("#websiteInput").fill("https://example.test/p12");
  await page.locator("#completeOnboarding").click(); await page.waitForFunction(() => !document.body.classList.contains("onboarding-scene")); await settle(page);
};
try {
  await pilot.start(); desktop = await chromium.launch({ headless: true }); mobile = await webkit.launch({ headless: true });
  const context = async (browser, name, viewport) => {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin === pilot.url) return route.continue();
      evidence.externalBrowserBlocked++; return route.abort();
    });
    context.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/model") {
        const payload = request.postDataJSON();
        evidence.requests.push({ client: name, operationId: payload.operationId, expectedRevision: payload.expectedRevision,
          sha256: createHash("sha256").update(request.postData()).digest("hex") });
      }
    });
    return context;
  };
  ca = await context(desktop, "A", { width: 1440, height: 1000 }); cb = await context(mobile, "B", { width: 390, height: 844 });
  a = await ca.newPage(); b = await cb.newPage();
  phase("fresh synthetic signup and real campaign/evidence fixture");
  await signup(a, email, syntheticPromoCode); await studio(a); await a.locator("#newCampaign").click(); await settle(a);
  await a.evaluate(async () => {
    const campaign = activeCampaign(); campaign.title = "SYNTHETIC P12 saved campaign"; campaign.brief = "Initial saved text";
    campaign.variants = [{ id: "synthetic-original-variant", campaignId: campaign.id, platform: "facebook", copy: "Original approved copy", status: "approved",
      approvedAt: "2026-09-01T15:00:00Z", scheduledFor: "2026-10-01T15:00:00Z", tags: [], flags: [], providerReceipt: "synthetic-excluded-receipt" }];
    model.proof = [{ id: "synthetic-manual-zero", source: "manual", schemaVersion: "social-cues.manual-proof.v1", type: "observed-result",
      campaignId: campaign.id, variantId: campaign.variants[0].id, platform: "facebook", postedUrl: "https://example.test/synthetic-zero",
      postedAt: "2026-09-01T10:30:00+00:00", postedTimezone: "+00:00", metric: "Synthetic views", metricValue: 0,
      observedAt: "2026-09-02T10:30:00+00:00", observedTimezone: "+00:00", note: "Synthetic manual fact, not verified delivery.",
      createdAt: "2026-09-02T12:00:00Z", updatedAt: "2026-09-02T12:00:00Z" }];
    campaign.evidenceSnapshot = buildSelfLaunchEvidence(model.proof, [model.proof[0].id], "2026-09-06T12:00:00Z");
    model.campaigns.push({ ...clone(campaign), id: "synthetic-unrelated-campaign", title: "Unrelated retained campaign", variants: [], evidenceSnapshot: undefined });
    await saveModel(); render();
  });
  const initial = await current(a), originalId = initial.activeCampaignId;
  await b.goto(pilot.url + "/portal?stay=1"); await b.locator("#emailInput").fill(email); await b.locator("#passwordInput").fill(password);
  await b.locator("#loginBtn").click(); await b.waitForURL(/\/app/); await b.waitForLoadState("networkidle");
  await a.reload({ waitUntil: "networkidle" });
  phase("winner, losing text, read-only preview/cancel and mobile keyboard controls");
  await saveBrief(a, "Winner one remains intact");
  const losingText = ("LOSING TEXT <img src=x onerror=window.p12Executed=true>\n" + "Private synthetic campaign paragraph.\n".repeat(80)).trim().replace(/\s+/g, " ");
  await saveBrief(b, losingText);
  check(await b.evaluate(() => workspaceSaveState.blocked === "conflict"), "normal losing edit conflicts");
  const winner = await current(a), before = await bytes(), posts = evidence.requests.length;
  await openRetained(b);
  check((await b.locator("#losingCampaignText").textContent()).includes(losingText), "losing text remains inspectable");
  check((await b.locator("#currentCampaignText").textContent()).includes("Winner one remains intact"), "current saved text is shown beside the retained version");
  check(!await b.evaluate(() => window.p12Executed === true), "imported-looking text is inert");
  check(await b.evaluate(() => [...document.querySelectorAll(".losing-footer button")].every(button => {
    const box = button.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
  })), "all mobile modal buttons fit without clipped controls");
  await b.locator("#losingCampaignText").focus();
  const reached = new Set();
  for (let i = 0; i < 9; i++) { await b.keyboard.press("Tab"); reached.add(await b.evaluate(() => document.activeElement.id)); }
  check(["downloadLosingCampaign", "refreshLosingCampaign", "createLosingCampaign", "cancelLosingCampaign"].every(id => reached.has(id)), "keyboard reaches every modal action");
  await b.locator(".losing-body").evaluate(element => { element.scrollTop = 0; });
  await b.screenshot({ path: path.join(output, "review-mobile.png") });
  const firstFile = await download(b, "first-campaign.json");
  check(Object.keys(firstFile.data).sort().join(",") === "campaign,copyId,schemaVersion,sourceCampaignId,workspaceScope", "download contains only versioned content and bounded metadata");
  const serialized = JSON.stringify(firstFile.data);
  check(![email, password, initial.currentUser.id, initial.workspace.id, "synthetic-excluded-receipt", "evidenceSnapshot", "formInputs", "attemptedSave"].some(value => serialized.includes(value)), "download omits credentials, account identity and operational state");
  await b.keyboard.press("Escape");
  check(!await b.locator("#losingCampaignDialog").evaluate(dialog => dialog.open), "Escape cancels review");
  check((await bytes()).equals(before) && evidence.requests.length === posts, "preview/download/cancel issue no save and change no persisted bytes");
  await openRetained(b); await create(b);
  const firstCreated = await current(b), copyOneId = "camp-copy-" + firstFile.data.copyId, copied = firstCreated.campaigns.find(item => item.id === copyOneId);
  check(firstCreated.campaigns.length === winner.campaigns.length + 1 && copied.brief === losingText, "explicit confirmation creates exactly one new campaign with losing text");
  check(copied.variants.every(item => item.status === "draft" && !item.approvedAt && !item.scheduledFor && !item.providerReceipt), "new variants are unapproved and have no dispatch or delivery state");
  check(!copied.evidenceSnapshot && copied.variants[0].id !== initial.campaigns[0].variants[0].id, "fresh IDs and no stale evidence snapshot on new draft");
  assert.deepEqual(firstCreated.campaigns.filter(item => item.id !== copyOneId), winner.campaigns); evidence.checks++;
  assert.deepEqual(firstCreated.proof, winner.proof); evidence.checks++;
  check(firstCreated.proof[0].metricValue === 0 && firstCreated.campaigns.find(item => item.id === originalId).evidenceSnapshot.records[0].metricValue === "0", "manual zero and immutable snapshot remain honest");
  check(await b.locator("#campaignTitleInput").inputValue() === copied.title && await b.locator("#briefInput").inputValue() === losingText, "confirmed new draft opens in ordinary campaign editor");

  phase("further concurrent edit requires deliberate re-review; lost response retries one operation");
  await a.reload({ waitUntil: "networkidle" }); await saveBrief(a, "Second saved winner"); await saveBrief(b, "Second losing copy"); await openRetained(b);
  const secondFile = await download(b, "second-campaign.json");
  await saveBrief(a, "Further concurrent winner"); const concurrent = await current(a), countBefore = concurrent.campaigns.length;
  await b.locator("#createLosingCampaign").click(); await modalState(b, "conflict");
  check((await current(a)).campaigns.length === countBefore && (await current(a)).campaigns.find(item => item.id === copyOneId).brief === "Further concurrent winner", "stale copy attempt preserves winner and creates nothing");
  check((await b.locator("#losingCampaignText").textContent()).includes("Second losing copy"), "further conflict retains the losing input");
  const afterConflict = await bytes();
  await b.locator("#refreshLosingCampaign").click(); await modalState(b, "review");
  check((await bytes()).equals(afterConflict), "explicit re-review remains read-only");
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
  const requestStart = evidence.requests.length;
  await b.locator("#createLosingCampaign").click(); await modalState(b, "unknown");
  check(await b.locator("#refreshLosingCampaign").isDisabled() && await b.locator("#losingCampaignSelect").isDisabled(), "uncertain creation does not offer another creation or re-review");
  await b.locator("#cancelLosingCampaign").click(); await importFile(b, firstFile.path, "unknown");
  check(await b.evaluate(() => losingCampaignState.operation.operationId === workspaceSaveState.pending.operationId), "closing an uncertain review cannot replace its pending operation with another file");
  await create(b);
  const retried = evidence.requests.slice(requestStart);
  check(retried.length === 2 && retried[0].operationId === retried[1].operationId && retried[0].sha256 === retried[1].sha256, "unknown outcome retries the identical original request and operation ID");
  check((await current(b)).campaigns.filter(item => item.id === "camp-copy-" + secondFile.data.copyId).length === 1 && (await current(b)).campaigns.length === countBefore + 1, "retry creates no duplicate");
  await b.reload({ waitUntil: "networkidle" }); const beforeDuplicate = await bytes();
  await importFile(b, secondFile.path, "exists"); await create(b);
  check((await bytes()).equals(beforeDuplicate), "same downloaded intent after reload opens existing draft without creating or writing");

  phase("download survives reload and uses the same conditional creation workflow");
  await a.reload({ waitUntil: "networkidle" }); await saveBrief(a, "Third saved winner"); await saveBrief(b, "Downloaded losing text after reload"); await openRetained(b);
  const thirdFile = await download(b, "resume-campaign.json"); await b.locator("#cancelLosingCampaign").click();
  await b.reload({ waitUntil: "networkidle" }); const beforeImport = await bytes();
  await importFile(b, thirdFile.path);
  check((await b.locator("#losingCampaignText").textContent()).includes("Downloaded losing text after reload") && (await bytes()).equals(beforeImport), "downloaded supported text reviews after reload without a write");
  await create(b);
  const finalModel = await current(b), lastId = "camp-copy-" + thirdFile.data.copyId;
  check(finalModel.campaigns.find(item => item.id === lastId).brief === "Downloaded losing text after reload", "downloaded text creates its new editable draft");
  assert.deepEqual(finalModel.campaigns.find(item => item.id === originalId), winner.campaigns.find(item => item.id === originalId)); evidence.checks++;
  assert.deepEqual(finalModel.proof, winner.proof); evidence.checks++;
  await a.reload({ waitUntil: "networkidle" }); await importFile(a, thirdFile.path, "exists");
  await a.screenshot({ path: path.join(output, "review-desktop.png") }); await a.locator("#cancelLosingCampaign").click();

  for (const phaseName of ["review", "exists"]) {
    phase("P12-R1: delayed/lost normal save during " + phaseName + " cannot be bypassed or forgotten");
    await a.reload({ waitUntil: "networkidle" }); await b.reload({ waitUntil: "networkidle" });
    let raceFile = thirdFile;
    if (phaseName === "review") {
      await saveBrief(a, "P12-R1 saved before race"); await saveBrief(b, "P12-R1 retained losing campaign");
      await openRetained(b); raceFile = await download(b, "normal-race-campaign.json"); await b.locator("#cancelLosingCampaign").click();
      await b.locator("#reviewWorkspaceSave").click(); await b.waitForFunction(() => workspaceSaveState.blocked === "");
    }
    await importFile(b, raceFile.path, phaseName);
    const retainedBeforeRace = await b.locator("#losingCampaignText").textContent(), raceStart = evidence.requests.length;
    const countBeforeRace = (await current(b)).campaigns.length, normalBrief = "P12-R1 normal winner during " + phaseName;
    // Synthetic ordering seam: use the actual normal queue and HTTP route, then hold
    // a committed response while the operator confirms the already-visible preview.
    await b.evaluate(({ sourceId, brief }) => {
      const original = window.fetch; let held = false;
      window.p12NormalHeld = false;
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (!held && String(args[0]).endsWith("/api/model") && args[1]?.method === "POST" && response.ok) {
          held = true; await response.clone().text(); window.p12NormalHeld = true;
          await new Promise(resolve => { window.releaseP12Normal = resolve; });
          throw new TypeError("Synthetic delayed/lost normal-save response");
        }
        return response;
      };
      const snapshot = sanitizedModelSnapshot(model);
      snapshot.campaigns.find(item => item.id === sourceId).brief = brief;
      window.p12NormalSave = enqueueHostedModelSave(snapshot).catch(error => error.message);
    }, { sourceId: raceFile.data.sourceCampaignId, brief: normalBrief });
    await b.waitForFunction(() => window.p12NormalHeld);
    await b.locator("#createLosingCampaign").click();
    await b.waitForFunction(() => losingCampaignState.busy);
    check(evidence.requests.length === raceStart + 1, phaseName + ": confirmation waits; only the original normal request was sent");
    await b.evaluate(() => window.releaseP12Normal());
    await modalState(b, "pending");
    const originalRequest = evidence.requests[raceStart];
    const pendingSummary = await b.evaluate(async () => {
      window.p12OriginalPending = workspaceSaveState.pending;
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(workspaceSaveState.pending)));
      return { operationId: workspaceSaveState.pending.operationId, blocked: workspaceSaveState.blocked,
        sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("") };
    });
    check(pendingSummary.blocked === "unknown" && pendingSummary.operationId === originalRequest.operationId
      && pendingSummary.sha256 === originalRequest.sha256, phaseName + ": original unknown identity and exact body remain intact");
    check(evidence.requests.length === raceStart + 1 && (await current(b)).campaigns.length === countBeforeRace, phaseName + ": no additional creation request or duplicate while unknown");
    check((await b.locator("#losingCampaignText").textContent()) === retainedBeforeRace
      && (await current(b)).campaigns.find(item => item.id === raceFile.data.sourceCampaignId).brief === normalBrief, phaseName + ": retained text and current winner both survive");
    check(await b.locator("#createLosingCampaign").isDisabled() && await b.evaluate(() => workspaceSaveState.pending === window.p12OriginalPending), phaseName + ": copy action cannot clear or resolve another operation");
    await b.locator("#cancelLosingCampaign").click();
    await b.locator("#retryWorkspaceSave").click();
    await b.waitForFunction(() => workspaceSaveState.pending === null && workspaceSaveState.blocked === "conflict");
    const reconciliation = evidence.requests.slice(raceStart);
    check(reconciliation.length === 2 && reconciliation[0].operationId === reconciliation[1].operationId
      && reconciliation[0].sha256 === reconciliation[1].sha256, phaseName + ": exact normal operation reconciles successfully");
    check((await current(b)).campaigns.length === countBeforeRace, phaseName + ": reconciliation did not create a campaign");
    await importFile(b, raceFile.path, phaseName);
    check((await b.locator("#currentCampaignText").textContent()).includes(normalBrief), phaseName + ": explicit fresh review shows the confirmed normal winner");
    await create(b);
    const afterRace = await current(b);
    check(afterRace.campaigns.length === countBeforeRace + (phaseName === "review" ? 1 : 0), phaseName + ": deliberate post-reconciliation action creates at most the one selected draft");
    check(afterRace.campaigns.find(item => item.id === raceFile.data.sourceCampaignId).brief === normalBrief, phaseName + ": later action preserves the normal saved winner");
    await importFile(b, raceFile.path, "exists"); await create(b);
    check((await current(b)).campaigns.filter(item => item.id === "camp-copy-" + raceFile.data.copyId).length === 1, phaseName + ": repeating the downloaded intent creates no duplicate");
  }

  phase("another authenticated account cannot import the file into its workspace");
  cc = await context(desktop, "C", { width: 1200, height: 900 }); c = await cc.newPage();
  await signup(c, "p12-other-" + randomUUID() + "@example.test", syntheticSecondPromoCode);
  const otherBefore = await bytes(), postsBeforeOther = evidence.requests.length;
  await importFile(c, thirdFile.path, "error");
  check((await c.locator("#losingCampaignStatus").textContent()).includes("different workspace") && await c.locator("#createLosingCampaign").isDisabled(), "cross-account workspace context rejects before creation");
  check((await bytes()).equals(otherBefore) && evidence.requests.length === postsBeforeOther, "cross-account rejection does not persist anything");
  const savedBeforeRestart = (await current(b)).campaigns.find(item => item.id === lastId);
  await pilot.restart(); await b.reload({ waitUntil: "networkidle" });
  assert.deepEqual((await current(b)).campaigns.find(item => item.id === lastId), savedBeforeRestart); evidence.checks++;
  check(await b.evaluate(() => localStorage.getItem(STORAGE_KEY) === null && localStorage.getItem(LEGACY_STORAGE_KEY) === null), "no private draft stored in browser model cache");
  await writeFile(path.join(pilot.dataDir, "pilot-access.json"), JSON.stringify({ email, password }, null, 2), { flag: "wx" });
  evidence.pilotUrl = pilot.url; evidence.originalCampaignId = originalId; evidence.copiedCampaignId = lastId;
} catch (error) { failure = error; }
finally {
  await ca?.close(); await cb?.close(); await cc?.close(); await desktop?.close(); await mobile?.close(); await pilot.stop();
  const summary = await pilot.summary(); evidence.dataDir = pilot.dataDir; evidence.externalProviderRequestsDispatched = summary.externalProviderRequestsDispatched;
  evidence.cleanupComplete = !summary.running && await access(path.join(pilot.dataDir, ".workspace-content.lock")).then(() => false, () => true);
  try { check(evidence.cleanupComplete && evidence.externalProviderRequestsDispatched === 0, "task-owned processes closed, lock released, zero external provider dispatch"); }
  catch (error) { failure ||= error; }
  evidence.ok = !failure;
  if (failure) evidence.failure = failure.message;
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ ok: !failure, checks: evidence.checks, output, dataDir: pilot.dataDir, cleanupComplete: evidence.cleanupComplete }));
if (failure) throw failure;
