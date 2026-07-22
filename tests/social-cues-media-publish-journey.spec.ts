import { expect, test, type Page } from '@playwright/test';

// This journey owns the synthetic upload boundary. A previously installed PWA
// worker can satisfy the request before Playwright sees it, especially in WebKit.
test.use({ serviceWorkers: 'block' });

const promoCodes: Record<string, string> = {
  chromium: 'SC-LOCAL-BEACON-4M7Q',
  webkit: 'SC-LOCAL-SIGNAL-9X2P',
  'mobile-chrome': 'SC-LOCAL-PULSE-6R8N',
  'mobile-safari': 'SC-LOCAL-LAUNCH-3V5K'
};

const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR42mNk+M9QzwAEYgH9Fj5l7QAAAABJRU5ErkJggg==',
  'base64'
);
const videoBytes = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');

type JsonResult = { ok: boolean; status: number; body: any };
type TestCredentials = { email: string; password: string };

async function sameOriginJson(page: Page, path: string, init: Record<string, unknown> = {}): Promise<JsonResult> {
  return page.evaluate(async ({ route, requestInit }) => {
    const response = await fetch(route, {
      ...requestInit,
      credentials: 'same-origin',
      cache: 'no-store'
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { ok: response.ok, status: response.status, body };
  }, { route: path, requestInit: init });
}

async function createIsolatedWorkspace(page: Page, projectName: string): Promise<TestCredentials> {
  const stamp = Date.now();
  const email = `media-${projectName}-${stamp}@socialcuesapp.test`;
  const password = `Media-journey-${stamp}!`;
  await page.goto('/portal?mode=create&stay=1');
  await page.locator('#nameInput').fill(`Media Journey ${projectName}`);
  await page.locator('#emailInput').fill(email);
  await page.locator('#passwordInput').fill(password);
  await page.locator('#promoInput').fill(promoCodes[projectName] || promoCodes.chromium);
  await page.locator('#createBtn').click();
  await page.waitForURL(/\/app|\/portal/, { timeout: 10_000 });
  await page.goto('/app');

  await expect(page.locator('#onboarding')).toBeVisible();
  await page.locator('#businessNameInput').fill('Media Journey Brand');
  await page.locator('#websiteInput').fill('https://socialcuesapp.com');
  await page.locator('[data-onboarding-platform][value="facebook"]').check();
  await page.locator('#completeOnboarding').click();
  await expect(page.locator('body')).not.toHaveClass(/onboarding-scene/);
  const desktopReady = await page.locator('#nav').isVisible();
  const mobileReady = await page.locator('#mobileViewSelect').isVisible();
  expect(desktopReady || mobileReady).toBeTruthy();
  return { email, password };
}

async function seedPostingIdentities(page: Page, credentials: TestCredentials) {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const seed = () => sameOriginJson(page, '/api/e2e/provider-accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accounts: [
      {
        id: 'e2e-facebook-page',
        platform: 'facebook',
        oauthProvider: 'meta',
        name: 'Media Journey Page',
        handle: '@mediajourneypage',
        providerAccountId: 'test-facebook-page-1',
        status: 'connected',
        credential: 'e2e-facebook-token',
        tokenExpiresAt: future,
        scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
        profileUrl: 'https://www.facebook.com/mediajourneypage'
      },
      {
        id: 'e2e-x-profile',
        platform: 'x',
        oauthProvider: 'x',
        name: 'Media Journey X',
        handle: '@mediajourney',
        providerAccountId: '987654321012345',
        status: 'connected',
        credential: 'e2e-x-token',
        tokenExpiresAt: future,
        scopes: ['tweet.read', 'tweet.write', 'users.read'],
        profileUrl: 'https://x.com/mediajourney'
      }
      ]
    })
  });
  let result = await seed();
  if (!result.ok && /sign in/i.test(String(result.body?.error || ''))) {
    const login = await sameOriginJson(page, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: credentials.email, password: credentials.password })
    });
    expect(login.ok, JSON.stringify(login.body)).toBeTruthy();
    result = await seed();
  }
  expect(result.ok, JSON.stringify(result.body)).toBeTruthy();
  expect(result.body.accounts?.find((account: any) => account.platform === 'facebook')?.tokenStored).toBe(true);
  expect(result.body.accounts?.find((account: any) => account.platform === 'x')?.tokenStored).toBe(true);
}

