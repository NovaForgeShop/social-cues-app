import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { localContentCollections } from "./local-workspace-persistence.mjs";
import {
  readPartitionedLocalWorkspaceFixture,
  writePartitionedLocalWorkspaceFixture
} from "./test-support/local-workspace-fixture.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(root, "server.mjs");
const seedPath = path.join(root, "social-cues-model-seed.json");
const twitchIdNames = [
  "TWITCH_CLIENT_ID",
  "TWITCH_APP_ID",
  "TWITCH_OAUTH_CLIENT_ID",
  "twitch_client_id"
];
const twitchSecretNames = [
  "TWITCH_CLIENT_SECRET",
  "TWITCH_APP_SECRET",
  "TWITCH_OAUTH_CLIENT_SECRET",
  "twitch_client_secret"
];
const twitchCredentialNames = [...twitchIdNames, ...twitchSecretNames];
const unapprovedNames = ["TWITCH_APPLICATION_ID", "TWITCH_APPLICATION_SECRET"];
const authSessionSecret = "synthetic-auth-session-secret-for-twitch-contract";
const tokenEncryptionKey = "synthetic-token-encryption-key-for-twitch-contract";
const callbackAccessToken = "synthetic-twitch-access-token";
const callbackRefreshToken = "synthetic-twitch-refresh-token";
const workspaceAccessTokenA = "synthetic-workspace-twitch-access-token-a";
const workspaceRefreshTokenA = "synthetic-workspace-twitch-refresh-token-a";
const workspaceAccessTokenB = "synthetic-workspace-twitch-access-token-b";
const workspaceRefreshTokenB = "synthetic-workspace-twitch-refresh-token-b";
const userA = Object.freeze({
  id: "test-twitch-user-a",
  email: "twitch-user-a@example.test",
  name: "Twitch User A",
  role: "owner",
  workspaceId: "test-twitch-workspace-a"
});
const userB = Object.freeze({
  id: "test-twitch-user-b",
  email: "twitch-user-b@example.test",
  name: "Twitch User B",
  role: "owner",
  workspaceId: "test-twitch-workspace-b"
});
const bearerA = "synthetic-twitch-session-a";
const bearerB = "synthetic-twitch-session-b";
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "social-cues-twitch-readiness-"));
const requestGuardPath = path.join(temporaryRoot, "external-request-guard.mjs");
let checkCount = 0;

function check(condition, message) {
  assert.ok(condition, message);
  checkCount += 1;
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  checkCount += 1;
}

function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checkCount += 1;
}

function credentialValue(prefix, suffix) {
  return `${prefix}${suffix.replace(/[^a-z0-9]/gi, "").toLowerCase()}000000000000000000000000`;
}

function hashSessionToken(token) {
  return createHmac("sha256", authSessionSecret).update(token).digest("base64url");
}

function encryptedCredential(value) {
  const key = createHash("sha256").update(tokenEncryptionKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    value: ciphertext.toString("base64url")
  };
}

function twitchAccount({ user, providerAccountId, accessToken, refreshToken, connected = true }) {
  return {
    id: `acct-twitch-${user.id}`,
    platform: "twitch",
    oauthProvider: "twitch",
    name: user === userA ? "Synthetic Twitch A" : "Foreign Twitch B",
    handle: user === userA ? "@synthetic_a" : "@foreign_b",
    status: connected ? "connected" : "not connected",
    connectedAt: connected ? "2026-08-15T12:00:00.000Z" : null,
    ownerUserId: user.id,
    workspaceId: user.workspaceId,
    providerAccountId,
    scopes: ["user:read:email"],
    credential: connected ? encryptedCredential(accessToken) : null,
    refreshCredential: connected ? encryptedCredential(refreshToken) : null,
    tokenType: "bearer",
    tokenExpiresAt: connected ? "2036-08-15T12:00:00.000Z" : null
  };
}

