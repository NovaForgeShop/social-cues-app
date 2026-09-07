import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, webkit } from "playwright";
import { html, campaigns } from "./manual-proof.contract.test.mjs";

const output = fileURLToPath(new URL("./test-results/manual-proof/", import.meta.url));
await mkdir(output, { recursive: true });
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
const results = [];
const legacy = [
  { id: "legacy-unassociated", type: "customer", metric: "Pilot note", note: "Original legacy text", createdAt: "2026-08-01T00:00:00Z" },
  { id: "legacy-associated", type: "action", metric: "Existing campaign action", note: "<script>not markup</script>",
    campaignId: "other", createdAt: "2026-08-02T00:00:00Z" }
];
for (const profile of [
  { name: "desktop-chromium", engine: chromium, viewport: { width: 1440, height: 1000 } },
  { name: "mobile-chromium", engine: chromium, viewport: { width: 390, height: 844 }, isMobile: true },
  { name: "mobile-webkit", engine: webkit, viewport: { width: 390, height: 844 }, isMobile: true }
]) {
  const browser = await profile.engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: !!profile.isMobile,
    hasTouch: !!profile.isMobile, serviceWorkers: "block", acceptDownloads: true, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const requests = [], pageErrors = [], snapshots = [], attempts = [];
  let persisted = null, failNext = false, saves = 0, phase = "boot";
  page.on("pageerror", error => pageErrors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ origin: url.origin, path: url.pathname, method: request.method(), phase });
    if (url.origin !== "http://127.0.0.1:4178") return route.abort();
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/app") return route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (url.pathname === "/api/auth/session" && persisted) return json(200, { ok: true, user: persisted.currentUser, workspace: persisted.workspace });
    if (url.pathname === "/api/auth/device/heartbeat") return json(200, { ok: true });
    if (url.pathname === "/api/model" && persisted) {
      if (request.method() === "GET") return json(200, persisted);
      if (request.method() === "POST") {
        saves += 1;
        attempts.push(request.postDataJSON());
        if (failNext) { failNext = false; return json(503, { error: "Synthetic save unavailable" }); }
        persisted = request.postDataJSON();
        snapshots.push(structuredClone(persisted));
        return json(200, { ok: true });
      }
    }
    return json(401, { ok: false, error: "Synthetic fixture: endpoint unavailable" });
  });
  const feedback = state => page.waitForFunction(expected =>
    document.querySelector("#proofFeedback").dataset.state === expected, state);
  const openResults = async () => {
    if (profile.isMobile) await page.locator("#mobileViewSelect").selectOption("calendar");
    else await page.locator('#nav [data-view="calendar"]').click();
    await page.locator("#openManualResults").click();
    await page.locator("#manualProofForm").waitFor({ state: "visible" });
  };
  const readiness = () => page.evaluate(() => JSON.stringify({
    campaigns: model.campaigns, queue: model.publishQueue, checks: model.functionChecks,
    integrations: model.integrations, evidence: facebookPageEvidence(null, metaState)
  }));
  const observation = page.locator("#proofObservation");
  const toggle = page.locator("#proofObservationToggle");
  const observationOpen = () => observation.evaluate(element => element.open);
  const observationValues = () => page.evaluate(() =>
    ["proofMetricInput", "proofValueInput", "proofObservedInput", "proofObservedZoneInput"]
      .map(id => document.getElementById(id).value));
  const settledScreenshot = async name => {
    await page.locator("#proof").evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    await page.screenshot({ path: path.join(output, profile.name + name + ".png"), fullPage: true });
  };
  const reload = async () => {
    phase = "boot";
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => hostedModelHydrated && model.currentUser?.id === "manual-operator");
    await page.waitForLoadState("networkidle");
    await openResults();
    phase = "form";
  };
  try {
    await page.goto("http://127.0.0.1:4178/app", { waitUntil: "load" });
    persisted = await page.evaluate(async seed => {
      await bootApp();
      model = normalizeModel(clone(defaultModel));
      model.currentUser = { id: "manual-operator", name: "Pilot operator", email: "operator@example.test" };
      model.workspace.id = "manual-workspace";
      model.workspace.name = "Synthetic manual pilot";
      model.onboarding.complete = true;
      model.onboarding.selectedPlatforms = ["facebook", "linkedin"];
      model.campaigns = seed.campaigns;
      model.activeCampaignId = seed.campaigns[0].id;
      model.proof = seed.legacy;
      model.publishQueue = [{ id: "existing-queue", status: "queued", variantId: "manual-post" }];
      hostedModelHydrated = true;
      render();
      return JSON.parse(JSON.stringify(model));
    }, { campaigns, legacy });
    await reload();
    check((await page.locator("#manualProofList").innerText()).includes("No manual receipts yet"), "empty state");
    check((await page.locator("#legacyProofList").innerText()).includes("Unassociated legacy entry"), "legacy association not guessed");
    check(await page.locator("#legacyProofList button").count() === 0, "legacy preserved read-only");
    check(await page.locator("#legacyProofList script").count() === 0, "legacy text escaped");
    const before = await readiness();
    check(await page.locator("#proofCampaignInput").inputValue() === "manual-campaign", "Plan preselects active campaign");
    check(!(await observationOpen()) && !(await page.locator("#proofMetricInput").isVisible()), "new receipt hides optional measurement fields");
    check(await page.locator("#proofUrlInput").inputValue() === "" && await page.locator("#proofPostedInput").inputValue() === ""
      && await page.locator("#proofPostedZoneInput").inputValue() === "", "Plan does not invent URL posting time or offset");
    await toggle.focus();
    await page.keyboard.press("Tab");
    check(await page.locator("#proofNoteInput").evaluate(element => element === document.activeElement), "keyboard skips collapsed measurement inputs");
    await toggle.focus();
    await page.keyboard.press("Enter");
    check(await observationOpen(), "keyboard expands native disclosure");
    check(await toggle.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth) >= 2), "keyboard focus has a visible outline");
    await page.keyboard.press("Tab");
    check(await page.locator("#proofMetricInput").evaluate(element => element === document.activeElement), "keyboard reaches expanded measurement fields");
    await toggle.focus();
    await page.keyboard.press("Space");
    check(!(await observationOpen()), "keyboard collapses native disclosure");
    await page.locator("#proofCampaignInput").selectOption("other");
    await openResults();
    check(await page.locator("#proofCampaignInput").inputValue() === "other", "Plan preserves explicit draft association");
    await page.locator("#newManualProof").click();
    await page.locator("#proofNoteInput").fill("Synthetic in-progress note");
    await openResults();
    check(await page.locator("#proofCampaignInput").inputValue() === ""
      && await page.locator("#proofNoteInput").inputValue() === "Synthetic in-progress note", "Plan preserves incomplete draft even with blank association");
    await page.locator("#newManualProof").click();
    await openResults();
    await settledScreenshot("-collapsed");
    const contrast = await page.locator("#saveManualProof").evaluate(element => {
      const style = getComputedStyle(element);
      const luminance = css => css.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255)
        .map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
        .reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
      const a = luminance(style.color), b = luminance(style.backgroundColor);
      return { foreground: style.color, background: style.backgroundColor,
        ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
    check(contrast.ratio >= 4.5, "receipt save label meets normal-text contrast");
    const saveCount = saves;
    await page.locator("#saveManualProof").click();
    await feedback("error");
    check(saves === saveCount, "empty submission never saved");
    await page.locator("#proofCampaignInput").selectOption("manual-campaign");
    await page.locator("#proofVariantInput").selectOption("manual-post");
    check(await page.locator("#proofPlatformInput").inputValue() === "Facebook Pages", "platform comes from variant");
    await page.locator("#proofUrlInput").fill("javascript:invalid");
    await page.locator("#proofPostedInput").fill("2026-09-01T09:30");
    await page.locator("#proofNoteInput").fill("Facebook publish dry-run proven. Facebook Pages provider banked. <b>operator note</b>");
    await page.locator("#saveManualProof").click();
    await feedback("error");
    check(saves === saveCount && await page.locator("#proofUrlInput").inputValue() === "javascript:invalid", "invalid URL retained without save");
    await page.locator("#proofUrlInput").fill("https://www.facebook.com/example/posts/synthetic-001");
    await page.locator("#proofPostedZoneInput").selectOption("-04:00");
    failNext = true;
    await page.locator("#saveManualProof").click();
    await feedback("error");
    const failedNewId = attempts.at(-1).proof.find(item => item.source === "manual").id;
    check(await page.locator("#proofUrlInput").inputValue() === "https://www.facebook.com/example/posts/synthetic-001", "new receipt failure retains URL");
    check(persisted.proof.length === legacy.length, "new receipt failure preserves legacy-only saved state");
    await page.locator("#saveManualProof").click();
    await feedback("success");
    const receipt = persisted.proof.find(item => item.source === "manual");
    check(receipt.id === failedNewId, "new receipt retry retains its stable identity");
    check(receipt.type === "posting-receipt" && receipt.metricValue === "" && receipt.observedAt === "", "unknown results blank");
    check(receipt.postedAt === "2026-09-01T09:30-04:00" || receipt.postedAt === "2026-09-01T09:30:00-04:00", "explicit posting offset persisted");
    check(JSON.stringify(persisted.proof.filter(item => item.source !== "manual")) === JSON.stringify(legacy), "legacy entries preserved exactly");
    check(await readiness() === before, "queue approval and provider readiness unchanged by receipt");
    check(await page.locator("#manualProofList b").count() === 0, "manual note escaped");
    await writeFile(path.join(output, profile.name + "-receipt.json"), JSON.stringify(receipt, null, 2));
    await reload();
    check(await page.locator("#manualProofList [data-edit-proof]").count() === 1, "receipt survives actual reload");
    check((await page.locator("#manualProofList").innerText()).includes("Results not recorded"), "receipt is not mislabelled as observed result");
    await page.locator("#manualProofList [data-edit-proof]").click();
    check(await page.locator("#proofPostedZoneInput").inputValue() === "-04:00", "edit restores explicit offset");
    check(!(await observationOpen()), "receipt-only edit stays collapsed");
    await page.evaluate(() => { model.activeCampaignId = "other"; });
    await openResults();
    check(await page.locator("#proofCampaignInput").inputValue() === "manual-campaign", "Plan cannot overwrite an edited receipt with another active campaign");
    await page.evaluate(() => { model.activeCampaignId = "manual-campaign"; });
    await toggle.click();
    await page.locator("#proofMetricInput").fill("Views");
    await toggle.click();
    await page.locator("#saveManualProof").click();
    await feedback("error");
    check(await page.locator("#proofMetricInput").inputValue() === "Views", "partial result retained");
    check(await observationOpen(), "measurement validation error opens disclosure");
    check(await page.locator("#proofValueInput").evaluate(element => element === document.activeElement), "measurement validation focuses visible invalid field");
    await page.locator("#proofValueInput").fill("unknown");
    await page.locator("#proofObservedInput").fill("2026-08-31T10:00");
    await page.locator("#proofObservedZoneInput").selectOption("-04:00");
    const invalidCount = saves;
    await page.locator("#saveManualProof").click();
    await feedback("error");
    check(saves === invalidCount, "invalid value and pre-post observation rejected");
    await page.locator("#proofValueInput").fill("0");
    await page.locator("#proofObservedInput").fill("2026-09-02T10:00");
    const enteredObservation = await observationValues();
    await toggle.click();
    check(!(await observationOpen()) && JSON.stringify(await observationValues()) === JSON.stringify(enteredObservation), "collapse retains measured zero and all entered values");
    const beforeFailure = JSON.stringify(persisted.proof);
    failNext = true;
    await page.locator("#saveManualProof").click();
    await feedback("error");
    check((await page.locator("#proofFeedback").innerText()).includes("Save was not confirmed"), "failed save reported honestly");
    check(await page.locator("#proofValueInput").inputValue() === "0", "failure retains entered value");
    check((await page.locator("#proofObservedInput").inputValue()).startsWith("2026-09-02T10:00"), "failure retains entered measurement");
    check(JSON.stringify(persisted.proof) === beforeFailure, "failed save did not change persisted proof");
    check(await page.evaluate(() => JSON.stringify(model.proof)) === beforeFailure, "failed optimistic change rolled back");
    check(await page.locator("#saveManualProof").isEnabled(), "retry available after failure");
    check(!(await observationOpen()), "failed save preserves disclosure state without clearing hidden inputs");
    await page.locator("#saveManualProof").click();
    await feedback("success");
    check(persisted.proof[0].id === receipt.id && persisted.proof[0].metricValue === "0", "retry corrects same receipt with measured zero");
    check(persisted.proof[0].type === "observed-result", "measured result distinguished from receipt");
    await reload();
    await page.locator("#manualProofList [data-edit-proof]").click();
    check(await observationOpen() && await page.locator("#proofValueInput").inputValue() === "0", "editing measured zero automatically opens observation");
    await page.locator("#proofValueInput").fill("12");
    await page.locator("#proofUrlInput").fill("https://www.facebook.com/example/posts/synthetic-corrected");
    await page.locator("#proofNoteInput").fill("Corrected manual count; observed directly by the operator.");
    await page.locator("#saveManualProof").click();
    await feedback("success");
    check(persisted.proof.filter(item => item.source === "manual").length === 1, "correction does not duplicate receipt");
    check(persisted.proof[0].metricValue === "12" && persisted.proof[0].postedUrl.endsWith("synthetic-corrected"), "URL and result correction persisted");
    await reload();
    check((await page.locator("#manualProofList").innerText()).includes("Views: 12"), "corrected observation survives reload");
    check((await page.locator("#manualProofList").innerText()).includes("Manually recorded observed result"), "visible manual provenance");
    check(await readiness() === before, "queue approval and provider readiness unchanged after correction/reload");
    await page.locator("#manualProofList [data-edit-proof]").click();
    await page.evaluate(() => window.scrollTo(0, 0));
    const layout = await page.locator("#proof").evaluate(element => ({
      viewport: innerWidth, width: element.getBoundingClientRect().width,
      overflow: element.scrollWidth > element.clientWidth,
      fields: [...element.querySelectorAll("input,select,textarea,button,summary")].filter(item => item.getClientRects().length).map(item => {
        const r = (item.type === "checkbox" ? item.closest("label") : item).getBoundingClientRect();
        return { id: item.id, tag: item.tagName, left: r.left, right: r.right, height: r.height, fits: item.scrollWidth <= item.clientWidth };
      })
    }));
    await settledScreenshot("-observed");
    check(!layout.overflow && layout.fields.every(item => item.left >= 0 && item.right <= layout.viewport), "form fields fit viewport");
    check(layout.fields.every(item => item.height >= 44 && item.fits), "controls readable with usable targets: " + JSON.stringify(layout.fields));
    // Existing JSON content backup still carries the proof array and legacy fields.
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#exportContent").dispatchEvent("click");
    const download = await downloadPromise;
    const backupPath = path.join(output, profile.name + "-backup.json");
    await download.saveAs(backupPath);
    const backup = JSON.parse(await readFile(backupPath, "utf8"));
    check(backup.proof[0].metricValue === "12" && backup.proof.length === 3, "existing JSON export retains manual and legacy proof");
    await writeFile(path.join(output, profile.name + "-result.json"), JSON.stringify(persisted.proof[0], null, 2));
    const recorded = structuredClone(persisted.proof[0]);
    await page.locator("#clearProofObservation").click();
    check(!(await observationOpen()) && (await observationValues()).every(value => value === ""), "explicit clear empties all measurement fields and collapses");
    check(await toggle.evaluate(element => element === document.activeElement), "clear returns focus to disclosure");
    check(JSON.stringify(persisted.proof[0]) === JSON.stringify(recorded), "clearing form does not silently change stored observation");
    check(await page.locator("#proofUrlInput").inputValue() === recorded.postedUrl
      && await page.locator("#proofNoteInput").inputValue() === recorded.note, "clearing preserves posting facts and operator note");
    failNext = true;
    await page.locator("#saveManualProof").click();
    await feedback("error");
    check((await observationValues()).every(value => value === "") && persisted.proof[0].metricValue === "12", "failed clearing save retains blank draft and original measured result");
    await page.locator("#saveManualProof").click();
    await feedback("success");
    check(persisted.proof[0].id === recorded.id && persisted.proof[0].createdAt === recorded.createdAt
      && persisted.proof[0].type === "posting-receipt" && persisted.proof[0].metricValue === "", "saved clear preserves identity and distinguishes blank from measured zero");
    await reload();
    await page.locator("#manualProofList [data-edit-proof]").click();
    check(!(await observationOpen()) && (await observationValues()).every(value => value === ""), "cleared observation stays blank after reload and edit");
    check(await readiness() === before, "clearing does not affect approval queue or readiness");
    check(JSON.stringify(persisted.proof.filter(item => item.source !== "manual")) === JSON.stringify(legacy), "clearing preserves legacy records");
    await page.locator("#newManualProof").click();
    check(await page.locator("#proofValueInput").inputValue() === "" && await page.locator("#proofPostedZoneInput").inputValue() === "", "new receipt does not inherit result/timezone");
    await page.locator("#proofNoteInput").fill("Unsaved workspace-specific note");
    await toggle.click();
    await page.locator("#proofMetricInput").fill("Unsaved measurement");
    await page.evaluate(() => { model.workspace.id = "different-workspace"; model.proof = []; renderProof(); });
    check(await page.locator("#proofNoteInput").inputValue() === "", "workspace change clears unsaved form");
    check(!(await observationOpen()) && (await observationValues()).every(value => value === ""), "workspace change clears and collapses observation");
    check(pageErrors.length === 0, "no application exceptions: " + pageErrors.join("; "));
    // The inherited boot refresh POSTs /api/meta/health; form interactions must not.
    const forbidden = requests.filter(request => request.method === "POST"
      && !["/api/model", "/api/auth/device/heartbeat"].includes(request.path)
      && !(request.phase === "boot" && request.path === "/api/meta/health"));
    check(forbidden.length === 0, "no approval/publishing/provider-action requests: " + JSON.stringify(forbidden));
    results.push({ profile: profile.name, saves, successfulSnapshots: snapshots.length, contrast, layout, pageErrors,
      requestCount: requests.length, requests, externalRequestsDispatched: 0 });
  } finally {
    await context.close();
    await browser.close();
    if (results.at(-1)?.profile === profile.name) results.at(-1).browserClosed = true;
  }
}
const evidence = { ok: true, checks, fixtureOnly: true, externalRequestsDispatched: 0,
  policy: "Every request fulfilled synthetically or aborted; no provider or real application server contacted", results };
await writeFile(path.join(output, "browser-evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ...evidence, results: results.map(({ requests, ...rest }) => rest) }));
