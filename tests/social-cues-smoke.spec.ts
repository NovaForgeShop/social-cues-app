import { expect, test } from '@playwright/test';

test('private workstation is gated without an active session', async ({ page }) => {
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: /No app access without an active account/i })).toBeVisible();
  await expect(page.getByText(/workstations are private/i)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Log in' }).first()).toBeVisible();
});

test('TikTok OAuth status is sandbox configured', async ({ request }) => {
  const response = await request.get('/api/oauth/tiktok/status');
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

test('TikTok authorize probe accepts the sandbox client key', async ({ request }) => {
  const response = await request.get('/api/oauth/tiktok/diagnostic?probe=1');
  expect(response.ok()).toBeTruthy();

  const body = await response.text();
  expect(body).toContain('&quot;acceptedClientKey&quot;: true');
  expect(body).toContain('https://socialcuesapp.com/api/oauth/tiktok/callback');
});
