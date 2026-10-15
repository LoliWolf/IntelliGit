import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";
import {
    dismissFirstRunDialogs,
    seedProfileSettings,
    toElectronLaunchEnv,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { resolveVSCodeProductInfo } from "./hostFixtures/resolveVSCodeProduct";
import { assertExactInstalledExtensionVersion } from "./hostFixtures/packageSmokeHelpers";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";
import { removeScratchDirectories } from "../helpers/scratchDirectories";
import {
    createRemoteWorkspaceCleanupScript,
    createRemoteWorkspaceFixtureScript,
    readRemoteServerArchive,
} from "./hostFixtures/remoteSshWorkspace";

const REPO_ROOT = path.resolve(__dirname, "../..");
const exec = promisify(execFile);
const host = process.env.INTELLIGIT_REMOTE_SSH_HOST;
const remoteNode = process.env.INTELLIGIT_REMOTE_NODE ?? "node";
const remoteParent = process.env.INTELLIGIT_REMOTE_WORKSPACE_PARENT ?? "/tmp";

test("real Remote SSH pulls, updates and merges the selected remote repository", async ({}, testInfo) => {
    test.skip(!host, "Opt-in: requires an explicitly configured disposable SSH test host.");
    test.setTimeout(240_000);
    if (!host || host.startsWith("-") || /\s/.test(host) || !/^[\w/.-]+$/.test(remoteNode))
        throw new Error("Invalid SSH test host or remote Node executable.");
    const remote = async (script: string): Promise<string> => {
        const encoded = Buffer.from(script).toString("base64");
        const command =
            `${remoteNode} -e 'eval(Buffer.from(process.argv[1],"base64").toString("utf8"))' ` +
            encoded;
        return (
            await exec(
                "ssh",
                ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", host, command],
                {
                    maxBuffer: 2 * 1024 * 1024,
                    timeout: 30_000,
                },
            )
        ).stdout.trim();
    };
    const local = await mkdtemp(path.join(os.tmpdir(), "intelligit-ssh-client-"));
    let remoteRoot: string | undefined;
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        const fixture = JSON.parse(
            await remote(createRemoteWorkspaceFixtureScript(remoteParent)),
        ) as {
            root: string;
            workspace: string;
            a: string;
            b: string;
            aHead: string;
            incoming: string;
        };
        remoteRoot = fixture.root;
        await expect(access(fixture.workspace)).rejects.toMatchObject({ code: "ENOENT" });
        const executablePath = await resolveVSCodeExecutable(REPO_ROOT);
        const product = resolveVSCodeProductInfo(executablePath);
        const serverArchive = process.env.INTELLIGIT_REMOTE_SERVER_ARCHIVE;
        let serverAgent: string | undefined;
        if (serverArchive) {
            const seed = await readRemoteServerArchive(serverArchive, product);
            // Remote-SSH appends the product data folder to its configured install base.
            serverAgent = `${fixture.root}/server/${seed.dataFolderName}`;
            await exec("scp", ["--", serverArchive, `${host}:${fixture.root}/server.zip`], {
                timeout: 60_000,
                maxBuffer: 2 * 1024 * 1024,
            });
            await remote(`
                const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process"),crypto=require("node:crypto");
                const root=${JSON.stringify(fixture.root)},archive=path.join(root,"server.zip");
                const agent=${JSON.stringify(serverAgent)};
                if(crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex")!==${JSON.stringify(seed.sha256)})
                    throw Error("Remote server archive transport mismatch");
                const staging=path.join(root,"server-seed");
                cp.execFileSync("unzip",["-q",archive,"-d",staging]);
                const source=path.join(staging,${JSON.stringify(seed.directory)});
                const product=JSON.parse(fs.readFileSync(path.join(source,"product.json"),"utf8"));
                if(product.commit!==${JSON.stringify(product.commit)}||product.version!==${JSON.stringify(product.version)})
                    throw Error("Remote server product mismatch");
                fs.mkdirSync(path.join(agent,"bin"),{recursive:true});
                fs.renameSync(source,path.join(agent,"bin",${JSON.stringify(product.commit)}));
                fs.rmSync(archive);
            `);
        }
        const profile = path.join(local, "profile");
        const extensions = path.join(local, "extensions");
        await mkdir(extensions);
        const installed = path.join(os.homedir(), ".vscode/extensions");
        for (const prefix of [
            "ms-vscode-remote.remote-ssh-",
            "ms-vscode-remote.remote-ssh-edit-",
            "ms-vscode.remote-explorer-",
        ]) {
            const matches = (await readdir(installed))
                .filter((name) => name.startsWith(prefix) && /^\d/.test(name.slice(prefix.length)))
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            if (!matches[0]) throw new Error(`Missing local test prerequisite: ${prefix}`);
            const source =
                prefix === "ms-vscode-remote.remote-ssh-" &&
                process.env.INTELLIGIT_REMOTE_SSH_EXTENSION_PATH
                    ? process.env.INTELLIGIT_REMOTE_SSH_EXTENSION_PATH
                    : path.join(installed, matches[0]);
            await cp(source, path.join(extensions, path.basename(source)), { recursive: true });
        }
        await seedProfileSettings(profile);
        const settingsFile = path.join(profile, "User/settings.json");
        const settings = JSON.parse(await readFile(settingsFile, "utf8")) as Record<
            string,
            unknown
        >;
        settings["remote.SSH.serverInstallPath"] = { [host]: `${fixture.root}/server` };
        settings["remote.SSH.useExecServer"] = false;
        settings["remote.SSH.localServerDownload"] = "always";
        settings["remote.SSH.showLoginTerminal"] = false;
        await writeFile(settingsFile, JSON.stringify(settings));
        const vsix = process.env.INTELLIGIT_REMOTE_VSIX;
        if (vsix) {
            if (!serverAgent)
                throw new Error("Installed remote smoke requires a matching seeded server.");
            const manifest = JSON.parse(
                await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
            ) as { name: string; publisher: string; version: string };
            const expected = `${manifest.publisher}.${manifest.name}@${manifest.version}`;
            const hash = createHash("sha256")
                .update(await readFile(vsix))
                .digest("hex");
            await exec("scp", ["--", vsix, `${host}:${fixture.root}/extension.vsix`], {
                timeout: 60_000,
                maxBuffer: 2 * 1024 * 1024,
            });
            const installed = await remote(`
                const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process"),crypto=require("node:crypto");
                const root=${JSON.stringify(fixture.root)},vsix=path.join(root,"extension.vsix");
                if(crypto.createHash("sha256").update(fs.readFileSync(vsix)).digest("hex")!==${JSON.stringify(hash)})
                    throw Error("Remote VSIX transport mismatch");
                const server=${JSON.stringify(serverAgent)},cli=path.join(server,"bin",${JSON.stringify(product.commit)},"bin/code-server");
                const args=["--user-data-dir",path.join(server,"data"),"--extensions-dir",path.join(server,"extensions")];
                const run=extra=>cp.execFileSync(cli,[...args,...extra],{env:{...process.env,VSCODE_AGENT_FOLDER:server},encoding:"utf8",stdio:["ignore","pipe","pipe"]});
                run(["--install-extension",vsix]);
                console.log(run(["--list-extensions","--show-versions"]).trim());
            `);
            assertExactInstalledExtensionVersion(installed, expected);
            const evidence = testInfo.outputPath("remote-ssh-installation.json");
            await writeFile(
                evidence,
                JSON.stringify({ extension: expected, vsixSha256: hash, vscode: product }),
            );
            await testInfo.attach("remote-ssh-installation", {
                path: evidence,
                contentType: "application/json",
            });
        } else {
            await exec(
                "scp",
                [
                    "-r",
                    "--",
                    path.join(REPO_ROOT, "package.json"),
                    path.join(REPO_ROOT, "dist"),
                    path.join(REPO_ROOT, "l10n"),
                    path.join(REPO_ROOT, "media"),
                    path.join(REPO_ROOT, "package.nls.json"),
                    `${host}:${fixture.root}/extension/`,
                ],
                { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
            );
        }
        const authority = `ssh-remote+${host}`;
        const uri = (remotePath: string) => `vscode-remote://${authority}${remotePath}`;
        app = await electron.launch({
            executablePath,
            args: [
                "--new-window",
                "--disable-workspace-trust",
                "--skip-welcome",
                "--skip-release-notes",
                "--disable-gpu",
                "--password-store=basic",
                "--force-disable-user-env",
                `--user-data-dir=${profile}`,
                `--extensions-dir=${extensions}`,
                ...(vsix ? [] : [`--extensionDevelopmentPath=${uri(`${fixture.root}/extension`)}`]),
                "--folder-uri",
                uri(fixture.workspace),
            ],
            env: toElectronLaunchEnv(process.env),
            timeout: 60_000,
        });
        if (vsix)
            expect(
                app.process().spawnargs.some((arg) => arg.startsWith("--extensionDevelopmentPath")),
            ).toBe(false);
        const page = await app.firstWindow();
        const hostWindow = await app.browserWindow(page);
        await hostWindow.evaluate((window) => window.setContentSize(1280, 900));
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280);
        await dismissFirstRunDialogs(page);
        const view = new IntelliGitView(page);
        await expect(
            page
                .locator(".activitybar .action-item")
                .filter({ has: page.getByLabel("IntelliGit", { exact: true }) })
                .first(),
        ).toBeVisible({ timeout: 120_000 });
        await view.reveal(120_000);
        if (serverAgent) {
            const identity = JSON.parse(
                await remote(`
                    const cp=require("node:child_process"),path=require("node:path"),agent=${JSON.stringify(serverAgent)};
                    const commands=cp.execFileSync("ps",["-axo","command="],{encoding:"utf8"}).split("\\n");
                    if(!commands.some(line=>line.includes(path.join(agent,"bin",${JSON.stringify(product.commit)}))&&line.includes("--server-data-dir "+agent)))
                        throw Error("SSH client did not use the isolated seeded server");
                    console.log(JSON.stringify({isolatedServer:true,node:cp.execFileSync(path.join(agent,"bin",${JSON.stringify(product.commit)},"node"),["--version"],{encoding:"utf8"}).trim()}));
                `),
            ) as { isolatedServer: boolean; node: string };
            expect(identity.isolatedServer).toBe(true);
            const evidence = testInfo.outputPath("remote-ssh-server.json");
            await writeFile(
                evidence,
                JSON.stringify({ ...identity, vscode: product, installedVsix: Boolean(vsix) }),
            );
            await testInfo.attach("remote-ssh-server", {
                path: evidence,
                contentType: "application/json",
            });
        }
        const workbench = new Workbench(page);
        const selectRepository = async (name: string) => {
            await workbench.runCommand("IntelliGit: Select Repository");
            await page.locator(".quick-input-widget").getByText(name, { exact: true }).click();
        };
        const assertActiveRepository = async (name: string) => {
            await workbench.runCommand("IntelliGit: Select Repository");
            await expect(
                page.getByRole("option").filter({ has: page.getByText(name, { exact: true }) }),
            ).toContainText("Active");
            await page.keyboard.press("Escape");
        };
        await selectRepository("a-active");
        await assertActiveRepository("a-active");
        for (const name of [/^Toggle Primary Side Bar/, /^Toggle Secondary Side Bar/]) {
            const toggle = page.getByRole("button", { name });
            if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
        }
        await workbench.runCommand("IntelliGit: Undock...");
        await page.getByRole("option", { name: /^Undock in Editor Tab/ }).click();
        const frame = await view.revealUndocked();
        const row = frame.getByTestId("undocked-repository-row").filter({ hasText: "b-selected" });
        await row.click();
        await expect(row).toHaveAttribute("aria-current", "true");
        await assertActiveRepository("a-active");
        const localBranches = frame
            .getByTestId("undocked-branch-section")
            .locator('div:has(> [data-branch-section-guide="local"])');
        const git = async (root: string, args: string[]): Promise<string> =>
            remote(
                `console.log(require("node:child_process").execFileSync("git",${JSON.stringify(args)},{cwd:${JSON.stringify(root)},encoding:"utf8"}).trim())`,
            );
        await localBranches
            .getByRole("button", { name: "main", exact: true })
            .click({ button: "right" });
        await frame.getByRole("menuitem", { name: "Update", exact: true }).click();
        await expect.poll(() => git(fixture.b, ["rev-parse", "HEAD"])).toBe(fixture.aHead);
        expect(await git(fixture.b, ["show", "HEAD:pull.txt"])).toBe("remote pull");
        expect(await git(fixture.a, ["rev-parse", "HEAD"])).toBe(fixture.aHead);
        console.info("[remote-ssh] Branch Update advanced remote B; docked A is unchanged.");
        const advance = (file: string) =>
            remote(`
                const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process"),root=${JSON.stringify(fixture.a)};
                const git=args=>cp.execFileSync("git",args,{cwd:root,encoding:"utf8"}).trim();
                fs.writeFileSync(path.join(root,${JSON.stringify(file)}),"remote pull\\n");
                git(["add","--",${JSON.stringify(file)}]);git(["commit","-m","Remote test advance"]);
                console.log(git(["rev-parse","HEAD"]));
            `);
        const toolbarHead = await advance("toolbar-pull.txt");
        await frame
            .getByTestId("undocked-commit-panel-section")
            .getByRole("button", { name: "Pull", exact: true })
            .click();
        await expect.poll(() => git(fixture.b, ["rev-parse", "HEAD"])).toBe(toolbarHead);
        expect(await git(fixture.a, ["rev-parse", "HEAD"])).toBe(toolbarHead);
        console.info("[remote-ssh] Undocked Pull advanced remote B; docked A is unchanged.");
        await localBranches
            .getByRole("button", { name: "incoming", exact: true })
            .click({ button: "right" });
        await frame.getByRole("menuitem", { name: /^Merge .*incoming.* into .*main/ }).click();
        await page.getByRole("button", { name: "Merge", exact: true }).click();
        await expect
            .poll(() => git(fixture.b, ["show", "HEAD:merge.txt"]).catch(() => "not committed"))
            .toBe("remote merge");
        expect(await git(fixture.b, ["show", "HEAD:pull.txt"])).toBe("remote pull");
        expect(await git(fixture.a, ["rev-parse", "HEAD"])).toBe(toolbarHead);
        expect(await git(fixture.b, ["status", "--porcelain"])).toBe("");
        console.info("[remote-ssh] Branch Merge changed remote B; docked A is unchanged.");
        await assertActiveRepository("a-active");
        await selectRepository("b-selected");
        const sidebar = await view.reveal();
        await expect(sidebar.getByTestId("commit-panel-tab-row")).toBeVisible();
        await assertActiveRepository("b-selected");
        const sidebarHead = await advance("sidebar-pull.txt");
        await page
            .locator(".part.sidebar")
            .getByRole("button", { name: "Pull", exact: true })
            .click();
        await expect
            .poll(() =>
                git(fixture.b, ["show", "HEAD:sidebar-pull.txt"]).catch(() => "not committed"),
            )
            .toBe("remote pull");
        expect(await git(fixture.b, ["show", "HEAD:merge.txt"])).toBe("remote merge");
        expect(await git(fixture.a, ["rev-parse", "HEAD"])).toBe(sidebarHead);
        expect(await git(fixture.b, ["status", "--porcelain"])).toBe("");
        console.info("[remote-ssh] Sidebar Pull changed remote B and preserved its merged file.");
        await page.screenshot({ path: testInfo.outputPath("remote-ssh-selected-repository.png") });
    } finally {
        try {
            await app?.close();
        } finally {
            try {
                if (remoteRoot)
                    await remote(createRemoteWorkspaceCleanupScript(remoteRoot, remoteParent));
            } finally {
                await removeScratchDirectories(local);
            }
        }
    }
});
