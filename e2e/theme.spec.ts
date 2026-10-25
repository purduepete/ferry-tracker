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
            page.getByRole('button', {
                name: preference === 'system' ? 'System' : preference === 'light' ? 'Light' : 'Midnight',
                exact: true,
            })
        ).toHaveAttribute('aria-pressed', 'true');
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
            const menu = await page.getByRole('group', { name: 'Theme', exact: true }).boundingBox();
            expect(menu).not.toBeNull();
            expect(menu!.x).toBeGreaterThanOrEqual(0);
            expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
            expect(await page.locator('html').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
                true
            );
        }
    });
}

test('theme icon opens segmented options with sliding fill and persistence', async ({ page }) => {
    await page.goto('/');
    const group = page.getByRole('group', { name: 'Theme', exact: true });
    await expect(page.locator('.theme-popover, select, datalist')).toHaveCount(0);
    const trigger = page.getByRole('button', { name: 'Appearance', exact: true });
    await trigger.click();
    for (const width of [390, 767, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const refresh = await page.getByRole('button', { name: 'Refresh data', exact: true }).boundingBox();
        const bounds = await trigger.boundingBox();
        expect(bounds!.y).toBe(refresh!.y);
        expect(bounds!.height).toBe(refresh!.height);
        await expect(group).toHaveCSS('border-radius', '0px');
        for (const theme of ['Light', 'Midnight', 'System']) {
            const button = group.getByRole('button', { name: theme, exact: true });
            await button.click();
            await expect(button).toHaveAttribute('aria-pressed', 'true');
            await expect
                .poll(async () => {
                    const fill = await page.locator('.theme-selection').boundingBox();
                    const option = await button.boundingBox();
                    return Math.abs(fill!.x - option!.x);
                })
                .toBeLessThan(1);
        }
    }
    await group.getByRole('button', { name: 'Light', exact: true }).click();
    await page.reload();
    await trigger.click();
    await expect(group.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
        await page
            .locator('.theme-selection')
            .evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration))
    ).toBeLessThan(0.001);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Appearance settings' })).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole('heading', { name: 'Departures and vehicle space', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Appearance settings' })).toHaveCount(0);
});
