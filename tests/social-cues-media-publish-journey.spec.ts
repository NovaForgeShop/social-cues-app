import { expect, test, type Page, type Response, type Route } from '@playwright/test';

// This journey owns the synthetic upload boundary. A previously installed PWA
// worker can satisfy the request before Playwright sees it, especially in WebKit.
test.use({ serviceWorkers: 'block' });

const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR42mNk+M9QzwAEYgH9Fj5l7QAAAABJRU5ErkJggg==',
  'base64'
);
const videoBytes = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');

type JsonResult = { ok: boolean; status: number; body: any };
type TestCredentials = { email: string; password: string };

function postedModelSnapshot(response: Response) {
  if (!response.url().endsWith('/api/model') || response.request().method() !== 'POST') return null;
  try {
    const payload = response.request().postDataJSON();
    return payload?.kind === 'model-save' && payload.request ? payload.request : payload;
  } catch {
    return null;
  }
}

function snapshotHasQuickVariant(response: Response, predicate: (variant: any) => boolean) {
  const snapshot = postedModelSnapshot(response);
  return Boolean((snapshot?.quickPosts || []).some((batch: any) => (batch.variants || []).some(predicate)));
}

async function workspaceSaveFailureSummary(response: Response) {
  const body = await response.json().catch(() => ({}));
  return JSON.stringify({
    status: response.status(),
    code: body?.code || '',
    error: body?.error || '',
    commitStatus: body?.commitStatus || '',
    receiptStatus: body?.receipt?.status || ''
  });
}

