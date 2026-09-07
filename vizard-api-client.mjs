import { isIP } from "node:net";

const DEFAULT_BASE_URL = "https://elb-api.vizard.ai/hvizard-server-front/open-api/v1";
const SUPPORTED_VIDEO_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12]);
const SUPPORTED_REMOTE_EXTENSIONS = new Set(["mp4", "3gp", "avi", "mov"]);
const SUPPORTED_RATIOS = new Set([1, 2, 3, 4]);
const SUPPORTED_CLIP_MODELS = new Set(["clip_v1", "clip_v2"]);
const BINARY_SWITCHES = [
  "removeSilenceSwitch",
  "subtitleSwitch",
  "headlineSwitch",
  "emojiSwitch",
  "highlightSwitch",
  "autoBrollSwitch"
];

class VizardClientError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "VizardClientError";
    this.code = code;
  }
}

function invalidRequest(message) {
  throw new VizardClientError(message, "VIZARD_INVALID_REQUEST");
}

function diagnosticUrl(value) {
  try {
    const url = new URL(String(value));
    const query = url.search ? "?[query redacted]" : "";
    return `${url.protocol}//${url.host}/[path redacted]${query}`;
  } catch {
    return "[invalid URL]";
  }
}

function redactText(value, apiKey) {
  let text = String(value ?? "");
  if (apiKey) text = text.split(apiKey).join("[redacted]");
  text = text.replace(/https?:\/\/[^\s<>"']+/giu, (url) => diagnosticUrl(url));
  text = text.replace(
    /\b((?:vizardai_)?api[_ -]?key|token|signature|sig|key|secret|credential|authorization)\s*[:=]\s*([^\s&,;]+)/giu,
    "$1=[redacted]"
  );
  text = text.replace(/\b(?=[a-z0-9_-]{24,}\b)(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b/giu, "[redacted]");
  return text.slice(0, 500);
}

function redactCredentialValues(value, apiKey) {
  if (typeof value === "string") return value.split(apiKey).join("[redacted]");
  if (Array.isArray(value)) return value.map((item) => redactCredentialValues(item, apiKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCredentialValues(item, apiKey)]));
  }
  return value;
}

function parseIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return bytes;
}

function blockedIpv4(bytes) {
  const [a, b] = bytes;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function parseIpv6(hostname) {
  let address = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const zoneIndex = address.indexOf("%");
  if (zoneIndex !== -1) address = address.slice(0, zoneIndex);

  const embeddedIpv4 = address.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (embeddedIpv4) {
    const ipv4 = parseIpv4(embeddedIpv4);
    if (!ipv4) return null;
    const replacement = `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
    address = `${address.slice(0, -embeddedIpv4.length)}${replacement}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return null;

  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function blockedIpv6(bytes) {
  const unspecified = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const uniqueLocal = (bytes[0] & 0xfe) === 0xfc;
  const linkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
  const siteLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0;
  const multicast = bytes[0] === 0xff;
  const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return unspecified || loopback || uniqueLocal || linkLocal || siteLocal || multicast || (ipv4Mapped && blockedIpv4(bytes.slice(12)));
}

function blockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  const addressType = isIP(host);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".localdomain") ||
    host.endsWith(".internal") ||
    (addressType === 0 && !host.includes(".")) ||
    host === "metadata" ||
    host === "metadata.google" ||
    host === "metadata.google.internal" ||
    host === "instance-data.ec2.internal"
  ) {
    return true;
  }

  if (addressType === 4) return blockedIpv4(parseIpv4(host));
  if (addressType === 6) {
    const bytes = parseIpv6(host);
    return !bytes || blockedIpv6(bytes);
  }
  return false;
}

