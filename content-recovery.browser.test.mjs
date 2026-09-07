import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, webkit } from "playwright";
import { html, fixture, project, envelope } from "./content-recovery.contract.test.mjs";

const output = fileURLToPath(new URL("./test-results/content-recovery/", import.meta.url));
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
    hasTouch: !!profile.mobile, serviceWorkers: "block", acceptDownloads: true });
  const page = await context.newPage();
  let persisted, mode = "", phase = "boot";
  const requests = [], attempts = [], pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ path: url.pathname, method: request.method(), origin: url.origin, phase });
    if (url.origin !== "http://127.0.0.1:4179") return route.abort();
    const json = (status, value) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/app") return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/api/auth/session" && persisted) return json(200, { ok: true, user: persisted.currentUser, workspace: persisted.workspace });
    if (url.pathname === "/api/auth/device/heartbeat") return json(200, { ok: true });
    if (url.pathname === "/api/model" && persisted) {
      if (request.method() === "GET") return json(200, persisted);
      const incoming = request.postDataJSON();
      attempts.push(incoming);
      const failure = mode; mode = "";
      if (failure === "reject") return json(503, { error: "Synthetic rejection", code: "workspace_storage_unavailable", commitStatus: "not_committed" });
      persisted = { ...persisted, ...project(incoming.request),
        persistence: { conditionalSave: true, revision: { epoch: "11111111-1111-4111-8111-111111111111", revision: "1" } },
        receipt: { operationId: incoming.operationId, superseded: false } };
      if (failure === "lost") return route.abort();
      if (failure === "incomplete") return json(200, { ok: true });
      if (failure === "context-switch") await page.evaluate(() => {
        model = { ...model, workspace:{ ...model.workspace,id:"another-workspace" },
          campaigns:[{ id:"another-workspace-content",title:"New context",variants:[] }],proof:[],activeCampaignId:"another-workspace-content" };
      });
      return json(200, persisted);
    }
    return json(401, { error: "Synthetic route unavailable" });
  });
  const state = value => page.waitForFunction(expected => document.querySelector("#recoveryFeedback").dataset.state === expected, value);
  const choose = async (value, raw = false) => {
    const pending = page.waitForEvent("filechooser");
    await page.locator("#importModelButton").click();
    await (await pending).setFiles({ name: "synthetic-recovery.json", mimeType: "application/json",
      buffer: Buffer.from(raw ? value : JSON.stringify(value)) });
  };
  const download = async selector => {
    const pending = page.waitForEvent("download");
    await page.locator(selector).click();
    const stream = await (await pending).createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const protectedState = () => page.evaluate(() => {
    const value = { ...model };
    for (const key of ["campaigns", "proof", "activeCampaignId", "updatedAt", "persistence", "receipt"]) delete value[key];
    return JSON.stringify(value);
  });
  const close = () => page.locator("#cancelRecovery").click();
  try {
    await page.goto("http://127.0.0.1:4179/app");
    persisted = await page.evaluate(async () => {
      await bootApp();
      model = normalizeModel(clone(defaultModel));
      model.currentUser = { id: "current-operator", name: "Synthetic operator", email: "synthetic@example.test" };
      model.persistence = { conditionalSave: true, revision: { epoch: "11111111-1111-4111-8111-111111111111", revision: "0" } };
      model.workspace = { ...model.workspace, id: "current-workspace", ownerUserId: "current-operator" };
      model.onboarding.complete = true;
      model.campaigns = [{ id: "before", title: "Original recoverable content", variants: [] }];
      model.activeCampaignId = "before";
      model.proof = [];
      model.billing.syntheticMarker = "PRIVATE-BILLING-MARKER";
      model.security.syntheticMarker = "PRIVATE-SECURITY-MARKER";
      model.publishQueue = [{ id: "unrelated-queue", variantId: "unrelated-variant", status: "queued" }];
      model.quickPosts = [{ id: "unrelated-quick", title: "Existing quick post", variants: [] }];
      model.memberships = [{ userId: "current-operator", workspaceId: "current-workspace", role: "owner" }];
      model.providerConfiguration = { sentinel: "PRIVATE-PROVIDER-MARKER" };
      hostedModelHydrated = true;
      render();
      return JSON.parse(JSON.stringify(model));
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => hostedModelHydrated && model.currentUser?.id === "current-operator");
    if (profile.mobile) await page.locator("#mobileViewSelect").selectOption("settings");
    else await page.locator('#nav [data-view="settings"]').click();
    phase = "recovery";
    const original = await page.evaluate(() => JSON.stringify(model)), protectedBefore = await protectedState();
    const privateExport = await download("#exportModel");
    check(JSON.stringify(privateExport).includes("PRIVATE-SECURITY-MARKER")
      && privateExport.publishQueue[0].id === "unrelated-queue", "private full-model export contains synthetic operational data");
    const contentExport = await download("#exportRecovery");
    check(contentExport.schemaVersion === "social-cues.campaign-content.v1"
      && !JSON.stringify(contentExport).includes("PRIVATE-"), "recovery export excludes operational markers");
    const singular = await download("#exportContent");
    await choose(singular); await state("error");
    check((await page.locator("#recoveryFeedback").innerText()).includes("not workspace"), "singular bundle not accepted as full recovery");
    await close();
    const raw = structuredClone(fixture);
    raw.currentUser = { id: "foreign-operator" };
    raw.workspace = { id: "foreign-workspace", ownerUserId: "foreign-operator" };
    raw.billing = { status: "active", private: "INJECTED-PRIVATE-MARKER" };
    raw.publishQueue = [{ id: "imported-queue", status: "queued" }];
    raw.connectedAccounts = [{ id: "imported-account" }];
    raw.campaigns[0].variants[0].media = { type: "image", url: "https://example.test/never-fetch" };
    await choose(raw); await state("preview");
    check(await page.evaluate(() => JSON.stringify(model)) === original && attempts.length === 0, "preview makes no mutation or save");
    check(await page.locator("#recoverySummary").evaluate(element => element === document.activeElement), "preview receives keyboard focus");
    check((await page.locator("#recoverySummary").innerText()).includes("3 campaigns; 3 variants; 3 evidence")
      && (await page.locator("#recoverySummary").innerText()).includes("published: 1"), "preview reports supported counts and status history");
    check(await page.locator("#recoveryDialog a").count() === 0, "preview creates no imported links");
    await page.locator("#recoveryDialog").screenshot({ path: path.join(output, profile.name + "-preview.png") });
    check(await page.locator("#recoveryDialog").evaluate(element =>
      element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().right <= innerWidth), "preview fits desktop/mobile");
    await page.keyboard.press("Escape");
    await page.locator("#recoveryDialog").waitFor({ state: "hidden" });
    check(await page.evaluate(() => JSON.stringify(model)) === original, "keyboard cancellation leaves all current data intact");
    for (const invalid of ["{", JSON.stringify({ ...raw, version: "future" }), JSON.stringify({ ...raw, proof: null })]) {
      await choose(invalid, true); await state("error");
      check(await page.locator("#applyRecovery").isDisabled() && attempts.length === 0
        && await page.evaluate(() => JSON.stringify(model)) === original, "invalid file leaves current content intact");
      await close();
    }
    await choose(raw); await state("preview");
    await page.evaluate(() => { model.workspace.name = "Changed since preview"; });
    await page.locator("#applyRecovery").click(); await state("error");
    check(attempts.length === 0 && (await page.locator("#recoveryFeedback").innerText()).includes("changed since preview"), "stale workspace preview is rejected");
    await close();
    await page.evaluate(value => { model = JSON.parse(value); render(); }, original);
    await choose(raw); await state("preview");
    await page.evaluate(() => { hostedModelHydrated = false; });
    await page.locator("#applyRecovery").click(); await state("error");
    check(attempts.length === 0 && (await page.locator("#recoveryFeedback").innerText()).includes("loaded signed-in"), "unhydrated workspace cannot claim a confirmed save");
    await page.evaluate(() => { hostedModelHydrated = true; });
    await close();
    await choose(raw); await state("preview");
    mode = "reject";
    await page.locator("#applyRecovery").focus(); await page.keyboard.press("Enter"); await state("error");
    check(await page.evaluate(() => JSON.stringify(model)) === original, "confirmed rejection restores original local content");
    check(persisted.campaigns[0].id === "before", "synthetic rejected save leaves server fixture intact");
    check(await protectedState() === protectedBefore, "failure preserves all current operational and identity fields");
    check(await page.locator("#applyRecovery").evaluate(element => element === document.activeElement), "failure focuses deliberate retry");
    const previewText = await page.locator("#recoverySummary").innerText();
    mode = "lost";
    await page.locator("#applyRecovery").click(); await state("error");
    check(persisted.campaigns.length === 3 && await page.evaluate(() => JSON.stringify(model)) === original, "lost response is uncertain with original local content retained");
    check((await page.locator("#recoveryFeedback").innerText()).includes("server may have saved"), "uncertain save never claims rollback");
    mode = "incomplete";
    await page.locator("#applyRecovery").click(); await state("error");
    check((await page.locator("#recoveryFeedback").getAttribute("data-state")) !== "success", "200 without complete content is not confirmed recovery");
    await page.locator("#applyRecovery").click(); await state("success");
    check(await page.locator("#recoverySummary").innerText() === previewText, "same recovery input remains available throughout retries");
    check(attempts.length === 4 && attempts.every(value => value.request.content.campaigns.length === 3), "deliberate replacement retries never append duplicate campaigns");
    check(attempts.every(value => JSON.stringify(value) === JSON.stringify(attempts[0])), "retry original operation ID, revision, content and capture metadata are stable");
    check(await protectedState() === protectedBefore, "successful recovery preserves identity, ownership, membership, billing, readiness and queues");
    check(!JSON.stringify(persisted).includes("INJECTED-PRIVATE-MARKER")
      && !persisted.connectedAccounts.some(item => item.id === "imported-account"), "imported operational fields cannot replace current state");
    const canonical = project(persisted), expected = project(raw);
    canonical.campaigns.forEach(item => delete item.recoveryRecordedAt);
    check(JSON.stringify(canonical) === JSON.stringify(expected), "all supported content and associations match original file");
    check(!requests.some(item => item.path === "/never-fetch"), "excluded media does not load");
    await page.locator("#recoveryDialog").screenshot({ path: path.join(output, profile.name + "-confirmed.png") });
    await close();
    phase = "reload";
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => hostedModelHydrated);
    check(await page.evaluate(() => model.campaigns.length === 3 && model.proof.length === 3), "confirmed content survives browser reload");
    check(await protectedState() === protectedBefore, "reload retains current account and operations");
    check(pageErrors.length === 0, "no page exceptions");
    check(requests.filter(item => item.phase === "recovery" && item.method !== "GET").every(item => item.path === "/api/model"), "recovery makes only model saves, no provider or publishing commands");
    check(requests.filter(item => item.phase === "recovery" && item.method === "POST").length === 4
      && requests.filter(item => item.phase === "recovery" && item.method === "GET").every(item => item.path === "/api/model"),
      "recovery sends four deliberate saves and only read-only current-state reconciliation requests");
    if (profile.mobile) await page.locator("#mobileViewSelect").selectOption("settings");
    else await page.locator('#nav [data-view="settings"]').click();
    phase = "context-switch";
    await choose(raw); await state("preview");
    mode = "context-switch";
    await page.locator("#applyRecovery").click(); await state("error");
    check(await page.evaluate(() => model.workspace.id === "another-workspace" && model.campaigns[0].id === "another-workspace-content"),
      "late response never rolls old content into a different workspace");
    check((await page.locator("#recoveryFeedback").innerText()).includes("Workspace changed during recovery"),
      "late response accurately identifies changed context");
    check(!requests.some(item => item.origin !== "http://127.0.0.1:4179" && item.phase !== "boot"),
      "recovery/reload/context-switch makes no external-origin request");
    results.push({ profile: profile.name, ok: true, saveAttempts: attempts.length, resourcesClosed: false,
      privateFullModelIncludesOperationalSentinels: true, recoveryExcludesOperationalSentinels: true,
      externalProviderRequestsDispatched: 0, requests });
  } finally {
    await context.close(); await browser.close();
    if (results.at(-1)?.profile === profile.name) results.at(-1).resourcesClosed = true;
  }
}
await writeFile(path.join(output, "evidence.json"), JSON.stringify({ ok: true, checks, fixture: "Browser routes intercepted; no real application server", results }, null, 2));
console.log(JSON.stringify({ ok: true, checks, output, profiles: results.map(({ profile, saveAttempts, resourcesClosed }) => ({ profile, saveAttempts, resourcesClosed })) }));
