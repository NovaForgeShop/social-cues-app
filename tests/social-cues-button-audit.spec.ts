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
  const primaryResponses = page.locator('#nav > [data-view="responses"]');
  await expect(primaryResponses).toBeVisible();
  await expect(page.locator('#moreNavigation [data-view="responses"]')).toHaveCount(0);
  await primaryResponses.click();
  await expect(page.locator('#responses')).toBeVisible();
  await expect(page.locator('#responseInbox')).toBeVisible();
  await expect(page.locator('#responseReadiness')).toBeVisible();
  await expect(page.locator('#refreshResponses')).toBeVisible();
  await page.locator('#moreNavigation summary').click();
  await expect(page.locator('[data-view="ads"]')).toBeVisible();
  const views = ['dashboard', 'brandkit', 'studio', 'library', 'approvals', 'calendar', 'growth', 'ads', 'responses', 'actionlab', 'devices', 'accounts', 'help', 'billing', 'settings'];
  for (const view of views) {
    await page.locator(`[data-view="${view}"]`).click();
    await expect(page.locator(`#${view}`), view).toBeVisible();
  }
  await expect(page.locator('[data-view="integrations"]')).toBeHidden();

  await page.locator('[data-view="library"]').click();
  await expect(page.locator('#librarySourceList')).toContainText(/YouTube comments/i);
  await expect(page.locator('#librarySourceList')).toContainText(/Threads reactions and replies/i);
  await expect(page.locator('#librarySourceList')).toContainText(/Patreon member intelligence/i);
  await expect(page.locator('#librarySourceList [data-customer-source]')).toHaveCount(59);
  await page.locator('#librarySourceList [data-customer-source="launch-assets"]').click();
  await expect(page.locator('#libraryResult [data-customer-record-use]').first()).toBeVisible();
  await page.locator('#libraryResult [data-customer-record-use]').first().click();
  await expect(page.locator('#studio')).toBeVisible();
  await expect(page.locator('#campaignTitleInput')).not.toHaveValue('');

  await page.locator('[data-view="studio"]').click();
  await page.locator('[data-studio-mode="post"]').click();
  await expect(page.locator('[data-studio-mode="post"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-studio-lane="post"]')).toBeVisible();
  await expect(page.locator('#quickPostMediaInput')).toHaveAttribute('accept', 'image/*,video/*');
  await expect(page.locator('#prepareQuickPostOne')).toBeVisible();
  await expect(page.locator('#prepareQuickPostEverywhere')).toBeVisible();
  await page.locator('[data-studio-mode="video"]').click();
  await expect(page.locator('[data-studio-mode="video"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-studio-lane="video"]')).toBeVisible();
  await expect(page.locator('#rawVideoMessageInput')).toBeVisible();
  await expect(page.locator('#rawVideoAudienceInput')).toBeVisible();
  await expect(page.locator('#rawVideoClipCountInput')).toHaveValue('3');
  await page.locator('#rawVideoMessageInput').fill('Preserve the audience-intelligence message.');
  await page.locator('#rawVideoAudienceInput').fill('Independent creators');
  await page.locator('#rawVideoClipCountInput').selectOption('5');
  await expect(page.locator('[data-studio-lane="campaign"]').first()).toBeHidden();
  await page.locator('[data-studio-mode="campaign"]').click();
  await expect(page.locator('#rulesBox .variant')).toHaveCount(3);
  await page.locator('#generateVariants').click();
  await expect(page.locator('#variantList [data-copy]')).toHaveCount(3);

  await page.locator('[data-view="growth"]').click();
  await expect(page.locator('#growthSourceList')).toContainText(/YouTube/i);
  await expect(page.locator('#growthSourceList')).not.toContainText(/Pinterest|Twitch|LinkedIn|Patreon/i);

  await page.locator('[data-view="accounts"]').click();
  const focusedAccountGrid = page.locator('#socialAccountList > .account-card-grid').first();
  await expect(focusedAccountGrid.locator('[data-account-lane="facebook"]')).toHaveCount(1);
  await expect(focusedAccountGrid.locator('[data-account-lane="instagram"]')).toHaveCount(1);
  await expect(focusedAccountGrid.locator('[data-account-lane="youtube"]')).toHaveCount(1);
  await expect(focusedAccountGrid.locator('[data-account-lane="google_growth"]')).toHaveCount(0);

  await page.locator('[data-view="approvals"]').click();
  const contentApproval = page.locator('#approvalList [data-variant-action="set-status"][data-status="approved"]');
  const approvalCount = await contentApproval.count();
  expect(approvalCount).toBeGreaterThan(0);
  await contentApproval.first().click();
  await expect(page.locator('#approvalProgress')).toContainText(/step 2|Confirm & queue/i);
  await expect(page.locator('#approvalNavBadge')).toBeVisible();
  await expect(page.locator('#publishApproved')).toBeEnabled();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#publishApproved').click();
  await expect(page.locator('#appResult')).toContainText(/confirmation complete|publishing queue/i);
  await page.locator('[data-view="calendar"]').click();
  await expect(page.locator('#calendarList')).toContainText(/queued|published|approved/i);
  await expect(page.locator('#calendarSummary')).toContainText(/upcoming|attention|published/i);

  const emailLinkedQueue = await page.evaluate(async () => {
    const response = await fetch('/api/publish/social-cues/queue', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variant: {
          id: `email-linked-${Date.now()}`,
          platform: 'facebook',
          copy: 'Email-linked approval journey',
          status: 'draft'
        },
        notifyByEmail: false
      })
    });
    return response.json();
  });
  expect(emailLinkedQueue.ok).toBeTruthy();
  const emailLinkedQueueId = emailLinkedQueue.queueItem.id;
  await page.goto('/app');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#approvalAttention')).toBeVisible();
  await expect(page.locator('#approvalAttentionDetail')).toContainText(/content review/i);
  await page.goto(`/app?view=approvals&approval=${encodeURIComponent(emailLinkedQueueId)}&notice=publish-approval`);
  await expect(page.locator('#approvals')).toBeVisible();
  await expect(page.locator('#approvalProgress')).toContainText(/step 1|content approval/i);
  await expect(page.locator('#approvalNavBadge')).toBeVisible();
  const emailLinkedCard = page.locator(`[data-approval-queue="${emailLinkedQueueId}"]`);
  await expect(emailLinkedCard).toBeVisible();
  await expect(emailLinkedCard).toHaveAttribute('data-approval-focus', 'true');
  await emailLinkedCard.locator('[data-queue-confirm="false"]').click();
  await expect(emailLinkedCard.locator('[data-queue-confirm="true"]')).toContainText(/Confirm & queue/i);
  await expect(page.locator('#publishApproved')).toBeEnabled();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#publishApproved').click();
  await expect(page.locator('#appResult')).toContainText(/confirmation complete|publishing queue/i);
  const confirmedQueue = await page.evaluate(async queueId => {
    const response = await fetch('/api/publish/queue', { credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json();
    return body.rows.find((row: { id?: string }) => row.id === queueId);
  }, emailLinkedQueueId);
  expect(confirmedQueue?.status).toBe('queued');
  expect(confirmedQueue?.approvalStage).toBe(2);

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
