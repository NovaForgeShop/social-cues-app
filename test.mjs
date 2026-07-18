import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const port = 4199;
const base = `http://127.0.0.1:${port}`;
const promoCodes = [crypto.randomBytes(18).toString("base64url"), crypto.randomBytes(18).toString("base64url")];
const promoCodeHashes = promoCodes.map(code => crypto.createHash("sha256").update(code.toUpperCase()).digest("hex")).join(",");
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    AUTH_PROVIDER: "alpha-local",
    SUPABASE_ENABLED: "false",
    SENTRY_DSN: "",
    SENTRY_RELEASE: "",
    VERCEL_DEPLOYMENT_ID: "dpl_social_cues_test",
    SENTRY_GITHUB_REPOSITORY: "NovaForgeShop/social-cues-app",
    SENTRY_SOURCE_CONTEXT_ENABLED: "true",
    SOCIAL_CUES_PROMO_CODE_HASHES: promoCodeHashes
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

try {
  await delay(700);
  const health = await request("/health");
  if (!health.ok) throw new Error("health not ok");

  const observability = await request("/api/observability/status");
  if (observability.release !== "dpl_social_cues_test" || observability.releaseTracking?.source !== "vercel-deployment") throw new Error("Sentry release fallback failed");
  if (!observability.sourceMapping?.ready || observability.sourceMapping.repository !== "NovaForgeShop/social-cues-app") throw new Error("Sentry GitHub source context readiness failed");

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

  const termsResponse = await fetch(base + "/terms");
  if (!termsResponse.ok || !(await termsResponse.text()).includes("Social Cues Terms of Service")) throw new Error("terms route failed");

  const model = await request("/api/model");
  if (!model.workspace || !Array.isArray(model.campaigns)) throw new Error("bad model shape");
  if (!Array.isArray(model.connectedAccounts)) throw new Error("bad accounts shape");
  if (Object.prototype.hasOwnProperty.call(model, "authUsers")) throw new Error("model exposed auth user ledger");
  if (JSON.stringify(model).includes('"token":') || JSON.stringify(model).includes('"accessToken":') || JSON.stringify(model).includes('"refreshToken":')) throw new Error("model leaked token material");
  if (JSON.stringify(model).includes('"oauthStates"')) throw new Error("model leaked oauth state ledger");

  const accountEmail = `alpha-${Date.now()}@socialcuesapp.com`;
  const accountPassword = "test-password-2026";
  const signup = await request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Alpha Tester", email: accountEmail, password: accountPassword, promoCode: promoCodes[0], workspaceName: "Social Cues Alpha" })
  });
  if (!signup.ok || signup.workspace.name !== "Social Cues Alpha" || !signup.session?.token) throw new Error("signup failed");
  if (signup.entitlement?.access !== "highest-tier-test" || signup.entitlement?.source !== "promo-code" || !signup.entitlement?.subscriptionPaid || !signup.entitlement?.appFeePaid) throw new Error("promo entitlement failed");

  const badLoginResponse = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: accountEmail, password: "wrong-password" })
  });
  if (badLoginResponse.status !== 401) throw new Error("bad login should be rejected");

  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Alpha Tester", email: accountEmail, password: accountPassword, workspaceName: "Social Cues Alpha" })
  });
  if (!login.ok || login.workspace.name !== "Social Cues Alpha" || !login.session?.token) throw new Error("login failed");

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

  const workspaceModelStatus = await request("/api/workspace/model/status", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!workspaceModelStatus.ok || !Object.prototype.hasOwnProperty.call(workspaceModelStatus, "mirrored")) throw new Error("workspace model status failed");

  const firstUserModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (firstUserModel.currentUser?.email !== accountEmail) throw new Error("signed-in model returned the wrong first user");
  const firstUserCampaignIds = new Set((firstUserModel.campaigns || []).map(item => item.id));
  if (!firstUserCampaignIds.size) throw new Error("first user workspace did not create private starter campaign data");

  const secondEmail = `alpha-second-${Date.now()}@socialcuesapp.com`;
  const secondSignup = await request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Second Tester", email: secondEmail, password: accountPassword, promoCode: promoCodes[1], workspaceName: "Second Workspace" })
  });
  if (!secondSignup.ok || !secondSignup.session?.token) throw new Error("second signup failed");
  const secondUserModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${secondSignup.session.token}` }
  });
  if (secondUserModel.currentUser?.email !== secondEmail) throw new Error("signed-in model returned the wrong second user");
  if ((secondUserModel.campaigns || []).some(item => firstUserCampaignIds.has(item.id))) throw new Error("second user can see first user campaigns");
  if ((secondUserModel.connectedAccounts || []).some(item => item.ownerUserId === login.user.id)) throw new Error("second user can see first user accounts");

  const generated = await request("/api/generate/platform-variants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ campaign: model.campaigns[0] })
  });
  if (!generated.ok || generated.variants.length < 6) throw new Error("generation failed");

  const queued = await request("/api/publish/social-cues/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variant: generated.variants[0] })
  });
  if (!queued.ok || queued.provider !== "social-cues-queue") throw new Error("queue failed");
  if (queued.status === "queued-local-simulation") throw new Error("queue returned demo simulation status");

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

  const metaStatus = await request("/api/oauth/meta/status");
  if (!metaStatus.ok || !metaStatus.redirectUri.includes("/api/oauth/meta/callback")) throw new Error("meta status failed");
  if (metaStatus.scopes.includes("business_management")) throw new Error("meta default login should not request business_management for non-business Page flow");

  const metaStartResponse = await fetch(base + "/api/oauth/meta/start?platform=instagram", { redirect: "manual" });
  if (![200, 302].includes(metaStartResponse.status)) throw new Error("meta start failed");
  if (metaStartResponse.status === 200) {
    const metaStartText = await metaStartResponse.text();
    if (!metaStartText.includes("Meta app id needed") && !metaStartText.includes("HTTPS callback needed")) throw new Error("meta start setup guidance failed");
  } else {
    const location = metaStartResponse.headers.get("location") || "";
    if (!location.includes("facebook.com") || !location.includes("dialog/oauth")) throw new Error("meta start redirect failed");
  }

  const threadsStatus = await request("/api/oauth/threads/status");
  if (!threadsStatus.ok || !threadsStatus.redirectUri.includes("/api/oauth/threads/callback")) throw new Error("threads status failed");

  const xStatus = await request("/api/oauth/x/status");
  if (!xStatus.ok || !xStatus.redirectUri.includes("/api/oauth/x/callback") || !xStatus.scopes.includes("tweet.write")) throw new Error("x status failed");

  const pinterestStatus = await request("/api/oauth/pinterest/status");
  if (!pinterestStatus.ok || !pinterestStatus.redirectUri.includes("/api/oauth/pinterest/callback") || !pinterestStatus.scopes.includes("pins:write")) throw new Error("pinterest status failed");

  const canvaStatus = await request("/api/oauth/canva/status");
  if (!canvaStatus.ok || !canvaStatus.redirectUri.includes("/api/oauth/canva/callback") || !canvaStatus.scopes.includes("design:meta:read")) throw new Error("canva status failed");

  const shopifyStatus = await request("/api/oauth/shopify/status");
  if (!shopifyStatus.ok || !shopifyStatus.redirectUri.includes("/api/oauth/shopify/callback") || !shopifyStatus.scopes.includes("read_products")) throw new Error("shopify status failed");

  const etsyStatus = await request("/api/oauth/etsy/status");
  if (!etsyStatus.ok || !etsyStatus.redirectUri.includes("/api/oauth/etsy/callback") || !etsyStatus.scopes.includes("listings_r")) throw new Error("etsy status failed");

  const twitchStatus = await request("/api/oauth/twitch/status");
  if (!twitchStatus.ok || !twitchStatus.redirectUri.includes("/api/oauth/twitch/callback") || !twitchStatus.scopes.includes("user:read:email")) throw new Error("twitch status failed");

  const xStartResponse = await fetch(base + "/api/oauth/x/start", { redirect: "manual" });
  if (![200, 302].includes(xStartResponse.status)) throw new Error("x start failed");
  if (xStartResponse.status === 200) {
    const xStartText = await xStartResponse.text();
    if (!xStartText.includes("X client id needed") && !xStartText.includes("X callback URL needed")) throw new Error("x start setup guidance failed");
  } else {
    const location = xStartResponse.headers.get("location") || "";
    if (!location.includes("x.com") || !location.includes("oauth2/authorize")) throw new Error("x start redirect failed");
  }

  const metaUseCases = await request("/api/meta/use-cases");
  if (!metaUseCases.ok || metaUseCases.total !== 19 || !Array.isArray(metaUseCases.useCases) || !Array.isArray(metaUseCases.capabilityMatrix)) throw new Error("meta use-case matrix failed");
  if (!metaUseCases.useCases.some(item => item.id === "oembed_read")) throw new Error("meta oEmbed use case missing");

  const metaCapabilities = await request("/api/meta/capabilities");
  if (!metaCapabilities.ok || metaCapabilities.total !== 19 || !metaCapabilities.capabilities.every(item => item.endpoint)) throw new Error("meta capabilities failed");
  if (!metaCapabilities.capabilities.some(item => item.id === "oembed_read" && item.endpoint === "/api/meta/oembed")) throw new Error("meta oEmbed capability missing");

  const diagnosticAgent = await request("/api/meta/diagnostic-agent");
  if (!diagnosticAgent.ok || !Array.isArray(diagnosticAgent.actions) || !diagnosticAgent.paidNeeds?.length) throw new Error("meta diagnostic agent failed");
  if (!diagnosticAgent.biggestMiss.includes("personal profile")) throw new Error("meta diagnostic agent missed personal profile/Page distinction");
  if (!diagnosticAgent.snapshot || !Array.isArray(diagnosticAgent.snapshot.blockedFeatures) || !diagnosticAgent.snapshot.retryOnlyAfter.includes("Facebook Page created")) throw new Error("meta diagnostic agent snapshot failed");

  const metaAssets = await request("/api/meta/assets");
  if (!metaAssets.ok || !Array.isArray(metaAssets.accounts) || !Array.isArray(metaAssets.capabilities)) throw new Error("meta assets failed");

  const metaHealth = await request("/api/meta/health", { method: "POST" });
  if (!metaHealth.ok || !Array.isArray(metaHealth.accounts) || !Array.isArray(metaHealth.capabilities) || !metaHealth.health) throw new Error("meta health failed");
  if (Object.prototype.hasOwnProperty.call(metaHealth.health, "token")) throw new Error("meta health exposed token-shaped field");
  if (metaHealth.accounts.some(account => !account.connected || !account.tokenStored || !account.providerAccountId)) throw new Error("meta health returned placeholder accounts as assets");

  const badMetaCallback = await fetch(base + "/api/oauth/meta/callback?code=fake-code&state=bad-state");
  if (badMetaCallback.status !== 400) throw new Error("meta callback should reject unissued OAuth state");

  const unsignedWebhook = await fetch(base + "/api/meta/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ object: "page", entry: [] })
  });
  if (![403, 503].includes(unsignedWebhook.status)) throw new Error("unsigned Meta webhook should be rejected");

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
  for (const id of ["openai", "stripe", "discord", "resend", "media_editor"]) {
    if (!coreReadiness.coreServices.some(service => service.id === id)) throw new Error(`missing ${id} readiness`);
  }

  const openaiReady = await request("/api/openai/readiness");
  if (!openaiReady.ok || !openaiReady.serverSideOnly) throw new Error("openai readiness failed");

  const discordReady = await request("/api/discord/readiness");
  if (!discordReady.ok || !discordReady.redirectUri.includes("/api/oauth/discord/callback")) throw new Error("discord readiness failed");

  const resendReady = await request("/api/resend/readiness");
  if (!resendReady.ok || !resendReady.smtp || !Array.isArray(resendReady.missingEnv)) throw new Error("resend readiness failed");

  const billingReady = await request("/api/billing/readiness");
  if (!billingReady.ok || !billingReady.mode) throw new Error("billing readiness failed");

  const mediaEditorReady = await request("/api/media/editor/readiness");
  if (!mediaEditorReady.ok || !Array.isArray(mediaEditorReady.outputs)) throw new Error("media editor readiness failed");

  const authReady = await request("/api/auth/readiness");
  if (!authReady.ok || !authReady.sessionStorage.includes("HMAC")) throw new Error("auth readiness failed");

  const storageReady = await request("/api/media/storage/readiness");
  if (!storageReady.ok || !storageReady.bucket || !Array.isArray(storageReady.missingEnv)) throw new Error("media storage readiness failed");

  const securityAudit = await request("/api/security/audit");
  if (!securityAudit.ok || !securityAudit.headers || !securityAudit.auth?.publicUserListHidden) throw new Error("security audit failed");
  if (!securityAudit.secrets?.oauthTokenEncryption || !securityAudit.auth?.workspaceModelMirror) throw new Error("security audit missed core hardening status");

  const mediaEditPlan = await request("/api/media/editor/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceName: "raw-test.mp4", brief: "Social Cues launch" })
  });
  if (!mediaEditPlan.ok || !mediaEditPlan.plan?.outputs?.length || !mediaEditPlan.serverRequirement) throw new Error("media editor plan failed");

  const mediaAsset = await request("/api/media/assets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${login.session.token}`
    },
    body: JSON.stringify({ fileName: "raw-test.mp4", kind: "video", title: "Raw smoke clip" })
  });
  if (!mediaAsset.ok || !mediaAsset.asset?.storagePath || mediaAsset.asset.createdBy !== login.user.id) throw new Error("media asset reservation failed");

  const manualConnectResponse = await fetch(base + "/api/accounts/tiktok", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "connected", handle: "@should-not-connect" })
  });
  if (manualConnectResponse.status !== 409) throw new Error("manual account connect should be blocked");

  const disconnectResponse = await request("/api/accounts/tiktok", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ disconnect: true, disabled: true, status: "not connected" })
  });
  if (!disconnectResponse.ok || disconnectResponse.account.connected || disconnectResponse.account.tokenStored) throw new Error("disconnect should clear account evidence");

  const accounts = await request("/api/accounts", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!accounts.ok || !accounts.accounts.some(account => account.platform === "tiktok")) throw new Error("accounts list failed");
  if (JSON.stringify(accounts.accounts).includes('"token"')) throw new Error("accounts leaked token material");
  const tiktok = accounts.accounts.find(account => account.platform === "tiktok");
  if (tiktok.connected || tiktok.tokenStored || tiktok.status === "connected") throw new Error("tiktok should not be marked connected without provider evidence");

  const exported = await request("/api/export");
  if (JSON.stringify(exported).includes('"token":') || JSON.stringify(exported).includes('"accessToken":') || JSON.stringify(exported).includes('"refreshToken":')) throw new Error("export leaked token material");
  if (JSON.stringify(exported).includes('"oauthStates"')) throw new Error("export leaked oauth state ledger");

  const analytics = await request("/api/analyze", { method: "POST" });
  if (!analytics.ok || !Array.isArray(analytics.analytics.metrics)) throw new Error("analytics failed");
  if (!Array.isArray(analytics.analytics.sourceBreakdown) || !Array.isArray(analytics.analytics.translatedAnalysis)) throw new Error("analytics source readout failed");
  if (!analytics.analytics.metrics.every(metric => metric.source && metric.kind)) throw new Error("analytics metrics must include source and kind");
  if (analytics.analytics.metrics.some(metric => ["Audience", "Avg. views", "Engagement", "Cadence"].includes(metric.label))) throw new Error("analytics contains unlabeled placeholder metrics");
  if (!analytics.analytics.metrics.some(metric => metric.kind === "manual" && metric.label.startsWith("Manual"))) throw new Error("manual baseline metrics are not clearly labeled");

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
