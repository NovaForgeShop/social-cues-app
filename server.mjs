import http from "node:http";
import crypto from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = process.env.SOCIAL_CUES_DATA_DIR || (process.env.VERCEL ? "/tmp/social-cues-data" : path.join(__dirname, "data"));
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
const faviconPngPath = path.join(__dirname, "favicon.png");
const appleTouchIconPath = path.join(__dirname, "apple-touch-icon.png");
const scIcon192Path = path.join(__dirname, "sc-icon-192.png");
const scIcon512Path = path.join(__dirname, "sc-icon-512.png");
const scIcon1024Path = path.join(__dirname, "sc-icon-1024.png");

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

const sentryDsn = process.env.SENTRY_DSN || "";
const sentryEnvironment = process.env.SENTRY_ENVIRONMENT || (process.env.VERCEL ? "production" : "development");
const sentryRelease = process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || "";
const sentryReleaseSource = process.env.SENTRY_RELEASE
  ? "explicit"
  : process.env.VERCEL_GIT_COMMIT_SHA
    ? "git-commit"
    : process.env.VERCEL_DEPLOYMENT_ID
      ? "vercel-deployment"
      : "unavailable";
const sentryDist = process.env.SENTRY_DIST || process.env.VERCEL_DEPLOYMENT_ID || "";
const sentryGithubRepository = process.env.SENTRY_GITHUB_REPOSITORY || "";
const sentrySourceContextEnabled = /^true$/i.test(process.env.SENTRY_SOURCE_CONTEXT_ENABLED || "");
const defaultSentryBrowserCdnUrl = "https://browser.sentry-cdn.com/10.66.0/bundle.min.js";
const configuredSentryBrowserCdnUrl = process.env.SENTRY_BROWSER_CDN_URL || defaultSentryBrowserCdnUrl;
const sentryBrowserCdnUrl = /^https:\/\/browser\.sentry-cdn\.com\//i.test(configuredSentryBrowserCdnUrl)
  ? configuredSentryBrowserCdnUrl
  : defaultSentryBrowserCdnUrl;
const configuredSentryTracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0);
const sentryTracesSampleRate = Number.isFinite(configuredSentryTracesSampleRate)
  ? Math.min(1, Math.max(0, configuredSentryTracesSampleRate))
  : 0;
let sentrySdk = null;
let sentryInitialized = false;

function safeSentryText(value, maxLength = 500) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:code|state|token|access_token|refresh_token|client_secret)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, maxLength);
}

function safeSentryPath(value) {
  try {
    return new URL(String(value || ""), "http://social-cues.invalid").pathname.slice(0, 240);
  } catch {
    return "";
  }
}

function captureSentryError(error, context = {}) {
  if (!sentrySdk) return false;
  try {
    sentrySdk.withScope(scope => {
      for (const [key, value] of Object.entries(context || {})) {
        if (value === undefined || value === null || value === "") continue;
        scope.setTag(`social_cues.${key}`, safeSentryText(value, 160));
      }
      sentrySdk.captureException(error instanceof Error ? error : new Error(safeSentryText(error)));
    });
    return true;
  } catch (captureError) {
    console.error(JSON.stringify({ type: "social-cues-sentry-capture-failed", error: safeSentryText(captureError?.message) }));
    return false;
  }
}

async function flushSentry(timeout = 1500) {
  if (!sentrySdk?.flush) return false;
  try {
    await sentrySdk.flush(timeout);
    return true;
  } catch {
    return false;
  }
}

async function initializeSentry() {
  if (!sentryDsn) return;
  try {
    sentrySdk = await import("@sentry/node");
    sentrySdk.init({
      dsn: sentryDsn,
      environment: sentryEnvironment,
      release: sentryRelease || undefined,
      dist: sentryDist || undefined,
      sendDefaultPii: false,
      tracesSampleRate: sentryTracesSampleRate
    });
    sentryInitialized = true;
  } catch (error) {
    sentrySdk = null;
    console.error(JSON.stringify({ type: "social-cues-sentry-init-failed", error: safeSentryText(error?.message) }));
  }
}

await initializeSentry();

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
const adminEmails = new Set(String(process.env.SOCIAL_CUES_ADMIN_EMAILS || "")
  .split(",")
  .map(value => value.trim().toLowerCase())
  .filter(Boolean));
const resendApiKey = process.env.RESEND_API_KEY || "";
const smtpHost = process.env.SMTP_HOST || process.env.SUPABASE_SMTP_HOST || (resendApiKey ? "smtp.resend.com" : "");
const smtpPort = process.env.SMTP_PORT || process.env.SUPABASE_SMTP_PORT || (resendApiKey ? "587" : "");
const smtpUser = process.env.SMTP_USER || process.env.SUPABASE_SMTP_USER || (resendApiKey ? "resend" : "");
const smtpPass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD || process.env.SUPABASE_SMTP_PASS || resendApiKey;
const smtpFrom = process.env.SMTP_FROM || process.env.SUPABASE_SMTP_FROM || supportEmail;
const smtpSenderName = process.env.SMTP_SENDER_NAME || process.env.SUPABASE_SMTP_SENDER_NAME || "Social Cues";
const supabaseSmtpApplied = /^(1|true|yes|applied)$/i.test(process.env.SUPABASE_SMTP_APPLIED || "");
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
const tiktokOAuthMode = /^(sandbox|test)$/i.test(process.env.TIKTOK_OAUTH_MODE || process.env.tiktok_oauth_mode || "") ? "sandbox" : "production";
const tiktokProductionPublicAppUrl = (process.env.TIKTOK_PUBLIC_APP_URL || process.env.tiktok_public_app_url || publicAppUrl).replace(/\/$/, "");
const tiktokSandboxPublicAppUrl = (process.env.TIKTOK_SANDBOX_PUBLIC_APP_URL || process.env.tiktok_sandbox_public_app_url || tiktokProductionPublicAppUrl).replace(/\/$/, "");
const tiktokProductionClientKey = process.env.TIKTOK_CLIENT_KEY || process.env.tiktok_client_key || process.env.TIKTOK_CLIENT_ID || process.env.tiktok_client_id || "";
const tiktokProductionClientSecret = process.env.TIKTOK_CLIENT_SECRET || process.env.tiktok_client_secret || "";
const tiktokSandboxClientKey = process.env.TIKTOK_SANDBOX_CLIENT_KEY || process.env.tiktok_sandbox_client_key || "";
const tiktokSandboxClientSecret = process.env.TIKTOK_SANDBOX_CLIENT_SECRET || process.env.tiktok_sandbox_client_secret || "";
const tiktokPublicAppUrl = tiktokOAuthMode === "sandbox" ? tiktokSandboxPublicAppUrl : tiktokProductionPublicAppUrl;
const tiktokClientKey = tiktokOAuthMode === "sandbox" ? tiktokSandboxClientKey : tiktokProductionClientKey;
const tiktokClientSecret = tiktokOAuthMode === "sandbox" ? tiktokSandboxClientSecret : tiktokProductionClientSecret;
const pinterestPublicAppUrl = (process.env.PINTEREST_PUBLIC_APP_URL || process.env.pinterest_public_app_url || publicAppUrl).replace(/\/$/, "");
const pinterestAppId = process.env.PINTEREST_APP_ID || process.env.pinterest_app_id || process.env.PINTEREST_CLIENT_ID || process.env.pinterest_client_id || "";
const pinterestAppSecret = process.env.PINTEREST_APP_SECRET || process.env.pinterest_app_secret || process.env.PINTEREST_CLIENT_SECRET || process.env.pinterest_client_secret || "";
const canvaPublicAppUrl = (process.env.CANVA_PUBLIC_APP_URL || publicAppUrl).replace(/\/$/, "");
const canvaClientId = process.env.CANVA_CLIENT_ID || "";
const canvaClientSecret = process.env.CANVA_CLIENT_SECRET || "";
const canvaAppId = process.env.CANVA_APP_ID || "";
const shopifyPublicAppUrl = (process.env.SHOPIFY_PUBLIC_APP_URL || publicAppUrl).replace(/\/$/, "");
const shopifyClientId = process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY || "";
const shopifyClientSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || "";
const shopifyShopDomain = process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN || "";
const etsyPublicAppUrl = (process.env.ETSY_PUBLIC_APP_URL || process.env.etsy_public_app_url || publicAppUrl).replace(/\/$/, "");
const etsyClientId = process.env.ETSY_CLIENT_ID || process.env.etsy_client_id || process.env.ETSY_KEYSTRING || process.env.etsy_keystring || "";
const etsyClientSecret = process.env.ETSY_CLIENT_SECRET || process.env.etsy_client_secret || process.env.ETSY_SHARED_SECRET || process.env.etsy_shared_secret || "";
const linkedInPublicAppUrl = (process.env.LINKEDIN_PUBLIC_APP_URL || publicAppUrl).replace(/\/$/, "");
const linkedInClientId = process.env.LINKEDIN_CLIENT_ID || "";
const linkedInClientSecret = process.env.LINKEDIN_CLIENT_SECRET || "";
const twitchPublicAppUrl = (process.env.TWITCH_PUBLIC_APP_URL || process.env.twitch_public_app_url || publicAppUrl).replace(/\/$/, "");
const twitchClientId = process.env.TWITCH_CLIENT_ID || process.env.twitch_client_id || "";
const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET || process.env.twitch_client_secret || "";
const googlePublicAppUrl = (process.env.GOOGLE_PUBLIC_APP_URL || process.env.google_public_app_url || process.env.YOUTUBE_PUBLIC_APP_URL || process.env.youtube_public_app_url || publicAppUrl).replace(/\/$/, "");
const googleClientId = process.env.GOOGLE_CLIENT_ID || process.env.google_client_id || process.env.YOUTUBE_CLIENT_ID || process.env.youtube_client_id || "";
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.google_client_secret || process.env.YOUTUBE_CLIENT_SECRET || process.env.youtube_client_secret || "";
const youtubeKnownChannelId = process.env.YOUTUBE_CHANNEL_ID || process.env.youtube_channel_id || "UC-hAyPwzwXBGTyK7nsmfcJA";
const googleAdsDeveloperToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
const googleAdsCustomerId = process.env.GOOGLE_ADS_CUSTOMER_ID || "";
const googleBusinessAccountId = process.env.GOOGLE_BUSINESS_ACCOUNT_ID || "";
const googleBusinessLocationId = process.env.GOOGLE_BUSINESS_LOCATION_ID || "";
const googleSearchConsoleSiteUrl = process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL || brandHomeUrl;
const googleAnalyticsPropertyId = process.env.GOOGLE_ANALYTICS_PROPERTY_ID || "";
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const openaiProjectId = process.env.OPENAI_PROJECT_ID || "";
const openaiOrgId = process.env.OPENAI_ORG_ID || "";
const openaiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const openaiImageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const openaiVideoModel = process.env.OPENAI_VIDEO_MODEL || "";
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const stripePriceFounderAudit = process.env.STRIPE_PRICE_FOUNDER_AUDIT || "";
const stripePriceCampaignBuild = process.env.STRIPE_PRICE_CAMPAIGN_BUILD || "";
const stripePriceProMonthly = process.env.STRIPE_PRICE_PRO_MONTHLY || "";
const discordPublicAppUrl = (process.env.DISCORD_PUBLIC_APP_URL || publicAppUrl).replace(/\/$/, "");
const discordClientId = process.env.DISCORD_CLIENT_ID || "";
const discordClientSecret = process.env.DISCORD_CLIENT_SECRET || "";
const discordBotToken = process.env.DISCORD_BOT_TOKEN || "";
const discordGuildId = process.env.DISCORD_GUILD_ID || "";
const discordAnnouncementChannelId = process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID || "";
const mediaEditorProvider = process.env.MEDIA_EDITOR_PROVIDER || "openai";
const mediaStorageProvider = process.env.MEDIA_STORAGE_PROVIDER || "supabase-storage";
const mediaMaxUploadMb = Number(process.env.MEDIA_MAX_UPLOAD_MB || 250);
const mediaCameraCaptureEnabled = process.env.MEDIA_CAMERA_CAPTURE_ENABLED !== "false";
const mediaMicCaptureEnabled = process.env.MEDIA_MIC_CAPTURE_ENABLED !== "false";
const vercelBlobToken = process.env.VERCEL_BLOB_READ_WRITE_TOKEN || "";
const authProvider = process.env.AUTH_PROVIDER || (supabaseEnabled ? "supabase" : "alpha-local");
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
const mediaStorageBucket = process.env.MEDIA_STORAGE_BUCKET || "social-cues-media";
const maxJsonBodyBytes = Number(process.env.MAX_JSON_BODY_BYTES || 1024 * 1024);
const authSessionSecret = process.env.AUTH_SESSION_SECRET || process.env.OAUTH_TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64url");
const publicSignupEnabled = /^(1|true|yes)$/i.test(process.env.SOCIAL_CUES_PUBLIC_SIGNUP_ENABLED || "");
const requestSecurityContext = new AsyncLocalStorage();
const requestRateBuckets = new Map();
let lastPersistence = { driver: supabaseEnabled ? "supabase" : "local-json", ok: true, message: "ready" };

const promoCodeRecords = String(process.env.SOCIAL_CUES_PROMO_CODE_HASHES || "")
  .split(",")
  .map(value => value.trim().toLowerCase())
  .filter(value => /^[a-f0-9]{64}$/.test(value))
  .map((hash, index) => ({
    id: `tester-${index + 1}`,
    hash,
    label: `Test account ${index + 1}`,
    access: "highest-tier-test",
    days: 120,
    active: true
  }));

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

const tiktokScopes = (process.env.TIKTOK_OAUTH_SCOPES || process.env.tiktok_oauth_scopes || "user.info.basic").split(",").map(scope => scope.trim()).filter(Boolean);
const tiktokFutureScopes = [
  "user.info.profile",
  "user.info.stats",
  "video.list",
  "video.upload",
  "video.publish"
];

const pinterestScopes = [
  "user_accounts:read",
  "boards:read",
  "boards:write",
  "pins:read",
  "pins:write",
  "ads:read"
];

const canvaScopes = [
  "asset:read",
  "asset:write",
  "design:meta:read",
  "design:content:read",
  "folder:read",
  "folder:write",
  "comment:read",
  "comment:write"
];

const shopifyScopes = [
  "read_products",
  "read_marketing_events",
  "write_marketing_events"
];

const etsyScopes = [
  "shops_r",
  "listings_r",
  "listings_w",
  "email_r"
];

const linkedInScopes = [
  "openid",
  "profile",
  "email"
];

const linkedInFutureScopes = [
  "w_member_social"
];

const twitchScopes = [
  "user:read:email",
  "channel:read:subscriptions",
  "analytics:read:games",
  "clips:edit"
];

const youtubeScopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/yt-analytics.readonly"
];

const googleGrowthApis = [
  {
    id: "youtube_data",
    name: "YouTube Data API v3",
    fit: "Channel identity, videos, comments where scopes allow, private-first uploads.",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    scopes: ["youtube.readonly", "youtube.upload"],
    status: "wired"
  },
  {
    id: "youtube_analytics",
    name: "YouTube Analytics API",
    fit: "Views, watch time, retention-adjacent summaries, subscriber movement.",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    scopes: ["yt-analytics.readonly"],
    status: "wired"
  },
  {
    id: "google_business_profile",
    name: "Google Business Profile APIs",
    fit: "Local profile posts, offers/events, media, reviews, and location trust signals.",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_BUSINESS_ACCOUNT_ID", "GOOGLE_BUSINESS_LOCATION_ID"],
    scopes: ["business.manage"],
    status: "ready-to-wire"
  },
  {
    id: "google_ads",
    name: "Google Ads API",
    fit: "Campaign/ad group reporting, recommendations, keyword ideas, conversion feedback, and campaign management after developer-token approval.",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID"],
    scopes: ["adwords"],
    status: "ready-to-wire"
  },
  {
    id: "search_console",
    name: "Search Console API",
    fit: "Search demand, landing page query performance, SEO feedback loop.",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_SEARCH_CONSOLE_SITE_URL"],
    scopes: ["webmasters.readonly"],
    status: "planned"
  },
  {
    id: "google_analytics",
    name: "Google Analytics Data API",
    fit: "Landing page/session/conversion feedback once the site property exists.",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ANALYTICS_PROPERTY_ID"],
    scopes: ["analytics.readonly"],
    status: "planned"
  },
  {
    id: "drive_assets",
    name: "Google Drive API",
    fit: "Store/share generated media kits, profile kits, and homepage launch docs.",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    scopes: ["drive.file"],
    status: "planned"
  },
  {
    id: "people_api",
    name: "Google People API",
    fit: "Optional identity/contact context for authenticated workspace users, not public social posting.",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    scopes: ["userinfo.profile"],
    status: "optional"
  }
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
  { id: "x", name: "X", fit: "Signal and conversation", bestTime: "9:05 AM", tags: ["#buildinpublic", "#AI", "#SaaS"] }
];

const apiBacklog = [
  { id: "pinterest", name: "Pinterest", fit: "Discovery, boards, evergreen campaign pins, and visual campaign analytics.", status: "developer-app-pending" },
  { id: "canva", name: "Canva Connect", fit: "Brand templates, design imports, assets, exports, comments, folders, and campaign-ready creative handoff.", status: "developer-integration-pending" },
  { id: "shopify", name: "Shopify", fit: "Commerce attribution, product links, offers, and conversion feedback.", status: "partner-account-open" },
  { id: "etsy", name: "Etsy", fit: "Shop/listing signal, marketplace product context, handmade commerce campaign feedback.", status: "developer-portal-open" },
  { id: "twitch", name: "Twitch", fit: "Creator/community signals, live campaign moments, clips, and audience feedback loops.", status: "developer-console-open" },
  { id: "linkedin", name: "LinkedIn", fit: "Founder/company thought leadership after product approval and brand/IP footing.", status: "approval-gated-corner" },
  { id: "snapchat", name: "Snapchat", fit: "Camera-native short-form/social discovery after app review and brand/IP footing.", status: "approval-gated-corner" }
];

const hiddenAccountPlaceholderPlatforms = new Set(["buffer", "linkedin", "sora", "discord"]);

const coreServiceStack = [
  {
    id: "openai",
    name: "OpenAI",
    purpose: "Generation, scoring, image prompts, AI editor planning, and translated growth analysis.",
    env: ["OPENAI_API_KEY"],
    optionalEnv: ["OPENAI_PROJECT_ID", "OPENAI_ORG_ID", "OPENAI_MODEL", "OPENAI_IMAGE_MODEL", "OPENAI_VIDEO_MODEL"],
    configured: () => Boolean(openaiApiKey),
    firstUse: "/api/media/editor/readiness and server-side generation routes"
  },
  {
    id: "stripe",
    name: "Stripe",
    purpose: "Payment Links first, then Checkout/subscriptions and webhooks for paid workspaces.",
    env: ["STRIPE_SECRET_KEY"],
    optionalEnv: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_FOUNDER_AUDIT", "STRIPE_PRICE_CAMPAIGN_BUILD", "STRIPE_PRICE_PRO_MONTHLY"],
    configured: () => Boolean(stripeSecretKey || stripePublishableKey),
    firstUse: "/api/billing/readiness and /api/billing/checkout"
  },
  {
    id: "discord",
    name: "Discord",
    purpose: "Community announcements, support/customer server, and optional campaign status notifications.",
    env: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"],
    optionalEnv: ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_ANNOUNCEMENT_CHANNEL_ID"],
    configured: () => Boolean(discordClientId && discordClientSecret),
    firstUse: "/api/discord/readiness"
  },
  {
    id: "resend",
    name: "Resend",
    purpose: "Production signup email, account verification, recovery, alerts, and campaign notification delivery.",
    env: ["RESEND_API_KEY"],
    optionalEnv: ["SMTP_FROM", "SMTP_SENDER_NAME"],
    configured: () => Boolean(resendApiKey),
    firstUse: "/api/resend/readiness and Supabase Auth custom SMTP"
  },
  {
    id: "media_editor",
    name: "AI editor",
    purpose: "Raw user video/image intake, platform-safe edit plans, captions/tags, and per-platform cut sheets.",
    env: ["OPENAI_API_KEY", "SUPABASE_URL"],
    optionalEnv: ["VERCEL_BLOB_READ_WRITE_TOKEN", "MEDIA_STORAGE_BUCKET", "MEDIA_EDITOR_PROVIDER", "MEDIA_STORAGE_PROVIDER", "MEDIA_MAX_UPLOAD_MB", "MEDIA_CAMERA_CAPTURE_ENABLED", "MEDIA_MIC_CAPTURE_ENABLED"],
    configured: () => Boolean(openaiApiKey && mediaStorageReady()),
    firstUse: "/api/media/editor/readiness and /api/media/editor/plan"
  }
];

const providerServiceStack = [
  {
    id: "meta",
    name: "Meta",
    purpose: "Facebook Pages, Instagram, Threads, oEmbed, comments, insights, and approved publishing workflows.",
    env: ["META_APP_ID", "META_APP_SECRET"],
    optionalEnv: ["THREADS_APP_ID", "THREADS_APP_SECRET", "WEBHOOK_VERIFY_TOKEN", "WEBHOOK_SIGNING_SECRET"],
    configured: () => Boolean(metaAppId && metaAppSecret),
    firstUse: "/api/oauth/meta/status, /api/meta/assets, and /api/meta/health"
  },
  {
    id: "x",
    name: "X",
    purpose: "Profile/account signal, approved post drafts, publishing, and response monitoring where the X plan allows it.",
    env: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
    optionalEnv: ["X_BEARER_TOKEN"],
    configured: () => Boolean(xClientId && xClientSecret),
    firstUse: "/api/oauth/x/status and /api/x/account"
  },
  {
    id: "tiktok",
    name: "TikTok",
    purpose: "Creator profile signal, upload/direct-post jobs after scope approval, and publish status tracking.",
    env: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
    optionalEnv: [],
    configured: () => Boolean(tiktokClientKey && tiktokClientSecret),
    firstUse: "/api/oauth/tiktok/status and /api/tiktok/account"
  },
  {
    id: "youtube",
    name: "YouTube",
    purpose: "Channel signal, analytics, reporting, private-first upload preparation, and user reminders before posting.",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    optionalEnv: ["YOUTUBE_CHANNEL_ID"],
    configured: () => Boolean(googleClientId && googleClientSecret),
    firstUse: "/api/youtube/readiness and /api/youtube/account"
  },
  {
    id: "google_growth",
    name: "Google Growth Suite",
    purpose: "Combined Google lane for YouTube, Business Profile, Ads, Search Console, Analytics, and Drive-backed launch/profile kits.",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    optionalEnv: ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_BUSINESS_ACCOUNT_ID", "GOOGLE_BUSINESS_LOCATION_ID", "GOOGLE_SEARCH_CONSOLE_SITE_URL", "GOOGLE_ANALYTICS_PROPERTY_ID"],
    configured: () => Boolean(googleClientId && googleClientSecret),
    firstUse: "/api/google/growth-suite"
  },
  {
    id: "google_business",
    name: "Google Business Profile",
    purpose: "Local/profile posts, offers, location media, review monitoring, and business profile feedback.",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    optionalEnv: ["GOOGLE_BUSINESS_ACCOUNT_ID", "GOOGLE_BUSINESS_LOCATION_ID"],
    configured: () => Boolean(googleClientId && googleClientSecret && googleBusinessAccountId && googleBusinessLocationId),
    firstUse: "/api/google/business/readiness"
  },
  {
    id: "pinterest",
    name: "Pinterest",
    purpose: "Boards, campaign Pins, visual discovery analytics, evergreen social content, and ads read when approved.",
    env: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"],
    optionalEnv: [],
    configured: () => Boolean(pinterestAppId && pinterestAppSecret),
    firstUse: "/api/pinterest/readiness"
  },
  {
    id: "canva",
    name: "Canva Connect",
    purpose: "Brand assets, design metadata, imports, exports, comments, folders, and campaign creative handoff.",
    env: ["CANVA_CLIENT_ID", "CANVA_CLIENT_SECRET"],
    optionalEnv: ["CANVA_APP_ID"],
    configured: () => Boolean(canvaClientId && canvaClientSecret),
    firstUse: "/api/canva/readiness"
  },
  {
    id: "shopify",
    name: "Shopify",
    purpose: "Storefront product context, offers, marketing events, conversion signal, and commerce campaign attribution.",
    env: ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"],
    optionalEnv: ["SHOPIFY_SHOP_DOMAIN"],
    configured: () => Boolean(shopifyClientId && shopifyClientSecret),
    firstUse: "/api/oauth/shopify/status"
  },
  {
    id: "etsy",
    name: "Etsy",
    purpose: "Shop and listing context for maker commerce campaigns, marketplace signal, and product-led content.",
    env: ["ETSY_CLIENT_ID", "ETSY_CLIENT_SECRET"],
    optionalEnv: [],
    configured: () => Boolean(etsyClientId && etsyClientSecret),
    firstUse: "/api/etsy/readiness"
  },
  {
    id: "twitch",
    name: "Twitch",
    purpose: "Creator community signal, livestream moments, clips, channel metadata, and audience feedback loops.",
    env: ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"],
    optionalEnv: [],
    configured: () => Boolean(twitchClientId && twitchClientSecret),
    firstUse: "/api/twitch/readiness"
  }
];

function publicServiceReadiness() {
  const serviceStatus = service => {
    const missingEnv = service.env.filter(name => !envPresent(name));
    const optionalMissingEnv = (service.optionalEnv || []).filter(name => !envPresent(name));
    return {
      id: service.id,
      name: service.name,
      purpose: service.purpose,
      configured: Boolean(service.configured()),
      ready: missingEnv.length === 0 && Boolean(service.configured()),
      missingEnv,
      optionalMissingEnv,
      firstUse: service.firstUse
    };
  };
  return [...coreServiceStack, ...providerServiceStack].map(serviceStatus);
}

function publicIntegrationReadiness(integrations = {}) {
  const safe = { ...(integrations || {}) };
  for (const key of ["sora"]) delete safe[key];
  safe.openai = openaiApiKey ? "Connected in backend" : safe.openai || "Needed";
  safe.stripe = stripeSecretKey || stripePublishableKey ? "Stripe Checkout ready" : safe.stripe || "Needed";
  safe.discord = discordClientId && discordClientSecret ? "Connected in backend" : safe.discord || "Needed";
  safe.mediaEditor = mediaEditorReadiness().ready ? "Server pipeline ready" : safe.mediaEditor || "Needed";
  safe.resend = resendApiKey ? "SMTP/email key present" : safe.resend || "Needed for signup email";
  safe.publishingQueue = safe.publishingQueue || "Supabase queue ready";
  safe.publishingPath = safe.publishingPath || "Social Cues Queue first";
  safe.shopify = shopifyClientId && shopifyClientSecret ? "Developer credentials present" : "Partner app setup pending";
  safe.etsy = etsyClientId ? "Developer key present" : "Developer app setup pending";
  safe.linkedin = "Approval-gated backlog";
  safe.twitch = twitchClientId && twitchClientSecret ? "Developer credentials present" : "Developer app setup pending";
  safe.pinterest = pinterestAppId && pinterestAppSecret ? (safe.pinterest || "OAuth credentials ready") : "Developer app pending";
  safe.canva = canvaClientId && canvaClientSecret ? (safe.canva || "OAuth credentials ready") : canvaAppId ? "Canva app shell created; Connect OAuth pending" : "Developer integration pending";
  return safe;
}

function discordRedirectUri() {
  return `${discordPublicAppUrl}/api/oauth/discord/callback`;
}

function mediaEditorReadiness() {
  const formats = platforms
    .filter(item => ["tiktok", "instagram", "youtube", "facebook", "x", "threads"].includes(item.id))
    .map(item => ({
      platform: item.id,
      name: item.name,
      output: item.id === "youtube" ? "16:9 or Shorts cut plus title/description/chapters" : "vertical short-form cut with captions, tags, CTA, and safe-area framing"
    }));
  return {
    provider: mediaEditorProvider,
    storage: mediaStorageProvider,
    maxUploadMb: mediaMaxUploadMb,
    cameraCaptureEnabled: mediaCameraCaptureEnabled,
    micCaptureEnabled: mediaMicCaptureEnabled,
    configured: Boolean(openaiApiKey),
    storageReady: mediaStorageReady(),
    ready: Boolean(openaiApiKey && mediaStorageReady()),
    models: {
      text: openaiModel,
      image: openaiImageModel,
      video: openaiVideoModel || "provider gated"
    },
    warnings: [
      "Raw media upload and AI editing should run server-side because files are large, expensive, and may contain private client footage.",
      "Camera and microphone access must be user-initiated in the browser and never auto-enabled.",
      "Live rendering/export needs object storage plus a job queue before it should be exposed to paying users."
    ],
    outputs: formats
  };
}

function mediaStorageReady() {
  if (mediaStorageProvider === "supabase-storage") return Boolean(supabaseUrl && supabaseServiceKey);
  if (mediaStorageProvider === "vercel-blob") return Boolean(vercelBlobToken);
  return mediaStorageProvider === "local";
}

function missingSupabaseServiceEnv() {
  if (supabaseServiceKey) return [];
  return ["SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY"];
}

function missingSupabasePublicAuthEnv() {
  if (supabaseAnonKey) return [];
  return ["SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY"];
}

function supabaseProjectRef() {
  try {
    return new URL(supabaseUrl).host.split(".")[0] || "_";
  } catch {
    return "_";
  }
}

function authSmtpReadiness() {
  const checks = [
    ["SMTP_HOST", smtpHost],
    ["SMTP_PORT", smtpPort],
    ["SMTP_USER", smtpUser],
    ["SMTP_PASS", smtpPass],
    ["SMTP_FROM", smtpFrom]
  ];
  const missingEnv = checks.filter(([, value]) => !value).map(([name]) => name);
  return {
    ready: missingEnv.length === 0,
    configuredAppEnv: missingEnv.length === 0,
    provider: resendApiKey ? "resend" : smtpHost ? smtpHost.replace(/^smtp\./i, "").split(":")[0] : "not configured",
    from: smtpFrom,
    senderName: smtpSenderName,
    missingEnv,
    resendReady: Boolean(resendApiKey),
    supabaseDashboardApplied: supabaseSmtpApplied,
    inferredFromResend: Boolean(resendApiKey && !process.env.SMTP_HOST && !process.env.SUPABASE_SMTP_HOST),
    supabaseDashboardPath: `https://supabase.com/dashboard/project/${supabaseProjectRef()}/auth/smtp`,
    note: supabaseSmtpApplied
      ? "Supabase Auth custom SMTP is applied in the dashboard. Production signup confirmations now use the configured SMTP sender."
      : "Supabase Auth custom SMTP must be saved in the Supabase dashboard or Management API. Vercel env vars can document readiness, but they do not configure Supabase Auth by themselves."
  };
}

function resendReadiness() {
  const smtp = authSmtpReadiness();
  return {
    ready: Boolean(resendApiKey),
    configured: Boolean(resendApiKey),
    apiKeyPresent: Boolean(resendApiKey),
    from: smtpFrom,
    senderName: smtpSenderName,
    smtp: {
      host: smtpHost || "smtp.resend.com",
      port: smtpPort || "587",
      user: smtpUser || "resend",
      passFrom: resendApiKey ? "RESEND_API_KEY" : smtpPass ? "SMTP_PASS" : "not configured",
      supabaseReadyToApply: smtp.ready,
      supabaseDashboardApplied: supabaseSmtpApplied
    },
    allowedUse: ["Supabase Auth signup confirmation", "password recovery", "device/login alerts", "campaign approval reminders", "delivery webhooks later"],
    missingEnv: ["RESEND_API_KEY"].filter(name => !envPresent(name)),
    optionalMissingEnv: ["SMTP_FROM", "SMTP_SENDER_NAME"].filter(name => !envPresent(name)),
    nextStep: resendApiKey && supabaseSmtpApplied
      ? "Production email is ready. Keep monitoring delivery, then add password recovery and login alert templates."
      : resendApiKey
      ? "Apply these SMTP settings in Supabase Auth custom SMTP, then run a real signup confirmation test."
      : "Create a Resend API key and add RESEND_API_KEY to Vercel and local .env."
  };
}

function sanitizeStorageName(value = "asset") {
  return String(value || "asset")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "asset";
}

function mediaStoragePath({ userId = "anonymous", fileName = "asset", kind = "media" } = {}) {
  return `${sanitizeStorageName(userId)}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${sanitizeStorageName(kind)}-${sanitizeStorageName(fileName)}`;
}

function stripePriceForPlan(plan = "") {
  const normalized = String(plan).toLowerCase();
  if (normalized.includes("campaign")) return stripePriceCampaignBuild;
  if (normalized.includes("pro")) return stripePriceProMonthly;
  return stripePriceFounderAudit;
}

async function createStripeCheckoutSession({ selectedPlan, successUrl, cancelUrl, customerEmail = "", userId = "" }) {
  const price = stripePriceForPlan(selectedPlan);
  if (!stripeSecretKey || !price) return null;
  const mode = selectedPlan && selectedPlan.toLowerCase().includes("pro") ? "subscription" : "payment";
  const body = new URLSearchParams({
    mode,
    success_url: successUrl,
    cancel_url: cancelUrl,
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    "metadata[source]": "social-cues",
    "metadata[selected_plan]": selectedPlan || "",
    "metadata[user_id]": userId || "",
    "metadata[email]": normalizeEmail(customerEmail)
  });
  if (customerEmail) body.set("customer_email", normalizeEmail(customerEmail));
  if (mode === "payment") body.set("customer_creation", "always");
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `Stripe Checkout failed with ${response.status}`);
  return payload;
}

function verifyStripeWebhook(raw, signatureHeader = "") {
  if (!stripeWebhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured.");
  const parts = Object.fromEntries(String(signatureHeader).split(",").map(part => {
    const [key, ...rest] = part.split("=");
    return [key, rest.join("=")];
  }).filter(([key]) => key));
  const timestamp = parts.t || "";
  const signatures = String(signatureHeader)
    .split(",")
    .filter(part => part.startsWith("v1="))
    .map(part => part.slice(3));
  if (!timestamp || !signatures.length) throw new Error("Missing Stripe signature timestamp or v1 signature.");
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 5 * 60) throw new Error("Stripe webhook signature timestamp is outside the allowed tolerance.");
  const expected = crypto.createHmac("sha256", stripeWebhookSecret).update(`${timestamp}.${raw}`).digest("hex");
  if (!signatures.some(signature => timingSafeEqualText(signature, expected))) throw new Error("Stripe webhook signature verification failed.");
  return JSON.parse(raw || "{}");
}

function stripeAccessForPlan(plan = "") {
  const normalized = String(plan || "").toLowerCase();
  if (normalized.includes("pro")) return "pro";
  if (normalized.includes("campaign")) return "campaign-build";
  if (normalized.includes("founder")) return "founder-audit";
  return "paid";
}

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

