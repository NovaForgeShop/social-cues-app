import * as Sentry from "@sentry/node";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sentryEnvNames = new Set([
  "SENTRY_DSN",
  "SENTRY_ENVIRONMENT",
  "SENTRY_RELEASE",
  "SENTRY_TRACES_SAMPLE_RATE",
  "SENTRY_LOGS_ENABLED"
]);

async function loadLocalSentryEnv() {
  try {
    const source = await readFile(path.join(__dirname, ".env"), "utf8");
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const separator = trimmed.indexOf("=");
      const key = trimmed.slice(0, separator).trim();
      if (!sentryEnvNames.has(key) || process.env[key] !== undefined) continue;
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // Production receives configuration from Vercel; a local .env is optional.
  }
}

await loadLocalSentryEnv();

const sensitiveKey = /authorization|cookie|token|secret|password|credential|session|api[-_]?key|client[-_]?secret|code[-_]?verifier|access[-_]?key/i;
const sentryDsn = String(process.env.SENTRY_DSN || "").trim();
const sentryEnvironment = String(process.env.SENTRY_ENVIRONMENT || (process.env.VERCEL_ENV === "production" ? "production" : "development")).trim();
const commitSha = String(process.env.VERCEL_GIT_COMMIT_SHA || "").trim();
const sentryRelease = String(process.env.SENTRY_RELEASE || (commitSha ? `social-cues@${commitSha}` : "social-cues@local")).trim();
const configuredSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.1");
const tracesSampleRate = Number.isFinite(configuredSampleRate) ? Math.max(0, Math.min(configuredSampleRate, 1)) : 0.1;
const logsEnabled = !/^(0|false|no|off)$/i.test(String(process.env.SENTRY_LOGS_ENABLED || "true"));

function stripUrlQuery(value = "") {
  try {
    const parsed = new URL(String(value), "https://socialcuesapp.com");
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(value).split(/[?#]/)[0].slice(0, 500);
  }
}

function redactValue(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 30).map(item => redactValue(item, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? value.slice(0, 2_000) : value;
  }
  const safe = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    safe[key] = sensitiveKey.test(key) ? "[redacted]" : redactValue(item, depth + 1);
  }
  return safe;
}

function sanitizeEvent(event = {}) {
  if (event.request) {
    event.request.url = stripUrlQuery(event.request.url || "");
    delete event.request.data;
    delete event.request.cookies;
    event.request.headers = Object.fromEntries(
      Object.entries(event.request.headers || {}).filter(([key]) => ["content-type", "user-agent"].includes(key.toLowerCase()))
    );
  }
  if (event.user) event.user = event.user.id ? { id: String(event.user.id).slice(0, 128) } : undefined;
  if (event.extra) event.extra = redactValue(event.extra);
  if (event.contexts) event.contexts = redactValue(event.contexts);
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.slice(-50).map(item => ({
      ...item,
      message: String(item.message || "").slice(0, 500),
      data: redactValue(item.data || {})
    }));
  }
  return event;
}

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: sentryEnvironment,
    release: sentryRelease,
    enableLogs: logsEnabled,
    tracesSampleRate,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      httpBodies: []
    },
    beforeSend: event => sanitizeEvent(event),
    beforeSendTransaction: event => sanitizeEvent(event),
    ignoreErrors: [
      "AbortError",
      "The operation was aborted",
      "ResizeObserver loop limit exceeded"
    ]
  });
}

export function sentryStatus() {
  return {
    configured: Boolean(sentryDsn),
    environment: sentryEnvironment,
    release: sentryRelease,
    logsEnabled,
    tracesSampleRate,
    piiCollection: false,
    requestBodies: false
  };
}

function safeFaultContext(context = {}) {
  return {
    requestId: String(context.requestId || "").slice(0, 80),
    method: String(context.method || "").slice(0, 12),
    path: stripUrlQuery(context.path || "/"),
    runtime: String(context.runtime || "server").slice(0, 32),
    source: String(context.source || "").split(/[?#]/)[0].slice(0, 500),
    line: Math.max(0, Number(context.line || 0)),
    column: Math.max(0, Number(context.column || 0))
  };
}

export async function captureServerException(error, context = {}) {
  if (!sentryDsn) return null;
  let eventId = null;
  Sentry.withScope(scope => {
    const safe = safeFaultContext(context);
    scope.setTag("social_cues.runtime", safe.runtime || "server");
    scope.setTag("social_cues.request_id", safe.requestId || "unknown");
    if (context.userId) scope.setUser({ id: String(context.userId).slice(0, 128) });
    scope.setContext("social_cues_request", safe);
    eventId = Sentry.captureException(error instanceof Error ? error : new Error(String(error || "Unknown server error")));
  });
  await Sentry.flush(1_500).catch(() => false);
  return eventId;
}

export async function captureClientException(input = {}, context = {}) {
  if (!sentryDsn) return null;
  const message = String(input.message || "Unhandled browser error").slice(0, 500);
  const error = new Error(message);
  error.name = String(input.name || "BrowserError").slice(0, 100);
  if (input.stack) error.stack = String(input.stack).slice(0, 8_000);
  return captureServerException(error, {
    ...context,
    runtime: "browser",
    source: input.source,
    line: input.line,
    column: input.column
  });
}

export function recordRequestTelemetry({ method = "GET", path: requestPath = "/", statusCode = 0, durationMs = 0 } = {}) {
  if (!sentryDsn) return;
  const attributes = {
    "http.request.method": String(method).slice(0, 12),
    "http.route": stripUrlQuery(requestPath),
    "http.response.status_code": Number(statusCode || 0)
  };
  Sentry.metrics.count("social_cues.http.request", 1, { attributes });
  Sentry.metrics.distribution("social_cues.http.duration", Math.max(0, Number(durationMs || 0)), {
    unit: "millisecond",
    attributes
  });
}

export function traceSupabaseOperation({ area = "rest", pathname = "/", method = "GET" } = {}, operation) {
  if (typeof operation !== "function") throw new TypeError("traceSupabaseOperation requires an operation function.");
  if (!sentryDsn) return operation();
  const safePath = String(pathname || "/").split(/[?#]/)[0].slice(0, 300);
  return Sentry.startSpan({
    op: area === "auth" ? "auth.supabase" : "db.supabase",
    name: `Supabase ${area} ${String(method || "GET").toUpperCase()} ${safePath}`,
    attributes: {
      "db.system": "postgresql",
      "server.address": "supabase",
      "supabase.area": String(area).slice(0, 40),
      "http.request.method": String(method || "GET").toUpperCase().slice(0, 12),
      "http.route": safePath
    }
  }, operation);
}

export function logRuntimeError(event, fields = {}) {
  if (!sentryDsn || !logsEnabled) return;
  Sentry.logger.error(String(event || "runtime_error").slice(0, 200), redactValue(fields));
}