function normalizeSourceUrl(value, allowHttpSource) {
  if (typeof value !== "string" || !value.trim()) invalidRequest("videoUrl is required.");
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    invalidRequest("videoUrl is malformed.");
  }
  if (url.protocol !== "https:" && !(allowHttpSource && url.protocol === "http:")) {
    invalidRequest("videoUrl must use HTTPS.");
  }
  if (url.username || url.password) {
    invalidRequest(`videoUrl must not contain embedded credentials (${diagnosticUrl(url)}).`);
  }
  if (!url.hostname || blockedHostname(url.hostname)) {
    invalidRequest(`videoUrl host is not a permitted public host (${diagnosticUrl(url)}).`);
  }
  return url.href;
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) invalidRequest(`${name} is required.`);
  return value.trim();
}

function optionalText(value, name, maxLength = 500) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) invalidRequest(`${name} must be a non-empty string.`);
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    invalidRequest(`${name} contains unsupported characters or is too long.`);
  }
  return normalized;
}

function normalizeVideoType(value) {
  if (!Number.isInteger(value) || !SUPPORTED_VIDEO_TYPES.has(value)) {
    invalidRequest("videoType is not supported.");
  }
  return value;
}

function normalizeExtension(value, videoType) {
  if (videoType !== 1) {
    if (value !== undefined) invalidRequest("ext is supported only when videoType is 1.");
    return undefined;
  }
  if (typeof value !== "string") invalidRequest("ext is required when videoType is 1.");
  const extension = value.trim().toLowerCase().replace(/^\./u, "");
  if (!SUPPORTED_REMOTE_EXTENSIONS.has(extension)) {
    invalidRequest("ext must be mp4, 3gp, avi, or mov when videoType is 1.");
  }
  return extension;
}

function normalizePreferLength(value) {
  if (!Array.isArray(value) || value.length === 0) invalidRequest("preferLength must be a non-empty array.");
  const lengths = [...new Set(value)];
  if (lengths.some((length) => !Number.isInteger(length) || length < 0 || length > 4)) {
    invalidRequest("preferLength values must be 0, 1, 2, 3, or 4.");
  }
  if (lengths.includes(0) && lengths.length !== 1) {
    invalidRequest("preferLength 0 cannot be combined with another length.");
  }
  return lengths;
}

function assignRatio(payload, value) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || !SUPPORTED_RATIOS.has(value)) {
    invalidRequest("ratioOfClip must be 1, 2, 3, or 4.");
  }
  payload.ratioOfClip = value;
}

function assignTemplate(payload, value) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) invalidRequest("templateId must be a positive integer.");
  payload.templateId = value;
}

function assignSwitches(payload, request) {
  for (const name of BINARY_SWITCHES) {
    const value = request[name];
    if (value === undefined) continue;
    if (value !== 0 && value !== 1) invalidRequest(`${name} must be 0 or 1.`);
    payload[name] = value;
  }
}

function buildCreatePayload(request, allowHttpSource) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    invalidRequest("createProject requires a request object.");
  }
  if (request.mode !== "clipping" && request.mode !== "editing") {
    invalidRequest('mode must be "clipping" or "editing".');
  }

  const videoType = normalizeVideoType(request.videoType);
  const payload = {
    lang: requiredText(request.lang, "lang"),
    videoUrl: normalizeSourceUrl(request.videoUrl, allowHttpSource),
    videoType
  };
  const extension = normalizeExtension(request.ext, videoType);
  if (extension) payload.ext = extension;
  assignRatio(payload, request.ratioOfClip);
  assignTemplate(payload, request.templateId);
  assignSwitches(payload, request);
  const projectName = optionalText(request.projectName, "projectName", 200);
  if (projectName) payload.projectName = projectName;

  if (request.mode === "editing") {
    if (request.getClips !== undefined && request.getClips !== 0) {
      invalidRequest("editing mode requires getClips to be 0.");
    }
    for (const name of ["preferLength", "maxClipNumber", "keywords", "clipModel"]) {
      if (request[name] !== undefined) invalidRequest(`${name} is supported only in clipping mode.`);
    }
    payload.getClips = 0;
    return payload;
  }

  if (request.getClips !== undefined) invalidRequest("getClips is supported only in editing mode.");
  payload.preferLength = normalizePreferLength(request.preferLength);
  if (request.maxClipNumber !== undefined) {
    if (!Number.isInteger(request.maxClipNumber) || request.maxClipNumber < 1 || request.maxClipNumber > 100) {
      invalidRequest("maxClipNumber must be between 1 and 100.");
    }
    payload.maxClipNumber = request.maxClipNumber;
  }
  const keywords = optionalText(request.keywords, "keywords", 500);
  if (keywords) payload.keywords = keywords;
  if (request.clipModel !== undefined) {
    if (!SUPPORTED_CLIP_MODELS.has(request.clipModel)) {
      invalidRequest("clipModel must be clip_v1 or clip_v2.");
    }
    payload.clipModel = request.clipModel;
  }
  return payload;
}

