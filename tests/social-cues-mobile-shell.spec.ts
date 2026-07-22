import { expect, test } from '@playwright/test';
import path from 'node:path';

test('first-run workspace stays usable on Android and iPhone', async ({ page }, testInfo) => {
  test.skip(!process.env.E2E_USE_LOCAL_SERVER, 'Mobile account creation runs against the isolated local alpha only.');

  const stamp = Date.now();
  const promoCode = testInfo.project.name === 'mobile-safari'
    ? 'SC-LOCAL-PULSE-6R8N'
    : 'SC-LOCAL-LAUNCH-3V5K';

  await page.goto('/portal?mode=create&stay=1');
  await page.locator('#nameInput').fill(`Mobile ${testInfo.project.name}`);
  await page.locator('#emailInput').fill(`mobile-${testInfo.project.name}-${stamp}@socialcuesapp.test`);
  await page.locator('#passwordInput').fill(`Mobile-shell-${stamp}!`);
  await page.locator('#promoInput').fill(promoCode);
  const [mobileSignupResponse] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/auth/signup') && response.request().method() === 'POST'),
    page.locator('#createBtn').click()
  ]);
  const mobileSignup = await mobileSignupResponse.json();
  expect(mobileSignupResponse.ok()).toBeTruthy();
  expect(mobileSignup.entitlement?.active).toBeTruthy();
  await page.context().addCookies([{
    name: 'sc_session',
    value: mobileSignup.session.token,
    url: new URL(page.url()).origin,
    httpOnly: true,
    sameSite: 'Lax'
  }]);
  await page.waitForURL(/\/app(?:[?#]|$)/, { timeout: 10_000 });
  await page.waitForLoadState('domcontentloaded');

  await expect(page.locator('#onboarding')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/onboarding-scene/);
  await expect(page.locator('.side')).toBeHidden();
  await page.locator('#businessNameInput').fill('Mobile Test Brand');
  await page.locator('[data-onboarding-platform][value="facebook"]').check();
  await page.locator('[data-onboarding-platform][value="instagram"]').check();
  await page.locator('[data-onboarding-goal][value="awareness"]').check();
  await expect(page.locator('#onboardingAccountRequirements [data-onboarding-requirement]')).toHaveCount(2);
  await page.locator('#completeOnboarding').click();

  await expect(page.locator('body')).not.toHaveClass(/onboarding-scene/);
  await expect(page.locator('#mobileViewSelect')).toBeVisible();
  const mobileQueue = await page.evaluate(async projectName => {
    const response = await fetch('/api/publish/social-cues/queue', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variant: {
          id: `mobile-approval-${projectName}-${Date.now()}`,
          platform: 'facebook',
          copy: `Mobile approval check for ${projectName}`,
          status: 'draft'
        },
        notifyByEmail: false
      })
    });
    return response.json();
  }, testInfo.project.name);
  expect(mobileQueue.ok).toBeTruthy();
  await page.goto(`/app?view=approvals&approval=${encodeURIComponent(mobileQueue.queueItem.id)}&notice=publish-approval`);
  await expect(page.locator('#mobileViewSelect option[value="approvals"]')).toContainText(/Approvals \(\d+\)/);
  await expect(page.locator('#approvals')).toBeVisible();
  const mobileApprovalCard = page.locator(`[data-approval-queue="${mobileQueue.queueItem.id}"]`);
  await expect(mobileApprovalCard).toBeVisible();
  const mobileEntitlement = await page.evaluate(async () => {
    const response = await fetch('/api/auth/entitlement', { credentials: 'same-origin', cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  if (mobileEntitlement.status !== 200 || !mobileEntitlement.body?.entitlement?.active) {
    throw new Error(`mobile entitlement missing before approval: ${JSON.stringify(mobileEntitlement)}`);
  }
  const [mobileFirstApprovalResponse] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/publish/queue/approval') && response.request().method() === 'POST'),
    mobileApprovalCard.locator('[data-queue-confirm="false"]').click()
  ]);
  const mobileFirstApproval = await mobileFirstApprovalResponse.json();
  if (!mobileFirstApprovalResponse.ok()) {
    throw new Error(`mobile approval failed: ${mobileFirstApprovalResponse.status()} ${JSON.stringify(mobileFirstApproval)}`);
  }
  expect(mobileFirstApproval.status).toBe('approved');
  expect(mobileFirstApproval.approvalStage).toBe(1);
  page.once('dialog', dialog => dialog.accept());
  await mobileApprovalCard.locator('[data-queue-confirm="true"]').click();
  await expect(page.locator('#appResult')).toContainText(/confirmed and queued|deliverable/i);

  await page.locator('#mobileViewSelect').selectOption('accounts');
  await expect(page.locator('#accounts')).toBeVisible();
  await expect(page.locator('#socialAccountList [data-account-lane="facebook"]')).toHaveCount(1);
  await expect(page.locator('#socialAccountList [data-account-lane="instagram"]')).toHaveCount(1);
  await expect(page.locator('#socialAccountList > .account-card-grid').first().locator('[data-account-lane="google_growth"]')).toHaveCount(0);

  await expect(page.locator('#mobileViewSelect option[value="responses"]')).toBeEnabled();
  await page.locator('#mobileViewSelect').selectOption('responses');
  await expect(page.locator('#responses')).toBeVisible();
  await expect(page.locator('#responseInbox')).toBeVisible();
  await expect(page.locator('#responseReadiness')).toBeVisible();
  await expect(page.locator('#responses h2').first()).toHaveText('Response inbox');

  await page.locator('#mobileViewSelect').selectOption('studio');
  await expect(page.locator('[data-studio-mode="post"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-studio-lane="post"]')).toBeVisible();
  await expect(page.locator('#quickPostMediaInput')).toBeVisible();
  await expect(page.locator('#prepareQuickPostOne')).toBeVisible();
  await expect(page.locator('#prepareQuickPostEverywhere')).toBeVisible();
  await page.locator('[data-studio-lane="post"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.resolve('outputs', `mobile-quick-post-${testInfo.project.name}.png`), fullPage: true });
  await page.locator('[data-studio-mode="video"]').click();
  await expect(page.locator('[data-studio-mode="video"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-studio-lane="video"]')).toBeVisible();

  await page.locator('#mobileViewSelect').selectOption('help');
  await expect(page.locator('#helpSelectedProviders')).toContainText(/Facebook/i);
  await page.locator('#helpSearchInput').fill('Instagram professional account');
  await page.locator('#searchHelp').click();
  await expect(page.locator('#helpAnswer')).toContainText(/Instagram/i);

  await page.locator('#mobileViewSelect').selectOption('settings');
  await page.locator('[data-workspace-feature][value="automation"]').check();
  await page.locator('#saveWorkspaceFeatures').click();
  await page.locator('#mobileViewSelect').selectOption('automation');
  await expect(page.locator('#automation')).toBeVisible();
  await expect(page.locator('#automation h2').first()).toContainText(/Automation/i);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const smallestButton = await page.locator('#automation button:visible').evaluateAll(buttons => Math.min(...buttons.map(button => button.getBoundingClientRect().height)));
  expect(smallestButton).toBeGreaterThanOrEqual(43.9);
  await page.locator('#automation').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.resolve('outputs', `mobile-workspace-${testInfo.project.name}.png`) });
});
