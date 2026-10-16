import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, chmod, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    createCommitInfoVscodeDouble,
    createFakeExtensionUri,
} from "../../visual/recorder/commitInfoVscodeDouble";
vi.mock("vscode", () => {
    const double = createCommitInfoVscodeDouble();
    Object.defineProperty(double, "ProgressLocation", {
        value: { Notification: 15 },
        configurable: true,
    });
    Object.defineProperty(double.workspace, "textDocuments", { value: [] });
    Object.defineProperty(double.workspace, "notebookDocuments", { value: [] });
    Object.defineProperty(double.window, "showWarningMessage", {
        value: vi.fn().mockResolvedValue(undefined),
        configurable: true,
    });
    Object.defineProperty(double.window, "showQuickPick", {
        value: vi.fn().mockResolvedValue(undefined),
        configurable: true,
    });
    Object.defineProperty(double.window, "showInputBox", {
        value: vi.fn().mockResolvedValue(undefined),
        configurable: true,
    });
    Object.defineProperty(double.window, "showSaveDialog", {
        value: vi.fn().mockResolvedValue(undefined),
        configurable: true,
    });
    Object.defineProperty(double.workspace, "fs", {
        value: { writeFile: vi.fn(async () => undefined) },
        configurable: true,
    });
    Object.defineProperty(double.window, "showInformationMessage", {
        value: vi.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(double.window, "withProgress", {
        value: async (_options: unknown, task: () => Promise<unknown>) => task(),
    });
    Object.defineProperty(double.l10n, "t", {
        value: (message: string, values: Record<string, string> = {}) =>
            message.replace(/\{([^}]+)\}/g, (match, key: string) => values[key] ?? match),
    });
    return double;
});
import { ChangeWorkflowHost } from "../../../src/views/ChangeWorkflowHost";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { PartialChanges } from "../../../src/git/partialChanges";
import { PartialIndexPublicationError } from "../../../src/git/partialIndexTransaction";
import * as vscode from "vscode";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { changeIds } from "../../../src/changes/selection";
import {
    getCreatedWebviewPanels,
    resetCreatedWebviewPanelsForTests,
} from "../../visual/recorder/webviewPanelDouble";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import type { PartialEditorReply } from "../../../src/webviews/protocol/changelists";
import type { ShelfService } from "../../../src/services/shelfService";
import { createSecondService } from "../../integration/shelf/shelfTestHarness";
import { writeSelectedPatch } from "../../../src/views/selectedPatchExport";

let root: string;
let gitOps: GitOps;
let host: ChangeWorkflowHost;
let store: ChangelistStore;
let posted: unknown[];
let shelfService: ShelfService | undefined;
let baselineHead: string;
let persistenceFailure: "none" | "before" | "after";
let values: Map<string, unknown>;
let storage: {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Promise<void>;
};
const base = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join("");
const first = base.replace("line 20\n", "selected\n");
const working = first.replace("line 80\n", "remaining\n");
const delivered = vi.fn();
function git(args: string[]) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}
beforeEach(async () => {
    shelfService = undefined;
    vi.mocked(vscode.window.showInputBox).mockReset().mockResolvedValue(undefined);
    vi.mocked(vscode.window.showSaveDialog).mockReset().mockResolvedValue(undefined);
    vi.mocked(vscode.window.showWarningMessage).mockReset().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.fs.writeFile).mockClear();
    root = await mkdtemp(path.join(tmpdir(), "intelligit-change-host-"));
    git(["init", "-q"]);
    git(["config", "user.name", "Host"]);
    git(["config", "user.email", "host@example.invalid"]);
    git(["config", "commit.gpgSign", "false"]);
    await writeFile(path.join(root, "file.txt"), base);
    git(["add", "--", "file.txt"]);
    git(["commit", "-qm", "base"]);
    baselineHead = git(["rev-parse", "HEAD"]);
    persistenceFailure = "none";
    await writeFile(path.join(root, "file.txt"), working);
    gitOps = new GitOps(new GitExecutor(root));
    values = new Map<string, unknown>();
    storage = {
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
            if (
                persistenceFailure === "before" ||
                (persistenceFailure === "after" && git(["rev-parse", "HEAD"]) !== baselineHead)
            )
                throw new Error("injected metadata storage failure");
            values.set(key, structuredClone(value));
        },
    };
    store = ChangelistStore.forStorage(storage);
    const files = await gitOps.getStatus({ withStats: false });
    posted = [];
    delivered.mockClear();
    resetCreatedWebviewPanelsForTests();
    host = new ChangeWorkflowHost({
        root,
        extensionUri: createFakeExtensionUri(),
        gitOps,
        get shelfService() {
            return shelfService;
        },
        workspaceState: storage,
        files: () => files,
        post: (message) => posted.push(message),
        actions: {
            gitOps,
            refreshData: async () => undefined,
            postCommitted: delivered,
            fireWorkingTreeChanged: () => undefined,
            maybeOfferPublishBranch: async () => undefined,
        },
        postScopedCommit: delivered,
        runCommit: (operation) => operation(),
    });
    await host.reconcile(files);
});
afterEach(async () => {
    vi.restoreAllMocks();
    (vscode.workspace.textDocuments as vscode.TextDocument[]).length = 0;
    host?.dispose();
    for (const panel of getCreatedWebviewPanels()) panel.dispose();
    resetCreatedWebviewPanelsForTests();
    await removeScratchDirectories(root);
});
async function partialEditor() {
    await host.handle({ type: "openPartialChanges", repositoryRoot: root, path: "file.txt" });
    const panel = getCreatedWebviewPanels()[0];
    const messages: PartialEditorReply[] = [];
    panel.webview.postMessage = (message: unknown) => {
        messages.push(message as PartialEditorReply);
        return Promise.resolve(true);
    };
    await panel.receiveMessage({ type: "ready" });
    const data = messages.find((message) => message.type === "partialFile");
    if (!data || data.type !== "partialFile") throw new Error("Missing partial snapshot");
    return {
        panel,
        messages,
        selection: {
            snapshotId: data.file.snapshotId,
            lineIds: changeIds(data.file.blocks.slice(0, 1)),
        },
    };
}