function buildModel(seed, accountMode = "none") {
  const model = structuredClone(seed);
  for (const collection of localContentCollections) model[collection] = [];
  model.authUsers = [structuredClone(userA), structuredClone(userB)];
  model.deviceSessions = [
    {
      id: "device-twitch-a",
      deviceId: "device-twitch-a",
      userId: userA.id,
      workspaceId: userA.workspaceId,
      sessionTokenHash: hashSessionToken(bearerA),
      sessionProvider: "local-password",
      trusted: true,
      lastSeenAt: "2026-08-15T12:00:00.000Z",
      expiresAt: "2036-08-15T12:00:00.000Z"
    },
    {
      id: "device-twitch-b",
      deviceId: "device-twitch-b",
      userId: userB.id,
      workspaceId: userB.workspaceId,
      sessionTokenHash: hashSessionToken(bearerB),
      sessionProvider: "local-password",
      trusted: true,
      lastSeenAt: "2026-08-15T12:00:00.000Z",
      expiresAt: "2036-08-15T12:00:00.000Z"
    }
  ];
  model.workspaces = [
    { id: userA.workspaceId, name: "Workspace A", ownerUserId: userA.id, createdAt: "2026-08-15T12:00:00.000Z" },
    { id: userB.workspaceId, name: "Workspace B", ownerUserId: userB.id, createdAt: "2026-08-15T12:00:00.000Z" }
  ];
  model.workspace = structuredClone(model.workspaces[accountMode === "banked-b" ? 1 : 0]);
  model.oauthStates = [];
  model.oauthEvents = [];
  model.connectedAccounts = (model.connectedAccounts || []).filter(account => account.platform !== "twitch");
  model.activeProviderAccounts = { ...(model.activeProviderAccounts || {}) };

  if (accountMode === "banked-a" || accountMode === "disconnected-a") {
    const account = twitchAccount({
      user: userA,
      providerAccountId: "123456789",
      accessToken: workspaceAccessTokenA,
      refreshToken: workspaceRefreshTokenA,
      connected: accountMode === "banked-a"
    });
    model.connectedAccounts.push(account);
    model.activeProviderAccounts.twitch = account.providerAccountId;
  }
  if (accountMode === "banked-b") {
    const account = twitchAccount({
      user: userB,
      providerAccountId: "987654321",
      accessToken: workspaceAccessTokenB,
      refreshToken: workspaceRefreshTokenB,
      connected: true
    });
    model.connectedAccounts.push(account);
    model.activeProviderAccounts.twitch = account.providerAccountId;
  }
  return model;
}

function twitchScenarioEnv({ overrides = {}, dataDir, logPath, expectedId = "", expectedSecret = "", mockTwitch = false }) {
  const env = { ...process.env };
  const removedNames = new Set([...twitchCredentialNames, ...unapprovedNames].map(name => name.toLowerCase()));
  for (const existingName of Object.keys(env)) {
    if (removedNames.has(existingName.toLowerCase())) delete env[existingName];
  }
  const overrideNames = new Set(Object.keys(overrides).map(name => name.toLowerCase()));
  for (const name of twitchCredentialNames) {
    if (!overrideNames.has(name.toLowerCase())) env[name] = "";
  }
  return {
    ...env,
    ...overrides,
    PORT: "0",
    HOST: "127.0.0.1",
    PUBLIC_APP_URL: "https://socialcuesapp.example.test",
    TWITCH_PUBLIC_APP_URL: "https://socialcuesapp.example.test",
    TWITCH_DEVELOPER_REVIEW_STATUS: "Synthetic Twitch review status",
    SOCIAL_CUES_DATA_DIR: dataDir,
    SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: logPath,
    SOCIAL_CUES_TEST_EXPECTED_TWITCH_CLIENT_ID: expectedId,
    SOCIAL_CUES_TEST_EXPECTED_TWITCH_CLIENT_SECRET: expectedSecret,
    SOCIAL_CUES_TEST_MOCK_TWITCH: mockTwitch ? "1" : "0",
    AUTH_PROVIDER: "alpha-local",
    AUTH_SESSION_SECRET: authSessionSecret,
    OAUTH_TOKEN_ENCRYPTION_KEY: tokenEncryptionKey,
    SUPABASE_ENABLED: "false",
    SUPABASE_URL: "",
    SUPABASE_SECRET_KEY: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    SENTRY_DSN: "",
    VERCEL: ""
  };
}

async function availablePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  probe.close();
  await once(probe, "close");
  return port;
}

async function request(baseUrl, pathname, bearer = "") {
  const response = await fetch(`${baseUrl}${pathname}`, {
    redirect: "manual",
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return {
    status: response.status,
    location: response.headers.get("location") || "",
    text,
    body
  };
}

async function waitForServer(baseUrl, child, output) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Twitch contract server exited early (${child.exitCode}).\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { redirect: "manual" });
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Twitch contract server.\n${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    delay(3_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    })
  ]);
}

