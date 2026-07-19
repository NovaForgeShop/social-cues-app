import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function requireCondition(condition, message) {
  if (!condition) failures.push(message);
}

function commandAvailable(command, args = ["-version"]) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

const server = readFileSync(path.join(root, "server.mjs"), "utf8");
const schema = readFileSync(path.join(root, "SUPABASE-DURABLE-WORKERS.sql"), "utf8");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
requireCondition(server.includes('kind: "media_render"'), "The server does not enqueue durable media_render jobs.");
requireCondition(server.includes("signedSupabaseMediaUrl"), "The server does not return short-lived signed render output URLs.");
requireCondition(schema.includes("worker_jobs"), "The durable worker schema is missing worker_jobs.");
requireCondition(Boolean(packageJson.dependencies?.remotion && packageJson.dependencies?.["@remotion/renderer"]), "Remotion renderer dependencies are missing.");
requireCondition(commandAvailable("ffmpeg"), "FFmpeg is not available on PATH.");
requireCondition(commandAvailable("ffprobe"), "FFprobe is not available on PATH.");

const assetDir = path.join(root, "public", "media", "social-cues-promo-pack");
const expectedAssets = [
  "social-cues-coming-soon-square-feed-1080x1080.mp4",
  "social-cues-coming-soon-vertical-9x16-1080x1920.mp4",
  "social-cues-coming-soon-story-safe-1080x1920.mp4",
  "social-cues-coming-soon-square-still-1080x1080.png",
  "social-cues-coming-soon-vertical-still-1080x1920.png",
  "social-cues-coming-soon-youtube-thumbnail-1280x720.png"
];
for (const fileName of expectedAssets) {
  const filePath = path.join(assetDir, fileName);
  requireCondition(existsSync(filePath) && statSync(filePath).size > 10_000, `Launch asset is missing or empty: ${fileName}`);
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`PASS render worker contract: durable queue, private output signing, FFmpeg, Remotion, and ${expectedAssets.length} launch assets verified.\n`);
