import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PRICING_CONFIGURATION, resolvePricingPlan } from "./pricing-packaging.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const requestTimeoutMs = 5_000;
const startupTimeoutMs = 20_000;
const expectedSchemaVersion = "social-cues.pricing-presentation.v1";
const secretSentinel = "pricing-presentation-secret-sentinel";
const protectedFiles = {
  "pricing-packaging.mjs": {
    sha256: "0283ac45bf6b7cd46c2ffa666ed980a3c3266f37d29c77a02016f34c606aab56",
    objectId: "e6573be7865536ddef479a2a914729ac2b75f213"
  },
  "pricing-packaging.contract.test.mjs": {
    sha256: "7817c0f54635ded02a51a10604c10a1677d1021b66f06c906ea237797e2aebd1",
    objectId: "cf611cb92f6bafa552d219cc743eacdf6c612a39"
  },
  "package-lock.json": {
    sha256: "6c4b13067bed8bccd173b7059b9bcfadcb647c9a7befbb9ba22e2ff118270883",
    objectId: "7ef54f2b11b83967af8170c16dd81f0ec40cd32f"
  }
};
let checks = 0;

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
}

function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

async function git(...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, windowsHide: true });
  return stdout.trim();
}

async function availablePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise(resolve => probe.close(resolve));
  check(port > 0, "A loopback port must be available for the pricing contract.");
  return port;
}