async function readGuardLog(logPath) {
  try {
    const source = await readFile(logPath, "utf8");
    return source.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readModel(dataDir) {
  return readPartitionedLocalWorkspaceFixture(path.join(dataDir, "model.json"), userA.workspaceId);
}

function oauthStateCount(model) {
  return (model.oauthStates || []).filter(state => state.provider === "twitch").length;
}

function twitchRow(payload, collection, label) {
  const rows = payload?.[collection] || payload?.rows || [];
  const row = rows.find(item => item.id === "twitch" || item.provider === "twitch");
  check(row, `${label} did not include Twitch`);
  return row;
}

function assertNoConnectOrReconnect(row, label) {
  equal(/\b(?:connect|reconnect) Twitch\b/iu.test(String(row?.nextAction || "")), false, `${label} recommended Connect or Reconnect`);
}

function assertSecretAbsent(label, value, secrets) {
  const text = String(value);
  const exposed = secrets
    .filter(item => String(item || "").length >= 8)
    .find(secret => text.includes(secret));
  equal(exposed, undefined, `${label} exposed protected Twitch test material`);
}

function expectedPortalDecision(scenario, configured) {
  if (!configured) return "application-credentials";
  if (scenario.accountMode === "banked-a") return "developer-approval";
  if (scenario.accountMode === "disconnected-a") return "reconnect";
  return "connect";
}

function assertPortalDecision(row, decision, scenarioLabel) {
  equal(row.category, decision, `${scenarioLabel}: portal category mismatch`);
  if (decision === "application-credentials") {
    equal(row.phase, "application-configuration", `${scenarioLabel}: application phase mismatch`);
    equal(/reconnect Twitch/iu.test(row.nextAction), false, `${scenarioLabel}: missing app credentials recommended Reconnect`);
    return;
  }
  if (decision === "connect") {
    equal(row.phase, "workspace-authorization", `${scenarioLabel}: connect phase mismatch`);
    check(/^Connect Twitch\b/iu.test(row.nextAction), `${scenarioLabel}: no-account guidance did not recommend Connect Twitch`);
    equal(/reconnect Twitch/iu.test(row.nextAction), false, `${scenarioLabel}: no-account guidance recommended Reconnect`);
    return;
  }
  if (decision === "reconnect") {
    equal(row.phase, "workspace-authorization", `${scenarioLabel}: reconnect phase mismatch`);
    check(/^Reconnect Twitch\b/iu.test(row.nextAction), `${scenarioLabel}: unusable account did not recommend Reconnect Twitch`);
    return;
  }
  equal(row.phase, "provider-proof", `${scenarioLabel}: banked-account phase mismatch`);
  equal(row.workspaceReady, true, `${scenarioLabel}: banked account was not workspace-ready`);
  assertNoConnectOrReconnect(row, `${scenarioLabel}: banked account`);
  check(/developer approval/iu.test(row.nextAction), `${scenarioLabel}: banked guidance omitted the remaining approval gate`);
  check(/channel.+action-check.+publish-check/iu.test(row.nextAction), `${scenarioLabel}: banked guidance omitted provider proof checks`);
}

async function readSurfaces(baseUrl, bearer) {
  const status = await request(baseUrl, "/api/oauth/twitch/status", bearer);
  const readiness = await request(baseUrl, "/api/twitch/readiness", bearer);
  const integrations = await request(baseUrl, "/api/integrations/readiness", bearer);
  const truth = await request(baseUrl, "/api/provider/truth", bearer);
  const contracts = await request(baseUrl, "/api/provider/contracts", bearer);
  const portal = await request(baseUrl, "/api/dev-portal/audit", bearer);
  return { status, readiness, integrations, truth, contracts, portal };
}

function assertSurfaceState({ scenario, surfaces, expectedConfigured, expectedMissing, expectedConnected, expectedBanked }) {
  for (const [label, response] of Object.entries(surfaces)) {
    equal(response.status, 200, `${scenario.label}: ${label} request failed`);
    check(response.body, `${scenario.label}: ${label} did not return JSON`);
  }
  const { status, readiness, integrations, truth, contracts, portal } = surfaces;
  const service = twitchRow(integrations.body, "providerServices", `${scenario.label}: integrations readiness`);
  const truthRow = twitchRow(truth.body, "rows", `${scenario.label}: provider truth`);
  const contractRow = twitchRow(contracts.body, "rows", `${scenario.label}: provider contracts`);
  const portalRow = twitchRow(portal.body, "rows", `${scenario.label}: portal audit`);
  const normalizedConfig = {
    status: { configured: status.body.configured, missingEnv: status.body.missingEnv },
    readiness: { configured: readiness.body.configured, missingEnv: readiness.body.missingEnv },
    integrations: { configured: service.configured, missingEnv: service.missingEnv },
    truth: { configured: truthRow.configured, missingEnv: truthRow.missingEnv },
    contracts: { configured: contractRow.gates.envReady, missingEnv: contractRow.missingEnv },
    portal: { configured: portalRow.configured, missingEnv: expectedMissing }
  };
  for (const [surface, state] of Object.entries(normalizedConfig)) {
    deepEqual(state, { configured: expectedConfigured, missingEnv: expectedMissing }, `${scenario.label}: ${surface} application state disagreed`);
  }
  equal(status.body.credentialSources.clientId, scenario.expectedIdSource || null, `${scenario.label}: status client ID source mismatch`);
  equal(status.body.credentialSources.clientSecret, scenario.expectedSecretSource || null, `${scenario.label}: status client secret source mismatch`);
  equal(status.body.connected, expectedConnected, `${scenario.label}: status connection state mismatch`);
  equal(readiness.body.connected, expectedConnected, `${scenario.label}: readiness connection state mismatch`);
  equal(truthRow.connected, expectedConnected, `${scenario.label}: provider truth connection state mismatch`);
  equal(contractRow.gates.oauthConnected, expectedConnected && expectedBanked, `${scenario.label}: provider contract OAuth gate mismatch`);
  equal(portalRow.connected, expectedConnected, `${scenario.label}: portal connection state mismatch`);
  equal(portalRow.banked, expectedBanked, `${scenario.label}: portal banked state mismatch`);
  return { service, truthRow, contractRow, portalRow };
}

const requestGuardSource = `
import { appendFileSync } from "node:fs";

const originalFetch = globalThis.fetch;
const logPath = process.env.SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG || "";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function record(entry) {
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\\n", "utf8");
}

globalThis.fetch = async (input, init = {}) => {
  const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const url = new URL(rawUrl);
  if (loopbackHosts.has(url.hostname)) return originalFetch(input, init);

  if (process.env.SOCIAL_CUES_TEST_MOCK_TWITCH === "1" && url.hostname === "id.twitch.tv" && url.pathname === "/oauth2/token") {
    const parameters = new URLSearchParams(String(init.body || ""));
    record({
      kind: "twitch-token-mock",
      clientIdMatches: parameters.get("client_id") === process.env.SOCIAL_CUES_TEST_EXPECTED_TWITCH_CLIENT_ID,
      clientSecretMatches: parameters.get("client_secret") === process.env.SOCIAL_CUES_TEST_EXPECTED_TWITCH_CLIENT_SECRET,
      grantType: parameters.get("grant_type") || ""
    });
    return new Response(JSON.stringify({
      access_token: "${callbackAccessToken}",
      refresh_token: "${callbackRefreshToken}",
      token_type: "bearer",
      expires_in: 3600,
      scope: ["user:read:email"]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (process.env.SOCIAL_CUES_TEST_MOCK_TWITCH === "1" && url.hostname === "id.twitch.tv" && url.pathname === "/oauth2/validate") {
    const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
    record({
      kind: "twitch-validate-mock",
      bearerPresent: /^OAuth\\s+\\S+$/u.test(headers.get("authorization") || "")
    });
    return new Response(JSON.stringify({
      client_id: process.env.SOCIAL_CUES_TEST_EXPECTED_TWITCH_CLIENT_ID || "unconfigured-test-client",
      login: "synthetic_streamer",
      scopes: ["user:read:email"],
      user_id: "123456789",
      expires_in: 3600
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (process.env.SOCIAL_CUES_TEST_MOCK_TWITCH === "1" && url.hostname === "api.twitch.tv" && url.pathname === "/helix/users") {
    const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
    record({
      kind: "twitch-users-mock",
      clientIdMatches: headers.get("client-id") === process.env.SOCIAL_CUES_TEST_EXPECTED_TWITCH_CLIENT_ID,
      bearerPresent: /^Bearer\\s+\\S+$/u.test(headers.get("authorization") || "")
    });
    return new Response(JSON.stringify({
      data: [{ id: "123456789", login: "synthetic_streamer", display_name: "Synthetic Streamer" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  record({ kind: "blocked-external-request", method: init.method || "GET", host: url.hostname, pathname: url.pathname });
  throw new Error("External requests are disabled by the Twitch readiness contract.");
};
`;

await writeFile(requestGuardPath, requestGuardSource, "utf8");

const serverSource = await readFile(serverPath, "utf8");
const seed = JSON.parse(await readFile(seedPath, "utf8"));
const aliasEntry = name => {
  const match = serverSource.match(new RegExp(`${name}:\\s*\\[([^\\]]*)\\]`, "u"));
  assert.ok(match, `${name} alias inventory is missing`);
  return JSON.parse(`[${match[1]}]`);
};

deepEqual(aliasEntry("TWITCH_CLIENT_ID"), twitchIdNames.slice(1), "Twitch client ID aliases changed");
deepEqual(aliasEntry("TWITCH_CLIENT_SECRET"), twitchSecretNames.slice(1), "Twitch client secret aliases changed");
check(serverSource.includes("const twitchApplicationCredentials = resolveTwitchApplicationCredentialState();"), "authoritative Twitch application credential state is missing");
check(serverSource.includes("credentialState: twitchApplicationCredentials"), "provider readiness does not consume the authoritative Twitch state");
check(serverSource.includes("function twitchSetupAuditForWorkspace("), "workspace-aware Twitch setup audit is missing");
check(serverSource.includes("function twitchWorkspaceAccountProjection("), "safe Twitch workspace projection is missing");
equal(/if\s*\(\s*!twitchClientId\s*\)/u.test(serverSource), false, "a Twitch OAuth start still gates on client ID alone");

const canonicalId = credentialValue("twclient", "canonical").slice(0, 30);
const canonicalSecret = credentialValue("twsecret", "canonical").slice(0, 40);
const appId = credentialValue("twclient", "app").slice(0, 30);
const appSecret = credentialValue("twsecret", "app").slice(0, 40);
const oauthId = credentialValue("twclient", "oauth").slice(0, 30);
const oauthSecret = credentialValue("twsecret", "oauth").slice(0, 40);
const lowercaseId = credentialValue("twclient", "lowercase").slice(0, 30);
const lowercaseSecret = credentialValue("twsecret", "lowercase").slice(0, 40);
const scenarios = [
  {
    label: "canonical pair, no account",
    overrides: { TWITCH_CLIENT_ID: canonicalId, TWITCH_CLIENT_SECRET: canonicalSecret },
    expectedId: canonicalId,
    expectedSecret: canonicalSecret,
    expectedIdSource: "TWITCH_CLIENT_ID",
    expectedSecretSource: "TWITCH_CLIENT_SECRET"
  },
  {
    label: "app alias pair, no account",
    overrides: { TWITCH_APP_ID: appId, TWITCH_APP_SECRET: appSecret },
    expectedId: appId,
    expectedSecret: appSecret,
    expectedIdSource: "TWITCH_APP_ID",
    expectedSecretSource: "TWITCH_APP_SECRET"
  },
  {
    label: "OAuth alias pair, no account",
    overrides: { TWITCH_OAUTH_CLIENT_ID: oauthId, TWITCH_OAUTH_CLIENT_SECRET: oauthSecret },
    expectedId: oauthId,
    expectedSecret: oauthSecret,
    expectedIdSource: "TWITCH_OAUTH_CLIENT_ID",
    expectedSecretSource: "TWITCH_OAUTH_CLIENT_SECRET"
  },
  {
    label: "lowercase alias pair, no account",
    overrides: { twitch_client_id: lowercaseId, twitch_client_secret: lowercaseSecret },
    expectedId: lowercaseId,
    expectedSecret: lowercaseSecret,
    expectedIdSource: "twitch_client_id",
    expectedSecretSource: "twitch_client_secret"
  },
  {
    label: "canonical ID plus app secret",
    overrides: { TWITCH_CLIENT_ID: canonicalId, TWITCH_APP_SECRET: appSecret },
    expectedId: canonicalId,
    expectedSecret: appSecret,
    expectedIdSource: "TWITCH_CLIENT_ID",
    expectedSecretSource: "TWITCH_APP_SECRET"
  },
  {
    label: "app ID plus canonical secret",
    overrides: { TWITCH_APP_ID: appId, TWITCH_CLIENT_SECRET: canonicalSecret },
    expectedId: appId,
    expectedSecret: canonicalSecret,
    expectedIdSource: "TWITCH_APP_ID",
    expectedSecretSource: "TWITCH_CLIENT_SECRET"
  },
  {
    label: "app ID plus OAuth secret",
    overrides: { TWITCH_APP_ID: appId, TWITCH_OAUTH_CLIENT_SECRET: oauthSecret },
    expectedId: appId,
    expectedSecret: oauthSecret,
    expectedIdSource: "TWITCH_APP_ID",
    expectedSecretSource: "TWITCH_OAUTH_CLIENT_SECRET"
  },
  {
    label: "OAuth ID plus app secret",
    overrides: { TWITCH_OAUTH_CLIENT_ID: oauthId, TWITCH_APP_SECRET: appSecret },
    expectedId: oauthId,
    expectedSecret: appSecret,
    expectedIdSource: "TWITCH_OAUTH_CLIENT_ID",
    expectedSecretSource: "TWITCH_APP_SECRET"
  },
  {
    label: "lowercase ID plus approved uppercase alias secret",
    overrides: { twitch_client_id: lowercaseId, TWITCH_APP_SECRET: appSecret },
    expectedId: lowercaseId,
    expectedSecret: appSecret,
    expectedIdSource: "twitch_client_id",
    expectedSecretSource: "TWITCH_APP_SECRET"
  },
  {
    label: "canonical precedence",
    overrides: {
      TWITCH_CLIENT_ID: canonicalId,
      TWITCH_CLIENT_SECRET: canonicalSecret,
      TWITCH_APP_ID: appId,
      TWITCH_APP_SECRET: appSecret
    },
    expectedId: canonicalId,
    expectedSecret: canonicalSecret,
    expectedIdSource: "TWITCH_CLIENT_ID",
    expectedSecretSource: "TWITCH_CLIENT_SECRET"
  },
  {
    label: "empty canonical plus valid alias",
    overrides: {
      TWITCH_CLIENT_ID: "   ",
      TWITCH_CLIENT_SECRET: "\t",
      TWITCH_APP_ID: appId,
      TWITCH_APP_SECRET: appSecret
    },
    expectedId: appId,
    expectedSecret: appSecret,
    expectedIdSource: "TWITCH_APP_ID",
    expectedSecretSource: "TWITCH_APP_SECRET"
  },
  {
    label: "client ID only",
    overrides: { TWITCH_CLIENT_ID: canonicalId },
    expectedId: canonicalId,
    expectedIdSource: "TWITCH_CLIENT_ID",
    missingEnv: ["TWITCH_CLIENT_SECRET"]
  },
  {
    label: "client secret only",
    overrides: { TWITCH_CLIENT_SECRET: canonicalSecret },
    expectedSecret: canonicalSecret,
    expectedSecretSource: "TWITCH_CLIENT_SECRET",
    missingEnv: ["TWITCH_CLIENT_ID"]
  },
  {
    label: "missing pair",
    overrides: {},
    missingEnv: ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"]
  },
  {
    label: "blank pair",
    overrides: { TWITCH_CLIENT_ID: "   ", TWITCH_CLIENT_SECRET: "\t" },
    missingEnv: ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"]
  },
  {
    label: "unapproved names",
    overrides: {
      TWITCH_APPLICATION_ID: credentialValue("twclient", "unapproved").slice(0, 30),
      TWITCH_APPLICATION_SECRET: credentialValue("twsecret", "unapproved").slice(0, 40)
    },
    missingEnv: ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"]
  },
  {
    label: "workspace token only, no application credentials",
    overrides: {},
    missingEnv: ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"],
    accountMode: "banked-a"
  },
  {
    label: "complete pair plus banked account",
    overrides: { TWITCH_CLIENT_ID: canonicalId, TWITCH_CLIENT_SECRET: canonicalSecret },
    expectedId: canonicalId,
    expectedSecret: canonicalSecret,
    expectedIdSource: "TWITCH_CLIENT_ID",
    expectedSecretSource: "TWITCH_CLIENT_SECRET",
    accountMode: "banked-a"
  },
  {
    label: "complete pair plus disconnected account",
    overrides: { TWITCH_CLIENT_ID: canonicalId, TWITCH_CLIENT_SECRET: canonicalSecret },
    expectedId: canonicalId,
    expectedSecret: canonicalSecret,
    expectedIdSource: "TWITCH_CLIENT_ID",
    expectedSecretSource: "TWITCH_CLIENT_SECRET",
    accountMode: "disconnected-a"
  },
  {
    label: "foreign workspace account",
    overrides: { TWITCH_CLIENT_ID: canonicalId, TWITCH_CLIENT_SECRET: canonicalSecret },
    expectedId: canonicalId,
    expectedSecret: canonicalSecret,
    expectedIdSource: "TWITCH_CLIENT_ID",
    expectedSecretSource: "TWITCH_CLIENT_SECRET",
    accountMode: "banked-b"
  }
];

const protectedValues = [...new Set([
  authSessionSecret,
  tokenEncryptionKey,
  bearerA,
  bearerB,
  callbackAccessToken,
  callbackRefreshToken,
  workspaceAccessTokenA,
  workspaceRefreshTokenA,
  workspaceAccessTokenB,
  workspaceRefreshTokenB,
  ...scenarios.flatMap(item => Object.entries(item.overrides)
    .filter(([name]) => /secret/iu.test(name))
    .map(([, value]) => String(value).trim())
    .filter(Boolean))
])];
let mockedProviderRequests = 0;
let callbackScenarios = 0;

try {
  for (const [index, scenario] of scenarios.entries()) {
    scenario.accountMode ||= "none";
    const expectedMissing = scenario.missingEnv || [];
    const expectedConfigured = expectedMissing.length === 0;
    const expectedConnectedBefore = scenario.accountMode === "banked-a";
    const expectedBankedBefore = expectedConnectedBefore;
    const decisionBefore = expectedPortalDecision(scenario, expectedConfigured);
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const dataDir = path.join(temporaryRoot, `scenario-${index}`);
    const logPath = path.join(dataDir, "request-log.ndjson");
    await mkdir(dataDir, { recursive: true });
    await writePartitionedLocalWorkspaceFixture({ dataDir, model: buildModel(seed, scenario.accountMode) });
    let stdout = "";
    let stderr = "";
    const env = twitchScenarioEnv({
      overrides: scenario.overrides,
      dataDir,
      logPath,
      expectedId: scenario.expectedId || "",
      expectedSecret: scenario.expectedSecret || "",
      mockTwitch: expectedConfigured || scenario.accountMode === "banked-a"
    });
    env.PORT = String(port);
    const child = spawn(process.execPath, [`--import=${pathToFileURL(requestGuardPath).href}`, serverPath], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    let capturedHttp = {};
    try {
      await waitForServer(baseUrl, child, () => `${stdout}\n${stderr}`);
      const globalPortal = await request(baseUrl, "/api/dev-portal/audit");
      equal(globalPortal.status, 200, `${scenario.label}: global portal audit failed`);
      const globalPortalRow = twitchRow(globalPortal.body, "rows", `${scenario.label}: global portal audit`);
      equal(globalPortalRow.workspaceContext, false, `${scenario.label}: global audit claimed workspace context`);
      if (expectedConfigured) assertNoConnectOrReconnect(globalPortalRow, `${scenario.label}: global audit`);

      const before = await readSurfaces(baseUrl, bearerA);
      const beforeRows = assertSurfaceState({
        scenario,
        surfaces: before,
        expectedConfigured,
        expectedMissing,
        expectedConnected: expectedConnectedBefore,
        expectedBanked: expectedBankedBefore
      });
      equal(before.status.body.clientIdPresent, Boolean(scenario.expectedId), `${scenario.label}: client ID presence mismatch`);
      equal(before.status.body.clientSecretPresent, Boolean(scenario.expectedSecret), `${scenario.label}: client secret presence mismatch`);
      equal(before.status.body.clientIdValid, Boolean(scenario.expectedId), `${scenario.label}: client ID validity mismatch`);
      equal(before.status.body.clientSecretValid, Boolean(scenario.expectedSecret), `${scenario.label}: client secret validity mismatch`);
      assertPortalDecision(beforeRows.portalRow, decisionBefore, scenario.label);

      const expectedAccountPresent = ["banked-a", "disconnected-a"].includes(scenario.accountMode);
      equal(beforeRows.portalRow.accountPresent, expectedAccountPresent, `${scenario.label}: portal account-presence mismatch`);
      if (!expectedConfigured) {
        for (const name of expectedMissing) {
          check(String(beforeRows.portalRow.blocker).includes(name), `${scenario.label}: portal blocker omitted ${name}`);
          check(String(beforeRows.portalRow.nextAction).includes(name), `${scenario.label}: portal next action omitted ${name}`);
        }
      }

      if (scenario.accountMode === "banked-b") {
        const foreignPortal = await request(baseUrl, "/api/dev-portal/audit", bearerB);
        const foreignRow = twitchRow(foreignPortal.body, "rows", `${scenario.label}: foreign owner audit`);
        assertPortalDecision(foreignRow, "developer-approval", `${scenario.label}: foreign owner`);
        const forgedSelectorPortal = await request(
          baseUrl,
          `/api/dev-portal/audit?workspaceId=${encodeURIComponent(userB.workspaceId)}&accountId=987654321`,
          bearerA
        );
        const forgedSelectorRow = twitchRow(forgedSelectorPortal.body, "rows", `${scenario.label}: forged selector audit`);
        assertPortalDecision(forgedSelectorRow, "connect", `${scenario.label}: forged selector`);
        const workspaceAOutput = JSON.stringify({ before, forgedSelectorPortal });
        equal(workspaceAOutput.includes("Foreign Twitch B"), false, `${scenario.label}: foreign account name leaked`);
        equal(workspaceAOutput.includes("@foreign_b"), false, `${scenario.label}: foreign handle leaked`);
        equal(workspaceAOutput.includes("987654321"), false, `${scenario.label}: foreign provider account ID leaked`);
      }

      if (scenario.accountMode === "disconnected-a") {
        const disconnectedModel = await readModel(dataDir);
        const disconnected = disconnectedModel.connectedAccounts.find(account => account.platform === "twitch");
        equal(disconnected.ownerUserId, userA.id, `${scenario.label}: disconnected account owner changed`);
        equal(disconnected.workspaceId, userA.workspaceId, `${scenario.label}: disconnected account workspace changed`);
        equal(beforeRows.portalRow.connectionState, "missing-token", `${scenario.label}: unsupported disconnect state was inferred`);
      }

      const beforeStartsModel = await readModel(dataDir);
      const stateCountBefore = oauthStateCount(beforeStartsModel);
      const guardBeforeStarts = await readGuardLog(logPath);
      const genericStart = await request(baseUrl, "/api/oauth/connect-url?provider=twitch", bearerA);
      const directStart = await request(baseUrl, "/api/oauth/twitch/start", bearerA);
      const afterStartsModel = await readModel(dataDir);
      const guardAfterStarts = await readGuardLog(logPath);
      equal(guardAfterStarts.length, guardBeforeStarts.length, `${scenario.label}: OAuth start performed a provider request`);

      if (expectedConfigured) {
        equal(genericStart.status, 200, `${scenario.label}: generic OAuth start did not succeed`);
        check(genericStart.body?.url, `${scenario.label}: generic OAuth start omitted its URL`);
        const genericUrl = new URL(genericStart.body.url);
        equal(genericUrl.hostname, "id.twitch.tv", `${scenario.label}: generic OAuth host mismatch`);
        equal(genericUrl.searchParams.get("client_id"), scenario.expectedId, `${scenario.label}: generic OAuth used the wrong client ID`);
        equal(directStart.status, 302, `${scenario.label}: direct OAuth start did not redirect`);
        const directUrl = new URL(directStart.location);
        equal(directUrl.hostname, "id.twitch.tv", `${scenario.label}: direct OAuth host mismatch`);
        equal(directUrl.searchParams.get("client_id"), scenario.expectedId, `${scenario.label}: direct OAuth used the wrong client ID`);
        equal(oauthStateCount(afterStartsModel), stateCountBefore + 2, `${scenario.label}: OAuth starts did not create exactly two owned states`);

        const state = genericUrl.searchParams.get("state") || "";
        check(state.length > 20, `${scenario.label}: generic OAuth state was not created`);
        const callback = await request(baseUrl, `/api/oauth/twitch/callback?code=synthetic-code&state=${encodeURIComponent(state)}`, bearerA);
        equal(callback.status, 200, `${scenario.label}: mocked callback failed`);
        check(/Twitch connected and token stored/u.test(callback.text), `${scenario.label}: mocked callback did not persist a banked account`);
        callbackScenarios += 1;

        const afterCallbackModel = await readModel(dataDir);
        equal(oauthStateCount(afterCallbackModel), stateCountBefore + 1, `${scenario.label}: callback did not consume only its own OAuth state`);
        const after = await readSurfaces(baseUrl, bearerA);
        const afterRows = assertSurfaceState({
          scenario,
          surfaces: after,
          expectedConfigured: true,
          expectedMissing: [],
          expectedConnected: true,
          expectedBanked: true
        });
        equal(afterRows.portalRow.accountPresent, true, `${scenario.label}: callback account was not visible to its workspace`);
        assertPortalDecision(afterRows.portalRow, "developer-approval", `${scenario.label}: after callback`);
        capturedHttp = { globalPortal, before, genericStart, directStart, callback, after };
      } else {
        equal(genericStart.status, 409, `${scenario.label}: generic OAuth start did not fail closed`);
        deepEqual(genericStart.body?.missingEnv, expectedMissing, `${scenario.label}: generic OAuth missing requirements mismatch`);
        equal(genericStart.location, "", `${scenario.label}: generic OAuth emitted a Location header`);
        equal(Boolean(genericStart.body?.url), false, `${scenario.label}: generic OAuth emitted an authorization URL`);
        equal(directStart.status === 302, false, `${scenario.label}: direct OAuth created a redirect`);
        equal(directStart.location, "", `${scenario.label}: direct OAuth emitted a Location header`);
        equal(directStart.text.includes("id.twitch.tv"), false, `${scenario.label}: direct OAuth emitted an authorization URL`);
        equal(oauthStateCount(afterStartsModel), stateCountBefore, `${scenario.label}: blocked OAuth start persisted state`);
        capturedHttp = { globalPortal, before, genericStart, directStart };
      }

      if (scenario.label === "workspace token only, no application credentials") {
        equal(beforeRows.portalRow.accountPresent, true, `${scenario.label}: owned account was hidden`);
        equal(beforeRows.portalRow.connected, true, `${scenario.label}: owned connection was hidden`);
        equal(beforeRows.portalRow.banked, true, `${scenario.label}: banked token evidence was hidden`);
        equal(beforeRows.portalRow.configured, false, `${scenario.label}: workspace token masked application configuration`);
        assertPortalDecision(beforeRows.portalRow, "application-credentials", scenario.label);
      }

      const publicOutput = JSON.stringify(capturedHttp);
      assertSecretAbsent(`${scenario.label}: HTTP output`, publicOutput, protectedValues);
      equal(publicOutput.includes('"alg":"aes-256-gcm"'), false, `${scenario.label}: encrypted credential envelope appeared in HTTP output`);
    } finally {
      await stopChild(child);
    }

    const guardEntries = await readGuardLog(logPath);
    const blocked = guardEntries.filter(entry => entry.kind === "blocked-external-request");
    deepEqual(blocked, [], `${scenario.label}: attempted a real external request`);
    if (expectedConfigured) {
      const tokenMock = guardEntries.find(entry => entry.kind === "twitch-token-mock");
      check(tokenMock, `${scenario.label}: callback did not reach the local token mock`);
      equal(tokenMock.clientIdMatches, true, `${scenario.label}: callback resolver used the wrong client ID`);
      equal(tokenMock.clientSecretMatches, true, `${scenario.label}: callback resolver used the wrong client secret`);
      equal(tokenMock.grantType, "authorization_code", `${scenario.label}: callback used the wrong token grant`);
      const usersMocks = guardEntries.filter(entry => entry.kind === "twitch-users-mock");
      check(usersMocks.length > 0, `${scenario.label}: Twitch identity did not reach the local mock`);
      check(usersMocks.every(entry => entry.bearerPresent), `${scenario.label}: a Twitch identity request omitted bearer authentication`);
      const validateMocks = guardEntries.filter(entry => entry.kind === "twitch-validate-mock");
      check(validateMocks.length > 0, `${scenario.label}: banked token validation did not reach the local mock`);
      check(validateMocks.every(entry => entry.bearerPresent), `${scenario.label}: Twitch token validation omitted OAuth authentication`);
    } else {
      equal(guardEntries.some(entry => entry.kind === "twitch-token-mock"), false, `${scenario.label}: incomplete credentials reached token exchange`);
    }
    mockedProviderRequests += guardEntries.filter(entry => entry.kind.endsWith("-mock")).length;

    const finalModelSource = await readFile(path.join(dataDir, "model.json"), "utf8");
    assertSecretAbsent(`${scenario.label}: model/session/audit state`, finalModelSource, protectedValues);
    assertSecretAbsent(`${scenario.label}: request guard log`, JSON.stringify(guardEntries), protectedValues);
    assertSecretAbsent(`${scenario.label}: stdout`, stdout, protectedValues);
    assertSecretAbsent(`${scenario.label}: stderr`, stderr, protectedValues);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  checks: checkCount,
  scenarios: scenarios.length,
  categories: {
    completeCredentialResolution: scenarios.filter(item => !(item.missingEnv || []).length).length,
    incompleteCredentialResolution: scenarios.filter(item => (item.missingEnv || []).length).length,
    mixedFamilyPairs: 5,
    workspaceAccountStates: 4,
    foreignWorkspaceIsolation: 1,
    callbackLifecycle: callbackScenarios
  },
  mockedProviderRequests,
  realProviderRequests: 0,
  secretsExposed: 0
}));
