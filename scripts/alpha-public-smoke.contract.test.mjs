import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  executeAlphaPublicSmoke
} from "./alpha-public-smoke.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptsDirectory);
const cliPath = path.join(scriptsDirectory, "alpha-public-smoke.mjs");
const expectedCommit = "b7af387a7f368656e385c0263fd5c460b8a373f7";
const otherCommit = "1".repeat(40);
const fixedTimestamp = "2026-09-07T21:00:00.000Z";
const protectedMarker = "p33-protected-credential-value";
const paths = Object.freeze([
  "/health",
  "/api/release/readiness",
  "/api/auth/readiness",
  "/api/auth/smtp/readiness",
  "/api/billing/readiness",
  "/api/pricing",
  "/api/model",
  "/api/monitoring/status",
  "/api/cron/workers"
]);
const requestIds = Object.freeze(Object.fromEntries(
  paths.map((pathname, index) => [pathname, `p33-request-${String(index + 1).padStart(2, "0")}`])
));

let assertionCount = 0;

function check(condition, message) {
  assertionCount += 1;
  assert.ok(condition, message);
}

function equal(actual, expected, message) {
  assertionCount += 1;
  assert.equal(actual, expected, message);
}

function deepEqual(actual, expected, message) {
  assertionCount += 1;
  assert.deepEqual(actual, expected, message);
}

function responseBodies() {
  return {
    "/health": {
      ok: true,
      app: "Social Cues",
      status: "healthy"
    },
    "/api/release/readiness": {
      ok: true,
      schema: "social-cues.release-readiness.v1",
      ready: false,
      releaseIdentityReady: true,
      commitSha: expectedCommit,
      environment: "production",
      runtime: "vercel",
      gates: {
        hostedPersistence: { review: "R4", status: "HOLD" },
        externalUserContent: "HOLD",
        billingReleaseStage: "readiness_only",
        providers: "DEFERRED"
      }
    },
    "/api/auth/readiness": {
      ok: true,
      ready: true,
      provider: "supabase",
      alphaLocalFallback: false,
      emailVerificationRequired: true,
      passwordRecoveryReady: true,
      loginAlertingReady: true,
      rateLimitGuarded: true,
      signupAccess: {
        mode: "invite-only",
        allowed: "Owner allowlist or active Social Cues Alpha code",
        ownerEmailCount: 1,
        activePromoCodeCount: 0
      }
    },
    "/api/auth/smtp/readiness": {
      ok: true,
      ready: true
    },
    "/api/billing/readiness": {
      ok: false,
      state: "configuration_supported_but_incomplete",
      mode: "live",
      configured: false,
      databaseReady: false,
      releaseStage: "readiness_only",
      checkoutAvailable: false,
      portalAvailable: false,
      webhookProcessingAvailable: false,
      ready: false
    },
    "/api/pricing": {
      ok: true,
      schemaVersion: "social-cues.pricing-presentation.v1",
      pricing: {
        status: "available",
        checkout: { available: false, status: "unavailable" },
        billingActivation: { available: false, status: "unavailable" },
        plans: [
          {
            id: "business",
            checkout: { available: false, status: "unavailable" }
          }
        ]
      }
    },
    "/api/model": {
      ok: false,
      error: "Sign in to Social Cues before using this API."
    },
    "/api/monitoring/status": {
      ok: false,
      error: "Sign in to Social Cues before using this API."
    },
    "/api/cron/workers": {
      ok: false,
      error: "Worker authorization failed."
    }
  };
}