async function openStudio(page: Page, projectName: string) {
  const mobileSelect = page.locator('#mobileViewSelect');
  if (projectName.startsWith('mobile-') && await mobileSelect.isVisible()) {
    await mobileSelect.selectOption('studio');
  } else {
    await page.locator('#nav [data-view="studio"]').click();
  }
  await expect(page.locator('#studio')).toBeVisible();
  await expect(page.locator('[data-studio-lane="post"]')).toBeVisible();
}

async function completeOnboardingIfVisible(page: Page) {
  const onboardingVisible = await page.locator('#onboarding').isVisible().catch(() => false);
  const onboardingScene = await page.locator('body').evaluate(body => body.classList.contains('onboarding-scene')).catch(() => false);
  if (!onboardingVisible || !onboardingScene) return;
  const businessName = page.locator('#businessNameInput');
  if (await businessName.isVisible().catch(() => false)) {
    await businessName.fill('Media Journey Brand');
  }
  const website = page.locator('#websiteInput');
  if (await website.isVisible().catch(() => false)) {
    await website.fill('https://socialcuesapp.com');
  }
  const facebook = page.locator('[data-onboarding-platform][value="facebook"]');
  if (await facebook.isVisible().catch(() => false)) {
    await facebook.check();
  }
  await page.locator('#completeOnboarding').click();
  await expect(page.locator('body')).not.toHaveClass(/onboarding-scene/);
}

async function ensureAppShell(page: Page, credentials: TestCredentials) {
  if (!page.url().includes('/app')) {
    await page.goto('/app');
  }
  const shellReady = async () => {
    const navReady = await page.locator('#nav').isVisible().catch(() => false);
    const mobileReady = await page.locator('#mobileViewSelect').isVisible().catch(() => false);
    return navReady || mobileReady;
  };
  const onboardingReady = async () => {
    const onboardingReady = await page.locator('#onboarding').isVisible().catch(() => false);
    const onboardingScene = await page.locator('body').evaluate(body => body.classList.contains('onboarding-scene')).catch(() => false);
    return onboardingReady && onboardingScene;
  };
  await expect.poll(async () => {
    const loginReady = await page.locator('#loginScreen:not(.hidden) #loginEmailInput').isVisible().catch(() => false);
    return await shellReady() || await onboardingReady() || loginReady;
  }, { timeout: 10_000 }).toBe(true);
  if (await shellReady()) return;
  if (await onboardingReady()) {
    await completeOnboardingIfVisible(page);
    await expect.poll(shellReady, { timeout: 10_000 }).toBe(true);
    return;
  }

  const loginEmail = page.locator('#loginScreen:not(.hidden) #loginEmailInput');
  if (await loginEmail.isVisible().catch(() => false)) {
    const login = await sameOriginJson(page, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: credentials.email, password: credentials.password })
    });
    expect(login.ok, JSON.stringify(login.body)).toBeTruthy();
    await page.goto('/app');
  }
  await expect.poll(async () => await shellReady() || await onboardingReady(), { timeout: 10_000 }).toBe(true);
  await completeOnboardingIfVisible(page);
  await expect.poll(shellReady, { timeout: 10_000 }).toBe(true);
}

