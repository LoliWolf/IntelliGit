import * as vscode from "vscode";
import type { GitOps } from "../git/operations";
import type { PartialChanges } from "../git/partialChanges";
import { ChangelistStore, DEFAULT_CHANGELIST_ID } from "../changes/changelistStore";
import { changeIds, validateSelection } from "../changes/selection";
import type { ChangelistReply, ChangelistOutbound } from "../webviews/protocol/changelists";
import type { SelectedFileChanges } from "../webviews/protocol/changeSelection";
import type { WorkingFile } from "../types";
import { PartialChangesPanel } from "./PartialChangesPanel";
import { assertChangeBuffersSaved } from "./changeDirtyBuffers";
import { assertRepoPathArray, assertString } from "./messageValidation";
import { commitSelectedFromPanel, runGitOperationFromPanel } from "./commitPanelActions";
import { showDiffFromPanel } from "./panelFileActions";
import { getErrorMessage } from "../utils/errors";
import { showTimedWarningMessage } from "../utils/notifications";

interface ChangeWorkflowDeps {
    root: string;
    extensionUri: vscode.Uri;
    workspaceState?: vscode.Memento;
    gitOps: GitOps;
    files(): readonly WorkingFile[];
    post(
        message: ChangelistReply | { type: "error"; repositoryRoot: string; message: string },
    ): void;
    actions: CommitPanelActionDeps;
    runCommit(operation: () => Promise<void>): Promise<void>;
}
type CommitPanelActionDeps = Parameters<typeof commitSelectedFromPanel>[0];

const COMMANDS = new Set([
    "loadChangelists",
    "changelistAction",
    "openPartialChanges",
    "commitChangelist",
]);

/** Recognizes only the additive workflow family, leaving existing panel routes unchanged. */
export function isChangeWorkflowCommand(type: string): boolean {
    return COMMANDS.has(type);
}

/** Coordinates metadata and a captured-root Git service for one provider runtime. */
export class ChangeWorkflowHost {
    private readonly store: ChangelistStore;
    private readonly partial: PartialChanges;
    private readonly unsubscribe: () => void;
    private committing = false;

    /** Shares workspace metadata while each provider retains its own root-bound Git facade. */
    constructor(private readonly deps: ChangeWorkflowDeps) {
        this.store = ChangelistStore.forStorage(deps.workspaceState);
        this.partial = deps.gitOps.partialChangesFor(deps.root);
        this.unsubscribe = this.store.subscribe((root, state) => {
            if (root === this.deps.root)
                this.deps.post({
                    type: "setChangelists",
                    repositoryRoot: root,
                    state,
                    busy: this.committing || this.store.isCommitting(root),
                    ...(this.partial.recoveryIssues().length ? { hasRecoveryIssues: true } : {}),
                });
        });
    }

    /** Releases provider delivery; already-open editors still own their captured root. */
    dispose(): void {
        this.unsubscribe();
    }

    /** Updates membership from an already acquired status snapshot without another Git scan. */
    async reconcile(files: readonly WorkingFile[]): Promise<void> {
        await this.store.reconcileFiles(
            this.deps.root,
            files.filter((file) => file.status !== "!").map((file) => file.path),
        );
        this.post();
    }

    /** Validates repository identity before metadata dialogs or Git actions. */
    async handle(raw: Record<string, unknown>): Promise<void> {
        if (raw.repositoryRoot !== this.deps.root)
            throw new Error("Unknown changelist repository.");
        try {
            const message = raw as unknown as ChangelistOutbound;
            switch (message.type) {
                case "loadChangelists": {
                    const recovered = await this.partial.recover();
                    const files = this.deps.files();
                    await this.reconcile(
                        files.length
                            ? files
                            : await this.deps.gitOps.getStatus({ withStats: false }),
                    );
                    if (recovered) await this.deps.actions.refreshData();
                    break;
                }
                case "changelistAction":
                    await this.changeList(message);
                    break;
                case "openPartialChanges":
                    this.open(assertString(message.path, "path"), message.listId);
                    break;
                case "commitChangelist":
                    await this.runCommit(() => this.commitList(message));
                    break;
            }
        } catch (error) {
            this.deps.post({
                type: "error",
                repositoryRoot: this.deps.root,
                message: vscode.l10n.t("Changelist action failed: {message}", {
                    message: getErrorMessage(error),
                }),
            });
        } finally {
            this.post();
        }
    }

    private post(): void {
        try {
            this.deps.post({
                type: "setChangelists",
                repositoryRoot: this.deps.root,
                state: this.store.get(this.deps.root),
                busy: this.committing || this.store.isCommitting(this.deps.root),
                ...(this.partial.recoveryIssues().length ? { hasRecoveryIssues: true } : {}),
            });
        } catch (error) {
            this.deps.post({
                type: "error",
                repositoryRoot: this.deps.root,
                message: vscode.l10n.t("Changelist action failed: {message}", {
                    message: getErrorMessage(error),
                }),
            });
        }
    }

