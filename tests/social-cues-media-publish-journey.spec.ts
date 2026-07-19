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

async function createIsolatedWorkspace(page: Page, projectName: string) {
  const stamp = Date.now();
  await page.goto('/portal?mode=create&stay=1');
  await page.locator('#nameInput').fill(`Media Journey ${projectName}`);
  await page.locator('#emailInput').fill(`media-${projectName}-${stamp}@socialcuesapp.test`);
  await page.locator('#passwordInput').fill(`Media-journey-${stamp}!`);
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
}

async function seedPostingIdentities(page: Page) {
  const result = await page.evaluate(async () => {
    const currentResponse = await fetch('/api/model', { credentials: 'same-origin', cache: 'no-store' });
    const model = await currentResponse.json();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    model.connectedAccounts = [
      ...(model.connectedAccounts || []).filter((account: any) => !['facebook', 'x'].includes(account.platform)),
      {
        id: 'e2e-facebook-page',
        platform: 'facebook',
        oauthProvider: 'meta',
        name: 'Media Journey Page',
        handle: '@mediajourneypage',
        providerAccountId: '123456789012345',
        status: 'connected',
        credential: 'e2e-facebook-token',
        tokenExpiresAt: future,
        scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
        profileUrl: 'https://www.facebook.com/123456789012345'
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
    ];
    const response = await fetch('/api/model', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model)
    });
    return { ok: response.ok, status: response.status, body: await response.json() };
  });
  expect(result.ok, JSON.stringify(result.body)).toBeTruthy();
  expect(result.body.connectedAccounts?.find((account: any) => account.platform === 'facebook')?.tokenStored).toBe(true);
}

async function openStudio(page: Page, projectName: string) {
  const mobileSelect = page.locator('#mobileViewSelect');
  if (projectName.startsWith('mobile-')) {
    await expect(mobileSelect).toBeVisible();
    await mobileSelect.selectOption('studio');
  } else {
    await page.locator('#nav [data-view="studio"]').click();
  }
  await expect(page.locator('#studio')).toBeVisible();
  await expect(page.locator('[data-studio-lane="post"]')).toBeVisible();
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

  await createIsolatedWorkspace(page, projectName);
  await seedPostingIdentities(page);

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
  await expect(quickCard.locator('textarea')).toContainText('https://socialcuesapp.com');
  await expect(quickCard.locator('textarea')).toContainText('https://x.com/mediajourney');
  await quickCard.locator('[data-quick-batch-action="queue-all"]').click();

  await expect.poll(async () => {
    const result = await sameOriginJson(page, '/api/model');
    const variant = result.body.quickPosts?.[0]?.variants?.[0];
    return variant?.status === 'queued' && variant.media?.storageStatus === 'uploaded' ? variant.id : '';
  }, { timeout: 10_000 }).not.toBe('');
  const queuedModel = await sameOriginJson(page, '/api/model');
  const queuedVariant = queuedModel.body.quickPosts[0].variants[0];
  const queuedVariantId = queuedVariant.id;
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
  expect(queueRow?.status).toBe('dry-run-ready');
  expect(queueRow?.lastAttempt?.ok).toBe(true);
  expect(queueRow?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);

  await page.reload({ waitUntil: 'domcontentloaded' });
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
