import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";
import { removeScratchDirectories } from "../helpers/scratchDirectories";
import { createRemoteWorkspaceFixtureScript } from "./hostFixtures/remoteSshWorkspace";

const REPO_ROOT = path.resolve(__dirname, "../..");
const exec = promisify(execFile);
const host = process.env.INTELLIGIT_REMOTE_SSH_HOST;
const remoteNode = process.env.INTELLIGIT_REMOTE_NODE ?? "node";

test("real Remote SSH updates and merges the selected remote repository", async ({}, testInfo) => {
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
        const fixture = JSON.parse(await remote(createRemoteWorkspaceFixtureScript())) as {
            root: string;
            workspace: string;
            a: string;
            b: string;
            aHead: string;
            incoming: string;
        };
        remoteRoot = fixture.root;
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
        const authority = `ssh-remote+${host}`;
        const uri = (remotePath: string) => `vscode-remote://${authority}${remotePath}`;
        app = await electron.launch({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
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
                `--extensionDevelopmentPath=${uri(`${fixture.root}/extension`)}`,
                "--folder-uri",
                uri(fixture.workspace),
            ],
            env: toElectronLaunchEnv(process.env),
            timeout: 60_000,
        });
        const page = await app.firstWindow();
        await dismissFirstRunDialogs(page);
        const view = new IntelliGitView(page);
        await expect(page.getByLabel("IntelliGit", { exact: true })).toBeVisible({
            timeout: 120_000,
        });
        await view.reveal(120_000);
        const workbench = new Workbench(page);
        await workbench.runCommand("IntelliGit: Undock...");
        await page.getByRole("option", { name: /^Undock in Editor Tab/ }).click();
        const frame = await view.revealUndocked();
        const row = frame.getByTestId("undocked-repository-row").filter({ hasText: "b-selected" });
        await row.click();
        await expect(row).toHaveAttribute("aria-current", "true");
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
        await localBranches
            .getByRole("button", { name: "incoming", exact: true })
            .click({ button: "right" });
        await frame.getByRole("menuitem", { name: /^Merge .*incoming.* into .*main/ }).click();
        await page.getByRole("button", { name: "Merge", exact: true }).click();
        await expect
            .poll(() => git(fixture.b, ["show", "HEAD:merge.txt"]).catch(() => "not committed"))
            .toBe("remote merge");
        expect(await git(fixture.b, ["show", "HEAD:pull.txt"])).toBe("remote pull");
        expect(await git(fixture.a, ["rev-parse", "HEAD"])).toBe(fixture.aHead);
        expect(await git(fixture.b, ["status", "--porcelain"])).toBe("");
        await page.screenshot({ path: testInfo.outputPath("remote-ssh-selected-repository.png") });
    } finally {
        await app?.close();
        if (remoteRoot)
            await remote(`
            const fs=require("node:fs"),cp=require("node:child_process");
            const root=${JSON.stringify(remoteRoot)};
            if(!/^\\/tmp\\/intelligit-ssh-workspace-[A-Za-z0-9]+$/.test(root))throw Error("Unexpected cleanup root");
            const output=cp.execFileSync("ps",["-axo","pid=,command="],{encoding:"utf8"});
            for(const line of output.split("\\n")){const match=/^\\s*(\\d+)\\s+(.*)$/.exec(line);if(match&&match[2].includes(root+"/server/")){try{process.kill(Number(match[1]),"SIGTERM")}catch{}}}
            fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
        `).catch(() => undefined);
        await removeScratchDirectories(local);
    }
});
