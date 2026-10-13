import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { PartialEditorOutbound, PartialEditorReply } from "../webviews/protocol/changelists";
import type {
    ChangeFileView,
    ChangelistState,
    SelectedFileChanges,
} from "../webviews/protocol/changeSelection";
import { buildWebviewShellHtml } from "./webviewHtml";
import { captureWebview } from "../e2e/webviewCapture";
import { assertMessage } from "./messageValidation";
import { getErrorMessage } from "../utils/errors";

/** Captured-root operations injected by the owning Changes workflow. */
export interface PartialPanelActions {
    load(side: "working" | "index"): Promise<{
        file: ChangeFileView;
        contentId: string;
        lists: ChangelistState;
        listId: string;
    }>;
    stage(selection: SelectedFileChanges): Promise<void>;
    use(selection: SelectedFileChanges): Promise<void>;
    commit(selection: SelectedFileChanges, message: string): Promise<string>;
    assign(selection: SelectedFileChanges, listId: string, revision: number): Promise<void>;
    openNative(): Promise<void>;
}

/** Owns one fixed file session; its browser never supplies Git arguments or paths. */
export class PartialChangesPanel {
    private busy = false;
    private committed = false;
    private alive = true;
    private readonly panel: vscode.WebviewPanel;
    private side: "working" | "index" = "working";

    /** Creates the usable partial editor with the existing production shell and E2E boundary. */
    constructor(
        extensionUri: vscode.Uri,
        file: string,
        private readonly actions: PartialPanelActions,
    ) {
        const rawPanel = vscode.window.createWebviewPanel(
            "intelligit.partialChanges",
            vscode.l10n.t("Selected changes: {path}", { path: file }),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
            },
        );
        this.panel = captureWebview(rawPanel, "partial-changes");
        this.panel.webview.html = buildWebviewShellHtml({
            webview: this.panel.webview,
            extensionUri,
            scriptFile: "webview-partialchanges.js",
            styleFiles: ["webview-partialchanges.css"],
            title: this.panel.title,
            backgroundVar: "var(--vscode-editor-background)",
            e2eViewId: `partial-changes:${randomUUID()}`,
        });
        this.panel.onDidDispose(() => {
            this.alive = false;
        });
        this.panel.webview.onDidReceiveMessage((raw: unknown) => {
            return this.handle(raw).catch((error: unknown) =>
                this.post({
                    type: "partialError",
                    message: vscode.l10n.t("Selected changes failed: {message}", {
                        message: getErrorMessage(error),
                    }),
                }),
            );
        });
    }

    private async handle(raw: unknown): Promise<void> {
        const message = assertMessage(raw) as unknown as PartialEditorOutbound;
        if (this.busy || this.committed) return;
        if (message.type === "openNative") return this.actions.openNative();
        if (message.type === "ready") {
            if (
                message.side !== undefined &&
                message.side !== "working" &&
                message.side !== "index"
            )
                return;
            this.side = message.side ?? this.side;
            return this.load();
        }
        if (
            !["stageSelection", "commitSelection", "assignSelection", "useSelection"].includes(
                message.type,
            )
        )
            return;
        this.busy = true;
        try {
            if (message.type === "useSelection") {
                await this.actions.use(message.selection);
                await this.load();
            } else if (message.type === "assignSelection") {
                await this.actions.assign(message.selection, message.listId, message.revision);
                await this.load();
            } else if (message.type === "stageSelection") {
                await this.actions.stage(message.selection);
                await this.post({ type: "partialStaged" });
                await this.load();
            } else if (message.type === "commitSelection") {
                const commit = await this.actions.commit(message.selection, message.message);
                this.committed = true;
                await this.post({ type: "partialCommitted", commit });
            }
        } finally {
            this.busy = false;
        }
    }

    private async load(): Promise<void> {
        const data = await this.actions.load(this.side);
        await this.post({ type: "partialFile", ...data });
    }

    private async post(message: PartialEditorReply): Promise<void> {
        if (this.alive) await this.panel.webview.postMessage(message);
    }
}
