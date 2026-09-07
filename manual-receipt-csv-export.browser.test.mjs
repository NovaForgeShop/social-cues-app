import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit } from "playwright";
import {
  createLocalPilot,
  projectRoot,
  syntheticPromoCode,
  syntheticSecondPromoCode
} from "./scripts/run-local-pilot.mjs";

const output = path.join(projectRoot, ".tmp", "p14-browser-" + Date.now());
await mkdir(output, { recursive: true });
const pilot = await createLocalPilot();
const password = "Synthetic-only-" + randomUUID() + "!";
const primaryEmail = "p14-" + randomUUID() + "@example.test";
const evidence = {
  checks: 0,
  applicationRoutesMocked: false,
  phases: [],
  modelPosts: [],
  localCellLoads: 0,
  externalBrowserBlocked: 0,
  downloads: 0,
  injectedFailures: [
    "Hold a successful local export-review GET while the in-page workspace changes",
    "Replace one successful local export-review GET response with a synthetic 503",
    "Suppress one successful local normal-save response"
  ],
  cleanupComplete: false
};
const check = (ok, label) => { assert.ok(ok, label); evidence.checks++; };
const equal = (actual, expected, label = "values match") => {
  assert.deepEqual(actual, expected, label);
  evidence.checks++;
};
const phase = label => { evidence.phases.push(label); console.log("P14: " + label); };
const settle = page => page.evaluate(async () => { await hostedModelSaveChain.catch(() => {}); });
const current = page => page.evaluate(async () => (await authedFetch("/api/model")).json());
const bytes = () => readFile(path.join(pilot.dataDir, "model.json"));
const results = page => page.evaluate(() => jump("proof"));
const exportState = (page, expected) => page.waitForFunction(value => {
  const status = document.querySelector("#manualCsvExportStatus");
  return status?.dataset.state === value && !manualCsvExportState.busy;
}, expected);
const importState = (page, expected) => page.waitForFunction(value => {
  const status = document.querySelector("#manualCsvStatus");
  return status?.dataset.state === value && !manualCsvState.busy;
}, expected);
const exportRow = (page, text) => page.locator("[data-csv-export-row]").filter({ hasText: text });
const openExport = async (page, expected = "review") => {
  await results(page);
  await page.locator("#exportManualCsv").click();
  await exportState(page, expected);
};
const openImport = async (page, file, expected = "review") => {
  await results(page);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#importManualCsv").click();
  await (await chooser).setFiles(file);
  await importState(page, expected);
};
const signup = async (page, email, promo) => {
  await page.goto(pilot.url + "/portal?stay=1");
  await page.locator("#createBtn").click();
  await page.locator("#nameInput").fill("Synthetic P14");
  await page.locator("#emailInput").fill(email);
  await page.locator("#passwordInput").fill(password);
  await page.locator("#promoInput").fill(promo);
  await page.locator("#createBtn").click();
  await page.waitForURL(/\/app/);
  await page.waitForLoadState("networkidle");
  await page.locator("#businessNameInput").fill("Synthetic CSV export pilot");
  await page.locator("#websiteInput").fill("https://example.test/p14");
  await page.locator("#completeOnboarding").click();
  await page.waitForFunction(() => !document.body.classList.contains("onboarding-scene"));
  await settle(page);
};

const columns = ["campaignId", "variantId", "postedUrl", "postedLocal", "postedTimezone", "metric", "metricValue", "observedLocal", "observedTimezone", "note"];
const campaignId = "synthetic-p14-campaign";
const receiptVariantId = "synthetic-p14-facebook";
const resultVariantId = "synthetic-p14-linkedin";
const receiptUrl = "https://example.test/p14-formula";
const resultUrl = "https://example.test/p14-zero";
const unselectedUrl = "https://example.test/p14-unselected";
const oldNote = '=HYPERLINK("https://outside.invalid/p14","old, quoted")\nold <img src="https://outside.invalid/p14-cell-load">';
const updatedNote = '=HYPERLINK("https://outside.invalid/p14","new, quoted")\nnew <img src="https://outside.invalid/p14-cell-load">';
const providerSentinel = "p14-private-provider-evidence";
const queueSentinel = "p14-private-queue-record";
const briefSentinel = "p14-private-campaign-brief";
const snapshotTime = "2026-09-03T19:27:41Z";
const approvalTime = "2026-09-01T12:34:56Z";
const legacySentinel = "p14-private-legacy-evidence";

