import { expect, test } from "./playwright/harnessPage";

for (const state of ["modified", "deleted", "inserted"] as const) {
    test(`${state} diff boundaries use the host change colors`, async ({
        mountHarness,
        page,
    }, testInfo) => {
        await mountHarness("diff-viewer", { webviewFixture: "clean.json" });
        const blocks = page.locator(`.diff-segment-changed.diff-segment-${state}`);
        await expect(blocks.first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`${state}-boundaries.png`) });
        const samples = await blocks.evaluateAll((elements) =>
            elements.map((element) => {
                const style = getComputedStyle(element);
                return {
                    fill: style.backgroundColor,
                    // Chromium resolves host tokens to RGB; unknown syntax fails below.
                    edges: style.boxShadow.match(/rgba?\([^)]+\)/g) ?? [],
                    height: element.getBoundingClientRect().height,
                };
            }),
        );
        expect(samples.length, `${state} blocks must render`).toBeGreaterThan(0);
        for (const sample of samples) {
            expect(sample.height, `${state} block must occupy visible rows`).toBeGreaterThan(0);
            expect(
                sample.edges,
                `${state} must retain three geometry-neutral inset edges`,
            ).toHaveLength(3);
            expect(sample.edges[1], `${state} upper/lower brackets must agree`).toBe(
                sample.edges[2],
            );
            expect(sample.edges.every((edge) => edge.startsWith("rgb"))).toBe(true);
        }
    });
}
