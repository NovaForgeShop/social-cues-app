import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const port = 4199;
const base = `http://127.0.0.1:${port}`;
const testDataDir = path.join(process.cwd(), ".tmp", `regression-data-${port}-${Date.now()}`);
const localPromoCodes = [
  { code: "SC-LOCAL-BEACON-4M7Q", label: "Local test account 1", days: 120, active: true },
  { code: "SC-LOCAL-SIGNAL-9X2P", label: "Local test account 2", days: 120, active: true },
  { code: "SC-LOCAL-PULSE-6R8N", label: "Local test account 3", days: 120, active: true },
  { code: "SC-LOCAL-LAUNCH-3V5K", label: "Local test account 4", days: 120, active: true }
];
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    AUTH_PROVIDER: "alpha-local",
    SUPABASE_ENABLED: "false",
    SENTRY_DSN: "",
    SOCIAL_CUES_DATA_DIR: testDataDir,
    SOCIAL_CUES_PROMO_CODES: JSON.stringify(localPromoCodes),
    WORKER_SECRET: "test-worker-secret",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    GOOGLE_PUBLIC_APP_URL: "https://socialcuesapp.com",
    META_APP_ID: "test-meta-app-id",
    META_APP_SECRET: "test-meta-app-secret",
    DISCORD_APPLICATION_ID: "test-discord-application-id",
    DISCORD_APP_SECRET: "test-discord-app-secret",
    PINTEREST_CLIENT_ID: "test-pinterest-client-id",
    PINTEREST_CLIENT_SECRET: "test-pinterest-client-secret",
    PINTEREST_ACCESS_TIER: "trial",
    CANVA_CONNECT_CLIENT_ID: "test-canva-connect-client-id",
    CANVA_CONNECT_CLIENT_SECRET: "test-canva-connect-client-secret",
    SHOPIFY_APP_ID: "test-shopify-app-id",
    SHOPIFY_APP_SECRET: "test-shopify-app-secret",
    ETSY_KEYSTRING: "test-etsy-keystring",
    ETSY_SHARED_SECRET: "test-etsy-shared-secret",
    PATREON_PUBLIC_APP_URL: "https://socialcuesapp.com",
    PATREON_CLIENT_ID: "test-patreon-client-id",
    PATREON_CLIENT_SECRET: "test-patreon-client-secret",
    PATREON_OAUTH_SCOPES: "identity campaigns campaigns.members campaigns.posts w:campaigns.webhook"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
