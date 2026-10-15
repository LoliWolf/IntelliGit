import path from "node:path";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { expect, test } from "./fixtureWorkspace";
import { runGitRaw } from "../fixtures/repo/gitRun";
import { E2eControlChannelClient, waitForE2eChannelReady } from "./controlChannelClient";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { Workbench } from "./pageObjects/workbench";
import { IntelliGitView } from "./pageObjects/intelliGitView";

const REPO_ROOT = path.resolve(__dirname, "../..");

test.describe("originating repository branch actions", () => {
    test.use({ scenario: "clean" });

    for (const operation of ["update", "merge"] as const) {
        test(`${operation} changes selected B while docked A stays untouched`, async ({
            fixtureWorkspace,
        }) => {
            const { workspace } = fixtureWorkspace;
            const a = workspace.root;
            const b = path.join(a, "selected-repo");
            const git = (root: string, args: string[]) => runGitRaw(root, args, workspace.env);
            const exclude = path.join(a, ".git/info/exclude");
            await writeFile(exclude, `${await readFile(exclude, "utf8")}\nselected-repo/\n`);
            await git(a, ["clone", "--no-hardlinks", "--", a, b]);
            if (operation === "update") {
                await writeFile(path.join(a, "incoming.txt"), "remote update\n");
                await git(a, ["add", "--", "incoming.txt"]);
                await git(a, ["commit", "-m", "Incoming remote update"]);
            } else {
                await git(a, ["branch", "incoming"]);
                await git(b, ["checkout", "-b", "incoming"]);
                await writeFile(path.join(b, "incoming.txt"), "selected merge\n");
                await git(b, ["add", "--", "incoming.txt"]);
                await git(b, ["commit", "-m", "Incoming selected merge"]);
                await git(b, ["checkout", "main"]);
            }
            const aHead = await git(a, ["rev-parse", "HEAD"]);
            const bHead = await git(b, ["rev-parse", "HEAD"]);
            const expectedHead =
                operation === "update" ? aHead : await git(b, ["rev-parse", "incoming"]);
            expect(bHead).not.toBe(expectedHead);
            const canonicalB = await realpath(b);
            const canonicalA = await realpath(a);
            const app = await launchFixtureWorkspace({
                executablePath: await resolveVSCodeExecutable(REPO_ROOT),
                repoRoot: REPO_ROOT,
                workspace,
                channelDir: fixtureWorkspace.channelDir,
                timeout: 60_000,
            });
            try {
                const page = await app.firstWindow();
                const hostWindow = await app.browserWindow(page);
                await hostWindow.evaluate((browserWindow) => {
                    browserWindow.setContentSize(1280, 900);
                });
                await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280);
                await dismissFirstRunDialogs(page);
                await waitForE2eChannelReady(fixtureWorkspace.channelDir);
                const workbench = new Workbench(page);
                const control = new E2eControlChannelClient(fixtureWorkspace.channelDir);
                const activeRoot = async () => {
                    const response = await control.request({
                        store: "memento",
                        scope: "workspace",
                        operation: "snapshot",
                        key: "intelligit.selectedRepositoryRoot",
                    });
                    return response.ok && response.result?.kind === "value"
                        ? response.result.value
                        : undefined;
                };
                await workbench.runCommand("IntelliGit: Select Repository");
                await page
                    .locator(".quick-input-widget")
                    .getByText("workspace", { exact: true })
                    .click();
                await expect.poll(activeRoot).toBe(canonicalA);
                for (const name of [/^Toggle Primary Side Bar/, /^Toggle Secondary Side Bar/]) {
                    const toggle = page.getByRole("button", { name });
                    if ((await toggle.getAttribute("aria-pressed")) === "true")
                        await toggle.click();
                }
                await workbench.runCommand("IntelliGit: Undock...");
                await page.getByRole("option", { name: /^Undock in Editor Tab/ }).click();
                const frame = await new IntelliGitView(page).revealUndocked();
                const row = frame.locator(
                    `[data-testid="undocked-repository-row"][data-repository-root=${JSON.stringify(canonicalB)}]`,
                );
                await expect(row).toBeVisible();
                await row.click();
                await expect(row).toHaveAttribute("aria-current", "true");
                await expect.poll(activeRoot).toBe(canonicalA);
                const local = frame
                    .getByTestId("undocked-branch-section")
                    .locator('div:has(> [data-branch-section-guide="local"])');
                await local
                    .getByRole("button", {
                        name: operation === "update" ? "main" : "incoming",
                        exact: true,
                    })
                    .click({ button: "right" });
                await frame
                    .getByRole("menuitem", {
                        name: operation === "update" ? "Update" : /^Merge .*incoming.* into .*main/,
                        exact: operation === "update",
                    })
                    .click();
                if (operation === "merge")
                    await page.getByRole("button", { name: "Merge", exact: true }).click();
                await expect.poll(() => git(b, ["rev-parse", "HEAD"])).toBe(expectedHead);
                expect(await git(a, ["rev-parse", "HEAD"])).toBe(aHead);
                expect(await git(a, ["branch", "--show-current"])).toBe("main\n");
                expect(await git(b, ["branch", "--show-current"])).toBe("main\n");
                expect(await git(b, ["status", "--porcelain"])).toBe("");
                expect(await readFile(path.join(b, "incoming.txt"), "utf8")).toBe(
                    operation === "update" ? "remote update\n" : "selected merge\n",
                );
            } finally {
                await app.close();
            }
        });
    }
});
