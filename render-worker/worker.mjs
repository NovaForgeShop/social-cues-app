import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const bucket = process.env.MEDIA_STORAGE_BUCKET || "social-cues-media";
const batchSize = Math.max(1, Math.min(Number(process.env.RENDER_WORKER_BATCH_SIZE || 2), 4));
const leaseSeconds = Math.max(300, Math.min(Number(process.env.RENDER_WORKER_LEASE_SECONDS || 1800), 3600));
const workerId = `cloud-run-render-${process.env.CLOUD_RUN_EXECUTION || process.env.HOSTNAME || process.pid}`;

if (!supabaseUrl || !serviceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

function headers(extra = {}) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", ...extra };
}

async function supabase(pathname, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1${pathname}`, { ...options, headers: headers(options.headers || {}) });
  const text = await response.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

async function startWorkerRun() {
  const rows = await supabase("/worker_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{
      worker_id: workerId,
      trigger: "cloud-run-render",
      status: "running",
      metadata: { kind: "media_render", batchSize, leaseSeconds }
    }])
  });
  return rows?.[0]?.id || null;
}

async function finishWorkerRun(runId, summary, error = null) {
  if (!runId) return;
  const status = error ? "failed" : summary.dead ? (summary.completed || summary.retried ? "partial" : "failed") : "completed";
  await supabase(`/worker_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status,
      completed_at: new Date().toISOString(),
      claimed: summary.claimed,
      succeeded: summary.completed,
      retried: summary.retried,
      blocked: 0,
      dead: summary.dead,
      last_error: error ? String(error.message || error).slice(0, 2000) : null,
      metadata: { kind: "media_render", batchSize, leaseSeconds }
    })
  });
}

async function claimJobs() {
  const rows = await supabase("/rpc/social_cues_claim_worker_jobs", {
    method: "POST",
    body: JSON.stringify({ p_worker_id: workerId, p_limit: batchSize, p_lease_seconds: leaseSeconds, p_kinds: ["media_render"] })
  });
  return Array.isArray(rows) ? rows : [];
}

async function heartbeat(jobId) {
  await supabase("/rpc/social_cues_heartbeat_worker_job", {
    method: "POST",
    body: JSON.stringify({ p_job_id: jobId, p_worker_id: workerId, p_lease_seconds: leaseSeconds })
  });
}

async function finish(job, status, result = {}, error = null, runAt = null) {
  await supabase("/rpc/social_cues_finish_worker_job", {
    method: "POST",
    body: JSON.stringify({
      p_job_id: job.id,
      p_worker_id: workerId,
      p_status: status,
      p_result: result,
      p_error: error,
      p_run_at: runAt,
      p_actual_cost_microusd: 0
    })
  });
}

function storageObjectUrl(storagePath, authenticated = true) {
  const encoded = String(storagePath || "").split("/").map(encodeURIComponent).join("/");
  return `${supabaseUrl}/storage/v1/object/${authenticated ? "authenticated/" : ""}${encodeURIComponent(bucket)}/${encoded}`;
}

async function downloadSource(storagePath, destination) {
  const response = await fetch(storageObjectUrl(storagePath), { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!response.ok) throw new Error(`Storage download ${response.status}: ${await response.text()}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function uploadOutput(storagePath, filePath) {
  const bytes = await readFile(filePath);
  const response = await fetch(storageObjectUrl(storagePath, false), {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "video/mp4",
      "x-upsert": "true"
    },
    body: bytes
  });
  if (!response.ok) throw new Error(`Storage upload ${response.status}: ${await response.text()}`);
  return storagePath;
}

function safeName(value = "output.mp4") {
  const name = path.basename(String(value)).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return (name || "output.mp4").replace(/\.(?!mp4$)[^.]+$/i, ".mp4");
}

function dimensions(output = {}) {
  const resolution = String(output.spec?.resolution || "1080x1920").match(/(\d{3,4})x(\d{3,4})/i);
  const width = Math.min(2160, Math.max(320, Number(resolution?.[1] || 1080)));
  const height = Math.min(2160, Math.max(320, Number(resolution?.[2] || 1920)));
  return { width: width - (width % 2), height: height - (height % 2) };
}

async function runFfmpeg(sourcePath, outputPath, output) {
  const { width, height } = dimensions(output);
  const videoFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
  const args = [
    "-hide_banner", "-loglevel", "warning", "-y", "-i", sourcePath,
    "-vf", videoFilter,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-movflags", "+faststart", outputPath
  ];
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-8000); });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr}`)));
  });
}

