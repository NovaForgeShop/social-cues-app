import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, webkit } from "playwright";
import { html, fixture, build, parseCsv } from "./posting-pack.contract.test.mjs";

const output = fileURLToPath(new URL("./test-results/posting-pack/", import.meta.url));
await mkdir(output, { recursive: true });
const results = [];
const intercepted = [];
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
for (const profile of [
  { name: "desktop-chromium", engine: chromium, viewport: { width: 1440, height: 1000 } },
  { name: "mobile-chromium", engine: chromium, viewport: { width: 390, height: 844 }, isMobile: true },
  { name: "mobile-webkit", engine: webkit, viewport: { width: 390, height: 844 }, isMobile: true }
]) {
  const browser = await profile.engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile || false,
    hasTouch: profile.isMobile || false, acceptDownloads: true, serviceWorkers: "block", timezoneId: "America/New_York" });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    intercepted.push({ profile: profile.name, origin: url.origin, method: route.request().method() });
    if (url.origin === "http://127.0.0.1:4177" && url.pathname === "/app") {
      await route.fulfill({ status: 200, contentType: "text/html", body: html });
    } else if (url.origin === "http://127.0.0.1:4177" && url.pathname.startsWith("/api/")) {
      await route.fulfill({ status: 401, contentType: "application/json", body: '{"ok":false,"error":"Synthetic local fixture"}' });
    } else await route.abort();
  });
  let closed = false;
  try {
    await page.goto("http://127.0.0.1:4177/app", { waitUntil: "load" });
    await page.evaluate(async campaign => {
      await bootApp();
      model = normalizeModel(clone(defaultModel));
      model.currentUser = { id: "synthetic-operator", name: "Pilot operator", email: "pilot@example.test" };
      model.onboarding.complete = true;
      model.onboarding.selectedPlatforms = ["facebook", "linkedin", "threads"];
      model.campaigns = [campaign, { id: "other-campaign", title: "Other campaign", variants: [
        { id: "other-post", platform: "facebook", status: "approved", copy: "UNRELATED-WORKSPACE-COPY" }
      ] }];
      model.campaigns.forEach(item => item.variants.forEach(variant => { variant.tags = []; }));
      model.activeCampaignId = campaign.id;
      model.proof = [{ type: "baseline", metric: "Synthetic baseline only", note: "No real results" }];
      render();
      navigateTo("calendar");
    }, fixture);
    await page.locator("#exportPostingMarkdown").waitFor({ state: "visible" });
    check((await page.locator("#postingPackSummary").innerText()).includes("3 approved/queued posts"), "active campaign count");
    const before = await page.evaluate(() => JSON.stringify(model));
    const requestsBeforeExport = intercepted.length;
    const paths = [];
    for (const [id, extension, expected] of [
      ["exportPostingMarkdown", "md", build(fixture).markdown],
      ["exportPostingCsv", "csv", "\ufeff" + build(fixture).csv]
    ]) {
      const waiting = page.waitForEvent("download");
      await page.locator("#" + id).click();
      const download = await waiting;
      check(download.suggestedFilename() === "Social-Cues-posting-pack-pilot-001." + extension, "actual download filename");
      const target = path.join(output, profile.name + "-download." + extension);
      await download.saveAs(target);
      const content = await readFile(target, "utf8");
      check(content === expected, "actual downloaded bytes");
      check(!content.includes("never-export") && !content.includes("UNRELATED-WORKSPACE-COPY"), "download field boundary");
      if (extension === "csv") check(parseCsv(content).length === 4, "three calendar rows");
      paths.push(target);
    }
    check(await page.evaluate(() => JSON.stringify(model)) === before, "export leaves all workspace state unchanged");
    check(intercepted.length === requestsBeforeExport, "export itself makes no request");
    const layout = await page.locator(".posting-pack-toolbar").evaluate(element => {
      const parent = element.getBoundingClientRect();
      const buttons = [...element.querySelectorAll("button")].map(button => {
        const r = button.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height,
          textFits: button.scrollWidth <= button.clientWidth };
      });
      return { left: parent.left, right: parent.right, viewport: innerWidth, buttons };
    });
    check(layout.left >= 0 && layout.right <= layout.viewport, "toolbar fits viewport");
    check(layout.buttons.every(b => b.left >= layout.left && b.right <= layout.right && b.height >= 44 && b.textFits), "readable and reachable download controls");
    const [a, b] = layout.buttons;
    check(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, "controls do not overlap");
    await page.screenshot({ path: path.join(output, profile.name + ".png"), fullPage: true });
    await page.evaluate(() => {
      activeCampaign().title = "Long campaign title " + "campaign".repeat(30);
      renderCalendar();
    });
    check(await page.locator(".posting-pack-toolbar").evaluate(element => element.scrollWidth <= element.clientWidth),
      "long campaign title remains within toolbar");

    await page.evaluate(() => { model.activeCampaignId = "other-campaign"; renderCalendar(); });
    const otherDownload = page.waitForEvent("download");
    await page.locator("#exportPostingMarkdown").click();
    const other = await otherDownload;
    await other.saveAs(path.join(output, profile.name + "-other.md"));
    const otherText = await readFile(path.join(output, profile.name + "-other.md"), "utf8");
    check(otherText.includes("UNRELATED-WORKSPACE-COPY") && !otherText.includes("First line"), "campaign switch exports only current selection");

    await page.evaluate(() => { model.campaigns = []; model.activeCampaignId = ""; renderCalendar(); });
    for (const [id, extension] of [["exportPostingMarkdown", "md"], ["exportPostingCsv", "csv"]]) {
      const waiting = page.waitForEvent("download");
      await page.locator("#" + id).click();
      const download = await waiting;
      const target = path.join(output, profile.name + "-empty." + extension);
      await download.saveAs(target);
      const text = await readFile(target, "utf8");
      check(extension === "md" ? text.includes("No approved or queued posts") : parseCsv(text).length === 1, "empty campaign downloads");
    }
    // Existing JSON backup remains a real download action, with its original schema.
    await page.evaluate(() => { navigateTo("data"); });
    const jsonDownload = page.waitForEvent("download");
    await page.locator("#exportContent").dispatchEvent("click");
    const backup = await jsonDownload;
    await backup.saveAs(path.join(output, profile.name + "-backup.json"));
    check(backup.suggestedFilename() === "Social Cues-content-bundle.json", "JSON backup remains");
    const backupData = JSON.parse(await readFile(path.join(output, profile.name + "-backup.json"), "utf8"));
    check(Array.isArray(backupData.approvedOrPublished) && "workspace" in backupData, "existing backup contract unchanged");
    check(pageErrors.length === 0, "no browser application exceptions: " + pageErrors.join("; "));
    results.push({ profile: profile.name, downloads: 6, layout, paths, pageErrors });
  } finally {
    await context.close();
    await browser.close();
    closed = true;
    if (results.at(-1)?.profile === profile.name) results.at(-1).browserClosed = closed;
  }
}
const evidence = { ok: true, checks, results, interceptedRequests: intercepted.length,
  externalRequestsDispatched: 0, fixtureOnly: true, requestPolicy: "Every browser request fulfilled locally or aborted; none continued",
  intercepted };
await writeFile(path.join(output, "browser-evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ...evidence, intercepted: undefined }));
