import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const defaultTargets = [
  "SENTRY_DSN",
  "SENTRY_ENVIRONMENT",
  "SENTRY_RELEASE",
  "SENTRY_TRACES_SAMPLE_RATE",
  "SENTRY_LOGS_ENABLED",
  "ETSY_CLIENT_SECRET",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "LINKEDIN_APPLICATION_ID",
  "LINKEDIN_API_VERSION",
  "LINKEDIN_OIDC_PRODUCT_GRANTED",
  "LINKEDIN_COMPANY_VERIFIED",
  "LINKEDIN_COMMUNITY_MANAGEMENT_TIER",
  "LINKEDIN_OAUTH_SCOPES",
  "PATREON_PUBLIC_APP_URL",
  "PATREON_CLIENT_ID",
  "PATREON_CLIENT_SECRET",
  "PATREON_OAUTH_SCOPES",
  "PATREON_WEBHOOK_SECRET",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_ANNOUNCEMENT_CHANNEL_ID",
  "CANVA_CLIENT_ID",
  "CANVA_CLIENT_SECRET",
  "PINTEREST_APP_ID",
  "PINTEREST_APP_SECRET",
  "PINTEREST_ACCESS_TIER",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_SHOP_DOMAIN",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CUSTOMER_ID",
  "GOOGLE_ANALYTICS_PROPERTY_ID",
  "REDDIT_DEVVIT_APP_SLUG",
  "REDDIT_COMMERCIAL_APPROVED",
  "REDDIT_DATA_API_CLIENT_ID",
  "REDDIT_DATA_API_CLIENT_SECRET",
  "REDDIT_ADS_API_CLIENT_ID",
  "REDDIT_ADS_API_CLIENT_SECRET",
  "REDDIT_ADS_ACCOUNT_ID",
  "VERCEL_BLOB_READ_WRITE_TOKEN",
  "OPENAI_VIDEO_MODEL"
];

function parseArgs(argv) {
  const args = { apply: false, environment: "production", names: [], envFile: ".env" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--env" || arg === "--environment") args.environment = argv[++index] || args.environment;
    else if (arg === "--names") args.names = (argv[++index] || "").split(",").map(item => item.trim()).filter(Boolean);
    else if (arg === "--env-file") args.envFile = argv[++index] || args.envFile;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function usage() {
  return [
    "Social Cues Vercel env sync",
    "",
    "Dry run:",
    "  npm run vercel:env:audit",
    "",
    "Apply non-empty local values to Vercel production:",
    "  npm run vercel:env:sync -- --apply",
    "",
    "Limit names:",
    "  npm run vercel:env:sync -- --apply --names ETSY_CLIENT_SECRET",
    "",
    "This script never prints secret values."
  ].join("\n");
}

function parseEnvFile(filePath) {
  const env = {};
  if (!existsSync(filePath)) return env;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadVercelProject() {
  const projectPath = path.join(root, ".vercel", "project.json");
  if (!existsSync(projectPath)) {
    throw new Error("Missing .vercel/project.json. Link this workspace to Vercel first.");
  }
  const project = JSON.parse(readFileSync(projectPath, "utf8"));
  if (!project.projectId || !project.orgId) {
    throw new Error(".vercel/project.json is missing its project or team identifier.");
  }
  return project;
}

function vercelApiUrl(project, suffix = "", params = {}) {
  const url = new URL(`https://api.vercel.com/v10/projects/${encodeURIComponent(project.projectId)}/env${suffix}`);
  url.searchParams.set("teamId", project.orgId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

async function vercelRequest(project, token, { method = "GET", body, params } = {}) {
  if (!token) throw new Error("VERCEL_TOKEN is not configured locally.");
  const response = await fetch(vercelApiUrl(project, "", params), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    let code = "unknown_error";
    try {
      const payload = await response.json();
      code = payload?.error?.code || payload?.code || code;
    } catch {}
    throw new Error(`Vercel API request failed (${response.status}, ${code}).`);
  }
  return response.json();
}

function targetIncludesEnvironment(target, environment) {
  if (Array.isArray(target)) return target.some(item => String(item).toLowerCase() === environment.toLowerCase());
  return String(target || "").toLowerCase() === environment.toLowerCase();
}

async function listExistingNames(project, token, environment) {
  const payload = await vercelRequest(project, token);
  const variables = Array.isArray(payload) ? payload : payload?.envs || payload?.data || [];
  return new Set(
    variables
      .filter(variable => targetIncludesEnvironment(variable?.target, environment))
      .map(variable => variable?.key)
      .filter(Boolean)
  );
}

async function addEnvironmentVariable(project, token, name, value, environment) {
  await vercelRequest(project, token, {
    method: "POST",
    body: {
      key: name,
      value,
      type: "sensitive",
      target: [environment],
      comment: "Managed by Social Cues env sync"
    }
  });
}

function redactedValueState(value = "") {
  if (!value) return "empty";
  return `present (${value.length} chars)`;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const envPath = path.resolve(root, args.envFile);
const localEnv = parseEnvFile(envPath);
const token = localEnv.VERCEL_TOKEN || process.env.VERCEL_TOKEN || "";
const project = loadVercelProject();
const names = args.names.length ? args.names : defaultTargets;

console.log(`Social Cues Vercel env sync (${args.apply ? "apply" : "dry-run"})`);
console.log(`Environment: ${args.environment}`);
console.log(`Source file: ${path.relative(root, envPath) || ".env"}`);
console.log("Secret values are never printed.");

let existing = new Set();
try {
  existing = await listExistingNames(project, token, args.environment);
} catch (error) {
  if (args.apply) {
    console.error(error.message);
    process.exit(1);
  }
  console.log("WARN_VERCEL_LIST_UNAVAILABLE dry-run will not mark existing production variables");
}

let added = 0;
let skipped = 0;
let missingLocal = 0;
for (const name of names) {
  const value = localEnv[name] || "";
  if (!value) {
    missingLocal += 1;
    console.log(`MISSING_LOCAL ${name}`);
    continue;
  }
  if (existing.has(name)) {
    skipped += 1;
    console.log(`EXISTS ${name} ${redactedValueState(value)}`);
    continue;
  }
  if (!args.apply) {
    console.log(`WOULD_ADD ${name} ${redactedValueState(value)}`);
    continue;
  }
  try {
    await addEnvironmentVariable(project, token, name, value, args.environment);
    added += 1;
    console.log(`ADDED ${name}`);
  } catch (error) {
    console.error(`FAILED ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

console.log(`Summary: ${added} added, ${skipped} already present, ${missingLocal} missing locally, ${names.length} checked.`);
