import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitExecutor } from "../../../src/git/executor";
import { PartialChanges } from "../../../src/git/partialChanges";
import { changeIds } from "../../../src/changes/selection";
import type {
    ChangeFileView,
    SelectedFileChanges,
} from "../../../src/webviews/protocol/changeSelection";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

let root: string;
let workflow: PartialChanges;
const base = Array.from({ length: 100 }, (_, index) => `line ${index}\n`).join("");
const selected = base.replace("line 20\n", "selected change\n");
const working = selected.replace("line 80\n", "other change\n");

function git(args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function firstBlock(view: ChangeFileView): SelectedFileChanges {
    return {
        snapshotId: view.snapshotId,
        lineIds: changeIds(view.blocks.slice(0, 1)),
    };
}

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "intelligit-partial-integration-"));
    git(["init", "-q"]);
    git(["config", "user.name", "Partial Tests"]);
    git(["config", "user.email", "partial@example.invalid"]);
    git(["config", "commit.gpgSign", "false"]);
    await writeFile(path.join(root, "text.txt"), base);
    await writeFile(path.join(root, "other.txt"), "base\n");
    git(["add", "--", "text.txt", "other.txt"]);
    git(["commit", "-qm", "base"]);
    await writeFile(path.join(root, "text.txt"), working);
    workflow = new PartialChanges(new GitExecutor(root), root);
});

afterEach(async () => {
    await removeScratchDirectories(root);
});