describe("root-bound selected-change host", () => {
    it("cancels native rollback before shelf, metadata or Git writes", async () => {
        shelfService = (
            await createSecondService(root, path.join(root, ".git/selected-shelf-storage"))
        ).service;
        const { panel, selection, messages } = await partialEditor();
        const before = store.get(root);
        await panel.receiveMessage({ type: "selectedOperation", operation: "rollback", selection });
        expect(messages.some((message) => message.type === "partialCanceled")).toBe(true);
        expect((await shelfService.listShelves()).shelfIds).toEqual([]);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(store.get(root).changes).toEqual(before.changes);
    });

    it.each(["save", "shelve", "rollback"] as const)(
        "runs selected %s with a durable shelf and keeps the remaining content",
        async (operation) => {
            shelfService = (
                await createSecondService(root, path.join(root, ".git/selected-shelf-storage"))
            ).service;
            vi.mocked(vscode.window.showInputBox).mockResolvedValue("Selected shelf");
            vi.mocked(vscode.window.showWarningMessage).mockImplementation(
                async (_text, _options, action) => action as string,
            );
            const { panel, selection, messages } = await partialEditor();
            await panel.receiveMessage({ type: "selectedOperation", operation, selection });
            expect(
                messages.some(
                    (message) =>
                        message.type === "partialOperationCompleted" &&
                        message.operation === operation,
                ),
            ).toBe(true);
            expect((await shelfService.listShelves()).shelfIds).toHaveLength(1);
            expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(
                operation === "save" ? working : base.replace("line 80\n", "remaining\n"),
            );
            expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
            expect(git(["show", ":file.txt"])).toBe(base);
            expect(delivered).not.toHaveBeenCalled();
        },
    );

    it("does not remove changes when durable shelf publication fails", async () => {
        shelfService = (
            await createSecondService(root, path.join(root, ".git/selected-shelf-storage"))
        ).service;
        vi.spyOn(shelfService, "saveSelectedChanges").mockRejectedValue(
            new Error("shelf disk failure"),
        );
        vi.mocked(vscode.window.showWarningMessage).mockImplementation(
            async (_text, _options, action) => action as string,
        );
        const { panel, selection, messages } = await partialEditor();
        const metadata = store.get(root);
        await panel.receiveMessage({ type: "selectedOperation", operation: "rollback", selection });
        expect(messages.findLast((message) => message.type === "partialError")).toMatchObject({
            message: expect.stringContaining("shelf disk failure"),
        });
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(store.get(root)).toEqual(metadata);
    });

    it("reports a completed operation separately from a post-operation view failure", async () => {
        shelfService = (
            await createSecondService(root, path.join(root, ".git/selected-shelf-storage"))
        ).service;
        vi.mocked(vscode.window.showInputBox).mockResolvedValue("Saved selection");
        const { panel, selection, messages } = await partialEditor();
        vi.spyOn(PartialChanges.prototype, "open").mockRejectedValueOnce(
            new Error("reload read failed"),
        );
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await panel.receiveMessage({ type: "selectedOperation", operation: "save", selection });
        expect(messages.some((message) => message.type === "partialOperationCompleted")).toBe(true);
        expect(messages.findLast((message) => message.type === "partialError")).toMatchObject({
            reloadRequired: true,
            message: expect.stringContaining("operation completed"),
        });
        expect(messages.at(-1)?.type).toBe("partialReady");
        expect((await shelfService.listShelves()).shelfIds).toHaveLength(1);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
    });

    it("keeps the saved copy and prior inclusion when a foreign index lock refuses removal", async () => {
        shelfService = (
            await createSecondService(root, path.join(root, ".git/selected-shelf-storage"))
        ).service;
        const save = shelfService.saveSelectedChanges.bind(shelfService);
        vi.spyOn(shelfService, "saveSelectedChanges").mockImplementation(async (...args) => {
            const result = await save(...args);
            await writeFile(path.join(root, ".git/index.lock"), "foreign owner");
            return result;
        });
        vi.mocked(vscode.window.showWarningMessage).mockImplementation(
            async (_text, _options, action) => action as string,
        );
        const { panel, selection, messages } = await partialEditor();
        const previous = store.get(root).changes;
        await panel.receiveMessage({ type: "selectedOperation", operation: "rollback", selection });
        expect(messages.some((message) => message.type === "partialError")).toBe(true);
        expect(store.get(root).changes).toEqual(previous);
        expect(await readFile(path.join(root, ".git/index.lock"), "utf8")).toBe("foreign owner");
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect((await shelfService.listShelves()).shelfIds).toHaveLength(1);
    });

    it("exports only through the native Save destination and never accepts a browser path", async () => {
        const { panel, selection, messages } = await partialEditor();
        const output = {
            ...vscode.Uri.file(path.join(root, "chosen.patch")),
            scheme: "file",
        } as vscode.Uri;
        vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(output);
        await panel.receiveMessage({
            type: "selectedOperation",
            operation: "export",
            selection,
            path: "/forged",
        });
        expect(messages.filter((message) => message.type === "partialError")).toEqual([]);
        expect(messages.some((message) => message.type === "partialOperationCompleted")).toBe(true);
        expect(await readFile(output.fsPath, "utf8")).toContain("+selected");
        expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
    });

    it("does not overwrite source bytes when a chosen patch file is a hardlink alias", async () => {
        const { panel, selection, messages } = await partialEditor();
        const alias = path.join(root, "alias.patch");
        await link(path.join(root, "file.txt"), alias);
        vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({
            ...vscode.Uri.file(alias),
            scheme: "file",
        } as vscode.Uri);
        await panel.receiveMessage({ type: "selectedOperation", operation: "export", selection });
        expect(messages.some((message) => message.type === "partialOperationCompleted")).toBe(true);
        expect(await readFile(alias, "utf8")).toContain("+selected");
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
    });

    it("protects a dirty native buffer even when its chosen export file does not exist yet", async () => {
        const { panel, selection, messages } = await partialEditor();
        const output = path.join(root, "new.patch");
        const uri = { ...vscode.Uri.file(output), scheme: "file" } as vscode.Uri;
        (vscode.workspace.textDocuments as unknown as { isDirty: boolean; uri: vscode.Uri }[]).push(
            { isDirty: true, uri },
        );
        vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(uri);
        await panel.receiveMessage({ type: "selectedOperation", operation: "export", selection });
        expect(messages.findLast((message) => message.type === "partialError")).toMatchObject({
            message: expect.stringContaining("Save the native editor"),
        });
        await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
    });

    it("refuses an untranslated remote export URI rather than writing its path on the wrong host", async () => {
        const { panel, selection, messages } = await partialEditor();
        vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({
            ...vscode.Uri.file(path.join(root, "file.txt")),
            scheme: "vscode-remote",
        } as vscode.Uri);
        await panel.receiveMessage({ type: "selectedOperation", operation: "export", selection });
        expect(messages.findLast((message) => message.type === "partialError")).toMatchObject({
            message: expect.stringContaining("native filesystem"),
        });
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    });

    it("preserves a concurrently changed export destination instead of replacing it", async () => {
        const partial = new PartialChanges(new GitExecutor(root), root);
        const view = await partial.open("file.txt");
        const snapshot = partial.snapshot(view.snapshotId);
        const output = path.join(root, "existing.patch");
        await writeFile(output, "previous");
        let checks = 0;
        await expect(
            writeSelectedPatch(
                { scheme: "file", fsPath: output },
                snapshot,
                Buffer.from("selected patch"),
                async () => {
                    if (++checks === 2) await writeFile(output, "newer external patch");
                },
            ),
        ).rejects.toThrow("destination changed");
        expect(await readFile(output, "utf8")).toBe("newer external patch");
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
    });

    it("refuses a directory alias into Git metadata before exporting a patch", async () => {
        const { panel, selection, messages } = await partialEditor();
        const alias = path.join(root, "metadata-alias");
        await symlink(
            path.join(root, ".git"),
            alias,
            process.platform === "win32" ? "junction" : "dir",
        );
        const index = await readFile(path.join(root, ".git/index"));
        vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({
            ...vscode.Uri.file(path.join(alias, "index")),
            scheme: "file",
        } as vscode.Uri);
        await panel.receiveMessage({ type: "selectedOperation", operation: "export", selection });
        expect(messages.findLast((message) => message.type === "partialError")).toMatchObject({
            message: expect.stringContaining("Git metadata"),
        });
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it("requires native amend confirmation and leaves drafts on cancellation", async () => {
        const { panel, selection, messages } = await partialEditor();
        await panel.receiveMessage({
            type: "commitSelection",
            amend: true,
            selection,
            message: "changed",
        });
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
        expect(messages.some((message) => message.type === "partialCanceled")).toBe(true);
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Amend selected changes");
        const parents = git(["show", "-s", "--format=%P", "HEAD"]);
        await panel.receiveMessage({
            type: "commitSelection",
            amend: true,
            selection,
            message: "changed",
        });
        expect(messages.some((message) => message.type === "partialCommitted")).toBe(true);
        expect(git(["show", "-s", "--format=%P", "HEAD"])).toBe(parents);
        expect(git(["show", "HEAD:file.txt"])).toBe(first);
    });

    it.each([false, true])(
        "restores staging inclusion after a dirty-buffer refusal and later commits the prior choice (existing=%s)",
        async (existing) => {
            const { panel, selection, messages } = await partialEditor();
            if (existing) {
                const data = messages.find((message) => message.type === "partialFile");
                if (!data || data.type !== "partialFile") throw new Error("Missing snapshot");
                await panel.receiveMessage({
                    type: "useSelection",
                    selection: {
                        snapshotId: data.file.snapshotId,
                        lineIds: changeIds(data.file.blocks.slice(1)),
                    },
                });
            }
            const before = store.get(root).changes["file.txt"].selections;
            const index = await readFile(path.join(root, ".git/index"));
            (vscode.workspace.textDocuments as vscode.TextDocument[]).push({
                uri: { scheme: "file", fsPath: path.join(root, "file.txt") },
                isDirty: true,
            } as vscode.TextDocument);
            await panel.receiveMessage({ type: "stageSelection", selection });
            expect(messages).toContainEqual(
                expect.objectContaining({
                    type: "partialError",
                    message: expect.stringContaining("Save the native editor"),
                }),
            );
            expect(store.get(root).changes["file.txt"].selections).toEqual(before);
            expect(new ChangelistStore(storage).get(root).changes["file.txt"].selections).toEqual(
                before,
            );
            expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
            expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
            (vscode.workspace.textDocuments as vscode.TextDocument[]).length = 0;
            await host.handle({
                type: "commitChangelist",
                repositoryRoot: root,
                revision: store.get(root).revision,
                listId: "all",
                paths: ["file.txt"],
                message: "original inclusion after refused staging",
            });
            expect(git(["show", "HEAD:file.txt"])).toBe(
                existing ? base.replace("line 80\n", "remaining\n") : working,
            );
        },
    );

    it.each(["empty", "foreign lock"] as const)(
        "does not keep a staging inclusion after %s refusal",
        async (refusal) => {
            const { panel, selection, messages } = await partialEditor();
            const before = store.get(root).changes["file.txt"].selections;
            const index = await readFile(path.join(root, ".git/index"));
            const lock = path.join(root, ".git/index.lock");
            if (refusal === "foreign lock") await writeFile(lock, "foreign owner");
            await panel.receiveMessage({
                type: "stageSelection",
                selection: { ...selection, lineIds: refusal === "empty" ? [] : selection.lineIds },
            });
            expect(messages).toContainEqual(expect.objectContaining({ type: "partialError" }));
            expect(store.get(root).changes["file.txt"].selections).toEqual(before);
            expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
            expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
            expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
            if (refusal === "foreign lock")
                expect(await readFile(lock, "utf8")).toBe("foreign owner");
        },
    );

    it("refuses staging before changing the index when inclusion cannot be persisted", async () => {
        const { panel, selection, messages } = await partialEditor();
        const index = await readFile(path.join(root, ".git/index"));
        persistenceFailure = "before";
        await panel.receiveMessage({ type: "stageSelection", selection });
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining("metadata storage"),
            }),
        );
        expect(store.get(root).changes["file.txt"].selections).toBeUndefined();
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it("keeps staging inclusion when a published index needs recovery", async () => {
        const { panel, selection, messages } = await partialEditor();
        const original = PartialChanges.prototype.stage;
        vi.spyOn(PartialChanges.prototype, "stage").mockImplementation(async function (
            this: PartialChanges,
            ...args
        ) {
            await original.apply(this, args);
            throw new PartialIndexPublicationError("index durability needs recovery");
        });
        await panel.receiveMessage({ type: "stageSelection", selection });
        expect(git(["show", ":file.txt"])).toBe(first);
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
        expect(store.get(root).changes["file.txt"].selections?.all.lineIds).toEqual(
            selection.lineIds,
        );
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining("durability"),
            }),
        );
    });

    it("warns and retains staging inclusion when rollback persistence fails", async () => {
        const { panel, selection, messages } = await partialEditor();
        vi.spyOn(PartialChanges.prototype, "stage").mockImplementation(async () => {
            persistenceFailure = "before";
            throw new Error("staging refused");
        });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await panel.receiveMessage({ type: "stageSelection", selection });
        expect(git(["show", ":file.txt"])).toBe(base);
        expect(store.get(root).changes["file.txt"].selections?.all.lineIds).toEqual(
            selection.lineIds,
        );
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("selection metadata could not be restored"),
            }),
        );
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining("staging refused"),
            }),
        );
    });

    it("holds the shared metadata lease while staging and releases it on failure", async () => {
        const { panel, selection } = await partialEditor();
        vi.spyOn(PartialChanges.prototype, "stage").mockImplementation(async () => {
            expect(store.isCommitting(root)).toBe(true);
            await expect(
                store.resetSelection(root, store.get(root).revision, "all", ["file.txt"]),
            ).rejects.toThrow("cannot change");
            throw new Error("staging refused");
        });
        await panel.receiveMessage({ type: "stageSelection", selection });
        expect(store.isCommitting(root)).toBe(false);
        expect(store.get(root).changes["file.txt"].selections).toBeUndefined();
    });

    it.each([false, true])(
        "restores prior inclusion after a rejected hook (existing=%s)",
        async (existing) => {
            const { panel, selection, messages } = await partialEditor();
            if (existing) {
                const file = messages.find((message) => message.type === "partialFile");
                if (!file || file.type !== "partialFile") throw new Error("Missing snapshot");
                await panel.receiveMessage({
                    type: "useSelection",
                    selection: {
                        snapshotId: file.file.snapshotId,
                        lineIds: changeIds(file.file.blocks.slice(1)),
                    },
                });
            }
            const before = store.get(root).changes["file.txt"].selections;
            const hook = path.join(root, ".git/hooks/pre-commit");
            await writeFile(hook, "#!/bin/sh\nexit 1\n");
            await chmod(hook, 0o755);
            await panel.receiveMessage({
                type: "commitSelection",
                selection,
                message: "hook rejection",
            });
            expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
            expect(store.get(root).changes["file.txt"].selections).toEqual(before);
            expect(messages).toContainEqual(expect.objectContaining({ type: "partialError" }));
        },
    );

    it("does not restore old inclusion after actual publication even if HEAD was reset back", async () => {
        const { panel, selection, messages } = await partialEditor();
        const original = GitExecutor.prototype.runBinary;
        vi.spyOn(GitExecutor.prototype, "runBinary").mockImplementation(async function (
            this: GitExecutor,
            args,
            options,
        ) {
            const result = await original.call(this, args, options);
            if (args[0] === "update-ref") git(["update-ref", args[3], args[5], args[4]]);
            return result;
        });
        await panel.receiveMessage({
            type: "commitSelection",
            selection,
            message: "published then reset",
        });
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
        expect(store.get(root).changes["file.txt"].selections?.all.lineIds).toEqual(
            selection.lineIds,
        );
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining("commit succeeded"),
            }),
        );
    });

    it("retains a fence when ref publication cannot be confirmed", async () => {
        const { panel, selection, messages } = await partialEditor();
        const original = GitExecutor.prototype.runBinary;
        vi.spyOn(GitExecutor.prototype, "runBinary").mockImplementation(function (
            this: GitExecutor,
            args,
            options,
        ) {
            if (args[0] === "update-ref")
                return Promise.reject(new Error("publication transport interrupted"));
            return original.call(this, args, options);
        });
        await panel.receiveMessage({
            type: "commitSelection",
            selection,
            message: "uncertain publication",
        });
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
        expect(store.get(root).changes["file.txt"].selections?.all.lineIds).toEqual(
            selection.lineIds,
        );
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining("could not be confirmed"),
            }),
        );
    });
    it("rejects an oversized partial commit before opening its file snapshots", async () => {
        const { panel, selection } = await partialEditor();
        await panel.receiveMessage({ type: "useSelection", selection });
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: store.get(root).revision,
            listId: "all",
            paths: ["file.txt", ...Array.from({ length: 64 }, (_, i) => `missing-${i}.txt`)],
            message: "too many files",
        });
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("1 to 64 text files"),
            }),
        );
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });
    it("routes pending sidebar inclusion through real Git and does not commit the remainder twice", async () => {
        const { panel, selection } = await partialEditor();
        await panel.receiveMessage({ type: "useSelection", selection });
        const revision = store.get(root).revision;
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision,
            listId: "all",
            paths: ["file.txt"],
            message: "selected only",
        });
        expect(git(["show", "HEAD:file.txt"])).toBe(first);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(delivered).toHaveBeenCalledTimes(1);
        const state = store.get(root);
        expect(state.changes["file.txt"].selections?.all.lineIds).toEqual([]);
        const head = git(["rev-parse", "HEAD"]);
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: state.revision,
            listId: "all",
            paths: ["file.txt"],
            message: "must not commit remainder",
        });
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("No selected changes"),
            }),
        );
    });

    it("rejects another repository, stale revisions and a forged editor selection", async () => {
        await expect(
            host.handle({ type: "loadChangelists", repositoryRoot: "/unknown" }),
        ).rejects.toThrow("Unknown");
        const head = git(["rev-parse", "HEAD"]);
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: 0,
            listId: "all",
            paths: ["file.txt"],
            message: "stale",
        });
        const { panel, messages } = await partialEditor();
        await panel.receiveMessage({
            type: "stageSelection",
            selection: { snapshotId: "forged", lineIds: ["0:1"] },
        });
        expect(messages).toContainEqual(expect.objectContaining({ type: "partialError" }));
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(git(["show", ":file.txt"])).toBe(base);
    });

    it("fences duplicate editor commits and retains drafts after a failed action", async () => {
        const { panel, messages, selection } = await partialEditor();
        await panel.receiveMessage({ type: "commitSelection", selection, message: "" });
        expect(messages).toContainEqual(expect.objectContaining({ type: "partialError" }));
        await panel.receiveMessage({ type: "commitSelection", selection, message: "one commit" });
        expect(messages).toContainEqual(expect.objectContaining({ type: "partialCommitted" }));
        const head = git(["rev-parse", "HEAD"]);
        await panel.receiveMessage({ type: "commitSelection", selection, message: "duplicate" });
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(delivered).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
        "does not change working inclusion when unstaging index lines (saved=%s)",
        async (saved) => {
            git(["add", "--", "file.txt"]);
            const { panel, selection, messages } = await partialEditor();
            if (saved) await panel.receiveMessage({ type: "useSelection", selection });
            const before = store.get(root);
            await panel.receiveMessage({ type: "ready", side: "index" });
            const indexed = messages.findLast((message) => message.type === "partialFile");
            if (!indexed || indexed.type !== "partialFile")
                throw new Error("Missing index snapshot");
            await panel.receiveMessage({
                type: "stageSelection",
                selection: {
                    snapshotId: indexed.file.snapshotId,
                    lineIds: changeIds(indexed.file.blocks.slice(0, 1)),
                },
            });
            expect(store.get(root)).toEqual(before);
            expect(git(["show", ":file.txt"])).toBe(base.replace("line 80\n", "remaining\n"));
            await host.handle({
                type: "commitChangelist",
                repositoryRoot: root,
                revision: before.revision,
                listId: "all",
                paths: ["file.txt"],
                message: "commit after unstage",
            });
            expect(posted).not.toContainEqual(expect.objectContaining({ type: "error" }));
            expect(git(["show", "HEAD:file.txt"])).toBe(saved ? first : working);
        },
    );

    it("refuses publication if the pre-commit inclusion fence cannot be persisted", async () => {
        const { panel, selection, messages } = await partialEditor();
        const index = await readFile(path.join(root, ".git/index"));
        persistenceFailure = "before";
        await panel.receiveMessage({
            type: "commitSelection",
            selection,
            message: "must not publish",
        });
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining("metadata storage"),
            }),
        );
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(delivered).not.toHaveBeenCalled();
    });

    it("keeps a durable partial fence after a committed selection cannot be consumed", async () => {
        const { panel, selection, messages } = await partialEditor();
        const before = store.get(root);
        expect(before.changes["file.txt"].selections).toBeUndefined();
        persistenceFailure = "after";
        await panel.receiveMessage({
            type: "commitSelection",
            selection,
            message: "published once",
        });
        expect(messages).toContainEqual(expect.objectContaining({ type: "partialCommitted" }));
        expect(git(["show", "HEAD:file.txt"])).toBe(first);
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("commit succeeded"),
            }),
        );
        const persisted = new ChangelistStore(storage).get(root);
        expect(persisted.changes["file.txt"].selections?.all.lineIds).toEqual(selection.lineIds);
        const head = git(["rev-parse", "HEAD"]);
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: store.get(root).revision,
            listId: "all",
            paths: ["file.txt"],
            message: "must not include remainder",
        });
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(delivered).toHaveBeenCalledTimes(1);
    });
});
