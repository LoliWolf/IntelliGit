import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    folders: [] as Array<{ uri: { scheme: string } }>,
    remoteName: undefined as string | undefined,
    error: vi.fn(),
}));
vi.mock("vscode", () => ({
    workspace: {
        get workspaceFolders() {
            return mocks.folders;
        },
    },
    env: {
        get remoteName() {
            return mocks.remoteName;
        },
    },
    ExtensionKind: { UI: 1, Workspace: 2 },
    window: { showErrorMessage: mocks.error },
    l10n: { t: (message: string) => message },
}));
import { assertWorkspaceExtensionHost } from "../../../src/activation/workspaceHost";
import type { ExtensionContext } from "vscode";

beforeEach(() => {
    mocks.folders = [{ uri: { scheme: "file" } }];
    mocks.remoteName = undefined;
    mocks.error.mockClear();
});

describe("native Git execution host", () => {
    it("allows normal local workspace activation", () => {
        expect(assertWorkspaceExtensionHost({} as ExtensionContext)).toBe(true);
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it.each(["ssh-remote", "wsl", "dev-container"])(
        "allows translated agent-side file URIs for %s",
        (remoteName) => {
            mocks.remoteName = remoteName;
            expect(
                assertWorkspaceExtensionHost({
                    extension: { extensionKind: 2 },
                } as ExtensionContext),
            ).toBe(true);
            expect(mocks.error).not.toHaveBeenCalled();
        },
    );

    it("refuses UI-side remote folders before a same-path local clone can be discovered", () => {
        mocks.folders = [{ uri: { scheme: "vscode-remote" } }];
        expect(assertWorkspaceExtensionHost({} as ExtensionContext)).toBe(false);
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("remote workspace host"));
    });

    it("refuses a forced UI extension host even before a remote folder opens", () => {
        mocks.folders = [];
        mocks.remoteName = "ssh-remote";
        expect(
            assertWorkspaceExtensionHost({ extension: { extensionKind: 1 } } as ExtensionContext),
        ).toBe(false);
    });
});
