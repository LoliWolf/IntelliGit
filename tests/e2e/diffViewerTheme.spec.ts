import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtureWorkspace";
import { runGit } from "../fixtures/repo/gitRun";
import { waitForE2eChannelReady } from "./controlChannelClient";
import {
    launchFixtureWorkspace,
    dismissFirstRunDialogs,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { ChangesPanel } from "./pageObjects/changesPanel";

const REPO_ROOT = path.resolve(__dirname, "../..");
const THEMES = [
    {
        id: "IntelliGit Test Dark",
        uiTheme: "vs-dark",
        kind: "vscode-dark",
        background: "#152025",
        foreground: "#e4eef2",
        comment: "#87bba2",
    },
    {
        id: "IntelliGit Test Light",
        uiTheme: "vs",
        kind: "vscode-light",
        background: "#f4f8fa",
        foreground: "#142026",
        comment: "#276847",
    },
    {
        id: "IntelliGit Test HC",
        uiTheme: "hc-black",
        kind: "vscode-high-contrast",
        background: "#000000",
        foreground: "#ffffff",
        comment: "#8ee89f",
    },
    {
        id: "IntelliGit Test HC Light",
        uiTheme: "hc-light",
        kind: "vscode-high-contrast-light",
        background: "#ffffff",
        foreground: "#000000",
        comment: "#0b6130",
    },
] as const;

test.describe("Diff follows the active VS Code theme", () => {
    test.use({ scenario: "dirty" });
    test("uses contributed syntax rules, user overrides and live host Diff colors", async ({
        fixtureWorkspace,
    }, testInfo) => {
        test.setTimeout(180_000);
        const { workspace } = fixtureWorkspace;
        const file = "theme-check.ts";
        const filePath = path.join(workspace.root, file);
        const head =
            Array.from({ length: 80 }, (_, i) => `const item${i} = "old"; // theme`).join("\n") +
            "\n";
        await writeFile(filePath, head);
        await runGit(workspace.root, ["add", "--", file], workspace.env);
        await runGit(workspace.root, ["commit", "-m", "Theme fixture"], workspace.env);
        await writeFile(filePath, head.replace('item1 = "old"', 'item1 = "new"'));
        const extension = path.join(
            path.dirname(workspace.profileDir),
            "extensions",
            "intelligit-test-theme",
        );
        await mkdir(path.join(extension, "themes"), { recursive: true });
        await writeFile(
            path.join(extension, "package.json"),
            JSON.stringify({
                name: "intelligit-test-theme",
                publisher: "intelligit-tests",
                version: "1.0.0",
                engines: { vscode: "^1.96.0" },
                contributes: {
                    themes: THEMES.map((theme, i) => ({
                        id: theme.id,
                        label: theme.id,
                        uiTheme: theme.uiTheme,
                        path: `themes/${i}.json`,
                    })),
                },
            }),
        );
        await writeFile(
            path.join(extension, "themes", "parent.json"),
            JSON.stringify({
                tokenColors: [{ scope: "string", settings: { foreground: "#998877" } }],
            }),
        );
        for (const [index, theme] of THEMES.entries()) {
            await writeFile(
                path.join(extension, "themes", `${index}.json`),
                JSON.stringify({
                    include: "parent.json",
                    colors: {
                        "editor.background": theme.background,
                        "editor.foreground": theme.foreground,
                    },
                    tokenColors: [
                        { scope: "storage.type", settings: { foreground: "#776655" } },
                        { scope: "comment", settings: { foreground: theme.comment } },
                    ],
                }),
            );
        }
        await mkdir(path.join(workspace.root, ".vscode"), { recursive: true });
        await writeFile(
            path.join(workspace.root, ".vscode/settings.json"),
            JSON.stringify({
                "workbench.colorTheme": THEMES[0].id,
                "editor.tokenColorCustomizations": {
                    textMateRules: [{ scope: "string", settings: { foreground: "#b08040" } }],
                    "[IntelliGit Test*]": {
                        textMateRules: [
                            {
                                scope: "storage.type",
                                settings: { foreground: "#a04090", fontStyle: "italic" },
                            },
                        ],
                    },
                },
                "workbench.colorCustomizations": {
                    "diffEditor.insertedLineBackground": "#20704040",
                    "diffEditor.removedLineBackground": "#90304040",
                    "diffEditor.insertedTextBackground": "#20704070",
                    "diffEditor.removedTextBackground": "#90304070",
                    "editorLineNumber.foreground": "#808888",
                },
            }),
        );
        const electronApp = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await electronApp.firstWindow();
            await page.waitForLoadState("domcontentloaded");
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const view = new IntelliGitView(page);
            const changes = new ChangesPanel(await view.reveal());
            await changes.changedFileRow(file).click();
            const frame = await view.revealDiffViewer();
            const keyword = frame
                .locator(".code-line-content span")
                .filter({ hasText: /^const$/ })
                .first();
            const string = frame
                .locator(".code-line-content span")
                .filter({ hasText: /^"old"$/ })
                .first();
            await expect(keyword).toHaveCSS("color", "rgb(160, 64, 144)");
            await expect(keyword).toHaveCSS("font-style", "italic");
            await expect(string).toHaveCSS("color", "rgb(176, 128, 64)");
            const comment = frame
                .locator(".code-line-content span")
                .filter({ hasText: /^\/\/ theme$/ })
                .first();
            const editable = frame.locator(".diff-pane-right .diff-segment-modified").first();
            await editable.click();
            const textarea = frame.locator('[data-testid="diff-pane-right-editable"]');
            await expect(textarea).toBeVisible();
            await textarea.fill('const item1 = "draft";');
            await expect.poll(() => readFile(filePath, "utf8")).toContain('"draft"');
            const content = frame.locator(".diff-content");
            await content.evaluate((element) => {
                element.scrollTop = 200;
            });
            const scroll = await content.evaluate((element) => element.scrollTop);
            const settingsPath = path.join(workspace.root, ".vscode/settings.json");
            const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
                string,
                unknown
            >;
            for (const theme of THEMES) {
                if (theme !== THEMES[0]) {
                    await writeFile(
                        settingsPath,
                        JSON.stringify({ ...settings, "workbench.colorTheme": theme.id }),
                    );
                }
                await expect(frame.locator("body")).toHaveAttribute(
                    "data-vscode-theme-kind",
                    theme.kind,
                );
                await expect(keyword).toHaveCSS("color", "rgb(160, 64, 144)");
                const rgb = theme.comment
                    .slice(1)
                    .match(/.{2}/g)!
                    .map((channel) => Number.parseInt(channel, 16));
                await expect(comment).toHaveCSS("color", `rgb(${rgb.join(", ")})`);
                await expect(
                    frame.locator(".diff-pane-left .diff-segment-modified").first(),
                ).toHaveCSS("background-color", "rgba(144, 48, 64, 0.25)");
                await expect(
                    frame.locator(".diff-pane-right .diff-segment-modified").first(),
                ).toHaveCSS("background-color", "rgba(32, 112, 64, 0.25)");
                await expect(frame.locator(".line-numbers").first()).toHaveCSS(
                    "color",
                    "rgb(128, 136, 136)",
                );
                expect(await content.evaluate((element) => element.scrollTop)).toBe(scroll);
                await expect(textarea).toHaveValue('const item1 = "draft";');
                await page.screenshot({ path: testInfo.outputPath(`${theme.kind}.png`) });
            }
        } finally {
            await electronApp.close();
        }
    });
});
