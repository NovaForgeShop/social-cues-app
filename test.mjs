import { spawn } from "node:child_process";
import { createCipheriv, createHash, createHmac, generateKeyPairSync, randomBytes, sign as signPayload } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { openLocalWorkspacePersistence } from "./local-workspace-persistence.mjs";

const PINTEREST_CREDENTIAL_ENV_NAMES = Object.freeze([
  "PINTEREST_APP_ID",
  "PINTEREST_APP_SECRET",
  "PINTEREST_CLIENT_ID",
  "PINTEREST_CLIENT_SECRET",
  "PINTEREST_OAUTH_CLIENT_ID",
  "PINTEREST_OAUTH_CLIENT_SECRET",
  "pinterest_app_id",
  "pinterest_app_secret",
  "pinterest_client_id",
  "pinterest_client_secret"
]);

function pinterestScenarioEnv(overrides = {}) {
  const env = { ...process.env };
  for (const existingName of Object.keys(env)) {
    if (PINTEREST_CREDENTIAL_ENV_NAMES.some(name => name.toLowerCase() === existingName.toLowerCase())) {
      delete env[existingName];
    }
  }
  return { ...env, ...overrides };
}

const DISCORD_SCENARIO_ENV_NAMES = Object.freeze([
  "DISCORD_CLIENT_ID",
  "DISCORD_APPLICATION_ID",
  "DISCORD_APP_ID",
  "DISCORD_OAUTH_CLIENT_ID",
  "discord_client_id",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_APP_SECRET",
  "DISCORD_OAUTH_CLIENT_SECRET",
  "discord_client_secret",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_INTERACTIONS_PUBLIC_KEY",
  "DISCORD_APP_PUBLIC_KEY",
  "discord_public_key",
  "DISCORD_BOT_TOKEN",
  "DISCORD_TOKEN",
  "DISCORD_BOT_SECRET",
  "discord_bot_token",
  "DISCORD_GUILD_ID",
  "DISCORD_SERVER_ID",
  "discord_guild_id",
  "DISCORD_ANNOUNCEMENT_CHANNEL_ID",
  "DISCORD_CHANNEL_ID",
  "DISCORD_DEFAULT_CHANNEL_ID",
  "discord_announcement_channel_id",
  "DISCORD_PUBLIC_APP_URL"
]);
const DISCORD_SCENARIO_ENV_KEYS = new Set(DISCORD_SCENARIO_ENV_NAMES.map(name => name.toLowerCase()));
const SYNTHETIC_DISCORD_APPLICATION_ID = "test-discord-application-id";
const SYNTHETIC_DISCORD_CLIENT_SECRET = "test-discord-app-secret";
const {
  publicKey: syntheticDiscordPublicKeyObject,
  privateKey: syntheticDiscordPrivateKey
} = generateKeyPairSync("ed25519");
const SYNTHETIC_DISCORD_PUBLIC_KEY = syntheticDiscordPublicKeyObject
  .export({ type: "spki", format: "der" })
  .subarray(-32)
  .toString("hex");
const DISCORD_COMMUNITY_PUBLIC_CREDENTIAL_KEYS = new Set([
  "credential", "refreshcredential", "token", "accesstoken", "refreshtoken",
  "encryptedtoken", "encryptedcredential", "clientsecret", "appsecret",
  "authorization", "cookie", "password", "sessiontoken", "sessiontokenhash"
]);
const SYNTHETIC_DISCORD_COMMUNITY_APPLICATION_ID = "280000000000000001";
const SYNTHETIC_DISCORD_COMMUNITY_CLIENT_SECRET = "p28-discord-client-secret";
const SYNTHETIC_DISCORD_COMMUNITY_AUTH_SECRET = "p28-discord-auth-secret-material-2026";
const SYNTHETIC_DISCORD_COMMUNITY_ENCRYPTION_KEY = "p28-discord-encryption-key-material-2026";
const SYNTHETIC_DISCORD_COMMUNITY_ACCESS_TOKEN = "p28-discord-access-token";
const SYNTHETIC_DISCORD_COMMUNITY_OWNER_PROMO = "P28-DISCORD-OWNER";
const SYNTHETIC_DISCORD_COMMUNITY_FOREIGN_PROMO = "P28-DISCORD-FOREIGN";
const SYNTHETIC_DISCORD_COMMUNITY_PROVIDER_ID = "280000000000000002";
const SYNTHETIC_DISCORD_COMMUNITY_GUILD_ID = "280000000000000003";
const DISCORD_COMMUNITY_SCOPES = Object.freeze(["identify", "guilds"]);

function discordScenarioEnv({ baseEnv = process.env, overrides = {} } = {}) {
  const env = { ...baseEnv };
  for (const existingName of Object.keys(env)) {
    if (DISCORD_SCENARIO_ENV_KEYS.has(existingName.toLowerCase())) delete env[existingName];
  }
  return { ...env, ...overrides };
}

function assertDiscordCommunityPrivateMarkersAbsent(value, markers, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) || "";
  if (markers.some(marker => marker && serialized.includes(marker))) {
    throw new Error(`Discord community fixture leaked a private value through ${label}`);
  }
}

function containsDiscordCommunityCredentialField(value) {
  if (Array.isArray(value)) return value.some(containsDiscordCommunityCredentialField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => (
    DISCORD_COMMUNITY_PUBLIC_CREDENTIAL_KEYS.has(String(key).replace(/[_-]/g, "").toLowerCase())
    || containsDiscordCommunityCredentialField(nested)
  ));
}

function discordInteractionSignature(rawBody, timestamp) {
  return signPayload(null, Buffer.from(`${timestamp}${rawBody}`), syntheticDiscordPrivateKey).toString("hex");
}

const TWITCH_CLIENT_ID_ENV_NAMES = Object.freeze([
  "TWITCH_CLIENT_ID",
  "TWITCH_APP_ID",
  "TWITCH_OAUTH_CLIENT_ID",
  "twitch_client_id"
]);
const TWITCH_CLIENT_SECRET_ENV_NAMES = Object.freeze([
  "TWITCH_CLIENT_SECRET",
  "TWITCH_APP_SECRET",
  "TWITCH_OAUTH_CLIENT_SECRET",
  "twitch_client_secret"
]);
const TWITCH_APPLICATION_CREDENTIAL_ENV_NAMES = Object.freeze([
  ...TWITCH_CLIENT_ID_ENV_NAMES,
  ...TWITCH_CLIENT_SECRET_ENV_NAMES
]);
const TWITCH_APPLICATION_CREDENTIAL_ENV_KEYS = new Set(
  TWITCH_APPLICATION_CREDENTIAL_ENV_NAMES.map(name => name.toLowerCase())
);
const TWITCH_PUBLIC_CREDENTIAL_KEYS = new Set([
  "credential", "refreshcredential", "token", "accesstoken", "refreshtoken",
  "encryptedtoken", "encryptedcredential", "clientsecret", "appsecret",
  "authorization", "cookie", "password", "sessiontoken", "sessiontokenhash"
]);
const SYNTHETIC_TWITCH_APP_ID = "twitch-fixture-app-id";
const SYNTHETIC_TWITCH_APP_SECRET = "twitch-fixture-app-secret";
const SYNTHETIC_TWITCH_CALLBACK_ACCESS_TOKEN = "twitch-fixture-callback-access-token";
const SYNTHETIC_TWITCH_CALLBACK_REFRESH_TOKEN = "twitch-fixture-callback-refresh-token";
const SYNTHETIC_TWITCH_CALLBACK_CODE = "twitch-fixture-callback-code";
const SYNTHETIC_TWITCH_TOKEN_ENCRYPTION_KEY = "twitch-fixture-token-encryption-key";
const SYNTHETIC_TWITCH_PROMO_CODE = "TWITCH-PORTAL-FIXTURE";
const SYNTHETIC_TWITCH_SECOND_PROMO_CODE = "TWITCH-PORTAL-FOREIGN";

function twitchScenarioEnv({ baseEnv = process.env, overrides = {} } = {}) {
  const env = { ...baseEnv };
  for (const existingName of Object.keys(env)) {
    if (TWITCH_APPLICATION_CREDENTIAL_ENV_KEYS.has(existingName.toLowerCase())) {
      delete env[existingName];
    }
  }
  return { ...env, ...overrides };
}

function assertTwitchCredentialValuesAbsent(value, credentialValues, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) || "";
  if (credentialValues.some(item => item && serialized.includes(item))) {
    throw new Error(`twitch credential fixture leaked a value through ${label}`);
  }
}

function containsTwitchPublicCredentialField(value) {
  if (Array.isArray(value)) return value.some(containsTwitchPublicCredentialField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => (
    TWITCH_PUBLIC_CREDENTIAL_KEYS.has(String(key).replace(/[_-]/g, "").toLowerCase())
    || containsTwitchPublicCredentialField(nested)
  ));
}

const GOOGLE_CALLBACK_CREDENTIAL_ENV_NAMES = Object.freeze([
  "GOOGLE_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_ID",
  "YOUTUBE_CLIENT_ID",
  "youtube_client_id",
  "google_client_id",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "YOUTUBE_CLIENT_SECRET",
  "youtube_client_secret",
  "google_client_secret"
]);
const GOOGLE_CALLBACK_CREDENTIAL_ENV_KEYS = new Set(
  GOOGLE_CALLBACK_CREDENTIAL_ENV_NAMES.map(name => name.toLowerCase())
);
const GOOGLE_CALLBACK_PUBLIC_CREDENTIAL_KEYS = new Set([
  "credential", "refreshcredential", "token", "accesstoken", "refreshtoken",
  "encryptedtoken", "encryptedcredential", "clientsecret", "appsecret",
  "authorization", "cookie", "oauthcode", "codeverifier"
]);
const SYNTHETIC_GOOGLE_CLIENT_ID = "p20-google-client-id.apps.googleusercontent.com";
const SYNTHETIC_GOOGLE_CLIENT_SECRET = "p20-google-client-secret";
const SYNTHETIC_GOOGLE_ACCESS_TOKEN = "p20-google-access-token";
const SYNTHETIC_GOOGLE_REFRESH_TOKEN = "p20-google-refresh-token";
const SYNTHETIC_GOOGLE_FAILURE_CODE = "p20-google-failure-code";
const SYNTHETIC_YOUTUBE_SUCCESS_CODE = "p20-youtube-success-code";
const SYNTHETIC_GOOGLE_BUSINESS_SUCCESS_CODE = "p20-google-business-success-code";
const SYNTHETIC_GOOGLE_TOKEN_ENCRYPTION_KEY = "p20-google-token-encryption-key";
const SYNTHETIC_GOOGLE_OWNER_PROMO_CODE = "P20-GOOGLE-OWNER";
const SYNTHETIC_GOOGLE_FOREIGN_PROMO_CODE = "P20-GOOGLE-FOREIGN";
const SYNTHETIC_GOOGLE_START_CLIENT_ID = "p25-google-start-client.apps.googleusercontent.com";
const SYNTHETIC_GOOGLE_START_CLIENT_SECRET = "p25-google-start-client-secret";
const SYNTHETIC_GOOGLE_START_AUTH_SECRET = "p25-google-start-auth-secret-material-2026";
const SYNTHETIC_GOOGLE_START_ENCRYPTION_KEY = "p25-google-start-encryption-key-material-2026";
const SYNTHETIC_GOOGLE_START_FOREIGN_PROMO_CODE = "P25-GOOGLE-START-FOREIGN";

const X_ACCOUNT_ENV_NAMES = Object.freeze([
  "X_CLIENT_ID",
  "TWITTER_CLIENT_ID",
  "X_OAUTH_CLIENT_ID",
  "X_CLIENT_SECRET",
  "TWITTER_CLIENT_SECRET",
  "X_OAUTH_CLIENT_SECRET",
  "X_OAUTH_SCOPES",
  "X_SCOPES",
  "TWITTER_OAUTH_SCOPES",
  "X_OAUTH_WRITE_SCOPES",
  "X_WRITE_SCOPES",
  "TWITTER_OAUTH_WRITE_SCOPES",
  "X_PUBLIC_APP_URL"
]);
const X_ACCOUNT_ENV_KEYS = new Set(X_ACCOUNT_ENV_NAMES.map(name => name.toLowerCase()));
const X_ACCOUNT_PUBLIC_CREDENTIAL_KEYS = new Set([
  "credential", "refreshcredential", "token", "accesstoken", "refreshtoken",
  "encryptedtoken", "encryptedcredential", "clientsecret", "appsecret",
  "authorization", "cookie", "password", "sessiontoken", "sessiontokenhash"
]);
const SYNTHETIC_X_ACCOUNT_CLIENT_ID = "p26-x-client-id";
const SYNTHETIC_X_ACCOUNT_CLIENT_SECRET = "p26-x-client-secret";
const SYNTHETIC_X_ACCOUNT_AUTH_SECRET = "p26-x-auth-secret-material-2026";
const SYNTHETIC_X_ACCOUNT_ENCRYPTION_KEY = "p26-x-encryption-key-material-2026";
const SYNTHETIC_X_ACCOUNT_ACCESS_TOKEN = "fake-test-token-marker";
const SYNTHETIC_X_ACCOUNT_OWNER_PROMO = "P26-X-OWNER";
const SYNTHETIC_X_ACCOUNT_FOREIGN_PROMO = "P26-X-FOREIGN";
const SYNTHETIC_X_ACCOUNT_PROVIDER_ID = "test-p26-x-owner";
const X_ACCOUNT_READ_SCOPES = Object.freeze(["tweet.read", "users.read", "offline.access"]);
const X_ACCOUNT_WRITE_SCOPES = Object.freeze(["tweet.read", "tweet.write", "users.read", "offline.access"]);

function xAccountScenarioEnv({ baseEnv = process.env, overrides = {} } = {}) {
  const env = { ...baseEnv };
  for (const existingName of Object.keys(env)) {
    if (X_ACCOUNT_ENV_KEYS.has(existingName.toLowerCase())) delete env[existingName];
  }
  return { ...env, ...overrides };
}

function assertXAccountPrivateMarkersAbsent(value, markers, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) || "";
  if (markers.some(marker => marker && serialized.includes(marker))) {
    throw new Error(`X account fixture leaked a private value through ${label}`);
  }
}

function containsXAccountCredentialField(value) {
  if (Array.isArray(value)) return value.some(containsXAccountCredentialField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => (
    X_ACCOUNT_PUBLIC_CREDENTIAL_KEYS.has(String(key).replace(/[_-]/g, "").toLowerCase())
    || containsXAccountCredentialField(nested)
  ));
}

function googleCallbackScenarioEnv({ baseEnv = process.env, overrides = {} } = {}) {
  const env = { ...baseEnv };
  for (const existingName of Object.keys(env)) {
    if (GOOGLE_CALLBACK_CREDENTIAL_ENV_KEYS.has(existingName.toLowerCase())) delete env[existingName];
  }
  return { ...env, ...overrides };
}

function assertGoogleCallbackSecretsAbsent(value, markers, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) || "";
  if (markers.some(marker => marker && serialized.includes(marker))) {
    throw new Error(`Google callback fixture leaked a private value through ${label}`);
  }
}

function assertGoogleStartPrivateMarkersAbsent(value, markers, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) || "";
  if (markers.some(marker => marker && serialized.includes(marker))) {
    throw new Error(`Google start fixture leaked a private value through ${label}`);
  }
}

function containsGoogleCallbackCredentialField(value) {
  if (Array.isArray(value)) return value.some(containsGoogleCallbackCredentialField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => (
    GOOGLE_CALLBACK_PUBLIC_CREDENTIAL_KEYS.has(String(key).replace(/[_-]/g, "").toLowerCase())
    || containsGoogleCallbackCredentialField(nested)
  ));
}

const META_START_CREDENTIAL_ENV_NAMES = Object.freeze([
  "META_APP_ID",
  "META_CLIENT_ID",
  "FACEBOOK_APP_ID",
  "FACEBOOK_CLIENT_ID",
  "FB_APP_ID",
  "META_APP_SECRET",
  "META_CLIENT_SECRET",
  "FACEBOOK_APP_SECRET",
  "FACEBOOK_CLIENT_SECRET",
  "FB_APP_SECRET"
]);
const META_START_CREDENTIAL_ENV_KEYS = new Set(META_START_CREDENTIAL_ENV_NAMES.map(name => name.toLowerCase()));
const SYNTHETIC_META_START_APP_ID = "p21-meta-app-id";
const SYNTHETIC_META_START_APP_SECRET = "p21-meta-app-secret";
const SYNTHETIC_META_START_AUTH_SECRET = "p21-meta-session-secret";
const SYNTHETIC_META_START_ENCRYPTION_KEY = "p21-meta-encryption-key";
const SYNTHETIC_META_START_OWNER_PROMO = "P21-META-OWNER";
const SYNTHETIC_META_ASSETS_APP_ID = "220000000000001";
const SYNTHETIC_META_ASSETS_APP_SECRET = "p22-meta-assets-app-secret";
const SYNTHETIC_META_ASSETS_USER_ID = "220000000000002";
const SYNTHETIC_META_ASSETS_USER_TOKEN = "p22-meta-user-token";
const SYNTHETIC_META_ASSETS_PAGE_ID = "220000000000003";
const SYNTHETIC_META_ASSETS_PAGE_TOKEN = "p22-facebook-page-token";
const SYNTHETIC_META_ASSETS_INSTAGRAM_ID = "220000000000004";
const SYNTHETIC_META_ASSETS_AUTH_SECRET = "p22-meta-assets-session-secret";
const SYNTHETIC_META_ASSETS_ENCRYPTION_KEY = "p22-meta-assets-encryption-key";
const SYNTHETIC_META_ASSETS_OWNER_PROMO = "P22-META-ASSETS-OWNER";
const SYNTHETIC_META_ASSETS_FOREIGN_PROMO = "P22-META-ASSETS-FOREIGN";
const SYNTHETIC_META_CALLBACK_APP_ID = "230000000000001";
const SYNTHETIC_META_CALLBACK_APP_SECRET = "p23-meta-callback-app-secret";
const SYNTHETIC_META_CALLBACK_AUTH_SECRET = "p23-meta-callback-session-secret";
const SYNTHETIC_META_CALLBACK_ENCRYPTION_KEY = "p23-meta-callback-encryption-key";
const SYNTHETIC_META_CALLBACK_FAILURE_CODE = "p23-meta-callback-failure-code";
const SYNTHETIC_META_CALLBACK_OWNER_PROMO = "P23-META-CALLBACK-OWNER";
const SYNTHETIC_META_CALLBACK_FOREIGN_PROMO = "P23-META-CALLBACK-FOREIGN";
const SYNTHETIC_META_ATOMIC_APP_ID = "240000000000001";
const SYNTHETIC_META_ATOMIC_APP_SECRET = "p24-meta-callback-app-secret";
const SYNTHETIC_META_ATOMIC_AUTH_SECRET = "p24-meta-callback-session-secret";
const SYNTHETIC_META_ATOMIC_ENCRYPTION_KEY = "p24-meta-callback-encryption-key";
const SYNTHETIC_META_ATOMIC_FAILURE_CODE = "p24-meta-callback-failure-code";
const SYNTHETIC_META_ATOMIC_SUCCESS_CODE = "p24-meta-callback-success-code";
const SYNTHETIC_META_ATOMIC_SHORT_TOKEN = "p24-meta-short-lived-token";
const SYNTHETIC_META_ATOMIC_USER_TOKEN = "p24-meta-long-lived-token";
const SYNTHETIC_META_ATOMIC_PAGE_TOKEN = "p24-meta-page-token";
const SYNTHETIC_META_ATOMIC_USER_ID = "240000000000002";
const SYNTHETIC_META_ATOMIC_PAGE_ID = "240000000000003";
const SYNTHETIC_META_ATOMIC_INSTAGRAM_ID = "240000000000004";
const SYNTHETIC_META_ATOMIC_OWNER_PROMO = "P24-META-CALLBACK-OWNER";
const SYNTHETIC_META_ATOMIC_FOREIGN_PROMO = "P24-META-CALLBACK-FOREIGN";
const META_CALLBACK_UNISSUED_ERROR = "OAuth state was not issued by this backend or was already used.";
const META_CALLBACK_OWNER_REQUIRED_ERROR = "Sign in to the same Social Cues account that started this connection, then try again.";
const META_CALLBACK_OWNER_MISMATCH_ERROR = "OAuth state belongs to a different signed-in Social Cues user. Start the connection again from the app.";
const META_ASSETS_GRANTED_SCOPES = Object.freeze([
  "public_profile",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts"
]);

function metaStartScenarioEnv({ baseEnv = process.env, overrides = {} } = {}) {
  const env = { ...baseEnv };
  for (const existingName of Object.keys(env)) {
    if (META_START_CREDENTIAL_ENV_KEYS.has(existingName.toLowerCase()) || existingName.toLowerCase() === "vercel") {
      delete env[existingName];
    }
  }
  return { ...env, ...overrides };
}

function assertMetaStartPrivateMarkersAbsent(value, markers, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) || "";
  if (markers.some(marker => marker && serialized.includes(marker))) {
    throw new Error(`Meta start fixture leaked a private marker through ${label}`);
  }
}

function assertMetaAssetsPrivateMarkersAbsent(value, markers, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) || "";
  if (markers.some(marker => marker && serialized.includes(marker))) {
    throw new Error(`Meta assets fixture leaked a private marker through ${label}`);
  }
}

function assertMetaCallbackPrivateMarkersAbsent(value, markers, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) || "";
  if (markers.some(marker => marker && serialized.includes(marker))) {
    throw new Error(`Meta callback fixture leaked a private marker through ${label}`);
  }
}

function signedMetaCallbackState(sourceState, overrides, secret) {
  const decoded = JSON.parse(Buffer.from(sourceState, "base64url").toString("utf8"));
  const { sig: ignoredSignature, ...payload } = decoded;
  const nextPayload = { ...payload, ...overrides };
  const sig = createHmac("sha256", secret).update(JSON.stringify(nextPayload)).digest("base64url");
  return Buffer.from(JSON.stringify({ ...nextPayload, sig })).toString("base64url");
}

function metaAssetsPublicShapeIsSafe(value) {
  const sensitiveKeys = new Set([
    "credential", "refreshcredential", "token", "accesstoken", "refreshtoken", "oauthcode",
    "encryptedtoken", "encryptedcredential", "encryptedrefreshtoken", "clientsecret", "appsecret",
    "codeverifier", "password", "sessiontoken", "sessiontokenhash", "authorization", "cookie",
    "oauthstates", "oauthevents"
  ]);
  const visit = current => {
    if (Array.isArray(current)) return current.every(visit);
    if (!current || typeof current !== "object") return true;
    return Object.entries(current).every(([key, nested]) => (
      !sensitiveKeys.has(String(key).replace(/[_-]/g, "").toLowerCase()) && visit(nested)
    ));
  };
  return visit(value);
}

// The focused contract owns the exhaustive credential/callback matrix. This helper keeps
// the monolithic suite at the authenticated workspace-integration boundary.
function twitchPortalIntegrationStateIsTruthful(fixture = {}) {
  const portal = fixture.portal || {};
  const missingEnv = fixture.missingEnv || [];
  const action = String(portal.nextAction || "");
  const connect = /^Connect Twitch\b/iu.test(action);
  const reconnect = /^Reconnect Twitch\b/iu.test(action);
  const credentialLike = fixture.publicPayload && containsTwitchPublicCredentialField(fixture.publicPayload);
  if (!fixture.authenticated || !fixture.workspaceContext || !fixture.workspaceIdMatches) return false;
  if (fixture.foreignMetadataPresent || credentialLike) return false;
  if (fixture.externalRequests !== 0) return false;
  if (fixture.requiredProviderGatesMissing && fixture.executable) return false;
  if (fixture.configured !== fixture.readinessConfigured || fixture.configured !== fixture.envReady) return false;
  if (fixture.configured && missingEnv.length) return false;

  if (fixture.expectedDecision === "application-credentials") {
    return !fixture.configured
      && missingEnv.includes("TWITCH_CLIENT_ID")
      && missingEnv.includes("TWITCH_CLIENT_SECRET")
      && fixture.accountPresent === true
      && fixture.connected === true
      && fixture.banked === true
      && portal.status === "needs-application-credentials"
      && portal.phase === "application-configuration"
      && portal.category === "application-credentials"
      && /^Configure TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET\b/iu.test(action)
      && !connect
      && !reconnect
      && !fixture.executable;
  }
  if (fixture.expectedDecision === "connect") {
    return fixture.configured
      && fixture.accountPresent === false
      && fixture.connected === false
      && fixture.banked === false
      && portal.status === "workspace-connect-required"
      && portal.phase === "workspace-authorization"
      && portal.category === "connect"
      && connect
      && !reconnect
      && !fixture.executable;
  }
  if (fixture.expectedDecision === "developer-approval") {
    return fixture.configured
      && fixture.accountPresent === true
      && fixture.connected === true
      && fixture.banked === true
      && portal.status === "workspace-token-banked-approval-pending"
      && portal.phase === "provider-proof"
      && portal.category === "developer-approval"
      && !connect
      && !reconnect
      && /developer approval/iu.test(action)
      && !fixture.executable;
  }
  return false;
}

function assertTwitchPortalIntegrationMutations(missingFixture, connectFixture, bankedFixture) {
  const mutations = [
    ["missing app credentials reported as reconnect", missingFixture, fixture => { fixture.portal.category = "reconnect"; fixture.portal.nextAction = "Reconnect Twitch"; }],
    ["no account reported as reconnect", connectFixture, fixture => { fixture.portal.category = "reconnect"; fixture.portal.nextAction = "Reconnect Twitch"; }],
    ["banked account reported as connect", bankedFixture, fixture => { fixture.portal.category = "connect"; fixture.portal.nextAction = "Connect Twitch"; }],
    ["banked account reported as reconnect", bankedFixture, fixture => { fixture.portal.category = "reconnect"; fixture.portal.nextAction = "Reconnect Twitch"; }],
    ["workspace token satisfied app readiness", missingFixture, fixture => { fixture.configured = true; fixture.readinessConfigured = true; fixture.envReady = true; }],
    ["foreign workspace influenced guidance", connectFixture, fixture => { fixture.workspaceIdMatches = false; fixture.foreignMetadataPresent = true; }],
    ["configured secret remained missing", connectFixture, fixture => { fixture.missingEnv = ["TWITCH_CLIENT_SECRET"]; }],
    ["credential-like public field", bankedFixture, fixture => { fixture.publicPayload = { accessToken: "synthetic-public-token" }; }],
    ["provider label without workspace proof", connectFixture, fixture => { fixture.authenticated = false; fixture.workspaceContext = false; }],
    ["executable while provider gates remain", bankedFixture, fixture => { fixture.executable = true; fixture.requiredProviderGatesMissing = true; }]
  ];
  for (const [label, source, mutate] of mutations) {
    const fixture = structuredClone(source);
    mutate(fixture);
    if (twitchPortalIntegrationStateIsTruthful(fixture)) {
      throw new Error(`Twitch portal integration assertion accepted mutation: ${label}`);
    }
  }
  return mutations.length;
}

function assertTwitchScenarioEnvironmentHelper() {
  const parentBefore = JSON.stringify(Object.entries(process.env));
  const baseEnv = {
    ...process.env,
    ...Object.fromEntries(TWITCH_APPLICATION_CREDENTIAL_ENV_NAMES.map((name, index) => [name, `inherited-twitch-${index}`])),
    TwItCh_ApP_Id: "inherited-twitch-mixed-case-id",
    tWiTcH_aPp_SeCrEt: "inherited-twitch-mixed-case-secret",
    SOCIAL_CUES_TWITCH_UNRELATED_SENTINEL: "preserved"
  };
  const baseBefore = JSON.stringify(Object.entries(baseEnv));
  const overrides = {
    TWITCH_APP_ID: SYNTHETIC_TWITCH_APP_ID,
    TWITCH_APP_SECRET: SYNTHETIC_TWITCH_APP_SECRET
  };
  const first = twitchScenarioEnv({ baseEnv, overrides });
  const second = twitchScenarioEnv({ baseEnv, overrides });
  if (first === second || first === baseEnv || second === baseEnv) throw new Error("twitch scenario environments must be fresh objects");
  if (first.SOCIAL_CUES_TWITCH_UNRELATED_SENTINEL !== "preserved") throw new Error("twitch scenario isolation removed an unrelated environment variable");
  const retainedNames = Object.keys(first).filter(name => TWITCH_APPLICATION_CREDENTIAL_ENV_KEYS.has(name.toLowerCase())).sort();
  if (JSON.stringify(retainedNames) !== JSON.stringify(Object.keys(overrides).sort())) throw new Error("twitch scenario isolation retained inherited application credentials");
  if (JSON.stringify(Object.entries(baseEnv)) !== baseBefore) throw new Error("twitch scenario isolation mutated its supplied base environment");
  if (JSON.stringify(Object.entries(process.env)) !== parentBefore) throw new Error("twitch scenario isolation mutated the parent process environment");
}

function assertCommittedTwitchCredentialContract(source) {
  const requiredMarkers = [
    'TWITCH_CLIENT_ID: ["TWITCH_APP_ID", "TWITCH_OAUTH_CLIENT_ID", "twitch_client_id"]',
    'TWITCH_CLIENT_SECRET: ["TWITCH_APP_SECRET", "TWITCH_OAUTH_CLIENT_SECRET", "twitch_client_secret"]',
    'function resolveTwitchApplicationCredentialState()',
    'const twitchApplicationCredentials = resolveTwitchApplicationCredentialState();',
    'credentialState: twitchApplicationCredentials',
    'configured: () => twitchApplicationCredentials.configured',
    'client_id: twitchClientId',
    'client_secret: twitchClientSecret',
    'function twitchSetupAuditForWorkspace(',
    'function developerPortalAuditForWorkspace(',
    'if (!twitchApplicationCredentials.configured)'
  ];
  if (requiredMarkers.some(marker => !source.includes(marker))) throw new Error("committed Twitch credential-resolution contract is incomplete");
}

const SHOPIFY_CLIENT_ID_ENV_NAMES = Object.freeze([
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_API_KEY",
  "SHOPIFY_APP_ID",
  "SHOPIFY_APP_CLIENT_ID",
  "shopify_client_id",
  "shopify_api_key"
]);
const SHOPIFY_CLIENT_SECRET_ENV_NAMES = Object.freeze([
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_SECRET",
  "SHOPIFY_APP_CLIENT_SECRET",
  "shopify_client_secret",
  "shopify_api_secret"
]);
const SHOPIFY_APPLICATION_CREDENTIAL_ENV_NAMES = Object.freeze([
  ...SHOPIFY_CLIENT_ID_ENV_NAMES,
  ...SHOPIFY_CLIENT_SECRET_ENV_NAMES
]);
const SHOPIFY_SHOP_DOMAIN_ENV_NAMES = Object.freeze([
  "SHOPIFY_SHOP_DOMAIN",
  "SHOPIFY_STORE_DOMAIN",
  "SHOPIFY_TEST_STORE_DOMAIN",
  "shopify_shop_domain"
]);
const SHOPIFY_CONFIGURATION_ENV_NAMES = Object.freeze([
  ...SHOPIFY_SHOP_DOMAIN_ENV_NAMES,
  "SHOPIFY_PUBLIC_APP_URL",
  "SHOPIFY_API_VERSION",
  "PUBLIC_APP_URL"
]);
const SHOPIFY_SCENARIO_ENV_NAMES = Object.freeze([
  ...SHOPIFY_APPLICATION_CREDENTIAL_ENV_NAMES,
  ...SHOPIFY_CONFIGURATION_ENV_NAMES
]);
const SHOPIFY_TEST_ONLY_UNKNOWN_ENV_NAMES = Object.freeze([
  "SHOPIFY_FIXTURE_UNKNOWN_CLIENT_ID",
  "SHOPIFY_FIXTURE_UNKNOWN_CLIENT_SECRET"
]);
const SHOPIFY_SCENARIO_ENV_KEYS = new Set(SHOPIFY_SCENARIO_ENV_NAMES.map(name => name.toLowerCase()));
const SHOPIFY_MISSING_CLIENT_ID = "SHOPIFY_CLIENT_ID (32-character Shopify client ID/API key)";
const SHOPIFY_MISSING_CLIENT_SECRET = "SHOPIFY_CLIENT_SECRET (shpss_ client secret)";
const SYNTHETIC_SHOPIFY_APP_ID = "0".repeat(32);
const SYNTHETIC_SHOPIFY_APP_SECRET = `shpss_${"0".repeat(32)}`;

function shopifyScenarioEnv({ baseEnv = process.env, overrides = {} } = {}) {
  const env = { ...baseEnv };
  for (const existingName of Object.keys(env)) {
    if (SHOPIFY_SCENARIO_ENV_KEYS.has(existingName.toLowerCase())) {
      delete env[existingName];
    }
  }
  return { ...env, ...overrides };
}

function assertShopifyCredentialValuesAbsent(value, credentialValues, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) || "";
  if (credentialValues.some(item => item && serialized.includes(item))) {
    throw new Error(`shopify credential fixture leaked a value through ${label}`);
  }
}

const port = 4199;
const base = `http://127.0.0.1:${port}`;
const testDataDir = path.join(process.cwd(), ".tmp", `regression-data-${port}-${Date.now()}`);
const externalRequestLogPath = path.join(testDataDir, "external-http-requests.ndjson");
const providerMockLogPath = path.join(testDataDir, "provider-mocks.ndjson");
const externalRequestGuardPath = path.join(testDataDir, "external-request-guard.mjs");
await mkdir(testDataDir, { recursive: true });
await writeFile(externalRequestGuardPath, `
import { appendFile } from "node:fs/promises";

const originalFetch = globalThis.fetch;
const logPath = process.env.SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG || "";
const mockLogPath = process.env.SOCIAL_CUES_TEST_PROVIDER_MOCK_LOG || "";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

async function recordProviderMock(entry) {
  if (mockLogPath) await appendFile(mockLogPath, JSON.stringify(entry) + "\\n", "utf8");
}

globalThis.fetch = async (input, init = {}) => {
  const rawUrl = input instanceof URL || typeof input === "string" ? String(input) : String(input?.url || "");
  const target = new URL(rawUrl);
  if (process.env.SOCIAL_CUES_TEST_MOCK_TWITCH_CALLBACK === "true"
    && target.hostname === "id.twitch.tv"
    && target.pathname === "/oauth2/token") {
    const parameters = new URLSearchParams(String(init.body || ""));
    await recordProviderMock({
      kind: "twitch-token-mock",
      clientIdMatches: parameters.get("client_id") === process.env.TWITCH_APP_ID,
      clientSecretMatches: parameters.get("client_secret") === process.env.TWITCH_APP_SECRET,
      grantType: parameters.get("grant_type") || ""
    });
    return new Response(JSON.stringify({
      access_token: "${SYNTHETIC_TWITCH_CALLBACK_ACCESS_TOKEN}",
      refresh_token: "${SYNTHETIC_TWITCH_CALLBACK_REFRESH_TOKEN}",
      token_type: "bearer",
      expires_in: 3600,
      scope: ["user:read:email"]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_TWITCH_CALLBACK === "true"
    && target.hostname === "id.twitch.tv"
    && target.pathname === "/oauth2/validate") {
    const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
    await recordProviderMock({
      kind: "twitch-validate-mock",
      bearerPresent: /^OAuth\\s+\\S+$/u.test(headers.get("authorization") || "")
    });
    return new Response(JSON.stringify({
      client_id: process.env.TWITCH_APP_ID,
      login: "synthetic_portal_fixture",
      scopes: ["user:read:email"],
      user_id: "123456789",
      expires_in: 3600
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_TWITCH_CALLBACK === "true"
    && target.hostname === "api.twitch.tv"
    && target.pathname === "/helix/users") {
    const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
    await recordProviderMock({
      kind: "twitch-users-mock",
      clientIdMatches: headers.get("client-id") === process.env.TWITCH_APP_ID,
      bearerPresent: /^Bearer\\s+\\S+$/u.test(headers.get("authorization") || "")
    });
    return new Response(JSON.stringify({
      data: [{ id: "123456789", login: "synthetic_portal_fixture", display_name: "Synthetic Portal Fixture" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_GOOGLE_CALLBACK === "true"
    && target.hostname === "oauth2.googleapis.com"
    && target.pathname === "/token") {
    const parameters = new URLSearchParams(String(init.body || ""));
    const code = parameters.get("code") || "";
    const failed = code === process.env.SOCIAL_CUES_TEST_GOOGLE_FAILURE_CODE;
    const business = code === process.env.SOCIAL_CUES_TEST_GOOGLE_BUSINESS_SUCCESS_CODE;
    await recordProviderMock({
      kind: "google-token-mock",
      outcome: failed ? "failed" : "succeeded",
      flow: business ? "google_business" : "youtube",
      clientIdMatches: parameters.get("client_id") === process.env.GOOGLE_CLIENT_ID,
      clientSecretMatches: parameters.get("client_secret") === process.env.GOOGLE_CLIENT_SECRET,
      redirectMatches: parameters.get("redirect_uri") === "https://socialcuesapp.com/api/oauth/youtube/callback",
      grantType: parameters.get("grant_type") || ""
    });
    if (failed) {
      return new Response(JSON.stringify({
        error: "invalid_grant",
        error_description: "Synthetic Google token exchange rejected."
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      access_token: "${SYNTHETIC_GOOGLE_ACCESS_TOKEN}",
      refresh_token: "${SYNTHETIC_GOOGLE_REFRESH_TOKEN}",
      token_type: "Bearer",
      expires_in: 3600,
      scope: business
        ? "https://www.googleapis.com/auth/business.manage"
        : "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_GOOGLE_CALLBACK === "true"
    && target.hostname === "www.googleapis.com"
    && target.pathname === "/youtube/v3/channels") {
    const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
    await recordProviderMock({
      kind: "youtube-channels-mock",
      bearerPresent: /^Bearer\\s+\\S+$/u.test(headers.get("authorization") || ""),
      mine: target.searchParams.get("mine") || "",
      partPresent: Boolean(target.searchParams.get("part"))
    });
    return new Response(JSON.stringify({
      items: [{
        id: "test-p20-youtube-channel",
        snippet: { title: "P20 YouTube Channel", customUrl: "@p20-youtube" },
        statistics: { subscriberCount: "20", videoCount: "2", viewCount: "200" },
        contentDetails: {},
        status: { privacyStatus: "public" }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_GOOGLE_CALLBACK === "true"
    && target.hostname === "mybusinessaccountmanagement.googleapis.com"
    && target.pathname === "/v1/accounts") {
    const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
    await recordProviderMock({
      kind: "google-business-accounts-mock",
      bearerPresent: /^Bearer\\s+\\S+$/u.test(headers.get("authorization") || ""),
      pageSize: target.searchParams.get("pageSize") || ""
    });
    return new Response(JSON.stringify({
      accounts: [{
        name: "accounts/p20-business-account",
        accountName: "P20 Business Account",
        type: "LOCATION_GROUP",
        role: "PRIMARY_OWNER",
        verificationState: "VERIFIED",
        vettedState: "VETTED"
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_GOOGLE_CALLBACK === "true"
    && target.hostname === "mybusinessbusinessinformation.googleapis.com"
    && target.pathname === "/v1/accounts/p20-business-account/locations") {
    const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
    await recordProviderMock({
      kind: "google-business-locations-mock",
      bearerPresent: /^Bearer\\s+\\S+$/u.test(headers.get("authorization") || ""),
      readMaskPresent: Boolean(target.searchParams.get("readMask")),
      pageSize: target.searchParams.get("pageSize") || ""
    });
    return new Response(JSON.stringify({
      locations: [{
        name: "locations/p20-location-1",
        title: "P20 Business Location",
        storeCode: "P20-01",
        websiteUri: "https://example.test/p20",
        metadata: { canOperateLocalPost: true },
        profile: { description: "Synthetic P20 business location" }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_META_CALLBACK_ATOMIC === "true"
    && target.hostname === "graph.facebook.com"
    && target.pathname.endsWith("/oauth/access_token")) {
    const grantType = target.searchParams.get("grant_type") || "";
    const code = target.searchParams.get("code") || "";
    if (code === process.env.SOCIAL_CUES_TEST_META_ATOMIC_FAILURE_CODE) {
      await recordProviderMock({
        kind: "meta-token-exchange-failure-mock-p24",
        method: String(init?.method || input?.method || "GET").toUpperCase(),
        clientIdMatches: target.searchParams.get("client_id") === process.env.META_APP_ID,
        clientSecretMatches: target.searchParams.get("client_secret") === process.env.META_APP_SECRET,
        redirectMatches: target.searchParams.get("redirect_uri") === "https://socialcuesapp.com/api/oauth/meta/callback",
        codeMatches: code === process.env.SOCIAL_CUES_TEST_META_ATOMIC_FAILURE_CODE,
        grantTypeAbsent: !grantType
      });
      return new Response(JSON.stringify({
        error: { message: "Synthetic P24 Meta token exchange rejected.", type: "OAuthException", code: 190 }
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (!grantType && code === process.env.SOCIAL_CUES_TEST_META_ATOMIC_SUCCESS_CODE) {
      await recordProviderMock({
        kind: "meta-short-token-mock-p24",
        method: String(init?.method || input?.method || "GET").toUpperCase(),
        clientIdMatches: target.searchParams.get("client_id") === process.env.META_APP_ID,
        clientSecretMatches: target.searchParams.get("client_secret") === process.env.META_APP_SECRET,
        redirectMatches: target.searchParams.get("redirect_uri") === "https://socialcuesapp.com/api/oauth/meta/callback",
        codeMatches: true,
        grantTypeAbsent: true
      });
      return new Response(JSON.stringify({
        access_token: process.env.SOCIAL_CUES_TEST_META_ATOMIC_SHORT_TOKEN,
        token_type: "bearer",
        expires_in: 3600
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (grantType === "fb_exchange_token") {
      await recordProviderMock({
        kind: "meta-long-token-mock-p24",
        method: String(init?.method || input?.method || "GET").toUpperCase(),
        clientIdMatches: target.searchParams.get("client_id") === process.env.META_APP_ID,
        clientSecretMatches: target.searchParams.get("client_secret") === process.env.META_APP_SECRET,
        shortTokenMatches: target.searchParams.get("fb_exchange_token") === process.env.SOCIAL_CUES_TEST_META_ATOMIC_SHORT_TOKEN,
        grantTypeMatches: true
      });
      return new Response(JSON.stringify({
        access_token: process.env.SOCIAL_CUES_TEST_META_ATOMIC_USER_TOKEN,
        token_type: "bearer",
        expires_in: 5184000
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_META_CALLBACK_ATOMIC === "true"
    && target.hostname === "graph.facebook.com"
    && target.pathname.endsWith("/me")) {
    await recordProviderMock({
      kind: "meta-user-mock-p24",
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      userTokenMatches: target.searchParams.get("access_token") === process.env.SOCIAL_CUES_TEST_META_ATOMIC_USER_TOKEN,
      fieldsPresent: target.searchParams.get("fields") === "id,name,picture"
    });
    return new Response(JSON.stringify({
      id: process.env.SOCIAL_CUES_TEST_META_ATOMIC_USER_ID,
      name: "P24 Meta User"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_META_CALLBACK_ATOMIC === "true"
    && target.hostname === "graph.facebook.com"
    && target.pathname.endsWith("/debug_token")) {
    await recordProviderMock({
      kind: "meta-debug-token-mock-p24",
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      inputTokenMatches: target.searchParams.get("input_token") === process.env.SOCIAL_CUES_TEST_META_ATOMIC_USER_TOKEN,
      appAccessTokenMatches: target.searchParams.get("access_token") === process.env.META_APP_ID + "|" + process.env.META_APP_SECRET
    });
    return new Response(JSON.stringify({
      data: {
        is_valid: true,
        app_id: process.env.META_APP_ID,
        user_id: process.env.SOCIAL_CUES_TEST_META_ATOMIC_USER_ID,
        expires_at: 4102444800,
        scopes: ${JSON.stringify(META_ASSETS_GRANTED_SCOPES)}
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_META_CALLBACK_ATOMIC === "true"
    && target.hostname === "graph.facebook.com"
    && target.pathname.endsWith("/me/permissions")) {
    await recordProviderMock({
      kind: "meta-permissions-mock-p24",
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      userTokenMatches: target.searchParams.get("access_token") === process.env.SOCIAL_CUES_TEST_META_ATOMIC_USER_TOKEN
    });
    return new Response(JSON.stringify({
      data: ${JSON.stringify(META_ASSETS_GRANTED_SCOPES)}.map(permission => ({ permission, status: "granted" }))
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_META_CALLBACK_ATOMIC === "true"
    && target.hostname === "graph.facebook.com"
    && target.pathname.endsWith("/me/accounts")) {
    await recordProviderMock({
      kind: "meta-accounts-mock-p24",
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      userTokenMatches: target.searchParams.get("access_token") === process.env.SOCIAL_CUES_TEST_META_ATOMIC_USER_TOKEN,
      fieldsPresent: Boolean(target.searchParams.get("fields"))
    });
    return new Response(JSON.stringify({
      data: [{
        id: process.env.SOCIAL_CUES_TEST_META_ATOMIC_PAGE_ID,
        name: "P24 Facebook Page",
        category: "Software",
        access_token: process.env.SOCIAL_CUES_TEST_META_ATOMIC_PAGE_TOKEN,
        tasks: ["ANALYZE", "CREATE_CONTENT"],
        instagram_business_account: {
          id: process.env.SOCIAL_CUES_TEST_META_ATOMIC_INSTAGRAM_ID,
          username: "p24_instagram",
          name: "P24 Instagram"
        }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_META_CALLBACK_ATOMIC === "true"
    && target.hostname === "graph.facebook.com"
    && target.pathname.endsWith("/me/businesses")) {
    await recordProviderMock({
      kind: "meta-businesses-mock-p24",
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      userTokenMatches: target.searchParams.get("access_token") === process.env.SOCIAL_CUES_TEST_META_ATOMIC_USER_TOKEN,
      fieldsPresent: Boolean(target.searchParams.get("fields"))
    });
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_META_CALLBACK === "true"
    && target.hostname === "graph.facebook.com"
    && target.pathname.endsWith("/oauth/access_token")) {
    await recordProviderMock({
      kind: "meta-token-exchange-failure-mock",
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      clientIdMatches: target.searchParams.get("client_id") === process.env.META_APP_ID,
      clientSecretMatches: target.searchParams.get("client_secret") === process.env.META_APP_SECRET,
      redirectMatches: target.searchParams.get("redirect_uri") === "https://socialcuesapp.com/api/oauth/meta/callback",
      codeMatches: target.searchParams.get("code") === process.env.SOCIAL_CUES_TEST_META_FAILURE_CODE
    });
    return new Response(JSON.stringify({
      error: {
        message: "Synthetic Meta token exchange rejected.",
        type: "OAuthException",
        code: 190
      }
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_META_ASSETS === "true"
    && target.hostname === "graph.facebook.com"
    && target.pathname.endsWith("/debug_token")) {
    await recordProviderMock({
      kind: "meta-debug-token-mock",
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      inputTokenMatches: target.searchParams.get("input_token") === process.env.SOCIAL_CUES_TEST_META_USER_TOKEN,
      appAccessTokenMatches: target.searchParams.get("access_token") === process.env.META_APP_ID + "|" + process.env.META_APP_SECRET
    });
    return new Response(JSON.stringify({
      data: {
        is_valid: true,
        app_id: process.env.META_APP_ID,
        user_id: process.env.SOCIAL_CUES_TEST_META_USER_ID,
        expires_at: 4102444800,
        scopes: ${JSON.stringify(META_ASSETS_GRANTED_SCOPES)}
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_META_ASSETS === "true"
    && target.hostname === "graph.facebook.com"
    && target.pathname.endsWith("/me/permissions")) {
    await recordProviderMock({
      kind: "meta-permissions-mock",
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      userTokenMatches: target.searchParams.get("access_token") === process.env.SOCIAL_CUES_TEST_META_USER_TOKEN
    });
    return new Response(JSON.stringify({
      data: ${JSON.stringify(META_ASSETS_GRANTED_SCOPES)}.map(permission => ({ permission, status: "granted" }))
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_META_ASSETS === "true"
    && target.hostname === "graph.facebook.com"
    && target.pathname.endsWith("/me/accounts")) {
    await recordProviderMock({
      kind: "meta-accounts-mock",
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      userTokenMatches: target.searchParams.get("access_token") === process.env.SOCIAL_CUES_TEST_META_USER_TOKEN,
      fieldsPresent: Boolean(target.searchParams.get("fields"))
    });
    return new Response(JSON.stringify({
      data: [{
        id: process.env.SOCIAL_CUES_TEST_META_PAGE_ID,
        name: "P22 Facebook Page",
        category: "Software",
        access_token: process.env.SOCIAL_CUES_TEST_META_PAGE_TOKEN,
        tasks: ["ANALYZE", "CREATE_CONTENT"],
        instagram_business_account: {
          id: process.env.SOCIAL_CUES_TEST_META_INSTAGRAM_ID,
          username: "p22_instagram",
          name: "P22 Instagram"
        }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_META_ASSETS === "true"
    && target.hostname === "graph.facebook.com"
    && target.pathname.endsWith("/me/businesses")) {
    await recordProviderMock({
      kind: "meta-businesses-mock",
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      userTokenMatches: target.searchParams.get("access_token") === process.env.SOCIAL_CUES_TEST_META_USER_TOKEN,
      fieldsPresent: Boolean(target.searchParams.get("fields"))
    });
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_DISCORD_COMMUNITY === "true"
    && target.hostname === "discord.com"
    && target.pathname === "/api/v10/users/@me") {
    const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
    await recordProviderMock({
      kind: "discord-community-user-mock",
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      bearerPresent: /^Bearer\\s+\\S+$/u.test(headers.get("authorization") || ""),
      accessTokenMatches: headers.get("authorization") === "Bearer " + (process.env.SOCIAL_CUES_TEST_DISCORD_ACCESS_TOKEN || "")
    });
    return new Response(JSON.stringify({
      id: "${SYNTHETIC_DISCORD_COMMUNITY_PROVIDER_ID}",
      username: "p28_discord_owner",
      global_name: "P28 Discord Owner",
      avatar: "synthetic-avatar"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (process.env.SOCIAL_CUES_TEST_MOCK_DISCORD_COMMUNITY === "true"
    && target.hostname === "discord.com"
    && target.pathname === "/api/v10/users/@me/guilds") {
    const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
    await recordProviderMock({
      kind: "discord-community-guilds-mock",
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      bearerPresent: /^Bearer\\s+\\S+$/u.test(headers.get("authorization") || ""),
      accessTokenMatches: headers.get("authorization") === "Bearer " + (process.env.SOCIAL_CUES_TEST_DISCORD_ACCESS_TOKEN || ""),
      boundedLimit: target.searchParams.get("limit") === "200",
      countsRequested: target.searchParams.get("with_counts") === "true"
    });
    return new Response(JSON.stringify([{
      id: "${SYNTHETIC_DISCORD_COMMUNITY_GUILD_ID}",
      name: "P28 Community",
      owner: true,
      permissions: "8",
      features: [],
      approximate_member_count: 28,
      approximate_presence_count: 7
    }]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (["http:", "https:"].includes(target.protocol) && !loopbackHosts.has(target.hostname)) {
    if (logPath) {
      await appendFile(logPath, JSON.stringify({
        method: String(init?.method || input?.method || "GET").toUpperCase(),
        origin: target.origin
      }) + "\\n", "utf8");
    }
    throw new Error("External HTTP request blocked by the Social Cues test guard.");
  }
  return originalFetch(input, init);
};
`, "utf8");

function shopifyEnvironmentState(env) {
  return Object.entries(env)
    .filter(([name]) => SHOPIFY_SCENARIO_ENV_KEYS.has(name.toLowerCase()))
    .sort(([left], [right]) => left.localeCompare(right));
}

function assertShopifyScenarioEnvironmentHelper() {
  const parentBefore = Object.entries(process.env);
  const inheritedShopifyEntries = Object.fromEntries(SHOPIFY_SCENARIO_ENV_NAMES.map((name, index) => [name, `shopify-inherited-${index}`]));
  const baseEnv = {
    ...process.env,
    ...inheritedShopifyEntries,
    ShOpIfY_ClIeNt_Id: "shopify-inherited-mixed-case-id",
    sHoPiFy_ApP_sEcReT: "shopify-inherited-mixed-case-secret",
    SOCIAL_CUES_SHOPIFY_UNRELATED_SENTINEL: "preserved"
  };
  const baseBefore = JSON.stringify(Object.entries(baseEnv));
  const overrides = {
    SHOPIFY_APP_ID: SYNTHETIC_SHOPIFY_APP_ID,
    SHOPIFY_APP_SECRET: SYNTHETIC_SHOPIFY_APP_SECRET
  };
  const first = shopifyScenarioEnv({ baseEnv, overrides });
  const second = shopifyScenarioEnv({ baseEnv, overrides: { SHOPIFY_APP_SECRET: SYNTHETIC_SHOPIFY_APP_SECRET, SHOPIFY_APP_ID: SYNTHETIC_SHOPIFY_APP_ID } });
  if (first === second || first === baseEnv || second === baseEnv) throw new Error("shopify scenario environments must be fresh objects");
  if (first.SOCIAL_CUES_SHOPIFY_UNRELATED_SENTINEL !== "preserved") throw new Error("shopify scenario isolation removed an unrelated environment variable");
  const expectedState = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(shopifyEnvironmentState(first)) !== JSON.stringify(expectedState)) throw new Error("shopify scenario isolation retained inherited Shopify configuration");
  if (JSON.stringify(shopifyEnvironmentState(first)) !== JSON.stringify(shopifyEnvironmentState(second))) {
    throw new Error("shopify scenario environment depends on override insertion order");
  }
  if (JSON.stringify(Object.entries(baseEnv)) !== baseBefore) throw new Error("shopify scenario isolation mutated its supplied base environment");
  if (JSON.stringify(Object.entries(process.env)) !== JSON.stringify(parentBefore)) throw new Error("shopify scenario isolation mutated the parent process environment");
}

function assertCommittedShopifyCredentialFamilies(source) {
  const requiredMarkers = [
    'SHOPIFY_CLIENT_ID: ["SHOPIFY_API_KEY", "SHOPIFY_APP_ID", "SHOPIFY_APP_CLIENT_ID", "shopify_client_id", "shopify_api_key"]',
    'SHOPIFY_CLIENT_SECRET: ["SHOPIFY_API_SECRET", "SHOPIFY_APP_SECRET", "SHOPIFY_APP_CLIENT_SECRET", "shopify_client_secret", "shopify_api_secret"]',
    'SHOPIFY_SHOP_DOMAIN: ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_TEST_STORE_DOMAIN", "shopify_shop_domain"]',
    'const shopifyPublicAppUrl = (process.env.SHOPIFY_PUBLIC_APP_URL || publicAppUrl)',
    'const shopifyApiVersion = process.env.SHOPIFY_API_VERSION || "2026-07"',
    'const shopifyClientId = envValue("SHOPIFY_CLIENT_ID")',
    'const shopifyClientSecret = envValue("SHOPIFY_CLIENT_SECRET")',
    'client_id: shopifyClientId',
    'client_secret: shopifyClientSecret',
    'crypto.createHmac("sha256", shopifyClientSecret)',
    'account.credential = encryptedToken(token.accessToken)',
    'encrypted_token: account.credential',
    '/provider_tokens?on_conflict=connected_account_id,token_kind',
    '"X-Shopify-Access-Token": accessToken'
  ];
  if (requiredMarkers.some(marker => !source.includes(marker))) throw new Error("committed Shopify credential-family contract is incomplete");
  const committedNames = new Set([
    ...[...source.matchAll(/["']((?:SHOPIFY|shopify)_[A-Za-z0-9_]+)["']/g)].map(match => match[1]),
    ...[...source.matchAll(/process\.env\.((?:SHOPIFY|shopify)_[A-Za-z0-9_]+)/g)].map(match => match[1])
  ]);
  for (const name of SHOPIFY_SCENARIO_ENV_NAMES.filter(item => item !== "PUBLIC_APP_URL")) {
    if (!committedNames.has(name)) throw new Error(`Shopify test environment inventory is not backed by committed source: ${name}`);
  }
  if (!source.includes("process.env.PUBLIC_APP_URL")) throw new Error("Shopify public URL fallback is missing from committed source");
  for (const unknownName of SHOPIFY_TEST_ONLY_UNKNOWN_ENV_NAMES) {
    if (committedNames.has(unknownName)) throw new Error(`Shopify unknown-alias control unexpectedly became accepted: ${unknownName}`);
  }
}

function assertShopifyScenarioDefinitions(scenarios, source) {
  const committedKeys = new Set(SHOPIFY_SCENARIO_ENV_NAMES.map(name => name.toLowerCase()));
  const testOnlyUnknownKeys = new Set(SHOPIFY_TEST_ONLY_UNKNOWN_ENV_NAMES.map(name => name.toLowerCase()));
  const requiredKeys = [
    "canonical-pair",
    "api-key-pair",
    "app-id-pair",
    "app-client-pair",
    "lowercase-client-pair",
    "lowercase-api-pair",
    "canonical-id-only",
    "canonical-secret-only",
    "alias-id-only",
    "alias-secret-only",
    "blank-canonical-id",
    "blank-canonical-secret",
    "whitespace-canonical-id",
    "whitespace-canonical-secret",
    "blank-alias-id",
    "blank-alias-secret",
    "whitespace-alias-id",
    "whitespace-alias-secret",
    "invalid-id-characters",
    "invalid-id-length",
    "invalid-secret-format",
    "unknown-id-valid-secret",
    "valid-id-unknown-secret",
    "unknown-id-and-secret",
    "canonical-conflicting-alias",
    "empty-canonical-id-alias-fallback",
    "empty-canonical-secret-alias-fallback",
    "empty-canonical-pair-alias-fallback",
    "whitespace-canonical-id-blocks-alias",
    "whitespace-canonical-secret-blocks-alias",
    "mixed-canonical-id-alias-secret",
    "mixed-alias-id-canonical-secret",
    "mixed-api-key-app-secret",
    "mixed-app-id-api-secret",
    "mixed-app-client-lowercase-secret",
    "mixed-lowercase-id-uppercase-secret",
    "hostile-inherited-environment",
    "workspace-token-without-app-credentials"
  ];
  const scenarioKeys = new Set(scenarios.map(scenario => scenario.key));
  if (requiredKeys.some(key => !scenarioKeys.has(key))) throw new Error("Shopify credential matrix is missing a required independent scenario");
  if (scenarioKeys.size !== scenarios.length) throw new Error("Shopify credential matrix contains duplicate scenario keys");
  for (const scenario of scenarios) {
    const allowedUnknown = new Set((scenario.allowedUnknownEnvNames || []).map(name => name.toLowerCase()));
    for (const name of Object.keys(scenario.overrides || {})) {
      if (!/^shopify_/i.test(name)) continue;
      const normalized = name.toLowerCase();
      if (!committedKeys.has(normalized) && !(testOnlyUnknownKeys.has(normalized) && allowedUnknown.has(normalized))) {
        throw new Error(`Shopify scenario introduced an unproven production environment name: ${name}`);
      }
    }
    for (const name of scenario.hostileEnvNames || []) {
      if (!committedKeys.has(name.toLowerCase())) throw new Error(`Shopify hostile environment used an unproven configuration name: ${name}`);
    }
  }
  const acceptedSource = source.slice(source.indexOf("const envAliases ="), source.indexOf("function envValue"));
  for (const unknownName of SHOPIFY_TEST_ONLY_UNKNOWN_ENV_NAMES) {
    if (acceptedSource.includes(unknownName)) throw new Error(`Shopify unknown alias was added to the committed resolver: ${unknownName}`);
  }
}

async function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const selectedPort = typeof address === "object" && address ? address.port : 0;
      probe.close(error => error ? reject(error) : resolve(selectedPort));
    });
  });
}

async function stopShopifyScenarioServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let exited = false;
  const exit = new Promise(resolve => child.once("exit", () => {
    exited = true;
    resolve();
  }));
  if (child.connected) child.send({ type: "social-cues-local-shutdown" });
  else child.kill();
  await Promise.race([exit, delay(3000)]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exit, delay(1500)]);
  }
}

async function waitForShopifyScenarioServer(child, scenarioBaseUrl, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`shopify credential scenario exited before startup: ${label}`);
    try {
      const response = await fetch(`${scenarioBaseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The loopback server may still be binding its port.
    }
    await delay(50);
  }
  throw new Error(`shopify credential scenario did not start: ${label}`);
}

async function shopifyScenarioResponse(scenarioBaseUrl, route, options = {}) {
  const response = await fetch(scenarioBaseUrl + route, { redirect: "manual", ...options });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // OAuth start and callback routes intentionally return HTML.
  }
  return {
    status: response.status,
    body,
    text,
    headers: Object.fromEntries(response.headers.entries()),
    location: response.headers.get("location") || ""
  };
}

async function shopifyScenarioExternalAttempts(logPath) {
  try {
    const source = await readFile(logPath, "utf8");
    return source.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForTwitchScenarioServer(child, scenarioBaseUrl) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error("twitch portal credential scenario exited before startup");
    try {
      const response = await fetch(`${scenarioBaseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The loopback server may still be binding its port.
    }
    await delay(50);
  }
  throw new Error("twitch portal credential scenario did not start");
}

async function runMetaOAuthStartScenario() {
  const parentBefore = JSON.stringify(Object.entries(process.env));
  const scenarioPort = await availableLoopbackPort();
  const scenarioBaseUrl = `http://127.0.0.1:${scenarioPort}`;
  const scenarioDataDir = path.join(process.cwd(), ".tmp", `meta-start-p21-${Date.now()}`);
  const requestLogPath = path.join(scenarioDataDir, "external-http-requests.ndjson");
  const workspaceLockPath = path.join(scenarioDataDir, ".workspace-content.lock");
  const expectedNormalScopes = ["public_profile", "pages_show_list", "pages_read_engagement"];
  const expectedTestingScopes = [
    ...expectedNormalScopes,
    "pages_manage_posts",
    "pages_manage_metadata",
    "business_management"
  ];
  const ownerPassword = "p21-meta-owner-password-2026";
  const privateMarkers = [
    SYNTHETIC_META_START_APP_SECRET,
    SYNTHETIC_META_START_AUTH_SECRET,
    SYNTHETIC_META_START_ENCRYPTION_KEY,
    ownerPassword
  ];
  await mkdir(scenarioDataDir, { recursive: true });
  const childEnv = metaStartScenarioEnv({
    overrides: {
      PORT: String(scenarioPort),
      HOST: "127.0.0.1",
      AUTH_PROVIDER: "alpha-local",
      SUPABASE_ENABLED: "false",
      SENTRY_DSN: "",
      PUBLIC_APP_URL: "https://socialcuesapp.com",
      META_PUBLIC_APP_URL: "https://socialcuesapp.com",
      META_APP_ID: SYNTHETIC_META_START_APP_ID,
      META_APP_SECRET: SYNTHETIC_META_START_APP_SECRET,
      AUTH_SESSION_SECRET: SYNTHETIC_META_START_AUTH_SECRET,
      OAUTH_TOKEN_ENCRYPTION_KEY: SYNTHETIC_META_START_ENCRYPTION_KEY,
      SOCIAL_CUES_DATA_DIR: scenarioDataDir,
      SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: requestLogPath,
      SOCIAL_CUES_PROMO_CODES: JSON.stringify([
        { code: SYNTHETIC_META_START_OWNER_PROMO, label: "P21 Meta owner", days: 1, active: true }
      ])
    }
  });
  const retainedCredentialNames = Object.keys(childEnv)
    .filter(name => META_START_CREDENTIAL_ENV_KEYS.has(name.toLowerCase()))
    .sort();
  if (JSON.stringify(retainedCredentialNames) !== JSON.stringify(["META_APP_ID", "META_APP_SECRET"])) {
    throw new Error("Meta start fixture retained inherited application credentials");
  }

  let stdout = "";
  let stderr = "";
  let result;
  let scenarioFailure;
  let childStopped = false;
  const child = spawn(process.execPath, [`--import=${pathToFileURL(externalRequestGuardPath).href}`, "server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const modelHash = async () => {
    try {
      return createHash("sha256").update(await readFile(path.join(scenarioDataDir, "model.json"))).digest("hex");
    } catch (error) {
      if (error?.code === "ENOENT") return "absent";
      throw error;
    }
  };
  const auth = token => ({ headers: { Authorization: `Bearer ${token}` } });
  const revision = response => response.body?.persistence?.revision || null;

  try {
    await waitForShopifyScenarioServer(child, scenarioBaseUrl, "P21 Meta start");
    const attemptsBefore = await shopifyScenarioExternalAttempts(requestLogPath);
    const hashBeforeAnonymous = await modelHash();
    const anonymous = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/meta/start?platform=facebook");
    const hashAfterAnonymous = await modelHash();
    const tampered = await shopifyScenarioResponse(
      scenarioBaseUrl,
      "/api/oauth/meta/start?platform=facebook",
      auth("p21-invalid-session")
    );
    const hashAfterTampered = await modelHash();
    for (const [label, response] of [["anonymous", anonymous], ["tampered session", tampered]]) {
      if (response.status !== 401
        || !/sign in required/iu.test(response.text)
        || response.location
        || /workspace_writer_unclassified|commitStatus/iu.test(response.text)) {
        throw new Error(`Meta start fixture did not return a sanitized sign-in requirement for ${label}`);
      }
    }
    if (hashBeforeAnonymous !== hashAfterAnonymous || hashAfterAnonymous !== hashAfterTampered) {
      throw new Error("Meta start fixture committed OAuth state before authentication");
    }
    if (JSON.stringify(await shopifyScenarioExternalAttempts(requestLogPath)) !== JSON.stringify(attemptsBefore)) {
      throw new Error("Meta start fixture attempted provider traffic for an unauthenticated request");
    }

    const signup = await shopifyScenarioResponse(scenarioBaseUrl, "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "P21 Meta Owner",
        email: `p21-meta-owner-${Date.now()}@example.test`,
        password: ownerPassword,
        promoCode: SYNTHETIC_META_START_OWNER_PROMO,
        workspaceName: "P21 Meta Workspace"
      })
    });
    const ownerToken = signup.body?.session?.token || "";
    const ownerUserId = signup.body?.user?.id || "";
    const ownerWorkspaceId = signup.body?.workspace?.id || "";
    if (signup.status !== 200 || !ownerToken || !ownerUserId || !ownerWorkspaceId
      || signup.body.workspace?.ownerUserId !== ownerUserId) {
      throw new Error("Meta start fixture could not establish its synthetic owner workspace");
    }
    const ownerAuth = auth(ownerToken);
    const modelBefore = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const normal = await shopifyScenarioResponse(
      scenarioBaseUrl,
      "/api/oauth/meta/start?platform=facebook",
      ownerAuth
    );
    const modelAfterNormal = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const testing = await shopifyScenarioResponse(
      scenarioBaseUrl,
      "/api/oauth/meta/start?platform=facebook&testing=pages",
      ownerAuth
    );
    const modelAfterTesting = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    if (normal.status !== 302 || !normal.location || testing.status !== 302 || !testing.location) {
      throw new Error("Meta start fixture did not redirect both authenticated Facebook lanes");
    }
    const normalUrl = new URL(normal.location);
    const testingUrl = new URL(testing.location);
    const normalScopes = (normalUrl.searchParams.get("scope") || "").split(",").filter(Boolean);
    const testingScopes = (testingUrl.searchParams.get("scope") || "").split(",").filter(Boolean);
    for (const [label, redirect] of [["normal", normalUrl], ["testing", testingUrl]]) {
      if (redirect.hostname !== "www.facebook.com"
        || redirect.pathname !== "/v23.0/dialog/oauth"
        || redirect.searchParams.get("client_id") !== SYNTHETIC_META_START_APP_ID
        || redirect.searchParams.get("redirect_uri") !== "https://socialcuesapp.com/api/oauth/meta/callback"
        || redirect.searchParams.get("auth_type") !== "rerequest"
        || redirect.searchParams.get("response_type") !== "code"
        || !redirect.searchParams.get("state")) {
        throw new Error(`Meta start fixture returned an invalid ${label} provider redirect`);
      }
    }
    if (JSON.stringify(normalScopes) !== JSON.stringify(expectedNormalScopes)
      || normalUrl.searchParams.has("enable_profile_selector")) {
      throw new Error("Meta start fixture changed the normal Facebook scope contract");
    }
    if (JSON.stringify(testingScopes) !== JSON.stringify(expectedTestingScopes)
      || testingUrl.searchParams.get("enable_profile_selector") !== "1") {
      throw new Error("Meta start fixture changed the Facebook testing scope or selector contract");
    }
    if (modelBefore.status !== 200 || modelAfterNormal.status !== 200 || modelAfterTesting.status !== 200
      || JSON.stringify(revision(modelBefore)) === JSON.stringify(revision(modelAfterNormal))
      || JSON.stringify(revision(modelAfterNormal)) === JSON.stringify(revision(modelAfterTesting))) {
      throw new Error("Meta start fixture did not durably advance both owner workspace revisions");
    }

    const rawModelSource = await readFile(path.join(scenarioDataDir, "model.json"), "utf8");
    const rawModel = JSON.parse(rawModelSource);
    const metaStates = (rawModel.shared?.oauthStates || [])
      .filter(record => record.provider === "meta" && record.platform === "facebook");
    const normalRecord = metaStates.find(record => record.state === normalUrl.searchParams.get("state"));
    const testingRecord = metaStates.find(record => record.state === testingUrl.searchParams.get("state"));
    const recordOwnerMatches = record => record?.ownerUserId === ownerUserId
      && record?.userId === ownerUserId
      && record?.workspaceId === ownerWorkspaceId;
    if (metaStates.length !== 2
      || !recordOwnerMatches(normalRecord)
      || !recordOwnerMatches(testingRecord)
      || normalRecord.testingPages !== false
      || testingRecord.testingPages !== true
      || JSON.stringify(normalRecord.requestedScopes) !== JSON.stringify(expectedNormalScopes)
      || JSON.stringify(testingRecord.requestedScopes) !== JSON.stringify(expectedTestingScopes)
      || rawModel.shared?.workspaces?.find(workspace => workspace.id === ownerWorkspaceId)?.ownerUserId !== ownerUserId
      || !rawModel.workspaces?.[ownerWorkspaceId]) {
      throw new Error("Meta start fixture did not durably bind OAuth states to the authenticated owner workspace");
    }
    if ([modelBefore, modelAfterNormal, modelAfterTesting]
      .some(response => /"oauthStates"|"oauthEvents"/u.test(JSON.stringify(response.body)))) {
      throw new Error("Meta start fixture exposed a private OAuth ledger through the public model");
    }

    const attemptsAfter = await shopifyScenarioExternalAttempts(requestLogPath);
    if (JSON.stringify(attemptsAfter) !== JSON.stringify(attemptsBefore)) {
      throw new Error("Meta start fixture attempted an external provider request");
    }
    assertMetaStartPrivateMarkersAbsent(
      [anonymous.text, tampered.text, normal.location, testing.location, modelBefore.body, modelAfterNormal.body, modelAfterTesting.body, rawModelSource],
      privateMarkers,
      "HTTP or persistence"
    );
    assertMetaStartPrivateMarkersAbsent(rawModelSource, [ownerToken], "private persistence");
    result = {
      anonymousStatus: anonymous.status,
      tamperedSessionStatus: tampered.status,
      unauthenticatedMutation: false,
      normalStatus: normal.status,
      normalRedirectHost: normalUrl.hostname,
      normalRedirectPath: normalUrl.pathname,
      normalScopes,
      testingStatus: testing.status,
      testingRedirectHost: testingUrl.hostname,
      testingRedirectPath: testingUrl.pathname,
      testingScopes,
      selectorRequiredForTesting: true,
      revisionsAdvanced: true,
      ownerWorkspaceBound: true,
      externalRequests: attemptsAfter.length
    };
  } catch (error) {
    scenarioFailure = error;
  } finally {
    await stopShopifyScenarioServer(child);
    childStopped = child.exitCode !== null || child.signalCode !== null;
  }

  let postFailure = scenarioFailure;
  let cleanupComplete = false;
  try {
    assertMetaStartPrivateMarkersAbsent(`${stdout}\n${stderr}`, privateMarkers, "stdout or stderr");
    const finalAttempts = await shopifyScenarioExternalAttempts(requestLogPath);
    if (finalAttempts.length !== 0) throw new Error("Meta start fixture recorded an external request");
    if (!childStopped) throw new Error("Meta start fixture did not stop its child process");
    try {
      await access(workspaceLockPath);
      throw new Error("Meta start fixture retained the workspace lock after shutdown");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (JSON.stringify(Object.entries(process.env)) !== parentBefore) {
      throw new Error("Meta start fixture mutated the parent process environment");
    }
  } catch (error) {
    if (!postFailure) postFailure = error;
  } finally {
    await rm(scenarioDataDir, { recursive: true, force: true });
    try {
      await access(scenarioDataDir);
    } catch (error) {
      if (error?.code === "ENOENT") cleanupComplete = true;
      else if (!postFailure) postFailure = error;
    }
  }
  if (!cleanupComplete && !postFailure) postFailure = new Error("Meta start fixture cleanup was incomplete");
  if (postFailure) throw postFailure;
  return { ...result, cleanupComplete };
}

async function runGoogleOAuthStartScenario() {
  const parentBefore = JSON.stringify(Object.entries(process.env));
  const scenarioPort = await availableLoopbackPort();
  const scenarioBaseUrl = `http://127.0.0.1:${scenarioPort}`;
  const scenarioDataDir = path.join(process.cwd(), ".tmp", `google-start-p25-${Date.now()}`);
  const modelPath = path.join(scenarioDataDir, "model.json");
  const requestLogPath = path.join(scenarioDataDir, "external-http-requests.ndjson");
  const providerMockLogPath = path.join(scenarioDataDir, "provider-mocks.ndjson");
  const workspaceLockPath = path.join(scenarioDataDir, ".workspace-content.lock");
  const expectedYouTubeScopes = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/yt-analytics.readonly"
  ];
  const expectedBusinessScopes = ["https://www.googleapis.com/auth/business.manage"];
  const ownerPassword = "p25-google-start-owner-password-2026";
  const foreignPassword = "p25-google-start-foreign-password-2026";
  const privateMarkers = [
    SYNTHETIC_GOOGLE_START_CLIENT_SECRET,
    SYNTHETIC_GOOGLE_START_AUTH_SECRET,
    SYNTHETIC_GOOGLE_START_ENCRYPTION_KEY,
    ownerPassword,
    foreignPassword
  ];
  await mkdir(scenarioDataDir, { recursive: true });
  const childEnv = googleCallbackScenarioEnv({
    baseEnv: {
      ...process.env,
      ...Object.fromEntries(GOOGLE_CALLBACK_CREDENTIAL_ENV_NAMES.map((name, index) => [name, `inherited-google-start-${index}`])),
      GoOgLe_ClIeNt_Id: "inherited-google-start-mixed-case-id",
      gOoGlE_cLiEnT_sEcReT: "inherited-google-start-mixed-case-secret"
    },
    overrides: {
      PORT: String(scenarioPort),
      HOST: "127.0.0.1",
      AUTH_PROVIDER: "alpha-local",
      SUPABASE_ENABLED: "false",
      SENTRY_DSN: "",
      PUBLIC_APP_URL: "https://socialcuesapp.com",
      GOOGLE_PUBLIC_APP_URL: "https://socialcuesapp.com",
      GOOGLE_CLIENT_ID: SYNTHETIC_GOOGLE_START_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: SYNTHETIC_GOOGLE_START_CLIENT_SECRET,
      AUTH_SESSION_SECRET: SYNTHETIC_GOOGLE_START_AUTH_SECRET,
      OAUTH_TOKEN_ENCRYPTION_KEY: SYNTHETIC_GOOGLE_START_ENCRYPTION_KEY,
      SOCIAL_CUES_DATA_DIR: scenarioDataDir,
      SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: requestLogPath,
      SOCIAL_CUES_TEST_PROVIDER_MOCK_LOG: providerMockLogPath,
      SOCIAL_CUES_PROMO_CODES: JSON.stringify([
        { code: SYNTHETIC_GOOGLE_START_FOREIGN_PROMO_CODE, label: "P25 Google start foreign", days: 1, active: true }
      ])
    }
  });
  const retainedCredentialNames = Object.keys(childEnv)
    .filter(name => GOOGLE_CALLBACK_CREDENTIAL_ENV_KEYS.has(name.toLowerCase()))
    .sort();
  if (JSON.stringify(retainedCredentialNames) !== JSON.stringify(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])) {
    throw new Error("Google start fixture retained inherited application credentials");
  }

  let stdout = "";
  let stderr = "";
  let result;
  let scenarioFailure;
  let childStopped = false;
  let issuedStates = [];
  const child = spawn(process.execPath, [`--import=${pathToFileURL(externalRequestGuardPath).href}`, "server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const auth = token => ({ headers: { Authorization: `Bearer ${token}` } });
  const revision = response => JSON.stringify(response.body?.persistence?.revision || null);
  const parseStart = (response, platform, expectedScopes) => {
    if (response.status !== 302 || !response.location) {
      throw new Error(`Google start fixture did not redirect the authenticated ${platform} lane`);
    }
    const location = new URL(response.location);
    const state = location.searchParams.get("state") || "";
    const scopes = (location.searchParams.get("scope") || "").split(" ").filter(Boolean);
    if (location.origin !== "https://accounts.google.com"
      || location.pathname !== "/o/oauth2/v2/auth"
      || location.searchParams.get("client_id") !== SYNTHETIC_GOOGLE_START_CLIENT_ID
      || location.searchParams.get("redirect_uri") !== "https://socialcuesapp.com/api/oauth/youtube/callback"
      || location.searchParams.get("response_type") !== "code"
      || location.searchParams.get("access_type") !== "offline"
      || location.searchParams.get("include_granted_scopes") !== "true"
      || location.searchParams.get("prompt") !== "consent select_account"
      || JSON.stringify(scopes) !== JSON.stringify(expectedScopes)
      || !state) {
      throw new Error(`Google start fixture changed the authenticated ${platform} redirect contract`);
    }
    let signedPayload;
    try {
      signedPayload = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    } catch {
      throw new Error(`Google start fixture issued a malformed signed state for ${platform}`);
    }
    if (!signedPayload?.sig || signedPayload.provider !== "youtube" || signedPayload.platform !== platform
      || JSON.stringify(signedPayload.requestedScopes) !== JSON.stringify(expectedScopes)) {
      throw new Error(`Google start fixture changed the signed state contract for ${platform}`);
    }
    return { location, scopes, state, signedPayload };
  };

  try {
    await waitForShopifyScenarioServer(child, scenarioBaseUrl, "P25 Google start");
    const foreignSignup = await shopifyScenarioResponse(scenarioBaseUrl, "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "P25 Google Start Foreign",
        email: `p25-google-start-foreign-${Date.now()}@example.test`,
        password: foreignPassword,
        promoCode: SYNTHETIC_GOOGLE_START_FOREIGN_PROMO_CODE,
        workspaceName: "P25 Google Start Foreign Workspace"
      })
    });
    const ownerSignup = await shopifyScenarioResponse(scenarioBaseUrl, "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "P25 Google Start Owner",
        email: `mr.barton+p25-google-start-${Date.now()}@socialcuesapp.com`,
        password: ownerPassword,
        workspaceName: "P25 Google Start Owner Workspace"
      })
    });
    const ownerToken = ownerSignup.body?.session?.token || "";
    const foreignToken = foreignSignup.body?.session?.token || "";
    const ownerUserId = ownerSignup.body?.session?.user?.id || ownerSignup.body?.user?.id || "";
    const foreignUserId = foreignSignup.body?.session?.user?.id || foreignSignup.body?.user?.id || "";
    const ownerWorkspaceId = ownerSignup.body?.workspace?.id || "";
    const foreignWorkspaceId = foreignSignup.body?.workspace?.id || "";
    if (ownerSignup.status !== 200 || foreignSignup.status !== 200 || !ownerToken || !foreignToken
      || !ownerUserId || !foreignUserId || !ownerWorkspaceId || !foreignWorkspaceId
      || ownerSignup.body.workspace?.ownerUserId !== ownerUserId
      || foreignSignup.body.workspace?.ownerUserId !== foreignUserId) {
      throw new Error("Google start fixture could not establish isolated authenticated workspaces");
    }
    privateMarkers.push(ownerToken, foreignToken);
    const ownerAuth = auth(ownerToken);
    const foreignAuth = auth(foreignToken);
    const ownerBeforeDenials = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const foreignBeforeDenials = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    const modelBeforeDenials = await readFile(modelPath);
    const requestsBeforeDenials = await shopifyScenarioExternalAttempts(requestLogPath);
    const mocksBeforeDenials = await shopifyScenarioExternalAttempts(providerMockLogPath);

    const anonymous = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/youtube/start");
    const invalidSession = await shopifyScenarioResponse(
      scenarioBaseUrl,
      "/api/oauth/youtube/start?service=business",
      auth("p25-google-start-invalid-session")
    );
    for (const [label, response] of [["anonymous", anonymous], ["invalid session", invalidSession]]) {
      if (response.status !== 401
        || !/sign in required/iu.test(response.text)
        || response.location
        || response.headers["set-cookie"]
        || /workspace_writer_unclassified|commitStatus/iu.test(response.text)) {
        throw new Error(`Google start fixture did not return a sanitized sign-in requirement for ${label}`);
      }
    }
    const ownerAfterDenials = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const foreignAfterDenials = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    if (Buffer.compare(modelBeforeDenials, await readFile(modelPath)) !== 0
      || revision(ownerBeforeDenials) !== revision(ownerAfterDenials)
      || revision(foreignBeforeDenials) !== revision(foreignAfterDenials)) {
      throw new Error("Google start fixture changed storage or a workspace revision before authentication");
    }
    if (JSON.stringify(await shopifyScenarioExternalAttempts(requestLogPath)) !== JSON.stringify(requestsBeforeDenials)
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(mocksBeforeDenials)) {
      throw new Error("Google start fixture attempted provider traffic before authentication");
    }

    const youtubeStart = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/youtube/start", ownerAuth);
    const youtube = parseStart(youtubeStart, "youtube", expectedYouTubeScopes);
    const ownerAfterYouTube = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const businessStart = await shopifyScenarioResponse(
      scenarioBaseUrl,
      "/api/oauth/youtube/start?service=business",
      ownerAuth
    );
    const business = parseStart(businessStart, "google_business", expectedBusinessScopes);
    const ownerAfterBusiness = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const foreignAfterStarts = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    if (youtube.state === business.state
      || revision(ownerAfterDenials) === revision(ownerAfterYouTube)
      || revision(ownerAfterYouTube) === revision(ownerAfterBusiness)
      || revision(foreignAfterDenials) !== revision(foreignAfterStarts)) {
      throw new Error("Google start fixture did not isolate two durable owner revisions from the foreign workspace");
    }
    for (const entry of [youtube, business]) {
      if (entry.signedPayload.ownerUserId !== ownerUserId
        || entry.signedPayload.userId !== ownerUserId
        || entry.signedPayload.workspaceId !== ownerWorkspaceId) {
        throw new Error("Google start fixture did not bind signed state to the authenticated owner workspace");
      }
    }

    const rawModelSource = await readFile(modelPath, "utf8");
    const rawModel = JSON.parse(rawModelSource);
    const googleStates = (rawModel.shared?.oauthStates || []).filter(record => record.provider === "youtube");
    const youtubeRecord = googleStates.find(record => record.state === youtube.state);
    const businessRecord = googleStates.find(record => record.state === business.state);
    const recordMatches = (record, platform, scopes) => record?.platform === platform
      && record.ownerUserId === ownerUserId
      && record.userId === ownerUserId
      && record.workspaceId === ownerWorkspaceId
      && JSON.stringify(record.requestedScopes) === JSON.stringify(scopes);
    if (googleStates.length !== 2
      || !recordMatches(youtubeRecord, "youtube", expectedYouTubeScopes)
      || !recordMatches(businessRecord, "google_business", expectedBusinessScopes)
      || googleStates.some(record => record.ownerUserId === foreignUserId || record.workspaceId === foreignWorkspaceId)
      || rawModel.shared?.workspaces?.find(workspace => workspace.id === ownerWorkspaceId)?.ownerUserId !== ownerUserId) {
      throw new Error("Google start fixture did not durably isolate both OAuth states to the owner workspace");
    }

    const oauthDebug = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/debug-log", ownerAuth);
    if (oauthDebug.status !== 200
      || !oauthDebug.body?.rows?.filter(row => row.provider === "youtube" && row.event === "state_issued").length) {
      throw new Error("Google start fixture could not read the sanitized owner OAuth audit");
    }
    const publicModels = [ownerBeforeDenials, foreignBeforeDenials, ownerAfterDenials, foreignAfterDenials,
      ownerAfterYouTube, ownerAfterBusiness, foreignAfterStarts];
    if (publicModels.some(response => /"oauthStates"|"oauthEvents"/u.test(JSON.stringify(response.body)))) {
      throw new Error("Google start fixture exposed a private OAuth ledger through the public model");
    }
    const rawStates = [youtube.state, business.state];
    issuedStates = rawStates;
    const stateSensitiveEvidence = [
      ...publicModels.map(response => response.body),
      anonymous.text,
      invalidSession.text,
      oauthDebug.body,
      stdout,
      stderr,
      await shopifyScenarioExternalAttempts(requestLogPath),
      await shopifyScenarioExternalAttempts(providerMockLogPath)
    ];
    assertGoogleStartPrivateMarkersAbsent(stateSensitiveEvidence, rawStates, "public responses or logs");
    assertGoogleStartPrivateMarkersAbsent(
      [anonymous.text, invalidSession.text, youtubeStart.location, businessStart.location,
        ...publicModels.map(response => response.body), oauthDebug.body, stdout, stderr, rawModelSource],
      privateMarkers,
      "HTTP, logs, or persistence"
    );
    if ((rawModel.shared?.oauthEvents || []).some(event => rawStates.some(state => JSON.stringify(event).includes(state)))) {
      throw new Error("Google start fixture retained a raw OAuth state in the durable audit log");
    }
    const finalRequests = await shopifyScenarioExternalAttempts(requestLogPath);
    const finalMocks = await shopifyScenarioExternalAttempts(providerMockLogPath);
    if (finalRequests.length !== 0 || finalMocks.length !== 0) {
      throw new Error("Google start fixture attempted a provider request");
    }
    result = {
      anonymousStatus: anonymous.status,
      invalidSessionStatus: invalidSession.status,
      unauthenticatedMutation: false,
      youtubeStatus: youtubeStart.status,
      businessStatus: businessStart.status,
      youtubeScopes: youtube.scopes,
      businessScopes: business.scopes,
      signedStates: true,
      distinctStates: true,
      revisionsAdvanced: true,
      ownerWorkspaceBound: true,
      foreignWorkspaceIsolated: true,
      rawStateRedactedFromPublicEvidence: true,
      externalRequests: finalRequests.length,
      mockedProviderRequests: finalMocks.length
    };
  } catch (error) {
    scenarioFailure = error;
  } finally {
    await stopShopifyScenarioServer(child);
    childStopped = child.exitCode !== null || child.signalCode !== null;
  }

  let postFailure = scenarioFailure;
  let cleanupComplete = false;
  try {
    assertGoogleStartPrivateMarkersAbsent(`${stdout}\n${stderr}`, [...privateMarkers, ...issuedStates], "stdout or stderr");
    if ((await shopifyScenarioExternalAttempts(requestLogPath)).length !== 0
      || (await shopifyScenarioExternalAttempts(providerMockLogPath)).length !== 0) {
      throw new Error("Google start fixture recorded provider traffic");
    }
    if (!childStopped) throw new Error("Google start fixture did not stop its child process");
    try {
      await access(workspaceLockPath);
      throw new Error("Google start fixture retained the workspace lock after shutdown");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (JSON.stringify(Object.entries(process.env)) !== parentBefore) {
      throw new Error("Google start fixture mutated the parent process environment");
    }
  } catch (error) {
    if (!postFailure) postFailure = error;
  } finally {
    await rm(scenarioDataDir, { recursive: true, force: true });
    try {
      await access(scenarioDataDir);
    } catch (error) {
      if (error?.code === "ENOENT") cleanupComplete = true;
      else if (!postFailure) postFailure = error;
    }
  }
  if (!cleanupComplete && !postFailure) postFailure = new Error("Google start fixture cleanup was incomplete");
  if (postFailure) throw postFailure;
  return { ...result, cleanupComplete };
}

async function seedXAccountWorkspaceFixture({ dataDir, encryptionKey, user, workspaceId }) {
  const seedSource = await readFile(new URL("./social-cues-model-seed.json", import.meta.url), "utf8");
  const seed = JSON.parse(seedSource.replace(/^\uFEFF/, ""));
  const owner = { ...user, id: String(user?.id || ""), workspaceId: String(workspaceId || "") };
  if (!owner.id || !owner.workspaceId) throw new Error("X account fixture is missing its canonical owner identity");
  const unavailable = () => { throw new Error("X account fixture must not invoke a browser merge callback"); };
  const store = await openLocalWorkspacePersistence({ dataDir, seed, mergeClient: unavailable, recoverClient: unavailable });
  try {
    const sharedModel = await store.load();
    const model = store.view(sharedModel, owner.workspaceId);
    model.connectedAccounts = (model.connectedAccounts || []).filter(account => account.platform !== "x");
    model.connectedAccounts.push({
      id: `acct-x-p26-${owner.id}`,
      platform: "x",
      name: "X",
      displayName: "P26 X Owner",
      handle: "@p26_x_owner",
      status: "connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "x",
      providerAccountId: SYNTHETIC_X_ACCOUNT_PROVIDER_ID,
      credential: encryptedShopifyFixtureToken(SYNTHETIC_X_ACCOUNT_ACCESS_TOKEN, encryptionKey),
      tokenType: "Bearer",
      scopes: [...X_ACCOUNT_WRITE_SCOPES],
      requestedScopes: [...X_ACCOUNT_WRITE_SCOPES],
      ownerUserId: owner.id,
      workspaceId: owner.workspaceId
    });
    await store.save(model, owner);
  } finally {
    await store.close();
  }
}

async function runXAccountBoundaryScenario() {
  const parentBefore = JSON.stringify(Object.entries(process.env));
  const scenarioPort = await availableLoopbackPort();
  const scenarioBaseUrl = `http://127.0.0.1:${scenarioPort}`;
  const scenarioDataDir = path.join(process.cwd(), ".tmp", `x-account-p26-${Date.now()}`);
  const modelPath = path.join(scenarioDataDir, "model.json");
  const requestLogPath = path.join(scenarioDataDir, "external-http-requests.ndjson");
  const providerMockLogPath = path.join(scenarioDataDir, "provider-mocks.ndjson");
  const workspaceLockPath = path.join(scenarioDataDir, ".workspace-content.lock");
  const ownerPassword = "p26-x-owner-password-2026";
  const foreignPassword = "p26-x-foreign-password-2026";
  const privateMarkers = [
    SYNTHETIC_X_ACCOUNT_CLIENT_ID,
    SYNTHETIC_X_ACCOUNT_CLIENT_SECRET,
    SYNTHETIC_X_ACCOUNT_AUTH_SECRET,
    SYNTHETIC_X_ACCOUNT_ENCRYPTION_KEY,
    SYNTHETIC_X_ACCOUNT_ACCESS_TOKEN,
    ownerPassword,
    foreignPassword
  ];
  await mkdir(scenarioDataDir, { recursive: true });
  const childEnv = xAccountScenarioEnv({
    baseEnv: {
      ...process.env,
      ...Object.fromEntries(X_ACCOUNT_ENV_NAMES.map((name, index) => [name, `p26-inherited-x-${index}`])),
      x_CliEnT_iD: "p26-inherited-mixed-case-id",
      X_cLiEnT_sEcReT: "p26-inherited-mixed-case-secret"
    },
    overrides: {
      PORT: String(scenarioPort),
      HOST: "127.0.0.1",
      AUTH_PROVIDER: "alpha-local",
      SUPABASE_ENABLED: "false",
      SENTRY_DSN: "",
      PUBLIC_APP_URL: "https://socialcuesapp.com",
      X_PUBLIC_APP_URL: "https://socialcuesapp.com",
      X_CLIENT_ID: SYNTHETIC_X_ACCOUNT_CLIENT_ID,
      X_CLIENT_SECRET: SYNTHETIC_X_ACCOUNT_CLIENT_SECRET,
      X_OAUTH_SCOPES: X_ACCOUNT_READ_SCOPES.join(" "),
      X_OAUTH_WRITE_SCOPES: X_ACCOUNT_WRITE_SCOPES.join(" "),
      AUTH_SESSION_SECRET: SYNTHETIC_X_ACCOUNT_AUTH_SECRET,
      OAUTH_TOKEN_ENCRYPTION_KEY: SYNTHETIC_X_ACCOUNT_ENCRYPTION_KEY,
      SOCIAL_CUES_DATA_DIR: scenarioDataDir,
      SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: requestLogPath,
      SOCIAL_CUES_TEST_PROVIDER_MOCK_LOG: providerMockLogPath,
      SOCIAL_CUES_PROMO_CODES: JSON.stringify([
        { code: SYNTHETIC_X_ACCOUNT_OWNER_PROMO, label: "P26 X owner", days: 1, active: true },
        { code: SYNTHETIC_X_ACCOUNT_FOREIGN_PROMO, label: "P26 X foreign", days: 1, active: true }
      ])
    }
  });
  const retainedXNames = Object.keys(childEnv)
    .filter(name => X_ACCOUNT_ENV_KEYS.has(name.toLowerCase()))
    .sort();
  if (JSON.stringify(retainedXNames) !== JSON.stringify([
    "X_CLIENT_ID",
    "X_CLIENT_SECRET",
    "X_OAUTH_SCOPES",
    "X_OAUTH_WRITE_SCOPES",
    "X_PUBLIC_APP_URL"
  ])) {
    throw new Error("X account fixture retained inherited X configuration");
  }

  let stdout = "";
  let stderr = "";
  let child = null;
  let startedChildren = 0;
  let stoppedChildren = 0;
  let result;
  let scenarioFailure;
  const auth = token => ({ headers: { Authorization: `Bearer ${token}` } });
  const revision = response => response.body?.persistence?.revision || null;
  const sameRevision = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const revisionAdvancedOnce = (before, after) => Boolean(
    before?.epoch
    && before.epoch === after?.epoch
    && BigInt(after.revision) === BigInt(before.revision) + 1n
  );
  const fileBytes = async () => readFile(modelPath);
  const startChild = async label => {
    child = spawn(process.execPath, [`--import=${pathToFileURL(externalRequestGuardPath).href}`, "server.mjs"], {
      cwd: new URL(".", import.meta.url),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    startedChildren += 1;
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    await waitForShopifyScenarioServer(child, scenarioBaseUrl, label);
  };
  const stopChild = async () => {
    if (!child) return;
    const current = child;
    await stopShopifyScenarioServer(current);
    if (current.exitCode === null && current.signalCode === null) {
      throw new Error("X account fixture did not stop its child process");
    }
    stoppedChildren += 1;
    child = null;
  };
  const assertNoWorkspaceLock = async label => {
    try {
      await access(workspaceLockPath);
      throw new Error(`X account fixture retained the workspace lock ${label}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  const assertSanitizedAccessDenial = (label, response) => {
    const keys = Object.keys(response.body || {}).sort();
    const expectedKeys = ["accessRequired", "checkoutPath", "error", "ok", "portalPath"].sort();
    if (response.status !== 402
      || response.body?.ok !== false
      || response.body?.accessRequired !== true
      || response.body?.checkoutPath !== "/api/billing/checkout"
      || response.body?.portalPath !== "/portal"
      || response.body?.error !== "Buy Social Cues or use an active approved promo entitlement before using the app."
      || JSON.stringify(keys) !== JSON.stringify(expectedKeys)
      || response.location
      || response.headers["set-cookie"]
      || /workspace_writer_unclassified|commitStatus/iu.test(response.text)
      || containsXAccountCredentialField(response.body)) {
      throw new Error(`X account fixture did not return the exact sanitized access denial for ${label}`);
    }
  };

  try {
    await startChild("P26 X account workspace setup");
    const signup = input => shopifyScenarioResponse(scenarioBaseUrl, "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    const ownerSignup = await signup({
      name: "P26 X Owner",
      email: `p26-x-owner-${Date.now()}@example.test`,
      password: ownerPassword,
      promoCode: SYNTHETIC_X_ACCOUNT_OWNER_PROMO,
      workspaceName: "P26 X Owner Workspace"
    });
    const foreignSignup = await signup({
      name: "P26 X Foreign",
      email: `p26-x-foreign-${Date.now()}@example.test`,
      password: foreignPassword,
      promoCode: SYNTHETIC_X_ACCOUNT_FOREIGN_PROMO,
      workspaceName: "P26 X Foreign Workspace"
    });
    const ownerToken = ownerSignup.body?.session?.token || "";
    const foreignToken = foreignSignup.body?.session?.token || "";
    const ownerUser = ownerSignup.body?.user || ownerSignup.body?.session?.user || null;
    const foreignUser = foreignSignup.body?.user || foreignSignup.body?.session?.user || null;
    const ownerWorkspaceId = ownerSignup.body?.workspace?.id || "";
    const foreignWorkspaceId = foreignSignup.body?.workspace?.id || "";
    if (ownerSignup.status !== 200 || foreignSignup.status !== 200
      || !ownerToken || !foreignToken || !ownerUser?.id || !foreignUser?.id
      || !ownerWorkspaceId || !foreignWorkspaceId || ownerWorkspaceId === foreignWorkspaceId
      || ownerSignup.body?.workspace?.ownerUserId !== ownerUser.id
      || foreignSignup.body?.workspace?.ownerUserId !== foreignUser.id) {
      throw new Error("X account fixture could not establish isolated entitled workspaces");
    }
    privateMarkers.push(ownerToken, foreignToken);

    await stopChild();
    await assertNoWorkspaceLock("before canonical seeding");
    await seedXAccountWorkspaceFixture({
      dataDir: scenarioDataDir,
      encryptionKey: SYNTHETIC_X_ACCOUNT_ENCRYPTION_KEY,
      user: ownerUser,
      workspaceId: ownerWorkspaceId
    });
    await startChild("P26 X account authenticated boundary");

    const ownerAuth = auth(ownerToken);
    const foreignAuth = auth(foreignToken);
    const ownerBeforeDenials = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const foreignBeforeDenials = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    const bytesBeforeDenials = await fileBytes();
    const externalBeforeDenials = await shopifyScenarioExternalAttempts(requestLogPath);
    const mocksBeforeDenials = await shopifyScenarioExternalAttempts(providerMockLogPath);

    const anonymous = await shopifyScenarioResponse(scenarioBaseUrl, "/api/x/account");
    const invalidSession = await shopifyScenarioResponse(
      scenarioBaseUrl,
      "/api/x/account",
      auth("p26-invalid-x-session")
    );
    assertSanitizedAccessDenial("anonymous request", anonymous);
    assertSanitizedAccessDenial("invalid session", invalidSession);
    const ownerAfterDenials = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const foreignAfterDenials = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    if (Buffer.compare(bytesBeforeDenials, await fileBytes()) !== 0
      || !sameRevision(revision(ownerBeforeDenials), revision(ownerAfterDenials))
      || !sameRevision(revision(foreignBeforeDenials), revision(foreignAfterDenials))) {
      throw new Error("X account fixture changed storage or a workspace revision before authentication");
    }
    if (JSON.stringify(await shopifyScenarioExternalAttempts(requestLogPath)) !== JSON.stringify(externalBeforeDenials)
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(mocksBeforeDenials)) {
      throw new Error("X account fixture attempted provider traffic before authentication");
    }

    const ownerAccount = await shopifyScenarioResponse(scenarioBaseUrl, "/api/x/account", ownerAuth);
    const ownerAfterAccount = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const expectedResponseKeys = [
      "account", "capabilityLanes", "configured", "connectRoute", "connectionState", "defaultScopes",
      "ok", "postingReady", "postingStatus", "ready", "redirectUri", "refreshError", "refreshed", "repaired",
      "requestableScopes", "scopes", "verified", "writeConnectRoute", "writeScopes"
    ].sort();
    const lane = id => ownerAccount.body?.capabilityLanes?.find(item => item.id === id);
    if (ownerAccount.status !== 200 || ownerAccount.body?.ok !== true
      || JSON.stringify(Object.keys(ownerAccount.body || {}).sort()) !== JSON.stringify(expectedResponseKeys)
      || ownerAccount.body?.configured !== true
      || ownerAccount.body?.ready !== true
      || ownerAccount.body?.verified !== true
      || ownerAccount.body?.postingReady !== true
      || ownerAccount.body?.repaired !== false
      || ownerAccount.body?.refreshed !== false
      || ownerAccount.body?.refreshError !== null
      || ownerAccount.body?.redirectUri !== "https://socialcuesapp.com/api/oauth/x/callback"
      || ownerAccount.body?.connectRoute !== "/api/oauth/x/start"
      || ownerAccount.body?.writeConnectRoute !== "/api/oauth/x/start?mode=write"
      || JSON.stringify(ownerAccount.body?.scopes) !== JSON.stringify(X_ACCOUNT_READ_SCOPES)
      || JSON.stringify(ownerAccount.body?.defaultScopes) !== JSON.stringify(X_ACCOUNT_READ_SCOPES)
      || JSON.stringify(ownerAccount.body?.writeScopes) !== JSON.stringify(X_ACCOUNT_WRITE_SCOPES)
      || JSON.stringify(ownerAccount.body?.requestableScopes) !== JSON.stringify(["tweet.read", "users.read", "offline.access", "tweet.write"])
      || ownerAccount.body?.account?.providerAccountId !== SYNTHETIC_X_ACCOUNT_PROVIDER_ID
      || ownerAccount.body?.account?.ownerUserId !== ownerUser.id
      || ownerAccount.body?.account?.workspaceId !== ownerWorkspaceId
      || ownerAccount.body?.account?.connected !== true
      || ownerAccount.body?.account?.tokenStored !== true
      || ownerAccount.body?.account?.identityVerified !== true
      || JSON.stringify(ownerAccount.body?.account?.grantedScopes) !== JSON.stringify(X_ACCOUNT_WRITE_SCOPES)
      || ownerAccount.body?.connectionState?.connected !== true
      || ownerAccount.body?.connectionState?.reason !== "connected"
      || ownerAccount.body?.postingStatus?.state !== "oauth-ready"
      || lane("identity")?.status !== "available"
      || lane("post-create")?.status !== "available"
      || lane("post-read")?.status !== "available") {
      throw new Error("Authenticated X account fixture changed owner account, readiness, or scope truth");
    }
    if (!revisionAdvancedOnce(revision(ownerAfterDenials), revision(ownerAfterAccount))) {
      throw new Error("Authenticated X account validation did not advance the owner revision exactly once");
    }
    if (containsXAccountCredentialField(ownerAccount.body)) {
      throw new Error("Authenticated X account response exposed a credential-like field");
    }
    const rawAfterOwnerSource = await readFile(modelPath, "utf8");
    const rawAfterOwner = JSON.parse(rawAfterOwnerSource);
    const storedOwnerAccount = (rawAfterOwner.workspaces?.[ownerWorkspaceId]?.content?.connectedAccounts || [])
      .find(account => account.platform === "x" && account.providerAccountId === SYNTHETIC_X_ACCOUNT_PROVIDER_ID);
    if (storedOwnerAccount?.ownerUserId !== ownerUser.id
      || storedOwnerAccount?.workspaceId !== ownerWorkspaceId
      || storedOwnerAccount?.credential?.alg !== "aes-256-gcm"
      || storedOwnerAccount?.connectionEvidence !== "X local regression token accepted without provider network validation.") {
      throw new Error("Authenticated X account validation did not retain encrypted owner-scoped evidence");
    }
    assertXAccountPrivateMarkersAbsent(rawAfterOwnerSource, privateMarkers, "durable persistence");

    const bytesBeforeForeign = await fileBytes();
    const ownerRevisionBeforeForeign = revision(ownerAfterAccount);
    const foreignRevisionBefore = revision(foreignAfterDenials);
    const foreignAccount = await shopifyScenarioResponse(scenarioBaseUrl, "/api/x/account", foreignAuth);
    const ownerAfterForeign = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const foreignAfterAccount = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    if (foreignAccount.status !== 200 || foreignAccount.body?.ok !== true
      || foreignAccount.body?.configured !== true
      || foreignAccount.body?.ready !== false
      || foreignAccount.body?.verified !== false
      || foreignAccount.body?.account !== null
      || foreignAccount.body?.connectionState?.connected !== false
      || foreignAccount.body?.connectionState?.reason !== "missing-token"
      || JSON.stringify(foreignAccount.body).includes(ownerUser.id)
      || JSON.stringify(foreignAccount.body).includes(ownerWorkspaceId)
      || JSON.stringify(foreignAccount.body).includes(SYNTHETIC_X_ACCOUNT_PROVIDER_ID)
      || containsXAccountCredentialField(foreignAccount.body)) {
      throw new Error("X account fixture exposed owner provider state to a foreign workspace");
    }
    if (Buffer.compare(bytesBeforeForeign, await fileBytes()) !== 0
      || !sameRevision(ownerRevisionBeforeForeign, revision(ownerAfterForeign))
      || !sameRevision(foreignRevisionBefore, revision(foreignAfterAccount))) {
      throw new Error("Foreign X account inspection changed durable workspace state");
    }
    const externalAttempts = await shopifyScenarioExternalAttempts(requestLogPath);
    const providerMocks = await shopifyScenarioExternalAttempts(providerMockLogPath);
    if (externalAttempts.length !== 0 || providerMocks.length !== 0) {
      throw new Error("X account fixture attempted provider traffic");
    }
    assertXAccountPrivateMarkersAbsent(
      [anonymous.body, invalidSession.body, ownerAccount.body, foreignAccount.body, stdout, stderr, externalAttempts, providerMocks],
      privateMarkers,
      "HTTP, request logs, stdout, or stderr"
    );
    result = {
      anonymousStatus: anonymous.status,
      invalidSessionStatus: invalidSession.status,
      denialStorageUnchanged: true,
      denialRevisionsUnchanged: true,
      ownerStatus: ownerAccount.status,
      ownerReady: ownerAccount.body.ready,
      ownerVerified: ownerAccount.body.verified,
      ownerRevisionAdvancedExactlyOnce: true,
      foreignStatus: foreignAccount.status,
      foreignReady: foreignAccount.body.ready,
      foreignWorkspaceIsolated: true,
      encryptedCredentialRetained: true,
      externalRequests: externalAttempts.length,
      mockedProviderRequests: providerMocks.length
    };
  } catch (error) {
    scenarioFailure = error;
  } finally {
    try {
      await stopChild();
    } catch (error) {
      if (!scenarioFailure) scenarioFailure = error;
    }
  }

  let postFailure = scenarioFailure;
  let cleanupComplete = false;
  try {
    assertXAccountPrivateMarkersAbsent(`${stdout}\n${stderr}`, privateMarkers, "stdout or stderr");
    if ((await shopifyScenarioExternalAttempts(requestLogPath)).length !== 0
      || (await shopifyScenarioExternalAttempts(providerMockLogPath)).length !== 0) {
      throw new Error("X account fixture recorded provider traffic");
    }
    if (startedChildren !== 2 || stoppedChildren !== 2) {
      throw new Error("X account fixture did not verify both child-server shutdowns");
    }
    await assertNoWorkspaceLock("after shutdown");
    if (JSON.stringify(Object.entries(process.env)) !== parentBefore) {
      throw new Error("X account fixture mutated the parent process environment");
    }
  } catch (error) {
    if (!postFailure) postFailure = error;
  } finally {
    await rm(scenarioDataDir, { recursive: true, force: true });
    try {
      await access(scenarioDataDir);
    } catch (error) {
      if (error?.code === "ENOENT") cleanupComplete = true;
      else if (!postFailure) postFailure = error;
    }
  }
  if (!cleanupComplete && !postFailure) postFailure = new Error("X account fixture cleanup was incomplete");
  if (postFailure) throw postFailure;
  return { ...result, cleanupComplete };
}

async function seedDiscordCommunityWorkspaceFixture({ dataDir, encryptionKey, user, workspaceId }) {
  const seedSource = await readFile(new URL("./social-cues-model-seed.json", import.meta.url), "utf8");
  const seed = JSON.parse(seedSource.replace(/^\uFEFF/, ""));
  const owner = { ...user, id: String(user?.id || ""), workspaceId: String(workspaceId || "") };
  if (!owner.id || !owner.workspaceId) throw new Error("Discord community fixture is missing its canonical owner identity");
  const unavailable = () => { throw new Error("Discord community fixture must not invoke a browser merge callback"); };
  const store = await openLocalWorkspacePersistence({ dataDir, seed, mergeClient: unavailable, recoverClient: unavailable });
  try {
    const sharedModel = await store.load();
    const model = store.view(sharedModel, owner.workspaceId);
    model.connectedAccounts = (model.connectedAccounts || []).filter(account => account.platform !== "discord");
    model.connectedAccounts.push({
      id: `acct-discord-p28-${owner.id}`,
      platform: "discord",
      name: "Discord",
      displayName: "P28 Discord Owner",
      handle: "@p28_discord_owner",
      status: "connected",
      connectedAt: new Date().toISOString(),
      oauthProvider: "discord",
      providerAccountId: SYNTHETIC_DISCORD_COMMUNITY_PROVIDER_ID,
      credential: encryptedShopifyFixtureToken(SYNTHETIC_DISCORD_COMMUNITY_ACCESS_TOKEN, encryptionKey),
      tokenType: "Bearer",
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
      scopes: [...DISCORD_COMMUNITY_SCOPES],
      requestedScopes: [...DISCORD_COMMUNITY_SCOPES],
      ownerUserId: owner.id,
      workspaceId: owner.workspaceId
    });
    await store.save(model, owner);
  } finally {
    await store.close();
  }
}

async function runDiscordCommunityBoundaryScenario() {
  const parentBefore = JSON.stringify(Object.entries(process.env));
  const scenarioPort = await availableLoopbackPort();
  const scenarioBaseUrl = `http://127.0.0.1:${scenarioPort}`;
  const scenarioDataDir = path.join(process.cwd(), ".tmp", `discord-community-p28-${Date.now()}`);
  const modelPath = path.join(scenarioDataDir, "model.json");
  const requestLogPath = path.join(scenarioDataDir, "external-http-requests.ndjson");
  const providerMockLogPath = path.join(scenarioDataDir, "provider-mocks.ndjson");
  const workspaceLockPath = path.join(scenarioDataDir, ".workspace-content.lock");
  const ownerPassword = "p28-discord-owner-password-2026";
  const foreignPassword = "p28-discord-foreign-password-2026";
  const privateMarkers = [
    SYNTHETIC_DISCORD_COMMUNITY_CLIENT_SECRET,
    SYNTHETIC_DISCORD_PUBLIC_KEY,
    SYNTHETIC_DISCORD_COMMUNITY_AUTH_SECRET,
    SYNTHETIC_DISCORD_COMMUNITY_ENCRYPTION_KEY,
    SYNTHETIC_DISCORD_COMMUNITY_ACCESS_TOKEN,
    ownerPassword,
    foreignPassword
  ];
  await mkdir(scenarioDataDir, { recursive: true });
  const childEnv = discordScenarioEnv({
    baseEnv: {
      ...process.env,
      ...Object.fromEntries(DISCORD_SCENARIO_ENV_NAMES.map((name, index) => [name, `p28-inherited-discord-${index}`])),
      dIsCoRd_CliEnT_iD: "p28-inherited-mixed-case-id",
      DiScOrD_CliEnT_sEcReT: "p28-inherited-mixed-case-secret"
    },
    overrides: {
      PORT: String(scenarioPort),
      HOST: "127.0.0.1",
      AUTH_PROVIDER: "alpha-local",
      SUPABASE_ENABLED: "false",
      SENTRY_DSN: "",
      PUBLIC_APP_URL: "https://socialcuesapp.com",
      DISCORD_PUBLIC_APP_URL: "https://socialcuesapp.com",
      DISCORD_CLIENT_ID: SYNTHETIC_DISCORD_COMMUNITY_APPLICATION_ID,
      DISCORD_CLIENT_SECRET: SYNTHETIC_DISCORD_COMMUNITY_CLIENT_SECRET,
      DISCORD_PUBLIC_KEY: SYNTHETIC_DISCORD_PUBLIC_KEY,
      AUTH_SESSION_SECRET: SYNTHETIC_DISCORD_COMMUNITY_AUTH_SECRET,
      OAUTH_TOKEN_ENCRYPTION_KEY: SYNTHETIC_DISCORD_COMMUNITY_ENCRYPTION_KEY,
      SOCIAL_CUES_DATA_DIR: scenarioDataDir,
      SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: requestLogPath,
      SOCIAL_CUES_TEST_PROVIDER_MOCK_LOG: providerMockLogPath,
      SOCIAL_CUES_TEST_MOCK_DISCORD_COMMUNITY: "true",
      SOCIAL_CUES_TEST_DISCORD_ACCESS_TOKEN: SYNTHETIC_DISCORD_COMMUNITY_ACCESS_TOKEN,
      SOCIAL_CUES_PROMO_CODES: JSON.stringify([
        { code: SYNTHETIC_DISCORD_COMMUNITY_OWNER_PROMO, label: "P28 Discord owner", days: 1, active: true },
        { code: SYNTHETIC_DISCORD_COMMUNITY_FOREIGN_PROMO, label: "P28 Discord foreign", days: 1, active: true }
      ])
    }
  });
  const retainedDiscordNames = Object.keys(childEnv)
    .filter(name => DISCORD_SCENARIO_ENV_KEYS.has(name.toLowerCase()))
    .sort();
  if (JSON.stringify(retainedDiscordNames) !== JSON.stringify([
    "DISCORD_CLIENT_ID",
    "DISCORD_CLIENT_SECRET",
    "DISCORD_PUBLIC_APP_URL",
    "DISCORD_PUBLIC_KEY"
  ])) {
    throw new Error("Discord community fixture retained inherited Discord configuration");
  }

  let stdout = "";
  let stderr = "";
  let child = null;
  let startedChildren = 0;
  let stoppedChildren = 0;
  let result;
  let scenarioFailure;
  const auth = token => ({ headers: { Authorization: `Bearer ${token}` } });
  const revision = response => response.body?.persistence?.revision || null;
  const sameRevision = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const revisionAdvancedOnce = (before, after) => Boolean(
    before?.epoch
    && before.epoch === after?.epoch
    && BigInt(after.revision) === BigInt(before.revision) + 1n
  );
  const fileBytes = async () => readFile(modelPath);
  const startChild = async label => {
    child = spawn(process.execPath, [`--import=${pathToFileURL(externalRequestGuardPath).href}`, "server.mjs"], {
      cwd: new URL(".", import.meta.url),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    startedChildren += 1;
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    await waitForShopifyScenarioServer(child, scenarioBaseUrl, label);
  };
  const stopChild = async () => {
    if (!child) return;
    const current = child;
    await stopShopifyScenarioServer(current);
    if (current.exitCode === null && current.signalCode === null) {
      throw new Error("Discord community fixture did not stop its child process");
    }
    stoppedChildren += 1;
    child = null;
  };
  const assertNoWorkspaceLock = async label => {
    try {
      await access(workspaceLockPath);
      throw new Error(`Discord community fixture retained the workspace lock ${label}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  const assertSanitizedAccessDenial = (label, response) => {
    const keys = Object.keys(response.body || {}).sort();
    const expectedKeys = ["accessRequired", "checkoutPath", "error", "ok", "portalPath"].sort();
    if (response.status !== 402
      || response.body?.ok !== false
      || response.body?.accessRequired !== true
      || response.body?.checkoutPath !== "/api/billing/checkout"
      || response.body?.portalPath !== "/portal"
      || response.body?.error !== "Buy Social Cues or use an active approved promo entitlement before using the app."
      || JSON.stringify(keys) !== JSON.stringify(expectedKeys)
      || response.location
      || response.headers["set-cookie"]
      || /workspace_writer_unclassified|commitStatus/iu.test(response.text)
      || containsDiscordCommunityCredentialField(response.body)) {
      throw new Error(`Discord community fixture did not return the exact sanitized access denial for ${label}`);
    }
  };

  try {
    await startChild("P28 Discord community workspace setup");
    const signup = input => shopifyScenarioResponse(scenarioBaseUrl, "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    const ownerSignup = await signup({
      name: "P28 Discord Owner",
      email: `p28-discord-owner-${Date.now()}@example.test`,
      password: ownerPassword,
      promoCode: SYNTHETIC_DISCORD_COMMUNITY_OWNER_PROMO,
      workspaceName: "P28 Discord Owner Workspace"
    });
    const foreignSignup = await signup({
      name: "P28 Discord Foreign",
      email: `p28-discord-foreign-${Date.now()}@example.test`,
      password: foreignPassword,
      promoCode: SYNTHETIC_DISCORD_COMMUNITY_FOREIGN_PROMO,
      workspaceName: "P28 Discord Foreign Workspace"
    });
    const ownerToken = ownerSignup.body?.session?.token || "";
    const foreignToken = foreignSignup.body?.session?.token || "";
    const ownerUser = ownerSignup.body?.user || ownerSignup.body?.session?.user || null;
    const foreignUser = foreignSignup.body?.user || foreignSignup.body?.session?.user || null;
    const ownerWorkspaceId = ownerSignup.body?.workspace?.id || "";
    const foreignWorkspaceId = foreignSignup.body?.workspace?.id || "";
    if (ownerSignup.status !== 200 || foreignSignup.status !== 200
      || !ownerToken || !foreignToken || !ownerUser?.id || !foreignUser?.id
      || !ownerWorkspaceId || !foreignWorkspaceId || ownerWorkspaceId === foreignWorkspaceId
      || ownerSignup.body?.workspace?.ownerUserId !== ownerUser.id
      || foreignSignup.body?.workspace?.ownerUserId !== foreignUser.id) {
      throw new Error("Discord community fixture could not establish isolated entitled workspaces");
    }
    privateMarkers.push(ownerToken, foreignToken);

    await stopChild();
    await assertNoWorkspaceLock("before canonical seeding");
    await seedDiscordCommunityWorkspaceFixture({
      dataDir: scenarioDataDir,
      encryptionKey: SYNTHETIC_DISCORD_COMMUNITY_ENCRYPTION_KEY,
      user: ownerUser,
      workspaceId: ownerWorkspaceId
    });
    await startChild("P28 Discord community authenticated boundary");

    const ownerAuth = auth(ownerToken);
    const foreignAuth = auth(foreignToken);
    const ownerBeforeDenials = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const foreignBeforeDenials = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    const bytesBeforeDenials = await fileBytes();
    const externalBeforeDenials = await shopifyScenarioExternalAttempts(requestLogPath);
    const mocksBeforeDenials = await shopifyScenarioExternalAttempts(providerMockLogPath);

    const anonymous = await shopifyScenarioResponse(scenarioBaseUrl, "/api/discord/community");
    const invalidSession = await shopifyScenarioResponse(
      scenarioBaseUrl,
      "/api/discord/community",
      auth("p28-invalid-discord-session")
    );
    assertSanitizedAccessDenial("anonymous request", anonymous);
    assertSanitizedAccessDenial("invalid session", invalidSession);
    const ownerAfterDenials = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const foreignAfterDenials = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    if (Buffer.compare(bytesBeforeDenials, await fileBytes()) !== 0
      || !sameRevision(revision(ownerBeforeDenials), revision(ownerAfterDenials))
      || !sameRevision(revision(foreignBeforeDenials), revision(foreignAfterDenials))) {
      throw new Error("Discord community fixture changed storage or a workspace revision before authentication");
    }
    if (JSON.stringify(await shopifyScenarioExternalAttempts(requestLogPath)) !== JSON.stringify(externalBeforeDenials)
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(mocksBeforeDenials)) {
      throw new Error("Discord community fixture attempted provider traffic before authentication");
    }

    const bytesBeforeForeign = await fileBytes();
    const foreignNoAccount = await shopifyScenarioResponse(scenarioBaseUrl, "/api/discord/community", foreignAuth);
    const ownerAfterForeign = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const foreignAfterNoAccount = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    if (foreignNoAccount.status !== 409
      || foreignNoAccount.body?.ok !== false
      || foreignNoAccount.body?.error !== "Connect Discord OAuth before Social Cues can read community/server signal."
      || foreignNoAccount.body?.connectRoute !== "/api/oauth/discord/start"
      || JSON.stringify(foreignNoAccount.body?.requiredScopes) !== JSON.stringify(DISCORD_COMMUNITY_SCOPES)
      || JSON.stringify(Object.keys(foreignNoAccount.body || {}).sort()) !== JSON.stringify(["connectRoute", "error", "ok", "requiredScopes"])
      || JSON.stringify(foreignNoAccount.body).includes(ownerUser.id)
      || JSON.stringify(foreignNoAccount.body).includes(ownerWorkspaceId)
      || JSON.stringify(foreignNoAccount.body).includes(SYNTHETIC_DISCORD_COMMUNITY_PROVIDER_ID)
      || containsDiscordCommunityCredentialField(foreignNoAccount.body)) {
      throw new Error("Discord community fixture exposed owner account state to a foreign no-account workspace");
    }
    if (Buffer.compare(bytesBeforeForeign, await fileBytes()) !== 0
      || !sameRevision(revision(ownerAfterDenials), revision(ownerAfterForeign))
      || !sameRevision(revision(foreignAfterDenials), revision(foreignAfterNoAccount))) {
      throw new Error("Foreign Discord community inspection changed durable workspace state");
    }
    if (JSON.stringify(await shopifyScenarioExternalAttempts(requestLogPath)) !== JSON.stringify(externalBeforeDenials)
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(mocksBeforeDenials)) {
      throw new Error("Foreign Discord community inspection attempted provider traffic");
    }

    const ownerCommunity = await shopifyScenarioResponse(scenarioBaseUrl, "/api/discord/community", ownerAuth);
    const ownerAfterCommunity = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const foreignAfterCommunity = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    const expectedResponseKeys = [
      "account", "allowedUse", "channels", "configuredTargets", "gates", "guilds",
      "install", "member", "ok", "selectedTarget", "user", "warnings"
    ].sort();
    if (ownerCommunity.status !== 200
      || ownerCommunity.body?.ok !== true
      || JSON.stringify(Object.keys(ownerCommunity.body || {}).sort()) !== JSON.stringify(expectedResponseKeys)
      || ownerCommunity.body?.account?.connected !== true
      || ownerCommunity.body?.account?.tokenStored !== true
      || ownerCommunity.body?.account?.ownerUserId !== ownerUser.id
      || ownerCommunity.body?.account?.workspaceId !== ownerWorkspaceId
      || ownerCommunity.body?.user?.id !== SYNTHETIC_DISCORD_COMMUNITY_PROVIDER_ID
      || ownerCommunity.body?.guilds?.length !== 1
      || ownerCommunity.body.guilds[0]?.id !== SYNTHETIC_DISCORD_COMMUNITY_GUILD_ID
      || ownerCommunity.body.guilds[0]?.authority?.administrator !== true
      || ownerCommunity.body?.channels?.length !== 0
      || ownerCommunity.body?.member !== null
      || ownerCommunity.body?.selectedTarget?.guildId !== null
      || ownerCommunity.body?.selectedTarget?.channelId !== null
      || ownerCommunity.body?.configuredTargets?.botReady !== false
      || ownerCommunity.body?.gates?.memberScopeReady !== false
      || ownerCommunity.body?.gates?.botReady !== false
      || ownerCommunity.body?.gates?.channelReady !== false
      || containsDiscordCommunityCredentialField(ownerCommunity.body)) {
      throw new Error("Authenticated Discord community fixture changed the public owner response contract");
    }
    if (!revisionAdvancedOnce(revision(ownerAfterForeign), revision(ownerAfterCommunity))
      || !sameRevision(revision(foreignAfterNoAccount), revision(foreignAfterCommunity))) {
      throw new Error("Authenticated Discord community refresh did not advance only the owner revision exactly once");
    }
    const rawAfterOwnerSource = await readFile(modelPath, "utf8");
    const rawAfterOwner = JSON.parse(rawAfterOwnerSource);
    const storedOwnerAccount = (rawAfterOwner.workspaces?.[ownerWorkspaceId]?.content?.connectedAccounts || [])
      .find(account => account.platform === "discord" && account.providerAccountId === SYNTHETIC_DISCORD_COMMUNITY_PROVIDER_ID);
    if (storedOwnerAccount?.ownerUserId !== ownerUser.id
      || storedOwnerAccount?.workspaceId !== ownerWorkspaceId
      || storedOwnerAccount?.credential?.alg !== "aes-256-gcm"
      || storedOwnerAccount?.profile?.user?.id !== SYNTHETIC_DISCORD_COMMUNITY_PROVIDER_ID
      || storedOwnerAccount?.profile?.guildCount !== 1
      || storedOwnerAccount?.profile?.guilds?.[0]?.id !== SYNTHETIC_DISCORD_COMMUNITY_GUILD_ID) {
      throw new Error("Authenticated Discord community refresh did not retain encrypted owner-scoped evidence");
    }
    assertDiscordCommunityPrivateMarkersAbsent(rawAfterOwnerSource, privateMarkers, "durable persistence");

    const externalAttempts = await shopifyScenarioExternalAttempts(requestLogPath);
    const providerMocks = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const providerSequenceEvidence = {
      externalRequests: externalAttempts.length,
      mocks: providerMocks.map(entry => ({
        kind: entry.kind,
        method: entry.method,
        bearerPresent: entry.bearerPresent,
        accessTokenMatches: entry.accessTokenMatches,
        boundedLimit: entry.boundedLimit,
        countsRequested: entry.countsRequested
      }))
    };
    if (externalAttempts.length !== 0
      || JSON.stringify(providerMocks.map(entry => entry.kind)) !== JSON.stringify([
        "discord-community-user-mock",
        "discord-community-guilds-mock"
      ])
      || providerMocks.some(entry => entry.method !== "GET" || !entry.bearerPresent || !entry.accessTokenMatches)
      || providerMocks[1]?.boundedLimit !== true
      || providerMocks[1]?.countsRequested !== true) {
      throw new Error(`Discord community fixture did not use the exact guarded provider sequence: ${JSON.stringify(providerSequenceEvidence)}`);
    }
    assertDiscordCommunityPrivateMarkersAbsent(
      [anonymous.body, invalidSession.body, foreignNoAccount.body, ownerCommunity.body, stdout, stderr, externalAttempts, providerMocks],
      privateMarkers,
      "HTTP, request logs, mock evidence, stdout, or stderr"
    );
    result = {
      anonymousStatus: anonymous.status,
      invalidSessionStatus: invalidSession.status,
      denialStorageUnchanged: true,
      denialRevisionsUnchanged: true,
      foreignStatus: foreignNoAccount.status,
      foreignWorkspaceIsolated: true,
      ownerStatus: ownerCommunity.status,
      ownerPublicShapeSafe: true,
      ownerRevisionAdvancedExactlyOnce: true,
      encryptedCredentialRetained: true,
      externalRequests: externalAttempts.length,
      mockedProviderRequests: providerMocks.length
    };
  } catch (error) {
    scenarioFailure = error;
  } finally {
    try {
      await stopChild();
    } catch (error) {
      if (!scenarioFailure) scenarioFailure = error;
    }
  }

  let postFailure = scenarioFailure;
  let cleanupComplete = false;
  try {
    assertDiscordCommunityPrivateMarkersAbsent(`${stdout}\n${stderr}`, privateMarkers, "stdout or stderr");
    if ((await shopifyScenarioExternalAttempts(requestLogPath)).length !== 0
      || (await shopifyScenarioExternalAttempts(providerMockLogPath)).length !== 2) {
      throw new Error("Discord community fixture recorded an unexpected provider request count");
    }
    if (startedChildren !== 2 || stoppedChildren !== 2) {
      throw new Error("Discord community fixture did not verify both child-server shutdowns");
    }
    await assertNoWorkspaceLock("after shutdown");
    if (JSON.stringify(Object.entries(process.env)) !== parentBefore) {
      throw new Error("Discord community fixture mutated the parent process environment");
    }
  } catch (error) {
    if (!postFailure) postFailure = error;
  } finally {
    await rm(scenarioDataDir, { recursive: true, force: true });
    try {
      await access(scenarioDataDir);
    } catch (error) {
      if (error?.code === "ENOENT") cleanupComplete = true;
      else if (!postFailure) postFailure = error;
    }
  }
  if (!cleanupComplete && !postFailure) postFailure = new Error("Discord community fixture cleanup was incomplete");
  if (postFailure) throw postFailure;
  return { ...result, cleanupComplete };
}

async function seedMetaAssetsWorkspaceFixture({ dataDir, encryptionKey, user, workspaceId }) {
  const seedSource = await readFile(new URL("./social-cues-model-seed.json", import.meta.url), "utf8");
  const seed = JSON.parse(seedSource.replace(/^\uFEFF/, ""));
  const owner = { ...user, id: String(user?.id || ""), workspaceId: String(workspaceId || "") };
  if (!owner.id || !owner.workspaceId) throw new Error("Meta assets fixture is missing its canonical owner identity");
  const unavailable = () => { throw new Error("Meta assets fixture must not invoke a browser merge callback"); };
  const store = await openLocalWorkspacePersistence({ dataDir, seed, mergeClient: unavailable, recoverClient: unavailable });
  try {
    const sharedModel = await store.load();
    const model = store.view(sharedModel, owner.workspaceId);
    model.connectedAccounts = Array.isArray(model.connectedAccounts) ? model.connectedAccounts : [];
    model.connectedAccounts.push({
      id: `acct-meta-assets-${owner.id}`,
      platform: "meta",
      name: "P22 Meta User",
      handle: "P22 Meta User",
      status: "asset returned",
      connectedAt: null,
      oauthProvider: "meta",
      providerAccountId: SYNTHETIC_META_ASSETS_USER_ID,
      credential: encryptedShopifyFixtureToken(SYNTHETIC_META_ASSETS_USER_TOKEN, encryptionKey),
      tokenType: "bearer",
      scopes: META_ASSETS_GRANTED_SCOPES,
      loginNote: "Meta login is present, but token-backed asset status needs server repair.",
      ownerUserId: owner.id,
      workspaceId: owner.workspaceId
    });
    await store.save(model, owner);
  } finally {
    await store.close();
  }
}

async function runMetaAssetsScenario() {
  const parentBefore = JSON.stringify(Object.entries(process.env));
  const scenarioPort = await availableLoopbackPort();
  const scenarioBaseUrl = `http://127.0.0.1:${scenarioPort}`;
  const scenarioDataDir = path.join(process.cwd(), ".tmp", `meta-assets-p22-${Date.now()}`);
  const modelPath = path.join(scenarioDataDir, "model.json");
  const requestLogPath = path.join(scenarioDataDir, "external-http-requests.ndjson");
  const providerMockLogPath = path.join(scenarioDataDir, "provider-mocks.ndjson");
  const workspaceLockPath = path.join(scenarioDataDir, ".workspace-content.lock");
  const ownerPassword = "p22-meta-assets-owner-password";
  const foreignPassword = "p22-meta-assets-foreign-password";
  const privateMarkers = [
    SYNTHETIC_META_ASSETS_APP_SECRET,
    SYNTHETIC_META_ASSETS_USER_TOKEN,
    SYNTHETIC_META_ASSETS_PAGE_TOKEN,
    SYNTHETIC_META_ASSETS_AUTH_SECRET,
    SYNTHETIC_META_ASSETS_ENCRYPTION_KEY,
    ownerPassword,
    foreignPassword
  ];
  await mkdir(scenarioDataDir, { recursive: true });
  const inheritedMetaCredentials = Object.fromEntries(
    META_START_CREDENTIAL_ENV_NAMES.map((name, index) => [name, `p22-inherited-meta-${index}`])
  );
  const childEnv = metaStartScenarioEnv({
    baseEnv: {
      ...process.env,
      ...inheritedMetaCredentials,
      MeTa_App_Id: "p22-inherited-mixed-case-id",
      mEtA_aPp_SeCrEt: "p22-inherited-mixed-case-secret"
    },
    overrides: {
      PORT: String(scenarioPort),
      HOST: "127.0.0.1",
      AUTH_PROVIDER: "alpha-local",
      SUPABASE_ENABLED: "false",
      SENTRY_DSN: "",
      PUBLIC_APP_URL: "https://socialcuesapp.com",
      META_PUBLIC_APP_URL: "https://socialcuesapp.com",
      META_APP_ID: SYNTHETIC_META_ASSETS_APP_ID,
      META_APP_SECRET: SYNTHETIC_META_ASSETS_APP_SECRET,
      AUTH_SESSION_SECRET: SYNTHETIC_META_ASSETS_AUTH_SECRET,
      OAUTH_TOKEN_ENCRYPTION_KEY: SYNTHETIC_META_ASSETS_ENCRYPTION_KEY,
      SOCIAL_CUES_DATA_DIR: scenarioDataDir,
      SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: requestLogPath,
      SOCIAL_CUES_TEST_PROVIDER_MOCK_LOG: providerMockLogPath,
      SOCIAL_CUES_TEST_MOCK_META_ASSETS: "true",
      SOCIAL_CUES_TEST_META_USER_ID: SYNTHETIC_META_ASSETS_USER_ID,
      SOCIAL_CUES_TEST_META_USER_TOKEN: SYNTHETIC_META_ASSETS_USER_TOKEN,
      SOCIAL_CUES_TEST_META_PAGE_ID: SYNTHETIC_META_ASSETS_PAGE_ID,
      SOCIAL_CUES_TEST_META_PAGE_TOKEN: SYNTHETIC_META_ASSETS_PAGE_TOKEN,
      SOCIAL_CUES_TEST_META_INSTAGRAM_ID: SYNTHETIC_META_ASSETS_INSTAGRAM_ID,
      SOCIAL_CUES_PROMO_CODES: JSON.stringify([
        { code: SYNTHETIC_META_ASSETS_OWNER_PROMO, label: "P22 Meta assets owner", days: 1, active: true },
        { code: SYNTHETIC_META_ASSETS_FOREIGN_PROMO, label: "P22 Meta assets foreign", days: 1, active: true }
      ])
    }
  });
  const retainedCredentialNames = Object.keys(childEnv)
    .filter(name => META_START_CREDENTIAL_ENV_KEYS.has(name.toLowerCase()))
    .sort();
  if (JSON.stringify(retainedCredentialNames) !== JSON.stringify(["META_APP_ID", "META_APP_SECRET"])) {
    throw new Error("Meta assets fixture retained inherited application credentials");
  }

  let stdout = "";
  let stderr = "";
  let child = null;
  let startedChildren = 0;
  let stoppedChildren = 0;
  let result;
  let scenarioFailure;
  const fileBytes = async () => {
    try {
      return await readFile(modelPath);
    } catch (error) {
      if (error?.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    }
  };
  const readDocument = async () => JSON.parse(await readFile(modelPath, "utf8"));
  const contentHash = value => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
  const receiptKeys = (document, workspaceId) => Object.keys(document.workspaces?.[workspaceId]?.receipts || {}).sort();
  const revision = response => response.body?.persistence?.revision || null;
  const auth = token => ({ headers: { Authorization: `Bearer ${token}` } });
  const startChild = async label => {
    child = spawn(process.execPath, [`--import=${pathToFileURL(externalRequestGuardPath).href}`, "server.mjs"], {
      cwd: new URL(".", import.meta.url),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    startedChildren += 1;
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    await waitForShopifyScenarioServer(child, scenarioBaseUrl, label);
  };
  const stopChild = async () => {
    if (!child) return;
    const current = child;
    await stopShopifyScenarioServer(current);
    if (current.exitCode === null && current.signalCode === null) {
      throw new Error("Meta assets fixture did not stop its child process");
    }
    stoppedChildren += 1;
    child = null;
  };
  const assertSanitizedDenial = (label, response) => {
    if (response.status !== 401
      || response.body?.ok !== false
      || response.body?.error !== "Sign in to Social Cues before using this API."
      || Object.keys(response.body || {}).sort().join(",") !== "error,ok"
      || response.location
      || /workspace_writer_unclassified|commitStatus/iu.test(response.text)) {
      throw new Error(`Meta assets fixture did not return an exact sanitized denial for ${label}`);
    }
  };

  try {
    await startChild("P22 Meta assets pre-authentication");
    const bytesBeforeStatic = await fileBytes();
    const externalBeforeStatic = await shopifyScenarioExternalAttempts(requestLogPath);
    const mocksBeforeStatic = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const useCases = await shopifyScenarioResponse(scenarioBaseUrl, "/api/meta/use-cases");
    const capabilities = await shopifyScenarioResponse(scenarioBaseUrl, "/api/meta/capabilities");
    if (useCases.status !== 200 || useCases.body?.ok !== true || !Array.isArray(useCases.body?.useCases)
      || capabilities.status !== 200 || capabilities.body?.ok !== true || !Array.isArray(capabilities.body?.capabilities)) {
      throw new Error("Meta assets fixture changed neighboring anonymous Meta capability routes");
    }
    if (Buffer.compare(await fileBytes(), bytesBeforeStatic) !== 0
      || JSON.stringify(await shopifyScenarioExternalAttempts(requestLogPath)) !== JSON.stringify(externalBeforeStatic)
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(mocksBeforeStatic)) {
      throw new Error("Anonymous Meta capability discovery mutated state or attempted provider traffic");
    }

    const bytesBeforeAnonymous = await fileBytes();
    const externalBeforeAnonymous = await shopifyScenarioExternalAttempts(requestLogPath);
    const mocksBeforeAnonymous = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const anonymous = await shopifyScenarioResponse(scenarioBaseUrl, "/api/meta/assets");
    const invalidSession = await shopifyScenarioResponse(
      scenarioBaseUrl,
      "/api/meta/assets",
      auth("p22-invalid-session")
    );
    assertSanitizedDenial("anonymous request", anonymous);
    assertSanitizedDenial("invalid session", invalidSession);
    if (Buffer.compare(await fileBytes(), bytesBeforeAnonymous) !== 0) {
      throw new Error("Unauthenticated Meta assets denial changed durable model bytes");
    }
    if (JSON.stringify(await shopifyScenarioExternalAttempts(requestLogPath)) !== JSON.stringify(externalBeforeAnonymous)
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(mocksBeforeAnonymous)) {
      throw new Error("Unauthenticated Meta assets denial attempted provider traffic");
    }

    const signup = async ({ name, email, password, promoCode, workspaceName }) => shopifyScenarioResponse(
      scenarioBaseUrl,
      "/api/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, promoCode, workspaceName })
      }
    );
    const ownerSignup = await signup({
      name: "P22 Meta Assets Owner",
      email: `p22-meta-owner-${Date.now()}@example.test`,
      password: ownerPassword,
      promoCode: SYNTHETIC_META_ASSETS_OWNER_PROMO,
      workspaceName: "P22 Meta Assets Workspace"
    });
    const foreignSignup = await signup({
      name: "P22 Meta Assets Foreign",
      email: `p22-meta-foreign-${Date.now()}@example.test`,
      password: foreignPassword,
      promoCode: SYNTHETIC_META_ASSETS_FOREIGN_PROMO,
      workspaceName: "P22 Foreign Workspace"
    });
    const ownerToken = ownerSignup.body?.session?.token || "";
    const ownerUser = ownerSignup.body?.user || null;
    const ownerWorkspaceId = ownerSignup.body?.workspace?.id || "";
    const foreignToken = foreignSignup.body?.session?.token || "";
    const foreignUser = foreignSignup.body?.user || null;
    const foreignWorkspaceId = foreignSignup.body?.workspace?.id || "";
    privateMarkers.push(ownerToken, foreignToken);
    if (ownerSignup.status !== 200 || !ownerToken || !ownerUser?.id || !ownerWorkspaceId
      || ownerSignup.body.workspace?.ownerUserId !== ownerUser.id
      || foreignSignup.status !== 200 || !foreignToken || !foreignUser?.id || !foreignWorkspaceId
      || foreignSignup.body.workspace?.ownerUserId !== foreignUser.id
      || ownerWorkspaceId === foreignWorkspaceId) {
      throw new Error("Meta assets fixture could not establish two distinct owner workspaces");
    }

    await stopChild();
    await seedMetaAssetsWorkspaceFixture({
      dataDir: scenarioDataDir,
      encryptionKey: SYNTHETIC_META_ASSETS_ENCRYPTION_KEY,
      user: ownerUser,
      workspaceId: ownerWorkspaceId
    });
    await startChild("P22 Meta assets authenticated repair");

    const ownerAuth = auth(ownerToken);
    const foreignAuth = auth(foreignToken);
    const ownerModelBefore = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const ownerRevisionBefore = revision(ownerModelBefore);
    const rawBeforeOwner = await readDocument();
    const ownerReceiptsBefore = receiptKeys(rawBeforeOwner, ownerWorkspaceId);
    const providerMocksBeforeOwner = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const externalBeforeOwner = await shopifyScenarioExternalAttempts(requestLogPath);
    const ownerAssets = await shopifyScenarioResponse(scenarioBaseUrl, "/api/meta/assets", ownerAuth);
    const ownerModelAfter = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const ownerRevisionAfter = revision(ownerModelAfter);
    const rawAfterOwner = await readDocument();
    const providerMocksAfterOwner = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const ownerMockDelta = providerMocksAfterOwner.slice(providerMocksBeforeOwner.length);
    const expectedMockKinds = [
      "meta-debug-token-mock",
      "meta-permissions-mock",
      "meta-accounts-mock",
      "meta-businesses-mock"
    ];
    if (ownerAssets.status !== 200 || ownerAssets.body?.ok !== true
      || !Array.isArray(ownerAssets.body.accounts) || ownerAssets.body.accounts.length !== 3
      || !Array.isArray(ownerAssets.body.capabilities) || ownerAssets.body.capabilities.length < 35
      || ownerAssets.body.metaConnection?.pageCount !== 1
      || ownerAssets.body.metaConnection?.instagramCount !== 1
      || ownerAssets.body.metaHealth?.tokenHealth?.valid !== true
      || ownerAssets.body.metaHealth?.tokenHealth?.appIdMatches !== true
      || ownerAssets.body.selectedProviderAccounts?.facebook !== SYNTHETIC_META_ASSETS_PAGE_ID
      || ownerAssets.body.selectedProviderAccounts?.instagram !== SYNTHETIC_META_ASSETS_INSTAGRAM_ID
      || !ownerAssets.body.capabilities.some(item => item.id === "facebook_pages_publish" && item.ready === true)) {
      throw new Error(`Authenticated Meta assets fixture did not return repaired owner-scoped assets and capability truth: ${JSON.stringify({
        status: ownerAssets.status,
        ok: ownerAssets.body?.ok,
        accountCount: ownerAssets.body?.accounts?.length ?? null,
        capabilityCount: ownerAssets.body?.capabilities?.length ?? null,
        pageCount: ownerAssets.body?.metaConnection?.pageCount ?? null,
        instagramCount: ownerAssets.body?.metaConnection?.instagramCount ?? null,
        tokenValid: ownerAssets.body?.metaHealth?.tokenHealth?.valid ?? null,
        appIdMatches: ownerAssets.body?.metaHealth?.tokenHealth?.appIdMatches ?? null,
        facebookSelected: ownerAssets.body?.selectedProviderAccounts?.facebook === SYNTHETIC_META_ASSETS_PAGE_ID,
        instagramSelected: ownerAssets.body?.selectedProviderAccounts?.instagram === SYNTHETIC_META_ASSETS_INSTAGRAM_ID,
        facebookPublishReady: ownerAssets.body?.capabilities?.some(item => item.id === "facebook_pages_publish" && item.ready === true) === true,
        ownerModelAccountCount: ownerModelAfter.body?.connectedAccounts?.length ?? null,
        ownerRawAccountCount: rawAfterOwner.workspaces?.[ownerWorkspaceId]?.content?.connectedAccounts?.length ?? null,
        ownerRawMetaAccounts: (rawAfterOwner.workspaces?.[ownerWorkspaceId]?.content?.connectedAccounts || [])
          .filter(account => account.oauthProvider === "meta" || ["meta", "facebook", "instagram"].includes(account.platform))
          .map(account => ({
            platform: account.platform,
            status: account.status,
            ownerMatches: account.ownerUserId === ownerUser.id,
            workspaceMatches: account.workspaceId === ownerWorkspaceId,
            providerAccountIdPresent: Boolean(account.providerAccountId),
            credentialPresent: Boolean(account.credential)
          })),
        providerMockKinds: ownerMockDelta.map(entry => entry.kind),
        providerMockChecksPassed: ownerMockDelta[0]?.inputTokenMatches === true
          && ownerMockDelta[0]?.appAccessTokenMatches === true
          && ownerMockDelta[1]?.userTokenMatches === true
          && ownerMockDelta[2]?.userTokenMatches === true
          && ownerMockDelta[2]?.fieldsPresent === true
          && ownerMockDelta[3]?.userTokenMatches === true
          && ownerMockDelta[3]?.fieldsPresent === true
      })}`);
    }
    if (!metaAssetsPublicShapeIsSafe(ownerAssets.body)
      || ownerAssets.body.accounts.some(account => Object.hasOwn(account, "ownerUserId") || Object.hasOwn(account, "workspaceId"))) {
      throw new Error("Authenticated Meta assets response exposed a private account field");
    }
    if (!ownerRevisionBefore || !ownerRevisionAfter
      || ownerRevisionBefore.epoch !== ownerRevisionAfter.epoch
      || BigInt(ownerRevisionAfter.revision) !== BigInt(ownerRevisionBefore.revision) + 1n) {
      throw new Error("Authenticated Meta assets repair did not advance the owner workspace revision exactly once");
    }
    if (JSON.stringify(receiptKeys(rawAfterOwner, ownerWorkspaceId)) !== JSON.stringify(ownerReceiptsBefore)) {
      throw new Error("Authenticated Meta assets server repair minted a client operation receipt");
    }
    if (JSON.stringify(ownerMockDelta.map(entry => entry.kind)) !== JSON.stringify(expectedMockKinds)
      || ownerMockDelta.some(entry => entry.method !== "GET")
      || ownerMockDelta[0]?.inputTokenMatches !== true
      || ownerMockDelta[0]?.appAccessTokenMatches !== true
      || ownerMockDelta[1]?.userTokenMatches !== true
      || ownerMockDelta[2]?.userTokenMatches !== true
      || ownerMockDelta[2]?.fieldsPresent !== true
      || ownerMockDelta[3]?.userTokenMatches !== true
      || ownerMockDelta[3]?.fieldsPresent !== true) {
      throw new Error("Authenticated Meta assets repair did not use the exact guarded Graph fixture sequence");
    }
    if (JSON.stringify(await shopifyScenarioExternalAttempts(requestLogPath)) !== JSON.stringify(externalBeforeOwner)) {
      throw new Error("Authenticated Meta assets repair attempted an unguarded external provider request");
    }
    const rawOwnerAccounts = (rawAfterOwner.workspaces?.[ownerWorkspaceId]?.content?.connectedAccounts || [])
      .filter(account => account.oauthProvider === "meta" || ["meta", "facebook", "instagram"].includes(account.platform));
    if (rawOwnerAccounts.length !== 3
      || rawOwnerAccounts.some(account => account.ownerUserId !== ownerUser.id || account.workspaceId !== ownerWorkspaceId)
      || !rawOwnerAccounts.every(account => account.status === "connected" && account.credential)) {
      throw new Error("Meta assets repair did not durably bind all repaired assets to the authenticated owner workspace");
    }
    const rawAfterOwnerSource = JSON.stringify(rawAfterOwner);
    assertMetaAssetsPrivateMarkersAbsent(rawAfterOwnerSource, privateMarkers, "durable persistence");

    const foreignModelBefore = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    const foreignRevisionBefore = revision(foreignModelBefore);
    const rawBeforeForeign = await readDocument();
    const bytesBeforeForeign = await fileBytes();
    const ownerContentHashBeforeForeign = contentHash(rawBeforeForeign.workspaces?.[ownerWorkspaceId]?.content);
    const allReceiptsBeforeForeign = Object.fromEntries(
      Object.entries(rawBeforeForeign.workspaces || {}).map(([workspaceId, entry]) => [workspaceId, Object.keys(entry.receipts || {}).sort()])
    );
    const providerMocksBeforeForeign = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const externalBeforeForeign = await shopifyScenarioExternalAttempts(requestLogPath);
    const foreignAssets = await shopifyScenarioResponse(scenarioBaseUrl, "/api/meta/assets", foreignAuth);
    const foreignModelAfter = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    const rawAfterForeign = await readDocument();
    const foreignRevisionAfter = revision(foreignModelAfter);
    if (foreignAssets.status !== 200 || foreignAssets.body?.ok !== true
      || foreignAssets.body.accounts?.length !== 0
      || foreignAssets.body.metaConnection !== null
      || foreignAssets.body.metaHealth?.hasMetaUserToken !== false
      || foreignAssets.body.diagnostic?.snapshot?.reason !== "META_TOKEN_NOT_VALID"
      || foreignAssets.body.selectedProviderAccounts?.facebook !== null
      || foreignAssets.body.selectedProviderAccounts?.instagram !== null
      || !Array.isArray(foreignAssets.body.capabilities)
      || foreignAssets.body.capabilities.some(item => item.connectedAccountCount !== 0)
      || !ownerAssets.body.capabilities.some(item => item.connectedAccountCount > 0)) {
      throw new Error("Meta assets fixture exposed owner provider truth to a foreign workspace");
    }
    if (!metaAssetsPublicShapeIsSafe(foreignAssets.body)) {
      throw new Error("Foreign Meta assets response exposed a private field");
    }
    if (JSON.stringify(foreignRevisionAfter) !== JSON.stringify(foreignRevisionBefore)
      || Buffer.compare(await fileBytes(), bytesBeforeForeign) !== 0
      || contentHash(rawAfterForeign.workspaces?.[ownerWorkspaceId]?.content) !== ownerContentHashBeforeForeign
      || JSON.stringify(Object.fromEntries(
        Object.entries(rawAfterForeign.workspaces || {}).map(([workspaceId, entry]) => [workspaceId, Object.keys(entry.receipts || {}).sort()])
      )) !== JSON.stringify(allReceiptsBeforeForeign)) {
      throw new Error("Foreign Meta assets inspection changed durable workspace state or receipts");
    }
    if (JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(providerMocksBeforeForeign)
      || JSON.stringify(await shopifyScenarioExternalAttempts(requestLogPath)) !== JSON.stringify(externalBeforeForeign)) {
      throw new Error("Foreign Meta assets inspection attempted provider traffic");
    }
    assertMetaAssetsPrivateMarkersAbsent(
      [anonymous.body, invalidSession.body, ownerAssets.body, foreignAssets.body, providerMocksAfterOwner],
      privateMarkers,
      "HTTP or provider-mock evidence"
    );
    result = {
      anonymousStatus: anonymous.status,
      invalidSessionStatus: invalidSession.status,
      staticRoutesRemainAnonymous: true,
      ownerStatus: ownerAssets.status,
      ownerAccountCount: ownerAssets.body.accounts.length,
      ownerCapabilityCount: ownerAssets.body.capabilities.length,
      ownerRevisionAdvancedExactlyOnce: true,
      clientReceiptsUnchanged: true,
      foreignStatus: foreignAssets.status,
      foreignAccountCount: foreignAssets.body.accounts.length,
      foreignRevisionUnchanged: true,
      foreignWorkspaceIsolated: true,
      providerMockKinds: expectedMockKinds,
      externalRequests: 0
    };
  } catch (error) {
    scenarioFailure = error;
  } finally {
    try {
      await stopChild();
    } catch (error) {
      if (!scenarioFailure) scenarioFailure = error;
    }
  }

  let postFailure = scenarioFailure;
  let cleanupComplete = false;
  try {
    assertMetaAssetsPrivateMarkersAbsent(`${stdout}\n${stderr}`, privateMarkers, "stdout or stderr");
    const externalAttempts = await shopifyScenarioExternalAttempts(requestLogPath);
    if (externalAttempts.length !== 0) throw new Error("Meta assets fixture recorded an external request");
    const providerMocks = await shopifyScenarioExternalAttempts(providerMockLogPath);
    if (JSON.stringify(providerMocks.map(entry => entry.kind)) !== JSON.stringify([
      "meta-debug-token-mock",
      "meta-permissions-mock",
      "meta-accounts-mock",
      "meta-businesses-mock"
    ])) throw new Error("Meta assets fixture recorded an unexpected provider mock sequence");
    if (startedChildren !== 2 || stoppedChildren !== 2) {
      throw new Error("Meta assets fixture did not verify both child-server shutdowns");
    }
    try {
      await access(workspaceLockPath);
      throw new Error("Meta assets fixture retained the workspace lock after shutdown");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (JSON.stringify(Object.entries(process.env)) !== parentBefore) {
      throw new Error("Meta assets fixture mutated the parent process environment");
    }
  } catch (error) {
    if (!postFailure) postFailure = error;
  } finally {
    await rm(scenarioDataDir, { recursive: true, force: true });
    try {
      await access(scenarioDataDir);
    } catch (error) {
      if (error?.code === "ENOENT") cleanupComplete = true;
      else if (!postFailure) postFailure = error;
    }
  }
  if (!cleanupComplete && !postFailure) postFailure = new Error("Meta assets fixture cleanup was incomplete");
  if (postFailure) throw postFailure;
  return { ...result, cleanupComplete };
}

async function runMetaCallbackRejectionScenario() {
  const parentBefore = JSON.stringify(Object.entries(process.env));
  const scenarioPort = await availableLoopbackPort();
  const scenarioBaseUrl = `http://127.0.0.1:${scenarioPort}`;
  const scenarioDataDir = path.join(process.cwd(), ".tmp", `meta-callback-p23-${Date.now()}`);
  const modelPath = path.join(scenarioDataDir, "model.json");
  const requestLogPath = path.join(scenarioDataDir, "external-http-requests.ndjson");
  const providerMockLogPath = path.join(scenarioDataDir, "provider-mocks.ndjson");
  const workspaceLockPath = path.join(scenarioDataDir, ".workspace-content.lock");
  const ownerPassword = "p23-meta-callback-owner-password";
  const foreignPassword = "p23-meta-callback-foreign-password";
  const privateMarkers = [
    SYNTHETIC_META_CALLBACK_APP_SECRET,
    SYNTHETIC_META_CALLBACK_AUTH_SECRET,
    SYNTHETIC_META_CALLBACK_ENCRYPTION_KEY,
    SYNTHETIC_META_CALLBACK_FAILURE_CODE,
    ownerPassword,
    foreignPassword
  ];
  await mkdir(scenarioDataDir, { recursive: true });
  const childEnv = metaStartScenarioEnv({
    overrides: {
      PORT: String(scenarioPort),
      HOST: "127.0.0.1",
      AUTH_PROVIDER: "alpha-local",
      SUPABASE_ENABLED: "false",
      SENTRY_DSN: "",
      PUBLIC_APP_URL: "https://socialcuesapp.com",
      META_PUBLIC_APP_URL: "https://socialcuesapp.com",
      META_APP_ID: SYNTHETIC_META_CALLBACK_APP_ID,
      META_APP_SECRET: SYNTHETIC_META_CALLBACK_APP_SECRET,
      AUTH_SESSION_SECRET: SYNTHETIC_META_CALLBACK_AUTH_SECRET,
      OAUTH_TOKEN_ENCRYPTION_KEY: SYNTHETIC_META_CALLBACK_ENCRYPTION_KEY,
      SOCIAL_CUES_DATA_DIR: scenarioDataDir,
      SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: requestLogPath,
      SOCIAL_CUES_TEST_PROVIDER_MOCK_LOG: providerMockLogPath,
      SOCIAL_CUES_TEST_MOCK_META_CALLBACK: "true",
      SOCIAL_CUES_TEST_MOCK_META_ASSETS: "",
      SOCIAL_CUES_TEST_META_FAILURE_CODE: SYNTHETIC_META_CALLBACK_FAILURE_CODE,
      SOCIAL_CUES_PROMO_CODES: JSON.stringify([
        { code: SYNTHETIC_META_CALLBACK_OWNER_PROMO, label: "P23 Meta callback owner", days: 1, active: true },
        { code: SYNTHETIC_META_CALLBACK_FOREIGN_PROMO, label: "P23 Meta callback foreign", days: 1, active: true }
      ])
    }
  });
  const retainedCredentialNames = Object.keys(childEnv)
    .filter(name => META_START_CREDENTIAL_ENV_KEYS.has(name.toLowerCase()))
    .sort();
  if (JSON.stringify(retainedCredentialNames) !== JSON.stringify(["META_APP_ID", "META_APP_SECRET"])) {
    throw new Error("Meta callback fixture retained inherited application credentials");
  }

  let stdout = "";
  let stderr = "";
  let result;
  let scenarioFailure;
  let childStopped = false;
  const child = spawn(process.execPath, [`--import=${pathToFileURL(externalRequestGuardPath).href}`, "server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const auth = token => ({ headers: { Authorization: `Bearer ${token}` } });
  const durableSnapshot = async () => {
    const bytes = await readFile(modelPath);
    const document = JSON.parse(bytes.toString("utf8"));
    const revisions = Object.fromEntries(Object.entries(document.workspaces || {}).map(([workspaceId, entry]) => [
      workspaceId,
      { epoch: entry.epoch, revision: entry.revision }
    ]));
    const receipts = Object.fromEntries(Object.entries(document.workspaces || {}).map(([workspaceId, entry]) => [
      workspaceId,
      Object.keys(entry.receipts || {}).sort()
    ]));
    return { bytes, document, revisions, receipts };
  };
  const assertDurableUnchanged = async (before, label) => {
    const after = await durableSnapshot();
    if (Buffer.compare(after.bytes, before.bytes) !== 0) {
      throw new Error(`Meta callback rejection changed durable bytes for ${label}`);
    }
    if (JSON.stringify(after.revisions) !== JSON.stringify(before.revisions)) {
      throw new Error(`Meta callback rejection changed a workspace revision for ${label}`);
    }
    if (JSON.stringify(after.receipts) !== JSON.stringify(before.receipts)) {
      throw new Error(`Meta callback rejection changed a client receipt for ${label}`);
    }
  };
  const trafficSnapshot = async () => ({
    providerMocks: await shopifyScenarioExternalAttempts(providerMockLogPath),
    external: await shopifyScenarioExternalAttempts(requestLogPath)
  });
  const assertTrafficUnchanged = async (before, label) => {
    const after = await trafficSnapshot();
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(`Meta callback rejection attempted provider traffic for ${label}`);
    }
  };
  const rejectionResults = [];
  const assertRejected = async (label, route, options, expectedError) => {
    const durableBefore = await durableSnapshot();
    const trafficBefore = await trafficSnapshot();
    const response = await shopifyScenarioResponse(scenarioBaseUrl, route, options);
    if (response.status !== 400
      || !response.text.includes("<h1>Meta OAuth state rejected</h1>")
      || !response.text.includes(`<p>${expectedError}</p>`)
      || !String(response.headers["content-type"] || "").startsWith("text/html")
      || response.headers["set-cookie"]
      || response.location
      || /workspace_writer_unclassified|commitStatus/iu.test(response.text)) {
      throw new Error(`Meta callback fixture did not return the exact sanitized 400 for ${label}: ${response.status}`);
    }
    assertMetaCallbackPrivateMarkersAbsent(response.text, privateMarkers, `${label} response`);
    await assertDurableUnchanged(durableBefore, label);
    await assertTrafficUnchanged(trafficBefore, label);
    rejectionResults.push({ label, status: response.status });
    return response;
  };

  try {
    await waitForShopifyScenarioServer(child, scenarioBaseUrl, "P23 Meta callback");
    const signup = async ({ name, promoCode, password, workspaceName }) => shopifyScenarioResponse(
      scenarioBaseUrl,
      "/api/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email: `p23-meta-${name.toLowerCase()}-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`,
          password,
          promoCode,
          workspaceName
        })
      }
    );
    const ownerSignup = await signup({
      name: "Owner",
      password: ownerPassword,
      promoCode: SYNTHETIC_META_CALLBACK_OWNER_PROMO,
      workspaceName: "P23 Meta Owner Workspace"
    });
    const foreignSignup = await signup({
      name: "Foreign",
      password: foreignPassword,
      promoCode: SYNTHETIC_META_CALLBACK_FOREIGN_PROMO,
      workspaceName: "P23 Meta Foreign Workspace"
    });
    const ownerToken = ownerSignup.body?.session?.token || "";
    const ownerUserId = ownerSignup.body?.user?.id || "";
    const ownerWorkspaceId = ownerSignup.body?.workspace?.id || "";
    const foreignToken = foreignSignup.body?.session?.token || "";
    const foreignUserId = foreignSignup.body?.user?.id || "";
    const foreignWorkspaceId = foreignSignup.body?.workspace?.id || "";
    privateMarkers.push(ownerToken, foreignToken);
    if (ownerSignup.status !== 200 || !ownerToken || !ownerUserId || !ownerWorkspaceId
      || foreignSignup.status !== 200 || !foreignToken || !foreignUserId || !foreignWorkspaceId
      || ownerWorkspaceId === foreignWorkspaceId) {
      throw new Error("Meta callback fixture could not establish two distinct owner workspaces");
    }
    const ownerAuth = auth(ownerToken);
    const foreignAuth = auth(foreignToken);
    const start = await shopifyScenarioResponse(
      scenarioBaseUrl,
      "/api/oauth/meta/start?platform=facebook",
      ownerAuth
    );
    if (start.status !== 302 || !start.location) throw new Error("Meta callback fixture could not issue an owner-bound state");
    const providerRedirect = new URL(start.location);
    const ownerState = providerRedirect.searchParams.get("state") || "";
    if (!ownerState) throw new Error("Meta callback fixture start omitted state");
    const publicModel = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    if (publicModel.status !== 200
      || /"oauthStates"|"oauthEvents"/u.test(JSON.stringify(publicModel.body))
      || JSON.stringify(publicModel.body).includes(ownerState)) {
      throw new Error("Meta callback fixture exposed the private OAuth ledger through the public model");
    }
    const afterStart = await durableSnapshot();
    const ownerStateRecord = (afterStart.document.shared?.oauthStates || [])
      .find(record => record.provider === "meta" && record.state === ownerState);
    if (ownerStateRecord?.ownerUserId !== ownerUserId
      || ownerStateRecord?.userId !== ownerUserId
      || ownerStateRecord?.workspaceId !== ownerWorkspaceId) {
      throw new Error("Meta callback fixture state was not bound to the initiating owner workspace");
    }

    const malformedState = "p23-malformed-meta-state";
    const unissuedState = signedMetaCallbackState(ownerState, { nonce: "p23-unissued-meta-nonce" }, SYNTHETIC_META_CALLBACK_AUTH_SECRET);
    const wrongProviderState = signedMetaCallbackState(ownerState, { provider: "youtube" }, SYNTHETIC_META_CALLBACK_AUTH_SECRET);
    const decodedState = JSON.parse(Buffer.from(ownerState, "base64url").toString("utf8"));
    const replacement = String(decodedState.sig || "").startsWith("A") ? "B" : "A";
    const tamperedState = Buffer.from(JSON.stringify({
      ...decodedState,
      sig: `${replacement}${String(decodedState.sig || "").slice(1)}`
    })).toString("base64url");
    privateMarkers.push(ownerState, malformedState, unissuedState, wrongProviderState, tamperedState);
    const codeQuery = `code=${encodeURIComponent(SYNTHETIC_META_CALLBACK_FAILURE_CODE)}`;
    await assertRejected("missing state", `/api/oauth/meta/callback?${codeQuery}`, {}, META_CALLBACK_UNISSUED_ERROR);
    await assertRejected("malformed state", `/api/oauth/meta/callback?${codeQuery}&state=${encodeURIComponent(malformedState)}`, {}, META_CALLBACK_UNISSUED_ERROR);
    await assertRejected("tampered state", `/api/oauth/meta/callback?${codeQuery}&state=${encodeURIComponent(tamperedState)}`, {}, META_CALLBACK_UNISSUED_ERROR);
    await assertRejected("signed but unissued state", `/api/oauth/meta/callback?${codeQuery}&state=${encodeURIComponent(unissuedState)}`, {}, META_CALLBACK_UNISSUED_ERROR);
    await assertRejected("wrong-provider state", `/api/oauth/meta/callback?${codeQuery}&state=${encodeURIComponent(wrongProviderState)}`, {}, META_CALLBACK_UNISSUED_ERROR);
    await assertRejected("missing owner session", `/api/oauth/meta/callback?${codeQuery}&state=${encodeURIComponent(ownerState)}`, {}, META_CALLBACK_OWNER_REQUIRED_ERROR);
    await assertRejected("foreign owner session", `/api/oauth/meta/callback?${codeQuery}&state=${encodeURIComponent(ownerState)}`, foreignAuth, META_CALLBACK_OWNER_MISMATCH_ERROR);

    const rawBeforeValid = await readFile(modelPath, "utf8");
    assertMetaCallbackPrivateMarkersAbsent(
      rawBeforeValid,
      [malformedState, unissuedState, wrongProviderState, tamperedState, SYNTHETIC_META_CALLBACK_FAILURE_CODE, ownerToken, foreignToken],
      "rejected-state persistence"
    );
    const beforeValid = await durableSnapshot();
    const trafficBeforeValid = await trafficSnapshot();
    const validControl = await shopifyScenarioResponse(
      scenarioBaseUrl,
      `/api/oauth/meta/callback?${codeQuery}&state=${encodeURIComponent(ownerState)}`,
      ownerAuth
    );
    const trafficAfterValid = await trafficSnapshot();
    const mockDelta = trafficAfterValid.providerMocks.slice(trafficBeforeValid.providerMocks.length);
    if (JSON.stringify(mockDelta.map(entry => entry.kind)) !== JSON.stringify(["meta-token-exchange-failure-mock"])
      || mockDelta[0]?.method !== "GET"
      || mockDelta[0]?.clientIdMatches !== true
      || mockDelta[0]?.clientSecretMatches !== true
      || mockDelta[0]?.redirectMatches !== true
      || mockDelta[0]?.codeMatches !== true
      || JSON.stringify(trafficAfterValid.external) !== JSON.stringify(trafficBeforeValid.external)) {
      throw new Error("Meta callback valid control did not reach the exact guarded token exchange");
    }
    const validCookieRenewed = String(validControl.headers["set-cookie"] || "").includes("sc_session=");
    let nextAtomicSaveDefect = false;
    let nextAtomicSaveDefectCode = null;
    if (validControl.status === 409) {
      nextAtomicSaveDefect = validControl.body?.code === "workspace_shared_state_conflict"
        && validControl.body?.commitStatus === "not_committed";
      nextAtomicSaveDefectCode = validControl.body?.code || null;
      if (!nextAtomicSaveDefect) {
        throw new Error(`Meta callback valid control failed for an unexpected persistence reason: ${JSON.stringify({
          status: validControl.status,
          code: validControl.body?.code || null,
          error: validControl.body?.error || null,
          commitStatus: validControl.body?.commitStatus || null
        })}`);
      }
    } else if (validControl.status !== 200
      || !validControl.text.includes("Meta returned an authorization code")
      || !validControl.text.includes("Synthetic Meta token exchange rejected.")) {
      throw new Error(`Meta callback valid control returned an unexpected result: ${validControl.status}`);
    }
    if (!validCookieRenewed
      || /Meta OAuth state rejected|workspace_writer_unclassified/iu.test(validControl.text)) {
      throw new Error("Meta callback valid control did not preserve the authenticated callback boundary");
    }
    assertMetaCallbackPrivateMarkersAbsent(validControl.text, privateMarkers, "valid control response");
    const afterValid = await durableSnapshot();
    if (Buffer.compare(afterValid.bytes, beforeValid.bytes) === 0) {
      throw new Error("Meta callback valid control did not durably consume its state");
    }
    if (JSON.stringify(afterValid.revisions[foreignWorkspaceId]) !== JSON.stringify(beforeValid.revisions[foreignWorkspaceId])
      || JSON.stringify(afterValid.receipts[foreignWorkspaceId]) !== JSON.stringify(beforeValid.receipts[foreignWorkspaceId])) {
      throw new Error("Meta callback valid control changed the foreign workspace");
    }
    const rawAfterValid = await readFile(modelPath, "utf8");
    const documentAfterValid = JSON.parse(rawAfterValid);
    if ((documentAfterValid.shared?.oauthStates || []).some(record => record.state === ownerState)) {
      throw new Error("Meta callback valid control left the consumed state active");
    }
    assertMetaCallbackPrivateMarkersAbsent(rawAfterValid, privateMarkers, "post-control persistence and audit");
    assertMetaCallbackPrivateMarkersAbsent(mockDelta, privateMarkers, "provider mock evidence");

    const replay = await assertRejected(
      "replayed owner state",
      `/api/oauth/meta/callback?${codeQuery}&state=${encodeURIComponent(ownerState)}`,
      ownerAuth,
      META_CALLBACK_UNISSUED_ERROR
    );
    result = {
      rejectionStatuses: Object.fromEntries(rejectionResults.map(item => [item.label, item.status])),
      rejectedWrites: 0,
      validControlStatus: validControl.status,
      validControlReachedProviderMock: true,
      validControlCookieRenewed: validCookieRenewed,
      nextAtomicSaveDefect,
      nextAtomicSaveDefectCode,
      replayStatus: replay.status,
      providerMocks: mockDelta.length,
      externalRequests: trafficAfterValid.external.length
    };
  } catch (error) {
    scenarioFailure = error;
  } finally {
    await stopShopifyScenarioServer(child);
    childStopped = child.exitCode !== null || child.signalCode !== null;
  }

  let postFailure = scenarioFailure;
  let cleanupComplete = false;
  try {
    assertMetaCallbackPrivateMarkersAbsent(`${stdout}\n${stderr}`, privateMarkers, "stdout or stderr");
    const finalExternal = await shopifyScenarioExternalAttempts(requestLogPath);
    const finalMocks = await shopifyScenarioExternalAttempts(providerMockLogPath);
    if (finalExternal.length !== 0) throw new Error("Meta callback fixture recorded a non-loopback request");
    if (JSON.stringify(finalMocks.map(entry => entry.kind)) !== JSON.stringify(["meta-token-exchange-failure-mock"])) {
      throw new Error("Meta callback fixture recorded an unexpected provider mock sequence");
    }
    if (!childStopped) throw new Error("Meta callback fixture did not stop its child process");
    try {
      await access(workspaceLockPath);
      throw new Error("Meta callback fixture retained the workspace lock after shutdown");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (JSON.stringify(Object.entries(process.env)) !== parentBefore) {
      throw new Error("Meta callback fixture mutated the parent process environment");
    }
  } catch (error) {
    if (!postFailure) postFailure = error;
  } finally {
    await rm(scenarioDataDir, { recursive: true, force: true });
    try {
      await access(scenarioDataDir);
    } catch (error) {
      if (error?.code === "ENOENT") cleanupComplete = true;
      else if (!postFailure) postFailure = error;
    }
  }
  if (!cleanupComplete && !postFailure) postFailure = new Error("Meta callback fixture cleanup was incomplete");
  if (postFailure) throw postFailure;
  return { ...result, cleanupComplete };
}

async function runMetaCallbackAtomicPersistenceScenario() {
  const parentBefore = JSON.stringify(Object.entries(process.env));
  const scenarioPort = await availableLoopbackPort();
  const scenarioBaseUrl = `http://127.0.0.1:${scenarioPort}`;
  const scenarioDataDir = path.join(process.cwd(), ".tmp", `meta-callback-p24-${Date.now()}`);
  const modelPath = path.join(scenarioDataDir, "model.json");
  const requestLogPath = path.join(scenarioDataDir, "external-http-requests.ndjson");
  const providerMockLogPath = path.join(scenarioDataDir, "provider-mocks.ndjson");
  const workspaceLockPath = path.join(scenarioDataDir, ".workspace-content.lock");
  const ownerPassword = "p24-meta-callback-owner-password";
  const foreignPassword = "p24-meta-callback-foreign-password";
  const privateMarkers = [
    SYNTHETIC_META_ATOMIC_APP_SECRET,
    SYNTHETIC_META_ATOMIC_AUTH_SECRET,
    SYNTHETIC_META_ATOMIC_ENCRYPTION_KEY,
    SYNTHETIC_META_ATOMIC_FAILURE_CODE,
    SYNTHETIC_META_ATOMIC_SUCCESS_CODE,
    SYNTHETIC_META_ATOMIC_SHORT_TOKEN,
    SYNTHETIC_META_ATOMIC_USER_TOKEN,
    SYNTHETIC_META_ATOMIC_PAGE_TOKEN,
    ownerPassword,
    foreignPassword
  ];
  await mkdir(scenarioDataDir, { recursive: true });
  const childEnv = metaStartScenarioEnv({
    baseEnv: {
      ...process.env,
      ...Object.fromEntries(META_START_CREDENTIAL_ENV_NAMES.map((name, index) => [name, `p24-inherited-meta-${index}`])),
      MeTa_ApP_Id: "p24-inherited-mixed-case-id",
      mEtA_aPp_SeCrEt: "p24-inherited-mixed-case-secret"
    },
    overrides: {
      PORT: String(scenarioPort),
      HOST: "127.0.0.1",
      AUTH_PROVIDER: "alpha-local",
      SUPABASE_ENABLED: "false",
      SENTRY_DSN: "",
      PUBLIC_APP_URL: "https://socialcuesapp.com",
      META_PUBLIC_APP_URL: "https://socialcuesapp.com",
      META_APP_ID: SYNTHETIC_META_ATOMIC_APP_ID,
      META_APP_SECRET: SYNTHETIC_META_ATOMIC_APP_SECRET,
      AUTH_SESSION_SECRET: SYNTHETIC_META_ATOMIC_AUTH_SECRET,
      OAUTH_TOKEN_ENCRYPTION_KEY: SYNTHETIC_META_ATOMIC_ENCRYPTION_KEY,
      SOCIAL_CUES_DATA_DIR: scenarioDataDir,
      SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: requestLogPath,
      SOCIAL_CUES_TEST_PROVIDER_MOCK_LOG: providerMockLogPath,
      SOCIAL_CUES_TEST_MOCK_META_CALLBACK: "",
      SOCIAL_CUES_TEST_MOCK_META_ASSETS: "",
      SOCIAL_CUES_TEST_MOCK_META_CALLBACK_ATOMIC: "true",
      SOCIAL_CUES_TEST_META_ATOMIC_FAILURE_CODE: SYNTHETIC_META_ATOMIC_FAILURE_CODE,
      SOCIAL_CUES_TEST_META_ATOMIC_SUCCESS_CODE: SYNTHETIC_META_ATOMIC_SUCCESS_CODE,
      SOCIAL_CUES_TEST_META_ATOMIC_SHORT_TOKEN: SYNTHETIC_META_ATOMIC_SHORT_TOKEN,
      SOCIAL_CUES_TEST_META_ATOMIC_USER_TOKEN: SYNTHETIC_META_ATOMIC_USER_TOKEN,
      SOCIAL_CUES_TEST_META_ATOMIC_PAGE_TOKEN: SYNTHETIC_META_ATOMIC_PAGE_TOKEN,
      SOCIAL_CUES_TEST_META_ATOMIC_USER_ID: SYNTHETIC_META_ATOMIC_USER_ID,
      SOCIAL_CUES_TEST_META_ATOMIC_PAGE_ID: SYNTHETIC_META_ATOMIC_PAGE_ID,
      SOCIAL_CUES_TEST_META_ATOMIC_INSTAGRAM_ID: SYNTHETIC_META_ATOMIC_INSTAGRAM_ID,
      SOCIAL_CUES_PROMO_CODES: JSON.stringify([
        { code: SYNTHETIC_META_ATOMIC_OWNER_PROMO, label: "P24 Meta callback owner", days: 1, active: true },
        { code: SYNTHETIC_META_ATOMIC_FOREIGN_PROMO, label: "P24 Meta callback foreign", days: 1, active: true }
      ])
    }
  });
  const retainedCredentialNames = Object.keys(childEnv)
    .filter(name => META_START_CREDENTIAL_ENV_KEYS.has(name.toLowerCase()))
    .sort();
  if (JSON.stringify(retainedCredentialNames) !== JSON.stringify(["META_APP_ID", "META_APP_SECRET"])) {
    throw new Error("Meta callback atomic fixture retained inherited application credentials");
  }

  let stdout = "";
  let stderr = "";
  let result;
  let scenarioFailure;
  let child = null;
  const children = [];
  const publicBodies = [];
  const startScenarioServer = () => {
    const nextChild = spawn(process.execPath, [`--import=${pathToFileURL(externalRequestGuardPath).href}`, "server.mjs"], {
      cwd: new URL(".", import.meta.url),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    children.push(nextChild);
    nextChild.stdout.on("data", chunk => { stdout += chunk; });
    nextChild.stderr.on("data", chunk => { stderr += chunk; });
    return nextChild;
  };
  const stopScenarioServer = async scenarioChild => {
    if (!scenarioChild || scenarioChild.exitCode !== null || scenarioChild.signalCode !== null) return;
    await stopShopifyScenarioServer(scenarioChild);
  };
  const auth = token => ({ headers: { Authorization: `Bearer ${token}` } });
  const callbackAuth = token => ({ headers: { Cookie: `sc_session=${encodeURIComponent(token)}` } });
  const readDocument = async () => JSON.parse(await readFile(modelPath, "utf8"));
  const stateFromStart = response => {
    if (response.status !== 302 || !response.location) {
      throw new Error("Meta callback atomic fixture did not receive an OAuth redirect");
    }
    const location = new URL(response.location);
    const state = location.searchParams.get("state") || "";
    if (location.origin !== "https://www.facebook.com"
      || !/\/dialog\/oauth$/u.test(location.pathname)
      || location.searchParams.get("client_id") !== SYNTHETIC_META_ATOMIC_APP_ID
      || location.searchParams.get("redirect_uri") !== "https://socialcuesapp.com/api/oauth/meta/callback"
      || !state) {
      throw new Error("Meta callback atomic fixture start used the wrong provider, app id, callback, or state");
    }
    return state;
  };
  const assertRenewedOwnerSession = async (response, ownerToken, ownerUserId, ownerWorkspaceId, label) => {
    const cookie = String(response.headers["set-cookie"] || "");
    if (!cookie.startsWith(`sc_session=${encodeURIComponent(ownerToken)};`)
      || !/(?:^|;)\s*HttpOnly(?:;|$)/iu.test(cookie)) {
      throw new Error(`Meta callback atomic fixture did not renew the initiating session for ${label}`);
    }
    const sessionModel = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", callbackAuth(ownerToken));
    publicBodies.push(sessionModel.text);
    if (sessionModel.status !== 200
      || sessionModel.body?.workspace?.ownerUserId !== ownerUserId
      || sessionModel.body?.workspace?.id !== ownerWorkspaceId) {
      throw new Error(`Meta callback atomic fixture changed the validated owner session for ${label}`);
    }
  };
  const assertReplayRejectedWithoutEffects = async ({ route, ownerToken, state, label }) => {
    const beforeSource = await readFile(modelPath, "utf8");
    const beforeMocks = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const beforeExternal = await shopifyScenarioExternalAttempts(requestLogPath);
    const replay = await shopifyScenarioResponse(scenarioBaseUrl, route, callbackAuth(ownerToken));
    publicBodies.push(replay.text);
    const afterSource = await readFile(modelPath, "utf8");
    if (replay.status !== 400
      || !replay.text.includes("<h1>Meta OAuth state rejected</h1>")
      || !replay.text.includes(META_CALLBACK_UNISSUED_ERROR)
      || replay.headers["set-cookie"]
      || beforeSource !== afterSource
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(beforeMocks)
      || JSON.stringify(await shopifyScenarioExternalAttempts(requestLogPath)) !== JSON.stringify(beforeExternal)) {
      throw new Error(`Meta callback atomic fixture replay was not rejected before provider traffic for ${label}`);
    }
    assertMetaCallbackPrivateMarkersAbsent(replay.text, [state, ...privateMarkers], `${label} replay response`);
  };

  child = startScenarioServer();
  try {
    await waitForShopifyScenarioServer(child, scenarioBaseUrl, "P24 Meta callback atomic persistence");
    const signup = async ({ name, password, promoCode, workspaceName }) => shopifyScenarioResponse(
      scenarioBaseUrl,
      "/api/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email: `p24-meta-${name.toLowerCase()}-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`,
          password,
          promoCode,
          workspaceName
        })
      }
    );
    const ownerSignup = await signup({
      name: "Owner",
      password: ownerPassword,
      promoCode: SYNTHETIC_META_ATOMIC_OWNER_PROMO,
      workspaceName: "P24 Meta Owner Workspace"
    });
    const foreignSignup = await signup({
      name: "Foreign",
      password: foreignPassword,
      promoCode: SYNTHETIC_META_ATOMIC_FOREIGN_PROMO,
      workspaceName: "P24 Meta Foreign Workspace"
    });
    const ownerToken = ownerSignup.body?.session?.token || "";
    const ownerUserId = ownerSignup.body?.user?.id || "";
    const ownerWorkspaceId = ownerSignup.body?.workspace?.id || "";
    const foreignToken = foreignSignup.body?.session?.token || "";
    const foreignWorkspaceId = foreignSignup.body?.workspace?.id || "";
    privateMarkers.push(ownerToken, foreignToken);
    if (ownerSignup.status !== 200 || !ownerToken || !ownerUserId || !ownerWorkspaceId
      || foreignSignup.status !== 200 || !foreignToken || !foreignWorkspaceId
      || ownerWorkspaceId === foreignWorkspaceId) {
      throw new Error("Meta callback atomic fixture could not establish isolated owner workspaces");
    }
    const ownerAuth = auth(ownerToken);
    const foreignAuth = auth(foreignToken);

    const failedStart = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/meta/start?platform=facebook", ownerAuth);
    const failedState = stateFromStart(failedStart);
    privateMarkers.push(failedState);
    const beforeFailure = await readDocument();
    const beforeFailureAccounts = JSON.stringify(beforeFailure.workspaces?.[ownerWorkspaceId]?.content?.connectedAccounts || []);
    const beforeFailureForeign = JSON.stringify(beforeFailure.workspaces?.[foreignWorkspaceId]);
    const beforeFailureEventIds = new Set((beforeFailure.shared?.oauthEvents || []).map(event => event.id));
    const mocksBeforeFailure = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const failedCallback = await shopifyScenarioResponse(
      scenarioBaseUrl,
      `/api/oauth/meta/callback?code=${encodeURIComponent(SYNTHETIC_META_ATOMIC_FAILURE_CODE)}&state=${encodeURIComponent(failedState)}`,
      callbackAuth(ownerToken)
    );
    publicBodies.push(failedCallback.text);
    const afterFailure = await readDocument();
    const ownerAfterFailure = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    publicBodies.push(ownerAfterFailure.text);
    const failureMockDelta = (await shopifyScenarioExternalAttempts(providerMockLogPath)).slice(mocksBeforeFailure.length);
    const failureEvents = (afterFailure.shared?.oauthEvents || []).filter(event => !beforeFailureEventIds.has(event.id));
    if (failedCallback.status !== 200
      || !failedCallback.text.includes("Meta returned an authorization code")
      || !failedCallback.text.includes("Synthetic P24 Meta token exchange rejected.")
      || /workspace_shared_state_conflict|workspace_writer_unclassified/iu.test(failedCallback.text)
      || ownerAfterFailure.status !== 200
      || ownerAfterFailure.body?.workspace?.id !== ownerWorkspaceId
      || afterFailure.shared?.metaConnection?.status !== "oauth-code-only"
      || !String(ownerAfterFailure.body?.integrations?.meta || "").includes("Synthetic P24 Meta token exchange rejected.")
      || JSON.stringify(afterFailure.workspaces?.[ownerWorkspaceId]?.content?.connectedAccounts || []) !== beforeFailureAccounts
      || JSON.stringify(afterFailure.workspaces?.[foreignWorkspaceId]) !== beforeFailureForeign
      || (afterFailure.shared?.oauthStates || []).some(record => record.state === failedState)
      || failureEvents.filter(event => event.provider === "meta" && event.event === "token_exchange_result" && event.outcome === "failed").length !== 1
      || JSON.stringify(failureMockDelta.map(entry => entry.kind)) !== JSON.stringify(["meta-token-exchange-failure-mock-p24"])
      || failureMockDelta[0]?.method !== "GET"
      || failureMockDelta[0]?.clientIdMatches !== true
      || failureMockDelta[0]?.clientSecretMatches !== true
      || failureMockDelta[0]?.redirectMatches !== true
      || failureMockDelta[0]?.codeMatches !== true
      || failureMockDelta[0]?.grantTypeAbsent !== true) {
      throw new Error(`Meta callback atomic fixture did not commit one safe failed-exchange result: ${JSON.stringify({
        callbackStatus: failedCallback.status,
        callbackTitle: failedCallback.text.includes("Meta returned an authorization code"),
        callbackEvidence: failedCallback.text.includes("Synthetic P24 Meta token exchange rejected."),
        callbackConflictFree: !/workspace_shared_state_conflict|workspace_writer_unclassified/iu.test(failedCallback.text),
        ownerModelStatus: ownerAfterFailure.status,
        ownerWorkspaceMatches: ownerAfterFailure.body?.workspace?.id === ownerWorkspaceId,
        connectionStatus: afterFailure.shared?.metaConnection?.status || null,
        integrationEvidence: String(ownerAfterFailure.body?.integrations?.meta || "").includes("Synthetic P24 Meta token exchange rejected."),
        accountsUnchanged: JSON.stringify(afterFailure.workspaces?.[ownerWorkspaceId]?.content?.connectedAccounts || []) === beforeFailureAccounts,
        foreignWorkspaceUnchanged: JSON.stringify(afterFailure.workspaces?.[foreignWorkspaceId]) === beforeFailureForeign,
        stateConsumed: !(afterFailure.shared?.oauthStates || []).some(record => record.state === failedState),
        failedAuditCount: failureEvents.filter(event => event.provider === "meta" && event.event === "token_exchange_result" && event.outcome === "failed").length,
        mockKinds: failureMockDelta.map(entry => entry.kind),
        mockChecksPassed: failureMockDelta[0]?.method === "GET"
          && failureMockDelta[0]?.clientIdMatches === true
          && failureMockDelta[0]?.clientSecretMatches === true
          && failureMockDelta[0]?.redirectMatches === true
          && failureMockDelta[0]?.codeMatches === true
          && failureMockDelta[0]?.grantTypeAbsent === true
      })}`);
    }
    await assertRenewedOwnerSession(failedCallback, ownerToken, ownerUserId, ownerWorkspaceId, "failed exchange");
    await assertReplayRejectedWithoutEffects({
      route: `/api/oauth/meta/callback?code=${encodeURIComponent(SYNTHETIC_META_ATOMIC_FAILURE_CODE)}&state=${encodeURIComponent(failedState)}`,
      ownerToken,
      state: failedState,
      label: "failed exchange"
    });

    const successStart = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/meta/start?platform=facebook", ownerAuth);
    const successState = stateFromStart(successStart);
    privateMarkers.push(successState);
    const beforeSuccess = await readDocument();
    const beforeSuccessForeign = JSON.stringify(beforeSuccess.workspaces?.[foreignWorkspaceId]);
    const beforeSuccessEventIds = new Set((beforeSuccess.shared?.oauthEvents || []).map(event => event.id));
    const mocksBeforeSuccess = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const successCallback = await shopifyScenarioResponse(
      scenarioBaseUrl,
      `/api/oauth/meta/callback?code=${encodeURIComponent(SYNTHETIC_META_ATOMIC_SUCCESS_CODE)}&state=${encodeURIComponent(successState)}`,
      callbackAuth(ownerToken)
    );
    publicBodies.push(successCallback.text);
    const afterSuccess = await readDocument();
    const ownerAfterSuccess = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const foreignAfterSuccess = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    publicBodies.push(ownerAfterSuccess.text, foreignAfterSuccess.text);
    const successMockDelta = (await shopifyScenarioExternalAttempts(providerMockLogPath)).slice(mocksBeforeSuccess.length);
    const expectedSuccessMockKinds = [
      "meta-short-token-mock-p24",
      "meta-long-token-mock-p24",
      "meta-user-mock-p24",
      "meta-debug-token-mock-p24",
      "meta-permissions-mock-p24",
      "meta-accounts-mock-p24",
      "meta-businesses-mock-p24"
    ];
    const successAccounts = (ownerAfterSuccess.body?.connectedAccounts || []).filter(account => [
      SYNTHETIC_META_ATOMIC_USER_ID,
      SYNTHETIC_META_ATOMIC_PAGE_ID,
      SYNTHETIC_META_ATOMIC_INSTAGRAM_ID
    ].includes(String(account.providerAccountId || "")));
    const successEvents = (afterSuccess.shared?.oauthEvents || []).filter(event => !beforeSuccessEventIds.has(event.id));
    if (successCallback.status !== 200
      || !successCallback.text.includes("Meta connected")
      || !successCallback.text.includes("P24 Meta User")
      || !successCallback.text.includes("P24 Facebook Page")
      || !successCallback.text.includes("P24 Instagram")
      || /workspace_shared_state_conflict|workspace_writer_unclassified/iu.test(successCallback.text)
      || ownerAfterSuccess.status !== 200
      || ownerAfterSuccess.body?.workspace?.id !== ownerWorkspaceId
      || successAccounts.length !== 3
      || successAccounts.some(account => account.connected !== true || account.tokenStored !== true)
      || successAccounts.some(account => account.ownerUserId !== ownerUserId || account.workspaceId !== ownerWorkspaceId)
      || successAccounts.some(account => !metaAssetsPublicShapeIsSafe(account))
      || JSON.stringify(afterSuccess.workspaces?.[foreignWorkspaceId]) !== beforeSuccessForeign
      || (foreignAfterSuccess.body?.connectedAccounts || []).some(account => [
        SYNTHETIC_META_ATOMIC_USER_ID,
        SYNTHETIC_META_ATOMIC_PAGE_ID,
        SYNTHETIC_META_ATOMIC_INSTAGRAM_ID
      ].includes(String(account.providerAccountId || "")))
      || (afterSuccess.shared?.oauthStates || []).some(record => record.state === successState)
      || successEvents.filter(event => event.provider === "meta" && event.event === "token_exchange_result" && event.outcome === "stored").length !== 1
      || JSON.stringify(successMockDelta.map(entry => entry.kind)) !== JSON.stringify(expectedSuccessMockKinds)
      || successMockDelta.some(entry => Object.entries(entry)
        .filter(([key]) => key !== "kind" && key !== "method")
        .some(([, value]) => value !== true))) {
      throw new Error("Meta callback atomic fixture did not persist the exact owner-scoped success result");
    }
    await assertRenewedOwnerSession(successCallback, ownerToken, ownerUserId, ownerWorkspaceId, "successful exchange");
    await assertReplayRejectedWithoutEffects({
      route: `/api/oauth/meta/callback?code=${encodeURIComponent(SYNTHETIC_META_ATOMIC_SUCCESS_CODE)}&state=${encodeURIComponent(successState)}`,
      ownerToken,
      state: successState,
      label: "successful exchange"
    });

    const mocksBeforeSelection = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const selectedAssets = await shopifyScenarioResponse(scenarioBaseUrl, "/api/meta/assets", ownerAuth);
    publicBodies.push(selectedAssets.text);
    const selectionMockDelta = (await shopifyScenarioExternalAttempts(providerMockLogPath)).slice(mocksBeforeSelection.length);
    const ownerAfterSelection = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    publicBodies.push(ownerAfterSelection.text);
    const selectedAccounts = (ownerAfterSelection.body?.connectedAccounts || []).filter(account => [
      SYNTHETIC_META_ATOMIC_USER_ID,
      SYNTHETIC_META_ATOMIC_PAGE_ID,
      SYNTHETIC_META_ATOMIC_INSTAGRAM_ID
    ].includes(String(account.providerAccountId || "")));
    if (selectedAssets.status !== 200
      || selectedAssets.body?.ok !== true
      || selectedAssets.body?.selectedProviderAccounts?.facebook !== SYNTHETIC_META_ATOMIC_PAGE_ID
      || selectedAssets.body?.selectedProviderAccounts?.instagram !== SYNTHETIC_META_ATOMIC_INSTAGRAM_ID
      || selectedAccounts.length !== 3
      || JSON.stringify(selectionMockDelta.map(entry => entry.kind)) !== JSON.stringify([
        "meta-debug-token-mock-p24",
        "meta-permissions-mock-p24",
        "meta-accounts-mock-p24",
        "meta-businesses-mock-p24"
      ])
      || selectionMockDelta.some(entry => Object.entries(entry)
        .filter(([key]) => key !== "kind" && key !== "method")
        .some(([, value]) => value !== true))
      || !metaAssetsPublicShapeIsSafe(selectedAssets.body)) {
      throw new Error("Meta callback atomic fixture did not preserve selection and deduplication behavior");
    }

    await stopScenarioServer(child);
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error("Meta callback atomic fixture could not stop before restart verification");
    }
    try {
      await access(workspaceLockPath);
      throw new Error("Meta callback atomic fixture retained the workspace lock before restart");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    child = startScenarioServer();
    await waitForShopifyScenarioServer(child, scenarioBaseUrl, "P24 Meta callback restart");
    const restartedOwner = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const restartedForeign = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    const restartedSession = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", callbackAuth(ownerToken));
    publicBodies.push(restartedOwner.text, restartedForeign.text, restartedSession.text);
    const restartedAccounts = (restartedOwner.body?.connectedAccounts || []).filter(account => [
      SYNTHETIC_META_ATOMIC_USER_ID,
      SYNTHETIC_META_ATOMIC_PAGE_ID,
      SYNTHETIC_META_ATOMIC_INSTAGRAM_ID
    ].includes(String(account.providerAccountId || "")));
    if (restartedOwner.status !== 200
      || restartedOwner.body?.workspace?.id !== ownerWorkspaceId
      || restartedAccounts.length !== 3
      || restartedAccounts.some(account => account.connected !== true || account.tokenStored !== true)
      || (restartedForeign.body?.connectedAccounts || []).some(account => [
        SYNTHETIC_META_ATOMIC_USER_ID,
        SYNTHETIC_META_ATOMIC_PAGE_ID,
        SYNTHETIC_META_ATOMIC_INSTAGRAM_ID
      ].includes(String(account.providerAccountId || "")))
      || restartedSession.status !== 200
      || restartedSession.body?.workspace?.ownerUserId !== ownerUserId
      || restartedSession.body?.workspace?.id !== ownerWorkspaceId) {
      throw new Error("Meta callback atomic fixture did not preserve owner state and isolation across restart");
    }

    const rawModelSource = await readFile(modelPath, "utf8");
    const rawModel = JSON.parse(rawModelSource);
    const rawOwnerAccounts = rawModel.workspaces?.[ownerWorkspaceId]?.content?.connectedAccounts || [];
    const rawConnected = rawOwnerAccounts.filter(account => [
      SYNTHETIC_META_ATOMIC_USER_ID,
      SYNTHETIC_META_ATOMIC_PAGE_ID,
      SYNTHETIC_META_ATOMIC_INSTAGRAM_ID
    ].includes(String(account.providerAccountId || "")));
    const oauthResults = (rawModel.shared?.oauthEvents || []).filter(event => event.provider === "meta" && event.event === "token_exchange_result");
    if (rawConnected.length !== 3
      || rawConnected.some(account => account.ownerUserId !== ownerUserId || account.workspaceId !== ownerWorkspaceId)
      || rawConnected.some(account => account.credential?.alg !== "aes-256-gcm")
      || (rawModel.shared?.oauthStates || []).some(record => [failedState, successState].includes(record.state))
      || !oauthResults.some(event => event.outcome === "failed")
      || !oauthResults.some(event => event.outcome === "stored")) {
      throw new Error("Meta callback atomic fixture did not retain encrypted accounts and sanitized audit evidence");
    }
    assertMetaCallbackPrivateMarkersAbsent(rawModelSource, privateMarkers, "durable workspace and OAuth audit");
    const providerMocks = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const expectedMockKinds = [
      "meta-token-exchange-failure-mock-p24",
      ...expectedSuccessMockKinds,
      "meta-debug-token-mock-p24",
      "meta-permissions-mock-p24",
      "meta-accounts-mock-p24",
      "meta-businesses-mock-p24"
    ];
    if (JSON.stringify(providerMocks.map(entry => entry.kind)) !== JSON.stringify(expectedMockKinds)) {
      throw new Error("Meta callback atomic fixture recorded an unexpected provider mock sequence");
    }
    assertMetaCallbackPrivateMarkersAbsent(publicBodies, privateMarkers, "public response bodies");
    assertMetaCallbackPrivateMarkersAbsent(providerMocks, privateMarkers, "provider mock evidence");
    result = {
      failedExchangeCommitted: true,
      successfulExchangeCommitted: true,
      ownerSessionPreserved: true,
      stateConsumed: true,
      replayRejectedBeforeProvider: true,
      connectedAccounts: rawConnected.length,
      selectedAccountsPreserved: true,
      encryptedAtRest: true,
      foreignWorkspaceIsolated: true,
      restartPersistence: true,
      providerMockKinds: providerMocks.map(entry => entry.kind),
      mockedProviderRequests: providerMocks.length,
      externalRequests: 0
    };
  } catch (error) {
    scenarioFailure = error;
  } finally {
    for (const scenarioChild of children) {
      if (scenarioChild.exitCode === null && scenarioChild.signalCode === null) await stopScenarioServer(scenarioChild);
    }
  }

  let postFailure = scenarioFailure;
  let cleanupComplete = false;
  try {
    assertMetaCallbackPrivateMarkersAbsent(`${stdout}\n${stderr}`, [SYNTHETIC_META_ATOMIC_APP_ID, ...privateMarkers], "stdout or stderr");
    const finalExternal = await shopifyScenarioExternalAttempts(requestLogPath);
    if (finalExternal.length !== 0) throw new Error("Meta callback atomic fixture attempted a non-loopback request");
    if (!children.length || children.some(scenarioChild => scenarioChild.exitCode === null && scenarioChild.signalCode === null)) {
      throw new Error("Meta callback atomic fixture did not stop every child process");
    }
    try {
      await access(workspaceLockPath);
      throw new Error("Meta callback atomic fixture retained the workspace lock after shutdown");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (JSON.stringify(Object.entries(process.env)) !== parentBefore) {
      throw new Error("Meta callback atomic fixture mutated the parent process environment");
    }
  } catch (error) {
    if (!postFailure) postFailure = error;
  } finally {
    await rm(scenarioDataDir, { recursive: true, force: true });
    try {
      await access(scenarioDataDir);
    } catch (error) {
      if (error?.code === "ENOENT") cleanupComplete = true;
      else if (!postFailure) postFailure = error;
    }
  }
  if (!cleanupComplete && !postFailure) postFailure = new Error("Meta callback atomic fixture cleanup was incomplete");
  if (postFailure) throw postFailure;
  return { ...result, cleanupComplete };
}

async function runGoogleCallbackPersistenceScenario() {
  const parentBefore = JSON.stringify(Object.entries(process.env));
  const scenarioPort = await availableLoopbackPort();
  const scenarioBaseUrl = `http://127.0.0.1:${scenarioPort}`;
  const scenarioDataDir = path.join(process.cwd(), ".tmp", `google-callback-p20-${Date.now()}`);
  const providerMockLogPath = path.join(scenarioDataDir, "provider-mocks.ndjson");
  const workspaceLockPath = path.join(scenarioDataDir, ".workspace-content.lock");
  await mkdir(scenarioDataDir, { recursive: true });
  const childEnv = googleCallbackScenarioEnv({
    baseEnv: {
      ...process.env,
      ...Object.fromEntries(GOOGLE_CALLBACK_CREDENTIAL_ENV_NAMES.map((name, index) => [name, `inherited-google-${index}`])),
      GoOgLe_ClIeNt_Id: "inherited-google-mixed-case-id",
      gOoGlE_cLiEnT_sEcReT: "inherited-google-mixed-case-secret"
    },
    overrides: {
      PORT: String(scenarioPort),
      HOST: "127.0.0.1",
      AUTH_PROVIDER: "alpha-local",
      SUPABASE_ENABLED: "false",
      SENTRY_DSN: "",
      PUBLIC_APP_URL: "https://socialcuesapp.com",
      GOOGLE_PUBLIC_APP_URL: "https://socialcuesapp.com",
      SOCIAL_CUES_DATA_DIR: scenarioDataDir,
      SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: externalRequestLogPath,
      SOCIAL_CUES_TEST_PROVIDER_MOCK_LOG: providerMockLogPath,
      SOCIAL_CUES_TEST_MOCK_GOOGLE_CALLBACK: "true",
      SOCIAL_CUES_TEST_GOOGLE_FAILURE_CODE: SYNTHETIC_GOOGLE_FAILURE_CODE,
      SOCIAL_CUES_TEST_GOOGLE_BUSINESS_SUCCESS_CODE: SYNTHETIC_GOOGLE_BUSINESS_SUCCESS_CODE,
      SOCIAL_CUES_PROMO_CODES: JSON.stringify([
        { code: SYNTHETIC_GOOGLE_OWNER_PROMO_CODE, label: "P20 Google owner", days: 1, active: true },
        { code: SYNTHETIC_GOOGLE_FOREIGN_PROMO_CODE, label: "P20 Google foreign", days: 1, active: true }
      ]),
      AUTH_SESSION_SECRET: "p20-google-session-secret",
      OAUTH_TOKEN_ENCRYPTION_KEY: SYNTHETIC_GOOGLE_TOKEN_ENCRYPTION_KEY,
      GOOGLE_CLIENT_ID: SYNTHETIC_GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: SYNTHETIC_GOOGLE_CLIENT_SECRET
    }
  });
  const retainedCredentialNames = Object.keys(childEnv)
    .filter(name => GOOGLE_CALLBACK_CREDENTIAL_ENV_KEYS.has(name.toLowerCase()))
    .sort();
  if (JSON.stringify(retainedCredentialNames) !== JSON.stringify(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])) {
    throw new Error("Google callback fixture retained inherited application credentials");
  }

  let stdout = "";
  let stderr = "";
  let result;
  let scenarioFailure;
  let providerMocks = [];
  let externalAttemptsBefore = [];
  let childStopped = false;
  const children = [];
  const capturedResponses = [];
  const privateMarkers = [
    SYNTHETIC_GOOGLE_CLIENT_SECRET,
    SYNTHETIC_GOOGLE_ACCESS_TOKEN,
    SYNTHETIC_GOOGLE_REFRESH_TOKEN,
    SYNTHETIC_GOOGLE_FAILURE_CODE,
    SYNTHETIC_YOUTUBE_SUCCESS_CODE,
    SYNTHETIC_GOOGLE_BUSINESS_SUCCESS_CODE,
    SYNTHETIC_GOOGLE_TOKEN_ENCRYPTION_KEY
  ];
  const startScenarioServer = () => {
    const nextChild = spawn(process.execPath, [`--import=${pathToFileURL(externalRequestGuardPath).href}`, "server.mjs"], {
      cwd: new URL(".", import.meta.url),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    children.push(nextChild);
    nextChild.stdout.on("data", chunk => { stdout += chunk; });
    nextChild.stderr.on("data", chunk => { stderr += chunk; });
    return nextChild;
  };
  const stopScenarioServer = async scenarioChild => {
    if (scenarioChild.exitCode !== null || scenarioChild.signalCode !== null) return;
    await stopShopifyScenarioServer(scenarioChild);
  };
  const callbackOptions = token => ({ headers: { Cookie: `sc_session=${encodeURIComponent(token)}` } });
  const authenticatedOptions = token => ({ headers: { Authorization: `Bearer ${token}` } });
  const stateFromStart = response => {
    if (response.status !== 302 || !response.location) throw new Error("Google callback fixture did not receive an OAuth redirect");
    const location = new URL(response.location);
    const state = location.searchParams.get("state") || "";
    if (location.origin !== "https://accounts.google.com"
      || location.pathname !== "/o/oauth2/v2/auth"
      || location.searchParams.get("client_id") !== SYNTHETIC_GOOGLE_CLIENT_ID
      || location.searchParams.get("redirect_uri") !== "https://socialcuesapp.com/api/oauth/youtube/callback"
      || !state) {
      throw new Error("Google callback fixture OAuth start used the wrong provider, application id, callback, or state");
    }
    return { location, state };
  };
  let child = startScenarioServer();

  try {
    await waitForShopifyScenarioServer(child, scenarioBaseUrl, "P20 Google callback");
    externalAttemptsBefore = await shopifyScenarioExternalAttempts(externalRequestLogPath);
    const foreignSignup = await shopifyScenarioResponse(scenarioBaseUrl, "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "P20 Google Foreign",
        email: `p20-google-foreign-${Date.now()}@example.test`,
        password: "p20-google-foreign-password-2026",
        promoCode: SYNTHETIC_GOOGLE_FOREIGN_PROMO_CODE,
        workspaceName: "P20 Google Foreign Workspace"
      })
    });
    const ownerSignup = await shopifyScenarioResponse(scenarioBaseUrl, "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "P20 Google Owner",
        email: `p20-google-owner-${Date.now()}@example.test`,
        password: "p20-google-owner-password-2026",
        promoCode: SYNTHETIC_GOOGLE_OWNER_PROMO_CODE,
        workspaceName: "P20 Google Owner Workspace"
      })
    });
    if (foreignSignup.status !== 200 || !foreignSignup.body?.session?.token || !foreignSignup.body?.workspace?.id
      || ownerSignup.status !== 200 || !ownerSignup.body?.session?.token || !ownerSignup.body?.workspace?.id) {
      throw new Error("Google callback fixture could not create isolated authenticated workspaces");
    }
    const ownerToken = ownerSignup.body.session.token;
    const foreignToken = foreignSignup.body.session.token;
    const ownerUserId = ownerSignup.body.session.user?.id || ownerSignup.body.workspace.ownerUserId;
    const ownerWorkspaceId = ownerSignup.body.workspace.id;
    const ownerAuth = authenticatedOptions(ownerToken);
    const foreignAuth = authenticatedOptions(foreignToken);
    const modelBefore = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    capturedResponses.push(modelBefore);

    const failedStart = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/youtube/start", ownerAuth);
    const failedStartState = stateFromStart(failedStart).state;
    capturedResponses.push(failedStart);
    const tamperIndex = Math.max(1, Math.floor(failedStartState.length / 2));
    const tamperedState = `${failedStartState.slice(0, tamperIndex)}${failedStartState[tamperIndex] === "A" ? "B" : "A"}${failedStartState.slice(tamperIndex + 1)}`;
    const mocksBeforeTamper = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const tamperedCallback = await shopifyScenarioResponse(
      scenarioBaseUrl,
      `/api/oauth/youtube/callback?code=${encodeURIComponent(SYNTHETIC_GOOGLE_FAILURE_CODE)}&state=${encodeURIComponent(tamperedState)}`,
      callbackOptions(ownerToken)
    );
    if (tamperedCallback.status !== 400
      || !/YouTube OAuth state rejected/iu.test(tamperedCallback.text)
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(mocksBeforeTamper)) {
      throw new Error("Google callback fixture did not reject tampered state before provider exchange");
    }

    const failedCallback = await shopifyScenarioResponse(
      scenarioBaseUrl,
      `/api/oauth/youtube/callback?code=${encodeURIComponent(SYNTHETIC_GOOGLE_FAILURE_CODE)}&state=${encodeURIComponent(failedStartState)}`,
      callbackOptions(ownerToken)
    );
    const modelAfterFailure = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const failureAccount = modelAfterFailure.body?.connectedAccounts?.find(account => account.platform === "youtube");
    const failedCookie = failedCallback.headers["set-cookie"] || "";
    capturedResponses.push(tamperedCallback, failedCallback, modelAfterFailure);
    if (failedCallback.status !== 200
      || !/YouTube token exchange failed: Synthetic Google token exchange rejected\./iu.test(failedCallback.text)
      || modelAfterFailure.status !== 200
      || modelAfterFailure.body?.workspace?.id !== ownerWorkspaceId
      || failureAccount?.connected === true
      || failureAccount?.tokenStored === true
      || !String(modelAfterFailure.body?.integrations?.youtube || "").includes("Synthetic Google token exchange rejected.")
      || JSON.stringify(modelBefore.body?.persistence?.revision) === JSON.stringify(modelAfterFailure.body?.persistence?.revision)
      || !failedCookie.startsWith(`sc_session=${encodeURIComponent(ownerToken)};`)
      || !/(?:^|;)\s*HttpOnly(?:;|$)/iu.test(failedCookie)) {
      throw new Error("Google callback fixture did not atomically persist its owner-scoped failure and renew the existing session");
    }
    const mocksBeforeFailureReplay = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const failedReplay = await shopifyScenarioResponse(
      scenarioBaseUrl,
      `/api/oauth/youtube/callback?code=${encodeURIComponent(SYNTHETIC_GOOGLE_FAILURE_CODE)}&state=${encodeURIComponent(failedStartState)}`,
      callbackOptions(ownerToken)
    );
    if (failedReplay.status !== 400
      || !/already used/iu.test(failedReplay.text)
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(mocksBeforeFailureReplay)) {
      throw new Error("Google callback fixture allowed a consumed failed state to reach provider exchange again");
    }

    const youtubeStart = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/youtube/start", ownerAuth);
    const youtubeStartResult = stateFromStart(youtubeStart);
    capturedResponses.push(youtubeStart);
    if (!youtubeStartResult.location.searchParams.get("scope")?.includes("youtube.upload")) {
      throw new Error("Google callback fixture YouTube start omitted the upload/read scope contract");
    }
    const youtubeCallback = await shopifyScenarioResponse(
      scenarioBaseUrl,
      `/api/oauth/youtube/callback?code=${encodeURIComponent(SYNTHETIC_YOUTUBE_SUCCESS_CODE)}&state=${encodeURIComponent(youtubeStartResult.state)}`,
      callbackOptions(ownerToken)
    );
    const modelAfterYoutube = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const youtubeAccount = modelAfterYoutube.body?.connectedAccounts?.find(account => account.platform === "youtube" && account.providerAccountId === "test-p20-youtube-channel");
    const youtubeCookie = youtubeCallback.headers["set-cookie"] || "";
    capturedResponses.push(failedReplay, youtubeCallback, modelAfterYoutube);
    if (youtubeCallback.status !== 200) throw new Error("Google callback fixture YouTube success did not return 200");
    if (!/P20 YouTube Channel connected and selected for YouTube/iu.test(youtubeCallback.text)) throw new Error("Google callback fixture YouTube success response was not truthful");
    if (!youtubeAccount?.connected || !youtubeAccount?.tokenStored) throw new Error("Google callback fixture YouTube account was not connected with a stored token");
    if (youtubeAccount.ownerUserId !== ownerUserId || youtubeAccount.workspaceId !== ownerWorkspaceId) throw new Error("Google callback fixture YouTube account was not bound to the initiating owner workspace");
    if (containsGoogleCallbackCredentialField(youtubeAccount)) throw new Error("Google callback fixture YouTube public account exposed a credential field");
    if (!youtubeCookie.startsWith(`sc_session=${encodeURIComponent(ownerToken)};`) || !/(?:^|;)\s*HttpOnly(?:;|$)/iu.test(youtubeCookie)) {
      throw new Error("Google callback fixture YouTube success did not renew the existing HttpOnly session");
    }
    const mocksBeforeYoutubeReplay = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const youtubeReplay = await shopifyScenarioResponse(
      scenarioBaseUrl,
      `/api/oauth/youtube/callback?code=${encodeURIComponent(SYNTHETIC_YOUTUBE_SUCCESS_CODE)}&state=${encodeURIComponent(youtubeStartResult.state)}`,
      callbackOptions(ownerToken)
    );
    if (youtubeReplay.status !== 400
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(mocksBeforeYoutubeReplay)) {
      throw new Error("Google callback fixture allowed a consumed YouTube state to reach provider exchange again");
    }

    const businessStart = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/youtube/start?service=business", ownerAuth);
    const businessStartResult = stateFromStart(businessStart);
    capturedResponses.push(businessStart);
    if (businessStartResult.location.searchParams.get("scope") !== "https://www.googleapis.com/auth/business.manage") {
      throw new Error("Google callback fixture Business start used the wrong scope contract");
    }
    const businessCallback = await shopifyScenarioResponse(
      scenarioBaseUrl,
      `/api/oauth/youtube/callback?code=${encodeURIComponent(SYNTHETIC_GOOGLE_BUSINESS_SUCCESS_CODE)}&state=${encodeURIComponent(businessStartResult.state)}`,
      callbackOptions(ownerToken)
    );
    const modelAfterBusiness = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const businessAuthAccount = modelAfterBusiness.body?.connectedAccounts?.find(account => account.platform === "google_business_auth");
    const businessLocation = modelAfterBusiness.body?.connectedAccounts?.find(account => account.platform === "google_business" && account.providerAccountId === "locations/p20-location-1");
    const businessCookie = businessCallback.headers["set-cookie"] || "";
    capturedResponses.push(youtubeReplay, businessCallback, modelAfterBusiness);
    if (businessCallback.status !== 200
      || !/1 Google Business Profile location discovered/iu.test(businessCallback.text)
      || !businessAuthAccount?.connected
      || !businessAuthAccount?.tokenStored
      || !businessLocation?.connected
      || !businessLocation?.tokenStored
      || [businessAuthAccount, businessLocation].some(account => account.ownerUserId !== ownerUserId || account.workspaceId !== ownerWorkspaceId)
      || [businessAuthAccount, businessLocation].some(containsGoogleCallbackCredentialField)
      || !businessCookie.startsWith(`sc_session=${encodeURIComponent(ownerToken)};`)
      || !/(?:^|;)\s*HttpOnly(?:;|$)/iu.test(businessCookie)) {
      throw new Error("Google callback fixture did not atomically persist the owner-scoped Business authorization and location");
    }

    const foreignModel = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    capturedResponses.push(foreignModel);
    if (foreignModel.status !== 200
      || foreignModel.body?.workspace?.id !== foreignSignup.body.workspace.id
      || (foreignModel.body?.connectedAccounts || []).some(account => ["youtube", "google_business", "google_business_auth"].includes(account.platform))) {
      throw new Error("Google callback fixture exposed owner provider state to another workspace");
    }

    providerMocks = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const expectedMockKinds = [
      "google-token-mock",
      "google-token-mock",
      "youtube-channels-mock",
      "google-token-mock",
      "google-business-accounts-mock",
      "google-business-locations-mock"
    ];
    if (JSON.stringify(providerMocks.map(entry => entry.kind)) !== JSON.stringify(expectedMockKinds)
      || providerMocks[0]?.outcome !== "failed"
      || providerMocks.slice(0, 4).filter(entry => entry.kind === "google-token-mock").some(entry => !entry.clientIdMatches || !entry.clientSecretMatches || !entry.redirectMatches || entry.grantType !== "authorization_code")
      || providerMocks.filter(entry => entry.kind !== "google-token-mock").some(entry => entry.bearerPresent !== true)) {
      throw new Error("Google callback fixture escaped or violated its hermetic provider exchange contract");
    }

    await stopScenarioServer(child);
    if (child.exitCode === null && child.signalCode === null) throw new Error("Google callback fixture could not stop before restart verification");
    try {
      await access(workspaceLockPath);
      throw new Error("Google callback fixture retained the workspace lock after shutdown");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    child = startScenarioServer();
    await waitForShopifyScenarioServer(child, scenarioBaseUrl, "P20 Google callback restart");
    const restartedOwnerModel = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", ownerAuth);
    const restartedForeignModel = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignAuth);
    capturedResponses.push(restartedOwnerModel, restartedForeignModel);
    const restartedYoutube = restartedOwnerModel.body?.connectedAccounts?.find(account => account.platform === "youtube" && account.providerAccountId === "test-p20-youtube-channel");
    const restartedBusiness = restartedOwnerModel.body?.connectedAccounts?.find(account => account.platform === "google_business" && account.providerAccountId === "locations/p20-location-1");
    if (!restartedYoutube?.connected || !restartedYoutube?.tokenStored
      || !restartedBusiness?.connected || !restartedBusiness?.tokenStored
      || (restartedForeignModel.body?.connectedAccounts || []).some(account => ["youtube", "google_business", "google_business_auth"].includes(account.platform))
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(providerMocks)) {
      throw new Error("Google callback fixture did not preserve owner state and workspace isolation across restart");
    }

    const rawModelSource = await readFile(path.join(scenarioDataDir, "model.json"), "utf8");
    const rawModel = JSON.parse(rawModelSource);
    const rawAccounts = rawModel.workspaces?.[ownerWorkspaceId]?.content?.connectedAccounts || [];
    const rawTokenAccounts = rawAccounts.filter(account => ["youtube", "google_business", "google_business_auth"].includes(account.platform) && account.status === "connected");
    const oauthResults = (rawModel.shared?.oauthEvents || []).filter(event => event.provider === "youtube" && event.event === "token_exchange_result");
    const rawForbiddenMarkers = [
      ...privateMarkers,
      ownerToken,
      foreignToken,
      failedStartState,
      tamperedState,
      youtubeStartResult.state,
      businessStartResult.state
    ];
    if (rawTokenAccounts.length < 3
      || rawTokenAccounts.some(account => account.credential?.alg !== "aes-256-gcm")
      || rawForbiddenMarkers.some(marker => marker && rawModelSource.includes(marker))
      || !oauthResults.some(event => event.platform === "youtube" && event.outcome === "failed")
      || !oauthResults.some(event => event.platform === "youtube" && event.outcome === "stored")
      || !oauthResults.some(event => event.platform === "google_business" && event.outcome === "stored")
      || (rawModel.shared?.oauthStates || []).some(entry => entry.provider === "youtube")) {
      throw new Error("Google callback fixture did not persist encrypted credentials and consumed OAuth audit state atomically");
    }

    assertGoogleCallbackSecretsAbsent(capturedResponses, privateMarkers, "public responses");
    assertGoogleCallbackSecretsAbsent(providerMocks, privateMarkers, "provider mock audit");
    if (capturedResponses.some(response => containsGoogleCallbackCredentialField(response.body))) {
      throw new Error("Google callback fixture exposed a credential-shaped public response field");
    }
    result = {
      tamperedStateRejected: true,
      failedExchangeCommitted: true,
      replayRejectedBeforeProvider: true,
      youtubeConnected: true,
      googleBusinessConnected: true,
      ownerSessionPreserved: true,
      ownerWorkspaceBound: true,
      foreignWorkspaceIsolated: true,
      encryptedAtRest: true,
      restartPersistence: true,
      providerMockKinds: providerMocks.map(entry => entry.kind),
      mockedProviderRequests: providerMocks.length,
      externalRequests: 0
    };
  } catch (error) {
    scenarioFailure = error;
  } finally {
    for (const scenarioChild of children) {
      if (scenarioChild.exitCode === null && scenarioChild.signalCode === null) await stopScenarioServer(scenarioChild);
    }
    childStopped = children.every(scenarioChild => scenarioChild.exitCode !== null || scenarioChild.signalCode !== null);
  }

  let postFailure = scenarioFailure;
  let cleanupComplete = false;
  try {
    assertGoogleCallbackSecretsAbsent(`${stdout}\n${stderr}`, [SYNTHETIC_GOOGLE_CLIENT_ID, ...privateMarkers], "stdout or stderr");
    const externalAttemptsAfter = await shopifyScenarioExternalAttempts(externalRequestLogPath);
    if (JSON.stringify(externalAttemptsAfter) !== JSON.stringify(externalAttemptsBefore)) {
      throw new Error("Google callback fixture attempted an external provider request");
    }
    if (!childStopped) throw new Error("Google callback fixture did not stop every child process");
    try {
      await access(workspaceLockPath);
      throw new Error("Google callback fixture retained the workspace lock after final shutdown");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (JSON.stringify(Object.entries(process.env)) !== parentBefore) throw new Error("Google callback fixture mutated the parent process environment");
  } catch (error) {
    if (!postFailure) postFailure = error;
  } finally {
    await rm(scenarioDataDir, { recursive: true, force: true });
    try {
      await access(scenarioDataDir);
    } catch (error) {
      if (error?.code === "ENOENT") cleanupComplete = true;
      else if (!postFailure) postFailure = error;
    }
  }
  if (!cleanupComplete && !postFailure) postFailure = new Error("Google callback fixture cleanup was incomplete");
  if (postFailure) throw postFailure;
  return { ...result, cleanupComplete };
}

async function runTwitchPortalCredentialScenario() {
  const parentBefore = JSON.stringify(Object.entries(process.env));
  assertTwitchScenarioEnvironmentHelper();
  const committedServerSource = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  assertCommittedTwitchCredentialContract(committedServerSource);

  const scenarioPort = await availableLoopbackPort();
  const scenarioBaseUrl = `http://127.0.0.1:${scenarioPort}`;
  const scenarioDataDir = path.join(process.cwd(), ".tmp", `twitch-portal-credential-${Date.now()}`);
  const requestLogPath = path.join(scenarioDataDir, "external-http-requests.ndjson");
  const providerMockLogPath = path.join(scenarioDataDir, "provider-mocks.ndjson");
  await mkdir(scenarioDataDir, { recursive: true });
  const childEnv = twitchScenarioEnv({
    overrides: {
      PORT: String(scenarioPort),
      HOST: "127.0.0.1",
      AUTH_PROVIDER: "alpha-local",
      SUPABASE_ENABLED: "false",
      SENTRY_DSN: "",
      PUBLIC_APP_URL: "https://socialcuesapp.com",
      TWITCH_PUBLIC_APP_URL: "https://socialcuesapp.com",
      SOCIAL_CUES_DATA_DIR: scenarioDataDir,
      SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: requestLogPath,
      SOCIAL_CUES_TEST_PROVIDER_MOCK_LOG: providerMockLogPath,
      SOCIAL_CUES_TEST_MOCK_TWITCH_CALLBACK: "true",
      SOCIAL_CUES_PROMO_CODES: JSON.stringify([
        { code: SYNTHETIC_TWITCH_PROMO_CODE, label: "Twitch portal fixture", days: 1, active: true },
        { code: SYNTHETIC_TWITCH_SECOND_PROMO_CODE, label: "Twitch foreign-workspace fixture", days: 1, active: true }
      ]),
      OAUTH_TOKEN_ENCRYPTION_KEY: SYNTHETIC_TWITCH_TOKEN_ENCRYPTION_KEY,
      WORKER_SECRET: "twitch-portal-fixture-worker-secret",
      TWITCH_APP_ID: SYNTHETIC_TWITCH_APP_ID,
      TWITCH_APP_SECRET: SYNTHETIC_TWITCH_APP_SECRET
    }
  });
  const retainedCredentialNames = Object.keys(childEnv)
    .filter(name => TWITCH_APPLICATION_CREDENTIAL_ENV_KEYS.has(name.toLowerCase()))
    .sort();
  if (JSON.stringify(retainedCredentialNames) !== JSON.stringify(["TWITCH_APP_ID", "TWITCH_APP_SECRET"])) {
    throw new Error("twitch portal credential scenario retained inherited application credentials");
  }

  let stdout = "";
  let stderr = "";
  let result;
  let scenarioFailure;
  let childStopped = false;
  const children = [];
  const startScenarioServer = () => {
    const nextChild = spawn(process.execPath, [`--import=${pathToFileURL(externalRequestGuardPath).href}`, "server.mjs"], {
      cwd: new URL(".", import.meta.url),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    children.push(nextChild);
    nextChild.stdout.on("data", chunk => { stdout += chunk; });
    nextChild.stderr.on("data", chunk => { stderr += chunk; });
    return nextChild;
  };
  const stopScenarioServer = async scenarioChild => {
    if (scenarioChild.exitCode !== null || scenarioChild.signalCode !== null) return;
    let exited = false;
    const exit = new Promise(resolve => scenarioChild.once("exit", () => {
      exited = true;
      resolve();
    }));
    if (scenarioChild.connected) scenarioChild.send({ type: "social-cues-local-shutdown" });
    else scenarioChild.kill();
    await Promise.race([exit, delay(3000)]);
    if (!exited && scenarioChild.exitCode === null && scenarioChild.signalCode === null) {
      await stopShopifyScenarioServer(scenarioChild);
    }
  };
  let child = startScenarioServer();

  try {
    await waitForTwitchScenarioServer(child, scenarioBaseUrl);
    const globalPortal = await shopifyScenarioResponse(scenarioBaseUrl, "/api/dev-portal/audit");
    const globalPortalRow = globalPortal.body?.rows?.find(row => row.id === "twitch");
    if (globalPortal.status !== 200
      || globalPortal.body?.ok !== true
      || !globalPortalRow
      || globalPortalRow.workspaceContext !== false
      || /^(?:Connect|Reconnect) Twitch\b/iu.test(globalPortalRow.nextAction || "")) {
      throw new Error("global Twitch portal audit claimed workspace connection state");
    }

    const foreignSignup = await shopifyScenarioResponse(scenarioBaseUrl, "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Twitch Foreign Workspace Fixture",
        email: `twitch-portal-foreign-${Date.now()}@example.test`,
        password: "twitch-portal-foreign-password-2026",
        promoCode: SYNTHETIC_TWITCH_SECOND_PROMO_CODE,
        workspaceName: "Twitch Foreign Workspace"
      })
    });
    if (foreignSignup.status !== 200 || !foreignSignup.body?.session?.token || !foreignSignup.body?.workspace?.id) {
      throw new Error("Twitch portal fixture could not create its foreign workspace control");
    }

    const signup = await shopifyScenarioResponse(scenarioBaseUrl, "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Twitch Portal Fixture",
        email: `twitch-portal-${Date.now()}@example.test`,
        password: "twitch-portal-fixture-password-2026",
        promoCode: SYNTHETIC_TWITCH_PROMO_CODE,
        workspaceName: "Twitch Portal Fixture Workspace"
      })
    });
    if (signup.status !== 200 || signup.body?.ok !== true || !signup.body?.session?.token || !signup.body?.workspace?.id) {
      throw new Error("Twitch portal fixture could not create its authenticated workspace");
    }
    const authenticatedOptions = { headers: { Authorization: `Bearer ${signup.body.session.token}` } };
    const modelBefore = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", authenticatedOptions);
    if (modelBefore.status !== 200
      || modelBefore.body?.workspace?.id !== signup.body.workspace.id
      || (modelBefore.body?.connectedAccounts || []).some(account => account.platform === "twitch")) {
      throw new Error("Twitch portal fixture did not begin with a blank owned workspace");
    }

    const status = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/twitch/status", authenticatedOptions);
    const readiness = await shopifyScenarioResponse(scenarioBaseUrl, "/api/twitch/readiness", authenticatedOptions);
    const integrations = await shopifyScenarioResponse(scenarioBaseUrl, "/api/integrations/readiness", authenticatedOptions);
    const portalAudit = await shopifyScenarioResponse(scenarioBaseUrl, "/api/dev-portal/audit", authenticatedOptions);
    const providerTruth = await shopifyScenarioResponse(scenarioBaseUrl, "/api/provider/truth", authenticatedOptions);
    const providerContracts = await shopifyScenarioResponse(scenarioBaseUrl, "/api/provider/contracts", authenticatedOptions);
    const ownershipQueue = await shopifyScenarioResponse(scenarioBaseUrl, "/api/provider/ownership-queue", authenticatedOptions);
    const providerService = integrations.body?.providerServices?.find(row => row.id === "twitch");
    const portalRow = portalAudit.body?.rows?.find(row => row.id === "twitch");
    const truthRow = providerTruth.body?.rows?.find(row => row.id === "twitch");
    const contractRow = providerContracts.body?.rows?.find(row => row.id === "twitch");
    const ownershipRow = ownershipQueue.body?.rows?.find(row => row.id === "twitch");
    const contractResponsesBefore = [status, readiness, integrations, portalAudit, providerTruth, providerContracts, ownershipQueue];

    if (contractResponsesBefore.some(response => response.status !== 200 || response.body?.ok !== true)) {
      throw new Error("twitch configured-alias scenario could not read every local contract surface");
    }
    if (!providerService || !portalRow || !truthRow || !contractRow || !ownershipRow) throw new Error("twitch configured-alias scenario omitted a contract row");
    if (JSON.stringify(status.body.acceptedEnv?.TWITCH_CLIENT_ID) !== JSON.stringify(TWITCH_CLIENT_ID_ENV_NAMES)
      || JSON.stringify(status.body.acceptedEnv?.TWITCH_CLIENT_SECRET) !== JSON.stringify(TWITCH_CLIENT_SECRET_ENV_NAMES)
      || JSON.stringify(providerService.acceptedEnv?.TWITCH_CLIENT_ID) !== JSON.stringify(TWITCH_CLIENT_ID_ENV_NAMES)
      || JSON.stringify(providerService.acceptedEnv?.TWITCH_CLIENT_SECRET) !== JSON.stringify(TWITCH_CLIENT_SECRET_ENV_NAMES)) {
      throw new Error("twitch configured-alias scenario observed an unexpected accepted environment inventory");
    }
    if (status.body.credentialSources?.clientId !== "TWITCH_APP_ID"
      || status.body.credentialSources?.clientSecret !== "TWITCH_APP_SECRET"
      || status.body.configured !== true
      || status.body.clientIdPresent !== true
      || status.body.clientSecretPresent !== true
      || status.body.secureOAuthReady !== true
      || (status.body.missingEnv || []).length !== 0
      || readiness.body.configured !== true
      || readiness.body.ready !== false
      || readiness.body.connected !== false
      || (readiness.body.missingEnv || []).length !== 0
      || providerService.configured !== true
      || truthRow.configured !== true
      || truthRow.connected !== false
      || contractRow.gates?.envReady !== true
      || contractRow.gates?.oauthConnected !== false
      || contractRow.owned !== false
      || ownershipRow.executable !== false) {
      throw new Error("twitch configured-alias scenario returned inconsistent readiness or workspace state");
    }
    const connectFixture = {
      expectedDecision: "connect",
      authenticated: true,
      workspaceContext: portalRow.workspaceContext,
      workspaceIdMatches: modelBefore.body.workspace.id === signup.body.workspace.id,
      foreignMetadataPresent: false,
      configured: status.body.configured,
      readinessConfigured: readiness.body.configured,
      envReady: contractRow.gates?.envReady,
      missingEnv: status.body.missingEnv,
      accountPresent: portalRow.accountPresent,
      connected: portalRow.connected,
      banked: portalRow.banked,
      portal: portalRow,
      executable: Boolean(contractRow.owned),
      proofRunnable: Boolean(ownershipRow.executable),
      requiredProviderGatesMissing: Boolean(contractRow.missing?.length),
      externalRequests: 0,
      publicPayload: { portal: portalRow }
    };
    if (!twitchPortalIntegrationStateIsTruthful(connectFixture)) {
      throw new Error("Twitch portal audit did not recommend Connect for the authenticated no-account workspace");
    }

    const genericStart = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/connect-url?provider=twitch", authenticatedOptions);
    const directStart = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/twitch/start", authenticatedOptions);
    if (genericStart.status !== 200 || !genericStart.body?.url || directStart.status !== 302 || !directStart.location) {
      throw new Error("generic and direct Twitch OAuth starts did not both accept the complete alias pair");
    }
    const genericLocation = new URL(genericStart.body.url);
    const directLocation = new URL(directStart.location);
    for (const [label, location] of [["generic", genericLocation], ["direct", directLocation]]) {
      if (location.origin !== "https://id.twitch.tv"
        || location.searchParams.get("client_id") !== SYNTHETIC_TWITCH_APP_ID
        || location.searchParams.get("redirect_uri") !== "https://socialcuesapp.com/api/oauth/twitch/callback"
        || !location.searchParams.get("state")) {
        throw new Error(`${label} Twitch OAuth start resolved a different application id, callback, or state`);
      }
    }
    if ((await shopifyScenarioExternalAttempts(providerMockLogPath)).length !== 0) {
      throw new Error("Twitch OAuth start reached a provider-shaped mock before callback");
    }

    const callbackState = genericLocation.searchParams.get("state");
    const tamperedState = `${callbackState.slice(0, -1)}${callbackState.endsWith("A") ? "B" : "A"}`;
    const providerMocksBeforeRejectedState = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const rejectedCallback = await shopifyScenarioResponse(
      scenarioBaseUrl,
      `/api/oauth/twitch/callback?code=${encodeURIComponent(SYNTHETIC_TWITCH_CALLBACK_CODE)}&state=${encodeURIComponent(tamperedState)}`,
      authenticatedOptions
    );
    const modelAfterRejectedState = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", authenticatedOptions);
    if (rejectedCallback.status !== 400
      || !/Twitch OAuth state rejected/iu.test(rejectedCallback.text)
      || modelAfterRejectedState.status !== 200
      || modelAfterRejectedState.body?.workspace?.id !== signup.body.workspace.id
      || (modelAfterRejectedState.body?.connectedAccounts || []).some(account => account.platform === "twitch")
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(providerMocksBeforeRejectedState)) {
      throw new Error("Twitch portal fixture did not reject a tampered callback state before provider exchange or persistence");
    }

    const callback = await shopifyScenarioResponse(
      scenarioBaseUrl,
      `/api/oauth/twitch/callback?code=${encodeURIComponent(SYNTHETIC_TWITCH_CALLBACK_CODE)}&state=${encodeURIComponent(callbackState)}`,
      authenticatedOptions
    );
    if (callback.status !== 200 || !/Twitch connected and token stored/iu.test(callback.text)) {
      throw new Error("Twitch portal fixture callback did not store the synthetic workspace connection");
    }

    const statusAfter = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/twitch/status", authenticatedOptions);
    const readinessAfter = await shopifyScenarioResponse(scenarioBaseUrl, "/api/twitch/readiness", authenticatedOptions);
    const portalAfter = await shopifyScenarioResponse(scenarioBaseUrl, "/api/dev-portal/audit", authenticatedOptions);
    const truthAfter = await shopifyScenarioResponse(scenarioBaseUrl, "/api/provider/truth", authenticatedOptions);
    const contractsAfter = await shopifyScenarioResponse(scenarioBaseUrl, "/api/provider/contracts", authenticatedOptions);
    const ownershipAfter = await shopifyScenarioResponse(scenarioBaseUrl, "/api/provider/ownership-queue", authenticatedOptions);
    const modelAfter = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", authenticatedOptions);
    const portalAfterRow = portalAfter.body?.rows?.find(row => row.id === "twitch");
    const truthAfterRow = truthAfter.body?.rows?.find(row => row.id === "twitch");
    const contractAfterRow = contractsAfter.body?.rows?.find(row => row.id === "twitch");
    const ownershipAfterRow = ownershipAfter.body?.rows?.find(row => row.id === "twitch");
    const publicAccount = modelAfter.body?.connectedAccounts?.find(account => account.platform === "twitch");
    const bankedFixture = {
      expectedDecision: "developer-approval",
      authenticated: true,
      workspaceContext: portalAfterRow?.workspaceContext,
      workspaceIdMatches: publicAccount?.workspaceId === signup.body.workspace.id,
      foreignMetadataPresent: false,
      configured: statusAfter.body?.configured,
      readinessConfigured: readinessAfter.body?.configured,
      envReady: contractAfterRow?.gates?.envReady,
      missingEnv: statusAfter.body?.missingEnv,
      accountPresent: portalAfterRow?.accountPresent,
      connected: portalAfterRow?.connected,
      banked: portalAfterRow?.banked,
      portal: portalAfterRow,
      executable: Boolean(contractAfterRow?.owned),
      proofRunnable: Boolean(ownershipAfterRow?.executable),
      requiredProviderGatesMissing: Boolean(contractAfterRow?.missing?.length),
      externalRequests: 0,
      publicPayload: { portal: portalAfterRow, account: publicAccount }
    };
    if (statusAfter.status !== 200
      || readinessAfter.status !== 200
      || portalAfter.status !== 200
      || truthAfter.status !== 200
      || contractsAfter.status !== 200
      || ownershipAfter.status !== 200
      || modelAfter.status !== 200
      || statusAfter.body?.connected !== true
      || readinessAfter.body?.connected !== true
      || truthAfterRow?.connected !== true
      || truthAfterRow?.tokenStored !== true
      || contractAfterRow?.gates?.oauthConnected !== true
      || contractAfterRow?.owned !== false
      || ownershipAfterRow?.executable !== true
      || !publicAccount?.connected
      || !publicAccount?.tokenStored
      || ["credential", "refreshCredential", "token", "accessToken", "refreshToken", "encryptedCredential"].some(name => Object.prototype.hasOwnProperty.call(publicAccount, name))
      || !twitchPortalIntegrationStateIsTruthful(bankedFixture)) {
      throw new Error("Twitch callback did not advance the workspace portal audit to the next truthful provider gate");
    }

    const foreignOptions = { headers: { Authorization: `Bearer ${foreignSignup.body.session.token}` } };
    const foreignModel = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignOptions);
    const forgedPortal = await shopifyScenarioResponse(
      scenarioBaseUrl,
      `/api/dev-portal/audit?workspaceId=${encodeURIComponent(signup.body.workspace.id)}&providerAccountId=123456789`,
      foreignOptions
    );
    const primaryTruthAfterForeign = await shopifyScenarioResponse(scenarioBaseUrl, "/api/provider/truth", authenticatedOptions);
    const forgedPortalRow = forgedPortal.body?.rows?.find(row => row.id === "twitch");
    const primaryTruthAfterForeignRow = primaryTruthAfterForeign.body?.rows?.find(row => row.id === "twitch");
    const foreignOutput = JSON.stringify({ model: foreignModel.body, portal: forgedPortal.body });
    const foreignFixture = {
      expectedDecision: "connect",
      authenticated: true,
      workspaceContext: forgedPortalRow?.workspaceContext,
      workspaceIdMatches: foreignModel.body?.workspace?.id === foreignSignup.body.workspace.id,
      foreignMetadataPresent: ["123456789", "Synthetic Portal Fixture", "synthetic_portal_fixture"].some(marker => foreignOutput.includes(marker)),
      configured: true,
      readinessConfigured: true,
      envReady: true,
      missingEnv: [],
      accountPresent: forgedPortalRow?.accountPresent,
      connected: forgedPortalRow?.connected,
      banked: forgedPortalRow?.banked,
      portal: forgedPortalRow,
      executable: false,
      requiredProviderGatesMissing: true,
      externalRequests: 0,
      publicPayload: { portal: forgedPortalRow }
    };
    if (foreignModel.status !== 200
      || forgedPortal.status !== 200
      || primaryTruthAfterForeign.status !== 200
      || (foreignModel.body?.connectedAccounts || []).some(account => account.platform === "twitch")
      || primaryTruthAfterForeignRow?.connected !== true
      || primaryTruthAfterForeignRow?.tokenStored !== true
      || !twitchPortalIntegrationStateIsTruthful(foreignFixture)) {
      throw new Error("Twitch portal selectors exposed or reused another workspace's account state");
    }

    const providerMocksBeforeRestart = await shopifyScenarioExternalAttempts(providerMockLogPath);
    await stopScenarioServer(child);
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error("Twitch portal fixture could not stop the initial server before restart verification");
    }
    child = startScenarioServer();
    await waitForTwitchScenarioServer(child, scenarioBaseUrl);

    const restartedPrimaryModel = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", authenticatedOptions);
    const restartedForeignModel = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", foreignOptions);
    const restartedTruth = await shopifyScenarioResponse(scenarioBaseUrl, "/api/provider/truth", authenticatedOptions);
    const restartedPortal = await shopifyScenarioResponse(scenarioBaseUrl, "/api/dev-portal/audit", authenticatedOptions);
    const restartedPrimaryAccount = restartedPrimaryModel.body?.connectedAccounts?.find(account => account.platform === "twitch");
    const restartedTruthRow = restartedTruth.body?.rows?.find(row => row.id === "twitch");
    const restartedPortalRow = restartedPortal.body?.rows?.find(row => row.id === "twitch");
    if (restartedPrimaryModel.status !== 200
      || restartedPrimaryModel.body?.workspace?.id !== signup.body.workspace.id
      || !restartedPrimaryAccount?.connected
      || !restartedPrimaryAccount?.tokenStored
      || restartedPrimaryAccount?.workspaceId !== signup.body.workspace.id
      || restartedPrimaryAccount?.ownerUserId !== signup.body.workspace.ownerUserId
      || restartedPrimaryAccount?.providerAccountId !== "123456789"
      || ["credential", "refreshCredential", "token", "accessToken", "refreshToken", "encryptedCredential"].some(name => Object.prototype.hasOwnProperty.call(restartedPrimaryAccount || {}, name))
      || restartedForeignModel.status !== 200
      || restartedForeignModel.body?.workspace?.id !== foreignSignup.body.workspace.id
      || (restartedForeignModel.body?.connectedAccounts || []).some(account => account.platform === "twitch")
      || restartedTruth.status !== 200
      || restartedTruthRow?.connected !== true
      || restartedTruthRow?.tokenStored !== true
      || restartedPortal.status !== 200
      || restartedPortalRow?.workspaceContext !== true
      || restartedPortalRow?.connected !== true
      || restartedPortalRow?.banked !== true
      || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(providerMocksBeforeRestart)) {
      throw new Error("Twitch portal fixture did not preserve its owner-scoped account across a clean server restart");
    }

    const beforeResponses = [globalPortal, status, readiness, integrations, portalAudit, providerTruth, providerContracts, ownershipQueue, rejectedCallback, modelAfterRejectedState];
    const afterResponses = [statusAfter, readinessAfter, portalAfter, truthAfter, contractsAfter, ownershipAfter, modelAfter, foreignModel, forgedPortal, primaryTruthAfterForeign, restartedPrimaryModel, restartedForeignModel, restartedTruth, restartedPortal];
    const privateMarkers = [
      SYNTHETIC_TWITCH_APP_SECRET,
      SYNTHETIC_TWITCH_CALLBACK_ACCESS_TOKEN,
      SYNTHETIC_TWITCH_CALLBACK_REFRESH_TOKEN,
      SYNTHETIC_TWITCH_TOKEN_ENCRYPTION_KEY
    ];
    assertTwitchCredentialValuesAbsent([...beforeResponses, ...afterResponses], [SYNTHETIC_TWITCH_APP_ID, ...privateMarkers], "readiness, workspace, portal, truth, or contract responses");
    assertTwitchCredentialValuesAbsent([genericStart, directStart, callback], privateMarkers, "OAuth start or callback response");
    if (callback.text.includes(SYNTHETIC_TWITCH_CALLBACK_CODE)) throw new Error("Twitch callback response exposed its raw callback code");

    const providerMocks = await shopifyScenarioExternalAttempts(providerMockLogPath);
    const providerMockKinds = providerMocks.map(entry => entry.kind);
    if (JSON.stringify(providerMockKinds) !== JSON.stringify([
      "twitch-token-mock",
      "twitch-users-mock",
      "twitch-validate-mock",
      "twitch-validate-mock"
    ])
      || providerMocks[0]?.clientIdMatches !== true
      || providerMocks[0]?.clientSecretMatches !== true
      || providerMocks[0]?.grantType !== "authorization_code"
      || providerMocks[1]?.clientIdMatches !== true
      || providerMocks[1]?.bearerPresent !== true
      || providerMocks.slice(2).some(entry => entry.bearerPresent !== true)) {
      throw new Error("Twitch callback did not remain inside the expected hermetic provider mocks");
    }
    result = {
      configured: true,
      resolvedIdSource: status.body.credentialSources.clientId,
      resolvedSecretSource: status.body.credentialSources.clientSecret,
      beforeCallback: connectFixture,
      afterCallback: bankedFixture,
      foreignWorkspace: foreignFixture,
      readinessReady: false,
      workspaceAccountConnected: true,
      callbackStateBinding: true,
      restartPersistence: true,
      foreignWorkspaceIsolatedAfterRestart: true,
      proofRunnableAfterCallback: true,
      oauthClientIdMatched: true,
      tokenExchangeSourceContractMatched: true,
      providerMockKinds,
      secretAbsent: true,
      mockedProviderRequests: providerMocks.length,
      serverStarts: children.length,
      externalRequests: 0
    };
  } catch (error) {
    scenarioFailure = error;
  } finally {
    for (const scenarioChild of children) {
      if (scenarioChild.exitCode === null && scenarioChild.signalCode === null) {
        await stopScenarioServer(scenarioChild);
      }
    }
    childStopped = children.every(scenarioChild => scenarioChild.exitCode !== null || scenarioChild.signalCode !== null);
  }

  let postFailure;
  let cleanupComplete = false;
  try {
    assertTwitchCredentialValuesAbsent(`${stdout}\n${stderr}`, [
      SYNTHETIC_TWITCH_APP_ID,
      SYNTHETIC_TWITCH_APP_SECRET,
      SYNTHETIC_TWITCH_CALLBACK_ACCESS_TOKEN,
      SYNTHETIC_TWITCH_CALLBACK_REFRESH_TOKEN,
      SYNTHETIC_TWITCH_TOKEN_ENCRYPTION_KEY
    ], "stdout or stderr");
    const externalAttempts = await shopifyScenarioExternalAttempts(requestLogPath);
    if (externalAttempts.length) throw new Error("twitch portal credential scenario attempted an external request");
    if (!childStopped) throw new Error("twitch portal credential scenario did not stop its child process");
    if (JSON.stringify(Object.entries(process.env)) !== parentBefore) throw new Error("twitch portal credential scenario mutated the parent process environment");
    if (scenarioFailure) throw scenarioFailure;
  } catch (error) {
    postFailure = error;
  } finally {
    await rm(scenarioDataDir, { recursive: true, force: true });
    try {
      await access(scenarioDataDir);
    } catch (error) {
      if (error?.code === "ENOENT") cleanupComplete = true;
      else if (!postFailure) postFailure = error;
    }
  }
  if (!cleanupComplete && !postFailure) postFailure = new Error("twitch portal credential scenario cleanup was incomplete");
  if (postFailure) throw postFailure;
  return { ...result, cleanupComplete };
}

function shopifyCallbackPath(shop, secret) {
  const params = new URLSearchParams({
    code: "shopify-fixture-code",
    shop,
    state: "shopify-fixture-invalid-state",
    timestamp: "1786834800"
  });
  const message = [...params.entries()].map(([key, value]) => `${key}=${value}`).sort().join("&");
  params.set("hmac", createHmac("sha256", secret).update(message).digest("hex"));
  return `/api/oauth/shopify/callback?${params.toString()}`;
}

function encryptedShopifyFixtureToken(value, keyMaterial) {
  const key = createHash("sha256").update(keyMaterial).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    value: ciphertext.toString("base64url")
  };
}

async function seedShopifyWorkspaceTokenFixture({ dataDir, credential, scenarioShop, user, workspaceId }) {
  const seedSource = await readFile(new URL("./social-cues-model-seed.json", import.meta.url), "utf8");
  const seed = JSON.parse(seedSource.replace(/^\uFEFF/, ""));
  const owner = { ...user, id: String(user?.id || ""), workspaceId: String(workspaceId || "") };
  if (!owner.id || !owner.workspaceId) throw new Error("shopify workspace-token fixture is missing its canonical owner identity");
  const unavailable = () => { throw new Error("shopify workspace-token fixture must not invoke a browser merge callback"); };
  const store = await openLocalWorkspacePersistence({ dataDir, seed, mergeClient: unavailable, recoverClient: unavailable });
  try {
    const sharedModel = await store.load();
    const model = store.view(sharedModel, owner.workspaceId);
    const connectedAt = new Date().toISOString();
    model.connectedAccounts = Array.isArray(model.connectedAccounts) ? model.connectedAccounts : [];
    model.connectedAccounts.push({
      id: `acct-shopify-fixture-${owner.workspaceId}`,
      platform: "shopify",
      name: scenarioShop,
      handle: scenarioShop,
      status: "connected",
      connectedAt,
      credentialUpdatedAt: connectedAt,
      oauthProvider: "shopify",
      providerAccountId: scenarioShop,
      credential,
      tokenType: "Bearer",
      scopes: ["read_products", "read_marketing_events", "write_marketing_events"],
      ownerUserId: owner.id,
      workspaceId: owner.workspaceId
    });
    await store.save(model, owner);
  } finally {
    await store.close();
  }
}

function resolvedShopifyEnvSource(env, names) {
  return names.find(name => Boolean(env[name])) || null;
}

function validShopifyFixtureClientId(value = "") {
  return /^[a-f0-9]{32}$/i.test(String(value || "").trim());
}

function validShopifyFixtureClientSecret(value = "") {
  return /^shpss_[a-f0-9]{32}$/i.test(String(value || "").trim());
}

function normalizedShopifyScenarioResult(result) {
  return {
    resolvedIdSource: result.resolvedIdSource,
    resolvedSecretSource: result.resolvedSecretSource,
    idFormatValid: result.idFormatValid,
    secretFormatValid: result.secretFormatValid,
    configured: result.configured,
    missingEnv: result.missingEnv,
    readinessConfigured: result.readinessConfigured,
    readinessReady: result.readinessReady,
    providerConfigured: result.providerConfigured,
    providerTruthConfigured: result.providerTruthConfigured,
    contractEnvReady: result.contractEnvReady,
    oauthClientIdMatched: result.oauthClientIdMatched,
    oauthRedirectMatched: result.oauthRedirectMatched,
    oauthSecretMatched: result.oauthSecretMatched,
    externalRequests: result.externalRequests,
    workspaceTokenSeparated: result.workspaceTokenSeparated
  };
}

let shopifyScenarioSequence = 0;

async function runShopifyCredentialScenario(scenario) {
  shopifyScenarioSequence += 1;
  const sequence = shopifyScenarioSequence;
  const scenarioPort = await availableLoopbackPort();
  const scenarioBaseUrl = `http://127.0.0.1:${scenarioPort}`;
  const scenarioShop = `social-cues-fixture-${sequence}.myshopify.com`;
  const scenarioDataDir = path.join(process.cwd(), ".tmp", `shopify-credential-${sequence}-${Date.now()}`);
  const requestLogPath = path.join(scenarioDataDir, "external-http-requests.ndjson");
  const workspacePromoCode = `SC-SHOPIFY-${String(sequence).padStart(4, "0")}`;
  const workspaceEncryptionKey = scenario.workspaceTokenFixture ? `shopify-fixture-encryption-${randomBytes(12).toString("hex")}` : "";
  const workspaceTokenMarker = scenario.workspaceTokenFixture ? `shopify-fixture-workspace-token-${randomBytes(12).toString("hex")}` : "";
  const authSessionMarker = `shopify-fixture-session-${randomBytes(12).toString("hex")}`;
  const workerSecretMarker = `shopify-fixture-worker-${randomBytes(12).toString("hex")}`;
  const workspaceCredential = scenario.workspaceTokenFixture ? encryptedShopifyFixtureToken(workspaceTokenMarker, workspaceEncryptionKey) : null;
  await mkdir(scenarioDataDir, { recursive: true });
  const suppliedBaseEnv = scenario.baseEnv || process.env;
  const suppliedBaseBefore = JSON.stringify(Object.entries(suppliedBaseEnv));
  const childEnv = shopifyScenarioEnv({
    baseEnv: suppliedBaseEnv,
    overrides: {
      PORT: String(scenarioPort),
      HOST: "127.0.0.1",
      AUTH_PROVIDER: "alpha-local",
      SUPABASE_ENABLED: "false",
      SENTRY_DSN: "",
      PUBLIC_APP_URL: "https://socialcuesapp.com",
      SHOPIFY_PUBLIC_APP_URL: "https://socialcuesapp.com",
      SHOPIFY_SHOP_DOMAIN: scenarioShop,
      SHOPIFY_API_VERSION: "2026-07",
      SOCIAL_CUES_DATA_DIR: scenarioDataDir,
      SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: requestLogPath,
      SOCIAL_CUES_PROMO_CODES: JSON.stringify([{ code: workspacePromoCode, label: "Shopify fixture", days: 1, active: true }]),
      OAUTH_TOKEN_ENCRYPTION_KEY: workspaceEncryptionKey,
      AUTH_SESSION_SECRET: authSessionMarker,
      WORKER_SECRET: workerSecretMarker,
      ...scenario.overrides
    }
  });
  if (JSON.stringify(Object.entries(suppliedBaseEnv)) !== suppliedBaseBefore) throw new Error(`shopify scenario mutated its base environment: ${scenario.label}`);
  const expectedShopifyNames = new Set([
    "PUBLIC_APP_URL",
    "SHOPIFY_PUBLIC_APP_URL",
    "SHOPIFY_SHOP_DOMAIN",
    "SHOPIFY_API_VERSION",
    ...Object.keys(scenario.overrides || {}).filter(name => SHOPIFY_SCENARIO_ENV_KEYS.has(name.toLowerCase()))
  ]);
  const actualShopifyNames = new Set(shopifyEnvironmentState(childEnv).map(([name]) => name));
  if (JSON.stringify([...actualShopifyNames].sort()) !== JSON.stringify([...expectedShopifyNames].sort())) {
    throw new Error(`shopify scenario retained inherited configuration: ${scenario.label}`);
  }
  if (scenario.unrelatedSentinel && childEnv[scenario.unrelatedSentinel.name] !== scenario.unrelatedSentinel.value) {
    throw new Error(`shopify scenario removed an unrelated inherited variable: ${scenario.label}`);
  }

  const idNameKeys = new Set(SHOPIFY_CLIENT_ID_ENV_NAMES.map(name => name.toLowerCase()));
  const secretNameKeys = new Set(SHOPIFY_CLIENT_SECRET_ENV_NAMES.map(name => name.toLowerCase()));
  const idCredentialValues = Object.entries(childEnv)
    .filter(([name, value]) => idNameKeys.has(name.toLowerCase()) && String(value || "").trim())
    .map(([, value]) => String(value));
  const secretCredentialValues = Object.entries(childEnv)
    .filter(([name, value]) => secretNameKeys.has(name.toLowerCase()) && String(value || "").trim())
    .map(([, value]) => String(value));
  const resolvedIdSource = resolvedShopifyEnvSource(childEnv, SHOPIFY_CLIENT_ID_ENV_NAMES);
  const resolvedSecretSource = resolvedShopifyEnvSource(childEnv, SHOPIFY_CLIENT_SECRET_ENV_NAMES);
  const resolvedClientId = resolvedIdSource ? String(childEnv[resolvedIdSource]) : "";
  const resolvedClientSecret = resolvedSecretSource ? String(childEnv[resolvedSecretSource]) : "";
  const idFormatValid = validShopifyFixtureClientId(resolvedClientId);
  const secretFormatValid = validShopifyFixtureClientSecret(resolvedClientSecret);
  if (resolvedIdSource !== (scenario.expectedIdSource || null)
    || resolvedSecretSource !== (scenario.expectedSecretSource || null)
    || idFormatValid !== scenario.expectedIdFormatValid
    || secretFormatValid !== scenario.expectedSecretFormatValid) {
    throw new Error(`shopify scenario resolved an unexpected credential source or format state: ${scenario.label}`);
  }
  const nonSelectedIdValues = idCredentialValues.filter(value => value !== scenario.expectedClientId);
  const workspacePrivateMarkers = workspaceCredential
    ? [workspaceTokenMarker, workspaceEncryptionKey, workspaceCredential.value]
    : [];
  const privateMarkers = [
    ...secretCredentialValues,
    authSessionMarker,
    workerSecretMarker,
    ...(scenario.privateMarkers || []),
    ...(scenario.hostileMarkers || []),
    ...workspacePrivateMarkers
  ].filter(Boolean);
  const capturedResponses = [];
  const nonOAuthResponses = [];
  let stdout = "";
  let stderr = "";
  let result;
  let scenarioFailure;
  let stopFailure;
  let childStopped = false;
  const children = [];
  const startScenarioServer = () => {
    const nextChild = spawn(process.execPath, [`--import=${pathToFileURL(externalRequestGuardPath).href}`, "server.mjs"], {
      cwd: new URL(".", import.meta.url),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    children.push(nextChild);
    nextChild.stdout.on("data", chunk => { stdout += chunk; });
    nextChild.stderr.on("data", chunk => { stderr += chunk; });
    return nextChild;
  };
  let child = startScenarioServer();

  try {
    await waitForShopifyScenarioServer(child, scenarioBaseUrl, scenario.label);
    let authenticatedOptions = {};
    let workspaceTokenSeparated = false;
    let signupUser = null;
    let signupWorkspaceId = "";
    if (scenario.expectedConfigured || scenario.workspaceTokenFixture) {
      const signup = await shopifyScenarioResponse(scenarioBaseUrl, "/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Shopify Fixture User",
          email: `shopify-fixture-${sequence}@example.test`,
          password: "shopify-fixture-password-2026",
          promoCode: workspacePromoCode,
          workspaceName: `Shopify Fixture Workspace ${sequence}`
        })
      });
      capturedResponses.push(signup);
      if (signup.status !== 200 || signup.body?.ok !== true || !signup.body?.session?.token) {
        throw new Error(`shopify credential scenario could not create its authenticated workspace: ${scenario.label}`);
      }
      authenticatedOptions = { headers: { Authorization: `Bearer ${signup.body.session.token}` } };
      signupUser = signup.body.session.user || signup.body.user || null;
      signupWorkspaceId = signup.body.workspace?.id || signupUser?.workspaceId || "";
    }
    if (scenario.workspaceTokenFixture) {
      await stopShopifyScenarioServer(child);
      if (child.exitCode === null && child.signalCode === null) throw new Error("shopify workspace-token fixture could not stop before canonical seeding");
      await seedShopifyWorkspaceTokenFixture({
        dataDir: scenarioDataDir,
        credential: workspaceCredential,
        scenarioShop,
        user: signupUser,
        workspaceId: signupWorkspaceId
      });
      child = startScenarioServer();
      await waitForShopifyScenarioServer(child, scenarioBaseUrl, scenario.label);
      const publicModel = await shopifyScenarioResponse(scenarioBaseUrl, "/api/model", authenticatedOptions);
      capturedResponses.push(publicModel);
      const publicAccount = publicModel.body?.connectedAccounts?.find(account => account.providerAccountId === scenarioShop);
      if (publicModel.status !== 200 || !publicAccount?.connected || !publicAccount?.tokenStored) {
        throw new Error("shopify workspace-token fixture was not represented as connected workspace state");
      }
      if (["credential", "token", "accessToken", "encryptedToken"].some(name => Object.prototype.hasOwnProperty.call(publicAccount, name))) {
        throw new Error("shopify workspace-token fixture exposed a private credential field");
      }
      const rawModelSource = await readFile(path.join(scenarioDataDir, "model.json"), "utf8");
      const rawModel = JSON.parse(rawModelSource);
      const rawAccount = rawModel.workspaces?.[signupWorkspaceId]?.content?.connectedAccounts
        ?.find(account => account.providerAccountId === scenarioShop);
      if (rawAccount?.credential?.alg !== "aes-256-gcm"
        || rawAccount.credential.value !== workspaceCredential.value
        || rawModelSource.includes(workspaceTokenMarker)) {
        throw new Error("shopify workspace-token fixture was not stored as the expected encrypted envelope");
      }
      workspaceTokenSeparated = true;
    }

    const status = await shopifyScenarioResponse(scenarioBaseUrl, "/api/oauth/shopify/status", authenticatedOptions);
    const readiness = await shopifyScenarioResponse(scenarioBaseUrl, "/api/shopify/readiness", authenticatedOptions);
    const integrations = await shopifyScenarioResponse(scenarioBaseUrl, "/api/integrations/readiness", authenticatedOptions);
    const providerTruth = await shopifyScenarioResponse(scenarioBaseUrl, "/api/provider/truth", authenticatedOptions);
    const providerContracts = await shopifyScenarioResponse(scenarioBaseUrl, "/api/provider/contracts", authenticatedOptions);
    capturedResponses.push(status, readiness, integrations, providerTruth, providerContracts);
    nonOAuthResponses.push(status, readiness, integrations, providerTruth, providerContracts);
    const providerService = integrations.body?.providerServices?.find(item => item.id === "shopify");
    const providerTruthRow = providerTruth.body?.rows?.find(item => item.id === "shopify");
    const providerContract = providerContracts.body?.rows?.find(item => item.id === "shopify");
    if (status.status !== 200 || status.body?.ok !== true) throw new Error(`shopify status failed in credential scenario: ${scenario.label}`);
    if (readiness.status !== 200 || readiness.body?.ok !== true) throw new Error(`shopify readiness failed in credential scenario: ${scenario.label}`);
    if (integrations.status !== 200 || integrations.body?.ok !== true || !providerService) throw new Error(`shopify integration readiness failed in credential scenario: ${scenario.label}`);
    if (providerTruth.status !== 200 || providerTruth.body?.ok !== true || !providerTruthRow) throw new Error(`shopify provider truth failed in credential scenario: ${scenario.label}`);
    if (providerContracts.status !== 200 || providerContracts.body?.ok !== true || !providerContract) throw new Error(`shopify provider contracts failed in credential scenario: ${scenario.label}`);
    if (JSON.stringify(status.body.acceptedEnv?.SHOPIFY_CLIENT_ID) !== JSON.stringify(SHOPIFY_CLIENT_ID_ENV_NAMES)
      || JSON.stringify(status.body.acceptedEnv?.SHOPIFY_CLIENT_SECRET) !== JSON.stringify(SHOPIFY_CLIENT_SECRET_ENV_NAMES)
      || JSON.stringify(status.body.acceptedEnv?.SHOPIFY_SHOP_DOMAIN) !== JSON.stringify(SHOPIFY_SHOP_DOMAIN_ENV_NAMES)
      || JSON.stringify(providerService.acceptedEnv?.SHOPIFY_CLIENT_ID) !== JSON.stringify(SHOPIFY_CLIENT_ID_ENV_NAMES)
      || JSON.stringify(providerService.acceptedEnv?.SHOPIFY_CLIENT_SECRET) !== JSON.stringify(SHOPIFY_CLIENT_SECRET_ENV_NAMES)) {
      throw new Error(`shopify accepted environment inventory changed in scenario: ${scenario.label}`);
    }
    assertShopifyCredentialValuesAbsent(nonOAuthResponses, [...idCredentialValues, ...secretCredentialValues, ...privateMarkers], `${scenario.label} public readiness and provider reports`);

    const observation = {
      key: scenario.key,
      resolvedIdSource,
      resolvedSecretSource,
      idFormatValid,
      secretFormatValid,
      configured: Boolean(status.body.configured),
      missingEnv: [...(status.body.missingEnv || [])],
      readinessConfigured: Boolean(readiness.body.configured),
      readinessReady: Boolean(readiness.body.ready),
      providerConfigured: Boolean(providerService.configured),
      providerTruthConfigured: Boolean(providerTruthRow.configured),
      contractEnvReady: Boolean(providerContract.gates?.envReady),
      oauthClientIdMatched: false,
      oauthRedirectMatched: false,
      oauthSecretMatched: false,
      externalRequests: 0,
      workspaceTokenSeparated
    };

    const accountConnected = Boolean(scenario.workspaceTokenFixture);
    if (observation.configured !== scenario.expectedConfigured
      || Boolean(status.body.clientIdPresent) !== scenario.expectedIdFormatValid
      || Boolean(status.body.clientSecretPresent) !== scenario.expectedSecretFormatValid
      || JSON.stringify(observation.missingEnv) !== JSON.stringify(scenario.expectedMissingEnv)
      || JSON.stringify(readiness.body.missingEnv || []) !== JSON.stringify(scenario.expectedMissingEnv)
      || observation.readinessConfigured !== scenario.expectedConfigured
      || observation.readinessReady !== Boolean(scenario.expectedConfigured && accountConnected)
      || observation.providerConfigured !== scenario.expectedConfigured
      || observation.providerTruthConfigured !== scenario.expectedConfigured
      || observation.contractEnvReady !== scenario.expectedConfigured
      || Boolean(status.body.connected) !== accountConnected
      || Boolean(readiness.body.account?.connected) !== accountConnected
      || Boolean(providerTruthRow.connected) !== accountConnected
      || Boolean(providerTruthRow.tokenStored) !== accountConnected
      || Boolean(providerContract.gates?.oauthConnected) !== accountConnected) {
      throw new Error(`shopify credential scenario returned the wrong readiness or workspace state: ${scenario.label}`);
    }
    if (scenario.workspaceTokenFixture) {
      const providerAccounts = await shopifyScenarioResponse(scenarioBaseUrl, "/api/provider/accounts?platform=shopify", authenticatedOptions);
      capturedResponses.push(providerAccounts);
      nonOAuthResponses.push(providerAccounts);
      const selectedAccount = providerAccounts.body?.rows?.[0]?.accounts?.find(account => account.providerAccountId === scenarioShop);
      if (providerAccounts.status !== 200 || providerAccounts.body?.ok !== true || !selectedAccount?.connected || !selectedAccount?.tokenStored) {
        throw new Error("shopify workspace-token fixture was absent from the safe provider-account surface");
      }
      if (observation.configured || observation.readinessReady || !observation.workspaceTokenSeparated) {
        throw new Error("shopify workspace token incorrectly satisfied application OAuth readiness");
      }
    }

    const connectUrl = await shopifyScenarioResponse(scenarioBaseUrl, `/api/oauth/connect-url?provider=shopify&shop=${encodeURIComponent(scenarioShop)}`, authenticatedOptions);
    const directStart = await shopifyScenarioResponse(scenarioBaseUrl, `/api/oauth/shopify/start?shop=${encodeURIComponent(scenarioShop)}`, authenticatedOptions);
    capturedResponses.push(connectUrl, directStart);
    if (observation.configured) {
      const genericStartUrl = typeof connectUrl.body?.url === "string" ? connectUrl.body.url : "";
      if (connectUrl.status !== 200 || connectUrl.body?.ok !== true || !genericStartUrl
        || directStart.status !== 302 || !directStart.location) {
        throw new Error(`shopify OAuth start did not return its configured redirect: ${scenario.label}`);
      }
      let genericOAuthUrl;
      let directOAuthUrl;
      try {
        genericOAuthUrl = new URL(genericStartUrl);
        directOAuthUrl = new URL(directStart.location);
      } catch {
        throw new Error(`shopify OAuth start returned a malformed configured redirect: ${scenario.label}`);
      }
      const expectedCallback = "https://socialcuesapp.com/api/oauth/shopify/callback";
      const validStartUrl = value => value.protocol === "https:"
        && value.hostname === scenarioShop
        && value.pathname === "/admin/oauth/authorize"
        && value.searchParams.get("client_id") === scenario.expectedClientId
        && value.searchParams.get("redirect_uri") === expectedCallback
        && Boolean(value.searchParams.get("state"));
      if (!validStartUrl(genericOAuthUrl) || !validStartUrl(directOAuthUrl)) {
        throw new Error(`shopify OAuth start resolved a different client id: ${scenario.label}`);
      }
      assertShopifyCredentialValuesAbsent([connectUrl.text, directStart.text, directStart.location], [scenario.expectedClientSecret], `${scenario.label} OAuth start`);
      const callback = await shopifyScenarioResponse(scenarioBaseUrl, shopifyCallbackPath(scenarioShop, scenario.expectedClientSecret), authenticatedOptions);
      if (callback.status !== 400 || !/OAuth state rejected/i.test(callback.text) || /HMAC did not validate/i.test(callback.text)) {
        throw new Error(`shopify OAuth callback resolved a different client secret: ${scenario.label}`);
      }
      const wrongSecret = syntheticShopifyPair(4095).clientSecret;
      const rejectedCallback = await shopifyScenarioResponse(scenarioBaseUrl, shopifyCallbackPath(scenarioShop, wrongSecret), authenticatedOptions);
      capturedResponses.push(callback, rejectedCallback);
      if (rejectedCallback.status !== 400 || !/HMAC did not validate/i.test(rejectedCallback.text) || /OAuth state rejected/i.test(rejectedCallback.text)) {
        throw new Error(`shopify OAuth callback accepted a signature from another credential pair: ${scenario.label}`);
      }
      assertShopifyCredentialValuesAbsent([callback, rejectedCallback], [...secretCredentialValues, wrongSecret], `${scenario.label} OAuth callback`);
      observation.oauthClientIdMatched = true;
      observation.oauthRedirectMatched = true;
      observation.oauthSecretMatched = true;
    } else {
      assertShopifyCredentialValuesAbsent([connectUrl, directStart], [...idCredentialValues, ...secretCredentialValues, ...privateMarkers], `${scenario.label} rejected OAuth start`);
      if (connectUrl.status !== 409 || connectUrl.body?.url || connectUrl.location
        || directStart.status !== 200 || !/Shopify app credentials needed/i.test(directStart.text) || directStart.location) {
        throw new Error(`shopify OAuth start did not fail closed: ${scenario.label}`);
      }
    }
    assertShopifyCredentialValuesAbsent(capturedResponses, [...privateMarkers, ...nonSelectedIdValues], `${scenario.label} captured HTTP surfaces`);
    assertShopifyCredentialValuesAbsent(nonOAuthResponses, scenario.expectedClientId?.trim() ? [scenario.expectedClientId] : [], `${scenario.label} non-OAuth surfaces`);
    assertShopifyCredentialValuesAbsent(observation, [...idCredentialValues, ...secretCredentialValues, ...privateMarkers], `${scenario.label} normalized report`);
    result = observation;
  } catch (error) {
    scenarioFailure = error;
  } finally {
    try {
      for (const scenarioChild of children) await stopShopifyScenarioServer(scenarioChild);
      childStopped = children.every(scenarioChild => scenarioChild.exitCode !== null || scenarioChild.signalCode !== null);
    } catch (error) {
      stopFailure = error;
    }
  }

  let postFailure = scenarioFailure || stopFailure;
  let cleanupComplete = false;
  try {
    assertShopifyCredentialValuesAbsent(`${stdout}\n${stderr}`, [...idCredentialValues, ...secretCredentialValues, ...privateMarkers], `${scenario.label} stdout or stderr`);
    const externalAttempts = await shopifyScenarioExternalAttempts(requestLogPath);
    if (externalAttempts.length) throw new Error(`shopify credential scenario attempted an external request: ${scenario.label}`);
    if (!childStopped) throw new Error(`shopify credential scenario did not stop its child process: ${scenario.label}`);
    if (JSON.stringify(Object.entries(suppliedBaseEnv)) !== suppliedBaseBefore) throw new Error(`shopify scenario changed its supplied base after execution: ${scenario.label}`);
  } catch (error) {
    if (!postFailure) postFailure = error;
  } finally {
    await rm(scenarioDataDir, { recursive: true, force: true });
    try {
      await access(scenarioDataDir);
    } catch (error) {
      if (error?.code === "ENOENT") cleanupComplete = true;
      else if (!postFailure) postFailure = error;
    }
  }
  if (!cleanupComplete && !postFailure) postFailure = new Error(`shopify credential scenario cleanup was incomplete: ${scenario.label}`);
  if (postFailure) throw postFailure;
  result.cleanupComplete = true;
  return result;
}

function syntheticShopifyPair(index) {
  const payload = Number(index).toString(16).padStart(32, "0");
  return {
    clientId: payload,
    clientSecret: `shpss_${payload}`
  };
}

function defineShopifyScenario({ key, label, overrides = {}, idSource = null, secretSource = null, ...options }) {
  const expectedClientId = idSource ? String(overrides[idSource] || "") : "";
  const expectedClientSecret = secretSource ? String(overrides[secretSource] || "") : "";
  const expectedIdFormatValid = validShopifyFixtureClientId(expectedClientId);
  const expectedSecretFormatValid = validShopifyFixtureClientSecret(expectedClientSecret);
  return {
    key,
    label,
    overrides,
    expectedIdSource: idSource,
    expectedSecretSource: secretSource,
    expectedClientId,
    expectedClientSecret,
    expectedIdFormatValid,
    expectedSecretFormatValid,
    expectedConfigured: expectedIdFormatValid && expectedSecretFormatValid,
    expectedMissingEnv: [
      ...(!expectedIdFormatValid ? [SHOPIFY_MISSING_CLIENT_ID] : []),
      ...(!expectedSecretFormatValid ? [SHOPIFY_MISSING_CLIENT_SECRET] : [])
    ],
    ...options
  };
}

function hostileShopifyEnvironment() {
  const inherited = {};
  const markers = [];
  let pairIndex = 100;
  for (const name of SHOPIFY_CLIENT_ID_ENV_NAMES) {
    const value = syntheticShopifyPair(pairIndex).clientId;
    pairIndex += 1;
    inherited[name] = value;
    markers.push(value);
  }
  for (const name of SHOPIFY_CLIENT_SECRET_ENV_NAMES) {
    const value = syntheticShopifyPair(pairIndex).clientSecret;
    pairIndex += 1;
    inherited[name] = value;
    markers.push(value);
  }
  Object.assign(inherited, {
    SHOPIFY_SHOP_DOMAIN: "hostile-canonical.myshopify.com",
    SHOPIFY_STORE_DOMAIN: "hostile-store.myshopify.com",
    SHOPIFY_TEST_STORE_DOMAIN: "hostile-test.myshopify.com",
    shopify_shop_domain: "hostile-lower.myshopify.com",
    SHOPIFY_PUBLIC_APP_URL: "https://hostile-shopify.example.test",
    SHOPIFY_API_VERSION: "2025-01",
    PUBLIC_APP_URL: "https://hostile-public.example.test",
    ShOpIfY_ClIeNt_Id: syntheticShopifyPair(pairIndex++).clientId,
    sHoPiFy_ClIeNt_SeCrEt: syntheticShopifyPair(pairIndex++).clientSecret,
    ShOpIfY_ApP_Id: syntheticShopifyPair(pairIndex++).clientId,
    sHoPiFy_ApP_sEcReT: syntheticShopifyPair(pairIndex++).clientSecret
  });
  markers.push(...Object.values(inherited).filter(Boolean));
  const unrelatedSentinel = { name: "SOCIAL_CUES_SHOPIFY_UNRELATED_SENTINEL", value: "shopify-unrelated-preserved" };
  return {
    baseEnv: { ...process.env, ...inherited, [unrelatedSentinel.name]: unrelatedSentinel.value },
    hostileEnvNames: Object.keys(inherited),
    hostileMarkers: [...new Set([...markers, unrelatedSentinel.value])],
    unrelatedSentinel
  };
}

async function runShopifyCredentialMatrix() {
  const parentBefore = Object.entries(process.env);
  assertShopifyScenarioEnvironmentHelper();
  const committedServerSource = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  assertCommittedShopifyCredentialFamilies(committedServerSource);
  const canonical = syntheticShopifyPair(1);
  const aliasPairs = [
    ["api-key-pair", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", syntheticShopifyPair(2)],
    ["app-id-pair", "SHOPIFY_APP_ID", "SHOPIFY_APP_SECRET", syntheticShopifyPair(3)],
    ["app-client-pair", "SHOPIFY_APP_CLIENT_ID", "SHOPIFY_APP_CLIENT_SECRET", syntheticShopifyPair(4)],
    ["lowercase-client-pair", "shopify_client_id", "shopify_client_secret", syntheticShopifyPair(5)],
    ["lowercase-api-pair", "shopify_api_key", "shopify_api_secret", syntheticShopifyPair(6)]
  ];
  const negativePair = syntheticShopifyPair(10);
  const aliasNegativePair = syntheticShopifyPair(11);
  const precedenceCanonical = syntheticShopifyPair(20);
  const precedenceAlias = syntheticShopifyPair(21);
  const unknownPair = syntheticShopifyPair(25);
  const unknownIdName = SHOPIFY_TEST_ONLY_UNKNOWN_ENV_NAMES[0];
  const unknownSecretName = SHOPIFY_TEST_ONLY_UNKNOWN_ENV_NAMES[1];
  const hostile = hostileShopifyEnvironment();
  const hostileTarget = syntheticShopifyPair(40);
  const scenarios = [
    defineShopifyScenario({
      key: "canonical-pair",
      label: "canonical pair",
      overrides: { SHOPIFY_CLIENT_ID: canonical.clientId, SHOPIFY_CLIENT_SECRET: canonical.clientSecret },
      idSource: "SHOPIFY_CLIENT_ID",
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    ...aliasPairs.map(([key, idName, secretName, pair]) => defineShopifyScenario({
      key,
      label: `${idName} and ${secretName}`,
      overrides: { [idName]: pair.clientId, [secretName]: pair.clientSecret },
      idSource: idName,
      secretSource: secretName
    })),
    defineShopifyScenario({
      key: "canonical-id-only",
      label: "canonical id without secret",
      overrides: { SHOPIFY_CLIENT_ID: negativePair.clientId },
      idSource: "SHOPIFY_CLIENT_ID"
    }),
    defineShopifyScenario({
      key: "canonical-secret-only",
      label: "canonical secret without id",
      overrides: { SHOPIFY_CLIENT_SECRET: negativePair.clientSecret },
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "alias-id-only",
      label: "alias id without secret",
      overrides: { SHOPIFY_API_KEY: aliasNegativePair.clientId },
      idSource: "SHOPIFY_API_KEY"
    }),
    defineShopifyScenario({
      key: "alias-secret-only",
      label: "alias secret without id",
      overrides: { SHOPIFY_API_SECRET: aliasNegativePair.clientSecret },
      secretSource: "SHOPIFY_API_SECRET"
    }),
    defineShopifyScenario({
      key: "blank-canonical-id",
      label: "blank canonical id",
      overrides: { SHOPIFY_CLIENT_ID: "", SHOPIFY_CLIENT_SECRET: negativePair.clientSecret },
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "blank-canonical-secret",
      label: "blank canonical secret",
      overrides: { SHOPIFY_CLIENT_ID: negativePair.clientId, SHOPIFY_CLIENT_SECRET: "" },
      idSource: "SHOPIFY_CLIENT_ID"
    }),
    defineShopifyScenario({
      key: "whitespace-canonical-id",
      label: "whitespace canonical id",
      overrides: { SHOPIFY_CLIENT_ID: "   ", SHOPIFY_CLIENT_SECRET: negativePair.clientSecret },
      idSource: "SHOPIFY_CLIENT_ID",
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "whitespace-canonical-secret",
      label: "whitespace canonical secret",
      overrides: { SHOPIFY_CLIENT_ID: negativePair.clientId, SHOPIFY_CLIENT_SECRET: "\t" },
      idSource: "SHOPIFY_CLIENT_ID",
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "blank-alias-id",
      label: "blank alias id",
      overrides: { SHOPIFY_APP_ID: "", SHOPIFY_APP_SECRET: aliasNegativePair.clientSecret },
      secretSource: "SHOPIFY_APP_SECRET"
    }),
    defineShopifyScenario({
      key: "blank-alias-secret",
      label: "blank alias secret",
      overrides: { SHOPIFY_APP_ID: aliasNegativePair.clientId, SHOPIFY_APP_SECRET: "" },
      idSource: "SHOPIFY_APP_ID"
    }),
    defineShopifyScenario({
      key: "whitespace-alias-id",
      label: "whitespace alias id",
      overrides: { SHOPIFY_APP_ID: "  ", SHOPIFY_APP_SECRET: aliasNegativePair.clientSecret },
      idSource: "SHOPIFY_APP_ID",
      secretSource: "SHOPIFY_APP_SECRET"
    }),
    defineShopifyScenario({
      key: "whitespace-alias-secret",
      label: "whitespace alias secret",
      overrides: { SHOPIFY_APP_ID: aliasNegativePair.clientId, SHOPIFY_APP_SECRET: "  " },
      idSource: "SHOPIFY_APP_ID",
      secretSource: "SHOPIFY_APP_SECRET"
    }),
    defineShopifyScenario({
      key: "invalid-id-characters",
      label: "invalid id character set",
      overrides: { SHOPIFY_CLIENT_ID: "g".repeat(32), SHOPIFY_CLIENT_SECRET: negativePair.clientSecret },
      idSource: "SHOPIFY_CLIENT_ID",
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "invalid-id-length",
      label: "invalid id length",
      overrides: { SHOPIFY_CLIENT_ID: negativePair.clientId.slice(1), SHOPIFY_CLIENT_SECRET: negativePair.clientSecret },
      idSource: "SHOPIFY_CLIENT_ID",
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "invalid-secret-format",
      label: "invalid secret prefix or format",
      overrides: { SHOPIFY_CLIENT_ID: negativePair.clientId, SHOPIFY_CLIENT_SECRET: negativePair.clientSecret.replace(/^shpss_/, "shopify_") },
      idSource: "SHOPIFY_CLIENT_ID",
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "unknown-id-valid-secret",
      label: "unknown id alias with approved secret",
      overrides: { [unknownIdName]: unknownPair.clientId, SHOPIFY_API_SECRET: unknownPair.clientSecret },
      secretSource: "SHOPIFY_API_SECRET",
      allowedUnknownEnvNames: [unknownIdName],
      privateMarkers: [unknownPair.clientId]
    }),
    defineShopifyScenario({
      key: "valid-id-unknown-secret",
      label: "approved id with unknown secret alias",
      overrides: { SHOPIFY_API_KEY: unknownPair.clientId, [unknownSecretName]: unknownPair.clientSecret },
      idSource: "SHOPIFY_API_KEY",
      allowedUnknownEnvNames: [unknownSecretName],
      privateMarkers: [unknownPair.clientSecret]
    }),
    defineShopifyScenario({
      key: "unknown-id-and-secret",
      label: "unknown id and secret aliases",
      overrides: { [unknownIdName]: unknownPair.clientId, [unknownSecretName]: unknownPair.clientSecret },
      allowedUnknownEnvNames: [unknownIdName, unknownSecretName],
      privateMarkers: [unknownPair.clientId, unknownPair.clientSecret]
    }),
    defineShopifyScenario({
      key: "canonical-conflicting-alias",
      label: "conflicting canonical and alias pairs",
      overrides: {
        SHOPIFY_CLIENT_ID: precedenceCanonical.clientId,
        SHOPIFY_CLIENT_SECRET: precedenceCanonical.clientSecret,
        SHOPIFY_API_KEY: precedenceAlias.clientId,
        SHOPIFY_API_SECRET: precedenceAlias.clientSecret
      },
      idSource: "SHOPIFY_CLIENT_ID",
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "empty-canonical-id-alias-fallback",
      label: "empty canonical id with alias fallback",
      overrides: {
        SHOPIFY_CLIENT_ID: "",
        SHOPIFY_CLIENT_SECRET: precedenceCanonical.clientSecret,
        SHOPIFY_API_KEY: precedenceAlias.clientId,
        SHOPIFY_API_SECRET: precedenceAlias.clientSecret
      },
      idSource: "SHOPIFY_API_KEY",
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "empty-canonical-secret-alias-fallback",
      label: "empty canonical secret with alias fallback",
      overrides: {
        SHOPIFY_CLIENT_ID: precedenceCanonical.clientId,
        SHOPIFY_CLIENT_SECRET: "",
        SHOPIFY_API_KEY: precedenceAlias.clientId,
        SHOPIFY_API_SECRET: precedenceAlias.clientSecret
      },
      idSource: "SHOPIFY_CLIENT_ID",
      secretSource: "SHOPIFY_API_SECRET"
    }),
    defineShopifyScenario({
      key: "empty-canonical-pair-alias-fallback",
      label: "empty canonical pair with alias fallback",
      overrides: {
        SHOPIFY_CLIENT_ID: "",
        SHOPIFY_CLIENT_SECRET: "",
        SHOPIFY_API_KEY: precedenceAlias.clientId,
        SHOPIFY_API_SECRET: precedenceAlias.clientSecret
      },
      idSource: "SHOPIFY_API_KEY",
      secretSource: "SHOPIFY_API_SECRET"
    }),
    defineShopifyScenario({
      key: "whitespace-canonical-id-blocks-alias",
      label: "whitespace canonical id blocks alias fallback",
      overrides: {
        SHOPIFY_CLIENT_ID: "   ",
        SHOPIFY_CLIENT_SECRET: precedenceCanonical.clientSecret,
        SHOPIFY_API_KEY: precedenceAlias.clientId,
        SHOPIFY_API_SECRET: precedenceAlias.clientSecret
      },
      idSource: "SHOPIFY_CLIENT_ID",
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "whitespace-canonical-secret-blocks-alias",
      label: "whitespace canonical secret blocks alias fallback",
      overrides: {
        SHOPIFY_CLIENT_ID: precedenceCanonical.clientId,
        SHOPIFY_CLIENT_SECRET: "\t",
        SHOPIFY_API_KEY: precedenceAlias.clientId,
        SHOPIFY_API_SECRET: precedenceAlias.clientSecret
      },
      idSource: "SHOPIFY_CLIENT_ID",
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "mixed-canonical-id-alias-secret",
      label: "mixed canonical id and alias secret",
      overrides: { SHOPIFY_CLIENT_ID: syntheticShopifyPair(30).clientId, SHOPIFY_APP_SECRET: syntheticShopifyPair(30).clientSecret },
      idSource: "SHOPIFY_CLIENT_ID",
      secretSource: "SHOPIFY_APP_SECRET"
    }),
    defineShopifyScenario({
      key: "mixed-alias-id-canonical-secret",
      label: "mixed alias id and canonical secret",
      overrides: { SHOPIFY_APP_ID: syntheticShopifyPair(31).clientId, SHOPIFY_CLIENT_SECRET: syntheticShopifyPair(31).clientSecret },
      idSource: "SHOPIFY_APP_ID",
      secretSource: "SHOPIFY_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "mixed-api-key-app-secret",
      label: "mixed API key and app secret",
      overrides: { SHOPIFY_API_KEY: syntheticShopifyPair(32).clientId, SHOPIFY_APP_SECRET: syntheticShopifyPair(32).clientSecret },
      idSource: "SHOPIFY_API_KEY",
      secretSource: "SHOPIFY_APP_SECRET"
    }),
    defineShopifyScenario({
      key: "mixed-app-id-api-secret",
      label: "mixed app id and API secret",
      overrides: { SHOPIFY_APP_ID: syntheticShopifyPair(33).clientId, SHOPIFY_API_SECRET: syntheticShopifyPair(33).clientSecret },
      idSource: "SHOPIFY_APP_ID",
      secretSource: "SHOPIFY_API_SECRET"
    }),
    defineShopifyScenario({
      key: "mixed-app-client-lowercase-secret",
      label: "mixed app client id and lowercase secret",
      overrides: { SHOPIFY_APP_CLIENT_ID: syntheticShopifyPair(34).clientId, shopify_client_secret: syntheticShopifyPair(34).clientSecret },
      idSource: "SHOPIFY_APP_CLIENT_ID",
      secretSource: "shopify_client_secret"
    }),
    defineShopifyScenario({
      key: "mixed-lowercase-id-uppercase-secret",
      label: "mixed lowercase id and uppercase secret",
      overrides: { shopify_api_key: syntheticShopifyPair(35).clientId, SHOPIFY_APP_CLIENT_SECRET: syntheticShopifyPair(35).clientSecret },
      idSource: "shopify_api_key",
      secretSource: "SHOPIFY_APP_CLIENT_SECRET"
    }),
    defineShopifyScenario({
      key: "hostile-inherited-environment",
      label: "hostile inherited environment",
      overrides: { SHOPIFY_APP_ID: hostileTarget.clientId, SHOPIFY_APP_SECRET: hostileTarget.clientSecret },
      idSource: "SHOPIFY_APP_ID",
      secretSource: "SHOPIFY_APP_SECRET",
      ...hostile
    }),
    defineShopifyScenario({
      key: "workspace-token-without-app-credentials",
      label: "workspace token without application credentials",
      workspaceTokenFixture: true
    })
  ];
  assertShopifyScenarioDefinitions(scenarios, committedServerSource);
  const scenarioByKey = new Map(scenarios.map(scenario => [scenario.key, scenario]));
  const observationsByKey = new Map();
  for (const scenario of scenarios) {
    observationsByKey.set(scenario.key, await runShopifyCredentialScenario(scenario));
  }

  const orderSequences = [
    ["canonical then API-key alias", ["canonical-pair", "api-key-pair"]],
    ["API-key alias then canonical", ["api-key-pair", "canonical-pair"]],
    ["same valid alias repeated", ["api-key-pair", "api-key-pair"]],
    ["invalid ID then valid alias", ["invalid-id-characters", "api-key-pair"]],
    ["valid alias then invalid ID", ["api-key-pair", "invalid-id-characters"]],
    ["alias family A then B", ["api-key-pair", "app-id-pair"]],
    ["alias family B then A", ["app-id-pair", "api-key-pair"]],
    ["hostile target repeated", ["hostile-inherited-environment", "hostile-inherited-environment"]],
    ["empty canonical fallback then canonical", ["empty-canonical-pair-alias-fallback", "canonical-pair"]],
    ["canonical then empty canonical fallback", ["canonical-pair", "empty-canonical-pair-alias-fallback"]]
  ];
  let orderExecutionCount = 0;
  for (const [label, keys] of orderSequences) {
    const sequenceResults = [];
    for (const key of keys) {
      const scenario = scenarioByKey.get(key);
      if (!scenario) throw new Error(`shopify order sequence references an unknown scenario: ${label}`);
      const actual = normalizedShopifyScenarioResult(await runShopifyCredentialScenario(scenario));
      const expected = normalizedShopifyScenarioResult(observationsByKey.get(key));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`shopify scenario result changed with execution order: ${label}`);
      sequenceResults.push(actual);
      orderExecutionCount += 1;
    }
    if (keys[0] === keys[1] && JSON.stringify(sequenceResults[0]) !== JSON.stringify(sequenceResults[1])) {
      throw new Error(`shopify repeated scenario was not deterministic: ${label}`);
    }
  }

  if (JSON.stringify(Object.entries(process.env)) !== JSON.stringify(parentBefore)) throw new Error("shopify credential matrix mutated the parent process environment");
  for (const key of ["canonical-pair", "api-key-pair", "app-id-pair"]) {
    const result = observationsByKey.get(key);
    if (!result?.oauthClientIdMatched || !result?.oauthRedirectMatched || !result?.oauthSecretMatched) {
      throw new Error("shopify callback HMAC coverage did not behaviorally prove canonical and alias credential resolution");
    }
  }
  if ([...observationsByKey.values()].some(result => result.cleanupComplete !== true)) throw new Error("shopify credential matrix left scenario data behind");
  const workspaceResult = observationsByKey.get("workspace-token-without-app-credentials");
  if (!workspaceResult?.workspaceTokenSeparated || workspaceResult.configured || workspaceResult.readinessReady) throw new Error("shopify workspace token was not kept separate from application credentials");
  const mixedResult = observationsByKey.get("mixed-canonical-id-alias-secret");
  return {
    count: scenarios.length,
    executions: scenarios.length + orderExecutionCount,
    orderSequenceCount: orderSequences.length,
    workspaceTokenSeparated: true,
    callbackHmacBehavioral: true,
    configuredOAuthStarts: true,
    cleanupComplete: true,
    mixedCanonicalIdAliasSecretConfigured: mixedResult?.configured === true
  };
}

const coreModelFixtureOnly = process.env.SOCIAL_CUES_CORE_MODEL_FIXTURE_ONLY === "true";
const providerStateFixtureOnly = process.env.SOCIAL_CUES_PROVIDER_STATE_FIXTURE_ONLY === "true";
const googleCallbackFixtureOnly = process.env.SOCIAL_CUES_GOOGLE_CALLBACK_FIXTURE_ONLY === "true";
const googleStartFixtureOnly = process.env.SOCIAL_CUES_GOOGLE_START_FIXTURE_ONLY === "true";
const twitchPortalFixtureOnly = process.env.SOCIAL_CUES_TWITCH_PORTAL_FIXTURE_ONLY === "true";
const shopifyFixtureOnly = process.env.SOCIAL_CUES_SHOPIFY_FIXTURE_ONLY === "true";
const metaStartFixtureOnly = process.env.SOCIAL_CUES_META_START_FIXTURE_ONLY === "true";
const metaAssetsFixtureOnly = process.env.SOCIAL_CUES_META_ASSETS_FIXTURE_ONLY === "true";
const metaCallbackFixtureOnly = process.env.SOCIAL_CUES_META_CALLBACK_FIXTURE_ONLY === "true";
const metaCallbackAtomicFixtureOnly = process.env.SOCIAL_CUES_META_CALLBACK_ATOMIC_FIXTURE_ONLY === "true";
const xAccountFixtureOnly = process.env.SOCIAL_CUES_X_ACCOUNT_FIXTURE_ONLY === "true";
const billingCheckoutFixtureOnly = process.env.SOCIAL_CUES_BILLING_CHECKOUT_FIXTURE_ONLY === "true";
const discordCommunityFixtureOnly = process.env.SOCIAL_CUES_DISCORD_COMMUNITY_FIXTURE_ONLY === "true";
const skipDiscordCommunityFixture = coreModelFixtureOnly || providerStateFixtureOnly || googleCallbackFixtureOnly
  || googleStartFixtureOnly || twitchPortalFixtureOnly || shopifyFixtureOnly || metaStartFixtureOnly
  || metaAssetsFixtureOnly || metaCallbackFixtureOnly || metaCallbackAtomicFixtureOnly || xAccountFixtureOnly
  || billingCheckoutFixtureOnly;
const discordCommunityFixture = skipDiscordCommunityFixture ? null : await runDiscordCommunityBoundaryScenario();
if (discordCommunityFixtureOnly) {
  console.log(JSON.stringify({ ok: true, discordCommunity: discordCommunityFixture }));
  process.exit(0);
}
const skipMetaStartFixture = coreModelFixtureOnly || providerStateFixtureOnly || googleCallbackFixtureOnly
  || googleStartFixtureOnly || twitchPortalFixtureOnly || shopifyFixtureOnly || metaAssetsFixtureOnly || metaCallbackFixtureOnly
  || metaCallbackAtomicFixtureOnly || xAccountFixtureOnly;
const metaStartFixture = skipMetaStartFixture ? null : await runMetaOAuthStartScenario();
if (metaStartFixtureOnly) {
  console.log(JSON.stringify({ ok: true, ...metaStartFixture }));
  process.exit(0);
}
const skipMetaAssetsFixture = coreModelFixtureOnly || providerStateFixtureOnly || googleCallbackFixtureOnly
  || googleStartFixtureOnly || twitchPortalFixtureOnly || shopifyFixtureOnly || metaStartFixtureOnly || metaCallbackFixtureOnly
  || metaCallbackAtomicFixtureOnly || xAccountFixtureOnly;
const metaAssetsFixture = skipMetaAssetsFixture ? null : await runMetaAssetsScenario();
if (metaAssetsFixtureOnly) {
  console.log(JSON.stringify({ ok: true, ...metaAssetsFixture }));
  process.exit(0);
}
const skipMetaCallbackFixture = coreModelFixtureOnly || providerStateFixtureOnly || googleCallbackFixtureOnly
  || googleStartFixtureOnly || twitchPortalFixtureOnly || shopifyFixtureOnly || metaStartFixtureOnly || metaAssetsFixtureOnly
  || metaCallbackAtomicFixtureOnly || xAccountFixtureOnly;
const metaCallbackFixture = skipMetaCallbackFixture ? null : await runMetaCallbackRejectionScenario();
if (metaCallbackFixtureOnly) {
  console.log(JSON.stringify({ ok: true, ...metaCallbackFixture }));
  process.exit(0);
}
const skipMetaCallbackAtomicFixture = coreModelFixtureOnly || providerStateFixtureOnly || googleCallbackFixtureOnly
  || googleStartFixtureOnly || twitchPortalFixtureOnly || shopifyFixtureOnly || metaStartFixtureOnly || metaAssetsFixtureOnly
  || metaCallbackFixtureOnly || xAccountFixtureOnly;
const metaCallbackAtomicFixture = skipMetaCallbackAtomicFixture ? null : await runMetaCallbackAtomicPersistenceScenario();
if (metaCallbackAtomicFixtureOnly) {
  console.log(JSON.stringify({ ok: true, ...metaCallbackAtomicFixture }));
  process.exit(0);
}
const skipGoogleStartFixture = coreModelFixtureOnly || providerStateFixtureOnly || googleCallbackFixtureOnly
  || twitchPortalFixtureOnly || shopifyFixtureOnly || metaStartFixtureOnly || metaAssetsFixtureOnly
  || metaCallbackFixtureOnly || metaCallbackAtomicFixtureOnly || xAccountFixtureOnly;
const googleStartFixture = skipGoogleStartFixture ? null : await runGoogleOAuthStartScenario();
if (googleStartFixtureOnly) {
  console.log(JSON.stringify({ ok: true, ...googleStartFixture }));
  process.exit(0);
}
const skipGoogleCallbackFixture = coreModelFixtureOnly || providerStateFixtureOnly || twitchPortalFixtureOnly
  || shopifyFixtureOnly || metaStartFixtureOnly || metaAssetsFixtureOnly || metaCallbackFixtureOnly || googleStartFixtureOnly
  || metaCallbackAtomicFixtureOnly || xAccountFixtureOnly;
const googleCallbackFixture = skipGoogleCallbackFixture ? null : await runGoogleCallbackPersistenceScenario();
if (googleCallbackFixtureOnly) {
  console.log(JSON.stringify({ ok: true, ...googleCallbackFixture }));
  process.exit(0);
}
const skipXAccountFixture = coreModelFixtureOnly || providerStateFixtureOnly || googleCallbackFixtureOnly
  || googleStartFixtureOnly || twitchPortalFixtureOnly || shopifyFixtureOnly || metaStartFixtureOnly || metaAssetsFixtureOnly
  || metaCallbackFixtureOnly || metaCallbackAtomicFixtureOnly;
const xAccountFixture = skipXAccountFixture ? null : await runXAccountBoundaryScenario();
if (xAccountFixtureOnly) {
  console.log(JSON.stringify({ ok: true, ...xAccountFixture }));
  process.exit(0);
}
const skipCredentialFixtureMatrices = coreModelFixtureOnly || providerStateFixtureOnly || metaStartFixtureOnly
  || metaAssetsFixtureOnly || metaCallbackFixtureOnly || metaCallbackAtomicFixtureOnly || googleStartFixtureOnly
  || xAccountFixtureOnly;
const twitchPortalCredentialFixture = skipCredentialFixtureMatrices ? null : await runTwitchPortalCredentialScenario();
if (!skipCredentialFixtureMatrices && twitchPortalFixtureOnly) {
  console.log(JSON.stringify({ ok: true, ...twitchPortalCredentialFixture }));
  process.exit(0);
}

const shopifyCredentialMatrix = skipCredentialFixtureMatrices ? null : await runShopifyCredentialMatrix();
if (!skipCredentialFixtureMatrices && shopifyFixtureOnly) {
  console.log(JSON.stringify({
    ok: true,
    shopifyCredentialScenarios: shopifyCredentialMatrix.count,
    shopifyCredentialExecutions: shopifyCredentialMatrix.executions,
    orderSequences: shopifyCredentialMatrix.orderSequenceCount,
    workspaceTokenSeparated: shopifyCredentialMatrix.workspaceTokenSeparated,
    callbackHmacBehavioral: shopifyCredentialMatrix.callbackHmacBehavioral,
    configuredOAuthStarts: shopifyCredentialMatrix.configuredOAuthStarts,
    cleanupComplete: shopifyCredentialMatrix.cleanupComplete,
    mixedCanonicalIdAliasSecretConfigured: shopifyCredentialMatrix.mixedCanonicalIdAliasSecretConfigured,
    externalRequests: 0
  }));
  process.exit(0);
}

const providerStateFixtureEncryptionKey = `p19-provider-state-${randomBytes(24).toString("hex")}`;

function providerStateFixtureAccounts(owner) {
  const now = new Date().toISOString();
  const credential = marker => encryptedShopifyFixtureToken(marker, providerStateFixtureEncryptionKey);
  return [
    {
      id: "acct-twitch-regression", platform: "twitch", name: "Regression Twitch", handle: "@regression_twitch",
      status: "connected", connectedAt: now, oauthProvider: "twitch", providerAccountId: "test-twitch-user-1",
      credential: credential("fake-test-token-marker"), scopes: ["user:read:email", "clips:edit", "user:read:broadcast"]
    },
    {
      id: "acct-twitch-regression-alternate", platform: "twitch", name: "Regression Twitch duplicate evidence", handle: "@regression_twitch",
      status: "connected", connectedAt: new Date(Date.now() - 60_000).toISOString(), oauthProvider: "twitch", providerAccountId: "test-twitch-user-1",
      credential: credential("fake-test-token-marker-alternate"), scopes: ["user:read:email", "clips:edit", "user:read:broadcast"]
    },
    {
      id: "acct-discord-regression", platform: "discord", name: "Regression Discord", handle: "@regression_discord",
      status: "connected", connectedAt: now, oauthProvider: "discord", providerAccountId: "test-discord-user-1",
      credential: credential("fake-test-token-marker"), scopes: ["identify", "guilds", "guilds.members.read"],
      profile: {
        discordSelectedGuildId: "test-discord-guild", discordSelectedGuildName: "Regression Guild",
        discordSelectedChannelId: "test-discord-channel", discordSelectedChannelName: "regression-channel"
      }
    },
    {
      id: "acct-x-regression", platform: "x", name: "Regression X", handle: "@regression_x", displayName: "Regression X",
      status: "connected", connectedAt: now, oauthProvider: "x", providerAccountId: "test-x-user-1",
      credential: credential("fake-test-token-marker"), scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"]
    },
    {
      id: "acct-tiktok-regression", platform: "tiktok", name: "TikTok", handle: "Regression TikTok", displayName: "Regression TikTok",
      status: "connected", connectedAt: now, oauthProvider: "tiktok", providerAccountId: "test-tiktok-user-1",
      credential: credential("fake-test-token-marker"), scopes: ["user.info.basic", "video.upload", "video.publish"]
    },
    {
      id: "acct-youtube-regression", platform: "youtube", name: "Regression YouTube", handle: "Regression YouTube", displayName: "Regression YouTube",
      status: "connected", connectedAt: now, oauthProvider: "youtube", providerAccountId: "test-youtube-channel-1",
      credential: credential("fake-test-token-marker"),
      scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/yt-analytics.readonly", "https://www.googleapis.com/auth/youtube.readonly"]
    },
    {
      id: "acct-pinterest-regression", platform: "pinterest", name: "Regression Pinterest", handle: "@regression_pinterest",
      status: "connected", connectedAt: now, oauthProvider: "pinterest", providerAccountId: "test-pinterest-user-1",
      credential: credential("fake-test-token-marker"), scopes: ["boards:read", "pins:read", "pins:write"]
    },
    {
      id: "acct-canva-regression", platform: "canva", name: "Regression Canva", handle: "Regression Canva",
      status: "connected", connectedAt: now, oauthProvider: "canva", providerAccountId: "test-canva-user-1",
      credential: credential("fake-test-token-marker"),
      scopes: ["profile:read", "design:meta:read", "design:content:read", "design:content:write", "asset:read", "asset:write", "brandtemplate:meta:read", "brandtemplate:content:read", "folder:read", "comment:read"]
    },
    {
      id: "acct-shopify-regression", platform: "shopify", name: "regression.myshopify.com", handle: "regression.myshopify.com",
      status: "connected", connectedAt: now, oauthProvider: "shopify", providerAccountId: "regression.myshopify.com",
      credential: credential("fake-test-token-marker"), scopes: ["read_products", "read_marketing_events", "write_marketing_events"]
    },
    {
      id: "acct-etsy-regression", platform: "etsy", name: "Regression Etsy", handle: "Regression Etsy",
      status: "connected", connectedAt: now, oauthProvider: "etsy", providerAccountId: "test-etsy-user-1",
      credential: credential("fake-test-token-marker"), scopes: ["shops_r", "listings_r", "listings_w"]
    },
    {
      id: "acct-meta-regression", platform: "meta", name: "Regression Meta User", handle: "Regression Meta User",
      status: "connected", connectedAt: now, oauthProvider: "meta", providerAccountId: "test-meta-user-1",
      credential: credential("fake-test-token-marker"), scopes: ["public_profile", "pages_show_list", "pages_read_engagement"]
    },
    {
      id: "acct-facebook-regression", platform: "facebook", name: "Regression Facebook Page", handle: "Regression Facebook Page", displayName: "Regression Facebook Page",
      status: "connected", connectedAt: now, oauthProvider: "meta", providerAccountId: "test-facebook-page-1",
      credential: credential("fake-test-token-marker"), scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "public_profile"]
    },
    {
      id: "acct-threads", platform: "threads", name: "Threads", handle: "@threads", status: "connected",
      connectedAt: "2026-01-01T00:00:00.000Z", oauthProvider: "threads", providerAccountId: "acct-threads",
      credential: credential("fake-stale-threads-token"), tokenExpiresAt: "2026-01-02T00:00:00.000Z", scopes: []
    },
    {
      id: "acct-threads-regression", platform: "threads", name: "Regression Threads", handle: "@regression_threads",
      status: "connected", connectedAt: now, oauthProvider: "threads", providerAccountId: "test-threads-user-1",
      credential: credential("fake-test-token-marker"),
      scopes: ["threads_basic", "threads_content_publish", "threads_manage_insights", "threads_manage_replies"],
      profile: { biography: "safe public field" }
    }
  ].map(account => ({ ...account, ownerUserId: owner.id, workspaceId: owner.workspaceId }));
}

async function mutateProviderStateFixture({ user, workspaceId, mutate }) {
  const seedSource = await readFile(new URL("./social-cues-model-seed.json", import.meta.url), "utf8");
  const seed = JSON.parse(seedSource.replace(/^\uFEFF/, ""));
  const owner = { ...user, id: String(user?.id || ""), workspaceId: String(workspaceId || "") };
  if (!owner.id || !owner.workspaceId) throw new Error("provider-state fixture is missing its canonical owner identity");
  const unavailable = () => { throw new Error("provider-state fixture must not invoke a browser merge callback"); };
  const store = await openLocalWorkspacePersistence({ dataDir: testDataDir, seed, mergeClient: unavailable, recoverClient: unavailable });
  try {
    const sharedModel = await store.load();
    const model = store.view(sharedModel, owner.workspaceId);
    await mutate(model, owner);
    await store.save(model, owner);
  } finally {
    await store.close();
  }
}

async function bindBillingCheckoutNonOwnerDeviceFixture({ owner, nonOwner }) {
  const ownerUserId = String(owner?.userId || "");
  const ownerWorkspaceId = String(owner?.workspaceId || "");
  const nonOwnerUserId = String(nonOwner?.userId || "");
  const nonOwnerDeviceId = String(nonOwner?.deviceId || "");
  const nonOwnerWorkspaceId = String(nonOwner?.workspaceId || "");
  if (!ownerUserId || !ownerWorkspaceId || !nonOwnerUserId || !nonOwnerDeviceId || !nonOwnerWorkspaceId) {
    throw new Error("billing checkout fixture is missing canonical session identity");
  }
  await mutateProviderStateFixture({
    user: { id: ownerUserId, workspaceId: ownerWorkspaceId },
    workspaceId: ownerWorkspaceId,
    mutate(model) {
      const ownerWorkspace = (model.workspaces || []).filter(workspace => (
        workspace?.id === ownerWorkspaceId && workspace?.ownerUserId === ownerUserId
      ));
      const targetDevices = (model.deviceSessions || []).filter(device => (
        device?.userId === nonOwnerUserId
        && device?.deviceId === nonOwnerDeviceId
        && !device?.revokedAt
      ));
      if (ownerWorkspace.length !== 1
        || targetDevices.length !== 1
        || targetDevices[0].workspaceId !== nonOwnerWorkspaceId) {
        throw new Error("billing checkout fixture could not bind the exact authenticated non-owner device");
      }
      targetDevices[0].workspaceId = ownerWorkspaceId;
    }
  });
}

function revisionedModelSaveEnvelope(model) {
  if (!model?.persistence?.conditionalSave || !model.persistence.revision) {
    throw new Error("revisioned model-save fixture requires the current workspace revision capability");
  }
  return {
    operationId: `test-model-save-${randomBytes(16).toString("hex")}`,
    kind: "model-save",
    expectedRevision: structuredClone(model.persistence.revision),
    request: structuredClone(model)
  };
}

const localPromoCodes = [
  { code: "SC-LOCAL-BEACON-4M7Q", label: "Local test account 1", days: 120, active: true },
  { code: "SC-LOCAL-SIGNAL-9X2P", label: "Local test account 2", days: 120, active: true },
  { code: "SC-LOCAL-PULSE-6R8N", label: "Local test account 3", days: 120, active: true },
  { code: "SC-LOCAL-LAUNCH-3V5K", label: "Local test account 4", days: 120, active: true },
  { code: "SC-LOCAL-MEMBER-8N4Q", label: "Email-bound member account", email: "mr.barton+member-promo@socialcuesapp.com", days: 120, memberOnly: true, active: true }
];
const mainTestServerEnv = {
    ...discordScenarioEnv({
      baseEnv: twitchScenarioEnv({
        baseEnv: shopifyScenarioEnv({
          baseEnv: pinterestScenarioEnv({
            PINTEREST_CLIENT_ID: "1234567",
            PINTEREST_CLIENT_SECRET: "test-pinterest-client-secret"
          }),
          overrides: {
            SHOPIFY_APP_ID: SYNTHETIC_SHOPIFY_APP_ID,
            SHOPIFY_APP_SECRET: SYNTHETIC_SHOPIFY_APP_SECRET
          }
        }),
        overrides: {
          TWITCH_CLIENT_ID: "",
          TWITCH_CLIENT_SECRET: ""
        }
      }),
      overrides: {
        DISCORD_APPLICATION_ID: SYNTHETIC_DISCORD_APPLICATION_ID,
        DISCORD_APP_SECRET: SYNTHETIC_DISCORD_CLIENT_SECRET,
        DISCORD_INTERACTIONS_PUBLIC_KEY: SYNTHETIC_DISCORD_PUBLIC_KEY
      }
    }),
    PORT: String(port),
    AUTH_PROVIDER: "alpha-local",
    SUPABASE_ENABLED: "false",
    SENTRY_DSN: "",
    SOCIAL_CUES_DATA_DIR: testDataDir,
    SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: externalRequestLogPath,
    SOCIAL_CUES_TEST_PROVIDER_MOCK_LOG: providerMockLogPath,
    SOCIAL_CUES_TEST_MOCK_META_ASSETS: "true",
    SOCIAL_CUES_TEST_META_USER_ID: "test-meta-user-1",
    SOCIAL_CUES_TEST_META_USER_TOKEN: "fake-test-token-marker",
    SOCIAL_CUES_TEST_META_PAGE_ID: "test-facebook-page-1",
    SOCIAL_CUES_TEST_META_PAGE_TOKEN: SYNTHETIC_META_ASSETS_PAGE_TOKEN,
    SOCIAL_CUES_TEST_META_INSTAGRAM_ID: SYNTHETIC_META_ASSETS_INSTAGRAM_ID,
    SOCIAL_CUES_PROMO_CODES: JSON.stringify(localPromoCodes),
    OAUTH_TOKEN_ENCRYPTION_KEY: providerStateFixtureEncryptionKey,
    WORKER_SECRET: "test-worker-secret",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    GOOGLE_PUBLIC_APP_URL: "https://socialcuesapp.com",
    META_APP_ID: "test-meta-app-id",
    META_APP_SECRET: "test-meta-app-secret",
    META_PUBLIC_APP_URL: "https://socialcuesapp.com",
    PINTEREST_ACCESS_TIER: "trial",
    CANVA_CONNECT_CLIENT_ID: "test-canva-connect-client-id",
    CANVA_CONNECT_CLIENT_SECRET: "test-canva-connect-client-secret",
    ETSY_KEYSTRING: "test-etsy-keystring",
    ETSY_SHARED_SECRET: "test-etsy-shared-secret",
    PATREON_PUBLIC_APP_URL: "https://socialcuesapp.com",
    PATREON_CLIENT_ID: "test-patreon-client-id",
    PATREON_CLIENT_SECRET: "test-patreon-client-secret",
    PATREON_OAUTH_SCOPES: "identity campaigns campaigns.members campaigns.posts w:campaigns.webhook"
};

let output = "";
let server = null;

function startMainTestServer() {
  if (server && server.exitCode === null && server.signalCode === null) throw new Error("Social Cues test server is already running");
  const child = spawn(process.execPath, [`--import=${pathToFileURL(externalRequestGuardPath).href}`, "server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: mainTestServerEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  server = child;
  return child;
}

async function stopMainTestServer() {
  const child = server;
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise(resolve => child.once("close", resolve));
    if (child.connected) child.send({ type: "social-cues-local-shutdown" });
    else child.kill();
    await Promise.race([closed, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([closed, delay(3000)]);
    }
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error("Social Cues test server did not stop");
  server = null;
}

async function restartMainTestServer() {
  await stopMainTestServer();
  startMainTestServer();
  await waitForServer();
}

startMainTestServer();

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

async function externalHttpRequestAttempts() {
  try {
    const source = await readFile(externalRequestLogPath, "utf8");
    return source.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function assertAnonymousMutationDenied(pathname, payload, label, forbiddenMarkers = []) {
  const modelFilePath = path.join(testDataDir, "model.json");
  const modelBefore = await readFile(modelFilePath);
  const requestsBefore = await externalHttpRequestAttempts();
  const response = await fetch(base + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (response.status !== 401 || result.ok !== false || !/sign in/i.test(result.error || "")) {
    throw new Error(`${label} should return a sanitized authentication-required response`);
  }
  if (Buffer.compare(await readFile(modelFilePath), modelBefore) !== 0) {
    throw new Error(`${label} changed durable workspace, queue, or job state`);
  }
  if (JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(requestsBefore)) {
    throw new Error(`${label} attempted an external provider request`);
  }
  const publicResult = JSON.stringify(result);
  if (forbiddenMarkers.some(marker => marker && publicResult.includes(marker))) {
    throw new Error(`${label} reflected an untrusted identity or credential marker`);
  }
  return result;
}

const credentialLikeOwnershipKeys = new Set([
  "credential", "refreshcredential", "token", "accesstoken", "refreshtoken",
  "encryptedtoken", "encryptedcredential", "clientsecret", "appsecret",
  "authorization", "cookie", "password", "sessiontoken", "sessiontokenhash"
]);

function containsCredentialLikeOwnershipField(value) {
  if (Array.isArray(value)) return value.some(containsCredentialLikeOwnershipField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => (
    credentialLikeOwnershipKeys.has(String(key).replace(/[_-]/g, "").toLowerCase())
    || containsCredentialLikeOwnershipField(nested)
  ));
}

function providerReceiptEvidence(model = {}, providerId = "") {
  const queued = (model.publishQueue || []).filter(item => (
    item.provider === providerId
    || item.platform === providerId
    || item.variant?.platform === providerId
  ));
  const campaignReceipts = (model.campaigns || []).flatMap(campaign => (
    (campaign.variants || [])
      .filter(variant => variant.platform === providerId)
      .flatMap(variant => variant.publishReceipts || [])
  ));
  return { queued, campaignReceipts };
}

function providerOwnershipRunStateDelta(before = {}, after = {}, expected = {}) {
  const beforeActivityIds = new Set((before.activity || []).map(item => item.id));
  const beforeProofIds = new Set((before.proof || []).map(item => item.id));
  const addedActivity = (after.activity || []).filter(item => !beforeActivityIds.has(item.id));
  const account = (after.connectedAccounts || []).find(item => (
    item.platform === expected.providerId
    && item.providerAccountId === expected.providerAccountId
  ));
  const stable = value => JSON.stringify(value ?? null);
  return {
    blockedActivityAdded: addedActivity.length === 1
      && addedActivity[0].type === "provider-ownership-run"
      && addedActivity[0].providerId === expected.providerId
      && addedActivity[0].status === "blocked"
      && addedActivity[0].ownerUserId === expected.userId
      && addedActivity[0].workspaceId === expected.workspaceId,
    accountStillConnected: Boolean(account?.connected && account?.tokenStored),
    tenancyChanged: after.currentUser?.id !== before.currentUser?.id
      || after.workspace?.id !== before.workspace?.id,
    functionCheckChanged: stable(after.functionChecks?.[expected.providerId]) !== stable(before.functionChecks?.[expected.providerId]),
    proofChanged: stable(after.proof) !== stable(before.proof),
    actionChanged: stable(after.actions) !== stable(before.actions),
    publishQueueChanged: stable(after.publishQueue) !== stable(before.publishQueue),
    providerReceiptCreated: stable(providerReceiptEvidence(after, expected.providerId)) !== stable(providerReceiptEvidence(before, expected.providerId)),
    completionRecorded: addedActivity.some(item => item.status !== "blocked")
      || (after.proof || []).some(item => !beforeProofIds.has(item.id) && /ownership .* proven/i.test(item.metric || ""))
  };
}

function manualProviderOwnershipHandoffIsSafe(fixture = {}) {
  const result = fixture.result || {};
  const queue = result.providerOwnershipQueue || {};
  const row = (queue.rows || []).find(item => item.id === fixture.expectedProviderId);
  const ownership = fixture.ownershipEvidence || {};
  const delta = fixture.stateDelta || {};
  const responseKeys = ["currentStep", "nextAction", "ok", "phase", "providerId", "providerOwnershipQueue", "status"];
  const exactResponseShape = Object.keys(result).sort().join("|") === responseKeys.sort().join("|");
  const safeAccountShape = Object.keys(row?.account || {}).sort().join("|") === "handle|name|providerAccountId";
  return Boolean(
    fixture.authenticated === true
    && fixture.httpStatus === 409
    && exactResponseShape
    && result.ok === false
    && result.providerId === fixture.expectedProviderId
    && result.status === "manual-step-required"
    && result.phase === "Configure"
    && result.currentStep?.id === "developer"
    && result.currentStep?.label === "Developer app/portal"
    && result.currentStep?.state === "blocked"
    && result.currentStep?.detail === "Missing TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET"
    && result.currentStep?.at === ""
    && typeof result.nextAction === "string"
    && result.nextAction.length > 0
    && queue.ok === true
    && queue.workspaceId === fixture.expectedWorkspaceId
    && row?.status === "connected"
    && row.phase === "Configure"
    && row.executable === false
    && row.banked === true
    && row.owned === false
    && row.currentStep?.id === "developer"
    && row.currentStep?.label === result.currentStep.label
    && row.currentStep?.state === "blocked"
    && row.currentStep?.detail === result.currentStep.detail
    && row.nextAction === result.nextAction
    && row.account?.providerAccountId === fixture.expectedProviderAccountId
    && safeAccountShape
    && ownership.workspaceId === fixture.expectedWorkspaceId
    && ownership.ownerUserId === fixture.expectedUserId
    && ownership.providerAccountId === fixture.expectedProviderAccountId
    && ownership.connected === true
    && ownership.banked === true
    && fixture.providerRequestCount === 0
    && delta.blockedActivityAdded === true
    && delta.accountStillConnected === true
    && delta.tenancyChanged === false
    && delta.functionCheckChanged === false
    && delta.proofChanged === false
    && delta.actionChanged === false
    && delta.publishQueueChanged === false
    && delta.providerReceiptCreated === false
    && delta.completionRecorded === false
    && !containsCredentialLikeOwnershipField(result)
    && !JSON.stringify(result).includes("fake-test-token-marker")
  );
}

function twitchProviderContractOwnershipIsTruthful(fixture = {}) {
  const response = fixture.response || {};
  const contract = fixture.contract || {};
  const gates = contract.gates || {};
  const account = contract.account || {};
  const queueRow = fixture.ownershipQueueRow || {};
  const ledger = contract.ledger || {};
  const publishProbe = ledger.publishProbe || {};
  const publishResult = publishProbe.result || {};
  const missing = new Set(contract.missing || []);
  const missingEnv = new Set(contract.missingEnv || []);
  const grantedScopes = new Set((account.grantedScopes || account.scopes || []).map(String));
  const expectedMissingGates = ["envReady", "portalReady", "liveReadProven", "publishDryRunProven", "reviewClear"];
  const expectedMissingEnv = ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"];
  return Boolean(
    fixture.authenticated === true
    && fixture.developerCredentialsPresent === false
    && fixture.providerRequestCount === 0
    && response.ok === true
    && response.workspaceId === fixture.expectedWorkspaceId
    && contract.id === "twitch"
    && contract.account
    && account.providerAccountId === fixture.expectedProviderAccountId
    && account.ownerUserId === fixture.expectedUserId
    && account.workspaceId === fixture.expectedWorkspaceId
    && account.connected === true
    && account.tokenStored === true
    && queueRow.id === "twitch"
    && queueRow.banked === true
    && queueRow.executable === false
    && queueRow.phase === "Configure"
    && contract.status === "banked-needs-proof"
    && contract.owned === false
    && gates.envReady === false
    && gates.portalReady === false
    && gates.oauthConnected === true
    && gates.liveReadProven === false
    && gates.publishLaneReady === true
    && gates.publishDryRunProven === false
    && gates.analyticsLaneReady === true
    && gates.reviewClear === false
    && expectedMissingGates.every(gate => missing.has(gate))
    && missing.size === expectedMissingGates.length
    && contract.truth?.configured === false
    && contract.truth?.connected === true
    && contract.truth?.tokenStored === true
    && contract.truth?.canPublish === true
    && contract.truth?.canReadAnalytics === true
    && expectedMissingEnv.every(name => missingEnv.has(name))
    && missingEnv.size === expectedMissingEnv.length
    && grantedScopes.has("user:read:email")
    && grantedScopes.has("clips:edit")
    && grantedScopes.has("user:read:broadcast")
    && ledger.status === "connected-unproven"
    && ledger.banked === false
    && publishProbe.ok === false
    && publishProbe.attempted === true
    && publishProbe.status === "blocked"
    && publishResult.dryRun === false
    && publishResult.status === "blocked"
    && /does not have a native publish adapter/i.test(publishResult.error || publishProbe.summary || "")
    && !containsCredentialLikeOwnershipField(response)
    && !JSON.stringify(response).includes("fake-test-token-marker")
  );
}

function hostedWorkspaceCacheIsIsolated(source) {
  const persistStart = source.indexOf("function persistModelSnapshot");
  const loadStart = source.indexOf("function loadModel", persistStart);
  const shellStart = source.indexOf("function hostedSessionShell", loadStart);
  const shellEnd = source.indexOf("async function syncModelFromServer", shellStart);
  if ([persistStart, loadStart, shellStart, shellEnd].some(index => index < 0) || !(persistStart < loadStart && loadStart < shellStart && shellStart < shellEnd)) return false;

  const persistSource = source.slice(persistStart, loadStart);
  const loadSource = source.slice(loadStart, shellStart);
  const shellSource = source.slice(shellStart, shellEnd);
  const persistGuard = /if\s*\(\s*SERVER_MODE\s*\)\s*\{([^{}]*)\}/.exec(persistSource);
  const loadGuard = /if\s*\(\s*SERVER_MODE\s*\)\s*\{([^{}]*)\}/.exec(loadSource);
  if (!persistGuard || !loadGuard) return false;

  const clearsHostedCache = branch => (
    /localStorage\.removeItem\(\s*STORAGE_KEY\s*\)\s*;/.test(branch)
    && /localStorage\.removeItem\(\s*LEGACY_STORAGE_KEY\s*\)\s*;/.test(branch)
    && !/localStorage\.(?:getItem|setItem)\s*\(/.test(branch)
  );
  const localPersistSource = persistSource.slice(persistGuard.index + persistGuard[0].length);
  const localLoadSource = loadSource.slice(loadGuard.index + loadGuard[0].length);
  return (
    clearsHostedCache(persistGuard[1])
    && /\breturn\s*;/.test(persistGuard[1])
    && /localStorage\.setItem\(\s*STORAGE_KEY\s*,/.test(localPersistSource)
    && clearsHostedCache(loadGuard[1])
    && /localStorage\.getItem\(\s*STORAGE_KEY\s*\)/.test(localLoadSource)
    && /return\s+normalizeModel\(\s*clone\(\s*defaultModel\s*\)\s*\)\s*;/.test(loadGuard[1])
    && /currentUser\s*:\s*auth\.user\s*\|\|\s*null/.test(shellSource)
    && /workspaces\s*:\s*auth\.workspace\s*\?\s*\[\s*auth\.workspace\s*\]\s*:\s*\[\s*\]/.test(shellSource)
    && /campaigns\s*:\s*\[\s*\]/.test(shellSource)
    && /connectedAccounts\s*:\s*\[\s*\]/.test(shellSource)
  );
}

function boundedSourceSection(source, startMarker, endMarker, fromIndex = 0) {
  const start = source.indexOf(startMarker, fromIndex);
  if (start < 0) return "";
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? "" : source.slice(start, end);
}

function namedFunctionSection(source, functionName, nextFunctionNames = []) {
  const startMarker = `function ${functionName}`;
  const start = source.indexOf(startMarker);
  if (start < 0) return "";
  const ends = nextFunctionNames
    .map(name => source.indexOf(`function ${name}`, start + startMarker.length))
    .filter(index => index >= 0);
  const end = ends.length ? Math.min(...ends) : source.length;
  return source.slice(start, end);
}

function browserControlState(source, id) {
  const escapedId = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const element = new RegExp(`<(?:button|input)\\b[^>]*\\bid=["']${escapedId}["'][^>]*>`, "i").exec(source)?.[0] || "";
  return {
    present: Boolean(element),
    disabled: Boolean(element && (/\bdisabled(?:\s*=\s*(?:["']disabled["']|["']?["']|true))?/i.test(element) || /\baria-disabled=["']true["']/i.test(element)))
  };
}

function browserPaymentSafetyContract({ appSource, serverSource, modelSeedSource }) {
  const createCheckoutSource = namedFunctionSection(appSource, "createCheckout", ["manageSubscription"]);
  const manageSubscriptionSource = namedFunctionSection(appSource, "manageSubscription", ["providerTruthPill"]);
  const renderBillingSource = namedFunctionSection(appSource, "renderBilling", ["loadBillingStatus"]);
  const safeOpenerSource = namedFunctionSection(appSource, "openSafeExternalUrl", ["safeRedditHostedUrl"]);
  const paymentOpenerSource = namedFunctionSection(appSource, "openPaymentUrl", ["copyTextValue"]);
  const paymentHandlersSource = `${createCheckoutSource}\n${manageSubscriptionSource}`;
  const checkoutControl = browserControlState(appSource, "createCheckout");
  const portalControl = browserControlState(appSource, "manageSubscription");
  const portalPageControl = browserControlState(serverSource, "portalCheckout");
  const activeCheckoutRequest = /(?:authedFetch|fetch)\s*\(\s*["'`]\/api\/billing\/checkout["'`]/.test(createCheckoutSource);
  const activePortalRequest = /(?:authedFetch|fetch)\s*\(\s*["'`]\/api\/billing\/portal["'`]/.test(manageSubscriptionSource);
  const paymentUrlConsumed = /\b(?:openPaymentUrl|openSafeExternalUrl)\s*\(\s*(?:result|payload)\.url\b/.test(paymentHandlersSource);
  const paymentLinkAuthority = /\b(?:openPaymentUrl|openSafeExternalUrl|window\.open)\s*\([^)]*\bpaymentLink\b/i.test(paymentHandlersSource)
    || /(?:window\.)?location(?:\.href\s*=|\.(?:assign|replace)\s*\()[^;]*\bpaymentLink\b/i.test(paymentHandlersSource);
  const paymentHostPresent = /(?:checkout|buy)\.stripe\.com/i.test(appSource);
  const directNavigationSink = /\bwindow\.open\s*\(|(?:window\.)?location(?:\.href\s*=|\.(?:assign|replace)\s*\()/;
  const livePaymentNavigation = activeCheckoutRequest
    || activePortalRequest
    || paymentUrlConsumed
    || paymentLinkAuthority
    || paymentHostPresent
    || (checkoutControl.present && !checkoutControl.disabled)
    || (portalControl.present && !portalControl.disabled);
  const result = {
    mode: livePaymentNavigation ? "payment-navigation" : "fail-closed",
    assertions: 0,
    safeOpenerAssertions: 0,
    failClosedAssertions: 0
  };
  const check = (condition, message, category) => {
    result.assertions += 1;
    if (category === "safe-opener") result.safeOpenerAssertions += 1;
    if (category === "fail-closed") result.failClosedAssertions += 1;
    if (!condition) throw new Error(message);
  };

  if (livePaymentNavigation) {
    const checkoutRequestStart = createCheckoutSource.indexOf('/api/billing/checkout');
    const checkoutRequestEnd = createCheckoutSource.indexOf("const result", checkoutRequestStart);
    const checkoutRequestSource = checkoutRequestStart >= 0 && checkoutRequestEnd > checkoutRequestStart
      ? createCheckoutSource.slice(checkoutRequestStart, checkoutRequestEnd)
      : "";
    const checkoutHostMentions = (appSource.match(/checkout\.stripe\.com/gi) || []).length;
    const buyHostMentions = (appSource.match(/buy\.stripe\.com/gi) || []).length;
    check(activeCheckoutRequest, "live payment mode must retain the checkout request", "safe-opener");
    check(activePortalRequest, "live payment mode must retain the billing-portal request", "safe-opener");
    check(checkoutControl.present && !checkoutControl.disabled, "live checkout must use an enabled checkout control", "safe-opener");
    check(portalControl.present && !portalControl.disabled, "live billing management must use an enabled portal control", "safe-opener");
    check(/\bopenPaymentUrl\s*\(\s*result\.url\s*\)/.test(createCheckoutSource), "checkout URLs must pass through the payment safe opener", "safe-opener");
    check(/\bopenPaymentUrl\s*\(\s*payload\.url\s*\)/.test(manageSubscriptionSource), "portal URLs must pass through the payment safe opener", "safe-opener");
    check(Boolean(paymentOpenerSource), "live payment navigation requires a dedicated payment opener", "safe-opener");
    check(/openSafeExternalUrl\s*\(\s*url\s*,\s*\[\s*"checkout\.stripe\.com"\s*,\s*"buy\.stripe\.com"\s*\]\s*\)/.test(paymentOpenerSource), "payment links must use only the approved Stripe hosts", "safe-opener");
    check(/parsed\.protocol\s*!==\s*"https:"/.test(safeOpenerSource), "the payment safe opener must require HTTPS", "safe-opener");
    check(/allowedHosts\.length\s*&&\s*!allowedHosts\.includes\(parsed\.hostname\)/.test(safeOpenerSource), "the payment safe opener must reject unapproved hosts", "safe-opener");
    check(/throw new Error\("This link is not on the approved host list\."\)/.test(safeOpenerSource), "the payment safe opener must fail closed on an unapproved host", "safe-opener");
    check(/window\.open\(parsed\.toString\(\),\s*"_blank",\s*"noopener,noreferrer"\)/.test(safeOpenerSource), "approved payment links must open with noopener and noreferrer", "safe-opener");
    check(/catch\s*\(error\)\s*\{[\s\S]*alert\(error\.message/.test(safeOpenerSource), "payment opener failures must not fall back to unsafe navigation", "safe-opener");
    check(!directNavigationSink.test(paymentHandlersSource), "payment handlers must not navigate around the approved-host opener", "safe-opener");
    check(!directNavigationSink.test(paymentOpenerSource), "the dedicated payment opener must delegate instead of navigating directly", "safe-opener");
    check(checkoutHostMentions === 1 && buyHostMentions === 1, "approved payment hosts must not be reused as alternate navigation paths", "safe-opener");
    check(Boolean(checkoutRequestSource) && !/\bpaymentLink\b/i.test(checkoutRequestSource), "browser-provided paymentLink values must not become checkout authority", "safe-opener");
    check(!appSource.includes('id="paymentLinkInput"'), "live payment mode must not accept a browser-provided payment link", "safe-opener");
    return result;
  }

  let modelSeed;
  try {
    modelSeed = JSON.parse(modelSeedSource);
  } catch {
    throw new Error("fail-closed payment mode requires a valid model seed");
  }
  const pricingPresentationSource = namedFunctionSection(serverSource, "currentPricingPresentation", ["unavailablePricingEnvelope"]);
  const checkoutUnavailable = /checkout\s*:\s*\{\s*available\s*:\s*false\s*,\s*status\s*:\s*"unavailable"\s*\}/.test(pricingPresentationSource);
  const activationUnavailable = /billingActivation\s*:\s*\{\s*available\s*:\s*false\s*,\s*status\s*:\s*"unavailable"\s*\}/.test(pricingPresentationSource);
  const inertHandler = source => Boolean(source)
    && /button\.disabled\s*=\s*true/.test(source)
    && /unavailable/i.test(source)
    && !/(?:authedFetch|fetch)\s*\(/.test(source)
    && !/\b(?:openPaymentUrl|openSafeExternalUrl|window\.open)\s*\(/.test(source)
    && !/(?:window\.)?location(?:\.href\s*=|\.(?:assign|replace)\s*\()/.test(source);
  check(!activeCheckoutRequest && !appSource.includes('/api/billing/checkout'), "fail-closed payment mode must not request checkout", "fail-closed");
  check(!activePortalRequest && !appSource.includes('/api/billing/portal'), "fail-closed payment mode must not request the billing portal", "fail-closed");
  check(!paymentUrlConsumed && !/\b(?:result|payload)\.url\b/.test(paymentHandlersSource), "fail-closed payment handlers must not consume a payment URL", "fail-closed");
  check(!paymentLinkAuthority && !/\bpaymentLink\b/i.test(appSource), "fail-closed browser code must not consume paymentLink authority", "fail-closed");
  check(!paymentHostPresent, "fail-closed browser code must not contain a Stripe checkout host", "fail-closed");
  check(!directNavigationSink.test(paymentHandlersSource), "fail-closed payment handlers must not navigate directly", "fail-closed");
  check((!checkoutControl.present || checkoutControl.disabled) && (!portalControl.present || portalControl.disabled), "fail-closed payment controls must be absent or disabled", "fail-closed");
  check((!checkoutControl.present || /checkoutButton\.disabled\s*=\s*true/.test(renderBillingSource)) && (!portalControl.present || /portalButton\.disabled\s*=\s*true/.test(renderBillingSource)), "rendering must keep payment controls disabled", "fail-closed");
  check(!checkoutControl.present || inertHandler(createCheckoutSource), "the disabled checkout handler must remain inert", "fail-closed");
  check(!portalControl.present || inertHandler(manageSubscriptionSource), "the disabled billing-portal handler must remain inert", "fail-closed");
  check(serverSource.includes('url.pathname === "/api/pricing" && req.method === "GET"'), "fail-closed pricing must come from the public pricing API", "fail-closed");
  check(checkoutUnavailable, "the pricing API must mark checkout unavailable", "fail-closed");
  check(activationUnavailable, "the pricing API must mark billing activation unavailable", "fail-closed");
  check(!portalPageControl.present || portalPageControl.disabled, "the account portal payment control must remain absent or disabled", "fail-closed");
  check(modelSeed?.billing?.checkoutMode === "unavailable", "the model seed must mark checkout unavailable", "fail-closed");
  check(!Object.hasOwn(modelSeed?.billing || {}, "paymentLink"), "the model seed must not carry a payment link", "fail-closed");
  check(!/\b(?:STRIPE_PRICE_[A-Z0-9_]+|price_[A-Za-z0-9_]+)\b/.test(appSource), "the browser presentation must not contain a Stripe price ID", "fail-closed");
  check(!/(?:checkout|buy)\.stripe\.com/i.test(`${appSource}\n${modelSeedSource}`), "the browser presentation and seed must not contain a payment URL", "fail-closed");
  return result;
}

function assertBrowserPaymentSafetyMutations(sources, mode) {
  let checks = 0;
  const reject = (label, mutatedSources) => {
    checks += 1;
    try {
      browserPaymentSafetyContract(mutatedSources);
    } catch {
      return;
    }
    throw new Error(`payment safety contract accepted unsafe mutation: ${label}`);
  };
  const appSource = sources.appSource;
  if (mode === "payment-navigation") {
    const paymentOpenerSource = namedFunctionSection(appSource, "openPaymentUrl", ["copyTextValue"]);
    reject("payment opener removed while navigation remains", { ...sources, appSource: appSource.replace(paymentOpenerSource, "") });
    reject("checkout response paymentLink opened directly", { ...sources, appSource: appSource.replace("openPaymentUrl(result.url);", 'window.open(result.paymentLink, "_blank");') });
    reject("approved payment hosts replaced", { ...sources, appSource: appSource.replace('["checkout.stripe.com", "buy.stripe.com"]', '["payments.example"]') });
    reject("host rejection removed", { ...sources, appSource: appSource.replace("if (allowedHosts.length && !allowedHosts.includes(parsed.hostname))", "if (false)") });
    reject("only portal navigation remains active", { ...sources, appSource: appSource.replace('/api/billing/checkout', '/api/billing/status') });
    return checks;
  }

  reject("checkout request restored without a safe opener", { ...sources, appSource: appSource.replace('showAppResult("Checkout unavailable"', 'authedFetch("/api/billing/checkout"); showAppResult("Checkout unavailable"') });
  reject("paymentLink consumed directly", { ...sources, appSource: appSource.replace('showAppResult("Checkout unavailable"', 'window.open(model.billing.paymentLink, "_blank"); showAppResult("Checkout unavailable"') });
  reject("checkout control enabled without navigation safety", { ...sources, appSource: appSource.replace('id="createCheckout" disabled', 'id="createCheckout"') });
  reject("portal alone restored while checkout stays disabled", { ...sources, appSource: appSource.replace('showAppResult("Billing portal unavailable"', 'authedFetch("/api/billing/portal"); showAppResult("Billing portal unavailable"') });
  reject("pricing API claims checkout is available", { ...sources, serverSource: sources.serverSource.replaceAll('checkout: { available: false, status: "unavailable" }', 'checkout: { available: true, status: "available" }') });
  reject("unavailable labels used without seed and activation proof", {
    ...sources,
    serverSource: sources.serverSource.replace('billingActivation: { available: false, status: "unavailable" }', 'billingActivation: { available: true, status: "available" }'),
    modelSeedSource: sources.modelSeedSource.replace('"checkoutMode": "unavailable"', '"checkoutMode": "available"')
  });
  return checks;
}

function discordQueuedAnnouncementAdapterIsNative(source) {
  const discoverySource = boundedSourceSection(source, "async function discoverWorkerJobs", "async function claimWorkerJobs");
  const scheduledWorkerSource = boundedSourceSection(source, "async function processScheduledPublishWorkerJob", "async function processProviderPublishStatusWorkerJob");
  const workerDispatchSource = boundedSourceSection(source, "async function processWorkerJob", "async function runDurableWorkerTick");
  const adapterSource = boundedSourceSection(source, "async function attemptQueuedVariantPublish", "function rememberPublishAttempt");
  const discordSource = boundedSourceSection(adapterSource, 'if (item.variant.platform === "discord")', 'if (item.variant.platform === "linkedin")');
  if (!discoverySource || !scheduledWorkerSource || !workerDispatchSource || !discordSource) return false;

  return (
    /kind\s*:\s*"scheduled_publish"/.test(discoverySource)
    && /platform\s*:\s*row\.platform/.test(discoverySource)
    && /attemptQueuedVariantPublish\(\s*model\s*,\s*item\s*,\s*\{\s*live\s*:\s*true\s*,\s*user\s*\}\s*\)/.test(scheduledWorkerSource)
    && /job\.kind\s*===\s*"scheduled_publish"\s*\)\s*return\s+processScheduledPublishWorkerJob\(\s*job\s*,\s*registry\s*\)\s*;/.test(workerDispatchSource)
    && /selectedProviderAccount\(\s*model\s*,\s*"discord"\s*,\s*options\.user\s*\|\|\s*null\s*\)/.test(discordSource)
    && /!account\s*\|\|\s*!isRealConnectedAccount\(account\)\s*\|\|\s*!tokenForDiscordAccount\(account\)/.test(discordSource)
    && /if\s*\(\s*!discordBotToken\s*\)/.test(discordSource)
    && /target\s*=\s*discordSavedTarget\(\s*account\s*,\s*\{\s*\}\s*\)/.test(discordSource)
    && /if\s*\(\s*live\s*\)\s*await\s+authorizedDiscordGuild\(\s*tokenForDiscordAccount\(account\)\s*,\s*target\.guildId/.test(discordSource)
    && /if\s*\(\s*!live\s*\)\s*return\s*\{\s*ok\s*:\s*true\s*,\s*provider\s*:\s*"discord"\s*,\s*dryRun\s*:\s*true\b/.test(discordSource)
    && /discordApi\(\s*`\/channels\/\$\{target\.channelId\}\/messages`\s*,/.test(discordSource)
    && /allowed_mentions\s*:\s*\{\s*parse\s*:\s*\[\s*\]\s*\}/.test(discordSource)
    && /\{\s*method\s*:\s*"POST"\s*,\s*authScheme\s*:\s*"Bot"\s*\}/.test(discordSource)
    && /provider\s*:\s*"discord"\s*,\s*dryRun\s*:\s*false\b/.test(discordSource)
    && /providerPostId\s*:\s*response\.id\s*\|\|\s*null/.test(discordSource)
  );
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
  const redditSplashSource = await readFile(new URL("./reddit-devvit/social-cues-app/src/client/splash.tsx", import.meta.url), "utf8");
  const redditGameSource = await readFile(new URL("./reddit-devvit/social-cues-app/src/client/game.tsx", import.meta.url), "utf8");
  if (!redditSplashSource.includes("fetch('/api/comments')") || !redditSplashSource.includes("state.summary.loadedComments") || !redditSplashSource.includes("requestExpandedMode(event.nativeEvent, 'game')")) {
    throw new Error("Reddit inline view must show the live comment count and expand into the thread reader");
  }
  if (!redditGameSource.includes('state.isModerator && <aside className="audit-panel">') || !redditGameSource.includes("state.moderatorPermissions") || !redditGameSource.includes("state.moderationCapabilities")) {
    throw new Error("Reddit moderator information must stay inside the moderator-only expanded view");
  }
  if (!appHtml.includes("Choose image or video") || !appHtml.includes("Use coming-soon asset") || !appHtml.includes('accept="image/*,video/*"')) throw new Error("publish media UI must expose a general image/video picker and keep the approved launch asset optional");
  for (const quickPostContract of ['data-studio-mode="post"', 'id="quickPostMediaInput"', 'id="prepareQuickPostOne"', 'id="prepareQuickPostEverywhere"', "function prepareQuickPost", "function quickPostDescription", "function renderQuickPosts"]) {
    if (!appHtml.includes(quickPostContract)) throw new Error(`quick post foreground contract missing: ${quickPostContract}`);
  }
  for (const quickPostDestination of ['"reddit"', '"patreon"', '"tiktok"', '"x"', '"linkedin"', '"pinterest"', '"discord"', '"google_business"', '"shopify"', '"etsy"', '"twitch"']) {
    if (!appHtml.includes("quickPostDistributionPlatformIds") || !appHtml.includes(quickPostDestination)) {
      throw new Error(`quick post everywhere destination missing: ${quickPostDestination}`);
    }
  }
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
  const modelSeedSource = await readFile(new URL("./social-cues-model-seed.json", import.meta.url), "utf8");
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
  if (!serverSource.includes("async function enforceHostedApiAccess") || !serverSource.includes('return "entitled";') || !serverSource.includes('if (!(await enforceHostedApiAccess(req, res, url))) return;')) throw new Error("hosted APIs must use a deny-by-default server-side access boundary");
  if (!serverSource.includes('"/api/auth/login"') || !serverSource.includes('"/api/meta/webhook"') || !serverSource.includes('"/api/meta/data-deletion"') || !serverSource.includes('"/api/meta/deauthorize"') || !serverSource.includes('pathname.startsWith("/api/media/provider/")')) throw new Error("public auth, signed provider callbacks, compliance routes, and expiring provider media must remain explicitly allowlisted");
  if (!serverSource.includes('"/api/security/audit"') || !serverSource.includes('accessLevel === "operator"') || !serverSource.includes("socialCuesProviderOperator(session.user)")) throw new Error("internal diagnostics must require the Social Cues owner role");
  if (!serverSource.includes('status: "healthy"') || serverSource.includes("supabaseConfigured: supabaseEnabled")) throw new Error("public health output must not advertise internal persistence or provider configuration");
  if (!vercelConfigSource.includes('"server.mjs"') || vercelConfigSource.includes('"api/server.mjs"') || vercelConfigSource.includes('"routes"')) throw new Error("Vercel must use the single root server entrypoint without a stale catch-all function route");
  if (!serverSource.includes("promo.email !== normalizedEmail") || !serverSource.includes("memberOnly: Boolean(promo.memberOnly)") || !serverSource.includes("if (entitlement.memberOnly) return \"Member\"") || !serverSource.includes("const assignedMemberPromo = testPromoCodes.find")) throw new Error("email-bound member promo codes must not inherit owner/admin access");
  if (!serverSource.includes("REDDIT_DEVVIT_PROJECT_READY") || !serverSource.includes("redditDevvitProjectDeclaredReady") || !serverSource.includes('if (runtimeMode === "vercel") return redditDevvitProjectDeclaredReady')) throw new Error("production Reddit readiness must use verified flags instead of packaging the Devvit toolchain");
  if (serverSource.includes("promoFromSupabaseUser") || /raw_user_meta_data[\s\S]{0,400}promo/i.test(serverSource)) throw new Error("user-editable Supabase metadata must never grant promo authorization");
  const authPolicyStart = serverSource.indexOf("function authenticationExecutionMode");
  const authPolicyEnd = serverSource.indexOf("function supabaseAuthEnabled", authPolicyStart);
  const authPolicySource = serverSource.slice(authPolicyStart, authPolicyEnd);
  const upsertSupabaseStart = serverSource.indexOf("function upsertSupabaseAppUser");
  const createAccountStart = serverSource.indexOf("async function createAppAccount", upsertSupabaseStart);
  const loginAccountStart = serverSource.indexOf("async function loginAppAccount", createAccountStart);
  const deviceSessionStart = serverSource.indexOf("function upsertDeviceSession", loginAccountStart);
  const providerUserSource = serverSource.slice(upsertSupabaseStart, createAccountStart);
  const createAccountSource = serverSource.slice(createAccountStart, loginAccountStart);
  const loginAccountSource = serverSource.slice(loginAccountStart, deviceSessionStart);
  const sessionValidatorStart = serverSource.indexOf("function requireSupabaseAuthenticatedSession");
  const signupValidatorStart = serverSource.indexOf("function requireSupabaseSignupResult", sessionValidatorStart);
  const failureMapperStart = serverSource.indexOf("function publicAuthenticationFailure", signupValidatorStart);
  const sessionValidatorSource = serverSource.slice(sessionValidatorStart, signupValidatorStart);
  const signupValidatorSource = serverSource.slice(signupValidatorStart, failureMapperStart);
  if ([authPolicyStart, authPolicyEnd, upsertSupabaseStart, createAccountStart, loginAccountStart, deviceSessionStart, sessionValidatorStart, signupValidatorStart, failureMapperStart].some(index => index < 0)) throw new Error("hosted authentication security boundaries are missing");
  if (!serverSource.includes('const authProvider = String(process.env.AUTH_PROVIDER || "supabase")')) throw new Error("local password authentication must require an explicit alpha-local provider selection");
  if (!authPolicySource.includes('runtimeMode === "vercel"') || !authPolicySource.includes('supabaseAuthReady() ? "supabase" : "unavailable"') || !authPolicySource.includes('authProvider === "supabase"')) throw new Error("hosted and explicitly selected Supabase authentication must fail closed when readiness is incomplete");
  if (createAccountSource.indexOf('authMode === "unavailable"') < 0 || createAccountSource.indexOf('authMode === "unavailable"') > createAccountSource.indexOf("hashPassword(password)")) throw new Error("signup must reject unavailable hosted authentication before local hashing");
  if (createAccountSource.split("hashPassword(password)").length !== 2 || createAccountSource.indexOf('if (authMode === "local-password")') > createAccountSource.indexOf("hashPassword(password)")) throw new Error("signup hashing must exist only in the explicit local-password branch");
  if (loginAccountSource.split("verifyPassword(password").length !== 2 || loginAccountSource.indexOf('if (authMode === "local-password")') > loginAccountSource.indexOf("verifyPassword(password")) throw new Error("password verification must exist only in the explicit local-password branch");
  if (!loginAccountSource.includes('return publicAuthenticationFailure("login", error);') || loginAccountSource.indexOf('return publicAuthenticationFailure("login", error);') > loginAccountSource.indexOf('if (authMode === "local-password")')) throw new Error("Supabase login failures must return before the local-password branch");
  if (!providerUserSource.includes("requireSupabaseUserIdentity(supabaseUser)") || providerUserSource.includes('supabaseUser?.id || uid("user")') || providerUserSource.includes("supabaseUser?.email || input.email")) throw new Error("provider persistence must require a validated identity without synthesized ids or email fallbacks");
  if (!sessionValidatorSource.includes("requireSupabaseUserIdentity(value.user") || !sessionValidatorSource.includes("value.access_token") || !sessionValidatorSource.includes("!accessToken")) throw new Error("hosted login must require a provider user and nonblank access token");
  if (!signupValidatorSource.includes("needsEmailVerification: true") || !signupValidatorSource.includes("if (!accessToken)") || !signupValidatorSource.includes("if (!confirmed)")) throw new Error("verification-required signup must remain separate from authenticated signup");
  if (serverSource.includes("Supabase failed, so try the local password.")) throw new Error("provider failures must never introduce a local-password fallback");
  if (!serverSource.includes('ready: checkoutReady && webhookReady') || !serverSource.includes('if (runtimeMode === "vercel" && !stripeWebhookSecret)')) throw new Error("Stripe must not accept hosted checkout before signed entitlement webhooks are configured");
  if (serverSource.includes("Stripe Checkout is live") || !serverSource.includes('id="portalCheckout" disabled') || !serverSource.includes('button.textContent = billing.ready ? "Pay or manage checkout" : "Payments opening soon"')) throw new Error("public payment controls must reflect verified billing readiness instead of exposing a dead checkout");
  if (/localStorage\.setItem\(STORAGE_KEY,\s*JSON\.stringify\(model\)\)/.test(appHtml) || /body:\s*JSON\.stringify\(model\)/.test(appHtml)) throw new Error("browser model persistence must use sanitized snapshots");
  if (!appHtml.includes("SENSITIVE_BROWSER_STORAGE_KEYS") || !appHtml.includes("scrubBrowserStorageValue") || !appHtml.includes("persistModelSnapshot") || !appHtml.includes("sanitizedModelSnapshot(model)")) throw new Error("browser model storage scrubber missing");
  if (!serverSource.includes('url.pathname === "/api/responses"') || !serverSource.includes('url.pathname === "/api/responses/actions"') || !appHtml.includes("function updateDurableResponse")) throw new Error("durable response inbox and customer actions are incomplete");
  if (!responseIntelligenceMigrationSource.includes("create table if not exists public.response_events") || !responseIntelligenceMigrationSource.includes("create policy server_only_deny_all") || !responseIntelligenceMigrationSource.includes("revoke all on table public.response_events from public, anon, authenticated")) throw new Error("response intelligence storage must remain explicitly server-only");
  if (!serverSource.includes('url.pathname === "/api/push/subscribe"') || !serverSource.includes("encrypted_subscription: encryptedToken") || !appHtml.includes('id="togglePushNotifications"') || !serviceWorkerSource.includes('self.addEventListener("push"')) throw new Error("encrypted per-device push notifications are incomplete");
  if (!serverSource.includes('job.kind === "analytics_collection"') || !serverSource.includes('job.kind === "audience_brief"') || !serverSource.includes("social-cues-evidence-rules-v1")) throw new Error("scheduled analytics and evidence-only audience brief workers are incomplete");
  const paymentSafetySources = { appSource: appHtml, serverSource, modelSeedSource };
  const paymentSafety = browserPaymentSafetyContract(paymentSafetySources);
  const paymentSafetyMutationChecks = assertBrowserPaymentSafetyMutations(paymentSafetySources, paymentSafety.mode);
  console.log(JSON.stringify({ paymentSafety: { ...paymentSafety, mutationChecks: paymentSafetyMutationChecks } }));
  if (!appHtml.includes('.replaceAll("\'", "&#39;")')) throw new Error("HTML escaping must encode apostrophes");
  if (!serverSource.includes("SOCIAL_CUES_DATA_DIR") || !serverSource.includes("model.invalid-") || !serverSource.includes("await rename(tempPath, modelPath)") || !serverSource.includes("Recovered malformed local model.json")) throw new Error("local model persistence should isolate tests, recover malformed JSON, and write atomically");
  if (!serverSource.includes("function normalizeBrandHashtags") || !serverSource.includes("brandKitTagList") || !serverSource.includes("model.brandKit || {}")) throw new Error("server-side brand kit copy support is missing");
  if (!serverSource.includes("function resolvedAppUserRole")) throw new Error("resolved app-user role helper is missing");
  if (!/workspace_members\?on_conflict=workspace_id,user_id"[\s\S]{0,320}role: "owner"/.test(serverSource)) throw new Error("private workspace persistence must keep the account owner as the workspace owner");
  if (!serverSource.includes("async function requireWorkspaceManagementAccess") || !serverSource.includes("&user_id=eq.${encodeURIComponent(userId)}") || !serverSource.includes("managementAccess.workspaceId")) throw new Error("workspace management must require the active user's exact owner or admin membership");
  if (!serverSource.includes("merged.workspace = workspaceForUser(workspaceModel, user)")) throw new Error("session hydration must keep the private workspace identity instead of replacing it with the shared registry label");
  if (!appHtml.includes("Account health") || !appHtml.includes('id="accountHealthSummary"') || !appHtml.includes("Refresh insights")) throw new Error("account page should use the customer-facing account health summary");
  if (!appHtml.includes('data-manychat-connect') || !appHtml.includes('type="password"') || !appHtml.includes('authedFetch("/api/manychat/connect"')) throw new Error("Manychat should connect through an authenticated password-style key control");
  if (!appHtml.includes('data-manychat-profile-connect') || !appHtml.includes('data-manychat-template-generate') || !appHtml.includes('authedFetch("/api/manychat/profile/connect"') || !appHtml.includes('authedFetch("/api/manychat/template-link"')) throw new Error("Manychat Profile API must have a distinct template-link connection instead of being submitted as an Account API token");
  if (!appHtml.includes("Two different Manychat connections") || !appHtml.includes("Profile API key - templates only") || !serverSource.includes("looksLikeManychatProfileApiKey") || !serverSource.includes("Manychat accepted the Profile API credential, but the template is unavailable")) throw new Error("Manychat must identify Profile keys and explain the channel/template prerequisite instead of returning a generic wrong-token error");
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
  if (!/async function sessionFromRequest[\s\S]{0,300}const authMode = authenticationExecutionMode\(\);[\s\S]{0,300}if \(authMode === "supabase"\) \{[\s\S]{0,200}normalizedDeviceSessionByTokenHash/.test(serverSource)) throw new Error("Supabase sessions must trust the normalized device record before any stale shared registry entry");
  if (!/async function persistNormalizedDeviceAuthState[\s\S]{0,4000}on_conflict=user_id,device_id/.test(serverSource) || !/async function persistNormalizedDeviceAuthState[\s\S]{0,800}preserveDurableRevocation/.test(serverSource)) throw new Error("device auth writes must create new devices without resurrecting durable revocations");
  if (!/async function persistNormalizedDeviceAuthState[\s\S]{0,3200}method: "PATCH"[\s\S]{0,500}return=representation[\s\S]{0,500}Device session revocation did not persist/.test(serverSource)) throw new Error("existing device changes must use a verified owner-and-device update");
  if (!/normalizedDeviceSessionByTokenHash[\s\S]{0,500}model\.deviceSessions = \[[\s\S]{0,500}\.filter\(item =>/.test(serverSource)) throw new Error("normalized session lookup must replace a stale registry copy instead of duplicating the device");
  if (!/function buildGrowthAnalytics[\s\S]{0,500}if \(!connected\.length\)[\s\S]{0,500}status: "Waiting for connected accounts"[\s\S]{0,500}metrics: \[\]/.test(serverSource)) throw new Error("unconnected customer workspaces must not receive internal readiness metrics as analytics");
  if (!appHtml.includes("data-device-revoke") || !appHtml.includes("function revokeRememberedDevice") || !appHtml.includes("Sign out device")) throw new Error("Devices must expose a customer-facing sign-out control for remembered devices");
  if (!serverSource.includes("const [rows, normalizedRows] = await Promise.all") || !serverSource.includes("name: normalizedWorkspace.name")) throw new Error("workspace loading must preserve the normalized customer workspace name");
  if (!serverSource.includes("hasLegacySharedWorkspaceContamination") || !serverSource.includes('source: "legacy-shared-seed-quarantine"')) throw new Error("legacy shared-seed workspaces must be quarantined before customer delivery");
  if (/async function ensureWorkspaceBootstrap[\s\S]{0,500}getSeedModel\(\)/.test(serverSource)) throw new Error("customer workspace bootstrap must never clone the shared product seed");
  if (!/async function clientWorkspaceModelForUser[\s\S]{0,2600}activeCampaignId: ""[\s\S]{0,100}campaigns: \[\][\s\S]{0,100}quickPosts: \[\][\s\S]{0,100}actions: \[\]/.test(serverSource) || /async function ensureWorkspaceBootstrap[\s\S]{0,1800}model\.campaigns\.push/.test(serverSource)) throw new Error("new customer workspaces must remain blank across creation and bootstrap");
  if (!serverSource.includes("function blankClientIntegrations") || !serverSource.includes("copySharedRegistryFields(model, sharedModel, { includeIntegrations: false })")) throw new Error("new customer workspaces must not inherit another user's provider-status labels");
  if (!/activeCampaignId: "",\s*campaigns: \[\]/.test(appHtml)) throw new Error("the browser default must not invent a starter campaign");
  if (/const first = defaultModel\.campaigns\[0\]/.test(appHtml)) throw new Error("browser boot must not generate content from a nonexistent starter campaign");
  if (!serverSource.includes('safe.deviceSessions = [];') || !serverSource.includes('source: "client-isolated-workspace"')) throw new Error("workspace snapshots must exclude device security records and remain explicitly isolated");
  if (!hostedWorkspaceCacheIsIsolated(appHtml)) throw new Error("hosted browsers must not persist a cross-account workspace cache");
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
  if (!appHtml.includes("quickPostNativeQueuePlatformIds") || !appHtml.includes("quickPostVariantCanApprove") || !appHtml.includes("This stays a draft until a verified delivery workflow is available.")) throw new Error("Quick Post must keep unverified delivery adapters out of the live queue");
  if (!appHtml.includes("campaignVariantCanApprove") || !appHtml.includes("campaign copy and media are prepared")) throw new Error("Campaign approvals must keep draft-only provider workflows out of the live publishing queue");
  if (!appHtml.includes("await saveCampaignFromForm();") || !appHtml.includes("return saveModel(`Saved campaign:")) throw new Error("campaign generation must wait for the current form save before replacing platform variants");
  if (appHtml.includes("return rows.slice(0, 8);") || !appHtml.includes("metaState.redditStatus?.commandThreadUrl")) throw new Error("Quick Post link directories must not silently truncate connected destinations and should include the Reddit command thread");
  if (!appHtml.includes("quickPostVariantCard(batch, variant, index === 0)") || !appHtml.includes("Shared media:") || !appHtml.includes("resolveQuickPostPrivatePreview")) throw new Error("Quick Post everywhere packs should resolve and render one shared private media preview instead of downloading the same asset for every destination");
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
  if ((appHtml.match(/addEventListener\("click", \(\) => openConnectorRoute/g) || []).length) throw new Error("provider connector buttons must use only the delegated click handler so one tap starts one OAuth flow");
  if ((appHtml.match(/const functionConnectorButton = event\.target\.closest\("\.connector-route"\)/g) || []).length !== 1) throw new Error("provider connector buttons should have exactly one delegated OAuth navigation handler");
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
  if (!appHtml.includes("function customerDeliveryLedgerRows") || !appHtml.includes("function deliveryHistoryCard") || !appHtml.includes("provider receipt") || !appHtml.includes("Array.isArray(model.publishQueue)")) throw new Error("customer Calendar and Dashboard should surface durable normalized delivery history and provider receipt evidence");
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
  if (!appHtml.includes("const connected = Boolean(connectionState.connected)")) throw new Error("provider evidence merge should use computed connection truth from token, status, and identity evidence");
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
  if (!/function mirrorNormalizedWorkspaceRows[\s\S]*?const normalizedConnectedAccounts = dedupeProviderAccounts\(visibleConnectedAccounts\(model\)\)[\s\S]*?for \(const account of normalizedConnectedAccounts\)/.test(serverSource)) throw new Error("normalized provider persistence must omit stale placeholders and duplicate assets when a real provider identity exists");
  if (!serverSource.includes("cleanupNormalizedProviderPlaceholders") || !serverSource.includes("reconcileProviderAccountEvidence")) throw new Error("provider persistence must remove invalid placeholder siblings after a verified identity is stored");
  if (!serverSource.includes("connectionReason: connectionState.reason") || !serverSource.includes("scopeEvidence: { requested: requestedScopes, granted: grantedScopes, missing: missingScopes }") || !serverSource.includes("credentialFamily: providerCredentialFamily(account)")) throw new Error("public account truth must expose safe reason, scope, provider-family, and asset evidence");
  if (!serverSource.includes("function scrubPublicAccountValue") || !serverSource.includes("nested]) => [key, scrubPublicAccountValue(nested)]")) throw new Error("public account secret scrubber must recursively remove nested secret fields");
  for (const secretField of ["encryptedtoken", "encryptedcredential", "encryptedrefreshtoken", "clientsecret", "appsecret", "codeverifier", "sessiontokenhash"]) {
    if (!serverSource.includes(`"${secretField}"`)) throw new Error(`public account secret scrubber missing ${secretField}`);
  }
  if (!serverSource.includes('!item.providerAccountId && String(item.id || "") === String(publicProfile.id || "")')) throw new Error("normalized provider rehydration must not let a stale card id overwrite a real provider account identity");
  if (!serverSource.includes("encrypted_refresh_credential") || !serverSource.includes("normalizedDeviceSessionByTokenHash") || !serverSource.includes("persistNormalizedDeviceAuthState")) throw new Error("normalized device rows must support encrypted refresh recovery after cold starts");
  if (!/async function heartbeatDevice\(\)[\s\S]*?response\.status === 401[\s\S]*?setSessionToken\(""\)[\s\S]*?model = normalizeModel\(clone\(defaultModel\)\)/.test(appHtml)) throw new Error("an expired device heartbeat must clear stale browser identity instead of retrying forever");
  if (!serverSource.includes('"/rpc/social_cues_claim_auth_rate_limit"') || !perUserMigrationSource.includes("pg_advisory_xact_lock") || !perUserMigrationSource.includes("auth_rate_limits")) throw new Error("hosted auth throttling must be durable and concurrency-safe");
  if (!perUserMigrationSource.includes("billing_entitlements_workspace_user_uidx") || !perUserMigrationSource.includes("alter column user_id set not null")) throw new Error("Supabase migration must enforce one owned entitlement row per workspace user");
  if (!serverSource.includes("recordStripeSubscriptionState") || !serverSource.includes('customer.subscription.deleted') || !serverSource.includes('invoice.payment_failed')) throw new Error("Stripe webhook handling must reconcile subscription access loss");
  if (!serverSource.includes("claimDurableWebhookEvent") || !serverSource.includes("completeDurableWebhookEvent") || !perUserMigrationSource.includes("webhook_events")) throw new Error("Stripe webhook idempotency must survive server restarts");
  if (!serverSource.includes("publishIdempotencyKey") || !serverSource.includes("completedPublishReceipt") || !serverSource.includes("duplicateSuppressed")) throw new Error("live publish retries must suppress duplicate provider posts");
  if (!serverSource.includes("durableCompletedPublishReceipt") || !serverSource.includes("/publish_receipts?workspace_id=eq.") || !serverSource.includes("recoveredFromDurableReceipt")) throw new Error("live publish retries must consult durable provider receipts after restarts");
  if (!serverSource.includes('["queued", "scheduled"].includes(variantStatus)') || !serverSource.includes('["blocked", "failed", "retrying"].includes(row.status) ? row.lastAttempt?.error || null : null')) throw new Error("fresh final approval must override stale publish blockers in the durable queue");
  if (!serverSource.includes("preserveNewerServerVariant") || !serverSource.includes("variantRuntimeTimestamp") || !serverSource.includes('mergeVariantRuntimeState(key, merged[key], existingRows)')) throw new Error("stale client saves must not overwrite newer worker publish results");
  if (!serverSource.includes("result.live = true;") || !serverSource.includes("result.live = live;") || !serverSource.includes("result.idempotencyKey = result.idempotencyKey || publishIdempotencyKey(item);")) throw new Error("publish results must retain live and idempotency context even when a provider blocks before sending");
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
  if (!appHtml.includes("function rememberMediaAsset") || !appHtml.includes("rememberMediaAsset(body.asset)")) throw new Error("verified media must remain in the browser workspace model before the next save");
  if (!appHtml.includes("hostedModelSaveChain") || !appHtml.includes("revisionAtStart !== localModelRevision")) throw new Error("hosted workspace saves must be ordered and stale server syncs must not overwrite newer user actions");
  if (!appHtml.includes("let hostedModelHydrated = !SERVER_MODE") || !appHtml.includes("SERVER_MODE && hostedModelHydrated") || !/model = serverModel;\s*hostedModelHydrated = true;/.test(appHtml)) throw new Error("hosted workspace writes must stay blocked until the signed-in server model is hydrated");
  if (!serverSource.includes("serverRetainedWorkspaceCollectionKeys") || !serverSource.includes("The attached Facebook image is not available through verified provider delivery yet.")) throw new Error("client saves must retain server-owned worker/media records and must not silently drop attached Facebook media");
  if (!/record\.idempotencyKey = result\.idempotencyKey \|\| publishIdempotencyKey\(item\);\s*if \(result\.ok && result\.dryRun === false\)/.test(serverSource)) throw new Error("every publish attempt must retain its idempotency key before a live provider receipt exists");
  if (!serverSource.includes("providerMediaDeliveryToken") || !serverSource.includes("providerMediaDeliveryPayload") || !serverSource.includes("publishableVariantMediaUrl") || !serverSource.includes("Readable.fromWeb(upstream.body)")) throw new Error("provider delivery must stream owner-approved private media through an expiring signed capability URL");
  if (!serverSource.includes('item.variant.platform === "threads"') || !serverSource.includes('media_type: "VIDEO"') || !serverSource.includes('media_type: "IMAGE"')) throw new Error("the shared publish queue must support Threads text, image, and video posts");
  if (!serverSource.includes('asset.status === "uploaded"') || !serverSource.includes('status: sourceUploadRequired ? "source-upload-required"') || !serverSource.includes('job.status = "queue-write-failed"')) throw new Error("render jobs must require a verified source and expose durable queue write failures");
  if (!appHtml.includes("uploadRawVideoTus") || !appHtml.includes('"Upload-Metadata"') || !appHtml.includes('"x-signature"') || !appHtml.includes("6 * 1024 * 1024") || !appHtml.includes("rawVideoUploadProgress") || !appHtml.includes("cancelRawVideoUpload")) throw new Error("raw video intake must expose resumable progress, retry recovery, and cancellation");
  if (!/catch \(tusError\)[\s\S]*?uploadRawVideoSignedPut\(file, upload, signal, report\)/.test(appHtml)) throw new Error("media intake must fall back to signed direct upload when resumable upload initialization fails");
  if (!appHtml.includes("stripConsumedAuthCredentials") || !appHtml.includes('["verify", "token", "token_hash", "access_token", "refresh_token"]') || !/const oauthReturn = currentOAuthReturn\(\);\s+stripConsumedAuthCredentials\(\);/.test(appHtml)) throw new Error("consumed one-time authentication credentials must be removed from the app URL before session restoration");
  if (appHtml.includes("Storage path reserved; upload worker still needs the signed-upload pass.")) throw new Error("raw video intake must not claim that the implemented browser upload pass is still missing");
  if (!serverSource.includes('url.pathname === "/api/cron/workers"') || !serverSource.includes("workerRequestAuthorized") || !serverSource.includes('"Idempotency-Key"')) throw new Error("worker trigger must be secret-authenticated and provider deliveries idempotent");
  if (!serverSource.includes("function workerDispatcherStatus") || !serverSource.includes("workerRunStaleMinutes") || !serverSource.includes('? "never-observed"') || !serverSource.includes('? "active"')) throw new Error("worker readiness must be based on a recent durable run instead of database availability alone");
  if (!serverSource.includes("function publishQueueRecordIdentity") || !serverSource.includes("function preferredPublishQueueRecord") || !serverSource.includes("successfulDryRun")) throw new Error("publish queue reconciliation must deduplicate each variant and preserve successful dry-run evidence");
  if (!appHtml.includes("function preferredDeliveryRecord") || !appHtml.includes("deliveryStatusPriority") || !appHtml.includes("worker ${escapeHtml(dispatcher.status")) throw new Error("customer delivery and automation views must surface canonical queue state and dispatcher truth");
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
  if (!serverSource.includes("function scheduledVariantLedgerItems") || !serverSource.includes('variantStatus === "blocked"') || !serverSource.includes("recoveredFromVariantEvidence") || !serverSource.includes('["queued", "scheduled", "retrying"].includes(item.status)') || !serverSource.includes("awaitingApproval") || !serverSource.includes("terminalPublishHistory: true")) throw new Error("normalized publishing history must preserve approval gates and real terminal evidence without counting unconfirmed or completed posts as due");
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
  const packageScripts = JSON.parse(packageSource).scripts || {};
  if (packageScripts["vercel:env:audit"] !== "node scripts/sync-vercel-env.mjs --dry-run") throw new Error("vercel:env:audit must remain the explicit dry-run command");
  if (packageScripts["vercel:env:sync"] !== "node scripts/sync-vercel-env.mjs") throw new Error("vercel:env:sync must remain the explicit synchronization command");
  if (!envSyncSource.includes("Secret values are never printed.") || !envSyncSource.includes("defaultTargets") || !envSyncSource.includes("MISSING_LOCAL") || !envSyncSource.includes("WOULD_ADD") || !envSyncSource.includes("ADDED")) throw new Error("Vercel env sync script should be dry-run safe and name-only");
  if (!envSyncSource.includes("ETSY_CLIENT_SECRET") || !envSyncSource.includes("LINKEDIN_CLIENT_SECRET") || !envSyncSource.includes("DISCORD_CLIENT_ID") || !envSyncSource.includes("CANVA_CLIENT_SECRET")) throw new Error("Vercel env sync script missing prioritized provider targets");
  if (!envSyncSource.includes('const args = { apply: false, environment: "production", names: [], envFile: ".env" };') || !envSyncSource.includes('if (arg === "--apply") args.apply = true;') || (envSyncSource.match(/args\.apply\s*=\s*true/g) || []).length !== 1 || !envSyncSource.includes('else if (arg === "--names") args.names = (argv[++index] || "").split(",").map(item => item.trim()).filter(Boolean);') || !/if \(!args\.apply\) \{[\s\S]*?WOULD_ADD[\s\S]*?continue;[\s\S]*?\}\s*try \{\s*await addEnvironmentVariable\(/.test(envSyncSource)) throw new Error("Vercel env sync mutation must require explicit --apply while preserving focused --names handling");
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
  for (const route of ["/api/discord/user", "/api/discord/guilds", "/api/discord/channels", "/api/discord/channels/create", "/api/discord/interactions/readiness", "/api/discord/webhook-events/readiness", "/api/discord/webhook-events", "/api/discord/bot/readiness", "/api/discord/commands/readiness", "/api/discord/commands", "/api/discord/commands/register", "/api/discord/verification-preflight", "/api/discord/community/select", "/api/discord/messages", "/api/discord/messages/reply", "/api/discord/messages/moderate", "/api/discord/announcement"]) {
    if (!appHtml.includes(route)) throw new Error(`Discord expansion route missing from function suite: ${route}`);
    if (!serverSource.includes(`url.pathname === "${route}"`)) throw new Error(`Discord expansion route missing backend handler: ${route}`);
  }
  if (!serverSource.includes('"/api/discord/interactions"') || !serverSource.includes("verifyDiscordInteractionSignature") || !serverSource.includes("DISCORD_PUBLIC_KEY") || !serverSource.includes("x-signature-ed25519")) throw new Error("Discord interactions endpoint must verify signed Discord requests");
  if (!serverSource.includes('"/api/discord/webhook-events"') || !serverSource.includes("APPLICATION_DEAUTHORIZED") || !serverSource.includes("claimDurableWebhookEvent(\"discord\"") || !serverSource.includes("clearDiscordAccountCredentials")) throw new Error("Discord webhook events should verify, deduplicate, and synchronize authorization lifecycle changes");
  if (!/externalSignedPostPaths[\s\S]*?"\/api\/discord\/webhook-events"/.test(serverSource)) throw new Error("Discord signed webhook events must bypass browser-origin checks and rely on Ed25519 verification");
  if (!serverSource.includes("function discordVerificationPreflight") || !serverSource.includes("discordVerificationServerThreshold = 100") || !appHtml.includes("Discord operations console") || !appHtml.includes("verification deferred")) throw new Error("Discord should expose an operations console that defers app verification until 100 servers");
  if (!serverSource.includes('method: "PUT", authScheme: "Bot"') || !serverSource.includes('confirm === "REGISTER_DISCORD_COMMANDS"')) throw new Error("Discord command registration should use explicit live approval and bulk overwrite semantics");
  if (!serverSource.includes('name: "Send to Social Cues"') || !serverSource.includes('name: "Community profile"')) throw new Error("Discord should expose message and member context commands alongside /cue");
  if (!serverSource.includes("requireDiscordAccountForRead") || !serverSource.includes('discordApi("/users/@me"') || !serverSource.includes('discordApi("/users/@me/guilds"') || !serverSource.includes('authScheme: "Bot"')) throw new Error("Discord expansion should use OAuth and bot-gated API routes behind the connected account gate");
  if (!serverSource.includes("function discordSavedTarget") || !serverSource.includes("function authorizedDiscordGuild") || !serverSource.includes("discordGuildAuthority")) throw new Error("Discord customer actions must bind to the workspace's saved authorized server and channel");
  if (!serverSource.includes("function requireProviderOperator") || !serverSource.includes("Only the Social Cues owner can register application commands")) throw new Error("Discord application-level diagnostics and command registration must be operator-only in production");
  if (!serverSource.includes("function existingDiscordActionReceipt") || !serverSource.includes("function recordDiscordActionReceipt") || !serverSource.includes('req.headers["idempotency-key"]')) throw new Error("Discord direct writes need durable idempotency receipts");
  if (!/url\.pathname === "\/api\/discord\/announcement"[\s\S]*?allowed_mentions:\s*\{ parse: \[\] \}/.test(serverSource)) throw new Error("Discord announcements must suppress mass mentions");
  if (!discordQueuedAnnouncementAdapterIsNative(serverSource)) throw new Error("Discord capability truth requires a native queued announcement adapter");
  if (serverSource.includes("Message captured for the Social Cues community response workflow") || serverSource.includes("Community profile handoff created")) throw new Error("Discord context commands must not claim durable capture before a workspace mapping exists");
  if (!serverSource.includes("escapeHtml(error)") || !serverSource.includes("escapeHtml(stateCheck.error)")) throw new Error("Discord callback errors must be HTML escaped");
  if (!appHtml.includes("data-discord-save-target") || !appHtml.includes("data-discord-message-reply") || !appHtml.includes("data-discord-message-moderate")) throw new Error("Discord community target, reply, and moderation controls should be present in Responses");
  if (!appHtml.includes("data-discord-room-action") || !serverSource.includes('confirm === "CREATE_DISCORD_CHANNEL"') || !serverSource.includes('action: "channel_create"')) throw new Error("Discord room creation should be approval-gated, idempotent, and visible in Responses");
  if (!/url\.pathname === "\/api\/discord\/channels\/create"[\s\S]*?requireDiscordAccountForRead[\s\S]*?discordSavedTarget[\s\S]*?authorizedDiscordGuild/.test(serverSource)) throw new Error("Discord room creation must require an entitled connected account and stay bound to its authorized saved server");
  if (!/url\.pathname === "\/api\/oauth\/discord\/callback"[\s\S]*?modelForSession\(\{ user: owner \}, sharedModel\)/.test(serverSource)) throw new Error("Discord callback must save connected account evidence into the signed-in user workspace");
  if (!/url\.pathname === "\/api\/oauth\/discord\/status"[\s\S]*?account: account \? publicAccount\(account\) : null/.test(serverSource)) throw new Error("Discord OAuth status must include signed-in account evidence after a successful handshake");
  if (!appHtml.includes("source.discordStatus?.account")) throw new Error("Discord readiness account evidence is not merged into the app account list");
  if (!appHtml.includes("function acceptedEnvTags") || !appHtml.includes("${name} accepts") || !appHtml.includes("acceptedEnvTags(service") || !appHtml.includes("acceptedEnvTags(backendService(\"pinterest\")")) throw new Error("provider UI should expose accepted env aliases for missing production credentials");
  if (!appHtml.includes("Production credential unlocks") || !appHtml.includes("credentialUnlocks") || !serverSource.includes('url.pathname === "/api/provider/credential-unlocks"') || !serverSource.includes("function serviceCredentialUnlocks")) throw new Error("provider credential unlock queue missing");
  if (serverSource.includes("Next provider unlock") || serverSource.includes("integrations.nextCredentialUnlock")) throw new Error("public account portal must not expose provider credential names or operator setup details");
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
  if (!serverSource.includes("async function refreshThreadsAccount") || !serverSource.includes('grant_type: "th_refresh_token"') || !serverSource.includes('threads: refreshThreadsAccount')) throw new Error("Threads long-lived tokens must renew through the durable refresh worker");
  if (!serverSource.includes('"youtube", "threads"]') || !serverSource.includes("Automatic Threads token renewal is scheduled before expiry.")) throw new Error("Threads refresh jobs and customer token health must expose automatic renewal");
  if (!serverSource.includes('if (!expired && account.platform === "threads") return null;')) throw new Error("Threads accounts scheduled for automatic renewal must not raise a contradictory reconnect alert");
  if (!serverSource.includes('"Cache-Control": "private, max-age=120, must-revalidate"') || !serverSource.includes('Vary: "Cookie, Authorization"')) throw new Error("private media previews should reuse short-lived signed links without becoming shared-cache content");
  if (!serverSource.includes('url.searchParams.get("resolve") === "1"') || !serverSource.includes("{ ok: true, url: signedUrl, expiresIn: 300 }")) throw new Error("signed-in media previews should resolve one short-lived private URL for safe client reuse");
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
  if (!serverSource.includes("let token = session?.token") || !serverSource.includes("const preservedSession = Boolean(device && token)") || !serverSource.includes("if (!device && !supabaseAuthEnabled())")) throw new Error("hosted OAuth callbacks must preserve a validated Supabase session instead of replacing it with a random local token");
  if ((serverSource.match(/renewOAuthReturnSession\(res, sharedModel, model, owner, stateCheck\.record, req, session\)/g) || []).length < 14) throw new Error("every provider callback must pass its validated app session through the OAuth return");
  if (!serverSource.includes("function dedupeProviderAccounts") || !serverSource.includes("dedupeProviderAccounts(visibleConnectedAccounts(model))") || !serverSource.includes("model.connectedAccounts = dedupedAccounts")) throw new Error("provider persistence must collapse duplicate asset rows before normalized token writes and workspace rehydration");
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
  if (!appHtml.includes('data-studio-mode="post"') || !appHtml.includes('data-studio-mode="video"') || !appHtml.includes("function setStudioMode") || !appHtml.includes("visibleCreationPlatforms().map(platform => platform.id)")) throw new Error("Create must expose one-shot posting and video campaigns as distinct first-class modes");
  if (!appHtml.includes("function providerSourceIsActive") || !appHtml.includes("visibleSources")) throw new Error("Audience, library, and commerce sources must follow selected or connected workspace services");
  if (!appHtml.includes("Analytics lanes ready - refresh live insights") || !appHtml.includes("Accounts connected - analytics permission still needed") || !appHtml.includes("escapeHtml(analysisStatus)")) throw new Error("Audience analysis must not say it is waiting for accounts after canonical connected assets are present");
  if (!appHtml.includes('data-account-lane="reddit"') || !appHtml.includes("Reddit installed-community lane") || !appHtml.includes("View Reddit comments")) throw new Error("Accounts must expose the Reddit installed-community inbox without pretending it is OAuth");
  if (!appHtml.includes("function renderResponseProviderGroup") || !appHtml.includes('class="response-count') || !appHtml.includes('data-response-provider-group="${escapeHtml(group.key)}"')) throw new Error("Responses must use shared count-and-expand provider groups");
  if (!appHtml.includes("function mergeResponseInboxItems") || !appHtml.includes("const groupedItems = new Map()") || !appHtml.includes("secured workspace record")) throw new Error("Live and durable provider responses must merge without hiding or duplicating conversations");
  if (!appHtml.includes('key: "meta_comments"') || !appHtml.includes('key: "youtube"') || !appHtml.includes('key: "threads"') || !appHtml.includes('key: "x"') || !appHtml.includes('key: "linkedin"') || !appHtml.includes('key: "reddit"') || !appHtml.includes('key: "discord"')) throw new Error("Every active response provider must expose an expandable inbox group");
  if (!appHtml.includes("A connected account alone is not reported as zero responses.") || !appHtml.includes('countAvailable: false') || !appHtml.includes('const countLabel = countAvailable ? String(items.length) : "--"')) throw new Error("Connected providers without a response feed must show unavailable instead of a fake zero");
  if (!appHtml.includes("moderator context") || !appHtml.includes("delete with permission") || !appHtml.includes("read-only triage")) throw new Error("Expanded response groups must explain provider-specific moderation and permission context");
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

  const forgedMediaResponse = await fetch(base + "/api/media/provider/forged.signature");
  const forgedMedia = await forgedMediaResponse.json();
  if (forgedMediaResponse.status !== 403 || !/invalid or expired/i.test(forgedMedia.error || "")) throw new Error("forged provider media capability should be rejected before storage access");

  const coreModelRequestsBefore = (await externalHttpRequestAttempts()).length;
  const anonymousModelResponse = await fetch(base + "/api/model");
  const anonymousModel = await anonymousModelResponse.json();
  const anonymousModelSource = JSON.stringify(anonymousModel);
  const anonymousForbiddenFields = [
    "workspace", "workspaces", "campaigns", "quickPosts", "connectedAccounts",
    "authUsers", "authPromoClaims", "oauthStates", "oauthEvents"
  ];
  if (anonymousModelResponse.status !== 401 || anonymousModel.ok !== false || !/sign in/i.test(anonymousModel.error || "")) {
    throw new Error("anonymous model read must fail closed with a sanitized authentication-required response");
  }
  if (anonymousForbiddenFields.some(field => Object.prototype.hasOwnProperty.call(anonymousModel, field))
    || anonymousModelSource.includes('"token":')
    || anonymousModelSource.includes('"accessToken":')
    || anonymousModelSource.includes('"refreshToken":')) {
    throw new Error("anonymous model denial exposed public workspace or private model data");
  }

  const ownerGateEmail = `mr.barton+owner-gate-test-${Date.now()}@socialcuesapp.com`;
  const ownerSignup = await request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Cory Barton", email: ownerGateEmail, password: "test-password-2026", workspaceName: "Owner Workspace" })
  });
  if (!ownerSignup.ok || ownerSignup.entitlement?.source !== "owner-allowlist" || !ownerSignup.entitlement?.subscriptionPaid || !ownerSignup.entitlement?.appFeePaid) throw new Error("owner email signup should bypass invite lock and receive full access");
  if (ownerSignup.user?.role !== "Owner" || !ownerSignup.session?.token) throw new Error("owner signup should resolve to the Owner role with a local session");

  const authenticatedModelResponse = await fetch(base + "/api/model", {
    headers: { Authorization: `Bearer ${ownerSignup.session.token}` }
  });
  const model = await authenticatedModelResponse.json();
  if (authenticatedModelResponse.status !== 200) throw new Error("authenticated owner could not load the public workspace model");
  if (model.workspace?.id !== ownerSignup.workspace?.id
    || model.currentUser?.id !== ownerSignup.user?.id
    || (model.workspaces || []).some(workspace => workspace.id !== ownerSignup.workspace?.id)) {
    throw new Error("authenticated model was not limited to the signed-in owner workspace");
  }
  if (!model.workspace || !Array.isArray(model.campaigns) || !Array.isArray(model.quickPosts)) throw new Error("bad model shape");
  if (!Array.isArray(model.connectedAccounts)) throw new Error("bad accounts shape");
  const privateAccountFields = ["credential", "refreshCredential", "token", "accessToken", "refreshToken", "encryptedToken", "encryptedCredential"];
  if (model.connectedAccounts.some(account => privateAccountFields.some(field => Object.prototype.hasOwnProperty.call(account, field)))) throw new Error("model exposed a private connected-account credential field");
  if (Object.prototype.hasOwnProperty.call(model, "authUsers")) throw new Error("model exposed auth user ledger");
  if (Object.prototype.hasOwnProperty.call(model, "authPromoClaims")) throw new Error("model exposed promo claim ledger");
  if (JSON.stringify(model).includes('"token":') || JSON.stringify(model).includes('"accessToken":') || JSON.stringify(model).includes('"refreshToken":')) throw new Error("model leaked token material");
  if (JSON.stringify(model).includes('"oauthStates"')) throw new Error("model leaked oauth state ledger");
  if (JSON.stringify(model).includes('"oauthEvents"')) throw new Error("model leaked OAuth debug event ledger");
  const coreModelExternalRequests = (await externalHttpRequestAttempts()).length - coreModelRequestsBefore;
  if (coreModelExternalRequests !== 0) throw new Error("core model authentication fixture attempted an external request");
  const coreModelFixture = {
    anonymousStatus: anonymousModelResponse.status,
    anonymousContentType: anonymousModelResponse.headers.get("content-type") || "",
    anonymousClassification: "authentication_required",
    anonymousSessionPresent: false,
    authenticatedStatus: authenticatedModelResponse.status,
    authenticatedContentType: authenticatedModelResponse.headers.get("content-type") || "",
    authenticatedSessionPresent: Boolean(ownerSignup.session?.token),
    workspaceIdEqual: model.workspace?.id === ownerSignup.workspace?.id,
    foreignWorkspaceVisible: (model.workspaces || []).some(workspace => workspace.id !== ownerSignup.workspace?.id),
    publicShape: {
      workspace: Boolean(model.workspace),
      campaigns: Array.isArray(model.campaigns),
      quickPosts: Array.isArray(model.quickPosts),
      connectedAccounts: Array.isArray(model.connectedAccounts)
    },
    privateDataAbsent: true,
    externalRequests: coreModelExternalRequests
  };

  if (coreModelFixtureOnly) {
    console.log(JSON.stringify({ ok: true, coreModel: coreModelFixture }));
  } else {
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

  const missingMemberPromoResponse = await fetch(base + "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Workspace Member", email: "mr.barton+member-promo@socialcuesapp.com", password: "test-password-2026", workspaceName: "Fresh Member Workspace" })
  });
  const missingMemberPromo = await missingMemberPromoResponse.json();
  if (missingMemberPromoResponse.status !== 403 || !missingMemberPromo.signupLocked || !/member promo code assigned/i.test(missingMemberPromo.error || "")) throw new Error("an email assigned to a member-only promo must never fall through to owner signup");

  const memberPromoSignup = await request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Workspace Member", email: "mr.barton+member-promo@socialcuesapp.com", password: "test-password-2026", promoCode: "SC-LOCAL-MEMBER-8N4Q", workspaceName: "Fresh Member Workspace" })
  });
  if (!memberPromoSignup.ok || memberPromoSignup.user?.role !== "Member" || memberPromoSignup.entitlement?.memberOnly !== true) throw new Error("member-only promo must override the owner-email alias rule");
  const memberWorkspace = await request("/api/model", { headers: { Authorization: `Bearer ${memberPromoSignup.session.token}` } });
  if (memberWorkspace.campaigns?.length || memberWorkspace.quickPosts?.length || memberWorkspace.connectedAccounts?.some(account => account.status === "connected")) throw new Error("member promo signup must receive a fresh blank isolated workspace");

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
  if (!firstUserModel.persistence?.conditionalSave || !firstUserModel.persistence.revision) {
    throw new Error("signed-in local workspace did not expose revisioned save capability");
  }
  const modelFilePath = path.join(testDataDir, "model.json");
  const bareSaveStateBefore = await readFile(modelFilePath);
  const bareSaveRequestsBefore = (await externalHttpRequestAttempts()).length;
  const bareSaveResponse = await fetch(base + "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(firstUserModel)
  });
  const bareSave = await bareSaveResponse.json();
  if (bareSaveResponse.status !== 428 || bareSave.code !== "workspace_revision_required" || bareSave.commitStatus !== "not_committed") {
    throw new Error("bare authenticated model save did not fail closed on the missing revision envelope");
  }
  if (!bareSaveStateBefore.equals(await readFile(modelFilePath))) {
    throw new Error("rejected bare model save changed durable workspace state");
  }
  if ((await externalHttpRequestAttempts()).length !== bareSaveRequestsBefore) {
    throw new Error("rejected bare model save attempted an external provider request");
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
      encryptedCredential: "encrypted-credential-regression-marker",
      scopes: ["threads_basic", "threads_content_publish", "threads_manage_insights", "threads_manage_replies"],
      profile: { biography: "safe public field", accessToken: "nested-secret-regression-marker" }
    }
  ];
  const browserCredentialInjectionEnvelope = revisionedModelSaveEnvelope(firstUserModel);
  const browserCredentialInjection = await request("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(browserCredentialInjectionEnvelope)
  });
  if (browserCredentialInjection.receipt?.operationId !== browserCredentialInjectionEnvelope.operationId
    || !browserCredentialInjection.receipt?.committedRevision) {
    throw new Error("revisioned browser credential-injection control did not return a durable save receipt");
  }
  const browserInjectionMarkers = ["fake-test-token-marker", "fake-stale-threads-token", "encrypted-credential-regression-marker", "nested-secret-regression-marker"];
  const browserInjectionDisk = await readFile(modelFilePath, "utf8");
  if (browserInjectionMarkers.some(marker => browserInjectionDisk.includes(marker))
    || browserInjectionMarkers.some(marker => JSON.stringify(browserCredentialInjection).includes(marker))) {
    throw new Error("browser model save injected a provider credential into private storage or public output");
  }

  const providerFixtureRequestsBefore = (await externalHttpRequestAttempts()).length;
  await stopMainTestServer();
  const workspaceLockPath = path.join(testDataDir, ".workspace-content.lock");
  if (await access(workspaceLockPath).then(() => true, error => error?.code !== "ENOENT")) {
    throw new Error("main test server did not release the local workspace lock before provider fixture setup");
  }
  await mutateProviderStateFixture({
    user: login.user,
    workspaceId: login.workspace.id,
    mutate(model, owner) {
      model.connectedAccounts = providerStateFixtureAccounts(owner);
      model.integrations = {
        ...(model.integrations || {}),
        youtube: "YouTube token exchange failed: Unauthorized",
        facebook: "No pages returned by current permissions"
      };
    }
  });
  startMainTestServer();
  await waitForServer();
  const savedFirstUserModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const providerFixturePlatformIds = (savedFirstUserModel.connectedAccounts || [])
    .map(account => `${account.platform}:${account.providerAccountId || ""}`).sort();
  const providerFixtureStored = JSON.parse(await readFile(modelFilePath, "utf8"));
  const storedProviderAccounts = providerFixtureStored.workspaces?.[login.workspace.id]?.content?.connectedAccounts || [];
  if (storedProviderAccounts.length !== 14
    || storedProviderAccounts.some(account => account.ownerUserId !== login.user.id || account.workspaceId !== login.workspace.id)
    || storedProviderAccounts.some(account => account.credential?.alg !== "aes-256-gcm")) {
    throw new Error("server-private provider fixture was not stored with canonical ownership and encrypted credentials");
  }
  if (browserInjectionMarkers.some(marker => JSON.stringify(providerFixtureStored).includes(marker))) {
    throw new Error("provider fixture storage retained a plaintext credential marker");
  }
  if (savedFirstUserModel.workspace?.id !== login.workspace.id
    || (savedFirstUserModel.workspaces || []).some(workspace => workspace.id !== login.workspace.id)
    || containsCredentialLikeOwnershipField(savedFirstUserModel.connectedAccounts)) {
    throw new Error("restarted public model did not preserve workspace isolation and provider secret absence");
  }
  const isolatedMemberProviderModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${memberPromoSignup.session.token}` }
  });
  if ((isolatedMemberProviderModel.connectedAccounts || []).length
    || isolatedMemberProviderModel.workspace?.id === login.workspace.id) {
    throw new Error("server-private provider fixture crossed into another signed-in workspace");
  }
  if ((await externalHttpRequestAttempts()).length !== providerFixtureRequestsBefore) {
    throw new Error("provider-state fixture setup or restart attempted an external provider request");
  }
  const providerStateFixtureEvidence = {
    bareSaveStatus: bareSaveResponse.status,
    bareSaveCode: bareSave.code,
    bareSaveCommitStatus: bareSave.commitStatus,
    bareSaveStateUnchanged: true,
    revisionCapabilityPresent: true,
    browserCredentialInjectionCommitted: true,
    browserCredentialInjectionStored: false,
    accountCount: savedFirstUserModel.connectedAccounts.length,
    platformIds: providerFixturePlatformIds,
    workspaceIdEqual: savedFirstUserModel.workspace?.id === login.workspace.id,
    foreignWorkspaceVisible: false,
    privateFieldsAbsent: true,
    externalRequests: (await externalHttpRequestAttempts()).length - providerFixtureRequestsBefore
  };
  if (JSON.stringify(savedFirstUserModel).includes("nested-secret-regression-marker")) throw new Error("public model leaked a nested provider secret field");
  const twitchProviderAccounts = await request("/api/provider/accounts?platform=twitch", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const twitchSelectionRow = twitchProviderAccounts.rows?.[0];
  const twitchSelectionEvidence = {
    rowCount: twitchProviderAccounts.rows?.length || 0,
    accountCount: twitchSelectionRow?.accounts?.length || 0,
    credentialPathCount: twitchSelectionRow?.credentialPathCount || 0,
    assetCount: twitchProviderAccounts.assetCount || 0
  };
  if (!twitchProviderAccounts.ok || twitchSelectionRow?.accounts?.length !== 1 || twitchSelectionRow?.credentialPathCount !== 2 || twitchProviderAccounts.assetCount !== 1) {
    throw new Error(`provider account selection did not collapse duplicate credential paths into one posting identity: ${JSON.stringify(twitchSelectionEvidence)}`);
  }
  if (providerStateFixtureOnly) {
    await stopMainTestServer();
    await rm(testDataDir, { recursive: true, force: true });
    let cleanupComplete = false;
    try {
      await access(testDataDir);
    } catch (error) {
      if (error?.code === "ENOENT") cleanupComplete = true;
      else throw error;
    }
    if (!cleanupComplete) throw new Error("provider-state focused fixture cleanup was incomplete");
    console.log(JSON.stringify({ ok: true, providerState: { ...providerStateFixtureEvidence, twitchSelection: twitchSelectionEvidence, cleanupComplete } }));
    process.exit(0);
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
  const discordChannelDryRun = await request("/api/discord/channels/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ guildId: "test-discord-guild", name: "Launch Room", topic: "Coordinate an approved launch.", live: false })
  });
  if (!discordChannelDryRun.ok || discordChannelDryRun.mode !== "dry-run" || discordChannelDryRun.channel?.name !== "launch-room" || discordChannelDryRun.channel?.live !== false || !discordChannelDryRun.channel?.idempotencyKey) throw new Error("Discord channel creation dry-run failed");
  const discordCommandDryRun = await request("/api/discord/commands/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ live: false })
  });
  if (!discordCommandDryRun.ok || discordCommandDryRun.mode !== "dry-run" || !discordCommandDryRun.dryRun?.commands?.some(command => command.name === "cue")) throw new Error("Discord command registration dry-run failed");
  const discordPreflight = await request("/api/discord/verification-preflight", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!discordPreflight.ok || !Array.isArray(discordPreflight.gates) || !discordPreflight.gates.some(gate => gate.id === "verification-final" && gate.finalStep && gate.deferred) || discordPreflight.verificationPolicy?.indexOf("not an operating prerequisite below 100 servers") === -1) throw new Error("Discord verification preflight should defer app verification below 100 servers");
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
  if (!refreshableXAccount) throw new Error("X refresh fixture could not find the server-owned account");
  await stopMainTestServer();
  await mutateProviderStateFixture({
    user: login.user,
    workspaceId: login.workspace.id,
    mutate(model) {
      const account = model.connectedAccounts?.find(item => item.providerAccountId === "test-x-user-1");
      if (!account) throw new Error("X refresh fixture could not find the private provider account");
      account.refreshCredential = encryptedShopifyFixtureToken("fake-test-refresh-marker", providerStateFixtureEncryptionKey);
      account.tokenExpiresAt = "2026-01-02T00:00:00.000Z";
    }
  });
  startMainTestServer();
  await waitForServer();
  const signedInProviderAssetMap = await request("/api/provider/asset-map", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!signedInProviderAssetMap.ok || signedInProviderAssetMap.summary.total < 10) throw new Error("provider asset map failed signed-in workspace proof");
  const facebookAssetMap = signedInProviderAssetMap.rows.find(row => row.id === "facebook");
  const xAssetMap = signedInProviderAssetMap.rows.find(row => row.id === "x");
  if (!facebookAssetMap?.assetKind || !facebookAssetMap?.loginIdentity?.source || !facebookAssetMap?.setupNote || !facebookAssetMap?.postingIdentity?.label?.startsWith("Facebook")) throw new Error("provider asset map did not separate posting identity, login identity, and setup guidance");
  if (!facebookAssetMap?.permissionExplainer?.summary || !facebookAssetMap?.permissionExplainer?.nextAction) throw new Error("provider asset map did not include a plain-language permission explainer");
  if (xAssetMap?.status !== "needs-refresh" || !xAssetMap?.gates?.tokenStored || !xAssetMap?.account?.tokenStored || !["setup", "reconnect"].includes(xAssetMap?.permissionExplainer?.severity)) throw new Error(`expired X token evidence must remain visible as needs-refresh instead of no-token or needs-oauth: ${JSON.stringify(xAssetMap)}`);
  await stopMainTestServer();
  await mutateProviderStateFixture({
    user: login.user,
    workspaceId: login.workspace.id,
    mutate(model) {
      const account = model.connectedAccounts?.find(item => item.providerAccountId === "test-x-user-1");
      if (!account) throw new Error("X refresh cleanup fixture could not find the private provider account");
      delete account.refreshCredential;
      delete account.tokenExpiresAt;
    }
  });
  startMainTestServer();
  await waitForServer();
  const signedInPermissionGaps = await request("/api/provider/permission-gaps", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!signedInPermissionGaps.ok || signedInPermissionGaps.summary.total < 10 || !signedInPermissionGaps.rows.some(row => row.id === "facebook" && row.permissionExplainer?.technicalCause)) throw new Error("provider permission gaps endpoint failed signed-in workspace proof");
  const signedInAcceptanceLedger = await request("/api/provider/acceptance-ledger", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const twitchAcceptanceRow = signedInAcceptanceLedger.rows.find(row => row.id === "twitch");
  if (
    !signedInAcceptanceLedger.ok
    || signedInAcceptanceLedger.summary.total < 10
    || signedInAcceptanceLedger.workspaceId !== login.workspace.id
    || !twitchAcceptanceRow?.gates?.oauthConnected
    || twitchAcceptanceRow.account?.providerAccountId !== "test-twitch-user-1"
    || twitchAcceptanceRow.account?.ownerUserId !== login.user.id
    || twitchAcceptanceRow.account?.workspaceId !== login.workspace.id
  ) throw new Error("provider acceptance ledger failed signed-in workspace proof");
  if (twitchAcceptanceRow.gates.devConfigured || !twitchAcceptanceRow.missing?.includes("devConfigured")) throw new Error("provider acceptance ledger did not preserve missing Twitch developer credentials");
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
  const twitchOwnershipRow = signedInOwnershipQueue.rows.find(row => row.id === "twitch");
  if (
    !signedInOwnershipQueue.ok
    || signedInOwnershipQueue.summary.total < 10
    || signedInOwnershipQueue.workspaceId !== login.workspace.id
    || twitchOwnershipRow?.status !== "connected"
    || !twitchOwnershipRow.banked
    || twitchOwnershipRow.account?.providerAccountId !== "test-twitch-user-1"
    || JSON.stringify(twitchOwnershipRow.account).includes("fake-test-token-marker")
  ) throw new Error("provider ownership queue failed signed-in workspace proof");
  if (
    twitchOwnershipRow.executable
    || twitchOwnershipRow.phase !== "Configure"
    || twitchOwnershipRow.currentStep?.id !== "developer"
    || twitchOwnershipRow.currentStep?.state !== "blocked"
  ) throw new Error("provider ownership queue did not preserve missing Twitch developer credentials");
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
  const unauthorizedOwnershipRunResponse = await fetch(base + "/api/provider/ownership-run", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-ownership-session" },
    body: JSON.stringify({ providerId: "twitch" })
  });
  const unauthorizedOwnershipRun = await unauthorizedOwnershipRunResponse.json();
  if (
    unauthorizedOwnershipRunResponse.status !== 401
    || unauthorizedOwnershipRun.ok !== false
    || unauthorizedOwnershipRun.providerOwnershipQueue
    || containsCredentialLikeOwnershipField(unauthorizedOwnershipRun)
  ) throw new Error("provider ownership run must reject an invalid application session without returning workspace state");

  const ownershipEvidence = {
    workspaceId: twitchAcceptanceRow.account?.workspaceId || "",
    ownerUserId: twitchAcceptanceRow.account?.ownerUserId || "",
    providerAccountId: twitchAcceptanceRow.account?.providerAccountId || "",
    connected: twitchAcceptanceRow.account?.connected === true && twitchOwnershipRow?.status === "connected",
    banked: twitchOwnershipRow?.banked === true
  };
  const runExpectedManualOwnershipHandoff = async input => {
    const beforeModel = await request("/api/model", {
      headers: { Authorization: `Bearer ${login.session.token}` }
    });
    const requestsBefore = await externalHttpRequestAttempts();
    const response = await fetch(base + "/api/provider/ownership-run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
      body: JSON.stringify(input)
    });
    const result = await response.json();
    const requestsAfter = await externalHttpRequestAttempts();
    const afterModel = await request("/api/model", {
      headers: { Authorization: `Bearer ${login.session.token}` }
    });
    const fixture = {
      authenticated: true,
      httpStatus: response.status,
      result,
      expectedProviderId: "twitch",
      expectedProviderAccountId: "test-twitch-user-1",
      expectedWorkspaceId: login.workspace.id,
      expectedUserId: login.user.id,
      ownershipEvidence,
      providerRequestCount: requestsAfter.length - requestsBefore.length,
      stateDelta: providerOwnershipRunStateDelta(beforeModel, afterModel, {
        providerId: "twitch",
        providerAccountId: "test-twitch-user-1",
        workspaceId: login.workspace.id,
        userId: login.user.id
      })
    };
    if (!manualProviderOwnershipHandoffIsSafe(fixture)) {
      throw new Error(`provider ownership run did not preserve the exact authenticated manual-step contract: HTTP ${response.status}`);
    }
    return fixture;
  };

  const twitchOwnershipRunFixture = await runExpectedManualOwnershipHandoff({ providerId: "twitch" });
  await runExpectedManualOwnershipHandoff({
    providerId: "twitch",
    workspaceId: "foreign-workspace-id",
    queueId: "foreign-queue-id",
    providerAccountId: "foreign-twitch-account",
    twitchUserId: "foreign-twitch-user"
  });

  const manualOwnershipMutations = [
    ["HTTP 200 success", fixture => { fixture.httpStatus = 200; fixture.result.ok = true; }],
    ["wrong manual-step category", fixture => { fixture.result.status = "blocked"; }],
    ["executable provider row", fixture => { fixture.result.providerOwnershipQueue.rows.find(row => row.id === "twitch").executable = true; }],
    ["foreign workspace", fixture => { fixture.result.providerOwnershipQueue.workspaceId = "foreign-workspace"; }],
    ["foreign connected account", fixture => { fixture.result.providerOwnershipQueue.rows.find(row => row.id === "twitch").account.providerAccountId = "foreign-account"; }],
    ["missing ownership proof", fixture => { fixture.ownershipEvidence.ownerUserId = ""; }],
    ["provider request attempted", fixture => { fixture.providerRequestCount = 1; }],
    ["provider receipt created", fixture => { fixture.stateDelta.providerReceiptCreated = true; }],
    ["credential-like response field", fixture => { fixture.result.providerOwnershipQueue.rows.find(row => row.id === "twitch").account.credential = "synthetic-secret"; }],
    ["incorrect phase and step", fixture => { fixture.result.phase = "Prove"; fixture.result.currentStep.id = "read"; }],
    ["provider label without account ownership", fixture => { fixture.result.providerOwnershipQueue.rows.find(row => row.id === "twitch").account = null; }],
    ["anonymous response state", fixture => { fixture.authenticated = false; }],
    ["unsupported action queued", fixture => { fixture.stateDelta.actionChanged = true; }]
  ];
  for (const [label, mutate] of manualOwnershipMutations) {
    const mutation = structuredClone(twitchOwnershipRunFixture);
    mutate(mutation);
    if (manualProviderOwnershipHandoffIsSafe(mutation)) throw new Error(`provider ownership manual-step assertion accepted mutation: ${label}`);
  }
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
  const providerContractRequestsBefore = await externalHttpRequestAttempts();
  const unauthorizedProviderContractsResponse = await fetch(base + "/api/provider/contracts", {
    headers: { Authorization: "Bearer invalid-provider-contract-session" }
  });
  const unauthorizedProviderContracts = await unauthorizedProviderContractsResponse.json();
  if (
    unauthorizedProviderContractsResponse.status !== 401
    || unauthorizedProviderContracts.ok !== false
    || unauthorizedProviderContracts.workspaceId
    || unauthorizedProviderContracts.rows
    || containsCredentialLikeOwnershipField(unauthorizedProviderContracts)
  ) throw new Error("provider contracts must reject an invalid application session without returning workspace state");
  const signedInProviderContracts = await request("/api/provider/contracts", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const forgedSelectorProviderContracts = await request("/api/provider/contracts?workspaceId=foreign-workspace&providerAccountId=foreign-twitch-account&twitchUserId=foreign-twitch-user", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const providerContractRequestsAfter = await externalHttpRequestAttempts();
  if (!signedInProviderContracts.ok || signedInProviderContracts.summary.total < 10 || !Array.isArray(signedInProviderContracts.nextContractActions)) throw new Error("provider contracts failed signed-in workspace proof");
  const twitchContract = signedInProviderContracts.rows.find(row => row.id === "twitch");
  const twitchContractFixture = {
    authenticated: true,
    developerCredentialsPresent: false,
    response: signedInProviderContracts,
    contract: twitchContract,
    ownershipQueueRow: twitchOwnershipRow,
    expectedWorkspaceId: login.workspace.id,
    expectedUserId: login.user.id,
    expectedProviderAccountId: "test-twitch-user-1",
    providerRequestCount: providerContractRequestsAfter.length - providerContractRequestsBefore.length
  };
  if (!twitchProviderContractOwnershipIsTruthful(twitchContractFixture)) throw new Error("provider contracts did not separate Twitch workspace ownership from developer and adapter readiness");
  const forgedSelectorTwitchContract = forgedSelectorProviderContracts.rows?.find(row => row.id === "twitch");
  if (!twitchProviderContractOwnershipIsTruthful({
    ...twitchContractFixture,
    response: forgedSelectorProviderContracts,
    contract: forgedSelectorTwitchContract
  })) throw new Error("provider contract selectors overrode the authenticated Twitch workspace");

  const twitchContractMutations = [
    ["foreign contract workspace", fixture => { fixture.response.workspaceId = "foreign-workspace"; }],
    ["foreign account owner", fixture => { fixture.contract.account.ownerUserId = "foreign-owner"; }],
    ["foreign account workspace", fixture => { fixture.contract.account.workspaceId = "foreign-workspace"; }],
    ["wrong provider account", fixture => { fixture.contract.account.providerAccountId = "foreign-twitch-account"; }],
    ["missing ownership gate", fixture => { fixture.contract.gates.oauthConnected = false; }],
    ["falsified developer readiness", fixture => { fixture.contract.gates.envReady = true; }],
    ["executable without developer readiness", fixture => { fixture.ownershipQueueRow.executable = true; }],
    ["provider label without tenant proof", fixture => { fixture.contract.account = { name: "Twitch" }; }],
    ["unsupported Twitch write marked supported", fixture => { fixture.contract.gates.publishDryRunProven = true; fixture.contract.ledger.publishProbe.ok = true; }],
    ["credential-like public field", fixture => { fixture.contract.account.refreshToken = "synthetic-secret"; }],
    ["anonymous contract state", fixture => { fixture.authenticated = false; }],
    ["missing banked connection evidence", fixture => { fixture.contract.account.connected = false; fixture.ownershipQueueRow.banked = false; }]
  ];
  for (const [label, mutate] of twitchContractMutations) {
    const mutation = structuredClone(twitchContractFixture);
    mutate(mutation);
    if (twitchProviderContractOwnershipIsTruthful(mutation)) throw new Error(`provider contract ownership assertion accepted mutation: ${label}`);
  }

  const twitchPortalRequestsBefore = (await externalHttpRequestAttempts()).length;
  const portalTwitchReady = await request("/api/twitch/readiness", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const portalTwitchStatus = await request("/api/oauth/twitch/status", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const portalProviderTruth = await request("/api/provider/truth", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const portalProviderContracts = await request("/api/provider/contracts", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const portalOwnershipQueue = await request("/api/provider/ownership-queue", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const signedInTwitchPortalAudit = await request("/api/dev-portal/audit", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const twitchPortalRequestsAfter = (await externalHttpRequestAttempts()).length;
  const portalTruthRow = portalProviderTruth.rows?.find(row => row.id === "twitch");
  const portalContractRow = portalProviderContracts.rows?.find(row => row.id === "twitch");
  const portalOwnershipRow = portalOwnershipQueue.rows?.find(row => row.id === "twitch");
  const twitchPortalRow = signedInTwitchPortalAudit.rows?.find(row => row.id === "twitch");
  const missingApplicationFixture = {
    expectedDecision: "application-credentials",
    authenticated: Boolean(login.session?.token),
    workspaceContext: twitchPortalRow?.workspaceContext,
    workspaceIdMatches: portalContractRow?.account?.workspaceId === login.workspace.id
      && portalContractRow?.account?.ownerUserId === login.user.id,
    foreignMetadataPresent: false,
    configured: portalTwitchStatus.configured,
    readinessConfigured: portalTwitchReady.configured,
    envReady: portalContractRow?.gates?.envReady,
    missingEnv: portalTwitchStatus.missingEnv,
    accountPresent: twitchPortalRow?.accountPresent,
    connected: twitchPortalRow?.connected,
    banked: twitchPortalRow?.banked,
    portal: twitchPortalRow,
    executable: Boolean(portalContractRow?.owned),
    proofRunnable: Boolean(portalOwnershipRow?.executable),
    requiredProviderGatesMissing: Boolean(portalContractRow?.missing?.length),
    externalRequests: twitchPortalRequestsAfter - twitchPortalRequestsBefore,
    publicPayload: { portal: twitchPortalRow, account: portalTwitchReady.account }
  };
  if (!twitchPortalIntegrationStateIsTruthful(missingApplicationFixture)
    || signedInTwitchPortalAudit.ok !== true
    || portalTwitchReady.ready !== false
    || portalTwitchReady.connected !== true
    || portalTwitchStatus.connected !== true
    || portalTruthRow?.configured !== false
    || portalTruthRow?.connected !== true
    || portalTruthRow?.tokenStored !== true
    || portalContractRow?.gates?.oauthConnected !== true
    || portalContractRow?.owned !== false
    || portalOwnershipRow?.executable !== false
    || portalOwnershipRow?.banked !== true) {
    throw new Error("Twitch portal audit should preserve banked workspace evidence while requiring application credentials");
  }
  assertTwitchCredentialValuesAbsent(
    [signedInTwitchPortalAudit, portalTwitchReady, portalTwitchStatus, portalTruthRow, portalContractRow, portalOwnershipRow],
    ["fake-test-token-marker", "fake-test-token-marker-alternate"],
    "signed-in missing-application-credential surfaces"
  );
  const twitchPortalMutationChecks = assertTwitchPortalIntegrationMutations(
    missingApplicationFixture,
    twitchPortalCredentialFixture.beforeCallback,
    twitchPortalCredentialFixture.afterCallback
  );
  if (twitchPortalMutationChecks !== 10) throw new Error("Twitch portal integration mutation coverage was incomplete");

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
  const secondProviderContracts = await request("/api/provider/contracts?workspaceId=" + encodeURIComponent(login.workspace.id) + "&providerAccountId=test-twitch-user-1&twitchUserId=test-twitch-user-1", {
    headers: { Authorization: `Bearer ${secondSignup.session.token}` }
  });
  const secondTwitchContract = secondProviderContracts.rows?.find(row => row.id === "twitch");
  if (
    secondProviderContracts.workspaceId !== secondUserModel.workspace.id
    || secondTwitchContract?.account
    || secondTwitchContract?.gates?.oauthConnected
    || secondTwitchContract?.truth?.connected
    || secondTwitchContract?.truth?.tokenStored
    || containsCredentialLikeOwnershipField(secondProviderContracts)
  ) throw new Error("provider contract selectors exposed another workspace's Twitch ownership evidence");
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
  const ownedYouTubeCallback = await fetch(base + `/api/oauth/youtube/callback?code=fake-code&state=${encodeURIComponent(ownedYouTubeState)}`, {
    headers: { Cookie: `sc_session=${encodeURIComponent(secondSignup.session.token)}` }
  });
  const oauthReturnCookie = ownedYouTubeCallback.headers.get("set-cookie") || "";
  const ownedYouTubeCallbackText = await ownedYouTubeCallback.text();
  if (ownedYouTubeCallback.status !== 200 || !ownedYouTubeCallbackText.includes("YouTube token exchange failed")) throw new Error("owned youtube callback should handle the provider return");
  if (!oauthReturnCookie.includes("sc_session=") || !oauthReturnCookie.includes("HttpOnly")) throw new Error("owned provider callback did not renew the app session cookie");
  if (!oauthReturnCookie.startsWith(`sc_session=${encodeURIComponent(secondSignup.session.token)};`)) throw new Error("OAuth return replaced the validated app session token");
  const renewedSessionResponse = await fetch(base + "/api/auth/session", {
    headers: { Cookie: oauthReturnCookie.split(";")[0] }
  });
  const renewedSession = await renewedSessionResponse.json();
  if (!renewedSessionResponse.ok || renewedSession.user?.email !== secondEmail || renewedSession.device?.sessionProvider === "oauth-return") throw new Error("OAuth return cookie did not preserve the signed-in workspace session");

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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ variant: generated.variants[0] })
  });
  if (!queued.ok || queued.provider !== "social-cues-queue") throw new Error("queue failed");
  if (queued.status === "queued-local-simulation") throw new Error("queue returned demo simulation status");
  if (queued.status !== "queued-review-only" || queued.queueItem?.approvalStage !== 0) throw new Error("new queue items must begin at approval step 1");

  const unauthenticatedApproval = await fetch(base + "/api/publish/queue/approval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queueId: queued.queueItem.id, approved: true })
  });
  if (unauthenticatedApproval.status !== 402) throw new Error("queue approval must require authenticated paid or promo access");

  const prematureQueueConfirmation = await fetch(base + "/api/publish/queue/approval", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ queueId: queued.queueItem.id, approved: true, confirm: "QUEUE_APPROVED_POST" })
  });
  if (prematureQueueConfirmation.status !== 409) throw new Error("queue confirmation must not bypass content approval");

  const firstApproval = await request("/api/publish/queue/approval", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ queueId: queued.queueItem.id, approved: true })
  });
  if (!firstApproval.ok || firstApproval.status !== "approved" || firstApproval.approvalStage !== 1) throw new Error("queue content approval did not reach step 1");

  const finalApproval = await request("/api/publish/queue/approval", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ queueId: queued.queueItem.id, approved: true, confirm: "QUEUE_APPROVED_POST" })
  });
  if (!finalApproval.ok || finalApproval.status !== "queued" || finalApproval.approvalStage !== 2) throw new Error("final queue confirmation did not make the post deliverable");
  if (!finalApproval.publishQueue?.rows?.some(item => item.id === queued.queueItem.id && item.status === "queued")) throw new Error("confirmed queue item was not visible in the durable publish ledger");

  const repeatedFinalApproval = await request("/api/publish/queue/approval", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ queueId: queued.queueItem.id, approved: true, confirm: "QUEUE_APPROVED_POST" })
  });
  if (!repeatedFinalApproval.ok || repeatedFinalApproval.status !== "queued" || repeatedFinalApproval.approvalStage !== 2) throw new Error("repeating final queue confirmation must be idempotent");

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
      status: "queued",
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
  const scheduledSaveEnvelope = revisionedModelSaveEnvelope(scheduledModel);
  const scheduledSave = await request("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(scheduledSaveEnvelope)
  });
  if (scheduledSave.receipt?.operationId !== scheduledSaveEnvelope.operationId
    || JSON.stringify(scheduledSave.receipt?.committedRevision) !== JSON.stringify(scheduledSave.persistence?.revision)) {
    throw new Error("scheduled campaign save did not return its committed workspace revision");
  }
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
  const successfulDryRunIds = duePublish.results.filter(item => item.ok && item.dryRun === true).map(item => item.variantId);
  for (const variantId of successfulDryRunIds) {
    const matchingRows = duePublish.publishQueue.rows.filter(item => item.variantId === variantId);
    if (matchingRows.length !== 1 || matchingRows[0].status !== "dry-run-ready") throw new Error("successful dry runs must reconcile to one dry-run-ready queue row");
    if (!matchingRows[0].lastAttempt?.ok || matchingRows[0].lastAttempt?.dryRun !== true || !matchingRows[0].lastAttempt?.provider) throw new Error("dry-run-ready queue rows must retain provider attempt evidence");
    if (!/^[a-f0-9]{64}$/.test(matchingRows[0].idempotencyKey || "")) throw new Error("dry-run-ready queue rows must retain a stable idempotency key");
  }

  const historicalModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const historicalCampaign = historicalModel.campaigns.find(item => item.id === scheduledCampaign.id) || historicalModel.campaigns[0];
  const historicalAt = new Date().toISOString();
  const historicalPublishedId = `published-facebook-${Date.now()}`;
  const staleQueuedReceiptId = `queued-youtube-receipt-${Date.now()}`;
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
      id: staleQueuedReceiptId,
      platform: "youtube",
      status: "queued",
      scheduledFor: dueAt,
      publishedAt: historicalAt,
      updatedAt: historicalAt,
      providerPostId: "provider-stale-ledger-test",
      copy: "Receipt-backed publication reconciliation smoke test."
    },
    {
      id: historicalBlockedId,
      platform: "tiktok",
      status: "blocked",
      scheduledFor: dueAt,
      blockedAt: historicalAt,
      updatedAt: historicalAt,
      copy: "Blocked history smoke test."
    },
    {
      id: staleQueuedReceiptId,
      platform: "youtube",
      status: "queued",
      scheduledFor: dueAt,
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
      copy: "Newer stale duplicate without provider evidence."
    }
  );
  const historicalSaveEnvelope = revisionedModelSaveEnvelope(historicalModel);
  const historicalSave = await request("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(historicalSaveEnvelope)
  });
  if (historicalSave.receipt?.operationId !== historicalSaveEnvelope.operationId
    || JSON.stringify(historicalSave.receipt?.committedRevision) !== JSON.stringify(historicalSave.persistence?.revision)) {
    throw new Error("historical campaign save did not return its committed workspace revision");
  }

  const publishQueue = await request("/api/publish/queue", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!publishQueue.ok || publishQueue.summary?.total < 2 || !publishQueue.rows?.some(item => item.platform === "facebook")) throw new Error("durable publish queue did not persist scheduled provider items");
  if (!publishQueue.rows.some(item => item.variantId === historicalPublishedId && item.status === "published") || !publishQueue.rows.some(item => item.variantId === historicalBlockedId && item.status === "blocked")) throw new Error("publish queue must retain terminal provider history from campaign variants");
  const reconciledReceiptRows = publishQueue.rows.filter(item => item.variantId === staleQueuedReceiptId);
  if (reconciledReceiptRows.length !== 1 || reconciledReceiptRows[0].status !== "published") throw new Error("provider receipt evidence must outrank and deduplicate a newer stale queued ledger row");
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
  if (automationStatus.workers?.ledgerReady !== false || automationStatus.workers?.dispatcher?.active !== false || automationStatus.workers?.dispatcher?.status !== "not-configured") throw new Error("local automation status must expose an unavailable ledger and inactive dispatcher without guessing");
  if (automationStatus.summary?.automaticPublishing !== 0 || automationStatus.lanes.find(row => row.id === "publishing")?.mode !== "approval-first manual dispatch") throw new Error("automatic publishing must remain distinct from a healthy dispatcher and explicit operator enablement");
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
  const wrongManychatLane = await fetch(base + "/api/manychat/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ apiKey: "12345678:0123456789abcdef0123456789abcdef" })
  });
  const wrongManychatLaneBody = await wrongManychatLane.json();
  if (wrongManychatLane.status !== 400 || !/Profile Public API key/i.test(wrongManychatLaneBody.error || "")) throw new Error("Manychat Account connector must redirect Profile-key-shaped credentials before calling the Page API");
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

  const metaStartRequestsBefore = await externalHttpRequestAttempts();
  const anonymousMetaFacebookStart = await fetch(base + "/api/oauth/meta/start?platform=facebook", { redirect: "manual" });
  const anonymousMetaFacebookText = await anonymousMetaFacebookStart.text();
  if (anonymousMetaFacebookStart.status !== 401
    || !/sign in required/iu.test(anonymousMetaFacebookText)
    || anonymousMetaFacebookStart.headers.get("location")
    || /workspace_writer_unclassified|commitStatus/iu.test(anonymousMetaFacebookText)) {
    throw new Error("anonymous Facebook Meta start should fail closed with a sanitized sign-in requirement");
  }
  const tamperedMetaFacebookStart = await fetch(base + "/api/oauth/meta/start?platform=facebook", {
    redirect: "manual",
    headers: { Authorization: "Bearer invalid-meta-start-session" }
  });
  const tamperedMetaFacebookText = await tamperedMetaFacebookStart.text();
  if (tamperedMetaFacebookStart.status !== 401
    || !/sign in required/iu.test(tamperedMetaFacebookText)
    || /workspace_writer_unclassified|commitStatus/iu.test(tamperedMetaFacebookText)) {
    throw new Error("invalid-session Facebook Meta start should fail closed before persistence");
  }

  const metaFacebookStartResponse = await fetch(base + "/api/oauth/meta/start?platform=facebook", {
    redirect: "manual",
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (metaFacebookStartResponse.status !== 302) throw new Error("authenticated facebook meta start failed");
  const facebookStartLocation = metaFacebookStartResponse.headers.get("location") || "";
  const facebookStartUrl = new URL(facebookStartLocation);
  const facebookRequestedScopes = (facebookStartUrl.searchParams.get("scope") || "").split(",").filter(Boolean);
  if (facebookRequestedScopes.includes("pages_manage_posts")) throw new Error("facebook Meta start should not request pages_manage_posts before App Review approval");
  if (facebookStartUrl.searchParams.get("auth_type") !== "rerequest") throw new Error("facebook Meta start should force a permission re-prompt");
  if (facebookStartUrl.searchParams.has("enable_profile_selector")) throw new Error("normal Facebook Meta start should not force the Page testing selector");

  const metaFacebookTestingStartResponse = await fetch(base + "/api/oauth/meta/start?platform=facebook&testing=pages", {
    redirect: "manual",
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (metaFacebookTestingStartResponse.status !== 302) throw new Error("authenticated facebook meta testing start failed");
  const facebookTestingLocation = metaFacebookTestingStartResponse.headers.get("location") || "";
  const facebookTestingStartUrl = new URL(facebookTestingLocation);
  const facebookTestingRequestedScopes = (facebookTestingStartUrl.searchParams.get("scope") || "").split(",").filter(Boolean);
  if (!["pages_manage_posts", "pages_manage_metadata", "business_management"].every(scope => facebookTestingRequestedScopes.includes(scope))) throw new Error("facebook testing Meta start should request Ready for testing Page scopes");
  if (facebookTestingStartUrl.searchParams.get("enable_profile_selector") !== "1") throw new Error("facebook testing Meta start should force account/page selection");

  const rawMetaStartDocument = JSON.parse(await readFile(path.join(testDataDir, "model.json"), "utf8"));
  const metaStartRecords = (rawMetaStartDocument.shared?.oauthStates || [])
    .filter(record => record.provider === "meta" && record.platform === "facebook");
  const normalMetaStartRecord = metaStartRecords.find(record => record.state === facebookStartUrl.searchParams.get("state"));
  const testingMetaStartRecord = metaStartRecords.find(record => record.state === facebookTestingStartUrl.searchParams.get("state"));
  const metaRecordMatchesOwner = record => record?.ownerUserId === login.user.id
    && record?.userId === login.user.id
    && record?.workspaceId === login.workspace.id;
  if (metaStartRecords.length !== 2
    || !metaRecordMatchesOwner(normalMetaStartRecord)
    || !metaRecordMatchesOwner(testingMetaStartRecord)
    || normalMetaStartRecord.testingPages !== false
    || testingMetaStartRecord.testingPages !== true) {
    throw new Error("Facebook Meta starts were not durably bound to the authenticated workspace owner");
  }
  if ((await externalHttpRequestAttempts()).length !== metaStartRequestsBefore.length) {
    throw new Error("Facebook Meta start fixture attempted an external provider request");
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
  if (!shopifyStatus.configured || !shopifyStatus.clientIdPresent || !shopifyStatus.clientSecretPresent || shopifyStatus.missingEnv?.length) throw new Error("shopify alias credentials were not recognized");
  if (JSON.stringify(shopifyStatus.acceptedEnv?.SHOPIFY_CLIENT_ID) !== JSON.stringify(SHOPIFY_CLIENT_ID_ENV_NAMES)
    || JSON.stringify(shopifyStatus.acceptedEnv?.SHOPIFY_CLIENT_SECRET) !== JSON.stringify(SHOPIFY_CLIENT_SECRET_ENV_NAMES)
    || JSON.stringify(shopifyStatus.acceptedEnv?.SHOPIFY_SHOP_DOMAIN) !== JSON.stringify(SHOPIFY_SHOP_DOMAIN_ENV_NAMES)) {
    throw new Error("shopify readiness did not preserve the exact application-credential alias allowlist");
  }
  const shopifyRuntimeReadiness = await request("/api/shopify/readiness");
  if (!shopifyRuntimeReadiness.ok || !shopifyRuntimeReadiness.configured || shopifyRuntimeReadiness.missingEnv?.length) throw new Error("shopify runtime readiness disagreed with OAuth status");
  assertShopifyCredentialValuesAbsent(
    [shopifyStatus, shopifyRuntimeReadiness, readiness, signedInProviderTruth, signedInProviderContracts, unauthorizedProviderContracts, output],
    [SYNTHETIC_SHOPIFY_APP_ID, SYNTHETIC_SHOPIFY_APP_SECRET],
    "readiness, provider truth, provider contracts, logs, or errors"
  );

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
  if (!/^https:\/\/([a-z0-9-]+\.)?reddit\.com\//i.test(redditReadiness.commandThreadUrl || "") || !redditReadiness.records?.some(item => item.url === redditReadiness.commandThreadUrl)) throw new Error("reddit readiness should expose the safe hosted command-thread handoff");
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

  const metaAssetsModelPath = path.join(testDataDir, "model.json");
  const metaAssetsModelBeforeAnonymous = await readFile(metaAssetsModelPath);
  const metaAssetsRequestsBeforeAnonymous = await externalHttpRequestAttempts();
  const metaAssetsMocksBeforeAnonymous = await shopifyScenarioExternalAttempts(providerMockLogPath);
  const anonymousMetaAssetsResponse = await fetch(base + "/api/meta/assets");
  const anonymousMetaAssets = await anonymousMetaAssetsResponse.json();
  const invalidMetaAssetsResponse = await fetch(base + "/api/meta/assets", {
    headers: { Authorization: "Bearer invalid-meta-assets-session" }
  });
  const invalidMetaAssets = await invalidMetaAssetsResponse.json();
  for (const [label, response, body] of [
    ["anonymous", anonymousMetaAssetsResponse, anonymousMetaAssets],
    ["invalid-session", invalidMetaAssetsResponse, invalidMetaAssets]
  ]) {
    if (response.status !== 401
      || body.ok !== false
      || body.error !== "Sign in to Social Cues before using this API."
      || Object.keys(body).sort().join(",") !== "error,ok"
      || /workspace_writer_unclassified|commitStatus/iu.test(JSON.stringify(body))) {
      throw new Error(`${label} meta assets read should return an exact sanitized authentication requirement`);
    }
  }
  if (Buffer.compare(await readFile(metaAssetsModelPath), metaAssetsModelBeforeAnonymous) !== 0) throw new Error("anonymous meta assets denial changed persisted model state");
  if (JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(metaAssetsRequestsBeforeAnonymous)
    || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(metaAssetsMocksBeforeAnonymous)) {
    throw new Error("anonymous meta assets denial attempted provider traffic");
  }
  const metaAssetsRequestsBeforeAuthenticated = await externalHttpRequestAttempts();
  const metaAssetsMocksBeforeAuthenticated = await shopifyScenarioExternalAttempts(providerMockLogPath);
  const metaAssets = await request("/api/meta/assets", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!metaAssets.ok || !Array.isArray(metaAssets.accounts) || !Array.isArray(metaAssets.capabilities)) throw new Error("meta assets failed");
  if (!metaAssets.accounts.length && !metaAssets.diagnostic?.snapshot?.reason) throw new Error("meta assets should return a safe diagnostic when no Page or Instagram assets are visible");
  if (Object.prototype.hasOwnProperty.call(metaAssets.metaHealth || {}, "token")) throw new Error("meta assets exposed token-shaped health field");
  if (!metaAssetsPublicShapeIsSafe(metaAssets)
    || metaAssets.accounts.some(account => Object.hasOwn(account, "ownerUserId") || Object.hasOwn(account, "workspaceId"))) {
    throw new Error("meta assets exposed a private workspace or credential field");
  }
  const metaAssetsMockDelta = (await shopifyScenarioExternalAttempts(providerMockLogPath)).slice(metaAssetsMocksBeforeAuthenticated.length);
  if (JSON.stringify(metaAssetsMockDelta.map(entry => entry.kind)) !== JSON.stringify([
    "meta-debug-token-mock",
    "meta-permissions-mock",
    "meta-accounts-mock",
    "meta-businesses-mock"
  ]) || metaAssetsMockDelta.some(entry => entry.method !== "GET")) {
    throw new Error("authenticated meta assets read did not use the guarded provider fixture");
  }
  if (JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(metaAssetsRequestsBeforeAuthenticated)) {
    throw new Error("authenticated meta assets read attempted an unguarded provider request");
  }
  assertMetaAssetsPrivateMarkersAbsent(
    [anonymousMetaAssets, invalidMetaAssets, metaAssets, metaAssetsMockDelta],
    ["test-meta-app-secret", "fake-test-token-marker", SYNTHETIC_META_ASSETS_PAGE_TOKEN, login.session.token],
    "monolithic HTTP or mock evidence"
  );

  const metaHealthModelPath = path.join(testDataDir, "model.json");
  const metaHealthModelBeforeAnonymous = await readFile(metaHealthModelPath);
  const metaHealthRequestsBeforeAnonymous = await externalHttpRequestAttempts();
  const anonymousMetaHealthResponse = await fetch(base + "/api/meta/health", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "foreign-meta-health-workspace",
      providerAccountId: "foreign-meta-health-account",
      token: "browser-meta-health-token",
      metaHealth: { marker: "browser-meta-health" },
      analytics: { marker: "browser-meta-analytics" }
    })
  });
  const anonymousMetaHealth = await anonymousMetaHealthResponse.json();
  if (
    anonymousMetaHealthResponse.status !== 401
    || anonymousMetaHealth.ok !== false
    || anonymousMetaHealth.error !== "Sign in to Social Cues before using this API."
  ) throw new Error("anonymous meta health write should require authentication");
  if (Buffer.compare(await readFile(metaHealthModelPath), metaHealthModelBeforeAnonymous) !== 0) throw new Error("anonymous meta health denial changed persisted model state");
  if (JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(metaHealthRequestsBeforeAnonymous)) throw new Error("anonymous meta health denial attempted a provider request");

  const metaHealth = await request("/api/meta/health", {
    method: "POST",
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!metaHealth.ok || !Array.isArray(metaHealth.accounts) || !Array.isArray(metaHealth.capabilities) || !metaHealth.health) throw new Error("meta health failed");
  if (Object.prototype.hasOwnProperty.call(metaHealth.health, "token")) throw new Error("meta health exposed token-shaped field");
  if (metaHealth.accounts.some(account => !account.connected || !account.tokenStored || !account.providerAccountId)) throw new Error("meta health returned placeholder accounts as assets");
  if (!metaHealth.accounts.length && !metaHealth.diagnostic?.actions?.length) throw new Error("meta health should include safe next actions when no Meta assets are visible");

  const badMetaCallbackModelBefore = await readFile(metaAssetsModelPath);
  const badMetaCallbackRequestsBefore = await externalHttpRequestAttempts();
  const badMetaCallbackMocksBefore = await shopifyScenarioExternalAttempts(providerMockLogPath);
  const badMetaCallback = await fetch(base + "/api/oauth/meta/callback?code=fake-code&state=bad-state");
  const badMetaCallbackText = await badMetaCallback.text();
  if (badMetaCallback.status !== 400
    || !badMetaCallbackText.includes("<h1>Meta OAuth state rejected</h1>")
    || !badMetaCallbackText.includes(`<p>${META_CALLBACK_UNISSUED_ERROR}</p>`)
    || badMetaCallback.headers.get("set-cookie")
    || /workspace_writer_unclassified|commitStatus/iu.test(badMetaCallbackText)) {
    throw new Error("meta callback should reject unissued OAuth state without exposing the local persistence classifier");
  }
  if (Buffer.compare(await readFile(metaAssetsModelPath), badMetaCallbackModelBefore) !== 0) {
    throw new Error("unissued meta callback changed durable model bytes");
  }
  if (JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(badMetaCallbackRequestsBefore)
    || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(badMetaCallbackMocksBefore)) {
    throw new Error("unissued meta callback attempted provider traffic");
  }

  const youtubeModelBeforeAnonymous = await readFile(metaAssetsModelPath);
  const youtubeRequestsBeforeAnonymous = await externalHttpRequestAttempts();
  const youtubeMocksBeforeAnonymous = await shopifyScenarioExternalAttempts(providerMockLogPath);
  const anonymousYoutubeStart = await fetch(base + "/api/oauth/youtube/start", { redirect: "manual" });
  const anonymousYoutubeStartText = await anonymousYoutubeStart.text();
  if (anonymousYoutubeStart.status !== 401
    || !anonymousYoutubeStartText.includes("<h1>Sign in required</h1>")
    || anonymousYoutubeStart.headers.get("location")
    || anonymousYoutubeStart.headers.get("set-cookie")
    || /workspace_writer_unclassified|commitStatus/iu.test(anonymousYoutubeStartText)) {
    throw new Error("anonymous youtube start should fail closed before issuing OAuth state");
  }
  if (Buffer.compare(await readFile(metaAssetsModelPath), youtubeModelBeforeAnonymous) !== 0
    || JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(youtubeRequestsBeforeAnonymous)
    || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(youtubeMocksBeforeAnonymous)) {
    throw new Error("anonymous youtube start changed durable state or attempted provider traffic");
  }
  const youtubeStart = await fetch(base + "/api/oauth/youtube/start", {
    redirect: "manual",
    headers: { Authorization: `Bearer ${ownerSignup.session.token}` }
  });
  if (youtubeStart.status !== 302) throw new Error("authenticated youtube start should redirect to Google");
  const youtubeAuthUrl = new URL(youtubeStart.headers.get("location"));
  const youtubeState = youtubeAuthUrl.searchParams.get("state");
  if (!youtubeState) throw new Error("youtube start did not issue OAuth state");
  const youtubeCallbackSession = { headers: { Cookie: `sc_session=${encodeURIComponent(ownerSignup.session.token)}` } };
  const firstYoutubeCallback = await fetch(
    base + `/api/oauth/youtube/callback?code=fake-code&state=${encodeURIComponent(youtubeState)}`,
    youtubeCallbackSession
  );
  const firstYoutubeText = await firstYoutubeCallback.text();
  if (firstYoutubeCallback.status !== 200 || !firstYoutubeText.includes("YouTube token exchange failed")) throw new Error("youtube callback should consume ledger state and reach token exchange");
  const youtubeRequestsBeforeReplay = await externalHttpRequestAttempts();
  const secondYoutubeCallback = await fetch(
    base + `/api/oauth/youtube/callback?code=fake-code&state=${encodeURIComponent(youtubeState)}`,
    youtubeCallbackSession
  );
  const secondYoutubeText = await secondYoutubeCallback.text();
  if (secondYoutubeCallback.status !== 400
    || !secondYoutubeText.includes("YouTube OAuth state rejected")
    || !/already used/iu.test(secondYoutubeText)
    || JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(youtubeRequestsBeforeReplay)) {
    throw new Error("youtube callback replay should be rejected before another provider exchange");
  }
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

  const anonymousXAccountResponse = await fetch(base + "/api/x/account");
  const anonymousXAccount = await anonymousXAccountResponse.json();
  if (anonymousXAccountResponse.status !== 402
    || anonymousXAccount.ok !== false
    || anonymousXAccount.accessRequired !== true
    || anonymousXAccount.checkoutPath !== "/api/billing/checkout"
    || anonymousXAccount.portalPath !== "/portal"
    || Object.keys(anonymousXAccount).sort().join(",") !== "accessRequired,checkoutPath,error,ok,portalPath"
    || containsCredentialLikeOwnershipField(anonymousXAccount)
    || /workspace_writer_unclassified|commitStatus/iu.test(JSON.stringify(anonymousXAccount))) {
    throw new Error("x account must fail closed before anonymous workspace or provider access");
  }

  const xAnonymousPayload = {
    text: "Social Cues X anonymous smoke test",
    live: false,
    workspaceId: "foreign-x-workspace",
    ownerUserId: "foreign-x-owner",
    providerAccountId: "foreign-x-provider-account",
    token: "synthetic-x-browser-token"
  };
  await assertAnonymousMutationDenied(
    "/api/x/post",
    xAnonymousPayload,
    "anonymous X post",
    [xAnonymousPayload.workspaceId, xAnonymousPayload.ownerUserId, xAnonymousPayload.providerAccountId, xAnonymousPayload.token]
  );
  const xPostRequestsBeforeAuthenticated = await externalHttpRequestAttempts();
  const xPostBlocked = await fetch(base + "/api/x/post", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({
      text: "Social Cues X smoke test",
      live: false,
      workspaceId: xAnonymousPayload.workspaceId,
      ownerUserId: xAnonymousPayload.ownerUserId,
      providerAccountId: xAnonymousPayload.providerAccountId
    })
  });
  const xPostBody = await xPostBlocked.json();
  if (![200, 409].includes(xPostBlocked.status)) throw new Error("x post returned unexpected status");
  if (xPostBlocked.status === 200 && !xPostBody.dryRun) throw new Error("x post should dry-run unless explicitly live submitted");
  if (xPostBlocked.status === 409 && !xPostBody.connectRoute) throw new Error("x post gate should provide connect route");
  if (JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(xPostRequestsBeforeAuthenticated)) throw new Error("authenticated X dry run attempted a real provider request");
  if ([xAnonymousPayload.workspaceId, xAnonymousPayload.ownerUserId, xAnonymousPayload.providerAccountId].some(marker => JSON.stringify(xPostBody).includes(marker))) throw new Error("X post body identity fields influenced the authenticated response");

  const reviewPack = await request("/api/meta/review-pack");
  if (!reviewPack.ok || !reviewPack.dataDeletionUri || !Array.isArray(reviewPack.statements)) throw new Error("meta review pack failed");
  if (!reviewPack.termsOfServiceUrl || !reviewPack.termsOfServiceUrl.endsWith("/terms")) throw new Error("meta review pack missing terms URL");
  if (!reviewPack.dataDeletionUri || !reviewPack.dataDeletionUri.endsWith("/api/meta/data-deletion")) throw new Error("meta review pack missing data deletion URL");
  if (!reviewPack.dashboardEvidence?.needsAddOrReview?.instagramBusinessLogin?.includes("instagram_business_manage_messages")) throw new Error("meta review pack missing Instagram portal evidence");

  const commerceAnonymousPayload = {
    event: "anonymous_test_signal",
    value: 1,
    workspaceId: "foreign-commerce-workspace",
    ownerUserId: "foreign-commerce-owner",
    providerAccountId: "foreign-commerce-provider-account",
    token: "synthetic-commerce-browser-token"
  };
  await assertAnonymousMutationDenied(
    "/api/meta/commerce/signals",
    commerceAnonymousPayload,
    "anonymous Meta commerce signal",
    [commerceAnonymousPayload.workspaceId, commerceAnonymousPayload.ownerUserId, commerceAnonymousPayload.providerAccountId, commerceAnonymousPayload.token]
  );
  const commerceWorkspaceBefore = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  const trustedCommerceWorkspaceId = commerceWorkspaceBefore.workspace?.id;
  const commerceRequestsBeforeAuthenticated = await externalHttpRequestAttempts();
  const commerceSignal = await request("/api/meta/commerce/signals", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({
      event: "test_signal",
      value: 1,
      workspaceId: commerceAnonymousPayload.workspaceId,
      ownerUserId: commerceAnonymousPayload.ownerUserId,
      providerAccountId: commerceAnonymousPayload.providerAccountId
    })
  });
  if (!commerceSignal.ok || !commerceSignal.signal.id) throw new Error("meta commerce signal failed");
  const commerceWorkspaceAfter = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if (!trustedCommerceWorkspaceId || commerceWorkspaceAfter.workspace?.id !== trustedCommerceWorkspaceId || commerceWorkspaceAfter.workspace?.ownerUserId !== login.user.id) throw new Error("meta commerce signal did not remain in the authenticated active workspace");
  if (!(commerceWorkspaceAfter.metaCommerceSignals || []).some(signal => signal.id === commerceSignal.signal.id)) throw new Error("meta commerce signal did not persist through the authenticated workspace");
  if (JSON.stringify(commerceWorkspaceAfter).includes(commerceAnonymousPayload.workspaceId) || JSON.stringify(commerceWorkspaceAfter).includes(commerceAnonymousPayload.ownerUserId) || JSON.stringify(commerceWorkspaceAfter).includes(commerceAnonymousPayload.providerAccountId)) throw new Error("meta commerce signal accepted foreign body identity authority");
  if (JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(commerceRequestsBeforeAuthenticated)) throw new Error("authenticated Meta commerce signal attempted a real provider request");

  const billingModelPath = path.join(testDataDir, "model.json");
  const billingFixtureModelBefore = JSON.parse(await readFile(billingModelPath, "utf8"));
  if (billingFixtureModelBefore.format !== "social-cues.local-workspace-content.v1"
    || Object.prototype.hasOwnProperty.call(billingFixtureModelBefore, "workspace")
    || !Array.isArray(billingFixtureModelBefore.shared?.workspaces)
    || !Array.isArray(billingFixtureModelBefore.shared?.authUsers)
    || !Array.isArray(billingFixtureModelBefore.shared?.deviceSessions)
    || !billingFixtureModelBefore.workspaces
    || typeof billingFixtureModelBefore.workspaces !== "object"
    || Array.isArray(billingFixtureModelBefore.workspaces)) {
    throw new Error("billing checkout fixture requires the canonical revisioned workspace document");
  }
  const billingSessionCandidates = [login, ownerSignup, memberPromoSignup, secondSignup]
    .filter(candidate => candidate?.session?.token && candidate?.session?.deviceId && candidate?.user?.id && candidate?.workspace?.id)
    .map(candidate => ({
      token: candidate.session.token,
      deviceId: candidate.session.deviceId,
      userId: candidate.user.id,
      workspaceId: candidate.workspace.id,
      role: candidate.user.role || ""
    }));
  const fixtureWorkspaces = billingFixtureModelBefore.shared.workspaces;
  const fixtureUsers = billingFixtureModelBefore.shared.authUsers;
  const fixtureDevices = billingFixtureModelBefore.shared.deviceSessions;
  const ownsCanonicalWorkspace = candidate => (
    fixtureWorkspaces.some(workspace => workspace?.id === candidate.workspaceId && workspace?.ownerUserId === candidate.userId)
    && fixtureUsers.some(user => user?.id === candidate.userId && user?.workspaceId === candidate.workspaceId)
    && fixtureDevices.some(device => (
      device?.userId === candidate.userId
      && device?.deviceId === candidate.deviceId
      && device?.workspaceId === candidate.workspaceId
      && !device?.revokedAt
    ))
    && Boolean(billingFixtureModelBefore.workspaces[candidate.workspaceId])
  );
  const canonicalBillingOwner = billingSessionCandidates.find(ownsCanonicalWorkspace);
  const canonicalBillingNonOwnerSource = billingSessionCandidates.find(candidate => (
    canonicalBillingOwner
    && candidate.userId !== canonicalBillingOwner.userId
    && !["owner", "admin"].includes(String(candidate.role || "").trim().toLowerCase())
    && ownsCanonicalWorkspace(candidate)
  ));
  const foreignBillingWorkspace = billingSessionCandidates.find(candidate => (
    canonicalBillingOwner
    && canonicalBillingNonOwnerSource
    && candidate.userId !== canonicalBillingOwner.userId
    && candidate.userId !== canonicalBillingNonOwnerSource.userId
    && candidate.workspaceId !== canonicalBillingOwner.workspaceId
    && ownsCanonicalWorkspace(candidate)
  ));
  if (!canonicalBillingOwner || !canonicalBillingNonOwnerSource || !foreignBillingWorkspace) {
    throw new Error("billing checkout fixture could not resolve canonical owner and foreign workspace controls");
  }
  const billingFixtureRequestsBefore = await externalHttpRequestAttempts();
  const billingFixtureMocksBefore = await shopifyScenarioExternalAttempts(providerMockLogPath);
  await stopMainTestServer();
  const billingWorkspaceLockPath = path.join(testDataDir, ".workspace-content.lock");
  if (await access(billingWorkspaceLockPath).then(() => true, error => error?.code !== "ENOENT")) {
    throw new Error("billing checkout fixture could not acquire released revisioned storage");
  }
  await bindBillingCheckoutNonOwnerDeviceFixture({
    owner: canonicalBillingOwner,
    nonOwner: canonicalBillingNonOwnerSource
  });
  startMainTestServer();
  await waitForServer();
  if (JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(billingFixtureRequestsBefore)
    || JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(billingFixtureMocksBefore)) {
    throw new Error("billing checkout fixture setup attempted a provider or external request");
  }

  const billingModelBefore = await readFile(billingModelPath);
  const canonicalBillingModel = JSON.parse(billingModelBefore.toString("utf8"));
  const canonicalBillingWorkspace = canonicalBillingModel.shared?.workspaces?.find(workspace => (
    workspace?.id === canonicalBillingOwner.workspaceId && workspace?.ownerUserId === canonicalBillingOwner.userId
  ));
  const canonicalBillingNonOwnerDevice = canonicalBillingModel.shared?.deviceSessions?.find(device => (
    device?.userId === canonicalBillingNonOwnerSource.userId
    && device?.deviceId === canonicalBillingNonOwnerSource.deviceId
    && !device?.revokedAt
  ));
  const canonicalBillingNonOwner = {
    ...canonicalBillingNonOwnerSource,
    workspaceId: canonicalBillingNonOwnerDevice?.workspaceId || ""
  };
  if (!canonicalBillingWorkspace
    || canonicalBillingNonOwner.userId === canonicalBillingWorkspace.ownerUserId
    || canonicalBillingNonOwner.workspaceId !== canonicalBillingWorkspace.id
    || foreignBillingWorkspace.workspaceId === canonicalBillingWorkspace.id
    || JSON.stringify(canonicalBillingModel.shared.workspaces) !== JSON.stringify(fixtureWorkspaces)
    || Object.prototype.hasOwnProperty.call(canonicalBillingModel, "workspace")) {
    throw new Error("billing checkout fixture did not establish canonical owner, same-workspace non-owner, and foreign controls");
  }

  const billingRequestsBefore = await externalHttpRequestAttempts();
  const billingMocksBefore = await shopifyScenarioExternalAttempts(providerMockLogPath);
  const billingRouteStart = serverSource.indexOf('url.pathname === "/api/billing/checkout"');
  const billingRouteEnd = serverSource.indexOf('url.pathname === "/api/billing/portal"', billingRouteStart);
  const billingRouteSource = billingRouteStart >= 0 && billingRouteEnd > billingRouteStart
    ? serverSource.slice(billingRouteStart, billingRouteEnd)
    : "";
  if (!billingRouteSource.includes("requireWorkspaceManagementAccess") || !billingRouteSource.includes("prepareCheckoutHeld")) {
    throw new Error("billing checkout fixture did not reach the shared held application boundary");
  }
  for (const forbiddenOperation of ["bodyJson", "createStripeCheckoutSession", "saveModel(", "saveModelForUser(", "supabaseRequest(", "stripeBillingGatewayRequest(", "billing_entitlements", "fetch("]) {
    if (billingRouteSource.includes(forbiddenOperation)) throw new Error(`held billing checkout route retained ${forbiddenOperation}`);
  }
  const stripeApplicationSource = await readFile(path.resolve("stripe-billing-application.mjs"), "utf8");
  const heldCheckoutStart = stripeApplicationSource.indexOf("async function prepareCheckoutHeld");
  const heldCheckoutEnd = stripeApplicationSource.indexOf("async function preparePortalHeld", heldCheckoutStart);
  const heldCheckoutSource = heldCheckoutStart >= 0 && heldCheckoutEnd > heldCheckoutStart
    ? stripeApplicationSource.slice(heldCheckoutStart, heldCheckoutEnd)
    : "";
  if (!heldCheckoutSource.includes('return heldResult("checkout")')) throw new Error("Stripe checkout held operation is unavailable");
  for (const forbiddenOperation of ["lifecycle.", "repository.", "gateway.", "fetch(", "billing_entitlements"]) {
    if (heldCheckoutSource.includes(forbiddenOperation)) throw new Error(`held checkout operation retained ${forbiddenOperation}`);
  }

  async function billingResponse(pathname, { method = "GET", token = "", body } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(base + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }

  function assertBillingResponseRedacted(result, label, hostileMarkers = []) {
    const forbiddenKeys = new Set([
      "url", "paymenturl", "paymentlink", "priceid", "stripepriceid", "productid",
      "customerid", "subscriptionid", "checkoutsessionid", "paymentintentid",
      "providerrequestid", "requestid", "secret", "clientsecret", "webhooksecret",
      "configuration", "stack", "sql", "query", "raw", "gatewayoutput", "provideroutput"
    ]);
    const visit = value => {
      if (Array.isArray(value)) return value.some(visit);
      if (!value || typeof value !== "object") return false;
      return Object.entries(value).some(([key, nested]) => (
        forbiddenKeys.has(String(key).replace(/[_-]/g, "").toLowerCase()) || visit(nested)
      ));
    };
    const serialized = JSON.stringify(result);
    if (visit(result)
      || /https?:\/\//i.test(serialized)
      || /\b(?:price|prod|cus|sub|cs|pi|req)_[A-Za-z0-9]+\b/.test(serialized)
      || /\b(?:sk_(?:test|live)|whsec)_[A-Za-z0-9]+\b/i.test(serialized)
      || hostileMarkers.some(marker => marker && serialized.includes(marker))) {
      throw new Error(`${label} exposed payment, provider, configuration, or hostile body authority`);
    }
  }

  async function assertBillingCheckoutInert(label) {
    if (Buffer.compare(await readFile(billingModelPath), billingModelBefore) !== 0) {
      throw new Error(`${label} changed workspace, billing, entitlement, queue, or durable model state`);
    }
    if (JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(billingRequestsBefore)) {
      throw new Error(`${label} attempted a provider or external request`);
    }
    if (JSON.stringify(await shopifyScenarioExternalAttempts(providerMockLogPath)) !== JSON.stringify(billingMocksBefore)) {
      throw new Error(`${label} attempted a mocked provider request`);
    }
  }

  const billingReadiness = await billingResponse("/api/billing/readiness");
  if (billingReadiness.status !== 200
    || billingReadiness.body?.releaseStage !== "readiness_only"
    || billingReadiness.body?.checkoutAvailable !== false
    || billingReadiness.body?.portalAvailable !== false
    || billingReadiness.body?.webhookProcessingAvailable !== false) {
    throw new Error("billing readiness did not remain readiness-only and fail-closed");
  }
  await assertBillingCheckoutInert("billing readiness");

  const billingStatus = await billingResponse("/api/billing/status", {
    token: canonicalBillingOwner.token
  });
  if (billingStatus.status !== 200
    || billingStatus.body?.releaseStage !== "readiness_only"
    || billingStatus.body?.checkoutAvailable !== false
    || billingStatus.body?.portalAvailable !== false
    || billingStatus.body?.webhookProcessingAvailable !== false
    || billingStatus.body?.billing?.connected !== false) {
    throw new Error("authenticated canonical owner did not receive safe held billing status");
  }
  assertBillingResponseRedacted(billingStatus.body, "authenticated billing status");
  await assertBillingCheckoutInert("authenticated billing status");

  const anonymousCheckout = await billingResponse("/api/billing/checkout", {
    method: "POST",
    body: { selectedPlan: "anonymous-browser-plan" }
  });
  if (anonymousCheckout.status !== 401
    || anonymousCheckout.body?.ok !== false
    || !/account|sign in/i.test(anonymousCheckout.body?.error || "")) {
    throw new Error("anonymous billing checkout should return sanitized authentication-required denial");
  }
  assertBillingResponseRedacted(anonymousCheckout.body, "anonymous billing checkout", ["anonymous-browser-plan"]);
  await assertBillingCheckoutInert("anonymous billing checkout");

  const nonOwnerCheckout = await billingResponse("/api/billing/checkout", {
    method: "POST",
    token: canonicalBillingNonOwner.token,
    body: { selectedPlan: "non-owner-browser-plan" }
  });
  if (nonOwnerCheckout.status !== 403
    || nonOwnerCheckout.body?.ok !== false
    || !/owner or admin/i.test(nonOwnerCheckout.body?.error || "")) {
    throw new Error("authenticated local non-owner billing checkout should be denied");
  }
  assertBillingResponseRedacted(nonOwnerCheckout.body, "non-owner billing checkout", ["non-owner-browser-plan"]);
  await assertBillingCheckoutInert("non-owner billing checkout");

  const ownerCheckout = await billingResponse("/api/billing/checkout", {
    method: "POST",
    token: canonicalBillingOwner.token,
    body: { selectedPlan: "owner-browser-plan" }
  });
  if (ownerCheckout.status !== 503
    || ownerCheckout.body?.ok !== false
    || ownerCheckout.body?.status !== "activation_held"
    || ownerCheckout.body?.resultCode !== "checkout_activation_held"
    || ownerCheckout.body?.releaseStage !== "readiness_only"
    || ownerCheckout.body?.checkoutAvailable !== false
    || ownerCheckout.body?.portalAvailable !== false
    || ownerCheckout.body?.webhookProcessingAvailable !== false) {
    throw new Error("canonical local owner did not reach readiness-only held checkout");
  }
  assertBillingResponseRedacted(ownerCheckout.body, "canonical-owner held checkout", ["owner-browser-plan"]);
  await assertBillingCheckoutInert("canonical-owner held checkout");

  const adminClaimCheckout = await billingResponse("/api/billing/checkout", {
    method: "POST",
    token: canonicalBillingNonOwner.token,
    body: {
      role: "admin",
      workspaceId: canonicalBillingWorkspace.id,
      selectedPlan: "admin-claim-browser-plan"
    }
  });
  if (adminClaimCheckout.status !== 403
    || adminClaimCheckout.body?.ok !== false
    || !/owner or admin/i.test(adminClaimCheckout.body?.error || "")) {
    throw new Error("unsupported local admin claim should remain denied");
  }
  assertBillingResponseRedacted(adminClaimCheckout.body, "local admin-claim checkout", ["admin-claim-browser-plan"]);
  await assertBillingCheckoutInert("local admin-claim checkout");

  const hostileBillingBody = {
    selectedPlan: "hostile-browser-plan",
    amount: 1,
    currency: "ZZZ",
    priceId: "price_hostile_browser_authority",
    productId: "prod_hostile_browser_authority",
    customerId: "cus_hostile_browser_authority",
    subscriptionId: "sub_hostile_browser_authority",
    paymentLink: "https://payments.invalid/hostile",
    successUrl: "https://success.invalid/hostile",
    cancelUrl: "https://cancel.invalid/hostile",
    environment: "live",
    billingMode: "live",
    workspaceId: foreignBillingWorkspace.workspaceId,
    role: "owner",
    email: "hostile-billing-authority@example.test"
  };
  const hostileCheckout = await billingResponse("/api/billing/checkout", {
    method: "POST",
    token: canonicalBillingOwner.token,
    body: hostileBillingBody
  });
  if (hostileCheckout.status !== 503
    || hostileCheckout.body?.status !== "activation_held"
    || hostileCheckout.body?.resultCode !== "checkout_activation_held") {
    throw new Error("hostile billing body escaped readiness-only held checkout");
  }
  assertBillingResponseRedacted(hostileCheckout.body, "hostile-body held checkout", Object.values(hostileBillingBody));
  await assertBillingCheckoutInert("hostile-body held checkout");

  const foreignWorkspaceCheckout = await billingResponse("/api/billing/checkout", {
    method: "POST",
    token: canonicalBillingOwner.token,
    body: {
      workspaceId: foreignBillingWorkspace.workspaceId,
      selectedPlan: "foreign-workspace-browser-plan"
    }
  });
  if (foreignWorkspaceCheckout.status !== 503
    || foreignWorkspaceCheckout.body?.status !== "activation_held"
    || foreignWorkspaceCheckout.body?.resultCode !== "checkout_activation_held") {
    throw new Error("foreign body workspace redirected canonical-owner billing authority");
  }
  assertBillingResponseRedacted(foreignWorkspaceCheckout.body, "foreign-workspace held checkout", [
    foreignBillingWorkspace.workspaceId,
    "foreign-workspace-browser-plan"
  ]);
  await assertBillingCheckoutInert("foreign-workspace held checkout");

  if (billingCheckoutFixtureOnly) {
    await stopMainTestServer();
    if (await access(billingWorkspaceLockPath).then(() => true, error => error?.code !== "ENOENT")) {
      throw new Error("billing checkout focused fixture retained the revisioned workspace lock");
    }
    await rm(testDataDir, { recursive: true, force: true });
    let cleanupComplete = false;
    try {
      await access(testDataDir);
    } catch (error) {
      if (error?.code === "ENOENT") cleanupComplete = true;
      else throw error;
    }
    if (!cleanupComplete) throw new Error("billing checkout focused fixture cleanup was incomplete");
    console.log(JSON.stringify({
      ok: true,
      billingCheckout: {
        revisionedRootWorkspaceAbsent: true,
        canonicalOwnerResolved: true,
        sameWorkspaceNonOwnerResolved: true,
        foreignWorkspaceResolved: true,
        anonymousStatus: anonymousCheckout.status,
        nonOwnerStatus: nonOwnerCheckout.status,
        ownerStatus: ownerCheckout.status,
        adminClaimStatus: adminClaimCheckout.status,
        hostileBodyStatus: hostileCheckout.status,
        foreignBodyStatus: foreignWorkspaceCheckout.status,
        durableStateUnchangedByRequests: true,
        externalRequestDelta: 0,
        mockedProviderRequestDelta: 0,
        cleanupComplete
      }
    }));
    process.exit(0);
  }

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
  const discordPortalRow = portalAudit.rows.find(row => row.id === "discord");
  if (!discordPortalRow || !/portal-app-created|configured/i.test(discordPortalRow.status) || !/client secret|bot token|DISCORD_BOT_TOKEN/i.test(`${discordPortalRow.blocker} ${discordPortalRow.nextAction}`)) throw new Error("Discord portal audit should reflect the created app and remaining credentials");

  const depth = await request("/api/platform-capabilities/depth");
  if (!depth.ok || depth.total < 10 || !depth.categories.includes("community-ops")) throw new Error("platform capability depth failed");
  if (!depth.rows.some(row => row.provider === "discord" && row.deeperUse.includes("Slash commands"))) throw new Error("discord depth lane missing");
  if (!coreReadiness.depth || !Array.isArray(coreReadiness.depth.priorityBuildOrder) || !coreReadiness.depth.priorityBuildOrder.some(item => item.provider === "meta")) throw new Error("integration readiness missing capability depth summary");

  const openaiReady = await request("/api/openai/readiness");
  if (!openaiReady.ok || !openaiReady.serverSideOnly) throw new Error("openai readiness failed");

  const discordExternalRequestsBefore = (await externalHttpRequestAttempts()).length;
  const discordReady = await request("/api/discord/readiness");
  if (!discordReady.ok || !discordReady.redirectUri.includes("/api/oauth/discord/callback") || discordReady.connectRoute !== "/api/oauth/discord/start" || !discordReady.scopes.includes("identify")) throw new Error("discord readiness failed");
  if (!discordReady.install?.guildUrl?.includes("scope=bot+applications.commands") || discordReady.install?.botPermissionBits !== "126032" || !discordReady.install?.botPermissions?.includes("Manage Messages") || !discordReady.install?.botPermissions?.includes("Manage Channels")) throw new Error("discord install URL readiness failed");
  if (!discordReady.configured || discordReady.missingEnv?.includes("DISCORD_CLIENT_ID") || discordReady.missingEnv?.includes("DISCORD_CLIENT_SECRET")) throw new Error("discord alias credentials were not recognized");
  if (discordReady.botReady || discordReady.guildConfigured || discordReady.announcementChannelConfigured) throw new Error("discord OAuth readiness must not borrow interaction, bot, or workspace-target configuration");
  if (discordReady.account !== null) throw new Error("discord readiness borrowed connected-account state that is absent from this workspace");
  const discordInteractionsReady = await request("/api/discord/interactions/readiness");
  if (!discordInteractionsReady.ok || !discordInteractionsReady.ready || !discordInteractionsReady.configured || !discordInteractionsReady.endpoint.includes("/api/discord/interactions") || !discordInteractionsReady.publicKeyConfigured || !discordInteractionsReady.commandIdeas.some(item => item.includes("/cue status"))) throw new Error("discord interactions readiness failed");
  if (discordInteractionsReady.missingEnv?.length || discordInteractionsReady.optionalMissingEnv?.includes("DISCORD_PUBLIC_KEY") || !["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_ANNOUNCEMENT_CHANNEL_ID"].every(name => discordInteractionsReady.optionalMissingEnv?.includes(name))) throw new Error("discord interaction readiness must keep public-key, bot, and workspace-target gates separate");
  const discordReadinessPayload = JSON.stringify([discordReady, discordInteractionsReady]);
  if (discordReadinessPayload.includes(SYNTHETIC_DISCORD_CLIENT_SECRET) || discordReadinessPayload.includes(SYNTHETIC_DISCORD_PUBLIC_KEY)) throw new Error("discord readiness exposed configured credential material");

  const discordPingBody = JSON.stringify({ type: 1 });
  const discordPingTimestamp = String(Math.floor(Date.now() / 1000));
  const discordPingSignature = discordInteractionSignature(discordPingBody, discordPingTimestamp);
  const signedDiscordPing = await fetch(base + "/api/discord/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature-Ed25519": discordPingSignature,
      "X-Signature-Timestamp": discordPingTimestamp
    },
    body: discordPingBody
  });
  const signedDiscordPong = await signedDiscordPing.json();
  if (signedDiscordPing.status !== 200 || !signedDiscordPing.headers.get("content-type")?.includes("application/json") || signedDiscordPong.type !== 1) throw new Error("discord signed PING did not return PONG");
  const unsignedDiscordPing = await fetch(base + "/api/discord/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: discordPingBody
  });
  if (unsignedDiscordPing.status !== 401) throw new Error("discord interactions accepted an unsigned PING");
  const tamperedDiscordPing = await fetch(base + "/api/discord/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature-Ed25519": discordPingSignature,
      "X-Signature-Timestamp": discordPingTimestamp
    },
    body: JSON.stringify({ type: 1, tampered: true })
  });
  if (tamperedDiscordPing.status !== 401) throw new Error("discord interactions accepted a body that did not match its signature");
  const discordWebhookEventsReady = await request("/api/discord/webhook-events/readiness");
  if (!discordWebhookEventsReady.ok || !discordWebhookEventsReady.ready || !discordWebhookEventsReady.publicKeyConfigured || !discordWebhookEventsReady.endpoint.includes("/api/discord/webhook-events") || !discordWebhookEventsReady.subscriptions.includes("APPLICATION_DEAUTHORIZED")) throw new Error("discord webhook event readiness failed");
  const discordCommandsReady = await request("/api/discord/commands/readiness");
  if (!discordCommandsReady.ok || !discordCommandsReady.registerRoute.includes("/api/discord/commands/register") || !discordCommandsReady.commands.some(item => item.name === "cue")) throw new Error("discord command readiness failed");
  if (discordCommandsReady.ready || discordCommandsReady.botReady || !discordCommandsReady.optionalMissingEnv?.includes("DISCORD_BOT_TOKEN")) throw new Error("discord command readiness must require the separate bot-token family");
  const discordBotReady = await request("/api/discord/bot/readiness");
  if (!discordBotReady.ok || !Object.prototype.hasOwnProperty.call(discordBotReady, "botTokenConfigured") || !Array.isArray(discordBotReady.errors)) throw new Error("discord bot readiness failed");
  if (discordBotReady.ready || discordBotReady.botTokenConfigured || !discordBotReady.optionalMissingEnv?.includes("DISCORD_BOT_TOKEN")) throw new Error("discord bot readiness must remain false without a bot token");
  const discordVerificationPreflight = await request("/api/discord/verification-preflight");
  if (!discordVerificationPreflight.ok || !discordVerificationPreflight.dashboardFields?.some(field => field.label === "Interactions Endpoint URL") || !discordVerificationPreflight.gates?.some(gate => gate.id === "verification-final" && gate.finalStep && gate.deferred) || discordVerificationPreflight.verificationServerThreshold !== 100) throw new Error("discord verification preflight failed");
  const discordCommandsListResponse = await fetch(base + "/api/discord/commands");
  if (![200, 409].includes(discordCommandsListResponse.status)) throw new Error("discord registered command list should either return commands or a bot-config gate");

  const discordCommunityResponse = await fetch(base + "/api/discord/community");
  const discordCommunity = await discordCommunityResponse.json();
  if (discordCommunityResponse.status !== 402
    || discordCommunity.ok !== false
    || discordCommunity.accessRequired !== true
    || discordCommunity.checkoutPath !== "/api/billing/checkout"
    || discordCommunity.portalPath !== "/portal"
    || discordCommunity.error !== "Buy Social Cues or use an active approved promo entitlement before using the app."
    || JSON.stringify(Object.keys(discordCommunity).sort()) !== JSON.stringify(["accessRequired", "checkoutPath", "error", "ok", "portalPath"])) {
    throw new Error("anonymous Discord community reads should require app access before workspace account lookup");
  }
  if ((await externalHttpRequestAttempts()).length !== discordExternalRequestsBefore) throw new Error("discord readiness fixture attempted an external provider request");

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
  if (!authReady.ok || !["emailVerificationRequired", "passwordRecoveryReady", "loginAlertingReady", "rateLimitGuarded"].every(key => Object.prototype.hasOwnProperty.call(authReady, key))) throw new Error("auth readiness failed");
  if (authReady.signupAccess?.mode !== "invite-only" || authReady.signupAccess?.activePromoCodeCount < 4) throw new Error("auth readiness must expose invite-only signup policy");
  if (["sessionStorage", "nextSwitch", "missingEnv", "customSmtpReady", "refreshTokenRotationReady"].some(key => Object.prototype.hasOwnProperty.call(authReady, key))) throw new Error("public auth readiness must not expose internal implementation or environment details");

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
  if (!storageReady.ok || typeof storageReady.ready !== "boolean" || !storageReady.provider || !storageReady.maxUploadMb) throw new Error("media storage readiness failed");
  if ("bucket" in storageReady || "missingEnv" in storageReady) throw new Error("public media storage readiness must not expose private storage names or environment details");

  const securityAudit = await request("/api/security/audit");
  if (!securityAudit.ok || !securityAudit.headers || !securityAudit.auth?.publicUserListHidden) throw new Error("security audit failed");
  if (!securityAudit.secrets?.oauthTokenEncryption || !securityAudit.auth?.workspaceModelMirror) throw new Error("security audit missed core hardening status");

  const mediaPlanAnonymousPayload = {
    sourceName: "raw-test.mp4",
    brief: "Social Cues launch",
    workspaceId: "foreign-media-plan-workspace",
    userId: "foreign-media-plan-user",
    providerAccountId: "foreign-media-plan-provider-account",
    token: "synthetic-media-plan-browser-token",
    intent: {
      messageToPreserve: "Show creators the audience-intelligence payoff.",
      audience: "Creators building their first repeatable growth system",
      targetClipCount: 5
    }
  };
  await assertAnonymousMutationDenied(
    "/api/media/editor/plan",
    mediaPlanAnonymousPayload,
    "anonymous media editor plan",
    [mediaPlanAnonymousPayload.workspaceId, mediaPlanAnonymousPayload.userId, mediaPlanAnonymousPayload.providerAccountId, mediaPlanAnonymousPayload.token]
  );
  const mediaPlanRequestsBeforeAuthenticated = await externalHttpRequestAttempts();
  const mediaEditPlan = await request("/api/media/editor/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(mediaPlanAnonymousPayload)
  });
  if (!mediaEditPlan.ok || !mediaEditPlan.plan?.outputs?.length || !mediaEditPlan.serverRequirement) throw new Error("media editor plan failed");
  if (mediaEditPlan.plan.intent?.targetClipCount !== 5 || !mediaEditPlan.plan.intent?.messageToPreserve?.includes("audience-intelligence") || !mediaEditPlan.plan.intent?.audience?.includes("Creators")) throw new Error("media editor plan must preserve the user's message, audience, and requested clip count");
  if (![...(mediaEditPlan.plan.intake || []), ...(mediaEditPlan.plan.editPass || [])].some(stage => /scene|silence/i.test(stage)) || !mediaEditPlan.plan.reviewGate) throw new Error("media editor plan must include dissection stages and an explicit human review gate");
  if (!mediaEditPlan.plan.outputs.every(output => output.outputName?.startsWith("raw-test-") && output.filterPlan && output.safeArea && output.requiredReview)) throw new Error("media editor plan must include export names, filters, safe areas, and review gates");
  if (JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(mediaPlanRequestsBeforeAuthenticated)) throw new Error("authenticated media editor plan attempted an external provider request");
  if ([mediaPlanAnonymousPayload.workspaceId, mediaPlanAnonymousPayload.userId, mediaPlanAnonymousPayload.providerAccountId, mediaPlanAnonymousPayload.token].some(marker => JSON.stringify(mediaEditPlan).includes(marker))) throw new Error("media editor plan accepted browser identity or credential authority");

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

  const tiktokAnonymousPayload = {
    status: "connected",
    handle: "@should-not-connect",
    workspaceId: "foreign-tiktok-workspace",
    ownerUserId: "foreign-tiktok-owner",
    providerAccountId: "foreign-tiktok-provider-account",
    token: "synthetic-tiktok-browser-token"
  };
  await assertAnonymousMutationDenied(
    "/api/accounts/tiktok",
    tiktokAnonymousPayload,
    "anonymous TikTok account mutation",
    [tiktokAnonymousPayload.workspaceId, tiktokAnonymousPayload.ownerUserId, tiktokAnonymousPayload.providerAccountId, tiktokAnonymousPayload.token]
  );
  const tiktokRequestsBeforeAuthenticated = await externalHttpRequestAttempts();
  const manualConnectResponse = await fetch(base + "/api/accounts/tiktok", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(tiktokAnonymousPayload)
  });
  const manualConnect = await manualConnectResponse.json();
  if (manualConnectResponse.status !== 409 || manualConnect.ok !== false || manualConnect.platform !== "tiktok" || !manualConnect.connectRoutes?.tiktok) throw new Error("manual account connect should preserve the OAuth handoff gate");
  if (JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(tiktokRequestsBeforeAuthenticated)) throw new Error("authenticated TikTok manual-connect gate attempted a real provider request");
  if ([tiktokAnonymousPayload.workspaceId, tiktokAnonymousPayload.ownerUserId, tiktokAnonymousPayload.providerAccountId, tiktokAnonymousPayload.token].some(marker => JSON.stringify(manualConnect).includes(marker))) throw new Error("TikTok account fixture accepted body identity or credential authority");

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
  const serverCacheForgeryEnvelope = revisionedModelSaveEnvelope(cachedProviderModel);
  const serverCacheForgerySave = await request("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(serverCacheForgeryEnvelope)
  });
  if (serverCacheForgerySave.receipt?.operationId !== serverCacheForgeryEnvelope.operationId
    || !serverCacheForgerySave.receipt?.committedRevision) {
    throw new Error("server-owned cache forgery control did not use the revisioned model-save contract");
  }
  const serverRetainedModel = await request("/api/model", {
    headers: { Authorization: `Bearer ${login.session.token}` }
  });
  if ((serverRetainedModel.providerStateSnapshots || []).some(item => item.id === "provider-state-cache-test") || (serverRetainedModel.analyticsSnapshots || []).some(item => item.id === "analytics-cache-test")) {
    throw new Error("customer workspace writes must not forge server-owned provider or analytics snapshots");
  }

  const disconnectResponse = await request("/api/accounts/tiktok", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify({ disconnect: true, disabled: true, status: "not connected" })
  });
  if (!disconnectResponse.ok || disconnectResponse.account.connected || disconnectResponse.account.tokenStored) throw new Error("disconnect should clear account evidence");
  if (!disconnectResponse.cleanup?.purged || disconnectResponse.cleanup.purged.functionChecks < 1 || disconnectResponse.cleanup.purged.activity < 1) throw new Error("disconnect should clear cached provider checks and activity");

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

  const mediaGenerateAnonymousPayload = {
    provider: "Sora",
    platform: "tiktok",
    brief: "Social Cues launch",
    workspaceId: "foreign-media-generate-workspace",
    userId: "foreign-media-generate-user",
    providerAccountId: "foreign-media-generate-provider-account",
    token: "synthetic-media-generate-browser-token"
  };
  await assertAnonymousMutationDenied(
    "/api/media/generate",
    mediaGenerateAnonymousPayload,
    "anonymous media generation",
    [mediaGenerateAnonymousPayload.workspaceId, mediaGenerateAnonymousPayload.userId, mediaGenerateAnonymousPayload.providerAccountId, mediaGenerateAnonymousPayload.token]
  );
  const mediaGenerateRequestsBeforeAuthenticated = await externalHttpRequestAttempts();
  const media = await request("/api/media/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.session.token}` },
    body: JSON.stringify(mediaGenerateAnonymousPayload)
  });
  if (!media.ok || !media.prompt || media.provider !== "Sora" || media.platform !== "tiktok") throw new Error("media generation failed");
  if (JSON.stringify(await externalHttpRequestAttempts()) !== JSON.stringify(mediaGenerateRequestsBeforeAuthenticated)) throw new Error("authenticated media generation attempted a real provider request");
  if ([mediaGenerateAnonymousPayload.workspaceId, mediaGenerateAnonymousPayload.userId, mediaGenerateAnonymousPayload.providerAccountId, mediaGenerateAnonymousPayload.token].some(marker => JSON.stringify(media).includes(marker))) throw new Error("media generation accepted browser identity or credential authority");

  console.log(JSON.stringify({ ok: true, generated: generated.variants.length, queued: queued.status }));
  }
} finally {
  await stopMainTestServer();
}
