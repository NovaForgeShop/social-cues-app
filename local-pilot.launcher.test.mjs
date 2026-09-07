import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalPilot, pilotEnvironment, projectRoot } from "./scripts/run-local-pilot.mjs";

test("pilot environment excludes inherited credentials and configuration without mutating the parent", () => {
  const parent = Object.freeze({ Path: "synthetic-path", SystemRoot: "synthetic-system", TEMP: "synthetic-temp",
    STRIPE_SECRET_KEY: "synthetic-stripe", supabase_service_role_key: "synthetic-database",
    OPENAI_API_KEY: "synthetic-ai", META_APP_SECRET: "synthetic-parent-meta", NODE_OPTIONS: "synthetic-options",
    VERCEL: "1", AUTH_PROVIDER: "synthetic-hosted", HTTPS_PROXY: "synthetic-proxy" });
  const config = { port: 12345, url: "http://127.0.0.1:12345", dataDir: path.join(projectRoot, ".tmp", "local-pilot-test"),
    sessionSecret: "synthetic-session" };
  const env = pilotEnvironment(config, parent);
  assert.equal(env.Path, parent.Path);
  assert.equal(env.SystemRoot, parent.SystemRoot);
  assert.equal(env.TEMP, parent.TEMP);
  for (const name of ["STRIPE_SECRET_KEY", "supabase_service_role_key", "VERCEL", "HTTPS_PROXY"]) assert.equal(env[name], undefined);
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.AUTH_PROVIDER, "alpha-local");
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.SUPABASE_ENABLED, "false");
  assert.equal(env.OPENAI_API_KEY, "");
  assert.notEqual(env.META_APP_SECRET, parent.META_APP_SECRET);
  assert.match(env.NODE_OPTIONS, /^--import=file:.*tester-loop-provider-fixture\.mjs$/);
  assert.equal(env.SOCIAL_CUES_TESTER_LOOP_PROVIDER_FIXTURE, "1");
  assert.equal(env.SOCIAL_CUES_DATA_DIR, config.dataDir);
  assert.equal(env.AUTH_SESSION_SECRET, config.sessionSecret);
  assert.notEqual(pilotEnvironment(config, parent), env);
  assert.equal(parent.AUTH_PROVIDER, "synthetic-hosted");
});

test("resume rejects directories outside task-owned pilot storage", async () => {
  for (const resumeDir of [projectRoot, path.dirname(projectRoot), path.join(projectRoot, ".tmp"),
    path.join(projectRoot, ".tmp", "not-a-pilot")]) {
    await assert.rejects(createLocalPilot({ resumeDir }), /task-owned local-pilot directory/);
  }
});

test("real launcher supports lock exclusion, restart, retained data, and resume", { timeout: 60000 }, async () => {
  const pilot = await createLocalPilot();
  let resumed;
  try {
    await pilot.start();
    assert.equal((await fetch(pilot.url + "/health")).status, 200);
    const contender = await createLocalPilot({ resumeDir: pilot.dataDir });
    await assert.rejects(contender.start(), { code: "EEXIST" });
    await contender.stop();
    await access(path.join(pilot.dataDir, "pilot.lock"));
    await pilot.restart();
    const state = await pilot.summary();
    assert.deepEqual(state.lifecycle.map(item => item.event), ["start", "stop", "start"]);
    assert.notEqual(state.lifecycle[0].pid, state.lifecycle[2].pid);
    await pilot.stop();
    await assert.rejects(access(path.join(pilot.dataDir, "pilot.lock")), { code: "ENOENT" });
    await assert.rejects(access(path.join(pilot.dataDir, "model.json")), { code: "ENOENT" });
    resumed = await createLocalPilot({ resumeDir: pilot.dataDir });
    assert.equal(resumed.url, pilot.url);
    await resumed.start();
    assert.equal((await fetch(resumed.url + "/health")).status, 200);
  } finally {
    await pilot.stop();
    if (resumed) await resumed.stop();
  }
  assert.equal((await pilot.summary()).running, false);
  assert.equal((await resumed.summary()).running, false);
});

test("interactive command supports restart then stop, even with an inherited fixture activation flag", { timeout: 45000 }, async () => {
  const osNames = new Set(["systemroot", "windir", "path", "pathext", "comspec", "temp", "tmp", "home", "userprofile", "localappdata", "appdata"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => osNames.has(name.toLowerCase())));
  env.SOCIAL_CUES_TESTER_LOOP_PROVIDER_FIXTURE = "1";
  const child = spawn(process.execPath, ["scripts/run-local-pilot.mjs"], {
    cwd: projectRoot, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "", stderr = "", finished = false, code;
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("close", value => { code = value; finished = true; });
  child.on("error", () => { finished = true; });
  const until = async predicate => {
    const deadline = Date.now() + 15000;
    while (!predicate() && Date.now() < deadline) await delay(50);
    assert.ok(predicate(), "local CLI checkpoint completed");
  };
  try {
    await until(() => stdout.includes('"mode":') || finished);
    assert.equal(finished, false, "CLI must start despite unrelated inherited fixture flags");
    const opening = JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith("{")));
    assert.match(opening.url, /^http:\/\/127\.0\.0\.1:\d+\/portal\?stay=1$/);
    child.stdin.write("restart\n");
    await until(() => stdout.includes("restarted with the same data") || finished);
    assert.equal(finished, false);
    child.stdin.end("stop\n");
    await until(() => finished);
    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /Task-owned local pilot stopped; synthetic data retained/);
    await assert.rejects(access(path.join(opening.dataDir, "pilot.lock")), { code: "ENOENT" });
    const log = await readFile(path.join(opening.dataDir, "server-sanitized.log"), "utf8");
    assert.ok(log.length > 0);
  } finally {
    if (!finished) {
      if (!child.stdin.destroyed) child.stdin.end("stop\n");
      await until(() => finished);
    }
  }
});