test('media selection reaches a durable provider handoff on desktop and mobile', async ({ page }, testInfo) => {
  test.skip(!process.env.E2E_USE_LOCAL_SERVER, 'The media journey uses an isolated local account and synthetic external storage boundary.');

  const projectName = testInfo.project.name;
  const useVideo = projectName.includes('safari');
  const media = useVideo
    ? { name: 'journey-video.mp4', mimeType: 'video/mp4', buffer: videoBytes, kind: 'video' }
    : { name: 'journey-image.png', mimeType: 'image/png', buffer: imageBytes, kind: 'image' };
  let reservation: any = null;
  let resumableAttempts = 0;
  let directUploads = 0;
  let completedUploads = 0;

  const credentials = await createIsolatedWorkspace(page, projectName);
  await ensureAppShell(page, credentials);
  await seedPostingIdentities(page, credentials);

  await page.route(/\/__e2e-media-tus\//, async route => {
    resumableAttempts += 1;
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic TUS rejection' }) });
  });
  await page.route(/\/__e2e-media-upload\//, async route => {
    directUploads += 1;
    await route.fulfill({ status: 200, body: '' });
  });
  await page.route(/\/api\/media\/assets$/, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const upstream = await route.fetch();
    const body = await upstream.json();
    reservation = body.asset;
    const origin = new URL(route.request().url()).origin;
    await route.fulfill({
      response: upstream,
      contentType: 'application/json',
      body: JSON.stringify({
        ...body,
        upload: {
          ...body.upload,
          ready: true,
          method: 'PUT',
          token: 'e2e-upload-signature',
          signedUrl: `${origin}/__e2e-media-upload/${body.asset.id}`,
          resumable: {
            endpoint: `${origin}/__e2e-media-tus/${body.asset.id}`,
            bucket: 'e2e-private-media',
            objectName: body.asset.storagePath,
            chunkSize: 1024 * 1024
          }
        }
      })
    });
  });
  await page.route(/\/api\/media\/assets\/complete$/, async route => {
    completedUploads += 1;
    const input = route.request().postDataJSON() as { assetId: string; size: number };
    const asset = { ...reservation, id: input.assetId, status: 'uploaded', size: input.size, verifiedAt: new Date().toISOString() };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, asset }) });
  });
  await page.route(/\/api\/model$/, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const payload = route.request().postDataJSON();
    for (const batch of payload.quickPosts || []) {
      for (const variant of batch.variants || []) {
        if (!variant.media?.assetId) continue;
        variant.media.hostedUrl = `https://media.socialcues.test/${encodeURIComponent(variant.media.assetId)}`;
      }
    }
    const upstream = await route.fetch({
      postData: JSON.stringify(payload),
      headers: { ...route.request().headers(), 'content-type': 'application/json' }
    });
    await route.fulfill({ response: upstream });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await ensureAppShell(page, credentials);
  await seedPostingIdentities(page, credentials);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ensureAppShell(page, credentials);
  const seededModel = await sameOriginJson(page, '/api/model');
  expect(seededModel.body.connectedAccounts?.find((account: any) => account.platform === 'x')?.tokenStored).toBe(true);
  await openStudio(page, projectName);
  await expect(page.locator('#quickPostPlatformInput')).toContainText('@mediajourneypage');
  await page.locator('#quickPostMediaInput').setInputFiles(media);
  await expect(page.locator('#quickPostUploadStatus')).toContainText(`${media.name} selected`);
  await page.locator('#quickPostTitleInput').fill('Audience intelligence, coming soon');
  await page.locator('#quickPostCaptionInput').fill('Know the room before you speak. Create, schedule, conquer with Social Cues.');
  await page.locator('#quickPostDestinationInput').fill('https://socialcuesapp.com');
  await page.locator('#quickPostIncludeLinks').check();
  await page.locator('#prepareQuickPostEverywhere').click();

  await expect(page.locator('#appResult')).toContainText('Quick post prepared', { timeout: 15_000 });
  await expect(page.locator('#quickPostUploadStatus')).toContainText('private, verified, and ready for approval');
  await expect(page.locator('#quickPostList [data-quick-batch]')).toHaveCount(1);
  expect(reservation?.status).toBe('storage-not-configured');
  expect(resumableAttempts).toBe(1);
  expect(directUploads).toBe(1);
  expect(completedUploads).toBe(1);

  const quickCard = page.locator('#quickPostList [data-quick-batch]').first();
  await expect(quickCard).toContainText('@mediajourneypage');
  await expect.poll(async () => quickCard.locator('textarea').evaluateAll(nodes => nodes.some(node => (node as HTMLTextAreaElement).value.includes('https://socialcuesapp.com'))), { timeout: 5_000 }).toBe(true);
  await expect(page.locator('#quickPostPlatformInput')).toContainText('X: Media Journey X');
  const generatedVariantCount = await quickCard.locator('[data-quick-variant]').count();
  if (generatedVariantCount > 1) {
    await expect(quickCard).toContainText('https://x.com/mediajourney');
  }
  const preparedModel = await sameOriginJson(page, '/api/model');
  const preparedVariant = preparedModel.body.quickPosts?.[0]?.variants?.find((variant: any) => variant.platform === 'facebook');
  const queuedVariantId = preparedVariant?.id;
  expect(queuedVariantId).toBeTruthy();
  const approvedSave = page.waitForResponse(response => response.url().endsWith('/api/model') && response.request().method() === 'POST' && response.ok());
  await quickCard.locator(`[data-quick-action="approve"][data-quick-variant="${queuedVariantId}"]`).click();
  await approvedSave;
  await expect(quickCard.locator('[data-quick-batch-action="queue-all"]')).toBeEnabled();
  const queuedSave = page.waitForResponse(response => response.url().endsWith('/api/model') && response.request().method() === 'POST' && response.ok());
  page.once('dialog', dialog => dialog.accept());
  await quickCard.locator('[data-quick-batch-action="queue-all"]').click();
  await queuedSave;
  const queuedModel = await sameOriginJson(page, '/api/model');
  const queuedVariant = (queuedModel.body.quickPosts || [])
    .flatMap((batch: any) => batch.variants || [])
    .find((variant: any) => variant.id === queuedVariantId);
  expect(queuedVariant?.status).toBe('queued');
  expect(queuedVariant.media.type).toBe(media.kind);
  expect(queuedVariant.media.assetId).toBe(reservation.id);
  expect(queuedVariant.postingIdentity).toBe('@mediajourneypage');

  const handoff = await sameOriginJson(page, '/api/publish/due', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ includeFuture: true, live: false, platforms: ['facebook'] })
  });
  expect(handoff.ok, JSON.stringify(handoff.body)).toBeTruthy();
  const handoffResult = handoff.body.results?.find((item: any) => item.variantId === queuedVariantId);
  expect(handoffResult?.ok, JSON.stringify(handoffResult)).toBe(true);
  expect(handoffResult?.provider).toBe('meta');
  expect(handoffResult?.dryRun).toBe(true);
  expect(handoffResult?.wouldPost?.url || handoffResult?.wouldPost?.file_url).toMatch(/^https:\/\//);

  const queue = await sameOriginJson(page, '/api/publish/queue');
  const queueRow = queue.body.rows?.find((item: any) => item.variantId === queuedVariantId);
  if (queueRow) {
    expect(queueRow.status).toBe('dry-run-ready');
    expect(queueRow.lastAttempt?.ok).toBe(true);
    expect(queueRow.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await ensureAppShell(page, credentials);
  const mobileSelect = page.locator('#mobileViewSelect');
  if (projectName.startsWith('mobile-')) {
    await expect(mobileSelect).toBeVisible();
    await mobileSelect.selectOption('calendar');
  } else {
    await page.locator('#nav [data-view="calendar"]').click();
  }
  await expect(page.locator('#calendarList')).toContainText('dry-run ready');
  await expect(page.locator('#calendarList')).toContainText('Audience intelligence, coming soon');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
