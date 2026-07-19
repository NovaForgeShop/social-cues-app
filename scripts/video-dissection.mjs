import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const PLATFORM_SPECS = {
  tiktok: { width: 1080, height: 1920, maxSeconds: 60, label: "TikTok" },
  instagram: { width: 1080, height: 1920, maxSeconds: 90, label: "Instagram Reels" },
  threads: { width: 1080, height: 1920, maxSeconds: 60, label: "Threads" },
  "youtube-short": { width: 1080, height: 1920, maxSeconds: 60, label: "YouTube Shorts" },
  facebook: { width: 1080, height: 1920, maxSeconds: 90, label: "Facebook Reels" },
  x: { width: 1080, height: 1920, maxSeconds: 60, label: "X" },
  square: { width: 1080, height: 1080, maxSeconds: 60, label: "Square feed" }
};

function parseArgs(argv) {
  const options = { platforms: ["tiktok", "instagram", "youtube-short"], maxClips: 3, render: false, transcribe: false, ai: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--") && !options.input) options.input = value;
    else if (value === "--render") options.render = true;
    else if (value === "--transcribe") options.transcribe = true;
    else if (value === "--ai") options.ai = true;
    else if (value === "--output-dir") options.outputDir = argv[++index];
    else if (value === "--platforms") options.platforms = String(argv[++index] || "").split(",").map(item => item.trim()).filter(Boolean);
    else if (value === "--max-clips") options.maxClips = Math.max(1, Math.min(12, Number(argv[++index] || 3)));
    else if (value === "--message") options.message = argv[++index] || "";
    else if (value === "--audience") options.audience = argv[++index] || "";
  }
  return options;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function probeVideo(input) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", input]);
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find(stream => stream.codec_type === "video");
  const audio = (data.streams || []).find(stream => stream.codec_type === "audio");
  if (!video) throw new Error("The source does not contain a video stream.");
  const fpsParts = String(video.avg_frame_rate || "0/1").split("/").map(Number);
  return {
    durationSeconds: Number(data.format?.duration || video.duration || 0),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    fps: fpsParts[1] ? Number((fpsParts[0] / fpsParts[1]).toFixed(3)) : 0,
    videoCodec: video.codec_name || "unknown",
    audioCodec: audio?.codec_name || "none",
    hasAudio: Boolean(audio),
    sizeBytes: Number(data.format?.size || 0),
    bitRate: Number(data.format?.bit_rate || 0),
    orientation: Number(video.width || 0) > Number(video.height || 0) ? "landscape" : Number(video.width || 0) < Number(video.height || 0) ? "portrait" : "square"
  };
}

async function detectScenes(input) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", input, "-vf", "select='gt(scene,0.28)',showinfo", "-an", "-f", "null", "-"]);
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map(match => Number(match[1])).filter(Number.isFinite);
}

async function detectSilence(input, hasAudio) {
  if (!hasAudio) return [];
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", input, "-af", "silencedetect=noise=-34dB:d=0.35", "-f", "null", "-"]);
  const starts = [...stderr.matchAll(/silence_start: ([0-9.]+)/g)].map(match => Number(match[1]));
  const ends = [...stderr.matchAll(/silence_end: ([0-9.]+)/g)].map(match => Number(match[1]));
  return starts.map((start, index) => ({ start, end: ends[index] ?? start, duration: Math.max(0, (ends[index] ?? start) - start) }));
}

