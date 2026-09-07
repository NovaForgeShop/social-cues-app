import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { createVizardClient } from "../vizard-api-client.mjs";

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MINUTES = 30;
const MAX_TIMEOUT_MINUTES = 120;

function usage() {
  return `Usage:
  npm.cmd run vizard:canary -- --submit --accept-minute-charge --model=clip_v1 --video-url=<https-url> --video-type=<type> [--ext=mp4] [--timeout-minutes=30] [--project-name=<name>]

Required safeguards:
  VIZARD_API_KEY             Social Cues-owned local/internal canary key only; never use for customer jobs or pass as a CLI argument.
  --submit                   Confirms that one Vizard create request may be sent.
  --accept-minute-charge     Confirms that provider minutes may be consumed.
  --model=clip_v1|clip_v2    Explicit model choice. Vizard documents clip_v2 at 1.25x the v1 billing rate.
  --video-url=<https-url>    Public source URL. The URL is validated but never printed.
  --video-type=<type>        Vizard source type: 1-7 or 9-12.

For --video-type=1, --ext=mp4|3gp|avi|mov is also required.
The command submits exactly one clipping project, polls no more often than every 30 seconds,
does not download output videos, and stops after the bounded timeout.`;
}

function parseArguments(argv) {
  const options = {
    submit: false,
    acceptMinuteCharge: false,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES
  };
  const valueFlags = new Map([
    ["--model", "model"],
    ["--video-url", "videoUrl"],
    ["--video-type", "videoType"],
    ["--ext", "ext"],
    ["--timeout-minutes", "timeoutMinutes"],
    ["--project-name", "projectName"]
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--submit") {
      options.submit = true;
      continue;
    }
    if (argument === "--accept-minute-charge") {
      options.acceptMinuteCharge = true;
      continue;
    }

    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const key = valueFlags.get(flag);
    if (!key) throw new Error("Unknown command-line option.");
    const value = separator === -1 ? argv[index + 1] : argument.slice(separator + 1);
    if (separator === -1) index += 1;
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    if (Object.hasOwn(options, key) && key !== "timeoutMinutes") throw new Error(`${flag} may be supplied only once.`);
    options[key] = value;
  }

  return options;
}

function boundedInteger(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return number;
}

function sanitizeProjectName(value) {
  const fallback = `Social Cues Vizard canary ${new Date().toISOString().slice(0, 10)}`;
  const normalized = String(value || fallback)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return normalized || fallback;
}

function safeId(value) {
  return String(value ?? "").replace(/[^a-z0-9_-]/giu, "").slice(0, 128) || "[missing]";
}