async function optionalSupabaseRequest(pathname, options = {}) {
  try {
    return await supabaseRequest(pathname, options);
  } catch (error) {
    if (/Could not find the table|schema cache|PGRST20|PGRST205|404/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function supabaseAuthHeaders(token = "", options = {}) {
  const key = supabaseAnonKey || supabaseServiceKey;
  const headers = {
    apikey: key,
    "Content-Type": "application/json"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else if (options.admin && supabaseServiceKey) {
    headers.Authorization = `Bearer ${supabaseServiceKey}`;
  }
  return headers;
}

async function supabaseAuthRequest(pathname, options = {}, token = "", authOptions = {}) {
  if (!supabaseUrl || !(supabaseAnonKey || supabaseServiceKey)) {
    throw new Error("Supabase Auth is not configured.");
  }
  const response = await fetch(`${supabaseUrl}/auth/v1${pathname}`, {
    ...options,
    headers: {
      ...supabaseAuthHeaders(token, authOptions),
      ...(options.headers || {})
    }
  });
  const textValue = await response.text();
  let body = textValue;
  try {
    body = textValue ? JSON.parse(textValue) : null;
  } catch {
    body = textValue;
  }
  if (!response.ok) {
    const message = body?.msg || body?.message || body?.error_description || body?.error || textValue || `Supabase Auth ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function supabaseAuthEnabled() {
  return authProvider === "supabase" && Boolean(supabaseUrl && (supabaseAnonKey || supabaseServiceKey));
}

async function signInWithSupabasePassword(email, password) {
  return supabaseAuthRequest("/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

async function refreshSupabasePasswordSession(refreshToken) {
  return supabaseAuthRequest("/token?grant_type=refresh_token", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken })
  });
}

async function createSupabasePasswordUser(input = {}) {
  const email = normalizeEmail(input.email);
  const password = normalizePassword(input.password);
  const promoCode = normalizePromoCode(input.promoCode);
  const promo = promoCode ? promoCodeRecord(promoCode) : null;
  const signup = await supabaseAuthRequest("/signup", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      data: {
        name: input.name || "Social Cues User",
        workspace_name: input.workspaceName || "Social Cues",
        ...(promo ? {
          promo_id: promo.id,
          promo_access: promo.access || "highest-tier-test",
          promo_days: promo.days || 120
        } : {})
      }
    })
  });
  const confirmed = Boolean(signup?.user?.email_confirmed_at || signup?.user?.confirmed_at);
  if (!signup?.access_token || !confirmed) {
    const pendingUser = signup?.user || (signup?.id || signup?.email ? signup : null);
    return { needsEmailVerification: true, user: pendingUser };
  }
  return signup;
}

async function getSupabaseAuthUser(token) {
  const body = await supabaseAuthRequest("/user", { method: "GET" }, token);
  return body?.user || body;
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

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function supabaseUserIdForUser(user = {}) {
  return [user.supabaseUserId, user.id].find(isUuid) || "";
}

function workspaceModelIdForUser(user = {}) {
  return [user.workspaceId, user.supabaseUserId, user.id].find(isUuid) || "";
}

const workspaceScopedCollectionKeys = ["campaigns", "actions", "proof", "mediaAssets", "activity"];
const sharedRegistryKeys = ["authUsers", "deviceSessions", "oauthStates", "metaDeletionRequests", "billing", "integrations"];

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function copySharedRegistryFields(target = {}, shared = {}) {
  for (const key of sharedRegistryKeys) {
    if (shared?.[key] !== undefined) target[key] = cloneJson(shared[key]);
  }
  return target;
}

function serverRegistryModel(model = {}) {
  const registry = {
    version: model.version || "0.3.0-registry",
    currentUser: null,
    workspace: {
      name: "Social Cues",
      owner: "Server registry",
      purpose: "Authentication, billing, OAuth state, and device registry only."
    },
    workspaces: [],
    campaigns: [],
    actions: [],
    proof: [],
    mediaAssets: [],
    activity: [],
    connectedAccounts: [],
    analytics: {
      lastCompiledAt: null,
      status: "Per-user workspace analytics only",
      metrics: []
    },
    workspaceIsolation: {
      mode: "per-user",
      note: "Client workspace content is stored in workspace_models and normalized owner-scoped tables."
    }
  };
  copySharedRegistryFields(registry, model);
  registry.currentUser = null;
  return registry;
}

function isRegistryOnlyModel(model = {}) {
  return model?.workspaceIsolation?.mode === "per-user" || model?.workspace?.owner === "Server registry";
}

function mergeOwnerRuntimeState(target = {}, source = {}, user = {}) {
  if (!user?.id) return target;
  const workspaceId = workspaceIdForUser(user);
  if (Array.isArray(source.connectedAccounts)) {
    target.connectedAccounts = Array.isArray(target.connectedAccounts) ? target.connectedAccounts : [];
    for (const account of source.connectedAccounts.filter(item => ownedByUser(item, user.id))) {
      const incoming = cloneJson(account);
      stampWorkspaceOwnership(incoming, user, workspaceId);
      const index = target.connectedAccounts.findIndex(item =>
        item.id === incoming.id
        || (item.platform === incoming.platform && item.providerAccountId && incoming.providerAccountId && item.providerAccountId === incoming.providerAccountId)
        || (item.platform === incoming.platform && item.oauthProvider === incoming.oauthProvider)
      );
      if (index >= 0) target.connectedAccounts[index] = mergeServerOnlyAccountFields(incoming, target.connectedAccounts[index]);
      else target.connectedAccounts.push(incoming);
    }
  }
  if (source.metaConnection) target.metaConnection = cloneJson(source.metaConnection);
  if (source.metaHealth) target.metaHealth = cloneJson(source.metaHealth);
  if (source.integrations) {
    target.integrations = {
      ...(target.integrations || {}),
      ...cloneJson(source.integrations)
    };
  }
  return target;
}

async function workspaceModelForRegistryWrite(model = {}, user = {}) {
  if (!user?.id || !isRegistryOnlyModel(model)) return model;
  let workspaceModel = null;
  try {
    workspaceModel = await supabaseGetWorkspaceModel(user, model);
  } catch {
    workspaceModel = null;
  }
  if (!workspaceModel) workspaceModel = await clientWorkspaceModelForUser(user, {}, model);
  ensureUserWorkspace(workspaceModel, user);
  return mergeOwnerRuntimeState(workspaceModel, model, user);
}

async function clientWorkspaceModelForUser(user = {}, input = {}, sharedModel = {}) {
  const seed = await getSeedModel();
  const workspaceId = workspaceIdForUser(user);
  const userName = user.name || input.name || "Social Cues User";
  const workspaceName = input.workspaceName || `${userName}'s Social Cues`;
  const starterCampaignId = `camp-first-${workspaceId}`;
  const model = {
    version: "0.3.0-client-workspace",
    currentUser: publicAppUser(user),
    workspace: {
      id: workspaceId,
      name: workspaceName,
      owner: userName,
      ownerUserId: user.id || "",
      ownerEmail: user.email || "",
      purpose: "Private client workspace",
      createdAt: new Date().toISOString()
    },
    workspaces: [],
    onboarding: {
      complete: false,
      hasLlc: null,
      businessName: "",
      offer: "",
      audience: "",
      purpose: "Set up this account around the user's own brand, channels, offers, and proof goals."
    },
    profile: {
      operator: userName,
      outcome: "Build demand",
      display: "Command center",
      automation: "Approval-first"
    },
    security: {
      session: "Keep me logged in",
      stepUp: "Re-auth before publish/account changes"
    },
    settings: {
      theme: "auto"
    },
    baseline: {
      audience: 0,
      avgViews: 0,
      engagement: 0,
      cadence: 0
    },
    activeCampaignId: starterCampaignId,
    campaigns: [{
      id: starterCampaignId,
      title: "First campaign",
      brief: "Define the offer, audience, channel mix, and proof goal for this workspace.",
      goal: "Build demand",
      tone: "Useful and clear",
      disclosure: "Owner-approved post",
      riskPosture: "Balanced growth",
      variants: [],
      ownerUserId: user.id || "",
      workspaceId,
      createdAt: new Date().toISOString()
    }],
    actions: [
      {
        id: `act-connect-${workspaceId}`,
        type: "Setup",
        priority: "High",
        status: "active",
        title: "Connect the first social account",
        signal: "Social Cues can read owned platform context after consent.",
        ownerUserId: user.id || "",
        workspaceId,
        createdAt: new Date().toISOString()
      },
      {
        id: `act-onboard-${workspaceId}`,
        type: "Onboarding",
        priority: "High",
        status: "active",
        title: "Complete business and audience setup",
        signal: "Campaign guidance improves once the account knows the offer, audience, and business structure.",
        ownerUserId: user.id || "",
        workspaceId,
        createdAt: new Date().toISOString()
      }
    ],
    proof: [],
    mediaAssets: [],
    activity: [{
      id: `actv-created-${workspaceId}`,
      message: "Private Social Cues workspace created.",
      ownerUserId: user.id || "",
      workspaceId,
      createdAt: new Date().toISOString()
    }],
    handoff: { lastLink: "" },
    integrations: cloneJson(sharedModel.integrations || seed.integrations || {}),
    analytics: {
      lastCompiledAt: null,
      status: "Waiting for connected accounts",
      metrics: []
    },
    connectedAccounts: (seed.connectedAccounts || []).map((account, index) => ({
      ...cloneJson(account),
      id: `${account.id || `acct-${index + 1}`}-${workspaceId}`,
      ownerUserId: user.id || "",
      workspaceId
    })),
    workspaceModel: {
      version: 1,
      source: "client-isolated-starter",
      clientIsolated: true,
      createdAt: new Date().toISOString()
    }
  };
  copySharedRegistryFields(model, sharedModel);
  ensureUserWorkspace(model, user, { workspaceName });
  return model;
}

function workspaceOwnedItems(model, key, user = {}) {
  if (!Array.isArray(model?.[key]) || !user?.id) return [];
  return model[key].filter(item => ownedByUser(item, user.id));
}

function safeWorkspaceSnapshot(model, user = {}) {
  const safe = JSON.parse(JSON.stringify(model || {}));
  const workspace = workspaceForUser(model, user);
  safe.currentUser = publicAppUser(user);
  safe.workspace = workspace;
  safe.workspaces = [workspace];
  for (const key of workspaceScopedCollectionKeys) {
    safe[key] = workspaceOwnedItems(model, key, user);
  }
  safe.connectedAccounts = visibleConnectedAccounts(model)
    .filter(account => ownedByUser(account, user.id))
    .map(publicAccount);
  safe.deviceSessions = publicDeviceSessions(model, user.id);
  safe.billing = publicBilling(model.billing || {});
  safe.analytics = buildGrowthAnalytics(safe);
  delete safe.authUsers;
  delete safe.oauthStates;
  delete safe.metaDeletionRequests;
  safe.workspaceModel = {
    version: 1,
    mirroredAt: new Date().toISOString(),
    source: "app_state.compatibility.filtered"
  };
  return safe;
}

async function ensureSupabaseWorkspaceRows(model, user = {}) {
  const workspaceId = workspaceModelIdForUser(user);
  const ownerUserId = supabaseUserIdForUser(user);
  if (!supabaseEnabled || !workspaceId || !ownerUserId) return { ok: false, reason: "workspace user is not a Supabase UUID user" };
  const workspace = workspaceForUser(model, user);
  const now = new Date().toISOString();
  await supabaseRequest("/workspaces?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      id: workspaceId,
      owner_user_id: ownerUserId,
      name: workspace.name || "Social Cues",
      plan: user.entitlement?.access || "founder_alpha",
      updated_at: now
    }])
  });
  await supabaseRequest("/profiles?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      id: ownerUserId,
      workspace_id: workspaceId,
      display_name: user.name || "Social Cues User",
      email: user.email || "",
      role: user.role || "owner",
      updated_at: now
    }])
  });
  await optionalSupabaseRequest("/workspace_members?on_conflict=workspace_id,user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      workspace_id: workspaceId,
      user_id: ownerUserId,
      role: user.role || "owner",
      updated_at: now
    }])
  });
  return { ok: true, workspaceId, ownerUserId };
}

async function mirrorWorkspaceModel(model, user = {}) {
  if (!supabaseEnabled || !user?.id) return { ok: false, skipped: true };
  try {
    const workspaceRows = await ensureSupabaseWorkspaceRows(model, user);
    if (!workspaceRows.ok) return workspaceRows;
    const snapshot = safeWorkspaceSnapshot(model, user);
    const now = new Date().toISOString();
    await supabaseRequest("/workspace_models?on_conflict=workspace_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{
        workspace_id: workspaceRows.workspaceId,
        owner_user_id: workspaceRows.ownerUserId,
        model: snapshot,
        updated_at: now
      }])
    });
    await mirrorNormalizedWorkspaceRows(model, user, workspaceRows);
    return { ok: true, workspaceId: workspaceRows.workspaceId };
  } catch (error) {
    lastPersistence = { driver: "supabase", ok: false, message: `workspace mirror failed: ${error.message}` };
    return { ok: false, error: error.message };
  }
}

async function mirrorNormalizedWorkspaceRows(model, user = {}, workspaceRows = {}) {
  const workspaceId = workspaceRows.workspaceId || workspaceModelIdForUser(user);
  const ownerUserId = workspaceRows.ownerUserId || supabaseUserIdForUser(user);
  if (!workspaceId || !ownerUserId) return { ok: false, skipped: true };
  const now = new Date().toISOString();

  const accounts = (model.connectedAccounts || [])
    .filter(account => ownedByUser(account, user.id) && (account.providerAccountId || account.id))
    .map(account => ({
      workspace_id: workspaceId,
      user_id: ownerUserId,
      provider: account.oauthProvider || account.provider || account.platform,
      platform: account.platform,
      provider_account_id: String(account.providerAccountId || account.id),
      display_name: account.name || account.displayName || account.handle || account.platform,
      handle: account.handle || "",
      status: account.status || "not_connected",
      scopes: Array.isArray(account.scopes) ? account.scopes : [],
      public_profile: publicAccount(account),
      connected_at: account.connectedAt || null,
      last_sync_at: account.lastSyncedAt || account.updatedAt || null,
      updated_at: now
    }));
  const accountRows = accounts.length ? await optionalSupabaseRequest("/connected_accounts?on_conflict=workspace_id,provider,platform,provider_account_id&select=id,provider,platform,provider_account_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(accounts)
  }) : null;

  if (Array.isArray(accountRows) && accountRows.length) {
    const tokenRows = [];
    for (const account of model.connectedAccounts || []) {
      if (!ownedByUser(account, user.id) || !hasStoredToken(account)) continue;
      const provider = account.oauthProvider || account.provider || account.platform;
      const providerAccountId = String(account.providerAccountId || account.id);
      const row = accountRows.find(item =>
        item.provider === provider
        && item.platform === account.platform
        && String(item.provider_account_id) === providerAccountId
      );
      if (!row?.id || !account.credential) continue;
      tokenRows.push({
        connected_account_id: row.id,
        workspace_id: workspaceId,
        user_id: ownerUserId,
        provider,
        token_kind: "oauth",
        encrypted_token: account.credential,
        encrypted_refresh_token: account.refreshCredential || null,
        token_type: account.tokenType || null,
        scopes: Array.isArray(account.scopes) ? account.scopes : [],
        expires_at: account.tokenExpiresAt || null,
        refresh_expires_at: account.refreshTokenExpiresAt || null,
        updated_at: now
      });
    }
    if (tokenRows.length) {
      await optionalSupabaseRequest("/provider_tokens?on_conflict=connected_account_id,token_kind", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(tokenRows)
      });
    }
  }

  const devices = (model.deviceSessions || [])
    .filter(device => String(device.userId || "") === String(user.id))
    .map(device => ({
      workspace_id: workspaceId,
      user_id: ownerUserId,
      device_id: String(device.deviceId || device.id),
      session_token_hash: device.sessionTokenHash || "",
      name: device.name || "This device",
      kind: device.kind || "",
      user_agent: device.userAgent || "",
      platform: device.platform || "",
      language: device.language || "",
      screen: device.screen || "",
      time_zone: device.timeZone || "",
      trusted: device.trusted !== false,
      login_count: Number(device.loginCount || 0),
      last_seen_at: device.lastSeenAt || null,
      expires_at: device.expiresAt || null,
      revoked_at: device.revokedAt || null,
      updated_at: now
    }));
  if (devices.length) {
    await optionalSupabaseRequest("/device_sessions?on_conflict=user_id,device_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(devices)
    });
  }

  const entitlement = publicEntitlement(user);
  if (entitlement?.active) {
    await optionalSupabaseRequest("/billing_entitlements", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify([{
        workspace_id: workspaceId,
        user_id: ownerUserId,
        source: entitlement.source || "unknown",
        access: entitlement.access || "active",
        status: "active",
        promo_code: entitlement.promoCode || null,
        current_period_end: entitlement.expiresAt || null,
        updated_at: now
      }])
    });
  }

  return { ok: true };
}

async function workspaceModelMirrorStatus(user = {}) {
  const workspaceId = workspaceModelIdForUser(user);
  if (!supabaseEnabled || !workspaceId) return { ready: false, mirrored: false, reason: "workspace mirror requires Supabase Auth user ids" };
  try {
    const rows = await supabaseRequest(`/workspace_models?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=workspace_id,updated_at&limit=1`);
    return { ready: true, mirrored: Boolean(rows?.[0]), workspaceId, updatedAt: rows?.[0]?.updated_at || null };
  } catch (error) {
    return { ready: false, mirrored: false, workspaceId, error: error.message };
  }
}

async function rehydrateProviderTokenAccounts(model = {}, user = {}) {
  const workspaceId = workspaceModelIdForUser(user);
  const ownerUserId = supabaseUserIdForUser(user);
  if (!supabaseEnabled || !workspaceId || !ownerUserId) return false;
  const accountRows = await optionalSupabaseRequest(`/connected_accounts?workspace_id=eq.${encodeURIComponent(workspaceId)}&user_id=eq.${encodeURIComponent(ownerUserId)}&select=id,provider,platform,provider_account_id,display_name,handle,status,scopes,connected_at,public_profile&limit=200`);
  if (!Array.isArray(accountRows) || !accountRows.length) return false;
  const accountIds = accountRows.map(row => row.id).filter(Boolean);
  const tokenRows = accountIds.length
    ? await optionalSupabaseRequest(`/provider_tokens?connected_account_id=in.(${accountIds.map(id => encodeURIComponent(id)).join(",")})&token_kind=eq.oauth&select=connected_account_id,encrypted_token,encrypted_refresh_token,token_type,scopes,expires_at,refresh_expires_at&limit=200`)
    : [];
  const tokensByAccountId = new Map((Array.isArray(tokenRows) ? tokenRows : []).map(row => [row.connected_account_id, row]));
  model.connectedAccounts = Array.isArray(model.connectedAccounts) ? model.connectedAccounts : [];
  let changed = false;
  for (const row of accountRows) {
    const tokenRow = tokensByAccountId.get(row.id);
    const publicProfile = row.public_profile && typeof row.public_profile === "object" ? row.public_profile : {};
    const providerAccountId = String(row.provider_account_id || publicProfile.providerAccountId || "");
    const platform = row.platform || publicProfile.platform || row.provider;
    if (!platform) continue;
    let account = model.connectedAccounts.find(item =>
      item.platform === platform
      && ownedByUser(item, user.id)
      && (
        (providerAccountId && String(item.providerAccountId || "") === providerAccountId)
        || String(item.id || "") === String(publicProfile.id || "")
        || (!item.providerAccountId && !providerAccountId)
      )
    );
    if (!account) {
      account = {
        id: publicProfile.id || uid("acct"),
        platform,
        name: publicProfile.name || row.display_name || platform,
        handle: row.handle || publicProfile.handle || "",
        status: row.status || publicProfile.status || "not connected",
        connectedAt: row.connected_at || publicProfile.connectedAt || null
      };
      stampWorkspaceOwnership(account, user, workspaceId);
      model.connectedAccounts.push(account);
    }
    const nextName = platform === "x" ? "X" : (publicProfile.name || row.display_name || account.name || platform);
    const nextDisplayName = platform === "x" ? (publicProfile.displayName || row.display_name || account.displayName || account.name || "") : (publicProfile.displayName || row.display_name || account.displayName || "");
    Object.assign(account, {
      platform,
      name: nextName,
      displayName: nextDisplayName,
      handle: row.handle || publicProfile.handle || account.handle || "",
      status: row.status || publicProfile.status || account.status || "not connected",
      connectedAt: row.connected_at || publicProfile.connectedAt || account.connectedAt || null,
      providerAccountId: providerAccountId || account.providerAccountId || null,
      oauthProvider: row.provider || publicProfile.oauthProvider || account.oauthProvider || platform,
      scopes: Array.isArray(tokenRow?.scopes) && tokenRow.scopes.length ? tokenRow.scopes : Array.isArray(row.scopes) ? row.scopes : Array.isArray(publicProfile.scopes) ? publicProfile.scopes : account.scopes || [],
      tokenType: tokenRow?.token_type || account.tokenType || null,
      tokenExpiresAt: tokenRow?.expires_at || account.tokenExpiresAt || null,
      refreshTokenExpiresAt: tokenRow?.refresh_expires_at || account.refreshTokenExpiresAt || null
    });
    if (tokenRow?.encrypted_token) account.credential = tokenRow.encrypted_token;
    if (tokenRow?.encrypted_refresh_token) account.refreshCredential = tokenRow.encrypted_refresh_token;
    delete account.connected;
    delete account.tokenStored;
    changed = true;
  }
  return changed;
}

function mergeWorkspaceRuntimeFields(workspaceModel = {}, sharedModel = {}, user = {}) {
  const merged = JSON.parse(JSON.stringify(workspaceModel || {}));
  for (const key of ["authUsers", "deviceSessions", "oauthStates", "metaDeletionRequests"]) {
    if (sharedModel?.[key] !== undefined) merged[key] = cloneJson(sharedModel[key]);
  }
  if (sharedModel?.billing && !merged.billing) merged.billing = sharedModel.billing;
  if (sharedModel?.integrations && !merged.integrations) merged.integrations = sharedModel.integrations;
  if (user?.id) {
    merged.currentUser = publicAppUser(user);
    merged.workspace = workspaceForUser(sharedModel, user);
    merged.workspaces = [merged.workspace];
  }
  merged.loadedFromWorkspaceModel = Boolean(workspaceModel?.workspaceModel);
  return merged;
}

async function supabaseGetWorkspaceModel(user = {}, sharedModel = null) {
  const workspaceId = workspaceModelIdForUser(user);
  if (!supabaseEnabled || !workspaceId) return null;
  const rows = await supabaseRequest(`/workspace_models?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=workspace_id,model,updated_at&limit=1`);
  if (!Array.isArray(rows) || !rows[0]?.model) return null;
  const model = mergeWorkspaceRuntimeFields(rows[0].model, sharedModel || {}, user);
  try {
    await rehydrateProviderTokenAccounts(model, user);
  } catch (error) {
    lastPersistence = { driver: "supabase", ok: false, message: `provider token rehydrate failed: ${error.message}` };
  }
  model.workspaceModel = {
    ...(model.workspaceModel || {}),
    version: model.workspaceModel?.version || 1,
    loadedAt: new Date().toISOString(),
    updatedAt: rows[0].updated_at || null,
    source: "workspace_models"
  };
  lastPersistence = { driver: "supabase", ok: true, message: "loaded workspace model" };
  return model;
}

async function modelForSession(session = null, sharedModel = null) {
  const base = sharedModel || await getModel();
  if (!session?.user) return base;
  if (!supabaseEnabled) {
    const scoped = cloneJson(base);
    ensureUserWorkspace(scoped, session.user);
    const workspaceId = workspaceIdForUser(session.user);
    for (const key of workspaceScopedCollectionKeys) {
      scoped[key] = (scoped[key] || []).filter(item => ownedByUser(item, session.user.id));
    }
    scoped.connectedAccounts = (scoped.connectedAccounts || []).filter(account => ownedByUser(account, session.user.id));
    scoped.workspaces = (scoped.workspaces || []).filter(item => item.id === workspaceId && ownedByUser(item, session.user.id));
    scoped.workspace = workspaceForUser(scoped, session.user);
    scoped.currentUser = publicAppUser(session.user);
    scoped.deviceSessions = (scoped.deviceSessions || []).filter(device => String(device.userId || "") === String(session.user.id));
    return scoped;
  }
  try {
    const workspaceModel = await supabaseGetWorkspaceModel(session.user, base);
    if (workspaceModel) return workspaceModel;
  } catch (error) {
    lastPersistence = { driver: "supabase", ok: false, message: `workspace load failed: ${error.message}` };
  }
  return clientWorkspaceModelForUser(session.user, {}, base);
}

async function getSharedModel() {
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
  if (model.integrations) {
    for (const key of ["sora"]) {
      if (key in model.integrations) {
        delete model.integrations[key];
        changed = true;
      }
    }
    if (model.integrations.shopify !== "Backlog") {
      model.integrations.shopify = "Backlog";
      changed = true;
    }
    const pinterestStatus = pinterestAppId && pinterestAppSecret ? (model.integrations.pinterest || "OAuth credentials ready") : "Developer app pending";
    if (model.integrations.pinterest !== pinterestStatus) {
      model.integrations.pinterest = pinterestStatus;
      changed = true;
    }
    const canvaStatus = canvaClientId && canvaClientSecret ? (model.integrations.canva || "OAuth credentials ready") : "MFA / developer integration pending";
    if (model.integrations.canva !== canvaStatus) {
      model.integrations.canva = canvaStatus;
      changed = true;
    }
  }
  if (!model.billing) {
    const seed = await getSeedModel();
    model.billing = seed.billing || {};
    changed = true;
  }
  if (sanitizeConnectedAccounts(model)) changed = true;
  if (hydrateMetaLoginStatus(model)) changed = true;
  if (changed) await saveSharedModel(model);
  return model;
}

async function getModel() {
  const sharedModel = await getSharedModel();
  const context = requestSecurityContext.getStore();
  if (!context?.workspaceScoped || !context.session?.user) return sharedModel;
  return modelForSession(context.session, sharedModel);
}

function isConnectedStatus(status) {
  return String(status || "").toLowerCase() === "connected";
}

function hasStoredToken(account) {
  return Boolean(account?.credential || account?.token || account?.accessToken || account?.refreshToken);
}

function isRealConnectedAccount(account) {
  if (account?.disabled) return false;
  if (!account || account.status !== "connected") return false;
  if (account.platform === "meta") return account.oauthProvider === "meta" && hasStoredToken(account) && Boolean(account.providerAccountId);
  if (["facebook", "instagram"].includes(account.platform)) return account.oauthProvider === "meta" && hasStoredToken(account) && Boolean(account.providerAccountId);
  if (account.platform === "threads") return account.oauthProvider === "threads" && hasStoredToken(account) && Boolean(account.providerAccountId);
  if (account.platform === "x") return account.oauthProvider === "x" && hasStoredToken(account) && Boolean(account.providerAccountId);
  return hasStoredToken(account) && Boolean(account.providerAccountId || account.oauthProvider);
}

function repairConnectedOAuthAccount(account, provider) {
  if (!account || account.disabled) return false;
  if (account.status === "connected") return false;
  if (account.oauthProvider !== provider) return false;
  if (!hasStoredToken(account) || !account.providerAccountId) return false;
  if (account.tokenExpiresAt && Date.parse(account.tokenExpiresAt) <= Date.now()) return false;
  account.status = "connected";
  account.connectedAt = account.connectedAt || new Date().toISOString();
  account.connectionEvidence = `${provider.toUpperCase()} token/provider evidence restored connected status.`;
  return true;
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

async function saveSharedModel(model) {
  try {
    return supabaseEnabled ? await supabaseSaveModel(model) : await localSaveModel(model);
  } catch (error) {
    lastPersistence = { driver: "supabase", ok: false, message: error.message };
    return localSaveModel(model);
  }
}

async function saveModel(model) {
  const context = requestSecurityContext.getStore();
  if (context?.workspaceScoped && context.session?.user) {
    return saveModelForUser(model, context.session.user);
  }
  return saveSharedModel(model);
}

async function saveModelForUser(model, user = null) {
  if (user?.id && supabaseEnabled) {
    const workspaceModel = await workspaceModelForRegistryWrite(model, user);
    await mirrorWorkspaceModel(workspaceModel, user);
    await saveSharedModel(serverRegistryModel(model));
    return workspaceModel;
  }
  if (user?.id) {
    const existing = await getSharedModel();
    const merged = mergePublicModelUpdate(model, existing, user);
    return saveSharedModel(merged);
  }
  const saved = await saveSharedModel(model);
  return saved;
}

function responseHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Permitted-Cross-Domain-Policies": "none",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
    ...(runtimeMode === "vercel" ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload" } : {}),
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://browser.sentry-cdn.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' data: blob: https:",
      "connect-src 'self' https:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://checkout.stripe.com"
    ].join("; ")
  };
}

function json(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, responseHeaders("application/json; charset=utf-8"));
  res.end(body);
}

function setCookie(res, value) {
  if (typeof res.setHeader === "function") res.setHeader("Set-Cookie", value);
}

function sessionCookieValue(token = "", expiresAt = "") {
  const secure = runtimeMode === "vercel" || publicAppUrl.startsWith("https://") ? "; Secure" : "";
  const maxAgeSeconds = expiresAt && Date.parse(expiresAt) > Date.now()
    ? Math.max(60, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
    : 60 * 60 * 24 * 30;
  return `sc_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; HttpOnly${secure}`;
}

function expiredSessionCookieValue() {
  const secure = runtimeMode === "vercel" || publicAppUrl.startsWith("https://") ? "; Secure" : "";
  return `sc_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`;
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, responseHeaders(contentType));
  res.end(body);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function binary(res, status, body, contentType) {
  const headers = responseHeaders(contentType);
  headers["Content-Length"] = String(body.length);
  if (typeof res.setHeader === "function" && typeof res.status === "function" && typeof res.send === "function") {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    return res.status(status).send(body);
  }
  res.writeHead(status, headers);
  res.end(body);
}

function publicRequestError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

async function bodyJson(req) {
  let raw = "";
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxJsonBodyBytes) throw publicRequestError(413, "Request body is too large.");
    raw += chunk;
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw publicRequestError(400, "Request body must be valid JSON.");
  }
}

async function bodyText(req) {
  let raw = "";
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxJsonBodyBytes) throw publicRequestError(413, "Request body is too large.");
    raw += chunk;
  }
  return raw;
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePassword(value) {
  return String(value || "");
}