describe("partial changes on real Git", () => {
    it("stages one block without touching worktree, HEAD or unrelated staged content", async () => {
        await writeFile(path.join(root, "other.txt"), "user staged\n");
        git(["add", "--", "other.txt"]);
        const head = git(["rev-parse", "HEAD"]);
        const view = await workflow.open("text.txt");
        await workflow.stage(firstBlock(view), () => undefined);
        expect(git(["show", ":text.txt"])).toBe(selected);
        expect(git(["show", ":other.txt"])).toBe("user staged\n");
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
        expect(git(["rev-parse", "HEAD"])).toBe(head);
    });

    it("unstages only a selected indexed block", async () => {
        git(["add", "--", "text.txt"]);
        const view = await workflow.open("text.txt", "index");
        await workflow.stage(firstBlock(view), () => undefined);
        expect(git(["show", ":text.txt"])).toBe(base.replace("line 80\n", "other change\n"));
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
    });

    it("commits selected content and preserves unrelated staged and unstaged changes", async () => {
        await writeFile(path.join(root, "other.txt"), "user staged\n");
        git(["add", "--", "other.txt"]);
        const oldHead = git(["rev-parse", "HEAD"]).trim();
        const view = await workflow.open("text.txt");
        const commit = await workflow.commit([firstBlock(view)], "partial change", () => undefined);
        expect(git(["rev-parse", "HEAD"]).trim()).toBe(commit);
        expect(git(["rev-parse", "HEAD^"]).trim()).toBe(oldHead);
        expect(git(["show", "HEAD:text.txt"])).toBe(selected);
        expect(git(["show", "HEAD:other.txt"])).toBe("base\n");
        expect(git(["show", ":other.txt"])).toBe("user staged\n");
        expect(git(["show", ":text.txt"])).toBe(selected);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
    });

    it("retains other staged blocks in the same file after a partial commit", async () => {
        git(["add", "--", "text.txt"]);
        const view = await workflow.open("text.txt");
        await workflow.commit([firstBlock(view)], "one staged block", () => undefined);
        expect(git(["show", "HEAD:text.txt"])).toBe(selected);
        expect(git(["show", ":text.txt"])).toBe(working);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
    });

    it("refuses a stale worktree, index, branch and dirty native buffer", async () => {
        const view = await workflow.open("text.txt");
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        await writeFile(path.join(root, "text.txt"), working + "external\n");
        await expect(workflow.commit([firstBlock(view)], "stale", () => undefined)).rejects.toThrow(
            "changed",
        );
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        await writeFile(path.join(root, "text.txt"), working);
        await expect(
            workflow.stage(firstBlock(view), () => {
                throw new Error("dirty buffer");
            }),
        ).rejects.toThrow("dirty buffer");
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        await writeFile(path.join(root, "other.txt"), "external staged\n");
        git(["add", "--", "other.txt"]);
        await expect(workflow.stage(firstBlock(view), () => undefined)).rejects.toThrow("changed");
    });

    it("never removes another process's index lock", async () => {
        const view = await workflow.open("text.txt");
        const lock = path.join(root, ".git/index.lock");
        await writeFile(lock, "foreign owner");
        await expect(workflow.stage(firstBlock(view), () => undefined)).rejects.toThrow();
        expect(await readFile(lock, "utf8")).toBe("foreign owner");
    });

    it("runs a failing pre-commit hook without publishing HEAD or changing the real index", async () => {
        const hook = path.join(root, ".git/hooks/pre-commit");
        await writeFile(hook, "#!/bin/sh\nprintf ran > hook-ran\nexit 1\n");
        await chmod(hook, 0o755);
        const view = await workflow.open("text.txt");
        const index = await readFile(path.join(root, ".git/index"));
        const head = git(["rev-parse", "HEAD"]);
        await expect(
            workflow.commit([firstBlock(view)], "hook failure", () => undefined),
        ).rejects.toThrow();
        expect(await readFile(path.join(root, "hook-ran"), "utf8")).toBe("ran");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it("preserves the original branch context for hooks while keeping real refs unchanged", async () => {
        const branch = git(["symbolic-ref", "--short", "HEAD"]).trim();
        const hook = path.join(root, ".git/hooks/pre-commit");
        await writeFile(hook, "#!/bin/sh\ngit symbolic-ref --short HEAD > hook-branch\n");
        await chmod(hook, 0o755);
        const view = await workflow.open("text.txt");
        await workflow.commit([firstBlock(view)], "branch aware", () => undefined);
        expect((await readFile(path.join(root, "hook-branch"), "utf8")).trim()).toBe(branch);
        expect(git(["symbolic-ref", "--short", "HEAD"]).trim()).toBe(branch);
    });

    it("invokes the configured signing program and retains the resulting signature object", async () => {
        const signer = path.join(root, ".git", "fixture-signer");
        await writeFile(
            signer,
            "#!/bin/sh\ncat >/dev/null\nprintf signed > signer-ran\nprintf '[GNUPG:] SIG_CREATED D 1 10 00 0 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n' >&2\nprintf '%s\\n' '-----BEGIN PGP SIGNATURE-----' 'ZmFrZS1zaWduYXR1cmU=' '-----END PGP SIGNATURE-----'\n",
        );
        await chmod(signer, 0o755);
        git(["config", "gpg.program", signer]);
        git(["config", "user.signingkey", "A".repeat(40)]);
        git(["config", "commit.gpgSign", "true"]);
        const view = await workflow.open("text.txt");
        await workflow.commit([firstBlock(view)], "signed selected commit", () => undefined);
        expect(await readFile(path.join(root, "signer-ran"), "utf8")).toBe("signed");
        expect(git(["cat-file", "-p", "HEAD"])).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
        expect(git(["show", "HEAD:text.txt"])).toBe(selected);
    });

    it("does not silently disable signing when the configured signer fails", async () => {
        git(["config", "gpg.program", path.join(root, "missing-signer")]);
        git(["config", "commit.gpgSign", "true"]);
        const view = await workflow.open("text.txt");
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        await expect(
            workflow.commit([firstBlock(view)], "sign failure", () => undefined),
        ).rejects.toThrow();
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it("refuses a foreign replacement of its acquired index lock before publishing", async () => {
        const view = await workflow.open("text.txt");
        const head = git(["rev-parse", "HEAD"]);
        const lock = path.join(root, ".git/index.lock");
        await expect(
            workflow.commit([firstBlock(view)], "foreign lock", () => undefined, {
                afterLock: async () => {
                    await rm(lock);
                    await writeFile(lock, "replacement owner");
                },
            }),
        ).rejects.toThrow("ownership");
        expect(await readFile(lock, "utf8")).toBe("replacement owner");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
    });

    it("refuses hook-added content instead of publishing an unselected change", async () => {
        const hook = path.join(root, ".git/hooks/pre-commit");
        await writeFile(hook, "#!/bin/sh\nprintf extra > other.txt\ngit add -- other.txt\n");
        await chmod(hook, 0o755);
        const view = await workflow.open("text.txt");
        const index = await readFile(path.join(root, ".git/index"));
        const head = git(["rev-parse", "HEAD"]);
        await expect(
            workflow.commit([firstBlock(view)], "hook mutation", () => undefined),
        ).rejects.toThrow("hook changed");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it("recovers an index reconciliation interrupted after the ref CAS without another commit", async () => {
        const view = await workflow.open("text.txt");
        await expect(
            workflow.commit([firstBlock(view)], "recoverable", () => undefined, {
                afterPublish: async () => {
                    throw new Error("injected crash boundary");
                },
            }),
        ).rejects.toThrow("commit succeeded");
        const committed = git(["rev-parse", "HEAD"]);
        expect(git(["show", "HEAD:text.txt"])).toBe(selected);
        expect(await workflow.recover()).toBe(true);
        expect(git(["rev-parse", "HEAD"])).toBe(committed);
        expect(git(["show", ":text.txt"])).toBe(selected);
    });

    it("retains recovery evidence when an external ref advances after publication", async () => {
        const view = await workflow.open("text.txt");
        const index = await readFile(path.join(root, ".git/index"));
        await expect(
            workflow.commit([firstBlock(view)], "selected publication", () => undefined, {
                afterPublish: async () => {
                    const current = git(["rev-parse", "HEAD"]).trim();
                    const tree = git(["rev-parse", "HEAD^{tree}"]).trim();
                    const external = git([
                        "commit-tree",
                        tree,
                        "-p",
                        current,
                        "-m",
                        "external",
                    ]).trim();
                    git(["update-ref", "HEAD", external, current]);
                },
            }),
        ).rejects.toThrow("commit succeeded");
        const advanced = git(["rev-parse", "HEAD"]);
        expect(await readdir(path.join(root, ".git/intelligit/partial-index"))).toHaveLength(1);
        await expect(workflow.recover()).rejects.toThrow("will not overwrite");
        expect(git(["rev-parse", "HEAD"])).toBe(advanced);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
    });

    it("rejects a same-commit branch switch without changing Git", async () => {
        const view = await workflow.open("text.txt");
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        git(["switch", "-c", "other-branch"]);
        await expect(workflow.stage(firstBlock(view), () => undefined)).rejects.toThrow("changed");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it.skipIf(process.platform === "win32")(
        "rejects a symlink replacement without changing Git",
        async () => {
            const fresh = await workflow.open("text.txt");
            const head = git(["rev-parse", "HEAD"]);
            const index = await readFile(path.join(root, ".git/index"));
            await rm(path.join(root, "text.txt"));
            await symlink("other.txt", path.join(root, "text.txt"));
            await expect(workflow.stage(firstBlock(fresh), () => undefined)).rejects.toThrow(
                "regular",
            );
            expect(git(["rev-parse", "HEAD"])).toBe(head);
            expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        },
    );

    it("rejects binary, symlink and active-operation partial edits", async () => {
        await writeFile(path.join(root, "text.txt"), Buffer.from([1, 0, 2]));
        await expect(workflow.open("text.txt")).rejects.toThrow("Binary");
        await writeFile(path.join(root, "text.txt"), working);
        await writeFile(path.join(root, ".git/MERGE_HEAD"), git(["rev-parse", "HEAD"]));
        await expect(workflow.open("text.txt")).rejects.toThrow("Git operation");
    });

    it("supports Git's CRLF clean conversion without rewriting worktree bytes", async () => {
        git(["config", "core.autocrlf", "true"]);
        const crlf = working.replace(/\n/g, "\r\n");
        await writeFile(path.join(root, "text.txt"), crlf);
        const view = await workflow.open("text.txt");
        await workflow.stage(firstBlock(view), () => undefined);
        expect(git(["show", ":text.txt"])).toBe(selected);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(crlf);
    });

    it("commits on detached HEAD without moving the branch it was detached from", async () => {
        const branch = git(["symbolic-ref", "HEAD"]).trim();
        const original = git(["rev-parse", branch]);
        git(["checkout", "--detach", "-q"]);
        const view = await workflow.open("text.txt");
        const committed = await workflow.commit(
            [firstBlock(view)],
            "detached selection",
            () => undefined,
        );
        expect(git(["rev-parse", "HEAD"]).trim()).toBe(committed);
        expect(git(["rev-parse", branch])).toBe(original);
        expect(git(["show", "HEAD:text.txt"])).toBe(selected);
    });

    it("publishes to a linked worktree without changing the main worktree HEAD or index", async () => {
        const linked = path.join(root, "linked");
        git(["worktree", "add", "-q", "-b", "linked-branch", linked]);
        const mainHead = git(["rev-parse", "HEAD"]);
        const mainIndex = await readFile(path.join(root, ".git/index"));
        await writeFile(path.join(linked, "text.txt"), working);
        const service = new PartialChanges(new GitExecutor(linked), linked);
        const view = await service.open("text.txt");
        await service.commit([firstBlock(view)], "linked selection", () => undefined);
        const linkedContent = execFileSync("git", ["show", "HEAD:text.txt"], {
            cwd: linked,
            encoding: "utf8",
        });
        expect(linkedContent).toBe(selected);
        expect(git(["rev-parse", "HEAD"])).toBe(mainHead);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(mainIndex);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
    });
});
