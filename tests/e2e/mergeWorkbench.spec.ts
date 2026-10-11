import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { expect, test } from "./fixtureWorkspace";
import { runGitRaw as runGit } from "../fixtures/repo/gitRun";
import { waitForE2eChannelReady } from "./controlChannelClient";
import {
    launchFixtureWorkspace,
    dismissFirstRunDialogs,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** Opens the real command and row rather than injecting merge payloads. */
async function openMerge(
    page: Page,
    reuseVisibleSession = false,
    fileCount = 1,
    filePath?: string,
): Promise<FrameLocator> {
    const view = new IntelliGitView(page);
    if (!reuseVisibleSession) await new Workbench(page).runCommand("Open Conflict Session");
    else
        await page
            .getByRole("tab")
            .filter({ hasText: /^Conflicts$/ })
            .click();
    const session = await view.revealConflictSession();
    await expect(session.locator(".session-root")).toBeVisible();
    await expect(session.locator("tbody tr.row")).toHaveCount(fileCount);
    // Rows open on one click; a double click can land its second click on the revealed tab.
    const rows = session.locator("tbody tr.row");
    await (filePath ? rows.filter({ hasText: filePath }) : rows).click();
    const frame = await view.revealMergeWorkbench(undefined, filePath);
    await expect(frame.locator(".merge-editor.workbench")).toBeVisible();
    return frame;
}

/** Resolves remaining conflicts through main's rail and per-hunk side decisions. */
async function acceptOurs(frame: FrameLocator): Promise<void> {
    const changes = frame.locator(".overview-marker.unresolved");
    const count = await changes.count();
    for (let i = 0; i < count; i++) {
        await changes.first().click();
        await frame.locator(".pane-ours .merge-action-gutter .mrow-active .accept-btn").click();
        await expect(changes).toHaveCount(count - i - 1);
    }
    // Also select ours for empty-side hunks and decisions restored from a draft.
    await frame.getByRole("button", { name: "Accept All Yours", exact: true }).click();
    await expect(frame.locator("#merge-remaining-status")).toHaveText("All conflicts resolved");
}

test.describe("Full-document Git merge workbench", () => {
    test.use({ scenario: "conflicted" });
    test("reviews automatic changes, preserves reading state and stages two files in sequence", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await runGit(workspace.root, ["merge", "--abort"], workspace.env);
        const common = Array.from({ length: 30 }, (_, index) => `// context ${index}\n`).join("");
        const base = `${common}const a = 1, b = 1;\n${common}const choice = "base";\n${common}`;
        const files = ["flow-first.ts", "flow-second.ts"];
        for (const file of files) await writeFile(path.join(workspace.root, file), base);
        await runGit(workspace.root, ["add", "--", ...files], workspace.env);
        await runGit(workspace.root, ["commit", "-m", "Flow base"], workspace.env);
        const branch = (
            await runGit(workspace.root, ["branch", "--show-current"], workspace.env)
        ).trim();
        await runGit(workspace.root, ["checkout", "-b", "flow-incoming"], workspace.env);
        for (const file of files)
            await writeFile(
                path.join(workspace.root, file),
                base.replace("b = 1", "b = 2").replace('"base"', '"theirs"'),
            );
        await runGit(workspace.root, ["commit", "-am", "Flow incoming"], workspace.env);
        await runGit(workspace.root, ["checkout", branch], workspace.env);
        for (const file of files)
            await writeFile(
                path.join(workspace.root, file),
                base.replace("a = 1", "a = 2").replace('"base"', '"ours"'),
            );
        await runGit(workspace.root, ["commit", "-am", "Flow ours"], workspace.env);
        await runGit(workspace.root, ["merge", "flow-incoming"], workspace.env).catch(
            () => undefined,
        );
        const head = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
        const operation = await runGit(workspace.root, ["rev-parse", "MERGE_HEAD"], workspace.env);
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            let frame = await openMerge(page, false, 2, files[0]);
            await frame.getByRole("button", { name: "View options" }).click();
            await frame.getByRole("checkbox", { name: "Soft wrap", exact: true }).check();
            await frame
                .getByRole("checkbox", { name: "Collapse unchanged regions", exact: true })
                .check();
            await frame
                .getByRole("combobox", { name: "Highlight", exact: true })
                .selectOption("character");
            await frame
                .getByRole("combobox", { name: "Navigate", exact: true })
                .selectOption("automatic");
            await frame.getByRole("button", { name: "Next conflict", exact: true }).click();
            await frame.getByRole("checkbox", { name: "Reviewed automatic merge" }).check();
            await frame.getByRole("button", { name: "Undo", exact: true }).click();
            await expect(
                frame.getByRole("checkbox", { name: "Reviewed automatic merge" }),
            ).not.toBeChecked();
            await frame.getByRole("combobox", { name: "Resolve change" }).selectOption("base");
            await expect(frame.locator(".pane-result .cm-content")).toContainText("a = 1, b = 1");
            await frame.getByRole("button", { name: "Undo", exact: true }).click();
            await expect(frame.locator(".pane-result .cm-content")).toContainText("a = 2, b = 2");
            await frame
                .getByRole("combobox", { name: "Navigate", exact: true })
                .selectOption("unresolved");
            await frame.getByRole("checkbox", { name: "Next conflict after a decision" }).check();
            await frame.getByRole("button", { name: "Next conflict", exact: true }).click();
            await frame.locator(".pane-result .cm-line.mrow-active").click();
            await frame.locator(".pane-result .cm-content").press("Control+Alt+1");
            await expect(
                page.getByRole("tab").filter({ hasText: `Merge: ${files[0]}` }),
            ).toHaveAttribute("aria-selected", "true");
            await expect(frame.locator(".merge-editor.workbench")).toBeVisible();
            await expect(frame.locator("#merge-remaining-status")).toHaveText(
                "All conflicts resolved",
            );
            const chosen = await frame.locator(".pane-result .cm-content").innerText();
            await frame.getByRole("button", { name: "Conflicts", exact: true }).click();
            await frame
                .locator(".workbench-file-queue button")
                .filter({ hasText: files[1] })
                .click();
            const other = await new IntelliGitView(page).revealMergeWorkbench(undefined, files[1]);
            await expect(other.locator(".pane-meta-center")).toContainText(files[1]);
            await page
                .getByRole("tab")
                .filter({ hasText: `Merge: ${files[0]}` })
                .click();
            frame = await new IntelliGitView(page).revealMergeWorkbench(undefined, files[0]);
            await frame.getByRole("button", { name: "Base", exact: true }).click();
            const before = await runGit(workspace.root, ["ls-files", "-u"], workspace.env);
            await frame.getByRole("combobox", { name: "Compare with base" }).selectOption("result");
            const diff = await new IntelliGitView(page).revealDiffViewer();
            await expect(diff.locator('[data-testid="diff-viewer-root"]')).toBeVisible();
            await expect(diff.getByLabel("This side is read only", { exact: true })).toHaveCount(2);
            const readOnlyResult = diff.locator('[data-testid="diff-pane-right"]');
            const comparison = await readOnlyResult.innerText();
            await readOnlyResult.click();
            await readOnlyResult.pressSequentially("must not edit");
            await expect.poll(() => readOnlyResult.innerText()).toBe(comparison);
            await expect(diff.locator("body")).toContainText("Result");
            expect(await runGit(workspace.root, ["ls-files", "-u"], workspace.env)).toBe(before);
            await page
                .getByRole("tab")
                .filter({ hasText: `Merge: ${files[0]}` })
                .click();
            frame = await new IntelliGitView(page).revealMergeWorkbench();
            await frame.getByRole("button", { name: "Cancel", exact: true }).click();
            frame = await openMerge(page, true, 2, files[0]);
            await expect
                .poll(() => frame.locator(".pane-result .cm-content").innerText())
                .toBe(chosen);
            await frame.getByRole("button", { name: "View options" }).click();
            await expect(
                frame.getByRole("checkbox", { name: "Soft wrap", exact: true }),
            ).toBeChecked();
            await expect(
                frame.getByRole("combobox", { name: "Navigate", exact: true }),
            ).toHaveValue("unresolved");
            await expect(frame.locator(".pane-result .cm-foldPlaceholder")).toHaveCount(3);
            await page.screenshot({ path: testInfo.outputPath("flow-reading-restored.png") });
            await frame.getByRole("button", { name: "Apply and next file", exact: true }).click();
            await expect(
                page.getByRole("tab").filter({ hasText: `Merge: ${files[1]}` }),
            ).toBeVisible();
            frame = await new IntelliGitView(page).revealMergeWorkbench();
            await expect(frame.locator(".pane-meta-row")).toContainText(files[1]);
            const stages = await runGit(workspace.root, ["ls-files", "-u"], workspace.env);
            expect(stages).toContain(files[1]);
            expect(stages).not.toContain(files[0]);
            await frame.getByRole("button", { name: "Conflicts", exact: true }).click();
            await frame
                .locator(".workbench-file-queue button")
                .filter({ hasText: files[0] })
                .click();
            const review = await new IntelliGitView(page).revealDiffViewer();
            await expect(review.locator("body")).toContainText("Merged and staged");
            await expect(review.getByLabel("This side is read only", { exact: true })).toHaveCount(
                2,
            );
            await page
                .getByRole("tab")
                .filter({ hasText: `Merge: ${files[1]}` })
                .click();
            frame = await new IntelliGitView(page).revealMergeWorkbench();
            await acceptOurs(frame);
            await frame.getByRole("button", { name: "Apply and next file", exact: true }).click();
            await expect
                .poll(() => runGit(workspace.root, ["ls-files", "-u"], workspace.env))
                .toBe("");
            expect(await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env)).toBe(head);
            expect(await runGit(workspace.root, ["rev-parse", "MERGE_HEAD"], workspace.env)).toBe(
                operation,
            );
            for (const file of files)
                expect(await runGit(workspace.root, ["show", `:${file}`], workspace.env)).toBe(
                    await readFile(path.join(workspace.root, file), "utf8"),
                );
        } finally {
            await app.close();
        }
    });
    test("stages a cherry-pick resolution without automatically continuing it", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        await runGit(workspace.root, ["merge", "--abort"], workspace.env);
        await runGit(workspace.root, ["cherry-pick", "conflict/with-main"], workspace.env).catch(
            () => undefined,
        );
        expect(await runGit(workspace.root, ["ls-files", "-u"], workspace.env)).not.toBe("");
        const head = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const frame = await openMerge(page);
            await acceptOurs(frame);
            await frame.getByRole("button", { name: "Apply", exact: true }).click();
            await expect
                .poll(() => runGit(workspace.root, ["ls-files", "-u"], workspace.env))
                .toBe("");
            expect(await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env)).toBe(head);
            expect(
                await runGit(workspace.root, ["rev-parse", "CHERRY_PICK_HEAD"], workspace.env),
            ).not.toBe("");
        } finally {
            await app.close();
        }
    });
    test("keeps typing, decisions, history and durable drafts through theme changes and reopen", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const settingsPath = path.join(workspace.root, ".vscode/settings.json");
        await mkdir(path.dirname(settingsPath), { recursive: true });
        await writeFile(
            settingsPath,
            JSON.stringify({ "workbench.colorTheme": "Default Dark Modern" }),
        );
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            let frame = await openMerge(page);
            const result = () => frame.locator('[data-testid="merge-editor-1"] .cm-content');
            await expect(result()).toHaveAttribute("contenteditable", "true");
            await expect(
                frame.locator('[data-testid="merge-editor-0"] .cm-content'),
            ).toHaveAttribute("contenteditable", "false");
            const original = await result().innerText();
            await frame.locator(".pane-ours .accept-btn").first().click();
            const chosen = await result().innerText();
            expect(chosen).not.toBe(original);
            await frame.getByRole("button", { name: "Undo", exact: true }).click();
            await expect.poll(() => result().innerText()).toBe(original);
            await frame.getByRole("button", { name: "Redo", exact: true }).click();
            await expect.poll(() => result().innerText()).toBe(chosen);
            await result().click();
            await result().press("Control+End");
            await result().press("End");
            await result().press("Enter");
            await result().pressSequentially("manual draft");
            await expect(result()).toContainText("manual draft");
            await expect(frame.locator(".merge-footer .footer-draft-status")).toContainText(
                "Draft saved",
            );
            const draft = await result().innerText();
            await frame.getByRole("button", { name: "Base", exact: true }).click();
            await expect(frame.locator(".pane-base .cm-content")).toBeVisible();
            await page.screenshot({ path: testInfo.outputPath("merge-dark.png") });
            await writeFile(
                settingsPath,
                JSON.stringify({ "workbench.colorTheme": "Default Light Modern" }),
            );
            await expect(frame.locator("body")).toHaveAttribute(
                "data-vscode-theme-kind",
                "vscode-light",
            );
            await expect.poll(() => result().innerText()).toBe(draft);
            await expect(frame.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
            await page.screenshot({ path: testInfo.outputPath("merge-light.png") });
            // Close immediately after typing; the 250 ms draft timer must not lose this edit.
            await result().click();
            await result().press("Control+End");
            await result().press("End");
            await result().press("Enter");
            await result().pressSequentially("last-second draft");
            const finalDraft = await result().innerText();
            await frame.getByRole("button", { name: "Cancel", exact: true }).click();
            await expect(
                page.getByRole("tab").filter({ hasText: "Merge: conflict.txt" }),
            ).toHaveCount(0);
            // Cancel reveals the existing chooser; no redundant async command may reveal it later.
            frame = await openMerge(page, true);
            await expect.poll(() => result().innerText()).toBe(finalDraft);
            await acceptOurs(frame);
            await frame.getByRole("button", { name: "Apply", exact: true }).click();
            await expect
                .poll(() => runGit(workspace.root, ["ls-files", "-u"], workspace.env))
                .toBe("");
            expect(await runGit(workspace.root, ["show", ":conflict.txt"], workspace.env)).toBe(
                await readFile(path.join(workspace.root, "conflict.txt"), "utf8"),
            );
        } finally {
            await app.close();
        }
    });

    test("refuses an externally changed file while retaining the editable draft", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const frame = await openMerge(page);
            await acceptOurs(frame);
            const result = frame.locator('[data-testid="merge-editor-1"] .cm-content');
            const draft = await result.innerText();
            await writeFile(path.join(workspace.root, "conflict.txt"), "external change\n");
            await frame.getByRole("button", { name: "Apply", exact: true }).click();
            await expect(frame.locator(".merge-notice-error")).toContainText("changed");
            await expect.poll(() => result.innerText()).toBe(draft);
            await expect(result).toHaveAttribute("contenteditable", "true");
            expect(await readFile(path.join(workspace.root, "conflict.txt"), "utf8")).toBe(
                "external change\n",
            );
            expect(await runGit(workspace.root, ["ls-files", "-u"], workspace.env)).not.toBe("");
        } finally {
            await app.close();
        }
    });

    test("retains the saved result, draft and Git error when staging is locked", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const stages = await runGit(workspace.root, ["ls-files", "-u"], workspace.env);
        const mergeErrors: string[] = [];
        const ours = await runGit(workspace.root, ["show", ":2:conflict.txt"], workspace.env);
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const frame = await openMerge(page);
            await acceptOurs(frame);
            await expect(frame.locator(".merge-footer .footer-draft-status")).toContainText(
                "Draft saved",
            );
            page.on("console", (message) => {
                if (message.text().includes("[IntelliGit] Merge editor operation failed:")) {
                    mergeErrors.push(message.text());
                }
            });
            const lockPath = path.join(workspace.root, ".git/index.lock");
            await writeFile(lockPath, "owned by test", { flag: "wx" });
            await frame.getByRole("button", { name: "Apply", exact: true }).click();
            await expect(frame.locator(".merge-notice-error")).toContainText("staging failed");
            await expect(frame.locator(".merge-footer .footer-draft-status")).toContainText(
                "Draft saved",
            );
            await expect(
                frame.locator('[data-testid="merge-editor-1"] .cm-content'),
            ).toHaveAttribute("contenteditable", "true");
            expect(await readFile(path.join(workspace.root, "conflict.txt"), "utf8")).toBe(ours);
            expect(await runGit(workspace.root, ["ls-files", "-u"], workspace.env)).toBe(stages);
            expect(await readFile(lockPath, "utf8")).toBe("owned by test");
            await expect.poll(() => mergeErrors.join("\n")).toContain("index.lock");
            await testInfo.attach("merge-operation-errors.log", {
                body: mergeErrors.join("\n"),
                contentType: "text/plain",
            });
            await page.screenshot({ path: testInfo.outputPath("merge-stage-failure.png") });
        } finally {
            await app.close();
        }
    });

    test("refuses Apply over unsaved native editor changes", async ({ fixtureWorkspace }) => {
        const { workspace } = fixtureWorkspace;
        const settingsPath = path.join(workspace.root, ".vscode/settings.json");
        await mkdir(path.dirname(settingsPath), { recursive: true });
        await writeFile(settingsPath, JSON.stringify({ "git.mergeEditor": false }));
        const before = await readFile(path.join(workspace.root, "conflict.txt"), "utf8");
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            let frame = await openMerge(page);
            await acceptOurs(frame);
            const modifier = process.platform === "darwin" ? "Meta" : "Control";
            await page.keyboard.press(`${modifier}+P`);
            const input = page.locator(".quick-input-widget .quick-input-box input").first();
            await expect(input).toBeVisible();
            await input.fill(path.join(workspace.root, "conflict.txt"));
            await page.getByRole("option").filter({ hasText: "conflict.txt" }).first().click();
            await expect(input).toBeHidden();
            const editor = page.locator(".editor-group-container .monaco-editor:visible").first();
            await editor.click();
            await page.keyboard.press(`${modifier}+A`);
            await page.keyboard.type("unsaved native edit");
            await expect(editor.locator(".view-lines")).toContainText("unsaved native edit");
            await page.getByRole("tab").filter({ hasText: "Merge: conflict.txt" }).click();
            frame = await new IntelliGitView(page).revealMergeWorkbench();
            await frame.getByRole("button", { name: "Apply", exact: true }).click();
            await expect(frame.locator(".merge-notice-error")).toContainText(
                "unsaved editor changes",
            );
            expect(await readFile(path.join(workspace.root, "conflict.txt"), "utf8")).toBe(before);
            expect(await runGit(workspace.root, ["ls-files", "-u"], workspace.env)).not.toBe("");
            await expect(
                frame.locator('[data-testid="merge-editor-1"] .cm-content'),
            ).toHaveAttribute("contenteditable", "true");
        } finally {
            await app.close();
        }
    });

    test("preserves multiple unequal changes, scroll and syntax through high-contrast switches", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await runGit(workspace.root, ["merge", "--abort"], workspace.env);
        const file = "merge-theme.ts";
        const filePath = path.join(workspace.root, file);
        const base =
            Array.from({ length: 100 }, (_, index) => `const item${index} = "base"; // theme`).join(
                "\n",
            ) + "\n";
        await writeFile(filePath, base);
        await runGit(workspace.root, ["add", "--", file], workspace.env);
        await runGit(workspace.root, ["commit", "-m", "Merge theme base"], workspace.env);
        const branch = (
            await runGit(workspace.root, ["branch", "--show-current"], workspace.env)
        ).trim();
        await runGit(workspace.root, ["checkout", "-b", "merge-theme-incoming"], workspace.env);
        const change = (text: string, side: string) =>
            [5, 45, 85].reduce(
                (value, index) =>
                    value.replace(`item${index} = "base"`, `item${index} = "${side}"`),
                text,
            );
        await writeFile(filePath, change(base, "theirs"));
        await runGit(workspace.root, ["commit", "-am", "Incoming changes"], workspace.env);
        await runGit(workspace.root, ["checkout", branch], workspace.env);
        await writeFile(
            filePath,
            change(base, "ours").replace(
                "// theme\nconst item6",
                '// theme\nconst extra = "ours";\nconst item6',
            ),
        );
        await runGit(workspace.root, ["commit", "-am", "Local changes"], workspace.env);
        await runGit(workspace.root, ["merge", "merge-theme-incoming"], workspace.env).catch(
            () => undefined,
        );
        expect(await runGit(workspace.root, ["ls-files", "-u"], workspace.env)).toContain(file);
        const settingsPath = path.join(workspace.root, ".vscode/settings.json");
        await mkdir(path.dirname(settingsPath), { recursive: true });
        const settings = {
            "editor.tokenColorCustomizations": {
                textMateRules: [
                    { scope: "comment", settings: { foreground: "#33bb77", fontStyle: "italic" } },
                ],
            },
            "workbench.colorCustomizations": { "diffEditor.removedTextBorder": "#eeaa11" },
        };
        await writeFile(
            settingsPath,
            JSON.stringify({ ...settings, "workbench.colorTheme": "Default Dark Modern" }),
        );
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const frame = await openMerge(page);
            await expect(frame.locator(".overview-marker")).toHaveCount(3);
            await frame.locator(".overview-marker").first().click();
            const result = frame.locator('[data-testid="merge-editor-1"] .cm-content');
            await frame
                .getByRole("combobox", { name: "Resolve change" })
                .selectOption("both-reversed");
            await expect(result).toContainText('item5 = "theirs"');
            await expect(result).toContainText('item5 = "ours"');
            // One shared scroller moves every pane; the result text must move on screen with it.
            const scroller = frame.locator(".merge-content");
            const resultTop = () =>
                result.evaluate((element) => element.getBoundingClientRect().top);
            const startTop = await resultTop();
            await scroller.evaluate((element) => {
                element.scrollTop = 600;
            });
            await expect
                .poll(async () => {
                    const moved = startTop - (await resultTop());
                    const scrolled = await scroller.evaluate((element) => element.scrollTop);
                    return {
                        moved,
                        scrolled,
                        follows: scrolled > 300 && Math.abs(moved - scrolled) <= 1,
                    };
                })
                .toMatchObject({ follows: true });
            const scroll = await scroller.evaluate((element) => element.scrollTop);
            const draft = await result.innerText();
            const comment = frame
                .locator('[data-testid="merge-editor-1"] span[style*="color"]')
                .filter({ hasText: /^\/\/ theme$/ })
                .first();
            await expect(comment).toHaveCSS("color", "rgb(51, 187, 119)");
            await expect(comment).toHaveCSS("font-style", "italic");
            for (const [theme, kind] of [
                ["Default High Contrast", "vscode-high-contrast"],
                ["Default High Contrast Light", "vscode-high-contrast-light"],
            ]) {
                await writeFile(
                    settingsPath,
                    JSON.stringify({ ...settings, "workbench.colorTheme": theme }),
                );
                await expect(frame.locator("body")).toHaveAttribute("data-vscode-theme-kind", kind);
                await expect(comment).toHaveCSS("color", "rgb(51, 187, 119)");
                await expect(
                    frame.locator(".pane-ours .mrow-conflict .word-diff-change").first(),
                ).toHaveCSS("outline-style", "none");
                expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scroll);
                expect(await result.innerText()).toBe(draft);
                await expect(
                    frame.getByRole("button", { name: "Undo", exact: true }),
                ).toBeEnabled();
                await page.screenshot({ path: testInfo.outputPath(`${kind}.png`) });
            }
            await frame.getByRole("button", { name: "Find in result" }).click();
            await expect(frame.locator(".cm-search")).toBeVisible();
        } finally {
            await app.close();
        }
    });
});

test.describe("Rebase conflict workbench", () => {
    test.use({ scenario: "mid-rebase" });
    test("resolves index stages without committing or continuing the rebase", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        const head = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const frame = await openMerge(page);
            await expect(frame.locator(".pane-meta-row")).toContainText("Result");
            await acceptOurs(frame);
            await frame.getByRole("button", { name: "Apply", exact: true }).click();
            await expect
                .poll(() => runGit(workspace.root, ["ls-files", "-u"], workspace.env))
                .toBe("");
            expect(await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env)).toBe(head);
            expect((await stat(path.join(workspace.root, ".git/rebase-merge"))).isDirectory()).toBe(
                true,
            );
        } finally {
            await app.close();
        }
    });
});
