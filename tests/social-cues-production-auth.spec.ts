import { expect, test } from '@playwright/test';

test('production signup stays invite-only and requires verification', async ({ page, request }) => {
  test.skip(Boolean(process.env.E2E_USE_LOCAL_SERVER), 'Production verification gate is checked only against hosted auth.');

  const readinessResponse = await request.get('/api/auth/readiness');
  expect(readinessResponse.ok()).toBeTruthy();
  const readiness = await readinessResponse.json();
  expect(readiness.emailVerificationRequired).toBe(true);
  expect(readiness.signupAccess?.mode).toBe('invite-only');

  const stamp = Date.now();
  const email = `verify-gate-${stamp}@socialcuesapp.test`;
  const password = `Verify-gate-${stamp}!`;

  await page.goto('/portal?mode=create&stay=1');
  await expect(page.getByRole('heading', { name: /Manage access before opening the app/i })).toBeVisible();
  await page.locator('#nameInput').fill('Verify Gate');
  await page.locator('#emailInput').fill(email);
  await page.locator('#passwordInput').fill(password);
  await page.locator('#promoInput').fill('SC-LOCAL-BEACON-4M7Q');
  await page.locator('#createBtn').click();

  await expect(page.locator('#authNotice')).toContainText(/not active|invite-only/i, { timeout: 15_000 });
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: /No app access without an active account/i })).toBeVisible();
});
