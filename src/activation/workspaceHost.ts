import * as vscode from "vscode";

/** Remote agents receive their own files as file: URIs; raw remote URIs belong to the UI host. */
export function assertWorkspaceExtensionHost(context: vscode.ExtensionContext): boolean {
    const hasUntranslatedRemoteFolder = vscode.workspace.workspaceFolders?.some(
        (folder) => folder.uri.scheme === "vscode-remote",
    );
    const forcedUiHost =
        vscode.env.remoteName && context.extension?.extensionKind === vscode.ExtensionKind.UI;
    if (!hasUntranslatedRemoteFolder && !forcedUiHost) return true;
    void vscode.window.showErrorMessage(
        vscode.l10n.t(
            "IntelliGit must run on the remote workspace host. Install or enable it there and remove any remote.extensionKind UI override before running Git commands.",
        ),
    );
    return false;
}