function normalizePromoCode(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function promoCodeRecord(value) {
  const code = normalizePromoCode(value);
  if (!code) return null;
  const hash = crypto.createHash("sha256").update(code).digest("hex");
  return promoCodeRecords.find(item => timingSafeEqualText(item.hash, hash)) || null;
}

function promoCodeRecordById(value) {
  const id = String(value || "").trim();
  return id ? promoCodeRecords.find(item => item.id === id) || null : null;
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function publicEntitlement(user) {
  const entitlement = user?.entitlement || {};
  const expiresAt = entitlement.expiresAt || null;
  const expired = expiresAt ? Date.parse(expiresAt) <= Date.now() : false;
  return {
    access: entitlement.access || "unpaid",
    source: entitlement.source || "none",
    promoCode: entitlement.promoCode || "",
    active: !expired && entitlement.active !== false && Boolean(entitlement.access && entitlement.access !== "unpaid"),
    grantedAt: entitlement.grantedAt || null,
    expiresAt,
    billingStartsAfter: entitlement.billingStartsAfter || expiresAt,
    selectedPlan: entitlement.selectedPlan || "",
    tier: entitlement.tier || entitlement.access || "",
    subscriptionPaid: Boolean(entitlement.subscriptionPaid || entitlement.fullAccess || entitlement.source === "stripe"),
    appFeePaid: Boolean(entitlement.appFeePaid || entitlement.fullAccess || entitlement.source === "stripe"),
    paymentStatus: entitlement.paymentStatus || (entitlement.active ? "active" : "unpaid"),
    alphaHonorDiscountPercent: Number(entitlement.alphaHonorDiscountPercent || 0),
    deactivatesBeforeAlpha: Boolean(entitlement.deactivatesBeforeAlpha)
  };
}

function applyPromoEntitlement(user, promo, input = {}) {
  if (!promo) return;
  const now = new Date();
  const daysFree = Number(promo.days || (promo.months ? Number(promo.months) * 30 : 120));
  const expiresAt = addDays(now, daysFree).toISOString();
  user.entitlement = {
    access: promo.access,
    source: "promo-code",
    promoCode: promo.id,
    promoLabel: promo.label,
    active: true,
    fullAccess: true,
    daysFree,
    monthsFree: Math.round(daysFree / 30),
    expiresAt,
    billingStartsAfter: expiresAt,
    selectedPlan: "Social Cues highest tier tester access",
    tier: "highest",
    subscriptionPaid: true,
    appFeePaid: true,
    paymentStatus: "promo-paid",
    alphaHonorDiscountPercent: 10,
    alphaPremiumPercent: 25,
    deactivatesBeforeAlpha: false,
    grantedAt: user.entitlement?.grantedAt || now.toISOString(),
    grantedReason: input.grantedReason || "120-day no-charge highest-tier test account"
  };
}

function applyPaidEntitlement(user, payment = {}) {
  if (!user) return null;
  const plan = payment.selectedPlan || payment.plan || "Paid access";
  const access = payment.access || stripeAccessForPlan(plan);
  user.entitlement = {
    access,
    source: "stripe",
    active: true,
    fullAccess: true,
    tier: payment.tier || (access.includes("founder") ? "founder" : "highest"),
    subscriptionPaid: payment.subscriptionPaid !== false,
    appFeePaid: payment.appFeePaid !== false,
    paymentStatus: payment.paymentStatus || "paid",
    stripeCustomerId: payment.customerId || user.entitlement?.stripeCustomerId || "",
    stripeCheckoutSessionId: payment.checkoutSessionId || user.entitlement?.stripeCheckoutSessionId || "",
    stripeSubscriptionId: payment.subscriptionId || user.entitlement?.stripeSubscriptionId || "",
    selectedPlan: plan,
    grantedAt: user.entitlement?.source === "stripe" && user.entitlement?.grantedAt ? user.entitlement.grantedAt : new Date().toISOString(),
    grantedReason: payment.reason || "Stripe payment confirmed"
  };
  return user.entitlement;
}

function applyPaidEntitlementForEmail(model, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const payment = (model.billing?.paidEmails || []).find(item => normalizeEmail(item.email) === normalized && item.active !== false);
  if (!payment) return null;
  const user = (model.authUsers || []).find(item => normalizeEmail(item.email) === normalized);
  return user ? applyPaidEntitlement(user, payment) : null;
}

function recordStripeCheckoutCompletion(model, session = {}) {
  model.billing = model.billing || {};
  model.billing.stripeEvents = model.billing.stripeEvents || [];
  model.billing.paidEmails = model.billing.paidEmails || [];
  const metadata = session.metadata || {};
  const email = normalizeEmail(metadata.email || session.customer_details?.email || session.customer_email || "");
  const selectedPlan = metadata.selected_plan || model.billing.selectedPlan || "Paid access";
  const payment = {
    email,
    userId: metadata.user_id || "",
    selectedPlan,
    access: stripeAccessForPlan(selectedPlan),
    active: true,
    customerId: session.customer || "",
    checkoutSessionId: session.id || "",
    subscriptionId: session.subscription || "",
    paymentIntentId: session.payment_intent || "",
    paymentStatus: session.payment_status || session.status || "",
    amountTotal: session.amount_total || null,
    currency: session.currency || "",
    grantedAt: new Date().toISOString(),
    reason: "Stripe Checkout completed"
  };
  model.billing.stripeEvents.unshift({
    id: uid("stripe-event"),
    type: "checkout.session.completed",
    checkoutSessionId: payment.checkoutSessionId,
    email,
    selectedPlan,
    receivedAt: new Date().toISOString()
  });
  model.billing.stripeEvents = model.billing.stripeEvents.slice(0, 100);
  if (email) {
    const existing = model.billing.paidEmails.find(item => normalizeEmail(item.email) === email);
    if (existing) Object.assign(existing, payment);
    else model.billing.paidEmails.unshift(payment);
    const user = (model.authUsers || []).find(item => normalizeEmail(item.email) === email || item.id === payment.userId);
    if (user) applyPaidEntitlement(user, payment);
  }
  model.billing.status = "Stripe payment confirmed";
  model.billing.lastStripeCheckout = payment;
  return payment;
}

function passwordError(password) {
  if (password.length < 8) return "Use at least 8 characters for your Social Cues password.";
  if (password.length > 256) return "Password is too long.";
  return "";
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("base64url")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("base64url");
  return `scrypt:v1:${salt}:${hash}`;
}

function verifyPassword(password, stored = "") {
  const parts = String(stored || "").split(":");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "v1") return false;
  const candidate = hashPassword(password, parts[2]);
  return timingSafeEqualText(candidate, stored);
}

function hashSecret(value) {
  return crypto.createHmac("sha256", authSessionSecret).update(String(value || "")).digest("base64url");
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1].trim();
  const cookieHeader = String(req.headers.cookie || "");
  const cookie = cookieHeader
    .split(";")
    .map(part => part.trim())
    .find(part => part.startsWith("sc_session="));
  return cookie ? decodeURIComponent(cookie.slice("sc_session=".length)) : "";
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

function isMetaProviderAccount(account = {}) {
  return account.oauthProvider === "meta" || account.platform === "meta";
}

function metaDeletionTargetKey(target = {}) {
  return `${String(target.workspaceId || "")}:${String(target.ownerUserId || "")}`;
}

function accountMatchesMetaDeletionTarget(account = {}, target = {}) {
  return isMetaProviderAccount(account)
    && String(account.workspaceId || "") === String(target.workspaceId || "")
    && String(account.ownerUserId || "") === String(target.ownerUserId || "");
}

function clearMetaProviderData(model = {}, target = {}, metaUserId = "") {
  model.connectedAccounts = (model.connectedAccounts || []).filter(account => !accountMatchesMetaDeletionTarget(account, target));
  if (!model.metaConnection?.userId || String(model.metaConnection.userId) === String(metaUserId)) delete model.metaConnection;
  delete model.metaHealth;
  model.integrations = {
    ...(model.integrations || {}),
    meta: "Disconnected by verified Meta data deletion request",
    facebook: "Disconnected by verified Meta data deletion request",
    instagram: "Disconnected by verified Meta data deletion request"
  };
  return model;
}

async function verifiedMetaDeletionTargets(model = {}, metaUserId = "") {
  const targets = new Map();
  for (const account of model.connectedAccounts || []) {
    if (account.platform !== "meta" || account.oauthProvider !== "meta" || String(account.providerAccountId || "") !== String(metaUserId)) continue;
    const target = { workspaceId: account.workspaceId || "", ownerUserId: account.ownerUserId || "" };
    if (target.workspaceId && target.ownerUserId) targets.set(metaDeletionTargetKey(target), target);
  }
  if (supabaseEnabled && metaUserId) {
    const rows = await optionalSupabaseRequest(`/connected_accounts?provider=eq.meta&platform=eq.meta&provider_account_id=eq.${encodeURIComponent(metaUserId)}&select=workspace_id,user_id&limit=100`);
    for (const row of Array.isArray(rows) ? rows : []) {
      const target = { workspaceId: row.workspace_id || "", ownerUserId: row.user_id || "" };
      if (target.workspaceId && target.ownerUserId) targets.set(metaDeletionTargetKey(target), target);
    }
  }
  return [...targets.values()];
}

async function purgeVerifiedMetaIdentity(model = {}, metaUserId = "") {
  const targets = await verifiedMetaDeletionTargets(model, metaUserId);
  for (const target of targets) {
    if (supabaseEnabled && isUuid(target.workspaceId) && isUuid(target.ownerUserId)) {
      const workspaceRows = await optionalSupabaseRequest(`/workspace_models?workspace_id=eq.${encodeURIComponent(target.workspaceId)}&select=model&limit=1`);
      if (Array.isArray(workspaceRows) && workspaceRows[0]?.model) {
        const workspaceModel = clearMetaProviderData(workspaceRows[0].model, target, metaUserId);
        await supabaseRequest(`/workspace_models?workspace_id=eq.${encodeURIComponent(target.workspaceId)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ model: workspaceModel, updated_at: new Date().toISOString() })
        });
      }
      await supabaseRequest(`/connected_accounts?workspace_id=eq.${encodeURIComponent(target.workspaceId)}&user_id=eq.${encodeURIComponent(target.ownerUserId)}&provider=eq.meta`, {
        method: "DELETE",
        headers: { Prefer: "return=minimal" }
      });
    }
    clearMetaProviderData(model, target, metaUserId);
  }
  if (model.metaConnection?.userId && String(model.metaConnection.userId) === String(metaUserId)) delete model.metaConnection;
  return targets;
}

function oauthTokenEncryptionKeyMaterial() {
  return process.env.OAUTH_TOKEN_ENCRYPTION_KEY || metaAppSecret || supabaseServiceKey || "Social Cues-local-dev";
}

function oauthTokenEncryptionReadiness() {
  const explicitKey = envPresent("OAUTH_TOKEN_ENCRYPTION_KEY");
  const fallback = explicitKey ? "OAUTH_TOKEN_ENCRYPTION_KEY" : metaAppSecret ? "META_APP_SECRET fallback" : supabaseServiceKey ? "Supabase server key fallback" : "local development fallback";
  const productionReady = runtimeMode !== "vercel" || explicitKey;
  return {
    explicitKey,
    productionReady,
    keySource: fallback,
    missingEnv: productionReady ? [] : ["OAUTH_TOKEN_ENCRYPTION_KEY"]
  };
}

function encryptedToken(value) {
  if (!value) return null;
  const keyMaterial = oauthTokenEncryptionKeyMaterial();
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
  if (typeof record === "string") return record;
  if (!record?.value || !record?.iv || !record?.tag) return "";
  const keyMaterial = oauthTokenEncryptionKeyMaterial();
  const key = crypto.createHash("sha256").update(keyMaterial).digest();
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.value, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return "";
  }
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

async function tiktokApi(pathname, params = {}, accessToken = "", options = {}) {
  const url = new URL(`https://open.tiktokapis.com${pathname}`);
  const method = options.method || "GET";
  for (const [key, value] of Object.entries(params)) {
    if (method === "GET" && value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(method === "POST" ? { "Content-Type": "application/json; charset=UTF-8" } : {})
    },
    body: method === "POST" ? JSON.stringify(params) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body.error && body.error.code && body.error.code !== "ok")) {
    const message = body.error?.message || body.error_description || body.error || `TikTok API ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function tiktokUserInfoFields(scopeString = "") {
  const scopes = new Set(String(scopeString || "").split(/[,\s]+/).filter(Boolean));
  const fields = ["open_id", "union_id", "avatar_url", "display_name"];
  if (scopes.has("user.info.profile")) {
    fields.push("bio_description", "profile_deep_link", "is_verified", "username");
  }
  if (scopes.has("user.info.stats")) {
    fields.push("follower_count", "following_count", "likes_count", "video_count");
  }
  return fields;
}

async function pinterestApi(pathname, params = {}, accessToken = "", options = {}) {
  const url = new URL(`https://api.pinterest.com/v5${pathname}`);
  const method = options.method || "GET";
  for (const [key, value] of Object.entries(params)) {
    if (method === "GET" && value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(method !== "GET" ? { "Content-Type": "application/json; charset=UTF-8" } : {})
    },
    body: method !== "GET" ? JSON.stringify(params) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error || body.code) {
    const message = body.message || body.error?.message || body.error || `Pinterest API ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function etsyApi(pathname, params = {}, accessToken = "", options = {}) {
  const url = new URL(`https://api.etsy.com/v3${pathname}`);
  const method = options.method || "GET";
  for (const [key, value] of Object.entries(params)) {
    if (method === "GET" && value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      "x-api-key": [etsyClientId, etsyClientSecret].filter(Boolean).join(":"),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(method !== "GET" ? { "Content-Type": "application/json; charset=UTF-8" } : {})
    },
    body: method !== "GET" ? JSON.stringify(params) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const message = body.error_description || body.error?.message || body.message || body.error || `Etsy API ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function twitchApi(pathname, params = {}, accessToken = "", options = {}) {
  const url = new URL(`https://api.twitch.tv/helix${pathname}`);
  const method = options.method || "GET";
  for (const [key, value] of Object.entries(params)) {
    if (method === "GET" && value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      "Client-Id": twitchClientId,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(method !== "GET" ? { "Content-Type": "application/json; charset=UTF-8" } : {})
    },
    body: method !== "GET" ? JSON.stringify(params) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const message = body.message || body.error_description || body.error || `Twitch API ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function canvaApi(pathname, params = {}, accessToken = "", options = {}) {
  const url = new URL(`https://api.canva.com/rest/v1${pathname}`);
  const method = options.method || "GET";
  for (const [key, value] of Object.entries(params)) {
    if (method === "GET" && value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(method !== "GET" ? { "Content-Type": options.contentType || "application/json; charset=UTF-8" } : {})
    },
    body: method !== "GET" && options.body !== undefined ? options.body : (method !== "GET" ? JSON.stringify(params) : undefined)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const message = body.error_description || body.error?.message || body.message || body.error || `Canva API ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function googleApi(baseUrl, pathname, params = {}, accessToken = "", options = {}) {
  const url = new URL(`${baseUrl}${pathname}`);
  const method = options.method || "GET";
  for (const [key, value] of Object.entries(params)) {
    if (method === "GET" && value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const headers = {
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(method !== "GET" ? { "Content-Type": options.contentType || "application/json; charset=UTF-8" } : {})
  };
  const response = await fetch(url, {
    method,
    headers,
    body: method !== "GET" && options.body !== undefined ? options.body : (method !== "GET" ? JSON.stringify(params) : undefined)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const message = body.error_description || body.error?.message || body.error || `Google API ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function youtubeData(pathname, params = {}, accessToken = "", options = {}) {
  return googleApi("https://www.googleapis.com/youtube/v3", pathname, params, accessToken, options);
}

async function youtubeAnalytics(pathname, params = {}, accessToken = "", options = {}) {
  return googleApi("https://youtubeanalytics.googleapis.com/v2", pathname, params, accessToken, options);
}

async function exchangeMetaCode(code, redirectUri = metaRedirectUri()) {
  if (!metaAppId || !metaAppSecret) throw new Error("META_APP_ID and META_APP_SECRET are required for token exchange.");
  const shortLived = await metaGraph("/oauth/access_token", {
    client_id: metaAppId,
    client_secret: metaAppSecret,
    redirect_uri: redirectUri,
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

async function exchangeTikTokCode(code, verifier, redirectUri = tiktokRedirectUri()) {
  if (!tiktokClientKey || !tiktokClientSecret) throw new Error("TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET are required for token exchange.");
  const payload = new URLSearchParams({
    client_key: tiktokClientKey,
    client_secret: tiktokClientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });
  if (verifier) payload.set("code_verifier", verifier);
  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString()
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || token.error) throw new Error(token.error_description || token.message || token.error || `TikTok token exchange ${response.status}`);
  const grantedScope = token.scope || tiktokScopes.join(",");
  const user = await tiktokApi("/v2/user/info/", { fields: tiktokUserInfoFields(grantedScope).join(",") }, token.access_token);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    tokenType: token.token_type || "bearer",
    expiresIn: token.expires_in || null,
    refreshExpiresIn: token.refresh_expires_in || null,
    scope: grantedScope,
    user: user.data?.user || null
  };
}

async function exchangePinterestCode(code, redirectUri = pinterestRedirectUri()) {
  if (!pinterestAppId || !pinterestAppSecret) throw new Error("PINTEREST_APP_ID and PINTEREST_APP_SECRET are required for token exchange.");
  const payload = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri
  });
  const response = await fetch("https://api.pinterest.com/v5/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${pinterestAppId}:${pinterestAppSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: payload.toString()
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || token.error) throw new Error(token.error_description || token.message || token.error || `Pinterest token exchange ${response.status}`);
  const user = await pinterestApi("/user_account", {}, token.access_token);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    tokenType: token.token_type || "bearer",
    expiresIn: token.expires_in || null,
    refreshExpiresIn: token.refresh_token_expires_in || null,
    scope: token.scope || pinterestScopes.join(","),
    user
  };
}

function etsyUserIdFromAccessToken(accessToken = "") {
  const [prefix] = String(accessToken || "").split(".");
  return /^\d+$/.test(prefix) ? prefix : "";
}

async function exchangeEtsyCode(code, verifier, redirectUri = etsyRedirectUri()) {
  if (!etsyClientId) throw new Error("ETSY_CLIENT_ID is required for token exchange.");
  const payload = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: etsyClientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier
  });
  const response = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString()
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || token.error) throw new Error(token.error_description || token.message || token.error || `Etsy token exchange ${response.status}`);
  const userId = etsyUserIdFromAccessToken(token.access_token);
  const user = userId ? await etsyApi(`/application/users/${userId}`, {}, token.access_token).catch(() => ({ user_id: userId })) : null;
  const shops = userId ? await etsyApi(`/application/users/${userId}/shops`, {}, token.access_token).catch(() => null) : null;
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    tokenType: token.token_type || "Bearer",
    expiresIn: token.expires_in || null,
    scope: token.scope || etsyScopes.join(" "),
    userId,
    user,
    shops
  };
}

async function exchangeTwitchCode(code, redirectUri = twitchRedirectUri()) {
  if (!twitchClientId || !twitchClientSecret) throw new Error("TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are required for token exchange.");
  const payload = new URLSearchParams({
    client_id: twitchClientId,
    client_secret: twitchClientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString()
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || token.error) throw new Error(token.message || token.error_description || token.error || `Twitch token exchange ${response.status}`);
  const users = await twitchApi("/users", {}, token.access_token);
  const user = users.data?.[0] || null;
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    tokenType: token.token_type || "bearer",
    expiresIn: token.expires_in || null,
    scope: Array.isArray(token.scope) ? token.scope.join(" ") : token.scope || twitchScopes.join(" "),
    user
  };
}

async function exchangeCanvaCode(code, verifier, redirectUri = canvaRedirectUri()) {
  if (!canvaClientId || !canvaClientSecret) throw new Error("CANVA_CLIENT_ID and CANVA_CLIENT_SECRET are required for token exchange.");
  const payload = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri
  });
  const response = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${canvaClientId}:${canvaClientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: payload.toString()
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || token.error) throw new Error(token.error_description || token.message || token.error || `Canva token exchange ${response.status}`);
  const user = await canvaApi("/users/me/profile", {}, token.access_token).catch(() => null);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    tokenType: token.token_type || "Bearer",
    expiresIn: token.expires_in || null,
    scope: token.scope || canvaScopes.join(" "),
    user
  };
}

async function exchangeGoogleCode(code, redirectUri = youtubeRedirectUri()) {
  if (!googleClientId || !googleClientSecret) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for token exchange.");
  const payload = new URLSearchParams({
    code,
    client_id: googleClientId,
    client_secret: googleClientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString()
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || token.error) throw new Error(token.error_description || token.error || `Google token exchange ${response.status}`);
  const channels = await youtubeData("/channels", {
    part: "id,snippet,statistics,contentDetails,status",
    mine: "true",
    fields: "items(id,snippet(title,customUrl,thumbnails),statistics,contentDetails,status/privacyStatus)"
  }, token.access_token);
  const channel = channels.items?.[0] || null;
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    tokenType: token.token_type || "Bearer",
    expiresIn: token.expires_in || null,
    scope: token.scope || youtubeScopes.join(" "),
    channel
  };
}

function tokenForXAccount(account) {
  return decryptedToken(account?.credential || account?.token);
}

function refreshTokenForXAccount(account) {
  return decryptedToken(account?.refreshCredential || account?.refreshToken);
}

function tokenForTikTokAccount(account) {
  return decryptedToken(account?.credential || account?.token);
}

function refreshTokenForTikTokAccount(account) {
  return decryptedToken(account?.refreshCredential || account?.refreshToken);
}

function tokenForYouTubeAccount(account) {
  return decryptedToken(account?.credential || account?.token);
}

function refreshTokenForYouTubeAccount(account) {
  return decryptedToken(account?.refreshCredential || account?.refreshToken);
}

function tokenExpiresSoon(isoValue, skewMs = 60_000) {
  if (!isoValue) return false;
  const time = Date.parse(isoValue);
  return Number.isFinite(time) && time <= Date.now() + skewMs;
}

async function refreshXAccount(model, account, user = null) {
  if (!account) throw new Error("No X account is stored.");
  const refreshToken = refreshTokenForXAccount(account);
  if (!refreshToken) throw new Error("X refresh token is missing. Reconnect X OAuth.");
  const payload = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: xClientId
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
  if (!response.ok || token.error) {
    throw new Error(token.error_description || token.error || `X token refresh ${response.status}`);
  }
  account.credential = encryptedToken(token.access_token);
  if (token.refresh_token) account.refreshCredential = encryptedToken(token.refresh_token);
  account.tokenType = token.token_type || account.tokenType || "bearer";
  account.tokenExpiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;
  account.scopes = String(token.scope || account.scopes?.join(" ") || "").split(/\s+/).filter(Boolean);
  account.status = "connected";
  account.connectedAt = account.connectedAt || new Date().toISOString();
  account.connectionEvidence = "X access token refreshed server-side.";
  await saveModelForUser(model, user);
  return account;
}

async function refreshYouTubeAccount(model, account) {
  if (!account) throw new Error("No YouTube account is stored.");
  const refreshToken = refreshTokenForYouTubeAccount(account);
  if (!refreshToken) throw new Error("YouTube refresh token is missing. Reconnect Google OAuth with offline access.");
  const payload = new URLSearchParams({
    client_id: googleClientId,
    client_secret: googleClientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString()
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || token.error) throw new Error(token.error_description || token.error || `YouTube token refresh ${response.status}`);
  account.credential = encryptedToken(token.access_token);
  account.tokenType = token.token_type || account.tokenType || "Bearer";
  account.tokenExpiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;
  account.scopes = String(token.scope || account.scopes?.join(" ") || "").split(/\s+/).filter(Boolean);
  account.status = "connected";
  account.connectedAt = account.connectedAt || new Date().toISOString();
  account.connectionEvidence = "YouTube access token refreshed server-side.";
  await saveModel(model);
  return account;
}

async function usableXAccount(model, options = {}) {
  const account = (model.connectedAccounts || []).find(item => item.platform === "x" && (!options.user?.id || ownedByUser(item, options.user.id)));
  if (!account) return null;
  if (tokenExpiresSoon(account.tokenExpiresAt) || !tokenForXAccount(account)) {
    if (!options.refresh) return account;
    return refreshXAccount(model, account, options.user || null);
  }
  return account;
}

async function usableYouTubeAccount(model, options = {}) {
  const account = (model.connectedAccounts || []).find(item => item.platform === "youtube");
  if (!account) return null;
  if (!isRealConnectedAccount(account) || !hasStoredToken(account)) return account;
  if (tokenExpiresSoon(account.tokenExpiresAt) || !tokenForYouTubeAccount(account)) {
    if (!options.refresh) return account;
    return refreshYouTubeAccount(model, account);
  }
  return account;
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
  const ownerUserId = patch.ownerUserId || patch.createdBy || "";
  const sameOwner = item => !ownerUserId || ownedByUser(item, ownerUserId) || !hasOwnerMarker(item);
  let account = model.connectedAccounts.find(item => item.id === patch.id && sameOwner(item));
  if (!account && patch.platform) {
    account = model.connectedAccounts.find(item => item.platform === patch.platform && item.oauthProvider === patch.oauthProvider && item.providerAccountId === patch.providerAccountId && sameOwner(item));
  }
  if (!account && patch.platform && !patch.providerAccountId) {
    account = model.connectedAccounts.find(item => item.platform === patch.platform && sameOwner(item));
  }
  if (!account) {
    const idTakenByOtherOwner = patch.id && ownerUserId && model.connectedAccounts.some(item => item.id === patch.id && !sameOwner(item));
    account = { id: idTakenByOtherOwner ? `${patch.id}-${ownerUserId}` : patch.id || uid("acct"), platform: patch.platform, name: patch.name || patch.platform, handle: "", status: "not connected", connectedAt: null };
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
  const xDisplayName = account.platform === "x" ? (account.displayName || account.name || account.handle || "") : account.displayName;
  const tiktokDisplayName = account.platform === "tiktok"
    ? (account.displayName || account.handle || account.profile?.display_name || account.name || "")
    : account.displayName;
  return {
    ...safe,
    name: account.platform === "x" ? "X" : account.platform === "tiktok" ? "TikTok" : account.name,
    displayName: account.platform === "x" ? xDisplayName : account.platform === "tiktok" ? tiktokDisplayName : account.displayName,
    connected: isRealConnectedAccount(account),
    tokenStored: Boolean(credential || token || accessToken || refreshToken)
  };
}

function visibleConnectedAccounts(model) {
  const accounts = model.connectedAccounts || [];
  const realPlatforms = new Set(accounts.filter(isRealConnectedAccount).map(account => account.platform));
  return accounts.filter(account => {
    if (hiddenAccountPlaceholderPlatforms.has(account.platform) && !isRealConnectedAccount(account)) return false;
    if (account.platform === "meta") return true;
    if (!isRealConnectedAccount(account) && realPlatforms.has(account.platform)) return false;
    return true;
  });
}

function publicAppUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || "Owner",
    admin: isAdminUser(user),
    createdAt: user.createdAt || null,
    lastLoginAt: user.lastLoginAt || user.loggedInAt || null,
    entitlement: publicEntitlement(user)
  };
}

function publicDeviceSession(device) {
  if (!device) return null;
  const { sessionTokenHash, refreshCredential, refreshToken, accessToken, token, ...safe } = device;
  return {
    ...safe,
    trusted: device.trusted !== false,
    active: !device.revokedAt
  };
}

function publicDeviceSessions(model, userId = "") {
  return (model.deviceSessions || [])
    .filter(device => !userId || device.userId === userId)
    .map(publicDeviceSession)
    .sort((a, b) => Date.parse(b.lastSeenAt || b.createdAt || "") - Date.parse(a.lastSeenAt || a.createdAt || ""));
}

function detectDeviceKind(input = {}) {
  const hinted = String(input.deviceKind || input.kind || "").toLowerCase();
  if (["phone", "tablet", "laptop", "desktop"].includes(hinted)) return hinted;
  const ua = String(input.userAgent || "").toLowerCase();
  if (/iphone|android.*mobile|windows phone/.test(ua)) return "phone";
  if (/ipad|tablet|android/.test(ua)) return "tablet";
  if (/macintosh|windows|linux/.test(ua)) return "laptop";
  return "device";
}

function accountSessionResponse(model, user, device, token = "") {
  return {
    ok: true,
    user: publicAppUser(user),
    workspace: workspaceForUser(model, user),
    session: {
      token,
      deviceId: device.deviceId,
      expiresAt: device.expiresAt,
      trusted: device.trusted !== false
    },
    entitlement: publicEntitlement(user),
    device: publicDeviceSession(device),
    devices: publicDeviceSessions(model, user.id)
  };
}

function setCurrentUser(model, user) {
  model.currentUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || "Owner",
    loggedInAt: new Date().toISOString()
  };
}

function upsertAppAccount(model, input = {}) {
  model.authUsers = model.authUsers || [];
  const email = normalizeEmail(input.email) || "user@local.test";
  let user = model.authUsers.find(item => normalizeEmail(item.email) === email);
  if (!user) {
    user = {
      id: uid("user"),
      name: input.name || "Social Cues User",
      email,
      role: "Owner",
      createdAt: new Date().toISOString(),
      lastLoginAt: null
    };
    model.authUsers.push(user);
  }
  user.name = input.name || user.name || "Social Cues User";
  user.email = email;
  user.lastLoginAt = new Date().toISOString();
  return user;
}

function upsertSupabaseAppUser(model, supabaseUser, input = {}) {
  model.authUsers = model.authUsers || [];
  const email = normalizeEmail(supabaseUser?.email || input.email);
  const id = String(supabaseUser?.id || uid("user"));
  let user = model.authUsers.find(item => item.id === id) || model.authUsers.find(item => normalizeEmail(item.email) === email);
  if (!user) {
    user = {
      id,
      name: input.name || supabaseUser?.user_metadata?.name || "Social Cues User",
      email,
      role: "Owner",
      createdAt: new Date().toISOString(),
      lastLoginAt: null
    };
    model.authUsers.push(user);
  }
  user.id = id;
  user.name = input.name || user.name || supabaseUser?.user_metadata?.name || "Social Cues User";
  user.email = email;
  user.authProvider = "supabase";
  user.supabaseUserId = id;
  user.emailConfirmedAt = supabaseUser?.email_confirmed_at || supabaseUser?.confirmed_at || user.emailConfirmedAt || null;
  delete user.passwordHash;
  delete user.emailVerificationPending;
  user.lastLoginAt = new Date().toISOString();
  return user;
}

function promoFromSupabaseUser(supabaseUser = {}) {
  const metadata = {
    ...(supabaseUser.raw_user_meta_data || {}),
    ...(supabaseUser.user_metadata || {})
  };
  const promoById = promoCodeRecordById(metadata.promo_id || metadata.promoId || "");
  if (promoById) return promoById;
  const legacyCode = normalizePromoCode(metadata.promo_code || metadata.promoCode || "");
  return legacyCode ? promoCodeRecord(legacyCode) : null;
}

async function createAppAccount(model, input = {}) {
  const password = normalizePassword(input.password);
  const issue = passwordError(password);
  if (issue) return { ok: false, status: 400, error: issue };
  const enteredPromoCode = normalizePromoCode(input.promoCode);
  const promo = enteredPromoCode ? promoCodeRecord(enteredPromoCode) : null;
  if (enteredPromoCode && (!promo || promo.active === false)) {
    return { ok: false, status: 400, error: "That Social Cues promo code is not active." };
  }
  if (!promo && !publicSignupEnabled) {
    return { ok: false, status: 403, error: "Account creation currently requires an approved Social Cues invite code." };
  }
  if (supabaseAuthEnabled()) {
    let auth;
    try {
      auth = await createSupabasePasswordUser(input);
    } catch (error) {
      const status = /rate limit|too many/i.test(error.message) ? 429 : /invalid|email|password/i.test(error.message) ? 400 : 502;
      return { ok: false, status, error: `Supabase Auth signup failed: ${error.message}` };
    }
    if (auth?.ok === false) return auth;
    if (auth?.needsEmailVerification) {
      return {
        ok: false,
        status: 202,
        requiresEmailVerification: true,
        email: normalizeEmail(input.email),
        promoPending: Boolean(promo),
        error: promo
          ? "Check your email to verify this Social Cues account. Your promo code will apply after verification and login."
          : "Check your email to verify this Social Cues account, then log in."
      };
    }
    const user = upsertSupabaseAppUser(model, auth.user, input);
    applyPromoEntitlement(user, promo || promoFromSupabaseUser(auth.user), input);
    applyPaidEntitlementForEmail(model, user.email);
    return { ok: true, user, providerSession: auth };
  }
  model.authUsers = model.authUsers || [];
  const email = normalizeEmail(input.email);
  if (!email || !email.includes("@")) return { ok: false, status: 400, error: "Enter a valid email address." };
  let user = model.authUsers.find(item => normalizeEmail(item.email) === email);
  if (user?.passwordHash) return { ok: false, status: 409, error: "That Social Cues account already exists. Use Log in on this device." };
  if (!user) {
    user = {
      id: uid("user"),
      name: input.name || "Social Cues User",
      email,
      role: "Owner",
      createdAt: new Date().toISOString(),
      lastLoginAt: null
    };
    model.authUsers.push(user);
  }
  user.name = input.name || user.name || "Social Cues User";
  user.email = email;
  user.passwordHash = hashPassword(password);
  user.passwordSetAt = new Date().toISOString();
  user.lastLoginAt = new Date().toISOString();
  applyPromoEntitlement(user, promo, input);
  applyPaidEntitlementForEmail(model, user.email);
  return { ok: true, user };
}

async function loginAppAccount(model, input = {}) {
  const email = normalizeEmail(input.email);
  const password = normalizePassword(input.password);
  if (supabaseAuthEnabled()) {
    try {
      const auth = await signInWithSupabasePassword(email, password);
      const user = upsertSupabaseAppUser(model, auth.user, input);
      applyPromoEntitlement(user, promoFromSupabaseUser(auth.user), input);
      applyPaidEntitlementForEmail(model, user.email);
      return { ok: true, user, providerSession: auth };
    } catch {
      const user = (model.authUsers || []).find(item => normalizeEmail(item.email) === email);
      if (user?.authProvider === "promo-local" || user?.emailVerificationPending) {
        return { ok: false, status: 403, error: "Verify this email address before opening Social Cues." };
      }
      if (user?.passwordHash && verifyPassword(password, user.passwordHash)) {
        user.name = input.name || user.name || "Social Cues User";
        user.lastLoginAt = new Date().toISOString();
        applyPaidEntitlementForEmail(model, user.email);
        return { ok: true, user, providerSession: { sessionProvider: "local-promo" } };
      }
      return { ok: false, status: 401, error: "Email or password did not match a Social Cues account." };
    }
  }
  const user = (model.authUsers || []).find(item => normalizeEmail(item.email) === email);
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    return { ok: false, status: 401, error: "Email or password did not match a Social Cues account." };
  }
  user.name = input.name || user.name || "Social Cues User";
  user.lastLoginAt = new Date().toISOString();
  applyPaidEntitlementForEmail(model, user.email);
  return { ok: true, user };
}

function upsertDeviceSession(model, user, input = {}, token = crypto.randomBytes(32).toString("base64url"), providerSession = null) {
  model.deviceSessions = model.deviceSessions || [];
  const deviceId = String(input.deviceId || uid("device"));
  let device = model.deviceSessions.find(item => item.userId === user.id && item.deviceId === deviceId);
  if (!device) {
    device = {
      id: uid("session"),
      userId: user.id,
      deviceId,
      createdAt: new Date().toISOString(),
      loginCount: 0
    };
    model.deviceSessions.push(device);
  }
  device.name = input.deviceName || input.name || device.name || "This device";
  device.kind = detectDeviceKind(input);
  device.userAgent = input.userAgent || device.userAgent || "";
  device.platform = input.platform || device.platform || "";
  device.language = input.language || device.language || "";
  device.screen = input.screen || device.screen || "";
  device.timeZone = input.timeZone || device.timeZone || "";
  device.trusted = input.trusted !== false;
  device.revokedAt = null;
  device.lastSeenAt = new Date().toISOString();
  device.expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  device.loginCount = Number(device.loginCount || 0) + 1;
  device.sessionTokenHash = hashSecret(token);
  if (providerSession?.refresh_token) device.refreshCredential = encryptedToken(providerSession.refresh_token);
  if (providerSession?.expires_in) device.tokenExpiresAt = new Date(Date.now() + Number(providerSession.expires_in) * 1000).toISOString();
  device.sessionProvider = providerSession?.sessionProvider || (providerSession?.access_token ? "supabase" : device.sessionProvider || "local");
  return device;
}

async function sessionFromRequest(model, req) {
  const context = requestSecurityContext.getStore();
  if (context?.sessionResolved) return context.session || null;
  const token = bearerToken(req);
  if (!token) return null;
  const tokenHash = hashSecret(token);
  const device = (model.deviceSessions || []).find(item => item.sessionTokenHash === tokenHash && !item.revokedAt);
  if (!device) return null;
  if (device.expiresAt && Date.parse(device.expiresAt) < Date.now()) return null;
  let user = (model.authUsers || []).find(item => item.id === device.userId);
  if (!user) return null;
  if (supabaseAuthEnabled() && device.sessionProvider !== "local-promo") {
    try {
      const supabaseUser = await getSupabaseAuthUser(token);
      if (!supabaseUser?.id || String(supabaseUser.id) !== String(user.supabaseUserId || user.id)) return null;
      user = upsertSupabaseAppUser(model, supabaseUser, user);
    } catch {
      const refreshToken = decryptedToken(device.refreshCredential);
      if (!refreshToken) {
        return null;
      }
      try {
        const refreshed = await refreshSupabasePasswordSession(refreshToken);
        const nextToken = refreshed.access_token || "";
        const supabaseUser = refreshed.user || (nextToken ? await getSupabaseAuthUser(nextToken) : null);
        if (!nextToken || !supabaseUser?.id || String(supabaseUser.id) !== String(user.supabaseUserId || user.id)) return null;
        device.sessionTokenHash = hashSecret(nextToken);
        if (refreshed.refresh_token) device.refreshCredential = encryptedToken(refreshed.refresh_token);
        if (refreshed.expires_in) device.tokenExpiresAt = new Date(Date.now() + Number(refreshed.expires_in) * 1000).toISOString();
        device.lastSeenAt = new Date().toISOString();
        user = upsertSupabaseAppUser(model, supabaseUser, user);
        return { user, device, token: nextToken, refreshed: true };
      } catch {
        return null;
      }
    }
  }
  return { user, device, token };
}

function hasActiveAppAccess(user = {}) {
  return Boolean(publicEntitlement(user)?.active);
}

function appAccessRequiredResponse(res, status = 402) {
  return json(res, status, {
    ok: false,
    error: "Buy Social Cues or use an active approved promo entitlement before using the app.",
    accessRequired: true,
    checkoutPath: "/api/billing/checkout",
    portalPath: "/portal"
  });
}

async function entitledSessionFromRequest(model, req) {
  const session = await sessionFromRequest(model, req);
  if (!session?.user) return null;
  return hasActiveAppAccess(session.user) ? session : null;
}

async function hostedWriteRequiresSession(req, model) {
  return entitledSessionFromRequest(model, req);
}

function isAdminUser(user = {}) {
  return adminEmails.has(normalizeEmail(user.email));
}

function requestCredentialSource(req) {
  if (/^Bearer\s+\S+/i.test(String(req?.headers?.authorization || ""))) return "bearer";
  if (/(?:^|;\s*)sc_session=/.test(String(req?.headers?.cookie || ""))) return "cookie";
  return "none";
}

function requestClientKey(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req?.headers?.["x-real-ip"] || req?.socket?.remoteAddress || "unknown");
}

function takeRateLimit(key, limit, windowMs) {
  const now = Date.now();
  if (requestRateBuckets.size > 5000) {
    for (const [bucketKey, bucket] of requestRateBuckets) {
      if (bucket.resetAt <= now) requestRateBuckets.delete(bucketKey);
    }
  }
  const current = requestRateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    requestRateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: Math.max(0, limit - 1), resetAt: now + windowMs };
  }
  current.count += 1;
  return { allowed: current.count <= limit, remaining: Math.max(0, limit - current.count), resetAt: current.resetAt };
}

async function takeRequestRateLimit(req, pathname, limit, windowMs) {
  const local = takeRateLimit(`${requestClientKey(req)}:${pathname}`, limit, windowMs);
  const durable = ["/api/auth/login", "/api/auth/signup", "/api/observability/client-error"].includes(pathname)
    || /\/(publish|upload|generate|analyze|actions)(?:\/|$)/.test(pathname);
  if (!local.allowed || !supabaseEnabled || !durable) return local;
  try {
    const result = await supabaseRequest("/rpc/social_cues_claim_auth_rate_limit", {
      method: "POST",
      body: JSON.stringify({
        p_action: pathname,
        p_identity_hash: hashSecret(`${pathname}:${requestClientKey(req)}`),
        p_window_seconds: Math.max(1, Math.ceil(windowMs / 1000)),
        p_max_attempts: limit
      })
    });
    const row = Array.isArray(result) ? result[0] : result;
    if (!row || typeof row.allowed !== "boolean") throw new Error("Supabase auth rate limiter returned no decision.");
    const retryAfterSeconds = Math.max(0, Number(row.retry_after_seconds || 0));
    return {
      allowed: row.allowed,
      remaining: Math.max(0, Number(row.remaining || 0)),
      resetAt: Date.now() + retryAfterSeconds * 1000,
      durable: true
    };
  } catch (error) {
    captureSentryError(error, { surface: "security", operation: "auth-rate-limit", route: pathname });
    return { allowed: false, remaining: 0, resetAt: Date.now() + 30_000, unavailable: true };
  }
}

function sameOriginRequest(req) {
  const origin = String(req?.headers?.origin || "").trim();
  if (!origin) return requestCredentialSource(req) !== "cookie" || runtimeMode !== "vercel";
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  const forwardedHost = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "").split(",")[0].trim();
  const requestOrigin = forwardedHost ? `${forwardedProto}://${forwardedHost}` : "";
  const allowed = new Set([corsOrigin, new URL(brandHomeUrl).origin, requestOrigin].filter(Boolean));
  return allowed.has(origin);
}

const publicApiRoutes = new Set([
  "GET /api/observability/config",
  "POST /api/observability/client-error",
  "POST /api/auth/signup",
  "POST /api/auth/login",
  "GET /api/portal/readiness"
]);

const sessionApiRoutes = new Set([
  "GET /api/auth/session",
  "POST /api/auth/device/heartbeat",
  "GET /api/devices",
  "GET /api/auth/entitlement",
  "POST /api/auth/logout",
  "POST /api/billing/checkout"
]);

const adminApiRoutes = new Set([
  "GET /api/observability/status",
  "GET /api/oauth/tiktok/diagnostic",
  "GET /api/oauth/tiktok/debug-start",
  "GET /api/meta/diagnostic-agent",
  "GET /api/supabase/status",
  "GET /api/auth/readiness",
  "GET /api/auth/smtp/readiness",
  "GET /api/resend/readiness",
  "GET /api/resend/status",
  "GET /api/security/audit"
]);

function externalApiPolicy(pathname, method) {
  if (method === "GET" && /^\/api\/oauth\/[a-z0-9-]+\/callback$/.test(pathname)) return "oauth-state";
  const routeKey = `${method} ${pathname}`;
  if ([
    "GET /api/meta/data-deletion",
    "POST /api/meta/data-deletion",
    "GET /api/meta/data-deletion/status",
    "GET /api/meta/webhook",
    "POST /api/meta/webhook",
    "POST /api/billing/webhook"
  ].includes(routeKey)) return "signed-external";
  return "";
}

