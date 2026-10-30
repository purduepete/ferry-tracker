import { expect, test } from '@playwright/test';

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    test(`initial spinner and single results entrance with ${reducedMotion} motion`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion });
        let release!: () => void;
        const scheduleGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route('**/api/schedule?**', async (route) => {
            await scheduleGate;
            await route.continue();
        });
        await page.goto('/');
        const navigation = await page.getByRole('tablist').elementHandle();
        const spinner = page.getByRole('status', { name: 'Loading ferry data', exact: true });
        await expect(spinner).toBeVisible();
        expect(
            await spinner.evaluate((element) => {
                const wrapper = getComputedStyle(element);
                const ring = getComputedStyle(element.querySelector('.loading-spinner-ring')!);
                return { wrapperAnimation: wrapper.animationName, ringAnimation: ring.animationName, size: ring.width };
            })
        ).toEqual({
            wrapperAnimation: reducedMotion === 'reduce' ? 'none' : 'data-reveal',
            ringAnimation: reducedMotion === 'reduce' ? 'none' : 'spinner-turn',
            size: '40px',
        });
        const resultsReady = page.evaluate(
            () =>
                new Promise<{
                    opacity: number;
                    duration: string;
                    delay: string;
                    panelAnimation: string;
                    samples: number[];
                }>((resolve) => {
                    const observer = new MutationObserver(() => {
                        const content = document.querySelector<HTMLElement>('.view-content');
                        if (!content) return;
                        observer.disconnect();
                        const style = getComputedStyle(content);
                        const panel = getComputedStyle(content.querySelector('.view-panel')!);
                        const result = {
                            opacity: Number(style.opacity),
                            duration: style.animationDuration,
                            delay: style.animationDelay,
                            panelAnimation: panel.animationName,
                            samples: [] as number[],
                        };
                        const start = performance.now();
                        const sample = () => {
                            result.samples.push(Number(getComputedStyle(content).opacity));
                            if (performance.now() - start < 700) requestAnimationFrame(sample);
                            else resolve(result);
                        };
                        sample();
                    });
                    observer.observe(document.querySelector('.view')!, { childList: true, subtree: true });
                })
        );
        release();
        const result = await resultsReady;
        await expect(spinner).toHaveCount(0);
        expect(result.panelAnimation).toBe('none');
        expect(result.delay).toBe('0s');
        if (reducedMotion === 'reduce') {
            expect(result.opacity).toBe(1);
            expect(result.samples.every((opacity) => opacity === 1)).toBe(true);
        } else {
            expect(result.duration).toBe('0.6s');
            expect(result.samples.some((opacity) => opacity > 0.05 && opacity < 0.85)).toBe(true);
            expect(result.samples.at(-1)).toBe(1);
        }
        for (const name of ['Vessels', 'Terminals', 'Sailings']) {
            await page.getByRole('tab', { name, exact: true }).click();
        }
        expect(await page.getByRole('tablist').evaluate((element, previous) => element === previous, navigation)).toBe(
            true
        );
        await expect(spinner).toHaveCount(0);
        await expect(page.locator('.view-panel')).not.toHaveClass(/is-first-panel/);
        await page.getByRole('tab', { name: 'Sailings', exact: true }).focus();
        await page.keyboard.press('ArrowRight');
        await expect(page.getByRole('tab', { name: 'Catch', exact: true })).toBeFocused();
    });
}

test('loading and results fit Light and Midnight at phone, tablet and desktop widths', async ({ page }) => {
    for (const theme of ['light', 'midnight']) {
        for (const width of [390, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.addInitScript((preference) => localStorage.setItem('ferry-tracker-theme', preference), theme);
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            await page.route('**/api/schedule?**', async (route) => {
                await gate;
                await route.continue();
            });
            await page.goto('/');
            await expect(page.getByRole('status', { name: 'Loading ferry data', exact: true })).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            release();
            await expect(page.locator('.view-content')).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
            await page.unroute('**/api/schedule?**');
        }
    }
});