    private async runCommit(operation: () => Promise<void>): Promise<void> {
        if (this.committing) throw new Error("A selected commit is already in progress.");
        this.committing = true;
        this.post();
        let release: (() => void) | undefined;
        try {
            release = await this.store.beginCommit(this.deps.root);
            await this.deps.runCommit(operation);
        } finally {
            release?.();
            this.committing = false;
            this.post();
        }
    }

    private async changeList(
        message: Extract<ChangelistOutbound, { type: "changelistAction" }>,
    ): Promise<void> {
        const revision = expectedRevision(message.revision);
        const id =
            message.action === "create" ||
            (message.action === "move" && message.listId === undefined)
                ? ""
                : assertString(message.listId, "listId");
        switch (message.action) {
            case "reviewRecovery":
                await this.reviewRecovery();
                break;
            case "create":
            case "rename": {
                const name = await vscode.window.showInputBox({
                    title:
                        message.action === "create"
                            ? vscode.l10n.t("New changelist")
                            : vscode.l10n.t("Rename changelist"),
                    value:
                        message.action === "rename"
                            ? this.store.get(this.deps.root).lists.find((list) => list.id === id)
                                  ?.name
                            : "",
                    validateInput: (value) =>
                        !value.trim() || value.length > 80
                            ? vscode.l10n.t("Enter a changelist name of 1 to 80 characters.")
                            : undefined,
                });
                if (name === undefined) return;
                if (message.action === "create")
                    await this.store.create(this.deps.root, revision, name);
                else await this.store.rename(this.deps.root, revision, id, name);
                break;
            }
            case "activate":
                await this.store.activate(this.deps.root, revision, id);
                break;
            case "resetSelection":
                await this.store.resetSelection(
                    this.deps.root,
                    revision,
                    id,
                    assertRepoPathArray(message.paths, "paths"),
                );
                break;
            case "move": {
                const paths = assertRepoPathArray(message.paths, "paths");
                const source = message.sourceListId ?? "all";
                const metadata = this.store.get(this.deps.root);
                if (
                    paths.some(
                        (file) =>
                            metadata.changes[file]?.selections?.[source] !== undefined ||
                            (source !== "all" &&
                                Object.values(metadata.changes[file]?.lines ?? {}).some(
                                    (owner) => owner !== source,
                                )),
                    )
                ) {
                    throw new Error("Move partial selections through their partial editor.");
                }
                const chosen =
                    id ||
                    (
                        await vscode.window.showQuickPick(
                            this.store
                                .get(this.deps.root)
                                .lists.map((list) => ({ label: list.name, id: list.id })),
                            { title: vscode.l10n.t("Move selected changes") },
                        )
                    )?.id;
                if (chosen) await this.store.moveFiles(this.deps.root, revision, chosen, paths);
                break;
            }
            case "remove": {
                const confirm = await vscode.window.showWarningMessage(
                    vscode.l10n.t("Remove this changelist and move its changes to Default?"),
                    { modal: true },
                    vscode.l10n.t("Remove"),
                );
                if (confirm) await this.store.remove(this.deps.root, revision, id);
                break;
            }
            default:
                throw new Error("Unknown changelist action.");
        }
    }

