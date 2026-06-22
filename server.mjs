import http from "node:http";
import crypto from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(__dirname, "data");
const modelPath = path.join(dataDir, "model.json");
const localUiPath = path.join(__dirname, "social-cues-app.html");
const parentUiPath = path.join(root, "social-cues-app.html");
const uiPath = existsSync(localUiPath) ? localUiPath : parentUiPath;
const localSeedPath = path.join(__dirname, "social-cues-model-seed.json");
const parentSeedPath = path.join(root, "social-cues-model-seed.json");
const seedPath = existsSync(localSeedPath) ? localSeedPath : parentSeedPath;
const manifestPath = path.join(__dirname, "manifest.webmanifest");
const serviceWorkerPath = path.join(__dirname, "sw.js");
const iconPath = path.join(__dirname, "icon.svg");

async function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  const lines = (await readFile(envPath, "utf8")).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

await loadEnvFile();

const port = Number(process.env.PORT || 4177);
const host = process.env.HOST || "0.0.0.0";
const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const supabaseServiceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseEnabled = Boolean(supabaseUrl && supabaseServiceKey && process.env.SUPABASE_ENABLED !== "false");
const publicAppUrl = (process.env.PUBLIC_APP_URL || process.env.APP_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
const metaPublicAppUrl = (process.env.META_PUBLIC_APP_URL || publicAppUrl).replace(/\/$/, "");
const brandDomain = process.env.BRAND_DOMAIN || "socialcuesapp.com";
const brandHomeUrl = (process.env.BRAND_HOME_URL || `https://${brandDomain}`).replace(/\/$/, "");
const supportEmail = process.env.SUPPORT_EMAIL || "mr.barton@socialcuesapp.com";
const runtimeMode = process.env.VERCEL ? "vercel" : "local";
const corsOrigin = new URL(publicAppUrl).origin;
const metaAppId = process.env.META_APP_ID || "";
const metaAppSecret = process.env.META_APP_SECRET || "";
const metaApiVersion = process.env.META_API_VERSION || "v23.0";
const threadsAppId = process.env.THREADS_APP_ID || process.env.THREADS_CLIENT_ID || "";
const threadsAppSecret = process.env.THREADS_APP_SECRET || process.env.THREADS_CLIENT_SECRET || "";
const xPublicAppUrl = (process.env.X_PUBLIC_APP_URL || publicAppUrl).replace(/\/$/, "");
const xClientId = process.env.X_CLIENT_ID || process.env.TWITTER_CLIENT_ID || "";
const xClientSecret = process.env.X_CLIENT_SECRET || process.env.TWITTER_CLIENT_SECRET || "";
let lastPersistence = { driver: supabaseEnabled ? "supabase" : "local-json", ok: true, message: "ready" };

const metaScopes = [
  "public_profile",
  "pages_show_list",
  "pages_read_engagement"
];

const threadsScopes = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_insights"
];

const xScopes = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access"
];

const metaUseCases = [
  { id: "auth", name: "OAuth login and account consent", lane: "Core", env: ["META_APP_ID", "META_APP_SECRET"], scopes: ["public_profile"], phase: "wired" },
  { id: "facebook_pages_connect", name: "Facebook Page connection", lane: "Facebook", env: ["META_APP_ID", "META_APP_SECRET"], scopes: ["pages_show_list"], phase: "oauth-ready" },
  { id: "facebook_pages_publish", name: "Facebook Page publishing", lane: "Facebook", env: ["META_APP_ID", "META_APP_SECRET"], scopes: ["pages_manage_posts"], phase: "queue-adapter-next" },
  { id: "facebook_pages_insights", name: "Facebook Page analytics", lane: "Facebook", env: ["META_APP_ID", "META_APP_SECRET"], scopes: ["pages_read_engagement"], phase: "analytics-next" },
  { id: "instagram_connect", name: "Instagram professional account connection", lane: "Instagram", env: ["META_APP_ID", "META_APP_SECRET"], scopes: ["instagram_basic", "pages_show_list"], phase: "oauth-ready" },
  { id: "instagram_publish", name: "Instagram content publishing", lane: "Instagram", env: ["META_APP_ID", "META_APP_SECRET"], scopes: ["instagram_content_publish"], phase: "queue-adapter-next" },
  { id: "instagram_insights", name: "Instagram analytics", lane: "Instagram", env: ["META_APP_ID", "META_APP_SECRET"], scopes: ["instagram_basic", "pages_read_engagement"], phase: "analytics-next" },
  { id: "threads_connect", name: "Threads account connection", lane: "Threads", env: ["THREADS_APP_ID", "THREADS_APP_SECRET"], scopes: ["threads_basic"], phase: "oauth-ready" },
  { id: "threads_publish", name: "Threads publishing", lane: "Threads", env: ["THREADS_APP_ID", "THREADS_APP_SECRET"], scopes: ["threads_content_publish"], phase: "queue-adapter-next" },
  { id: "threads_insights", name: "Threads insights", lane: "Threads", env: ["THREADS_APP_ID", "THREADS_APP_SECRET"], scopes: ["threads_manage_insights"], phase: "analytics-next" },
  { id: "ads_read", name: "Ads reporting", lane: "Ads", env: ["META_APP_ID", "META_APP_SECRET"], scopes: ["ads_read"], phase: "planned-review" },
  { id: "ads_management", name: "Ads campaign management", lane: "Ads", env: ["META_APP_ID", "META_APP_SECRET"], scopes: ["ads_management"], phase: "planned-review" },
  { id: "business_management", name: "Business asset management", lane: "Business", env: ["META_APP_ID", "META_APP_SECRET"], scopes: ["business_management"], phase: "planned-review" },
  { id: "lead_ads", name: "Lead ads intake", lane: "Growth", env: ["META_APP_ID", "META_APP_SECRET"], scopes: ["leads_retrieval"], phase: "planned-review" },
  { id: "webhooks", name: "Webhooks and event intake", lane: "Infrastructure", env: ["META_APP_ID", "META_APP_SECRET", "WEBHOOK_VERIFY_TOKEN", "WEBHOOK_SIGNING_SECRET"], scopes: [], phase: "planned" },
  { id: "oembed_read", name: "Meta oEmbed Read", lane: "Public embeds", env: ["META_APP_ID", "META_APP_SECRET"], scopes: [], phase: "added-use-case" },
  { id: "fundraising", name: "Fundraising workflows", lane: "Fundraising", env: ["META_APP_ID", "META_APP_SECRET"], scopes: [], phase: "policy-review" },
  { id: "commerce_signal", name: "Commerce attribution signals", lane: "Commerce", env: ["META_APP_ID", "META_APP_SECRET"], scopes: ["pages_read_engagement"], phase: "planned" },
  { id: "app_review", name: "App review evidence and permission governance", lane: "Trust", env: ["META_APP_ID", "META_APP_SECRET"], scopes: [], phase: "required-before-public" }
];

const metaUseCaseSurfaces = {
  auth: { endpoint: "/api/oauth/meta/start", method: "GET", liveWhen: "Meta app credentials and valid OAuth redirect are configured." },
  facebook_pages_connect: { endpoint: "/api/meta/pages", method: "GET", liveWhen: "A Meta account is connected with pages_show_list." },
  facebook_pages_publish: { endpoint: "/api/meta/publish/facebook", method: "POST", liveWhen: "A Page token is connected with pages_manage_posts." },
  facebook_pages_insights: { endpoint: "/api/meta/insights/facebook", method: "GET", liveWhen: "A Page token is connected with pages_read_engagement." },
  instagram_connect: { endpoint: "/api/meta/instagram/accounts", method: "GET", liveWhen: "A connected Page exposes instagram_business_account." },
  instagram_publish: { endpoint: "/api/meta/publish/instagram", method: "POST", liveWhen: "An Instagram business account is connected with instagram_content_publish." },
  instagram_insights: { endpoint: "/api/meta/insights/instagram", method: "GET", liveWhen: "An Instagram business account is connected with instagram_basic and analytics access." },
  threads_connect: { endpoint: "/api/oauth/threads/start", method: "GET", liveWhen: "Threads credentials and callback are configured." },
  threads_publish: { endpoint: "/api/oauth/threads/start", method: "GET", liveWhen: "Threads publishing permission is approved and token exchange is implemented." },
  threads_insights: { endpoint: "/api/oauth/threads/status", method: "GET", liveWhen: "Threads insights permission is approved and token exchange is implemented." },
  ads_read: { endpoint: "/api/meta/ads/report", method: "GET", liveWhen: "A connected business/ad account token has ads_read." },
  ads_management: { endpoint: "/api/meta/ads/campaigns", method: "POST", liveWhen: "A connected ad account token has ads_management." },
  business_management: { endpoint: "/api/meta/business/assets", method: "GET", liveWhen: "A connected token has business_management." },
  lead_ads: { endpoint: "/api/meta/leads", method: "GET", liveWhen: "A connected Page token has leads_retrieval." },
  webhooks: { endpoint: "/api/meta/webhook", method: "GET/POST", liveWhen: "WEBHOOK_VERIFY_TOKEN and WEBHOOK_SIGNING_SECRET are configured." },
  oembed_read: { endpoint: "/api/meta/oembed", method: "GET", liveWhen: "Meta app credentials are configured and the requested URL is a public Facebook or Instagram page, post, or video." },
  fundraising: { endpoint: "/api/meta/fundraising/readiness", method: "GET", liveWhen: "Policy, region, and Meta review requirements are cleared." },
  commerce_signal: { endpoint: "/api/meta/commerce/signals", method: "POST", liveWhen: "User-approved campaign commerce signals are available." },
  app_review: { endpoint: "/api/meta/review-pack", method: "GET", liveWhen: "Always available as the evidence pack for App Review." }
};

const platforms = [
  { id: "tiktok", name: "TikTok", fit: "Discovery and hooks", bestTime: "5:40 PM", tags: ["#AItools", "#SmallBiz", "#CreatorTools", "#Automation", "#TechTok"] },
  { id: "instagram", name: "Instagram", fit: "Visual trust and saves", bestTime: "6:15 PM", tags: ["#CreatorBusiness", "#SmallBusinessTools", "#AIWorkflow", "#ContentStrategy", "#NoCode"] },
  { id: "threads", name: "Threads", fit: "Conversation and thought leadership", bestTime: "10:20 AM", tags: ["#buildinpublic", "#FounderMode", "#CreatorTools", "#AI"] },
  { id: "youtube", name: "YouTube", fit: "Search and authority", bestTime: "12:30 PM", tags: ["AI tools", "creator workflow", "social media automation", "small business software"] },
  { id: "facebook", name: "Facebook", fit: "Community and local trust", bestTime: "8:10 AM", tags: ["#SmallBusiness", "#MarketingTools", "#ContentPlanning"] },
  { id: "x", name: "X", fit: "Signal and conversation", bestTime: "9:05 AM", tags: ["#buildinpublic", "#AI", "#SaaS"] },
  { id: "shopify", name: "Shopify", fit: "Commerce and attribution", bestTime: "Campaign source", tags: ["launch", "creator-stack", "automation"] }
];

async function ensureModel() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(modelPath)) {
    const seed = await readFile(seedPath, "utf8");
    await writeFile(modelPath, seed);
  }
}

function supabaseHeaders(extra = {}) {
  const headers = {
    apikey: supabaseServiceKey,
    "Content-Type": "application/json",
    ...extra
  };
  if (supabaseServiceKey.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${supabaseServiceKey}`;
  }
  return headers;
}

async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1${pathname}`, {
    ...options,
    headers: supabaseHeaders(options.headers || {})
  });
  const textValue = await response.text();
  let body = textValue;
  try {
    body = textValue ? JSON.parse(textValue) : null;
  } catch {
    body = textValue;
  }
  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`Supabase ${response.status}: ${detail}`);
  }
  return body;
}

async function localGetModel() {
  await ensureModel();
  return readJsonFile(modelPath);
}

async function localSaveModel(model) {
  await mkdir(dataDir, { recursive: true });
  model.updatedAt = new Date().toISOString();
  await writeFile(modelPath, JSON.stringify(model, null, 2));
  return model;
}

async function getSeedModel() {
  return readJsonFile(seedPath);
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function supabaseGetModel() {
  const rows = await supabaseRequest("/app_state?id=eq.primary&select=id,model,updated_at");
  if (Array.isArray(rows) && rows[0]?.model) {
    lastPersistence = { driver: "supabase", ok: true, message: "loaded cloud model" };
    return rows[0].model;
  }
  const seed = await getSeedModel();
  await supabaseSaveModel(seed);
  lastPersistence = { driver: "supabase", ok: true, message: "seeded cloud model" };
  return seed;
}

async function supabaseSaveModel(model) {
  model.updatedAt = new Date().toISOString();
  await supabaseRequest("/app_state?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{ id: "primary", model, updated_at: model.updatedAt }])
  });
  lastPersistence = { driver: "supabase", ok: true, message: "saved cloud model" };
  return model;
}

