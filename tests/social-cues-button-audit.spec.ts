import { expect, test } from '@playwright/test';

test('local workstation navigation and safe buttons respond', async ({ page }) => {
  test.skip(!process.env.E2E_USE_LOCAL_SERVER, 'Safe broad button audit runs against local alpha only.');

  const stamp = Date.now();
  const email = `button-audit-${stamp}@socialcuesapp.test`;
  const password = `Button-audit-${stamp}!`;

  await page.goto('/portal?mode=create&stay=1');
  await page.locator('#nameInput').fill('Button Audit');
  await page.locator('#emailInput').fill(email);
  await page.locator('#passwordInput').fill(password);
  await page.locator('#promoInput').fill('SC-LOCAL-SIGNAL-9X2P');
  await page.locator('#createBtn').click();
  await page.waitForURL(/\/app|\/portal/, { timeout: 10_000 });
  await page.goto('/app');
  await expect(page.locator('#onboarding')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/onboarding-scene/);
  await expect(page.locator('.side')).toBeHidden();

  await expect(page.locator('#onboardingAccountRequirements [data-onboarding-requirement]')).toHaveCount(0);
  await page.locator('[data-onboarding-platform][value="facebook"]').check();
  await page.locator('[data-onboarding-platform][value="instagram"]').check();
  await page.locator('[data-onboarding-platform][value="youtube"]').check();
  await expect(page.locator('#onboardingAccountRequirements [data-onboarding-requirement]')).toHaveCount(3);
  await expect(page.locator('[data-onboarding-requirement="facebook"]')).toContainText(/managed Facebook Page|personal profile/i);
  await expect(page.locator('[data-onboarding-requirement="instagram"]')).toContainText(/professional account|linked.*Facebook Page/i);
  await expect(page.locator('[data-onboarding-requirement="youtube"]')).toContainText(/exact channel|channel ID/i);
  await page.locator('[data-onboarding-goal][value="awareness"]').check();
  await page.locator('[data-onboarding-requirement="facebook"] [data-onboarding-prepared]').check();
  await Promise.all([
    page.waitForResponse(response => {
      if (!response.url().endsWith('/api/model') || response.request().method() !== 'POST') return false;
      const payload = response.request().postDataJSON();
      return payload?.onboarding?.selectedPlatforms?.includes('facebook')
        && payload?.onboarding?.preparedPlatforms?.includes('facebook');
    }),
    page.locator('#completeOnboarding').click()
  ]);
  await expect(page.locator('body')).not.toHaveClass(/onboarding-scene/);
  await expect(page.locator('#nav [data-onboarding-nav]')).toBeHidden();
  await page.reload();
  await page.locator('[data-view="settings"]').click();
  await page.locator('#reconfigureWorkspace').click();
  await expect(page.locator('[data-onboarding-platform][value="facebook"]')).toBeChecked();
  await expect(page.locator('[data-onboarding-requirement="facebook"] [data-onboarding-prepared]')).toBeChecked();
  await page.locator('#completeOnboarding').click();

  await expect(page.locator('[data-view="automation"]')).toHaveClass(/hidden/);
  await expect(page.locator('[data-view="commerce"]')).toHaveClass(/hidden/);
  await expect(page.locator('[data-view="ads"]')).not.toHaveClass(/hidden/);
  await expect(page.locator('[data-view="responses"]')).not.toHaveClass(/hidden/);
  await page.locator('#moreNavigation summary').click();
  await expect(page.locator('[data-view="ads"]')).toBeVisible();
  await expect(page.locator('[data-view="responses"]')).toBeVisible();
  const views = ['dashboard', 'brandkit', 'studio', 'library', 'approvals', 'calendar', 'growth', 'ads', 'responses', 'actionlab', 'devices', 'accounts', 'help', 'billing', 'settings'];
  for (const view of views) {
    await page.locator(`[data-view="${view}"]`).click();
    await expect(page.locator(`#${view}`), view).toBeVisible();
  }
  await expect(page.locator('[data-view="integrations"]')).toBeHidden();

  await page.locator('[data-view="studio"]').click();
  await page.locator('#generateVariants').click();
  await expect(page.locator('#variantList [data-copy]')).toHaveCount(18);

  await page.locator('[data-view="approvals"]').click();
  await page.locator('#approvalList [data-variant-action="set-status"][data-status="approved"]').first().click();
  await page.locator('#publishApproved').click();
  await page.locator('[data-view="calendar"]').click();
  await expect(page.locator('#calendarList')).toContainText(/queued|published|approved/i);

  for (const route of ['/api/auth/readiness', '/api/integrations/readiness', '/api/oauth/tiktok/status', '/api/oauth/youtube/status']) {
    const response = await page.evaluate(async path => {
      const result = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
      return { ok: result.ok, status: result.status };
    }, route);
    expect(response.status).toBeLessThan(500);
  }

  await page.locator('[data-view="settings"]').click();
  await page.locator('#languageInput').selectOption('en-US');
  await page.locator('#contentLanguageInput').selectOption('interface');
  await page.locator('#saveTheme').click();
  await expect(page.locator('#languagePreviewInput')).toHaveValue(/English|Follow/i);
});
