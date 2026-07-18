import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const projectRef = process.env.SUPABASE_PROJECT_REF || "arbkgucejiovqakwvibw";
const apply = process.argv.includes("--apply");

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(resolve(".env"));

function readSetting(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

const settings = {
  accessToken: readSetting("SUPABASE_ACCESS_TOKEN"),
  resendApiKey: readSetting("RESEND_API_KEY"),
  host: readSetting("SMTP_HOST", "SUPABASE_SMTP_HOST") || (readSetting("RESEND_API_KEY") ? "smtp.resend.com" : ""),
  port: Number(readSetting("SMTP_PORT", "SUPABASE_SMTP_PORT") || "587"),
  user: readSetting("SMTP_USER", "SUPABASE_SMTP_USER") || (readSetting("RESEND_API_KEY") ? "resend" : ""),
  pass: readSetting("SMTP_PASS", "SMTP_PASSWORD", "SUPABASE_SMTP_PASS", "RESEND_API_KEY"),
  from: readSetting("SMTP_FROM", "SUPABASE_SMTP_FROM", "SUPPORT_EMAIL"),
  senderName: readSetting("SMTP_SENDER_NAME", "SUPABASE_SMTP_SENDER_NAME") || "Social Cues"
};

const required = [
  ["SUPABASE_ACCESS_TOKEN", settings.accessToken],
  ["SMTP_HOST", settings.host],
  ["SMTP_PORT", Number.isFinite(settings.port) && settings.port > 0 ? String(settings.port) : ""],
  ["SMTP_USER", settings.user],
  ["SMTP_PASS", settings.pass],
  ["SMTP_FROM", settings.from]
];

const missing = required.filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  console.error(`Missing required SMTP setup values: ${missing.join(", ")}`);
  console.error("No Supabase changes were made.");
  process.exit(1);
}

const payload = {
  external_email_enabled: true,
  mailer_secure_email_change_enabled: true,
  mailer_autoconfirm: false,
  smtp_admin_email: settings.from,
  smtp_host: settings.host,
  smtp_port: settings.port,
  smtp_user: settings.user,
  smtp_pass: settings.pass,
  smtp_sender_name: settings.senderName
};

console.log(JSON.stringify({
  projectRef,
  apply,
  smtpHost: settings.host,
  smtpPort: settings.port,
  smtpUserPresent: Boolean(settings.user),
  smtpPassPresent: Boolean(settings.pass),
  smtpFrom: settings.from,
  smtpSenderName: settings.senderName
}, null, 2));

if (!apply) {
  console.log("Dry run only. Re-run with --apply to update Supabase Auth SMTP settings.");
  process.exit(0);
}

const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${settings.accessToken}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(payload)
});

const text = await response.text();
if (!response.ok) {
  console.error(`Supabase SMTP update failed: ${response.status} ${text}`);
  process.exit(1);
}

console.log("Supabase Auth SMTP settings updated.");
