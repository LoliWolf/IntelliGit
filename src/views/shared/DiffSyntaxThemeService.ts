import * as vscode from "vscode";
import { resolveSyntaxTheme } from "../../utils/syntaxTheme";
import type { SyntaxThemeInbound } from "../../webviews/protocol/syntaxTheme";
import { logGitOpsWarning } from "../../git/operationSupport";

/** Publishes syntax-only updates without reseeding editable Diff documents or history previews. */
export class DiffSyntaxThemeService implements vscode.Disposable {
    private generation = 0;
    private disposed = false;
    private readonly disposables: vscode.Disposable[] = [];

    /** Keeps theme resolution dormant until the webview requests its first palette. */
    constructor(
        private readonly webview: vscode.Webview,
        private readonly resource?: vscode.Uri,
    ) {}

    private subscribe(): void {
        if (this.disposables.length) return;
        this.disposables.push(
            vscode.window.onDidChangeActiveColorTheme(() => {
                void this.publish();
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (
                    event.affectsConfiguration("workbench.colorTheme") ||
                    event.affectsConfiguration("workbench.colorCustomizations") ||
                    event.affectsConfiguration("editor.tokenColorCustomizations", this.resource)
                ) {
                    void this.publish();
                }
            }),
            vscode.extensions.onDidChange(() => {
                void this.publish();
            }),
        );
    }

    /** The ready handshake repeats this request after hidden or moved webviews become live. */
    async publish(): Promise<void> {
        if (this.disposed) return;
        this.subscribe();
        const generation = ++this.generation;
        let theme: SyntaxThemeInbound["theme"] = null;
        try {
            theme = await resolveSyntaxTheme(this.resource);
        } catch (error) {
            logGitOpsWarning("diffSyntaxTheme.resolve", error);
        }
        if (this.disposed || generation !== this.generation) return;
        try {
            await this.webview.postMessage({
                type: "setSyntaxTheme",
                theme,
            } satisfies SyntaxThemeInbound);
        } catch (error) {
            if (!this.disposed) logGitOpsWarning("diffSyntaxTheme.publish", error);
        }
    }

    /** Cancels pending resolutions and releases the host event subscriptions. */
    dispose(): void {
        this.disposed = true;
        this.generation++;
        for (const disposable of this.disposables) disposable.dispose();
    }
}