function apiPermissionFor(pathname, method) {
  const routeKey = `${method} ${pathname}`;
  if (publicApiRoutes.has(routeKey)) return "public";
  const external = externalApiPolicy(pathname, method);
  if (external) return external;
  if (sessionApiRoutes.has(routeKey)) return "session";
  if (adminApiRoutes.has(routeKey)) return "admin";
  return "active-workspace";
}

function workspaceWriteAllowed(user = {}) {
  if (isAdminUser(user)) return true;
  return ["owner", "operator", "editor"].includes(String(user.role || "owner").trim().toLowerCase());
}

async function authorizeApiRequest(req, res, url) {
  if (!url.pathname.startsWith("/api/")) return true;
  const context = requestSecurityContext.getStore();
  const permission = apiPermissionFor(url.pathname, req.method);
  if (context) context.permission = permission;

  const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (unsafeMethod && !["oauth-state", "signed-external"].includes(permission) && !sameOriginRequest(req)) {
    return Boolean(json(res, 403, { ok: false, error: "Cross-origin request rejected." }));
  }

  const rateProfile = ["/api/auth/login", "/api/auth/signup"].includes(url.pathname)
    ? { limit: 10, windowMs: 15 * 60 * 1000 }
    : url.pathname === "/api/observability/client-error"
      ? { limit: 30, windowMs: 60 * 1000 }
    : /\/(publish|upload|generate|analyze|actions)(?:\/|$)/.test(url.pathname)
      ? { limit: 60, windowMs: 60 * 1000 }
      : { limit: 300, windowMs: 60 * 1000 };
  const rate = await takeRequestRateLimit(req, url.pathname, rateProfile.limit, rateProfile.windowMs);
  if (rate.unavailable) {
    return Boolean(json(res, 503, { ok: false, error: "Authentication protection is temporarily unavailable. Try again shortly." }));
  }
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))));
    return Boolean(json(res, 429, { ok: false, error: "Too many requests. Try again shortly." }));
  }

  if (["public", "oauth-state", "signed-external"].includes(permission)) return true;

  const sharedModel = await getSharedModel();
  const session = await sessionFromRequest(sharedModel, req);
  if (context) {
    context.session = session;
    context.sessionResolved = true;
    context.workspaceScoped = permission === "active-workspace";
  }
  if (!session?.user) {
    json(res, 401, { ok: false, error: "Authentication required." });
    return false;
  }
  if (session.refreshed) {
    await saveSharedModel(sharedModel);
    setCookie(res, sessionCookieValue(session.token, session.device.expiresAt));
  }
  if (permission === "admin" && !isAdminUser(session.user)) {
    json(res, 403, { ok: false, error: "Administrator permission required." });
    return false;
  }
  if (permission === "active-workspace" && !hasActiveAppAccess(session.user)) {
    appAccessRequiredResponse(res);
    return false;
  }
  if (permission === "active-workspace" && unsafeMethod && !workspaceWriteAllowed(session.user)) {
    json(res, 403, { ok: false, error: "Workspace write permission required." });
    return false;
  }
  return true;
}

function workspaceIdForUser(user = {}) {
  return String(user.workspaceId || user.supabaseUserId || user.id || "local-dev-workspace");
}

function workspaceForUser(model, user = {}) {
  const workspaceId = workspaceIdForUser(user);
  const workspace = (model.workspaces || []).find(item => item.id === workspaceId);
  return workspace || {
    id: workspaceId,
    name: model.workspace?.name || "Social Cues",
    owner: user.name || model.workspace?.owner || "Workspace Owner",
    ownerUserId: user.id || "",
    ownerEmail: user.email || "",
    createdAt: new Date().toISOString()
  };
}

function ownedByUser(item, userId = "") {
  if (!item || !userId) return false;
  const owner = item.ownerUserId || item.workspaceOwnerId || item.createdBy || item.userId || "";
  return String(owner) === String(userId);
}

function hasOwnerMarker(item) {
  return Boolean(item && (item.ownerUserId || item.workspaceOwnerId || item.createdBy || item.userId || item.workspaceId));
}

function stampWorkspaceOwnership(item, user = {}, workspaceId = workspaceIdForUser(user)) {
  if (!item || typeof item !== "object") return item;
  item.ownerUserId = user.id || "alpha";
  item.workspaceId = workspaceId;
  return item;
}

function workspaceSeedItemId(item, key, index, user = {}) {
  const base = item?.id || `${key}-seed-${index + 1}`;
  return `${base}-${user.id || "alpha"}`;
}

function cloneWorkspaceSeedItem(item, key, index, user = {}, workspaceId = workspaceIdForUser(user)) {
  const clone = JSON.parse(JSON.stringify(item || {}));
  clone.id = workspaceSeedItemId(item, key, index, user);
  clone.ownerUserId = user.id || "alpha";
  clone.workspaceId = workspaceId;
  clone.seededFrom = item?.id || `${key}-seed-${index + 1}`;
  clone.seededAt = clone.seededAt || new Date().toISOString();
  return clone;
}

async function ensureWorkspaceBootstrap(model, user = {}) {
  if (!model || !user?.id) return false;
  if (model.workspaceModel?.clientIsolated) return false;
  const seed = await getSeedModel();
  const workspaceId = workspaceIdForUser(user);
  let changed = false;
  for (const key of workspaceScopedCollectionKeys) {
    model[key] = Array.isArray(model[key]) ? model[key] : [];
    if (workspaceOwnedItems(model, key, user).length) continue;
    const templates = Array.isArray(seed[key]) ? seed[key] : [];
    if (!templates.length) continue;
    model[key].push(...templates.map((item, index) => cloneWorkspaceSeedItem(item, key, index, user, workspaceId)));
    changed = true;
  }
  const ownedCampaigns = workspaceOwnedItems(model, "campaigns", user);
  if (ownedCampaigns.length && !ownedCampaigns.some(item => item.id === model.activeCampaignId)) {
    model.activeCampaignId = ownedCampaigns[0].id;
    changed = true;
  }
  return changed;
}

function ensureUserWorkspace(model, user = {}, input = {}) {
  if (!model || !user?.id) return null;
  model.workspaces = Array.isArray(model.workspaces) ? model.workspaces : [];
  const workspaceId = workspaceIdForUser(user);
  user.workspaceId = workspaceId;
  let workspace = model.workspaces.find(item => item.id === workspaceId);
  if (!workspace) {
    workspace = {
      id: workspaceId,
      name: input.workspaceName || model.workspace?.name || "Social Cues",
      owner: user.name || model.workspace?.owner || "Workspace Owner",
      ownerUserId: user.id,
      ownerEmail: user.email || "",
      createdAt: new Date().toISOString()
    };
    model.workspaces.push(workspace);
  }
  workspace.name = input.workspaceName || workspace.name || model.workspace?.name || "Social Cues";
  workspace.owner = user.name || workspace.owner || "Workspace Owner";
  workspace.ownerUserId = user.id;
  workspace.ownerEmail = user.email || workspace.ownerEmail || "";
  workspace.updatedAt = new Date().toISOString();
  return workspace;
}

function ownedCollection(model, key, user = {}) {
  const userId = user?.id || "";
  if (!Array.isArray(model?.[key])) return [];
  if (!userId) return runtimeMode === "vercel" ? [] : model[key];
  return model[key].filter(item => ownedByUser(item, userId));
}

function publicBilling(billing = {}) {
  const safe = JSON.parse(JSON.stringify(billing || {}));
  delete safe.paidEmails;
  delete safe.webhookEvents;
  delete safe.stripeEvents;
  delete safe.lastStripeCheckout;
  return safe;
}

