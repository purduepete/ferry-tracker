import { expect, test } from '@playwright/test';

test('uses custom icon help throughout the tabs in Light and Midnight without clipping', async ({ page, isMobile }) => {
    await page.goto('/');
    for (const theme of ['Light', 'Midnight']) {
        await page.getByRole('button', { name: 'Appearance', exact: true }).click();
        await page.getByRole('radio', { name: theme, exact: true }).click();
        await page.keyboard.press('Escape');
        for (const width of [390, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            for (const tab of ['Sailings', 'Catch', 'Disruption', 'Historical', 'Terminals', 'Vessels', 'Settings']) {
                await page.getByRole('tab', { name: tab, exact: true }).click();
                await expect(page.locator('[title]')).toHaveCount(0);
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            }
            await page.getByRole('tab', { name: 'Disruption', exact: true }).click();
            const info = page.getByRole('button', { name: 'Pushover notification information' });
            await page.locator('.notification-label').hover();
            await expect(info).toHaveAttribute('aria-expanded', 'false');
            await info.hover();
            const tooltip = page.getByRole('tooltip');
            await expect(tooltip).toBeVisible();
            await tooltip.hover();
            await expect(info).toHaveAttribute('aria-expanded', 'true');
            const bounds = await tooltip.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
            expect(bounds!.y).toBeGreaterThanOrEqual(0);
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
            await expect(tooltip).toHaveCSS('border-radius', '0px');
            await expect(tooltip).toHaveCSS('position', 'fixed');
            await page.keyboard.press('Escape');
            await expect(info).toHaveAttribute('aria-expanded', 'false');
            await info.focus();
            await expect(info).toHaveAttribute('aria-expanded', 'true');
            await page.keyboard.press('Tab');
            await expect(info).toHaveAttribute('aria-expanded', 'false');
            if (isMobile) await info.tap();
            else await info.click();
            await expect(info).toHaveAttribute('aria-expanded', 'true');
            await page.getByRole('heading', { name: 'Bainbridge Island offload' }).click();
            await expect(info).toHaveAttribute('aria-expanded', 'false');
        }
    }
});