function normalizeProviderCode(value) {
  const code = Number(value);
  if (!Number.isInteger(code)) {
    throw new VizardClientError("Vizard returned a malformed response.", "VIZARD_MALFORMED_RESPONSE");
  }
  return code;
}

function failureState(code) {
  if (code === 4001) return "authentication_failed";
  if (code === 4003) return "rate_limited";
  if (code === 4004 || code === 4006 || code === 4010) return "invalid_request";
  if (code === 4007) return "insufficient_minutes";
  if (code === 4005 || code === 4008 || code === 4009) return "source_unavailable";
  return "failed";
}

function providerResult(payload, httpStatus, apiKey, state) {
  const providerCode = normalizeProviderCode(payload.code);
  return {
    state: state ?? failureState(providerCode),
    providerCode,
    providerMessage: redactText(payload.errMsg ?? payload.message ?? "", apiKey),
    httpStatus
  };
}

function normalizeBoolean(value) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

function parseRelatedTopics(value) {
  let topics = value;
  if (typeof topics === "string") {
    try {
      topics = JSON.parse(topics);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(topics)) return [];
  return topics.filter((topic) => typeof topic === "string").map((topic) => topic.trim()).filter(Boolean);
}

function normalizeVideo(video, projectId) {
  const providerVideoId = video.videoId === null || video.videoId === undefined ? "" : String(video.videoId);
  const temporaryVideoUrl = typeof video.videoUrl === "string" ? video.videoUrl : "";
  return {
    providerProjectId: projectId,
    providerVideoId,
    // Vizard documents these URLs as temporary. A later phase must copy approved files to Social Cues storage.
    temporaryVideoUrl,
    durationMs: normalizeNumber(video.videoMsDuration),
    title: normalizeString(video.title),
    transcript: normalizeString(video.transcript),
    viralScore: normalizeNumber(video.viralScore),
    viralReason: normalizeString(video.viralReason),
    relatedTopics: parseRelatedTopics(video.relatedTopic),
    editorUrl: normalizeString(video.clipEditorUrl),
    starred: normalizeBoolean(video.starred),
    disliked: normalizeBoolean(video.disliked)
  };
}

function normalizeProjectId(value, name = "projectId") {
  const projectId = String(value ?? "").trim();
  if (!projectId || projectId.length > 128 || !/^[a-z0-9_-]+$/iu.test(projectId)) {
    invalidRequest(`${name} is invalid.`);
  }
  return projectId;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new VizardClientError("Vizard base URL is invalid.", "VIZARD_INVALID_CONFIGURATION");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
    throw new VizardClientError("Vizard base URL is invalid.", "VIZARD_INVALID_CONFIGURATION");
  }
  return url.href.replace(/\/$/u, "");
}