server.stdout.on("data", chunk => { output += chunk; });
server.stderr.on("data", chunk => { output += chunk; });

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  return body;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(base + "/health");
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Social Cues test server did not become ready. ${output}`);
}

try {
  await waitForServer();
  const health = await request("/health");
  if (!health.ok) throw new Error("health not ok");
  const monitoring = await request("/api/monitoring/status");
  if (!monitoring.ok || monitoring.provider !== "sentry" || monitoring.piiCollection !== false || monitoring.requestBodies !== false || monitoring.secretCollection !== false) {
    throw new Error("Sentry monitoring status must prove secret-safe collection settings");
  }
  const unauthorizedWorker = await fetch(base + "/api/cron/workers");
  if (unauthorizedWorker.status !== 401) throw new Error("durable worker trigger must reject requests without its bearer secret");
  const unavailableWorker = await fetch(base + "/api/cron/workers", { headers: { Authorization: "Bearer test-worker-secret" } });
  const unavailableWorkerBody = await unavailableWorker.json();
  if (unavailableWorker.status !== 503 || unavailableWorkerBody.ready !== false) throw new Error("durable worker trigger must report unavailable when its database ledger is disabled");
  const appShell = await request("/api/app-shell/readiness");
  if (!appShell.ok || !appShell.markers?.providerStateLedger || !appShell.markers?.durablePublishQueue || !appShell.markers?.analyticsSnapshotBank || !appShell.markers?.postingIdentityResolver || !appShell.markers?.permissionGapExplainer || !appShell.markers?.providerCacheCleanup) throw new Error("app shell readiness should prove the packaged workstation file, new ledger cards, posting identity labels, permission explanations, and provider cache cleanup");

  const manifestResponse = await fetch(base + "/manifest.webmanifest");
  if (!manifestResponse.ok) throw new Error("manifest failed");
  const manifest = await manifestResponse.json();
  if (manifest.name !== "Social Cues") throw new Error("bad manifest");

  const iconResponse = await fetch(base + "/icon.svg");
  if (!iconResponse.ok) throw new Error("icon failed");
  for (const iconPath of ["/sc-icon-192.png", "/sc-icon-512.png", "/apple-touch-icon.png", "/favicon.png"]) {
    const pngResponse = await fetch(base + iconPath);
    const pngBuffer = Buffer.from(await pngResponse.arrayBuffer());
    if (!pngResponse.ok || pngResponse.headers.get("content-type") !== "image/png" || pngBuffer.length < 100 || pngBuffer[0] !== 0x89 || pngBuffer[1] !== 0x50) {
      throw new Error(`${iconPath} png icon failed`);
    }
  }
  const publicAssets = await request("/api/media/public-assets");
  if (!publicAssets.ok || !publicAssets.assets?.some(asset => asset.fileName === "social-cues-coming-soon-vertical-9x16-1080x1920.mp4" && asset.metaPullReady)) {
    throw new Error("public launch media asset manifest failed");
  }
  const publicVideoResponse = await fetch(base + "/media/social-cues-promo-pack/social-cues-coming-soon-vertical-9x16-1080x1920.mp4");
  const publicVideoBuffer = Buffer.from(await publicVideoResponse.arrayBuffer());
  if (!publicVideoResponse.ok || publicVideoResponse.headers.get("content-type") !== "video/mp4" || publicVideoBuffer.length < 1000) {
    throw new Error("public launch media video route failed");
  }
  const publicVideoHead = await fetch(base + "/media/social-cues-promo-pack/social-cues-coming-soon-vertical-9x16-1080x1920.mp4", { method: "HEAD" });
  if (!publicVideoHead.ok || publicVideoHead.headers.get("content-type") !== "video/mp4" || Number(publicVideoHead.headers.get("content-length") || 0) < 1000) {
    throw new Error("public launch media HEAD route failed");
  }

  const appHtml = await readFile(new URL("./social-cues-app.html", import.meta.url), "utf8");
  if (!appHtml.includes("Attach launch video") || !appHtml.includes("Local preview only")) throw new Error("publish media UI must distinguish hosted launch assets from local previews");
  if (!appHtml.includes('data-variant-schedule=') || !appHtml.includes("function setVariantSchedule") || !appHtml.includes("scheduledAt > Date.now()") || !appHtml.includes("schedule cleared")) {
    throw new Error("campaign variants must preserve a user-selected local publish time when queued");
  }
  for (const customerSurface of [
    'data-view="library"', 'data-view="commerce"', 'id="buildAudienceBrief"', 'id="runListeningSearch"',
    'id="loadManychatCrm"', 'id="saveAdDraft"', 'id="workspaceMemberList"', 'id="billingAccountStatus"'
  ]) {
    if (!appHtml.includes(customerSurface)) throw new Error(`customer foreground surface missing: ${customerSurface}`);
  }
  for (const customerFunction of [
    "loadCustomerSource", "loadMetaEmbed", "buildAudienceBrief", "runListeningSearch", "recordCommerceSignal",
    "loadManychatCrm", "submitManychatAction", "previewMetaMarketingMessage", "saveAdDraft", "loadWorkspaceAccess", "loadBillingStatus"
  ]) {
    if (!appHtml.includes(`function ${customerFunction}`) && !appHtml.includes(`async function ${customerFunction}`)) throw new Error(`customer foreground function missing: ${customerFunction}`);
  }
  if (!appHtml.includes('data-admin-only>Save server copy') || !appHtml.includes('data-admin-only>Reset developer copy')) throw new Error("developer-only workspace disk controls must be hidden from customer accounts");
  if (appHtml.includes('id="billingStatusInput"') || appHtml.includes('id="paymentLinkInput"')) throw new Error("customer billing must not expose editable backend setup fields");
  const serverSource = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  const packageSource = await readFile(new URL("./package.json", import.meta.url), "utf8");
  const perUserMigrationSource = await readFile(new URL("./SUPABASE-PER-USER-MIGRATION.sql", import.meta.url), "utf8");
  const durableWorkerMigrationSource = await readFile(new URL("./SUPABASE-DURABLE-WORKERS.sql", import.meta.url), "utf8");
  const manychatIsolationMigrationSource = await readFile(new URL("./SUPABASE-MANYCHAT-ISOLATION.sql", import.meta.url), "utf8");
  const passwordRecoveryMigrationSource = await readFile(new URL("./SUPABASE-PASSWORD-RECOVERY.sql", import.meta.url), "utf8");
  const vercelConfigSource = await readFile(new URL("./vercel.json", import.meta.url), "utf8");
  const renderWorkerSource = await readFile(new URL("./render-worker/worker.mjs", import.meta.url), "utf8");
  const renderWorkerDockerfile = await readFile(new URL("./render-worker/Dockerfile", import.meta.url), "utf8");
  const renderWorkerDeploySource = await readFile(new URL("./render-worker/deploy-cloud-run.ps1", import.meta.url), "utf8");
  const serviceWorkerSource = await readFile(new URL("./sw.js", import.meta.url), "utf8");
  const responseIntelligenceMigrationSource = await readFile(new URL("./SUPABASE-RESPONSE-INTELLIGENCE.sql", import.meta.url), "utf8");
  const envExampleSource = await readFile(new URL("./.env.example", import.meta.url), "utf8");
  const envSyncSource = await readFile(new URL("./scripts/sync-vercel-env.mjs", import.meta.url), "utf8");
  const productionEnvAudit = await readFile(new URL("./PRODUCTION-ENV-AUDIT-2026-06-28.md", import.meta.url), "utf8");
  const implementedRoutes = new Set([...serverSource.matchAll(/url\.pathname\s*===\s*"([^"]+)"/g)].map(match => match[1]));
  const declaredEndpoints = [...serverSource.matchAll(/endpoint:\s*"([^"]+)"/g)]
    .map(match => match[1].split("?")[0])
    .filter(route => route.startsWith("/api/"));
  const missingDeclaredEndpoints = [...new Set(declaredEndpoints.filter(route => !implementedRoutes.has(route)))];
  if (missingDeclaredEndpoints.length) throw new Error(`declared provider endpoints missing handlers: ${missingDeclaredEndpoints.join(", ")}`);
  const customerOAuthStartRoutes = [
    "/api/oauth/short-video/start", "/api/oauth/instagram/start", "/api/oauth/threads/start",
    "/api/oauth/youtube/start", "/api/oauth/meta/start", "/api/oauth/x/start",
    "/api/oauth/pinterest/start", "/api/oauth/canva/start", "/api/oauth/shopify/start",
    "/api/oauth/etsy/start", "/api/oauth/linkedin/start", "/api/oauth/patreon/start", "/api/oauth/twitch/start",
    "/api/oauth/discord/start"
  ];
  const missingCustomerOAuthHandlers = customerOAuthStartRoutes.filter(route => !implementedRoutes.has(route));
  if (missingCustomerOAuthHandlers.length) throw new Error(`customer OAuth cards point at missing handlers: ${missingCustomerOAuthHandlers.join(", ")}`);
  if (/\son(?:click|input|change)=/i.test(appHtml)) throw new Error("app HTML reintroduced inline event handlers");
  if (/Cory Barton|ForgePilot|Forge Pilot|FPv2/i.test(appHtml)) throw new Error("app HTML contains stale personal or old brand defaults");
  if (/localStorage\.setItem\((SESSION_TOKEN_KEY|tokenKey|legacyTokenKey)/.test(`${appHtml}\n${serverSource}`)) throw new Error("session token should not be persisted into browser storage");
  if (!serverSource.includes("SOCIAL_CUES_PROMO_CODES") || /SC-TEST-[A-Z]+-[A-Z0-9]+/.test(serverSource)) throw new Error("active tester promo codes must be supplied through server environment, not deployed source");
  if (!serverSource.includes("REDDIT_DEVVIT_PROJECT_READY") || !serverSource.includes("redditDevvitProjectDeclaredReady") || !serverSource.includes('if (runtimeMode === "vercel") return redditDevvitProjectDeclaredReady')) throw new Error("production Reddit readiness must use verified flags instead of packaging the Devvit toolchain");
  if (serverSource.includes("promoFromSupabaseUser") || /raw_user_meta_data[\s\S]{0,400}promo/i.test(serverSource)) throw new Error("user-editable Supabase metadata must never grant promo authorization");
  if (!serverSource.includes('if (runtimeMode === "vercel") {\n        return { ok: false, status: 401, error: "Email or password did not match a verified Social Cues account." };')) throw new Error("hosted Supabase login must never fall back to a legacy local password hash");
  if (!serverSource.includes('ready: checkoutReady && webhookReady') || !serverSource.includes('if (runtimeMode === "vercel" && !stripeWebhookSecret)')) throw new Error("Stripe must not accept hosted checkout before signed entitlement webhooks are configured");
  if (serverSource.includes("Stripe Checkout is live") || !serverSource.includes('id="portalCheckout" disabled') || !serverSource.includes('button.textContent = billing.ready ? "Pay or manage checkout" : "Payments opening soon"')) throw new Error("public payment controls must reflect verified billing readiness instead of exposing a dead checkout");
  if (/localStorage\.setItem\(STORAGE_KEY,\s*JSON\.stringify\(model\)\)/.test(appHtml) || /body:\s*JSON\.stringify\(model\)/.test(appHtml)) throw new Error("browser model persistence must use sanitized snapshots");
  if (!appHtml.includes("SENSITIVE_BROWSER_STORAGE_KEYS") || !appHtml.includes("scrubBrowserStorageValue") || !appHtml.includes("persistModelSnapshot") || !appHtml.includes("sanitizedModelSnapshot(model)")) throw new Error("browser model storage scrubber missing");
  if (!serverSource.includes('url.pathname === "/api/responses"') || !serverSource.includes('url.pathname === "/api/responses/actions"') || !appHtml.includes("function updateDurableResponse")) throw new Error("durable response inbox and customer actions are incomplete");
  if (!responseIntelligenceMigrationSource.includes("create table if not exists public.response_events") || !responseIntelligenceMigrationSource.includes("create policy server_only_deny_all") || !responseIntelligenceMigrationSource.includes("revoke all on table public.response_events from public, anon, authenticated")) throw new Error("response intelligence storage must remain explicitly server-only");
  if (!serverSource.includes('url.pathname === "/api/push/subscribe"') || !serverSource.includes("encrypted_subscription: encryptedToken") || !appHtml.includes('id="togglePushNotifications"') || !serviceWorkerSource.includes('self.addEventListener("push"')) throw new Error("encrypted per-device push notifications are incomplete");
  if (!serverSource.includes('job.kind === "analytics_collection"') || !serverSource.includes('job.kind === "audience_brief"') || !serverSource.includes("social-cues-evidence-rules-v1")) throw new Error("scheduled analytics and evidence-only audience brief workers are incomplete");
  if (!appHtml.includes("openPaymentUrl") || !appHtml.includes('"checkout.stripe.com", "buy.stripe.com"') || !appHtml.includes('window.open(parsed.toString(), "_blank", "noopener,noreferrer")')) throw new Error("payment links must use the approved-host safe opener");
  if (!appHtml.includes('.replaceAll("\'", "&#39;")')) throw new Error("HTML escaping must encode apostrophes");
  if (!serverSource.includes("SOCIAL_CUES_DATA_DIR") || !serverSource.includes("model.invalid-") || !serverSource.includes("await rename(tempPath, modelPath)") || !serverSource.includes("Recovered malformed local model.json")) throw new Error("local model persistence should isolate tests, recover malformed JSON, and write atomically");
  if (!serverSource.includes("function normalizeBrandHashtags") || !serverSource.includes("brandKitTagList") || !serverSource.includes("model.brandKit || {}")) throw new Error("server-side brand kit copy support is missing");
  if (!serverSource.includes("function resolvedAppUserRole")) throw new Error("resolved app-user role helper is missing");
  if (!/workspace_members\?on_conflict=workspace_id,user_id"[\s\S]{0,320}role: "owner"/.test(serverSource)) throw new Error("private workspace persistence must keep the account owner as the workspace owner");
  if (!serverSource.includes("ownsPrivateWorkspace") || !serverSource.includes("workspaceId === ownerUserId")) throw new Error("private workspace owners must retain member-management authority regardless of subscription label");
  if (!serverSource.includes("merged.workspace = workspaceForUser(workspaceModel, user)")) throw new Error("session hydration must keep the private workspace identity instead of replacing it with the shared registry label");
  if (!appHtml.includes("Account health") || !appHtml.includes('id="accountHealthSummary"') || !appHtml.includes("Refresh insights")) throw new Error("account page should use the customer-facing account health summary");
  if (!appHtml.includes('data-manychat-connect') || !appHtml.includes('type="password"') || !appHtml.includes('authedFetch("/api/manychat/connect"')) throw new Error("Manychat should connect through an authenticated password-style key control");
  if (!appHtml.includes('data-manychat-profile-connect') || !appHtml.includes('data-manychat-template-generate') || !appHtml.includes('authedFetch("/api/manychat/profile/connect"') || !appHtml.includes('authedFetch("/api/manychat/template-link"')) throw new Error("Manychat Profile API must have a distinct template-link connection instead of being submitted as an Account API token");
  if (!serverSource.includes('credential: encryptedToken(apiKey)') || !serverSource.includes('url.pathname === "/api/manychat/catalog"') || !serverSource.includes('url.pathname === "/api/manychat/action"') || !serverSource.includes('url.pathname === "/api/manychat/usage"')) throw new Error("Manychat per-user connection, catalog, guarded actions, and usage routes are missing");
  if (!serverSource.includes('url.pathname === "/api/manychat/profile/connect"') || !serverSource.includes('url.pathname === "/api/manychat/template-link"') || !serverSource.includes('platform: "manychat_profile"') || !serverSource.includes('"/user/template/generateSingleUseLink"')) throw new Error("Manychat Profile Template API must verify, encrypt, and reuse a separate per-workspace token family");
  if (!manychatIsolationMigrationSource.includes("create table if not exists public.provider_api_rate_buckets") || !manychatIsolationMigrationSource.includes("pg_advisory_xact_lock") || !manychatIsolationMigrationSource.includes("social_cues_claim_provider_api_quota")) throw new Error("Manychat/provider quota isolation must be durable and concurrency-safe");
  if (!manychatIsolationMigrationSource.includes("enable row level security") || !manychatIsolationMigrationSource.includes("revoke all on table public.provider_api_rate_buckets from public, anon, authenticated") || !manychatIsolationMigrationSource.includes("to service_role")) throw new Error("provider quota storage must remain service-role only");
  if (!serverSource.includes('`subscriber-send:${subscriberHash}`') || !serverSource.includes("manychatSubscriberHourlySendLimit") || !serverSource.includes("manychatDailySendLimit")) throw new Error("Manychat sending must be isolated by account and subscriber with conservative limits");
  if (!appHtml.includes('data-elevenlabs-connect') || !appHtml.includes('id="voiceoverStudio"') || !appHtml.includes('authedFetch("/api/elevenlabs/text-to-speech"')) throw new Error("ElevenLabs must expose a restricted-key account connection and Campaign Studio voiceover lane");
  if (!serverSource.includes('url.pathname === "/api/elevenlabs/connect"') || !serverSource.includes('url.pathname === "/api/elevenlabs/catalog"') || !serverSource.includes('url.pathname === "/api/elevenlabs/text-to-speech"') || !serverSource.includes('url.pathname === "/api/elevenlabs/usage"')) throw new Error("ElevenLabs connection, catalog, generation, and usage routes are missing");
  if (!serverSource.includes('credential: encryptedToken(apiKey)') || !serverSource.includes('p_provider: "elevenlabs"') || !serverSource.includes('confirm !== "GENERATE_ELEVENLABS_AUDIO"')) throw new Error("ElevenLabs secrets, metering, and live-generation approval controls are incomplete");
  if (!serverSource.includes('"xi-api-key": apiKey') || serverSource.includes('xi_api_key: verified.xi_api_key')) throw new Error("ElevenLabs API keys must stay server-side and must not be copied from provider identity responses");
  if (!serverSource.includes('characterLimit > 0 && text.length > remaining')) throw new Error("ElevenLabs must block generation when a known account allowance is exhausted");
  if (!appHtml.includes('data-view="brandkit"') || !appHtml.includes('id="saveBrandKit"') || !appHtml.includes('id="brandKitSummary"') || !appHtml.includes('id="brandKitDashboard"')) throw new Error("brand kit workspace surface is missing");
  if (!appHtml.includes("function normalizeTagList") || !appHtml.includes("function renderBrandKit") || !appHtml.includes("function saveBrandKit")) throw new Error("brand kit client logic is missing");
  if (!appHtml.includes("function canAccessAdminPanel") || !appHtml.includes("function syncAdminSurface") || !appHtml.includes('if (view === "integrations" && !canAccessAdminPanel()) view = "dashboard";')) throw new Error("admin panel separation helpers are missing");
  if (!appHtml.includes('id="onboardingAccountRequirements"') || !appHtml.includes("const onboardingAccountRequirements") || !appHtml.includes("function renderOnboardingAccountRequirements")) throw new Error("onboarding provider-account prerequisite guide is missing");
  for (const accountLesson of ["managed Facebook Page", "Instagram professional account", "selected YouTube channel", "Manage Server permission", "Verified Google Business Profile location", "restricted API key"]) {
    if (!appHtml.includes(accountLesson)) throw new Error(`onboarding account lesson missing: ${accountLesson}`);
  }
  if (!appHtml.includes("Advanced proof details") || !appHtml.includes("advancedProofSection")) throw new Error("integration page should fold duplicate proof cards into advanced details");
  if (!appHtml.includes("App shell package") || !serverSource.includes('url.pathname === "/api/app-shell/readiness"')) throw new Error("app shell packaging readiness route/UI hook missing");
  if (!appHtml.includes("body.auth-required .app") || !appHtml.includes('document.body.classList.add("auth-required")') || !appHtml.includes('document.body.classList.remove("auth-required")')) throw new Error("logged-out app route should hide the workspace shell behind auth");
  if (!/<h1 id="authTitle">Log in to Social Cues<\/h1>\s*<p id="authHelp">Use your registered email and password\.<\/p>/.test(appHtml)) throw new Error("default app login should ask only for registered email and password");
  if (!/<label class="create-only hidden">\s*<span class="small-label">Device name<\/span>/.test(appHtml) || !appHtml.includes('deviceName: includeManualName ? (clean($("#loginDeviceInput")?.value) || defaultDeviceName()) : defaultDeviceName()') || !appHtml.includes("collectDeviceInfo(signupMode)")) throw new Error("device naming should be a create-account detail, not a login field");
  if (!appHtml.includes('<button class="primary" id="loginButton">Log in</button>') || !appHtml.includes('<button class="secondary" id="createAccountButton">Create account</button>')) throw new Error("default app auth actions should make login primary and create-account secondary");
  if (!serverSource.includes('<div class="notice" id="authNotice">Log in with your registered email and password.</div>')) throw new Error("portal login notice should not ask for account-creation details during login");
  if (!serverSource.includes('id="forgotPasswordBtn"') || !serverSource.includes('id="recoveryBox"') || !serverSource.includes('id="recoveryEmailInput"')) throw new Error("portal should expose a complete password recovery request panel");
  if (!serverSource.includes('/recover?redirect_to=${redirectTo}') || /requestSupabasePasswordRecovery[\s\S]{0,400}redirect_to:\s*passwordResetPortalUrl/.test(serverSource)) throw new Error("Supabase password recovery must pass redirect_to in the request URL");
  if (!serverSource.includes("function passwordResetPageHtml") || !serverSource.includes('url.pathname === "/reset-password"') || !serverSource.includes('recoveryType === "recovery"')) throw new Error("the emailed-link-only password reset page is missing");
  if (!serverSource.includes('claims.methods.includes("recovery")') || !serverSource.includes("claimPasswordRecoveryInstance") || !serverSource.includes("finishPasswordRecoveryInstance")) throw new Error("password updates must require and consume a Supabase recovery instance");
  if (!/url\.pathname === "\/api\/auth\/logout"[\s\S]{0,500}session\.device\.revokedAt[\s\S]{0,300}persistNormalizedDeviceAuthState\(session\.device\)/.test(serverSource)) throw new Error("logout must durably revoke the normalized device session");
  if (!serverSource.includes("function normalizedDeviceSessionsForUser") || !serverSource.includes("deviceRevokeMatch") || !serverSource.includes("persistNormalizedDeviceAuthState(target)")) throw new Error("device management must read durable sessions and revoke a selected non-current device");
  if (!/async function sessionFromRequest[\s\S]{0,500}if \(supabaseAuthEnabled\(\)\) \{[\s\S]{0,200}normalizedDeviceSessionByTokenHash/.test(serverSource)) throw new Error("Supabase sessions must trust the normalized device record before any stale shared registry entry");
  if (!/async function persistNormalizedDeviceAuthState[\s\S]{0,4000}on_conflict=user_id,device_id/.test(serverSource) || !/async function persistNormalizedDeviceAuthState[\s\S]{0,800}preserveDurableRevocation/.test(serverSource)) throw new Error("device auth writes must create new devices without resurrecting durable revocations");
  if (!/async function persistNormalizedDeviceAuthState[\s\S]{0,3200}method: "PATCH"[\s\S]{0,500}return=representation[\s\S]{0,500}Device session revocation did not persist/.test(serverSource)) throw new Error("existing device changes must use a verified owner-and-device update");
  if (!/normalizedDeviceSessionByTokenHash[\s\S]{0,500}model\.deviceSessions = \[[\s\S]{0,500}\.filter\(item =>/.test(serverSource)) throw new Error("normalized session lookup must replace a stale registry copy instead of duplicating the device");
  if (!/function buildGrowthAnalytics[\s\S]{0,500}if \(!connected\.length\)[\s\S]{0,500}status: "Waiting for connected accounts"[\s\S]{0,500}metrics: \[\]/.test(serverSource)) throw new Error("unconnected customer workspaces must not receive internal readiness metrics as analytics");
  if (!appHtml.includes("data-device-revoke") || !appHtml.includes("function revokeRememberedDevice") || !appHtml.includes("Sign out device")) throw new Error("Devices must expose a customer-facing sign-out control for remembered devices");
  if (!serverSource.includes("const [rows, normalizedRows] = await Promise.all") || !serverSource.includes("name: normalizedWorkspace.name")) throw new Error("workspace loading must preserve the normalized customer workspace name");
  if (!serverSource.includes("hasLegacySharedWorkspaceContamination") || !serverSource.includes('source: "legacy-shared-seed-quarantine"')) throw new Error("legacy shared-seed workspaces must be quarantined before customer delivery");
  if (/async function ensureWorkspaceBootstrap[\s\S]{0,500}getSeedModel\(\)/.test(serverSource)) throw new Error("customer workspace bootstrap must never clone the shared product seed");
  if (!/async function clientWorkspaceModelForUser[\s\S]{0,2600}activeCampaignId: ""[\s\S]{0,100}campaigns: \[\][\s\S]{0,100}actions: \[\]/.test(serverSource) || /async function ensureWorkspaceBootstrap[\s\S]{0,1800}model\.campaigns\.push/.test(serverSource)) throw new Error("new customer workspaces must remain blank across creation and bootstrap");
  if (!serverSource.includes("function blankClientIntegrations") || !serverSource.includes("copySharedRegistryFields(model, sharedModel, { includeIntegrations: false })")) throw new Error("new customer workspaces must not inherit another user's provider-status labels");
  if (!/activeCampaignId: "",\s*campaigns: \[\]/.test(appHtml)) throw new Error("the browser default must not invent a starter campaign");
  if (/const first = defaultModel\.campaigns\[0\]/.test(appHtml)) throw new Error("browser boot must not generate content from a nonexistent starter campaign");
  if (!serverSource.includes('safe.deviceSessions = [];') || !serverSource.includes('source: "client-isolated-workspace"')) throw new Error("workspace snapshots must exclude device security records and remain explicitly isolated");
  if (!appHtml.includes('if (SERVER_MODE) {\n        // Hosted workspaces are authoritative on the server.') || !appHtml.includes("function hostedSessionShell")) throw new Error("hosted browsers must not persist a cross-account workspace cache");
  if (!/if \(SERVER_MODE\)\s*\{\s*persistModelSnapshot\(model\);\s*render\(\);\s*\} else \{\s*saveModel\("Initialized Social Cues model\."\)/.test(appHtml)) throw new Error("a fresh hosted browser must not overwrite the customer workspace with the starter model");
  if (!passwordRecoveryMigrationSource.includes("create table if not exists public.password_recovery_instances") || !passwordRecoveryMigrationSource.includes("enable row level security") || !passwordRecoveryMigrationSource.includes("revoke all on table public.password_recovery_instances from public, anon, authenticated")) throw new Error("password recovery replay protection must be durable and service-role only");
  if (!appHtml.includes('href="/portal?mode=forgot-password"')) throw new Error("the app login screen must expose the password recovery request lane");
  if (!serverSource.includes('"/api/auth/password-recovery"') || !serverSource.includes('"/api/auth/password-update"')) throw new Error("hosted auth hardening routes for password recovery/update are missing");
  if (!appHtml.includes("<h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p>") || !appHtml.includes("<p>${escapeHtml(label)}</p>") || !appHtml.includes("<h3>${escapeHtml(heading)}</h3>") || !appHtml.includes("function deliveryHistoryCard") || !appHtml.includes("escapeHtml(platform.name)") || !appHtml.includes("escapeHtml(detail)") || !appHtml.includes("<span class=\"pill ${userState.pill}\">${userState.label}</span>")) throw new Error("workspace, campaign, calendar, and customer account card renderers must escape user-controlled text");
  if (!appHtml.includes("Follow-up video lane") || !appHtml.includes("Shared video everywhere") || !appHtml.includes("Unique cut per platform")) throw new Error("raw video follow-up lane controls missing");
  if (!serverSource.includes("openai_campaign_generation_fallback") || !serverSource.includes("AI generation was unavailable; local platform rules produced editable drafts instead.")) throw new Error("campaign generation must fall back to the local platform engine when OpenAI quota or availability fails");
  if (!appHtml.includes("createRawVideoFollowups") || !appHtml.includes("Follow-up map")) throw new Error("raw video follow-up generator missing");
  if (appHtml.includes("output.hashtags.map")) throw new Error("raw video output cards must tolerate older outputs without hashtags");
  if (!appHtml.includes("Array.isArray(source.outputs)") || !appHtml.includes("safeFollowups.map")) throw new Error("raw video renderer must tolerate malformed saved output/follow-up arrays");
  if (!appHtml.includes("createComingSoonShotCampaign") || !appHtml.includes("Coming soon shot") || !appHtml.includes("Hosted video URL")) throw new Error("coming-soon hosted video workflow missing");
  if (!appHtml.includes("Provider truth") || !appHtml.includes("Next provider actions") || !appHtml.includes("/api/provider/truth") || !appHtml.includes("/api/provider/action-check")) throw new Error("provider truth UI/API hook missing");
  if (!appHtml.includes('statusRoute: "/api/meta/instagram/accounts"') || !appHtml.includes('statusRoute: "/api/meta/assets"')) throw new Error("Meta account cards should expose direct setup checks");
  if (!appHtml.includes("function providerAccountKey") || !appHtml.includes("function mergeConnectedAccountLists") || !appHtml.includes("source.instagramAssets?.accounts")) throw new Error("provider evidence should dedupe by real account identity and merge dedicated Instagram asset checks");
  if (!appHtml.includes('authedFetch("/api/meta/instagram/accounts")') || !appHtml.includes("liveMetaAssetCount(\"instagram\")") || !appHtml.includes("metaDetectedInstagramAssetCount")) throw new Error("dashboard refresh should pull live Instagram assets and distinguish Meta-detected IG claims from usable token-backed assets");
  if (!appHtml.includes("data.diagnostic?.nextAction") || !appHtml.includes("pagesChecked")) throw new Error("setup-check alerts should expose provider diagnostics and checked asset counts");
  if (!appHtml.includes("Alpha test panel") || !appHtml.includes("/api/test-panel") || !appHtml.includes("renderAlphaTestPanel") || !serverSource.includes("function alphaTestPanel") || !serverSource.includes('url.pathname === "/api/test-panel"')) throw new Error("alpha test panel UI/API hook missing");
  if (!appHtml.includes("Each OAuth callback must map to exactly one provider row") && !serverSource.includes("Each OAuth callback must map to exactly one provider row")) throw new Error("alpha test panel should state OAuth/provider mapping rule");
  if (!appHtml.includes("data-function-check-suite=\"alpha-panel\"")) throw new Error("alpha test panel should expose safe function-check buttons");
  if (!appHtml.includes("data-function-check-provider") || !appHtml.includes("await refreshAlphaTestPanel()") || !appHtml.includes("Last check")) throw new Error("alpha test panel checks should keep provider identity and refresh live status");
  if (!appHtml.includes("/api/provider/publish-check") || !appHtml.includes("data-provider-publish-check")) throw new Error("provider publish-check UI/API hook missing");
  if (!appHtml.includes("/api/provider/acceptance-sweep") || !appHtml.includes("data-provider-acceptance-sweep")) throw new Error("provider acceptance sweep UI/API hook missing");
  if (!appHtml.includes('action.type === "Provider task"') || !appHtml.includes("action.providerGate") || !appHtml.includes('event.target.closest(".connector-route")')) throw new Error("provider action tasks should expose direct provider controls");
  if (!appHtml.includes('current.missing || []') || !appHtml.includes('current.owned')) throw new Error("Action Lab must hide historical provider tasks after the live acceptance ledger satisfies their gate");
  if (!appHtml.includes("data-external-route") || !appHtml.includes("openExternalRoute")) throw new Error("provider action tasks should expose safe external portal links");
  if (!appHtml.includes("data-copy-text") || !appHtml.includes("Copy callback") || !appHtml.includes("copyTextValue")) throw new Error("provider action tasks should expose callback copy controls");
  if (!appHtml.includes("Acceptance ledger") || !appHtml.includes("/api/provider/acceptance-ledger")) throw new Error("provider acceptance ledger UI/API hook missing");
  if (!appHtml.includes("Connection event log") || !appHtml.includes("/api/provider/connection-log") || !serverSource.includes("function providerConnectionLog") || !serverSource.includes('url.pathname === "/api/provider/connection-log"')) throw new Error("provider connection event log surface missing");
  if (!appHtml.includes("renderProviderConnectionLogCards") || !serverSource.includes("nextConnectionActions") || !serverSource.includes("recentActivity")) throw new Error("provider connection log should expose proof chain and recent event metadata");
  if (!serverSource.includes('step("developer", "Developer app/portal", developerReady, developerDetail)') || !serverSource.includes("Developer credentials are present; finish the provider portal setup")) throw new Error("provider connection log should distinguish credential readiness from portal/review blockers");
  if (!appHtml.includes("Provider ownership queue") || !appHtml.includes("/api/provider/ownership-queue") || !appHtml.includes("/api/provider/ownership-run") || !serverSource.includes("function providerOwnershipQueue") || !serverSource.includes("async function runProviderOwnershipProof")) throw new Error("provider ownership queue/run surface missing");
  if (!appHtml.includes("renderProviderOwnershipQueueCards") || !appHtml.includes("data-provider-ownership-run") || !appHtml.includes("runProviderOwnership")) throw new Error("provider ownership queue UI controls missing");
  if (!appHtml.includes("/api/provider/ownership-sweep") || !appHtml.includes("data-provider-ownership-sweep") || !appHtml.includes("runProviderOwnershipSweep") || !serverSource.includes("async function runProviderOwnershipSweep") || !serverSource.includes('url.pathname === "/api/provider/ownership-sweep"')) throw new Error("provider ownership sweep route/UI hook missing");
  if (!appHtml.includes("Ownership report") || !appHtml.includes("/api/provider/ownership-report") || !serverSource.includes("function providerOwnershipReport") || !serverSource.includes('url.pathname === "/api/provider/ownership-report"') || !serverSource.includes("text/markdown")) throw new Error("provider ownership report route/UI hook missing");
  if (!appHtml.includes("Catalog readiness") || !appHtml.includes("/api/meta/catalog/readiness")) throw new Error("Meta Catalog readiness should be visible in the function suite");
  if (!appHtml.includes("Messages readiness") || !appHtml.includes("/api/meta/messages") || !appHtml.includes("Instagram public content") || !appHtml.includes("/api/meta/instagram/shopping")) throw new Error("Meta extended use-case surfaces should be visible in the function suite");
  for (const route of ["/api/youtube/search", "/api/youtube/playlists", "/api/youtube/comments", "/api/youtube/activity"]) {
    if (!appHtml.includes(route)) throw new Error(`YouTube read-only expansion route missing from function suite: ${route}`);
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`YouTube read-only expansion route missing backend handler: ${route}`);
  }
  if (!serverSource.includes("requireYouTubeAccountForRead") || !serverSource.includes('youtubeData("/search"') || !serverSource.includes('youtubeData("/commentThreads"') || !serverSource.includes('youtubeData("/activities"')) throw new Error("YouTube read-only expansion should use Data API routes behind the connected account gate");
  if (!serverSource.includes("async function refreshYouTubeAccount(model, account, user = null)") || !serverSource.includes("saveModelForUser(model, user)") || !serverSource.includes("refreshYouTubeAccount(model, account, options.user || null)") || !serverSource.includes("refreshYouTubeAccount(model, account, session?.user || null)")) throw new Error("YouTube token refresh must save back to the signed-in user workspace");
  if (!serverSource.includes("function selectedProviderAccount") || !serverSource.includes("model.activeProviderAccounts") || !serverSource.includes("bestProviderAccountFromList(candidates, platform)")) throw new Error("provider account selection should honor the saved posting identity before falling back to a real token-backed account");
  if (!serverSource.includes("function providerAccountSelectionGroups") || !serverSource.includes("alternateCredentialFamilies") || !serverSource.includes("credentialPathCount")) throw new Error("provider account selection should collapse duplicate OAuth paths into one provider asset without discarding credential evidence");
  if (!appHtml.includes("function dedupeSelectableProviderAccounts") || !appHtml.includes("account.alternateCredentialFamilies")) throw new Error("Accounts should present one posting identity per provider asset even when more than one OAuth path proves access");
  if (!appHtml.includes("function customerDeliveryLedgerRows") || !appHtml.includes("function deliveryHistoryCard") || !appHtml.includes("provider receipt")) throw new Error("customer Calendar and Dashboard should surface normalized delivery history and provider receipt evidence");
  if (!appHtml.includes("Campaign source on record") || !appHtml.includes("Choose a file above to replace this saved campaign source")) throw new Error("raw video intake must distinguish a saved campaign source from the empty replacement file picker");
  if (!appHtml.includes("data-delivery-resolve") || !appHtml.includes("function focusAccountLane") || !appHtml.includes('navigateTo("accounts")')) throw new Error("blocked delivery rows must route customers directly to the affected account lane");
  if (!appHtml.includes('["blocked", "failed", "retrying"].includes(item.status)')) throw new Error("Dashboard run queue should prioritize blocked and retrying provider deliveries over ordinary drafts");
  if (!serverSource.includes("function providerIdentityEvidence") || !serverSource.includes("function providerAccountEvidenceTime") || !serverSource.includes("score(rightState) - score(leftState)")) throw new Error("provider account selection must rank verified, usable, fresh identities deterministically");
  if (!appHtml.includes("const actionPlatform = canonicalProviderAssetPlatform(platform.id)") || !serverSource.includes("const requestedPlatform = decodeURIComponent") || !serverSource.includes("const platform = canonicalProviderAssetPlatform(requestedPlatform)")) throw new Error("derived Google cards and account mutation routes must target the canonical YouTube identity");
  if (!appHtml.includes("await refreshMetaState();") || !appHtml.includes("selectedAccountId === mappedAccountId")) throw new Error("provider selection should refresh authoritative identity state and reject stale asset-map labels");
  for (const route of ["/api/provider/accounts", "/api/provider/accounts/select"]) {
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`provider account selection route missing: ${route}`);
  }
  if (!serverSource.includes('prompt: "consent select_account"') || !serverSource.includes('`acct-youtube-${channel.id}`') || !serverSource.includes("model.activeProviderAccounts.youtube = channel.id")) throw new Error("YouTube OAuth must preserve and select distinct channel identities");
  if (!appHtml.includes("data-provider-account-select") || !appHtml.includes("selectProviderAccount") || !appHtml.includes("Add channel") || !appHtml.includes("Add Page")) throw new Error("Accounts UI must expose posting-identity selection and asset discovery controls");
  if (!serverSource.includes("async function repairedProviderAccount") || !serverSource.includes("repairConnectedOAuthAccount(account, platform)")) throw new Error("provider account reflection should use the shared stale-handshake repair helper");
  if (!appHtml.includes("async function confirmOAuthReturn") || !appHtml.includes("oauthReturnStatusRoutes(provider)") || !appHtml.includes('twitch: ["/api/twitch/readiness", "/api/oauth/twitch/status"]')) throw new Error("OAuth returns should confirm provider evidence through status/readiness routes before the app card renders stale state");
  if (!appHtml.includes('instagram: ["/api/meta/instagram/accounts", "/api/oauth/meta/status", "/api/meta/assets"]')) throw new Error("Instagram OAuth return should refresh direct Instagram account evidence before generic Meta status");
  if (!/function hasStoredToken\(account\)[\s\S]*?account\?\.credential/.test(appHtml)) throw new Error("browser token detection must count backend credential fields as stored token evidence");
  if (!appHtml.includes("function providerIdentityEvidence") || !appHtml.includes("function accountConnectionState")) throw new Error("browser connected-account detection must consume shared provider identity and connection truth");
  if (!appHtml.includes("function canWriteHostedWorkspace()") || !appHtml.includes("return Boolean(SERVER_MODE && model.currentUser?.id)")) throw new Error("hosted workspace writes should require a current signed-in user");
  if (appHtml.includes("providerAccountId: account.providerAccountId || account.providerId || account.id")) throw new Error("provider evidence merge must not invent provider ids from local card ids");
  if (!appHtml.includes("account.connected === true && connectionState.connected")) throw new Error("provider evidence merge should require explicit backend connection truth");
  if (!/function mergeProviderEvidenceIntoModel[\s\S]*?Provider evidence is render-time backend truth; do not write it back as user model state/.test(appHtml)) throw new Error("provider evidence merge must remain render-only instead of persisting optimistic connection state");
  for (const provider of ["pinterest", "canva", "youtube", "shopify"]) {
    if (!serverSource.includes(`repairedProviderAccount(model, "${provider}"`)) throw new Error(`${provider} status/readiness should use shared repaired provider account selection`);
  }
  if (!serverSource.includes("async function usableEtsyAccount") || !serverSource.includes("usableEtsyAccount(model, { refresh: true")) throw new Error("Etsy status/readiness should select and refresh the durable account before rendering connection truth");
  if (!serverSource.includes("async function usableTwitchAccount") || !serverSource.includes("validateTwitchAccessToken") || !serverSource.includes('connectionState: connected ? "connected" : refreshError ? "needs-reconnect"')) throw new Error("Twitch readiness should validate and refresh tokens before showing connected");
  if (!serverSource.includes("async function usableTikTokAccount") || !serverSource.includes("refreshTikTokAccount") || !serverSource.includes("verifyTikTokAccount")) throw new Error("TikTok should refresh and verify access tokens before showing connected");
  if (!serverSource.includes("verifyXAccount(model, account") || !serverSource.includes("usableXAccount(model, { refresh: true, validate: true")) throw new Error("X status/readiness should verify and refresh tokens before showing connected");
  if (!serverSource.includes("function clearProviderTokenErrors") || !/function verifyXAccount[\s\S]*?clearProviderTokenErrors\(account\)/.test(serverSource) || !/url\.pathname === "\/api\/oauth\/x\/callback"[\s\S]*?clearProviderTokenErrors\(account\)/.test(serverSource)) throw new Error("successful X authorization and verification must clear stale reconnect flags");
  if (!/function usableProviderAccount[\s\S]*?providerAccountConnectionState\(account\)\.connected[\s\S]*?bestProviderAccountFromList/.test(serverSource)) throw new Error("an expired selected account must not outrank a healthy provider account");
  if (!serverSource.includes("x: account.providerAccountId") || !serverSource.includes("etsy: account.providerAccountId")) throw new Error("successful X and Etsy OAuth must activate the newly authorized posting identity");
  if (!serverSource.includes('billing_entitlements?on_conflict=workspace_id,user_id') || !serverSource.includes('resolution=merge-duplicates,return=minimal')) throw new Error("Supabase entitlement mirroring must be idempotent");
  if (!serverSource.includes('status: entitlement.active ? "active" : "inactive"') || !serverSource.includes("stripe_subscription_id")) throw new Error("Supabase entitlement mirroring must persist inactive Stripe lifecycle states");
  if (!/function mirrorNormalizedWorkspaceRows[\s\S]*?const normalizedConnectedAccounts = visibleConnectedAccounts\(model\)[\s\S]*?for \(const account of normalizedConnectedAccounts\)/.test(serverSource)) throw new Error("normalized provider persistence must omit stale placeholders when a real provider identity exists");
  if (!serverSource.includes("cleanupNormalizedProviderPlaceholders") || !serverSource.includes("reconcileProviderAccountEvidence")) throw new Error("provider persistence must remove invalid placeholder siblings after a verified identity is stored");
  if (!serverSource.includes("connectionReason: connectionState.reason") || !serverSource.includes("scopeEvidence: { requested: requestedScopes, granted: grantedScopes, missing: missingScopes }") || !serverSource.includes("credentialFamily: providerCredentialFamily(account)")) throw new Error("public account truth must expose safe reason, scope, provider-family, and asset evidence");
  if (!serverSource.includes("function scrubPublicAccountValue") || !serverSource.includes("nested]) => [key, scrubPublicAccountValue(nested)]")) throw new Error("public account secret scrubber must recursively remove nested secret fields");
  for (const secretField of ["encryptedtoken", "encryptedrefreshtoken", "clientsecret", "appsecret", "codeverifier", "sessiontokenhash"]) {
    if (!serverSource.includes(`"${secretField}"`)) throw new Error(`public account secret scrubber missing ${secretField}`);
  }
  if (!serverSource.includes('!item.providerAccountId && String(item.id || "") === String(publicProfile.id || "")')) throw new Error("normalized provider rehydration must not let a stale card id overwrite a real provider account identity");
  if (!serverSource.includes("encrypted_refresh_credential") || !serverSource.includes("normalizedDeviceSessionByTokenHash") || !serverSource.includes("persistNormalizedDeviceAuthState")) throw new Error("normalized device rows must support encrypted refresh recovery after cold starts");
  if (!serverSource.includes('"/rpc/social_cues_claim_auth_rate_limit"') || !perUserMigrationSource.includes("pg_advisory_xact_lock") || !perUserMigrationSource.includes("auth_rate_limits")) throw new Error("hosted auth throttling must be durable and concurrency-safe");
  if (!perUserMigrationSource.includes("billing_entitlements_workspace_user_uidx") || !perUserMigrationSource.includes("alter column user_id set not null")) throw new Error("Supabase migration must enforce one owned entitlement row per workspace user");
  if (!serverSource.includes("recordStripeSubscriptionState") || !serverSource.includes('customer.subscription.deleted') || !serverSource.includes('invoice.payment_failed')) throw new Error("Stripe webhook handling must reconcile subscription access loss");
  if (!serverSource.includes("claimDurableWebhookEvent") || !serverSource.includes("completeDurableWebhookEvent") || !perUserMigrationSource.includes("webhook_events")) throw new Error("Stripe webhook idempotency must survive server restarts");
  if (!serverSource.includes("publishIdempotencyKey") || !serverSource.includes("completedPublishReceipt") || !serverSource.includes("duplicateSuppressed")) throw new Error("live publish retries must suppress duplicate provider posts");
  if (!serverSource.includes("PUBLISH_APPROVED_QUEUE") || !serverSource.includes("markQueuePublishProcessing") || !serverSource.includes('"retrying"')) throw new Error("live queue publishing must require explicit approval and durable retry states");
  if (!perUserMigrationSource.includes("publish_receipts") || !perUserMigrationSource.includes("scheduled_posts_worker_idx") || !serverSource.includes('"/publish_receipts?on_conflict=workspace_id,idempotency_key"')) throw new Error("publish queue and provider receipts must mirror to normalized Supabase rows");
  if (!serverSource.includes("publishIdempotencyKeys") || !perUserMigrationSource.includes("publish_idempotency_keys")) throw new Error("analytics snapshots must bind to exact publish idempotency keys");
  if (!serverSource.includes("function providerGrowthDeltas") || !serverSource.includes('metric.kind !== "live"') || !serverSource.includes("analytics.deltas = snapshot.deltas")) throw new Error("growth deltas must compare timestamped live-provider metrics only");
  if (!perUserMigrationSource.includes("notification_outbox") || !serverSource.includes("enqueueNotificationOutbox") || !serverSource.includes('url.pathname === "/api/notifications/outbox"')) throw new Error("security, approval, and publish alerts must use a durable notification outbox");
  if (!durableWorkerMigrationSource.includes("create table if not exists public.worker_jobs") || !durableWorkerMigrationSource.includes("for update of job skip locked") || !durableWorkerMigrationSource.includes("lease_expires_at") || !durableWorkerMigrationSource.includes("social_cues_finish_worker_job")) throw new Error("durable workers require atomic claims, expiring leases, and guarded completion");
  if (!durableWorkerMigrationSource.includes("partition by job.workspace_id") || !durableWorkerMigrationSource.includes("workspace_rank <= 2")) throw new Error("worker claims must preserve per-workspace fairness");
  if (!durableWorkerMigrationSource.includes("alter table public.worker_jobs enable row level security") || !durableWorkerMigrationSource.includes("revoke all on table public.worker_jobs from anon, authenticated") || !durableWorkerMigrationSource.includes("grant execute on function public.social_cues_claim_worker_jobs")) throw new Error("worker tables and claims must remain service-role only");
  for (const marker of ["discoverWorkerJobs", "claimWorkerJobs", "runDurableWorkerTick", "processScheduledPublishWorkerJob", "processProviderPublishStatusWorkerJob", "processTokenRefreshWorkerJob", "processNotificationWorkerJob"]) {
    if (!serverSource.includes(marker)) throw new Error(`durable worker implementation missing ${marker}`);
  }
  if (!serverSource.includes("AUTOMATIC_PUBLISHING_ENABLED") || !serverSource.includes("notificationEmailMaxAgeHours")) throw new Error("worker activation must gate live publishing and expire stale email");
  if (!serverSource.includes("tokenRefreshLeadByPlatformMinutes") || !serverSource.includes('status: "not_connected"') || !serverSource.includes('type: "provider-reconnect"')) throw new Error("proactive token renewal must use provider-specific windows and surface permanent reconnect requirements");
  if (!serverSource.includes("newestProviderCredentialEvidenceAt") || !serverSource.includes("account.credentialUpdatedAt, account.connectedAt")) throw new Error("normalized token persistence must prefer fresh OAuth connection evidence over stale token timestamps");
  if (!serverSource.includes("reconcileTerminalTokenRefreshJobs") || !serverSource.includes('status: "cancelled"') || !serverSource.includes("accountsDisconnected")) throw new Error("terminal token refresh jobs must reconcile stale normalized connection state");
  if (!serverSource.includes('const normalizedConnected = connectionState.connected || refreshable') || !serverSource.includes('!providerAccountConnectionState(account).needsReconnect')) throw new Error("normalized provider rows must not revive accounts carrying a reconnect failure");
  if (!serverSource.includes("async function refreshEtsyAccount") || !serverSource.includes('grant_type: "refresh_token"') || !serverSource.includes('etsy: refreshEtsyAccount')) throw new Error("Etsy access tokens must renew from the durable refresh grant");
  if (!/url\.pathname === "\/api\/oauth\/x\/callback"[\s\S]*?account\.credentialUpdatedAt = account\.connectedAt[\s\S]*?confirmPersistedProviderAccount\(owner, "x"/.test(serverSource)) throw new Error("X callback must timestamp and verify normalized token persistence");
  if (!/url\.pathname === "\/api\/oauth\/etsy\/callback"[\s\S]*?account\.credentialUpdatedAt = account\.connectedAt[\s\S]*?confirmPersistedProviderAccount\(owner, "etsy"/.test(serverSource)) throw new Error("Etsy callback must timestamp and verify normalized token persistence");
  if (!/url\.pathname === "\/api\/oauth\/youtube\/callback"[\s\S]*?credentialUpdatedAt: connectedAt[\s\S]*?confirmPersistedProviderAccount\(owner, account\.platform, account\.providerAccountId/.test(serverSource)) throw new Error("Google callback must timestamp and verify persistence for the actual YouTube or Business Profile asset");
  if (!renderWorkerSource.includes('p_kinds: ["media_render"]') || !renderWorkerSource.includes("runFfmpeg") || !renderWorkerSource.includes("render_heartbeat_failed") || !renderWorkerSource.includes("social_cues_finish_worker_job")) throw new Error("isolated renderer must claim only media work, heartbeat long renders, transcode without a shell, and settle durable jobs");
  if (!renderWorkerSource.includes("startWorkerRun") || !renderWorkerSource.includes("finishWorkerRun") || !renderWorkerSource.includes('trigger: "cloud-run-render"') || !renderWorkerSource.includes('kind: "media_render"')) throw new Error("isolated renderer must write durable run receipts for production observability");
  if (!renderWorkerDockerfile.includes("ffmpeg") || !renderWorkerDockerfile.includes("USER node")) throw new Error("render container must include FFmpeg and run without root privileges");
  for (const deploymentControl of ["secretmanager.googleapis.com", "cloudscheduler.googleapis.com", "Invoke-Gcloud run jobs deploy", "Invoke-Gcloud run jobs add-iam-policy-binding", "--set-secrets", "--max-retries=0"]) {
    if (!renderWorkerDeploySource.includes(deploymentControl)) throw new Error(`Cloud Run deployment control missing: ${deploymentControl}`);
  }
  if (!renderWorkerDeploySource.includes("MEDIA_RENDER_WORKER_CONFIGURED=false") || !renderWorkerDeploySource.includes("one uploaded source produces private completed outputs")) throw new Error("Cloud Run deployment must keep production renderer readiness false until a real private render passes");
  if (!serverSource.includes("createSignedSupabaseMediaUpload") || !serverSource.includes("/object/upload/sign/") || !serverSource.includes("/object/info/") || !serverSource.includes('url.pathname === "/api/media/assets/complete"')) throw new Error("private media intake must authorize and verify owner-bound Supabase uploads");
  if (!serverSource.includes('asset.status === "uploaded"') || !serverSource.includes('status: sourceUploadRequired ? "source-upload-required"') || !serverSource.includes('job.status = "queue-write-failed"')) throw new Error("render jobs must require a verified source and expose durable queue write failures");
  if (!appHtml.includes("uploadRawVideoTus") || !appHtml.includes('"Upload-Metadata"') || !appHtml.includes('"x-signature"') || !appHtml.includes("6 * 1024 * 1024") || !appHtml.includes("rawVideoUploadProgress") || !appHtml.includes("cancelRawVideoUpload")) throw new Error("raw video intake must expose resumable progress, retry recovery, and cancellation");
  if (!appHtml.includes("stripConsumedAuthCredentials") || !appHtml.includes('["verify", "token", "token_hash", "access_token", "refresh_token"]') || !/const oauthReturn = currentOAuthReturn\(\);\s+stripConsumedAuthCredentials\(\);/.test(appHtml)) throw new Error("consumed one-time authentication credentials must be removed from the app URL before session restoration");
  if (appHtml.includes("Storage path reserved; upload worker still needs the signed-upload pass.")) throw new Error("raw video intake must not claim that the implemented browser upload pass is still missing");
  if (!serverSource.includes('url.pathname === "/api/cron/workers"') || !serverSource.includes("workerRequestAuthorized") || !serverSource.includes('"Idempotency-Key"')) throw new Error("worker trigger must be secret-authenticated and provider deliveries idempotent");
  if (!serverSource.includes("uploadType=resumable") || !serverSource.includes('duplex: "half"') || !serverSource.includes("uploadYouTubeHostedVideo")) throw new Error("scheduled YouTube uploads must stream through the resumable protocol instead of buffering whole videos");
  for (const status of ["PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD", "SEND_TO_USER_INBOX", "PUBLISH_COMPLETE", "FAILED"]) {
    if (!serverSource.includes(`"${status}"`)) throw new Error(`TikTok durable status worker missing ${status}`);
  }
  if (!serverSource.includes('url.pathname === "/api/media/editor/render-output"') || !appHtml.includes("data-render-output-job") || !appHtml.includes("openRenderedOutput")) throw new Error("completed private render outputs must be available through short-lived signed links");
  if (!vercelConfigSource.includes('"schedule": "* * * * *"') || !vercelConfigSource.includes('"path": "/api/cron/workers"') || !vercelConfigSource.includes('"maxDuration": 300')) throw new Error("Vercel must invoke the bounded durable dispatcher every minute with enough provider-processing time");
  for (const route of ["/api/auth/mfa/status", "/api/auth/mfa/enroll", "/api/auth/mfa/challenge", "/api/auth/mfa/verify", "/api/auth/mfa/unenroll"]) {
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`MFA route missing: ${route}`);
  }
  if (!appHtml.includes('id="mfaStatus"') || !appHtml.includes("refreshMfaStatus") || !appHtml.includes("verifyMfa")) throw new Error("Settings must expose optional authenticator enrollment and verification controls");
  for (const route of ["/api/workspace/members", "/api/workspace/invites", "/api/workspace/invites/accept", "/api/workspace/invites/revoke"]) {
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`Workspace membership route missing: ${route}`);
  }
  if (!perUserMigrationSource.includes("workspace_invites") || !serverSource.includes("token_hash: hashSecret(inviteToken)")) throw new Error("workspace invitations must be expiring, hashed, and server-owned");
  if (!serverSource.includes("acceptWorkspaceInvite") || !serverSource.includes('pageParams.get("invite")')) throw new Error("portal must accept a workspace invitation after the invited user signs in");
  if (!serverSource.includes('res.setHeader("X-Request-ID"') || !serverSource.includes('"http_request_completed"') || !serverSource.includes('"unhandled_request_error"')) throw new Error("production requests must expose correlation IDs and structured diagnostics");
  if (!serverSource.includes('const sensitiveKeys = ["verify", "token", "token_hash", "access_token", "refresh_token"]') || !serverSource.includes('credentialUrlCleanup: ui.includes("function stripConsumedAuthCredentials")') || !serverSource.includes('crypto.createHash("sha256").update(ui)')) throw new Error("locked app credentials and deployed app-shell identity must be observable without exposing source or secrets");
  if (!serverSource.includes("function scheduledVariantLedgerItems") || !serverSource.includes('variantStatus === "blocked"') || !serverSource.includes("recoveredFromVariantEvidence") || !serverSource.includes('["queued", "scheduled", "queued-review-only", "retrying"].includes(item.status)') || !serverSource.includes("terminalPublishHistory: true")) throw new Error("normalized publishing history must preserve real terminal evidence without counting completed posts as due");
  if (!serverSource.includes("function normalizedProviderCleanupKey") || !serverSource.includes("function normalizedStoredConnectionStatus") || !serverSource.includes("connectedIdsByPlatform") || !serverSource.includes("genericIdentity") || !serverSource.includes('normalizedStoredConnectionStatus(row.status) === "connected"') || !serverSource.includes("canonicalIds.has(providerAccountId)") || !serverSource.includes("canonicalProviderStateCleanup: true")) throw new Error("normalized provider cleanup must remove only stale disconnected duplicates or generic identities after a verified connection exists");
  if (!serverSource.includes("localModelSaveQueue.then(save, save)") || !serverSource.includes("renameLocalModelWithRetry")) throw new Error("local atomic model writes must serialize and retry transient Windows locks");
  if (!serverSource.includes('url.pathname === "/api/billing/portal"') || !serverSource.includes("createStripeCustomerPortalSession")) throw new Error("Stripe Customer Portal route missing");
  if (!serviceWorkerSource.includes('url.pathname.startsWith("/api/")') || !serviceWorkerSource.includes('event.request.mode === "navigate"')) throw new Error("service worker must keep APIs and private navigations network-only");
  if (!serverSource.includes("function providerExpiryAlertsForUser") || !serverSource.includes("token expires soon")) throw new Error("provider expiry alerts must warn users before token-backed lanes fail");
  if (!serverSource.includes("function accountMatchesMetaSignedRequest") || !serverSource.includes("metaSignedRequestUserId(payload)") || /for \(const account of model\.connectedAccounts\) \{\s*if \(\[\"meta\", \"facebook\", \"instagram\"\]\.includes\(account\.platform\) \|\| account\.oauthProvider === \"meta\"\)/.test(serverSource)) throw new Error("Meta data deletion/deauthorization must target only the signed-request user and owned Meta assets");
  for (const envName of ["PINTEREST_APP_ID", "CANVA_CLIENT_ID", "GOOGLE_CLIENT_ID", "SHOPIFY_CLIENT_ID", "ETSY_CLIENT_SECRET", "TWITCH_CLIENT_SECRET"]) {
    if (!serverSource.includes(envName) || !serverSource.includes("acceptedEnv: envAcceptedMap")) throw new Error("OAuth status endpoints should expose missing env names and accepted aliases");
  }
  if ((serverSource.match(/providerId === "discord"/g) || []).length !== 1) throw new Error("Discord live probe should have one canonical implementation");
  if (!packageSource.includes("vercel:env:audit") || !packageSource.includes("vercel:env:sync")) throw new Error("Vercel env sync scripts missing from package.json");
  if (!envSyncSource.includes("Secret values are never printed.") || !envSyncSource.includes("defaultTargets") || !envSyncSource.includes("MISSING_LOCAL") || !envSyncSource.includes("WOULD_ADD") || !envSyncSource.includes("ADDED")) throw new Error("Vercel env sync script should be dry-run safe and name-only");
  if (!envSyncSource.includes("ETSY_CLIENT_SECRET") || !envSyncSource.includes("LINKEDIN_CLIENT_SECRET") || !envSyncSource.includes("DISCORD_CLIENT_ID") || !envSyncSource.includes("CANVA_CLIENT_SECRET")) throw new Error("Vercel env sync script missing prioritized provider targets");
  if (!productionEnvAudit.includes("npm run vercel:env:audit") || !productionEnvAudit.includes("npm run vercel:env:sync -- --apply --names ETSY_CLIENT_SECRET")) throw new Error("production env audit missing safe sync loop");
  for (const route of ["/api/twitch/clips", "/api/twitch/videos", "/api/twitch/stream", "/api/twitch/schedule", "/api/twitch/followers"]) {
    if (!appHtml.includes(route)) throw new Error(`Twitch expansion route missing from function suite: ${route}`);
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`Twitch expansion route missing backend handler: ${route}`);
  }
  if (!serverSource.includes("requireTwitchAccountForRead") || !serverSource.includes('twitchApi("/videos"') || !serverSource.includes('twitchApi("/streams"') || !serverSource.includes('twitchApi("/schedule"') || !serverSource.includes('twitchApi("/channels/followers"')) throw new Error("Twitch expansion should use Helix read routes behind the connected account gate");
  if (!/url\.pathname === "\/api\/oauth\/twitch\/status"[\s\S]*?account: account \? publicAccount\(account\) : null/.test(serverSource)) throw new Error("Twitch OAuth status must include signed-in account evidence after a successful handshake");
  if (!/url\.pathname === "\/api\/oauth\/twitch\/callback"[\s\S]*?modelForSession\(\{ user: owner \}, sharedModel\)/.test(serverSource)) throw new Error("Twitch callback must save connected account evidence into the signed-in user workspace");
  if (!serverSource.includes('repairConnectedOAuthAccount(account, "twitch")')) throw new Error("Twitch status/read routes should repair token-backed handshake evidence when the status flag is stale");
  if (/function renewOAuthReturnSession[\s\S]*?!hasActiveAppAccess\(owner\)/.test(serverSource)) throw new Error("OAuth return session renewal must not depend on active paid access; app access is enforced separately");
  if (!appHtml.includes("source.twitchStatus?.account")) throw new Error("Twitch readiness account evidence is not merged into the app account list");
  if (!appHtml.includes("source.twitchAccount")) throw new Error("Twitch OAuth account evidence should be merged as a first-class provider identity");
  if (!appHtml.includes("customerAccountPlatformIds") || !appHtml.includes('"pinterest", "canva", "shopify", "etsy", "linkedin", "patreon", "twitch", "discord"')) throw new Error("customer account platform list should include real user identities such as LinkedIn, Patreon, Twitch, and Discord");
  if (!appHtml.includes('platformIdentityHeading(platform, headingAccount)') || !appHtml.includes('Accounts and posting identities')) throw new Error("provider cards should label each platform with its posting identity without duplicate identity sections");
  if (!appHtml.includes('if (key === "twitch") return { twitchAccount: data.account || null, twitchStatus: data };')) throw new Error("Twitch OAuth return should patch twitchAccount instead of only generic readiness state");
  if (!appHtml.includes('twitchStatus.connectionState === "needs-reconnect"') || !appHtml.includes("const twitchAccount = twitchStatus.connected === false || twitchStatus.refreshError")) throw new Error("Twitch card should let live token validation failures override stale local account evidence");
  if (!appHtml.includes("connectionState === \"stored-but-incomplete\"")) throw new Error("Twitch card should explain stored-but-incomplete handshakes instead of showing contradictory status");
  if (!appHtml.includes("/api/canva/folder-items") || !appHtml.includes("/api/canva/user") || !appHtml.includes("/api/canva/brand-templates") || !appHtml.includes("canvaLaneTags") || !serverSource.includes("function canvaCapabilityLanes") || !serverSource.includes("function canvaPortalReadiness") || !serverSource.includes('url.pathname === "/api/canva/folder-items"')) throw new Error("Canva Connect should expose creative capability lanes and user/folder/template checks");
  if (!serverSource.includes("wouldCreateCreativeHandoff") || !serverSource.includes('provider: "canva", dryRun: true')) throw new Error("Canva publish proof should build a creative handoff payload without live mutation");
  for (const route of ["/api/pinterest/user", "/api/pinterest/pins", "/api/pinterest/analytics", "/api/pinterest/ads/readiness"]) {
    if (!appHtml.includes(route)) throw new Error(`Pinterest expansion route missing from function suite: ${route}`);
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`Pinterest expansion route missing backend handler: ${route}`);
  }
  if (!serverSource.includes("function pinterestCapabilityLanes") || !serverSource.includes("trialRateLimit") || !serverSource.includes("1000/day shown in Pinterest Developers")) throw new Error("Pinterest should expose the portal-backed trial capability contract");
  if (!serverSource.includes("wouldCreatePin") || !serverSource.includes('provider: "pinterest", dryRun: true')) throw new Error("Pinterest publish proof should build a safe Pin draft payload without live mutation");
  if (!appHtml.includes("/api/etsy/receipts") || !serverSource.includes('url.pathname === "/api/etsy/receipts"') || !serverSource.includes("function etsyCapabilityLanes") || !serverSource.includes('"transactions_r"')) throw new Error("Etsy sales/receipt lane should be visible and gated by transactions_r");
  if (!serverSource.includes("wouldCreateListingDraft") || !serverSource.includes('provider: "etsy", dryRun: true')) throw new Error("Etsy publish proof should build a draft listing payload without live mutation");
  if (!serverSource.includes("Personal Access") || !serverSource.includes("5 QPS / 5K QPD") || !serverSource.includes("webhook portal")) throw new Error("Etsy portal audit should reflect the actual existing personal app and rate-limit controls");
  if (!serverSource.includes('url.pathname === "/api/oauth/linkedin/start"') || !serverSource.includes('url.pathname === "/api/oauth/linkedin/callback"') || !serverSource.includes('url.pathname === "/api/linkedin/readiness"')) throw new Error("LinkedIn OAuth and readiness routes are incomplete");
  if (!serverSource.includes('const linkedInScopes = envScopeList("LINKEDIN_OAUTH_SCOPES", linkedInOidcProductGranted ? linkedInIdentityScopes : [])') || !serverSource.includes('"Linkedin-Version": linkedInApiVersion') || !serverSource.includes('"X-Restli-Protocol-Version": "2.0.0"')) throw new Error("LinkedIn must request only Product-approved scopes and version every REST API request");
  if (!serverSource.includes('linkedInApi("/organizationAcls"') || !serverSource.includes('linkedInApi("/posts"') || !serverSource.includes("Development tier does not support BATCH_GET")) throw new Error("LinkedIn Company Page discovery and modern Posts API adapter are incomplete");
  for (const route of ["/api/linkedin/posts", "/api/linkedin/comments", "/api/linkedin/analytics", "/api/linkedin/webhook/readiness", "/api/linkedin/webhook"]) {
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`LinkedIn capability route missing backend handler: ${route}`);
    if (route !== "/api/linkedin/webhook" && !appHtml.includes(route)) throw new Error(`LinkedIn capability route missing customer surface: ${route}`);
  }
  if (!serverSource.includes('"/organizationalEntityFollowerStatistics"') || !serverSource.includes('"/organizationPageStatistics"') || !serverSource.includes('"/organizationalEntityShareStatistics"')) throw new Error("LinkedIn follower, Page, and share statistics are incomplete");
  if (!serverSource.includes("validLinkedInWebhookSignature") || !serverSource.includes('req.headers["x-li-signature"]') || !serverSource.includes('claimDurableWebhookEvent("linkedin"') || !serverSource.includes("notificationId")) throw new Error("LinkedIn webhook validation, signature verification, or deduplication is incomplete");
  if (!serverSource.includes('requiredTier: "standard"') || !serverSource.includes("LinkedIn disables social-action push notifications")) throw new Error("LinkedIn UI must distinguish Development features from Standard-tier webhooks");
  if (!appHtml.includes("LinkedIn Company comments") || !appHtml.includes("linkedinAnalyticsLive") || !appHtml.includes("LinkedIn Company intelligence")) throw new Error("LinkedIn comments and analytics must be visible in customer response and growth surfaces");
  if (!serverSource.includes('{ opaque: true }') || !serverSource.includes('allowSignedRecovery: false, requireSessionOwner: true')) throw new Error("LinkedIn OAuth must use one-time opaque state bound to the active Social Cues session");
  if (!serverSource.includes('if (!normalized.includes("rw_organization_admin")) return [];') || !serverSource.includes('pageNumber < 20') || !serverSource.includes('DIRECT_SPONSORED_CONTENT_POSTER')) throw new Error("LinkedIn Company Page discovery must be paginated and preserve provider Page roles");
  if (/requiredScopes: \["w_organization_social", "w_organization_social_feed"\]/.test(serverSource) || !serverSource.includes('requiredScopes: ["w_organization_social"]')) throw new Error("LinkedIn Posts API must not treat feed scopes as post-creation permission");
  if (!serverSource.includes('providerGrantVerified') || !appHtml.includes('requested scopes configured - unverified') || !appHtml.includes('not publish-ready')) throw new Error("LinkedIn UI must distinguish requested scopes, provider grants, connection identity, and publishing readiness");
  if (!serverSource.includes('provider: "linkedin"') || !serverSource.includes('category: "professional-authority"')) throw new Error("LinkedIn depth contract should be represented in the platform capability inventory");
  if (!appHtml.includes('id: "linkedin"') || !appHtml.includes("OpenID Product pending") || !appHtml.includes("Company management optional / pending")) throw new Error("LinkedIn customer UI must separate member OpenID login from optional Company Management gates");
  if (!appHtml.includes("function applyConnectorStatusToUi(route, data)") || !appHtml.includes('"/api/linkedin/readiness": "linkedinStatus"')) throw new Error("Provider status refreshes must update the visible LinkedIn account card state");
  if (!serverSource.includes('"member-login-ready"') || !serverSource.includes("Connect and verify the member identity now; request Community Management Development Tier separately")) throw new Error("LinkedIn capability depth must keep approved member login separate from Company Management review");
  if (!serverSource.includes('url.pathname === "/api/oauth/patreon/start"') || !serverSource.includes('url.pathname === "/api/oauth/patreon/callback"') || !serverSource.includes('url.pathname === "/api/patreon/readiness"')) throw new Error("Patreon OAuth and readiness routes are incomplete");
  if (!serverSource.includes("function patreonTokenError") || !serverSource.includes('"token_exchange_http_error"') || !serverSource.includes("responseText ? JSON.parse(responseText)")) throw new Error("Patreon token exchange must preserve structured provider diagnostics without logging OAuth credentials");
  if (!serverSource.includes('redirectMatchesConfigured: redirectUri === patreonRedirectUri()')) throw new Error("Patreon token diagnostics must verify the exchange callback exactly matches the configured callback");
  if (serverSource.includes("avatar_photo_url") || !serverSource.includes("image_small_url")) throw new Error("Patreon campaign field requests must stay within the current API v2 Campaign schema");
  if (!serverSource.includes('"token_exchange_http_success"') || !serverSource.includes("Patreon connection failed:")) throw new Error("Patreon callback must distinguish a successful token exchange from downstream campaign hydration failures");
  for (const obsoletePatreonPostField of ["thumbnail_url", "post_type", "comment_count", "like_count", "excerpt"]) {
    if (serverSource.includes(`\"fields[post]\": \"title,content,${obsoletePatreonPostField}`) || /fields\[post\][^\n]*\b(thumbnail_url|post_type|comment_count|like_count|excerpt)\b/.test(serverSource)) throw new Error(`Patreon Post v2 request includes obsolete field: ${obsoletePatreonPostField}`);
  }
  if (!serverSource.includes('"User-Agent": "Social Cues App - Audience Intelligence"') || !serverSource.includes('"api_http_error"')) throw new Error("Patreon API requests need the documented identifying User-Agent and sanitized HTTP diagnostics");
  for (const route of ["/api/patreon/identity", "/api/patreon/campaigns", "/api/patreon/members", "/api/patreon/posts", "/api/patreon/webhook/readiness", "/api/patreon/webhook"]) {
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`Patreon capability route missing backend handler: ${route}`);
    if (route !== "/api/patreon/webhook" && !appHtml.includes(route)) throw new Error(`Patreon capability route missing customer surface: ${route}`);
  }
  if (!serverSource.includes("validPatreonWebhookSignature") || !serverSource.includes('req.headers["x-patreon-signature"]') || !serverSource.includes('claimDurableWebhookEvent("patreon"')) throw new Error("Patreon webhook validation and deduplication are incomplete");
  if (!/externalSignedPostPaths[\s\S]*?"\/api\/patreon\/webhook"[\s\S]*?"\/api\/linkedin\/webhook"/.test(serverSource)) throw new Error("Signed Patreon and LinkedIn webhook POSTs must reach their signature validators without disabling same-origin protection elsewhere");
  if (!serverSource.includes('"campaigns.members[email]"') || !serverSource.includes('"campaigns.members.address"') || !appHtml.includes("without requesting member email or mailing addresses")) throw new Error("Patreon must keep sensitive member contact scopes outside the default audience-intelligence lane");
  if (!envSyncSource.includes("LINKEDIN_OIDC_PRODUCT_GRANTED") || !envSyncSource.includes("PATREON_CLIENT_ID") || !envSyncSource.includes("PATREON_WEBHOOK_SECRET")) throw new Error("LinkedIn OpenID and Patreon runtime settings must be included in the safe Vercel env sync");
  for (const provider of ["tiktok", "pinterest", "etsy", "linkedin", "patreon", "shopify", "canva", "youtube", "discord"]) {
    const callbackPattern = new RegExp(`url\\.pathname === "\\/api\\/oauth\\/${provider}\\/callback"[\\s\\S]*?modelForSession\\(\\{ user: owner \\}, sharedModel\\)[\\s\\S]*?renewOAuthReturnSession\\(res, sharedModel, model, owner`);
    if (!callbackPattern.test(serverSource)) throw new Error(`${provider} callback must save connected account evidence into the signed-in user workspace and renew the app session from shared state`);
  }
  for (const provider of ["tiktok", "pinterest", "canva", "youtube", "shopify", "etsy", "patreon", "twitch", "discord"]) {
    const statusPattern = new RegExp(`url\\.pathname === "\\/api\\/oauth\\/${provider}\\/status"[\\s\\S]*?account: account \\? publicAccount\\(account\\) : null`);
    if (!statusPattern.test(serverSource)) throw new Error(`${provider} OAuth status must include signed-in account evidence after a successful handshake`);
  }
  for (const marker of ["source.tiktokStatus?.account", "source.youtubeStatus?.account", "source.pinterestStatus?.account", "source.canvaStatus?.account", "source.shopifyStatus?.account", "source.etsyStatus?.account"]) {
    if (!appHtml.includes(marker)) throw new Error(`provider evidence merge missing ${marker}`);
  }
  if (!serverSource.includes("function buildProviderAssetMap") || !serverSource.includes('url.pathname === "/api/provider/asset-map"')) throw new Error("Provider asset map should expose one backend source for posting identity versus login identity");
  if (!serverSource.includes("providerPostingIdentityName") || !serverSource.includes("providerEndUserSetupNote")) throw new Error("Provider asset map should include posting names and user-facing setup guidance");
  if (!appHtml.includes('authedFetch("/api/provider/asset-map")') || !appHtml.includes("function renderProviderAssetMapCards") || !appHtml.includes('id="adminProviderDiagnostics"') || !appHtml.includes("Posting identity map")) throw new Error("owner Admin diagnostics should render the provider asset map outside the customer Accounts surface");
  if (!appHtml.includes("function providerPostingIdentityName") || !appHtml.includes("function providerAssetMapRow") || !appHtml.includes("looksLikeAccountEmail") || !appHtml.includes("const identity = providerPostingIdentityName(platform || account?.platform, account)")) throw new Error("provider cards should show the posting asset/profile name beside the parent provider instead of login email");
  if (!appHtml.includes("sameTruthAsset") || !appHtml.includes("truthAccount?.connectionState || truth?.connectionState")) throw new Error("provider account selector labels must prefer exact asset truth before provider-wide state");
  if (!appHtml.includes("account.providerAccountId && hasStoredToken(account)")) throw new Error("posting identity selectors must hide tokenless stale account rows");
  if (!/function renderProviderAssetMapCards[\s\S]*?row\.connected \|\| row\.gates\?\.tokenStored \? "Reconnect" : "Connect"/.test(appHtml)) throw new Error("refreshable provider assets must offer reconnect instead of a misleading first-time connect action");
  if (!serverSource.includes("function providerPermissionGapExplainer") || !serverSource.includes('url.pathname === "/api/provider/permission-gaps"') || !serverSource.includes("providerPermissionGapReportFromAssetMap")) throw new Error("provider permission gap explainer should expose plain-language provider blockers");
  if (!appHtml.includes("function providerPermissionExplainer") || !appHtml.includes("function renderPermissionExplainerNotice") || !appHtml.includes("gap: ${explainer.severity}")) throw new Error("Admin diagnostics should retain plain-language provider permission gap explanations");
  if (!serverSource.includes("function clearProviderWorkspaceCache") || !serverSource.includes("clearProviderWorkspaceCache(model, session?.user || null, platform)") || !appHtml.includes("function clearProviderCacheLocally") || !appHtml.includes("Server cache cleared too")) throw new Error("provider on/off toggles should clear local and server cached provider data with a warning");
  if (!serverSource.includes("function recordOAuthEvent") || !serverSource.includes('url.pathname === "/api/oauth/debug-log"')) throw new Error("OAuth debugger should persist redacted provider OAuth events behind a dedicated endpoint");
  if (!serverSource.includes("callback_received") || !serverSource.includes("state_validation") || !serverSource.includes("token_exchange_result")) throw new Error("OAuth debugger should track callback, state, and token exchange events");
  if (!appHtml.includes('authedFetch("/api/oauth/debug-log")') || !appHtml.includes("function renderOAuthDebugLogCards") || !appHtml.includes("OAuth debug log")) throw new Error("Admin diagnostics should render the OAuth debug log without raw secrets");
  for (const route of ["/api/discord/user", "/api/discord/guilds", "/api/discord/channels", "/api/discord/interactions/readiness", "/api/discord/webhook-events/readiness", "/api/discord/webhook-events", "/api/discord/bot/readiness", "/api/discord/commands/readiness", "/api/discord/commands", "/api/discord/commands/register", "/api/discord/verification-preflight", "/api/discord/community/select", "/api/discord/messages", "/api/discord/messages/reply", "/api/discord/messages/moderate", "/api/discord/announcement"]) {
    if (!appHtml.includes(route)) throw new Error(`Discord expansion route missing from function suite: ${route}`);
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`Discord expansion route missing backend handler: ${route}`);
  }
  if (!serverSource.includes('"/api/discord/interactions"') || !serverSource.includes("verifyDiscordInteractionSignature") || !serverSource.includes("DISCORD_PUBLIC_KEY") || !serverSource.includes("x-signature-ed25519")) throw new Error("Discord interactions endpoint must verify signed Discord requests");
  if (!serverSource.includes('"/api/discord/webhook-events"') || !serverSource.includes("APPLICATION_DEAUTHORIZED") || !serverSource.includes("claimDurableWebhookEvent(\"discord\"") || !serverSource.includes("clearDiscordAccountCredentials")) throw new Error("Discord webhook events should verify, deduplicate, and synchronize authorization lifecycle changes");
  if (!/externalSignedPostPaths[\s\S]*?"\/api\/discord\/webhook-events"/.test(serverSource)) throw new Error("Discord signed webhook events must bypass browser-origin checks and rely on Ed25519 verification");
  if (!serverSource.includes("function discordVerificationPreflight") || !appHtml.includes("Discord pre-verification console") || !appHtml.includes("verify locked")) throw new Error("Discord should expose a pre-verification console that keeps verification last");
  if (!serverSource.includes('method: "PUT", authScheme: "Bot"') || !serverSource.includes('confirm === "REGISTER_DISCORD_COMMANDS"')) throw new Error("Discord command registration should use explicit live approval and bulk overwrite semantics");
  if (!serverSource.includes('name: "Send to Social Cues"') || !serverSource.includes('name: "Community profile"')) throw new Error("Discord should expose message and member context commands alongside /cue");
  if (!serverSource.includes("requireDiscordAccountForRead") || !serverSource.includes('discordApi("/users/@me"') || !serverSource.includes('discordApi("/users/@me/guilds"') || !serverSource.includes('authScheme: "Bot"')) throw new Error("Discord expansion should use OAuth and bot-gated API routes behind the connected account gate");
  if (!serverSource.includes("function discordSavedTarget") || !serverSource.includes("function authorizedDiscordGuild") || !serverSource.includes("discordGuildAuthority")) throw new Error("Discord customer actions must bind to the workspace's saved authorized server and channel");
  if (!serverSource.includes("function requireProviderOperator") || !serverSource.includes("Only the Social Cues owner can register application commands")) throw new Error("Discord application-level diagnostics and command registration must be operator-only in production");
  if (!serverSource.includes("function existingDiscordActionReceipt") || !serverSource.includes("function recordDiscordActionReceipt") || !serverSource.includes('req.headers["idempotency-key"]')) throw new Error("Discord direct writes need durable idempotency receipts");
  if (!/url\.pathname === "\/api\/discord\/announcement"[\s\S]*?allowed_mentions:\s*\{ parse: \[\] \}/.test(serverSource)) throw new Error("Discord announcements must suppress mass mentions");
  if (!serverSource.includes('item.variant.platform === "discord"') || !serverSource.includes('provider: "discord",\n        dryRun: false')) throw new Error("Discord capability truth requires a native queued announcement adapter");
  if (serverSource.includes("Message captured for the Social Cues community response workflow") || serverSource.includes("Community profile handoff created")) throw new Error("Discord context commands must not claim durable capture before a workspace mapping exists");
  if (!serverSource.includes("escapeHtml(error)") || !serverSource.includes("escapeHtml(stateCheck.error)")) throw new Error("Discord callback errors must be HTML escaped");
  if (!appHtml.includes("data-discord-save-target") || !appHtml.includes("data-discord-message-reply") || !appHtml.includes("data-discord-message-moderate")) throw new Error("Discord community target, reply, and moderation controls should be present in Responses");
  if (!/url\.pathname === "\/api\/oauth\/discord\/callback"[\s\S]*?modelForSession\(\{ user: owner \}, sharedModel\)/.test(serverSource)) throw new Error("Discord callback must save connected account evidence into the signed-in user workspace");
  if (!/url\.pathname === "\/api\/oauth\/discord\/status"[\s\S]*?account: account \? publicAccount\(account\) : null/.test(serverSource)) throw new Error("Discord OAuth status must include signed-in account evidence after a successful handshake");
  if (!appHtml.includes("source.discordStatus?.account")) throw new Error("Discord readiness account evidence is not merged into the app account list");
  if (!appHtml.includes("function acceptedEnvTags") || !appHtml.includes("${name} accepts") || !appHtml.includes("acceptedEnvTags(service") || !appHtml.includes("acceptedEnvTags(backendService(\"pinterest\")")) throw new Error("provider UI should expose accepted env aliases for missing production credentials");
  if (!appHtml.includes("Production credential unlocks") || !appHtml.includes("credentialUnlocks") || !serverSource.includes('url.pathname === "/api/provider/credential-unlocks"') || !serverSource.includes("function serviceCredentialUnlocks")) throw new Error("provider credential unlock queue missing");
  if (!serverSource.includes("Next provider unlock") || !serverSource.includes("integrations.nextCredentialUnlock") || !serverSource.includes("acceptedNames")) throw new Error("portal credential unlock alert missing");
  if (!appHtml.includes("/api/provider/setup-fields") || !serverSource.includes("function providerSetupFields") || !serverSource.includes('url.pathname === "/api/provider/setup-fields"')) throw new Error("provider setup field contract route/UI hook missing");
  if (!appHtml.includes("Provider setup contracts") || !appHtml.includes("metaState.setupFields") || !appHtml.includes("setupFieldsResponse") || !appHtml.includes("Refresh setup fields")) throw new Error("provider setup field contracts should be loaded and visible in Admin");
  if (!appHtml.includes('data-copy-text="${escapeHtml(item.callbackUrl)}"') || !appHtml.includes('data-external-route="${escapeHtml(item.portalRoute)}"') || !appHtml.includes('data-function-check-route="${escapeHtml(item.statusRoute)}"')) throw new Error("provider setup contracts should expose copy, portal, and status controls");
  if (!serverSource.includes("User data deletion URL") || !serverSource.includes("OAuth redirect/callback URL") || !serverSource.includes("Connect integration redirect URI")) throw new Error("provider setup fields should include dashboard-ready callback and platform fields");
  if (!appHtml.includes("Provider contracts") || !appHtml.includes("/api/provider/contracts") || !serverSource.includes("function providerContracts") || !serverSource.includes('url.pathname === "/api/provider/contracts"')) throw new Error("provider contract ownership surface missing");
  if (!serverSource.includes("nextContractActions") || !serverSource.includes("providerContracts:")) throw new Error("integration readiness should include provider contract actions");
  if (!appHtml.includes('data-provider-contract-check="${escapeHtml(item.id)}"') || !appHtml.includes("runProviderContractCheck") || !serverSource.includes('url.pathname === "/api/provider/contract-check"')) throw new Error("provider contract check route/UI hook missing");
  if (!appHtml.includes('data-provider-action-check="${escapeHtml(item.id)}"') || !appHtml.includes('data-provider-publish-check="${escapeHtml(item.id)}"') || !appHtml.includes('data-external-route="${escapeHtml(item.portalRoute)}"')) throw new Error("provider contract actions should expose read, publish, connect, setup, and portal controls");
  if (!appHtml.includes('id="runDailyLoop"') || !appHtml.includes("runDailyOwnershipLoop") || !serverSource.includes('url.pathname === "/api/provider/daily-loop"') || !serverSource.includes("runDailyProviderOwnershipLoop")) throw new Error("daily provider ownership loop route/UI hook missing");
  if (!appHtml.includes("Daily ownership loop") || !appHtml.includes("/api/provider/daily-loop/status") || !serverSource.includes("function dailyProviderLoopStatus") || !serverSource.includes('url.pathname === "/api/provider/daily-loop/status"')) throw new Error("daily provider ownership loop status surface missing");
  if (!appHtml.includes("Provider state ledger") || !appHtml.includes("/api/provider/state") || !serverSource.includes("function buildProviderStateSnapshot") || !serverSource.includes('url.pathname === "/api/provider/state"')) throw new Error("provider state ledger route/UI hook missing");
  if (!appHtml.includes("Publish queue ledger") || !appHtml.includes("/api/publish/queue") || !serverSource.includes("function publishQueueLedger") || !serverSource.includes('url.pathname === "/api/publish/queue"')) throw new Error("publish queue ledger route/UI hook missing");
  if (!appHtml.includes("Analytics snapshot bank") || !appHtml.includes("/api/analytics/snapshots") || !serverSource.includes("function bankAnalyticsSnapshot") || !serverSource.includes('url.pathname === "/api/analytics/snapshots"')) throw new Error("analytics snapshot bank route/UI hook missing");
  if (!appHtml.includes("/api/x/me") || !appHtml.includes("Post dry-run")) throw new Error("X function suite should expose identity proof and dry-run posting checks");
  if (!serverSource.includes('url.pathname === "/api/x/me"') || !serverSource.includes("requireXAccountForRead") || !serverSource.includes('xApi("/users/me"')) throw new Error("X identity proof should use /users/me behind the connected account gate");
  if (!appHtml.includes("connected / read ready") || !appHtml.includes("write upgrade available") || !appHtml.includes("read-first OAuth lane")) throw new Error("X GUI should separate read-first login from write-permission upgrade");
  if (!/url\.pathname === "\/api\/oauth\/x\/callback"[\s\S]*?modelForSession\(\{ user: owner \}, sharedModel\)/.test(serverSource)) throw new Error("X callback must save connected account evidence into the signed-in user workspace");
  if (!/url\.pathname === "\/api\/oauth\/x\/status"[\s\S]*?account: account \? publicAccount\(account\) : null/.test(serverSource)) throw new Error("X OAuth status must include signed-in account evidence after a successful handshake");
  if (!/url\.pathname === "\/api\/oauth\/meta\/callback"[\s\S]*?modelForSession\(\{ user: owner \}, sharedModel\)/.test(serverSource)) throw new Error("Meta callback must save connected account evidence into the signed-in user workspace");
  if (!/url\.pathname === "\/api\/oauth\/meta\/status"[\s\S]*?account: account \? publicMetaAccount\(account\) : null/.test(serverSource)) throw new Error("Meta OAuth status must include signed-in account evidence after a successful handshake");
  if (!/url\.pathname === "\/api\/oauth\/threads\/callback"[\s\S]*?modelForSession\(\{ user: owner \}, sharedModel\)/.test(serverSource)) throw new Error("Threads callback must save connected account evidence into the signed-in user workspace");
  if (!/function confirmPersistedProviderAccount[\s\S]*?\/connected_accounts\?[\s\S]*?\/provider_tokens\?/.test(serverSource) || !serverSource.includes("select=connected_account_id,encrypted_token,token_type")) throw new Error("OAuth persistence confirmation must verify the normalized provider identity and encrypted token rows directly");
  if (!serverSource.includes("!persistenceCheck.ok && !persistenceCheck.pending") || !serverSource.includes("Threads connected; secure storage verification is still syncing.")) throw new Error("Threads callback must not mislabel a verified token exchange as failed while normalized storage is still syncing");
  if (!serverSource.includes('title: exchangeSucceeded ? "Threads connected" : "Threads secure storage failed"')) throw new Error("Threads callback must distinguish token exchange success from secure storage verification failure");
  if (!/url\.pathname === "\/api\/oauth\/threads\/status"[\s\S]*?account: account \? publicAccount\(account\) : null/.test(serverSource)) throw new Error("Threads OAuth status must include signed-in account evidence after a successful handshake");
  if (!serverSource.includes("isVerifiedThreadsProviderAccountId") || !serverSource.includes("verifyThreadsAccountIdentity") || !serverSource.includes("applyVerifiedThreadsProfile")) throw new Error("Threads must replace placeholder identities with live /me provider evidence");
  if (!serverSource.includes("requestedScopes: threadsScopes") || !serverSource.includes("grantedScopes") || !serverSource.includes("tokenHealth: threadsTokenHealth")) throw new Error("Threads status must separate requested scopes, granted evidence, and token expiry health");
  if (!serverSource.includes("account.scopes = token.scopes") || serverSource.includes("account.scopes = threadsScopes")) throw new Error("Threads callback must persist provider-returned grant evidence, not every requested permission");
  if (!serverSource.includes('scopes: [...new Set([\"threads_basic\", ...returnedScopes])]')) throw new Error("Threads exchange should only infer threads_basic from a successful /me call");
  if (!serverSource.includes('if (runtimeMode !== \"vercel\") session.token = token') || serverSource.includes("rememberedDeviceFallback")) throw new Error("hosted auth must keep session tokens in HttpOnly cookies and fail closed when Supabase cannot refresh");
  if (!serverSource.includes("lastAttempt: lastAttempt ? publicAccount(lastAttempt) : null") || !serverSource.includes('status: exchangeSucceeded ? "connected" : "error"')) throw new Error("Threads OAuth should expose failed token exchange evidence without reporting a false connected return");
  if (!serverSource.includes("function requireThreadsAccountForRead") || !serverSource.includes("function grantedThreadsScopes") || !serverSource.includes('useCaseId.startsWith("threads") ? grantedThreadsScopes(model) : grantedMetaScopes(model)')) throw new Error("Threads reads and gates should use Threads-owned account evidence and scopes");
  if (!/function requireThreadsAccountForRead[\s\S]*?const missingScopes = requiredScopes\.filter[\s\S]*?grantedScopes: account\.scopes/.test(serverSource)) throw new Error("Threads read gates must reject missing provider-granted scopes with explicit evidence");
  if (!serverSource.includes("probe.attempted && probe.ok") || !serverSource.includes('"banked-scope-ready"')) throw new Error("provider truth must reserve banked-live for a passing live probe");
  if (!/discord:\s*\(\)\s*=>\s*Boolean\([\s\S]*?discordBotToken[\s\S]*?discordSelectedGuildId[\s\S]*?discordSelectedChannelId/.test(serverSource) || serverSource.includes("discord: () => true")) throw new Error("Discord publish truth must require the bot and the workspace's authorized server/channel destination");
  if (!serverSource.includes('twitch: () => hasAnyScope(account, ["analytics:read:extensions"')) throw new Error("Twitch analytics truth must require a relevant granted scope");
  if (!/function hasStoredToken\(account\)[\s\S]*?return Boolean\(account\?\.credential \|\| account\?\.token \|\| account\?\.accessToken \|\| account\?\.refreshToken\);/.test(serverSource)) throw new Error("provider truth must not treat a public tokenStored flag as encrypted credential evidence");
  if (!serverSource.includes('const paid = session.payment_status === "paid";') || serverSource.includes('session.mode === "subscription";')) throw new Error("Stripe checkout must not grant access for unpaid subscription sessions");
  if (!serverSource.includes("existingTokenUpdatedAt") || !serverSource.includes("incomingCredentialAt") || !serverSource.includes("credentialUpdatedAt = tokenRow.updated_at")) throw new Error("normalized provider tokens must reject stale concurrent workspace writes");
  if ((serverSource.match(/account\.credentialUpdatedAt = new Date\(\)\.toISOString\(\);/g) || []).length < 4) throw new Error("provider refresh paths must version newly rotated credentials");
  if (!serverSource.includes("providerAccountId: selectedIdentity?.providerAccountId || null") || !serverSource.includes("providerAccountId: attempt.providerAccountId")) throw new Error("publish attempts and durable receipts must bind to the selected provider identity");
  if (!/if \(providerAccepted\) \{[\s\S]*?item\.variant\.status = "published"/.test(serverSource) || !appHtml.includes('["approved", "queued", "submitted", "published"]')) throw new Error("published status must require provider receipt evidence while submitted remains visible");
  if (!serverSource.includes("staleConnectTask") || !serverSource.includes("superseded by the authoritative provider-ledger action")) throw new Error("provider task sync must retire satisfied or duplicate connect tasks");
  for (const route of ["/api/threads/account", "/api/threads/publish"]) {
    if (!appHtml.includes(route)) throw new Error(`Threads route missing from function suite: ${route}`);
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`Threads route missing backend handler: ${route}`);
  }
  if (!appHtml.includes("source.threadsStatus?.account")) throw new Error("Threads status account evidence is not merged into the app account list");
  if (!appHtml.includes("threadsStatus.lastError") || appHtml.includes('label: redirectFix.exactValue ? "needs whitelist"')) throw new Error("Threads account card should show token exchange evidence and not treat redirect setup instructions as an active blocker");
  if (!appHtml.includes("providerEvidenceAccountsFromState(metaState)") || !appHtml.includes("metaState.providerTruth?.rows") || !appHtml.includes("metaState.acceptanceLedger?.rows")) throw new Error("connected account resolver should merge provider evidence sources");
  if (!/url\.pathname === "\/api\/twitch\/readiness"[\s\S]*?const session = await sessionFromRequest/.test(serverSource)) throw new Error("Twitch readiness should use signed-in session evidence instead of hiding OAuth success behind entitlement lookup");
  if (!/url\.pathname === "\/api\/youtube\/readiness"[\s\S]*?const session = await sessionFromRequest/.test(serverSource)) throw new Error("YouTube readiness should be public-safe and not hide configuration behind entitlement");
  if (!/url\.pathname === "\/api\/google\/growth-suite"[\s\S]*?const session = await sessionFromRequest/.test(serverSource)) throw new Error("Google Growth readiness should be public-safe and not hide configuration behind entitlement");
  if (!/id: "google_business"[\s\S]*?env: \["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"\][\s\S]*?configured: \(\) => Boolean\(googleClientId && googleClientSecret\)/.test(serverSource)) throw new Error("Google Business provider readiness should use per-user OAuth discovery instead of global account/location IDs");
  if (!serverSource.includes("googleBusinessScopes") || !serverSource.includes("listGoogleBusinessAccounts") || !serverSource.includes("listGoogleBusinessLocations") || !serverSource.includes("upsertGoogleBusinessAssets")) throw new Error("Google Business must request business.manage and discover tenant-owned accounts and locations");
  if (!appHtml.includes('startProviderOAuth("youtube", platform === "google_business" ? "google_business" : "youtube")') || !appHtml.includes('renderProviderAccountPicker("google_business", accounts)') || !appHtml.includes("API approval needed")) throw new Error("Google Business account card should connect, select discovered locations, and explain project approval blockers");
  if (!serverSource.includes("oauthReturnBody") || !serverSource.includes("sc_last_oauth_return") || !serverSource.includes("oauth_provider")) throw new Error("OAuth callbacks should auto-return to the app so provider state refreshes after handshakes");
  if (!appHtml.includes("currentOAuthReturn") || !appHtml.includes("acknowledgeOAuthReturn") || !appHtml.includes('jump("accounts")')) throw new Error("app should consume OAuth return markers, refresh provider state, and land users on accounts");
  if (!appHtml.includes("if (platform?.name) return platform.name;")) throw new Error("provider cards should keep provider names separate from connected identity names");
  if (!serverSource.includes("function renewOAuthReturnSession") || !serverSource.includes('sessionProvider: "oauth-return"')) throw new Error("OAuth callbacks should renew the app session cookie after a provider return");
  if (!/url\.pathname === "\/api\/analyze"[\s\S]*?modelForSession\(session, sharedModel\)[\s\S]*?saveModelForUser\(model, session\.user\)/.test(serverSource)) throw new Error("analytics refresh must read and save the signed-in user's workspace model");
  if (!serverSource.includes("function inspectInstagramPageLinks") || !serverSource.includes("connected_instagram_account")) throw new Error("Instagram diagnostics should check Page-linked IG fields instead of only saying no assets");
  if (!serverSource.includes("page.instagram_business_account || page.connected_instagram_account") || !serverSource.includes("pageBody.instagram_business_account || pageBody.connected_instagram_account")) throw new Error("Meta sync should store Instagram assets from both Page IG link fields");
  if (!serverSource.includes("function getMetaBusinessAssetInventory") || !serverSource.includes("owned_instagram_accounts") || !serverSource.includes("client_instagram_accounts") || !serverSource.includes("owned_pages") || !serverSource.includes("client_pages")) throw new Error("Meta business assets should inspect Business-owned/client Page and Instagram edges");
  if (!serverSource.includes("check.graphPage") || !serverSource.includes("fields: \"id,name,link,instagram_business_account")) throw new Error("Instagram diagnostics should expose the exact Graph Page link/id checked");
  if (!serverSource.includes("model.metaConnection?.instagramCount") || !serverSource.includes("model.metaHealth?.assetSync?.instagramAvailable") || !appHtml.includes("Meta sees IG asset") || !appHtml.includes("needs token-backed bind")) throw new Error("growth and account cards should show Meta-detected Instagram assets without falsely marking them usable");
  if (!/url\.pathname === "\/api\/campaigns\/coming-soon"[\s\S]*?buildComingSoonShotCampaign\(session\.user\)/.test(serverSource)) throw new Error("coming-soon campaign should be creatable in the signed-in hosted workspace");
  if (!serverSource.includes('url.pathname === "/social-cues-coming-soon.png"')) throw new Error("coming-soon graphic should be publicly served for provider media URLs");
  if (!serverSource.includes("lockedAccessDetail") || !serverSource.includes("sc_last_oauth_return") || !serverSource.includes("Signed in as ") || !serverSource.includes("does not have active paid or promo access yet")) throw new Error("locked app gate should explain signed-in, signed-out, and OAuth-return access states");
  const oauthReturnCallbacks = [...serverSource.matchAll(/url\.pathname === "\/api\/oauth\/([^/]+)\/callback"[\s\S]*?return html\(res, 200, oauthReturnBody\("([^"]+)"/g)]
    .map(match => ({ provider: match[1], block: match[0] }));
  const callbacksMissingSessionRenewal = oauthReturnCallbacks
    .filter(item => !item.block.includes("renewOAuthReturnSession"))
    .map(item => item.provider);
  if (callbacksMissingSessionRenewal.length) throw new Error(`OAuth callbacks missing app-session renewal: ${callbacksMissingSessionRenewal.join(", ")}`);
  if (!serverSource.includes('media_type: "REELS"') || !serverSource.includes('video_url: videoUrl')) throw new Error("Instagram hosted video publish payload missing");
  if (!serverSource.includes("/videos") || !serverSource.includes("file_url: videoUrl")) throw new Error("Facebook hosted video publish payload missing");
  if (appHtml.includes('section("Backend services"')) throw new Error("accounts panel should not show backend-only services");
  if (appHtml.includes("<h2>Provider readiness</h2>")) throw new Error("app shell should present user account connections, not provider readiness");
  if (!appHtml.includes("Accounts and posting identities") || !appHtml.includes("customerAccountPlatformIds") || !appHtml.includes("Add or set up accounts") || !appHtml.includes("setupGatedPlatforms")) throw new Error("accounts panel must show saved identities plus every disconnected lane, including providers that are still setup gated");
  if (!appHtml.includes('label.includes("credential missing")') || !appHtml.includes("Visible below with the exact blocker")) throw new Error("accounts panel must explain setup-gated providers without rendering dead OAuth actions");
  if (!appHtml.includes("Checking account connections") || !appHtml.includes("Connection totals will appear only after those checks finish") || !appHtml.includes("loading: SERVER_MODE")) throw new Error("accounts panel must show a loading truth state instead of transient false zero connections");
  if (!appHtml.includes("if (readiness.detail) return readiness.detail") || !appHtml.includes("review|scope|permission|approval|audit|commercial|public users")) throw new Error("account cards must use provider-specific capability wording and reserve review warnings for actual review gates");
  if (!appHtml.includes('twitch: { write: "clip actions", read: "channel signals" }') || !appHtml.includes('shopify: { write: "catalog / marketing", read: "store signals" }')) throw new Error("workflow providers must label their actual API capabilities instead of pretending every write/read scope is social publishing/analytics");
  if (!appHtml.includes("function canonicalProviderSnapshot") || !appHtml.includes("Connected account assets") || !appHtml.includes("uniqueConnectedAssets")) throw new Error("Dashboard, Growth, Accounts, and Admin must share one canonical provider/account-asset state");
  if (!appHtml.includes("connectedAccountForPlatform(platform.id)") || !appHtml.includes('source: "Canonical workspace provider state"')) throw new Error("customer analytics surfaces must reconcile provider identities through the same canonical account evidence used by Accounts");
  if (!serverSource.includes("connectedAssets") || !serverSource.includes("connectedLanes") || !serverSource.includes("identity: providerPostingIdentityName")) throw new Error("the server provider-state contract must distinguish unique account assets from connected capability lanes");
  if (!serverSource.includes('tiktok: () => hasAnyScope(account, ["video.list"])') || serverSource.includes('tiktok: () => hasAnyScope(account, ["user.info.basic", "video.list"])')) throw new Error("TikTok basic profile access must not be counted as analytics readiness");
  if (!serverSource.includes("supersededPortalBlocker") || !serverSource.includes('platform.id === "threads"')) throw new Error("connected Threads evidence must supersede the stale historical URL-blocked portal symptom");
  if (appHtml.includes('section("Login identities"') || appHtml.includes('section("Managed publishing assets"') || appHtml.includes('section("Setup needed"')) throw new Error("accounts panel should not repeat provider identities in duplicate visible sections");
  if (!appHtml.includes("function providerCapabilityTags") || !appHtml.includes("function providerCustomerSummary") || !appHtml.includes("providerStateChips(platform.id, laneAccount)")) throw new Error("customer account cards must translate backend capability truth into concise connection, publishing, analytics, and review states");
  if (!appHtml.includes("const evidenceAccount = connectedAccountForPlatform(providerId)") || !appHtml.includes('connected ? "token-backed"')) throw new Error("provider capability strip should reconcile live account evidence before showing missing developer config");
  if (!appHtml.includes('`read: ${readVerified ? "verified" : "unproven"}`') || !appHtml.includes('`publish: ${publishReady ? "ready" : "gated"}`') || !appHtml.includes('`analytics: ${analyticsReady ? "ready" : "gated"}`')) throw new Error("provider capability strip must distinguish verified/read, publish, and analytics gates");
  if (!appHtml.includes('id: "discord"') || !appHtml.includes('connectRoute: "/api/oauth/discord/start"')) throw new Error("Discord function suite should expose the OAuth connect route");
  if (!appHtml.includes("function authoritativeProviderAccount") || !appHtml.includes("providerAccountSelectionRow(canonical)") || !appHtml.includes("providerAccountOptionLabel(account)")) throw new Error("accounts GUI must use the authoritative provider-account selection response");
  if (!appHtml.includes('return `${identity} is connected. Additional provider access is still pending.`') || !/function providerPrimaryAction[\s\S]*?if \(connected \|\| label\.includes\("connected"\)\)[\s\S]*?label: "Reconnect"/.test(appHtml) || !appHtml.includes("providerPrimaryAction(readiness, connected)")) throw new Error("connected provider cards must use customer summaries and avoid stale first-time connection language");
  if (!appHtml.includes('"google_growth", "google_business"') || !appHtml.includes("selectedPlatformIds") || !appHtml.includes("primaryPlatforms") || !appHtml.includes("More services")) throw new Error("Accounts must keep selected services in the focused account queue and move unused Google/provider lanes behind setup disclosure");
  if (!appHtml.includes('data-studio-mode="video"') || !appHtml.includes("function setStudioMode") || !appHtml.includes("visibleCreationPlatforms().map(platform => platform.id)")) throw new Error("Create must expose video as a first-class mode and generate only for active workspace platforms");
  if (!appHtml.includes("function providerSourceIsActive") || !appHtml.includes("visibleSources")) throw new Error("Audience, library, and commerce sources must follow selected or connected workspace services");
  if (!appHtml.includes("Analytics lanes ready - refresh live insights") || !appHtml.includes("Accounts connected - analytics permission still needed") || !appHtml.includes("escapeHtml(analysisStatus)")) throw new Error("Audience analysis must not say it is waiting for accounts after canonical connected assets are present");
  if (!appHtml.includes('data-account-lane="reddit"') || !appHtml.includes("Reddit installed-community lane") || !appHtml.includes("Open Reddit workflow")) throw new Error("Accounts must expose the Reddit installed-community workflow without pretending it is OAuth");
  if (!appHtml.includes("function discordClientActionKey") || !appHtml.includes('"Idempotency-Key": idempotencyKey') || !appHtml.includes("clearDiscordClientActionKey(button)")) throw new Error("Discord live customer actions must send reusable idempotency keys and clear them only after success");
  if (!appHtml.includes("function providerStateChips") || !appHtml.includes('data-provider-state="${escapeHtml(label)}"') || !appHtml.includes("function providerAccountEvidenceLine")) throw new Error("account cards must separate connection, publishing, analytics, and review while showing asset evidence");
  if (!appHtml.includes("integrationsStatus?.providerServices") || !appHtml.includes("integrationsStatus?.coreServices")) throw new Error("provider readiness services must not be dropped from GUI state");
  if (!appHtml.includes("const threadsInsightsLive = Boolean") || !appHtml.includes("metaState.threadsInsights?.observedAt") || !appHtml.includes("metricHtml + sourceHtml + analysisHtml")) throw new Error("Growth must require timestamped live Threads evidence and render provenance before interpretation");
  if (!appHtml.includes('id="appResult" role="status" aria-live="polite"') || !appHtml.includes("function showAppResult") || !appHtml.includes('id="dismissAppResult"')) throw new Error("provider checks need a non-blocking accessible in-app result region");
  if (!appHtml.includes("@media (max-width: 480px)") || !appHtml.includes(".provider-state-chips { display: grid; grid-template-columns: 1fr 1fr; }") || !appHtml.includes("overflow-wrap: anywhere")) throw new Error("mobile provider cards must bound controls and long provider evidence");
  for (const evidenceSource of ["YouTube Data API commentThreads.list", "Threads Insights API", "X API v2 user mentions and authored posts"]) {
    if (!serverSource.includes(evidenceSource)) throw new Error(`provider read response missing source evidence: ${evidenceSource}`);
  }

  const termsResponse = await fetch(base + "/terms");
  if (!termsResponse.ok || !(await termsResponse.text()).includes("Social Cues Terms of Service")) throw new Error("terms route failed");

  const model = await request("/api/model");
  if (!model.workspace || !Array.isArray(model.campaigns)) throw new Error("bad model shape");
  if (!Array.isArray(model.connectedAccounts)) throw new Error("bad accounts shape");
  if (Object.prototype.hasOwnProperty.call(model, "authUsers")) throw new Error("model exposed auth user ledger");
  if (JSON.stringify(model).includes('"token":') || JSON.stringify(model).includes('"accessToken":') || JSON.stringify(model).includes('"refreshToken":')) throw new Error("model leaked token material");
  if (JSON.stringify(model).includes('"oauthStates"')) throw new Error("model leaked oauth state ledger");
  if (JSON.stringify(model).includes('"oauthEvents"')) throw new Error("model leaked OAuth debug event ledger");
  if (!serverSource.includes("async function hydrateNormalizedSupabaseAccountState") || !serverSource.includes("/billing_entitlements?user_id=eq.") || !serverSource.includes("await hydrateNormalizedSupabaseAccountState(model, user)")) {
    throw new Error("Supabase login/session restoration must hydrate the durable profile and billing entitlement before enforcing the paywall");
  }
  if (!serverSource.includes("preserveDurableRevocation") || !serverSource.includes("device.activatedAt = new Date().toISOString()") || !serverSource.includes("trusted: device.trusted !== false && !device.revokedAt")) {
    throw new Error("remembered-device persistence must prevent stale workspace saves from resurrecting a revoked session");
  }

  const blockedSignupResponse = await fetch(base + "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "No Invite", email: `no-invite-${Date.now()}@socialcuesapp.com`, password: "test-password-2026", workspaceName: "Blocked Workspace" })
  });
  const blockedSignup = await blockedSignupResponse.json();
  if (blockedSignupResponse.status !== 403 || !blockedSignup.signupLocked || !/invite-only/i.test(blockedSignup.error || "")) throw new Error("public signup without owner email or promo code should be locked");

  const ownerGateEmail = `mr.barton+owner-gate-test-${Date.now()}@socialcuesapp.com`;
  const ownerSignup = await request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Cory Barton", email: ownerGateEmail, password: "test-password-2026", workspaceName: "Owner Workspace" })
  });
  if (!ownerSignup.ok || ownerSignup.entitlement?.source !== "owner-allowlist" || !ownerSignup.entitlement?.subscriptionPaid || !ownerSignup.entitlement?.appFeePaid) throw new Error("owner email signup should bypass invite lock and receive full access");
  if (ownerSignup.user?.role !== "Owner") throw new Error("owner signup should resolve to the Owner role");

  const accountEmail = `alpha-${Date.now()}@socialcuesapp.com`;
  const accountPassword = "test-password-2026";
  const signup = await request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Alpha Tester", email: accountEmail, password: accountPassword, promoCode: "SC-LOCAL-BEACON-4M7Q", workspaceName: "Social Cues Alpha" })
  });
  if (!signup.ok || signup.workspace.name !== "Social Cues Alpha" || !signup.session?.token) throw new Error("signup failed");
  if (signup.entitlement?.access !== "highest-tier-test" || signup.entitlement?.source !== "promo-code" || !signup.entitlement?.subscriptionPaid || !signup.entitlement?.appFeePaid) throw new Error("promo entitlement failed");
  if (signup.user?.role !== "Alpha tester") throw new Error("promo tester signup should not be treated as Owner");

  const duplicatePromoResponse = await fetch(base + "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Duplicate Tester", email: `duplicate-promo-${Date.now()}@socialcuesapp.com`, password: accountPassword, promoCode: "SC-LOCAL-BEACON-4M7Q", workspaceName: "Duplicate Promo" })
  });
  const duplicatePromo = await duplicatePromoResponse.json();
  if (duplicatePromoResponse.status !== 409 || !/already been assigned/i.test(duplicatePromo.error || "")) throw new Error("promo codes should be one tester account each");

  const badLoginResponse = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: accountEmail, password: "wrong-password" })
  });
  if (badLoginResponse.status !== 401) throw new Error("bad login should be rejected");

  const localResendResponse = await fetch(base + "/api/auth/resend-verification", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: accountEmail })
  });
  const localResend = await localResendResponse.json();
  if (localResendResponse.status !== 409 || !localResend.smtp) throw new Error("local resend verification guard failed");

  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Alpha Tester", email: accountEmail, password: accountPassword, workspaceName: "Social Cues Alpha" })
  });
  if (!login.ok || login.workspace.name !== "Social Cues Alpha" || !login.session?.token) throw new Error("login failed");
  if (login.user?.role !== "Alpha tester") throw new Error("promo tester login should preserve the Alpha tester role");
  const patreonStartResponse = await fetch(base + "/api/oauth/patreon/start", {
    redirect: "manual",
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (patreonStartResponse.status !== 302) throw new Error("Patreon OAuth start did not redirect an authenticated workspace");
  const patreonStartUrl = new URL(patreonStartResponse.headers.get("location") || "");
  if (patreonStartUrl.hostname !== "www.patreon.com" || patreonStartUrl.pathname !== "/oauth2/authorize") throw new Error("Patreon OAuth start returned the wrong provider URL");
  if (patreonStartUrl.searchParams.get("redirect_uri") !== "https://socialcuesapp.com/api/oauth/patreon/callback") throw new Error("Patreon OAuth start returned the wrong callback URL");
  const patreonRequestedScopes = patreonStartUrl.searchParams.get("scope") || "";
  if (!patreonRequestedScopes.includes("campaigns.members") || patreonRequestedScopes.includes("campaigns.members[email]") || patreonRequestedScopes.includes("campaigns.members.address")) throw new Error("Patreon OAuth start must request useful privacy-minimized scopes");
  const authReadiness = await request("/api/auth/readiness");
  if (!Object.prototype.hasOwnProperty.call(authReadiness, "ready")) throw new Error("auth readiness should expose a truthful top-level ready state");

  const cookieLoginResponse = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Alpha Tester", email: accountEmail, password: accountPassword })
  });
  const setCookie = cookieLoginResponse.headers.get("set-cookie") || "";
  if (!cookieLoginResponse.ok || !setCookie.includes("sc_session=") || !setCookie.includes("HttpOnly")) throw new Error("login did not set secure session cookie");
  const cookieModelResponse = await fetch(base + "/api/model", {
    headers: { Cookie: setCookie.split(";")[0] }
  });
  const cookieModel = await cookieModelResponse.json();
  if (!cookieModelResponse.ok || cookieModel.currentUser?.email !== accountEmail) throw new Error("session cookie did not load signed-in model");

  const rememberedDevices = await request("/api/devices", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const revokableDevice = rememberedDevices.devices?.find(device => device.active && device.deviceId !== rememberedDevices.currentDeviceId);
  if (!rememberedDevices.ok || !revokableDevice) throw new Error("device management did not return a non-current remembered device");
  const revokedDevice = await request(`/api/devices/${encodeURIComponent(revokableDevice.deviceId)}/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!revokedDevice.ok || revokedDevice.revokedDeviceId !== revokableDevice.deviceId || revokedDevice.devices?.find(device => device.deviceId === revokableDevice.deviceId)?.active !== false) {
    throw new Error("device management did not durably sign out the selected remembered device");
  }
  if (revokedDevice.devices?.find(device => device.deviceId === revokableDevice.deviceId)?.trusted !== false) throw new Error("signed-out devices must not remain trusted");

  const workspaceModelStatus = await request("/api/workspace/model/status", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!workspaceModelStatus.ok || !Object.prototype.hasOwnProperty.call(workspaceModelStatus, "mirrored")) throw new Error("workspace model status failed");

  const firstUserModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (firstUserModel.currentUser?.email !== accountEmail) throw new Error("signed-in model returned the wrong first user");
  if (Object.prototype.hasOwnProperty.call(firstUserModel, "authPromoClaims")) throw new Error("model exposed promo claim ledger");
  if ((firstUserModel.campaigns || []).some(item => item.id === "camp-Social Cues-self-launch" || item.title === "Social Cues Customer-Ready Launch")) throw new Error("customer workspace inherited the internal Social Cues launch campaign");
  const firstUserCampaignIds = new Set((firstUserModel.campaigns || []).map(item => item.id));
  const blankWorkspaceCollections = ["campaigns", "actions", "proof", "mediaAssets", "mediaRenderJobs", "publishQueue", "analyticsSnapshots", "providerStateSnapshots", "connectedAccounts", "activity"];
  if (blankWorkspaceCollections.some(key => (firstUserModel[key] || []).length) || firstUserModel.activeCampaignId || (firstUserModel.analytics?.metrics || []).length) {
    throw new Error("new first-user workspace was not completely blank");
  }
  firstUserModel.connectedAccounts = [
    ...(firstUserModel.connectedAccounts || []),
    {
      id: "acct-twitch-regression",
      platform: "twitch",
      name: "Regression Twitch",
      handle: "@regression_twitch",
      status: "not connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "twitch",
      providerAccountId: "test-twitch-user-1",
      credential: "fake-test-token-marker",
      scopes: ["user:read:email", "clips:edit", "user:read:broadcast"]
    },
    {
      id: "acct-twitch-regression-alternate",
      platform: "twitch",
      name: "Regression Twitch duplicate evidence",
      handle: "@regression_twitch",
      status: "connected",
      connectedAt: new Date(Date.now() - 60_000).toISOString(),
      oauthProvider: "twitch",
      providerAccountId: "test-twitch-user-1",
      credential: "fake-test-token-marker-alternate",
      scopes: ["user:read:email", "clips:edit", "user:read:broadcast"]
    },
    {
      id: "acct-discord-regression",
      platform: "discord",
      name: "Regression Discord",
      handle: "@regression_discord",
      status: "connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "discord",
      providerAccountId: "test-discord-user-1",
      credential: "fake-test-token-marker",
      scopes: ["identify", "guilds", "guilds.members.read"],
      profile: {
        discordSelectedGuildId: "test-discord-guild",
        discordSelectedGuildName: "Regression Guild",
        discordSelectedChannelId: "test-discord-channel",
        discordSelectedChannelName: "regression-channel"
      }
    },
    {
      id: "acct-x-regression",
      platform: "x",
      name: "Regression X",
      handle: "@regression_x",
      displayName: "Regression X",
      status: "connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "x",
      providerAccountId: "test-x-user-1",
      credential: "fake-test-token-marker",
      scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"]
    },
    {
      id: "acct-tiktok-regression",
      platform: "tiktok",
      name: "TikTok",
      handle: "Regression TikTok",
      displayName: "Regression TikTok",
      status: "connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "tiktok",
      providerAccountId: "test-tiktok-user-1",
      credential: "fake-test-token-marker",
      scopes: ["user.info.basic", "video.upload", "video.publish"]
    },
    {
      id: "acct-youtube-regression",
      platform: "youtube",
      name: "Regression YouTube",
      handle: "Regression YouTube",
      displayName: "Regression YouTube",
      status: "not connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "youtube",
      providerAccountId: "test-youtube-channel-1",
      credential: "fake-test-token-marker",
      scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/yt-analytics.readonly", "https://www.googleapis.com/auth/youtube.readonly"]
    },
    {
      id: "acct-pinterest-regression",
      platform: "pinterest",
      name: "Regression Pinterest",
      handle: "@regression_pinterest",
      status: "not connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "pinterest",
      providerAccountId: "test-pinterest-user-1",
      credential: "fake-test-token-marker",
      scopes: ["boards:read", "pins:read", "pins:write"]
    },
    {
      id: "acct-canva-regression",
      platform: "canva",
      name: "Regression Canva",
      handle: "Regression Canva",
      status: "connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "canva",
      providerAccountId: "test-canva-user-1",
      credential: "fake-test-token-marker",
      scopes: ["profile:read", "design:meta:read", "design:content:read", "design:content:write", "asset:read", "asset:write", "brandtemplate:meta:read", "brandtemplate:content:read", "folder:read", "comment:read"]
    },
    {
      id: "acct-shopify-regression",
      platform: "shopify",
      name: "regression.myshopify.com",
      handle: "regression.myshopify.com",
      status: "not connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "shopify",
      providerAccountId: "regression.myshopify.com",
      credential: "fake-test-token-marker",
      scopes: ["read_products", "read_marketing_events", "write_marketing_events"]
    },
    {
      id: "acct-etsy-regression",
      platform: "etsy",
      name: "Regression Etsy",
      handle: "Regression Etsy",
      status: "not connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "etsy",
      providerAccountId: "test-etsy-user-1",
      credential: "fake-test-token-marker",
      scopes: ["shops_r", "listings_r", "listings_w"]
    },
    {
      id: "acct-meta-regression",
      platform: "meta",
      name: "Regression Meta User",
      handle: "Regression Meta User",
      status: "connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "meta",
      providerAccountId: "test-meta-user-1",
      credential: "fake-test-token-marker",
      scopes: ["public_profile", "pages_show_list", "pages_read_engagement"]
    },
    {
      id: "acct-facebook-regression",
      platform: "facebook",
      name: "Regression Facebook Page",
      handle: "Regression Facebook Page",
      displayName: "Regression Facebook Page",
      status: "connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "meta",
      providerAccountId: "test-facebook-page-1",
      credential: "fake-test-token-marker",
      scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "public_profile"]
    },
    {
      id: "acct-threads",
      platform: "threads",
      name: "Threads",
      handle: "@threads",
      status: "connected",
      connectedAt: "2026-01-01T00:00:00.000Z",
      oauthProvider: "threads",
      providerAccountId: "acct-threads",
      credential: "fake-stale-threads-token",
      tokenExpiresAt: "2026-01-02T00:00:00.000Z",
      scopes: []
    },
    {
      id: "acct-threads-regression",
      platform: "threads",
      name: "Regression Threads",
      handle: "@regression_threads",
      status: "connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "threads",
      providerAccountId: "test-threads-user-1",
      credential: "fake-test-token-marker",
      scopes: ["threads_basic", "threads_content_publish", "threads_manage_insights", "threads_manage_replies"],
      profile: { biography: "safe public field", accessToken: "nested-secret-regression-marker" }
    }
  ];
  firstUserModel.integrations = {
    ...(firstUserModel.integrations || {}),
    youtube: "YouTube token exchange failed: Unauthorized",
    facebook: "No pages returned by current permissions"
  };
  const savedFirstUserModel = await request("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(firstUserModel)
  });
  if (JSON.stringify(savedFirstUserModel).includes("nested-secret-regression-marker")) throw new Error("public model leaked a nested provider secret field");
  const twitchProviderAccounts = await request("/api/provider/accounts?platform=twitch", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const twitchSelectionRow = twitchProviderAccounts.rows?.[0];
  if (!twitchProviderAccounts.ok || twitchSelectionRow?.accounts?.length !== 1 || twitchSelectionRow?.credentialPathCount !== 2 || twitchProviderAccounts.assetCount !== 1) {
    throw new Error("provider account selection did not collapse duplicate credential paths into one posting identity");
  }
  const signedInTwitchReady = await request("/api/twitch/readiness", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (signedInTwitchReady.account?.providerAccountId !== "test-twitch-user-1" || signedInTwitchReady.account?.connected !== true) throw new Error("signed-in Twitch readiness did not read the user workspace account");
  const signedInTwitchStatus = await request("/api/oauth/twitch/status", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (signedInTwitchStatus.account?.providerAccountId !== "test-twitch-user-1" || signedInTwitchStatus.account?.connected !== true) throw new Error("signed-in Twitch OAuth status did not expose the connected account for the app card");
  const signedInDiscordReady = await request("/api/discord/readiness", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (signedInDiscordReady.account?.providerAccountId !== "test-discord-user-1" || signedInDiscordReady.account?.connected !== true) throw new Error("signed-in Discord readiness did not read the user workspace account");
  const signedInDiscordStatus = await request("/api/oauth/discord/status", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (signedInDiscordStatus.account?.providerAccountId !== "test-discord-user-1" || signedInDiscordStatus.account?.connected !== true) throw new Error("signed-in Discord OAuth status did not expose the connected account for the app card");
  const discordAnnouncementDryRun = await request("/api/discord/announcement", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ content: "Social Cues Discord announcement dry-run regression.", live: false })
  });
  if (!discordAnnouncementDryRun.ok || discordAnnouncementDryRun.mode !== "dry-run" || discordAnnouncementDryRun.announcement?.live !== false || !discordAnnouncementDryRun.announcement?.idempotencyKey || discordAnnouncementDryRun.announcement?.guildId !== "test-discord-guild") throw new Error("Discord announcement dry-run failed");
  const discordReplyDryRun = await request("/api/discord/messages/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ channelId: "test-discord-channel", messageId: "test-discord-message", content: "Approved Discord reply dry-run.", live: false })
  });
  if (!discordReplyDryRun.ok || discordReplyDryRun.mode !== "dry-run" || discordReplyDryRun.reply?.live !== false || !discordReplyDryRun.reply?.idempotencyKey || discordReplyDryRun.reply?.guildId !== "test-discord-guild") throw new Error("Discord reply dry-run failed");
  const discordModerationDryRun = await request("/api/discord/messages/moderate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ channelId: "test-discord-channel", messageId: "test-discord-message", live: false })
  });
  if (!discordModerationDryRun.ok || discordModerationDryRun.mode !== "dry-run" || discordModerationDryRun.moderation?.action !== "delete" || !discordModerationDryRun.moderation?.idempotencyKey) throw new Error("Discord moderation dry-run failed");
  const discordCommandDryRun = await request("/api/discord/commands/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ live: false })
  });
  if (!discordCommandDryRun.ok || discordCommandDryRun.mode !== "dry-run" || !discordCommandDryRun.dryRun?.commands?.some(command => command.name === "cue")) throw new Error("Discord command registration dry-run failed");
  const discordPreflight = await request("/api/discord/verification-preflight", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!discordPreflight.ok || !Array.isArray(discordPreflight.gates) || !discordPreflight.gates.some(gate => gate.id === "verification-final" && gate.finalStep) || discordPreflight.verificationPolicy?.indexOf("dead last") === -1) throw new Error("Discord verification preflight should keep verification locked as the final portal step");
  const signedInXStatus = await request("/api/oauth/x/status", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (signedInXStatus.account?.providerAccountId !== "test-x-user-1" || signedInXStatus.account?.connected !== true) throw new Error("signed-in X OAuth status did not expose the connected account for the app card");
  const signedInXAccount = await request("/api/x/account", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (signedInXAccount.account?.providerAccountId !== "test-x-user-1" || signedInXAccount.ready !== true) throw new Error("signed-in X account did not read the user workspace account");
  for (const [provider, route, expectedId] of [
    ["tiktok", "/api/oauth/tiktok/status", "test-tiktok-user-1"],
    ["youtube", "/api/oauth/youtube/status", "test-youtube-channel-1"],
    ["pinterest", "/api/oauth/pinterest/status", "test-pinterest-user-1"],
    ["canva", "/api/oauth/canva/status", "test-canva-user-1"],
    ["shopify", "/api/oauth/shopify/status", "regression.myshopify.com"],
    ["etsy", "/api/oauth/etsy/status", "test-etsy-user-1"]
  ]) {
    const status = await request(route, { headers: { Authorization: `Bearer ${login.session.token}` } });
    if (status.account?.providerAccountId !== expectedId || status.account?.connected !== true) throw new Error(`signed-in ${provider} OAuth status did not expose the connected account for the app card`);
  }
  for (const [provider, route, expectedId] of [
    ["tiktok", "/api/short-video/account", "test-tiktok-user-1"],
    ["youtube", "/api/youtube/account", "test-youtube-channel-1"],
    ["pinterest", "/api/pinterest/readiness", "test-pinterest-user-1"],
    ["canva", "/api/canva/readiness", "test-canva-user-1"],
    ["shopify", "/api/shopify/readiness", "regression.myshopify.com"],
    ["etsy", "/api/etsy/readiness", "test-etsy-user-1"]
  ]) {
    const readiness = await request(route, { headers: { Authorization: `Bearer ${login.session.token}` } });
    if (readiness.account?.providerAccountId !== expectedId || readiness.account?.connected !== true) throw new Error(`signed-in ${provider} readiness/account route did not read the user workspace account`);
  }
  const signedInCanvaFolderItems = await request("/api/canva/folder-items", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (signedInCanvaFolderItems.ready !== false || signedInCanvaFolderItems.requiredQuery !== "folderId" || !signedInCanvaFolderItems.capabilityLanes?.some(lane => lane.id === "folder_organization")) throw new Error("Canva folder items should expose the required folderId setup contract before provider network calls");
  const signedInCanvaExportFormats = await request("/api/canva/design-export-formats", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (signedInCanvaExportFormats.ready !== false || signedInCanvaExportFormats.requiredQuery !== "designId" || !signedInCanvaExportFormats.capabilityLanes?.some(lane => lane.id === "design_exports")) throw new Error("Canva export formats should expose the required designId setup contract before provider network calls");
  const signedInEtsyReceiptsResponse = await fetch(base + "/api/etsy/receipts", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const signedInEtsyReceipts = await signedInEtsyReceiptsResponse.json();
  if (signedInEtsyReceipts.ok !== false || !signedInEtsyReceipts.requiredScopes?.includes("transactions_r") || !Array.isArray(signedInEtsyReceipts.capabilityLanes)) throw new Error("Etsy receipts should stop at the transactions_r gate before provider network calls");
  const signedInMetaStatus = await request("/api/oauth/meta/status", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (signedInMetaStatus.account?.providerAccountId !== "test-meta-user-1" || signedInMetaStatus.account?.connected !== true) throw new Error("signed-in Meta OAuth status did not expose the connected account for the app card");
  const signedInThreadsStatus = await request("/api/oauth/threads/status", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (signedInThreadsStatus.account?.providerAccountId !== "test-threads-user-1" || signedInThreadsStatus.account?.connected !== true) throw new Error("signed-in Threads OAuth status did not expose the connected account for the app card");
  const threadsReplyDryRun = await request("/api/threads/replies/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ replyToId: "test-thread-reply-1", text: "Social Cues Threads response regression.", live: false })
  });
  if (!threadsReplyDryRun.ok || threadsReplyDryRun.dryRun !== true || threadsReplyDryRun.account?.providerAccountId !== "test-threads-user-1") throw new Error("Threads reply workflow selected a stale placeholder instead of the real connected account");
  const threadsDryRun = await request("/api/threads/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ text: "Social Cues Threads dry-run regression.", live: false })
  });
  if (!threadsDryRun.ok || threadsDryRun.dryRun !== true || threadsDryRun.account?.providerAccountId !== "test-threads-user-1") throw new Error("Threads publish dry-run did not use the signed-in user workspace account");
  const xPostDryRun = await request("/api/x/post", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ text: "Social Cues X post dry-run regression.", live: false })
  });
  if (!xPostDryRun.ok || xPostDryRun.dryRun !== true || xPostDryRun.provider !== "x") throw new Error("X post dry-run failed");
  const signedInProviderTruth = await request("/api/provider/truth", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const twitchTruth = signedInProviderTruth.rows.find(row => row.id === "twitch");
  const tiktokTruth = signedInProviderTruth.rows.find(row => row.id === "tiktok");
  if (!signedInProviderTruth.ok || signedInProviderTruth.summary.total < 10 || !twitchTruth?.connected || !twitchTruth?.tokenStored || !twitchTruth?.canPublish) throw new Error("provider truth did not bank signed-in Twitch success");
  if (!tiktokTruth?.connected || !tiktokTruth?.tokenStored || !tiktokTruth?.canPublish || tiktokTruth.account?.providerAccountId !== "test-tiktok-user-1") throw new Error("provider truth did not prefer and bank the real signed-in TikTok account");
  if (!Array.isArray(signedInProviderTruth.nextProviderActions) || !signedInProviderTruth.nextProviderActions.length || !signedInProviderTruth.nextProviderActions[0].phase || !signedInProviderTruth.nextProviderActions[0].nextAction) throw new Error("provider truth next action ladder missing");
  if (!signedInProviderTruth.bankedSuccesses.some(row => row.id === "twitch" && row.canPublish)) throw new Error("provider truth did not bank Twitch as a success");
  if (!signedInProviderTruth.bankedSuccesses.some(row => row.id === "tiktok" && row.canPublish)) throw new Error("provider truth did not bank TikTok as a success");
  const comingSoonCampaign = await request("/api/campaigns/coming-soon", {
    method: "POST",
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!comingSoonCampaign.ok || comingSoonCampaign.campaign?.title !== "Social Cues Coming Soon Shot") throw new Error("coming-soon campaign endpoint failed");
  const comingSoonPlatforms = new Set((comingSoonCampaign.campaign.variants || []).map(item => item.platform));
  for (const platform of ["facebook", "instagram", "threads", "tiktok", "youtube"]) {
    if (!comingSoonPlatforms.has(platform)) throw new Error(`coming-soon campaign missing ${platform}`);
  }
  if (!comingSoonCampaign.approved?.includes("facebook") || !comingSoonCampaign.drafts?.includes("threads")) throw new Error("coming-soon campaign should approve Facebook and draft blocked lanes");
  const facebookComingSoon = comingSoonCampaign.campaign.variants.find(item => item.platform === "facebook");
  if (facebookComingSoon?.media?.type !== "image" || !/social-cues-coming-soon\.png$/.test(facebookComingSoon.media.hostedUrl || "")) throw new Error("coming-soon Facebook variant should include the hosted coming-soon graphic");
  const comingSoonFacebookDryRun = await request("/api/meta/publish/facebook", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ dryRun: true, message: facebookComingSoon.copy, imageUrl: facebookComingSoon.media.hostedUrl })
  });
  if (!comingSoonFacebookDryRun.ok || comingSoonFacebookDryRun.payload?.url !== facebookComingSoon.media.hostedUrl) throw new Error("Facebook coming-soon dry-run should include the image URL payload");
  const twitchActionCheck = await request("/api/provider/action-check", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ providerId: "twitch" })
  });
  if (!twitchActionCheck.ok || !twitchActionCheck.result?.ok || !["banked", "banked-scope-ready", "banked-live"].includes(twitchActionCheck.result.status)) throw new Error("provider action check did not bank Twitch");
  if (twitchActionCheck.result.liveProbe?.attempted !== true || twitchActionCheck.result.liveProbe?.ok !== false || !/Synthetic test token/i.test(twitchActionCheck.result.liveProbe?.summary || "")) throw new Error("provider action check did not attach bounded Twitch live probe evidence");
  const instagramActionCheck = await request("/api/provider/action-check", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ providerId: "instagram" })
  });
  if (!instagramActionCheck.ok || instagramActionCheck.result?.ok || !["ready-to-connect", "needs-config"].includes(instagramActionCheck.result?.status) || !instagramActionCheck.result?.nextAction) throw new Error("provider action check should keep Instagram unbanked with a next action");
  if (instagramActionCheck.result.liveProbe?.attempted !== false) throw new Error("unconnected provider action check should skip live provider probing");
  const checkedUserModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (checkedUserModel.functionChecks?.twitch?.status !== twitchActionCheck.result.status || checkedUserModel.functionChecks?.instagram?.status !== instagramActionCheck.result.status) throw new Error("provider action checks were not stored in the user workspace");
  if (!checkedUserModel.proof?.some(item => item.metric === "Twitch provider banked")) throw new Error("banked provider action check did not create proof");
  const facebookPublishCheck = await request("/api/provider/publish-check", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ providerId: "facebook" })
  });
  if (!facebookPublishCheck.ok || !facebookPublishCheck.result?.ok || facebookPublishCheck.result?.status !== "dry-run-proven") throw new Error("Facebook provider publish dry-run did not prove");
  if (facebookPublishCheck.result.result?.dryRun !== true || !facebookPublishCheck.result.result?.wouldPost?.message) throw new Error("Facebook provider publish dry-run did not include a safe would-post payload");
  if (!facebookPublishCheck.acceptanceLedger?.rows?.some(row => row.id === "facebook" && row.gates?.publishDryRunProven)) throw new Error("Facebook publish dry-run was not reflected in the acceptance ledger");
  const canvaPublishCheck = await request("/api/provider/publish-check", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ providerId: "canva" })
  });
  if (!canvaPublishCheck.ok || !canvaPublishCheck.result?.ok || canvaPublishCheck.result?.status !== "dry-run-proven") throw new Error(`Canva provider creative handoff dry-run did not prove: ${JSON.stringify(canvaPublishCheck.result)}`);
  if (canvaPublishCheck.result.result?.dryRun !== true || !canvaPublishCheck.result.result?.wouldPost?.outputs?.includes("export-ready social assets")) throw new Error("Canva provider dry-run did not include a safe creative handoff payload");
  const publishCheckedModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!publishCheckedModel.functionChecks?.facebook?.publishProbe?.ok) throw new Error("provider publish check was not stored in the user workspace");
  if (!publishCheckedModel.proof?.some(item => item.metric === "Facebook publish dry-run proven")) throw new Error("provider publish check did not create proof");
  const acceptanceSweep = await request("/api/provider/acceptance-sweep", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({})
  });
  if (!acceptanceSweep.ok || acceptanceSweep.sweep?.summary?.connected < 3) throw new Error("provider acceptance sweep did not inspect connected lanes");
  if (!acceptanceSweep.sweep.results.some(item => item.id === "facebook" && item.publish?.ok)) throw new Error("provider acceptance sweep did not prove Facebook publish dry-run");
  if (!acceptanceSweep.acceptanceLedger?.rows?.some(row => row.id === "facebook" && row.gates?.publishDryRunProven)) throw new Error("provider acceptance sweep did not refresh acceptance ledger proof");
  if (!acceptanceSweep.sweep.taskSync || acceptanceSweep.sweep.taskSync.total < 1 || !acceptanceSweep.sweep.taskSync.synced.some(item => item.id === "instagram")) throw new Error("provider acceptance sweep did not sync provider action tasks");
  const sweepCheckedModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!sweepCheckedModel.functionChecks?.facebook?.publishProbe?.ok || sweepCheckedModel.functionChecks?.facebook?.route !== "/api/provider/acceptance-sweep") throw new Error("provider acceptance sweep was not stored in the user workspace");
  if (!sweepCheckedModel.activity?.some(item => item.type === "provider-acceptance-sweep")) throw new Error("provider acceptance sweep did not create activity evidence");
  const instagramProviderTask = sweepCheckedModel.actions?.find(item => item.type === "Provider task" && item.sourceKey === "provider-ledger:instagram" && item.ownerUserId === login.user.id);
  if (!instagramProviderTask) throw new Error("provider acceptance sweep did not create owned provider tasks");
  if (!instagramProviderTask.providerGate || !instagramProviderTask.checkRoute || !instagramProviderTask.publishCheckRoute || !instagramProviderTask.sweepRoute || !instagramProviderTask.connectRoute || !instagramProviderTask.portalRoute) throw new Error("provider task did not include actionable route metadata");
  if (!instagramProviderTask.callbackUrl?.includes("/api/oauth/instagram/callback") || !instagramProviderTask.portalStatus || !instagramProviderTask.portalNextAction) throw new Error("provider task did not include Instagram callback and portal audit metadata");
  const signedInIntegrationReadiness = await request("/api/integrations/readiness", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!/YouTube connected/i.test(signedInIntegrationReadiness.readiness?.youtube || "") || /Unauthorized/i.test(signedInIntegrationReadiness.readiness?.youtube || "")) throw new Error("signed-in integration readiness did not override stale YouTube failure with provider truth");
  if (!/Facebook connected/i.test(signedInIntegrationReadiness.readiness?.facebook || "") || /No pages returned/i.test(signedInIntegrationReadiness.readiness?.facebook || "")) throw new Error("signed-in integration readiness did not override stale Facebook failure with provider truth");
  if (!/Twitch connected/i.test(signedInIntegrationReadiness.readiness?.twitch || "")) throw new Error("signed-in integration readiness should not hide connected Twitch behind portal gates");
  if (signedInIntegrationReadiness.providerTruth?.summary?.connected < 3) throw new Error("signed-in integration readiness did not use the user workspace provider truth");
  if (!signedInIntegrationReadiness.acceptanceLedger?.summary || !signedInIntegrationReadiness.acceptanceLedger.rows.some(row => row.id === "twitch" && row.gates.oauthConnected)) throw new Error("signed-in integration readiness missing provider acceptance ledger");
  if (!signedInIntegrationReadiness.connectionLog?.summary || !signedInIntegrationReadiness.connectionLog.rows.some(row => row.id === "twitch" && row.steps?.some(step => step.id === "oauth" && step.state === "complete"))) throw new Error("signed-in integration readiness missing provider connection log");
  if (!signedInIntegrationReadiness.providerAssetMap?.summary || !signedInIntegrationReadiness.providerAssetMap.rows.some(row => row.id === "facebook" && row.postingIdentity?.label?.includes(":"))) throw new Error("signed-in integration readiness missing provider asset map with posting identity labels");
  if (!signedInIntegrationReadiness.permissionGaps?.summary || !signedInIntegrationReadiness.permissionGaps.rows.some(row => row.id === "facebook" && row.permissionExplainer?.userMessage)) throw new Error("signed-in integration readiness missing plain-language permission gap explanations");
  const refreshableXModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const refreshableXAccount = refreshableXModel.connectedAccounts?.find(account => account.providerAccountId === "test-x-user-1");
  refreshableXAccount.refreshCredential = "fake-test-refresh-marker";
  refreshableXAccount.tokenExpiresAt = "2026-01-02T00:00:00.000Z";
  await request("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(refreshableXModel)
  });
  const signedInProviderAssetMap = await request("/api/provider/asset-map", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!signedInProviderAssetMap.ok || signedInProviderAssetMap.summary.total < 10) throw new Error("provider asset map failed signed-in workspace proof");
  const facebookAssetMap = signedInProviderAssetMap.rows.find(row => row.id === "facebook");
  const xAssetMap = signedInProviderAssetMap.rows.find(row => row.id === "x");
  if (!facebookAssetMap?.assetKind || !facebookAssetMap?.loginIdentity?.source || !facebookAssetMap?.setupNote || !facebookAssetMap?.postingIdentity?.label?.startsWith("Facebook")) throw new Error("provider asset map did not separate posting identity, login identity, and setup guidance");
  if (!facebookAssetMap?.permissionExplainer?.summary || !facebookAssetMap?.permissionExplainer?.nextAction) throw new Error("provider asset map did not include a plain-language permission explainer");
  if (xAssetMap?.status !== "needs-refresh" || !xAssetMap?.gates?.tokenStored || !xAssetMap?.account?.tokenStored || !["setup", "reconnect"].includes(xAssetMap?.permissionExplainer?.severity)) throw new Error(`expired X token evidence must remain visible as needs-refresh instead of no-token or needs-oauth: ${JSON.stringify(xAssetMap)}`);
  delete refreshableXAccount.refreshCredential;
  delete refreshableXAccount.tokenExpiresAt;
  await request("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(refreshableXModel)
  });
  const signedInPermissionGaps = await request("/api/provider/permission-gaps", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!signedInPermissionGaps.ok || signedInPermissionGaps.summary.total < 10 || !signedInPermissionGaps.rows.some(row => row.id === "facebook" && row.permissionExplainer?.technicalCause)) throw new Error("provider permission gaps endpoint failed signed-in workspace proof");
  const signedInAcceptanceLedger = await request("/api/provider/acceptance-ledger", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!signedInAcceptanceLedger.ok || signedInAcceptanceLedger.summary.total < 10 || !signedInAcceptanceLedger.rows.some(row => row.id === "twitch" && row.gates.devConfigured && row.gates.oauthConnected)) throw new Error("provider acceptance ledger failed signed-in workspace proof");
  if (!signedInAcceptanceLedger.nextProviderActions.some(row => row.id === "instagram")) throw new Error("provider acceptance ledger did not preserve next provider actions");
  const signedInConnectionLog = await request("/api/provider/connection-log", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const twitchConnectionLog = signedInConnectionLog.rows.find(row => row.id === "twitch");
  if (!signedInConnectionLog.ok || signedInConnectionLog.summary.total < 10 || !twitchConnectionLog?.steps?.some(step => step.id === "oauth" && step.state === "complete")) throw new Error("provider connection log failed signed-in workspace proof");
  if (!twitchConnectionLog.recentActivity?.some(item => item.type === "provider-action-check")) throw new Error("provider connection log did not include recent provider activity");
  if (!signedInConnectionLog.nextConnectionActions.some(row => row.id === "instagram" && row.currentStep?.id && row.nextAction)) throw new Error("provider connection log did not preserve next connection actions");
  const signedInOwnershipQueue = await request("/api/provider/ownership-queue", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!signedInOwnershipQueue.ok || signedInOwnershipQueue.summary.total < 10 || !signedInOwnershipQueue.rows.some(row => row.id === "twitch" && row.executable)) throw new Error("provider ownership queue failed signed-in workspace proof");
  const twitchOwnershipRow = signedInOwnershipQueue.rows.find(row => row.id === "twitch");
  if (twitchOwnershipRow?.currentStep?.id !== "read") throw new Error("connected Twitch should be ready to bank a creator-signal read proof before waiting on deeper analytics review");
  if (!signedInOwnershipQueue.next || !signedInOwnershipQueue.next.phase || !Object.prototype.hasOwnProperty.call(signedInOwnershipQueue.summary, "executable")) throw new Error("provider ownership queue did not rank next provider work");
  const signedInOwnershipReport = await request("/api/provider/ownership-report", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!signedInOwnershipReport.ok || !signedInOwnershipReport.markdown?.includes("Social Cues Provider Ownership Report") || !signedInOwnershipReport.sections?.summary || !signedInOwnershipReport.providerOwnershipQueue?.rows?.some(row => row.id === "twitch")) throw new Error("provider ownership report failed signed-in workspace proof");
  const signedInOwnershipReportMarkdownResponse = await fetch(base + "/api/provider/ownership-report?format=markdown", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const signedInOwnershipReportMarkdown = await signedInOwnershipReportMarkdownResponse.text();
  if (!signedInOwnershipReportMarkdownResponse.ok || !signedInOwnershipReportMarkdown.includes("# Social Cues Provider Ownership Report") || !signedInOwnershipReportMarkdown.includes("## Executable Now")) throw new Error("provider ownership markdown report failed");
  const twitchOwnershipRun = await request("/api/provider/ownership-run", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ providerId: "twitch" })
  });
  if (!twitchOwnershipRun.ok || twitchOwnershipRun.providerId !== "twitch" || !twitchOwnershipRun.readResult || !twitchOwnershipRun.publishProbe || !twitchOwnershipRun.providerOwnershipQueue?.rows?.some(row => row.id === "twitch")) throw new Error("provider ownership run did not return read, publish, queue, and provider evidence");
  const ownershipRunModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (ownershipRunModel.functionChecks?.twitch?.route !== "/api/provider/ownership-run" || !ownershipRunModel.activity?.some(item => item.type === "provider-ownership-run")) throw new Error("provider ownership run was not stored in the user workspace");
  const ownershipSweep = await request("/api/provider/ownership-sweep", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ limit: 5 })
  });
  if (!ownershipSweep.ok || !ownershipSweep.summary || !Array.isArray(ownershipSweep.results) || !ownershipSweep.providerOwnershipQueue?.rows || !ownershipSweep.ownershipReport?.markdown?.includes("Social Cues Provider Ownership Report")) throw new Error("provider ownership sweep did not return checked results, refreshed queue, and report");
  const sweepModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!sweepModel.activity?.some(item => item.type === "provider-ownership-sweep")) throw new Error("provider ownership sweep was not stored in the user workspace");
  if (sweepModel.actions?.some(item => item.providerId === "twitch" && item.status === "active" && (item.providerGate === "oauthConnected" || /connect (oauth|account|provider)/i.test(item.title || "")))) throw new Error("provider task reconciliation left a stale Twitch connect task active after OAuth was proven");
  const signedInProviderContracts = await request("/api/provider/contracts", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!signedInProviderContracts.ok || signedInProviderContracts.summary.total < 10 || !Array.isArray(signedInProviderContracts.nextContractActions)) throw new Error("provider contracts failed signed-in workspace proof");
  const twitchContract = signedInProviderContracts.rows.find(row => row.id === "twitch");
  if (!twitchContract?.gates?.envReady || !twitchContract?.gates?.oauthConnected || !Object.prototype.hasOwnProperty.call(twitchContract.gates, "publishDryRunProven")) throw new Error("provider contracts missing Twitch ownership gates");
  if (!twitchContract.gates.analyticsLaneReady) throw new Error("connected Twitch should expose its Helix creator-signal read lane as analytics/read ready");
  if (!signedInProviderContracts.nextContractActions.some(row => row.id === "instagram" && row.missing?.includes("oauthConnected"))) throw new Error("provider contracts did not preserve missing ownership gates");
  const twitchContractCheck = await request("/api/provider/contract-check", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ providerId: "twitch" })
  });
  if (!twitchContractCheck.ok || !twitchContractCheck.readResult || !twitchContractCheck.publishProbe || !twitchContractCheck.providerContracts?.rows?.some(row => row.id === "twitch")) throw new Error("provider contract check did not return read, publish, and refreshed contract evidence");
  const contractCheckedModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (contractCheckedModel.functionChecks?.twitch?.route !== "/api/provider/contract-check" || !contractCheckedModel.activity?.some(item => item.type === "provider-contract-check")) throw new Error("provider contract check was not stored in the user workspace");
  const dailyLoopStatusBefore = await request("/api/provider/daily-loop/status", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!dailyLoopStatusBefore.ok || dailyLoopStatusBefore.lastRun || dailyLoopStatusBefore.providerContracts?.summary?.total < 10) throw new Error("daily loop status before first run should expose contracts without a last run");
  const dailyLoop = await request("/api/provider/daily-loop", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ includeFuture: true, live: false })
  });
  if (!dailyLoop.ok || !dailyLoop.sweep?.summary || !dailyLoop.publishQueue || !dailyLoop.analytics?.summary || !dailyLoop.providerContracts?.rows?.some(row => row.id === "twitch")) throw new Error("daily provider ownership loop did not return sweep, publish dry-run, analytics, and contract evidence");
  const dailyLoopStatusAfter = await request("/api/provider/daily-loop/status", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!dailyLoopStatusAfter.ok || !dailyLoopStatusAfter.lastRun || dailyLoopStatusAfter.runCount < 1 || dailyLoopStatusAfter.providerContracts?.summary?.total < 10) throw new Error("daily loop status after run did not expose the latest run and contract summary");
  const dailyLoopModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const dailyAnalyticsStored = Boolean(
    dailyLoopModel.analytics?.lastCompiledAt
    || dailyLoopModel.analytics?.status === "Waiting for connected accounts"
  );
  if (!dailyLoopModel.activity?.some(item => item.type === "daily-provider-ownership-loop") || !dailyAnalyticsStored) throw new Error("daily provider ownership loop was not stored in the user workspace");

  const secondEmail = `alpha-second-${Date.now()}@socialcuesapp.com`;
  const secondSignup = await request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Second Tester", email: secondEmail, password: accountPassword, promoCode: "SC-LOCAL-SIGNAL-9X2P", workspaceName: "Second Workspace" })
  });
  if (!secondSignup.ok || !secondSignup.session?.token) throw new Error("second signup failed");
  const secondUserModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${secondSignup.session.token}` }
  });
  if (secondUserModel.currentUser?.email !== secondEmail) throw new Error("signed-in model returned the wrong second user");
  if (secondUserModel.workspace?.name !== "Second Workspace") throw new Error("second user received another user's workspace identity");
  if ((secondUserModel.campaigns || []).some(item => item.id === "camp-Social Cues-self-launch" || item.title === "Social Cues Customer-Ready Launch")) throw new Error("second user inherited the internal Social Cues launch campaign");
  if ((secondUserModel.campaigns || []).some(item => firstUserCampaignIds.has(item.id))) throw new Error("second user can see first user campaigns");
  if ((secondUserModel.connectedAccounts || []).some(item => item.ownerUserId === login.user.id)) throw new Error("second user can see first user accounts");
  if (blankWorkspaceCollections.some(key => (secondUserModel[key] || []).length) || secondUserModel.activeCampaignId || (secondUserModel.analytics?.metrics || []).length) {
    throw new Error("new second-user workspace was not completely blank");
  }
  const secondTwitchReady = await request("/api/twitch/readiness", {
    headers: { Authorization: `Bearer ${secondSignup.session.token}` }
  });
  if (secondTwitchReady.account) throw new Error("second user can see first user's Twitch account");
  const secondProviderTruth = await request("/api/provider/truth", {
    headers: { Authorization: `Bearer ${secondSignup.session.token}` }
  });
  if (secondProviderTruth.rows.find(row => row.id === "twitch")?.connected) throw new Error("second user's provider truth can see first user's Twitch connection");
  if (secondProviderTruth.bankedSuccesses.some(row => row.id === "twitch")) throw new Error("second user's banked successes can see first user's Twitch connection");
  const secondConnectionLog = await request("/api/provider/connection-log", {
    headers: { Authorization: `Bearer ${secondSignup.session.token}` }
  });
  if (secondConnectionLog.rows.find(row => row.id === "twitch")?.steps?.some(step => step.id === "oauth" && step.state === "complete")) throw new Error("second user's connection log can see first user's Twitch proof");
  const secondOwnershipQueue = await request("/api/provider/ownership-queue", {
    headers: { Authorization: `Bearer ${secondSignup.session.token}` }
  });
  if (secondOwnershipQueue.rows.find(row => row.id === "twitch")?.executable) throw new Error("second user's ownership queue can execute first user's Twitch proof");

  const ownedYouTubeStart = await fetch(base + "/api/oauth/youtube/start", {
    redirect: "manual",
    headers: { Authorization: `Bearer ${secondSignup.session.token}` }
  });
  if (ownedYouTubeStart.status !== 302) throw new Error("signed-in youtube start should redirect to Google");
  const ownedYouTubeAuthUrl = new URL(ownedYouTubeStart.headers.get("location"));
  const ownedYouTubeState = ownedYouTubeAuthUrl.searchParams.get("state");
  if (!ownedYouTubeState) throw new Error("signed-in youtube start did not issue OAuth state");
  const ownedYouTubeCallback = await fetch(base + `/api/oauth/youtube/callback?code=fake-code&state=${encodeURIComponent(ownedYouTubeState)}`);
  const oauthReturnCookie = ownedYouTubeCallback.headers.get("set-cookie") || "";
  const ownedYouTubeCallbackText = await ownedYouTubeCallback.text();
  if (ownedYouTubeCallback.status !== 200 || !ownedYouTubeCallbackText.includes("YouTube token exchange failed")) throw new Error("owned youtube callback should handle the provider return");
  if (!oauthReturnCookie.includes("sc_session=") || !oauthReturnCookie.includes("HttpOnly")) throw new Error("owned provider callback did not renew the app session cookie");
  const renewedSessionResponse = await fetch(base + "/api/auth/session", {
    headers: { Cookie: oauthReturnCookie.split(";")[0] }
  });
  const renewedSession = await renewedSessionResponse.json();
  if (!renewedSessionResponse.ok || renewedSession.user?.email !== secondEmail || renewedSession.device?.sessionProvider !== "oauth-return") throw new Error("OAuth return cookie did not restore the signed-in workspace session");

  const generated = await request("/api/generate/platform-variants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ campaign: { ...model.campaigns[0], destinationUrl: "https://socialcuesapp.com", destinationCta: "learn_more" }, contentLanguage: "es", locale: "es" })
  });
  const expectedPlatforms = ["tiktok", "instagram", "threads", "youtube", "facebook", "x", "google_growth", "google_business", "pinterest", "canva", "shopify", "etsy", "linkedin", "patreon", "twitch", "discord", "manychat", "reddit"];
  if (!generated.ok || generated.variants.length !== expectedPlatforms.length) throw new Error("generation failed");
  const generatedPlatforms = new Set(generated.variants.map(item => item.platform));
  if (expectedPlatforms.some(platform => !generatedPlatforms.has(platform))) throw new Error("generation missed an active platform");
  if (generated.variants.some(item => !String(item.copy || "").trim())) throw new Error("generation returned a blank platform copy");
  if (generated.variants.some(item => item.language !== "es" || item.locale !== "es")) throw new Error("generation did not preserve language settings");
  const instagramGenerated = generated.variants.find(item => item.platform === "instagram");
  const facebookGenerated = generated.variants.find(item => item.platform === "facebook");
  if (instagramGenerated?.destination?.placement !== "profile" || !/link in (our )?profile/i.test(instagramGenerated.copy || "")) throw new Error("Instagram generation must use profile-link wording instead of an ineffective caption URL");
  if (facebookGenerated?.destination?.placement !== "caption" || !String(facebookGenerated?.copy || "").includes("https://socialcuesapp.com")) throw new Error("link-friendly platform generation must include the selected destination URL");

  const openaiUsage = await request("/api/openai/usage", { headers: { Authorization: `Bearer ${login.session.token}` } });
  if (!openaiUsage.ok || !openaiUsage.serverSideOnly || !openaiUsage.usage?.limits) throw new Error("workspace OpenAI allowance route failed");

  const adDraft = await request("/api/ads/drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ provider: "meta", title: "Readiness campaign", objective: "Awareness", audience: "Existing test audience", creative: "Approved launch creative direction", dailyBudget: 0, live: false })
  });
  if (!adDraft.ok || adDraft.draft?.status !== "draft-only" || adDraft.draft?.launchApproved !== false) throw new Error("guarded paid campaign draft failed");
  const adDrafts = await request("/api/ads/drafts", { headers: { Authorization: `Bearer ${login.session.token}` } });
  if (!adDrafts.ok || !adDrafts.drafts?.some(item => item.id === adDraft.draft.id)) throw new Error("workspace paid campaign draft list failed");

  const queued = await request("/api/publish/social-cues/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variant: generated.variants[0] })
  });
  if (!queued.ok || queued.provider !== "social-cues-queue") throw new Error("queue failed");
  if (queued.status === "queued-local-simulation") throw new Error("queue returned demo simulation status");

  const scheduledModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  scheduledModel.campaigns = Array.isArray(scheduledModel.campaigns) ? scheduledModel.campaigns : [];
  if (!scheduledModel.campaigns.length) {
    scheduledModel.campaigns.push({
      id: `campaign-scheduled-${Date.now()}`,
      title: "Scheduled publish smoke campaign",
      brief: "Confirm Social Cues can inspect scheduled posts safely.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      variants: []
    });
    scheduledModel.activeCampaignId = scheduledModel.campaigns[0].id;
  }
  const scheduledCampaign = scheduledModel.campaigns?.[0];
  if (!scheduledCampaign?.id) throw new Error("scheduled publish test needs a user campaign");
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  scheduledCampaign.variants = [
    ...(scheduledCampaign.variants || []),
    {
      id: `queued-facebook-${Date.now()}`,
      platform: "facebook",
      status: "approved",
      scheduledFor: dueAt,
      queuedAt: dueAt,
      copy: "Social Cues scheduled Facebook smoke test.",
      source: "automated-test"
    },
    {
      id: `queued-youtube-${Date.now()}`,
      platform: "youtube",
      status: "queued",
      scheduledFor: dueAt,
      copy: "Social Cues scheduled YouTube smoke test.",
      title: "Social Cues YouTube smoke test",
      source: "automated-test"
    }
  ];
  await request("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(scheduledModel)
  });
  const duePublish = await request("/api/publish/due", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ includeFuture: true, live: false, platforms: ["facebook", "youtube"] })
  });
  if (!duePublish.ok || duePublish.provider !== "social-cues-queue" || duePublish.attempted < 2) throw new Error("due publish queue did not inspect scheduled variants");
  if (!duePublish.results.some(item => item.platform === "facebook") || !duePublish.results.some(item => item.platform === "youtube")) throw new Error("due publish queue missed Meta or YouTube variants");
  if (!duePublish.results.every(item => item.dryRun === true || item.status === "blocked")) throw new Error("due publish dry run should only report dry runs or blockers");
  if (!duePublish.results.filter(item => item.dryRun === true).every(item => item.providerAccountId)) throw new Error("due publish dry-run results must name the selected provider identity");
  if (!duePublish.publishQueue?.summary || !duePublish.providerState?.summary) throw new Error("due publish dry run should return durable queue and provider-state snapshots");

  const historicalModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const historicalCampaign = historicalModel.campaigns.find(item => item.id === scheduledCampaign.id) || historicalModel.campaigns[0];
  const historicalAt = new Date().toISOString();
  const historicalPublishedId = `published-facebook-${Date.now()}`;
  const historicalBlockedId = `blocked-tiktok-${Date.now()}`;
  historicalCampaign.variants.push(
    {
      id: historicalPublishedId,
      platform: "facebook",
      status: "published",
      scheduledFor: dueAt,
      publishedAt: historicalAt,
      updatedAt: historicalAt,
      providerPostId: "provider-history-test",
      copy: "Published history smoke test."
    },
    {
      id: historicalBlockedId,
      platform: "tiktok",
      status: "blocked",
      scheduledFor: dueAt,
      blockedAt: historicalAt,
      updatedAt: historicalAt,
      copy: "Blocked history smoke test."
    }
  );
  await request("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(historicalModel)
  });

  const publishQueue = await request("/api/publish/queue", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!publishQueue.ok || publishQueue.summary?.total < 2 || !publishQueue.rows?.some(item => item.platform === "facebook")) throw new Error("durable publish queue did not persist scheduled provider items");
  if (!publishQueue.rows.some(item => item.variantId === historicalPublishedId && item.status === "published") || !publishQueue.rows.some(item => item.variantId === historicalBlockedId && item.status === "blocked")) throw new Error("publish queue must retain terminal provider history from campaign variants");
  if (publishQueue.summary.dueNow >= publishQueue.summary.total) throw new Error("published and blocked history must not be counted as due work");

  const providerStateSnapshot = await request("/api/provider/state", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!providerStateSnapshot.ok || providerStateSnapshot.summary?.total < expectedPlatforms.length || providerStateSnapshot.summary?.publishQueue?.total < 2) throw new Error("provider state snapshot did not include provider rows and publish queue truth");

  const analyticsSnapshots = await request("/api/analytics/snapshots", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!analyticsSnapshots.ok || analyticsSnapshots.summary?.total < 1 || !analyticsSnapshots.rows?.length) throw new Error("analytics snapshots did not persist after publish/analyze work");

  const automationStatus = await request("/api/automation/status", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!automationStatus.ok || !automationStatus.lanes?.some(row => row.id === "publishing") || !automationStatus.capabilities?.some(row => row.id === "analyze")) throw new Error("customer automation center did not expose background lanes and capability truth");
  if (automationStatus.summary?.automaticWorkers !== 0 || !/automatic worker status is unavailable/i.test(automationStatus.truthNote || "")) throw new Error("local automation center must distinguish unavailable worker status from a live dispatcher");
  const publishCapability = automationStatus.capabilities.find(row => row.id === "publish");
  if (publishCapability?.providers?.some(name => ["Shopify", "Twitch", "Etsy", "Canva"].includes(name))) throw new Error("automation center must not describe context or creative-handoff providers as live publishers");

  const pausedAutomation = await request("/api/automation/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ livePublishingPaused: true })
  });
  if (!pausedAutomation.ok || pausedAutomation.preferences?.livePublishingPaused !== true) throw new Error("live publishing pause control was not persisted");
  const pausedLivePublish = await fetch(base + "/api/publish/due", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ includeFuture: true, live: true, approved: true, confirm: "PUBLISH_APPROVED_QUEUE" })
  });
  const pausedLivePublishBody = await pausedLivePublish.json();
  if (pausedLivePublish.status !== 409 || pausedLivePublishBody.paused !== true) throw new Error("paused live publishing was not enforced by the backend");
  const resumedAutomation = await request("/api/automation/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ livePublishingPaused: false })
  });
  if (!resumedAutomation.ok || resumedAutomation.preferences?.livePublishingPaused !== false) throw new Error("live publishing pause control did not resume");

  const proof = await request("/api/proof", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ type: "Test", metric: "API smoke test", note: "Automated local validation." })
  });
  if (!proof.ok) throw new Error("proof failed");

  const action = await request("/api/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ type: "Experiment", priority: "High", title: "Smoke-test action", signal: "API accepts action creation." })
  });
  if (!action.ok || !action.action.id) throw new Error("action create failed");

  const won = await request(`/api/actions/${encodeURIComponent(action.action.id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ status: "won" })
  });
  if (!won.ok || won.action.status !== "won") throw new Error("action update failed");

  const actions = await request("/api/actions", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!actions.ok || !Array.isArray(actions.actions)) throw new Error("action list failed");

  const readiness = await request("/api/integrations/readiness");
  if (!readiness.ok) throw new Error("readiness failed");
  const manychatReadiness = await request("/api/manychat/readiness");
  if (!manychatReadiness.ok || manychatReadiness.isolation?.crossCustomerSharing !== false || !manychatReadiness.routes?.includes("/api/manychat/connect") || !manychatReadiness.routes?.includes("/api/manychat/profile/connect") || !manychatReadiness.routes?.includes("/api/manychat/template-link")) throw new Error("Manychat readiness should expose tenant isolation and separate account/profile connection routes");
  const elevenlabsReadiness = await request("/api/elevenlabs/readiness");
  if (!elevenlabsReadiness.ok || elevenlabsReadiness.ready || !elevenlabsReadiness.routes?.includes("/api/elevenlabs/connect") || !elevenlabsReadiness.requiredKeyAccess?.includes("Text to Speech: Access") || !elevenlabsReadiness.connectionModel?.includes("API key")) throw new Error("ElevenLabs readiness should expose a disconnected restricted-key connection without importing provider credentials");

  const metaStatus = await request("/api/oauth/meta/status");
  if (!metaStatus.ok || !metaStatus.redirectUri.includes("/api/oauth/meta/callback")) throw new Error("meta status failed");
  if (!metaStatus.deauthorizeUri?.includes("/api/meta/deauthorize")) throw new Error("meta status should expose the Meta deauthorize callback URL");
  if (metaStatus.scopes.includes("business_management")) throw new Error("meta default login should not request business_management for non-business Page flow");
  if (!metaStatus.platformScopes?.instagram?.includes("instagram_business_basic") || !metaStatus.platformScopes?.instagram?.includes("instagram_business_content_publish") || !metaStatus.platformScopes?.instagram?.includes("instagram_business_manage_messages")) throw new Error("Instagram OAuth should request current Instagram Login business scopes");
  if (metaStatus.platformScopes?.instagram?.includes("instagram_basic") || metaStatus.platformScopes?.instagram?.includes("instagram_content_publish")) throw new Error("Instagram OAuth must not request legacy scopes that Meta rejects for Instagram Login");
  if (metaStatus.platformScopes?.facebook?.includes("pages_manage_posts")) throw new Error("meta Facebook OAuth should not request pages_manage_posts before App Review approval");
  if (!metaStatus.facebookDashboardScopes?.includes("pages_manage_posts")) throw new Error("meta status should expose Facebook publish review scopes separately");
  if (!metaStatus.facebookTestingScopes?.includes("pages_manage_posts") || !metaStatus.facebookTestingReconnectPath?.includes("testing=pages")) throw new Error("meta status should expose the alpha Page testing reconnect path");
  if (!metaStatus.instagramDashboardScopes?.includes("instagram_business_basic") || !metaStatus.instagramLogin?.redirectUri?.includes("/api/oauth/instagram/callback")) throw new Error("meta status should expose Instagram Login dashboard/review scopes and callback separately");
  if (metaStatus.instagramLogin?.authorizeEndpoint !== "https://www.instagram.com/oauth/authorize") throw new Error("Instagram Login status should expose the Business Login authorize endpoint");
  if (metaStatus.instagramLogin?.tokenEndpoint !== "https://api.instagram.com/oauth/access_token" || metaStatus.instagramLogin?.refreshTokenEndpoint !== "https://graph.instagram.com/refresh_access_token") throw new Error("Instagram Login status should expose token and refresh endpoints");
  if (metaStatus.instagramLogin?.configured || !metaStatus.instagramLogin?.missingEnv?.includes("INSTAGRAM_APP_ID") || !metaStatus.instagramLogin?.invalidPlatformAppHint?.includes("Invalid platform app")) throw new Error("Instagram Login must not silently fall back to Meta app credentials");
  if (serverSource.includes('INSTAGRAM_APP_ID: ["INSTAGRAM_CLIENT_ID", "INSTAGRAM_OAUTH_CLIENT_ID", "IG_APP_ID", "IG_CLIENT_ID", "META_APP_ID"') || serverSource.includes('const instagramAppId = envValue("INSTAGRAM_APP_ID", metaAppId)')) throw new Error("Instagram app credentials must not alias or fall back to META_APP_ID");

  const metaStartResponse = await fetch(base + "/api/oauth/meta/start?platform=instagram", { redirect: "manual" });
  if (metaStartResponse.status !== 302 || !(metaStartResponse.headers.get("location") || "").includes("/api/oauth/instagram/start")) throw new Error("legacy Meta Instagram start should redirect into direct Instagram Login");

  const instagramStartResponse = await fetch(base + "/api/oauth/instagram/start", { redirect: "manual" });
  if (![200, 302].includes(instagramStartResponse.status)) throw new Error("instagram start failed");
  if (instagramStartResponse.status === 200) {
    const instagramStartText = await instagramStartResponse.text();
    if (!instagramStartText.includes("Instagram Platform app credentials needed") && !instagramStartText.includes("HTTPS callback needed")) throw new Error("instagram start setup guidance failed");
    if (!instagramStartText.includes("Invalid platform app") || !instagramStartText.includes("INSTAGRAM_APP_ID")) throw new Error("instagram start should explain the invalid platform app credential root cause");
  } else {
    const location = instagramStartResponse.headers.get("location") || "";
    if (!location.includes("www.instagram.com") || !location.includes("/oauth/authorize")) throw new Error("instagram start redirect failed");
    const instagramStartUrl = new URL(location);
    if (instagramStartUrl.searchParams.get("enable_fb_login") !== "0") throw new Error("instagram start should use direct Instagram login rather than Facebook fallback");
    if (instagramStartUrl.searchParams.get("force_authentication") !== "1") throw new Error("instagram start should force the account selector");
    if (!instagramStartUrl.searchParams.get("version")) throw new Error("instagram start should pin the Instagram API version");
    const requestedScopes = instagramStartUrl.searchParams.get("scope") || "";
    if (!requestedScopes.includes("instagram_business_basic") || !requestedScopes.includes("instagram_business_content_publish") || !requestedScopes.includes("instagram_business_manage_messages")) throw new Error("instagram start should request Instagram Login business scopes");
  }

  const metaFacebookStartResponse = await fetch(base + "/api/oauth/meta/start?platform=facebook", { redirect: "manual" });
  if (![200, 302].includes(metaFacebookStartResponse.status)) throw new Error("facebook meta start failed");
  if (metaFacebookStartResponse.status === 302) {
    const location = metaFacebookStartResponse.headers.get("location") || "";
    const facebookStartUrl = new URL(location);
    const requestedScopes = facebookStartUrl.searchParams.get("scope") || "";
    if (requestedScopes.includes("pages_manage_posts")) throw new Error("facebook Meta start should not request pages_manage_posts before App Review approval");
    if (facebookStartUrl.searchParams.get("auth_type") !== "rerequest") throw new Error("facebook Meta start should force a permission re-prompt");
  }

  const metaFacebookTestingStartResponse = await fetch(base + "/api/oauth/meta/start?platform=facebook&testing=pages", { redirect: "manual" });
  if (![200, 302].includes(metaFacebookTestingStartResponse.status)) throw new Error("facebook meta testing start failed");
  if (metaFacebookTestingStartResponse.status === 302) {
    const location = metaFacebookTestingStartResponse.headers.get("location") || "";
    const facebookTestingStartUrl = new URL(location);
    const requestedScopes = facebookTestingStartUrl.searchParams.get("scope") || "";
    if (!requestedScopes.includes("pages_manage_posts") || !requestedScopes.includes("pages_manage_metadata") || !requestedScopes.includes("business_management")) throw new Error("facebook testing Meta start should request Ready for testing Page scopes");
    if (facebookTestingStartUrl.searchParams.get("enable_profile_selector") !== "1") throw new Error("facebook testing Meta start should force account/page selection");
  }

  const threadsStatus = await request("/api/oauth/threads/status");
  if (!threadsStatus.ok || !threadsStatus.redirectUri.includes("/api/oauth/threads/callback")) throw new Error("threads status failed");
  for (const scope of ["threads_content_publish", "threads_manage_insights", "threads_manage_mentions", "threads_manage_replies", "threads_read_replies", "threads_keyword_search", "threads_profile_discovery", "threads_location_tagging", "threads_share_to_instagram"]) {
    if (!threadsStatus.scopes.includes(scope)) throw new Error(`threads status missing ${scope}`);
  }
  if (!threadsStatus.blockedRedirectFix?.exactValue?.endsWith("/api/oauth/threads/callback") || threadsStatus.blockedRedirectFix.errorCode !== 1349168) throw new Error("threads redirect whitelist guidance missing");
  if (!serverSource.includes("Threads /me returned no provider account id") || !serverSource.includes("Threads workspace could not be recovered")) throw new Error("threads callback must fail closed without provider identity or workspace owner");

  const youtubeStatus = await request("/api/oauth/youtube/status");
  if (!youtubeStatus.scopes.includes("https://www.googleapis.com/auth/youtube.force-ssl")) throw new Error("youtube status should request comment management scope");
  if (!serverSource.includes('"/api/youtube/comments/reply"') || !serverSource.includes('"/api/youtube/comments/moderate"')) throw new Error("youtube comment reply and moderation routes missing");
  if (!appHtml.includes("data-youtube-comment-reply") || !appHtml.includes("data-youtube-comment-moderate")) throw new Error("reaction inbox should expose YouTube reply and moderation controls");
  for (const route of ["/api/threads/reactions", "/api/threads/insights", "/api/threads/search", "/api/threads/replies/respond", "/api/threads/replies/moderate"]) {
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`Threads reaction route missing: ${route}`);
  }
  if (!appHtml.includes("data-threads-comment-reply") || !appHtml.includes("data-threads-comment-moderate")) throw new Error("reaction inbox should expose Threads reply and moderation controls");
  if (!appHtml.includes("Live Threads Insights API") || !appHtml.includes('authedFetch("/api/threads/insights")')) throw new Error("growth should render live Threads insights with explicit source attribution");
  for (const route of ["/api/x/engagement", "/api/x/replies"]) {
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`X interaction route missing: ${route}`);
  }
  if (!appHtml.includes("data-x-comment-reply")) throw new Error("reaction inbox should expose X reply controls when the API plan returns mentions");

  const xStatus = await request("/api/oauth/x/status");
  if (!xStatus.ok || !xStatus.redirectUri.includes("/api/oauth/x/callback") || !xStatus.scopes.includes("tweet.read") || !xStatus.scopes.includes("users.read")) throw new Error("x status failed");
  if (xStatus.scopes.includes("tweet.write")) throw new Error("x default OAuth should be read-first so login is not blocked by write permission setup");
  if (!xStatus.writeScopes?.includes("tweet.write") || !xStatus.writeConnectPath?.includes("mode=write")) throw new Error("x status should expose a separate write-permission upgrade path");
  if (xStatus.oauthRequestRules?.stateMaxLength !== 500 || xStatus.oauthRequestRules?.stateMode !== "short-server-stored-nonce" || xStatus.oauthRequestRules?.scopeEncoding !== "%20") throw new Error("x status should expose the invalid-request hardening rules");
  if (!Array.isArray(xStatus.capabilityLanes) || !xStatus.capabilityLanes.some(lane => lane.id === "post-create" && ["ready-to-request", "needs-config"].includes(lane.status))) throw new Error("x capability lanes missing post-create readiness");
  if (!xStatus.capabilityLanes.some(lane => lane.id === "media-upload" && (lane.status.includes("gated") || lane.status === "needs-config"))) throw new Error("x capability lanes should keep media upload gated");
  if (!xStatus.browserStateFix?.stuckUrlPattern?.includes("/i/jf/onboarding/web/sso") || !xStatus.browserStateFix?.callbackUrl?.includes("/api/oauth/x/callback")) throw new Error("x SSO/onboarding stuck guidance missing");

  const pinterestStatus = await request("/api/oauth/pinterest/status");
  if (!pinterestStatus.ok || !pinterestStatus.redirectUri.includes("/api/oauth/pinterest/callback") || !pinterestStatus.scopes.includes("pins:write")) throw new Error("pinterest status failed");
  if (!pinterestStatus.configured || pinterestStatus.missingEnv?.includes("PINTEREST_APP_ID") || pinterestStatus.missingEnv?.includes("PINTEREST_APP_SECRET")) throw new Error("pinterest alias credentials were not recognized");
  if (pinterestStatus.accessTier !== "trial" || pinterestStatus.reviewStatus !== "oauth-ready") throw new Error("pinterest readiness should report the verified Trial tier and credential-backed OAuth state");
  if (!Array.isArray(pinterestStatus.capabilityLanes) || !pinterestStatus.capabilityLanes.some(lane => lane.id === "approved_pin_drafts")) throw new Error("pinterest status missing trial content capability lanes");
  if (!String(pinterestStatus.trialRateLimit || "").includes("1000/day")) throw new Error("pinterest status should expose portal-observed trial rate limit");
  if (/trial-access-pending|wait for review to release app secret/i.test(`${serverSource}\n${appHtml}`)) throw new Error("pinterest UI and readiness must not repeat stale portal guidance after Trial access and the secret control were verified");

  const canvaStatus = await request("/api/oauth/canva/status");
  if (!canvaStatus.ok || !canvaStatus.redirectUri.includes("/api/oauth/canva/callback") || !canvaStatus.scopes.includes("design:meta:read") || !canvaStatus.scopes.includes("profile:read") || !canvaStatus.scopes.includes("design:content:write")) throw new Error("canva status failed");
  if (!Array.isArray(canvaStatus.capabilityLanes) || !canvaStatus.capabilityLanes.some(lane => lane.id === "folder_organization") || !canvaStatus.capabilityLanes.some(lane => lane.id === "brand_templates") || !canvaStatus.capabilityLanes.some(lane => lane.id === "user_profile")) throw new Error("canva status missing expanded creative capability lanes");
  if (!canvaStatus.configured || canvaStatus.missingEnv?.includes("CANVA_CLIENT_ID") || canvaStatus.missingEnv?.includes("CANVA_CLIENT_SECRET")) throw new Error("canva alias credentials were not recognized");
  if (!canvaStatus.portalReadiness?.connectApi?.mfaRequired || !canvaStatus.portalReadiness?.appsSdkShell?.reviewBlockers?.some(item => item.includes("Translation JSON"))) throw new Error("canva status should expose portal-observed MFA and Apps SDK review blockers");

  const shopifyStatus = await request("/api/oauth/shopify/status");
  if (!shopifyStatus.ok || !shopifyStatus.redirectUri.includes("/api/oauth/shopify/callback") || !shopifyStatus.scopes.includes("read_products")) throw new Error("shopify status failed");
  if (!shopifyStatus.configured || shopifyStatus.missingEnv?.includes("SHOPIFY_CLIENT_ID") || shopifyStatus.missingEnv?.includes("SHOPIFY_CLIENT_SECRET")) throw new Error("shopify alias credentials were not recognized");

  const etsyStatus = await request("/api/oauth/etsy/status");
  if (!etsyStatus.ok || !etsyStatus.redirectUri.includes("/api/oauth/etsy/callback") || !etsyStatus.scopes.includes("listings_r")) throw new Error("etsy status failed");
  if (!etsyStatus.scopes.includes("transactions_r") || !Array.isArray(etsyStatus.capabilityLanes) || !etsyStatus.capabilityLanes.some(lane => lane.id === "sales_receipts")) throw new Error("etsy status missing receipt/sales capability lane");
  if (!etsyStatus.configured || etsyStatus.missingEnv?.includes("ETSY_CLIENT_ID") || etsyStatus.missingEnv?.includes("ETSY_CLIENT_SECRET")) throw new Error("etsy alias credentials were not recognized");
  if (!Object.prototype.hasOwnProperty.call(etsyStatus, "apiCredentialReady") || !Array.isArray(etsyStatus.missingApiEnv)) throw new Error("etsy status should separate OAuth readiness from shared-secret API readiness");
  if (!etsyStatus.blockedRedirectFix?.exactValue?.endsWith("/api/oauth/etsy/callback") || !String(etsyStatus.blockedRedirectFix?.symptom || "").includes("requested redirect URL")) throw new Error("etsy redirect-not-permitted guidance missing");
  if (!serverSource.includes('if (!etsyClientId)') || !serverSource.includes("OAuth can connect with the keystring and PKCE")) throw new Error("etsy start should allow OAuth with keystring while gating API reads on shared secret");
  if (!serverSource.includes('instagram: { connect: "/api/oauth/instagram/start"') || !serverSource.includes("function instagramOAuthUrl") || !serverSource.includes("async function exchangeInstagramCode")) throw new Error("Instagram account connect should use direct Instagram Login with token exchange");
  if (!serverSource.includes("function cleanOAuthCode") || !serverSource.includes("code: cleanOAuthCode(code)") || !serverSource.includes("www.instagram.com/oauth/authorize")) throw new Error("Instagram OAuth should use Business Login and clean returned codes before token exchange");
  if (!serverSource.includes("maybeRefreshInstagramAccountToken") || !serverSource.includes("/refresh_access_token") || !serverSource.includes("ig_refresh_token")) throw new Error("Instagram direct-login tokens should refresh before expiry");
  if (!serverSource.includes("waitForInstagramContainer") || !serverSource.includes('status_code"') || !serverSource.includes('"FINISHED"') || !serverSource.includes("media_publish")) throw new Error("Instagram publishing should poll container status before media_publish");
  if (!serverSource.includes("createInstagramMediaContainer") || !serverSource.includes("publishInstagramMediaContainer") || !serverSource.includes('instagramLoginMeGraph(account, "/media"') || !serverSource.includes('instagramLoginMeGraph(account, "/media_publish"')) throw new Error("Instagram direct-login publishing should fallback to /me media endpoints when account-id publishing fails");

  const twitchStatus = await request("/api/oauth/twitch/status");
  if (!twitchStatus.ok || !twitchStatus.redirectUri.includes("/api/oauth/twitch/callback") || !twitchStatus.scopes.includes("user:read:email") || !twitchStatus.developerReviewStatus) throw new Error("twitch status failed");

  const tiktokStatus = await request("/api/oauth/tiktok/status");
  if (!tiktokStatus.ok || !tiktokStatus.redirectUri.includes("/api/oauth/tiktok/callback") || !tiktokStatus.scopes.includes("user.info.basic")) throw new Error("tiktok status failed");
  if (!Array.isArray(tiktokStatus.capabilityLanes) || !tiktokStatus.capabilityLanes.some(lane => lane.id === "login-kit" && lane.status === "ready-to-request")) throw new Error("tiktok capability lanes missing Login Kit readiness");
  if (!tiktokStatus.capabilityLanes.some(lane => lane.id === "content-posting-direct" && lane.status === "review-gated")) throw new Error("tiktok capability lanes should keep direct posting review-gated");

  const youtubeReadiness = await request("/api/youtube/readiness");
  if (!youtubeReadiness.ok || !youtubeReadiness.redirectUri.includes("/api/oauth/youtube/callback") || !youtubeReadiness.connectRoute.includes("/api/oauth/youtube/start")) throw new Error("youtube readiness failed");
  const redditReadiness = await request("/api/reddit/readiness");
  if (!redditReadiness.ok || !redditReadiness.projectReady || !redditReadiness.communityCommandReady || !redditReadiness.devvitReady) throw new Error("reddit community command readiness failed");
  if (!redditReadiness.implementedCapabilities?.some(item => item.includes("Moderator-gated")) || !redditReadiness.implementedCapabilities?.some(item => item.includes("app-attributed replies"))) throw new Error("reddit readiness should expose implemented moderation and reply capabilities");
  if (!redditReadiness.capabilityLimits?.some(item => item.includes("Ads Manager handoff is not Reddit Ads API"))) throw new Error("reddit readiness must keep Ads Manager handoff separate from live Ads API access");
  if (redditReadiness.dataApi?.implemented !== false || redditReadiness.dataApi?.oauthConnected !== false) throw new Error("Reddit readiness must not label credential metadata as an implemented Data API connection");
  const redditAdsReadiness = await request("/api/reddit/ads/readiness");
  if (redditAdsReadiness.ready !== false || redditAdsReadiness.implemented !== false || redditAdsReadiness.oauthImplemented !== false || /approval|allowlist/i.test(redditAdsReadiness.nextAction || "")) throw new Error("Reddit Ads readiness must use real OAuth/account evidence rather than a stale approval flag");
  if (serverSource.includes("REDDIT_ADS_API_APPROVED") || envExampleSource.includes("REDDIT_ADS_API_APPROVED") || envSyncSource.includes("REDDIT_ADS_API_APPROVED")) throw new Error("deprecated Reddit Ads approval flag should be removed from runtime and env tooling");
  const googleGrowth = await request("/api/google/growth-suite");
  if (!googleGrowth.ok || !Array.isArray(googleGrowth.apis) || !googleGrowth.projectRecommendation?.callback?.includes("/api/oauth/youtube/callback")) throw new Error("google growth suite readiness failed");
  const googleBusiness = await request("/api/google/business/readiness", { headers: { Authorization: `Bearer ${login.session.token}` } });
  if (!googleBusiness.ok || !Array.isArray(googleBusiness.missingEnv) || !googleBusiness.acceptedEnv || googleBusiness.connectRoute !== "/api/oauth/youtube/start?service=business") throw new Error("google business readiness should expose the dedicated consent lane");
  if (!googleBusiness.requiredScopes?.includes("https://www.googleapis.com/auth/business.manage") || !Array.isArray(googleBusiness.accounts) || !googleBusiness.discovery) throw new Error("google business readiness should expose consent, discovery, and location evidence");
  if (googleBusiness.missingEnv.includes("GOOGLE_BUSINESS_ACCOUNT_ID") || googleBusiness.missingEnv.includes("GOOGLE_BUSINESS_LOCATION_ID")) throw new Error("google business readiness must not require global account/location IDs for customer assets");

  const googleBusinessStartResponse = await fetch(base + "/api/oauth/youtube/start?service=business", { redirect: "manual", headers: { Authorization: `Bearer ${login.session.token}` } });
  if (googleBusinessStartResponse.status !== 302) throw new Error("google business OAuth start should redirect to Google consent");
  const googleBusinessStartUrl = new URL(googleBusinessStartResponse.headers.get("location") || "");
  if (!googleBusinessStartUrl.searchParams.get("scope")?.includes("https://www.googleapis.com/auth/business.manage")) throw new Error("google business OAuth start must request business.manage");

  const xStartResponse = await fetch(base + "/api/oauth/x/start", { redirect: "manual" });
  if (![200, 302].includes(xStartResponse.status)) throw new Error("x start failed");
  if (xStartResponse.status === 200) {
    const xStartText = await xStartResponse.text();
    if (!xStartText.includes("X client id needed") && !xStartText.includes("X callback URL needed")) throw new Error("x start setup guidance failed");
  } else {
    const location = xStartResponse.headers.get("location") || "";
    if (!location.includes("x.com") || !location.includes("oauth2/authorize")) throw new Error("x start redirect failed");
    if (location.includes("+")) throw new Error("x OAuth URL should encode scope spaces as %20, not plus signs");
    if (!location.includes("scope=tweet.read%20users.read%20offline.access")) throw new Error("x default OAuth should request the read-first scope set");
    const xStartUrl = new URL(location);
    if ((xStartUrl.searchParams.get("state") || "").length > 500) throw new Error("x OAuth state must stay under X's 500 character limit");
    if (xStartUrl.searchParams.get("code_challenge_method") !== "S256") throw new Error("x OAuth should use PKCE S256");
  }

  const xWriteStartResponse = await fetch(base + "/api/oauth/x/start?mode=write", { redirect: "manual" });
  if (![200, 302].includes(xWriteStartResponse.status)) throw new Error("x write start failed");
  if (xWriteStartResponse.status === 302) {
    const location = xWriteStartResponse.headers.get("location") || "";
    if (!location.includes("scope=tweet.read%20tweet.write%20users.read%20offline.access")) throw new Error("x write upgrade should request tweet.write explicitly");
    const xWriteStartUrl = new URL(location);
    if ((xWriteStartUrl.searchParams.get("state") || "").length > 500) throw new Error("x write OAuth state must stay under X's 500 character limit");
  }

  const metaUseCases = await request("/api/meta/use-cases");
  if (!metaUseCases.ok || metaUseCases.total < 35 || !Array.isArray(metaUseCases.useCases) || !Array.isArray(metaUseCases.capabilityMatrix)) throw new Error("meta use-case matrix failed");
  if (!metaUseCases.useCases.some(item => item.id === "oembed_read")) throw new Error("meta oEmbed use case missing");
  if (!metaUseCases.useCases.some(item => item.id === "instagram_business_login")) throw new Error("meta Instagram business-login use case missing");
  if (!metaUseCases.useCases.some(item => item.id === "messenger_pages")) throw new Error("meta Messenger use case missing");
  if (!metaUseCases.portalEvidence?.appDashboard?.requiredDataDeletionUrl?.endsWith("/api/meta/data-deletion")) throw new Error("meta portal evidence missing data deletion URL");
  if (!metaUseCases.capabilityMatrix.every(item => item.statusCode && Array.isArray(item.blockers) && Array.isArray(item.requiredScopes))) throw new Error("meta capability matrix missing normalized lane fields");

  const metaCapabilities = await request("/api/meta/capabilities");
  if (!metaCapabilities.ok || metaCapabilities.total < 35 || !metaCapabilities.capabilities.every(item => item.endpoint)) throw new Error("meta capabilities failed");
  if (!metaCapabilities.portalEvidence?.readyForTesting?.ads?.includes("pages_manage_ads")) throw new Error("meta capabilities missing portal-discovered ads permissions");
  if (!metaCapabilities.capabilities.some(item => item.id === "oembed_read" && item.endpoint === "/api/meta/oembed")) throw new Error("meta oEmbed capability missing");
  if (!metaCapabilities.capabilities.some(item => item.id === "facebook_pages_publish" && item.statusCode)) throw new Error("meta publish lane missing status code");

  const diagnosticAgent = await request("/api/meta/diagnostic-agent");
  if (!diagnosticAgent.ok || !Array.isArray(diagnosticAgent.actions) || !diagnosticAgent.paidNeeds?.length) throw new Error("meta diagnostic agent failed");
  if (!diagnosticAgent.biggestMiss.includes("personal profile")) throw new Error("meta diagnostic agent missed personal profile/Page distinction");
  if (!diagnosticAgent.snapshot || !Array.isArray(diagnosticAgent.snapshot.blockedFeatures) || !diagnosticAgent.snapshot.retryOnlyAfter.includes("Facebook Page created")) throw new Error("meta diagnostic agent snapshot failed");

  const metaAssets = await request("/api/meta/assets");
  if (!metaAssets.ok || !Array.isArray(metaAssets.accounts) || !Array.isArray(metaAssets.capabilities)) throw new Error("meta assets failed");
  if (!metaAssets.accounts.length && !metaAssets.diagnostic?.snapshot?.reason) throw new Error("meta assets should return a safe diagnostic when no Page or Instagram assets are visible");
  if (Object.prototype.hasOwnProperty.call(metaAssets.metaHealth || {}, "token")) throw new Error("meta assets exposed token-shaped health field");

  const metaHealth = await request("/api/meta/health", { method: "POST" });
  if (!metaHealth.ok || !Array.isArray(metaHealth.accounts) || !Array.isArray(metaHealth.capabilities) || !metaHealth.health) throw new Error("meta health failed");
  if (Object.prototype.hasOwnProperty.call(metaHealth.health, "token")) throw new Error("meta health exposed token-shaped field");
  if (metaHealth.accounts.some(account => !account.connected || !account.tokenStored || !account.providerAccountId)) throw new Error("meta health returned placeholder accounts as assets");
  if (!metaHealth.accounts.length && !metaHealth.diagnostic?.actions?.length) throw new Error("meta health should include safe next actions when no Meta assets are visible");

  const badMetaCallback = await fetch(base + "/api/oauth/meta/callback?code=fake-code&state=bad-state");
  if (badMetaCallback.status !== 400) throw new Error("meta callback should reject unissued OAuth state");

  const youtubeStart = await fetch(base + "/api/oauth/youtube/start", { redirect: "manual" });
  if (youtubeStart.status !== 302) throw new Error("youtube start should redirect to Google");
  const youtubeAuthUrl = new URL(youtubeStart.headers.get("location"));
  const youtubeState = youtubeAuthUrl.searchParams.get("state");
  if (!youtubeState) throw new Error("youtube start did not issue OAuth state");
  const firstYoutubeCallback = await fetch(base + `/api/oauth/youtube/callback?code=fake-code&state=${encodeURIComponent(youtubeState)}`);
  const firstYoutubeText = await firstYoutubeCallback.text();
  if (firstYoutubeCallback.status !== 200 || !firstYoutubeText.includes("YouTube token exchange failed")) throw new Error("youtube callback should consume ledger state and reach token exchange");
  const secondYoutubeCallback = await fetch(base + `/api/oauth/youtube/callback?code=fake-code&state=${encodeURIComponent(youtubeState)}`);
  const secondYoutubeText = await secondYoutubeCallback.text();
  if (secondYoutubeCallback.status !== 200 || secondYoutubeText.includes("OAuth state was not issued")) throw new Error("youtube signed state fallback should recover after ledger state is consumed");
  const oauthDebugLog = await request("/api/oauth/debug-log");
  if (!oauthDebugLog.ok || oauthDebugLog.summary.total < 4) throw new Error("OAuth debug log did not record the local OAuth test flow");
  for (const expectedEvent of ["state_issued", "callback_received", "state_validation", "token_exchange_result"]) {
    if (!oauthDebugLog.rows.some(row => row.provider === "youtube" && row.event === expectedEvent)) throw new Error(`OAuth debug log missing ${expectedEvent} for YouTube`);
  }
  if (JSON.stringify(oauthDebugLog).includes("fake-code") || JSON.stringify(oauthDebugLog).includes(youtubeState)) throw new Error("OAuth debug log leaked a raw code or full state value");
  const promoDebugResponse = await fetch(base + "/api/oauth/debug-log", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (promoDebugResponse.status !== 403) throw new Error("OAuth debug log should be owner/admin-only for signed-in users");
  const ownerDebug = await request("/api/oauth/debug-log", {
    headers: { Authorization: `Bearer ${ownerSignup.session.token}` }
  });
  if (!ownerDebug.ok || ownerDebug.adminOnly !== true) throw new Error("owner/admin OAuth debug log access failed");

  const unsignedWebhook = await fetch(base + "/api/meta/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ object: "page", entry: [] })
  });
  if (![403, 503].includes(unsignedWebhook.status)) throw new Error("unsigned Meta webhook should be rejected");

  const metaDeauthorize = await request("/api/meta/deauthorize");
  if (!metaDeauthorize.ok || !metaDeauthorize.callback?.endsWith("/api/meta/deauthorize")) throw new Error("meta deauthorize readiness failed");
  const unsignedMetaDeauthorize = await fetch(base + "/api/meta/deauthorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  if (unsignedMetaDeauthorize.status !== 400) throw new Error("unsigned Meta deauthorize callback should be rejected");

  const metaPages = await request("/api/meta/pages");
  if (!metaPages.ok || !Array.isArray(metaPages.pages) || !metaPages.gate) throw new Error("meta pages failed");
  if (metaPages.pages.some(page => !page.connected || !page.tokenStored || !page.providerAccountId)) throw new Error("meta pages returned placeholder page assets");

  const facebookPublishReadiness = await request("/api/meta/publish/facebook/readiness");
  if (!facebookPublishReadiness.ok || facebookPublishReadiness.requiredScope !== "pages_manage_posts" || !Array.isArray(facebookPublishReadiness.nextActions)) throw new Error("facebook publish readiness failed");
  if (!facebookPublishReadiness.ready && !facebookPublishReadiness.nextActions.join(" ").includes("App Review")) throw new Error("facebook publish readiness missed review guidance");

  const metaInstagram = await request("/api/meta/instagram/accounts");
  if (!metaInstagram.ok || !Array.isArray(metaInstagram.accounts) || !metaInstagram.gate) throw new Error("meta instagram accounts failed");
  if (metaInstagram.accounts.some(account => !account.connected || !account.tokenStored || !account.providerAccountId)) throw new Error("meta instagram returned placeholder assets");

  const metaBusinessAssetsResponse = await fetch(base + "/api/meta/business/assets");
  const metaBusinessAssets = await metaBusinessAssetsResponse.json();
  if (!(metaBusinessAssets.gate || metaBusinessAssets.useCase) || !Object.prototype.hasOwnProperty.call(metaBusinessAssets, "ok")) throw new Error("meta business diagnostic failed");

  const metaOembed = await request("/api/meta/oembed");
  if (!metaOembed.ok || !metaOembed.gate || metaOembed.requiresOwnedPage !== false || !metaOembed.supportedKinds.includes("instagram")) throw new Error("meta oEmbed readiness failed");

  const badOembed = await fetch(base + "/api/meta/oembed?url=https%3A%2F%2Fexample.com%2Fpost");
  if (badOembed.status !== 400) throw new Error("meta oEmbed should reject non-Meta URLs");

  const metaCatalog = await request("/api/meta/catalog/readiness");
  if (!metaCatalog.ok || !metaCatalog.gate || !Array.isArray(metaCatalog.nextActions) || !metaCatalog.requiredScopes.includes("catalog_management")) throw new Error("meta catalog readiness failed");

  const metaComments = await request("/api/meta/comments");
  if (!metaComments.ok || !metaComments.gates?.facebook || !metaComments.gates?.instagram || !Array.isArray(metaComments.workflows)) throw new Error("meta comments contract failed");
  const metaMessages = await request("/api/meta/messages");
  if (!metaMessages.ok || !metaMessages.gates?.messenger || !metaMessages.gates?.instagram || !String(metaMessages.liveSubmitRequires || "").includes("explicit user approval")) throw new Error("meta messages contract failed");
  const metaPublicContent = await request("/api/meta/instagram/public-content");
  if (!metaPublicContent.ok || !metaPublicContent.gate || metaPublicContent.gate.id !== "instagram_public_content") throw new Error("meta Instagram public content contract failed");
  const metaShopping = await request("/api/meta/instagram/shopping");
  if (!metaShopping.ok || !metaShopping.gate || metaShopping.gate.id !== "instagram_shopping") throw new Error("meta Instagram shopping contract failed");
  const metaMarketingMessage = await fetch(base + "/api/meta/messages/marketing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Social Cues marketing message dry run" })
  });
  if (![401, 402].includes(metaMarketingMessage.status)) throw new Error("meta marketing messages should require a signed-in app session");

  const xAccount = await request("/api/x/account");
  if (!xAccount.ok || !Array.isArray(xAccount.scopes) || !xAccount.redirectUri.includes("/api/oauth/x/callback")) throw new Error("x account failed");

  const xPostBlocked = await fetch(base + "/api/x/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Social Cues X smoke test" })
  });
  const xPostBody = await xPostBlocked.json();
  if (![200, 409].includes(xPostBlocked.status)) throw new Error("x post returned unexpected status");
  if (xPostBlocked.status === 200 && !xPostBody.dryRun) throw new Error("x post should dry-run unless explicitly live submitted");
  if (xPostBlocked.status === 409 && !xPostBody.connectRoute) throw new Error("x post gate should provide connect route");

  const reviewPack = await request("/api/meta/review-pack");
  if (!reviewPack.ok || !reviewPack.dataDeletionUri || !Array.isArray(reviewPack.statements)) throw new Error("meta review pack failed");
  if (!reviewPack.termsOfServiceUrl || !reviewPack.termsOfServiceUrl.endsWith("/terms")) throw new Error("meta review pack missing terms URL");
  if (!reviewPack.dataDeletionUri || !reviewPack.dataDeletionUri.endsWith("/api/meta/data-deletion")) throw new Error("meta review pack missing data deletion URL");
  if (!reviewPack.dashboardEvidence?.needsAddOrReview?.instagramBusinessLogin?.includes("instagram_business_manage_messages")) throw new Error("meta review pack missing Instagram portal evidence");

  const commerceSignal = await request("/api/meta/commerce/signals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "test_signal", value: 1 })
  });
  if (!commerceSignal.ok || !commerceSignal.signal.id) throw new Error("meta commerce signal failed");

  const checkout = await request("/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selectedPlan: "Founder Audit - $99" })
  });
  if (!checkout.ok) throw new Error("billing checkout failed");

  const coreReadiness = await request("/api/integrations/readiness");
  if (!coreReadiness.ok || !Array.isArray(coreReadiness.coreServices)) throw new Error("integration readiness failed");
  if (!coreReadiness.envRequired.includes("PINTEREST_APP_ID") || !coreReadiness.envRequired.includes("CANVA_CLIENT_ID") || !coreReadiness.envRequired.includes("SHOPIFY_CLIENT_ID") || !coreReadiness.envRequired.includes("RESEND_API_KEY")) throw new Error("provider env readiness missing expanded providers");
  for (const id of ["openai", "stripe", "resend", "media_editor"]) {
    if (!coreReadiness.coreServices.some(service => service.id === id)) throw new Error(`missing ${id} readiness`);
  }
  if (!coreReadiness.providerServices.some(service => service.id === "discord")) throw new Error("missing discord provider readiness");
  const discordService = coreReadiness.providerServices.find(service => service.id === "discord");
  const canvaService = coreReadiness.providerServices.find(service => service.id === "canva");
  if (!discordService?.acceptedEnv?.DISCORD_CLIENT_ID?.includes("DISCORD_APPLICATION_ID") || !discordService?.acceptedEnv?.DISCORD_CLIENT_SECRET?.includes("DISCORD_APP_SECRET")) throw new Error("discord accepted env aliases missing from readiness");
  if (!canvaService?.acceptedEnv?.CANVA_CLIENT_ID?.includes("CANVA_CONNECT_CLIENT_ID") || !canvaService?.acceptedEnv?.CANVA_CLIENT_SECRET?.includes("CANVA_CONNECT_CLIENT_SECRET")) throw new Error("canva accepted env aliases missing from readiness");
  const metaService = coreReadiness.providerServices.find(service => service.id === "meta");
  if (!metaService || metaService.ready || !metaService.portalBlocker || !metaService.nextAction?.includes("OAuth redirect")) throw new Error("Meta readiness should reflect developer portal blockers, not only credentials");
  if (!/OAuth redirect|review-gated|gated/i.test(coreReadiness.readiness?.meta || "") || /credentials ready; connect/i.test(coreReadiness.readiness?.meta || "")) throw new Error("Meta readiness summary should use developer portal gate, not stale credential-only text");
  if (!coreReadiness.providerTruth?.summary || !Array.isArray(coreReadiness.providerTruth.nextProviderActions) || !coreReadiness.providerTruth.rows.some(row => row.id === "twitch")) throw new Error("integration readiness missing provider truth summary");
  if (!coreReadiness.acceptanceLedger?.summary || !Array.isArray(coreReadiness.acceptanceLedger.rows) || !coreReadiness.acceptanceLedger.rows.some(row => row.id === "twitch")) throw new Error("integration readiness missing provider acceptance ledger");
  if (!coreReadiness.providerContracts?.summary || !Array.isArray(coreReadiness.providerContracts.nextContractActions) || !coreReadiness.providerContracts.rows.some(row => row.id === "twitch")) throw new Error("integration readiness missing provider contract summary");
  if (!coreReadiness.portalAudit || !Array.isArray(coreReadiness.portalAudit.hardBlockers) || !coreReadiness.portalAudit.hardBlockers.some(item => item.id === "meta")) throw new Error("integration readiness missing developer portal audit summary");
  if (!Array.isArray(coreReadiness.credentialUnlocks) || !Object.prototype.hasOwnProperty.call(coreReadiness, "nextCredentialUnlock")) throw new Error("integration readiness missing prioritized credential unlock queue");

  const alphaTestPanel = await request("/api/test-panel");
  if (!alphaTestPanel.ok || !alphaTestPanel.summary || !Array.isArray(alphaTestPanel.rows) || !Array.isArray(alphaTestPanel.quickChecks)) throw new Error("alpha test panel endpoint failed");
  if (!alphaTestPanel.rows.some(row => row.id === "twitch" && Array.isArray(row.safeChecks)) || !alphaTestPanel.rows.some(row => row.id === "x" && row.nextTest)) throw new Error("alpha test panel missing provider mapping rows");
  if (!alphaTestPanel.health?.rules?.some(rule => /No secrets/i.test(rule))) throw new Error("alpha test panel must state that secrets are not returned");

  const credentialUnlocks = await request("/api/provider/credential-unlocks");
  if (!credentialUnlocks.ok || !Array.isArray(credentialUnlocks.unlocks) || !Object.prototype.hasOwnProperty.call(credentialUnlocks, "next")) throw new Error("provider credential unlock endpoint failed");
  if (!serverSource.includes('ETSY_CLIENT_SECRET: ["ETSY_SHARED_SECRET"') && !serverSource.includes('ETSY_CLIENT_SECRET": ["ETSY_SHARED_SECRET"')) throw new Error("provider credential unlock aliases missing Etsy shared-secret alias");

  const setupFields = await request("/api/provider/setup-fields");
  if (!setupFields.ok || setupFields.total < 10 || !setupFields.rows.some(row => row.id === "twitch" && row.callbackUrl.includes("/api/oauth/twitch/callback"))) throw new Error("provider setup fields endpoint failed");
  const metaSetup = setupFields.rows.find(row => row.id === "meta");
  if (!metaSetup?.dashboardFields?.some(field => field.label === "User data deletion URL" && field.value.includes("/api/meta/data-deletion"))) throw new Error("provider setup fields missing Meta data deletion URL");
  const canvaSetup = setupFields.rows.find(row => row.id === "canva");
  if (!canvaSetup?.dashboardFields?.some(field => field.label === "Connect integration redirect URI") || !canvaSetup.requiredEnv.includes("CANVA_CLIENT_ID")) throw new Error("provider setup fields missing Canva Connect contract");
  if (!canvaSetup.dashboardFields.some(field => field.label === "Canva product split")) throw new Error("provider setup fields should explain Canva Apps SDK versus Connect API");
  const pinterestSetup = setupFields.rows.find(row => row.id === "pinterest");
  if (!pinterestSetup?.dashboardFields?.some(field => field.label === "Trial access lane" && field.value.includes("1000/day"))) throw new Error("provider setup fields missing Pinterest trial access lane");
  const etsySetup = setupFields.rows.find(row => row.id === "etsy");
  if (!etsySetup?.dashboardFields?.some(field => field.label === "Existing app" && field.value.includes("Personal Access"))) throw new Error("provider setup fields missing existing Etsy app evidence");

  const portalAudit = await request("/api/dev-portal/audit");
  if (!portalAudit.ok || portalAudit.total < 10 || !portalAudit.rows.some(row => row.id === "tiktok" && row.callback.includes("/api/oauth/tiktok/callback"))) throw new Error("developer portal audit failed");
  if (!portalAudit.rows.some(row => row.id === "tiktok" && row.portalRoute?.includes("developers.tiktok.com")) || !portalAudit.hardBlockers.every(row => Object.prototype.hasOwnProperty.call(row, "portalRoute"))) throw new Error("developer portal audit missing provider portal routes");
  const twitchPortalRow = portalAudit.rows.find(row => row.id === "twitch");
  if (!twitchPortalRow || !twitchPortalRow.nextAction?.includes("Reconnect Twitch") || /Generate TWITCH_CLIENT_SECRET/i.test(twitchPortalRow.nextAction)) throw new Error("Twitch portal audit should not ask for a secret that is already configured");
  const discordPortalRow = portalAudit.rows.find(row => row.id === "discord");
  if (!discordPortalRow || !/portal-app-created|configured/i.test(discordPortalRow.status) || !/client secret|bot token|DISCORD_BOT_TOKEN/i.test(`${discordPortalRow.blocker} ${discordPortalRow.nextAction}`)) throw new Error("Discord portal audit should reflect the created app and remaining credentials");

  const depth = await request("/api/platform-capabilities/depth");
  if (!depth.ok || depth.total < 10 || !depth.categories.includes("community-ops")) throw new Error("platform capability depth failed");
  if (!depth.rows.some(row => row.provider === "discord" && row.deeperUse.includes("Slash commands"))) throw new Error("discord depth lane missing");
  if (!coreReadiness.depth || !Array.isArray(coreReadiness.depth.priorityBuildOrder) || !coreReadiness.depth.priorityBuildOrder.some(item => item.provider === "meta")) throw new Error("integration readiness missing capability depth summary");

  const openaiReady = await request("/api/openai/readiness");
  if (!openaiReady.ok || !openaiReady.serverSideOnly) throw new Error("openai readiness failed");

  const discordReady = await request("/api/discord/readiness");
  if (!discordReady.ok || !discordReady.redirectUri.includes("/api/oauth/discord/callback") || discordReady.connectRoute !== "/api/oauth/discord/start" || !discordReady.scopes.includes("identify")) throw new Error("discord readiness failed");
  if (!discordReady.install?.guildUrl?.includes("scope=bot+applications.commands") || discordReady.install?.botPermissionBits !== "126016" || !discordReady.install?.botPermissions?.includes("Manage Messages")) throw new Error("discord install URL readiness failed");
  if (!discordReady.configured || discordReady.missingEnv?.includes("DISCORD_CLIENT_ID") || discordReady.missingEnv?.includes("DISCORD_CLIENT_SECRET")) throw new Error("discord alias credentials were not recognized");
  const discordInteractionsReady = await request("/api/discord/interactions/readiness");
  if (!discordInteractionsReady.ok || !discordInteractionsReady.endpoint.includes("/api/discord/interactions") || !discordInteractionsReady.publicKeyConfigured || !discordInteractionsReady.commandIdeas.some(item => item.includes("/cue status"))) throw new Error("discord interactions readiness failed");
  const discordWebhookEventsReady = await request("/api/discord/webhook-events/readiness");
  if (!discordWebhookEventsReady.ok || !discordWebhookEventsReady.endpoint.includes("/api/discord/webhook-events") || !discordWebhookEventsReady.subscriptions.includes("APPLICATION_DEAUTHORIZED")) throw new Error("discord webhook event readiness failed");
  const discordCommandsReady = await request("/api/discord/commands/readiness");
  if (!discordCommandsReady.ok || !discordCommandsReady.registerRoute.includes("/api/discord/commands/register") || !discordCommandsReady.commands.some(item => item.name === "cue")) throw new Error("discord command readiness failed");
  const discordBotReady = await request("/api/discord/bot/readiness");
  if (!discordBotReady.ok || !Object.prototype.hasOwnProperty.call(discordBotReady, "botTokenConfigured") || !Array.isArray(discordBotReady.errors)) throw new Error("discord bot readiness failed");
  const discordVerificationPreflight = await request("/api/discord/verification-preflight");
  if (!discordVerificationPreflight.ok || !discordVerificationPreflight.dashboardFields?.some(field => field.label === "Interactions Endpoint URL") || !discordVerificationPreflight.gates?.some(gate => gate.id === "verification-final" && gate.finalStep)) throw new Error("discord verification preflight failed");
  const discordCommandsListResponse = await fetch(base + "/api/discord/commands");
  if (![200, 409].includes(discordCommandsListResponse.status)) throw new Error("discord registered command list should either return commands or a bot-config gate");

  const discordCommunityResponse = await fetch(base + "/api/discord/community");
  if (discordCommunityResponse.status !== 409) throw new Error("discord community should require connected Discord OAuth");

  const twitchReady = await request("/api/twitch/readiness");
  if (!twitchReady.ok || twitchReady.connectRoute !== "/api/oauth/twitch/start" || !twitchReady.developerReviewStatus) throw new Error("twitch readiness failed");

  const resendReady = await request("/api/resend/readiness");
  if (!resendReady.ok || !resendReady.smtp || !Array.isArray(resendReady.missingEnv)) throw new Error("resend readiness failed");

  const billingReady = await request("/api/billing/readiness");
  if (!billingReady.ok || !billingReady.mode) throw new Error("billing readiness failed");
  if (billingReady.ready !== Boolean(billingReady.checkoutReady && billingReady.webhookReady)) throw new Error("billing readiness must require both checkout and verified webhook delivery");

  const mediaEditorReady = await request("/api/media/editor/readiness");
  if (!mediaEditorReady.ok || !Array.isArray(mediaEditorReady.outputs)) throw new Error("media editor readiness failed");
  if (typeof mediaEditorReady.planningReady !== "boolean" || typeof mediaEditorReady.uploadReady !== "boolean" || typeof mediaEditorReady.rendererConfigured !== "boolean" || typeof mediaEditorReady.renderReady !== "boolean") throw new Error("media editor readiness must separate planning, upload, renderer configuration, and live rendering truth");
  if (mediaEditorReady.internalPipeline?.sourceProbe !== "ffprobe" || mediaEditorReady.internalPipeline?.sceneAndSilenceMap !== "FFmpeg" || !String(mediaEditorReady.internalPipeline?.transcript || "").includes("speech-to-text") || !String(mediaEditorReady.internalPipeline?.workerState || "").trim()) throw new Error("media readiness must expose the proven internal dissection stages and honest worker state");
  if (!serverSource.includes("const renderReady = Boolean(planningReady && uploadReady && mediaRenderWorkerConfigured)") || !serverSource.includes("Private upload and planning ready; isolated renderer pending")) throw new Error("media readiness must not report a live render pipeline before the isolated worker is configured");
  const requiredVideoPlatforms = ["tiktok", "instagram", "youtube", "facebook", "x", "threads"];
  if (requiredVideoPlatforms.some(platform => !mediaEditorReady.outputs.some(output => output.platform === platform))) throw new Error("media editor readiness missed a video platform");
  if (mediaEditorReady.outputs.some(output => !output.spec?.format || !output.spec?.resolution || !output.spec?.duration || !output.spec?.maxFile || !output.spec?.fileSuffix)) throw new Error("media editor outputs must include platform video specs");
  if (mediaEditorReady.outputs.some(output => !Array.isArray(output.hashtags) || !output.hashtags.length)) throw new Error("media editor outputs must include platform hashtag guidance");

  const authReady = await request("/api/auth/readiness");
  if (!authReady.ok || !authReady.sessionStorage.includes("HMAC")) throw new Error("auth readiness failed");
  if (authReady.signupAccess?.mode !== "invite-only" || authReady.signupAccess?.activePromoCodeCount < 4) throw new Error("auth readiness must expose invite-only signup policy");
  if (!["passwordRecoveryReady", "loginAlertingReady", "rateLimitGuarded", "refreshTokenRotationReady"].every(key => Object.prototype.hasOwnProperty.call(authReady, key))) {
    throw new Error("auth readiness must expose Supabase Pro hardening flags");
  }
  if (!authReady.alphaLocalFallback && authReady.customSmtpReady) {
    if (!authReady.passwordRecoveryReady || !authReady.loginAlertingReady || !authReady.rateLimitGuarded || !authReady.refreshTokenRotationReady) {
      throw new Error("hosted auth readiness should mark the Supabase Pro hardening flags ready");
    }
    if (!String(authReady.nextSwitch || "").includes("Recovery")) throw new Error("hosted auth readiness next switch should reflect the live recovery/alert lane");
  }

  const passwordRecoveryNoEmail = await fetch(base + "/api/auth/password-recovery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  if (passwordRecoveryNoEmail.status !== 400) throw new Error("password recovery should require an email address");

  const resetPageResponse = await fetch(base + "/reset-password");
  const resetPageHtml = await resetPageResponse.text();
  if (resetPageResponse.status !== 200 || !resetPageHtml.includes("Set a new password") || !resetPageHtml.includes("Open the newest Social Cues password-reset email")) throw new Error("dedicated password reset page is unavailable");
  if (!resetPageHtml.includes("/api/monitoring/client-error")) throw new Error("account and recovery pages must report sanitized browser failures");
  if (resetPageHtml.includes('id="createBtn"') || resetPageHtml.includes('id="createAccountButton"')) throw new Error("password reset page must not expose account creation controls");

  const resetWithoutRecoveryLink = await fetch(base + "/api/auth/password-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "replacement-password-2026" })
  });
  if (resetWithoutRecoveryLink.status !== 403) throw new Error("password update must reject requests that did not originate from an emailed recovery link");

  const storageReady = await request("/api/media/storage/readiness");
  if (!storageReady.ok || !storageReady.bucket || !Array.isArray(storageReady.missingEnv)) throw new Error("media storage readiness failed");

  const securityAudit = await request("/api/security/audit");
  if (!securityAudit.ok || !securityAudit.headers || !securityAudit.auth?.publicUserListHidden) throw new Error("security audit failed");
  if (!securityAudit.secrets?.oauthTokenEncryption || !securityAudit.auth?.workspaceModelMirror) throw new Error("security audit missed core hardening status");

  const mediaEditPlan = await request("/api/media/editor/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceName: "raw-test.mp4",
      brief: "Social Cues launch",
      intent: {
        messageToPreserve: "Show creators the audience-intelligence payoff.",
        audience: "Creators building their first repeatable growth system",
        targetClipCount: 5
      }
    })
  });
  if (!mediaEditPlan.ok || !mediaEditPlan.plan?.outputs?.length || !mediaEditPlan.serverRequirement) throw new Error("media editor plan failed");
  if (mediaEditPlan.plan.intent?.targetClipCount !== 5 || !mediaEditPlan.plan.intent?.messageToPreserve?.includes("audience-intelligence") || !mediaEditPlan.plan.intent?.audience?.includes("Creators")) throw new Error("media editor plan must preserve the user's message, audience, and requested clip count");
  if (![...(mediaEditPlan.plan.intake || []), ...(mediaEditPlan.plan.editPass || [])].some(stage => /scene|silence/i.test(stage)) || !mediaEditPlan.plan.reviewGate) throw new Error("media editor plan must include dissection stages and an explicit human review gate");
  if (!mediaEditPlan.plan.outputs.every(output => output.outputName?.startsWith("raw-test-") && output.filterPlan && output.safeArea && output.requiredReview)) throw new Error("media editor plan must include export names, filters, safe areas, and review gates");

  const mediaAsset = await request("/api/media/assets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${login.session.token}`
    },
    body: JSON.stringify({ fileName: "raw-test.mp4", kind: "video", title: "Raw smoke clip" })
  });
  if (!mediaAsset.ok || !mediaAsset.asset?.storagePath || mediaAsset.asset.createdBy !== login.user.id) throw new Error("media asset reservation failed");
  if (mediaAsset.upload.ready !== false || mediaAsset.upload.signedUrl || mediaAsset.upload.token) throw new Error("unconfigured local storage must not issue a browser upload secret");

  const anonymousMediaComplete = await fetch(base + "/api/media/assets/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetId: mediaAsset.asset.id })
  });
  if (anonymousMediaComplete.status !== 401) throw new Error("media completion verification must require an entitled owner session");

  const oversizedMedia = await fetch(base + "/api/media/assets", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ fileName: "too-large.mp4", kind: "video", contentType: "video/mp4", size: 251 * 1024 * 1024 })
  });
  if (oversizedMedia.status !== 413) throw new Error("media reservation must reject files above the configured limit before signing");

  const renderJob = await request("/api/media/editor/render-jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${login.session.token}`
    },
    body: JSON.stringify({
      campaignId: scheduledCampaign.id,
      sourceName: "raw-test.mp4",
      assetId: mediaAsset.asset.id,
      storagePath: mediaAsset.asset.storagePath,
      outputs: mediaEditPlan.plan.outputs
    })
  });
  if (!renderJob.ok || !renderJob.job?.id || renderJob.job.ownerUserId !== login.user.id || !renderJob.job.outputs?.length) throw new Error("media render job failed");
  if (!["worker-storage-not-ready", "storage-not-configured"].includes(renderJob.job.status) || renderJob.job.workerStatus !== "durable-queue-ready-renderer-not-configured") throw new Error("media render job status should distinguish durable storage from the isolated renderer");

  const manualConnectResponse = await fetch(base + "/api/accounts/tiktok", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "connected", handle: "@should-not-connect" })
  });
  if (manualConnectResponse.status !== 409) throw new Error("manual account connect should be blocked");

  const cachedProviderModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  cachedProviderModel.functionChecks = {
    ...(cachedProviderModel.functionChecks || {}),
    tiktok: { status: "cached", summary: "stale TikTok check should be cleared" },
    x: { status: "keep", summary: "X check should remain" }
  };
  cachedProviderModel.providerStateSnapshots = [
    {
      id: "provider-state-cache-test",
      createdAt: new Date().toISOString(),
      rows: [
        { id: "tiktok", name: "TikTok", connected: true, canPublish: true },
        { id: "x", name: "X", connected: true, canPublish: false }
      ],
      summary: { total: 2, connected: 2 }
    },
    ...(cachedProviderModel.providerStateSnapshots || [])
  ];
  cachedProviderModel.analyticsSnapshots = [
    {
      id: "analytics-cache-test",
      createdAt: new Date().toISOString(),
      metrics: [
        { label: "TikTok reach", source: "TikTok cached analytics" },
        { label: "X reach", source: "X cached analytics" }
      ],
      sourceBreakdown: [{ source: "TikTok live API" }, { source: "X live API" }],
      translatedAnalysis: ["TikTok cached note", "X cached note"]
    },
    ...(cachedProviderModel.analyticsSnapshots || [])
  ];
  cachedProviderModel.activity = [
    { id: "activity-tiktok-cache-test", type: "provider-action-check", providerId: "tiktok", summary: "stale TikTok activity" },
    ...(cachedProviderModel.activity || [])
  ];
  await request("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(cachedProviderModel)
  });

  const disconnectResponse = await request("/api/accounts/tiktok", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ disconnect: true, disabled: true, status: "not connected" })
  });
  if (!disconnectResponse.ok || disconnectResponse.account.connected || disconnectResponse.account.tokenStored) throw new Error("disconnect should clear account evidence");
  if (!disconnectResponse.cleanup?.purged || disconnectResponse.cleanup.purged.functionChecks < 1 || disconnectResponse.cleanup.purged.providerStateSnapshots < 1 || disconnectResponse.cleanup.purged.analyticsSnapshots < 1 || disconnectResponse.cleanup.purged.activity < 1) throw new Error("disconnect should clear cached provider checks, snapshots, analytics, and activity");

  const accounts = await request("/api/accounts", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!accounts.ok || !accounts.accounts.some(account => account.platform === "tiktok")) throw new Error("accounts list failed");
  if (JSON.stringify(accounts.accounts).includes('"token"')) throw new Error("accounts leaked token material");
  const tiktok = accounts.accounts.find(account => account.platform === "tiktok");
  if (tiktok.connected || tiktok.tokenStored || tiktok.status === "connected") throw new Error("tiktok should not be marked connected without provider evidence");
  const disconnectedModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (disconnectedModel.functionChecks?.tiktok) throw new Error("disabled provider function check cache was not cleared");
  if ((disconnectedModel.providerStateSnapshots || []).some(record => (record.rows || []).some(row => row.id === "tiktok"))) throw new Error("disabled provider state snapshot rows were not cleared");
  if (JSON.stringify(disconnectedModel.analyticsSnapshots || []).toLowerCase().includes("tiktok")) throw new Error("disabled provider analytics snapshot cache was not cleared");
  if ((disconnectedModel.activity || []).some(item => item.providerId === "tiktok")) throw new Error("disabled provider activity cache was not cleared");

  const exported = await request("/api/export");
  if (JSON.stringify(exported).includes('"token":') || JSON.stringify(exported).includes('"accessToken":') || JSON.stringify(exported).includes('"refreshToken":')) throw new Error("export leaked token material");
  if (JSON.stringify(exported).includes('"oauthStates"')) throw new Error("export leaked oauth state ledger");
  if (JSON.stringify(exported).includes('"oauthEvents"')) throw new Error("export leaked OAuth debug event ledger");

  const analytics = await request("/api/analyze", {
    method: "POST",
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!analytics.ok || !Array.isArray(analytics.analytics.metrics)) throw new Error("analytics failed");
  if (!Array.isArray(analytics.analytics.sourceBreakdown) || !Array.isArray(analytics.analytics.translatedAnalysis)) throw new Error("analytics source readout failed");
  if (!accounts.accounts.some(account => account.connected === true && account.tokenStored === true) && analytics.analytics.metrics.length) throw new Error("unconnected workspaces must return an empty analytics state");
  if (!analytics.analytics.metrics.every(metric => metric.source && metric.kind)) throw new Error("analytics metrics must include source and kind");
  if (analytics.analytics.metrics.some(metric => ["Audience", "Avg. views", "Engagement", "Cadence"].includes(metric.label))) throw new Error("analytics contains unlabeled placeholder metrics");
  if (analytics.analytics.metrics.some(metric => metric.kind === "manual" || String(metric.label || "").startsWith("Manual"))) throw new Error("growth should not expose manual baseline metrics");
  if (JSON.stringify(analytics.analytics).toLowerCase().includes("manual baseline")) throw new Error("growth should not mention manual baseline");
  if (appHtml.includes("variant.mockViews =") || appHtml.includes("4200 + Math.random() * 64000")) throw new Error("published variants must never invent view counts");

  const media = await request("/api/media/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "Sora", platform: "tiktok", brief: "Social Cues launch" })
  });
  if (!media.ok || !media.prompt) throw new Error("media generation failed");

  console.log(JSON.stringify({ ok: true, generated: generated.variants.length, queued: queued.status }));
} finally {
  server.kill();
  await delay(150);
}
