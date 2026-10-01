import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    resolve: vi.fn(),
    warning: vi.fn(),
    listeners: {} as Record<string, (event?: unknown) => void>,
    dispose: vi.fn(),
}));
vi.mock("vscode", () => ({
    window: {
        onDidChangeActiveColorTheme: (listener: () => void) => {
            mocks.listeners.theme = listener;
            return { dispose: mocks.dispose };
        },
    },
    workspace: {
        onDidChangeConfiguration: (listener: (event: unknown) => void) => {
            mocks.listeners.configuration = listener;
            return { dispose: mocks.dispose };
        },
    },
    extensions: {
        onDidChange: (listener: () => void) => {
            mocks.listeners.extensions = listener;
            return { dispose: mocks.dispose };
        },
    },
}));
vi.mock("../../../../src/utils/syntaxTheme", () => ({ resolveSyntaxTheme: mocks.resolve }));
vi.mock("../../../../src/git/operationSupport", () => ({ logGitOpsWarning: mocks.warning }));
import { DiffSyntaxThemeService } from "../../../../src/views/shared/DiffSyntaxThemeService";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners = {};
    mocks.resolve.mockResolvedValue(null);
});

describe("Diff syntax theme delivery", () => {
    it("publishes on request and subscribes once to relevant host changes", async () => {
        const postMessage = vi.fn().mockResolvedValue(true);
        const service = new DiffSyntaxThemeService({ postMessage } as never);
        expect(mocks.listeners).toEqual({});
        await service.publish();
        expect(postMessage).toHaveBeenLastCalledWith({ type: "setSyntaxTheme", theme: null });
        mocks.resolve.mockResolvedValue({ name: "changed" });
        mocks.listeners.theme();
        await vi.waitFor(() =>
            expect(postMessage).toHaveBeenLastCalledWith({
                type: "setSyntaxTheme",
                theme: { name: "changed" },
            }),
        );
        const count = postMessage.mock.calls.length;
        mocks.listeners.configuration({ affectsConfiguration: () => false });
        expect(postMessage).toHaveBeenCalledTimes(count);
        mocks.listeners.configuration({
            affectsConfiguration: (key: string) => key === "editor.tokenColorCustomizations",
        });
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(count + 1));
        mocks.listeners.extensions();
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(count + 2));
        service.dispose();
        expect(mocks.dispose).toHaveBeenCalledTimes(3);
        await service.publish();
        expect(postMessage).toHaveBeenCalledTimes(count + 2);
    });

    it("discards a slow old theme after a newer theme has resolved", async () => {
        let resolveOld!: (value: unknown) => void;
        mocks.resolve.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveOld = resolve;
                }),
        );
        const postMessage = vi.fn();
        const service = new DiffSyntaxThemeService({ postMessage } as never);
        const old = service.publish();
        await service.publish();
        resolveOld({ name: "stale" });
        await old;
        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith({ type: "setSyntaxTheme", theme: null });
        service.dispose();
    });

    it("logs a broken theme and posts a fallback without rejecting document initialization", async () => {
        mocks.resolve.mockRejectedValue(new Error("missing include"));
        const postMessage = vi.fn().mockResolvedValue(true);
        const service = new DiffSyntaxThemeService({ postMessage } as never);
        await service.publish();
        expect(mocks.warning).toHaveBeenCalled();
        expect(postMessage).toHaveBeenCalledWith({ type: "setSyntaxTheme", theme: null });
        postMessage.mockRejectedValue(new Error("gone"));
        await expect(service.publish()).resolves.toBeUndefined();
        service.dispose();
    });

    it("never posts a resolution that finished after disposal", async () => {
        let resolve!: (value: unknown) => void;
        mocks.resolve.mockImplementation(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const postMessage = vi.fn();
        const service = new DiffSyntaxThemeService({ postMessage } as never);
        const pending = service.publish();
        service.dispose();
        resolve(null);
        await pending;
        expect(postMessage).not.toHaveBeenCalled();
    });
});
