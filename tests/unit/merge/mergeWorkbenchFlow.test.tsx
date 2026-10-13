// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { foldedRanges } from "@codemirror/language";
import { undoDepth } from "@codemirror/commands";
import { MergeWorkbench } from "../../../src/webviews/react/merge-editor/MergeWorkbench";
import {
    buildWorkbenchDocument,
    workbenchHunks,
} from "../../../src/webviews/react/merge-editor/workbenchModel";
import { parseConflictVersions, detectEolMetadata } from "../../../src/mergeEditor/conflictParser";
import type { MergeEditorData } from "../../../src/webviews/react/merge-editor/types";
import { DEFAULT_MERGE_VIEW_SETTINGS } from "../../../src/webviews/protocol/mergeWorkbench";
import { mount, unmount, initReactDomTestEnvironment } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const api = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn<() => unknown>(() => null),
    setState: vi.fn(),
}));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();

function payload(base: string, ours: string, theirs: string): MergeEditorData {
    return {
        filePath: "flow.ts",
        oursLabel: "ours",
        theirsLabel: "theirs",
        segments: parseConflictVersions(base, ours, theirs),
        ...detectEolMetadata(ours),
        workbench: {
            snapshotId: "b".repeat(64),
            draftKey: "mergeDraft.flow",
            base,
            ours,
            theirs,
            operation: "merge",
        },
    };
}
const data = payload("head\nbase\ntail\n", "head\nours\ntail\n", "head\ntheirs\ntail\n");
const multiple = payload(
    "first\nkeep one\nsolo\nkeep two\nlast\n",
    "ours first\nkeep one\nOURS\nkeep two\nours last\n",
    "theirs first\nkeep one\nsolo\nkeep two\ntheirs last\n",
);

