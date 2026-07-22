import { expect, test, type Page } from '@playwright/test';

const promoCode = 'SC-LOCAL-BEACON-4M7Q';
const activePlatforms = ['facebook'];

async function sameOriginJson(page: Page, path: string) {
  return page.evaluate(async route => {
    const response = await fetch(route, { credentials: 'same-origin', cache: 'no-store' });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { ok: response.ok, status: response.status, body };
  }, path);
}

async function visibleAccessState(page: Page) {
  const locked = await page.getByRole('heading', { name: /No app access without an active account/i }).isVisible().catch(() => false);
  const login = await page.locator('#loginScreen').isVisible().catch(() => false);
  const localShell = await page.locator('#dashboard').isVisible().catch(() => false);
  expect(locked || login || localShell).toBeTruthy();
}

test('25-step Social Cues tester loop reaches the workstation and checks safe functions', async ({ page }) => {
  test.skip(!process.env.E2E_USE_LOCAL_SERVER, 'Full workstation loop uses the local alpha server; production signup requires email verification before app access.');

  const stamp = Date.now();
  const email = `tester-loop-${stamp}@socialcuesapp.test`;
  const password = `Tester-loop-${stamp}!`;

  await test.step('01 - anonymous app is guarded before login', async () => {
    await page.goto('/app');
    await visibleAccessState(page);
  });

  await test.step('02 - portal loads login shell', async () => {
    await page.goto('/portal?stay=1');
    await expect(page.getByRole('heading', { name: /Manage access before opening the app/i })).toBeVisible();
    await expect(page.locator('#emailInput')).toBeVisible();
    await expect(page.locator('#passwordInput')).toBeVisible();
  });

  await test.step('03 - create-account mode exposes tester fields', async () => {
    await page.locator('#createBtn').click();
    await expect(page.locator('#nameInput')).toBeVisible();
    await expect(page.locator('#promoInput')).toBeVisible();
  });

  await test.step('04 - promo tester account is created', async () => {
    await page.locator('#nameInput').fill('Tester Loop');
    await page.locator('#emailInput').fill(email);
    await page.locator('#passwordInput').fill(password);
    await page.locator('#promoInput').fill(promoCode);
    await page.locator('#createBtn').click();
    let session = await sameOriginJson(page, '/api/auth/session');
    await expect.poll(async () => {
      session = await sameOriginJson(page, '/api/auth/session');
      return session.ok && JSON.stringify(session.body).includes(email);
    }, { timeout: 10_000 }).toBeTruthy();
    expect(session.ok).toBeTruthy();
    expect(JSON.stringify(session.body)).toContain(email);
    await page.waitForURL(/\/app/, { timeout: 10_000 }).catch(() => {});
  });

  await test.step('05 - a new tester enters the private first-run scene', async () => {
    if (!page.url().includes('/app')) {
      await page.goto('/app', { waitUntil: 'domcontentloaded' });
    } else {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
    await expect(page.locator('#onboarding')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/onboarding-scene/);
    await expect(page.locator('#loginScreen')).not.toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#onboarding')).toContainText(/Build the workspace around how you actually work/i);
  });

  await test.step('06 - onboarding creates a focused workspace and returns the app shell', async () => {
    await page.locator('#businessNameInput').fill('Tester Loop Company');
    await page.locator('#websiteInput').fill('https://socialcuesapp.com');
    await page.locator('[data-onboarding-platform][value="facebook"]').check();
    await page.locator('#completeOnboarding').click();
    await expect(page.locator('body')).not.toHaveClass(/onboarding-scene/);
    await expect(page.locator('#nav')).toBeVisible();
    await page.locator('[data-view="dashboard"]').click();
    await expect(page.locator('#metricCampaigns')).toBeVisible();
    await expect(page.locator('#storageNotice')).toContainText(/selected|connected|services/i);
    await expect(page.locator('#persistenceTag')).toBeVisible();
  });

  await test.step('07 - session endpoint recognizes the logged-in user', async () => {
    const session = await sameOriginJson(page, '/api/auth/session');
    expect(session.ok).toBeTruthy();
    expect(JSON.stringify(session.body)).toContain(email);
  });

  await test.step('08 - remembered devices endpoint returns this device lane', async () => {
    const devices = await sameOriginJson(page, '/api/devices');
    expect(devices.ok).toBeTruthy();
    expect(JSON.stringify(devices.body)).toMatch(/device|devices/i);
  });

  await test.step('09 - completed onboarding moves to Settings and Help', async () => {
    await expect(page.locator('#nav [data-onboarding-nav]')).toBeHidden();
    await page.locator('[data-view="help"]').click();
    await expect(page.locator('#helpSelectedProviders')).toContainText(/Facebook/i);
  });

  await test.step('10 - language and locale settings are available', async () => {
    await page.locator('[data-view="settings"]').click();
    await expect(page.locator('#languageInput')).toBeVisible();
    await expect(page.locator('#contentLanguageInput')).toBeVisible();
    await expect(page.locator('#languagePreviewInput')).toBeVisible();
  });

  await test.step('11 - interface/content language preference can be saved', async () => {
    await page.locator('#languageInput').selectOption('es');
    await page.locator('#contentLanguageInput').selectOption('es');
    await page.locator('#saveTheme').click();
    await expect(page.locator('#languagePreviewInput')).toHaveValue(/Spanish/i);
    await expect(page.locator('html')).toHaveAttribute('lang', /es/);
  });

  await test.step('12 - studio generates platform variants', async () => {
    await page.locator('[data-view="studio"]').click();
    await page.locator('[data-studio-mode="campaign"]').click();
    await page.locator('#generateVariants').click();
    await expect(page.locator('#variantList [data-copy]')).toHaveCount(activePlatforms.length);
  });

  await test.step('13 - every selected platform receives a variant card', async () => {
    const platformNames = ['Facebook'];
    for (const platformName of platformNames) {
      await expect(page.locator('#variantList')).toContainText(platformName);
    }
  });

  await test.step('14 - generated copy is not blank for the focused lane', async () => {
    const copies = await page.locator('#variantList [data-copy]').evaluateAll(items => items.map(item => (item as HTMLTextAreaElement).value.trim()));
    expect(copies).toHaveLength(activePlatforms.length);
    expect(copies.every(Boolean)).toBeTruthy();
    expect(copies.join('\n')).toMatch(/campaign|Facebook|social|system|growth/i);
  });

  await test.step('14b - two-step approval preserves the selected publish time', async () => {
    const scheduleInput = page.locator('#variantList [data-variant-schedule]').first();
    await scheduleInput.fill('2030-01-02T09:30');
    await scheduleInput.blur();
    await page.locator('#variantList [data-variant-action="set-status"][data-status="approved"]').first().click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#variantList [data-variant-action="set-status"][data-status="queued"]').first().click();
    await expect(page.locator('#variantList [data-variant-schedule]').first()).toHaveValue('2030-01-02T09:30');
  });

  await test.step('15 - accounts page exposes real provider connection controls', async () => {
    await page.locator('[data-view="accounts"]').click();
    await expect(page.locator('#socialAccountList')).toContainText(/Accounts and posting identities/i);
    const availableAccounts = page.locator('#socialAccountList .account-available');
    if (await availableAccounts.count()) {
      await availableAccounts.first().locator('summary').click();
    }
    await expect(page.locator('#socialAccountList .connector-route').first()).toBeVisible();
    await expect(page.locator('#socialAccountList [data-account-lane="reddit"]')).toContainText(/installed-community|Devvit/i);
    await expect(page.locator('#socialAccountList [data-account-lane="reddit"]')).not.toContainText(/^Connect$/i);
    await expect(page.locator('#socialAccountList [data-account-lane="google_growth"]')).toBeVisible();
    await expect(page.locator('#socialAccountList [data-account-lane="google_business"]')).toBeVisible();
    await expect(page.locator('#socialAccountList [data-account-lane="google_growth"]')).toContainText(/Google/i);
    const customerAccountLanes = ['facebook', 'instagram', 'threads', 'youtube', 'x', 'tiktok', 'google_growth', 'google_business', 'pinterest', 'canva', 'shopify', 'etsy', 'linkedin', 'twitch', 'discord', 'manychat', 'elevenlabs', 'reddit'];
    for (const lane of customerAccountLanes) {
      await expect(page.locator(`#socialAccountList [data-account-lane="${lane}"]`)).toHaveCount(1);
    }
    await expect(page.locator('#socialAccountList')).toContainText(/setup gated|No hidden provider setup/i);
    const connectedAccounts = page.locator('#socialAccountList [data-account-action="toggle"]');
    if (await connectedAccounts.count()) {
      await expect(connectedAccounts.first()).toBeVisible();
    }
  });

  await test.step('16 - alpha tester does not see owner-only admin panels', async () => {
    await expect(page.locator('#nav button[data-view="integrations"]')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Admin cockpit' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Function checks' })).toHaveCount(0);
  });

  await test.step('17 - safe readiness routes still answer for the signed-in tester', async () => {
    const authReadiness = await sameOriginJson(page, '/api/auth/readiness');
    expect(authReadiness.ok).toBeTruthy();
    expect(JSON.stringify(authReadiness.body)).toMatch(/auth|ready|configured|session/i);

    const integrationReadiness = await sameOriginJson(page, '/api/integrations/readiness');
    expect(integrationReadiness.ok).toBeTruthy();
    expect(JSON.stringify(integrationReadiness.body)).toMatch(/openai|tiktok|google_growth|reddit/i);
  });

  await test.step('18 - integration readiness API reports active and missing provider lanes', async () => {
    const readiness = await sameOriginJson(page, '/api/integrations/readiness');
    expect(readiness.ok).toBeTruthy();
    const text = JSON.stringify(readiness.body);
    expect(text).toContain('openai');
    expect(text).toContain('tiktok');
    expect(text).toContain('google_growth');
    expect(text).toContain('reddit');
    expect(text).toContain('linkedin');
    expect(text).toContain('snapchat');
  });

  await test.step('19 - provider OAuth status endpoints are reachable', async () => {
    const routes = [
      '/api/oauth/meta/status',
      '/api/oauth/threads/status',
      '/api/oauth/x/status',
      '/api/oauth/tiktok/status',
      '/api/oauth/youtube/status',
      '/api/oauth/pinterest/status',
      '/api/oauth/canva/status',
      '/api/oauth/shopify/status',
      '/api/oauth/etsy/status',
      '/api/oauth/linkedin/status',
      '/api/oauth/twitch/status',
      '/api/oauth/discord/status'
    ];
    for (const route of routes) {
      const result = await sameOriginJson(page, route);
      expect(result.ok, route).toBeTruthy();
      expect(JSON.stringify(result.body), route).toContain('/api/oauth/');
    }
  });

  await test.step('20 - Threads separates requested permissions from verified grants', async () => {
    const result = await sameOriginJson(page, '/api/oauth/threads/status');
    expect(result.ok).toBeTruthy();
    const body = result.body as { requestedScopes?: string[]; grantedScopes?: string[]; identityVerified?: boolean; tokenHealth?: unknown };
    expect(Array.isArray(body.requestedScopes)).toBeTruthy();
    expect(Array.isArray(body.grantedScopes)).toBeTruthy();
    expect(body.tokenHealth).toBeTruthy();
    if (!body.identityVerified) expect(body.grantedScopes || []).not.toContain('threads_content_publish');
  });

  await test.step('21 - X status exposes verified freshness instead of stale connection optimism', async () => {
    const result = await sameOriginJson(page, '/api/x/account');
    expect(result.ok).toBeTruthy();
    const body = result.body as { ready?: boolean; connectionState?: { connected?: boolean; expired?: boolean; needsReconnect?: boolean } };
    expect(body.connectionState).toBeTruthy();
    expect(body.ready).toBe(Boolean(body.connectionState?.connected));
    if (body.connectionState?.expired || body.connectionState?.needsReconnect) expect(body.ready).toBeFalsy();
  });

  await test.step('22 - billing readiness exposes webhook and self-service lifecycle', async () => {
    const result = await sameOriginJson(page, '/api/billing/readiness');
    expect(result.ok).toBeTruthy();
    const body = result.body as { customerPortalEndpoint?: string; entitlementEvents?: string[] };
    expect(body.customerPortalEndpoint).toBe('/api/billing/portal');
    expect(body.entitlementEvents).toContain('customer.subscription.deleted');
    expect(body.entitlementEvents).toContain('invoice.payment_failed');
  });

  await test.step('23 - Android account cards keep truth and controls in bounds', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#mobileViewSelect').selectOption('accounts');
    await expect(page.locator('.provider-state-chips').first()).toBeVisible();
    await expect(page.locator('.provider-evidence-line')).toHaveCount(0);
    await expect(page.locator('#accountHealthSummary')).toBeVisible();
    await expect(page.locator('#socialAccountList .provider-diagnostics')).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const smallestButton = await page.locator('#socialAccountList .variant-tools button').evaluateAll(buttons => Math.min(...buttons.map(button => button.getBoundingClientRect().height)));
    expect(smallestButton).toBeGreaterThanOrEqual(43.9);
  });

  await test.step('24 - iPhone result banner announces without blocking the app', async () => {
    await page.setViewportSize({ width: 430, height: 932 });
    await page.evaluate(() => (window as unknown as { showAppResult: (title: string, detail: string, tone: string) => void }).showAppResult('Provider check complete', 'Current provider evidence was refreshed.', 'success'));
    await expect(page.locator('#appResult')).toBeVisible();
    await expect(page.locator('#appResult')).toContainText('Provider check complete');
    await expect(page.locator('#appResult')).toHaveAttribute('aria-live', 'polite');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.locator('#dismissAppResult').click();
    await expect(page.locator('#appResult')).toBeHidden();
  });

  await test.step('25 - a hidden specialist tool can be enabled and remains mobile-safe', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#mobileViewSelect').selectOption('settings');
    await page.locator('[data-workspace-feature][value="automation"]').check();
    await page.locator('#saveWorkspaceFeatures').click();
    await page.locator('#mobileViewSelect').selectOption('automation');
    await expect(page.locator('#automationTruthNote')).toContainText('Automatic worker status is unavailable');
    await expect(page.locator('[data-automation-lane="publishing"]')).toBeVisible();
    await expect(page.locator('#capabilityCenterList')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const smallestButton = await page.locator('#automation .variant-tools button').evaluateAll(buttons => Math.min(...buttons.map(button => button.getBoundingClientRect().height)));
    expect(smallestButton).toBeGreaterThanOrEqual(43.9);
  });

  await test.step('26 - logout returns the workstation to a guarded state', async () => {
    await page.locator('#mobileViewSelect').selectOption('settings');
    await page.locator('#logoutButton').click();
    await page.goto('/app');
    await visibleAccessState(page);
  });
});