function retryAt(job) {
  const delaySeconds = Math.min(3600, 60 * (2 ** Math.min(Math.max(0, Number(job.attempts || 1) - 1), 5)));
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}

async function processRender(job) {
  const payload = job.payload || {};
  if (!payload.storagePath) throw new Error("Render job has no source storage path.");
  const outputs = Array.isArray(payload.outputs) ? payload.outputs.slice(0, 12) : [];
  if (!outputs.length) throw new Error("Render job has no output specifications.");
  const workDir = path.join(os.tmpdir(), `social-cues-${job.id}`);
  await mkdir(workDir, { recursive: true });
  const sourcePath = path.join(workDir, safeName(payload.sourceName || "source.mp4"));
  const completed = [];
  const pulse = setInterval(() => heartbeat(job.id).catch(error => console.error(JSON.stringify({ event: "render_heartbeat_failed", jobId: job.id, error: error.message }))), 60_000);
  try {
    await downloadSource(payload.storagePath, sourcePath);
    for (const output of outputs) {
      await heartbeat(job.id);
      const outputName = safeName(output.outputName || `${output.platform || "platform"}.mp4`);
      const localOutput = path.join(workDir, outputName);
      await runFfmpeg(sourcePath, localOutput, output);
      const storagePath = `${job.workspace_id}/renders/${payload.renderJobId || job.id}/${outputName}`;
      await uploadOutput(storagePath, localOutput);
      completed.push({ platform: output.platform, outputName, storagePath, contentType: "video/mp4", requiredReview: output.requiredReview || "User approval required before publishing." });
    }
    return { renderJobId: payload.renderJobId || null, engine: "ffmpeg", outputs: completed, completedAt: new Date().toISOString() };
  } finally {
    clearInterval(pulse);
    await rm(workDir, { recursive: true, force: true });
  }
}

const summary = { workerId, claimed: 0, completed: 0, retried: 0, dead: 0 };
const runId = await startWorkerRun();
try {
  const jobs = await claimJobs();
  summary.claimed = jobs.length;
  for (const job of jobs) {
    try {
      console.log(JSON.stringify({ event: "render_job_started", workerId, jobId: job.id, attempt: job.attempts }));
      const result = await processRender(job);
      await finish(job, "completed", result);
      summary.completed += 1;
      console.log(JSON.stringify({ event: "render_job_completed", workerId, jobId: job.id, outputs: result.outputs.length }));
    } catch (error) {
      const exhausted = Number(job.attempts || 0) >= Number(job.max_attempts || 12);
      const permanent = /no source storage path|no output specifications|Storage download 4\d\d|ffmpeg exited/i.test(String(error.message || error));
      const status = exhausted || permanent ? "dead" : "retrying";
      await finish(job, status, {}, String(error.message || error).slice(0, 2000), status === "retrying" ? retryAt(job) : null);
      summary[status === "retrying" ? "retried" : "dead"] += 1;
      console.error(JSON.stringify({ event: "render_job_failed", workerId, jobId: job.id, status, error: String(error.message || error) }));
    }
  }
  await finishWorkerRun(runId, summary);
} catch (error) {
  await finishWorkerRun(runId, summary, error).catch(() => {});
  throw error;
}
console.log(JSON.stringify({ event: "render_worker_complete", ...summary }));