function publicModel(model, session = null) {
  const safe = JSON.parse(JSON.stringify(model || {}));
  const sessionUser = session?.user || null;
  if (sessionUser) {
    const userId = sessionUser.id;
    safe.currentUser = publicAppUser(sessionUser);
    safe.workspace = workspaceForUser(model, sessionUser);
    safe.workspaces = [safe.workspace];
    for (const key of workspaceScopedCollectionKeys) {
      safe[key] = ownedCollection(model, key, sessionUser);
    }
    if (Array.isArray(safe.campaigns) && safe.campaigns.length) {
      safe.activeCampaignId = safe.campaigns.some(item => item.id === safe.activeCampaignId) ? safe.activeCampaignId : safe.campaigns[0].id;
    }
    if (Array.isArray(model.connectedAccounts)) {
      const visible = visibleConnectedAccounts(model).filter(account => ownedByUser(account, userId));
      safe.connectedAccounts = visible.map(publicAccount);
    }
    safe.deviceSessions = publicDeviceSessions(model, userId);
    safe.billing = publicBilling(safe.billing);
    safe.analytics = buildGrowthAnalytics(safe);
    if (!safe.connectedAccounts?.some(account => ["meta", "facebook", "instagram"].includes(account.platform))) {
      safe.metaConnection = null;
      safe.metaHealth = null;
    }
  }
  if (Array.isArray(safe.connectedAccounts)) {
    const sourceAccounts = sessionUser
      ? safe.connectedAccounts
      : visibleConnectedAccounts(model);
    safe.connectedAccounts = sourceAccounts.map(publicAccount);
  }
  if (safe.currentUser) safe.currentUser = publicAppUser(safe.currentUser);
  delete safe.authUsers;
  if (Array.isArray(safe.deviceSessions)) {
    safe.deviceSessions = publicDeviceSessions(model, sessionUser?.id || safe.currentUser?.id || "");
  }
  if (safe.billing) safe.billing = publicBilling(safe.billing);
  if (safe.metaHealth && Object.prototype.hasOwnProperty.call(safe.metaHealth, "token")) {
    safe.metaHealth.tokenHealth = safe.metaHealth.token;
    delete safe.metaHealth.token;
  }
  if (Array.isArray(safe.metaHealth?.assetSync?.synced)) {
    safe.metaHealth.assetSync.synced = safe.metaHealth.assetSync.synced.map(publicAccount);
  }
  delete safe.oauthStates;
  delete safe.metaDeletionRequests;
  delete safe.metaWebhookEvents;
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

function mergePublicAccountUpdate(incoming, existing) {
  const merged = { ...incoming };
  for (const key of ["credential", "refreshCredential", "token", "accessToken", "refreshToken", "oauthCode", "tokenType", "tokenExpiresAt"]) {
    delete merged[key];
    if (existing?.[key]) merged[key] = existing[key];
  }
  for (const key of ["providerAccountId", "oauthProvider", "scopes"]) delete merged[key];
  if (existing?.providerAccountId) merged.providerAccountId = existing.providerAccountId;
  if (existing?.oauthProvider) merged.oauthProvider = existing.oauthProvider;
  if (existing?.scopes?.length) merged.scopes = existing.scopes;
  return merged;
}

function mergeOwnedArray(key, merged, existing, user, workspaceId) {
  if (!Array.isArray(merged[key])) return;
  const incomingOwned = merged[key].map(item => stampWorkspaceOwnership(item, user, workspaceId));
  const existingOther = Array.isArray(existing[key])
    ? existing[key].filter(item => !ownedByUser(item, user.id))
    : [];
  merged[key] = [...incomingOwned, ...existingOther];
}

function mergePublicModelUpdate(incoming, existing, user = null) {
  const merged = JSON.parse(JSON.stringify(incoming || {}));
  const workspaceId = user ? workspaceIdForUser(user) : "";
  if (Array.isArray(merged.connectedAccounts)) {
    const existingAccounts = existing.connectedAccounts || [];
    const existingOwnedAccounts = user ? existingAccounts.filter(item => ownedByUser(item, user.id)) : existingAccounts;
    const incomingAccounts = merged.connectedAccounts.map(account => {
      const ownedAccount = user ? stampWorkspaceOwnership(account, user, workspaceId) : account;
      const match = existingOwnedAccounts.find(item => item.id === ownedAccount.id)
        || existingOwnedAccounts.find(item => item.platform === ownedAccount.platform && item.providerAccountId && item.providerAccountId === ownedAccount.providerAccountId)
        || existingOwnedAccounts.find(item => item.platform === ownedAccount.platform && !item.providerAccountId && !ownedAccount.providerAccountId);
      return mergePublicAccountUpdate(ownedAccount, match);
    });
    merged.connectedAccounts = user
      ? [
          ...incomingAccounts,
          ...existingAccounts.filter(existingAccount => !ownedByUser(existingAccount, user.id))
        ]
      : incomingAccounts;
    if (!user) {
      for (const existingAccount of existingAccounts) {
        const exists = merged.connectedAccounts.some(account => account.id === existingAccount.id);
        if (!exists && (hasStoredToken(existingAccount) || existingAccount.providerAccountId)) {
          merged.connectedAccounts.push(existingAccount);
        }
      }
    }
  }
  if (user) {
    for (const key of workspaceScopedCollectionKeys) {
      mergeOwnedArray(key, merged, existing, user, workspaceId);
    }
    merged.workspaces = existing.workspaces || [];
    const workspace = workspaceForUser(existing, user);
    const incomingWorkspace = incoming.workspace || {};
    const index = merged.workspaces.findIndex(item => item.id === workspace.id);
    const nextWorkspace = {
      ...workspace,
      name: incomingWorkspace.name || workspace.name,
      owner: user.name || workspace.owner,
      ownerUserId: user.id,
      ownerEmail: user.email || workspace.ownerEmail || "",
      updatedAt: new Date().toISOString()
    };
    if (index >= 0) merged.workspaces[index] = nextWorkspace;
    else merged.workspaces.push(nextWorkspace);
    merged.workspace = nextWorkspace;
  }
  if (existing.oauthStates && !merged.oauthStates) merged.oauthStates = existing.oauthStates;
  if (existing.metaDeletionRequests && !merged.metaDeletionRequests) merged.metaDeletionRequests = existing.metaDeletionRequests;
  if (existing.authUsers) merged.authUsers = existing.authUsers;
  if (existing.deviceSessions) merged.deviceSessions = existing.deviceSessions;
  if (user) merged.currentUser = existing.currentUser || publicAppUser(user);
  else if (existing.currentUser && !merged.currentUser) merged.currentUser = existing.currentUser;
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
        ownerUserId: options.ownerUserId,
        workspaceId: options.workspaceId,
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
          ownerUserId: options.ownerUserId,
          workspaceId: options.workspaceId,
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
  const metaUser = metaAccounts(model, "meta")
    .filter(account => !options.ownerUserId || ownedByUser(account, options.ownerUserId))
    .find(hasStoredToken);
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
  if (!token) {
    const existingPages = realMetaAccounts(model, "facebook").length;
    const existingInstagram = realMetaAccounts(model, "instagram").length;
    inspection.token = {
      valid: false,
      error: "Stored Meta credential could not be decrypted or is missing."
    };
    inspection.permissions = {
      granted: metaUser.scopes || [],
      declined: [],
      expired: [],
      error: "Reconnect Meta OAuth to refresh token health."
    };
    const existingAssets = realMetaAccounts(model).filter(account => account.platform !== "meta");
    inspection.assetSync = {
      pagesReturned: existingPages,
      instagramReturned: existingInstagram,
      synced: existingAssets,
      error: "Skipped live Meta asset sync because the user token is not usable."
    };
    inspection.businessSync = {
      businessesReturned: 0,
      businesses: [],
      error: "Skipped Business Portfolio diagnostic because the user token is not usable."
    };
    inspection.blockers.push("Stored Meta credential is present but not usable. Reconnect Meta OAuth to refresh the server-side token.");
    inspection.nextActions.push("Reconnect Meta from Social Cues so token health, Page analytics, and future publishing can use a fresh encrypted credential.");
    model.metaConnection = {
      ...(model.metaConnection || {}),
      checkedAt: inspection.checkedAt,
      tokenValid: false,
      appIdMatches: true,
      userId: model.metaConnection?.userId || metaUser.providerAccountId || null,
      userName: metaUser.name || model.metaConnection?.userName || null,
      scopes: metaUser.scopes || [],
      declinedScopes: [],
      expiredScopes: [],
      pageCount: existingPages,
      instagramCount: existingInstagram,
      businessCount: 0,
      businessDiagnosticError: inspection.businessSync.error,
      discoveredCount: 1 + inspection.assetSync.synced.length,
      warning: inspection.assetSync.error || inspection.permissions.error || inspection.token.error || null
    };
    inspection.capabilityMatrix = metaCapabilityMatrix(model);
    inspection.nextActions.push("The existing Page asset remains visible, but live API reads should treat it as stale until reauthorization refreshes credentials.");
    return inspection;
  }
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
  inspection.assetSync = await syncMetaAssetsFromToken(model, token, { scopes, ownerUserId: options.ownerUserId, workspaceId: options.workspaceId });
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
  const xAccount = accounts.find(account => account.platform === "x" && isRealConnectedAccount(account));
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
      label: "X identity",
      value: xAccount?.handle || xAccount?.name || "Not connected",
      source: "X OAuth 2.0 token exchange",
      kind: xAccount ? "live" : "blocked",
      signal: xAccount ? "X OAuth returned a user identity and Social Cues stored token evidence server-side." : "Connect X before X posting and account readouts can use a live token."
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
      source: "X OAuth 2.0 token exchange",
      status: xAccount ? "Live" : "Not connected",
      data: xAccount ? `X identity returned: ${xAccount.handle || xAccount.name || "X user"}. Scopes: ${(xAccount.scopes || []).join(", ") || "stored token scopes not listed"}.` : "No connected X token is available yet."
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
    xAccount
      ? `X is connected as ${xAccount.handle || xAccount.name || "the authenticated X user"}; Social Cues can use that identity for approved X dry-run/posting flows.`
      : "X is not connected in the current server model, so X actions remain OAuth-gated.",
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
      xConnected: Boolean(xAccount),
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

async function connectMetaAssets(model, code, redirectUri = metaRedirectUri(), owner = null) {
  const token = await exchangeMetaCode(code, redirectUri);
  const user = await metaGraph("/me", { fields: "id,name,picture" }, token.accessToken);
  const now = new Date().toISOString();
  const ownerPatch = accountOwnerPatch(owner);
  const metaUser = upsertConnectedAccount(model, {
    id: "acct-meta-user",
    platform: "meta",
    ...ownerPatch,
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

  const inspection = await inspectMetaConnection(model, ownerPatch);
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

function html(res, status, body, canonicalPath = "/") {
  const canonicalUrl = `${brandHomeUrl}${canonicalPath}`;
  const fbAppMeta = metaAppId ? `<meta property="fb:app_id" content="${metaAppId}">` : "";
  return text(res, status, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Social Cues Meta Connection</title><meta name="description" content="Social Cues helps users plan, approve, schedule, and analyze social media campaigns."><meta property="og:url" content="${canonicalUrl}"><meta property="og:type" content="website"><meta property="og:site_name" content="Social Cues"><meta property="og:title" content="Social Cues Meta Connection"><meta property="og:description" content="Social Cues helps users plan, approve, schedule, and analyze social media campaigns."><meta property="og:image" content="${brandHomeUrl}/sc-icon-512.png">${fbAppMeta}<meta name="twitter:card" content="summary"><meta name="twitter:title" content="Social Cues Meta Connection"><meta name="twitter:description" content="Social Cues helps users plan, approve, schedule, and analyze social media campaigns."><meta name="twitter:image" content="${brandHomeUrl}/sc-icon-512.png"><link rel="canonical" href="${canonicalUrl}"><link rel="icon" href="/favicon.png" type="image/png"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><style>body{font-family:Inter,Segoe UI,sans-serif;max-width:720px;margin:48px auto;padding:0 18px;line-height:1.5;background:#08080f;color:#f8fafc}a{color:#ff2d78}.box{border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:18px;background:#10131a}</style></head><body><div class="box">${body}</div></body></html>`, "text/html; charset=utf-8");
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

function brandMarkSvg(size = 36) {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 80 80" role="img" aria-label="Social Cues mark" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="80" rx="18" fill="#0f0f1a" stroke="#ff2d78" stroke-width="1" stroke-opacity=".45"/><g stroke="#ff2d78" stroke-width=".9" opacity=".28"><path d="M22 22 40 40 58 22"/><path d="M22 58 40 40 58 58"/><path d="M22 40h36"/><path d="M40 22v36"/></g><g fill="#ff2d78"><circle cx="22" cy="22" r="4" opacity=".35"/><circle cx="40" cy="22" r="4" opacity=".65"/><circle cx="58" cy="22" r="4" opacity=".25"/><circle cx="22" cy="40" r="4" opacity=".70"/><circle cx="40" cy="40" r="8"/><circle cx="58" cy="40" r="4" opacity=".50"/><circle cx="22" cy="58" r="4" opacity=".20"/><circle cx="40" cy="58" r="4" opacity=".45"/><circle cx="58" cy="58" r="4" opacity=".75"/></g></svg>`;
}

function marketingShell(title, body, canonicalPath = "/") {
  const canonicalUrl = `${brandHomeUrl}${canonicalPath === "/" ? "" : canonicalPath}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="Social Cues helps creators and operators turn ideas, approvals, media, and account signals into a working social growth system.">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="Plan, approve, schedule, analyze, and grow from one social command center.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:image" content="${brandHomeUrl}/sc-icon-512.png">
  <link rel="canonical" href="${canonicalUrl}">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/favicon.png" type="image/png">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <style>
    :root{color-scheme:dark;--void:#08080f;--grid:#0f0f1a;--deep:#1a1a2e;--signal:#ff2d78;--signal-deep:#cc0055;--ghost:rgba(255,45,120,.10);--rule:rgba(255,45,120,.18);--muted:rgba(255,255,255,.52);--text:#fff;--success:#00e5a0}
    *{box-sizing:border-box}body{margin:0;font-family:Inter,Segoe UI,Arial,sans-serif;background:linear-gradient(var(--rule) 1px,transparent 1px),linear-gradient(90deg,var(--rule) 1px,transparent 1px),radial-gradient(circle at 70% 0%,rgba(255,45,120,.16),transparent 32rem),var(--void);background-size:60px 60px,60px 60px,auto,auto;color:var(--text);line-height:1.5}a{color:inherit}.wrap{max-width:1120px;margin:0 auto;padding:0 20px}.nav{height:74px;display:flex;align-items:center;justify-content:space-between;gap:16px;background:rgba(8,8,15,.78);backdrop-filter:blur(14px)}.brand{display:flex;align-items:center;gap:12px;font-weight:900;text-decoration:none}.mark{width:38px;height:38px;flex:0 0 auto;filter:drop-shadow(0 0 18px rgba(255,45,120,.18))}.nav-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.btn{border:1px solid var(--rule);background:rgba(255,255,255,.04);color:var(--text);border-radius:6px;padding:10px 14px;font-weight:800;text-decoration:none;cursor:pointer}.btn.primary,.btn.accent{background:var(--signal);border-color:var(--signal);color:#fff}.btn:hover{border-color:var(--signal)}.hero{padding:64px 0 38px;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr);gap:26px;align-items:center}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:4px;color:var(--signal);font-weight:800}.hero h1{font-size:clamp(42px,7vw,82px);line-height:.96;margin:12px 0 18px;letter-spacing:0;font-weight:950}.lead{font-size:20px;color:var(--muted);max-width:680px}.hero-panel,.panel{background:rgba(15,15,26,.88);border:1px solid var(--rule);border-radius:8px;box-shadow:0 24px 80px rgba(0,0,0,.30);padding:20px}.hero-panel{display:grid;gap:14px}.metric{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--rule);padding:10px 0}.metric:last-child{border-bottom:0}.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;border:1px solid var(--rule);padding:6px 9px;font-size:12px;font-weight:800;background:var(--ghost);color:var(--signal)}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:18px 0 40px}.panel h3{margin:0 0 8px}.panel p{color:var(--muted);margin:0}.band{background:rgba(15,15,26,.92);border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);color:#fff;padding:34px 0;margin-top:20px}.band p{color:var(--muted)}.auth-box{display:grid;gap:10px}.field{display:grid;gap:5px}.field span{font-size:12px;text-transform:uppercase;font-weight:900;color:var(--muted)}.field input{border:1px solid var(--rule);border-radius:8px;padding:11px;font:inherit;background:rgba(255,255,255,.05);color:#fff}.notice{border:1px solid var(--rule);border-radius:8px;padding:12px;background:var(--ghost);color:rgba(255,255,255,.78)}.status-list{display:grid;gap:10px}.status-row{display:flex;justify-content:space-between;gap:12px;border:1px solid var(--rule);border-radius:8px;padding:12px;background:rgba(255,255,255,.04)}.download-list{display:grid;gap:10px}.download-list a,.download-list button{text-align:left}.footer{padding:28px 0;color:var(--muted);font-size:13px}.hidden{display:none!important}@media(max-width:820px){.hero,.grid{grid-template-columns:1fr}.nav{height:auto;padding:14px 0;align-items:flex-start}.nav-actions{justify-content:flex-end}.hero{padding-top:24px}.btn{padding:9px 11px}.status-row{display:grid}}
  </style>
</head>
<body>${body}
<script>
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.register("/sw.js").then(registration => registration.update()).catch(() => {});
  }
</script>
</body>
</html>`;
}

function landingPageHtml() {
  return marketingShell("Social Cues - Build a social system that compounds", `
  <header class="wrap nav">
    <a class="brand" href="/" aria-label="Social Cues home">${brandMarkSvg()}<span>Social Cues</span></a>
    <div class="nav-actions">
      <a class="btn" href="/portal">Log in</a>
      <a class="btn primary" href="/portal?mode=create">Create account</a>
    </div>
  </header>
  <main>
    <section class="wrap hero">
      <div>
        <div class="eyebrow">Approval-first social growth</div>
        <h1>Turn raw ideas into a working social engine.</h1>
        <p class="lead">Social Cues helps creators, founders, local operators, and agencies plan campaigns, approve posts, attach media, connect accounts, and translate platform signals into the next best move.</p>
        <div class="nav-actions" style="margin-top:22px">
          <button class="btn accent" id="startCheckout">Pay to start</button>
          <a class="btn" href="/portal">Account portal</a>
        </div>
        <p style="color:var(--muted);margin-top:12px">Payment comes first for public access. Promo testers can create an account with a code and use the portal for devices, alerts, and app links.</p>
      </div>
      <aside class="hero-panel">
        <div class="metric"><strong>Plan</strong><span class="pill">Platform-native variants</span></div>
        <div class="metric"><strong>Approve</strong><span class="pill">Manual control</span></div>
        <div class="metric"><strong>Connect</strong><span class="pill">Meta, X, YouTube, TikTok</span></div>
        <div class="metric"><strong>Analyze</strong><span class="pill">Live vs manual signals</span></div>
        <div class="metric"><strong>Scale</strong><span class="pill">Paid workspace path</span></div>
      </aside>
    </section>
    <section class="wrap grid">
      <article class="panel"><h3>One idea, many lanes</h3><p>Shape each campaign for TikTok, Instagram, Threads, YouTube, Facebook, X, and commerce without losing approval control.</p></article>
      <article class="panel"><h3>Real account truth</h3><p>The app separates login identity, managed assets, manual estimates, and live provider data so dashboards do not lie.</p></article>
      <article class="panel"><h3>Operator portal</h3><p>Customers log in to manage trusted devices, account alerts, payment/download actions, and app access from one place.</p></article>
    </section>
    <section class="band">
      <div class="wrap">
        <h2 style="margin:0 0 8px">Early access</h2>
        <p style="max-width:760px">Start with paid access or a temporary promo tester code, then use Social Cues to build the campaign proof loop. Stripe Checkout is live; subscription pricing will settle before public launch.</p>
      </div>
    </section>
  </main>
  <footer class="wrap footer"><a href="/privacy">Privacy</a> - <a href="/terms">Terms</a> - <a href="mailto:${supportEmail}">${supportEmail}</a></footer>
  <script>
    document.getElementById("startCheckout").addEventListener("click", async () => {
      const button = document.getElementById("startCheckout");
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "Opening checkout...";
      try {
        const res = await fetch("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectedPlan: "Founder Audit - $99" }) });
        const data = await res.json();
        if (!res.ok || !data.ok || !data.url) throw new Error(data.error || data.message || "Checkout is not ready.");
        location.href = data.url;
      } catch (error) {
        alert(error.message);
        button.disabled = false;
        button.textContent = original;
      }
    });
  </script>
  `, "/");
}

function portalPageHtml() {
  return marketingShell("Social Cues Account Portal", `
  <header class="wrap nav">
    <a class="brand" href="/">${brandMarkSvg()}<span>Social Cues</span></a>
    <div class="nav-actions">
      <a class="btn" href="/">Website</a>
      <a class="btn" href="/app">App</a>
    </div>
  </header>
  <main class="wrap" style="padding:24px 20px 42px">
    <section class="hero" style="padding:18px 0 24px">
      <div>
        <div class="eyebrow">Account portal</div>
        <h1 style="font-size:clamp(36px,6vw,64px)">Manage access before opening the app.</h1>
        <p class="lead">Log in to see remembered devices, account alerts, payment status actions, and app/download links.</p>
      </div>
      <aside class="panel">
        <div class="auth-box" id="authBox">
          <div class="field"><span>Email</span><input id="emailInput" type="email" autocomplete="email" placeholder="you@socialcuesapp.com"></div>
          <div class="field"><span>Password</span><input id="passwordInput" type="password" autocomplete="current-password" placeholder="At least 8 characters"></div>
          <div class="field create-only hidden"><span>Name</span><input id="nameInput" autocomplete="name" placeholder="Your name"></div>
          <div class="field create-only hidden"><span>Promo code</span><input id="promoInput" autocomplete="off" placeholder="Optional test access code"></div>
          <div class="nav-actions">
            <button class="btn primary" id="loginBtn">Log in</button>
            <button class="btn" id="createBtn">Create account</button>
          </div>
          <div class="notice" id="authNotice">Log in with your registered email and password. Create account opens the promo/tester fields.</div>
        </div>
        <div class="hidden" id="signedInBox">
          <h2 style="margin:0 0 8px" id="welcomeText">Signed in</h2>
          <p style="color:var(--muted);margin:0 0 12px">This device is remembered for your Social Cues workspace.</p>
          <button class="btn primary openAppBtn">Open command center</button>
          <button class="btn" id="logoutBtn">Log out this device</button>
        </div>
      </aside>
    </section>
    <section class="grid">
      <article class="panel">
        <h3>Device management</h3>
        <div class="status-list" id="deviceList"><div class="notice">Log in to load remembered devices.</div></div>
      </article>
      <article class="panel">
        <h3>Account alerts</h3>
        <div class="status-list" id="alertList"><div class="notice">Checking readiness after login.</div></div>
      </article>
      <article class="panel">
        <h3>Downloads and app access</h3>
        <div class="download-list">
          <button class="btn accent" id="portalCheckout">Pay or manage checkout</button>
          <button class="btn openAppBtn">Open command center</button>
          <a class="btn" href="/manifest.webmanifest">PWA manifest</a>
          <button class="btn" id="copyAppLink">Copy app link</button>
        </div>
        <p style="font-size:13px;color:#66717e;margin-top:12px">Install on phone by opening the web app in your mobile browser and using Add to Home Screen. Native app downloads can be added here later.</p>
      </article>
    </section>
  </main>
  <footer class="wrap footer"><a href="/privacy">Privacy</a> - <a href="/terms">Terms</a> - <a href="mailto:${supportEmail}">${supportEmail}</a></footer>
  <script>
    const tokenKey = "Social Cues-session-token";
    const deviceKey = "Social Cues-device-id";
    const $ = id => document.getElementById(id);
    const pageParams = new URLSearchParams(location.search);
    let createMode = pageParams.get("mode")==="create" || pageParams.has("promo") || pageParams.has("code");
    function deviceId(){let id=localStorage.getItem(deviceKey);if(!id){id="portal-"+Date.now()+"-"+Math.random().toString(16).slice(2,8);localStorage.setItem(deviceKey,id)}return id}
    function deviceInfo(){return{deviceId:deviceId(),deviceName:navigator.platform||"This device",deviceKind:/iphone|android.*mobile/i.test(navigator.userAgent)?"phone":"laptop",userAgent:navigator.userAgent,platform:navigator.platform,language:navigator.language,screen:(screen.width||0)+"x"+(screen.height||0),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,trusted:true}}
    async function api(path, options={}){const headers={...(options.headers||{})};const token=localStorage.getItem(tokenKey);if(token)headers.Authorization="Bearer "+token;const res=await fetch(path,{...options,headers,cache:"no-store"});const data=await res.json().catch(()=>({}));if(!res.ok||data.ok===false)throw new Error(data.error||"Request failed");return data}
    function setCreateMode(value){createMode=Boolean(value);document.querySelectorAll(".create-only").forEach(el=>el.classList.toggle("hidden",!createMode));$("createBtn").textContent=createMode?"Create account":"Create account";$("loginBtn").textContent=createMode?"Back to login":"Log in";$("authNotice").textContent=createMode?"Create a tester/customer account with name, email, password, and optional promo code.":"Log in with registered email and password."}
    async function auth(mode){if(mode==="create"&&!createMode){setCreateMode(true);return}if(mode==="login"&&createMode){setCreateMode(false);return}const body={email:$("emailInput").value,password:$("passwordInput").value,device:deviceInfo()};if(createMode){body.name=$("nameInput").value;body.promoCode=$("promoInput").value}if(!body.password||body.password.length<8){$("authNotice").textContent="Use at least 8 characters.";return}try{const data=await api(createMode?"/api/auth/signup":"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(data.session?.token)localStorage.setItem(tokenKey,data.session.token);$("authNotice").textContent=data.entitlement?.active?"Full access active. Opening workstation.":"Signed in. Payment or promo access is still needed.";renderSignedIn(data);await refreshPortal();if(data.entitlement?.active)location.replace("/app")}catch(error){$("authNotice").textContent=error.message}}
    function renderSignedIn(data){$("authBox").classList.add("hidden");$("signedInBox").classList.remove("hidden");$("welcomeText").textContent="Signed in"+(data?.user?.name?" as "+data.user.name:"")}
    function renderDevices(devices=[]){$("deviceList").innerHTML=devices.length?devices.map(d=>'<div class="status-row"><div><strong>'+escapeHtml(d.name||"Device")+'</strong><br><span>'+escapeHtml(d.kind||"device")+' - '+escapeHtml(d.lastSeenAt?new Date(d.lastSeenAt).toLocaleString():"not seen yet")+'</span></div><span class="pill">'+(d.active?"remembered":"signed out")+'</span></div>').join(""):'<div class="notice">No remembered devices yet.</div>'}
    function renderAlerts(items){$("alertList").innerHTML=items.map(item=>'<div class="status-row"><div><strong>'+escapeHtml(item.label)+'</strong><br><span>'+escapeHtml(item.detail)+'</span></div><span class="pill">'+escapeHtml(item.status)+'</span></div>').join("")}
    function accessDetail(entitlement){if(!entitlement?.active)return"Pay with Stripe or use an active promo code during account creation.";if(entitlement.source==="promo-code"){const until=entitlement.expiresAt?new Date(entitlement.expiresAt).toLocaleDateString():"120 days";return"Promo code "+entitlement.promoCode+" gives highest-tier full access through "+until+". App fee and subscription gate are satisfied for the test window."}return(entitlement.selectedPlan||"Highest-tier paid access")+" active. App fee and subscription gate are satisfied."}
    async function refreshPortal(){let entitlement=null;try{const session=await api("/api/auth/session");renderSignedIn(session);renderDevices(session.devices||[]);entitlement=session.entitlement||null;try{entitlement=(await api("/api/auth/entitlement")).entitlement||entitlement}catch{}}catch{}const readiness=await fetch("/api/portal/readiness",{cache:"no-store"}).then(r=>r.json());renderAlerts([{label:"Access",status:entitlement?.active?"full access":"payment needed",detail:accessDetail(entitlement)},{label:"Account security",status:readiness.auth?.ready?"ready":"setup in progress",detail:readiness.auth?.ready?"Secure account authentication is active.":"Account authentication is being configured."},{label:"Email verification",status:readiness.email?.ready?"ready":"setup in progress",detail:readiness.email?.ready?"Verification email delivery is active.":"Verification email delivery is being configured."},{label:"Stripe checkout",status:readiness.billing?.ready?"ready":"setup in progress",detail:readiness.billing?.ready?"Secure checkout is available.":"Checkout is being configured."},{label:"Media storage",status:readiness.media?.ready?"ready":"setup in progress",detail:readiness.media?.ready?"Private media storage is available.":"Media storage is being configured."},{label:"Account alerts",status:readiness.alerts?.ready?"ready":"setup in progress",detail:readiness.alerts?.ready?"Account alert delivery is active.":"Account alerts are being configured."}]);if(entitlement?.active&&pageParams.get("stay")!=="1")location.replace("/app")}
    function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]))}
    async function openApp(){try{if(localStorage.getItem(tokenKey))await api("/api/auth/session");location.href="/app"}catch(error){$("authNotice").textContent="Log in again before opening the command center.";setCreateMode(false)}}
    $("loginBtn").addEventListener("click",()=>auth("login"));$("createBtn").addEventListener("click",()=>auth("create"));document.querySelectorAll(".openAppBtn").forEach(btn=>btn.addEventListener("click",openApp));$("logoutBtn").addEventListener("click",async()=>{await api("/api/auth/logout",{method:"POST"}).catch(()=>{});localStorage.removeItem(tokenKey);location.reload()});$("copyAppLink").addEventListener("click",async()=>{await navigator.clipboard.writeText(location.origin+"/app");alert("App link copied.")});$("portalCheckout").addEventListener("click",async()=>{const data=await api("/api/billing/checkout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selectedPlan:"Social Cues highest tier"})});if(data.url)location.href=data.url});setCreateMode(createMode);const inviteCode=pageParams.get("promo")||pageParams.get("code")||"";if(inviteCode)$("promoInput").value=inviteCode.toUpperCase();refreshPortal();
  </script>
  `, "/portal");
}

function lockedAppPreviewHtml() {
  return marketingShell("Social Cues Command Center", `
  <header class="wrap nav">
    <a class="brand" href="/">${brandMarkSvg()}<span>Social Cues</span></a>
    <div class="nav-actions">
      <a class="btn primary" href="/portal">Log in</a>
    </div>
  </header>
  <main>
    <section class="wrap hero">
      <div>
        <div class="eyebrow">Access required</div>
        <h1>No app access without an active account.</h1>
        <p class="lead">Social Cues workstations are private. Log in with a paid account or an active tester promo account to continue.</p>
        <div class="nav-actions" style="margin-top:22px">
          <a class="btn primary" href="/portal">Log in</a>
          <a class="btn" href="/portal?mode=create">Create account</a>
        </div>
      </div>
      <aside class="hero-panel">
        <div class="metric"><strong>Account</strong><span class="pill">Required</span></div>
        <div class="metric"><strong>Payment or promo</strong><span class="pill">Required</span></div>
        <div class="metric"><strong>Workstation</strong><span class="pill">Private</span></div>
      </aside>
    </section>
  </main>
  <footer class="wrap footer"><a href="/privacy">Privacy</a> - <a href="/terms">Terms</a> - <a href="mailto:${supportEmail}">${supportEmail}</a></footer>
  <script>
    (async function repairAppSession(){
      const token = localStorage.getItem("Social Cues-session-token");
      if (!token || sessionStorage.getItem("sc-app-session-repair") === "done") return;
      sessionStorage.setItem("sc-app-session-repair", "done");
      try {
        const res = await fetch("/api/auth/session", { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
        const data = await res.json().catch(()=>({}));
        if (res.ok && data.ok && data.entitlement && data.entitlement.active) location.replace("/app");
      } catch {}
    })();
  </script>
  `, "/app");
}

function requestPublicBaseUrl(req, configured = publicAppUrl) {
  if (process.env.VERCEL) return (configured || brandHomeUrl).replace(/\/$/, "");
  const forwardedHost = String(req?.headers?.["x-forwarded-host"] || "").split(",")[0].trim();
  const hostHeader = String(req?.headers?.host || "").trim();
  const hostValue = forwardedHost || hostHeader;
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  if (hostValue && !/^127\.0\.0\.1(?::|$)/.test(hostValue) && !/^localhost(?::|$)/i.test(hostValue)) {
    const proto = forwardedProto || (process.env.VERCEL ? "https" : "http");
    return `${proto}://${hostValue}`.replace(/\/$/, "");
  }
  const configuredUrl = configured.replace(/\/$/, "");
  const configuredHost = (() => {
    try {
      return new URL(configuredUrl).host;
    } catch {
      return "";
    }
  })();
  if (/^127\.0\.0\.1(?::|$)/.test(configuredHost) || /^localhost(?::|$)/i.test(configuredHost)) {
    return brandHomeUrl;
  }
  return configuredUrl;
}

function metaRedirectUri(req) {
  return `${requestPublicBaseUrl(req, metaPublicAppUrl)}/api/oauth/meta/callback`;
}

function metaDataDeletionUri(req) {
  return `${requestPublicBaseUrl(req, metaPublicAppUrl)}/api/meta/data-deletion`;
}

function metaDataDeletionStatusUri(code, req) {
  return `${requestPublicBaseUrl(req, metaPublicAppUrl)}/api/meta/data-deletion/status?code=${encodeURIComponent(code)}`;
}

function createOAuthState(model, provider, platform, extra = {}) {
  const state = crypto.randomBytes(32).toString("base64url");
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

async function oauthStartSession(model, req) {
  const session = await sessionFromRequest(model, req);
  if (!session || !hasActiveAppAccess(session.user)) return null;
  if (session?.user) {
    ensureUserWorkspace(model, session.user);
    await ensureWorkspaceBootstrap(model, session.user);
  }
  return session;
}

function oauthOwnerFields(session) {
  if (!session?.user) return {};
  return {
    userId: session.user.id,
    ownerUserId: session.user.id,
    workspaceId: workspaceIdForUser(session.user),
    ownerEmail: session.user.email || ""
  };
}

function userFromOAuthRecord(model, record = {}) {
  const userId = record.ownerUserId || record.userId || "";
  if (!userId) return null;
  const user = (model.authUsers || []).find(item => String(item.id) === String(userId));
  if (user) ensureUserWorkspace(model, user);
  return user || null;
}

function accountOwnerPatch(user) {
  return user ? { ownerUserId: user.id, workspaceId: workspaceIdForUser(user) } : {};
}

function metaOAuthUrl(platform = "meta", state = "", redirectUri = metaRedirectUri()) {
  const params = new URLSearchParams({
    client_id: metaAppId,
    redirect_uri: redirectUri,
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

function tiktokRedirectUri() {
  return `${tiktokPublicAppUrl}/api/oauth/tiktok/callback`;
}

function pinterestRedirectUri() {
  return `${pinterestPublicAppUrl}/api/oauth/pinterest/callback`;
}

function canvaRedirectUri() {
  return `${canvaPublicAppUrl}/api/oauth/canva/callback`;
}

function youtubeRedirectUri() {
  return `${googlePublicAppUrl}/api/oauth/youtube/callback`;
}

function shopifyRedirectUri() {
  return `${shopifyPublicAppUrl}/api/oauth/shopify/callback`;
}

function etsyRedirectUri() {
  return `${etsyPublicAppUrl}/api/oauth/etsy/callback`;
}

function linkedInRedirectUri() {
  return `${linkedInPublicAppUrl}/api/oauth/linkedin/callback`;
}

function twitchRedirectUri() {
  return `${twitchPublicAppUrl}/api/oauth/twitch/callback`;
}

function secureOAuthReady(req) {
  return metaRedirectUri(req).startsWith("https://");
}

function secureThreadsOAuthReady() {
  return publicAppUrl.startsWith("https://");
}

function secureXOAuthReady() {
  return xPublicAppUrl.startsWith("https://") || xPublicAppUrl.startsWith("http://127.0.0.1") || xPublicAppUrl.startsWith("http://localhost");
}

function secureTikTokOAuthReady() {
  return tiktokRedirectUri().startsWith("https://");
}

function securePinterestOAuthReady() {
  return pinterestRedirectUri().startsWith("https://");
}

function secureCanvaOAuthReady() {
  return canvaRedirectUri().startsWith("https://");
}

function secureYouTubeOAuthReady() {
  return youtubeRedirectUri().startsWith("https://");
}

function secureShopifyOAuthReady() {
  return shopifyRedirectUri().startsWith("https://");
}

function secureEtsyOAuthReady() {
  return etsyRedirectUri().startsWith("https://");
}

function secureLinkedInOAuthReady() {
  return linkedInRedirectUri().startsWith("https://");
}

function secureTwitchOAuthReady() {
  return twitchRedirectUri().startsWith("https://");
}

function oauthSecurityWarning(req) {
  if (secureOAuthReady(req)) return null;
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

function tiktokSecurityWarning() {
  if (secureTikTokOAuthReady()) return null;
  return "TikTok Login Kit requires an HTTPS redirect URI. Set TIKTOK_PUBLIC_APP_URL or PUBLIC_APP_URL to the hosted Social Cues URL, then add the matching callback in TikTok for Developers.";
}

function pinterestSecurityWarning() {
  if (securePinterestOAuthReady()) return null;
  return "Pinterest OAuth requires an exact HTTPS redirect URI. Set PINTEREST_PUBLIC_APP_URL or PUBLIC_APP_URL to the hosted Social Cues URL, then add the matching callback in Pinterest Developers.";
}

function canvaSecurityWarning() {
  if (secureCanvaOAuthReady()) return null;
  return "Canva Connect OAuth requires an HTTPS redirect URI. Set CANVA_PUBLIC_APP_URL or PUBLIC_APP_URL to the hosted Social Cues URL, then add the matching callback in the Canva Developer Portal.";
}

function youtubeSecurityWarning() {
  if (secureYouTubeOAuthReady()) return null;
  return "Google OAuth requires an HTTPS redirect URI for this hosted flow. Set GOOGLE_PUBLIC_APP_URL or PUBLIC_APP_URL to the hosted Social Cues URL, then add the matching callback in Google Cloud.";
}

function shopifySecurityWarning() {
  if (secureShopifyOAuthReady()) return null;
  return "Shopify app OAuth requires an HTTPS app/callback URL. Set SHOPIFY_PUBLIC_APP_URL or PUBLIC_APP_URL to the hosted Social Cues URL, then add the matching callback in Shopify Partners.";
}

function etsySecurityWarning() {
  if (secureEtsyOAuthReady()) return null;
  return "Etsy OAuth requires an HTTPS redirect URI. Set ETSY_PUBLIC_APP_URL or PUBLIC_APP_URL to the hosted Social Cues URL, then add the matching callback in Etsy Developers.";
}

function linkedInSecurityWarning() {
  if (secureLinkedInOAuthReady()) return null;
  return "LinkedIn OAuth requires an absolute HTTPS redirect URI. Set LINKEDIN_PUBLIC_APP_URL or PUBLIC_APP_URL to the hosted Social Cues URL, then add the matching callback in the LinkedIn Developer app Auth tab.";
}

function twitchSecurityWarning() {
  if (secureTwitchOAuthReady()) return null;
  return "Twitch OAuth requires an HTTPS redirect URI for the hosted app. Set TWITCH_PUBLIC_APP_URL or PUBLIC_APP_URL to the hosted Social Cues URL, then add the matching callback in Twitch Developers.";
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

function tiktokOAuthUrl(state = "") {
  const params = new URLSearchParams({
    client_key: tiktokClientKey,
    redirect_uri: tiktokRedirectUri(),
    response_type: "code",
    scope: tiktokScopes.join(","),
    state,
    disable_auto_auth: process.env.TIKTOK_DISABLE_AUTO_AUTH || "1"
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

function pinterestOAuthUrl(state = "") {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: pinterestAppId,
    redirect_uri: pinterestRedirectUri(),
    scope: pinterestScopes.join(","),
    state
  });
  return `https://www.pinterest.com/oauth/?${params.toString()}`;
}

function etsyOAuthUrl(state = "", challenge = "") {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: etsyClientId,
    redirect_uri: etsyRedirectUri(),
    scope: etsyScopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  return `https://www.etsy.com/oauth/connect?${params.toString()}`;
}

function normalizeShopifyShop(value = "") {
  let shop = String(value || "").trim().toLowerCase();
  shop = shop.replace(/^https?:\/\//, "").replace(/^admin\./, "").replace(/\/.*$/, "");
  if (!shop) return "";
  if (!shop.endsWith(".myshopify.com")) shop = `${shop}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : "";
}

function shopifyOAuthUrl(shop = "", state = "") {
  const normalizedShop = normalizeShopifyShop(shop);
  if (!normalizedShop) throw new Error("A valid Shopify shop domain is required.");
  const params = new URLSearchParams({
    client_id: shopifyClientId,
    scope: shopifyScopes.join(","),
    redirect_uri: shopifyRedirectUri(),
    state
  });
  return `https://${normalizedShop}/admin/oauth/authorize?${params.toString()}`;
}

function verifyShopifyHmac(searchParams) {
  const hmac = searchParams.get("hmac") || "";
  if (!hmac || !shopifyClientSecret) return false;
  const pairs = [];
  for (const [key, value] of searchParams.entries()) {
    if (key === "hmac" || key === "signature") continue;
    pairs.push(`${key}=${value}`);
  }
  const message = pairs.sort().join("&");
  const digest = crypto.createHmac("sha256", shopifyClientSecret).update(message).digest("hex");
  return timingSafeEqualText(hmac, digest);
}

async function exchangeShopifyCode(shop, code) {
  if (!shopifyClientId || !shopifyClientSecret) throw new Error("SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are required for token exchange.");
  const normalizedShop = normalizeShopifyShop(shop);
  if (!normalizedShop) throw new Error("A valid Shopify shop domain is required.");
  const response = await fetch(`https://${normalizedShop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: shopifyClientId,
      client_secret: shopifyClientSecret,
      code
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || payload.error || `Shopify token exchange failed with ${response.status}.`);
  return {
    accessToken: payload.access_token || "",
    scopes: String(payload.scope || "").split(",").map(item => item.trim()).filter(Boolean),
    shop: normalizedShop,
    raw: payload
  };
}

function twitchOAuthUrl(state = "") {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: twitchClientId,
    redirect_uri: twitchRedirectUri(),
    scope: twitchScopes.join(" "),
    state
  });
  return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
}

function canvaOAuthUrl(state = "", challenge = "") {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: canvaClientId,
    redirect_uri: canvaRedirectUri(),
    scope: canvaScopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  return `https://www.canva.com/api/oauth/authorize?${params.toString()}`;
}

function youtubeOAuthUrl(state = "") {
  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: youtubeRedirectUri(),
    response_type: "code",
    scope: youtubeScopes.join(" "),
    state,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent"
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function envPresent(name) {
  return Boolean(process.env[name]);
}

function publicKeyFingerprint(value = "") {
  if (!value) return null;
  return {
    prefix: value.slice(0, 4),
    suffix: value.slice(-4),
    sha256: crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)
  };
}

function oauthRuntimeLog(provider, event, fields = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    if (/token|secret|password|credential|code$/i.test(key)) continue;
    safe[key] = value;
  }
  console.log(JSON.stringify({
    type: "social-cues-oauth",
    provider,
    event,
    at: new Date().toISOString(),
    ...safe
  }));
}

function googleGrowthStatus() {
  return googleGrowthApis.map(api => ({
    ...api,
    ready: api.env.every(envPresent),
    missingEnv: api.env.filter(name => !envPresent(name))
  }));
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
  if (url.pathname.startsWith("/api/") && !(await authorizeApiRequest(req, res, url))) return;

  if (url.pathname === "/") {
    return text(res, 200, landingPageHtml(), "text/html; charset=utf-8");
  }

  if (url.pathname === "/portal" || url.pathname === "/account") {
    return text(res, 200, portalPageHtml(), "text/html; charset=utf-8");
  }

  if (url.pathname === "/app") {
    const model = await getModel();
    const session = await sessionFromRequest(model, req);
    const entitlement = session?.user ? publicEntitlement(session.user) : null;
    if (runtimeMode === "vercel" && (!session || !entitlement?.active)) {
      return text(res, 200, lockedAppPreviewHtml(), "text/html; charset=utf-8");
    }
    if (session?.refreshed) {
      await saveModel(model);
      setCookie(res, sessionCookieValue(session.token, session.device.expiresAt));
    }
    const html = await readFile(uiPath, "utf8");
    return text(res, 200, html, "text/html; charset=utf-8");
  }

  if (url.pathname === "/privacy" || url.pathname === "/privacy-policy") {
    return html(res, 200, privacyPolicyHtml(), "/privacy");
  }

  if (url.pathname === "/terms" || url.pathname === "/terms-of-service") {
    return html(res, 200, termsOfServiceHtml(), "/terms");
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

  if (url.pathname === "/favicon.png") {
    return binary(res, 200, await readFile(faviconPngPath), "image/png");
  }

  if (url.pathname === "/apple-touch-icon.png") {
    return binary(res, 200, await readFile(appleTouchIconPath), "image/png");
  }

  if (url.pathname === "/sc-icon-192.png") {
    return binary(res, 200, await readFile(scIcon192Path), "image/png");
  }

  if (url.pathname === "/sc-icon-512.png") {
    return binary(res, 200, await readFile(scIcon512Path), "image/png");
  }

  if (url.pathname === "/sc-icon-1024.png") {
    return binary(res, 200, await readFile(scIcon1024Path), "image/png");
  }

  if (url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      app: "Social Cues"
    });
  }

  if (url.pathname === "/api/observability/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      provider: "sentry",
      configured: Boolean(sentryDsn),
      initialized: sentryInitialized,
      environment: sentryEnvironment,
      release: sentryRelease || null,
      releaseSource: sentryReleaseSource,
      dist: sentryDist || null,
      tracesSampleRate: sentryTracesSampleRate,
      clientErrors: Boolean(sentryDsn),
      sourceMaps: false,
      sourceMapping: {
        ready: Boolean(sentryGithubRepository && sentrySourceContextEnabled),
        mode: "github-original-source",
        repository: sentryGithubRepository || null,
        scmSourceContextEnabled: sentrySourceContextEnabled,
        sourceMapsRequired: false,
        reason: "Social Cues currently deploys original JavaScript without bundling or minification; Sentry can map stack frames directly through GitHub source context. The Vercel integration will upload source maps automatically if a future build emits them."
      },
      releaseTracking: {
        enabled: Boolean(sentryRelease),
        release: sentryRelease || null,
        source: sentryReleaseSource,
        dist: sentryDist || null
      },
      nextActions: sentryDsn
        ? (sentryGithubRepository && sentrySourceContextEnabled
          ? ["Keep Supabase as the data/auth system; Sentry captures server-side Supabase and provider failures."]
          : ["Connect the Social Cues GitHub repository in Sentry and enable SCM Source Context."])
        : ["Create a Sentry JavaScript/Node project named Social Cues and add its DSN to SENTRY_DSN in Vercel and local .env."]
    });
  }

  if (url.pathname === "/api/observability/config" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      enabled: Boolean(sentryDsn),
      dsn: sentryDsn || null,
      environment: sentryEnvironment,
      release: sentryRelease || null,
      dist: sentryDist || null,
      repository: sentryGithubRepository || null,
      sourceContextEnabled: sentrySourceContextEnabled,
      browserCdnUrl: sentryDsn ? sentryBrowserCdnUrl : null,
      tracesSampleRate: sentryTracesSampleRate
    });
  }

  if (url.pathname === "/api/portal/readiness" && req.method === "GET") {
    const smtp = authSmtpReadiness();
    return json(res, 200, {
      ok: true,
      auth: { ready: supabaseAuthEnabled(), provider: authProvider },
      email: { ready: smtp.ready && smtp.supabaseDashboardApplied },
      billing: { ready: Boolean(stripeSecretKey && (stripePriceFounderAudit || stripePriceCampaignBuild || stripePriceProMonthly)) },
      media: { ready: mediaStorageReady() },
      alerts: { ready: Boolean(discordClientId && discordClientSecret) }
    });
  }

  if (url.pathname === "/api/observability/client-error" && req.method === "POST") {
    const input = await bodyJson(req);
    const message = safeSentryText(input.message || "Browser error", 500);
    const clientError = new Error(message);
    clientError.name = safeSentryText(input.name || "BrowserError", 100);
    if (input.stack) clientError.stack = safeSentryText(input.stack, 5000);
    const captured = captureSentryError(clientError, {
      surface: "browser",
      source: safeSentryText(input.source || "unknown", 80),
      route: safeSentryPath(input.url || input.route),
      userAgent: safeSentryText(req.headers["user-agent"], 160)
    });
    if (captured) await flushSentry();
    return json(res, captured ? 202 : 200, { ok: true, captured });
  }

  if (url.pathname === "/api/oauth/meta/status" && req.method === "GET") {
    const redirectUri = metaRedirectUri(req);
    return json(res, 200, {
      ok: true,
      configured: Boolean(metaAppId && metaAppSecret),
      appIdPresent: Boolean(metaAppId),
      appSecretPresent: Boolean(metaAppSecret),
      apiVersion: metaApiVersion,
      redirectUri,
      validOAuthRedirectUris: [redirectUri],
      appDomains: [brandDomain],
      dataDeletionUri: metaDataDeletionUri(req),
      secureOAuthReady: secureOAuthReady(req),
      warning: oauthSecurityWarning(req),
      blockedRedirectFix: {
        product: "Facebook Login",
        settingsPage: "Facebook Login > Settings",
        requiredToggles: ["Client OAuth Login: On", "Web OAuth Login: On"],
        field: "Valid OAuth Redirect URIs",
        exactValue: redirectUri,
        appDomainsField: "App settings > Basic > App Domains",
        appDomainsValue: brandDomain
      },
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

  if (url.pathname === "/api/oauth/tiktok/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(tiktokClientKey && tiktokClientSecret),
      mode: tiktokOAuthMode,
      clientKeyPresent: Boolean(tiktokClientKey),
      clientSecretPresent: Boolean(tiktokClientSecret),
      productionClientKeyPresent: Boolean(tiktokProductionClientKey),
      sandboxClientKeyPresent: Boolean(tiktokSandboxClientKey),
      clientKeyFingerprint: publicKeyFingerprint(tiktokClientKey),
      redirectUri: tiktokRedirectUri(),
      secureOAuthReady: secureTikTokOAuthReady(),
      warning: tiktokSecurityWarning(),
      scopes: tiktokScopes,
      futureScopes: tiktokFutureScopes,
      disableAutoAuth: process.env.TIKTOK_DISABLE_AUTO_AUTH || "1",
      domainVerification: {
        domain: "socialcuesapp.com",
        status: "verified",
        verifiedAt: "2026-06-27"
      },
      scopePolicy: "Social Cues requests only the minimal Login Kit scopes during first OAuth. Publishing/video scopes stay review-gated until TikTok approves them.",
      products: ["Login Kit", "Display API", "Content Posting API", "Embed Videos", "Commercial Content API", "Research API", "Data Portability API"],
      reviewRequiredFor: tiktokFutureScopes,
      portalConfigurationRequired: tiktokOAuthMode === "sandbox"
        ? "Sandbox mode requires the sandbox Client key/secret, Login Kit product, redirect URI, and the TikTok account added as a sandbox target user."
        : "Production mode requires the app configuration to be submitted and Live before general TikTok users can authorize. Use Sandbox mode with target users before approval."
    });
  }

  if (url.pathname === "/api/oauth/tiktok/diagnostic" && req.method === "GET") {
    const diagnosticState = "diagnostic";
    const diagnosticAuthorizeUrl = tiktokOAuthUrl(diagnosticState);
    let authorizeProbe = null;
    if (url.searchParams.get("probe") === "1") {
      try {
        const response = await fetch(diagnosticAuthorizeUrl, {
          redirect: "manual",
          headers: { "user-agent": "Mozilla/5.0 SocialCuesDiagnostic/1.0" }
        });
        authorizeProbe = {
          http: response.status,
          location: response.headers.get("location") || "",
          acceptedClientKey: response.status >= 300 && response.status < 400 && String(response.headers.get("location") || "").includes(`dev_${tiktokClientKey}`)
        };
      } catch (error) {
        authorizeProbe = { error: error.message };
      }
    }
    return html(res, 200, `
      <h1>TikTok Login Diagnostic</h1>
      <p>Use this page to compare Social Cues settings with TikTok for Developers. Do not paste secrets into chat.</p>
      <ul>
        <li><strong>Selected mode:</strong> <code>${tiktokOAuthMode}</code></li>
        <li><strong>Client key fingerprint:</strong> ${escapeHtml(JSON.stringify(publicKeyFingerprint(tiktokClientKey)))}</li>
        <li><strong>Client key present:</strong> ${tiktokClientKey ? "yes" : "no"}</li>
        <li><strong>Client secret present:</strong> ${tiktokClientSecret ? "yes" : "no"}</li>
        <li><strong>Production key present:</strong> ${tiktokProductionClientKey ? "yes" : "no"}</li>
        <li><strong>Sandbox key present:</strong> ${tiktokSandboxClientKey ? "yes" : "no"}</li>
        <li><strong>Redirect URI:</strong> <code>${tiktokRedirectUri()}</code></li>
        <li><strong>Active first-login scopes:</strong> <code>${tiktokScopes.join(",")}</code></li>
        <li><strong>Future review-gated scopes:</strong> <code>${tiktokFutureScopes.join(",")}</code></li>
      </ul>
      <h2>What the TikTok portal must show</h2>
      <ul>
        <li>The portal mode must match Social Cues mode: <code>${tiktokOAuthMode}</code>.</li>
        <li>The selected mode's <strong>Client key</strong> must have prefix <code>${tiktokClientKey.slice(0, 4)}</code> and suffix <code>${tiktokClientKey.slice(-4)}</code>.</li>
        <li><strong>Login Kit</strong> must be added in Products for the selected mode.</li>
        <li>The Login Kit redirect URI must exactly be <code>${tiktokRedirectUri()}</code>. No query string, no trailing slash unless the app also sends it.</li>
        <li>The assigned scope must include <code>user.info.basic</code>. Do not add Display or Content Posting scopes to first login until TikTok grants them.</li>
        <li>In production mode, the app configuration must be submitted and Live before general TikTok accounts can authorize.</li>
        <li>In sandbox mode, the TikTok account must be added under Sandbox settings as a target user before Login Kit authorization can complete.</li>
      </ul>
      <h2>Current diagnosis</h2>
      <p>${tiktokOAuthMode === "production"
        ? "Social Cues is using production credentials. If TikTok shows client_key after login while the key fingerprint matches, the likely portal gap is that the Production app is still Draft, Login Kit is not active in Production, user.info.basic is not assigned, or the redirect URI is missing in Login Kit."
        : "Social Cues is using sandbox credentials. If TikTok shows client_key after login while the key fingerprint matches, the likely portal gap is that the TikTok account is not a sandbox target user, Login Kit is not active in Sandbox, user.info.basic is not assigned, or the redirect URI is missing in Login Kit."
      }</p>
      ${authorizeProbe ? `<h2>Server-side authorize probe</h2><pre>${escapeHtml(JSON.stringify(authorizeProbe, null, 2))}</pre>` : `<p><a href="/api/oauth/tiktok/diagnostic?probe=1">Run server-side authorize probe</a></p>`}
      <p><a href="/api/oauth/tiktok/start">Start TikTok connect</a> | <a href="/app">Back to Social Cues</a></p>
    `);
  }

  if (url.pathname === "/api/oauth/tiktok/debug-start" && req.method === "GET") {
    const model = await getModel();
    const rawSession = await sessionFromRequest(model, req);
    const session = await oauthStartSession(model, req);
    if (runtimeMode === "vercel" && !session) {
      if (rawSession?.user && !hasActiveAppAccess(rawSession.user)) return appAccessRequiredResponse(res);
      return json(res, 401, { ok: false, error: "Sign in before debugging TikTok OAuth start." });
    }
    const state = createOAuthState(model, "tiktok", "tiktok", oauthOwnerFields(session));
    await saveModel(model);
    const authUrl = tiktokOAuthUrl(state);
    const parsed = new URL(authUrl);
    return json(res, 200, {
      ok: true,
      provider: "tiktok",
      mode: tiktokOAuthMode,
      clientKeyFingerprint: publicKeyFingerprint(tiktokClientKey),
      redirectUri: tiktokRedirectUri(),
      secureOAuthReady: secureTikTokOAuthReady(),
      scopes: tiktokScopes,
      disableAutoAuth: process.env.TIKTOK_DISABLE_AUTO_AUTH || "1",
      authUrl,
      params: Object.fromEntries(parsed.searchParams.entries()),
      stateLength: state.length,
      statePreview: `${state.slice(0, 8)}...${state.slice(-8)}`
    });
  }

  if (url.pathname === "/api/oauth/pinterest/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(pinterestAppId && pinterestAppSecret),
      appIdPresent: Boolean(pinterestAppId),
      appSecretPresent: Boolean(pinterestAppSecret),
      redirectUri: pinterestRedirectUri(),
      secureOAuthReady: securePinterestOAuthReady(),
      warning: pinterestSecurityWarning(),
      scopes: pinterestScopes,
      portal: "https://developers.pinterest.com/apps/",
      accessModel: "Trial access requires a Pinterest app request; Standard access expands rate limits and production use.",
      allowedUse: ["basic analytics", "read/write boards", "read/write standard Pins", "read ads"]
    });
  }

  if (url.pathname === "/api/oauth/canva/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(canvaClientId && canvaClientSecret),
      appShellCreated: Boolean(canvaAppId),
      appId: canvaAppId || null,
      clientIdPresent: Boolean(canvaClientId),
      clientSecretPresent: Boolean(canvaClientSecret),
      redirectUri: canvaRedirectUri(),
      secureOAuthReady: secureCanvaOAuthReady(),
      warning: canvaSecurityWarning(),
      scopes: canvaScopes,
      portal: "https://www.canva.com/developers/apps",
      connectPortal: "https://www.canva.com/developers/integrations",
      credentialLane: "Canva Connect integration credentials are required. A Canva Apps SDK app shell is useful later, but it does not provide CANVA_CLIENT_ID or CANVA_CLIENT_SECRET.",
      nextActions: canvaClientId && canvaClientSecret ? [
        "Connect a Canva account through /api/oauth/canva/start.",
        "Verify design and asset metadata reads through /api/canva/designs."
      ] : [
        "Open Canva Developer Portal > Your integrations, not Your apps.",
        "Create a public Connect integration.",
        "Set the integration name to Social Cues.",
        `Add authorized redirect URL ${canvaRedirectUri()}.`,
        "Select only the Connect scopes Social Cues needs.",
        "Copy the Client ID and generate one Client secret, then save them as CANVA_CLIENT_ID and CANVA_CLIENT_SECRET."
      ],
      products: ["Connect API", "assets", "designs", "imports", "exports", "brand templates", "comments", "folders"],
      securityModel: "OAuth 2.0 authorization-code flow with PKCE and backend token exchange."
    });
  }

  if (url.pathname === "/api/oauth/youtube/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(googleClientId && googleClientSecret),
      clientIdPresent: Boolean(googleClientId),
      clientSecretPresent: Boolean(googleClientSecret),
      redirectUri: youtubeRedirectUri(),
      secureOAuthReady: secureYouTubeOAuthReady(),
      warning: youtubeSecurityWarning(),
      scopes: youtubeScopes,
      knownChannelId: youtubeKnownChannelId,
      products: ["YouTube Data API v3", "YouTube Analytics API", "YouTube Reporting API"],
      uploadAuditNote: "Videos uploaded from unverified API projects created after July 28, 2020 are restricted to private visibility until Google API Services audit approval."
    });
  }

  if (url.pathname === "/api/oauth/shopify/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(shopifyClientId && shopifyClientSecret),
      clientIdPresent: Boolean(shopifyClientId),
      clientSecretPresent: Boolean(shopifyClientSecret),
      redirectUri: shopifyRedirectUri(),
      secureOAuthReady: secureShopifyOAuthReady(),
      warning: shopifySecurityWarning(),
      scopes: shopifyScopes,
      portal: "https://partners.shopify.com/",
      setupStatus: shopifyClientId ? "partner app credentials present" : "create Shopify Partner organization/app, then add credentials",
      shopDomainConfigured: Boolean(shopifyShopDomain),
      missingEnv: ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"].filter(name => !envPresent(name)),
      optionalMissingEnv: shopifyShopDomain ? [] : ["SHOPIFY_SHOP_DOMAIN"],
      securityModel: "Shopify install flow must validate shop host, state nonce, and Shopify HMAC before exchanging the authorization code."
    });
  }

  if (url.pathname === "/api/oauth/etsy/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(etsyClientId && etsyClientSecret),
      clientIdPresent: Boolean(etsyClientId),
      clientSecretPresent: Boolean(etsyClientSecret),
      redirectUri: etsyRedirectUri(),
      secureOAuthReady: secureEtsyOAuthReady(),
      warning: etsySecurityWarning(),
      scopes: etsyScopes,
      portal: "https://www.etsy.com/developers",
      setupStatus: etsyClientId && etsyClientSecret ? "Etsy developer key present" : "create Etsy app, then add keystring/client id and shared secret",
      securityModel: "Etsy Open API uses OAuth 2.0 with PKCE; Social Cues should request shop/listing scopes only after user consent."
    });
  }

  if (url.pathname === "/api/oauth/linkedin/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(linkedInClientId && linkedInClientSecret),
      clientIdPresent: Boolean(linkedInClientId),
      clientSecretPresent: Boolean(linkedInClientSecret),
      redirectUri: linkedInRedirectUri(),
      secureOAuthReady: secureLinkedInOAuthReady(),
      warning: linkedInSecurityWarning(),
      scopes: linkedInScopes,
      futureScopes: linkedInFutureScopes,
      portal: "https://www.linkedin.com/developers/apps",
      setupStatus: linkedInClientId ? "LinkedIn app credentials present" : "create/select LinkedIn app, add products, then add credentials",
      securityModel: "LinkedIn scopes depend on approved Products in the app. Do not request w_member_social until the app has that product access."
    });
  }

  if (url.pathname === "/api/oauth/twitch/status" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(twitchClientId && twitchClientSecret),
      clientIdPresent: Boolean(twitchClientId),
      clientSecretPresent: Boolean(twitchClientSecret),
      redirectUri: twitchRedirectUri(),
      secureOAuthReady: secureTwitchOAuthReady(),
      warning: twitchSecurityWarning(),
      scopes: twitchScopes,
      portal: "https://dev.twitch.tv/console/apps",
      setupStatus: twitchClientId ? "Twitch app credentials present" : "create/register Twitch developer app, then add credentials",
      securityModel: "Twitch access depends on OAuth scopes and channel ownership; analytics and subscriber scopes require the broadcaster's consent."
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
        meta: metaRedirectUri(req),
        threads: threadsRedirectUri(),
        dataDeletion: metaDataDeletionUri(req)
      },
      secureOAuthReady: secureOAuthReady(req),
      warning: oauthSecurityWarning(req),
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
      callback: metaDataDeletionUri(req),
      method: "POST",
      expects: "signed_request"
    });
  }

  if (url.pathname === "/api/meta/data-deletion" && req.method === "POST") {
    const contentType = req.headers["content-type"] || "";
    const raw = await bodyText(req);
    let signedRequest = "";
    try {
      if (contentType.includes("application/json")) {
        signedRequest = JSON.parse(raw || "{}").signed_request || "";
      } else {
        signedRequest = new URLSearchParams(raw).get("signed_request") || "";
      }
    } catch {
      return json(res, 400, { ok: false, error: "Request body must include a valid signed_request." });
    }

    let payload;
    try {
      payload = parseMetaSignedRequest(signedRequest);
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }

    const confirmationCode = `meta-delete-${crypto.randomBytes(18).toString("base64url")}`;
    const model = await getModel();
    const metaUserId = payload.user_id || payload.user?.id || "";
    const deletedTargets = await purgeVerifiedMetaIdentity(model, metaUserId);
    model.metaDeletionRequests = model.metaDeletionRequests || [];
    model.metaDeletionRequests.push({
      confirmationCode,
      userId: metaUserId || null,
      issuedAt: payload.issued_at || null,
      receivedAt: new Date().toISOString(),
      deletedWorkspaceCount: deletedTargets.length
    });
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
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { ok: false, error: "Meta webhook body must be valid JSON." });
    }
    const fieldNames = [...new Set((Array.isArray(payload.entry) ? payload.entry : [])
      .flatMap(entry => Array.isArray(entry?.changes) ? entry.changes : [])
      .map(change => String(change?.field || "").trim())
      .filter(Boolean))].slice(0, 20);
    const model = await getModel();
    model.metaWebhookEvents = model.metaWebhookEvents || [];
    model.metaWebhookEvents.unshift({
      id: uid("meta-webhook"),
      receivedAt: new Date().toISOString(),
      object: String(payload.object || "unknown").slice(0, 64),
      entryCount: Array.isArray(payload.entry) ? payload.entry.length : 0,
      fieldNames
    });
    model.metaWebhookEvents = model.metaWebhookEvents.slice(0, 50);
    await saveModel(model);
    return json(res, 200, { ok: true, received: true });
  }

  if (url.pathname === "/api/oauth/connect-url" && req.method === "GET") {
    const provider = url.searchParams.get("provider") || "";
    const platform = url.searchParams.get("platform") || provider;
    const model = await getModel();
    const rawSession = await sessionFromRequest(model, req);
    const session = await oauthStartSession(model, req);
    if (runtimeMode === "vercel" && !session) {
      if (rawSession?.user && !hasActiveAppAccess(rawSession.user)) return appAccessRequiredResponse(res);
      return json(res, 401, { ok: false, error: "Sign in before connecting a social account." });
    }
    let authUrl = "";
    let state = "";
    if (provider === "threads") {
      if (!secureThreadsOAuthReady()) return json(res, 409, { ok: false, error: threadsSecurityWarning() });
      if (!threadsAppId) return json(res, 409, { ok: false, error: "THREADS_APP_ID is not configured." });
      state = createOAuthState(model, "threads", "threads", oauthOwnerFields(session));
      authUrl = threadsOAuthUrl(state);
    } else if (provider === "x") {
      if (!secureXOAuthReady()) return json(res, 409, { ok: false, error: xSecurityWarning() });
      if (!xClientId) return json(res, 409, { ok: false, error: "X_CLIENT_ID is not configured." });
      const verifier = codeVerifier();
      state = createOAuthState(model, "x", "x", { ...oauthOwnerFields(session), codeVerifier: verifier });
      authUrl = xOAuthUrl(state, codeChallenge(verifier));
    } else if (provider === "tiktok") {
      if (!secureTikTokOAuthReady()) return json(res, 409, { ok: false, error: tiktokSecurityWarning() });
      if (!tiktokClientKey) return json(res, 409, { ok: false, error: "TIKTOK_CLIENT_KEY is not configured." });
      state = createOAuthState(model, "tiktok", "tiktok", oauthOwnerFields(session));
      authUrl = tiktokOAuthUrl(state);
      oauthRuntimeLog("tiktok", "connect_url_issued", {
        ownerUserId: session?.user?.id || null,
        workspaceId: session?.user ? workspaceIdForUser(session.user) : null,
        mode: tiktokOAuthMode,
        redirectUri: tiktokRedirectUri(),
        scopes: tiktokScopes,
        clientKeyFingerprint: publicKeyFingerprint(tiktokClientKey),
        disableAutoAuth: process.env.TIKTOK_DISABLE_AUTO_AUTH || "1"
      });
    } else if (provider === "pinterest") {
      if (!securePinterestOAuthReady()) return json(res, 409, { ok: false, error: pinterestSecurityWarning() });
      if (!pinterestAppId) return json(res, 409, { ok: false, error: "PINTEREST_APP_ID is not configured." });
      state = createOAuthState(model, "pinterest", "pinterest", oauthOwnerFields(session));
      authUrl = pinterestOAuthUrl(state);
    } else if (provider === "etsy") {
      if (!secureEtsyOAuthReady()) return json(res, 409, { ok: false, error: etsySecurityWarning() });
      if (!etsyClientId) return json(res, 409, { ok: false, error: "ETSY_CLIENT_ID is not configured." });
      const verifier = codeVerifier();
      state = createOAuthState(model, "etsy", "etsy", { ...oauthOwnerFields(session), codeVerifier: verifier });
      authUrl = etsyOAuthUrl(state, codeChallenge(verifier));
    } else if (provider === "shopify") {
      if (!secureShopifyOAuthReady()) return json(res, 409, { ok: false, error: shopifySecurityWarning() });
      if (!shopifyClientId || !shopifyClientSecret) return json(res, 409, { ok: false, error: "SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are required before Shopify OAuth can start." });
      const shop = normalizeShopifyShop(url.searchParams.get("shop") || shopifyShopDomain);
      if (!shop) return json(res, 409, { ok: false, error: "SHOPIFY_SHOP_DOMAIN is required before Shopify OAuth can start. Use a myshopify.com test store domain from the Shopify Partners dashboard." });
      state = createOAuthState(model, "shopify", "shopify", { ...oauthOwnerFields(session), shop });
      authUrl = shopifyOAuthUrl(shop, state);
    } else if (provider === "twitch") {
      if (!secureTwitchOAuthReady()) return json(res, 409, { ok: false, error: twitchSecurityWarning() });
      if (!twitchClientId) return json(res, 409, { ok: false, error: "TWITCH_CLIENT_ID is not configured." });
      state = createOAuthState(model, "twitch", "twitch", oauthOwnerFields(session));
      authUrl = twitchOAuthUrl(state);
    } else if (provider === "canva") {
      if (!secureCanvaOAuthReady()) return json(res, 409, { ok: false, error: canvaSecurityWarning() });
      if (!canvaClientId) return json(res, 409, { ok: false, error: "CANVA_CLIENT_ID is not configured." });
      const verifier = codeVerifier();
      state = createOAuthState(model, "canva", "canva", { ...oauthOwnerFields(session), codeVerifier: verifier });
      authUrl = canvaOAuthUrl(state, codeChallenge(verifier));
    } else if (provider === "youtube") {
      if (!secureYouTubeOAuthReady()) return json(res, 409, { ok: false, error: youtubeSecurityWarning() });
      if (!googleClientId) return json(res, 409, { ok: false, error: "GOOGLE_CLIENT_ID is not configured." });
      state = createOAuthState(model, "youtube", "youtube", oauthOwnerFields(session));
      authUrl = youtubeOAuthUrl(state);
    } else if (provider === "meta") {
      const redirectUri = metaRedirectUri(req);
      if (!secureOAuthReady(req)) return json(res, 409, { ok: false, error: oauthSecurityWarning(req) });
      if (!metaAppId) return json(res, 409, { ok: false, error: "META_APP_ID is not configured." });
      state = createOAuthState(model, "meta", platform || "meta", { ...oauthOwnerFields(session), redirectUri });
      authUrl = metaOAuthUrl(platform || "meta", state, redirectUri);
    } else {
      return json(res, 400, { ok: false, error: "Unknown OAuth provider." });
    }
    await saveModel(model);
    if (url.searchParams.get("redirect") === "1") {
      res.writeHead(302, { Location: authUrl });
      return res.end();
    }
    return json(res, 200, { ok: true, provider, platform, url: authUrl });
  }

  if (url.pathname === "/api/oauth/threads/start" && req.method === "GET") {
    if (!secureThreadsOAuthReady()) {
      return html(res, 200, `<h1>HTTPS callback needed</h1><p>${threadsSecurityWarning()}</p><p>Current Threads callback:</p><p><code>${threadsRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!threadsAppId) {
      return html(res, 200, `<h1>Threads app id needed</h1><p>Add <code>THREADS_APP_ID</code> and <code>THREADS_APP_SECRET</code> to <code>outputs/Social Cues-testable-app/.env</code>, then restart Social Cues.</p><p>Use this redirect URI in Threads app settings:</p><p><code>${threadsRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const session = await oauthStartSession(model, req);
    if (runtimeMode === "vercel" && !session) return html(res, 401, `<h1>Sign in required</h1><p>Open Social Cues, sign in, then connect Threads from inside the app.</p><p><a href="/app">Back to Social Cues</a></p>`);
    const state = createOAuthState(model, "threads", "threads", oauthOwnerFields(session));
    await saveModel(model);
    res.writeHead(302, { Location: threadsOAuthUrl(state) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/threads/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    if (error) {
      return html(res, 200, `<h1>Threads connection stopped</h1><p>${escapeHtml(error)}</p><p><a href="/app">Back to Social Cues</a></p>`);
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
    const owner = userFromOAuthRecord(model, stateCheck.record);
    const ownerPatch = accountOwnerPatch(owner);
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === "threads" && (!owner || ownedByUser(item, owner.id)));
    if (!account) {
      account = { id: uid("acct"), platform: "threads", name: "Threads", handle: "", status: "not connected", connectedAt: null, ...ownerPatch };
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
      Object.assign(account, ownerPatch);
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
      Object.assign(account, ownerPatch);
      account.connectionEvidence = `Threads token exchange failed: ${exchangeError.message}`;
      model.integrations.threads = account.connectionEvidence;
    }
    await saveModelForUser(model, owner);
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
    const session = await oauthStartSession(model, req);
    if (runtimeMode === "vercel" && !session) return html(res, 401, `<h1>Sign in required</h1><p>Open Social Cues, sign in, then connect X from inside the app.</p><p><a href="/app">Back to Social Cues</a></p>`);
    const verifier = codeVerifier();
    const state = createOAuthState(model, "x", "x", { ...oauthOwnerFields(session), codeVerifier: verifier });
    await saveModel(model);
    res.writeHead(302, { Location: xOAuthUrl(state, codeChallenge(verifier)) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/x/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    if (error) {
      return html(res, 200, `<h1>X connection stopped</h1><p>${escapeHtml(error)}</p><p><a href="/app">Back to Social Cues</a></p>`);
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
    const owner = userFromOAuthRecord(model, stateCheck.record);
    const ownerPatch = accountOwnerPatch(owner);
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === "x" && (!owner || ownedByUser(item, owner.id)));
    if (!account) {
      account = { id: "acct-x", platform: "x", name: "X", handle: "", status: "not connected", connectedAt: null, ...ownerPatch };
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
      Object.assign(account, ownerPatch);
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
      Object.assign(account, ownerPatch);
      account.connectionEvidence = `X token exchange failed: ${exchangeError.message}`;
      model.integrations.x = account.connectionEvidence;
    }
    await saveModelForUser(model, owner);
    return html(res, 200, `<h1>X callback handled</h1><p>${model.integrations.x}</p><p><a href="/app">Back to Social Cues</a></p>`);
  }

  if (url.pathname === "/api/oauth/tiktok/start" && req.method === "GET") {
    if (!secureTikTokOAuthReady()) {
      return html(res, 200, `<h1>TikTok callback URL needed</h1><p>${tiktokSecurityWarning()}</p><p>Current TikTok callback:</p><p><code>${tiktokRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!tiktokClientKey) {
      return html(res, 200, `<h1>TikTok client key needed</h1><p>Add <code>TIKTOK_CLIENT_KEY</code> and <code>TIKTOK_CLIENT_SECRET</code> to <code>.env</code> or Vercel environment variables.</p><p>Use this redirect URI in TikTok Login Kit:</p><p><code>${tiktokRedirectUri()}</code></p><p>Requested scopes: <code>${tiktokScopes.join(",")}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const session = await oauthStartSession(model, req);
    if (runtimeMode === "vercel" && !session) return html(res, 401, `<h1>Sign in required</h1><p>Open Social Cues, sign in, then connect TikTok from inside the app.</p><p><a href="/app">Back to Social Cues</a></p>`);
    const state = createOAuthState(model, "tiktok", "tiktok", oauthOwnerFields(session));
    await saveModel(model);
    oauthRuntimeLog("tiktok", "start_redirect", {
      ownerUserId: session?.user?.id || null,
      workspaceId: session?.user ? workspaceIdForUser(session.user) : null,
      mode: tiktokOAuthMode,
      redirectUri: tiktokRedirectUri(),
      scopes: tiktokScopes,
      clientKeyFingerprint: publicKeyFingerprint(tiktokClientKey),
      disableAutoAuth: process.env.TIKTOK_DISABLE_AUTO_AUTH || "1"
    });
    res.writeHead(302, { Location: tiktokOAuthUrl(state) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/tiktok/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    oauthRuntimeLog("tiktok", "callback_received", {
      hasCode: Boolean(code),
      hasState: Boolean(state),
      returnedError: error || null
    });
    if (error) {
      oauthRuntimeLog("tiktok", "callback_provider_error", { returnedError: error });
      return html(res, 200, `<h1>TikTok connection stopped</h1><p>${escapeHtml(error)}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!code) {
      oauthRuntimeLog("tiktok", "callback_missing_code", { hasState: Boolean(state) });
      return html(res, 200, `<h1>No TikTok code received</h1><p>TikTok did not return an authorization code.</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const stateCheck = consumeOAuthState(model, "tiktok", state);
    if (!stateCheck.ok) {
      await saveModel(model);
      oauthRuntimeLog("tiktok", "state_rejected", { reason: stateCheck.error });
      return html(res, 400, `<h1>TikTok OAuth state rejected</h1><p>${stateCheck.error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const owner = userFromOAuthRecord(model, stateCheck.record);
    const ownerPatch = accountOwnerPatch(owner);
    oauthRuntimeLog("tiktok", "state_accepted", {
      ownerUserId: owner?.id || null,
      workspaceId: owner ? workspaceIdForUser(owner) : null
    });
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === "tiktok" && (!owner || ownedByUser(item, owner.id)));
    if (!account) {
      account = { id: "acct-tiktok", platform: "tiktok", name: "TikTok", handle: "", status: "not connected", connectedAt: null, ...ownerPatch };
      model.connectedAccounts.push(account);
    }
    model.integrations = model.integrations || {};
    try {
      const token = await exchangeTikTokCode(code, stateCheck.record.codeVerifier || "");
      oauthRuntimeLog("tiktok", "token_exchange_success", {
        ownerUserId: owner?.id || null,
        providerAccountId: token.user?.open_id || null,
        displayNamePresent: Boolean(token.user?.display_name),
        scopes: String(token.scope || "").split(/[,\s]+/).filter(Boolean)
      });
      account.status = "connected";
      account.handle = token.user?.display_name || "TikTok";
      account.name = "TikTok";
      account.displayName = token.user?.display_name || account.displayName || account.handle || "TikTok account";
      account.connectedAt = new Date().toISOString();
      account.oauthProvider = "tiktok";
      Object.assign(account, ownerPatch);
      account.providerAccountId = token.user?.open_id || null;
      account.scopes = String(token.scope || "").split(/[,\s]+/).filter(Boolean);
      account.credential = encryptedToken(token.accessToken);
      account.refreshCredential = token.refreshToken ? encryptedToken(token.refreshToken) : null;
      account.tokenType = token.tokenType;
      account.tokenExpiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
      account.refreshTokenExpiresAt = token.refreshExpiresIn ? new Date(Date.now() + token.refreshExpiresIn * 1000).toISOString() : null;
      account.profile = token.user || {};
      model.integrations.tiktok = "TikTok connected and token stored";
    } catch (exchangeError) {
      account.status = "not connected";
      account.connectedAt = null;
      account.oauthProvider = "tiktok";
      Object.assign(account, ownerPatch);
      account.connectionEvidence = `TikTok token exchange failed: ${exchangeError.message}`;
      model.integrations.tiktok = account.connectionEvidence;
      oauthRuntimeLog("tiktok", "token_exchange_failed", {
        ownerUserId: owner?.id || null,
        error: exchangeError.message
      });
    }
    await saveModelForUser(model, owner);
    oauthRuntimeLog("tiktok", "callback_saved", {
      ownerUserId: owner?.id || null,
      connected: isRealConnectedAccount(account),
      tokenStored: hasStoredToken(account),
      providerAccountId: account.providerAccountId || null
    });
    return html(res, 200, `<h1>TikTok callback handled</h1><p>${model.integrations.tiktok}</p><p><a href="/app">Back to Social Cues</a></p>`);
  }

  if (url.pathname === "/api/oauth/pinterest/start" && req.method === "GET") {
    if (!securePinterestOAuthReady()) {
      return html(res, 200, `<h1>Pinterest callback URL needed</h1><p>${pinterestSecurityWarning()}</p><p>Current Pinterest callback:</p><p><code>${pinterestRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!pinterestAppId) {
      return html(res, 200, `<h1>Pinterest app id needed</h1><p>Create/connect the Pinterest developer app, then add <code>PINTEREST_APP_ID</code> and <code>PINTEREST_APP_SECRET</code> to Vercel environment variables.</p><p>Use this redirect URI in Pinterest Developers:</p><p><code>${pinterestRedirectUri()}</code></p><p>Requested scopes: <code>${pinterestScopes.join(",")}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const session = await oauthStartSession(model, req);
    if (runtimeMode === "vercel" && !session) return html(res, 401, `<h1>Sign in required</h1><p>Open Social Cues, sign in, then connect Pinterest from inside the app.</p><p><a href="/app">Back to Social Cues</a></p>`);
    const state = createOAuthState(model, "pinterest", "pinterest", oauthOwnerFields(session));
    await saveModel(model);
    res.writeHead(302, { Location: pinterestOAuthUrl(state) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/pinterest/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    if (error) {
      return html(res, 200, `<h1>Pinterest connection stopped</h1><p>${escapeHtml(error)}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!code) {
      return html(res, 200, `<h1>No Pinterest code received</h1><p>Pinterest did not return an authorization code.</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const stateCheck = consumeOAuthState(model, "pinterest", state);
    if (!stateCheck.ok) {
      await saveModel(model);
      return html(res, 400, `<h1>Pinterest OAuth state rejected</h1><p>${stateCheck.error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const owner = userFromOAuthRecord(model, stateCheck.record);
    const ownerPatch = accountOwnerPatch(owner);
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === "pinterest" && (!owner || ownedByUser(item, owner.id)));
    if (!account) {
      account = { id: "acct-pinterest", platform: "pinterest", name: "Pinterest", handle: "", status: "not connected", connectedAt: null, ...ownerPatch };
      model.connectedAccounts.push(account);
    }
    model.integrations = model.integrations || {};
    try {
      const token = await exchangePinterestCode(code);
      account.status = "connected";
      account.handle = token.user?.username ? `@${token.user.username}` : token.user?.profile_url || "Pinterest";
      account.name = token.user?.username || account.name || "Pinterest";
      account.connectedAt = new Date().toISOString();
      account.oauthProvider = "pinterest";
      Object.assign(account, ownerPatch);
      account.providerAccountId = token.user?.account_id || token.user?.id || null;
      account.scopes = String(token.scope || "").split(/[,\s]+/).filter(Boolean);
      account.credential = encryptedToken(token.accessToken);
      account.refreshCredential = token.refreshToken ? encryptedToken(token.refreshToken) : null;
      account.tokenType = token.tokenType;
      account.tokenExpiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
      account.refreshTokenExpiresAt = token.refreshExpiresIn ? new Date(Date.now() + token.refreshExpiresIn * 1000).toISOString() : null;
      account.profile = token.user || {};
      model.integrations.pinterest = "Pinterest connected and token stored";
    } catch (exchangeError) {
      account.status = "not connected";
      account.connectedAt = null;
      account.oauthProvider = "pinterest";
      Object.assign(account, ownerPatch);
      account.connectionEvidence = `Pinterest token exchange failed: ${exchangeError.message}`;
      model.integrations.pinterest = account.connectionEvidence;
    }
    await saveModelForUser(model, owner);
    return html(res, 200, `<h1>Pinterest callback handled</h1><p>${model.integrations.pinterest}</p><p><a href="/app">Back to Social Cues</a></p>`);
  }

  if (url.pathname === "/api/oauth/etsy/start" && req.method === "GET") {
    if (!secureEtsyOAuthReady()) {
      return html(res, 200, `<h1>Etsy callback URL needed</h1><p>${etsySecurityWarning()}</p><p>Current Etsy callback:</p><p><code>${etsyRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!etsyClientId) {
      return html(res, 200, `<h1>Etsy client id needed</h1><p>Create an Etsy developer app, then add <code>ETSY_CLIENT_ID</code> and <code>ETSY_CLIENT_SECRET</code> to Vercel environment variables.</p><p>Use this callback URL in Etsy Developers:</p><p><code>${etsyRedirectUri()}</code></p><p>Requested scopes: <code>${etsyScopes.join(" ")}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const session = await oauthStartSession(model, req);
    if (runtimeMode === "vercel" && !session) return html(res, 401, `<h1>Sign in required</h1><p>Open Social Cues, sign in, then connect Etsy from inside the app.</p><p><a href="/app">Back to Social Cues</a></p>`);
    const verifier = codeVerifier();
    const state = createOAuthState(model, "etsy", "etsy", { ...oauthOwnerFields(session), codeVerifier: verifier });
    await saveModel(model);
    res.writeHead(302, { Location: etsyOAuthUrl(state, codeChallenge(verifier)) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/etsy/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    if (error) {
      return html(res, 200, `<h1>Etsy connection stopped</h1><p>${escapeHtml(error)}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!code) {
      return html(res, 200, `<h1>No Etsy code received</h1><p>Etsy did not return an authorization code.</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const stateCheck = consumeOAuthState(model, "etsy", state);
    if (!stateCheck.ok) {
      await saveModel(model);
      return html(res, 400, `<h1>Etsy OAuth state rejected</h1><p>${stateCheck.error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const owner = userFromOAuthRecord(model, stateCheck.record);
    const ownerPatch = accountOwnerPatch(owner);
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === "etsy" && (!owner || ownedByUser(item, owner.id)));
    if (!account) {
      account = { id: "acct-etsy", platform: "etsy", name: "Etsy", handle: "", status: "not connected", connectedAt: null, ...ownerPatch };
      model.connectedAccounts.push(account);
    }
    model.integrations = model.integrations || {};
    try {
      const token = await exchangeEtsyCode(code, stateCheck.record.codeVerifier || "");
      const shop = Array.isArray(token.shops?.results) ? token.shops.results[0] : Array.isArray(token.shops) ? token.shops[0] : null;
      const loginName = token.user?.login_name || token.user?.primary_email || token.user?.user_id || token.userId || "Etsy";
      account.status = "connected";
      account.handle = shop?.shop_name || loginName;
      account.name = shop?.shop_name || loginName || account.name || "Etsy";
      account.connectedAt = new Date().toISOString();
      account.oauthProvider = "etsy";
      Object.assign(account, ownerPatch);
      account.providerAccountId = String(token.user?.user_id || token.userId || shop?.user_id || "");
      account.scopes = String(token.scope || "").split(/\s+/).filter(Boolean);
      account.credential = encryptedToken(token.accessToken);
      account.refreshCredential = token.refreshToken ? encryptedToken(token.refreshToken) : null;
      account.tokenType = token.tokenType;
      account.tokenExpiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
      account.profile = { user: token.user || null, shops: token.shops || null };
      model.integrations.etsy = "Etsy connected and token stored";
    } catch (exchangeError) {
      account.status = "not connected";
      account.connectedAt = null;
      account.oauthProvider = "etsy";
      Object.assign(account, ownerPatch);
      account.connectionEvidence = `Etsy token exchange failed: ${exchangeError.message}`;
      model.integrations.etsy = account.connectionEvidence;
    }
    await saveModelForUser(model, owner);
    return html(res, 200, `<h1>Etsy callback handled</h1><p>${model.integrations.etsy}</p><p><a href="/app">Back to Social Cues</a></p>`);
  }

  if (url.pathname === "/api/oauth/shopify/start" && req.method === "GET") {
    if (!secureShopifyOAuthReady()) {
      return html(res, 200, `<h1>Shopify callback URL needed</h1><p>${shopifySecurityWarning()}</p><p>Current Shopify callback:</p><p><code>${shopifyRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!shopifyClientId || !shopifyClientSecret) {
      return html(res, 200, `<h1>Shopify app credentials needed</h1><p>Create a Shopify Partner app, then add <code>SHOPIFY_CLIENT_ID</code> and <code>SHOPIFY_CLIENT_SECRET</code> to Vercel environment variables.</p><p>Use this callback URL in Shopify Partners:</p><p><code>${shopifyRedirectUri()}</code></p><p>Requested scopes: <code>${shopifyScopes.join(",")}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const shop = normalizeShopifyShop(url.searchParams.get("shop") || shopifyShopDomain);
    if (!shop) {
      return html(res, 200, `<h1>Shopify test store needed</h1><p>Add <code>SHOPIFY_SHOP_DOMAIN</code> with a test store domain from Shopify Partners, or open this route with <code>?shop=your-store.myshopify.com</code>.</p><p>Current callback:</p><p><code>${shopifyRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const session = await oauthStartSession(model, req);
    if (runtimeMode === "vercel" && !session) return html(res, 401, `<h1>Sign in required</h1><p>Open Social Cues, sign in, then connect Shopify from inside the app.</p><p><a href="/app">Back to Social Cues</a></p>`);
    const state = createOAuthState(model, "shopify", "shopify", { ...oauthOwnerFields(session), shop });
    await saveModel(model);
    res.writeHead(302, { Location: shopifyOAuthUrl(shop, state) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/shopify/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    const shop = normalizeShopifyShop(url.searchParams.get("shop") || shopifyShopDomain);
    if (error) {
      return html(res, 200, `<h1>Shopify connection stopped</h1><p>${escapeHtml(error)}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!code || !shop) {
      return html(res, 200, `<h1>Shopify callback incomplete</h1><p>Shopify did not return both an authorization code and a valid shop domain.</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!verifyShopifyHmac(url.searchParams)) {
      return html(res, 400, `<h1>Shopify callback rejected</h1><p>The Shopify HMAC did not validate. Restart the Shopify connection from Social Cues.</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const stateCheck = consumeOAuthState(model, "shopify", state);
    if (!stateCheck.ok) {
      await saveModel(model);
      return html(res, 400, `<h1>Shopify OAuth state rejected</h1><p>${stateCheck.error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const owner = userFromOAuthRecord(model, stateCheck.record);
    const ownerPatch = accountOwnerPatch(owner);
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === "shopify" && (!owner || ownedByUser(item, owner.id)));
    if (!account) {
      account = { id: "acct-shopify", platform: "shopify", name: "Shopify", handle: "", status: "not connected", connectedAt: null, ...ownerPatch };
      model.connectedAccounts.push(account);
    }
    model.integrations = model.integrations || {};
    try {
      const token = await exchangeShopifyCode(shop, code);
      account.status = "connected";
      account.handle = token.shop;
      account.name = token.shop;
      account.connectedAt = new Date().toISOString();
      account.oauthProvider = "shopify";
      Object.assign(account, ownerPatch);
      account.providerAccountId = token.shop;
      account.scopes = token.scopes;
      account.credential = encryptedToken(token.accessToken);
      account.refreshCredential = null;
      account.tokenType = "Bearer";
      account.profile = { shop: token.shop, scope: token.scopes };
      model.integrations.shopify = "Shopify connected and token stored";
    } catch (exchangeError) {
      account.status = "not connected";
      account.connectedAt = null;
      account.oauthProvider = "shopify";
      Object.assign(account, ownerPatch);
      account.connectionEvidence = `Shopify token exchange failed: ${exchangeError.message}`;
      model.integrations.shopify = account.connectionEvidence;
    }
    await saveModelForUser(model, owner);
    return html(res, 200, `<h1>Shopify callback handled</h1><p>${model.integrations.shopify}</p><p><a href="/app">Back to Social Cues</a></p>`);
  }

  if (url.pathname === "/api/oauth/twitch/start" && req.method === "GET") {
    if (!secureTwitchOAuthReady()) {
      return html(res, 200, `<h1>Twitch callback URL needed</h1><p>${twitchSecurityWarning()}</p><p>Current Twitch callback:</p><p><code>${twitchRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!twitchClientId) {
      return html(res, 200, `<h1>Twitch client id needed</h1><p>Create a Twitch developer app, then add <code>TWITCH_CLIENT_ID</code> and <code>TWITCH_CLIENT_SECRET</code> to Vercel environment variables.</p><p>Use this OAuth redirect URL in Twitch Developers:</p><p><code>${twitchRedirectUri()}</code></p><p>Requested scopes: <code>${twitchScopes.join(" ")}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const session = await oauthStartSession(model, req);
    if (runtimeMode === "vercel" && !session) return html(res, 401, `<h1>Sign in required</h1><p>Open Social Cues, sign in, then connect Twitch from inside the app.</p><p><a href="/app">Back to Social Cues</a></p>`);
    const state = createOAuthState(model, "twitch", "twitch", oauthOwnerFields(session));
    await saveModel(model);
    res.writeHead(302, { Location: twitchOAuthUrl(state) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/twitch/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    if (error) {
      return html(res, 200, `<h1>Twitch connection stopped</h1><p>${escapeHtml(error)}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!code) {
      return html(res, 200, `<h1>No Twitch code received</h1><p>Twitch did not return an authorization code.</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const stateCheck = consumeOAuthState(model, "twitch", state);
    if (!stateCheck.ok) {
      await saveModel(model);
      return html(res, 400, `<h1>Twitch OAuth state rejected</h1><p>${stateCheck.error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const owner = userFromOAuthRecord(model, stateCheck.record);
    const ownerPatch = accountOwnerPatch(owner);
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === "twitch" && (!owner || ownedByUser(item, owner.id)));
    if (!account) {
      account = { id: "acct-twitch", platform: "twitch", name: "Twitch", handle: "", status: "not connected", connectedAt: null, ...ownerPatch };
      model.connectedAccounts.push(account);
    }
    model.integrations = model.integrations || {};
    try {
      const token = await exchangeTwitchCode(code);
      account.status = "connected";
      account.handle = token.user?.login ? `@${token.user.login}` : token.user?.display_name || "Twitch";
      account.name = token.user?.display_name || account.name || "Twitch";
      account.connectedAt = new Date().toISOString();
      account.oauthProvider = "twitch";
      Object.assign(account, ownerPatch);
      account.providerAccountId = token.user?.id || null;
      account.scopes = String(token.scope || "").split(/\s+/).filter(Boolean);
      account.credential = encryptedToken(token.accessToken);
      account.refreshCredential = token.refreshToken ? encryptedToken(token.refreshToken) : null;
      account.tokenType = token.tokenType;
      account.tokenExpiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
      account.profile = token.user || {};
      model.integrations.twitch = "Twitch connected and token stored";
    } catch (exchangeError) {
      account.status = "not connected";
      account.connectedAt = null;
      account.oauthProvider = "twitch";
      Object.assign(account, ownerPatch);
      account.connectionEvidence = `Twitch token exchange failed: ${exchangeError.message}`;
      model.integrations.twitch = account.connectionEvidence;
    }
    await saveModelForUser(model, owner);
    return html(res, 200, `<h1>Twitch callback handled</h1><p>${model.integrations.twitch}</p><p><a href="/app">Back to Social Cues</a></p>`);
  }

  if (url.pathname === "/api/oauth/canva/start" && req.method === "GET") {
    if (!secureCanvaOAuthReady()) {
      return html(res, 200, `<h1>Canva callback URL needed</h1><p>${canvaSecurityWarning()}</p><p>Current Canva callback:</p><p><code>${canvaRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!canvaClientId) {
      return html(res, 200, `<h1>Canva client id needed</h1><p>Create a Canva Connect integration, then add <code>CANVA_CLIENT_ID</code> and <code>CANVA_CLIENT_SECRET</code> to Vercel environment variables.</p><p>Use this redirect URI in Canva Developer Portal:</p><p><code>${canvaRedirectUri()}</code></p><p>Requested scopes: <code>${canvaScopes.join(" ")}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const session = await oauthStartSession(model, req);
    if (runtimeMode === "vercel" && !session) return html(res, 401, `<h1>Sign in required</h1><p>Open Social Cues, sign in, then connect Canva from inside the app.</p><p><a href="/app">Back to Social Cues</a></p>`);
    const verifier = codeVerifier();
    const state = createOAuthState(model, "canva", "canva", { ...oauthOwnerFields(session), codeVerifier: verifier });
    await saveModel(model);
    res.writeHead(302, { Location: canvaOAuthUrl(state, codeChallenge(verifier)) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/canva/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    if (error) {
      return html(res, 200, `<h1>Canva connection stopped</h1><p>${escapeHtml(error)}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!code) {
      return html(res, 200, `<h1>No Canva code received</h1><p>Canva did not return an authorization code.</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const stateCheck = consumeOAuthState(model, "canva", state);
    if (!stateCheck.ok) {
      await saveModel(model);
      return html(res, 400, `<h1>Canva OAuth state rejected</h1><p>${stateCheck.error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const owner = userFromOAuthRecord(model, stateCheck.record);
    const ownerPatch = accountOwnerPatch(owner);
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === "canva" && (!owner || ownedByUser(item, owner.id)));
    if (!account) {
      account = { id: "acct-canva", platform: "canva", name: "Canva", handle: "", status: "not connected", connectedAt: null, ...ownerPatch };
      model.connectedAccounts.push(account);
    }
    model.integrations = model.integrations || {};
    try {
      const token = await exchangeCanvaCode(code, stateCheck.record.codeVerifier || "");
      account.status = "connected";
      account.handle = token.user?.profile?.display_name || token.user?.display_name || "Canva";
      account.name = token.user?.profile?.display_name || account.name || "Canva";
      account.connectedAt = new Date().toISOString();
      account.oauthProvider = "canva";
      Object.assign(account, ownerPatch);
      account.providerAccountId = token.user?.profile?.user_id || token.user?.id || null;
      account.scopes = String(token.scope || "").split(/\s+/).filter(Boolean);
      account.credential = encryptedToken(token.accessToken);
      account.refreshCredential = token.refreshToken ? encryptedToken(token.refreshToken) : null;
      account.tokenType = token.tokenType;
      account.tokenExpiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
      account.profile = token.user || {};
      model.integrations.canva = "Canva connected and token stored";
    } catch (exchangeError) {
      account.status = "not connected";
      account.connectedAt = null;
      account.oauthProvider = "canva";
      Object.assign(account, ownerPatch);
      account.connectionEvidence = `Canva token exchange failed: ${exchangeError.message}`;
      model.integrations.canva = account.connectionEvidence;
    }
    await saveModelForUser(model, owner);
    return html(res, 200, `<h1>Canva callback handled</h1><p>${model.integrations.canva}</p><p><a href="/app">Back to Social Cues</a></p>`);
  }

  if (url.pathname === "/api/oauth/youtube/start" && req.method === "GET") {
    if (!secureYouTubeOAuthReady()) {
      return html(res, 200, `<h1>YouTube callback URL needed</h1><p>${youtubeSecurityWarning()}</p><p>Current YouTube callback:</p><p><code>${youtubeRedirectUri()}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!googleClientId) {
      return html(res, 200, `<h1>Google OAuth client needed</h1><p>Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to Vercel environment variables.</p><p>Use this redirect URI in Google Cloud OAuth client settings:</p><p><code>${youtubeRedirectUri()}</code></p><p>Requested scopes: <code>${youtubeScopes.join(" ")}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const session = await oauthStartSession(model, req);
    if (runtimeMode === "vercel" && !session) return html(res, 401, `<h1>Sign in required</h1><p>Open Social Cues, sign in, then connect YouTube from inside the app.</p><p><a href="/app">Back to Social Cues</a></p>`);
    const state = createOAuthState(model, "youtube", "youtube", oauthOwnerFields(session));
    await saveModel(model);
    res.writeHead(302, { Location: youtubeOAuthUrl(state) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/youtube/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    if (error) {
      return html(res, 200, `<h1>YouTube connection stopped</h1><p>${escapeHtml(error)}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!code) {
      return html(res, 200, `<h1>No YouTube code received</h1><p>Google did not return an authorization code.</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const stateCheck = consumeOAuthState(model, "youtube", state);
    if (!stateCheck.ok) {
      await saveModel(model);
      return html(res, 400, `<h1>YouTube OAuth state rejected</h1><p>${stateCheck.error}</p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const owner = userFromOAuthRecord(model, stateCheck.record);
    const ownerPatch = accountOwnerPatch(owner);
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === "youtube" && (!owner || ownedByUser(item, owner.id)));
    if (!account) {
      account = { id: "acct-youtube", platform: "youtube", name: "YouTube", handle: "", status: "not connected", connectedAt: null, ...ownerPatch };
      model.connectedAccounts.push(account);
    }
    model.integrations = model.integrations || {};
    try {
      const token = await exchangeGoogleCode(code);
      const channel = token.channel || {};
      account.status = "connected";
      account.handle = channel.snippet?.customUrl || channel.snippet?.title || "YouTube channel";
      account.name = channel.snippet?.title || account.name || "YouTube";
      account.connectedAt = new Date().toISOString();
      account.oauthProvider = "google";
      Object.assign(account, ownerPatch);
      account.providerAccountId = channel.id || null;
      account.scopes = String(token.scope || "").split(/\s+/).filter(Boolean);
      account.credential = encryptedToken(token.accessToken);
      account.refreshCredential = token.refreshToken ? encryptedToken(token.refreshToken) : account.refreshCredential || null;
      account.tokenType = token.tokenType;
      account.tokenExpiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
      account.channel = channel;
      model.integrations.youtube = "YouTube connected and token stored";
    } catch (exchangeError) {
      account.status = "not connected";
      account.connectedAt = null;
      account.oauthProvider = "google";
      Object.assign(account, ownerPatch);
      account.connectionEvidence = `YouTube token exchange failed: ${exchangeError.message}`;
      model.integrations.youtube = account.connectionEvidence;
    }
    await saveModelForUser(model, owner);
    return html(res, 200, `<h1>YouTube callback handled</h1><p>${model.integrations.youtube}</p><p><a href="/app">Back to Social Cues</a></p>`);
  }

  if (url.pathname === "/api/oauth/meta/start" && req.method === "GET") {
    const platform = url.searchParams.get("platform") || "meta";
    const redirectUri = metaRedirectUri(req);
    if (!secureOAuthReady(req)) {
      return html(res, 200, `<h1>HTTPS callback needed</h1><p>${oauthSecurityWarning(req)}</p><p>Current Meta callback:</p><p><code>${redirectUri}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    if (!metaAppId) {
      return html(res, 200, `<h1>Meta app id needed</h1><p>Add <code>META_APP_ID</code> and <code>META_APP_SECRET</code> to <code>outputs/Social Cues-testable-app/.env</code>, then restart Social Cues.</p><p>Use this redirect URI in Meta:</p><p><code>${redirectUri}</code></p><p><a href="/app">Back to Social Cues</a></p>`);
    }
    const model = await getModel();
    const session = await oauthStartSession(model, req);
    if (runtimeMode === "vercel" && !session) return html(res, 401, `<h1>Sign in required</h1><p>Open Social Cues, sign in, then connect Meta from inside the app.</p><p><a href="/app">Back to Social Cues</a></p>`);
    const state = createOAuthState(model, "meta", platform, { ...oauthOwnerFields(session), redirectUri });
    await saveModel(model);
    res.writeHead(302, { Location: metaOAuthUrl(platform, state, redirectUri) });
    return res.end();
  }

  if (url.pathname === "/api/oauth/meta/callback" && req.method === "GET") {
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    if (error) {
      return html(res, 200, `<h1>Meta connection stopped</h1><p>${escapeHtml(error)}</p><p><a href="/app">Back to Social Cues</a></p>`);
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
    const owner = userFromOAuthRecord(model, stateCheck.record);
    let connected = [];
    let exchangeError = null;
    if (metaAppSecret) {
      try {
        connected = await connectMetaAssets(model, code, stateCheck.record.redirectUri || metaRedirectUri(req), owner);
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
    await saveModelForUser(model, owner);
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
      authProvider,
      authReady: Boolean(supabaseUrl && (supabaseAnonKey || supabaseServiceKey)),
      storageReady: mediaStorageReady(),
      mediaBucket: mediaStorageBucket,
      requiredEnv: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY"],
      authRequiredEnv: ["SUPABASE_URL", "SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY"],
      storageRequiredEnv: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY", "MEDIA_STORAGE_BUCKET"]
    });
  }

  if (url.pathname === "/api/auth/readiness" && req.method === "GET") {
    const smtp = authSmtpReadiness();
    return json(res, 200, {
      ok: true,
      provider: authProvider,
      supabaseConfigured: Boolean(supabaseUrl && (supabaseAnonKey || supabaseServiceKey)),
      alphaLocalFallback: !supabaseAuthEnabled(),
      customSmtpReady: smtp.ready,
      emailVerificationRequired: supabaseAuthEnabled(),
      signupSessionPolicy: supabaseAuthEnabled()
        ? "New Supabase signups must verify email before Social Cues issues an app session or applies promo/paid access."
        : "Local development signup can create sessions immediately; production uses Supabase email verification.",
      sessionStorage: supabaseAuthEnabled()
        ? "Supabase Auth access tokens identify users; Social Cues stores only HMAC-hashed remembered-device bindings."
        : "Alpha fallback stores HMAC-hashed device sessions; plaintext tokens are returned once at login only.",
      nextSwitch: supabaseAuthEnabled()
        ? (smtp.ready && smtp.supabaseDashboardApplied ? "Complete account recovery UX and login alerts before public customer launch; server authorization and request rate limits are active." : smtp.ready ? "Confirm SMTP is saved in Supabase Auth settings, then complete email verification policy and account recovery UX before public customer launch." : "Configure Supabase custom SMTP before public customer signup.")
        : "Configure Supabase Auth keys so server APIs can validate Supabase access tokens instead of alpha device tokens.",
      missingEnv: [...["SUPABASE_URL"].filter(name => !envPresent(name)), ...missingSupabasePublicAuthEnv(), ...smtp.missingEnv]
    });
  }

  if (url.pathname === "/api/auth/smtp/readiness" && req.method === "GET") {
    return json(res, 200, { ok: true, ...authSmtpReadiness() });
  }

  if ((url.pathname === "/api/resend/readiness" || url.pathname === "/api/resend/status") && req.method === "GET") {
    return json(res, 200, { ok: true, ...resendReadiness() });
  }

  if (url.pathname === "/api/security/audit" && req.method === "GET") {
    const smtp = authSmtpReadiness();
    const tokenEncryption = oauthTokenEncryptionReadiness();
    const publicModelHidesUsers = true;
    const workspaceIsolation = "All protected API routes require a valid server session and load a request-scoped owner workspace before reading provider accounts, tokens, campaigns, actions, media, or analytics.";
    const productionNeedsSecret = runtimeMode === "vercel" && !(process.env.AUTH_SESSION_SECRET || process.env.OAUTH_TOKEN_ENCRYPTION_KEY);
    return json(res, 200, {
      ok: true,
      runtimeMode,
      headers: {
        cacheControl: "no-store",
        contentSniffing: "blocked",
        framing: "denied",
        crossOriginIsolation: "same-origin opener and resource policy",
        strictTransportSecurity: runtimeMode === "vercel",
        referrerPolicy: "strict-origin-when-cross-origin",
        permissionsPolicy: "camera and microphone limited to this app"
      },
      bodyLimitBytes: maxJsonBodyBytes,
      auth: {
        provider: authProvider,
        supabaseReady: Boolean(supabaseUrl && supabaseAnonKey),
        customSmtpReady: smtp.ready,
        sessionHashesUseServerSecret: supabaseAuthEnabled() || !productionNeedsSecret,
        publicUserListHidden: publicModelHidesUsers,
        workspaceIsolation,
        defaultDenyApiPolicy: true,
        cookieWriteOriginChecks: true,
        requestRateLimits: true,
        durableAuthRateLimits: supabaseEnabled,
        durableHighCostRateLimits: supabaseEnabled,
        rawWebhookPayloadsRetained: false,
        adminAllowlistConfigured: adminEmails.size > 0,
        inviteOnlySignup: !publicSignupEnabled,
        globalAdminRoleDerivedFromServerEmailAllowlistOnly: true,
        workspaceModelMirror: supabaseEnabled ? "active when the signed-in user has a Supabase UUID id" : "disabled until Supabase server storage is configured",
        oauthOwnerBinding: "Provider connect URLs are created through an authenticated endpoint and OAuth callbacks stamp connected accounts with ownerUserId/workspaceId from validated state.",
        missingEnv: [
          ...["SUPABASE_URL"].filter(name => !envPresent(name)),
          ...missingSupabasePublicAuthEnv(),
          ...smtp.missingEnv,
          ...(productionNeedsSecret ? ["AUTH_SESSION_SECRET"] : []),
          ...(adminEmails.size ? [] : ["SOCIAL_CUES_ADMIN_EMAILS"]),
          ...tokenEncryption.missingEnv
        ]
      },
      storage: {
        provider: mediaStorageProvider,
        bucket: mediaStorageBucket,
        ready: mediaStorageReady(),
        missingEnv: mediaStorageProvider === "supabase-storage"
          ? [...["SUPABASE_URL"].filter(name => !envPresent(name)), ...missingSupabaseServiceEnv()]
          : ["VERCEL_BLOB_READ_WRITE_TOKEN"].filter(name => !envPresent(name))
      },
      secrets: {
        exposedToBrowser: false,
        oauthTokenEncryption: tokenEncryption,
        note: "Server readiness endpoints return booleans and missing variable names only, not secret values."
      },
      remainingGaps: [
        ...(authProvider === "supabase" && !supabaseAnonKey ? ["Supabase browser auth key is not configured yet."] : []),
        ...(authProvider === "supabase" && !smtp.ready ? ["Supabase custom SMTP is not configured for production signup email."] : []),
        ...(!mediaStorageReady() ? ["Media storage is not ready for real uploads yet."] : []),
        ...(productionNeedsSecret ? ["Production needs AUTH_SESSION_SECRET before account launch."] : []),
        ...(!adminEmails.size ? ["Configure SOCIAL_CUES_ADMIN_EMAILS before enabling internal diagnostics."] : []),
        ...(!tokenEncryption.productionReady ? ["Production needs OAUTH_TOKEN_ENCRYPTION_KEY so provider tokens do not depend on fallback key material."] : []),
        "app_state.primary is now a server registry for auth, billing, OAuth state, and device sessions; signed-in client workspace content loads from per-user workspace_models."
      ]
    });
  }

  if (url.pathname === "/api/media/storage/readiness" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      provider: mediaStorageProvider,
      ready: mediaStorageReady(),
      bucket: mediaStorageBucket,
      maxUploadMb: mediaMaxUploadMb,
      serverSideOnly: true,
      missingEnv: mediaStorageProvider === "supabase-storage"
        ? [...["SUPABASE_URL"].filter(name => !envPresent(name)), ...missingSupabaseServiceEnv()]
        : ["VERCEL_BLOB_READ_WRITE_TOKEN"].filter(name => !envPresent(name))
    });
  }

  if (url.pathname === "/api/media/assets" && req.method === "POST") {
    const input = await bodyJson(req);
    const sharedModel = await getModel();
    const session = await entitledSessionFromRequest(sharedModel, req);
    if (runtimeMode === "vercel" && !session) {
      return appAccessRequiredResponse(res);
    }
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    const userId = session?.user?.id || "alpha";
    if (session?.user) ensureUserWorkspace(model, session.user);
    const fileName = sanitizeStorageName(input.fileName || input.name || "media");
    const kind = String(input.kind || input.type || "media").startsWith("video") ? "video" : String(input.kind || input.type || "image").startsWith("image") ? "image" : "media";
    const storagePath = mediaStoragePath({ userId, fileName, kind });
    model.mediaAssets = model.mediaAssets || [];
    const asset = {
      id: uid("media"),
      provider: mediaStorageProvider,
      kind,
      title: input.title || fileName,
      fileName,
      storagePath,
      status: mediaStorageReady() ? "reserved" : "storage-not-configured",
      maxUploadMb: mediaMaxUploadMb,
      createdAt: new Date().toISOString(),
      createdBy: userId,
      ownerUserId: userId,
      workspaceId: session?.user ? workspaceIdForUser(session.user) : "local-dev-workspace"
    };
    model.mediaAssets.unshift(asset);
    await saveModelForUser(model, session?.user || null);
    return json(res, 200, {
      ok: true,
      asset,
      upload: {
        provider: mediaStorageProvider,
        bucket: mediaStorageBucket,
        storagePath,
        ready: mediaStorageReady(),
        note: mediaStorageReady()
          ? "Storage path reserved. Browser upload should use a short-lived signed upload URL in the next worker pass."
          : "Configure Supabase Storage credentials before accepting large client files."
      }
    });
  }

  if (url.pathname === "/api/model" && req.method === "GET") {
    const sharedModel = await getModel();
    const session = await sessionFromRequest(sharedModel, req);
    if ((runtimeMode === "vercel" || bearerToken(req)) && !session) {
      return json(res, 401, { ok: false, error: "Sign in to load this hosted Social Cues workspace." });
    }
    if (runtimeMode === "vercel" && session?.user && !hasActiveAppAccess(session.user)) {
      return appAccessRequiredResponse(res);
    }
    const model = await modelForSession(session, sharedModel);
    if (session?.user) {
      ensureUserWorkspace(model, session.user);
      await ensureWorkspaceBootstrap(model, session.user);
      await saveModelForUser(model, session.user);
    }
    return json(res, 200, publicModel(model, session));
  }

  if (url.pathname === "/api/model" && req.method === "POST") {
    const sharedExisting = await getModel();
    const session = await hostedWriteRequiresSession(req, sharedExisting);
    if (!session) {
      return json(res, 401, { ok: false, error: "Sign in before saving the hosted Social Cues workspace." });
    }
    const existing = await modelForSession(session, sharedExisting);
    if (session?.user) {
      ensureUserWorkspace(existing, session.user);
      await ensureWorkspaceBootstrap(existing, session.user);
    }
    const incoming = await bodyJson(req);
    const merged = mergePublicModelUpdate(incoming, existing, session?.user || null);
    sanitizeConnectedAccounts(merged);
    return json(res, 200, publicModel(await saveModelForUser(merged, session?.user || null), session && session.user ? session : null));
  }

  if (url.pathname === "/api/auth/signup" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    const created = await createAppAccount(model, input);
    if (!created.ok) return json(res, created.status || 400, {
      ok: false,
      error: created.error,
      requiresEmailVerification: Boolean(created.requiresEmailVerification),
      email: created.email || normalizeEmail(input.email),
      promoPending: Boolean(created.promoPending)
    });
    const user = created.user;
    const token = created.providerSession?.access_token || crypto.randomBytes(32).toString("base64url");
    const device = upsertDeviceSession(model, user, input.device || input, token, created.providerSession);
    setCurrentUser(model, user);
    await saveSharedModel(model);
    const workspaceModel = await clientWorkspaceModelForUser(user, input, model);
    await saveModelForUser(workspaceModel, user);
    setCookie(res, sessionCookieValue(token, device.expiresAt));
    return json(res, 200, accountSessionResponse(workspaceModel, user, device, token));
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    const loggedIn = await loginAppAccount(model, input);
    if (!loggedIn.ok) return json(res, loggedIn.status || 401, { ok: false, error: loggedIn.error });
    const user = loggedIn.user;
    const token = loggedIn.providerSession?.access_token || crypto.randomBytes(32).toString("base64url");
    const device = upsertDeviceSession(model, user, input.device || input, token, loggedIn.providerSession);
    setCurrentUser(model, user);
    await saveSharedModel(model);
    const workspaceModel = hasActiveAppAccess(user) ? await modelForSession({ user }, model) : model;
    if (hasActiveAppAccess(user)) {
      ensureUserWorkspace(workspaceModel, user, input);
      await saveModelForUser(workspaceModel, user);
    } else {
      await saveModel(model);
    }
    setCookie(res, sessionCookieValue(token, device.expiresAt));
    return json(res, 200, accountSessionResponse(workspaceModel, user, device, token));
  }

  if (url.pathname === "/api/auth/session" && req.method === "GET") {
    const model = await getModel();
    const session = await sessionFromRequest(model, req);
    if (!session) return json(res, 401, { ok: false, error: "No active Social Cues session on this device." });
    session.device.lastSeenAt = new Date().toISOString();
    session.user.lastLoginAt = session.user.lastLoginAt || new Date().toISOString();
    const workspaceModel = hasActiveAppAccess(session.user) ? await modelForSession(session, model) : model;
    if (hasActiveAppAccess(session.user)) ensureUserWorkspace(workspaceModel, session.user);
    setCurrentUser(model, session.user);
    await saveSharedModel(model);
    if (hasActiveAppAccess(session.user)) await saveModelForUser(workspaceModel, session.user);
    else await saveModel(model);
    setCookie(res, sessionCookieValue(session.token, session.device.expiresAt));
    return json(res, 200, accountSessionResponse(workspaceModel, session.user, session.device, ""));
  }

  if (url.pathname === "/api/auth/device/heartbeat" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    const session = await sessionFromRequest(model, req);
    if (!session) return json(res, 401, { ok: false, error: "No active Social Cues session on this device." });
    Object.assign(session.device, {
      name: input.deviceName || session.device.name,
      kind: detectDeviceKind({ ...session.device, ...input }),
      userAgent: input.userAgent || session.device.userAgent || "",
      platform: input.platform || session.device.platform || "",
      language: input.language || session.device.language || "",
      screen: input.screen || session.device.screen || "",
      timeZone: input.timeZone || session.device.timeZone || "",
      lastSeenAt: new Date().toISOString()
    });
    await saveModel(model);
    return json(res, 200, { ok: true, device: publicDeviceSession(session.device), devices: publicDeviceSessions(model, session.user.id) });
  }

  if (url.pathname === "/api/devices" && req.method === "GET") {
    const model = await getModel();
    const session = await sessionFromRequest(model, req);
    if (!session) return json(res, 401, { ok: false, error: "No active Social Cues session on this device.", devices: [] });
    session.device.lastSeenAt = new Date().toISOString();
    await saveModel(model);
    return json(res, 200, { ok: true, currentDeviceId: session.device.deviceId, devices: publicDeviceSessions(model, session.user.id) });
  }

  if (url.pathname === "/api/auth/entitlement" && req.method === "GET") {
    const model = await getModel();
    const session = await sessionFromRequest(model, req);
    if (!session) return json(res, 401, { ok: false, error: "No active Social Cues session on this device." });
    return json(res, 200, {
      ok: true,
      entitlement: publicEntitlement(session.user),
      accessMessage: publicEntitlement(session.user).active
        ? "Full test access is active for this account."
        : "No paid or promo access is active yet."
    });
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const model = await getModel();
    const session = await sessionFromRequest(model, req);
    if (session) {
      session.device.revokedAt = new Date().toISOString();
      session.device.lastSeenAt = new Date().toISOString();
    }
    model.currentUser = null;
    await saveModel(model);
    setCookie(res, expiredSessionCookieValue());
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/workspace/model/status" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    if (!session) return appAccessRequiredResponse(res);
    const status = await workspaceModelMirrorStatus(session.user);
    return json(res, 200, { ok: true, ...status });
  }

  if (url.pathname === "/api/generate/platform-variants" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) {
      return appAccessRequiredResponse(res);
    }
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
    const model = await getModel();
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) {
      return appAccessRequiredResponse(res);
    }
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
    const sharedModel = await getModel();
    const session = await hostedWriteRequiresSession(req, sharedModel);
    if (!session) {
      return json(res, 401, { ok: false, error: "Sign in before adding proof to this workspace." });
    }
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    if (session?.user) ensureUserWorkspace(model, session.user);
    model.proof = model.proof || [];
    model.proof.unshift({
      id: uid("proof"),
      type: input.type || "Growth win",
      metric: input.metric || "Unlabeled proof",
      note: input.note || "",
      createdAt: new Date().toISOString(),
      ownerUserId: session?.user?.id || "alpha",
      workspaceId: session?.user ? workspaceIdForUser(session.user) : "local-dev-workspace"
    });
    await saveModelForUser(model, session?.user || null);
    return json(res, 200, { ok: true, proof: model.proof[0] });
  }

  if (url.pathname === "/api/actions" && req.method === "GET") {
    const sharedModel = await getModel();
    const session = await entitledSessionFromRequest(sharedModel, req);
    if (runtimeMode === "vercel" && !session) {
      return appAccessRequiredResponse(res);
    }
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    if (session?.user) ensureUserWorkspace(model, session.user);
    return json(res, 200, { ok: true, actions: session?.user ? ownedCollection(model, "actions", session.user) : model.actions || [] });
  }

  if (url.pathname === "/api/actions" && req.method === "POST") {
    const input = await bodyJson(req);
    const sharedModel = await getModel();
    const session = await hostedWriteRequiresSession(req, sharedModel);
    if (!session) {
      return json(res, 401, { ok: false, error: "Sign in before changing action items." });
    }
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    if (session?.user) ensureUserWorkspace(model, session.user);
    model.actions = model.actions || [];
    const action = {
      id: uid("act"),
      type: input.type || "Experiment",
      priority: input.priority || "Medium",
      status: input.status || "active",
      title: input.title || "Untitled action",
      signal: input.signal || "Signal not defined yet.",
      createdAt: new Date().toISOString(),
      ownerUserId: session?.user?.id || "alpha",
      workspaceId: session?.user ? workspaceIdForUser(session.user) : "local-dev-workspace"
    };
    model.actions.unshift(action);
    await saveModelForUser(model, session?.user || null);
    return json(res, 200, { ok: true, action });
  }

  if (url.pathname.startsWith("/api/actions/") && req.method === "POST") {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const input = await bodyJson(req);
    const sharedModel = await getModel();
    const session = await hostedWriteRequiresSession(req, sharedModel);
    if (!session) {
      return json(res, 401, { ok: false, error: "Sign in before changing action items." });
    }
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    if (session?.user) ensureUserWorkspace(model, session.user);
    const action = (model.actions || []).find(item => item.id === id && (!session?.user || ownedByUser(item, session.user.id)));
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
        createdAt: new Date().toISOString(),
        ownerUserId: session?.user?.id || "alpha",
        workspaceId: session?.user ? workspaceIdForUser(session.user) : "local-dev-workspace"
      });
    }
    await saveModelForUser(model, session?.user || null);
    return json(res, 200, { ok: true, action });
  }

  if (url.pathname === "/api/integrations/readiness" && req.method === "GET") {
    const model = await getModel();
    const coreServices = publicServiceReadiness();
    return json(res, 200, {
      ok: true,
      readiness: publicIntegrationReadiness(model.integrations),
      coreServices,
      futureApiBacklog: apiBacklog,
      envRequired: ["OPENAI_API_KEY", "OPENAI_PROJECT_ID", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO_MONTHLY", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN", "RESEND_API_KEY", "SMTP_FROM", "SUPABASE_URL", "SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "MEDIA_STORAGE_BUCKET", "META_APP_ID", "META_APP_SECRET", "THREADS_APP_ID", "THREADS_APP_SECRET", "X_CLIENT_ID", "X_CLIENT_SECRET", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "PINTEREST_APP_ID", "PINTEREST_APP_SECRET", "CANVA_CLIENT_ID", "CANVA_CLIENT_SECRET", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "ETSY_CLIENT_ID", "ETSY_CLIENT_SECRET", "TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "YOUTUBE_CHANNEL_ID", "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_BUSINESS_ACCOUNT_ID", "GOOGLE_BUSINESS_LOCATION_ID", "GOOGLE_SEARCH_CONSOLE_SITE_URL", "GOOGLE_ANALYTICS_PROPERTY_ID"]
    });
  }

  if ((url.pathname === "/api/openai/readiness" || url.pathname === "/api/openai/status") && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      ready: Boolean(openaiApiKey),
      configured: Boolean(openaiApiKey),
      projectConfigured: Boolean(openaiProjectId),
      orgConfigured: Boolean(openaiOrgId),
      models: { text: openaiModel, image: openaiImageModel, video: openaiVideoModel || "not configured" },
      allowedUse: ["campaign generation", "growth analysis", "media edit plans", "caption and tag variants", "safety/checklist transforms"],
      serverSideOnly: true,
      missingEnv: ["OPENAI_API_KEY"].filter(name => !envPresent(name))
    });
  }

  if ((url.pathname === "/api/discord/readiness" || url.pathname === "/api/discord/status" || url.pathname === "/api/oauth/discord/status") && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      ready: Boolean(discordClientId && discordClientSecret),
      configured: Boolean(discordClientId && discordClientSecret),
      redirectUri: discordRedirectUri(),
      botReady: Boolean(discordBotToken),
      guildConfigured: Boolean(discordGuildId),
      announcementChannelConfigured: Boolean(discordAnnouncementChannelId),
      allowedUse: ["customer community login", "support server handoff", "campaign status notifications", "admin alerts"],
      missingEnv: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"].filter(name => !envPresent(name)),
      optionalMissingEnv: ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_ANNOUNCEMENT_CHANNEL_ID"].filter(name => !envPresent(name))
    });
  }

  if ((url.pathname === "/api/billing/readiness" || url.pathname === "/api/billing/status") && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      ready: Boolean(stripeSecretKey || stripePublishableKey),
      checkoutReady: Boolean(stripeSecretKey && (stripePriceFounderAudit || stripePriceCampaignBuild || stripePriceProMonthly)),
      webhookReady: Boolean(stripeWebhookSecret),
      webhookEndpoint: `${brandHomeUrl}/api/billing/webhook`,
      mode: stripeSecretKey ? "stripe-checkout-capable" : "payment-link-first",
      priceIds: {
        founderAudit: Boolean(stripePriceFounderAudit),
        campaignBuild: Boolean(stripePriceCampaignBuild),
        proMonthly: Boolean(stripePriceProMonthly)
      },
      missingEnv: ["STRIPE_SECRET_KEY"].filter(name => !envPresent(name)),
      optionalMissingEnv: ["STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_FOUNDER_AUDIT", "STRIPE_PRICE_CAMPAIGN_BUILD", "STRIPE_PRICE_PRO_MONTHLY"].filter(name => !envPresent(name))
    });
  }

  if (url.pathname === "/api/billing/webhook" && req.method === "POST") {
    const raw = await bodyText(req);
    let event;
    try {
      event = verifyStripeWebhook(raw, req.headers["stripe-signature"] || "");
    } catch (error) {
      return json(res, stripeWebhookSecret ? 400 : 503, { ok: false, error: error.message });
    }
    const model = await getModel();
    model.billing = model.billing || {};
    model.billing.webhookEvents = model.billing.webhookEvents || [];
    if (event.id && model.billing.webhookEvents.some(item => item.stripeEventId === event.id)) {
      return json(res, 200, { ok: true, duplicate: true });
    }
    model.billing.webhookEvents.unshift({
      id: uid("billing-webhook"),
      stripeEventId: event.id || "",
      type: event.type || "",
      receivedAt: new Date().toISOString()
    });
    model.billing.webhookEvents = model.billing.webhookEvents.slice(0, 100);
    let entitlement = null;
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data?.object || {};
      const paid = session.payment_status === "paid" || session.status === "complete" || session.mode === "subscription";
      if (paid) entitlement = recordStripeCheckoutCompletion(model, session);
    }
    await saveModel(model);
    return json(res, 200, { ok: true, received: true, type: event.type || "", entitlement: entitlement ? { email: entitlement.email, access: entitlement.access, selectedPlan: entitlement.selectedPlan } : null });
  }

  if (url.pathname === "/api/media/editor/readiness" && req.method === "GET") {
    return json(res, 200, { ok: true, ...mediaEditorReadiness() });
  }

  if (url.pathname === "/api/media/editor/plan" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    if (!(await hostedWriteRequiresSession(req, model))) {
      return json(res, 401, { ok: false, error: "Sign in before preparing media edit plans." });
    }
    const campaign = input.campaign || {};
    const sourceName = input.sourceName || "raw client video";
    const brief = input.brief || campaign.brief || "campaign-ready social cut";
    return json(res, 200, {
      ok: true,
      dryRun: true,
      ready: mediaEditorReadiness().ready,
      sourceName,
      plan: {
        intake: ["Confirm rights/consent", "Detect orientation and spoken hook", "Transcribe if audio is present", "Choose one campaign promise"],
        editPass: ["Cut dead air", "Add first-frame title", "Add burned-in captions", "Add platform-safe CTA", "Export per-platform sizes"],
        outputs: mediaEditorReadiness().outputs.map(output => ({
          ...output,
          captionPlan: `Adapt the campaign brief for ${output.name}: ${brief}`.slice(0, 240)
        })),
        reviewGate: "User approval is required before upload, scheduling, or publishing."
      },
      serverRequirement: "Live editing needs server-side media storage plus a queued render worker; this endpoint is the product contract until that worker is added."
    });
  }

  if (url.pathname === "/api/google/growth-suite" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    if (runtimeMode === "vercel" && !session) {
      return appAccessRequiredResponse(res);
    }
    const googleAccounts = session?.user
      ? (model.connectedAccounts || []).filter(item => item.platform === "youtube" && ownedByUser(item, session.user.id))
      : (model.connectedAccounts || []).filter(item => item.platform === "youtube");
    return json(res, 200, {
      ok: true,
      projectRecommendation: {
        name: "Social Cues",
        purpose: "Google API project for YouTube, Business Profile, Ads, Search Console, Analytics, and Drive-backed launch assets.",
        callback: youtubeRedirectUri()
      },
      googlePlus: {
        usable: false,
        answer: "Google+ is not a current public social media app. Consumer Google+ shut down in 2019, and the Workspace successor Currents was replaced by Google Chat/Spaces."
      },
      configured: Boolean(googleClientId && googleClientSecret),
      account: googleAccounts[0] ? publicAccount(googleAccounts[0]) : null,
      apis: googleGrowthStatus(),
      pageCreator: "/api/google/page-kit",
      priority: [
        "YouTube Data API v3 + YouTube Analytics API",
        "Google Business Profile APIs",
        "Google Ads API after developer-token approval",
        "Search Console API and Google Analytics Data API for website feedback",
        "Google Drive API for launch/profile kit storage"
      ]
    });
  }

  if (url.pathname === "/api/google/page-kit" && ["GET", "POST"].includes(req.method)) {
    const input = req.method === "POST" ? await bodyJson(req) : {};
    const model = await getModel();
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) {
      return appAccessRequiredResponse(res);
    }
    const campaign = input.campaign || model.campaigns?.find(item => item.id === model.activeCampaignId) || model.campaigns?.[0] || {};
    const offer = input.offer || model.onboarding?.offer || model.billing?.selectedPlan || "Social Cues";
    const audience = input.audience || model.onboarding?.audience || "creators, small businesses, agencies, and ecommerce operators";
    const promise = "Turn scattered social activity into an approval-first growth system with platform-native content, analytics, and next actions.";
    return json(res, 200, {
      ok: true,
      provider: "google-page-kit",
      use: ["Google Business Profile description", "YouTube channel About section", "homepage hero", "profile bio", "ad landing page"],
      kit: {
        profileName: "Social Cues",
        shortBio: "Social Cues turns one campaign idea into platform-native posts, approval workflows, and live growth feedback.",
        homepageHero: "Build the social command center behind your next campaign.",
        homepageSubhead: promise,
        googleBusinessDescription: `Social Cues helps ${audience} plan, approve, schedule, and learn from social campaigns. ${promise}`,
        youtubeAbout: `Social Cues is building the operating system for approval-first social growth. Follow the build as we connect YouTube, Meta, TikTok, X, and commerce signals into one practical command center.`,
        ctas: ["Start a proof sprint", "Connect your channels", "Build a launch kit"],
        proofAngles: [
          "One brief becomes platform-native content.",
          "Humans approve before anything goes live.",
          "Analytics turn into next actions instead of vanity numbers."
        ],
        campaignContext: campaign.brief || "",
        offer
      }
    });
  }

  if (url.pathname === "/api/google/business/readiness" && req.method === "GET") {
    const suite = googleGrowthStatus().find(item => item.id === "google_business_profile");
    return json(res, 200, {
      ok: true,
      ready: Boolean(suite?.ready),
      api: suite,
      allowedWorkflows: ["Business profile posts", "offer/event/update posts", "location media", "review monitoring/reply when granted"],
      note: "Google Business Profile is the Google replacement lane for local/profile posting. It is not Google+."
    });
  }

  if (url.pathname === "/api/google/ads/readiness" && req.method === "GET") {
    const suite = googleGrowthStatus().find(item => item.id === "google_ads");
    return json(res, 200, {
      ok: true,
      ready: Boolean(suite?.ready),
      api: suite,
      allowedWorkflows: ["Campaign reporting", "recommendations", "keyword planning", "conversion feedback", "campaign management after explicit user approval"],
      note: "Google Ads API requires OAuth plus a Google Ads developer token and customer account access."
    });
  }

  if (url.pathname === "/api/youtube/readiness" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    const account = session?.user
      ? (model.connectedAccounts || []).find(item => item.platform === "youtube" && isRealConnectedAccount(item) && ownedByUser(item, session.user.id))
      : null;
    return json(res, 200, {
      ok: true,
      ready: Boolean(googleClientId && googleClientSecret && account),
      configured: Boolean(googleClientId && googleClientSecret),
      account: account ? publicAccount(account) : null,
      redirectUri: youtubeRedirectUri(),
      scopes: youtubeScopes,
      knownChannelId: youtubeKnownChannelId,
      allowedUse: ["read channel profile", "read analytics", "read reporting data", "prepare private-first uploads", "show posting reminders before YouTube publishing"],
      products: ["YouTube Data API v3", "YouTube Analytics API", "YouTube Reporting API"],
      connectRoute: "/api/oauth/youtube/start",
      uploadReminder: "Social Cues prepares YouTube uploads private-first. Public automated publishing may require Google API Services audit approval.",
      missingEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].filter(name => !envPresent(name)),
      optionalMissingEnv: ["YOUTUBE_CHANNEL_ID"].filter(name => !envPresent(name))
    });
  }

  if (url.pathname === "/api/shopify/readiness" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      ready: Boolean(shopifyClientId && shopifyClientSecret),
      configured: Boolean(shopifyClientId && shopifyClientSecret),
      redirectUri: shopifyRedirectUri(),
      scopes: shopifyScopes,
      allowedUse: ["read product context", "sync campaign offer links", "prepare marketing events", "connect social campaigns to storefront outcomes"],
      portalStatus: shopifyClientId && shopifyClientSecret ? "partner app credentials present" : "Shopify partner app setup pending",
      shopDomainConfigured: Boolean(shopifyShopDomain),
      connectRoute: "/api/oauth/shopify/start",
      missingEnv: ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"].filter(name => !envPresent(name)),
      optionalMissingEnv: shopifyShopDomain ? [] : ["SHOPIFY_SHOP_DOMAIN"]
    });
  }

  if (url.pathname === "/api/pinterest/readiness" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    const account = session?.user
      ? (model.connectedAccounts || []).find(item => item.platform === "pinterest" && isRealConnectedAccount(item) && ownedByUser(item, session.user.id))
      : null;
    return json(res, 200, {
      ok: true,
      ready: Boolean(pinterestAppId && pinterestAppSecret && account),
      configured: Boolean(pinterestAppId && pinterestAppSecret),
      account: account ? publicAccount(account) : null,
      redirectUri: pinterestRedirectUri(),
      scopes: pinterestScopes,
      allowedUse: ["basic analytics", "read/write boards", "read/write standard Pins", "ads read"],
      portalStatus: pinterestAppId ? "app credentials present" : "Pinterest developer app request pending",
      connectRoute: "/api/oauth/pinterest/start",
      missingEnv: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"].filter(name => !envPresent(name))
    });
  }

  if (url.pathname === "/api/pinterest/boards" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    if (runtimeMode === "vercel" && !session) return appAccessRequiredResponse(res);
    const account = (model.connectedAccounts || []).find(item => item.platform === "pinterest" && isRealConnectedAccount(item) && (!session?.user || ownedByUser(item, session.user.id)));
    if (!account || !hasStoredToken(account)) {
      return json(res, 409, { ok: false, error: "Connect Pinterest OAuth before reading boards.", connectRoute: "/api/oauth/pinterest/start" });
    }
    const boards = await pinterestApi("/boards", { page_size: "25" }, decryptedToken(account.credential));
    return json(res, 200, { ok: true, account: publicAccount(account), boards: boards.items || [] });
  }

  if (url.pathname === "/api/etsy/readiness" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    const account = session?.user
      ? (model.connectedAccounts || []).find(item => item.platform === "etsy" && isRealConnectedAccount(item) && ownedByUser(item, session.user.id))
      : null;
    return json(res, 200, {
      ok: true,
      ready: Boolean(etsyClientId && etsyClientSecret && account),
      configured: Boolean(etsyClientId && etsyClientSecret),
      account: account ? publicAccount(account) : null,
      redirectUri: etsyRedirectUri(),
      scopes: etsyScopes,
      allowedUse: ["read shop profile", "read listing context", "create/edit listings after explicit user approval", "read user profile email when granted"],
      portalStatus: etsyClientId && etsyClientSecret ? "developer key present" : "Etsy developer app setup pending",
      connectRoute: "/api/oauth/etsy/start",
      missingEnv: ["ETSY_CLIENT_ID", "ETSY_CLIENT_SECRET"].filter(name => !envPresent(name))
    });
  }

  if (url.pathname === "/api/etsy/shops" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    if (runtimeMode === "vercel" && !session) return appAccessRequiredResponse(res);
    const account = (model.connectedAccounts || []).find(item => item.platform === "etsy" && isRealConnectedAccount(item) && (!session?.user || ownedByUser(item, session.user.id)));
    if (!account || !hasStoredToken(account)) {
      return json(res, 409, { ok: false, error: "Connect Etsy OAuth before reading shops.", connectRoute: "/api/oauth/etsy/start" });
    }
    const accessToken = decryptedToken(account.credential);
    const userId = account.providerAccountId || etsyUserIdFromAccessToken(accessToken);
    if (!userId) return json(res, 409, { ok: false, error: "Etsy user id missing from OAuth token. Reconnect Etsy." });
    const shops = await etsyApi(`/application/users/${userId}/shops`, {}, accessToken);
    return json(res, 200, { ok: true, account: publicAccount(account), shops: shops.results || shops });
  }

  if (url.pathname === "/api/etsy/listings" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    if (runtimeMode === "vercel" && !session) return appAccessRequiredResponse(res);
    const account = (model.connectedAccounts || []).find(item => item.platform === "etsy" && isRealConnectedAccount(item) && (!session?.user || ownedByUser(item, session.user.id)));
    if (!account || !hasStoredToken(account)) {
      return json(res, 409, { ok: false, error: "Connect Etsy OAuth before reading listings.", connectRoute: "/api/oauth/etsy/start" });
    }
    const accessToken = decryptedToken(account.credential);
    const userId = account.providerAccountId || etsyUserIdFromAccessToken(accessToken);
    if (!userId) return json(res, 409, { ok: false, error: "Etsy user id missing from OAuth token. Reconnect Etsy." });
    const shops = await etsyApi(`/application/users/${userId}/shops`, {}, accessToken);
    const shop = (shops.results || shops || [])[0];
    if (!shop?.shop_id) return json(res, 200, { ok: true, account: publicAccount(account), shop: null, listings: [] });
    const listings = await etsyApi(`/application/shops/${shop.shop_id}/listings`, { limit: "25" }, accessToken);
    return json(res, 200, { ok: true, account: publicAccount(account), shop, listings: listings.results || listings });
  }

  if (url.pathname === "/api/twitch/readiness" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    const account = session?.user
      ? (model.connectedAccounts || []).find(item => item.platform === "twitch" && isRealConnectedAccount(item) && ownedByUser(item, session.user.id))
      : null;
    return json(res, 200, {
      ok: true,
      ready: Boolean(twitchClientId && twitchClientSecret && account),
      configured: Boolean(twitchClientId && twitchClientSecret),
      account: account ? publicAccount(account) : null,
      redirectUri: twitchRedirectUri(),
      scopes: twitchScopes,
      allowedUse: ["read channel identity", "read subscription signal when broadcaster grants access", "read game analytics where allowed", "create clips after explicit user approval"],
      portalStatus: twitchClientId && twitchClientSecret ? "developer credentials present" : "Twitch developer app setup pending",
      connectRoute: "/api/oauth/twitch/start",
      missingEnv: ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"].filter(name => !envPresent(name))
    });
  }

  if (url.pathname === "/api/twitch/channel" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    if (runtimeMode === "vercel" && !session) return appAccessRequiredResponse(res);
    const account = (model.connectedAccounts || []).find(item => item.platform === "twitch" && isRealConnectedAccount(item) && (!session?.user || ownedByUser(item, session.user.id)));
    if (!account || !hasStoredToken(account)) {
      return json(res, 409, { ok: false, error: "Connect Twitch OAuth before reading channel data.", connectRoute: "/api/oauth/twitch/start" });
    }
    const accessToken = decryptedToken(account.credential);
    const user = await twitchApi("/users", {}, accessToken);
    const broadcaster = user.data?.[0] || account.profile || null;
    const channel = broadcaster?.id ? await twitchApi("/channels", { broadcaster_id: broadcaster.id }, accessToken).catch(error => ({ error: error.message, data: [] })) : null;
    const clips = broadcaster?.id ? await twitchApi("/clips", { broadcaster_id: broadcaster.id, first: "10" }, accessToken).catch(error => ({ error: error.message, data: [] })) : null;
    return json(res, 200, { ok: true, account: publicAccount(account), broadcaster, channel: channel?.data?.[0] || null, clips: clips?.data || [], warnings: [channel?.error, clips?.error].filter(Boolean) });
  }

  if (url.pathname === "/api/canva/readiness" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    const account = session?.user
      ? (model.connectedAccounts || []).find(item => item.platform === "canva" && isRealConnectedAccount(item) && ownedByUser(item, session.user.id))
      : null;
    return json(res, 200, {
      ok: true,
      ready: Boolean(canvaClientId && canvaClientSecret && account),
      configured: Boolean(canvaClientId && canvaClientSecret),
      appShellCreated: Boolean(canvaAppId),
      appId: canvaAppId || null,
      account: account ? publicAccount(account) : null,
      redirectUri: canvaRedirectUri(),
      scopes: canvaScopes,
      allowedUse: ["brand templates", "asset import/export", "design metadata", "design imports", "exports", "comments", "folder organization"],
      portalStatus: canvaClientId ? "integration credentials present" : canvaAppId ? "Canva app shell created; Connect OAuth credentials pending" : "Canva developer integration pending",
      credentialLane: "Use Canva Developer Portal > Your integrations for Connect API OAuth credentials. The existing Canva Apps SDK app shell does not unlock Connect OAuth.",
      nextActions: canvaClientId && canvaClientSecret ? [
        "Connect Canva OAuth from the app.",
        "Verify /api/canva/designs with a connected user account."
      ] : [
        "Create a Canva Connect integration under Your integrations.",
        `Add ${canvaRedirectUri()} as an authorized redirect URL.`,
        "Generate and save the Connect client secret.",
        "Add CANVA_CLIENT_ID and CANVA_CLIENT_SECRET to local .env and Vercel."
      ],
      connectRoute: "/api/oauth/canva/start",
      missingEnv: ["CANVA_CLIENT_ID", "CANVA_CLIENT_SECRET"].filter(name => !envPresent(name))
    });
  }

  if (url.pathname === "/api/canva/designs" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    if (runtimeMode === "vercel" && !session) return appAccessRequiredResponse(res);
    const account = (model.connectedAccounts || []).find(item => item.platform === "canva" && isRealConnectedAccount(item) && (!session?.user || ownedByUser(item, session.user.id)));
    if (!account || !hasStoredToken(account)) {
      return json(res, 409, { ok: false, error: "Connect Canva OAuth before reading design metadata.", connectRoute: "/api/oauth/canva/start" });
    }
    const designs = await canvaApi("/designs", { limit: "20" }, decryptedToken(account.credential));
    return json(res, 200, { ok: true, account: publicAccount(account), designs: designs.items || designs.designs || [] });
  }

  if (url.pathname === "/api/billing/checkout" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    const session = await sessionFromRequest(model, req);
    model.billing = model.billing || {};
    model.billing.selectedPlan = input.selectedPlan || model.billing.selectedPlan || "Founder Audit - $99";
    model.billing.paymentLink = input.paymentLink || model.billing.paymentLink || "";
    let checkoutSession = null;
    if (!model.billing.paymentLink) {
      checkoutSession = await createStripeCheckoutSession({
        selectedPlan: model.billing.selectedPlan,
        successUrl: `${brandHomeUrl}/portal?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${brandHomeUrl}/portal?checkout=cancelled`,
        customerEmail: input.email || session?.user?.email || "",
        userId: session?.user?.id || ""
      }).catch(error => ({ error: error.message }));
    }
    model.billing.status = checkoutSession?.url ? "Stripe Checkout ready" : model.billing.paymentLink ? "Payment Link ready" : "Not configured";
    await saveModel(model);
    return json(res, 200, {
      ok: true,
      mode: checkoutSession?.url ? "stripe-checkout" : model.billing.paymentLink ? "payment-link" : "stripe-not-configured",
      url: checkoutSession?.url || model.billing.paymentLink || null,
      checkoutSessionId: checkoutSession?.id || null,
      message: checkoutSession?.url
        ? "Open this Stripe Checkout Session."
        : model.billing.paymentLink ? "Open this Stripe Payment Link." : "Set STRIPE_SECRET_KEY and Stripe price IDs on the backend to create live Checkout Sessions.",
      error: checkoutSession?.error || null
    });
  }

  if (url.pathname === "/api/meta/assets" && req.method === "GET") {
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    if (runtimeMode === "vercel" && !session) {
      return appAccessRequiredResponse(res);
    }
    if (session?.user) ensureUserWorkspace(model, session.user);
    const accounts = realMetaAccounts(model)
      .filter(account => !session?.user || ownedByUser(account, session.user.id))
      .map(publicMetaAccount);
    const hideMetaSummary = runtimeMode === "vercel" && session?.user && !accounts.length;
    return json(res, 200, {
      ok: true,
      metaConnection: hideMetaSummary ? null : model.metaConnection || null,
      metaHealth: hideMetaSummary ? null : publicMetaHealth(model.metaHealth),
      capabilities: metaCapabilityMatrix(model),
      accounts
    });
  }

  if (url.pathname === "/api/meta/health" && ["GET", "POST"].includes(req.method)) {
    const model = await getModel();
    const session = req.method === "POST" ? await hostedWriteRequiresSession(req, model) : await entitledSessionFromRequest(model, req);
    if (runtimeMode === "vercel" && !session) {
      return appAccessRequiredResponse(res);
    }
    if (session?.user) ensureUserWorkspace(model, session.user);
    const inspection = await inspectMetaConnection(model, session?.user ? accountOwnerPatch(session.user) : {});
    model.metaHealth = inspection;
    model.analytics = buildGrowthAnalytics(model);
    await saveModel(model);
    const accounts = realMetaAccounts(model).filter(account => !session?.user || ownedByUser(account, session.user.id));
    const hideMetaSummary = runtimeMode === "vercel" && session?.user && !accounts.length;
    return json(res, 200, {
      ok: true,
      metaConnection: hideMetaSummary ? null : model.metaConnection || null,
      health: hideMetaSummary ? null : publicMetaHealth(inspection),
      accounts: accounts.map(publicMetaAccount),
      capabilities: inspection.capabilityMatrix || metaCapabilityMatrix(model),
      analytics: session?.user ? buildGrowthAnalytics(publicModel(model, session)) : model.analytics
    });
  }

  if (url.pathname === "/api/meta/sync" && req.method === "POST") {
    const model = await getModel();
    if (!(await hostedWriteRequiresSession(req, model))) {
      return json(res, 401, { ok: false, error: "Sign in before syncing connected Meta assets." });
    }
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
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
    const gate = metaGate(model, "facebook_pages_connect", { platform: "facebook" });
    const pages = realMetaAccounts(model, "facebook").map(publicMetaAccount);
    return json(res, 200, { ok: true, ready: gate.ready, gate, pages });
  }

  if (url.pathname === "/api/meta/instagram/accounts" && req.method === "GET") {
    const model = await getModel();
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
    const accounts = realMetaAccounts(model, "instagram").map(publicMetaAccount);
    const gate = metaGate(model, "instagram_connect", { platform: "instagram" });
    return json(res, 200, { ok: true, ready: gate.ready, gate, accounts });
  }

  if (url.pathname === "/api/meta/insights/facebook" && req.method === "GET") {
    const model = await getModel();
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
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
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
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
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
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
    if (!(await hostedWriteRequiresSession(req, model))) {
      return json(res, 401, { ok: false, error: "Sign in before publishing or previewing Facebook Page posts." });
    }
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
    if (!(await hostedWriteRequiresSession(req, model))) {
      return json(res, 401, { ok: false, error: "Sign in before publishing or previewing Instagram content." });
    }
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
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
    const gate = metaGate(model, "ads_read");
    if (!gate.ready) return respondGate(res, gate);
    return json(res, 200, { ok: true, report: [], note: "ads_read approved; add ad account selection to pull insights." });
  }

  if (url.pathname === "/api/meta/ads/campaigns" && req.method === "POST") {
    const model = await getModel();
    if (!(await hostedWriteRequiresSession(req, model))) {
      return json(res, 401, { ok: false, error: "Sign in before preparing Meta ad campaigns." });
    }
    const gate = metaGate(model, "ads_management");
    if (!gate.ready) return respondGate(res, gate);
    return json(res, 200, { ok: true, dryRun: true, note: "ads_management approved; campaign creation is gated behind explicit live-submit controls." });
  }

  if (url.pathname === "/api/meta/business/assets" && req.method === "GET") {
    const model = await getModel();
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
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
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
    const gate = metaGate(model, "lead_ads", { platform: "facebook" });
    if (!gate.ready) return respondGate(res, gate);
    return json(res, 200, { ok: true, leads: [], note: "leads_retrieval approved; add form selection to pull lead records." });
  }

  if (url.pathname === "/api/meta/comments/readiness" && req.method === "GET") {
    const model = await getModel();
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
    const pages = realMetaAccounts(model, "facebook").map(publicMetaAccount);
    const scopes = Array.from(grantedMetaScopes(model));
    return json(res, 200, {
      ok: true,
      ready: pages.length > 0 && scopes.includes("pages_read_engagement"),
      pages,
      currentScopes: scopes,
      requiredForMonitoring: ["pages_read_engagement", "Page asset"],
      requiredForReplyModeration: ["pages_manage_engagement", "pages_manage_metadata"],
      workflows: ["Comment monitoring", "post engagement triage", "review queue for replies", "moderation handoff"],
      note: "Social Cues should monitor and draft replies before it performs live comment actions. Live moderation/replies require additional Meta permissions and explicit user approval."
    });
  }

  if (url.pathname === "/api/meta/ads/readiness" && req.method === "GET") {
    const model = await getModel();
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
    return json(res, 200, {
      ok: true,
      reporting: metaGate(model, "ads_read"),
      management: metaGate(model, "ads_management"),
      workflows: ["Ads reporting", "campaign draft planning", "budget guardrails", "lead campaign intake", "explicit approval before live spend"],
      note: "Ads management belongs in Social Cues, but live campaign mutation must stay gated behind Meta review, ad account selection, billing awareness, and explicit user approval."
    });
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
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
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

  if (url.pathname === "/api/tiktok/account" && req.method === "GET") {
    const sharedModel = await getModel();
    const session = await entitledSessionFromRequest(sharedModel, req);
    if (runtimeMode === "vercel" && !session) return appAccessRequiredResponse(res);
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    const account = (model.connectedAccounts || []).find(item => item.platform === "tiktok" && (!session?.user || ownedByUser(item, session.user.id)));
    return json(res, 200, {
      ok: true,
      configured: Boolean(tiktokClientKey),
      clientKeyFingerprint: publicKeyFingerprint(tiktokClientKey),
      redirectUri: tiktokRedirectUri(),
      scopes: tiktokScopes,
      futureScopes: tiktokFutureScopes,
      appReviewStatus: "First-login OAuth is configured for Login Kit. Display, stats, and posting scopes remain review-gated until TikTok grants them.",
      products: [
        "Login Kit",
        "Display API",
        "Content Posting API",
        "Embed Videos",
        "Commercial Content API",
        "Research API",
        "Data Portability API"
      ],
      account: account ? publicAccount(account) : null,
      ready: Boolean(account && isRealConnectedAccount(account)),
      connectRoute: "/api/oauth/tiktok/start"
    });
  }

  if (url.pathname === "/api/tiktok/creator-info" && req.method === "GET") {
    const sharedModel = await getModel();
    const session = await entitledSessionFromRequest(sharedModel, req);
    if (runtimeMode === "vercel" && !session) return appAccessRequiredResponse(res);
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    const account = (model.connectedAccounts || []).find(item => item.platform === "tiktok" && (!session?.user || ownedByUser(item, session.user.id)));
    if (!account || !isRealConnectedAccount(account) || !tokenForTikTokAccount(account)) {
      return json(res, 409, {
        ok: false,
        error: "Connect TikTok OAuth before Social Cues can read TikTok creator posting settings.",
        connectRoute: "/api/oauth/tiktok/start",
        requiredScopes: ["user.info.basic", "video.upload", "video.publish"]
      });
    }
    try {
      const creator = await tiktokApi("/v2/post/publish/creator_info/query/", {}, tokenForTikTokAccount(account), { method: "POST" });
      return json(res, 200, { ok: true, provider: "tiktok", account: publicAccount(account), creator: creator.data || creator });
    } catch (error) {
      return json(res, 502, { ok: false, provider: "tiktok", account: publicAccount(account), error: error.message });
    }
  }

  if (url.pathname === "/api/tiktok/publish" && req.method === "POST") {
    const input = await bodyJson(req);
    const sharedModel = await getModel();
    const session = await hostedWriteRequiresSession(req, sharedModel);
    if (!session) {
      return json(res, 401, { ok: false, error: "Sign in before publishing or previewing TikTok submissions." });
    }
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    const account = (model.connectedAccounts || []).find(item => item.platform === "tiktok" && (!session?.user || ownedByUser(item, session.user.id)));
    const caption = String(input.caption || input.message || input.text || "").trim();
    const videoUrl = String(input.videoUrl || input.video_url || "").trim();
    const photoUrls = Array.isArray(input.photoUrls) ? input.photoUrls.filter(Boolean) : [];
    const mode = input.mode === "direct" ? "direct" : "draft";
    if (!caption) return json(res, 400, { ok: false, error: "caption or message is required." });
    if (!videoUrl && !photoUrls.length) {
      return json(res, 409, {
        ok: false,
        error: "TikTok publishing requires a hosted video URL or hosted photo URL from a verified domain/prefix.",
        requiredAsset: "Public HTTPS media URL on a TikTok-verified domain or URL prefix."
      });
    }
    if (!account || !isRealConnectedAccount(account) || !tokenForTikTokAccount(account)) {
      return json(res, 409, {
        ok: false,
        error: "Connect TikTok OAuth before Social Cues can publish or upload drafts to TikTok.",
        connectRoute: "/api/oauth/tiktok/start",
        requiredScopes: mode === "direct" ? ["video.publish"] : ["video.upload"]
      });
    }
    if (input.live !== true) {
      return json(res, 200, {
        ok: true,
        dryRun: true,
        provider: "tiktok",
        mode,
        account: publicAccount(account),
        wouldSubmit: {
          caption,
          videoUrl: videoUrl || null,
          photoUrls,
          privacyLevel: input.privacyLevel || "SELF_ONLY",
          commentDisabled: Boolean(input.disableComment)
        },
        liveSubmitRequires: "Send { live: true } only after explicit user approval and TikTok scope review."
      });
    }
    const token = tokenForTikTokAccount(account);
    const postInfo = {
      title: caption.slice(0, 2200),
      privacy_level: input.privacyLevel || "SELF_ONLY",
      disable_comment: Boolean(input.disableComment),
      disable_duet: Boolean(input.disableDuet),
      disable_stitch: Boolean(input.disableStitch)
    };
    const endpoint = photoUrls.length ? "/v2/post/publish/content/init/" : (mode === "direct" ? "/v2/post/publish/video/init/" : "/v2/post/publish/inbox/video/init/");
    const sourceInfo = photoUrls.length
      ? { source: "PULL_FROM_URL", photo_cover_index: Number(input.photoCoverIndex || 0), photo_images: photoUrls }
      : { source: "PULL_FROM_URL", video_url: videoUrl };
    const payload = photoUrls.length
      ? { post_info: { ...postInfo, description: caption, auto_add_music: input.autoAddMusic !== false }, source_info: sourceInfo, post_mode: mode === "direct" ? "DIRECT_POST" : "MEDIA_UPLOAD", media_type: "PHOTO" }
      : { post_info: postInfo, source_info: sourceInfo };
    const response = await tiktokApi(endpoint, payload, token, { method: "POST" });
    return json(res, 200, { ok: true, dryRun: false, provider: "tiktok", mode, endpoint, response });
  }

  if (url.pathname === "/api/tiktok/publish/status" && req.method === "POST") {
    const input = await bodyJson(req);
    const sharedModel = await getModel();
    const session = await hostedWriteRequiresSession(req, sharedModel);
    if (!session) {
      return json(res, 401, { ok: false, error: "Sign in before checking TikTok publish status." });
    }
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    const account = (model.connectedAccounts || []).find(item => item.platform === "tiktok" && (!session?.user || ownedByUser(item, session.user.id)));
    if (!account || !isRealConnectedAccount(account) || !tokenForTikTokAccount(account)) return json(res, 409, { ok: false, error: "Connect TikTok OAuth before checking publish status." });
    if (!input.publishId && !input.publish_id) return json(res, 400, { ok: false, error: "publishId is required." });
    const response = await tiktokApi("/v2/post/publish/status/fetch/", { publish_id: input.publishId || input.publish_id }, tokenForTikTokAccount(account), { method: "POST" });
    return json(res, 200, { ok: true, provider: "tiktok", response });
  }

  if (url.pathname === "/api/youtube/account" && req.method === "GET") {
    const model = await getModel();
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
    const account = (model.connectedAccounts || []).find(item => item.platform === "youtube");
    let refreshed = false;
    let refreshError = null;
    if (account && tokenExpiresSoon(account.tokenExpiresAt)) {
      try {
        await refreshYouTubeAccount(model, account);
        refreshed = true;
      } catch (error) {
        account.status = "not connected";
        account.connectedAt = null;
        account.connectionEvidence = `YouTube token refresh failed: ${error.message}`;
        refreshError = error.message;
        await saveModel(model);
      }
    }
    return json(res, 200, {
      ok: true,
      configured: Boolean(googleClientId && googleClientSecret),
      redirectUri: youtubeRedirectUri(),
      scopes: youtubeScopes,
      knownChannelId: youtubeKnownChannelId,
      studioEvidence: { handle: "worldofdadcraft", channelId: youtubeKnownChannelId, source: "Open YouTube Studio tab" },
      uploadReminder: "Social Cues prepares YouTube uploads private-first. Public automated publishing may require Google API Services compliance/audit approval.",
      account: account ? publicAccount(account) : null,
      ready: Boolean(account && isRealConnectedAccount(account)),
      refreshed,
      refreshError,
      connectRoute: "/api/oauth/youtube/start"
    });
  }

  if (url.pathname === "/api/youtube/channel" && req.method === "GET") {
    const model = await getModel();
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
    let account = null;
    try {
      account = await usableYouTubeAccount(model, { refresh: true });
    } catch (error) {
      return json(res, 409, { ok: false, error: `Reconnect YouTube OAuth before Social Cues can read private channel data. ${error.message}`, connectRoute: "/api/oauth/youtube/start" });
    }
    if (!account || !isRealConnectedAccount(account) || !tokenForYouTubeAccount(account)) {
      return json(res, 409, {
        ok: false,
        error: "Connect YouTube OAuth before Social Cues can read channel data.",
        connectRoute: "/api/oauth/youtube/start",
        requiredScopes: ["youtube.readonly"]
      });
    }
    const channel = await youtubeData("/channels", {
      part: "id,snippet,statistics,contentDetails,status",
      mine: "true",
      fields: "items(id,snippet(title,customUrl,description,thumbnails),statistics,contentDetails,status/privacyStatus)"
    }, tokenForYouTubeAccount(account));
    return json(res, 200, { ok: true, provider: "youtube", account: publicAccount(account), channel: channel.items?.[0] || null });
  }

  if (url.pathname === "/api/youtube/analytics" && req.method === "GET") {
    const model = await getModel();
    if (runtimeMode === "vercel" && !(await entitledSessionFromRequest(model, req))) return appAccessRequiredResponse(res);
    let account = null;
    try {
      account = await usableYouTubeAccount(model, { refresh: true });
    } catch (error) {
      return json(res, 409, { ok: false, error: `Reconnect YouTube OAuth before Social Cues can read analytics. ${error.message}`, connectRoute: "/api/oauth/youtube/start" });
    }
    if (!account || !isRealConnectedAccount(account) || !tokenForYouTubeAccount(account)) {
      return json(res, 409, {
        ok: false,
        error: "Connect YouTube OAuth before Social Cues can read analytics.",
        connectRoute: "/api/oauth/youtube/start",
        requiredScopes: ["yt-analytics.readonly"]
      });
    }
    const endDate = url.searchParams.get("endDate") || new Date().toISOString().slice(0, 10);
    const startDate = url.searchParams.get("startDate") || new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const report = await youtubeAnalytics("/reports", {
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: url.searchParams.get("metrics") || "views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained",
      dimensions: url.searchParams.get("dimensions") || "day",
      sort: url.searchParams.get("sort") || "day"
    }, tokenForYouTubeAccount(account));
    return json(res, 200, { ok: true, provider: "youtube", account: publicAccount(account), report });
  }

  if (url.pathname === "/api/youtube/upload" && req.method === "POST") {
    const input = await bodyJson(req);
    const model = await getModel();
    if (!(await hostedWriteRequiresSession(req, model))) {
      return json(res, 401, { ok: false, error: "Sign in before publishing or previewing YouTube uploads." });
    }
    const title = String(input.title || input.message || "").trim();
    const description = String(input.description || input.copy || "").trim();
    const videoUrl = String(input.videoUrl || input.video_url || "").trim();
    if (!title) return json(res, 400, { ok: false, error: "title is required." });
    if (!videoUrl) return json(res, 409, { ok: false, error: "YouTube upload requires a hosted videoUrl." });
    let account = null;
    try {
      account = await usableYouTubeAccount(model, { refresh: true });
    } catch (error) {
      return json(res, 409, { ok: false, error: `Reconnect YouTube OAuth before Social Cues can upload. ${error.message}`, connectRoute: "/api/oauth/youtube/start" });
    }
    if (!account || !isRealConnectedAccount(account) || !tokenForYouTubeAccount(account)) {
      return json(res, 409, {
        ok: false,
        error: "Connect YouTube OAuth before Social Cues can upload.",
        connectRoute: "/api/oauth/youtube/start",
        requiredScopes: ["youtube.upload"]
      });
    }
    const metadata = {
      snippet: {
        title: title.slice(0, 100),
        description,
        tags: Array.isArray(input.tags) ? input.tags : [],
        categoryId: input.categoryId || "22"
      },
      status: {
        privacyStatus: input.privacyStatus || "private",
        selfDeclaredMadeForKids: Boolean(input.madeForKids)
      }
    };
    if (input.live !== true) {
      return json(res, 200, {
        ok: true,
        dryRun: true,
        provider: "youtube",
        account: publicAccount(account),
        wouldUpload: { videoUrl, metadata },
        auditNote: "Google restricts uploads from unverified API projects created after July 28, 2020 to private visibility until API compliance audit approval.",
        liveSubmitRequires: "Send { live: true } only after explicit user approval."
      });
    }
    const media = await fetch(videoUrl);
    if (!media.ok) return json(res, 502, { ok: false, error: `Could not fetch hosted video: ${media.status}` });
    const videoBytes = Buffer.from(await media.arrayBuffer());
    const boundary = `social-cues-${crypto.randomBytes(8).toString("hex")}`;
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${media.headers.get("content-type") || "video/mp4"}\r\n\r\n`),
      videoBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const response = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenForYouTubeAccount(account)}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(multipart.length)
      },
      body: multipart
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) return json(res, response.status || 502, { ok: false, provider: "youtube", error: body.error?.message || body.error || `YouTube upload ${response.status}`, details: body });
    return json(res, 200, { ok: true, dryRun: false, provider: "youtube", response: body });
  }

  if (url.pathname === "/api/x/account" && req.method === "GET") {
    const sharedModel = await getModel();
    const session = await entitledSessionFromRequest(sharedModel, req);
    if (runtimeMode === "vercel" && !session) return appAccessRequiredResponse(res);
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    const account = (model.connectedAccounts || []).find(item => item.platform === "x" && (!session?.user || ownedByUser(item, session.user.id)));
    let repaired = false;
    if (repairConnectedOAuthAccount(account, "x")) {
      repaired = true;
      await saveModelForUser(model, session?.user || null);
    }
    let refreshed = false;
    let refreshError = null;
    if (account && tokenExpiresSoon(account.tokenExpiresAt)) {
      try {
        await refreshXAccount(model, account, session?.user || null);
        refreshed = true;
      } catch (error) {
        account.status = "not connected";
        account.connectedAt = null;
        account.connectionEvidence = `X token refresh failed: ${error.message}`;
        refreshError = error.message;
        await saveModelForUser(model, session?.user || null);
      }
    }
    return json(res, 200, {
      ok: true,
      configured: Boolean(xClientId),
      redirectUri: xRedirectUri(),
      scopes: xScopes,
      account: account ? publicAccount(account) : null,
      ready: Boolean(account && isRealConnectedAccount(account)),
      repaired,
      refreshed,
      refreshError
    });
  }

  if (url.pathname === "/api/x/engagement/readiness" && req.method === "GET") {
    const sharedModel = await getModel();
    const session = await entitledSessionFromRequest(sharedModel, req);
    if (runtimeMode === "vercel" && !session) return appAccessRequiredResponse(res);
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    const account = (model.connectedAccounts || []).find(item => item.platform === "x" && (!session?.user || ownedByUser(item, session.user.id)));
    return json(res, 200, {
      ok: true,
      configured: Boolean(xClientId),
      ready: Boolean(account && isRealConnectedAccount(account)),
      account: account ? publicAccount(account) : null,
      requiredScopes: ["tweet.read", "users.read", "offline.access"],
      futureScopes: ["like.read", "follows.read", "bookmark.read where available/approved"],
      workflows: ["Mention/reply monitoring", "engagement triage", "draft reply queue", "post performance readout", "approved posting"],
      note: "X engagement monitoring depends on the X API plan and granted scopes. Social Cues can prepare the lane now, but live monitoring depends on X API access level and OAuth scopes."
    });
  }

  if (url.pathname === "/api/x/post" && req.method === "POST") {
    const input = await bodyJson(req);
    const sharedModel = await getModel();
    const session = await hostedWriteRequiresSession(req, sharedModel);
    if (!session) {
      return json(res, 401, { ok: false, error: "Sign in before publishing or previewing X posts." });
    }
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    let account = null;
    try {
      account = await usableXAccount(model, { refresh: true, user: session?.user || null });
    } catch (error) {
      return json(res, 409, {
        ok: false,
        error: `Reconnect X OAuth before Social Cues can publish to X. ${error.message}`,
        connectRoute: "/api/oauth/x/start",
        requiredScopes: ["tweet.write", "users.read", "offline.access"]
      });
    }
    const textValue = String(input.text || input.message || "").trim().replace(/\s+/g, " ");
    if (!account || !isRealConnectedAccount(account)) {
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
    const response = await xApi("/tweets", { text: textValue }, tokenForXAccount(account), { method: "POST" });
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
    if (!(await hostedWriteRequiresSession(req, model))) {
      return json(res, 401, { ok: false, error: "Sign in before recording commerce signals." });
    }
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
      redirectUri: metaRedirectUri(req),
      privacyPolicyUrl: `${requestPublicBaseUrl(req, metaPublicAppUrl)}/privacy`,
      termsOfServiceUrl: `${requestPublicBaseUrl(req, metaPublicAppUrl)}/terms`,
      dataDeletionUri: metaDataDeletionUri(req),
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
    const sharedModel = await getModel();
    const session = await entitledSessionFromRequest(sharedModel, req);
    if ((runtimeMode === "vercel" || bearerToken(req)) && !session) {
      return appAccessRequiredResponse(res);
    }
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    const accounts = session?.user
      ? visibleConnectedAccounts(model).filter(account => ownedByUser(account, session.user.id))
      : visibleConnectedAccounts(model).filter(account => !hasOwnerMarker(account));
    return json(res, 200, { ok: true, accounts: accounts.map(publicAccount) });
  }

  if (url.pathname.startsWith("/api/accounts/") && req.method === "POST") {
    const platform = decodeURIComponent(url.pathname.split("/").pop());
    const input = await bodyJson(req);
    const sharedModel = await getModel();
    const session = await hostedWriteRequiresSession(req, sharedModel);
    if (!session) {
      return json(res, 401, { ok: false, error: "Sign in before changing connected accounts." });
    }
    const model = session?.user ? await modelForSession(session, sharedModel) : sharedModel;
    if (session?.user) {
      ensureUserWorkspace(model, session.user);
      await ensureWorkspaceBootstrap(model, session.user);
    }
    model.connectedAccounts = model.connectedAccounts || [];
    let account = model.connectedAccounts.find(item => item.platform === platform && (!session?.user || ownedByUser(item, session.user.id) || !hasOwnerMarker(item)));
    if (session?.user && account && !ownedByUser(account, session.user.id)) {
      account = {
        ...JSON.parse(JSON.stringify(account)),
        id: `${account.id || uid("acct")}-${session.user.id}`,
        ownerUserId: session.user.id,
        workspaceId: workspaceIdForUser(session.user)
      };
      model.connectedAccounts.push(account);
    }
    if (!account) {
      account = { id: uid("acct"), platform, name: platform, handle: "", status: "not connected", connectedAt: null };
      if (session?.user) stampWorkspaceOwnership(account, session.user);
      model.connectedAccounts.push(account);
    }
    if (input.disabled === false) {
      account.disabled = false;
      account.status = input.status || account.status || "not connected";
      account.connectionEvidence = "provider lane re-enabled; connect with OAuth when ready";
      await saveModelForUser(model, session?.user || null);
      return json(res, 200, { ok: true, account: publicAccount(account) });
    }
    if (input.status === "not connected" || input.disconnect === true) {
      account.status = "not connected";
      account.connectedAt = null;
      account.connected = false;
      account.disabled = Boolean(input.disabled);
      account.connectionEvidence = input.disabled
        ? "disabled by user; cached provider data and token evidence cleared"
        : "disconnected by user";
      for (const key of ["credential", "refreshCredential", "token", "accessToken", "refreshToken", "oauthCode", "providerAccountId", "tokenType", "tokenExpiresAt", "refreshTokenExpiresAt", "profile", "scopes"]) {
        delete account[key];
      }
      await saveModelForUser(model, session?.user || null);
      return json(res, 200, { ok: true, account: publicAccount(account) });
    }
    return json(res, 409, {
      ok: false,
      error: "Manual account connection disabled. Use the provider OAuth route so Social Cues stores real provider evidence.",
      platform,
      connectRoutes: {
        tiktok: "/api/oauth/tiktok/start",
        youtube: "/api/oauth/youtube/start",
        facebook: "/api/oauth/meta/start?platform=facebook",
        instagram: "/api/oauth/meta/start?platform=instagram",
        threads: "/api/oauth/threads/start",
        x: "/api/oauth/x/start",
        pinterest: "/api/oauth/pinterest/start",
        canva: "/api/oauth/canva/start",
        etsy: "/api/oauth/etsy/start",
        shopify: "/api/oauth/shopify/start"
      }
    });
  }

  if (url.pathname === "/api/analyze" && req.method === "POST") {
    const model = await getModel();
    if (!(await hostedWriteRequiresSession(req, model))) {
      return json(res, 401, { ok: false, error: "Sign in before refreshing workspace analytics." });
    }
    model.analytics = buildGrowthAnalytics(model);
    await saveModel(model);
    return json(res, 200, { ok: true, analytics: model.analytics });
  }

  if (url.pathname === "/api/media/generate" && req.method === "POST") {
    const model = await getModel();
    if (!(await hostedWriteRequiresSession(req, model))) {
      return json(res, 401, { ok: false, error: "Sign in before generating media guidance." });
    }
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
    const model = await getModel();
    const session = await entitledSessionFromRequest(model, req);
    if ((runtimeMode === "vercel" || bearerToken(req)) && !session) {
      return appAccessRequiredResponse(res);
    }
    return json(res, 200, publicModel(model, session));
  }

  return json(res, 404, { ok: false, error: "Not found", path: url.pathname });
}

await ensureModel();

export default async function handler(req, res) {
  return requestSecurityContext.run({ session: null, sessionResolved: false, workspaceScoped: false, permission: "none" }, () => route(req, res)).catch(error => {
    if (error?.expose && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
      return json(res, error.status, { ok: false, error: error.message });
    }
    const incidentId = crypto.randomUUID();
    captureSentryError(error, {
      surface: "server",
      method: req?.method,
      route: safeSentryPath(req?.url),
      incidentId
    });
    console.error(JSON.stringify({ type: "social-cues-request-failed", incidentId, method: req?.method, route: safeSentryPath(req?.url) }));
    void flushSentry();
    json(res, 500, { ok: false, error: "Internal server error.", incidentId });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = http.createServer(handler);
  server.listen(port, host, () => {
    console.log(`Social Cues local test app running at http://127.0.0.1:${port}`);
    console.log("For phone access, open http://YOUR-COMPUTER-LAN-IP:" + port + " while on the same Wi-Fi.");
  });
}
