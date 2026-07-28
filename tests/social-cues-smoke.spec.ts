import { expect, test } from '@playwright/test';

test('private workstation is gated without an active session', async ({ page }) => {
  await page.goto('/app');
  if (process.env.E2E_USE_LOCAL_SERVER) {
    await expect(page.locator('#loginScreen')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Log in to Social Cues/i })).toBeVisible();
  } else {
    await expect(page.getByRole('heading', { name: /No app access without an active account/i })).toBeVisible();
    await expect(page.getByText(/workstations are private/i)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Log in' }).first()).toBeVisible();
  }
});

test('TikTok OAuth status is private in production and sandbox configured locally', async ({ request }) => {
  const response = await request.get('/api/oauth/tiktok/status');
  if (!process.env.E2E_USE_LOCAL_SERVER) {
    expect(response.status()).toBe(401);
    return;
  }
  expect(response.ok()).toBeTruthy();

  const status = await response.json();
  expect(status.configured).toBe(true);
  expect(status.mode).toBe('sandbox');
  expect(status.secureOAuthReady).toBe(true);
  expect(status.redirectUri).toBe('https://socialcuesapp.com/api/oauth/tiktok/callback');
  expect(status.scopes).toEqual(['user.info.basic']);
  expect(status.clientKeyFingerprint).toMatchObject({
    prefix: 'sbaw',
    suffix: 'opku'
  });
  expect(status.domainVerification).toMatchObject({
    domain: 'socialcuesapp.com',
    status: 'verified'
  });
});

test('TikTok authorize diagnostics reject anonymous production traffic', async ({ request }) => {
  const response = await request.get('/api/oauth/tiktok/diagnostic?probe=1');
  if (!process.env.E2E_USE_LOCAL_SERVER) {
    expect(response.status()).toBe(401);
    return;
  }
  expect(response.ok()).toBeTruthy();

  const body = await response.text();
  expect(body).toContain('&quot;acceptedClientKey&quot;: true');
  expect(body).toContain('https://socialcuesapp.com/api/oauth/tiktok/callback');
});