export function createVizardClient({
  apiKey,
  fetch: fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 30_000,
  allowHttpSource = false
} = {}) {
  const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!normalizedApiKey) {
    throw new VizardClientError("VIZARD_API_KEY is required.", "VIZARD_INVALID_CONFIGURATION");
  }
  if (typeof fetchImpl !== "function") {
    throw new VizardClientError("A fetch implementation is required.", "VIZARD_INVALID_CONFIGURATION");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new VizardClientError("timeoutMs must be between 1 and 300000.", "VIZARD_INVALID_CONFIGURATION");
  }
  const endpoint = normalizeBaseUrl(baseUrl);
  const safeResult = (value) => redactCredentialValues(value, normalizedApiKey);

  async function requestJson(pathname, { method, body } = {}) {
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    if ([endpoint, pathname, serializedBody].some((value) => value?.includes(normalizedApiKey))) {
      throw new VizardClientError("Vizard request data must not contain the API key.", "VIZARD_INVALID_REQUEST");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {
        Accept: "application/json",
        VIZARDAI_API_KEY: normalizedApiKey
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetchImpl(`${endpoint}${pathname}`, {
        method,
        headers,
        body: serializedBody,
        redirect: "error",
        signal: controller.signal
      });
      const responseText = await response.text();
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new VizardClientError("Vizard returned malformed JSON.", "VIZARD_MALFORMED_RESPONSE");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new VizardClientError("Vizard returned a malformed response.", "VIZARD_MALFORMED_RESPONSE");
      }
      if (!response.ok && payload.code === undefined) {
        throw new VizardClientError(`Vizard request failed with HTTP ${response.status}.`, "VIZARD_HTTP_ERROR");
      }
      return { payload, httpStatus: response.status };
    } catch (error) {
      if (error instanceof VizardClientError) throw error;
      if (controller.signal.aborted) {
        throw new VizardClientError(`Vizard request timed out after ${timeoutMs} ms.`, "VIZARD_TIMEOUT");
      }
      throw new VizardClientError("Vizard request failed before a definitive response was received.", "VIZARD_NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
    }
  }

  async function createProject(request) {
    const payload = buildCreatePayload(request, allowHttpSource);
    // Intentionally single-shot: retrying an ambiguous create can duplicate a paid project.
    const response = await requestJson("/project/create", { method: "POST", body: payload });
    const providerCode = normalizeProviderCode(response.payload.code);
    if (providerCode !== 2000) return safeResult(providerResult(response.payload, response.httpStatus, normalizedApiKey));
    const result = providerResult(response.payload, response.httpStatus, normalizedApiKey, "accepted");
    const providerProjectId = response.payload.projectId === undefined || response.payload.projectId === null
      ? null
      : String(response.payload.projectId);
    return safeResult({ ...result, providerProjectId });
  }

  async function queryProject(projectId) {
    const normalizedProjectId = normalizeProjectId(projectId);
    const response = await requestJson(`/project/query/${encodeURIComponent(normalizedProjectId)}`, { method: "GET" });
    const providerCode = normalizeProviderCode(response.payload.code);
    if (providerCode === 1000) {
      return safeResult({
        ...providerResult(response.payload, response.httpStatus, normalizedApiKey, "processing"),
        providerProjectId: String(response.payload.projectId ?? normalizedProjectId)
      });
    }
    if (providerCode === 2000) {
      const providerProjectId = String(response.payload.projectId ?? normalizedProjectId);
      const videos = Array.isArray(response.payload.videos)
        ? response.payload.videos.filter((video) => video && typeof video === "object" && !Array.isArray(video))
          .map((video) => normalizeVideo(video, providerProjectId))
        : [];
      return safeResult({
        ...providerResult(response.payload, response.httpStatus, normalizedApiKey, "completed"),
        providerProjectId,
        videos
      });
    }
    return safeResult({
      ...providerResult(response.payload, response.httpStatus, normalizedApiKey),
      providerProjectId: String(response.payload.projectId ?? normalizedProjectId)
    });
  }

  return Object.freeze({ createProject, queryProject });
}
