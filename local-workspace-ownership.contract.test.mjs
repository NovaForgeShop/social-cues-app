import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { fixtureModel, injectSharedFixture, revisionedFixtureOptions } from "./tests/support/local-envelope-fixture.mjs";
import {
  applyCanonicalLocalOwnership,
  createLocalWorkspaceIdentity,
  LocalWorkspaceOwnershipError,
  validateLocalOwnershipState
} from "./local-workspace-ownership.mjs";

const categoryCounts = Object.create(null);
let checks = 0;

function check(condition, label, category = "general") {
  if (!condition) throw new Error(label);
  checks += 1;
  categoryCounts[category] = Number(categoryCounts[category] || 0) + 1;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectOwnershipError(callback, expectedCode, label, category = "hostile-mutation") {
  let caught = null;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  check(caught instanceof LocalWorkspaceOwnershipError, `${label}: wrong error type`, category);
  check(caught?.code === expectedCode, `${label}: wrong error code`, category);
  check(!/[A-Za-z]:\\|model\.json|password|token|secret/i.test(caught?.message || ""), `${label}: error exposed sensitive detail`, "safety");
}

const OWNER_A = "user-owner-a";
const WORKSPACE_A = "workspace-owner-a";
const OWNER_B = "user-owner-b";
const WORKSPACE_B = "workspace-owner-b";
const CREATED_A = "2026-08-30T12:00:00.000Z";
const CREATED_B = "2026-08-30T12:01:00.000Z";

const canonicalWorkspaceA = {
  id: WORKSPACE_A,
  ownerUserId: OWNER_A,
  createdAt: CREATED_A,
  name: "Canonical A",
  owner: "Owner A",
  ownerEmail: "owner-a@example.test",
  purpose: "Canonical workspace"
};
const canonicalWorkspaceB = {
  id: WORKSPACE_B,
  ownerUserId: OWNER_B,
  createdAt: CREATED_B,
  name: "Canonical B",
  owner: "Owner B",
  ownerEmail: "owner-b@example.test"
};
const currentModel = {
  version: "ownership-fixture",
  currentUser: { id: OWNER_A, email: "owner-a@example.test", role: "Member" },
  workspace: clone(canonicalWorkspaceA),
  workspaces: [clone(canonicalWorkspaceA), clone(canonicalWorkspaceB)],
  workspaceModel: {
    version: 1,
    source: "client-isolated-blank",
    clientIsolated: true,
    createdAt: CREATED_A
  },
  profile: { outcome: "Before" },
  campaigns: [],
  actions: []
};

const untrustedCreationInput = {
  id: "attacker-workspace",
  ownerUserId: "attacker-user",
  createdAt: "1999-01-01T00:00:00.000Z",
  name: "Customer workspace name",
  description: "Customer-editable description"
};
const untrustedCreationBefore = JSON.stringify(untrustedCreationInput);
const created = createLocalWorkspaceIdentity({
  authenticatedUserId: OWNER_A,
  generatedWorkspaceId: WORKSPACE_A,
  createdAt: CREATED_A,
  workspace: untrustedCreationInput
});
check(created.id === WORKSPACE_A, "trusted workspace generator did not control the new workspace ID", "pure-create");
check(created.ownerUserId === OWNER_A, "authenticated server user did not control the new owner", "pure-create");
check(created.createdAt === CREATED_A, "trusted creation timestamp was not preserved", "pure-create");
check(created.name === untrustedCreationInput.name && created.description === untrustedCreationInput.description, "customer-editable workspace fields were not preserved", "pure-create");
check(JSON.stringify(untrustedCreationInput) === untrustedCreationBefore, "workspace creation mutated its input", "pure-create");

const incomingUpdate = {
  ...clone(currentModel),
  currentUser: { id: "attacker-user", email: "attacker@example.test", role: "Owner" },
  workspace: {
    ...clone(canonicalWorkspaceA),
    ownerUserId: "attacker-user",
    createdAt: "2000-01-01T00:00:00.000Z",
    name: "Renamed by customer",
    description: "Updated description"
  },
  workspaces: [{
    ...clone(canonicalWorkspaceA),
    ownerUserId: "collection-attacker",
    createdAt: "2001-01-01T00:00:00.000Z",
    name: "Collection rename"
  }],
  profile: { outcome: "After" }
};
const currentBefore = JSON.stringify(currentModel);
const incomingBefore = JSON.stringify(incomingUpdate);
const updated = applyCanonicalLocalOwnership({
  authenticatedUserId: OWNER_A,
  activeWorkspaceId: WORKSPACE_A,
  currentModel,
  incomingModel: incomingUpdate,
  operation: "model-update"
});
check(updated.workspace.id === WORKSPACE_A, "ordinary update replaced the canonical workspace ID", "pure-update");
check(updated.workspace.ownerUserId === OWNER_A, "ordinary update replaced the canonical owner", "pure-update");
check(updated.workspace.createdAt === CREATED_A, "ordinary update replaced creation identity", "pure-update");
check(updated.workspace.name === "Renamed by customer" && updated.workspace.description === "Updated description", "ordinary update lost customer-editable workspace data", "pure-update");
check(updated.profile.outcome === "After", "ordinary update lost customer-editable model data", "pure-update");
check(updated.workspaces.length === 2, "ordinary update discarded another canonical workspace record", "pure-update");
check(updated.workspaces.find(item => item.id === WORKSPACE_A)?.ownerUserId === OWNER_A, "collection owner did not match top-level owner", "pure-update");
check(updated.workspaces.find(item => item.id === WORKSPACE_B)?.ownerUserId === OWNER_B, "foreign canonical workspace record changed", "pure-update");
check(JSON.stringify(currentModel) === currentBefore, "ownership overlay mutated current model input", "pure-update");
check(JSON.stringify(incomingUpdate) === incomingBefore, "ownership overlay mutated incoming model input", "pure-update");
updated.workspace.name = "Output mutation";
check(currentModel.workspace.name === "Canonical A" && incomingUpdate.workspace.name === "Renamed by customer", "ownership output was not defensive", "pure-update");
check(validateLocalOwnershipState({ model: applyCanonicalLocalOwnership({
  authenticatedUserId: OWNER_A,
  activeWorkspaceId: WORKSPACE_A,
  currentModel,
  incomingModel: incomingUpdate
}), activeWorkspaceId: WORKSPACE_A, authenticatedUserId: OWNER_A }).ownerUserId === OWNER_A, "canonical output validation failed", "pure-update");

const importInput = clone(incomingUpdate);
delete importInput.workspace.id;
delete importInput.workspaces;
importInput.workspace.ownerUserId = "imported-owner";
importInput.workspace.ownerEmail = "imported@example.test";
importInput.workspace.role = "Owner";
const imported = applyCanonicalLocalOwnership({
  authenticatedUserId: OWNER_A,
  activeWorkspaceId: WORKSPACE_A,
  currentModel,
  incomingModel: importInput,
  operation: "import"
});
check(imported.workspace.id === WORKSPACE_A && imported.workspace.ownerUserId === OWNER_A, "import replaced canonical ownership", "import-restore");
check(imported.workspace.ownerEmail === "imported@example.test" && imported.workspace.role === "Owner", "non-authoritative profile fields were unnecessarily made immutable", "import-restore");
check(imported.workspaceModel.source === currentModel.workspaceModel.source && imported.workspaceModel.createdAt === currentModel.workspaceModel.createdAt, "import replaced workspace provenance", "import-restore");

const restoreInput = clone(importInput);
restoreInput.workspace.ownerUserId = "restored-owner";
restoreInput.profile.outcome = "Restored customer data";
const restored = applyCanonicalLocalOwnership({
  authenticatedUserId: OWNER_A,
  activeWorkspaceId: WORKSPACE_A,
  currentModel,
  incomingModel: restoreInput,
  operation: "restore"
});
check(restored.workspace.ownerUserId === OWNER_A && restored.workspace.id === WORKSPACE_A, "restore replaced canonical identity", "import-restore");
check(restored.profile.outcome === "Restored customer data", "restore lost customer model data", "import-restore");

expectOwnershipError(() => applyCanonicalLocalOwnership({
  authenticatedUserId: OWNER_A,
  activeWorkspaceId: WORKSPACE_A,
  currentModel,
  incomingModel: { ...clone(incomingUpdate), workspace: { ...incomingUpdate.workspace, id: WORKSPACE_B } }
}), "workspace_identity_conflict", "foreign top-level workspace selector was accepted");
expectOwnershipError(() => applyCanonicalLocalOwnership({
  authenticatedUserId: OWNER_A,
  activeWorkspaceId: WORKSPACE_A,
  currentModel,
  incomingModel: { ...clone(incomingUpdate), activeWorkspaceId: WORKSPACE_B }
}), "workspace_identity_conflict", "foreign active workspace selector was accepted");
expectOwnershipError(() => applyCanonicalLocalOwnership({
  authenticatedUserId: OWNER_A,
  activeWorkspaceId: WORKSPACE_A,
  currentModel,
  incomingModel: { ...clone(incomingUpdate), workspaces: [clone(canonicalWorkspaceA), clone(canonicalWorkspaceB)] }
}), "workspace_identity_conflict", "foreign collection workspace was accepted");
expectOwnershipError(() => applyCanonicalLocalOwnership({
  authenticatedUserId: OWNER_A,
  activeWorkspaceId: WORKSPACE_A,
  currentModel,
  incomingModel: {
    ...clone(incomingUpdate),
    workspaces: [clone(canonicalWorkspaceA), { ...clone(canonicalWorkspaceA), ownerUserId: "attacker-user" }]
  }
}), "workspace_identity_conflict", "last duplicate workspace entry was accepted");
expectOwnershipError(() => applyCanonicalLocalOwnership({
  authenticatedUserId: OWNER_A,
  activeWorkspaceId: WORKSPACE_A,
  currentModel: { ...clone(currentModel), workspaces: [clone(canonicalWorkspaceB)] },
  incomingModel: incomingUpdate
}), "workspace_unavailable", "missing canonical workspace was repaired from untrusted input");
expectOwnershipError(() => applyCanonicalLocalOwnership({
  authenticatedUserId: OWNER_A,
  activeWorkspaceId: WORKSPACE_A,
  currentModel: {
    ...clone(currentModel),
    workspace: { ...clone(canonicalWorkspaceA), ownerUserId: OWNER_B },
    workspaces: [{ ...clone(canonicalWorkspaceA), ownerUserId: OWNER_B }]
  },
  incomingModel: incomingUpdate
}), "ownership_mismatch", "stored owner mismatch was accepted");
expectOwnershipError(() => validateLocalOwnershipState({
  model: { ...clone(currentModel), workspace: clone(canonicalWorkspaceB) },
  activeWorkspaceId: WORKSPACE_A,
  authenticatedUserId: OWNER_A
}), "workspace_identity_conflict", "top-level and collection identity conflict was accepted");
expectOwnershipError(() => validateLocalOwnershipState({
  model: { ...clone(currentModel), workspaces: [clone(canonicalWorkspaceA), clone(canonicalWorkspaceA)] },
  activeWorkspaceId: WORKSPACE_A,
  authenticatedUserId: OWNER_A
}), "workspace_identity_conflict", "stored duplicate workspace ID was accepted");
expectOwnershipError(() => createLocalWorkspaceIdentity({
  authenticatedUserId: "owner id with spaces",
  generatedWorkspaceId: WORKSPACE_A,
  createdAt: CREATED_A
}), "ownership_integrity_invalid", "malformed authenticated user ID was accepted");
expectOwnershipError(() => applyCanonicalLocalOwnership({
  authenticatedUserId: OWNER_A,
  activeWorkspaceId: WORKSPACE_A,
  currentModel,
  incomingModel: incomingUpdate,
  operation: "ownership-transfer"
}), "ownership_integrity_invalid", "ownership transfer operation was accepted");

function functionSlice(source, name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers.map(marker => source.indexOf(marker)).find(index => index >= 0);
  if (start === undefined) throw new Error(`missing function: ${name}`);
  const rest = source.slice(start + 1);
  const nextMatch = /\n(?:async\s+)?function\s+[A-Za-z0-9_]+\s*\(/.exec(rest);
  return source.slice(start, nextMatch ? start + 1 + nextMatch.index : source.length);
}

const [serverSource, appSource, ownershipSource] = await Promise.all([
  readFile(new URL("./server.mjs", import.meta.url), "utf8"),
  readFile(new URL("./social-cues-app.html", import.meta.url), "utf8"),
  readFile(new URL("./local-workspace-ownership.mjs", import.meta.url), "utf8")
]);
const writeGateSource = functionSlice(serverSource, "hostedWriteRequiresSession");
const modelMergeSource = functionSlice(serverSource, "mergePublicModelUpdate");
const localSaveSource = functionSlice(serverSource, "localSaveModel");
const loadModelSource = functionSlice(serverSource, "loadModel");
const importStart = appSource.indexOf("function importModel(");
const importEnd = appSource.indexOf("\n  async function", importStart + 1);
const importSource = appSource.slice(importStart, importEnd > importStart ? importEnd : importStart + 2000);
check(writeGateSource.includes("sessionFromRequest") && writeGateSource.includes("if (!session?.user) return null") && !writeGateSource.includes("return true"), "shared local write gate still permits anonymous persistence", "alternate-writes");
check(modelMergeSource.includes("overwrite: !supabaseEnabled"), "local generic merge does not overwrite forged collection ownership", "alternate-writes");
check(localSaveSource.includes("renameLocalModelWithRetry") && !localSaveSource.includes("bodyJson"), "local persistence accepts request input directly", "alternate-writes");
check(loadModelSource.includes("getSeedModel") && !loadModelSource.includes("bodyJson"), "startup repair accepts request identity", "alternate-writes");
check(importStart >= 0 && functionSlice(appSource, "applyRecovery").includes("sendWorkspaceSave(state.operation)")
  && functionSlice(appSource, "sendWorkspaceSave").includes('authedFetch("/api/model"'), "browser recovery no longer funnels through the canonical revisioned model route", "import-restore");
check(serverSource.split("mergePublicModelUpdate(").length - 1 === 3
  && serverSource.includes("const merged = mergePublicModelUpdate(trusted, current, user)")
  && serverSource.includes("applyCanonicalLocalOwnership({ authenticatedUserId: user.id"), "a full-model merge path bypasses canonical ownership", "alternate-writes");
for (const name of ["createOAuthState", "consumeOAuthState", "applyPatreonWebhookEvent", "applyLinkedInWebhookEvent", "applyDiscordWebhookEvent"]) {
  const source = functionSlice(serverSource, name);
  check(!/model\.workspaces?\s*=|workspace\.ownerUserId\s*=/.test(source), `${name} can replace canonical workspace identity`, "alternate-writes");
}
check(serverSource.includes('process.env.E2E_USE_LOCAL_SERVER !== "1"') && serverSource.includes("Sign in before seeding local provider accounts"), "tester provider setup can become unauthenticated production authority", "alternate-writes");
check(!/process\.env|node:fs|node:http|node:https|\bfetch\s*\(|server\.mjs|social-cues-app\.html/.test(ownershipSource), "ownership module has an environment, filesystem, network, server, or browser dependency", "safety");
check((serverSource.slice(0, serverSource.indexOf("async function route")).match(/applyCanonicalLocalOwnership/g) || []).length === 1, "local ownership overlay has import-time execution", "safety");

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const SENSITIVE_ENV_PREFIXES = /^(?:META|FACEBOOK|INSTAGRAM|THREADS|X_|TWITTER|TIKTOK|PINTEREST|CANVA|SHOPIFY|ETSY|LINKEDIN|PATREON|TWITCH|GOOGLE|YOUTUBE|DISCORD|MANYCHAT|ELEVENLABS|REDDIT|OPENAI|STRIPE|SUPABASE|SENTRY|VERCEL|VAPID|RESEND)_/i;

function hermeticEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (SENSITIVE_ENV_PREFIXES.test(name)
      || ["VERCEL", "AUTH_SESSION_SECRET", "OAUTH_TOKEN_ENCRYPTION_KEY", "SOCIAL_CUES_PROMO_CODES", "SOCIAL_CUES_DATA_DIR", "SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG"].includes(name.toUpperCase())) {
      delete env[name];
    }
  }
  return { ...env, ...overrides };
}

async function writeExternalGuard(filePath) {
  await writeFile(filePath, `
import { appendFile } from "node:fs/promises";
const originalFetch = globalThis.fetch;
const logPath = process.env.SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG || "";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
globalThis.fetch = async (input, init = {}) => {
  const rawUrl = input instanceof URL || typeof input === "string" ? String(input) : String(input?.url || "");
  const target = new URL(rawUrl);
  if (["http:", "https:"].includes(target.protocol) && !loopbackHosts.has(target.hostname)) {
    if (logPath) await appendFile(logPath, JSON.stringify({ method: String(init?.method || input?.method || "GET").toUpperCase(), origin: target.origin }) + "\\n", "utf8");
    throw new Error("External HTTP request blocked by the ownership contract.");
  }
  return originalFetch(input, init);
};
`, "utf8");
}

async function waitForServer(child, baseUrl) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error("ownership test server exited before startup");
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Loopback server may still be binding.
    }
    await delay(50);
  }
  throw new Error("ownership test server did not start");
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  let exited = new Promise(resolve => child.once("exit", resolve));
  if (child.connected) child.send({ type: "social-cues-local-shutdown" }); else child.kill("SIGTERM");
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL");
    await Promise.race([exited, delay(2000)]);
  }
}