function scenarioResponse(scenario, pathname, redirectOrigin) {
  const bodies = responseBodies();
  const result = {
    status: ["/api/model", "/api/monitoring/status", "/api/cron/workers"].includes(pathname) ? 401 : 200,
    body: bodies[pathname],
    requestId: requestIds[pathname],
    delayMs: 0,
    location: null,
    rawBody: null
  };
  if (scenario === "commit-mismatch" && pathname === "/api/release/readiness") {
    result.body.commitSha = otherCommit;
  }
  if (scenario === "lifted-hold" && pathname === "/api/release/readiness") {
    result.body.gates.providers = "ACTIVE";
  }
  if (scenario === "billing-capability-lifted" && pathname === "/api/billing/readiness") {
    result.body.checkoutAvailable = true;
  }
  if (scenario === "protected-success" && pathname === "/api/model") {
    result.status = 200;
    result.body = { ok: true, reflected: protectedMarker };
  }
  if (scenario === "cross-origin-redirect" && pathname === "/health") {
    result.status = 302;
    result.location = `${redirectOrigin}/${protectedMarker}`;
  }
  if (scenario === "timeout" && pathname === "/api/auth/readiness") {
    result.delayMs = 250;
  }
  if (scenario === "malformed-body" && pathname === "/api/pricing") {
    result.rawBody = `{"unsafe":"${protectedMarker}`;
  }
  if (scenario === "hostile-body" && pathname === "/health") {
    result.body = { ok: false, reflected: protectedMarker };
  }
  if (scenario === "missing-request-id" && pathname === "/api/auth/smtp/readiness") {
    result.requestId = null;
  }
  return result;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function createFixture(scenario) {
  const metrics = {
    requests: [],
    redirectTargetHits: 0,
    externalRequestAttempts: 0,
    nonGetMethods: 0,
    requestBodyBytes: 0,
    authorizationHeaders: 0,
    cookieHeaders: 0,
    queryStrings: 0,
    applicationStateVersion: 0
  };
  const redirectTarget = http.createServer((_req, res) => {
    metrics.redirectTargetHits += 1;
    res.writeHead(204);
    res.end();
  });
  const redirectOrigin = await listen(redirectTarget);
  const pendingHandlers = new Set();
  const server = http.createServer((req, res) => {
    const handler = (async () => {
      const url = new URL(req.url || "/", "http://fixture.local");
      metrics.requests.push(url.pathname);
      if (req.method !== "GET") metrics.nonGetMethods += 1;
      if (url.search) metrics.queryStrings += 1;
      if (req.headers.authorization) metrics.authorizationHeaders += 1;
      if (req.headers.cookie) metrics.cookieHeaders += 1;
      for await (const chunk of req) metrics.requestBodyBytes += chunk.length;

      const fixtureResponse = scenarioResponse(scenario, url.pathname, redirectOrigin);
      if (fixtureResponse.delayMs) await delay(fixtureResponse.delayMs);
      if (res.destroyed) return;
      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `p33_fixture=${protectedMarker}; HttpOnly`,
        "X-Untrusted-Fixture": protectedMarker
      };
      if (fixtureResponse.requestId) headers["X-Request-ID"] = fixtureResponse.requestId;
      if (fixtureResponse.location) headers.Location = fixtureResponse.location;
      res.writeHead(fixtureResponse.status, headers);
      res.end(fixtureResponse.rawBody ?? JSON.stringify(fixtureResponse.body));
    })();
    pendingHandlers.add(handler);
    handler.finally(() => pendingHandlers.delete(handler));
  });
  const baseOrigin = await listen(server);

  async function guardedFetch(input, init = {}) {
    const url = new URL(input);
    if (url.origin !== baseOrigin) {
      metrics.externalRequestAttempts += 1;
      throw new Error("Non-fixture request blocked.");
    }
    const headers = new Headers(init.headers || {});
    if (String(init.method || "GET").toUpperCase() !== "GET") metrics.nonGetMethods += 1;
    if (init.body !== undefined && init.body !== null) metrics.requestBodyBytes += 1;
    if (headers.has("authorization")) metrics.authorizationHeaders += 1;
    if (headers.has("cookie")) metrics.cookieHeaders += 1;
    check(init.redirect === "manual", `${scenario} did not disable redirect following`);
    check(init.credentials === "omit", `${scenario} did not omit credentials`);
    return fetch(input, init);
  }

  async function close() {
    await Promise.allSettled([...pendingHandlers]);
    await closeServer(server);
    await closeServer(redirectTarget);
  }

  return { baseOrigin, guardedFetch, metrics, server, redirectTarget, close };
}

async function runScenario(scenario) {
  const fixture = await createFixture(scenario);
  let execution;
  try {
    const timeoutMs = scenario === "timeout" ? 100 : 1_000;
    execution = await executeAlphaPublicSmoke([
      "--base-url", fixture.baseOrigin,
      "--expected-commit", expectedCommit,
      "--timeout-ms", String(timeoutMs)
    ], {
      fetchImpl: fixture.guardedFetch,
      now: () => new Date(fixedTimestamp)
    });
  } finally {
    await fixture.close();
  }
  return {
    ...execution,
    metrics: fixture.metrics,
    cleanupComplete: !fixture.server.listening && !fixture.redirectTarget.listening
  };
}