async function installHermeticProviderReadiness(page: Page) {
  const fulfillUnavailableReadiness = (route: Route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      configured: false,
      ready: false,
      accounts: [],
      pages: [],
      instagramAccounts: [],
      comments: [],
      conversations: [],
      messages: [],
      items: [],
      posts: [],
      replies: [],
      metrics: []
    })
  });
  await page.route(/\/api\/meta\/health(?:\?.*)?$/, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, configured: true, ready: false, capabilities: [], accounts: [], pages: [], instagramAccounts: [] })
  }));
  await page.route(/\/api\/meta\/(?:instagram\/accounts|comments|messages)(?:\?.*)?$/, fulfillUnavailableReadiness);
  await page.route(/\/api\/x\/account(?:\?.*)?$/, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, configured: false, ready: false, account: null, connectionState: { connected: false, expired: false, needsReconnect: false } })
  }));
  await page.route(/\/api\/x\/engagement(?:\/readiness)?(?:\?.*)?$/, fulfillUnavailableReadiness);
}

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
  const email = `barton.cory.m+media-${projectName}-${stamp}@gmail.com`;
  const password = `Media-journey-${stamp}!`;
  await page.goto('/portal?mode=create&stay=1');
  await page.locator('#nameInput').fill(`Media Journey ${projectName}`);
  await page.locator('#emailInput').fill(email);
  await page.locator('#passwordInput').fill(password);
  await page.locator('#createBtn').click();
  await page.waitForURL(/\/app$/, { timeout: 10_000 });

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
  let result: JsonResult = { ok: false, status: 0, body: null };
  let relogged = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    result = await seed();
    if (result.ok) break;
    if (!relogged && /sign in/i.test(String(result.body?.error || ''))) {
      const login = await sameOriginJson(page, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: credentials.email, password: credentials.password })
      });
      expect(login.ok, JSON.stringify(login.body)).toBeTruthy();
      relogged = true;
      continue;
    }
    if (result.body?.code !== 'workspace_authorization_failed' || result.body?.commitStatus !== 'not_committed' || attempt === 3) break;
    await page.waitForTimeout(100 * (attempt + 1));
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

  await installHermeticProviderReadiness(page);
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
    const input = route.request().postDataJSON() as { fileName?: string; kind?: string; contentType?: string; size?: number; title?: string };
    const assetId = `e2e-media-${Date.now()}`;
    reservation = {
      id: assetId,
      provider: 'supabase-storage',
      kind: input.kind || 'image',
      title: input.title || input.fileName || 'Synthetic media',
      fileName: input.fileName || 'synthetic-media',
      storagePath: `e2e-private-media/${assetId}/${encodeURIComponent(input.fileName || 'synthetic-media')}`,
      status: 'storage-not-configured',
      contentType: input.contentType || 'application/octet-stream',
      expectedSize: Number(input.size || 0),
      createdAt: new Date().toISOString()
    };
    const origin = new URL(route.request().url()).origin;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        asset: reservation,
        upload: {
          provider: 'supabase-storage',
          bucket: 'e2e-private-media',
          storagePath: reservation.storagePath,
          ready: true,
          method: 'PUT',
          token: 'e2e-upload-signature',
          signedUrl: `${origin}/__e2e-media-upload/${assetId}`,
          resumable: {
            endpoint: `${origin}/__e2e-media-tus/${assetId}`,
            bucket: 'e2e-private-media',
            objectName: reservation.storagePath,
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
    const snapshot = payload?.kind === 'model-save' && payload.request ? payload.request : payload;
    for (const batch of snapshot.quickPosts || []) {
      for (const variant of batch.variants || []) {
        if (!variant.media?.assetId) continue;
        variant.media.hostedUrl = `https://media.socialcues.test/${encodeURIComponent(variant.media.assetId)}`;
      }
    }
    const headers = { ...route.request().headers(), 'content-type': 'application/json' };
    delete headers['content-length'];
    const upstream = await route.fetch({
      postData: JSON.stringify(payload),
      headers
    });
    await route.fulfill({ response: upstream });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await ensureAppShell(page, credentials);
  await expect(page.locator('#socialAccountList [data-account-lane="facebook"]')).toContainText('Media Journey Page');
  await expect(page.locator('#socialAccountList [data-account-lane="x"]')).toContainText('Media Journey X');
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
  const preparedSave = page.waitForResponse(response => snapshotHasQuickVariant(
    response,
    variant => variant.platform === 'facebook' && variant.status === 'draft' && variant.media?.assetId
  ));
  await page.locator('#prepareQuickPostEverywhere').click();

  await expect(page.locator('#appResult')).toContainText('Quick post prepared', { timeout: 15_000 });
  const preparedSaveResponse = await preparedSave;
  expect(preparedSaveResponse.ok(), `prepared model save failed ${await workspaceSaveFailureSummary(preparedSaveResponse)}`).toBeTruthy();
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
  const approvedSave = page.waitForResponse(response => snapshotHasQuickVariant(response, variant => variant.id === queuedVariantId && variant.status === 'approved'));
  await quickCard.locator(`[data-quick-action="approve"][data-quick-variant="${queuedVariantId}"]`).click();
  const approvedSaveResponse = await approvedSave;
  expect(approvedSaveResponse.ok(), `approved model save returned ${approvedSaveResponse.status()}`).toBeTruthy();
  await expect(quickCard.locator('[data-quick-batch-action="queue-all"]')).toBeEnabled();
  const queuedSave = page.waitForResponse(response => snapshotHasQuickVariant(response, variant => variant.id === queuedVariantId && variant.status === 'queued'));
  page.once('dialog', dialog => dialog.accept());
  await quickCard.locator('[data-quick-batch-action="queue-all"]').click();
  const queuedSaveResponse = await queuedSave;
  expect(queuedSaveResponse.ok(), `queued model save returned ${queuedSaveResponse.status()}`).toBeTruthy();
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
  expect(handoff.body.attempted).toBe(1);
  expect(handoff.body.results?.every((item: any) => item.variantId === queuedVariantId)).toBe(true);
  const handoffResult = handoff.body.results?.find((item: any) => item.variantId === queuedVariantId);
  expect(handoffResult?.ok, JSON.stringify(handoffResult)).toBe(true);
  expect(handoffResult?.provider).toBe('meta');
  expect(handoffResult?.dryRun).toBe(true);
  expect(handoffResult?.wouldPost?.url || handoffResult?.wouldPost?.file_url).toMatch(/^https:\/\//);

  const queue = await sameOriginJson(page, '/api/publish/queue');
  expect(queue.body.rows?.every((item: any) => item.workspaceId === queuedModel.body.workspace.id)).toBe(true);
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
