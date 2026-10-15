import { GitOps } from "../../../src/git/operations";
import { GitExecutor } from "../../../src/git/executor";
import { ChangeWorkflowHost } from "../../../src/views/ChangeWorkflowHost";
import { isE2eControlChannelActive } from "../../../src/e2e/activationState";
import {
    getE2eWebviewCaptureSink,
    resetE2eWebviewCaptureSinkForTests,
} from "../../../src/e2e/webviewCapture";
import type { PlaceholderRoots } from "../../fixtures/repo/placeholderCanonicalization";
import { createFakeExtensionUri } from "./commitInfoVscodeDouble";
import { getCreatedWebviewPanels, resetCreatedWebviewPanelsForTests } from "./webviewPanelDouble";
import {
    resetFakeWorkspaceConfigurationForTests,
    setFakeWorkspaceConfiguration,
} from "./workspaceConfigurationDouble";
import { toGitEnvironment } from "./recordingGitEnvironment";
import { canonicalizeCapturedMessages } from "./canonicalizeCapturedMessages";
import { buildWebviewFixture } from "./webviewFixtureFile";
import type { WebviewFixture } from "./webviewFixtureTypes";

/** Drives the production fixed-file host against ordinary modifications in a real dirty repository. */
export async function recordPartialChangesWebviewFixture(options: {
    repoRoot: string;
    roots: PlaceholderRoots;
    env: NodeJS.ProcessEnv;
}): Promise<WebviewFixture> {
    if (!isE2eControlChannelActive())
        throw new Error("Partial fixture capture requires the E2E gate.");
    resetE2eWebviewCaptureSinkForTests();
    resetCreatedWebviewPanelsForTests();
    resetFakeWorkspaceConfigurationForTests();
    const gitOps = new GitOps(
        new GitExecutor(options.repoRoot, undefined, toGitEnvironment(options.env)),
    );
    const files = await gitOps.getStatus({ withStats: false });
    const modified = files.find((file) => file.status === "M" && !file.staged);
    if (!modified) throw new Error("Partial fixture requires an ordinary modified file.");
    const unexpectedMutation = async (): Promise<void> => {
        throw new Error("Partial fixture recording must not mutate Git.");
    };
    const host = new ChangeWorkflowHost({
        root: options.repoRoot,
        extensionUri: createFakeExtensionUri(),
        gitOps,
        files: () => files,
        post: (message) => {
            if (message.type === "error") throw new Error(message.message);
        },
        actions: {
            gitOps,
            refreshData: unexpectedMutation,
            postCommitted: unexpectedMutation,
            fireWorkingTreeChanged: () => {
                throw new Error("Partial fixture cannot refresh mutations.");
            },
            maybeOfferPublishBranch: unexpectedMutation,
        },
        runCommit: unexpectedMutation,
    });
    try {
        setFakeWorkspaceConfiguration({ "editor.fontSize": 14 });
        await host.handle({
            type: "openPartialChanges",
            repositoryRoot: options.repoRoot,
            path: modified.path,
        });
        const panels = getCreatedWebviewPanels();
        if (panels.length !== 1)
            throw new Error("Partial recorder expected one production editor.");
        await panels[0].receiveMessage({ type: "ready" });
        const messages =
            getE2eWebviewCaptureSink()
                ?.getMessages()
                .filter((message) => message.contextId === "partial-changes") ?? [];
        if (
            !messages.some(
                (message) =>
                    typeof message.message === "object" &&
                    message.message !== null &&
                    "type" in message.message &&
                    message.message.type === "partialFile",
            )
        ) {
            throw new Error("Partial recorder did not receive a production snapshot.");
        }
        return buildWebviewFixture(
            "partial-changes",
            "dirty",
            canonicalizeCapturedMessages(messages, options.roots, [
                { path: ["file", "snapshotId"], placeholder: "a".repeat(64) },
            ]),
        );
    } finally {
        host.dispose();
        for (const panel of getCreatedWebviewPanels()) panel.dispose();
        resetCreatedWebviewPanelsForTests();
        resetE2eWebviewCaptureSinkForTests();
        resetFakeWorkspaceConfigurationForTests();
    }
}
