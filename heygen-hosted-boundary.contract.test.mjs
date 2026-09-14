import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const server = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
const html = await readFile(new URL("./social-cues-app.html", import.meta.url), "utf8");

function bounded(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("hosted adapter requires authentication, encryption, schema, and provider registration", () => {
  assert.match(server, /import \{[\s\S]*?createHeyGenDurableRepository[\s\S]*?\} from "\.\/heygen-durable-repository\.mjs";/u);
  const repositorySetup = bounded(server, "const heygenDurableRepository =", "function publicHeygenFailure");
  assert.match(repositorySetup, /tracePathname: "\/heygen-durable"/u);

  const readiness = bounded(server, "async function heygenDurableReadiness", "function requireHeygenDurableReadiness");
  assert.match(readiness, /runtimeMode !== "vercel"/u);
  assert.match(readiness, /!supabaseEnabled \|\| !supabaseAuthReady\(\)/u);
  assert.match(readiness, /!oauthTokenEncryptionReadiness\(\)\.productionReady/u);
  assert.match(readiness, /heygenDurableRepository\.probeReadiness\(\)/u);
  assert.match(readiness, /result\.ready \? 30_000 : 5_000/u);

  const selection = bounded(server, "async function heygenPersistenceForContext", "async function heygenWorkflowActor");
  assert.match(selection, /isUuid\(context\?\.actorId\) && isUuid\(context\?\.workspaceId\)/u);
  assert.match(selection, /providerReady = heygenConfiguration\.safeReadiness\.readyToDiscover/u);
  assert.match(selection, /adapterReady: databaseReadiness\.ready && providerReady/u);
  assert.match(selection, /repository: databaseReadiness\.ready && providerReady \? heygenDurableRepository : null/u);
});

test("hosted OAuth callback commits through the repository without model credential writes", () => {
  const callback = bounded(
    server,
    'if (url.pathname === "/api/oauth/heygen/callback"',
    'if (url.pathname === "/api/heygen/refresh"'
  );
  assert.match(callback, /const persistence = await heygenPersistenceForContext\(context\)/u);
  assert.match(callback, /const durable = Boolean\(persistence\.repository\)/u);
  assert.match(callback, /repository: persistence\.repository/u);
  assert.match(callback, /ledger: durable \? undefined : context\.model\.heygenOAuthStates/u);
  assert.match(callback, /state: durable \? "" : state/u);
  assert.match(callback, /persistenceVerified: durable/u);
  assert.match(callback, /if \(!durable\) \{[\s\S]*?context\.model\.connectedAccounts[\s\S]*?context\.model\.integrations\.heygen/u);
  assert.match(callback, /if \(!durable\) \{[\s\S]*?saveModelForUser[\s\S]*?confirmPersistedProviderAccount/u);
  assert.doesNotMatch(callback, /if \(durable\) \{[\s\S]*?saveModelForUser/u);

  const eventRecorder = bounded(server, "function recordOAuthEvent", "function recordOAuthCallbackIngress");
  assert.match(eventRecorder, /provider === "heygen" \? "" : input\.state/u);
  assert.match(eventRecorder, /stateFingerprint: provider === "heygen" \? null/u);
  assert.match(eventRecorder, /stateHash: provider === "heygen" \? null/u);
});

test("all hosted HeyGen account and media routes select the durable boundary", () => {
  for (const [start, end] of [
    ['if (url.pathname === "/api/heygen/readiness"', 'if (url.pathname === "/api/heygen/account"'],
    ['if (url.pathname === "/api/heygen/account"', 'if (url.pathname === "/api/oauth/heygen/start"'],
    ['if (url.pathname === "/api/oauth/heygen/start"', 'if (url.pathname === "/api/oauth/heygen/callback"'],
    ['if (url.pathname === "/api/heygen/refresh"', 'if (url.pathname === "/api/heygen/reconnect"'],
    ['if (url.pathname === "/api/heygen/disconnect"', 'if (url.pathname === "/api/heygen/jobs"'],
    ['if (url.pathname === "/api/heygen/jobs" && req.method === "GET"', 'if (url.pathname === "/api/heygen/jobs" && req.method === "POST"'],
    ['if (url.pathname === "/api/heygen/jobs" && req.method === "POST"', "const heygenPollMatch"],
    ["const heygenPollMatch", "const heygenJobMatch"],
    ["const heygenJobMatch", 'if (url.pathname === "/api/heygen/versions"'],
    ['if (url.pathname === "/api/heygen/versions"', "const heygenVersionMatch"]
  ]) {
    const route = bounded(server, start, end);
    assert.match(route, /heygenPersistenceForContext|heygenMediaWorkflowFor/u, `${start} bypasses durable selection`);
  }
});

test("browser retries reuse operation IDs and never request customer API keys", () => {
  const refresh = bounded(html, "async function refreshHeygenAccount", "async function disconnectHeygenAccount");
  const disconnect = bounded(html, "async function disconnectHeygenAccount", "async function pollHeygenJob");
  for (const [block, route] of [[refresh, "/api/heygen/refresh"], [disconnect, "/api/heygen/disconnect"]]) {
    const assignment = block.indexOf("dataset.heygenOperationId ||=");
    const request = block.indexOf(route);
    const successCheck = block.indexOf("!response.ok");
    const clear = block.indexOf('dataset.heygenOperationId = ""');
    assert.ok(assignment >= 0 && assignment < request);
    assert.ok(request < successCheck && successCheck < clear);
    assert.match(block, /body: JSON\.stringify\(\{ operationId: button\.dataset\.heygenOperationId \}\)/u);
  }
  const accountCard = bounded(html, "function renderHeygenAccountCard", "function renderAccounts");
  assert.doesNotMatch(accountCard, /api.?key|type="password"|credential/i);
  assert.match(accountCard, /readiness\.connectRoute[\s\S]*?connected \? "Reconnect" : "Connect"/u);
  assert.match(accountCard, /fixed Remote MCP OAuth connection only/u);
});