async function getModel() {
  let model;
  try {
    model = supabaseEnabled ? await supabaseGetModel() : await localGetModel();
  } catch (error) {
    lastPersistence = { driver: "supabase", ok: false, message: error.message };
    model = await localGetModel();
  }
  let changed = false;
  if (!Array.isArray(model.connectedAccounts)) {
    const seed = await getSeedModel();
    model.connectedAccounts = seed.connectedAccounts || [];
    changed = true;
  }
  if (!("currentUser" in model)) {
    model.currentUser = null;
    changed = true;
  }
  if (!Array.isArray(model.actions)) {
    const seed = await getSeedModel();
    model.actions = seed.actions || [];
    changed = true;
  }
  if (!model.onboarding) {
    const seed = await getSeedModel();
    model.onboarding = seed.onboarding || {};
    changed = true;
  }
  if (!model.analytics) {
    const seed = await getSeedModel();
    model.analytics = seed.analytics || { metrics: [] };
    changed = true;
  }
  if (model.integrations && !("canva" in model.integrations)) {
    model.integrations.canva = "Needed";
    model.integrations.sora = "Needed";
    changed = true;
  }
  if (!model.billing) {
    const seed = await getSeedModel();
    model.billing = seed.billing || {};
    changed = true;
  }
  if (sanitizeConnectedAccounts(model)) changed = true;
  if (hydrateMetaLoginStatus(model)) changed = true;
  if (changed) await saveModel(model);
  return model;
}

function isConnectedStatus(status) {
  return String(status || "").toLowerCase() === "connected";
}

function hasStoredToken(account) {
  return Boolean(account?.credential || account?.token || account?.accessToken || account?.refreshToken);
}

function isRealConnectedAccount(account) {
  if (!account || account.status !== "connected") return false;
  if (account.platform === "meta") return account.oauthProvider === "meta" && hasStoredToken(account) && Boolean(account.providerAccountId);
  if (["facebook", "instagram"].includes(account.platform)) return account.oauthProvider === "meta" && hasStoredToken(account) && Boolean(account.providerAccountId);
  if (account.platform === "threads") return account.oauthProvider === "threads" && hasStoredToken(account) && Boolean(account.providerAccountId);
  if (account.platform === "x") return account.oauthProvider === "x" && hasStoredToken(account) && Boolean(account.providerAccountId);
  return hasStoredToken(account) && Boolean(account.providerAccountId || account.oauthProvider);
}

function sanitizeConnectedAccounts(model) {
  if (!Array.isArray(model.connectedAccounts)) return false;
  let changed = false;
  for (const account of model.connectedAccounts) {
    if (!account.credential && account.token) {
      account.credential = account.token;
      delete account.token;
      changed = true;
    }
    if (account.accessToken) {
      delete account.accessToken;
      changed = true;
    }
    if (account.refreshToken) {
      delete account.refreshToken;
      changed = true;
    }
    const status = String(account.status || "").toLowerCase();
    const pendingOauth = ["oauth code received", "oauth pending secret"].includes(status);
    if (["facebook", "instagram"].includes(account.platform) && !account.providerAccountId && account.handle) {
      account.handle = "";
      changed = true;
    }
    if (isRealConnectedAccount(account) || pendingOauth || status === "not connected") continue;
    if (isConnectedStatus(account.status) || ["logged in", "meta login connected"].includes(status)) {
      account.status = "not connected";
      account.connectedAt = null;
      account.connectionEvidence = "removed: no provider token or provider account id was stored";
      changed = true;
    }
  }
  return changed;
}

function hydrateMetaLoginStatus(model) {
  const accounts = model.connectedAccounts || [];
  const metaUser = accounts.find(account => account.platform === "meta" && isRealConnectedAccount(account));
  if (!metaUser) return false;
  let changed = false;
  model.integrations = model.integrations || {};
  if (model.integrations.meta !== `Logged in as ${metaUser.name || metaUser.handle || "Meta user"}`) {
    model.integrations.meta = `Logged in as ${metaUser.name || metaUser.handle || "Meta user"}`;
    changed = true;
  }
  for (const platform of ["facebook", "instagram"]) {
    const account = accounts.find(item => item.platform === platform);
    if (account && account.oauthProvider !== "meta") {
      account.oauthProvider = "meta";
      account.scopes = metaUser.scopes || metaScopes;
      account.loginNote = platform === "facebook"
        ? "Meta login is connected, but no Facebook Page asset was returned. This account is not connected until Meta returns a Page id and token."
        : "Meta login is connected, but no Instagram professional asset was returned. This account is not connected until Meta returns an IG id and token.";
      changed = true;
    }
  }
  return changed;
}