let desktop;
let mobile;
let primaryDesktopContext;
let primaryMobileContext;
let otherContext;
let a;
let b;
let c;
let failure;
try {
  await pilot.start();
  desktop = await chromium.launch({ headless: true });
  mobile = await webkit.launch({ headless: true });
  const newContext = async (browser, client, viewport) => {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === pilot.url) return route.continue();
      evidence.externalBrowserBlocked++;
      return route.abort();
    });
    context.on("request", request => {
      const url = new URL(request.url());
      if (url.origin === pilot.url && url.pathname === "/p14-cell-load") evidence.localCellLoads++;
      if (request.method() === "POST" && url.origin === pilot.url && url.pathname === "/api/model") {
        const body = request.postDataJSON();
        evidence.modelPosts.push({
          client,
          operationId: body.operationId,
          expectedRevision: body.expectedRevision,
          sha256: createHash("sha256").update(request.postData()).digest("hex")
        });
      }
    });
    context.on("download", () => { evidence.downloads++; });
    return context;
  };

  primaryDesktopContext = await newContext(desktop, "A", { width: 1440, height: 1000 });
  primaryMobileContext = await newContext(mobile, "B", { width: 390, height: 844 });
  a = await primaryDesktopContext.newPage();
  b = await primaryMobileContext.newPage();

  phase("fresh authenticated workspace with mixed manual and excluded evidence");
  await signup(a, primaryEmail, syntheticPromoCode);
  await a.evaluate(async fixtures => {
    const campaign = {
      id: fixtures.campaignId,
      title: "Synthetic P14 campaign",
      brief: fixtures.briefSentinel,
      variants: [
        { id: fixtures.receiptVariantId, platform: "facebook", copy: "Approved synthetic copy", status: "approved", approvedAt: fixtures.approvalTime, tags: [], flags: [] },
        { id: fixtures.resultVariantId, platform: "linkedin", copy: "Draft synthetic copy", status: "draft", tags: [], flags: [] }
      ]
    };
    const receipt = {
      id: "synthetic-p14-receipt",
      source: "manual",
      schemaVersion: "social-cues.manual-proof.v1",
      type: "posting-receipt",
      campaignId: campaign.id,
      campaignTitle: campaign.title,
      variantId: campaign.variants[0].id,
      platform: "facebook",
      postedUrl: fixtures.receiptUrl,
      postedAt: "2026-09-01T10:15:30-04:00",
      postedTimezone: "-04:00",
      metric: "",
      metricValue: "",
      observedAt: "",
      observedTimezone: "",
      note: fixtures.oldNote,
      createdAt: "2026-09-02T12:00:00Z",
      updatedAt: "2026-09-02T12:00:00Z"
    };
    const result = {
      id: "synthetic-p14-zero",
      source: "manual",
      schemaVersion: "social-cues.manual-proof.v1",
      type: "observed-result",
      campaignId: campaign.id,
      campaignTitle: campaign.title,
      variantId: campaign.variants[1].id,
      platform: "linkedin",
      postedUrl: fixtures.resultUrl,
      postedAt: "2026-09-01T11:00+05:30",
      postedTimezone: "+05:30",
      metric: "@Views",
      metricValue: "0",
      observedAt: "2026-09-02T12:00+05:30",
      observedTimezone: "+05:30",
      note: "",
      createdAt: "2026-09-02T13:00:00Z",
      updatedAt: "2026-09-02T13:00:00Z"
    };
    const unselected = {
      ...receipt,
      id: "synthetic-p14-unselected",
      postedUrl: fixtures.unselectedUrl,
      note: "Eligible but not selected",
      createdAt: "2026-09-02T14:00:00Z",
      updatedAt: "2026-09-02T14:00:00Z"
    };
    model.campaigns = [campaign];
    model.activeCampaignId = campaign.id;
    model.proof = [receipt, result, unselected, {
      id: "synthetic-p14-provider-legacy",
      type: "Provider banked",
      metric: "Meta provider banked",
      note: fixtures.providerSentinel,
      createdAt: "2026-09-02T15:00:00Z"
    }, {
      id: "synthetic-p14-legacy",
      type: "action",
      metric: "Legacy note",
      note: fixtures.legacySentinel,
      createdAt: "2026-09-02T16:00:00Z"
    }];
    campaign.evidenceSnapshot = buildSelfLaunchEvidence(model.proof, [receipt.id], fixtures.snapshotTime);
    model.publishQueue = [{ id: fixtures.queueSentinel, variantId: receipt.variantId, status: "draft" }];
    await saveModel();
    render();
  }, { campaignId, receiptVariantId, resultVariantId, receiptUrl, resultUrl, unselectedUrl, oldNote, providerSentinel, legacySentinel, queueSentinel, briefSentinel, snapshotTime, approvalTime });
  await settle(a);

  await b.goto(pilot.url + "/portal?stay=1");
  await b.locator("#emailInput").fill(primaryEmail);
  await b.locator("#passwordInput").fill(password);
  await b.locator("#loginBtn").click();
  await b.waitForURL(/\/app/);
  await b.waitForLoadState("networkidle");

  phase("mobile review defaults to no selection and cancellation writes nothing");
  const beforeReviewBytes = await bytes();
  const beforeReviewPosts = evidence.modelPosts.length;
  const beforeReviewDownloads = evidence.downloads;
  await openExport(b);
  check(await b.locator("[data-csv-export-row]").count() === 3, "three compatible current-workspace manual records are reviewable");
  check(await b.locator("[data-csv-export-select]:checked").count() === 0, "review selects no records by default");
  check(await b.locator("#downloadManualCsvExport").isDisabled(), "download is disabled without explicit selection");
  const excludedText = await b.locator("[data-csv-export-excluded]").innerText();
  check(excludedText.includes("Provider-derived evidence is excluded") && excludedText.includes("Legacy evidence is excluded"), "provider-derived and legacy evidence have specific reason counts");
  check(!(await b.locator("#manualCsvExportRows").innerText()).includes(providerSentinel)
    && !(await b.locator("#manualCsvExportRows").innerText()).includes(legacySentinel), "excluded provider and legacy contents are hidden");
  const receiptReview = exportRow(b, receiptUrl);
  const resultReview = exportRow(b, resultUrl);
  const unselectedReview = exportRow(b, unselectedUrl);
  check(await receiptReview.count() === 1 && await resultReview.count() === 1 && await unselectedReview.count() === 1, "every eligible association is shown before selection");
  check((await receiptReview.innerText()).includes(campaignId + " / " + receiptVariantId + " / facebook"), "campaign variant and derived platform are shown");
  check((await receiptReview.innerText()).includes("postedLocal: 2026-09-01T10:15:30") && (await receiptReview.innerText()).includes("postedTimezone: -04:00"), "posting wall time and offset are shown");
  check((await resultReview.innerText()).includes("metric: @Views") && (await resultReview.innerText()).includes("metricValue: 0"), "observed zero and formula-leading metric are shown");
  check((await resultReview.innerText()).includes("note: "), "blank note remains explicitly visible");
  check(await b.locator("#manualCsvExportRows img").count() === 0 && evidence.localCellLoads === 0, "reviewed cell text is inert");
  check((await b.locator("#manualCsvExportRows").innerText()).includes("not provider-verified"), "manual unverified provenance is visible");
  const receiptCheckbox = receiptReview.locator("[data-csv-export-select]");
  await receiptCheckbox.focus();
  await b.keyboard.press("Space");
  check(await receiptCheckbox.isChecked() && await receiptCheckbox.evaluate(element => element === document.activeElement), "keyboard selects a record without losing focus");
  await b.locator("#refreshManualCsvExport").focus();
  const reached = new Set();
  for (let index = 0; index < 3; index++) {
    reached.add(await b.evaluate(() => document.activeElement.id));
    await b.keyboard.press("Tab");
  }
  check(["refreshManualCsvExport", "downloadManualCsvExport", "cancelManualCsvExport"].every(id => reached.has(id)), "keyboard reaches every export action");
  check(await b.locator("#manualCsvExportDialog .losing-footer button").evaluateAll(buttons => buttons.every(button => {
    const rect = button.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
  })), "mobile export actions remain inside the viewport");
  await b.screenshot({ path: path.join(output, "review-mobile.png") });
  await b.keyboard.press("Escape");
  check(!await b.locator("#manualCsvExportDialog").evaluate(element => element.open), "Escape cancels export review");
  check((await bytes()).equals(beforeReviewBytes) && evidence.modelPosts.length === beforeReviewPosts, "review selection and cancel perform no workspace write");
  check(evidence.downloads === beforeReviewDownloads, "cancel creates no download");

  phase("explicit refresh reveals a newer saved revision without relabeling the old snapshot");
  await openExport(b);
  const staleReceipt = exportRow(b, receiptUrl);
  await staleReceipt.locator("[data-csv-export-select]").check();
  const reviewedStatus = await b.locator("#manualCsvExportStatus").innerText();
  check(reviewedStatus.includes("Reviewed saved revision") && reviewedStatus.includes("Download uses this reviewed snapshot") && reviewedStatus.includes("refresh"), "review labels its saved snapshot and refresh requirement");
  await a.reload({ waitUntil: "networkidle" });
  await a.evaluate(async ({ receiptUrl: targetUrl, updatedNote: note }) => {
    model.proof.find(item => item.postedUrl === targetUrl).note = note;
    await saveModel();
  }, { receiptUrl, updatedNote });
  await settle(a);
  check((await staleReceipt.innerText()).includes(oldNote) && !(await staleReceipt.innerText()).includes(updatedNote), "open review remains the explicitly labeled older snapshot");
  check(!await b.locator("#downloadManualCsvExport").isDisabled(), "reviewed snapshot remains downloadable as labeled");
  await b.locator("#refreshManualCsvExport").click();
  await exportState(b, "review");
  const refreshedReceipt = exportRow(b, receiptUrl);
  check((await refreshedReceipt.innerText()).includes(updatedNote) && !(await refreshedReceipt.innerText()).includes(oldNote), "explicit refresh shows the newer saved manual fact");
  check(await refreshedReceipt.locator("[data-csv-export-select]").isChecked(), "refresh retains an explicit selection for the same saved record");
  await exportRow(b, resultUrl).locator("[data-csv-export-select]").check();
  check(await exportRow(b, unselectedUrl).locator("[data-csv-export-select]").isChecked() === false, "eligible third record remains outside the explicit subset");
  check((await b.locator("#downloadManualCsvExport").innerText()).includes("(2)"), "download reports the exact selected subset size");

  phase("versioned download preserves exact facts and excludes all non-column state");
  const beforeDownloadModel = await current(b);
  const beforeDownloadBytes = await bytes();
  const beforeDownloadPosts = evidence.modelPosts.length;
  const downloadEvent = b.waitForEvent("download");
  await b.locator("#downloadManualCsvExport").click();
  const download = await downloadEvent;
  const downloadedCsv = path.join(output, "reviewed-manual-receipts.csv");
  await download.saveAs(downloadedCsv);
  check(download.suggestedFilename() === "Social-Cues-reviewed-manual-receipts.csv", "download uses the reviewed manual receipt filename");
  const raw = await readFile(downloadedCsv, "utf8");
  const rawRows = await b.evaluate(text => parseManualReceiptCsvRows(text), raw);
  equal(rawRows[0], ["social-cues-manual-receipts-export.v1"], "exact export marker is first");
  equal(rawRows[1], columns, "exact existing ten-column order is second");
  check(rawRows.length === 4, "marker header and exactly two selected records are emitted");
  const encodedReceipt = rawRows.find(row => row[2] === receiptUrl);
  const encodedResult = rawRows.find(row => row[2] === resultUrl);
  const literalPrefix = await b.evaluate(() => manualCsvLiteralPrefix);
  check(encodedReceipt[9].startsWith(literalPrefix) && encodedReceipt[9].slice(literalPrefix.length) === updatedNote, "formula-leading quoted multiline note is reversibly protected");
  check(encodedResult[5].startsWith(literalPrefix) && encodedResult[5].slice(literalPrefix.length) === "@Views", "formula-leading metric is reversibly protected");
  check(encodedResult[6] === "0" && encodedResult[9] === "", "measured zero and blank note remain distinct");
  const decodedRows = await b.evaluate(text => parseManualReceiptCsv(text), raw);
  check(decodedRows[0][9] === updatedNote && decodedRows[1][5] === "@Views" && decodedRows[1][6] === "0", "marked import decoder restores exact selected facts");
  check(decodedRows[0][3] === "2026-09-01T10:15:30" && decodedRows[0][4] === "-04:00", "posting time and offset round-trip exactly");
  check(decodedRows[1][7] === "2026-09-02T12:00" && decodedRows[1][8] === "+05:30", "observation time and offset round-trip exactly");
  for (const forbidden of [unselectedUrl, providerSentinel, legacySentinel, queueSentinel, briefSentinel, snapshotTime, approvalTime,
    "synthetic-p14-receipt", "synthetic-p14-zero", primaryEmail, beforeDownloadModel.currentUser.id, beforeDownloadModel.workspace.id]) {
    check(!raw.includes(forbidden), "download excludes private or non-column state: " + forbidden);
  }
  check(!raw.includes("schemaVersion") && !raw.includes("providerReceipt") && !raw.includes("evidenceSnapshot") && !raw.includes("publishQueue"), "download contains no model metadata families");
  const afterDownloadModel = await current(b);
  equal(afterDownloadModel.proof, beforeDownloadModel.proof, "download does not mutate evidence or verification state");
  equal(afterDownloadModel.campaigns, beforeDownloadModel.campaigns, "download does not mutate campaigns or frozen snapshots");
  check((await bytes()).equals(beforeDownloadBytes) && evidence.modelPosts.length === beforeDownloadPosts, "download performs no workspace write");
  check(evidence.localCellLoads === 0 && evidence.externalBrowserBlocked === 0, "review and download neither visit nor execute cell URLs");

  phase("downloaded app file reimports as exact duplicates before and after reload");
  await b.locator("#cancelManualCsvExport").click();
  const beforeImportReview = await bytes();
  const beforeImportPosts = evidence.modelPosts.length;
  await openImport(b, downloadedCsv);
  check(await b.locator("[data-csv-row]").count() === 2, "downloaded selected records are readable by the existing importer");
  check(await b.locator("[data-csv-select]:not(:disabled)").count() === 0 && await b.locator("#confirmManualCsv").isDisabled(), "exact saved records cannot be appended again");
  check((await b.locator("#manualCsvRows").innerText()).split("Exact existing manual record").length - 1 === 2, "both marked rows are identified as exact existing records");
  check((await bytes()).equals(beforeImportReview) && evidence.modelPosts.length === beforeImportPosts, "duplicate review writes nothing");
  await b.locator("#cancelManualCsv").click();
  await b.reload({ waitUntil: "networkidle" });
  await openImport(b, downloadedCsv);
  check(await b.locator("[data-csv-select]:not(:disabled)").count() === 0, "reload preserves duplicate exclusion for the marked file");
  await b.locator("#cancelManualCsv").click();
  await results(b);
  const templateEvent = b.waitForEvent("download");
  await b.locator("#manualCsvTemplate").click();
  const template = await templateEvent;
  const templatePath = path.join(output, "template.csv");
  await template.saveAs(templatePath);
  check((await readFile(templatePath, "utf8")).replace(/^\uFEFF/, "") === columns.join(",") + "\r\n", "header-only external template remains unchanged and unmarked");

  phase("workspace context change during a real review hides evidence and disables export");
  const contextBytes = await bytes();
  const contextPosts = evidence.modelPosts.length;
  await b.evaluate(() => {
    const original = window.fetch;
    let hold = true;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (hold && String(args[0]).endsWith("/api/model") && !args[1]?.method) {
        hold = false;
        window.p14ReviewHeld = true;
        await new Promise(resolve => { window.p14ReviewRelease = resolve; });
      }
      return response;
    };
  });
  await results(b);
  await b.locator("#exportManualCsv").click();
  await b.waitForFunction(() => window.p14ReviewHeld);
  await b.evaluate(() => {
    window.p14OriginalWorkspace = model.workspace.id;
    model.workspace.id = "synthetic-p14-context-shift";
    window.p14ReviewRelease();
  });
  await exportState(b, "context");
  check(await b.locator("[data-csv-export-row]").count() === 0, "changed context hides all reviewed rows");
  check(await b.locator("#downloadManualCsvExport").isDisabled() && await b.locator("#refreshManualCsvExport").isDisabled(), "changed context disables download and refresh");
  check((await bytes()).equals(contextBytes) && evidence.modelPosts.length === contextPosts, "context-change failure sends no write");
  await b.evaluate(() => { model.workspace.id = window.p14OriginalWorkspace; renderManualCsvExport(); });
  await b.locator("#cancelManualCsvExport").click();

  phase("a separate authenticated workspace cannot review the primary workspace receipts");
  otherContext = await newContext(desktop, "C", { width: 1200, height: 900 });
  c = await otherContext.newPage();
  await signup(c, "p14-other-" + randomUUID() + "@example.test", syntheticSecondPromoCode);
  const otherBytes = await bytes();
  const otherPosts = evidence.modelPosts.length;
  await openExport(c);
  check(await c.locator("[data-csv-export-row]").count() === 0, "second workspace has no eligible primary-workspace records");
  const otherText = await c.locator("#manualCsvExportRows").innerText();
  check(!otherText.includes(campaignId) && !otherText.includes(receiptUrl) && !otherText.includes(updatedNote), "second workspace receives no primary-workspace fact content");
  check(await c.locator("#downloadManualCsvExport").isDisabled(), "empty second-workspace review cannot download");
  check((await bytes()).equals(otherBytes) && evidence.modelPosts.length === otherPosts, "second-workspace review writes nothing");
  await c.locator("#cancelManualCsvExport").click();

  phase("an earlier unknown save blocks review until the identical operation is reconciled");
  await b.reload({ waitUntil: "networkidle" });
  const unknownStart = evidence.modelPosts.length;
  await b.evaluate(() => {
    const original = window.fetch;
    let suppress = true;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (suppress && String(args[0]).endsWith("/api/model") && args[1]?.method === "POST" && response.ok) {
        suppress = false;
        await response.clone().text();
        throw new TypeError("Synthetic lost P14 normal-save response");
      }
      return response;
    };
    const snapshot = sanitizedModelSnapshot(model);
    snapshot.campaigns[0].brief = "P14 confirmed normal-save winner";
    window.p14UnknownSave = enqueueHostedModelSave(snapshot).catch(error => error.message);
  });
  await b.waitForFunction(() => workspaceSaveState.blocked === "unknown" && workspaceSaveState.pending !== null);
  check(evidence.modelPosts.length === unknownStart + 1, "one real normal save reached the local server before its response was suppressed");
  const unknownBytes = await bytes();
  const unknownDownloads = evidence.downloads;
  await openExport(b, "error");
  check((await b.locator("#manualCsvExportStatus").innerText()).includes("Reconcile the original unresolved save"), "unknown operation produces explicit reconciliation guidance");
  check(await b.locator("[data-csv-export-row]").count() === 0 && await b.locator("#downloadManualCsvExport").isDisabled(), "unknown operation exposes no exportable rows or download");
  check((await bytes()).equals(unknownBytes) && evidence.modelPosts.length === unknownStart + 1 && evidence.downloads === unknownDownloads, "blocked export sends no second write or download");
  await b.locator("#cancelManualCsvExport").click();
  await b.locator("#retryWorkspaceSave").click();
  await b.waitForFunction(() => workspaceSaveState.pending === null && workspaceSaveState.blocked === "conflict");
  const reconciledPosts = evidence.modelPosts.slice(unknownStart);
  check(reconciledPosts.length === 2 && reconciledPosts[0].operationId === reconciledPosts[1].operationId
    && reconciledPosts[0].sha256 === reconciledPosts[1].sha256, "unknown save retries only the byte-identical original operation");
  check((await b.locator("#workspaceSaveNotice").innerText()).includes("Original save confirmed"), "confirmed retry still requires an explicit current-content review");
  await b.locator("#reviewWorkspaceSave").click();
  await b.waitForFunction(() => workspaceSaveState.pending === null && workspaceSaveState.blocked === "");
  check((await current(b)).campaigns[0].brief === "P14 confirmed normal-save winner", "reconciliation confirms the original saved winner");

  phase("failed saved-content confirmation disables export without a write");
  const failedGetBytes = await bytes();
  const failedGetPosts = evidence.modelPosts.length;
  await b.evaluate(() => {
    const original = window.fetch;
    let fail = true;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (fail && String(args[0]).endsWith("/api/model") && !args[1]?.method) {
        fail = false;
        await response.clone().text();
        return new Response(JSON.stringify({ ok: false, error: "Synthetic review confirmation failure" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      }
      return response;
    };
  });
  await openExport(b, "error");
  check((await b.locator("#manualCsvExportStatus").innerText()).includes("could not be confirmed"), "failed current-save confirmation is explicit");
  check(await b.locator("[data-csv-export-row]").count() === 0 && await b.locator("#downloadManualCsvExport").isDisabled(), "failed confirmation clears rows and disables download");
  check((await bytes()).equals(failedGetBytes) && evidence.modelPosts.length === failedGetPosts, "failed confirmation writes nothing");
  await b.locator("#cancelManualCsvExport").click();

  phase("restart preserves manual facts and export behavior on desktop and mobile");
  const beforeRestart = await current(b);
  await pilot.restart();
  await b.reload({ waitUntil: "networkidle" });
  const afterRestart = await current(b);
  equal(afterRestart.proof, beforeRestart.proof, "restart retains all proof records exactly");
  equal(afterRestart.campaigns, beforeRestart.campaigns, "restart retains campaigns and frozen evidence exactly");
  await openExport(b);
  check(await b.locator("[data-csv-export-row]").count() === 3 && (await exportRow(b, receiptUrl).innerText()).includes(updatedNote), "mobile review survives restart with the latest saved facts");
  await b.locator("#cancelManualCsvExport").click();
  await a.reload({ waitUntil: "networkidle" });
  await openExport(a);
  check(await a.locator("[data-csv-export-row]").count() === 3, "desktop review exposes the same three eligible records");
  check(await a.locator("#manualCsvExportDialog .losing-footer button").evaluateAll(buttons => buttons.every(button => {
    const rect = button.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
  })), "desktop export actions remain inside the viewport");
  await a.screenshot({ path: path.join(output, "review-desktop.png") });
  await a.locator("#cancelManualCsvExport").click();
  check(evidence.localCellLoads === 0 && evidence.externalBrowserBlocked === 0, "all displayed CSV values remain inert across both engines");

  await writeFile(path.join(pilot.dataDir, "pilot-access.json"), JSON.stringify({ email: primaryEmail, password }, null, 2), { flag: "wx" });
  evidence.pilotUrl = pilot.url;
  evidence.dataDir = pilot.dataDir;
  evidence.downloadedCsv = downloadedCsv;
} catch (error) {
  failure = error;
} finally {
  await primaryDesktopContext?.close();
  await primaryMobileContext?.close();
  await otherContext?.close();
  await desktop?.close();
  await mobile?.close();
  await pilot.stop();
  const summary = await pilot.summary();
  evidence.dataDir = pilot.dataDir;
  evidence.server = summary;
  const absent = async name => access(path.join(pilot.dataDir, name)).then(() => false, error => {
    if (error.code === "ENOENT") return true;
    throw error;
  });
  const pilotLockAbsent = await absent("pilot.lock");
  const workspaceLockAbsent = await absent(".workspace-content.lock");
  evidence.cleanupChecks = { serverStopped: !summary.running, pilotLockAbsent, workspaceLockAbsent };
  evidence.cleanupComplete = !summary.running && pilotLockAbsent && workspaceLockAbsent;
  try {
    check(evidence.cleanupComplete, "task-owned server stopped and both lock files are absent");
    check(summary.externalProviderRequestsDispatched === 0 && summary.blockedProviderAttempts === 0
      && summary.providerFixtureHits === 0, "zero external dispatch, blocked provider attempts, or provider fixture requests");
  } catch (error) {
    failure ||= error;
  }
  evidence.ok = !failure;
  if (failure) evidence.failure = failure.message;
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
}

console.log(JSON.stringify({
  ok: !failure,
  checks: evidence.checks,
  output,
  dataDir: pilot.dataDir,
  cleanupComplete: evidence.cleanupComplete,
  externalProviderRequestsDispatched: evidence.server?.externalProviderRequestsDispatched
}));
if (failure) throw failure;
