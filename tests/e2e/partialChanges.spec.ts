import { readFile, writeFile } from "node:fs/promises";
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
const FILE = "partial-target.ts";
const OTHER = "preserve.txt";
const context = Array.from({ length: 12 }, (_, index) => `// context ${index}\n`).join("");
const base = `${context}export const first = 1;\n${context}export const second = 2;\n${context}`;
const working = base.replace("first = 1", "first = 3").replace("second = 2", "second = 4");

async function createFiles(root: string, env: NodeJS.ProcessEnv): Promise<void> {
    await writeFile(path.join(root, FILE), base);
    await writeFile(path.join(root, OTHER), "base\n");
    await runGit(root, ["add", "--", FILE, OTHER], env);
    await runGit(root, ["commit", "-m", "Partial baseline", "--only", "--", FILE, OTHER], env);
    await writeFile(path.join(root, FILE), working);
    await writeFile(path.join(root, OTHER), "user staged\n");
    await runGit(root, ["add", "--", OTHER], env);
}

async function chooseFile(frame: FrameLocator): Promise<void> {
    await frame.getByRole("checkbox", { name: OTHER, exact: true }).first().uncheck();
    await frame.getByRole("checkbox", { name: FILE, exact: true }).first().check();
}

async function createList(page: Page, frame: FrameLocator, name: string): Promise<void> {
    await frame.getByRole("button", { name: "New changelist", exact: true }).click();
    const input = page.locator(".quick-input-widget .quick-input-box input");
    await expect(input).toBeVisible();
    await input.fill(name);
    await input.press("Enter");
    await expect(
        frame.getByRole("combobox", { name: "Changelists", exact: true }).locator("option"),
    ).toContainText([name]);
}

test.describe("Selected changes and changelists", () => {
    test.use({ scenario: "clean" });

    test("stages a block and commits the same selection from the sidebar without including other content", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
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
            const view = new IntelliGitView(page);
            const sidebar = await view.reveal();
            await expect(
                sidebar.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toBeVisible();
            await chooseFile(sidebar);
            await sidebar.getByRole("button", { name: "Partial changes", exact: true }).click();
            const editor = await view.revealPartialChanges(FILE);
            await expect(editor.locator(".partial-block")).toHaveCount(2);
            await editor.getByRole("checkbox", { name: "Select block 1", exact: true }).uncheck();
            await expect(editor.getByLabel("Selection preview", { exact: true })).toContainText(
                "first = 3",
            );
            await editor.getByRole("button", { name: "Stage selected", exact: true }).click();
            await expect
                .poll(() => runGit(workspace.root, ["show", `:${FILE}`], workspace.env))
                .toBe(base.replace("first = 1", "first = 3"));
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
            expect(await runGit(workspace.root, ["show", `:${OTHER}`], workspace.env)).toBe(
                "user staged\n",
            );
            await sidebar.locator("#commit-area-message").fill("Selected first block");
            await expect(sidebar.getByTestId("commit-action-commit")).toBeEnabled();
            await sidebar.getByTestId("commit-action-commit").click();
            await expect
                .poll(() => runGit(workspace.root, ["show", `HEAD:${FILE}`], workspace.env))
                .toBe(base.replace("first = 1", "first = 3"));
            expect(await runGit(workspace.root, ["show", `HEAD:${OTHER}`], workspace.env)).toBe(
                "base\n",
            );
            expect(await runGit(workspace.root, ["show", `:${OTHER}`], workspace.env)).toBe(
                "user staged\n",
            );
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
            await page.screenshot({ path: testInfo.outputPath("partial-sidebar-committed.png") });
        } finally {
            await app.close();
        }
    });

    test("persists named lists and split-file ownership through reload and commits only the selected list", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
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
            let view = new IntelliGitView(page);
            let sidebar = await view.reveal();
            await expect(
                sidebar.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toBeVisible();
            await createList(page, sidebar, "Feature");
            await createList(page, sidebar, "Bug");
            await chooseFile(sidebar);
            await sidebar
                .getByRole("button", { name: "Move selected changes", exact: true })
                .click();
            await page.locator(".quick-input-widget").getByText("Feature", { exact: true }).click();
            await sidebar
                .getByRole("combobox", { name: "Changelists", exact: true })
                .selectOption({ label: "Feature" });
            await sidebar.getByRole("checkbox", { name: FILE, exact: true }).first().check();
            await sidebar.getByRole("button", { name: "Partial changes", exact: true }).click();
            const editor = await view.revealPartialChanges(FILE);
            await editor.getByRole("checkbox", { name: "Select block 0", exact: true }).uncheck();
            await editor
                .getByRole("combobox", { name: "Target changelist", exact: true })
                .selectOption({ label: "Bug" });
            await editor.getByRole("button", { name: "Assign selected", exact: true }).click();
            await expect(
                editor.getByRole("button", { name: "Assign selected", exact: true }),
            ).toBeEnabled();
            await new Workbench(page).runCommand("Developer: Reload Window");
            view = new IntelliGitView(page);
            sidebar = await view.reveal();
            await expect(
                sidebar.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toBeVisible();
            await sidebar
                .getByRole("combobox", { name: "Changelists", exact: true })
                .selectOption({ label: "Bug" });
            await sidebar.getByRole("checkbox", { name: FILE, exact: true }).first().check();
            await expect(sidebar.getByRole("checkbox", { name: OTHER, exact: true })).toHaveCount(
                0,
            );
            await sidebar.locator("#commit-area-message").fill("Bug changelist only");
            await expect(sidebar.getByTestId("commit-action-commit")).toBeEnabled();
            await sidebar.getByTestId("commit-action-commit").click();
            await expect
                .poll(() => runGit(workspace.root, ["show", `HEAD:${FILE}`], workspace.env))
                .toBe(base.replace("second = 2", "second = 4"));
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
            expect(await runGit(workspace.root, ["show", `:${OTHER}`], workspace.env)).toBe(
                "user staged\n",
            );
            await page.screenshot({ path: testInfo.outputPath("changelist-after-reload.png") });
        } finally {
            await app.close();
        }
    });

    test("uses the standalone commit action and keeps syntax preview read-only", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
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
            const view = new IntelliGitView(page);
            const sidebar = await view.reveal();
            await expect(
                sidebar.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toBeVisible();
            await chooseFile(sidebar);
            await sidebar.getByRole("button", { name: "Partial changes", exact: true }).click();
            const editor = await view.revealPartialChanges(FILE);
            await editor.getByRole("checkbox", { name: "Select block 1", exact: true }).uncheck();
            await editor
                .getByRole("button", { name: "Use selection for commit", exact: true })
                .click();
            await expect(
                editor.getByRole("button", { name: "Use selection for commit", exact: true }),
            ).toBeEnabled();
            const preview = editor.getByLabel("Selection preview", { exact: true });
            await expect(preview.locator('span[style*="color"]')).not.toHaveCount(0);
            await expect(preview).toHaveAttribute("contenteditable", "false");
            await editor
                .getByRole("textbox", { name: "Commit message", exact: true })
                .fill("Standalone first block");
            await editor.getByRole("button", { name: "Commit selected", exact: true }).click();
            await expect(editor.locator(".partial-commit [role=status]")).toContainText(
                "Committed",
            );
            await expect
                .poll(() => runGit(workspace.root, ["show", `HEAD:${FILE}`], workspace.env))
                .toBe(base.replace("first = 1", "first = 3"));
            expect(await runGit(workspace.root, ["show", `:${OTHER}`], workspace.env)).toBe(
                "user staged\n",
            );
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
        } finally {
            await app.close();
        }
    });
});