async function saveModel(model) {
  try {
    return supabaseEnabled ? await supabaseSaveModel(model) : await localSaveModel(model);
  } catch (error) {
    lastPersistence = { driver: "supabase", ok: false, message: error.message };
    return localSaveModel(model);
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}

async function bodyJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function bodyText(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseMetaSignedRequest(signedRequest) {
  if (!metaAppSecret) throw new Error("META_APP_SECRET is required to verify data deletion requests.");
  const [encodedSignature, encodedPayload] = String(signedRequest || "").split(".");
  if (!encodedSignature || !encodedPayload) throw new Error("Missing signed_request.");

  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
  if (payload.algorithm && String(payload.algorithm).toUpperCase() !== "HMAC-SHA256") {
    throw new Error("Unsupported signed_request algorithm.");
  }

  const expected = crypto
    .createHmac("sha256", metaAppSecret)
    .update(encodedPayload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  if (!timingSafeEqualText(encodedSignature, expected)) throw new Error("Invalid signed_request signature.");
  return payload;
}

function encryptedToken(value) {
  if (!value) return null;
  const keyMaterial = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || metaAppSecret || supabaseServiceKey || "Social Cues-local-dev";
  const key = crypto.createHash("sha256").update(keyMaterial).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    value: ciphertext.toString("base64url")
  };
}

function decryptedToken(record) {
  if (!record?.value || !record?.iv || !record?.tag) return "";
  const keyMaterial = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || metaAppSecret || supabaseServiceKey || "Social Cues-local-dev";
  const key = crypto.createHash("sha256").update(keyMaterial).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.value, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

async function metaGraph(pathname, params = {}, accessToken = "", options = {}) {
  const url = new URL(`https://graph.facebook.com/${metaApiVersion}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  if (accessToken) url.searchParams.set("access_token", accessToken);
  const response = await fetch(url, { method: options.method || "GET" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const message = body.error?.message || `Meta Graph API ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function threadsApi(pathname, params = {}, accessToken = "", options = {}) {
  const version = process.env.THREADS_API_VERSION || "v1.0";
  const base = pathname.includes("/oauth/") ? "https://graph.threads.net" : `https://graph.threads.net/${version}`;
  const url = new URL(`${base}${pathname}`);
  const method = options.method || "GET";
  const payload = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (method === "POST") {
      if (value !== undefined && value !== null && value !== "") payload.set(key, value);
      continue;
    }
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  if (method === "POST") {
    if (accessToken) payload.set("access_token", accessToken);
  } else if (accessToken) {
    url.searchParams.set("access_token", accessToken);
  }
  const response = await fetch(url, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
    body: method === "POST" ? payload.toString() : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const message = body.error?.message || `Threads API ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function xApi(pathname, params = {}, accessToken = "", options = {}) {
  const url = new URL(`https://api.x.com/2${pathname}`);
  const method = options.method || "GET";
  for (const [key, value] of Object.entries(params)) {
    if (method === "GET" && value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {})
    },
    body: method === "POST" ? JSON.stringify(params) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error || body.errors?.length) {
    const message = body.error_description || body.error || body.errors?.[0]?.detail || body.errors?.[0]?.title || `X API ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function exchangeMetaCode(code) {
  if (!metaAppId || !metaAppSecret) throw new Error("META_APP_ID and META_APP_SECRET are required for token exchange.");
  const shortLived = await metaGraph("/oauth/access_token", {
    client_id: metaAppId,
    client_secret: metaAppSecret,
    redirect_uri: metaRedirectUri(),
    code
  });
  const longLived = await metaGraph("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: metaAppId,
    client_secret: metaAppSecret,
    fb_exchange_token: shortLived.access_token
  });
  return {
    accessToken: longLived.access_token || shortLived.access_token,
    tokenType: longLived.token_type || shortLived.token_type || "bearer",
    expiresIn: longLived.expires_in || shortLived.expires_in || null
  };
}

async function exchangeXCode(code, verifier) {
  if (!xClientId) throw new Error("X_CLIENT_ID is required for token exchange.");
  const payload = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: xClientId,
    redirect_uri: xRedirectUri(),
    code,
    code_verifier: verifier
  });
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (xClientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${xClientId}:${xClientSecret}`).toString("base64")}`;
  }
  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers,
    body: payload.toString()
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || token.error) throw new Error(token.error_description || token.error || `X token exchange ${response.status}`);
  const user = await xApi("/users/me", { "user.fields": "id,name,username,verified,profile_image_url" }, token.access_token);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    tokenType: token.token_type || "bearer",
    expiresIn: token.expires_in || null,
    scope: token.scope || xScopes.join(" "),
    user: user.data || null
  };
}

async function exchangeThreadsCode(code) {
  if (!threadsAppId || !threadsAppSecret) throw new Error("THREADS_APP_ID and THREADS_APP_SECRET are required for token exchange.");
  const shortLived = await threadsApi("/oauth/access_token", {
    client_id: threadsAppId,
    client_secret: threadsAppSecret,
    grant_type: "authorization_code",
    redirect_uri: threadsRedirectUri(),
    code
  }, "", { method: "POST" });
  const longLived = await threadsApi("/access_token", {
    grant_type: "th_exchange_token",
    client_secret: threadsAppSecret,
    access_token: shortLived.access_token
  });
  const accessToken = longLived.access_token || shortLived.access_token;
  const me = await threadsApi("/me", { fields: "id,username,name" }, accessToken);
  return {
    accessToken,
    tokenType: longLived.token_type || shortLived.token_type || "bearer",
    expiresIn: longLived.expires_in || shortLived.expires_in || null,
    user: me
  };
}

function upsertConnectedAccount(model, patch) {
  model.connectedAccounts = model.connectedAccounts || [];
  let account = model.connectedAccounts.find(item => item.id === patch.id);
  if (!account && patch.platform) {
    account = model.connectedAccounts.find(item => item.platform === patch.platform && item.oauthProvider === patch.oauthProvider && item.providerAccountId === patch.providerAccountId);
  }
  if (!account && patch.platform && !patch.providerAccountId) {
    account = model.connectedAccounts.find(item => item.platform === patch.platform);
  }
  if (!account) {
    account = { id: patch.id || uid("acct"), platform: patch.platform, name: patch.name || patch.platform, handle: "", status: "not connected", connectedAt: null };
    model.connectedAccounts.push(account);
  }
  Object.assign(account, patch, { updatedAt: new Date().toISOString() });
  return account;
}

function publicMetaAccount(account) {
  return {
    id: account.id,
    platform: account.platform,
    name: account.name,
    handle: account.handle,
    status: account.status,
    connectedAt: account.connectedAt,
    providerAccountId: account.providerAccountId || null,
    parentFacebookPageId: account.parentFacebookPageId || null,
    category: account.category || null,
    tasks: account.tasks || [],
    scopes: account.scopes || [],
    tokenStored: hasStoredToken(account),
    connected: isRealConnectedAccount(account)
  };
}

function publicAccount(account) {
  const { credential, refreshCredential, token, accessToken, refreshToken, oauthCode, ...safe } = account;
  return {
    ...safe,
    connected: isRealConnectedAccount(account),
    tokenStored: Boolean(credential || token || accessToken || refreshToken)
  };
}

function visibleConnectedAccounts(model) {
  const accounts = model.connectedAccounts || [];
  const realPlatforms = new Set(accounts.filter(isRealConnectedAccount).map(account => account.platform));
  return accounts.filter(account => {
    if (account.platform === "meta") return true;
    if (!isRealConnectedAccount(account) && realPlatforms.has(account.platform)) return false;
    return true;
  });
}

function publicModel(model) {
  const safe = JSON.parse(JSON.stringify(model || {}));
  if (Array.isArray(safe.connectedAccounts)) {
    const sourceAccounts = visibleConnectedAccounts(model);
    safe.connectedAccounts = sourceAccounts.map(publicAccount);
  }
  if (safe.metaHealth && Object.prototype.hasOwnProperty.call(safe.metaHealth, "token")) {
    safe.metaHealth.tokenHealth = safe.metaHealth.token;
    delete safe.metaHealth.token;
  }
  if (Array.isArray(safe.metaHealth?.assetSync?.synced)) {
    safe.metaHealth.assetSync.synced = safe.metaHealth.assetSync.synced.map(publicAccount);
  }
  delete safe.oauthStates;
  if (Array.isArray(safe.metaDeletionRequests)) {
    safe.metaDeletionRequests = safe.metaDeletionRequests.map(item => ({
      confirmationCode: item.confirmationCode,
      receivedAt: item.receivedAt,
      completed: Boolean(item.completed),
      statusUrl: item.statusUrl
    }));
  }
  return safe;
}

function publicMetaHealth(health) {
  if (!health) return null;
  const safe = JSON.parse(JSON.stringify(health));
  if (Object.prototype.hasOwnProperty.call(safe, "token")) {
    safe.tokenHealth = safe.token;
    delete safe.token;
  }
  if (Array.isArray(safe.assetSync?.synced)) {
    safe.assetSync.synced = safe.assetSync.synced.map(publicAccount);
  }
  return safe;
}

function mergeServerOnlyAccountFields(incoming, existing) {
  const merged = { ...incoming };
  for (const key of ["credential", "refreshCredential", "token", "accessToken", "refreshToken", "oauthCode", "tokenType", "tokenExpiresAt"]) {
    if (existing?.[key] && !merged[key]) merged[key] = existing[key];
  }
  if (existing?.providerAccountId && !merged.providerAccountId) merged.providerAccountId = existing.providerAccountId;
  if (existing?.oauthProvider && !merged.oauthProvider) merged.oauthProvider = existing.oauthProvider;
  if (existing?.scopes?.length && (!Array.isArray(merged.scopes) || !merged.scopes.length)) merged.scopes = existing.scopes;
  return merged;
}

function mergePublicModelUpdate(incoming, existing) {
  const merged = JSON.parse(JSON.stringify(incoming || {}));
  if (Array.isArray(merged.connectedAccounts)) {
    const existingAccounts = existing.connectedAccounts || [];
    merged.connectedAccounts = merged.connectedAccounts.map(account => {
      const match = existingAccounts.find(item => item.id === account.id)
        || existingAccounts.find(item => item.platform === account.platform && item.providerAccountId && item.providerAccountId === account.providerAccountId)
        || existingAccounts.find(item => item.platform === account.platform && !item.providerAccountId && !account.providerAccountId);
      return mergeServerOnlyAccountFields(account, match);
    });
    for (const existingAccount of existingAccounts) {
      const exists = merged.connectedAccounts.some(account => account.id === existingAccount.id);
      if (!exists && (hasStoredToken(existingAccount) || existingAccount.providerAccountId)) {
        merged.connectedAccounts.push(existingAccount);
      }
    }
  }
  if (existing.oauthStates && !merged.oauthStates) merged.oauthStates = existing.oauthStates;
  if (existing.metaDeletionRequests && !merged.metaDeletionRequests) merged.metaDeletionRequests = existing.metaDeletionRequests;
  return merged;
}

function metaAccounts(model, platform = "") {
  return (model.connectedAccounts || [])
    .filter(account => account.oauthProvider === "meta" || ["meta", "facebook", "instagram"].includes(account.platform))
    .filter(account => !platform || account.platform === platform);
}

function realMetaAccounts(model, platform = "") {
  return metaAccounts(model, platform).filter(account => isRealConnectedAccount(account));
}

function grantedMetaScopes(model) {
  const scopes = new Set();
  for (const account of realMetaAccounts(model)) {
    for (const scope of account.scopes || []) scopes.add(scope);
  }
  return scopes;
}

function tokenForMetaAccount(account) {
  return decryptedToken(account.credential || account.token);
}

function appAccessToken() {
  return metaAppId && metaAppSecret ? `${metaAppId}|${metaAppSecret}` : "";
}

function requiredAssetPlatform(useCaseId) {
  if (["facebook_pages_publish", "facebook_pages_insights", "lead_ads"].includes(useCaseId)) return "facebook";
  if (["instagram_connect", "instagram_publish", "instagram_insights"].includes(useCaseId)) return "instagram";
  if (useCaseId.startsWith("threads")) return "threads";
  return "";
}

function metaOembedTarget(rawUrl, requestedKind = "") {
  if (!rawUrl) return { ok: false, error: "Add a public Facebook or Instagram URL in the url query parameter." };
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "The oEmbed URL is not a valid URL." };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "Only http and https public URLs can be sent to Meta oEmbed." };
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const isInstagram = host === "instagram.com" || host.endsWith(".instagram.com");
  const isFacebook = host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch";
  if (!isInstagram && !isFacebook) {
    return { ok: false, error: "Meta oEmbed only accepts public Facebook or Instagram URLs." };
  }
  const kind = requestedKind || (isInstagram ? "instagram" : parsed.pathname.includes("/videos/") || host === "fb.watch" ? "facebook_video" : "facebook_post");
  const endpointByKind = {
    instagram: "/instagram_oembed",
    facebook_page: "/oembed_page",
    facebook_post: "/oembed_post",
    facebook_video: "/oembed_video"
  };
  if (!endpointByKind[kind]) {
    return { ok: false, error: "Unsupported oEmbed kind. Use instagram, facebook_page, facebook_post, or facebook_video." };
  }
  return { ok: true, url: parsed.toString(), kind, endpoint: endpointByKind[kind], host };
}

function metaGate(model, useCaseId, options = {}) {
  const useCase = metaUseCases.find(item => item.id === useCaseId);
  const surface = metaUseCaseSurfaces[useCaseId] || {};
  const granted = grantedMetaScopes(model);
  const missingEnv = (useCase?.env || []).filter(name => !envPresent(name));
  const missingScopes = (useCase?.scopes || []).filter(scope => !granted.has(scope));
  const platform = options.platform || requiredAssetPlatform(useCaseId);
  const connected = useCaseId.startsWith("threads")
    ? (model.connectedAccounts || []).filter(account => account.platform === "threads" && isRealConnectedAccount(account))
    : metaAccounts(model, platform).filter(account => isRealConnectedAccount(account));
  const policyGate = useCaseId === "fundraising";
  const needsAsset = Boolean(platform);
  const ready = !policyGate && !missingEnv.length && !missingScopes.length && (!needsAsset || connected.length > 0);
  return {
    id: useCaseId,
    name: useCase?.name || useCaseId,
    lane: useCase?.lane || "Meta",
    endpoint: surface.endpoint || null,
    method: surface.method || null,
    phase: useCase?.phase || "planned",
    ready,
    status: ready ? "ready" : policyGate ? "needs policy review" : missingScopes.length ? "needs Meta permission/review" : missingEnv.length ? "needs configuration" : needsAsset ? `needs ${platform} asset` : "needs connected asset",
    missingEnv,
    missingScopes,
    requiredAssetPlatform: platform || null,
    connectedAccountCount: connected.length,
    liveWhen: surface.liveWhen || ""
  };
}

function metaCapabilityMatrix(model) {
  return metaUseCases.map(useCase => metaGate(model, useCase.id));
}

function metaDiagnosticAgent(model) {
  const health = model.metaHealth || {};
  const connection = model.metaConnection || {};
  const granted = new Set(connection.scopes || health.permissions?.granted || []);
  const pageCount = connection.pageCount ?? health.assetSync?.pagesReturned ?? 0;
  const instagramCount = connection.instagramCount ?? health.assetSync?.instagramReturned ?? 0;
  const tokenValid = Boolean(connection.tokenValid || health.token?.valid);
  const appIdMatches = connection.appIdMatches !== false && health.token?.appIdMatches !== false;
  const hasPageRead = granted.has("pages_show_list") && granted.has("pages_read_engagement");
  const facts = [
    tokenValid ? "Meta token is valid." : "Meta token is missing, expired, or unverified.",
    appIdMatches ? "Meta token belongs to the configured Social Cues app." : "Meta token does not match the configured app.",
    hasPageRead ? "Page read permissions are granted." : "Page read permissions are not fully granted.",
    `Facebook Pages returned by /me/accounts: ${pageCount}.`,
    `Linked Instagram professional assets returned: ${instagramCount}.`
  ];
  const conclusions = [];
  const actions = [];
  const reason = tokenValid && appIdMatches && hasPageRead && !pageCount
    ? "NO_FACEBOOK_PAGE_ASSET"
    : !tokenValid
      ? "META_TOKEN_NOT_VALID"
      : !hasPageRead
        ? "PAGE_READ_PERMISSION_NOT_GRANTED"
        : "READY_OR_PARTIALLY_READY";
  const snapshot = {
    identityConnected: tokenValid && appIdMatches,
    permissionsGranted: Array.from(granted),
    pageReadPermissionsGranted: hasPageRead,
    pagesReturned: pageCount,
    instagramProfessionalAssetsReturned: instagramCount,
    reason,
    retryOnlyAfter: [
      "new Meta OAuth login",
      "Facebook Page created",
      "Page access changed",
      "Instagram professional account linked to a Page",
      "Meta permissions changed"
    ],
    featuresUnlocked: pageCount ? ["meta_identity", "facebook_page_asset"] : ["meta_identity", "public_oembed_preview"],
    blockedFeatures: pageCount ? [] : ["facebook_page_analytics", "facebook_page_publishing", "instagram_graph_api", "lead_ads"]
  };
  if (tokenValid && appIdMatches && hasPageRead && !pageCount) {
    conclusions.push("A personal Facebook profile is not a Facebook Page asset and cannot be made to appear in /me/accounts by code.");
    conclusions.push("The Pages API path needs an actual Facebook Page that the logged-in profile manages, then a fresh Meta login where that Page is selected.");
    actions.push("Create a Facebook Page for Social Cues, even if it starts unpublished/minimal.");
    actions.push("Log out/remove Social Cues from Facebook Business Integrations, then reconnect and select the Page when Meta asks.");
    actions.push("After /me/accounts returns the Page, link an Instagram professional account to that Page for Instagram APIs.");
  }
  if (!pageCount) {
    actions.push("Use Meta oEmbed Read for public Facebook/Instagram post previews until a Page asset exists.");
  }
  if (pageCount) {
    conclusions.push(`${pageCount} Facebook Page asset(s) are available for Page read/analytics workflows.`);
    if (!instagramCount) {
      conclusions.push("Instagram remains gated until a professional Instagram account is linked to the returned Facebook Page and Instagram permissions are approved.");
    }
  }
  const paidNeeds = [
    {
      item: "Stable HTTPS app hosting on the Social Cues domain",
      priority: 1,
      why: `The domain ${brandDomain} is owned now; the remaining unlock is hosting the app/policy pages there for reliable callbacks, sharing previews, app review, and customer trust.`
    },
    {
      item: "Facebook Page creation",
      priority: 0,
      why: "Usually free, but it is the non-negotiable asset needed for /me/accounts, Page analytics, Page publishing, and linked Instagram professional access."
    },
    {
      item: "Meta business verification/app review",
      priority: 2,
      why: "Needed later for public/advanced permissions, but it will not replace the need for a Page asset."
    }
  ];
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    mode: "meta-debug-supervisor",
    snapshot,
    facts,
    conclusions,
    actions,
    paidNeeds,
    leastConfident: pageCount
      ? "Whether the newly-created Page has enough real activity for useful insights responses yet; brand-new Pages often return sparse or empty analytics."
      : "Whether Cory already owns a usable Facebook Page under another profile or account surface; the current login shows zero Pages.",
    biggestMiss: pageCount
      ? "The personal profile vs Facebook Page distinction still matters: the Page asset blocker is cleared, but publishing, Instagram, ads, leads, and Threads still each require their own permissions, assets, and review path."
      : "A Facebook personal profile is not the asset Social Cues needs for Pages API. The app needs either a real Page asset or a product fallback that does not depend on Pages API."
  };
}

async function getMetaTokenHealth(token) {
  const result = {
    checkedAt: new Date().toISOString(),
    valid: false,
    appIdMatches: false,
    userId: null,
    expiresAt: null,
    scopes: [],
    error: null
  };
  if (!token || !appAccessToken()) {
    result.error = "Missing token or app access token.";
    return result;
  }
  try {
    const debug = await metaGraph("/debug_token", { input_token: token }, appAccessToken());
    const data = debug.data || {};
    result.valid = Boolean(data.is_valid);
    result.appIdMatches = String(data.app_id || "") === String(metaAppId);
    result.userId = data.user_id || null;
    result.expiresAt = data.expires_at ? new Date(Number(data.expires_at) * 1000).toISOString() : null;
    result.scopes = data.scopes || [];
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function getMetaPermissions(token) {
  const result = { granted: [], declined: [], expired: [], raw: [], error: null };
  if (!token) {
    result.error = "Missing token.";
    return result;
  }
  try {
    const body = await metaGraph("/me/permissions", {}, token);
    result.raw = body.data || [];
    for (const item of result.raw) {
      if (item.status === "granted") result.granted.push(item.permission);
      if (item.status === "declined") result.declined.push(item.permission);
      if (item.status === "expired") result.expired.push(item.permission);
    }
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function syncMetaAssetsFromToken(model, token, options = {}) {
  const now = new Date().toISOString();
  const result = {
    syncedAt: now,
    pagesReturned: 0,
    instagramReturned: 0,
    synced: [],
    error: null
  };
  try {
    const pages = await metaGraph("/me/accounts", {
      fields: "id,name,category,access_token,tasks,instagram_business_account{id,username,name,profile_picture_url}"
    }, token);
    result.pagesReturned = (pages.data || []).length;
    for (const page of pages.data || []) {
      const pageToken = page.access_token || "";
      result.synced.push(upsertConnectedAccount(model, {
        id: `acct-facebook-${page.id}`,
        platform: "facebook",
        name: page.name || "Facebook Page",
        handle: page.name || "Facebook Page",
        status: pageToken ? "connected" : "asset returned",
        connectedAt: pageToken ? now : null,
        oauthProvider: "meta",
        providerAccountId: page.id,
        category: page.category || "",
        tasks: page.tasks || [],
        scopes: options.scopes || metaScopes,
        credential: pageToken ? encryptedToken(pageToken) : "",
        tokenType: "bearer"
      }));
      if (page.instagram_business_account?.id) {
        const ig = page.instagram_business_account;
        result.instagramReturned += 1;
        result.synced.push(upsertConnectedAccount(model, {
          id: `acct-instagram-${ig.id}`,
          platform: "instagram",
          name: ig.name || "Instagram",
          handle: ig.username ? `@${ig.username}` : ig.name || "Instagram",
          status: pageToken ? "connected" : "asset returned",
          connectedAt: pageToken ? now : null,
          oauthProvider: "meta",
          providerAccountId: ig.id,
          parentFacebookPageId: page.id,
          profilePictureUrl: ig.profile_picture_url || "",
          scopes: options.scopes || metaScopes,
          credential: pageToken ? encryptedToken(pageToken) : "",
          tokenType: "bearer"
        }));
      }
    }
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function getMetaBusinesses(token) {
  const result = {
    checkedAt: new Date().toISOString(),
    businessesReturned: 0,
    businesses: [],
    error: null
  };
  if (!token) {
    result.error = "Missing token.";
    return result;
  }
  try {
    const body = await metaGraph("/me/businesses", {
      fields: "id,name,verification_status"
    }, token);
    result.businesses = body.data || [];
    result.businessesReturned = result.businesses.length;
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function inspectMetaConnection(model, options = {}) {
  const metaUser = metaAccounts(model, "meta").find(hasStoredToken);
  const inspection = {
    checkedAt: new Date().toISOString(),
    configured: Boolean(metaAppId && metaAppSecret),
    hasMetaUserToken: Boolean(metaUser),
    token: null,
    permissions: null,
    assetSync: null,
    businessSync: null,
    capabilityMatrix: [],
    blockers: [],
    nextActions: []
  };
  if (!metaUser) {
    inspection.blockers.push("No server-side Meta user token is stored. Reconnect Meta OAuth.");
    inspection.nextActions.push("Start Meta login again from Social Cues and authorize the requested account permissions.");
    inspection.capabilityMatrix = metaCapabilityMatrix(model);
    return inspection;
  }
  const token = tokenForMetaAccount(metaUser);
  inspection.token = await getMetaTokenHealth(token);
  inspection.permissions = await getMetaPermissions(token);
  const scopes = inspection.permissions?.granted?.length ? inspection.permissions.granted : inspection.token?.scopes || metaUser.scopes || [];
  metaUser.scopes = scopes;
  if (inspection.token?.expiresAt) metaUser.tokenExpiresAt = inspection.token.expiresAt;
  if (inspection.token?.valid === false) inspection.blockers.push(`Meta user token is not valid${inspection.token.error ? `: ${inspection.token.error}` : "."}`);
  if (inspection.token && !inspection.token.appIdMatches) inspection.blockers.push("Meta token does not belong to the configured app id.");
  for (const scope of metaScopes) {
    if (!scopes.includes(scope)) inspection.blockers.push(`Missing granted Meta scope: ${scope}.`);
  }
  inspection.assetSync = await syncMetaAssetsFromToken(model, token, { scopes });
  inspection.businessSync = await getMetaBusinesses(token);
  if (!inspection.assetSync.pagesReturned) {
    inspection.blockers.push("Meta Graph returned zero Facebook Pages for /me/accounts.");
    inspection.nextActions.push("Yes, a Page/account selection or Page admin check is likely needed: reauthorize Meta and make sure at least one Facebook Page is selected and available to this app.");
  }
  if (inspection.businessSync?.error) {
    inspection.nextActions.push(`Business Portfolio diagnostic is blocked: ${inspection.businessSync.error}. Reauthorize with business_management to test /me/businesses.`);
  }
  if (!inspection.assetSync.instagramReturned) {
    inspection.blockers.push("Meta Graph returned zero linked Instagram professional assets.");
    inspection.nextActions.push("Link an Instagram professional account to a Facebook Page, then reauthorize Social Cues with Instagram permissions when the app is ready for those scopes.");
  }
  if (inspection.permissions?.declined?.length) {
    inspection.nextActions.push(`Review declined Meta permissions: ${inspection.permissions.declined.join(", ")}.`);
  }
  if (inspection.assetSync?.error) {
    inspection.nextActions.push(`Resolve Meta Graph asset discovery error: ${inspection.assetSync.error}.`);
  }
  model.metaConnection = {
    ...(model.metaConnection || {}),
    checkedAt: inspection.checkedAt,
    tokenValid: Boolean(inspection.token?.valid),
    appIdMatches: Boolean(inspection.token?.appIdMatches),
    userId: inspection.token?.userId || model.metaConnection?.userId || metaUser.providerAccountId || null,
    userName: metaUser.name || model.metaConnection?.userName || null,
    scopes,
    declinedScopes: inspection.permissions?.declined || [],
    expiredScopes: inspection.permissions?.expired || [],
    pageCount: inspection.assetSync.pagesReturned,
    instagramCount: inspection.assetSync.instagramReturned,
    businessCount: inspection.businessSync?.businessesReturned || 0,
    businessDiagnosticError: inspection.businessSync?.error || null,
    discoveredCount: 1 + inspection.assetSync.synced.length,
    blockers: inspection.blockers,
    nextActions: inspection.nextActions,
    warning: inspection.assetSync.error || inspection.permissions?.error || inspection.token?.error || null
  };
  model.integrations = model.integrations || {};
  model.integrations.meta = inspection.blockers.length ? `Meta connected with ${inspection.blockers.length} blocker${inspection.blockers.length === 1 ? "" : "s"}` : "Meta connected and fully verified";
  inspection.capabilityMatrix = metaCapabilityMatrix(model);
  return inspection;
}

function fmtNumber(value) {
  return Number(value || 0).toLocaleString();
}

function buildGrowthAnalytics(model) {
  const accounts = model.connectedAccounts || [];
  const connected = accounts.filter(account => isRealConnectedAccount(account));
  const metaConnected = accounts.filter(account => account.oauthProvider === "meta" && isRealConnectedAccount(account));
  const metaIdentity = accounts.find(account => account.platform === "meta" && account.oauthProvider === "meta" && isRealConnectedAccount(account));
  const pages = metaConnected.filter(account => account.platform === "facebook" && account.status === "connected" && account.providerAccountId);
  const instagram = metaConnected.filter(account => account.platform === "instagram" && account.status === "connected" && account.providerAccountId);
  const capabilityMatrix = metaCapabilityMatrix(model);
  const readyMeta = capabilityMatrix.filter(item => item.ready);
  const gatedMeta = capabilityMatrix.filter(item => !item.ready);
  const base = model.baseline || {};
  const pageCount = Number(model.metaConnection?.pageCount ?? pages.length);
  const discoveredCount = Number(model.metaConnection?.discoveredCount ?? metaConnected.length);
  const instagramCount = instagram.length;

  const metrics = [
    {
      label: "Meta identity",
      value: metaIdentity?.name || model.metaConnection?.userName || "Not connected",
      source: "Meta Graph /me",
      kind: metaIdentity ? "live" : "blocked",
      signal: metaIdentity ? "OAuth returned a real Meta identity and the token is stored server-side." : "Connect Meta before live account analysis can run."
    },
    {
      label: "Meta Pages",
      value: String(pageCount),
      source: "Meta Graph /me/accounts",
      kind: pageCount ? "live" : "blocked",
      signal: pageCount ? "Facebook Page assets are available for Page-level analytics." : "No Facebook Pages were returned, so Page analytics and publishing are still blocked."
    },
    {
      label: "Instagram assets",
      value: String(instagramCount),
      source: "Meta Page instagram_business_account lookup",
      kind: instagramCount ? "live" : "blocked",
      signal: instagramCount ? "Instagram professional assets are available." : "No Instagram professional account was returned; this needs instagram_basic plus a linked professional account."
    },
    {
      label: "Meta ready lanes",
      value: `${readyMeta.length}/${capabilityMatrix.length}`,
      source: "Social Cues Meta capability matrix",
      kind: "computed",
      signal: readyMeta.length ? "Core OAuth/readiness paths are online; publishing, ads, leads, and Threads remain gated as shown." : "Meta credentials or permissions still need setup."
    },
    {
      label: "Connected account cards",
      value: `${connected.length}/${accounts.length}`,
      source: "Social Cues local account state",
      kind: "computed",
      signal: "Counts cards marked connected or logged in; it does not mean every platform has live analytics yet."
    },
    {
      label: "Manual audience estimate",
      value: fmtNumber(base.audience),
      source: "Manual baseline input",
      kind: "manual",
      signal: "User-entered planning number, not a live platform metric."
    },
    {
      label: "Manual avg. views",
      value: fmtNumber(base.avgViews),
      source: "Manual baseline input",
      kind: "manual",
      signal: "User-entered planning number used only for scenario sizing."
    },
    {
      label: "Manual engagement",
      value: `${base.engagement || 0}%`,
      source: "Manual baseline input",
      kind: "manual",
      signal: "User-entered estimate; live engagement requires Page or Instagram insight permissions and assets."
    },
    {
      label: "Manual cadence",
      value: `${base.cadence || 0}/week`,
      source: "Manual baseline input",
      kind: "manual",
      signal: "User-entered posting rhythm for planning, not a platform-read schedule."
    }
  ];

  const sourceBreakdown = [
    {
      source: "Meta Graph /me",
      status: metaIdentity ? "Live" : "Not connected",
      data: metaIdentity ? `Identity returned: ${metaIdentity.name || metaIdentity.handle || "Meta user"}.` : "No Meta identity is connected yet."
    },
    {
      source: "Meta Graph /me/accounts",
      status: pageCount ? "Live with Pages" : "Live, no Pages returned",
      data: `${pageCount} Facebook Page record(s) returned from the connected Meta account.`
    },
    {
      source: "Meta Page instagram_business_account lookup",
      status: instagramCount ? "Live with Instagram assets" : "Blocked by permissions or asset linkage",
      data: `${instagramCount} Instagram professional account record(s) available.`
    },
    {
      source: "Social Cues capability matrix",
      status: `${readyMeta.length} ready, ${gatedMeta.length} gated`,
      data: gatedMeta.slice(0, 5).map(item => item.name).join(", ") || "No gated Meta lanes."
    },
    {
      source: "Manual baseline input",
      status: "Manual estimate",
      data: `Audience ${fmtNumber(base.audience)}, views ${fmtNumber(base.avgViews)}, engagement ${base.engagement || 0}%, cadence ${base.cadence || 0}/week.`
    }
  ];

  const translatedAnalysis = [
    metaIdentity
      ? `Meta login is real: Social Cues can identify ${metaIdentity.name || "the connected Meta user"} and store the token server-side.`
      : "Meta login is not connected yet, so Growth can only use manual planning data.",
    pageCount
      ? `${pageCount} Facebook Page asset(s) are ready for Page analysis.`
      : "Meta returned zero Facebook Pages. That is why audience, views, and engagement cannot honestly be called live Meta data yet.",
    instagramCount
      ? `${instagramCount} Instagram professional asset(s) are ready for Instagram analysis.`
      : "Instagram analytics are still gated: no linked professional Instagram account was returned with the current permissions.",
    `The manual baseline remains useful for planning, but it is now labeled as manual so it cannot be mistaken for live growth data.`,
    `Next unlock: get a Page/IG professional asset returned by Meta, then request the missing analytics and publishing permissions that the capability matrix marks as gated.`
  ];

  return {
    lastCompiledAt: new Date().toISOString(),
    status: "Compiled from live Meta OAuth signals, Social Cues account state, and clearly labeled manual baseline estimates.",
    summary: {
      liveMetaIdentity: Boolean(metaIdentity),
      metaDiscoveredRecords: discoveredCount,
      facebookPages: pageCount,
      instagramAssets: instagramCount,
      readyMetaLanes: readyMeta.length,
      totalMetaLanes: capabilityMatrix.length
    },
    metrics,
    sourceBreakdown,
    translatedAnalysis
  };
}

function respondGate(res, gate) {
  const nextActions = gate.id === "facebook_pages_publish"
    ? [
        "Add or request the pages_manage_posts permission in the Meta app dashboard.",
        "Prepare App Review evidence showing an explicit user-approved Page publishing workflow.",
        "After Meta approves the permission, reauthorize Social Cues so the connected Page token includes pages_manage_posts."
      ]
    : [];
  return json(res, 409, {
    ok: false,
    error: gate.status,
    useCase: gate,
    nextActions
  });
}

async function connectMetaAssets(model, code) {
  const token = await exchangeMetaCode(code);
  const user = await metaGraph("/me", { fields: "id,name,picture" }, token.accessToken);
  const now = new Date().toISOString();
  const metaUser = upsertConnectedAccount(model, {
    id: "acct-meta-user",
    platform: "meta",
    name: user.name || "Meta user",
    handle: user.name || "Meta user",
    status: "connected",
    connectedAt: now,
    oauthProvider: "meta",
    providerAccountId: user.id || null,
    scopes: metaScopes,
    credential: encryptedToken(token.accessToken),
    tokenType: token.tokenType,
    tokenExpiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null
  });

  const inspection = await inspectMetaConnection(model);
  const discovered = [metaUser, ...(inspection.assetSync?.synced || [])];

  model.integrations = model.integrations || {};
  model.integrations.meta = inspection.blockers.length ? `Logged in as ${user.name || "Meta user"} with ${inspection.blockers.length} blocker${inspection.blockers.length === 1 ? "" : "s"}` : `Logged in as ${user.name || "Meta user"}`;
  model.integrations.facebook = inspection.assetSync?.pagesReturned ? "Connected via Meta Pages API" : "No pages returned by current permissions";
  model.integrations.instagram = discovered.some(item => item.platform === "instagram") ? "Connected via linked Instagram business account" : "No linked Instagram business account returned";
  model.metaConnection = {
    ...(model.metaConnection || {}),
    connectedAt: now,
    userId: user.id || null,
    userName: user.name || "",
    scopes: inspection.permissions?.granted?.length ? inspection.permissions.granted : metaScopes,
    discoveredCount: discovered.length,
    pageCount: inspection.assetSync?.pagesReturned || 0,
    instagramCount: inspection.assetSync?.instagramReturned || 0,
    warning: inspection.assetSync?.error || inspection.permissions?.error || inspection.token?.error || null
  };
  hydrateMetaLoginStatus(model);
  return discovered;
}

function html(res, status, body) {
  return text(res, status, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Social Cues Meta Connection</title><style>body{font-family:Inter,Segoe UI,sans-serif;max-width:720px;margin:48px auto;padding:0 18px;line-height:1.5;background:#07090d;color:#f8fafc}a{color:#28d7ee}.box{border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:18px;background:#10131a}</style></head><body><div class="box">${body}</div></body></html>`, "text/html; charset=utf-8");
}

function privacyPolicyHtml() {
  return `
    <h1>Social Cues Privacy Policy</h1>
    <p><strong>Last updated:</strong> June 21, 2026</p>
    <p><strong>Website:</strong> <a href="${brandHomeUrl}">${brandDomain}</a></p>
    <p>Social Cues helps users plan, approve, schedule, and analyze social media campaigns. This policy explains what information Social Cues may collect and how it is used.</p>
    <h2>Information we collect</h2>
    <p>Social Cues may collect account connection details you choose to provide, campaign drafts, scheduled content, platform metadata, workspace settings, and basic usage or proof signals needed to operate the app.</p>
    <h2>Meta platform data</h2>
    <p>If you connect Facebook, Instagram, or Threads, Social Cues may request permissions needed to list connected assets, prepare publishing workflows, and support analytics or account status checks. Social Cues does not sell Meta platform data.</p>
    <h2>How we use information</h2>
    <p>Information is used to provide Social Cues features, maintain connected accounts, generate and queue approved content, improve campaign workflows, and support security, compliance, and troubleshooting.</p>
    <h2>Storage and security</h2>
    <p>Social Cues stores operational app data server-side. Access tokens and account identifiers should be stored only on the server or approved hosting environment, not in browser code.</p>
    <h2>Sharing</h2>
    <p>Social Cues only shares information with connected services when needed to perform actions you request, such as account connection, content publishing, or analytics retrieval.</p>
    <h2>Data deletion</h2>
    <p>You can disconnect accounts in Social Cues or request deletion of Meta-related data through Meta. Social Cues supports Meta's user data deletion callback and returns a confirmation code when a deletion request is received.</p>
    <h2>Contact</h2>
    <p>For privacy questions or deletion requests, contact Social Cues at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
  `;
}

function termsOfServiceHtml() {
  return `
    <h1>Social Cues Terms of Service</h1>
    <p><strong>Last updated:</strong> June 21, 2026</p>
    <p><strong>Website:</strong> <a href="${brandHomeUrl}">${brandDomain}</a></p>
    <p>Social Cues helps users plan, review, schedule, and analyze social media campaigns. By using Social Cues, you agree to use the service only for lawful, authorized, and platform-compliant social media workflows.</p>
    <h2>Approval-first use</h2>
    <p>Social Cues is designed to keep people in control. Content generated, queued, embedded, or prepared by the app should be reviewed and approved by an authorized user before publishing or external use.</p>
    <h2>Connected accounts</h2>
    <p>You may connect only accounts, Pages, profiles, shops, or other assets that you own or are authorized to manage. You are responsible for maintaining access, permissions, and compliance with each connected platform's terms.</p>
    <h2>Meta platform use</h2>
    <p>Facebook, Instagram, Threads, and oEmbed features are used only for the permitted purpose of the granted Meta permissions or features. Public embeds are for front-end views of public content. Publishing, insights, leads, ads, and business asset workflows require the correct assets, permissions, and user approval.</p>
    <h2>Prohibited use</h2>
    <p>You may not use Social Cues for spam, fake engagement, deceptive automation, unsupported claims, unauthorized scraping, impersonation, illegal content, or attempts to bypass platform limits or review requirements.</p>
    <h2>Data and security</h2>
    <p>Do not enter secrets, passwords, private tokens, or payment data into browser-visible fields unless the app explicitly asks for them through a secure backend flow. Social Cues stores provider token material server-side only.</p>
    <h2>Availability and changes</h2>
    <p>Social Cues is an evolving product. Features may change as provider APIs, app review requirements, and platform policies change.</p>
    <h2>Contact</h2>
    <p>For terms, access, or account questions, contact Social Cues at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
  `;
}

function metaRedirectUri() {
  return `${metaPublicAppUrl}/api/oauth/meta/callback`;
}

function metaDataDeletionUri() {
  return `${metaPublicAppUrl}/api/meta/data-deletion`;
}

function metaDataDeletionStatusUri(code) {
  return `${metaPublicAppUrl}/api/meta/data-deletion/status?code=${encodeURIComponent(code)}`;
}

function createOAuthState(model, provider, platform, extra = {}) {
  const state = Buffer.from(JSON.stringify({ provider, platform, nonce: uid("state") })).toString("base64url");
  model.oauthStates = (model.oauthStates || []).filter(item => Date.parse(item.expiresAt || "") > Date.now()).slice(-20);
  model.oauthStates.push({
    state,
    provider,
    platform,
    ...extra,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
  });
  return state;
}

function consumeOAuthState(model, provider, state) {
  const states = model.oauthStates || [];
  const index = states.findIndex(item => item.provider === provider && item.state === state);
  if (index < 0) return { ok: false, error: "OAuth state was not issued by this backend." };
  const [record] = states.splice(index, 1);
  if (Date.parse(record.expiresAt || "") < Date.now()) return { ok: false, error: "OAuth state expired. Start the connection again." };
  return { ok: true, record };
}

function metaOAuthUrl(platform = "meta", state = "") {
  const params = new URLSearchParams({
    client_id: metaAppId,
    redirect_uri: metaRedirectUri(),
    state: state || Buffer.from(JSON.stringify({ provider: "meta", platform, nonce: uid("state") })).toString("base64url"),
    scope: metaScopes.join(","),
    response_type: "code"
  });
  return `https://www.facebook.com/${metaApiVersion}/dialog/oauth?${params.toString()}`;
}

function threadsRedirectUri() {
  return `${publicAppUrl}/api/oauth/threads/callback`;
}

function xRedirectUri() {
  return `${xPublicAppUrl}/api/oauth/x/callback`;
}

function secureOAuthReady() {
  return metaPublicAppUrl.startsWith("https://");
}

function secureThreadsOAuthReady() {
  return publicAppUrl.startsWith("https://");
}

function secureXOAuthReady() {
  return xPublicAppUrl.startsWith("https://") || xPublicAppUrl.startsWith("http://127.0.0.1") || xPublicAppUrl.startsWith("http://localhost");
}

function oauthSecurityWarning() {
  if (secureOAuthReady()) return null;
  return "Meta OAuth requires an HTTPS callback for this flow. Set META_PUBLIC_APP_URL or PUBLIC_APP_URL to an HTTPS tunnel, hosted URL, or Supabase Edge Function URL, then add the matching callback URL in the Meta dashboard.";
}

function threadsSecurityWarning() {
  if (secureThreadsOAuthReady()) return null;
  return "Threads OAuth requires an HTTPS callback for this flow. Set PUBLIC_APP_URL to the HTTPS URL that serves /api/oauth/threads/callback, then add the matching callback URL in the Threads dashboard.";
}

function xSecurityWarning() {
  if (secureXOAuthReady()) return null;
  return "X OAuth requires an exact callback URL in the X Developer Console. Set X_PUBLIC_APP_URL or PUBLIC_APP_URL to the URL serving /api/oauth/x/callback, then add the matching callback in X user authentication settings.";
}

function codeVerifier() {
  return crypto.randomBytes(48).toString("base64url");
}

function codeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function threadsOAuthUrl(state = "") {
  const params = new URLSearchParams({
    client_id: threadsAppId,
    redirect_uri: threadsRedirectUri(),
    state: state || Buffer.from(JSON.stringify({ provider: "threads", platform: "threads", nonce: uid("state") })).toString("base64url"),
    scope: threadsScopes.join(","),
    response_type: "code"
  });
  return `https://threads.net/oauth/authorize?${params.toString()}`;
}

function xOAuthUrl(state = "", challenge = "") {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: xClientId,
    redirect_uri: xRedirectUri(),
    scope: xScopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  return `https://x.com/i/oauth2/authorize?${params.toString()}`;
}

function envPresent(name) {
  return Boolean(process.env[name]);
}

function useCaseStatus(item) {
  const envReady = item.env.every(envPresent);
  const oauthReady = item.id.startsWith("threads") ? Boolean(threadsAppId && threadsAppSecret) : Boolean(metaAppId && metaAppSecret);
  const state = envReady && oauthReady ? item.phase : "needs configuration";
  return {
    ...item,
    envReady,
    configured: envReady && oauthReady,
    missingEnv: item.env.filter(name => !envPresent(name))
  };
}

function platformCopy(platform, campaign, profile) {
  const brief = campaign.brief || "";
  const role = `${profile?.operator || "Founder"} mode for ${(profile?.outcome || campaign.goal || "growth").toLowerCase()}`;
  const templates = {
    tiktok: `POV: your social workflow stops feeling scattered.\n\n${brief}\n\nSocial Cues turns one idea into platform-native launch material, keeps approval in the loop, and learns from the result.\n\nComment CUES for the build-in-public version.`,
    instagram: `One campaign should not become six disconnected chores.\n\n${brief}\n\nSocial Cues helps shape the idea for each platform, keep the operator in control, and capture proof as the story grows.\n\nSave this for your next launch system.`,
    youtube: `Title: Building the AI Command Center Behind Social Cues\n\nShorts script:\nThe hard part is not having ideas. The hard part is turning ideas into a repeatable social machine.\n\n${brief}\n\nThis is Social Cues: ${role}.`,
    facebook: `Building something practical for creators and small businesses:\n\n${brief}\n\nThe point is not vanity growth. It is a cleaner system for creating, approving, publishing, and learning.`,
    x: `Building Social Cues in public.\n\n${brief}\n\nThe thesis: AI should adapt the work, but the human should approve the launch. ${role}.`,
    shopify: `Campaign context: ${brief}\n\nConnect product links, offers, UTM tags, and proof signals so social activity can connect back to business outcomes.`
  };
  return templates[platform.id] || `${brief}\n\nAdapted for ${platform.name}.`;
}

function claimFlags(textValue) {
  const lower = String(textValue || "").toLowerCase();
  return [
    ["guaranteed", "Guarantees need proof."],
    ["viral", "Frame as trend-informed, not guaranteed viral."],
    ["make $", "Income claims need substantiation."],
    ["risk-free", "Risk-free claims need review."],
    ["overnight", "Overnight growth claims are risky."]
  ].filter(([term]) => lower.includes(term)).map(([, flag]) => flag);
}

async function route(req, res) {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/" || url.pathname === "/app") {
    const html = await readFile(uiPath, "utf8");
    return text(res, 200, html, "text/html; charset=utf-8");
  }

  if (url.pathname === "/privacy" || url.pathname === "/privacy-policy") {
    return html(res, 200, privacyPolicyHtml());
  }

  if (url.pathname === "/terms" || url.pathname === "/terms-of-service") {
    return html(res, 200, termsOfServiceHtml());
  }

  if (url.pathname === "/manifest.webmanifest") {
    return text(res, 200, await readFile(manifestPath, "utf8"), "application/manifest+json; charset=utf-8");
  }

  if (url.pathname === "/sw.js") {
    return text(res, 200, await readFile(serviceWorkerPath, "utf8"), "application/javascript; charset=utf-8");
  }

  if (url.pathname === "/icon.svg") {
    return text(res, 200, await readFile(iconPath, "utf8"), "image/svg+xml; charset=utf-8");
  }

  if (url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      app: "Social Cues",
      mode: runtimeMode,
      port,
      persistence: lastPersistence,
      supabaseConfigured: supabaseEnabled
    });
  }

  if (url.pathname === "/api/oauth/meta/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(metaAppId && metaAppSecret),
      appIdPresent: Boolean(metaAppId),
      appSecretPresent: Boolean(metaAppSecret),
      apiVersion: metaApiVersion,
      redirectUri: metaRedirectUri(),
      dataDeletionUri: metaDataDeletionUri(),
      secureOAuthReady: secureOAuthReady(),
      warning: oauthSecurityWarning(),
      scopes: metaScopes
    });
  }

  if (url.pathname === "/api/oauth/threads/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(threadsAppId && threadsAppSecret),
      appIdPresent: Boolean(threadsAppId),
      appSecretPresent: Boolean(threadsAppSecret),
      redirectUri: threadsRedirectUri(),
      secureOAuthReady: secureThreadsOAuthReady(),
      warning: threadsSecurityWarning(),
      scopes: threadsScopes
    });
  }

  if (url.pathname === "/api/oauth/x/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(xClientId),
      clientIdPresent: Boolean(xClientId),
      clientSecretPresent: Boolean(xClientSecret),
      redirectUri: xRedirectUri(),
      secureOAuthReady: secureXOAuthReady(),
      warning: xSecurityWarning(),
      scopes: xScopes
    });
  }

  if (url.pathname === "/api/meta/use-cases" && req.method === "GET") {
    const model = await getModel();
    const cases = metaUseCases.map(useCaseStatus);
    return json(res, 200, {
      ok: true,
      configuredCount: cases.filter(item => item.configured).length,
      total: cases.length,
      metaConfigured: Boolean(metaAppId && metaAppSecret),
      threadsConfigured: Boolean(threadsAppId && threadsAppSecret),
      redirectUris: {
        meta: metaRedirectUri(),
        threads: threadsRedirectUri(),
        dataDeletion: metaDataDeletionUri()
      },
      secureOAuthReady: secureOAuthReady(),
      warning: oauthSecurityWarning(),
      capabilityMatrix: metaCapabilityMatrix(model),
      useCases: cases
    });
  }

  if (url.pathname === "/api/meta/capabilities" && req.method === "GET") {
    const model = await getModel();
    const capabilities = metaCapabilityMatrix(model);
    return json(res, 200, {
      ok: true,
      total: capabilities.length,
      ready: capabilities.filter(item => item.ready).length,
      capabilities
    });
  }

  if (url.pathname === "/api/meta/diagnostic-agent" && req.method === "GET") {
    const model = await getModel();
    return json(res, 200, metaDiagnosticAgent(model));
  }

  if (url.pathname === "/api/meta/data-deletion" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(metaAppSecret),
      callback: metaDataDeletionUri(),
      method: "POST",
      expects: "signed_request"
    });
  }

  if (url.pathname === "/api/meta/data-deletion" && req.method === "POST") {
    const contentType = req.headers["content-type"] || "";
    const raw = await bodyText(req);
    let signedRequest = "";
    if (contentType.includes("application/json")) {
      signedRequest = JSON.parse(raw || "{}").signed_request || "";
    } else {
      signedRequest = new URLSearchParams(raw).get("signed_request") || "";
    }

    let payload;
    try {
      payload = parseMetaSignedRequest(signedRequest);
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }

    const confirmationCode = uid("meta-delete");
    const model = await getModel();
    model.metaDeletionRequests = model.metaDeletionRequests || [];
    model.metaDeletionRequests.push({
      confirmationCode,
      userId: payload.user_id || payload.user?.id || null,
      issuedAt: payload.issued_at || null,
      receivedAt: new Date().toISOString()
    });

    if (Array.isArray(model.connectedAccounts)) {
      for (const account of model.connectedAccounts) {
        if (["meta", "facebook", "instagram"].includes(account.platform) || account.oauthProvider === "meta") {
          account.status = "deleted by user request";
          account.connectedAt = null;
          delete account.oauthProvider;
          delete account.oauthCode;
          delete account.accessToken;
          delete account.refreshToken;
          delete account.token;
          delete account.credential;
          delete account.refreshCredential;
          delete account.tokenType;
          delete account.tokenExpiresAt;
          delete account.providerAccountId;
          delete account.parentFacebookPageId;
          account.scopes = [];
          account.tokenDeletedAt = new Date().toISOString();
        }
      }
    }
    model.integrations = model.integrations || {};
    model.integrations.meta = "User data deletion callback received";
    await saveModel(model);

    return json(res, 200, {
      url: metaDataDeletionStatusUri(confirmationCode),
      confirmation_code: confirmationCode
    });
  }

  if (url.pathname === "/api/meta/data-deletion/status" && req.method === "GET") {
    const code = url.searchParams.get("code") || "";
    const model = await getModel();
    const request = (model.metaDeletionRequests || []).find(item => item.confirmationCode === code);
    if (!request) return json(res, 404, { ok: false, status: "not found" });
    return json(res, 200, {
      ok: true,
      status: "completed",
      confirmationCode: request.confirmationCode,
      receivedAt: request.receivedAt
    });
  }

  if (url.pathname === "/api/meta/webhook" && req.method === "GET") {
    const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || "";
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") || "";
    if (mode === "subscribe" && verifyToken && token === verifyToken) {
      return text(res, 200, challenge);
    }
    return json(res, 403, { ok: false, error: "Webhook verification failed or WEBHOOK_VERIFY_TOKEN is not configured." });
  }

  if (url.pathname === "/api/meta/webhook" && req.method === "POST") {
    const raw = await bodyText(req);
    const signature = String(req.headers["x-hub-signature-256"] || "").replace(/^sha256=/, "");
    const signingSecret = process.env.WEBHOOK_SIGNING_SECRET || metaAppSecret || "";
    if (!signingSecret) return json(res, 503, { ok: false, error: "WEBHOOK_SIGNING_SECRET or META_APP_SECRET is required before accepting Meta webhooks." });
    if (!signature) return json(res, 403, { ok: false, error: "Missing Meta webhook signature." });
    const expected = crypto.createHmac("sha256", signingSecret).update(raw).digest("hex");
    if (!timingSafeEqualText(signature, expected)) return json(res, 403, { ok: false, error: "Invalid webhook signature." });
    const payload = raw ? JSON.parse(raw) : {};
    const model = await getModel();
    model.metaWebhookEvents = model.metaWebhookEvents || [];
    model.metaWebhookEvents.unshift({ id: uid("meta-webhook"), receivedAt: new Date().toISOString(), payload });
    model.metaWebhookEvents = model.metaWebhookEvents.slice(0, 50);
    await saveModel(model);
    return json(res, 200, { ok: true, received: true });
  }

  if (url.pathname === "/api/oauth/threads/start" && req.method === "GET") {
    if (!secureThreadsOAuthReady()) {
      return html(res, 200, `<h1>HTTPS callback needed</h1><p>${threadsSecurityWarning()}</p><p>Current Threads callback:</p><p><code>${threadsRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!threadsAppId) {
      return html(res, 200, `<h1>Threads app id needed</h1><p>Add <code>THREADS_APP_ID</code> and <code>THREADS_APP_SECRET</code> to <code>outputs/Social Cues-testable-app/.env</code>, then restart Social Cues.</p><p>Use this redirect URI in Threads app settings:</p><p><code>${threadsRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const state = createOAuthState(model, "threads", "threads");
    await saveModel(model);
    res.writeHead(302, { Location: threadsOAuthUrl(state) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/threads/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    if (error) {
      return html(res, 200, `<h1>Threads connection stopped</h1><p>${error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!code) {
      return html(res, 200, `<h1>No Threads code received</h1><p>Threads did not return an authorization code.</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const stateCheck = consumeOAuthState(model, "threads", state);
    if (!stateCheck.ok) {
      await saveModel(model);
      return html(res, 400, `<h1>Threads OAuth state rejected</h1><p>${stateCheck.error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === "threads");
    if (!account) {
      account = { id: uid("acct"), platform: "threads", name: "Threads", handle: "", status: "not connected", connectedAt: null };
      model.connectedAccounts.push(account);
    }
    model.integrations = model.integrations || {};
    try {
      const token = await exchangeThreadsCode(code);
      account.status = "connected";
      account.handle = token.user?.username ? `@${token.user.username}` : token.user?.name || "Threads";
      account.name = token.user?.name || account.name || "Threads";
      account.connectedAt = new Date().toISOString();
      account.oauthProvider = "threads";
      account.providerAccountId = token.user?.id || null;
      account.scopes = threadsScopes;
      account.credential = encryptedToken(token.accessToken);
      account.tokenType = token.tokenType;
      account.tokenExpiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
      model.integrations.threads = "Threads connected and token stored";
    } catch (exchangeError) {
      account.status = "not connected";
      account.connectedAt = null;
      account.oauthProvider = "threads";
      account.connectionEvidence = `Threads token exchange failed: ${exchangeError.message}`;
      model.integrations.threads = account.connectionEvidence;
    }
    await saveModel(model);
    return html(res, 200, `<h1>Threads callback handled</h1><p>${model.integrations.threads}</p><p><a href="/app">Back to Social Cues</a></p>`);
  }

  if (url.pathname === "/api/oauth/x/start" && req.method === "GET") {
    if (!secureXOAuthReady()) {
      return html(res, 200, `<h1>X callback URL needed</h1><p>${xSecurityWarning()}</p><p>Current X callback:</p><p><code>${xRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!xClientId) {
      return html(res, 200, `<h1>X client id needed</h1><p>Add <code>X_CLIENT_ID</code> and, for confidential clients, <code>X_CLIENT_SECRET</code> to <code>.env</code>, then restart Social Cues.</p><p>Use this callback URL in X user authentication settings:</p><p><code>${xRedirectUri()}</code></p><p>Requested scopes: <code>${xScopes.join(" ")}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const verifier = codeVerifier();
    const state = createOAuthState(model, "x", "x", { codeVerifier: verifier });
    await saveModel(model);
    res.writeHead(302, { Location: xOAuthUrl(state, codeChallenge(verifier)) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/x/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    if (error) {
      return html(res, 200, `<h1>X connection stopped</h1><p>${error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!code) {
      return html(res, 200, `<h1>No X code received</h1><p>X did not return an authorization code.</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const stateCheck = consumeOAuthState(model, "x", state);
    if (!stateCheck.ok) {
      await saveModel(model);
      return html(res, 400, `<h1>X OAuth state rejected</h1><p>${stateCheck.error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === "x");
    if (!account) {
      account = { id: "acct-x", platform: "x", name: "X", handle: "", status: "not connected", connectedAt: null };
      model.connectedAccounts.push(account);
    }
    model.integrations = model.integrations || {};
    try {
      const token = await exchangeXCode(code, stateCheck.record.codeVerifier || "");
      account.status = "connected";
      account.handle = token.user?.username ? `@${token.user.username}` : token.user?.name || "X";
      account.name = token.user?.name || account.name || "X";
      account.connectedAt = new Date().toISOString();
      account.oauthProvider = "x";
      account.providerAccountId = token.user?.id || null;
      account.scopes = String(token.scope || "").split(/\s+/).filter(Boolean);
      account.credential = encryptedToken(token.accessToken);
      account.refreshCredential = token.refreshToken ? encryptedToken(token.refreshToken) : null;
      account.tokenType = token.tokenType;
      account.tokenExpiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
      model.integrations.x = "X connected and token stored";
    } catch (exchangeError) {
      account.status = "not connected";
      account.connectedAt = null;
      account.oauthProvider = "x";
      account.connectionEvidence = `X token exchange failed: ${exchangeError.message}`;
      model.integrations.x = account.connectionEvidence;
    }
    await saveModel(model);
    return html(res, 200, `<h1>X callback handled</h1><p>${model.integrations.x}</p><p><a href="/app">Back to Social Cues</a></p>`);
  }

  if (url.pathname === "/api/oauth/meta/start" && req.method === "GET") {
    const platform = url.searchParams.get("platform") || "meta";
    if (!secureOAuthReady()) {
      return html(res, 200, `<h1>HTTPS callback needed</h1><p>${oauthSecurityWarning()}</p><p>Current Meta callback:</p><p><code>${metaRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!metaAppId) {
      return html(res, 200, `<h1>Meta app id needed</h1><p>Add <code>META_APP_ID</code> and <code>META_APP_SECRET</code> to <code>outputs/Social Cues-testable-app/.env</code>, then restart Social Cues.</p><p>Use this redirect URI in Meta:</p><p><code>${metaRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const state = createOAuthState(model, "meta", platform);
    await saveModel(model);
    res.writeHead(302, { Location: metaOAuthUrl(platform, state) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/meta/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    if (error) {
      return html(res, 200, `<h1>Meta connection stopped</h1><p>${error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!code) {
      return html(res, 200, `<h1>No Meta code received</h1><p>Meta did not return an authorization code.</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const stateCheck = consumeOAuthState(model, "meta", state);
    if (!stateCheck.ok) {
      await saveModel(model);
      return html(res, 400, `<h1>Meta OAuth state rejected</h1><p>${stateCheck.error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    let connected = [];
    let exchangeError = null;
    if (metaAppSecret) {
      try {
        connected = await connectMetaAssets(model, code);
      } catch (error) {
        exchangeError = error;
      }
    }

    if (!connected.length) {
      model.integrations = model.integrations || {};
      model.integrations.meta = exchangeError ? `OAuth code received; token exchange failed: ${exchangeError.message}` : "OAuth code received; add app secret";
      model.metaConnection = {
        connectedAt: new Date().toISOString(),
        status: "oauth-code-only",
        error: exchangeError ? exchangeError.message : null,
        scopes: metaScopes
      };
    }
    await saveModel(model);
    if (connected.length) {
      const items = connected.map(account => `<li>${account.name} (${account.platform})</li>`).join("");
      return html(res, 200, `<h1>Meta connected</h1><p>Social Cues exchanged the authorization code, encrypted the token material, and stored the accounts it could discover from the granted permissions.</p><ul>${items}</ul><p><a href="/app">Back to Social Cues</a></p>`);
    }
    return html(res, 200, `<h1>Meta returned an authorization code</h1><p>Social Cues captured the callback but could not complete token exchange yet.</p><p>${exchangeError ? exchangeError.message : "Add the Meta app secret and retry."}</p><p><a href="/app">Back to Social Cues</a></p>`);
  }

  if (url.pathname === "/api/supabase/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: supabaseEnabled,
      persistence: lastPersistence,
      requiredEnv: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
    });
  }

  if (url.pathname === "/api/model" && req.method === "GET") {
    return json(res, 200, publicModel(await getModel()));
  }

  if (url.pathname === "/api/model" && req.method === "POST") {
    const existing = await getModel();
    const incoming = await bodyJson(req);
    const merged = mergePublicModelUpdate(incoming, existing);
    sanitizeConnectedAccounts(merged);
    return json(res, 200, publicModel(await saveModel(merged)));
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    model.currentUser = {
      id: input.id || "user-local",
      name: input.name || "Social Cues User",
      email: input.email || "user@local.test",
      role: "Owner",
      loggedInAt: new Date().toISOString()
    };
    if (input.workspaceName) model.workspace.name = input.workspaceName;
    await saveModel(model);
    return json(res, 200, { ok: true, user: model.currentUser, workspace: model.workspace });
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const model = await getModel();
    model.currentUser = null;
    await saveModel(model);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/generate/platform-variants" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    const campaign = input.campaign || model.campaigns?.find(item => item.id === model.activeCampaignId) || model.campaigns?.[0];
    const variants = platforms.map(platform => ({
      id: uid(platform.id),
      platform: platform.id,
      status: "draft",
      copy: platformCopy(platform, campaign, model.profile),
      tags: platform.tags,
      bestTime: platform.bestTime,
      fit: platform.fit,
      flags: claimFlags(campaign?.brief),
      generatedBy: "local-social-cues-engine",
      updatedAt: new Date().toISOString()
    }));
    return json(res, 200, {
      ok: true,
      provider: "local-social-cues-engine",
      promptVersion: "social-cues-local-v1",
      campaignId: campaign?.id,
      variants
    });
  }

  if (url.pathname === "/api/publish/social-cues/queue" && req.method === "POST") {
    const input = await bodyJson(req);
    return json(res, 200, {
      ok: true,
      provider: "social-cues-queue",
      status: "queued-review-only",
      queuedAt: new Date().toISOString(),
      scheduledFor: input.scheduledFor || new Date(Date.now() + 90 * 60 * 1000).toISOString(),
      mode: "reminder-or-native-publish",
      item: input.variant || input
    });
  }

  if (url.pathname === "/api/proof" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    model.proof = model.proof || [];
    model.proof.unshift({
      id: uid("proof"),
      type: input.type || "Growth win",
      metric: input.metric || "Unlabeled proof",
      note: input.note || "",
      createdAt: new Date().toISOString()
    });
    await saveModel(model);
    return json(res, 200, { ok: true, proof: model.proof[0] });
  }

  if (url.pathname === "/api/actions" && req.method === "GET") {
    const model = await getModel();
    return json(res, 200, { ok: true, actions: model.actions || [] });
  }

  if (url.pathname === "/api/actions" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    model.actions = model.actions || [];
    const action = {
      id: uid("act"),
      type: input.type || "Experiment",
      priority: input.priority || "Medium",
      status: input.status || "active",
      title: input.title || "Untitled action",
      signal: input.signal || "Signal not defined yet.",
      createdAt: new Date().toISOString()
    };
    model.actions.unshift(action);
    await saveModel(model);
    return json(res, 200, { ok: true, action });
  }

  if (url.pathname.startsWith("/api/actions/") && req.method === "POST") {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const input = await bodyJson(req);
    const model = await getModel();
    const action = (model.actions || []).find(item => item.id === id);
    if (!action) return json(res, 404, { ok: false, error: "Action not found" });
    action.status = input.status || action.status;
    action.updatedAt = new Date().toISOString();
    if (action.status === "won") {
      model.proof = model.proof || [];
      model.proof.unshift({
        id: uid("proof"),
        type: action.type,
        metric: action.title,
        note: action.signal,
        createdAt: new Date().toISOString()
      });
    }
    await saveModel(model);
    return json(res, 200, { ok: true, action });
  }

  if (url.pathname === "/api/integrations/readiness" && req.method === "GET") {
    const model = await getModel();
    return json(res, 200, {
      ok: true,
      readiness: model.integrations || {},
      envRequired: ["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "META_APP_ID", "META_APP_SECRET", "THREADS_APP_ID", "THREADS_APP_SECRET", "X_CLIENT_ID", "X_CLIENT_SECRET", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_ACCESS_TOKEN"]
    });
  }

  if (url.pathname === "/api/billing/checkout" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    model.billing = model.billing || {};
    model.billing.selectedPlan = input.selectedPlan || model.billing.selectedPlan || "Founder Audit - $99";
    model.billing.paymentLink = input.paymentLink || model.billing.paymentLink || "";
    model.billing.status = model.billing.paymentLink ? "Payment Link ready" : "Not configured";
    await saveModel(model);
    return json(res, 200, {
      ok: true,
      mode: model.billing.paymentLink ? "payment-link" : "stripe-not-configured",
      url: model.billing.paymentLink || null,
      message: model.billing.paymentLink ? "Open this Stripe Payment Link." : "Set STRIPE_SECRET_KEY and Stripe price IDs on the backend to create live Checkout Sessions."
    });
  }

  if (url.pathname === "/api/meta/assets" && req.method === "GET") {
    const model = await getModel();
    const accounts = realMetaAccounts(model).map(publicMetaAccount);
    return json(res, 200, {
      ok: true,
      metaConnection: model.metaConnection || null,
      metaHealth: publicMetaHealth(model.metaHealth),
      capabilities: metaCapabilityMatrix(model),
      accounts
    });
  }

  if (url.pathname === "/api/meta/health" && ["GET", "POST"].includes(req.method)) {
    const model = await getModel();
    const inspection = await inspectMetaConnection(model);
    model.metaHealth = inspection;
    model.analytics = buildGrowthAnalytics(model);
    await saveModel(model);
    return json(res, 200, {
      ok: true,
      metaConnection: model.metaConnection || null,
      health: publicMetaHealth(inspection),
      accounts: realMetaAccounts(model).map(publicMetaAccount),
      capabilities: inspection.capabilityMatrix || metaCapabilityMatrix(model),
      analytics: model.analytics
    });
  }

  if (url.pathname === "/api/meta/sync" && req.method === "POST") {
    const model = await getModel();
    const inspection = await inspectMetaConnection(model);
    model.metaHealth = inspection;
    await saveModel(model);
    return json(res, 200, {
      ok: true,
      health: publicMetaHealth(inspection),
      synced: (inspection.assetSync?.synced || []).map(publicMetaAccount),
      accounts: realMetaAccounts(model).map(publicMetaAccount),
      capabilities: inspection.capabilityMatrix || metaCapabilityMatrix(model)
    });
  }

  if (url.pathname === "/api/meta/pages" && req.method === "GET") {
    const model = await getModel();
    const gate = metaGate(model, "facebook_pages_connect", { platform: "facebook" });
    const pages = realMetaAccounts(model, "facebook").map(publicMetaAccount);
    return json(res, 200, { ok: true, ready: gate.ready, gate, pages });
  }

  if (url.pathname === "/api/meta/instagram/accounts" && req.method === "GET") {
    const model = await getModel();
    const accounts = realMetaAccounts(model, "instagram").map(publicMetaAccount);
    const gate = metaGate(model, "instagram_connect", { platform: "instagram" });
    return json(res, 200, { ok: true, ready: gate.ready, gate, accounts });
  }

  if (url.pathname === "/api/meta/insights/facebook" && req.method === "GET") {
    const model = await getModel();
    const gate = metaGate(model, "facebook_pages_insights", { platform: "facebook" });
    if (!gate.ready) return respondGate(res, gate);
    const page = realMetaAccounts(model, "facebook").find(account => account.providerAccountId && hasStoredToken(account));
    const token = tokenForMetaAccount(page);
    const metric = url.searchParams.get("metric") || "page_impressions,page_post_engagements";
    const period = url.searchParams.get("period") || "day";
    const body = await metaGraph(`/${page.providerAccountId}/insights`, { metric, period }, token);
    return json(res, 200, { ok: true, page: publicMetaAccount(page), insights: body.data || [] });
  }

  if (url.pathname === "/api/meta/insights/instagram" && req.method === "GET") {
    const model = await getModel();
    const gate = metaGate(model, "instagram_insights", { platform: "instagram" });
    if (!gate.ready) return respondGate(res, gate);
    const ig = realMetaAccounts(model, "instagram").find(account => account.providerAccountId && hasStoredToken(account));
    const token = tokenForMetaAccount(ig);
    const metric = url.searchParams.get("metric") || "reach,profile_views";
    const period = url.searchParams.get("period") || "day";
    const body = await metaGraph(`/${ig.providerAccountId}/insights`, { metric, period }, token);
    return json(res, 200, { ok: true, account: publicMetaAccount(ig), insights: body.data || [] });
  }

  if (url.pathname === "/api/meta/publish/facebook/readiness" && req.method === "GET") {
    const model = await getModel();
    const page = realMetaAccounts(model, "facebook").find(account => account.providerAccountId && hasStoredToken(account));
    const gate = metaGate(model, "facebook_pages_publish", { platform: "facebook" });
    const grantedScopes = Array.from(grantedMetaScopes(model));
    return json(res, 200, {
      ok: true,
      ready: gate.ready,
      gate,
      page: page ? publicMetaAccount(page) : null,
      requiredScope: "pages_manage_posts",
      scopeGranted: grantedScopes.includes("pages_manage_posts"),
      currentScopes: grantedScopes,
      nextActions: gate.ready ? [] : [
        "Keep pages_manage_posts out of the default login until Meta accepts it for this app; requesting it too early can break login.",
        "In Meta App Review, request pages_manage_posts for the Social Cues use case: user-approved publishing to the Facebook Page selected in the app.",
        "Show review evidence: connected Page selector, generated post draft, explicit approval control, dry-run preview, and no background/autonomous posting.",
        "After approval, add pages_manage_posts to the OAuth scope list and reauthorize the Facebook Page."
      ],
      reviewStatement: "Social Cues publishes only user-approved content to Facebook Pages the user manages. Publishing is previewed, gated by explicit approval, and disabled unless pages_manage_posts is granted."
    });
  }

  if (url.pathname === "/api/meta/publish/facebook" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    const gate = metaGate(model, "facebook_pages_publish", { platform: "facebook" });
    if (!gate.ready) return respondGate(res, gate);
    const page = realMetaAccounts(model, "facebook").find(account => account.providerAccountId && hasStoredToken(account));
    const message = input.message || input.copy || "";
    if (!message.trim()) return json(res, 400, { ok: false, error: "message is required" });
    if (input.dryRun !== false) {
      return json(res, 200, { ok: true, dryRun: true, page: publicMetaAccount(page), payload: { message } });
    }
    const response = await metaGraph(`/${page.providerAccountId}/feed`, { message }, tokenForMetaAccount(page), { method: "POST" });
    return json(res, 200, { ok: true, dryRun: false, page: publicMetaAccount(page), response });
  }

  if (url.pathname === "/api/meta/publish/instagram" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    const gate = metaGate(model, "instagram_publish", { platform: "instagram" });
    if (!gate.ready) return respondGate(res, gate);
    const ig = realMetaAccounts(model, "instagram").find(account => account.providerAccountId && hasStoredToken(account));
    if (!input.imageUrl) return json(res, 400, { ok: false, error: "imageUrl is required for Instagram publishing" });
    if (input.dryRun !== false) {
      return json(res, 200, { ok: true, dryRun: true, account: publicMetaAccount(ig), payload: { image_url: input.imageUrl, caption: input.caption || input.message || "" } });
    }
    const token = tokenForMetaAccount(ig);
    const container = await metaGraph(`/${ig.providerAccountId}/media`, { image_url: input.imageUrl, caption: input.caption || input.message || "" }, token, { method: "POST" });
    const publish = await metaGraph(`/${ig.providerAccountId}/media_publish`, { creation_id: container.id }, token, { method: "POST" });
    return json(res, 200, { ok: true, dryRun: false, account: publicMetaAccount(ig), container, publish });
  }

  if (url.pathname === "/api/meta/ads/report" && req.method === "GET") {
    const model = await getModel();
    const gate = metaGate(model, "ads_read");
    if (!gate.ready) return respondGate(res, gate);
    return json(res, 200, { ok: true, report: [], note: "ads_read approved; add ad account selection to pull insights." });
  }

  if (url.pathname === "/api/meta/ads/campaigns" && req.method === "POST") {
    const model = await getModel();
    const gate = metaGate(model, "ads_management");
    if (!gate.ready) return respondGate(res, gate);
    return json(res, 200, { ok: true, dryRun: true, note: "ads_management approved; campaign creation is gated behind explicit live-submit controls." });
  }

  if (url.pathname === "/api/meta/business/assets" && req.method === "GET") {
    const model = await getModel();
    const gate = metaGate(model, "business_management");
    if (!gate.ready) return respondGate(res, gate);
    const metaUser = metaAccounts(model, "meta").find(hasStoredToken);
    const businesses = await getMetaBusinesses(tokenForMetaAccount(metaUser));
    return json(res, 200, {
      ok: !businesses.error,
      gate,
      businesses,
      assets: realMetaAccounts(model).map(publicMetaAccount)
    });
  }

  if (url.pathname === "/api/meta/leads" && req.method === "GET") {
    const model = await getModel();
    const gate = metaGate(model, "lead_ads", { platform: "facebook" });
    if (!gate.ready) return respondGate(res, gate);
    return json(res, 200, { ok: true, leads: [], note: "leads_retrieval approved; add form selection to pull lead records." });
  }

  if (url.pathname === "/api/meta/oembed" && req.method === "GET") {
    const model = await getModel();
    const gate = metaGate(model, "oembed_read");
    const targetUrl = url.searchParams.get("url") || "";
    const kind = url.searchParams.get("kind") || "";
    if (!targetUrl) {
      return json(res, 200, {
        ok: true,
        gate,
        ready: gate.ready,
        allowedUsage: "Front-end views of public Facebook and Instagram pages, posts, and videos.",
        requiresOwnedPage: false,
        supportedKinds: ["instagram", "facebook_page", "facebook_post", "facebook_video"],
        queryExample: "/api/meta/oembed?kind=facebook_post&url=https%3A%2F%2Fwww.facebook.com%2F..."
      });
    }
    const target = metaOembedTarget(targetUrl, kind);
    if (!target.ok) return json(res, 400, { ok: false, gate, error: target.error });
    if (!gate.ready) return respondGate(res, gate);
    try {
      const embed = await metaGraph(target.endpoint, {
        url: target.url,
        omitscript: "true"
      }, appAccessToken());
      return json(res, 200, {
        ok: true,
        gate,
        kind: target.kind,
        sourceUrl: target.url,
        embed
      });
    } catch (error) {
      return json(res, 502, { ok: false, gate, kind: target.kind, sourceUrl: target.url, error: error.message });
    }
  }

  if (url.pathname === "/api/x/account" && req.method === "GET") {
    const model = await getModel();
    const account = (model.connectedAccounts || []).find(item => item.platform === "x");
    return json(res, 200, {
      ok: true,
      configured: Boolean(xClientId),
      redirectUri: xRedirectUri(),
      scopes: xScopes,
      account: account ? publicAccount(account) : null,
      ready: Boolean(account && isRealConnectedAccount(account))
    });
  }

  if (url.pathname === "/api/x/post" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    const account = (model.connectedAccounts || []).find(item => item.platform === "x" && isRealConnectedAccount(item));
    const textValue = String(input.text || input.message || "").trim().replace(/\s+/g, " ");
    if (!account) {
      return json(res, 409, {
        ok: false,
        error: "Connect X OAuth before Social Cues can publish to X.",
        connectRoute: "/api/oauth/x/start",
        requiredScopes: ["tweet.write", "users.read", "offline.access"]
      });
    }
    if (!textValue) return json(res, 400, { ok: false, error: "Post text is required." });
    if (input.live !== true) {
      return json(res, 200, {
        ok: true,
        dryRun: true,
        provider: "x",
        account: publicAccount(account),
        wouldPost: { text: textValue },
        liveSubmitRequires: "Send { live: true } after explicit user approval."
      });
    }
    const response = await xApi("/tweets", { text: textValue }, tokenForMetaAccount(account), { method: "POST" });
    return json(res, 200, { ok: true, provider: "x", response });
  }

  if (url.pathname === "/api/meta/fundraising/readiness" && req.method === "GET") {
    const model = await getModel();
    return json(res, 200, {
      ok: true,
      useCase: metaGate(model, "fundraising"),
      ready: false,
      requirements: ["Meta policy review", "region-specific donation compliance", "approved nonprofit/payment flow", "clear donor disclosure"]
    });
  }

  if (url.pathname === "/api/meta/commerce/signals" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    model.metaCommerceSignals = model.metaCommerceSignals || [];
    const signal = {
      id: uid("meta-commerce"),
      recordedAt: new Date().toISOString(),
      campaignId: input.campaignId || model.activeCampaignId || null,
      source: input.source || "Social Cues",
      event: input.event || "campaign_signal",
      value: input.value || null
    };
    model.metaCommerceSignals.unshift(signal);
    await saveModel(model);
    return json(res, 200, { ok: true, signal });
  }

  if (url.pathname === "/api/meta/review-pack" && req.method === "GET") {
    const model = await getModel();
    const health = model.metaHealth || null;
    return json(res, 200, {
      ok: true,
      app: "SCv2",
      brandDomain,
      brandHomeUrl,
      supportEmail,
      redirectUri: metaRedirectUri(),
      privacyPolicyUrl: `${metaPublicAppUrl}/privacy`,
      termsOfServiceUrl: `${metaPublicAppUrl}/terms`,
      dataDeletionUri: metaDataDeletionUri(),
      capabilities: metaCapabilityMatrix(model),
      healthSummary: health ? {
        checkedAt: health.checkedAt,
        tokenValid: Boolean(health.token?.valid),
        appIdMatches: Boolean(health.token?.appIdMatches),
        grantedScopes: health.permissions?.granted || [],
        pageCount: health.assetSync?.pagesReturned || 0,
        instagramCount: health.assetSync?.instagramReturned || 0,
        blockers: health.blockers || []
      } : null,
      statements: [
        "Users voluntarily connect Meta accounts through OAuth.",
        "Social Cues stores tokens server-side only and exposes only tokenStored booleans to the UI.",
        "Publishing endpoints require real provider assets, granted permissions, explicit user-approved content, and dry-run defaults unless live submission is requested.",
        "Users can request deletion through Meta's signed user data deletion callback.",
        "Permissions and assets not granted or returned by Meta are surfaced as gated capabilities, not silently used."
      ]
    });
  }

  if (url.pathname === "/api/accounts" && req.method === "GET") {
    const model = await getModel();
    return json(res, 200, { ok: true, accounts: visibleConnectedAccounts(model).map(publicAccount) });
  }

  if (url.pathname.startsWith("/api/accounts/") && req.method === "POST") {
    const platform = decodeURIComponent(url.pathname.split("/").pop());
    const input = await bodyJson(req);
    const model = await getModel();
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === platform);
    if (!account) {
      account = { id: uid("acct"), platform, name: platform, handle: "", status: "not connected", connectedAt: null };
      model.connectedAccounts.push(account);
    }
    if (input.status === "not connected" || input.disconnect === true) {
      account.status = "not connected";
      account.connectedAt = null;
      account.connectionEvidence = "disconnected by user";
      await saveModel(model);
      return json(res, 200, { ok: true, account: publicAccount(account) });
    }
    return json(res, 409, {
      ok: false,
      error: "Manual account connection disabled. Use the provider OAuth route so Social Cues stores real provider evidence.",
      platform,
      connectRoutes: {
        facebook: "/api/oauth/meta/start?platform=facebook",
        instagram: "/api/oauth/meta/start?platform=instagram",
        threads: "/api/oauth/threads/start",
        x: "/api/oauth/x/start"
      }
    });
  }

  if (url.pathname === "/api/analyze" && req.method === "POST") {
    const model = await getModel();
    model.analytics = buildGrowthAnalytics(model);
    await saveModel(model);
    return json(res, 200, { ok: true, analytics: model.analytics });
  }

  if (url.pathname === "/api/media/generate" && req.method === "POST") {
    const input = await bodyJson(req);
    const platform = platforms.find(item => item.id === input.platform) || platforms[0];
    return json(res, 200, {
      ok: true,
      provider: input.provider || "Social Cues",
      platform: platform.id,
      suggestion: `Create ${platform.fit.toLowerCase()} media for ${platform.name}: vertical, high-contrast, proof-led, with a clear first-frame hook.`,
      prompt: `Generate a ${platform.name} creative asset for this campaign: ${input.brief || ""}`
    });
  }

  if (url.pathname === "/api/export" && req.method === "GET") {
    return json(res, 200, publicModel(await getModel()));
  }

  return json(res, 404, { ok: false, error: "Not found", path: url.pathname });
}

await ensureModel();

export default async function handler(req, res) {
  return route(req, res).catch(error => {
    json(res, 500, { ok: false, error: error.message });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = http.createServer(handler);
  server.listen(port, host, () => {
    console.log(`Social Cues local test app running at http://127.0.0.1:${port}`);
    console.log("For phone access, open http://YOUR-COMPUTER-LAN-IP:" + port + " while on the same Wi-Fi.");
  });
}
