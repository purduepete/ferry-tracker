import { expect, test } from '@playwright/test';

for (const preference of ['system', 'light', 'midnight']) {
    test(`${preference} stays consistent through OS changes under self-only script CSP`, async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem('ferry-tracker-theme', value), preference);
        await page.emulateMedia({ colorScheme: 'light' });
        await page.route('**/', async (route) => {
            const response = await route.fetch();
            await route.fulfill({
                response,
                headers: { ...response.headers(), 'content-security-policy': "script-src 'self'" },
            });
        });
        await page.goto('/');
        await page.getByRole('button', { name: 'Appearance', exact: true }).click();
        await expect(
            page.getByRole('radio', {
                name: preference === 'system' ? 'System' : preference === 'light' ? 'Light' : 'Midnight',
            })
        ).toBeChecked();
        for (const os of ['dark', 'light'] as const) {
            await page.emulateMedia({ colorScheme: os });
            const theme = preference === 'system' ? (os === 'dark' ? 'midnight' : 'light') : preference;
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
            await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
                'content',
                theme === 'light' ? '#ffffff' : '#0f172a'
            );
            expect(await page.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
                theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(2, 6, 23)'
            );
            expect(await page.locator('html').evaluate((node) => node.style.colorScheme)).toBe(
                theme === 'light' ? 'light' : 'dark'
            );
            expect(await page.locator('html').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
                true
            );
        }
        for (const width of [320, 390, 768, 1024, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            const menu = await page.locator('.theme-popover').boundingBox();
            expect(menu).not.toBeNull();
            expect(menu!.x).toBeGreaterThanOrEqual(0);
            expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
            expect(await page.locator('html').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
                true
            );
        }
    });
}
