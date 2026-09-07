import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(root, "server.mjs");
const schema = "social-cues.release-readiness.v1";
const expectedGates = Object.freeze({
  hostedPersistence: Object.freeze({ review: "R4", status: "HOLD" }),
  externalUserContent: "HOLD",
  billingReleaseStage: "readiness_only",
  providers: "DEFERRED"
});
const productionSha = "ABCDEF12".repeat(5);
const previewSha = "2".repeat(40);
const developmentSha = "3".repeat(40);
const hostileMarker = ["p32", "hostile", "reflection"].join("-");
const mixedSha = `${"a".repeat(19)}-${"b".repeat(20)}`;
const protectedValues = Object.freeze([
  ["p32", "session", "secret"].join("-"),
  ["p32", "encryption", "secret"].join("-"),
  ["p32", "authorization", "marker"].join("-"),
  ["p32", "cookie", "marker"].join("-"),
  ["p32", "header", "marker"].join("-"),
  hostileMarker
]);

const scenarios = Object.freeze([
  {
    name: "vercel-production",
    vercel: true,
    sha: productionSha,
    environment: "production",
    ready: true
  },
  {
    name: "vercel-preview",
    vercel: true,
    sha: previewSha,
    environment: "preview",
    ready: true
  },
  {
    name: "vercel-development",
    vercel: true,
    sha: developmentSha,
    environment: "development",
    ready: true
  },
  {
    name: "missing-sha",
    vercel: true,
    sha: "",
    environment: "production",
    ready: false
  },
  {
    name: "invalid-sha",
    vercel: true,
    sha: "g".repeat(40),
    environment: "production",
    ready: false
  },
  {
    name: "mixed-content-sha",
    vercel: true,
    sha: mixedSha,
    environment: "preview",
    ready: false
  },
  {
    name: "overlong-sha",
    vercel: true,
    sha: "a".repeat(41),
    environment: "production",
    ready: false
  },
  {
    name: "whitespace-padded-sha",
    vercel: true,
    sha: ` ${previewSha} `,
    environment: "preview",
    ready: false
  },
  {
    name: "missing-environment",
    vercel: true,
    sha: previewSha,
    environment: "",
    ready: false
  },
  {
    name: "hostile-environment",
    vercel: true,
    sha: previewSha,
    environment: `production:${hostileMarker}`,
    ready: false
  },
  {
    name: "local-runtime",
    vercel: false,
    sha: developmentSha,
    environment: "development",
    ready: false
  }
]);

let checkCount = 0;

function check(condition, message) {
  checkCount += 1;
  assert.ok(condition, message);
}

function equal(actual, expected, message) {
  checkCount += 1;
  assert.equal(actual, expected, message);
}

function deepEqual(actual, expected, message) {
  checkCount += 1;
  assert.deepEqual(actual, expected, message);
}

function assertValuesAbsent(value, markers, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) || "";
  for (const marker of markers) {
    check(!serialized.includes(marker), `${label} exposed a protected value`);
  }
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

async function requestJson(baseUrl, pathname, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "GET",
    redirect: "manual",
    headers
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

async function waitForServer(baseUrl, child, output) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Release-readiness server exited early (${child.exitCode}).\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for release-readiness server.\n${output()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    delay(3_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    })
  ]);
}

async function readExternalRequestCount(logPath) {
  try {
    const source = await readFile(logPath, "utf8");
    return source.split(/\r?\n/u).filter(Boolean).length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function directorySnapshot(directory, excludedPath) {
  const result = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(current, entry.name);
      if (absolutePath === excludedPath) continue;
      const relativePath = path.relative(directory, absolutePath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        result.push({ path: `${relativePath}/`, type: "directory" });
        await walk(absolutePath);
      } else {
        result.push({
          path: relativePath,
          type: entry.isFile() ? "file" : "other",
          bytes: entry.isFile() ? (await readFile(absolutePath)).toString("base64") : null
        });
      }
    }
  }
  await walk(directory);
  return result;
}

function scenarioEnvironment({ scenario, port, baseUrl, dataDir, requestLogPath }) {
  return {
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    PUBLIC_APP_URL: baseUrl,
    BRAND_HOME_URL: baseUrl,
    AUTH_PROVIDER: "alpha-local",
    AUTH_SESSION_SECRET: protectedValues[0],
    OAUTH_TOKEN_ENCRYPTION_KEY: protectedValues[1],
    SUPABASE_ENABLED: "false",
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    SUPABASE_SECRET_KEY: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    SENTRY_DSN: "",
    AUTOMATIC_PUBLISHING_ENABLED: "false",
    STRIPE_BILLING_MODE: "disabled",
    SOCIAL_CUES_DATA_DIR: dataDir,
    SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: requestLogPath,
    VERCEL: scenario.vercel ? "1" : "",
    VERCEL_GIT_COMMIT_SHA: scenario.sha,
    VERCEL_ENV: scenario.environment
  };
}