    /** Reviews captured-worktree records; dismissal cannot restore or mutate Git history/index. */
    private async reviewRecovery(): Promise<void> {
        await this.partial.recover();
        const chosen = await vscode.window.showQuickPick(
            this.partial.recoveryIssues().map((issue) => ({
                label: issue.id,
                description: issue.reason,
                detail: issue.commit,
                issue,
            })),
            { title: vscode.l10n.t("Review partial-index recovery") },
        );
        if (!chosen) return;
        if (chosen.issue.kind !== "quarantined") {
            showTimedWarningMessage(chosen.issue.reason);
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                "Discard this quarantined recovery record? Git history, index, worktree and locks will not change.",
            ),
            { modal: true },
            vscode.l10n.t("Discard recovery record"),
        );
        if (confirm) await this.partial.discardRecovery(chosen.issue.id);
    }

    private open(file: string, requestedList: string | undefined): void {
        const listId = requestedList ?? "all";
        new PartialChangesPanel(this.deps.extensionUri, file, {
            load: async (side) => {
                const view = await this.partial.open(file, side);
                const snapshot = this.partial.snapshot(view.snapshotId);
                if (side === "working")
                    await this.store.registerChanges(
                        this.deps.root,
                        view.path,
                        snapshot.contentId,
                        changeIds(view.blocks).length,
                    );
                const lists = this.store.get(this.deps.root);
                return { file: view, contentId: snapshot.contentId, lists, listId };
            },
            stage: async (selection) => {
                const snapshot = this.assertFileSelection(file, selection);
                if (snapshot.view.side === "working") {
                    await this.store.recordSelection(
                        this.deps.root,
                        file,
                        snapshot.contentId,
                        listId,
                        selection.lineIds,
                        changeIds(snapshot.view.blocks).length,
                    );
                }
                await this.partial.stage(selection, (files) =>
                    assertChangeBuffersSaved(this.deps.root, files),
                );
                await this.deps.actions.refreshData();
                this.deps.actions.fireWorkingTreeChanged();
            },
            use: async (selection) => {
                const snapshot = this.assertFileSelection(file, selection);
                if (snapshot.view.side !== "working")
                    throw new Error("Use a working-tree selection for the Commit panel.");
                await this.store.recordSelection(
                    this.deps.root,
                    file,
                    snapshot.contentId,
                    listId,
                    selection.lineIds,
                    changeIds(snapshot.view.blocks).length,
                );
            },
            commit: async (selection, message) => {
                const original = this.assertFileSelection(file, selection);
                const selected = new Set(selection.lineIds);
                const fingerprints = new Set(
                    original.view.blocks
                        .flatMap((block) => block.lines)
                        .filter((line) => selected.has(line.id))
                        .map((line) => line.fingerprint),
                );
                let commit = "";
                await this.runCommit(async () => {
                    await this.store.prepareCommitInclusion(
                        this.deps.root,
                        this.store.get(this.deps.root).revision,
                        listId,
                        [
                            {
                                path: file,
                                contentId: original.contentId,
                                lineIds: selection.lineIds,
                                total: changeIds(original.view.blocks).length,
                            },
                        ],
                    );
                    commit = await this.partial.commit(
                        [selection],
                        assertString(message, "message"),
                        (files) => assertChangeBuffersSaved(this.deps.root, files),
                    );
                    await this.consumeSelection([{ path: file, fingerprints }], listId);
                    await this.afterCommit();
                });
                return commit;
            },
            assign: async (selection, id, revision) => {
                const snapshot = this.assertFileSelection(file, selection);
                if (snapshot.view.side !== "working")
                    throw new Error("Assign working-tree changes, not index changes.");
                const selected = validateSelection(snapshot.view.blocks, selection.lineIds);
                const lines = snapshot.view.blocks
                    .flatMap((block) => block.lines)
                    .filter((line) => line.kind !== "context");
                await this.store.assignChanges(
                    this.deps.root,
                    expectedRevision(revision),
                    file,
                    snapshot.contentId,
                    assertString(id, "listId"),
                    lines.filter((line) => selected.has(line.id)).map((line) => line.fingerprint),
                    new Set(lines.map((line) => line.fingerprint)),
                );
            },
            openNative: () =>
                showDiffFromPanel(
                    {
                        gitOps: this.deps.gitOps,
                        getWorkspaceRoot: () => vscode.Uri.file(this.deps.root),
                        refreshData: this.deps.actions.refreshData,
                        fireWorkingTreeChanged: this.deps.actions.fireWorkingTreeChanged,
                    },
                    file,
                ),
        });
    }

    private assertFileSelection(file: string, value: SelectedFileChanges) {
        if (
            !value ||
            typeof value.snapshotId !== "string" ||
            !Array.isArray(value.lineIds) ||
            value.lineIds.length > 100_000 ||
            value.lineIds.some((id) => typeof id !== "string")
        ) {
            throw new Error("Invalid partial change selection.");
        }
        const snapshot = this.partial.snapshot(value.snapshotId);
        if (snapshot.view.path !== file)
            throw new Error("The partial editor cannot target another file.");
        validateSelection(snapshot.view.blocks, value.lineIds);
        return snapshot;
    }

    private async commitList(
        message: Extract<ChangelistOutbound, { type: "commitChangelist" }>,
    ): Promise<void> {
        const paths = assertRepoPathArray(message.paths, "paths");
        const state = this.store.get(this.deps.root);
        if (expectedRevision(message.revision) !== state.revision)
            throw new Error("Changelists changed. Refresh before committing.");
        const id = assertString(message.listId, "listId");
        if (id !== "all" && !state.lists.some((list) => list.id === id))
            throw new Error("Unknown changelist.");
        const hasPartial = paths.some(
            (file) =>
                Object.keys(state.changes[file]?.lines ?? {}).length > 0 ||
                state.changes[file]?.selections?.[id] !== undefined,
        );
        if (!hasPartial) {
            if (id !== "all" && paths.some((file) => state.files[file] !== id))
                throw new Error("The files belong to another changelist.");
            await commitSelectedFromPanel(this.deps.actions, {
                paths,
                message: assertString(message.message, "message"),
                amend: message.amend === true,
                push: message.push === true,
                rejectActiveOperation: true,
            });
            return;
        }
        if (message.amend)
            throw new Error("Partial amend requires the whole-file commit workflow.");
        const selections: SelectedFileChanges[] = [];
        const inclusions: {
            path: string;
            contentId: string;
            lineIds: string[];
            total: number;
        }[] = [];
        const consumed: { path: string; fingerprints: ReadonlySet<string> }[] = [];
        for (const file of paths) {
            const view = await this.partial.open(file);
            const snapshot = this.partial.snapshot(view.snapshotId);
            const ownership = state.changes[file];
            const inclusion = ownership?.selections?.[id];
            if (ownership && (ownership.stale || ownership.contentId !== snapshot.contentId)) {
                throw new Error("Change assignments need review. Reopen the partial editor.");
            }
            if (inclusion && inclusion.contentId !== snapshot.contentId) {
                throw new Error("The partial selection needs review. Reopen its changes.");
            }
            const included = inclusion
                ? validateSelection(view.blocks, inclusion.lineIds)
                : undefined;
            const fallback = state.files[file] ?? DEFAULT_CHANGELIST_ID;
            const lines = view.blocks
                .flatMap((block) => block.lines)
                .filter(
                    (line) =>
                        line.kind !== "context" &&
                        (!included || included.has(line.id)) &&
                        (id === "all" || (ownership?.lines[line.fingerprint] ?? fallback) === id),
                );
            if (!lines.length) throw new Error("No selected changes belong to this changelist.");
            selections.push({ snapshotId: view.snapshotId, lineIds: lines.map((line) => line.id) });
            inclusions.push({
                path: file,
                contentId: snapshot.contentId,
                lineIds: lines.map((line) => line.id),
                total: changeIds(view.blocks).length,
            });
            consumed.push({
                path: file,
                fingerprints: new Set(lines.map((line) => line.fingerprint)),
            });
        }
        if (this.store.get(this.deps.root).revision !== state.revision)
            throw new Error("Changelists changed during commit preparation.");
        const prepared = await this.store.prepareCommitInclusion(
            this.deps.root,
            state.revision,
            id,
            inclusions,
        );
        await this.partial.commit(
            selections,
            assertString(message.message, "message"),
            async (files) => {
                if (this.store.get(this.deps.root).revision !== prepared.revision) {
                    throw new Error("Changelists changed during commit preparation.");
                }
                await assertChangeBuffersSaved(this.deps.root, files);
            },
        );
        await this.consumeSelection(consumed, id);
        await this.afterCommit();
        if (message.push === true) await runGitOperationFromPanel(this.deps.actions, "push");
    }

    private async consumeSelection(
        files: readonly { path: string; fingerprints: ReadonlySet<string> }[],
        scope: string,
    ): Promise<void> {
        try {
            for (const file of files) {
                const view = await this.partial.open(file.path);
                const snapshot = this.partial.snapshot(view.snapshotId);
                const available = new Set(
                    view.blocks
                        .flatMap((block) => block.lines)
                        .filter((line) => line.kind !== "context")
                        .map((line) => line.fingerprint),
                );
                await this.store.consumeCommitted(
                    this.deps.root,
                    file.path,
                    snapshot.contentId,
                    scope,
                    file.fingerprints,
                    available,
                    changeIds(view.blocks).length,
                );
            }
        } catch (error) {
            console.error(
                "[IntelliGit] Selected commit inclusion needs review after completion:",
                error,
            );
            try {
                const message = vscode.l10n.t(
                    "Selected commit succeeded, but its selection metadata needs review. Do not retry the commit.",
                );
                showTimedWarningMessage(message);
                this.deps.post({ type: "error", repositoryRoot: this.deps.root, message });
            } catch (deliveryError) {
                console.error(
                    "[IntelliGit] Selected commit review warning could not be delivered:",
                    deliveryError,
                );
            }
        }
    }

    private async afterCommit(): Promise<void> {
        const results = await Promise.allSettled([
            this.deps.actions.postCommitted(),
            this.deps.actions.refreshData(),
            this.deps.actions.refreshGraphData?.() ?? Promise.resolve(),
        ]);
        for (const result of results) {
            if (result.status === "rejected")
                console.error("[IntelliGit] Selected commit delivery failed:", result.reason);
        }
        try {
            this.deps.actions.fireWorkingTreeChanged();
        } catch (error) {
            console.error("[IntelliGit] Selected commit refresh failed:", error);
        }
    }
}

function expectedRevision(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid changelist revision.");
    return value;
}
