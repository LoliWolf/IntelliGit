import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteWorkspaceFixtureScript } from "../../e2e/hostFixtures/remoteSshWorkspace";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const directories: string[] = [];
afterEach(async () => {
    await removeScratchDirectories(...directories.splice(0));
});

describe("remote SSH fixture initialization cleanup", () => {
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
