import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

let port = process.env.PORT || '';
let baseURL = process.env.E2E_BASE_URL || '';
let testDataDir = '';
const testFiles = process.argv.slice(2);
const projects = String(process.env.E2E_PROJECTS || 'chromium').split(',').map(value => value.trim()).filter(Boolean);
const localPromoCodes = JSON.stringify([
  { code: 'SC-LOCAL-BEACON-4M7Q', label: 'Local test account 1', days: 120, active: true },
  { code: 'SC-LOCAL-SIGNAL-9X2P', label: 'Local test account 2', days: 120, active: true },
  { code: 'SC-LOCAL-PULSE-6R8N', label: 'Local test account 3', days: 120, active: true },
  { code: 'SC-LOCAL-LAUNCH-3V5K', label: 'Local test account 4', days: 120, active: true }
]);
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

async function findAvailablePort() {
  if (process.env.PORT) return String(process.env.PORT);
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
  testDataDir = process.env.SOCIAL_CUES_DATA_DIR || path.join(process.cwd(), '.tmp', `tester-loop-data-${port}-${Date.now()}`);
  const serverEnv = {
    ...process.env,
    PORT: port,
    AUTH_PROVIDER: process.env.AUTH_PROVIDER || 'alpha-local',
    SUPABASE_ENABLED: process.env.SUPABASE_ENABLED || 'false',
    AUTH_SESSION_SECRET: process.env.AUTH_SESSION_SECRET || 'social-cues-local-test-session-secret',
    SOCIAL_CUES_PROMO_CODES: process.env.SOCIAL_CUES_PROMO_CODES || localPromoCodes,
    SOCIAL_CUES_DATA_DIR: testDataDir,
    E2E_USE_LOCAL_SERVER: '1',
    // Provider payload tests use synthetic configuration and synthetic account tokens.
    // Never load production Meta credentials into an isolated browser regression run.
    META_APP_ID: process.env.E2E_META_APP_ID || '123456789012345',
    META_APP_SECRET: process.env.E2E_META_APP_SECRET || 'social-cues-e2e-meta-secret',
    // Browser regression runs must never inherit a paid production AI key.
    OPENAI_API_KEY: process.env.E2E_OPENAI_API_KEY || ''
  };
  const testEnv = {
    ...serverEnv,
    E2E_BASE_URL: baseURL,
    E2E_USE_LOCAL_SERVER: '1',
    E2E_SKIP_WEB_SERVER: '1'
  };

  const server = spawnProcess(process.execPath, ['server.mjs'], serverEnv);
  server.stdout.on('data', chunk => process.stdout.write(chunk));
  server.stderr.on('data', chunk => process.stderr.write(chunk));

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
    const code = await new Promise(resolve => testRun.on('close', resolve));
    process.exitCode = Number(code || 0);
  } finally {
    server.kill();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