function safeSummaryText(value, limit, apiKey) {
  let text = typeof value === "string" ? value : "";
  if (apiKey) text = text.split(apiKey).join("[redacted]");
  return text
    .replace(/https?:\/\/[^\s<>"']+/giu, "[URL redacted]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function completionSummary(result, apiKey) {
  const videos = Array.isArray(result.videos) ? result.videos : [];
  return {
    state: "completed",
    projectId: safeId(result.providerProjectId),
    clipCount: videos.length,
    clips: videos.map((video) => ({
      id: safeId(video.providerVideoId),
      durationMs: Number.isFinite(video.durationMs) ? video.durationMs : null,
      title: safeSummaryText(video.title, 160, apiKey),
      viralScore: Number.isFinite(video.viralScore) ? video.viralScore : null,
      viralReason: safeSummaryText(video.viralReason, 240, apiKey),
      transcriptPresent: Boolean(video.transcript),
      editorUrlPresent: Boolean(video.editorUrl)
    }))
  };
}

function terminalSummary(result, apiKey) {
  return {
    state: result.state,
    providerCode: result.providerCode,
    providerMessage: safeSummaryText(result.providerMessage, 240, apiKey)
  };
}

async function run() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const apiKey = String(process.env.VIZARD_API_KEY || "").trim();
  const missing = [];
  if (!apiKey) missing.push("VIZARD_API_KEY");
  if (!options.submit) missing.push("--submit");
  if (!options.acceptMinuteCharge) missing.push("--accept-minute-charge");
  if (!options.model) missing.push("--model");
  if (!options.videoUrl) missing.push("--video-url");
  if (!options.videoType) missing.push("--video-type");
  if (missing.length) {
    process.stderr.write(`Missing required safeguards: ${missing.join(", ")}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.model !== "clip_v1" && options.model !== "clip_v2") {
    process.stderr.write(`--model must be clip_v1 or clip_v2.\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  let videoType;
  let timeoutMinutes;
  try {
    videoType = boundedInteger(options.videoType, "--video-type", 1, 12);
    timeoutMinutes = boundedInteger(options.timeoutMinutes, "--timeout-minutes", 1, MAX_TIMEOUT_MINUTES);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (videoType === 8 || (videoType === 1 && !options.ext)) {
    process.stderr.write(`${videoType === 8 ? "--video-type=8 is not supported." : "--ext is required for --video-type=1."}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  let terminationSignal = "";
  const terminationController = new AbortController();
  const requestStop = (signal) => {
    if (terminationSignal) return;
    terminationSignal = signal;
    terminationController.abort();
  };
  const onSigint = () => requestStop("SIGINT");
  const onSigterm = () => requestStop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const canaryFetch = (url, fetchOptions = {}) => fetch(url, {
    ...fetchOptions,
    signal: AbortSignal.any([fetchOptions.signal, terminationController.signal])
  });
  const client = createVizardClient({ apiKey, fetch: canaryFetch, timeoutMs: 30_000 });
  const deadline = Date.now() + timeoutMinutes * 60_000;

  try {
    process.stdout.write(`Submitting exactly one Vizard clipping project with ${options.model}.\n`);
    const created = await client.createProject({
      mode: "clipping",
      lang: "auto",
      preferLength: [1, 2],
      videoUrl: options.videoUrl,
      videoType,
      ext: options.ext,
      ratioOfClip: 1,
      removeSilenceSwitch: 0,
      maxClipNumber: 5,
      subtitleSwitch: 1,
      headlineSwitch: 1,
      emojiSwitch: 0,
      highlightSwitch: 1,
      autoBrollSwitch: 0,
      clipModel: options.model,
      projectName: sanitizeProjectName(options.projectName)
    });

    if (created.state !== "accepted" || !created.providerProjectId) {
      process.stderr.write(`${JSON.stringify(terminalSummary(created, apiKey), null, 2)}\n`);
      process.exitCode = 1;
      return;
    }

    const projectId = created.providerProjectId;
    process.stdout.write(`Accepted project ${safeId(projectId)}. Polling every 30 seconds for up to ${timeoutMinutes} minute(s).\n`);

    while (!terminationSignal && Date.now() < deadline) {
      const waitMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
      if (waitMs > 0) await sleep(waitMs, undefined, { signal: terminationController.signal });
      if (terminationSignal || Date.now() >= deadline) break;

      let result;
      try {
        result = await client.queryProject(projectId);
      } catch (error) {
        if (terminationSignal) break;
        process.stderr.write(`A query attempt did not receive a definitive response: ${safeSummaryText(error.message, 200, apiKey)}\n`);
        continue;
      }

      if (result.state === "processing") {
        process.stdout.write(`Project ${safeId(projectId)} is still processing.\n`);
        continue;
      }
      if (result.state === "completed") {
        process.stdout.write(`${JSON.stringify(completionSummary(result, apiKey), null, 2)}\n`);
        return;
      }

      process.stderr.write(`${JSON.stringify(terminalSummary(result, apiKey), null, 2)}\n`);
      process.exitCode = 1;
      return;
    }

    if (terminationSignal) {
      process.stderr.write(`Canary stopped cleanly after ${terminationSignal}; no additional create request was sent.\n`);
      process.exitCode = terminationSignal === "SIGINT" ? 130 : 143;
      return;
    }
    process.stderr.write(`Canary timed out after ${timeoutMinutes} minute(s); no additional create request was sent.\n`);
    process.exitCode = 1;
  } catch (error) {
    if (terminationSignal) {
      process.stderr.write(`Canary stopped cleanly after ${terminationSignal}; no additional create request was sent.\n`);
      process.exitCode = terminationSignal === "SIGINT" ? 130 : 143;
      return;
    }
    process.stderr.write(`Canary stopped without retrying submission: ${safeSummaryText(error.message, 240, apiKey)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

await run();
