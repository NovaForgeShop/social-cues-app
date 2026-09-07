import fs from "node:fs";
import { appendFileSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const ACTIVATION_ENV = "SOCIAL_CUES_TESTER_LOOP_PROVIDER_FIXTURE";
const FIXTURE_LOG_ENV = "SOCIAL_CUES_TESTER_LOOP_PROVIDER_FIXTURE_LOG";
const SERVER_PROCESS_ENV = "SOCIAL_CUES_TESTER_LOOP_SERVER_PROCESS";
const META_ORIGIN = "https://graph.facebook.com";
const META_API_VERSION = "v23.0";
const SYNTHETIC_PAGE_ID = "test-tester-loop-facebook-page-1";
const SYNTHETIC_PAGE_TOKEN = "tester-loop-facebook-token";
const SYNTHETIC_PAGE_NAME = "Tester Loop Page";
const META_PATH = `/${META_API_VERSION}/${SYNTHETIC_PAGE_ID}`;
const FIELD_CASES = new Map([
  ["id,name,link,instagram_business_account{id,username,name,profile_picture_url}", "instagram-business-link"],
  ["id,name,link,connected_instagram_account{id,username,name,profile_picture_url}", "connected-instagram-link"]
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function testerLoopFixtureActivation(env = process.env, cwd = process.cwd()) {
  const reasons = [];
  if (env[ACTIVATION_ENV] !== "1") reasons.push("activation_disabled");
  if (env[SERVER_PROCESS_ENV] !== "1") reasons.push("not_tester_loop_server");
  if (env.E2E_USE_LOCAL_SERVER !== "1") reasons.push("not_local_e2e");
  if (env.AUTH_PROVIDER !== "alpha-local") reasons.push("not_alpha_local");
  if (String(env.SUPABASE_ENABLED || "").toLowerCase() !== "false") reasons.push("supabase_not_disabled");
  if (String(env.NODE_ENV || "").toLowerCase() === "production") reasons.push("production_node_env");
  if (env.VERCEL || env.VERCEL_ENV) reasons.push("vercel_runtime");

  const tempRoot = path.resolve(cwd, ".tmp");
  const dataDir = env.SOCIAL_CUES_DATA_DIR ? path.resolve(cwd, env.SOCIAL_CUES_DATA_DIR) : "";
  const logPath = env[FIXTURE_LOG_ENV] ? path.resolve(cwd, env[FIXTURE_LOG_ENV]) : "";
  if (!dataDir || !isInside(tempRoot, dataDir)) reasons.push("data_dir_not_disposable");
  if (!logPath || !dataDir || !isInside(dataDir, logPath)) reasons.push("fixture_log_not_scoped");

  return Object.freeze({ allowed: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export function assertTesterLoopFixtureActivation(env = process.env, cwd = process.cwd()) {
  const result = testerLoopFixtureActivation(env, cwd);
  if (!result.allowed) {
    throw new Error(`Tester-loop provider fixture activation denied: ${result.reasons.join(", ")}`);
  }
  return result;
}

export function isTesterLoopEnvFile(target) {
  try {
    return path.basename(path.resolve(String(target || ""))).toLowerCase() === ".env";
  } catch {
    return false;
  }
}

function blockEnvFileLoading() {
  const originalExistsSync = fs.existsSync.bind(fs);
  fs.existsSync = target => isTesterLoopEnvFile(target) ? false : originalExistsSync(target);
  syncBuiltinESMExports();
}

function requestParts(input, init = {}) {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const rawUrl = input instanceof URL || typeof input === "string"
    ? String(input)
    : String(input?.url || "");
  const headers = new Headers(isRequest ? input.headers : undefined);
  for (const [name, value] of new Headers(init.headers).entries()) headers.set(name, value);
  return {
    target: new URL(rawUrl),
    method: String(init.method || (isRequest ? input.method : "GET") || "GET").toUpperCase(),
    headers,
    bodyPresent: init.body !== undefined && init.body !== null
      ? true
      : Boolean(isRequest && input.body)
  };
}

function safeEvent(type, details = {}) {
  return Object.freeze({
    type,
    method: details.method || "",
    origin: details.origin || "",
    fixtureCase: details.fixtureCase || "",
    reason: details.reason || ""
  });
}

export function createTesterLoopProviderBoundary({ originalFetch, recordEvent = () => {} } = {}) {
  if (typeof originalFetch !== "function") throw new TypeError("An original fetch function is required.");
  const state = {
    fixtureHits: 0,
    unexpectedProviderAttempts: 0,
    blockedNonLoopbackAttempts: 0,
    originalExternalCalls: 0,
    fixtureCases: {
      "instagram-business-link": 0,
      "connected-instagram-link": 0
    }
  };

  const rejectProvider = (parts, reason) => {
    state.unexpectedProviderAttempts += 1;
    recordEvent(safeEvent("fixture-reject", {
      method: parts.method,
      origin: parts.target.origin,
      reason
    }));
    throw new Error(`Tester-loop Meta fixture rejected request: ${reason}`);
  };

  const rejectNonLoopback = parts => {
    state.blockedNonLoopbackAttempts += 1;
    recordEvent(safeEvent("guard-reject", {
      method: parts.method,
      origin: parts.target.origin,
      reason: "unmodeled_non_loopback"
    }));
    throw new Error("Tester-loop outbound network guard rejected an unmodeled non-loopback request.");
  };

  const guardedFetch = async (input, init = {}) => {
    const parts = requestParts(input, init);
    const { target, method, headers, bodyPresent } = parts;
    if (!["http:", "https:"].includes(target.protocol) || LOOPBACK_HOSTS.has(target.hostname)) {
      return originalFetch(input, init);
    }
    if (target.origin !== META_ORIGIN) return rejectNonLoopback(parts);
    if (method !== "GET") return rejectProvider(parts, "unexpected_method");
    if (target.pathname !== META_PATH) return rejectProvider(parts, "unexpected_path");
    if (bodyPresent) return rejectProvider(parts, "unexpected_body");
    if (headers.has("authorization")) return rejectProvider(parts, "unexpected_authorization");

    const entries = [...target.searchParams.entries()];
    const names = entries.map(([name]) => name).sort();
    if (entries.length !== 2 || names[0] !== "access_token" || names[1] !== "fields") {
      return rejectProvider(parts, "unexpected_query");
    }
    if (target.searchParams.get("access_token") !== SYNTHETIC_PAGE_TOKEN) {
      return rejectProvider(parts, "unknown_token");
    }
    const fields = target.searchParams.get("fields") || "";
    const fixtureCase = FIELD_CASES.get(fields);
    if (!fixtureCase) return rejectProvider(parts, "unexpected_fields");

    state.fixtureHits += 1;
    state.fixtureCases[fixtureCase] += 1;
    recordEvent(safeEvent("fixture-hit", { method, origin: target.origin, fixtureCase }));
    const body = {
      id: SYNTHETIC_PAGE_ID,
      name: SYNTHETIC_PAGE_NAME,
      link: "",
      ...(fixtureCase === "instagram-business-link"
        ? { instagram_business_account: null }
        : { connected_instagram_account: null })
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  };

  return Object.freeze({
    fetch: guardedFetch,
    snapshot: () => Object.freeze({
      ...state,
      fixtureCases: Object.freeze({ ...state.fixtureCases })
    })
  });
}

export function testerLoopMetaFixtureRequest(fixtureCase = "instagram-business-link") {
  const fields = [...FIELD_CASES.entries()].find(([, name]) => name === fixtureCase)?.[0];
  if (!fields) throw new Error("Unknown tester-loop Meta fixture case.");
  const target = new URL(`${META_ORIGIN}${META_PATH}`);
  target.searchParams.set("fields", fields);
  target.searchParams.set("access_token", SYNTHETIC_PAGE_TOKEN);
  return target;
}

function installActivatedBoundary() {
  assertTesterLoopFixtureActivation();
  blockEnvFileLoading();
  const logPath = path.resolve(process.env[FIXTURE_LOG_ENV]);
  mkdirSync(path.dirname(logPath), { recursive: true });
  const recordEvent = event => appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
  const boundary = createTesterLoopProviderBoundary({ originalFetch: globalThis.fetch, recordEvent });
  globalThis.fetch = boundary.fetch;
}

if (process.env[ACTIVATION_ENV] === "1") installActivatedBoundary();
