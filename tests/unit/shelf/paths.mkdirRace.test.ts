import { lstat, mkdir, mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const race = vi.hoisted(() => ({
    target: undefined as string | undefined,
    outside: "",
    kind: "symlink" as "symlink" | "file",
}));
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        lstat: async (candidate: string) => {
            try {
                return await actual.lstat(candidate);
            } catch (error) {
                if (
                    candidate === race.target &&
                    (error as NodeJS.ErrnoException).code === "ENOENT"
                ) {
                    race.target = undefined;
                    if (race.kind === "symlink")
                        await actual.symlink(race.outside, candidate, "junction");
                    else await actual.writeFile(candidate, "foreign file");
                }
                throw error;
            }
        },
    };
});
import { ensureShelfRoot, resolveShelfPaths, ShelfPathError } from "../../../src/shelf/paths";

const directories: string[] = [];
afterEach(async () => {
    race.target = undefined;
    await removeScratchDirectories(...directories.splice(0));
});

describe("shelf mkdir collision validation", () => {
    it.each(["symlink", "file"] as const)(
        "refuses a raced-in %s rather than accepting EEXIST",
        async (kind) => {
            const temporary = await mkdtemp(path.join(os.tmpdir(), "intelligit-shelf-mkdir-race-"));
            directories.push(temporary);
            const parent = await realpath(temporary);
            const repositoryRoot = path.join(parent, "repository");
            const outside = path.join(parent, "outside");
            await Promise.all([mkdir(repositoryRoot), mkdir(outside)]);
            const storage = path.join(parent, "storage");
            race.target = storage;
            race.outside = outside;
            race.kind = kind;
            const paths = await resolveShelfPaths({ repositoryRoot, globalStoragePath: storage });
            await expect(ensureShelfRoot(paths)).rejects.toBeInstanceOf(ShelfPathError);
            expect(await readdir(outside)).toEqual([]);
            if (kind === "symlink") expect((await lstat(storage)).isSymbolicLink()).toBe(true);
            else expect(await readFile(storage, "utf8")).toBe("foreign file");
        },
    );
});