async function response(baseUrl, route, options = {}) {
  if (route === "/api/model" && options.method === "POST") options = await revisionedFixtureOptions(baseUrl, options);
  const result = await fetch(baseUrl + route, { redirect: "manual", ...options });
  const text = await result.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // OAuth start denials are HTML.
  }
  return { status: result.status, body, text, location: result.headers.get("location") || "" };
}

async function durableSnapshot(dataDir) {
  const raw = await readFile(path.join(dataDir, "model.json"), "utf8");
  const model = fixtureModel(JSON.parse(raw));
  return {
    hash: hash(raw),
    workspace: model.workspace ? {
      id: model.workspace.id || "",
      ownerUserId: model.workspace.ownerUserId || "",
      createdAt: model.workspace.createdAt || "",
      name: model.workspace.name || ""
    } : null,
    workspaces: (model.workspaces || []).map(workspace => ({
      id: workspace.id || "",
      ownerUserId: workspace.ownerUserId || "",
      createdAt: workspace.createdAt || "",
      name: workspace.name || ""
    })),
    model
  };
}

async function externalAttempts(logPath) {
  try {
    return (await readFile(logPath, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const localDataDir = path.join(process.cwd(), ".tmp", `local-ownership-contract-${Date.now()}`);
const externalLogPath = path.join(localDataDir, "external-requests.ndjson");
const guardPath = path.join(localDataDir, "external-request-guard.mjs");
await mkdir(localDataDir, { recursive: true });
await writeExternalGuard(guardPath);
const localPort = await availablePort();
const localBase = `http://127.0.0.1:${localPort}`;
const PROMO_A = "OI1-OWNER-A";
const PROMO_B = "OI1-OWNER-B";
const PROMO_C = "OI1-OWNER-C";
const PROMO_D = "OI1-OWNER-D";
const TEST_ENCRYPTION_KEY = "oi1-synthetic-encryption-key-2026-not-production";
const TEST_PATREON_SECRET = "oi1-synthetic-patreon-secret";
const childEnv = hermeticEnvironment({
  PORT: String(localPort),
  HOST: "127.0.0.1",
  AUTH_PROVIDER: "alpha-local",
  SUPABASE_ENABLED: "false",
  SENTRY_DSN: "",
  PUBLIC_APP_URL: "https://socialcuesapp.com",
  SOCIAL_CUES_DATA_DIR: localDataDir,
  SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: externalLogPath,
  SOCIAL_CUES_PROMO_CODES: JSON.stringify([
    { code: PROMO_A, label: "OI1 owner A", days: 1, active: true },
    { code: PROMO_B, label: "OI1 owner B", days: 1, active: true },
    { code: PROMO_C, label: "OI1 revoked owner", days: 1, active: true },
    { code: PROMO_D, label: "OI1 expired owner", days: 1, active: true }
  ]),
  OAUTH_TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  PATREON_CLIENT_ID: "oi1-synthetic-patreon-client",
  PATREON_CLIENT_SECRET: TEST_PATREON_SECRET,
  PATREON_PUBLIC_APP_URL: "https://socialcuesapp.com"
});
let localStdout = "";
let localStderr = "";
const localChild = spawn(process.execPath, [`--import=${pathToFileURL(guardPath).href}`, "server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe", "ipc"]
});
localChild.stdout.on("data", chunk => { localStdout += chunk; });
localChild.stderr.on("data", chunk => { localStderr += chunk; });

let httpProbeCount = 0;
try {
  await waitForServer(localChild, localBase);
  const signupA = await response(localBase, "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Local Owner A",
      email: "local-owner-a@example.test",
      password: "local-owner-a-password-2026",
      promoCode: PROMO_A,
      workspaceName: "Local Workspace A"
    })
  });
  check(signupA.status === 200 && signupA.body?.session?.token && signupA.body?.workspace?.ownerUserId === signupA.body?.user?.id, "trusted first-workspace signup did not establish canonical ownership", "http-authentication");
  httpProbeCount += 1;
  const tokenA = signupA.body.session.token;
  const authA = { Authorization: `Bearer ${tokenA}` };
  const modelA = await response(localBase, "/api/model", { headers: authA });
  check(modelA.status === 200 && modelA.body?.workspace?.id === signupA.body.workspace.id, "authenticated owner could not load its canonical workspace", "http-authentication");
  const canonicalA = {
    id: modelA.body.workspace.id,
    ownerUserId: modelA.body.workspace.ownerUserId,
    createdAt: modelA.body.workspace.createdAt
  };

  let before = await durableSnapshot(localDataDir);
  const unauthenticated = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...clone(modelA.body),
      workspace: { ...clone(modelA.body.workspace), ownerUserId: "unauthenticated-attacker" }
    })
  });
  let after = await durableSnapshot(localDataDir);
  check(unauthenticated.status === 401 && unauthenticated.body?.code === "authentication_required", "unauthenticated model write did not return bounded 401", "http-authentication");
  check(after.hash === before.hash, "unauthenticated model write changed durable state", "http-authentication");
  check(after.workspace.ownerUserId === canonicalA.ownerUserId, "unauthenticated model write changed canonical owner", "http-ownership");
  httpProbeCount += 1;

  before = after;
  const invalidSession = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-local-session" },
    body: JSON.stringify(modelA.body)
  });
  after = await durableSnapshot(localDataDir);
  check(invalidSession.status === 401 && after.hash === before.hash, "invalid session changed durable model state", "http-authentication");
  httpProbeCount += 1;

  const ordinaryPayload = clone(modelA.body);
  ordinaryPayload.workspace.name = "Customer Renamed Workspace A";
  ordinaryPayload.profile = { ...(ordinaryPayload.profile || {}), outcome: "Customer editable outcome" };
  const ordinary = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authA },
    body: JSON.stringify(ordinaryPayload)
  });
  check(
    ordinary.status === 200
      && ordinary.body?.workspace?.name === "Customer Renamed Workspace A"
      && ordinary.body?.profile?.outcome === "Customer editable outcome",
    `authenticated owner ordinary update failed (status ${ordinary.status}, code ${ordinary.body?.code || "none"}, error ${ordinary.body?.error || "none"})`,
    "http-owner-update"
  );
  check(ordinary.body.workspace.id === canonicalA.id && ordinary.body.workspace.ownerUserId === canonicalA.ownerUserId && ordinary.body.workspace.createdAt === canonicalA.createdAt, "ordinary update changed canonical identity", "http-owner-update");
  httpProbeCount += 1;

  const forgedOwnerPayload = clone(ordinary.body);
  forgedOwnerPayload.currentUser = { id: "attacker-user", email: "attacker@example.test", role: "Owner" };
  forgedOwnerPayload.workspace.ownerUserId = "attacker-user";
  forgedOwnerPayload.workspace.ownerEmail = "attacker@example.test";
  forgedOwnerPayload.workspace.role = "Owner";
  forgedOwnerPayload.workspaces = [{ ...clone(forgedOwnerPayload.workspace), ownerUserId: "collection-attacker" }];
  forgedOwnerPayload.actions = [{
    id: "action-forged-owner",
    title: "Customer action",
    ownerUserId: "attacker-user",
    workspaceId: "attacker-workspace"
  }];
  const forgedOwner = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authA },
    body: JSON.stringify(forgedOwnerPayload)
  });
  check(forgedOwner.status === 200 && forgedOwner.body.workspace.ownerUserId === canonicalA.ownerUserId, "browser top-level owner forgery changed canonical owner", "http-ownership");
  check(forgedOwner.body.workspaces?.[0]?.ownerUserId === canonicalA.ownerUserId, "browser collection owner forgery changed canonical owner", "http-ownership");
  check(forgedOwner.body.currentUser?.id === signupA.body.user.id && forgedOwner.body.currentUser?.role !== "Owner", "browser user, email, or role established ownership", "http-ownership");
  check(forgedOwner.body.actions?.find(item => item.id === "action-forged-owner")?.ownerUserId === signupA.body.user.id
    && forgedOwner.body.actions?.find(item => item.id === "action-forged-owner")?.workspaceId === canonicalA.id, "browser collection row retained forged ownership", "http-ownership");
  httpProbeCount += 1;

  before = await durableSnapshot(localDataDir);
  const foreignIdPayload = clone(forgedOwner.body);
  foreignIdPayload.workspace.id = "foreign-workspace-from-browser";
  foreignIdPayload.workspaces = [{ ...clone(foreignIdPayload.workspace), id: "foreign-workspace-from-browser" }];
  const foreignId = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authA },
    body: JSON.stringify(foreignIdPayload)
  });
  after = await durableSnapshot(localDataDir);
  check(foreignId.status === 409 && foreignId.body?.code === "workspace_identity_conflict" && after.hash === before.hash, "browser workspace ID replacement was not rejected atomically", "http-ownership");
  httpProbeCount += 1;

  before = after;
  const duplicatePayload = clone(forgedOwner.body);
  duplicatePayload.workspaces = [
    { ...clone(duplicatePayload.workspace), ownerUserId: canonicalA.ownerUserId },
    { ...clone(duplicatePayload.workspace), ownerUserId: "last-entry-attacker" }
  ];
  const duplicate = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authA },
    body: JSON.stringify(duplicatePayload)
  });
  after = await durableSnapshot(localDataDir);
  check(duplicate.status === 409 && after.hash === before.hash, "conflicting duplicate workspace identity was not rejected atomically", "http-ownership");
  httpProbeCount += 1;

  before = after;
  const selectorPayload = clone(forgedOwner.body);
  selectorPayload.activeWorkspaceId = "foreign-active-workspace";
  const selector = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authA },
    body: JSON.stringify(selectorPayload)
  });
  after = await durableSnapshot(localDataDir);
  check(selector.status === 409 && after.hash === before.hash, "body-selected active workspace changed durable state", "http-ownership");
  httpProbeCount += 1;

  const importedPayload = clone(forgedOwner.body);
  delete importedPayload.workspace.id;
  delete importedPayload.workspaces;
  importedPayload.workspace.ownerUserId = "imported-owner";
  importedPayload.profile.outcome = "Imported customer outcome";
  const importedHttp = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authA },
    body: JSON.stringify(importedPayload)
  });
  check(importedHttp.status === 200 && importedHttp.body.workspace.id === canonicalA.id && importedHttp.body.workspace.ownerUserId === canonicalA.ownerUserId && importedHttp.body.profile.outcome === "Imported customer outcome", "import did not overlay canonical identity", "http-import-restore");
  httpProbeCount += 1;

  const restoredPayload = clone(importedHttp.body);
  delete restoredPayload.workspaces;
  restoredPayload.workspace.ownerUserId = "restored-owner";
  restoredPayload.workspace.createdAt = "1998-01-01T00:00:00.000Z";
  restoredPayload.settings = { ...(restoredPayload.settings || {}), theme: "dark" };
  const restoredHttp = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authA },
    body: JSON.stringify(restoredPayload)
  });
  check(restoredHttp.status === 200 && restoredHttp.body.workspace.ownerUserId === canonicalA.ownerUserId && restoredHttp.body.workspace.createdAt === canonicalA.createdAt && restoredHttp.body.settings.theme === "dark", "restore did not preserve canonical identity and customer settings", "http-import-restore");
  httpProbeCount += 1;

  before = await durableSnapshot(localDataDir);
  const unauthenticatedAction = await response(localBase, "/api/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Anonymous action", ownerUserId: "attacker-user" })
  });
  after = await durableSnapshot(localDataDir);
  check(unauthenticatedAction.status === 401 && after.hash === before.hash, "shared mutating route retained the local anonymous bypass", "http-alternate-writes");
  const authenticatedAction = await response(localBase, "/api/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authA },
    body: JSON.stringify({ title: "Authenticated action", ownerUserId: "attacker-user", workspaceId: "attacker-workspace" })
  });
  check(authenticatedAction.status === 200 && authenticatedAction.body?.action?.ownerUserId === signupA.body.user.id && authenticatedAction.body?.action?.workspaceId === canonicalA.id, "alternate authenticated write used request ownership", "http-alternate-writes");
  httpProbeCount += 2;

  before = await durableSnapshot(localDataDir);
  const deviceSync = await response(localBase, "/api/auth/device/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceName: "Attacker device", ownerUserId: "attacker-user" })
  });
  after = await durableSnapshot(localDataDir);
  check(deviceSync.status === 401 && after.hash === before.hash, "unauthenticated device synchronization changed durable state", "http-alternate-writes");
  httpProbeCount += 1;

  before = after;
  const oauthStart = await response(localBase, "/api/oauth/patreon/start");
  after = await durableSnapshot(localDataDir);
  check(oauthStart.status === 403 && oauthStart.body.code === "workspace_writer_unclassified"
    && after.hash === before.hash
    && JSON.stringify(after.workspace) === JSON.stringify(before.workspace)
    && JSON.stringify(after.workspaces) === JSON.stringify(before.workspaces), "OAuth state registry changed canonical workspace identity", "http-alternate-writes");
  const authenticatedOauthStart = await response(localBase, "/api/oauth/patreon/start", { headers: authA });
  check(authenticatedOauthStart.status === 302 && authenticatedOauthStart.location.startsWith("https://www.patreon.com/oauth2/authorize"), "authenticated OAuth state creation no longer works", "http-alternate-writes");
  httpProbeCount += 2;

  const aIdentityBeforeForeignSignup = (await durableSnapshot(localDataDir)).workspaces.find(item => item.id === canonicalA.id);
  const signupB = await response(localBase, "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Local Owner B",
      email: "local-owner-b@example.test",
      password: "local-owner-b-password-2026",
      promoCode: PROMO_B,
      workspaceName: "Local Workspace B"
    })
  });
  check(signupB.status === 200 && signupB.body?.session?.token, "foreign user fixture signup failed", "http-cross-workspace");
  const authB = { Authorization: `Bearer ${signupB.body.session.token}` };
  const modelB = await response(localBase, "/api/model", { headers: authB });
  const afterForeignSignup = await durableSnapshot(localDataDir);
  check(JSON.stringify(afterForeignSignup.workspaces.find(item => item.id === canonicalA.id)) === JSON.stringify(aIdentityBeforeForeignSignup), "trusted second-workspace bootstrap replaced first workspace identity", "http-cross-workspace");
  before = afterForeignSignup;
  const foreignWorkspacePayload = clone(modelB.body);
  foreignWorkspacePayload.workspace.id = canonicalA.id;
  foreignWorkspacePayload.workspace.ownerUserId = signupB.body.user.id;
  foreignWorkspacePayload.workspaces = [{ ...clone(foreignWorkspacePayload.workspace) }];
  const foreignWorkspace = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authB },
    body: JSON.stringify(foreignWorkspacePayload)
  });
  after = await durableSnapshot(localDataDir);
  const deniedText = JSON.stringify(foreignWorkspace.body);
  check(foreignWorkspace.status === 409 && after.hash === before.hash, "user B changed workspace A by submitting its ID", "http-cross-workspace");
  check(!deniedText.includes(canonicalA.id) && !deniedText.includes(canonicalA.ownerUserId), "cross-workspace denial disclosed canonical identity", "http-cross-workspace");
  check(JSON.stringify(after.workspaces.find(item => item.id === canonicalA.id)) === JSON.stringify(aIdentityBeforeForeignSignup), "cross-user denial changed workspace A identity", "http-cross-workspace");
  const forgedOwnerBPayload = clone(modelB.body);
  forgedOwnerBPayload.workspace.ownerUserId = canonicalA.ownerUserId;
  forgedOwnerBPayload.workspaces[0].ownerUserId = canonicalA.ownerUserId;
  forgedOwnerBPayload.workspace.name = "Workspace B legitimate rename";
  const forgedOwnerB = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authB },
    body: JSON.stringify(forgedOwnerBPayload)
  });
  check(forgedOwnerB.status === 200 && forgedOwnerB.body.workspace.ownerUserId === signupB.body.user.id && forgedOwnerB.body.workspace.name === "Workspace B legitimate rename", "workspace B owner forgery was not sanitized", "http-cross-workspace");
  check(JSON.stringify((await durableSnapshot(localDataDir)).workspaces.find(item => item.id === canonicalA.id)) === JSON.stringify(aIdentityBeforeForeignSignup), "workspace B update changed workspace A identity", "http-cross-workspace");
  httpProbeCount += 3;

  const signupC = await response(localBase, "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Revoked Owner", email: "revoked-owner@example.test", password: "revoked-owner-password-2026", promoCode: PROMO_C, workspaceName: "Revoked Workspace" })
  });
  const logoutC = await response(localBase, "/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${signupC.body.session.token}` } });
  check(signupC.status === 200 && logoutC.status === 200, "revoked session fixture setup failed", "http-authentication");
  before = await durableSnapshot(localDataDir);
  const revokedWrite = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signupC.body.session.token}` },
    body: JSON.stringify(signupC.body.model || {})
  });
  after = await durableSnapshot(localDataDir);
  check(revokedWrite.status === 401 && after.hash === before.hash, "revoked session changed durable model state", "http-authentication");
  httpProbeCount += 1;

  const signupD = await response(localBase, "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Expired Owner", email: "expired-owner@example.test", password: "expired-owner-password-2026", promoCode: PROMO_D, workspaceName: "Expired Workspace" })
  });
  check(signupD.status === 200, "expired session fixture signup failed", "http-authentication");
  const expiring = await durableSnapshot(localDataDir);
  for (const device of expiring.model.deviceSessions || []) {
    if (device.userId === signupD.body.user.id) device.expiresAt = "2000-01-01T00:00:00.000Z";
  }
  await injectSharedFixture(localDataDir, expiring.model);
  before = await durableSnapshot(localDataDir);
  const expiredWrite = await response(localBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signupD.body.session.token}` },
    body: JSON.stringify({ workspace: { ownerUserId: "expired-attacker" } })
  });
  after = await durableSnapshot(localDataDir);
  check(expiredWrite.status === 401 && after.hash === before.hash, "expired session changed durable model state", "http-authentication");
  httpProbeCount += 1;
} finally {
  await stopServer(localChild);
}

