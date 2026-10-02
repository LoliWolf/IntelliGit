import { readFile, writeFile, mkdir } from "node:fs/promises";
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
async function openMerge(page: Page): Promise<FrameLocator> {
    const view = new IntelliGitView(page);
    await new Workbench(page).runCommand("Open Conflict Session");
    const session = await view.revealConflictSession();
    await expect(session.locator("tbody tr.row")).toHaveCount(1);
    await session.locator("tbody tr.row").dblclick();
    return view.revealMergeWorkbench();
}

/** Resolves each original change through visible per-change navigation and side decisions. */
async function acceptOurs(frame: FrameLocator): Promise<void> {
    const changes = frame.locator(".mw-hunks button");
    for (let i = 0; i < (await changes.count()); i++) {
        await changes.nth(i).click();
        await frame
            .locator(".mw-toolbar")
            .getByRole("button", { name: "Accept left change", exact: true })
            .click();
    }
}

test.describe("Full-document Git merge workbench", () => {
    test.use({ scenario: "conflicted" });
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
            await frame
                .locator(".mw-connectors")
                .first()
                .getByRole("button", { name: "Accept left change", exact: true })
                .first()
                .click();
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
            await expect(frame.locator(".mw-footer")).toContainText("Draft saved");
            const draft = await result().innerText();
            await frame.getByRole("button", { name: "Base", exact: true }).click();
            await expect(frame.locator(".mw-base .cm-content")).toBeVisible();
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
            await frame.getByRole("button", { name: "Cancel", exact: true }).click();
            frame = await openMerge(page);
            await expect.poll(() => result().innerText()).toBe(draft);
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
            await expect(frame.locator(".mw-error")).toContainText("changed");
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
});
