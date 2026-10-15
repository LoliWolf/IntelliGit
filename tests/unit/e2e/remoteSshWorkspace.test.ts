import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import {
    createRemoteWorkspaceCleanupScript,
    createRemoteWorkspaceFixtureScript,
    readRemoteServerArchive,
} from "../../e2e/hostFixtures/remoteSshWorkspace";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const directories: string[] = [];
afterEach(async () => {
    await removeScratchDirectories(...directories.splice(0));
});

describe("remote SSH project cleanup", () => {
    const cleanup = (root: string, parent: string) =>
        runInNewContext(createRemoteWorkspaceCleanupScript(root, parent), {
            require: (name: string) => {
                if (name === "node:fs") return fs;
                if (name === "node:path") return path;
                if (name === "node:child_process") return { execFileSync: () => "" };
                throw new Error(`Unexpected remote cleanup dependency: ${name}`);
            },
            console: { log: vi.fn() },
        });

    it("removes only the allocated project and preserves its siblings and parent", async () => {
        const parent = await mkdtemp(path.join(os.tmpdir(), "intelligit-remote-cleanup-test-"));
        directories.push(parent);
        const root = fs.mkdtempSync(path.join(parent, "intelligit-ssh-workspace-"));
        const other = path.join(parent, "existing-project");
        fs.mkdirSync(other);
        fs.writeFileSync(path.join(other, "keep.txt"), "existing project\n");

        cleanup(root, parent);

        expect(fs.existsSync(root)).toBe(false);
        expect(fs.readFileSync(path.join(other, "keep.txt"), "utf8")).toBe("existing project\n");
        cleanup(root, parent);
        expect(fs.existsSync(parent)).toBe(true);
    });

    it("refuses parent, sibling, outside and symlink cleanup targets", async () => {
        const parent = await mkdtemp(path.join(os.tmpdir(), "intelligit-remote-cleanup-test-"));
        directories.push(parent);
        const other = path.join(parent, "existing-project");
        fs.mkdirSync(other);
        for (const root of [
            parent,
            other,
            path.join(path.dirname(parent), "intelligit-ssh-workspace-abcdef"),
        ])
            expect(() => cleanup(root, parent)).toThrow("Unexpected cleanup root");

        const link = path.join(parent, "intelligit-ssh-workspace-abcdef");
        fs.symlinkSync(other, link, process.platform === "win32" ? "junction" : "dir");
        expect(() => cleanup(link, parent)).toThrow("Unsafe cleanup root");
        expect(fs.existsSync(other)).toBe(true);
    });
});

describe("remote SSH server archive", () => {
    const client = { version: "1.132.0", commit: "a".repeat(40) };
    const dataFolderName = ".vscode-server";
    const directory = "vscode-server-darwin-arm64";
    const archive = async (change: (zip: JSZip) => void = () => undefined) => {
        const parent = await mkdtemp(path.join(os.tmpdir(), "intelligit-remote-archive-test-"));
        directories.push(parent);
        const zip = new JSZip();
        zip.file(
            `${directory}/product.json`,
            JSON.stringify({ ...client, serverDataFolderName: dataFolderName }),
        );
        zip.file(`${directory}/bin/code-server`, "#!/bin/sh\n");
        change(zip);
        const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
        const file = path.join(parent, "server.zip");
        fs.writeFileSync(file, bytes);
        return { file, bytes };
    };

    it("checks the actual client build and hashes the uploaded bytes", async () => {
        const { file, bytes } = await archive();
        await expect(readRemoteServerArchive(file, client)).resolves.toEqual({
            directory,
            dataFolderName,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        });
    });

    it.each(["version", "commit"] as const)("rejects a different server %s", async (field) => {
        const { file } = await archive((zip) =>
            zip.file(`${directory}/product.json`, JSON.stringify({ ...client, [field]: "other" })),
        );
        await expect(readRemoteServerArchive(file, client)).rejects.toThrow(
            "does not match the actual client",
        );
    });

    it.each(["../outside", `${directory}/../outside`, `${directory}/bad\\path`])(
        "rejects the unsafe archive path %s",
        async (name) => {
            const { file } = await archive((zip) => zip.file(name, "unsafe"));
            await expect(readRemoteServerArchive(file, client)).rejects.toThrow(
                "Unsafe remote server archive entry",
            );
        },
    );

    it("rejects symlink entries and a missing server executable", async () => {
        const link = await archive((zip) =>
            zip.file(`${directory}/link`, "/outside", { unixPermissions: 0o120777 }),
        );
        await expect(readRemoteServerArchive(link.file, client)).rejects.toThrow(
            "Unsafe remote server archive entry",
        );
        const missing = await archive((zip) => zip.remove(`${directory}/bin/code-server`));
        await expect(readRemoteServerArchive(missing.file, client)).rejects.toThrow(
            "Remote server executable is missing",
        );
    });

    it.each(["../outside", ".", "..", "/absolute"])(
        "refuses the unsafe server data folder %s",
        async (serverDataFolderName) => {
            const { file } = await archive((zip) =>
                zip.file(
                    `${directory}/product.json`,
                    JSON.stringify({ ...client, serverDataFolderName }),
                ),
            );
            await expect(readRemoteServerArchive(file, client)).rejects.toThrow(
                "Unsafe remote server data folder",
            );
        },
    );
});