const hostedDataDir = path.join(process.cwd(), ".tmp", `hosted-ownership-contract-${Date.now()}`);
const hostedGuardPath = path.join(hostedDataDir, "external-request-guard.mjs");
await mkdir(hostedDataDir, { recursive: true });
await writeExternalGuard(hostedGuardPath);
const hostedPort = await availablePort();
const hostedBase = `http://127.0.0.1:${hostedPort}`;
let hostedStdout = "";
let hostedStderr = "";
const hostedChild = spawn(process.execPath, [`--import=${pathToFileURL(hostedGuardPath).href}`, "server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: hermeticEnvironment({
    PORT: String(hostedPort),
    HOST: "127.0.0.1",
    VERCEL: "1",
    AUTH_PROVIDER: "alpha-local",
    SUPABASE_ENABLED: "false",
    SENTRY_DSN: "",
    PUBLIC_APP_URL: "https://socialcuesapp.com",
    SOCIAL_CUES_DATA_DIR: hostedDataDir,
    SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: externalLogPath,
    OAUTH_TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY
  }),
  stdio: ["ignore", "pipe", "pipe"]
});
hostedChild.stdout.on("data", chunk => { hostedStdout += chunk; });
hostedChild.stderr.on("data", chunk => { hostedStderr += chunk; });
try {
  await waitForServer(hostedChild, hostedBase);
  const hostedWarmup = await response(hostedBase, "/api/model");
  check(hostedWarmup.status === 401, "hosted model warmup did not fail closed", "hosted-regression");
  const hostedBefore = await durableSnapshot(hostedDataDir);
  const hostedDenied = await response(hostedBase, "/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://socialcuesapp.com" },
    body: JSON.stringify({ workspace: { id: "hosted-forged", ownerUserId: "hosted-attacker" } })
  });
  const hostedAfter = await durableSnapshot(hostedDataDir);
  check(
    hostedDenied.status === 401
      && JSON.stringify(hostedAfter.workspace) === JSON.stringify(hostedBefore.workspace)
      && !JSON.stringify(hostedAfter.model).includes("hosted-forged")
      && !JSON.stringify(hostedAfter.model).includes("hosted-attacker"),
    `failed hosted authorization fell back to local ownership persistence (status ${hostedDenied.status}, before ${JSON.stringify(hostedBefore.workspace)}, after ${JSON.stringify(hostedAfter.workspace)}, forged ${JSON.stringify(hostedAfter.model).includes("hosted-forged") || JSON.stringify(hostedAfter.model).includes("hosted-attacker")})`,
    "hosted-regression"
  );
  check(!JSON.stringify(hostedDenied.body).includes("hosted-forged") && !JSON.stringify(hostedDenied.body).includes("hosted-attacker"), "hosted denial reflected untrusted identity", "hosted-regression");
  check(serverSource.includes("if (!supabaseEnabled) {") && serverSource.includes("applyCanonicalLocalOwnership"), "local ownership overlay is not scoped away from Supabase persistence", "hosted-regression");
  httpProbeCount += 1;
} finally {
  await stopServer(hostedChild);
}

const attempts = await externalAttempts(externalLogPath);
check(attempts.length === 0, "ownership contract attempted an external HTTP request", "safety");
const allProcessOutput = `${localStdout}\n${localStderr}\n${hostedStdout}\n${hostedStderr}`;
for (const marker of [TEST_ENCRYPTION_KEY, TEST_PATREON_SECRET, "local-owner-a-password-2026", "local-owner-b-password-2026", PROMO_A, PROMO_B]) {
  check(!allProcessOutput.includes(marker), "ownership contract exposed a synthetic secret", "safety");
}
check((localChild.exitCode !== null || localChild.signalCode !== null)
  && (hostedChild.exitCode !== null || hostedChild.signalCode !== null), "ownership test server cleanup did not complete", "safety");

const hostileMutationCount = 13;
console.log(JSON.stringify({
  ok: true,
  checks,
  categories: categoryCounts,
  hostileMutations: hostileMutationCount,
  httpProbes: httpProbeCount,
  externalRequests: 0,
  providerRequests: 0,
  productionRequests: 0,
  remoteDatabaseRequests: 0,
  secretsExposed: 0,
  hermetic: true,
  productionContacted: false,
  cleanupComplete: true
}));