function view(container: HTMLElement, pane = 1): EditorView {
    return EditorView.findFromDOM(
        container.querySelector<HTMLElement>(`[data-testid="merge-editor-${pane}"] .cm-editor`)!,
    )!;
}
function button(container: HTMLElement, label: string) {
    const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (element) => element.getAttribute("aria-label") === label || element.textContent === label,
    );
    if (!element) throw new Error(`Missing button: ${label}`);
    act(() => element.click());
}
function control(container: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement {
    const element = [...container.querySelectorAll("label")]
        .find((element) => element.textContent?.startsWith(label))
        ?.querySelector<HTMLInputElement | HTMLSelectElement>("input, select");
    if (!element) throw new Error(`Missing control: ${label}`);
    return element;
}
function select(container: HTMLElement, label: string, value: string) {
    act(() => {
        const element = control(container, label);
        element.value = value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
    });
}
function toggle(container: HTMLElement, label: string) {
    act(() => control(container, label).click());
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
    vi.useRealTimers();
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("workbench flow controls", () => {
    it("navigates all changes or pending conflicts without changing result history", () => {
        const mounted = mount(<MergeWorkbench data={multiple} />);
        try {
            const result = view(mounted.container);
            const content = result.state.doc.toString();
            const active = () =>
                mounted.container.querySelector(".pane-result .cm-line.mrow-active")?.textContent;
            button(mounted.container, "View options");
            select(mounted.container, "Navigate", "changes");
            button(mounted.container, "Next conflict");
            expect(active()).toBe("OURS");
            select(mounted.container, "Navigate", "unresolved");
            button(mounted.container, "Next conflict");
            expect(active()).toBe("last");
            expect(result.state.doc.toString()).toBe(content);
            expect(undoDepth(result.state)).toBe(0);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("advances after an explicit side decision only when enabled", () => {
        const mounted = mount(<MergeWorkbench data={multiple} />);
        try {
            button(mounted.container, "View options");
            toggle(mounted.container, "Next conflict after a decision");
            act(() =>
                mounted.container
                    .querySelector<HTMLButtonElement>(".pane-ours .mrow-active .accept-btn")!
                    .click(),
            );
            expect(view(mounted.container).state.field(workbenchHunks)[0].resolved).toBe(true);
            expect(
                mounted.container.querySelector(".pane-result .cm-line.mrow-active")?.textContent,
            ).toBe("last");
            button(mounted.container, "Undo");
            expect(view(mounted.container).state.field(workbenchHunks)[0].resolved).toBe(false);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("wraps, folds and changes highlight granularity without editing bytes or history", () => {
        const context = Array.from({ length: 50 }, (_, index) => `common ${index}\n`).join("");
        const input = payload(
            context + "base\n" + context,
            context + "ours\n" + context,
            context + "theirs\n" + context,
        );
        const mounted = mount(<MergeWorkbench data={input} />);
        try {
            const result = view(mounted.container);
            const before = result.state.doc.toString();
            button(mounted.container, "View options");
            toggle(mounted.container, "Soft wrap");
            toggle(mounted.container, "Collapse unchanged regions");
            select(mounted.container, "Highlight", "character");
            for (let pane = 0; pane < 3; pane++) {
                expect(
                    view(mounted.container, pane).contentDOM.classList.contains("cm-lineWrapping"),
                ).toBe(true);
                expect(foldedRanges(view(mounted.container, pane).state).size).toBeGreaterThan(0);
            }
            expect(result.state.doc.toString()).toBe(before);
            expect(undoDepth(result.state)).toBe(0);
            toggle(mounted.container, "Collapse unchanged regions");
            expect(foldedRanges(result.state).size).toBe(0);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("does not hide a manually edited common region", () => {
        const common = "common text\n".repeat(30);
        const input = payload(common + "base\n", common + "ours\n", common + "theirs\n");
        const mounted = mount(<MergeWorkbench data={input} />);
        try {
            act(() =>
                view(mounted.container).dispatch({ changes: { from: 50, insert: "manual" } }),
            );
            button(mounted.container, "View options");
            toggle(mounted.container, "Collapse unchanged regions");
            for (let pane = 0; pane < 3; pane++)
                expect(foldedRanges(view(mounted.container, pane).state).size).toBe(0);
            expect(view(mounted.container).state.doc.toString()).toContain("manual");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("reviews automatic token merges and restores Base in the same undo history", () => {
        const input = payload(
            "const a = 1, b = 1;\n",
            "const a = 2, b = 1;\n",
            "const a = 1, b = 2;\n",
        );
        const mounted = mount(<MergeWorkbench data={input} />);
        try {
            const result = view(mounted.container);
            expect(result.state.field(workbenchHunks)[0].segment.autoResolvedLines).toBeDefined();
            button(mounted.container, "View options");
            select(mounted.container, "Navigate", "automatic");
            button(mounted.container, "Next conflict");
            toggle(mounted.container, "Reviewed automatic merge");
            expect(result.state.field(workbenchHunks)[0].reviewed).toBe(true);
            button(mounted.container, "Undo");
            expect(result.state.field(workbenchHunks)[0].reviewed).not.toBe(true);
            const original = result.state.doc.toString();
            act(() => {
                const combine = mounted.container.querySelector<HTMLSelectElement>(
                    '[aria-label="Resolve change"]',
                )!;
                combine.value = "base";
                combine.dispatchEvent(new Event("change", { bubbles: true }));
            });
            expect(result.state.doc.toString()).toBe(input.workbench!.base);
            button(mounted.container, "Undo");
            expect(result.state.doc.toString()).toBe(original);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("loads a late durable text draft after a view-only change without overwriting it first", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            button(mounted.container, "View options");
            toggle(mounted.container, "Soft wrap");
            await act(async () => vi.advanceTimersByTimeAsync(300));
            expect(
                api.postMessage.mock.calls.filter(([message]) => message.type === "saveMergeDraft"),
            ).toHaveLength(0);
            const initial = buildWorkbenchDocument(data);
            receive({
                type: "mergeDraft",
                draft: {
                    snapshotId: data.workbench!.snapshotId,
                    content: initial.content.replace("base", "EDIT"),
                    hunks: initial.hunks.map(({ id, from, to, resolved }) => ({
                        id,
                        from,
                        to,
                        resolved,
                    })),
                },
            });
            expect(view(mounted.container).state.doc.toString()).toContain("EDIT");
            expect(view(mounted.container).contentDOM.classList.contains("cm-lineWrapping")).toBe(
                true,
            );
            button(mounted.container, "Cancel");
            const last = api.postMessage.mock.calls
                .filter(([message]) => message.type === "saveMergeDraft")
                .at(-1)![0];
            expect(last.draft.content).toContain("EDIT");
            expect(last.draft.view.settings.wrap).toBe(true);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("restores cursor, navigation and reading settings from a matching draft", () => {
        const initial = buildWorkbenchDocument(data);
        api.getState.mockReturnValue({
            snapshotId: data.workbench!.snapshotId,
            content: initial.content,
            hunks: initial.hunks.map(({ id, from, to, resolved }) => ({ id, from, to, resolved })),
            view: {
                settings: {
                    ...DEFAULT_MERGE_VIEW_SETTINGS,
                    navigation: "unresolved",
                    wrap: true,
                    highlight: "character",
                },
                activeId: initial.hunks[0].id,
                anchor: 6,
                head: 8,
                scrollTop: 0,
                scrollLeft: 0,
            },
        });
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            expect(view(mounted.container).state.selection.main.anchor).toBe(6);
            expect(view(mounted.container).state.selection.main.head).toBe(8);
            expect(view(mounted.container).contentDOM.classList.contains("cm-lineWrapping")).toBe(
                true,
            );
            button(mounted.container, "View options");
            expect(control(mounted.container, "Navigate").value).toBe("unresolved");
            expect(control(mounted.container, "Highlight").value).toBe("character");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("requests read-only Base comparisons with the current unsaved result", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            act(() =>
                view(mounted.container).dispatch({ changes: { from: 0, insert: "unsaved\n" } }),
            );
            button(mounted.container, "Base");
            act(() => {
                const compare = mounted.container.querySelector<HTMLSelectElement>(
                    '[aria-label="Compare with base"]',
                )!;
                compare.value = "result";
                compare.dispatchEvent(new Event("change", { bubbles: true }));
            });
            expect(api.postMessage).toHaveBeenCalledWith({
                type: "compareMergeVersion",
                side: "result",
                snapshotId: data.workbench!.snapshotId,
                content: view(mounted.container).state.doc.toString(),
            });
            expect(
                api.postMessage.mock.calls.some(([message]) => message.type === "applyResolution"),
            ).toBe(false);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("preserves drafts before queue navigation and separates resolved review commands", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            receive({ type: "mergeDraft", draft: null });
            button(mounted.container, "Conflicts");
            receive({
                type: "mergeFileQueue",
                files: [
                    { path: "flow.ts", resolved: false },
                    { path: "done.ts", resolved: true },
                ],
            });
            expect(
                mounted.container.querySelector(
                    '.workbench-file-queue button[aria-current="true"]',
                ),
            ).not.toBeNull();
            api.postMessage.mockClear();
            act(() =>
                mounted.container
                    .querySelectorAll<HTMLButtonElement>(".workbench-file-queue button")[1]
                    .click(),
            );
            expect(api.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
                "saveMergeDraft",
                "reviewMergeFile",
            ]);
            expect(api.postMessage).toHaveBeenLastCalledWith({
                type: "reviewMergeFile",
                filePath: "done.ts",
            });
            receive({ type: "mergeFileQueue", files: [{ path: 7, resolved: true }] });
            expect(mounted.container.querySelectorAll(".workbench-file-queue button")).toHaveLength(
                2,
            );
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
});