function expectedCheck(name, resultCode, httpStatus, pathname) {
  return {
    name,
    status: "PASS",
    resultCode,
    httpStatus,
    requestId: requestIds[pathname]
  };
}

function expectedPassingReport(baseOrigin) {
  return {
    schema: "social-cues.alpha-public-smoke.v1",
    timestamp: fixedTimestamp,
    baseOrigin,
    expectedCommit,
    observedCommit: expectedCommit,
    pass: true,
    checks: [
      expectedCheck("health", "health_contract_ok", 200, "/health"),
      expectedCheck("release_readiness", "release_identity_and_holds_ok", 200, "/api/release/readiness"),
      expectedCheck("auth_readiness", "hosted_auth_readiness_ok", 200, "/api/auth/readiness"),
      expectedCheck("smtp_readiness", "smtp_readiness_ok", 200, "/api/auth/smtp/readiness"),
      expectedCheck("billing_readiness", "billing_activation_unavailable_ok", 200, "/api/billing/readiness"),
      expectedCheck("pricing", "pricing_visible_activation_unavailable_ok", 200, "/api/pricing"),
      expectedCheck("anonymous_model_denial", "anonymous_access_denied_ok", 401, "/api/model"),
      expectedCheck("anonymous_monitoring_denial", "anonymous_access_denied_ok", 401, "/api/monitoring/status"),
      expectedCheck("anonymous_worker_denial", "anonymous_worker_execution_denied_ok", 401, "/api/cron/workers")
    ],
    observations: {
      auth: {
        ready: true,
        provider: "supabase",
        alphaLocalFallback: false,
        emailVerificationRequired: true,
        passwordRecoveryReady: true,
        loginAlertingReady: true,
        rateLimitGuarded: true,
        signupMode: "invite-only"
      },
      smtp: { ready: true },
      billing: {
        state: "configuration_supported_but_incomplete",
        mode: "live",
        configured: false,
        databaseReady: false,
        releaseStage: "readiness_only",
        checkoutAvailable: false,
        portalAvailable: false,
        webhookProcessingAvailable: false,
        ready: false
      },
      pricing: {
        status: "available",
        planCount: 1,
        checkoutAvailable: false,
        billingActivationAvailable: false
      }
    },
    remainingNonPublicGates: [
      { name: "hosted_persistence", status: "HOLD", review: "R4" },
      { name: "external_user_content", status: "HOLD" },
      { name: "billing", status: "READINESS_ONLY" },
      { name: "providers", status: "DEFERRED" }
    ]
  };
}

function assertHermeticMetrics(result, expectedRequests = paths.length) {
  equal(result.metrics.requests.length, expectedRequests, "fixture request count changed");
  equal(result.metrics.externalRequestAttempts, 0, "fixture attempted a non-loopback request");
  equal(result.metrics.redirectTargetHits, 0, "fixture followed a cross-origin redirect");
  equal(result.metrics.nonGetMethods, 0, "fixture used a non-GET method");
  equal(result.metrics.requestBodyBytes, 0, "fixture sent a request body");
  equal(result.metrics.authorizationHeaders, 0, "fixture sent authorization data");
  equal(result.metrics.cookieHeaders, 0, "fixture sent or replayed a cookie");
  equal(result.metrics.queryStrings, 0, "fixture sent a query string");
  equal(result.metrics.applicationStateVersion, 0, "fixture mutated application state");
  check(result.cleanupComplete, "fixture cleanup did not complete");
}

const cliSource = await readFile(cliPath, "utf8");
check(!cliSource.includes("process.env"), "CLI reads environment variables");
check(!/authorization|cookie/iu.test(cliSource.match(/headers:\s*\{[^}]*\}/u)?.[0] || ""), "CLI request headers include credentials");
check(cliSource.includes('method: "GET"'), "CLI does not pin GET requests");
check(cliSource.includes('redirect: "manual"'), "CLI does not disable redirect following");
check(cliSource.includes('credentials: "omit"'), "CLI does not omit credentials");

