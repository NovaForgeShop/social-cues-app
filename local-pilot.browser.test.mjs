import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright";
import { createLocalPilot, projectRoot } from "./scripts/run-local-pilot.mjs";
import { parseCsv } from "./posting-pack.contract.test.mjs";
import { project as recoveryContent } from "./content-recovery.contract.test.mjs";

export async function runPilotRehearsal() {
  const output = path.join(projectRoot, "test-results", "local-pilot", String(Date.now()));
  await mkdir(output, { recursive: true });
  const report = { synthetic: true, ok: false, checks: 0, output, profiles: [] };
  const check = (condition, message) => { assert.ok(condition, message); report.checks += 1; };
  try {
    for (const profile of [
      { name: "desktop-chromium", engine: chromium, viewport: { width: 1440, height: 1000 } },
      { name: "mobile-webkit", engine: webkit, viewport: { width: 390, height: 844 }, mobile: true }
    ]) {
      const pilot = await createLocalPilot();
      const run = { profile: profile.name, steps: [], applicationRoutesMocked: false, browserExternalBlocked: [], responses: [], inspectionRequests: [] };
      report.profiles.push(run);
      let browser, context, page, inspectingSnapshot = false, step = "start";
      const email = "barton.cory.m+synthetic-pilot-" + randomUUID().slice(0, 8) + "@gmail.com";
      const password = "Synthetic-only-" + randomUUID() + "!";
      await writeFile(path.join(pilot.dataDir, "pilot-access.json"), JSON.stringify({
        label: "SYNTHETIC LOCAL TEST ACCOUNT ONLY", email, password
      }, null, 2));
      const pageErrors = [];
      const screenshot = async name => {
        await page.locator(".section.active").evaluate(async element => {
          await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
        });
        await page.screenshot({ path: path.join(output, profile.name + "-" + name + ".png"), fullPage: true });
      };
      const responseAfter = async (pathname, action) => {
        const pending = page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === "POST");
        await action();
        const response = await pending;
        if (!response.ok()) {
          const body = await response.json().catch(() => ({}));
          throw new Error(pathname + " returned " + response.status() + ": " + (body.code || body.error || "Request failed"));
        }
        return response;
      };
      const model = () => page.evaluate(async () => {
        const response = await fetch("/api/model", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("Real model GET failed: " + response.status);
        return response.json();
      });
      const navigate = async view => {
        if (profile.mobile) await page.locator("#mobileViewSelect").selectOption(view);
        else await page.locator('#nav [data-view="' + view + '"]').click();
      };
      const saveProof = async () => {
        await responseAfter("/api/model", () => page.locator("#saveManualProof").click());
        await page.waitForFunction(() => document.querySelector("#proofFeedback").dataset.state === "success");
      };
      try {
        await pilot.start();
        browser = await profile.engine.launch({ headless: true });
        context = await browser.newContext({ viewport: profile.viewport, isMobile: !!profile.mobile, hasTouch: !!profile.mobile,
          acceptDownloads: true, serviceWorkers: "block", timezoneId: "America/New_York" });
        await context.route("**/*", route => {
          const url = new URL(route.request().url());
          if (url.origin === pilot.url) return route.continue();
          run.browserExternalBlocked.push({ origin: url.origin, method: route.request().method() });
          return route.abort();
        });
        context.on("page", opened => {
          opened.setDefaultTimeout(15000);
          opened.on("pageerror", error => pageErrors.push(error.message));
        });
        context.on("response", response => {
          const url = new URL(response.url());
          if (url.origin === pilot.url && url.pathname.startsWith("/api/")) run.responses.push({
            path: url.pathname, method: response.request().method(), status: response.status()
          });
        });
        context.on("request", request => {
          if (!inspectingSnapshot) return;
          const url = new URL(request.url());
          run.inspectionRequests.push({origin:url.origin,path:url.pathname,method:request.method()});
        });
        page = await context.newPage();
        step = "signup and real session";
        await page.goto(pilot.url + "/portal?stay=1", { waitUntil: "load" });
        await page.locator("#createBtn").click();
        await page.locator("#nameInput").fill("Synthetic Pilot Operator");
        await page.locator("#emailInput").fill(email);
        await page.locator("#passwordInput").fill(password);
        await responseAfter("/api/auth/signup", () => page.locator("#createBtn").click());
        await page.waitForURL(/\/app/);
        await page.locator("#onboarding").waitFor({ state: "visible" });
        check((await model()).currentUser?.email === email, "real session recognizes signup");
        run.steps.push(step);

        step = "onboarding through controls";
        await page.locator("#businessNameInput").fill("Synthetic Pilot " + profile.name);
        await page.locator("#websiteInput").fill("https://example.test/synthetic-pilot");
        await page.locator("[data-onboarding-platform][value=facebook]").check();
        await responseAfter("/api/model", () => page.locator("#completeOnboarding").click());
        await page.waitForFunction(() => !document.body.classList.contains("onboarding-scene"));
        check((await model()).onboarding.complete === true, "onboarding persisted by real model route");
        run.steps.push(step);

        step = "documented synthetic provider prerequisite";
        const seed = await page.evaluate(async () => {
          const response = await fetch("/api/e2e/provider-accounts", { method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: [{
              id: "synthetic-pilot-facebook-page", platform: "facebook", oauthProvider: "meta",
              name: "Synthetic Pilot Page", handle: "@syntheticpilot", providerAccountId: "test-tester-loop-facebook-page-1",
              status: "connected", credential: "tester-loop-facebook-token",
              scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"]
            }] }) });
          const body = await response.json();
          return { status: response.status, ok: response.ok, error: body.error || "" };
        });
        check(seed.ok, "authenticated E2E prerequisite: " + seed.status + " " + seed.error);
        await page.reload({ waitUntil: "networkidle" });
        run.steps.push(step);

        step = "campaign creation and editing through controls";
        await navigate("studio");
        await page.locator('[data-studio-mode="campaign"]').click();
        await responseAfter("/api/model", () => page.locator("#newCampaign").click());
        await page.locator("#campaignTitleInput").fill("SYNTHETIC pilot campaign");
        await page.locator("#briefInput").fill("SYNTHETIC rehearsal only. Practice one manual campaign. No real posting or performance claims.");
        await responseAfter("/api/model", () => page.locator("#saveCampaign").click());
        const generated = await responseAfter("/api/generate/platform-variants", () => page.locator("#generateVariants").click());
        const generation = await generated.json();
        check(generation.provider !== "openai", "local generation did not use paid AI");
        await page.locator("#variantList [data-copy]").first().waitFor({ state: "visible" });
        const copy = 'SYNTHETIC PILOT ONLY\nFirst line, "reviewed".\nNo actual post or performance claim.';
        await page.locator("#variantList [data-copy]").first().fill(copy);
        await responseAfter("/api/model", () => page.locator('#variantList [data-status="approved"]').first().click());
        const approvedModel = await model();
        const campaign = approvedModel.campaigns.find(item => item.title === "SYNTHETIC pilot campaign");
        const variant = campaign.variants.find(item => item.copy === copy);
        check(variant?.status === "approved", "review approval persisted without queue confirmation");
        const deliveryState = JSON.stringify({ variants: campaign.variants, queue: approvedModel.publishQueue || [] });
        run.steps.push(step);

        step = "real Markdown and CSV downloads";
        await navigate("calendar");
        for (const [id, extension] of [["exportPostingMarkdown", "md"], ["exportPostingCsv", "csv"]]) {
          const pending = page.waitForEvent("download");
          await page.locator("#" + id).click();
          const download = await pending;
          const target = path.join(output, profile.name + "-posting-pack." + extension);
          await download.saveAs(target);
          const content = await readFile(target, "utf8");
          check(extension === "csv" ? parseCsv(content)[1]?.[4] === copy : content.includes(copy), extension + " exact reviewed synthetic copy");
          if (extension === "csv") check(parseCsv(content).length === 2, "CSV has one approved campaign row");
        }
        run.steps.push(step);

        step = "manual receipt saved to real JSON storage";
        await page.locator("#openManualResults").click();
        await screenshot("receipt-form");
        check(await page.locator("#proofCampaignInput").inputValue() === campaign.id, "Plan preselects active campaign");
        check(!(await page.locator("#proofObservation").evaluate(element => element.open)), "simple receipt starts with observation collapsed");
        await page.locator("#proofVariantInput").selectOption(variant.id);
        await page.locator("#proofUrlInput").fill("https://example.test/synthetic-pilot/post-001");
        await page.locator("#proofPostedInput").fill("2026-09-01T09:30");
        await page.locator("#proofPostedZoneInput").selectOption("-04:00");
        await page.locator("#proofNoteInput").fill("SYNTHETIC posting receipt; no real post.");
        await saveProof();
        const receiptModel = await model();
        const receipt = receiptModel.proof.find(item => item.source === "manual");
        check(receipt?.type === "posting-receipt" && receipt.metricValue === "", "real model returns manual receipt with blank observation");
        run.steps.push(step);

        step = "observation and correction saved";
        await page.locator("#proofObservationToggle").click();
        await page.locator("#proofMetricInput").fill("Synthetic views");
        await page.locator("#proofValueInput").fill("0");
        await page.locator("#proofObservedInput").fill("2026-09-02T10:00");
        await page.locator("#proofObservedZoneInput").selectOption("-04:00");
        await saveProof();
        await page.locator("#proofValueInput").fill("12");
        await page.locator("#proofNoteInput").fill("SYNTHETIC corrected result for rehearsal only, not actual performance.");
        await saveProof();
        const resultModel = await model();
        const result = resultModel.proof.find(item => item.id === receipt.id);
        check(result?.metricValue === "12" && result.type === "observed-result", "corrected result returned by real model");
        check(resultModel.proof.filter(item => item.source === "manual").length === 1, "real corrections preserve one receipt identity");
        check(JSON.stringify({ variants: resultModel.campaigns.find(item => item.id === campaign.id).variants,
          queue: resultModel.publishQueue || [] }) === deliveryState, "exports/proof leave approval and queue state unchanged");
        await screenshot("result");
        await writeFile(path.join(output, profile.name + "-manual-result.json"), JSON.stringify(result, null, 2));
        run.steps.push(step);

        step = "selected manual evidence to editable draft";
        await page.locator('[data-evidence-proof="' + receipt.id + '"]').check();
        await page.locator("#previewSelfLaunch").click();
        const previewText = await page.locator("#selfLaunchPreviewText").innerText();
        const previewSnapshot = await page.evaluate(() => structuredClone(selfLaunchState.preview.snapshot));
        check(previewText.includes("Synthetic views: 12") && previewText.includes("not provider-verified"), "preview labels selected manual observation");
        await page.locator(".self-launch-draft").screenshot({ path: path.join(output, profile.name + "-evidence-preview.png") });
        await responseAfter("/api/model", () => page.locator("#createSelfLaunch").click());
        await page.waitForFunction(() => document.querySelector("#selfLaunchFeedback").dataset.state === "success");
        const draftModel = await model();
        const evidenceDraft = draftModel.campaigns.find(item => item.evidenceSnapshot?.sourceRecordIds.includes(receipt.id));
        check(evidenceDraft?.brief === previewText && evidenceDraft.variants.length > 0
          && evidenceDraft.variants.every(item => item.status === "draft" && item.copy === previewText), "real saved draft exactly matches preview and remains unapproved");
        check(isDeepStrictEqual(evidenceDraft.evidenceSnapshot, previewSnapshot), "real server preserves selected source IDs and factual snapshot");
        check(JSON.stringify(draftModel.proof) === JSON.stringify(resultModel.proof), "draft creation does not change proof records");
        check(JSON.stringify({ variants: draftModel.campaigns.find(item => item.id === campaign.id).variants,
          queue: draftModel.publishQueue || [] }) === deliveryState, "draft creation preserves previous approval and queue state");
        await page.locator("#proofNoteInput").fill("SYNTHETIC source note corrected after draft capture.");
        await saveProof();
        check(isDeepStrictEqual((await model()).campaigns.find(item => item.id === evidenceDraft.id).evidenceSnapshot, previewSnapshot),
          "later real source correction leaves captured campaign facts unchanged");
        await page.locator("#openSelfLaunchDraft").click();
        const enteredBrief = previewText + "\nSYNTHETIC operator draft edit.";
        // The existing campaign editor normalizes brief whitespace with clean().
        const editedBrief = enteredBrief.trim().replace(/\s+/g, " ");
        await page.locator("#briefInput").fill(enteredBrief);
        await responseAfter("/api/model", () => page.locator("#saveCampaign").click());
        check((await model()).campaigns.find(item => item.id === evidenceDraft.id).brief === editedBrief, "draft remains editable through real campaign save");
        await screenshot("draft-editor");
        run.steps.push(step);

        step = "real server restart and fresh page";
        await page.close();
        await pilot.restart();
        page = await context.newPage();
        await page.goto(pilot.url + "/app", { waitUntil: "networkidle" });
        await page.locator("#mobileViewSelect").waitFor({ state: "attached" });
        await navigate("proof");
        await page.locator("#manualProofList [data-edit-proof]").waitFor({ state: "visible" });
        const reloaded = await model();
        check(reloaded.currentUser?.email === email, "session persists across actual server restart");
        check(reloaded.proof.find(item => item.id === receipt.id)?.metricValue === "12", "manual result survives real process restart and fresh page");
        check((await page.locator("#manualProofList").innerText()).includes("Synthetic views: 12"), "reloaded result visible");
        const reloadedDraft = reloaded.campaigns.find(item => item.id === evidenceDraft.id);
        check(reloadedDraft?.brief === editedBrief && isDeepStrictEqual(reloadedDraft.evidenceSnapshot, previewSnapshot),
          "editable draft and frozen facts survive real restart and fresh page");
        check(reloaded.campaigns.filter(item => item.id === evidenceDraft.id).length === 1
          && reloadedDraft.variants.every(item => item.status === "draft"), "restarted model contains one unapproved evidence draft");
        const disk = JSON.parse(await readFile(path.join(pilot.dataDir, "model.json"), "utf8"));
        check(JSON.stringify(disk).includes(receipt.id), "task-owned JSON file contains receipt identity");
        await screenshot("after-restart");
        run.steps.push(step);

        step = "read-only saved evidence inspection after restart";
        await navigate("studio");
        await page.locator('[data-studio-mode="campaign"]').click();
        await page.waitForLoadState("networkidle");
        check(await page.evaluate(() => selfLaunchState.preview === null), "real restart has no transient Results preview");
        const beforeInspection = await page.evaluate(() => JSON.stringify(model));
        // GET /api/model bootstraps/saves workspace state; inspect disk without that side effect.
        const storedBeforeInspection = await readFile(path.join(pilot.dataDir, "model.json"), "utf8");
        await page.locator("#campaignTitleInput").fill("UNSAVED synthetic review title");
        await page.locator("#briefInput").fill("UNSAVED synthetic review\nbrief");
        inspectingSnapshot = true;
        const disclosure = page.locator("#savedEvidenceDisclosure"), summary = disclosure.locator("summary");
        await summary.focus();
        await page.keyboard.press("Enter");
        check(await page.locator("#savedEvidenceStatus").getAttribute("data-state") === "ready", "real persisted snapshot is inspectable");
        check(await page.locator("#savedEvidenceText").innerText() === previewText, "inspector after restart shows original captured facts, not corrected source note");
        check((await page.locator("#savedEvidenceCapturedAt").innerText()).includes(previewSnapshot.capturedAt), "real saved capture time visible");
        check(await disclosure.locator("a").count() === 0, "inspection never turns recorded URLs into navigation");
        await page.keyboard.press("Space");
        await page.keyboard.press("Enter");
        check(await page.locator("#campaignTitleInput").inputValue() === "UNSAVED synthetic review title"
          && await page.locator("#briefInput").inputValue() === "UNSAVED synthetic review\nbrief", "disclosure preserves unfinished real editor inputs");
        check(await page.evaluate(() => JSON.stringify(model)) === beforeInspection, "real inspector leaves in-memory campaign and workspace unchanged");
        await disclosure.screenshot({path:path.join(output, profile.name + "-saved-snapshot.png")});
        inspectingSnapshot = false;
        check(run.inspectionRequests.length === 0, "real snapshot disclosure causes no requests");
        check(await readFile(path.join(pilot.dataDir, "model.json"), "utf8") === storedBeforeInspection,
          "inspection leaves stored model and draft statuses unchanged");
        run.steps.push(step);

        step = "visible JSON backup control";
        await navigate("settings");
        const pending = page.waitForEvent("download");
        await page.locator("#exportContent").click();
        const download = await pending;
        const target = path.join(output, profile.name + "-content-backup.json");
        await download.saveAs(target);
        const backup = JSON.parse(await readFile(target, "utf8"));
        check(backup.proof.some(item => item.id === receipt.id && item.metricValue === "12"), "visible JSON backup contains persisted result");
        check(backup.campaign?.id === evidenceDraft.id
          && isDeepStrictEqual(backup.campaign.evidenceSnapshot, previewSnapshot),
          "visible JSON backup includes the frozen evidence snapshot");
        check(!JSON.stringify(backup).includes(password), "account password absent from content export");
        run.steps.push(step);

        step = "disposable content recovery preparation";
        // Synthetic legacy/operational markers and content loss use the authenticated
        // model save. Export, preview, cancellation and restore use visible controls.
        await page.evaluate(async () => {
          model.proof.push({ id: "synthetic-legacy-recovery", type: "customer", metric: "Legacy manual note",
            note: "SYNTHETIC legacy history, not independently verified", createdAt: "2026-09-01T00:00:00Z" });
          model.security.recoverySentinel = "SYNTHETIC-PRIVATE-OPERATIONAL-MARKER";
          await saveModel();
        });
        await page.waitForLoadState("networkidle");
        const readDownload = async selector => {
          const pending = page.waitForEvent("download");
          await page.locator(selector).click();
          const stream = await (await pending).createReadStream(), chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          return JSON.parse(Buffer.concat(chunks).toString());
        };
        const privateModelExport = await readDownload("#exportModel");
        check(privateModelExport.security.recoverySentinel === "SYNTHETIC-PRIVATE-OPERATIONAL-MARKER",
          "private full-model export contains operational data and is not a public artifact");
        const recoveryFile = await readDownload("#exportRecovery");
        const expectedContent = recoveryContent(recoveryFile);
        check(expectedContent.campaigns.length >= 2 && expectedContent.proof.some(item => item.id === "synthetic-legacy-recovery"),
          "visible recovery export covers multiple campaigns, manual and legacy records");
        check(!JSON.stringify(recoveryFile).includes("SYNTHETIC-PRIVATE-OPERATIONAL-MARKER")
          && !JSON.stringify(recoveryFile).includes(password), "recovery content excludes account/operational markers");
        await page.evaluate(async () => {
          model.campaigns = [{ id: "synthetic-content-loss-placeholder", title: "Disposable replacement", variants: [] }];
          model.activeCampaignId = "synthetic-content-loss-placeholder";
          model.proof = [];
          await saveModel();
        });
        const operationalState = () => page.evaluate(() => JSON.stringify({
          userId: model.currentUser?.id, workspaceId: model.workspace?.id, owner: model.workspace?.ownerUserId,
          security: model.security, billing: model.billing, integrations: model.integrations,
          connectedAccounts: model.connectedAccounts, quickPosts: model.quickPosts, queue: model.publishQueue,
          memberships: model.memberships, settings: model.settings
        }));
        const operationsBeforeRecovery = await operationalState();
        const lostContent = await page.evaluate(() => JSON.stringify({ campaigns:model.campaigns,proof:model.proof,activeCampaignId:model.activeCampaignId }));
        const chooseRecovery = async value => {
          const pending = page.waitForEvent("filechooser");
          await page.locator("#importModelButton").click();
          await (await pending).setFiles({ name: "synthetic-recovery.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
        };
        const recoveryFeedback = expected => page.waitForFunction(value =>
          document.querySelector("#recoveryFeedback").dataset.state === value, expected);
        await chooseRecovery(recoveryFile); await recoveryFeedback("preview");
        await screenshot("recovery-preview");
        await page.locator("#cancelRecovery").click();
        check(await page.evaluate(() => JSON.stringify({ campaigns:model.campaigns,proof:model.proof,activeCampaignId:model.activeCampaignId })) === lostContent,
          "real cancellation leaves existing disposable content unchanged");
        for (const invalid of [{ schemaVersion:"future",content:expectedContent },
          { schemaVersion:recoveryFile.schemaVersion,content:{ ...expectedContent,proof:null } }]) {
          await chooseRecovery(invalid); await recoveryFeedback("error");
          check(await page.locator("#applyRecovery").isDisabled(), "real invalid structure/version cannot be applied");
          await page.locator("#cancelRecovery").click();
        }
        check(await operationalState() === operationsBeforeRecovery, "previews and rejected files preserve current authenticated operational state");
        run.steps.push(step);

        step = "visible recovery apply and actual restart";
        const responseOffset = run.responses.length;
        await chooseRecovery(recoveryFile); await recoveryFeedback("preview");
        await responseAfter("/api/model", () => page.locator("#applyRecovery").click());
        await recoveryFeedback("success");
        check(await operationalState() === operationsBeforeRecovery, "real successful save preserves account, workspace ownership and operational fields");
        const restored = await page.evaluate(() => JSON.parse(JSON.stringify(model)));
        const restoredContent = recoveryContent(restored);
        restoredContent.campaigns.forEach(item => delete item.recoveryRecordedAt);
        check(JSON.stringify(restoredContent) === JSON.stringify(expectedContent), "real restored content IDs, statuses, associations and frozen history match export");
        await screenshot("recovery-confirmed");
        await page.locator("#cancelRecovery").click();
        const recoveryResponses = run.responses.slice(responseOffset);
        check(recoveryResponses.length === 1 && recoveryResponses[0].path === "/api/model" && recoveryResponses[0].method === "POST",
          "real recovery sends only one confirmed model save, no generation/provider/publishing action");
        run.recoveryRequests = recoveryResponses;
        run.recovery = { supportedCampaigns:expectedContent.campaigns.length,proofRecords:expectedContent.proof.length,
          variants:expectedContent.campaigns.reduce((count,item)=>count+item.variants.length,0),
          privateFullModelContainsOperationalMarker:true,rawModelUploaded:false,preparation:"Authenticated synthetic model saves for legacy marker and content loss",
          applicationRoutesMocked:false };
        await page.close();
        await pilot.restart();
        page = await context.newPage();
        await page.goto(pilot.url + "/app", { waitUntil:"networkidle" });
        await page.waitForFunction(() => hostedModelHydrated);
        const restartedRecovery = recoveryContent(await model());
        restartedRecovery.campaigns.forEach(item => delete item.recoveryRecordedAt);
        check(JSON.stringify(restartedRecovery) === JSON.stringify(expectedContent), "actual process restart preserves all restored supported content");
        const restartedOps = await page.evaluate(() => ({ userId:model.currentUser?.id,workspaceId:model.workspace?.id,
          owner:model.workspace?.ownerUserId,security:model.security,billing:model.billing,queue:model.publishQueue }));
        const priorOps = JSON.parse(operationsBeforeRecovery);
        check(["userId","workspaceId","owner","security","billing","queue"].every(key =>
          isDeepStrictEqual(restartedOps[key], priorOps[key])), "restart preserves identity ownership security billing and queue");
        await navigate("studio");
        await page.locator('[data-studio-mode="campaign"]').click();
        await page.locator("#savedEvidenceDisclosure summary").click();
        check(await page.locator("#savedEvidenceText").innerText() === previewText, "restored frozen facts remain visibly inspectable after restart");
        check(await page.locator("#recoveryHistory").isVisible(), "recovered-history qualification visible in editor");
        await screenshot("recovery-restarted");
        // Keep only supported synthetic content, never the private full-model dump.
        await writeFile(path.join(output, profile.name + "-recovery-content.json"), JSON.stringify(recoveryFile,null,2));
        check(pageErrors.length === 0, "no application exceptions");
        check(!run.responses.some(item => item.method === "POST" && /\/api\/(?:worker|publish|billing|stripe)(?:\/|$)/.test(item.path)),
          "no worker, publish, or billing command sent during manual journey");
        run.steps.push(step);
        run.ok = true;
        run.pageErrors = pageErrors;
      } catch (error) {
        run.ok = false;
        run.failedStep = step;
        run.error = error.message.replaceAll(password, "[redacted]");
        if (page && !page.isClosed()) await screenshot("failure").catch(() => {});
        throw new Error(profile.name + " / " + step + ": " + run.error);
      } finally {
        if (context) await context.close();
        if (browser) await browser.close();
        await pilot.stop();
        run.server = await pilot.summary();
        run.resourcesClosed = true;
        await writeFile(path.join(output, "evidence.json"), JSON.stringify(report, null, 2));
      }
    }
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    await writeFile(path.join(output, "evidence.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, output,
      profiles: report.profiles.map(item => ({ profile: item.profile, ok: item.ok, failedStep: item.failedStep,
        dataDir: item.server?.dataDir, resourcesClosed: item.resourcesClosed })) }));
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPilotRehearsal().catch(error => { console.error(error.message); process.exitCode = 1; });
}
