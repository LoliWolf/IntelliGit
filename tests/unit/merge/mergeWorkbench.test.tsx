// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { MergeWorkbench } from "../../../src/webviews/react/merge-editor/MergeWorkbench";
import { parseConflictVersions, detectEolMetadata } from "../../../src/mergeEditor/conflictParser";
import { mount, unmount, initReactDomTestEnvironment } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const api = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn<() => unknown>(() => null),
    setState: vi.fn(),
}));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();
const base = "head\nbase\ntail\n";
const ours = "head\nours\ntail\n";
const theirs = "head\ntheirs\ntail\n";
const data = {
    filePath: "file.ts",
    oursLabel: "ours",
    theirsLabel: "theirs",
    segments: parseConflictVersions(base, ours, theirs),
    ...detectEolMetadata(ours),
    workbench: {
        snapshotId: "b".repeat(64),
        draftKey: "mergeDraft.test",
        base,
        ours,
        theirs,
        operation: "merge",
    },
};

function click(container: HTMLElement, label: string) {
    const button =
        container.querySelector<HTMLButtonElement>(`.mw-toolbar button[aria-label="${label}"]`) ??
        [...container.querySelectorAll<HTMLButtonElement>("button")].find(
            (element) => element.textContent === label,
        );
    if (!button) throw new Error(`Missing ${label}`);
    act(() => button.click());
}
function result(container: HTMLElement): EditorView {
    return EditorView.findFromDOM(
        container.querySelector('[data-testid="merge-editor-1"] .cm-editor') as HTMLElement,
    )!;
}
function receive(message: unknown) {
    act(() => window.dispatchEvent(new MessageEvent("message", { data: message })));
}

beforeEach(() => {
    installWebviewI18n();
    vi.clearAllMocks();
    api.getState.mockReturnValue(null);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
    Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
        configurable: true,
        value: () => new DOMRect(),
    });
});
afterEach(() => {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("merge workbench state and commands", () => {
    it("unifies side choices, manual editing and confirmations in undo/redo", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        const view = result(mounted.container);
        click(mounted.container, "Accept left change");
        expect(view.state.doc.toString()).toContain("ours");
        click(mounted.container, "Undo");
        expect(view.state.doc.toString()).toContain("base");
        click(mounted.container, "Redo");
        expect(view.state.doc.toString()).toContain("ours");
        act(() => view.dispatch({ changes: { from: 0, insert: "manual\n" } }));
        click(mounted.container, "Confirm manual resolution");
        click(mounted.container, "Undo");
        click(mounted.container, "Base");
        expect(mounted.container.querySelector(".mw-base")?.hasAttribute("hidden")).toBe(false);
        click(mounted.container, "Find in result");
        expect(mounted.container.querySelector(".cm-search")).not.toBeNull();
        click(mounted.container, "Synchronize scrolling");
        click(mounted.container, "Accept right change");
        expect(view.state.doc.toString()).toContain("theirs");
        unmount(mounted.root, mounted.container);
    });
    it.each(["both", "both-reversed", "base", "none"])(
        "applies the %s decision and allows undo",
        (choice) => {
            const mounted = mount(<MergeWorkbench data={data} />);
            const select = mounted.container.querySelector("select")!;
            act(() => {
                select.value = choice;
                select.dispatchEvent(new Event("change", { bubbles: true }));
            });
            const text = result(mounted.container).state.doc.toString();
            if (choice === "both") expect(text).toContain("ours\ntheirs");
            if (choice === "both-reversed") expect(text).toContain("theirs\nours");
            if (choice === "base") expect(text).toContain("base");
            if (choice === "none") expect(text).toBe("head\ntail\n");
            click(mounted.container, "Undo");
            expect(result(mounted.container).state.doc.toString()).toBe(base);
            unmount(mounted.root, mounted.container);
        },
    );
    it("freezes editing during Apply and restores it after a recoverable failure", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        click(mounted.container, "Accept left change");
        click(mounted.container, "Apply");
        expect(api.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            snapshotId: data.workbench.snapshotId,
            content: ours,
        });
        expect(result(mounted.container).contentDOM.getAttribute("contenteditable")).toBe("false");
        receive({ type: "resolutionError", message: "changed" });
        expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe("changed");
        expect(result(mounted.container).contentDOM.getAttribute("contenteditable")).toBe("true");
        receive({ type: "resolutionApplied" });
        expect(api.setState).toHaveBeenCalledWith(null);
        unmount(mounted.root, mounted.container);
    });
    it("restores matching local drafts before late durable loads and preserves stale drafts", () => {
        const draft = {
            snapshotId: data.workbench.snapshotId,
            content: "local draft\n",
            hunks: [{ id: 0, from: 0, to: 12, resolved: true }],
        };
        api.getState.mockReturnValue(draft);
        const mounted = mount(<MergeWorkbench data={data} />);
        expect(result(mounted.container).state.doc.toString()).toBe(draft.content);
        receive({ type: "mergeDraft", draft: { ...draft, content: "late draft\n" } });
        expect(result(mounted.container).state.doc.toString()).toBe(draft.content);
        receive({ type: "mergeDraft", draft: { ...draft, snapshotId: "a".repeat(64) } });
        expect(mounted.container.querySelector("details pre")?.textContent).toBe(draft.content);
        click(mounted.container, "Discard previous draft");
        expect(api.postMessage).toHaveBeenCalledWith({
            type: "discardMergeDraft",
            snapshotId: "a".repeat(64),
        });
        click(mounted.container, "Conflicted files");
        expect(api.postMessage).toHaveBeenCalledWith({ type: "openConflictSession" });
        click(mounted.container, "Cancel");
        expect(api.postMessage).toHaveBeenCalledWith({ type: "close" });
        unmount(mounted.root, mounted.container);
    });
});
