import { expect, test } from "./playwright/harnessPage";
import { mountWorkbenchMerge } from "./legacyMerge";
import { detectEolMetadata, parseConflictVersions } from "../../src/mergeEditor/conflictParser";
import fixture from "./fixtures/merge-editor/conflicted.json";
import type { MergeEditorData } from "../../src/webviews/react/merge-editor/types";

const source = fixture.messages[0].message.data as MergeEditorData;
const common = Array.from({ length: 35 }, (_, index) => `// common context ${index}\n`).join("");
const long = "repeated text ".repeat(8);
const versions = {
    base: `${common}const text = "base ${long}";\n${common}`,
    ours: `${common}const text = "ours ${long}";\n${common}`,
    theirs: `${common}const text = "theirs ${long}";\n${common}`,
};
const data: MergeEditorData = {
    ...source,
    filePath: "reading.ts",
    segments: parseConflictVersions(versions.base, versions.ours, versions.theirs),
    ...detectEolMetadata(versions.ours),
    workbench: { ...source.workbench!, ...versions },
};

function ribbonErrors(index: number) {
    const panes = ["ours", "result", "theirs"].slice(index, index + 2);
    const rows = panes.map((pane) =>
        document.querySelector(`.pane-${pane} .cm-line.mrow-conflict`),
    );
    const path = document.querySelectorAll<SVGPathElement>("path.merge-connector")[index];
    if (rows.some((row) => !row) || !path?.getAttribute("d")) return Infinity;
    const [left, right] = rows.map((row) => row!.getBoundingClientRect());
    const matrix = path.getScreenCTM()!;
    const points = [...path.getAttribute("d")!.matchAll(/[ML] ([-\d.]+),([-\d.]+)/g)].map((match) =>
        new DOMPoint(Number(match[1]), Number(match[2])).matrixTransform(matrix),
    );
    return Math.max(
        Math.abs(points[0].y - left.top),
        Math.abs(points[5].y - left.bottom),
        Math.abs(points[2].y - right.top),
        Math.abs(points[3].y - right.bottom),
    );
}

test("reading modes keep wrapped ribbons aligned and expand common regions together", async ({
    mountHarness,
    page,
}, testInfo) => {
    let recordedMessages!: () => Promise<readonly unknown[]>;
    await mountWorkbenchMerge(
        async (context, options) => {
            const harness = await mountHarness(context, options);
            recordedMessages = harness.recordedMessages;
            return harness;
        },
        page,
        data,
    );
    await page.evaluate(() =>
        window.dispatchEvent(
            new MessageEvent("message", {
                data: { type: "mergeDraft", draft: null },
            }),
        ),
    );
    const result = page.locator(".pane-result .cm-content");
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("checkbox", { name: "Soft wrap", exact: true }).check();
    await page.getByRole("checkbox", { name: "Collapse unchanged regions", exact: true }).check();
    await page.getByRole("combobox", { name: "Highlight", exact: true }).selectOption("character");
    for (const [index, pane] of ["ours", "result", "theirs"].entries()) {
        await page.locator(".merge-content").evaluate((element, index) => {
            element.scrollLeft = index * 214;
            element.scrollTop = 0;
        }, index);
        await expect(page.locator(`.pane-${pane} .cm-content`)).toHaveClass(/cm-lineWrapping/);
        await expect
            .poll(() => page.locator(`.pane-${pane} .cm-foldPlaceholder`).count())
            .toBeGreaterThan(0);
        await expect(page.locator(`.pane-${pane} .cm-line.mrow-conflict`)).toHaveCSS(
            "white-space",
            /pre-wrap|break-spaces/,
        );
    }
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Next conflict", exact: true }).click();
    await page.locator(".merge-content").evaluate((element) => {
        element.scrollLeft = 0;
    });
    const row = page.locator(".pane-result .cm-line.mrow-conflict");
    await expect
        .poll(() => row.evaluate((element) => element.getBoundingClientRect().height))
        .toBeGreaterThan(20);
    for (const index of [0, 1]) {
        await page.locator(".merge-content").evaluate((element, index) => {
            element.scrollLeft = index ? element.scrollWidth - element.clientWidth : 0;
        }, index);
        await expect.poll(() => page.evaluate(ribbonErrors, index)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: testInfo.outputPath("reading-modes.png") });
    await page.locator(".pane-result .cm-foldPlaceholder").first().click();
    for (const [index, pane] of ["ours", "result", "theirs"].entries()) {
        await page.locator(".merge-content").evaluate((element, index) => {
            element.scrollLeft = index * 214;
            element.scrollTop = 0;
        }, index);
        await expect(
            page.locator(`.pane-${pane} .cm-line`).filter({ hasText: /^\/\/ common context 3$/ }),
        ).toHaveCount(1);
    }
    await page.getByRole("checkbox", { name: "Collapse unchanged regions", exact: true }).uncheck();
    await expect
        .poll(async () => {
            const messages = await recordedMessages();
            const save = [...messages]
                .reverse()
                .find((message) => (message as { type?: string }).type === "saveMergeDraft");
            return (save as { draft?: { content: string } } | undefined)?.draft?.content;
        })
        .toBe(versions.base);
    await expect(result).toContainText('const text = "base');
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        page.viewportSize()!.width,
    );
});