describe("remote SSH fixture initialization cleanup", () => {
    it("refuses a relative project parent before allocating anything", () => {
        const allocate = vi.fn();
        expect(() =>
            runInNewContext(createRemoteWorkspaceFixtureScript("relative-projects"), {
                require: (name: string) => {
                    if (name === "node:fs") return { ...fs, mkdtempSync: allocate };
                    if (name === "node:path") return path;
                    if (name === "node:child_process") return {};
                    throw new Error(`Unexpected remote fixture dependency: ${name}`);
                },
                console,
            }),
        ).toThrow("Remote fixture parent must be absolute");
        expect(allocate).not.toHaveBeenCalled();
    });

    it("returns one valid fixture result with real independent Git repositories", async () => {
        const parent = await mkdtemp(path.join(os.tmpdir(), "intelligit-remote-init-test-"));
        directories.push(parent);
        const result = JSON.parse(
            execFileSync(process.execPath, ["-e", createRemoteWorkspaceFixtureScript(parent)], {
                encoding: "utf8",
                env: {
                    ...process.env,
                    GIT_CONFIG_NOSYSTEM: "1",
                    GIT_CONFIG_GLOBAL: path.join(parent, "unused-global-config"),
                },
            }),
        ) as { root: string; a: string; b: string; aHead: string; incoming: string };
        expect(path.dirname(result.root)).toBe(parent);
        expect(fs.existsSync(path.join(result.a, ".git"))).toBe(true);
        expect(fs.existsSync(path.join(result.b, ".git"))).toBe(true);
        expect(result.aHead).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
        expect(result.incoming).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    });

    it.each(["directory", "git"])("removes the allocated root after %s failure", async (phase) => {
        const parent = await mkdtemp(path.join(os.tmpdir(), "intelligit-remote-init-test-"));
        directories.push(parent);
        const failure = new Error(`injected ${phase} failure`);
        const remoteFs = {
            ...fs,
            mkdirSync:
                phase === "directory"
                    ? () => {
                          throw failure;
                      }
                    : fs.mkdirSync,
        };
        const requireRemote = (name: string): unknown => {
            if (name === "node:fs") return remoteFs;
            if (name === "node:path") return path;
            if (name === "node:child_process")
                return {
                    execFileSync: () => {
                        throw failure;
                    },
                };
            throw new Error(`Unexpected remote fixture dependency: ${name}`);
        };
        expect(() =>
            runInNewContext(createRemoteWorkspaceFixtureScript(parent), {
                require: requireRemote,
                console,
            }),
        ).toThrow(failure.message);
        expect(await readdir(parent)).toEqual([]);
    });
});
