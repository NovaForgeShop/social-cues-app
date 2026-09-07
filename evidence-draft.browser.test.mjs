import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, webkit } from "playwright";
import { html, records } from "./evidence-draft.contract.test.mjs";
import { campaigns } from "./manual-proof.contract.test.mjs";

const output = fileURLToPath(new URL("./test-results/evidence-draft/", import.meta.url));
await mkdir(output, { recursive: true });
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
const results = [];
for (const profile of [
  { name: "desktop-chromium", engine: chromium, viewport: { width: 1440, height: 1000 } },
  { name: "mobile-webkit", engine: webkit, viewport: { width: 390, height: 844 }, mobile: true }
]) {
  const browser = await profile.engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: !!profile.mobile,
    hasTouch: !!profile.mobile, serviceWorkers: "block", timezoneId: "America/New_York" });
  const page = await context.newPage();
  const requests = [], attempts = [], pageErrors = [];
  let persisted, failure = "", phase = "boot";
  page.on("pageerror", error => pageErrors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ path: url.pathname, origin: url.origin, method: request.method(), phase });
    if (url.origin !== "http://127.0.0.1:4178") return route.abort();
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/app") return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/api/auth/session" && persisted) return json(200, { ok: true, user: persisted.currentUser, workspace: persisted.workspace });
    if (url.pathname === "/api/auth/device/heartbeat") return json(200, { ok: true });
    if (url.pathname === "/api/model" && persisted) {
      if (request.method() === "GET") return json(200, persisted);
      if (request.method() === "POST") {
        const incoming = request.postDataJSON();
        attempts.push(structuredClone(incoming));
        const mode = failure;
        failure = "";
        if (mode === "reject") return json(503, { error: "Synthetic rejection" });
        persisted = incoming;
        if (mode === "lost-response") return route.abort();
        return json(200, { ok: true });
      }
    }
    return json(401, { error: "Synthetic fixture: unavailable" });
  });
  const feedback = state => page.waitForFunction(value =>
    document.querySelector("#selfLaunchFeedback").dataset.state === value, state);
  const openResults = async () => {
    if (profile.mobile) await page.locator("#mobileViewSelect").selectOption("proof");
    else await page.locator('#nav [data-view="proof"]').click();
    await page.locator("#proof").evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
  };
  const checkbox = id => page.locator('[data-evidence-proof="' + id + '"]');
  const preservedState = () => page.evaluate(() => JSON.stringify({
    campaigns: model.campaigns.filter(item => !item.evidenceSnapshot), proof: model.proof,
    queue: model.publishQueue, integrations: model.integrations, checks: model.functionChecks,
    readiness: facebookPageEvidence(null, metaState)
  }));
  try {
    await page.goto("http://127.0.0.1:4178/app");
    persisted = await page.evaluate(async seed => {
      await bootApp();
      model = normalizeModel(clone(defaultModel));
      model.currentUser = { id: "evidence-operator", name: "Synthetic operator", email: "synthetic@example.test" };
      model.workspace.id = "synthetic-evidence-workspace";
      model.workspace.name = "Synthetic evidence pilot";
      model.onboarding.complete = true;
      model.onboarding.selectedPlatforms = ["facebook", "linkedin"];
      model.campaigns = seed.campaigns;
      model.activeCampaignId = seed.campaigns[0].id;
      model.proof = seed.records;
      model.publishQueue = [{ id: "existing-queue", status: "queued", variantId: "manual-post" }];
      hostedModelHydrated = true;
      render();
      return JSON.parse(JSON.stringify(model));
    }, { campaigns, records });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => hostedModelHydrated && model.currentUser?.id === "evidence-operator");
    await openResults();
    phase = "evidence";
    const before = await preservedState();
    check(await page.locator("#legacyProofList input").count() === 0, "legacy notes cannot be selected");
    check(await page.locator("[data-evidence-proof]").count() === 3, "only saved eligible manual records are selectable");
    check(await page.locator("#createSelfLaunch").isDisabled(), "creation requires preview");
    await page.locator("#previewSelfLaunch").click();
    await feedback("error");
    check(attempts.length === 0 && await page.locator("#createSelfLaunch").isDisabled(), "empty selection makes no save");
    await checkbox("receipt-only").focus();
    await page.keyboard.press("Space");
    await page.locator("#previewSelfLaunch").focus();
    await page.keyboard.press("Enter");
    const receiptPreview = await page.locator("#selfLaunchPreviewText").innerText();
    check(receiptPreview.includes("Manual posting receipt") && receiptPreview.includes("Performance: unreported."), "receipt preview reports no performance");
    check(!receiptPreview.includes("Synthetic views") && !receiptPreview.includes("LEGACY SUCCESS CLAIM"), "receipt-only selection excludes other facts");
    check(await page.locator("#selfLaunchPreviewText").evaluate(element => element === document.activeElement), "preview receives keyboard focus");
    await checkbox("observed-zero").check();
    check(await page.locator("#createSelfLaunch").isDisabled(), "selection change requires a new preview");
    await page.locator("#previewSelfLaunch").click();
    const previewText = await page.locator("#selfLaunchPreviewText").innerText();
    const previewSnapshot = await page.evaluate(() => structuredClone(selfLaunchState.preview.snapshot));
    check(previewText.includes("Synthetic views: 0") && previewText.includes("Performance: unreported."), "mixed selection preserves zero and receipt distinction");
    check(!previewText.includes("UNSELECTED FACT") && !previewText.includes("LEGACY SUCCESS CLAIM"), "unselected campaigns and legacy notes excluded");
    check(await page.locator("#selfLaunchPreviewText b").count() === 0, "operator note rendered as text, not markup");
    check(previewText.includes('Operator note (unverified; quoted): "<b>SYNTHETIC operator note</b>"'), "operator note provenance explicit");
    await page.locator(".self-launch-draft").screenshot({ path: path.join(output, profile.name + "-preview.png") });
    await page.locator("#manualProofList").screenshot({ path: path.join(output, profile.name + "-selection.png") });
    await page.locator("#selfLaunchPreviewText").focus();
    await page.keyboard.press("Tab");
    check(await page.locator("#createSelfLaunch").evaluate(element => element === document.activeElement), "keyboard reaches deliberate create action");
    failure = "reject";
    await page.keyboard.press("Enter");
    await feedback("error");
    const pending = attempts.at(-1).campaigns.find(item => item.evidenceSnapshot);
    check(attempts.length === 1 && pending.variants.length > 0, "first save already contains complete draft variants");
    check(await preservedState() === before, "failed create restores original proof campaigns queue and readiness");
    check(await checkbox("receipt-only").isChecked() && await checkbox("observed-zero").isChecked(), "failed save retains selected records");
    check(await checkbox("receipt-only").isDisabled(), "unconfirmed retry keeps selection fixed");
    check(await page.locator("#selfLaunchPreviewText").innerText() === previewText, "failed save retains factual preview");
    check((await page.locator("#selfLaunchFeedback").innerText()).includes("not confirmed"), "save failure reported honestly");
    check(await page.locator("#createSelfLaunch").evaluate(element => element === document.activeElement), "failed save returns keyboard focus to retry");
    failure = "lost-response";
    await page.locator("#createSelfLaunch").click();
    await feedback("error");
    check(persisted.campaigns.filter(item => item.evidenceSnapshot).length === 1, "lost response simulates one server-stored draft");
    await page.locator("#createSelfLaunch").click();
    await feedback("success");
    const draft = persisted.campaigns.find(item => item.id === pending.id);
    check(attempts.slice(0, 3).every(item => item.campaigns.find(c => c.evidenceSnapshot).id === pending.id), "all retries use the same campaign identity");
    check(persisted.campaigns.filter(item => item.id === pending.id).length === 1, "retry after lost response does not duplicate draft");
    check(attempts.slice(0, 3).every(item => JSON.stringify(item.campaigns.find(c => c.evidenceSnapshot).variants) === JSON.stringify(draft.variants)), "retry preserves variant identities and contents");
    check(draft.brief === previewText && draft.variants.every(item => item.copy === previewText && item.status === "draft"), "preview exactly matches editable brief and unapproved variants");
    check(JSON.stringify(draft.evidenceSnapshot) === JSON.stringify(previewSnapshot), "saved draft retains the exact selected snapshot");
    check(await preservedState() === before, "successful creation preserves source proof approval queue and readiness");
    check(await page.locator("#createSelfLaunch").isDisabled() && await page.locator("#previewSelfLaunch").isDisabled(), "completed form cannot accidentally create another draft");
    await writeFile(path.join(output, profile.name + "-campaign.json"), JSON.stringify(draft, null, 2));
    const snapshotBeforeCorrection = JSON.stringify(draft.evidenceSnapshot);
    await page.locator('[data-manual-proof="observed-zero"] [data-edit-proof]').click();
    await page.locator("#proofValueInput").fill("12");
    await page.locator("#saveManualProof").click();
    await page.waitForFunction(() => document.querySelector("#proofFeedback").dataset.state === "success");
    check(persisted.proof.find(item => item.id === "observed-zero").metricValue === "12", "separate deliberate source correction saved");
    check(JSON.stringify(persisted.campaigns.find(item => item.id === draft.id).evidenceSnapshot) === snapshotBeforeCorrection, "source correction does not rewrite existing draft snapshot");
    check(await page.locator("#selfLaunchPreviewText").innerText() === previewText, "reviewed snapshot stays frozen after source correction");
    await page.locator("#openSelfLaunchDraft").click();
    check(await page.locator("#campaignTitleInput").isVisible() && await page.locator("#briefInput").inputValue() === previewText, "created campaign opens in existing editable campaign lane");
    const save = page.waitForResponse(response => new URL(response.url()).pathname === "/api/model" && response.request().method() === "POST");
    await page.locator("#briefInput").fill(previewText + "\nSYNTHETIC operator edit.");
    await page.locator("#saveCampaign").click();
    await save;
    check(persisted.campaigns.find(item => item.id === draft.id).brief.endsWith("SYNTHETIC operator edit."), "operator can edit draft through existing save flow");
    check(JSON.stringify(persisted.campaigns.find(item => item.id === draft.id).evidenceSnapshot) === snapshotBeforeCorrection, "editing campaign does not rewrite factual snapshot");
    await page.locator("#studio").evaluate(async element => { await Promise.all(element.getAnimations().map(a => a.finished.catch(() => {}))); });
    await page.screenshot({ path: path.join(output, profile.name + "-editor.png") });
    phase = "reload";
    await page.reload({waitUntil:"networkidle"});
    await page.waitForFunction(() => hostedModelHydrated && model.currentUser?.id === "evidence-operator");
    check(await page.evaluate(() => selfLaunchState.preview === null), "saved inspector is independent of transient Results preview after reload");
    if (profile.mobile) await page.locator("#mobileViewSelect").selectOption("studio");
    else await page.locator('#nav [data-view="studio"]').click();
    await page.locator('[data-studio-mode="campaign"]').click();
    await page.waitForLoadState("networkidle");
    phase = "inspection";
    const disclosure = page.locator("#savedEvidenceDisclosure"), summary = disclosure.locator("summary");
    const inspectionModel = await page.evaluate(() => JSON.stringify(model));
    const inspectionRequests = requests.length, inspectionSaves = attempts.length;
    check(!await disclosure.evaluate(element => element.open), "saved evidence begins collapsed");
    await page.locator("#campaignTitleInput").fill("UNSAVED operator title");
    await page.locator("#briefInput").fill("UNSAVED multiline\noperator brief");
    await summary.focus();
    await page.keyboard.press("Enter");
    check(await disclosure.evaluate(element => element.open), "keyboard opens saved snapshot disclosure");
    check(await page.locator("#savedEvidenceStatus").getAttribute("data-state") === "ready", "persisted valid snapshot renders ready");
    check(await page.locator("#savedEvidenceText").innerText() === previewText, "saved inspector retains exact original facts after source correction and reload");
    check((await page.locator("#savedEvidenceCapturedAt").innerText()).includes(previewSnapshot.capturedAt), "saved capture time is visible");
    check((await page.locator("#savedEvidenceStatus").innerText()).includes("Later receipt corrections do not update"), "saved history distinguished from current receipts");
    check(await disclosure.locator("a, b, script").count() === 0, "saved URLs and markup-like notes remain inert text");
    await page.keyboard.press("Tab");
    check(await page.locator("#savedEvidenceText").evaluate(element => element === document.activeElement), "keyboard can reach captured text");
    await summary.focus();
    await page.keyboard.press("Space");
    check(!await disclosure.evaluate(element => element.open), "keyboard closes saved disclosure");
    await page.keyboard.press("Enter");
    check(await page.locator("#campaignTitleInput").inputValue() === "UNSAVED operator title"
      && await page.locator("#briefInput").inputValue() === "UNSAVED multiline\noperator brief", "inspection preserves in-progress campaign input");
    check(await page.evaluate(() => JSON.stringify(model)) === inspectionModel, "inspection never changes campaign proof approval queue or readiness state");
    check(requests.length === inspectionRequests && attempts.length === inspectionSaves, "opening closing and reading inspector sends no request or save");
    const savedLayout = await disclosure.evaluate(element => {
      const bounds = element.getBoundingClientRect(), text = element.querySelector("pre"), trigger = element.querySelector("summary");
      return {fits:bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth,
        textFits:text.scrollWidth <= text.clientWidth, targetHeight:trigger.getBoundingClientRect().height};
    });
    check(savedLayout.fits && savedLayout.textFits && savedLayout.targetHeight >= 44, "saved snapshot and disclosure fit desktop/mobile");
    await disclosure.screenshot({path:path.join(output, profile.name + "-saved-snapshot.png")});
    phase = "campaign-selection";
    const selectionSaved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/model" && response.request().method() === "POST");
    // Exercise the existing selection listener; the mobile campaign list is outside the visible lane.
    await page.locator('#campaignList [data-campaign-id="manual-campaign"]').evaluate(element => element.click());
    await selectionSaved;
    await page.waitForLoadState("networkidle");
    check(attempts.length === inspectionSaves + 1, "existing campaign selection persists separately from inspection");
    phase = "inspection";
    const ordinaryModel = await page.evaluate(() => JSON.stringify(model)), ordinaryRequests = requests.length;
    await summary.click();
    check(await page.locator("#savedEvidenceStatus").getAttribute("data-state") === "none"
      && await page.locator("#savedEvidenceText").isHidden(), "ordinary campaign has an honest no-snapshot state without stale facts");
    check(await page.evaluate(() => JSON.stringify(model)) === ordinaryModel && requests.length === ordinaryRequests, "ordinary snapshot inspection is also read-only");
    const intact = structuredClone(persisted);
    for (const malformed of [{...previewSnapshot,schemaVersion:"future"}, {...previewSnapshot,records:[null]}]) {
      persisted.campaigns.find(item => item.id === draft.id).evidenceSnapshot = malformed;
      persisted.activeCampaignId = draft.id;
      phase = "reload";
      await page.reload({waitUntil:"networkidle"});
      if (profile.mobile) await page.locator("#mobileViewSelect").selectOption("studio");
      else await page.locator('#nav [data-view="studio"]').click();
      await page.locator('[data-studio-mode="campaign"]').click();
      await page.waitForLoadState("networkidle");
      phase = "inspection";
      const invalidRequests = requests.length, invalidSaves = attempts.length;
      await summary.click();
      check(await page.locator("#savedEvidenceStatus").getAttribute("data-state") === "unavailable"
        && await page.locator("#savedEvidenceText").innerText() === ""
        && await page.locator("#savedEvidenceCapturedAt").isHidden(), "malformed or unsupported persisted snapshot cannot present valid facts");
      check(requests.length === invalidRequests && attempts.length === invalidSaves, "invalid snapshot inspection sends no save or request");
    }
    persisted = intact;
    phase = "reload";
    await page.reload({waitUntil:"networkidle"});
    await openResults();
    const layout = await page.locator(".self-launch-draft").evaluate(element => ({
      overflow: element.scrollWidth > element.clientWidth,
      buttons: [...element.querySelectorAll("button")].filter(item => item.getClientRects().length).map(item => {
        const r = item.getBoundingClientRect();
        return { width: r.width, height: r.height, fits: r.left >= 0 && r.right <= innerWidth && item.scrollWidth <= item.clientWidth };
      })
    }));
    check(!layout.overflow && layout.buttons.every(item => item.fits && item.height >= 44), "preview and actions fit desktop/mobile with usable targets");
    await page.evaluate(() => { model.workspace.id = "different-workspace"; model.proof = []; renderProof(); });
    check(await page.locator("#selfLaunchPreview").isHidden() && await page.locator("#createSelfLaunch").isDisabled(), "workspace change clears selection preview and draft identity");
    check(pageErrors.length === 0, "no application page exceptions");
    const forbidden = requests.filter(item => ["evidence", "inspection"].includes(item.phase) && item.method === "POST"
      && !["/api/model", "/api/auth/device/heartbeat"].includes(item.path));
    check(forbidden.length === 0, "draft flow performs no provider generation approval or publishing action: " + JSON.stringify(forbidden));
    results.push({ profile: profile.name, ok: true, checks, requests, attempts: attempts.length, layout, pageErrors });
  } finally {
    await writeFile(path.join(output, profile.name + "-requests.json"), JSON.stringify(requests, null, 2));
    await context.close();
    await browser.close();
    if (results.at(-1)?.profile === profile.name) results.at(-1).resourcesClosed = true;
  }
}
const evidence = { ok: true, checks, fixtureOnly: true, externalRequestsDispatched: 0, results };
await writeFile(path.join(output, "browser-evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, checks, output, profiles: results.map(item => ({profile:item.profile,attempts:item.attempts,resourcesClosed:item.resourcesClosed})) }));
