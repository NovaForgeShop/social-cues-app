import assert from "node:assert/strict";
import path from "node:path";
import {
  assertTesterLoopFixtureActivation,
  createTesterLoopProviderBoundary,
  isTesterLoopEnvFile,
  testerLoopFixtureActivation,
  testerLoopMetaFixtureRequest
} from "./tester-loop-provider-fixture.mjs";

let checks = 0;
function check(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}

const cwd = path.resolve("tester-loop-fixture-contract-root");
const dataDir = path.join(cwd, ".tmp", "tester-loop-data-contract");
const logPath = path.join(dataDir, "provider-fixture.jsonl");
const validActivation = {
  SOCIAL_CUES_TESTER_LOOP_PROVIDER_FIXTURE: "1",
  SOCIAL_CUES_TESTER_LOOP_SERVER_PROCESS: "1",
  E2E_USE_LOCAL_SERVER: "1",
  AUTH_PROVIDER: "alpha-local",
  SUPABASE_ENABLED: "false",
  NODE_ENV: "test",
  SOCIAL_CUES_DATA_DIR: dataDir,
  SOCIAL_CUES_TESTER_LOOP_PROVIDER_FIXTURE_LOG: logPath
};

check(testerLoopFixtureActivation(validActivation, cwd).allowed, "local tester-loop activation should be allowed");
for (const productionEnv of [
  { ...validActivation, NODE_ENV: "production" },
  { ...validActivation, VERCEL: "1" },
  { ...validActivation, VERCEL_ENV: "production" },
  { ...validActivation, AUTH_PROVIDER: "supabase" },
  { ...validActivation, E2E_USE_LOCAL_SERVER: "0" }
]) {
  check(!testerLoopFixtureActivation(productionEnv, cwd).allowed, "production or hosted activation must be denied");
  assert.throws(() => assertTesterLoopFixtureActivation(productionEnv, cwd), /activation denied/);
  checks += 1;
}
check(!testerLoopFixtureActivation({ ...validActivation, SOCIAL_CUES_DATA_DIR: path.join(cwd, "data") }, cwd).allowed, "fixture data must remain under .tmp");
check(!testerLoopFixtureActivation({ ...validActivation, SOCIAL_CUES_TESTER_LOOP_PROVIDER_FIXTURE_LOG: path.join(cwd, ".tmp", "foreign.jsonl") }, cwd).allowed, "fixture log must remain inside its data directory");
check(isTesterLoopEnvFile(path.join(cwd, ".env")), "the tester-loop preload should recognize the application .env path");
check(!isTesterLoopEnvFile(path.join(cwd, ".env.example")), "the tester-loop preload should not mask ordinary fixture files");

let originalCalls = 0;
const events = [];
const boundary = createTesterLoopProviderBoundary({
  originalFetch: async () => {
    originalCalls += 1;
    return new Response("unexpected original fetch", { status: 599 });
  },
  recordEvent: event => events.push(event)
});

for (const fixtureCase of ["instagram-business-link", "connected-instagram-link"]) {
  const response = await boundary.fetch(testerLoopMetaFixtureRequest(fixtureCase));
  const body = await response.json();
  check(response.status === 200, `${fixtureCase} should receive a deterministic response`);
  check(Boolean(body.id && body.name), `${fixtureCase} should return the synthetic page identity shape`);
  check(body.link === "", `${fixtureCase} should not invent a provider link`);
  check(fixtureCase === "instagram-business-link"
    ? body.instagram_business_account === null
    : body.connected_instagram_account === null, `${fixtureCase} should deterministically report no linked Instagram asset`);
}
check(originalCalls === 0, "expected Meta fixtures must not call the original fetch");

async function expectRejected(input, init, message) {
  await assert.rejects(() => boundary.fetch(input, init), /rejected/);
  checks += 1;
  check(originalCalls === 0, message);
}

const wrongPath = testerLoopMetaFixtureRequest();
wrongPath.pathname += "/unexpected";
await expectRejected(wrongPath, {}, "a different Graph path must not call the original fetch");

await expectRejected(testerLoopMetaFixtureRequest(), { method: "POST" }, "an unexpected method must not call the original fetch");

const extraQuery = testerLoopMetaFixtureRequest();
extraQuery.searchParams.set("unexpected", "1");
await expectRejected(extraQuery, {}, "an unexpected query parameter must not call the original fetch");

const unknownToken = testerLoopMetaFixtureRequest();
unknownToken.searchParams.set("access_token", `EAA${"x".repeat(96)}`);
await expectRejected(unknownToken, {}, "an unknown token must not call the original fetch");

await expectRejected(testerLoopMetaFixtureRequest(), { body: "unexpected" }, "an unexpected body must not call the original fetch");
await expectRejected(testerLoopMetaFixtureRequest(), { headers: { Authorization: "Bearer synthetic-but-unapproved" } }, "an Authorization header must not call the original fetch");

const wrongOrigin = testerLoopMetaFixtureRequest();
wrongOrigin.hostname = "provider.invalid";
await expectRejected(wrongOrigin, {}, "a different provider origin must not call the original fetch");

const snapshot = boundary.snapshot();
check(snapshot.fixtureHits === 2, "fixture hit counter should include both exact reads");
check(snapshot.fixtureCases["instagram-business-link"] === 1, "business-link fixture counter should be exact");
check(snapshot.fixtureCases["connected-instagram-link"] === 1, "connected-link fixture counter should be exact");
check(snapshot.unexpectedProviderAttempts === 6, "Meta rejection counter should cover every malformed Meta request");
check(snapshot.blockedNonLoopbackAttempts === 1, "generic guard counter should cover the different provider origin");
check(snapshot.originalExternalCalls === 0, "the boundary must never delegate a non-loopback request");
check(events.filter(event => event.type === "fixture-hit").length === 2, "fixture events should record exact hits");
check(events.filter(event => event.type === "fixture-reject").length === 6, "fixture events should record exact Meta rejections");
check(events.filter(event => event.type === "guard-reject").length === 1, "fixture events should record the generic guard rejection");
const eventText = JSON.stringify(events);
for (const request of [testerLoopMetaFixtureRequest("instagram-business-link"), testerLoopMetaFixtureRequest("connected-instagram-link")]) {
  check(!eventText.includes(request.searchParams.get("access_token")), "fixture events must not expose synthetic tokens");
  check(!eventText.includes(request.pathname.split("/").at(-1)), "fixture events must not expose provider account identifiers");
}

console.log(JSON.stringify({ ok: true, checks, originalCalls, fixtureHits: snapshot.fixtureHits }));
