import process from "node:process";

const baseUrl = String(process.env.SOCIAL_CUES_CANARY_URL || "https://socialcuesapp.com").replace(/\/$/, "");
const failures = [];
const checks = [];

function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}: ${detail}`);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { redirect: "manual", ...options });
  const text = options.method === "HEAD" ? "" : await response.text();
  return { response, text };
}

function leakedSecret(text = "") {
  return /(sk_live_|sk-proj-|sb_secret_|service_role|BEGIN PRIVATE KEY|VAPID_PRIVATE_KEY)/i.test(text);
}

const health = await request("/health");
let healthBody = {};
try { healthBody = JSON.parse(health.text); } catch {}
record("health endpoint", health.response.status === 200 && healthBody.ok === true, `status ${health.response.status}`);
record("health response secret scan", !leakedSecret(health.text), "health output must never contain credential material");

const app = await request("/app");
record("customer app shell", app.response.status === 200 && /Social Cues/i.test(app.text), `status ${app.response.status}`);
record("content security policy", Boolean(app.response.headers.get("content-security-policy")), "CSP header missing");
record("content type protection", app.response.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options must be nosniff");
record("frame protection", Boolean(app.response.headers.get("x-frame-options") || /frame-ancestors/i.test(app.response.headers.get("content-security-policy") || "")), "frame protection missing");
record("app response secret scan", !leakedSecret(app.text), "app shell must never contain credential material");

for (const pathname of ["/api/model", "/api/responses", "/api/push/status", "/api/workers/status"]) {
  const result = await request(pathname);
  record(`protected ${pathname}`, [401, 402, 403].includes(result.response.status), `anonymous status ${result.response.status}`);
}

const worker = await request("/api/cron/workers");
record("secured worker schedule", worker.response.status === 401, `anonymous status ${worker.response.status}`);

const assets = await request("/api/media/public-assets");
let assetBody = {};
try { assetBody = JSON.parse(assets.text); } catch {}
record("public media manifest", assets.response.status === 200 && Array.isArray(assetBody.assets) && assetBody.assets.length >= 6, `status ${assets.response.status}`);
for (const asset of (assetBody.assets || []).slice(0, 12)) {
  const assetUrl = new URL(asset.url, baseUrl);
  const result = await fetch(assetUrl, { method: "HEAD", redirect: "manual" });
  record(`media ${asset.id || assetUrl.pathname}`, result.status === 200 && Number(result.headers.get("content-length") || 0) > 0, `status ${result.status}`);
}

for (const check of checks) {
  process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}${check.detail ? ` - ${check.detail}` : ""}\n`);
}
if (failures.length) {
  process.stderr.write(`\nProduction canary failed with ${failures.length} issue(s).\n`);
  process.exit(1);
}
process.stdout.write(`\nProduction canary passed ${checks.length} checks against ${baseUrl}.\n`);