async function startScenario({ temporaryRoot, guardPath, scenario }) {
  const dataDir = path.join(temporaryRoot, scenario.name);
  const requestLogPath = path.join(dataDir, "external-requests.ndjson");
  await mkdir(dataDir, { recursive: true });
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = scenarioEnvironment({ scenario, port, baseUrl, dataDir, requestLogPath });
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [`--import=${pathToFileURL(guardPath).href}`, serverPath], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    await waitForServer(baseUrl, child, () => `${stdout}\n${stderr}`);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return {
    baseUrl,
    child,
    dataDir,
    requestLogPath,
    output: () => `${stdout}\n${stderr}`
  };
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "social-cues-release-readiness-"));
const guardPath = path.join(temporaryRoot, "external-request-guard.mjs");
const guardSource = `
import { appendFileSync } from "node:fs";

const originalFetch = globalThis.fetch;
const logPath = process.env.SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG || "";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

globalThis.fetch = async (input, init = {}) => {
  const rawUrl = input instanceof URL || typeof input === "string"
    ? String(input)
    : String(input?.url || "");
  const url = new URL(rawUrl);
  if (loopbackHosts.has(url.hostname)) return originalFetch(input, init);
  if (logPath) appendFileSync(logPath, "blocked-non-loopback\\n", "utf8");
  throw new Error("Non-loopback request blocked by release-readiness contract.");
};
`;

let activeScenario = null;
let cleanupComplete = false;
let failure = null;

try {
  await writeFile(guardPath, guardSource, "utf8");
  for (const scenario of scenarios) {
    activeScenario = await startScenario({ temporaryRoot, guardPath, scenario });
    try {
      const dataBefore = await directorySnapshot(
        activeScenario.dataDir,
        activeScenario.requestLogPath
      );
      const requestHeaders = {
        Authorization: `Bearer ${protectedValues[2]}`,
        Cookie: `sc_session=${protectedValues[3]}`,
        "X-Release-Probe": protectedValues[4],
        "X-Forwarded-Host": `${hostileMarker}.example.test`
      };
      const readiness = await requestJson(
        activeScenario.baseUrl,
        "/api/release/readiness",
        requestHeaders
      );
      const expectedIdentity = scenario.ready
        ? {
            releaseIdentityReady: true,
            commitSha: scenario.sha.toLowerCase(),
            environment: scenario.environment
          }
        : {
            releaseIdentityReady: false,
            commitSha: null,
            environment: null
          };
      equal(readiness.status, 200, `${scenario.name} readiness status changed`);
      deepEqual(readiness.body, {
        ok: true,
        schema,
        ready: false,
        ...expectedIdentity,
        runtime: scenario.vercel ? "vercel" : "local",
        gates: expectedGates
      }, `${scenario.name} readiness response did not match the bounded schema`);
      assertValuesAbsent(readiness.text, protectedValues, `${scenario.name} readiness response`);
      if (!scenario.ready) {
        for (const rawValue of [scenario.sha, scenario.environment].filter(Boolean)) {
          check(!readiness.text.includes(rawValue), `${scenario.name} reflected invalid or untrusted identity input`);
        }
      }
      for (const name of [
        "VERCEL_GIT_COMMIT_SHA",
        "VERCEL_ENV",
        "AUTH_SESSION_SECRET",
        "OAUTH_TOKEN_ENCRYPTION_KEY"
      ]) {
        check(!readiness.text.includes(name), `${scenario.name} exposed an environment variable name`);
      }

      const health = await requestJson(activeScenario.baseUrl, "/health", requestHeaders);
      equal(health.status, 200, `${scenario.name} health status changed`);
      deepEqual(health.body, {
        ok: true,
        app: "Social Cues",
        status: "healthy"
      }, `${scenario.name} health response changed`);
      assertValuesAbsent(health.text, protectedValues, `${scenario.name} health response`);
      deepEqual(
        await directorySnapshot(activeScenario.dataDir, activeScenario.requestLogPath),
        dataBefore,
        `${scenario.name} read-only probes mutated persistence data`
      );
      equal(
        await readExternalRequestCount(activeScenario.requestLogPath),
        0,
        `${scenario.name} attempted a non-loopback request`
      );
      assertValuesAbsent(activeScenario.output(), protectedValues, `${scenario.name} stdout or stderr`);
    } finally {
      await stopChild(activeScenario.child);
      activeScenario = null;
    }
  }
} catch (error) {
  failure = error;
} finally {
  await stopChild(activeScenario?.child);
  await rm(temporaryRoot, { recursive: true, force: true });
  cleanupComplete = !existsSync(temporaryRoot);
}

if (!cleanupComplete) throw new Error("Release-readiness contract cleanup did not complete");
if (failure) throw failure;

console.log(JSON.stringify({
  ok: true,
  schema,
  checks: checkCount,
  scenarios: scenarios.length,
  vercelEnvironments: 3,
  invalidIdentityScenarios: scenarios.filter(scenario => !scenario.ready).length,
  healthContractChecks: scenarios.length,
  externalRequests: 0,
  externalMutations: 0,
  secretsExposed: 0,
  cleanupComplete
}));
