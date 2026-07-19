import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = process.env.PORT || '4188';
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${port}`;
const testDataDir = process.env.SOCIAL_CUES_DATA_DIR || path.join(process.cwd(), '.tmp', `tester-loop-data-${port}-${Date.now()}`);
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

function spawnProcess(command, args, env) {
  return spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
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
  const serverEnv = {
    ...process.env,
    PORT: port,
    AUTH_PROVIDER: process.env.AUTH_PROVIDER || 'alpha-local',
    SUPABASE_ENABLED: process.env.SUPABASE_ENABLED || 'false',
    AUTH_SESSION_SECRET: process.env.AUTH_SESSION_SECRET || 'social-cues-local-test-session-secret',
    SOCIAL_CUES_PROMO_CODES: process.env.SOCIAL_CUES_PROMO_CODES || localPromoCodes,
    SOCIAL_CUES_DATA_DIR: testDataDir,
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