test("automatic review is reversible and remains outside Apply", async ({ mountHarness, page }) => {
    const inputs = {
        base: "const a = 1, b = 1;\n",
        ours: "const a = 2, b = 1;\n",
        theirs: "const a = 1, b = 2;\n",
    };
    await mountWorkbenchMerge(mountHarness, page, {
        ...source,
        segments: parseConflictVersions(inputs.base, inputs.ours, inputs.theirs),
        workbench: { ...source.workbench!, ...inputs },
    });
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("combobox", { name: "Navigate", exact: true }).selectOption("automatic");
    await page.getByRole("button", { name: "Next conflict", exact: true }).click();
    const reviewed = page.getByRole("checkbox", { name: "Reviewed automatic merge" });
    await reviewed.check();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(reviewed).not.toBeChecked();
    const result = page.locator(".pane-result .cm-content");
    await expect(result).toContainText("a = 2, b = 2");
    await page.getByRole("combobox", { name: "Resolve change" }).selectOption("base");
    await expect(result).toContainText("a = 1, b = 1");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(result).toContainText("a = 2, b = 2");
});

test("stacked wrapped decisions keep each contour on its own result slice after resize", async ({
    mountHarness,
    page,
}) => {
    const inputs = {
        base: `const text = "base ${long}";\n`,
        ours: `const text = "ours ${long}";\n`,
        theirs: `const text = "theirs ${long}";\n`,
    };
    await mountWorkbenchMerge(mountHarness, page, {
        ...source,
        segments: parseConflictVersions(inputs.base, inputs.ours, inputs.theirs),
        workbench: { ...source.workbench!, ...inputs },
    });
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("checkbox", { name: "Soft wrap", exact: true }).check();
    await page.getByRole("combobox", { name: "Resolve change" }).selectOption("both");
    const original = page.viewportSize()!;
    for (const width of [original.width, original.width + 100]) {
        await page.setViewportSize({ width, height: original.height });
        for (const index of [0, 1]) {
            await page.locator(".merge-content").evaluate((element, index) => {
                element.scrollLeft = index ? element.scrollWidth - element.clientWidth : 0;
            }, index);
            await expect
                .poll(() =>
                    page.evaluate((index) => {
                        const side = document.querySelector(
                            `.pane-${index ? "theirs" : "ours"} .cm-line.mrow-conflict`,
                        );
                        const result = document.querySelectorAll(
                            ".pane-result .cm-line.mrow-conflict",
                        )[index];
                        const path =
                            document.querySelectorAll<SVGPathElement>("path.merge-connector")[
                                index
                            ];
                        if (!side || !result || !path?.getAttribute("d")) return Infinity;
                        const a = side.getBoundingClientRect(),
                            b = result.getBoundingClientRect();
                        const box = path.getBBox(),
                            matrix = path.getScreenCTM()!;
                        const top = new DOMPoint(box.x, box.y).matrixTransform(matrix).y;
                        const bottom = new DOMPoint(box.x, box.y + box.height).matrixTransform(
                            matrix,
                        ).y;
                        return Math.max(
                            Math.abs(top - Math.min(a.top, b.top)),
                            Math.abs(bottom - Math.max(a.bottom, b.bottom)),
                        );
                    }, index),
                )
                .toBeLessThanOrEqual(1);
        }
    }
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.locator(".pane-result .cm-content")).toContainText('text = "base');
});
