import { expect, test } from '@playwright/test';

test('shows the terminal to ferry to schedule relationship without external network', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.goto('/');
  await page.getByLabel('Terminal').selectOption('7');
  await expect(page.locator('.terminal-node h2')).toHaveText('Seattle');
  await expect(page.locator('.vessel-node h2', { hasText: 'Tacoma' })).toBeVisible();
  await expect(page.locator('.schedule-node h2')).toHaveText('Seattle to Bainbridge Island');
  await expect(page.getByText('176 drive-up of 202 spaces')).toBeVisible();
  await page.getByRole('button', { name: 'Raw JSON' }).click();
  await expect(page.getByText('WSDOT response JSON')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});