async function transcribeAudio(input, outputDir) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for --transcribe.");
  const audioPath = path.join(outputDir, "source-audio.mp3");
  await run("ffmpeg", ["-y", "-hide_banner", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioPath]);
  const form = new FormData();
  form.set("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
  form.set("response_format", "json");
  form.set("file", new Blob([await readFile(audioPath)], { type: "audio/mpeg" }), "source-audio.mp3");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Transcription failed with ${response.status}.`);
  return String(data.text || "").trim();
}

function candidateWindows(duration, scenes, silences, maxClips) {
  if (duration <= 0) return [];
  const target = duration <= 75 ? duration : 35;
  const boundaries = [0, duration, ...scenes, ...silences.map(item => item.end)]
    .filter(value => Number.isFinite(value) && value >= 0 && value <= duration)
    .sort((left, right) => left - right)
    .filter((value, index, list) => index === 0 || value - list[index - 1] >= 1.5);
  const starts = duration <= 75 ? [0] : boundaries.filter(value => value <= Math.max(0, duration - 8));
  return starts.map(start => {
    const end = Math.min(duration, start + target);
    const sceneCount = scenes.filter(value => value > start && value < end).length;
    const silenceSeconds = silences
      .filter(item => item.end > start && item.start < end)
      .reduce((total, item) => total + Math.max(0, Math.min(end, item.end) - Math.max(start, item.start)), 0);
    const clipDuration = end - start;
    const pacing = Math.min(30, sceneCount * 5);
    const audioContinuity = Math.max(0, 25 - Math.round((silenceSeconds / Math.max(1, clipDuration)) * 50));
    const hookPosition = Math.max(0, 25 - Math.round((start / Math.max(1, duration)) * 18));
    const durationFit = Math.max(0, 20 - Math.abs(35 - clipDuration));
    return {
      startSeconds: Number(start.toFixed(3)),
      endSeconds: Number(end.toFixed(3)),
      durationSeconds: Number(clipDuration.toFixed(3)),
      sceneChanges: sceneCount,
      silenceSeconds: Number(silenceSeconds.toFixed(3)),
      score: Math.max(0, Math.min(100, pacing + audioContinuity + hookPosition + durationFit)),
      evidence: [
        `${sceneCount} visual scene change(s)`,
        `${Number(silenceSeconds.toFixed(1))} seconds of detected silence`,
        start < 3 ? "opens near the source hook" : `starts at ${Number(start.toFixed(1))} seconds`
      ]
    };
  }).sort((left, right) => right.score - left.score || left.startSeconds - right.startSeconds).slice(0, maxClips);
}

async function scoreCandidatesWithAi({ transcript, candidates, message, audience }) {
  if (!process.env.OPENAI_API_KEY || !transcript || !candidates.length) return candidates;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      instructions: "Rank short-video candidates for hook strength, coherent message, payoff, audience fit, and honest fidelity to the source. Do not invent visual or spoken content. Return JSON only.",
      input: JSON.stringify({ messageToPreserve: message, audience, transcript, candidates }),
      text: { format: { type: "json_schema", name: "video_candidate_scores", strict: true, schema: {
        type: "object", additionalProperties: false, required: ["candidates"], properties: { candidates: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["startSeconds", "score", "reason", "hook", "payoff"], properties: {
            startSeconds: { type: "number" }, score: { type: "number" }, reason: { type: "string" }, hook: { type: "string" }, payoff: { type: "string" }
          }
        } } }
      } } }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `AI candidate scoring failed with ${response.status}.`);
  const raw = data.output?.flatMap(item => item.content || []).find(item => item.type === "output_text")?.text || "{}";
  const scores = JSON.parse(raw).candidates || [];
  const byStart = new Map(scores.map(item => [Number(item.startSeconds).toFixed(3), item]));
  return candidates.map(candidate => {
    const ai = byStart.get(Number(candidate.startSeconds).toFixed(3));
    return ai ? { ...candidate, score: Math.max(0, Math.min(100, Number(ai.score || candidate.score))), aiReason: ai.reason, hook: ai.hook, payoff: ai.payoff } : candidate;
  }).sort((left, right) => right.score - left.score);
}

function safeOverlayText(value, fallback) {
  return String(value || fallback).replace(/[^a-zA-Z0-9 .,!?'&-]/g, "").slice(0, 72).trim() || fallback;
}

function ffmpegText(value) {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%");
}

async function renderClip({ input, output, startSeconds, durationSeconds, spec, headline, hasAudio }) {
  const font = process.platform === "win32" ? "C\\:/Windows/Fonts/arialbd.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const text = ffmpegText(safeOverlayText(headline, "Your next idea starts here"));
  const filter = [
    `[0:v]split=2[background][foreground]`,
    `[background]scale=${spec.width}:${spec.height}:force_original_aspect_ratio=increase,crop=${spec.width}:${spec.height},boxblur=20:2[blurred]`,
    `[foreground]scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease[subject]`,
    `[blurred][subject]overlay=(W-w)/2:(H-h)/2,drawbox=x=0:y=ih*0.73:w=iw:h=ih*0.27:color=0x07090d@0.86:t=fill,drawbox=x=0:y=ih*0.73:w=iw:h=8:color=0xff2d78:t=fill,drawtext=fontfile='${font}':text='${text}':fontcolor=white:fontsize=${Math.round(spec.width * 0.048)}:x=(w-text_w)/2:y=h*0.79:box=0[outv]`
  ].join(";");
  const args = ["-y", "-hide_banner", "-ss", String(startSeconds), "-i", input, "-t", String(Math.min(durationSeconds, spec.maxSeconds)), "-filter_complex", filter, "-map", "[outv]"];
  if (hasAudio) args.push("-map", "0:a:0", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k");
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output);
  await run("ffmpeg", args);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) throw new Error("Usage: npm run video:dissect -- <video> [--render] [--transcribe] [--ai]");
  const input = path.resolve(options.input);
  const outputDir = path.resolve(options.outputDir || path.join("outputs", `video-dissection-${Date.now()}`));
  await mkdir(outputDir, { recursive: true });
  const source = await probeVideo(input);
  const [scenes, silences] = await Promise.all([detectScenes(input), detectSilence(input, source.hasAudio)]);
  const transcript = options.transcribe && source.hasAudio ? await transcribeAudio(input, outputDir) : "";
  let candidates = candidateWindows(source.durationSeconds, scenes, silences, options.maxClips);
  if (options.ai) candidates = await scoreCandidatesWithAi({ transcript, candidates, message: options.message, audience: options.audience });
  const selected = candidates[0] || { startSeconds: 0, durationSeconds: Math.min(60, source.durationSeconds), score: 0, evidence: [] };
  const outputs = [];
  for (const platform of options.platforms) {
    const spec = PLATFORM_SPECS[platform];
    if (!spec) throw new Error(`Unknown platform format: ${platform}`);
    const output = path.join(outputDir, `${path.parse(input).name}-${platform}.mp4`);
    if (options.render) await renderClip({ input, output, startSeconds: selected.startSeconds, durationSeconds: selected.durationSeconds, spec, headline: options.message || selected.hook, hasAudio: source.hasAudio });
    outputs.push({ platform, label: spec.label, width: spec.width, height: spec.height, maxSeconds: spec.maxSeconds, file: options.render ? output : null, status: options.render ? "rendered" : "planned" });
  }
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    engine: { probe: "ffprobe", edit: "ffmpeg", transcript: transcript ? (process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe") : "not-requested", scoring: options.ai ? (process.env.OPENAI_MODEL || "gpt-4.1-mini") : "evidence-heuristic" },
    source: { file: input, ...source },
    intent: { messageToPreserve: options.message || "", audience: options.audience || "" },
    evidence: { sceneThreshold: 0.28, sceneChanges: scenes, silences, transcript },
    candidates,
    selectedCandidate: selected,
    outputs,
    reviewGate: "A person must review message fidelity, captions, crop, and platform settings before publishing."
  };
  const manifestPath = path.join(outputDir, "dissection-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, manifest: manifestPath, candidates: candidates.length, rendered: outputs.filter(item => item.status === "rendered").length })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
