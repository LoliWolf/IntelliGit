import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChangelistState } from "../../src/webviews/protocol/changeSelection";
import { expect, test } from "./playwright/harnessPage";

test("recovery review is explicitly routed to the captured repository", async ({
    page,
    mountHarness,
}) => {
    const harness = await mountHarness("commit-panel", { webviewFixture: "dirty.json" });
    await page.evaluate(() =>
        window.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    type: "setChangelists",
                    repositoryRoot: "<ROOT>",
                    busy: false,
                    hasRecoveryIssues: true,
                    state: {
                        revision: 1,
                        activeId: "default",
                        lists: [{ id: "default", name: "Default" }],
                        files: {},
                        changes: {},
                    },
                },
            }),
        ),
    );
    const button = page.getByRole("button", { name: "Review partial-index recovery", exact: true });
    await expect(button).toBeVisible();
    await button.click();
    expect(await harness.recordedMessages()).toContainEqual({
        type: "changelistAction",
        repositoryRoot: "<ROOT>",
        revision: 1,
        action: "reviewRecovery",
        listId: "all",
    });
});
test("partial selections preserve their IDs, read-only preview and commit draft after a failure", async ({
    page,
    mountHarness,
}) => {
    const harness = await mountHarness("partial-changes", { webviewFixture: "dirty.json" });
    const lines = page.locator(".partial-line input[type=checkbox]");
    expect(await lines.count()).toBeGreaterThan(0);
    await lines.first().uncheck();
    await page.getByRole("textbox", { name: "Commit message", exact: true }).fill("Selected draft");
    await page.getByRole("button", { name: "Stage selected", exact: true }).click();
    const messages = await harness.recordedMessages();
    const selected = messages.findLast(
        (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "stageSelection",
    );
    expect(selected).toHaveProperty("selection.snapshotId");
    expect(selected).not.toHaveProperty("patch");
    await page.evaluate(() =>
        window.dispatchEvent(
            new MessageEvent("message", {
                data: { type: "partialError", message: "Index changed; review the selection." },
            }),
        ),
    );
    await expect(page.getByRole("alert")).toContainText("Index changed");
    await expect(lines.first()).not.toBeChecked();
    await expect(page.getByRole("textbox", { name: "Commit message", exact: true })).toHaveValue(
        "Selected draft",
    );
    await expect(page.getByLabel("Selection preview", { exact: true })).toHaveAttribute(
        "contenteditable",
        "false",
    );
});

test("a thousand-file commit queue stays bounded and reachable by scroll and keyboard", async ({
    page,
    mountHarness,
}, testInfo) => {
    await mountHarness("commit-panel", { webviewFixture: "dirty.json" });
    const fixture = JSON.parse(
        readFileSync(path.join(__dirname, "fixtures/commit-panel/dirty.json"), "utf8"),
    ) as {
        messages: { message: { type: string; files?: unknown[]; [key: string]: unknown } }[];
    };
    const update = fixture.messages.findLast(({ message }) => message.type === "update")!.message;
    const files = Array.from({ length: 1000 }, (_, i) => ({
        path: `file-${String(i).padStart(4, "0")}.txt`,
        status: "M",
        staged: false,
        additions: 1,
        deletions: 0,
    }));
    const state: ChangelistState = {
        revision: 1,
        activeId: "default",
        lists: [{ id: "default", name: "Default" }],
        files: Object.fromEntries(files.map((file) => [file.path, "default"])),
        changes: {},
    };
    await page.evaluate(
        ({ update, files, state }) => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        ...update,
                        files,
                        stashes: [],
                        shelves: [],
                        changedFileCount: files.length,
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setChangelists", repositoryRoot: "<ROOT>", state, busy: false },
                }),
            );
        },
        { update, files, state },
    );
    const tree = page.getByTestId("virtual-commit-tree");
    await expect(tree).toHaveCount(1);
    expect(await tree.locator("[data-virtual-row-index]").count()).toBeLessThan(100);
    const first = tree.locator("[data-virtual-row-index]").first();
    await first.focus();
    await first.press("End");
    const last = tree.locator('[data-virtual-row-index="999"]');
    await expect(last).toBeVisible();
    await expect(last.getByRole("checkbox")).toBeFocused();
    await last.getByRole("checkbox").press("Home");
    await expect(tree.locator('[data-virtual-row-index="0"]')).toBeVisible();
    expect(await tree.locator("[data-virtual-row-index]").count()).toBeLessThan(100);
    await page.screenshot({ path: testInfo.outputPath("virtual-changelists.png") });
});
