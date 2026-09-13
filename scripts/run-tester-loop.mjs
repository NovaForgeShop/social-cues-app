import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

let port = '';
let baseURL = '';
let testDataDir = '';
let providerFixtureLog = '';
const testFiles = process.argv.slice(2);
const projects = String(process.env.E2E_PROJECTS || 'chromium').split(',').map(value => value.trim()).filter(Boolean);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const providerFixtureModule = path.join(projectRoot, 'tests', 'support', 'tester-loop-provider-fixture.mjs');
const metaCredentialEnvNames = new Set([
  'META_APP_ID', 'META_CLIENT_ID', 'FACEBOOK_APP_ID', 'FACEBOOK_CLIENT_ID', 'FB_APP_ID',
  'META_APP_SECRET', 'META_CLIENT_SECRET', 'FACEBOOK_APP_SECRET', 'FACEBOOK_CLIENT_SECRET', 'FB_APP_SECRET',
  'E2E_META_APP_ID', 'E2E_META_APP_SECRET'
].map(name => name.toLowerCase()));
const playwrightBin = process.platform === 'win32'
  ? 'node_modules\\.bin\\playwright.cmd'
  : 'node_modules/.bin/playwright';
const browserBlockedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080
]);

function spawnProcess(command, args, env) {
  return spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

function testerLoopBaseEnv() {
  const env = { ...process.env };
  const harnessNames = new Set([
    ...metaCredentialEnvNames,
    'auth_provider',
    'auth_session_secret',
    'e2e_base_url',
    'e2e_openai_api_key',
    'e2e_skip_web_server',
    'e2e_use_local_server',
    'openai_api_key',
    'port',
    'social_cues_data_dir',
    'social_cues_promo_codes',
    'supabase_enabled',
    'meta_api_version',
    'node_env',
    'node_options',
    'vercel',
    'vercel_env',
    'social_cues_tester_loop_provider_fixture',
    'social_cues_tester_loop_provider_fixture_log',
    'social_cues_tester_loop_server_process'
  ]);
  for (const existingName of Object.keys(env)) {
    if (harnessNames.has(existingName.toLowerCase())) delete env[existingName];
  }
  for (const name of metaCredentialEnvNames) env[name.toUpperCase()] = '';
  return env;
}

async function readProviderFixtureEvents() {
  const text = await readFile(providerFixtureLog, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function summarizeProviderFixture(events) {
  const fixtureCases = {
    'instagram-business-link': 0,
    'connected-instagram-link': 0
  };
  for (const event of events) {
    if (event.type === 'fixture-hit' && Object.hasOwn(fixtureCases, event.fixtureCase)) fixtureCases[event.fixtureCase] += 1;
  }
  return {
    fixtureHits: events.filter(event => event.type === 'fixture-hit').length,
    fixtureCases,
    unexpectedProviderAttempts: events.filter(event => event.type === 'fixture-reject').length,
    blockedNonLoopbackAttempts: events.filter(event => event.type === 'guard-reject').length,
    originalExternalCalls: 0,
    credentialsExposed: 0
  };
}

function providerFixtureSummaryIsValid(summary) {
  const runsTesterLoop = !testFiles.length || testFiles.some(file => /social-cues-tester-loop\.spec\.ts$/i.test(file));
  const expectedPerCase = runsTesterLoop ? projects.length : 0;
  const expectedHits = expectedPerCase * Object.keys(summary.fixtureCases).length;
  return summary.fixtureHits === expectedHits
    && summary.fixtureCases['instagram-business-link'] === expectedPerCase
    && summary.fixtureCases['connected-instagram-link'] === expectedPerCase
    && summary.unexpectedProviderAttempts === 0
    && summary.blockedNonLoopbackAttempts === 0
    && summary.originalExternalCalls === 0
    && summary.credentialsExposed === 0;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill();
  await Promise.race([closed, delay(5_000)]);
}

async function findAvailablePort() {
  const preferred = 4188 + (process.pid % 1000);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = preferred + attempt;
    if (browserBlockedPorts.has(candidate)) continue;
    const available = await new Promise(resolve => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(candidate, '127.0.0.1');
    });
    if (available) return String(candidate);
  }
  throw new Error('Could not find an available local test port.');
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/health`, { cache: 'no-store' });
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw lastError || new Error('Social Cues test server did not become healthy.');
}

async function run() {
  port = port || await findAvailablePort();
  baseURL = baseURL || `http://127.0.0.1:${port}`;
  testDataDir = path.join(projectRoot, '.tmp', `tester-loop-data-${port}-${Date.now()}`);
  providerFixtureLog = path.join(testDataDir, 'provider-fixture.jsonl');
  const baseEnv = testerLoopBaseEnv();
  const serverEnv = {
    ...baseEnv,
    PORT: port,
    AUTH_PROVIDER: 'alpha-local',
    SUPABASE_ENABLED: 'false',
    AUTH_SESSION_SECRET: 'social-cues-local-test-session-secret',
    SOCIAL_CUES_DATA_DIR: testDataDir,
    E2E_USE_LOCAL_SERVER: '1',
    NODE_ENV: 'test',
    NODE_OPTIONS: `--import=${pathToFileURL(providerFixtureModule).href}`,
    SOCIAL_CUES_TESTER_LOOP_PROVIDER_FIXTURE: '1',
    SOCIAL_CUES_TESTER_LOOP_PROVIDER_FIXTURE_LOG: providerFixtureLog,
    SOCIAL_CUES_TESTER_LOOP_SERVER_PROCESS: '1',
    // Provider payload tests use synthetic configuration and synthetic account tokens.
    // Never load production Meta credentials into an isolated browser regression run.
    META_APP_ID: '123456789012345',
    META_APP_SECRET: 'social-cues-e2e-meta-secret',
    META_API_VERSION: 'v23.0',
    // Browser regression runs must never inherit a paid production AI key.
    OPENAI_API_KEY: ''
  };
  const testEnv = {
    ...baseEnv,
    PORT: port,
    AUTH_PROVIDER: 'alpha-local',
    SUPABASE_ENABLED: 'false',
    AUTH_SESSION_SECRET: 'social-cues-local-test-session-secret',
    SOCIAL_CUES_DATA_DIR: testDataDir,
    E2E_BASE_URL: baseURL,
    E2E_USE_LOCAL_SERVER: '1',
    E2E_SKIP_WEB_SERVER: '1'
  };

  const server = spawnProcess(process.execPath, ['server.mjs'], serverEnv);
  server.stdout.on('data', chunk => process.stdout.write(chunk));
  server.stderr.on('data', chunk => process.stderr.write(chunk));

  let testCode = 1;
  try {
    await waitForHealth();
    const playwrightCommand = process.platform === 'win32' ? 'cmd.exe' : playwrightBin;
    const playwrightArgs = [
      ...(process.platform === 'win32' ? ['/c', playwrightBin] : []),
      'test',
      ...(testFiles.length ? testFiles : ['tests/social-cues-tester-loop.spec.ts']),
      ...projects.map(project => `--project=${project}`),
      '--reporter=line',
      '--workers=1',
      '--timeout=90000'
    ];
    const testRun = spawnProcess(playwrightCommand, playwrightArgs, testEnv);
    testRun.stdout.on('data', chunk => process.stdout.write(chunk));
    testRun.stderr.on('data', chunk => process.stderr.write(chunk));
    testCode = Number(await new Promise(resolve => testRun.on('close', resolve)) || 0);
  } finally {
    await stopProcess(server);
  }
  const fixtureSummary = summarizeProviderFixture(await readProviderFixtureEvents());
  console.log(JSON.stringify({ type: 'tester-loop-provider-fixture', ...fixtureSummary }));
  if (testCode !== 0 || !providerFixtureSummaryIsValid(fixtureSummary)) process.exitCode = 1;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