const passing = await runScenario("pass");
equal(passing.exitCode, 0, "passing fixture returned a nonzero exit");
deepEqual(passing.report, expectedPassingReport(passing.report.baseOrigin), "passing report is not deterministic");
check(!JSON.stringify(passing.report).includes(protectedMarker), "passing report exposed response headers or cookies");
assertHermeticMetrics(passing);

const failureScenarios = [
  ["commit-mismatch", "release_readiness", "release_commit_mismatch"],
  ["lifted-hold", "release_readiness", "release_hold_regression"],
  ["billing-capability-lifted", "billing_readiness", "billing_readiness_regression"],
  ["protected-success", "anonymous_model_denial", "protected_route_unexpected_success"],
  ["cross-origin-redirect", "health", "cross_origin_redirect"],
  ["timeout", "auth_readiness", "request_timeout"],
  ["malformed-body", "pricing", "malformed_json"],
  ["hostile-body", "health", "health_contract_invalid"],
  ["missing-request-id", "smtp_readiness", "missing_request_id"]
];

let loopbackRequestCount = passing.metrics.requests.length;
for (const [scenario, failedCheckName, resultCode] of failureScenarios) {
  const result = await runScenario(scenario);
  loopbackRequestCount += result.metrics.requests.length;
  equal(result.exitCode, 1, `${scenario} returned a zero exit`);
  equal(result.report.pass, false, `${scenario} reported a pass`);
  const failedCheck = result.report.checks.find(checkResult => checkResult.name === failedCheckName);
  equal(failedCheck?.status, "FAIL", `${scenario} did not fail the intended check`);
  equal(failedCheck?.resultCode, resultCode, `${scenario} returned the wrong fixed result code`);
  check(!JSON.stringify(result.report).includes(protectedMarker), `${scenario} reflected protected content`);
  assertHermeticMetrics(result);
}

for (const [argv, resultCode] of [
  [[], "expected_commit_required"],
  [["--base-url", `https://user:${protectedMarker}@example.com`, "--expected-commit", expectedCommit], "base_url_invalid"],
  [["--expected-commit", expectedCommit, "--timeout-ms", "99"], "timeout_invalid"],
  [["--expected-commit", expectedCommit, "--timeout-ms", "30001"], "timeout_invalid"]
]) {
  const execution = await executeAlphaPublicSmoke(argv, { now: () => new Date(fixedTimestamp) });
  equal(execution.exitCode, 1, `${resultCode} configuration returned a zero exit`);
  equal(execution.report.checks[0].resultCode, resultCode, `${resultCode} configuration code changed`);
  check(!JSON.stringify(execution.report).includes(protectedMarker), `${resultCode} reflected an argument value`);
}

const processFixture = await createFixture("pass");
let stdout = "";
let stderr = "";
let childExitCode = null;
try {
  const child = spawn(process.execPath, [
    cliPath,
    "--base-url", processFixture.baseOrigin,
    "--expected-commit", expectedCommit,
    "--timeout-ms", "1000"
  ], {
    cwd: root,
    env: { P33_PROTECTED_CREDENTIAL: protectedMarker },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  [childExitCode] = await once(child, "exit");
} finally {
  await processFixture.close();
}
loopbackRequestCount += processFixture.metrics.requests.length;
equal(childExitCode, 0, "CLI process returned a nonzero exit");
equal(stderr, "", "CLI process wrote to stderr");
const stdoutLines = stdout.split(/\r?\n/u).filter(Boolean);
equal(stdoutLines.length, 1, "CLI process did not emit exactly one JSON report");
const processReport = JSON.parse(stdoutLines[0]);
equal(processReport.pass, true, "CLI process report failed");
check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(processReport.timestamp), "CLI timestamp is not bounded ISO-8601");
check(!stdout.includes(protectedMarker) && !stderr.includes(protectedMarker), "CLI process exposed an environment or response value");
assertHermeticMetrics({
  metrics: processFixture.metrics,
  cleanupComplete: !processFixture.server.listening && !processFixture.redirectTarget.listening
});

console.log(JSON.stringify({
  ok: true,
  suite: "alpha-public-smoke",
  assertions: assertionCount,
  contractScenarios: 1 + failureScenarios.length,
  configurationScenarios: 4,
  cliProcessScenarios: 1,
  loopbackGetRequests: loopbackRequestCount,
  externalRequests: 0,
  nonGetMethods: 0,
  mutations: 0,
  protectedValuesExposed: 0,
  cleanupComplete: true
}));