function minimalSystemEnv() {
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function redactedOutput(value = "") {
  return String(value)
    .replaceAll(secretSentinel, "[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .slice(-2_000);
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Social Cues exited before startup. ${redactedOutput(output())}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Social Cues did not become healthy before timeout. ${redactedOutput(output())}`);
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, "close").catch(() => []);
  child.kill();
  await Promise.race([closed, delay(3_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.race([once(child, "close").catch(() => []), delay(2_000)]);
}

async function request(baseUrl, pathname, { method = "GET" } = {}) {
  const headers = {};
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.Origin = baseUrl;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return {
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    text,
    body
  };
}

async function artifactInventory(directory) {
  let files = 0;
  let directories = 0;
  let bytes = 0;
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        directories += 1;
        await visit(entryPath);
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(entryPath)).size;
      }
    }
  }
  await visit(directory);
  return { files, directories, bytes };
}

function collectObjectKeys(value, keys = []) {
  if (!value || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys);
    return keys;
  }
  for (const [key, nested] of Object.entries(value)) {
    keys.push(key);
    collectObjectKeys(nested, keys);
  }
  return keys;
}

async function sourceChecks() {
  const [serverSource, appSource, seedSource, packageSource, moduleSource] = await Promise.all([
    readFile(path.join(root, "server.mjs"), "utf8"),
    readFile(path.join(root, "social-cues-app.html"), "utf8"),
    readFile(path.join(root, "social-cues-model-seed.json"), "utf8"),
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "pricing-packaging.mjs"), "utf8")
  ]);
  const seed = JSON.parse(seedSource);
  const packageJson = JSON.parse(packageSource);

  check(/from\s+["']\.\/pricing-packaging\.mjs["']/.test(serverSource), "The server must import the tracked P0 pricing module.");
  check(!/from\s+["']\.\/stripe-billing-lifecycle\.mjs["']/.test(serverSource), "P1 must not import the dirty Stripe lifecycle module.");
  equal(packageJson.scripts["test:pricing-presentation"], "node pricing-presentation.contract.test.mjs", "The P1 script must invoke only its contract.");
  for (const script of ["test:pricing", "test:auth-verification", "test:workspace-authorization", "test:twitch-oauth-readiness", "test:vizard", "test:vizard-connection-service", "test:vizard-connection-management", "test:vizard-connection-management:runtime", "test:vizard-connection-management:postgrest"]) {
    check(typeof packageJson.scripts[script] === "string" && packageJson.scripts[script].length > 0, `Package script ${script} must remain present.`);
  }

  const importSpecifiers = [
    ...serverSource.matchAll(/from\s+["'](\.[^"']+)["']/g),
    ...serverSource.matchAll(/import\s*\(\s*["'](\.[^"']+)["']\s*\)/g)
  ].map(match => match[1]);
  check(importSpecifiers.length > 0, "The server must expose local imports for tracking checks.");
  for (const specifier of new Set(importSpecifiers)) {
    const resolved = path.resolve(root, specifier);
    check(existsSync(resolved), `Local import ${specifier} must resolve.`);
    const relative = path.relative(root, resolved).replaceAll(path.sep, "/");
    equal(await git("ls-files", "--error-unmatch", "--", relative), relative, `Local import ${specifier} must be tracked.`);
  }

  for (const [file, expected] of Object.entries(protectedFiles)) {
    const bytes = await readFile(path.join(root, file));
    equal(crypto.createHash("sha256").update(bytes).digest("hex"), expected.sha256, `${file} raw SHA-256 must remain unchanged in P1.`);
    equal(await git("hash-object", `--path=${file}`, "--", file), expected.objectId, `${file} normalized Git object must remain unchanged.`);
    equal(await git("rev-parse", `HEAD:${file}`), expected.objectId, `${file} committed object must remain the P0 object.`);
    equal(await git("diff", "--", file), "", `${file} must have no working diff.`);
  }
  check(!/process\.env|fetch\s*\(|https?:\/\//i.test(moduleSource), "The P0 pricing domain must remain pure and provider-hermetic.");

  check(appSource.includes('fetch("/api/pricing"'), "The application must request the public pricing API.");
  check(appSource.includes("Pricing unavailable. No fallback price is shown."), "The application must render a fail-closed pricing state.");
  check(appSource.includes("pricingResult.value.payload.pricing"), "The application must render pricing from the server response.");
  check(appSource.includes("plans.map(plan =>"), "Canonical plans must render from response data.");
  check(!/Founder Audit|Campaign Build|Managed Proof Sprint|Social Cues Pro\b|\$299|\$499|\$49\s*\/\s*mo/i.test(appSource), "The application must contain no retired plan catalog.");
  check(!appSource.includes('/api/billing/checkout'), "The application must not invoke checkout.");
  check(!appSource.includes('/api/billing/portal'), "The application must not invoke the billing portal.");
  check(/id="createCheckout" disabled/.test(appSource), "The checkout control must begin disabled.");
  check(/id="manageSubscription" disabled/.test(appSource), "The billing portal control must begin disabled.");
  check(appSource.includes("data-vizard-credential-form") && appSource.includes("/api/accounts/vizard/status"), "Existing Vizard connection controls must remain represented.");

  deepEqual(seed.billing, {
    status: "Not configured",
    selectedPlanId: "business",
    checkoutMode: "unavailable",
    offers: []
  }, "The seed billing state must remain minimal and fail closed.");
  check(!Object.hasOwn(seed.billing, "paymentLink"), "The seed must not carry a payment-link field.");
  check(resolvePricingPlan(seed.billing.selectedPlanId).ok, "The seed-selected plan must resolve through P0.");
  check(!/monthlyPrice|priceCents|stripePrice|https?:\/\/(?:checkout|buy)\.stripe\.com|\$\d+/i.test(seedSource), "The seed must contain no authoritative prices or payment URL.");

  check(serverSource.includes('url.pathname === "/api/pricing" && req.method === "GET"'), "The server must expose only a GET pricing API route.");
  check(serverSource.includes('"/api/pricing"') && serverSource.includes("anonymousApiGetPaths"), "The pricing API must be on the anonymous GET allowlist.");
  check(serverSource.includes("unavailablePricingEnvelope"), "The API must include a sanitized unavailable envelope.");
  check(serverSource.includes("pricingUnavailablePageHtml"), "The public page must include a fail-closed unavailable view.");
  check(!serverSource.includes("buildPricingPresentation"), "P1 must not depend on the dirty Stripe-aware presentation adapter.");

  return { serverSource, appSource, seed, packageJson };
}

async function runtimeChecks() {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactRoot = path.join(root, ".tmp", `pricing-presentation-${process.pid}-${Date.now()}`);
  const dataDir = path.join(artifactRoot, "data");
  const guardPath = path.join(artifactRoot, "external-request-guard.mjs");
  const externalLogPath = path.join(artifactRoot, "external-http-requests.ndjson");
  await mkdir(dataDir, { recursive: true });
  await writeFile(guardPath, `
import { appendFile } from "node:fs/promises";
const originalFetch = globalThis.fetch;
const logPath = process.env.SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG || "";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
globalThis.fetch = async (input, init = {}) => {
  const rawUrl = input instanceof URL || typeof input === "string" ? String(input) : String(input?.url || "");
  const target = new URL(rawUrl);
  if (["http:", "https:"].includes(target.protocol) && !loopbackHosts.has(target.hostname)) {
    if (logPath) await appendFile(logPath, JSON.stringify({ method: String(init?.method || input?.method || "GET").toUpperCase(), origin: target.origin }) + "\\n", "utf8");
    throw new Error("External HTTP request blocked by the pricing presentation guard.");
  }
  return originalFetch(input, init);
};
`, "utf8");

  const env = {
    ...minimalSystemEnv(),
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    VERCEL: "1",
    AUTH_PROVIDER: "",
    AUTH_SESSION_SECRET: "pricing-contract-session-secret-with-sufficient-length",
    OAUTH_TOKEN_ENCRYPTION_KEY: "pricing-contract-encryption-secret-with-sufficient-length",
    SUPABASE_ENABLED: "false",
    SENTRY_DSN: "",
    PUBLIC_APP_URL: baseUrl,
    SOCIAL_CUES_DATA_DIR: dataDir,
    SOCIAL_CUES_PROMO_CODES: "[]",
    SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: externalLogPath,
    SOCIAL_CUES_PRICING_SECRET_SENTINEL: secretSentinel,
    AUTOMATIC_PUBLISHING_ENABLED: "false"
  };
  const child = spawn(process.execPath, [`--import=${pathToFileURL(guardPath).href}`, "server.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-30_000); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-30_000); });
  try {
    await waitForHealth(baseUrl, child, () => stdout + stderr);

    const firstApi = await request(baseUrl, "/api/pricing");
    equal(firstApi.status, 200, "Public GET /api/pricing must succeed without a session.");
    check(/^application\/json\b/i.test(firstApi.contentType), "GET /api/pricing must return JSON.");
    equal(firstApi.body?.ok, true, "Pricing API success must be explicit.");
    equal(firstApi.body?.schemaVersion, expectedSchemaVersion, "Pricing API schema version must be stable.");
    equal(firstApi.body?.pricing?.status, "available", "Pricing catalog must report available when P0 resolves.");
    equal(firstApi.body?.pricing?.catalogVersion, PRICING_CONFIGURATION.version, "API catalog version must match P0.");
    equal(firstApi.body?.pricing?.defaultPlanId, PRICING_CONFIGURATION.defaultPlanId, "API default plan must match P0.");
    equal(firstApi.body?.pricing?.currency, "usd", "API currency must be USD.");
    equal(firstApi.body?.pricing?.billingInterval, "month", "API interval must be monthly.");
    deepEqual(firstApi.body?.pricing?.plans.map(plan => plan.id), ["business", "growth", "agency"], "API plan order must be canonical.");
    deepEqual(firstApi.body?.pricing?.plans.map(plan => plan.monthlyPriceCents), [9900, 17900, 24900], "API amounts must match P0 exactly.");
    deepEqual(firstApi.body?.pricing?.plans.map(plan => plan.monthlyPriceDisplay), ["$99 / month", "$179 / month", "$249 / month"], "API monthly displays must derive from P0.");
    for (let index = 0; index < PRICING_CONFIGURATION.plans.length; index += 1) {
      const expected = PRICING_CONFIGURATION.plans[index];
      const actual = firstApi.body.pricing.plans[index];
      equal(actual.name, expected.name, `Plan ${expected.id} name must match P0.`);
      equal(actual.currency, expected.currency, `Plan ${expected.id} currency must match P0.`);
      equal(actual.billingInterval, expected.billingInterval, `Plan ${expected.id} interval must match P0.`);
      deepEqual(actual.allowances.map(item => item.id), expected.allowances.map(item => item.id), `Plan ${expected.id} allowances must preserve P0 order.`);
      deepEqual(actual.capabilities.map(item => item.id), expected.capabilities.map(item => item.id), `Plan ${expected.id} capabilities must preserve P0 order.`);
      equal(actual.support.serviceLevelAgreement, null, `Plan ${expected.id} must not promise an SLA.`);
      equal(actual.support.guaranteedResponseTime, null, `Plan ${expected.id} must not promise a response time.`);
      equal(actual.checkout.available, false, `Plan ${expected.id} checkout must be unavailable.`);
      for (const allowanceId of ["intelligence-credits", "media-storage", "automation"]) {
        equal(actual.allowances.find(item => item.id === allowanceId)?.serverBounded, true, `${expected.id} ${allowanceId} must remain server bounded.`);
      }
    }
    equal(firstApi.body.pricing.checkout.available, false, "Catalog checkout must be unavailable.");
    equal(firstApi.body.pricing.billingActivation.available, false, "Billing activation must be unavailable.");
    const vizard = firstApi.body.pricing.providers.find(provider => provider.id === "vizard");
    equal(vizard?.status, "planned", "Vizard must remain planned.");
    equal(vizard?.availability, "unavailable", "Vizard must remain unavailable.");

    const responseKeys = collectObjectKeys(firstApi.body).map(key => key.toLowerCase());
    for (const forbiddenKey of ["stripepriceid", "paymentlink", "credentialreadiness", "environmentvalues", "margin", "costassumption"]) {
      check(!responseKeys.includes(forbiddenKey), `Pricing API must omit ${forbiddenKey}.`);
    }
    for (const forbiddenText of [secretSentinel, "STRIPE_SECRET_KEY", "STRIPE_PRICE_", "checkout.stripe.com", "buy.stripe.com", "price_"]) {
      check(!firstApi.text.includes(forbiddenText), `Pricing API must not expose ${forbiddenText}.`);
    }

    firstApi.body.pricing.plans[0].name = "Mutated";
    firstApi.body.pricing.plans[0].monthlyPriceCents = 1;
    const secondApi = await request(baseUrl, "/api/pricing");
    equal(secondApi.body?.pricing?.plans?.[0]?.name, "Business", "A response mutation must not alter the catalog.");
    equal(secondApi.body?.pricing?.plans?.[0]?.monthlyPriceCents, 9900, "A response mutation must not alter P0 pricing.");

    const apiMutation = await request(baseUrl, "/api/pricing", { method: "POST" });
    check(apiMutation.status >= 400, "Non-GET pricing API requests must fail closed.");
    equal(apiMutation.body?.ok, false, "Non-GET pricing API requests must not succeed.");

    const page = await request(baseUrl, "/pricing");
    equal(page.status, 200, "GET /pricing must succeed.");
    check(/^text\/html\b/i.test(page.contentType), "GET /pricing must return HTML.");
    for (const plan of ["Business", "Growth", "Agency"]) check(page.text.includes(`>${plan}<`), `/pricing must render ${plan}.`);
    for (const price of ["$99 / month", "$179 / month", "$249 / month"]) check(page.text.includes(price), `/pricing must render ${price}.`);
    check(page.text.indexOf("Business") < page.text.indexOf("Growth") && page.text.indexOf("Growth") < page.text.indexOf("Agency"), "/pricing must preserve canonical plan order.");
    equal((page.text.match(/data-pricing-plan=/g) || []).length, 3, "/pricing must render exactly three plan cards.");
    equal((page.text.match(/disabled aria-disabled="true"/g) || []).length, 3, "Every pricing card checkout control must be disabled.");
    check(page.text.includes("USD, billed monthly"), "/pricing must identify USD and monthly billing.");
    check(page.text.includes("planned / unavailable") && page.text.includes("Vizard"), "/pricing must disclose Vizard as planned and unavailable.");
    for (const forbidden of [/Founder Audit/i, /Campaign Build/i, /Managed Proof Sprint/i, /Social Cues Pro\b/i, /\$299/i, /\$499/i, /\$49\s*\/\s*mo/i, /annual/i, /promotion/i, /founding/i, /unlimited/i, /checkout\.stripe\.com/i, /buy\.stripe\.com/i, /price_/i, /<s\b/i]) {
      check(!forbidden.test(page.text), `/pricing must exclude ${forbidden}.`);
    }
    const pageMutation = await request(baseUrl, "/pricing", { method: "POST" });
    equal(pageMutation.status, 405, "Non-GET /pricing requests must be rejected.");

    const landing = await request(baseUrl, "/");
    equal(landing.status, 200, "The landing page must remain available.");
    check(landing.text.includes('href="/pricing"'), "The landing page must expose the read-only pricing page.");
    check(!landing.text.includes('/api/billing/checkout'), "The landing page must not invoke checkout.");
    check(!/checkout\.stripe\.com|buy\.stripe\.com/i.test(landing.text), "The landing page must not contain a payment URL.");

    const portal = await request(baseUrl, "/portal");
    equal(portal.status, 200, "The account portal must remain available.");
    check(/id="portalCheckout" disabled/.test(portal.text), "The portal checkout control must remain disabled.");
    check(!portal.text.includes('/api/billing/checkout'), "The portal must not invoke checkout.");
    check(!portal.text.includes('/api/billing/portal'), "The portal must not invoke billing management.");
    check(!/checkout\.stripe\.com|buy\.stripe\.com/i.test(portal.text), "The portal must not contain a payment URL.");

    await terminateChild(child);
    const externalLog = await readFile(externalLogPath, "utf8").catch(() => "");
    equal(externalLog.trim(), "", "The P1 runtime contract must make zero external requests.");
    check(!stdout.includes(secretSentinel), "The server stdout must not expose the sentinel.");
    check(!stderr.includes(secretSentinel), "The server stderr must not expose the sentinel.");
    check(!page.text.includes(secretSentinel) && !landing.text.includes(secretSentinel) && !portal.text.includes(secretSentinel), "HTML responses must not expose the sentinel.");

    return { artifactRoot, artifacts: await artifactInventory(artifactRoot) };
  } finally {
    await terminateChild(child);
  }
}

async function run() {
  await sourceChecks();
  const runtime = await runtimeChecks();
  console.log(JSON.stringify({
    ok: true,
    checks,
    schemaVersion: expectedSchemaVersion,
    plans: PRICING_CONFIGURATION.plans.length,
    realProviderRequests: 0,
    productionRequests: 0,
    secretsExposed: 0,
    artifactRoot: path.relative(root, runtime.artifactRoot).replaceAll(path.sep, "/"),
    artifacts: runtime.artifacts
  }));
}

run().catch(error => {
  console.error(redactedOutput(error?.stack || error?.message || error));
  process.exitCode = 1;
});
