import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, appendFile, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const owner = "social-cues-local-pilot.v1";
const fixtureModule = path.join(projectRoot, "tests", "support", "tester-loop-provider-fixture.mjs");

export function pilotEnvironment(config, parent = process.env) {
  const allowed = new Set(["systemroot", "windir", "path", "pathext", "comspec", "temp", "tmp",
    "home", "userprofile", "localappdata", "appdata", "lang", "lc_all"]);
  const env = Object.fromEntries(Object.entries(parent).filter(([name]) => allowed.has(name.toLowerCase())));
  return { ...env, HOST: "127.0.0.1", PORT: String(config.port), PUBLIC_APP_URL: config.url,
    AUTH_PROVIDER: "alpha-local", NODE_ENV: "test", SUPABASE_ENABLED: "false",
    AUTH_SESSION_SECRET: config.sessionSecret, SOCIAL_CUES_DATA_DIR: config.dataDir,
    E2E_USE_LOCAL_SERVER: "1", SOCIAL_CUES_TESTER_LOOP_PROVIDER_FIXTURE: "1",
    SOCIAL_CUES_TESTER_LOOP_SERVER_PROCESS: "1",
    SOCIAL_CUES_TESTER_LOOP_PROVIDER_FIXTURE_LOG: path.join(config.dataDir, "provider-fixture.jsonl"),
    META_APP_ID: "123456789012345", META_APP_SECRET: "social-cues-e2e-meta-secret", META_API_VERSION: "v23.0",
    OPENAI_API_KEY: "", NODE_OPTIONS: "--import=" + pathToFileURL(fixtureModule).href
  };
}

function validateDataDir(dataDir) {
  const tempRoot = path.join(projectRoot, ".tmp");
  const relative = path.relative(tempRoot, path.resolve(dataDir));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(dataDir).startsWith("local-pilot-")) {
    throw new Error("Pilot data must be a task-owned local-pilot directory under this worktree's .tmp.");
  }
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

export async function createLocalPilot({ resumeDir = "" } = {}) {
  const tempRoot = path.join(projectRoot, ".tmp");
  await mkdir(tempRoot, { recursive: true });
  const dataDir = resumeDir ? path.resolve(resumeDir) : await mkdtemp(path.join(tempRoot, "local-pilot-"));
  validateDataDir(dataDir);
  const configPath = path.join(dataDir, "pilot-config.json");
  let config;
  if (resumeDir) {
    config = JSON.parse(await readFile(configPath, "utf8"));
    if (config.owner !== owner || path.resolve(config.dataDir) !== dataDir
      || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
      || config.url !== "http://127.0.0.1:" + config.port || typeof config.sessionSecret !== "string" || !config.sessionSecret) {
      throw new Error("The resume directory is not a valid local pilot.");
    }
  } else {
    const port = await availablePort();
    config = { owner, dataDir, port, url: "http://127.0.0.1:" + port, sessionSecret: randomUUID() + randomUUID() };
    await writeFile(configPath, JSON.stringify(config, null, 2), { flag: "wx" });
  }
  const env = pilotEnvironment(config);
  // The child preloads and validates the fixture against its isolated environment.
  const logPath = path.join(dataDir, "server-sanitized.log"), lockPath = path.join(dataDir, "pilot.lock");
  let child = null, ownsLock = false, logWrites = Promise.resolve();
  const lifecycle = [];
  const log = chunk => {
    const text = String(chunk).replaceAll(config.sessionSecret, "[redacted]")
      .replaceAll(env.META_APP_SECRET, "[synthetic credential redacted]")
      .replace(/\bBearer\s+[^\s"',]+/gi, "Bearer [redacted]");
    logWrites = logWrites.then(() => appendFile(logPath, text));
  };
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const current = child, closed = new Promise(resolve => current.once("close", resolve));
      if (current.connected) current.send({ type: "social-cues-local-shutdown" });
      else current.kill();
      await Promise.race([closed, delay(5000)]);
      if (current.exitCode === null && current.signalCode === null) {
        current.kill("SIGKILL");
        await Promise.race([closed, delay(5000)]);
      }
      if (current.exitCode === null && current.signalCode === null) throw new Error("Task-owned server did not stop.");
    }
    if (child) lifecycle.push({ event: "stop", pid: child.pid, exitCode: child.exitCode, signal: child.signalCode });
    child = null;
    await logWrites;
    if (ownsLock) { await unlink(lockPath); ownsLock = false; }
  }
  async function start() {
    if (child) throw new Error("This pilot server is already started.");
    await writeFile(lockPath, JSON.stringify({ owner, launcherPid: process.pid }), { flag: "wx" });
    ownsLock = true;
    let launchError = null;
    child = spawn(process.execPath, ["server.mjs"], { cwd: projectRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.on("error", error => { launchError = error; });
    child.stdout.on("data", log);
    child.stderr.on("data", log);
    lifecycle.push({ event: "start", pid: child.pid, url: config.url, dataDir });
    try {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (launchError || child.exitCode !== null) throw new Error("Local server failed to start; inspect server-sanitized.log.");
        try {
          const response = await fetch(config.url + "/health", { signal: AbortSignal.timeout(1500) });
          if (response.ok) return;
        } catch {}
        await delay(200);
      }
      throw new Error("Local server health check timed out.");
    } catch (error) { await stop(); throw error; }
  }
  async function summary() {
    const events = (await readFile(env.SOCIAL_CUES_TESTER_LOOP_PROVIDER_FIXTURE_LOG, "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    })).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    return { url: config.url, dataDir, lifecycle, running: Boolean(child),
      providerFixtureHits: events.filter(item => item.type === "fixture-hit").length,
      blockedProviderAttempts: events.filter(item => item.type !== "fixture-hit").length,
      providerEvents: events, externalProviderRequestsDispatched: 0 };
  }
  return { url: config.url, dataDir, start, stop, restart: async () => { await stop(); await start(); }, summary };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--rehearse") {
    const { runPilotRehearsal } = await import("../local-pilot.browser.test.mjs");
    await runPilotRehearsal();
    return;
  }
  if (args.length && !(args.length === 2 && args[0] === "--resume")) throw new Error("Use no arguments, --rehearse, or --resume <pilot-data-directory>.");
  const pilot = await createLocalPilot({ resumeDir: args[1] || "" });
  await pilot.start();
  console.log(JSON.stringify({ mode: "SYNTHETIC LOCAL PILOT ONLY", url: pilot.url + "/portal?stay=1", dataDir: pilot.dataDir,
    stop: "Type stop or press Ctrl+C in this terminal.", restart: "Type restart to reuse the same JSON data." }));
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let ending = false;
  const finish = async () => {
    if (ending) return;
    ending = true;
    terminal.close();
    await pilot.stop();
    console.log("Task-owned local pilot stopped; synthetic data retained.");
  };
  let commands = Promise.resolve();
  const requestFinish = () => {
    commands = commands.then(finish).catch(error => { console.error(error.message); process.exitCode = 1; });
  };
  process.once("SIGINT", requestFinish);
  process.once("SIGTERM", requestFinish);
  terminal.on("close", () => { if (!ending) requestFinish(); });
  terminal.on("line", line => {
    commands = commands.then(async () => {
      if (ending) return;
      if (line.trim() === "stop") await finish();
      else if (line.trim() === "restart") { await pilot.restart(); console.log("Local pilot restarted with the same data."); }
      else console.log("Commands: restart, stop");
    }).catch(error => { console.error(error.message); process.exitCode = 1; return finish(); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
