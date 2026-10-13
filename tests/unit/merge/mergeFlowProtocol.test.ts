import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import {
    DEFAULT_MERGE_VIEW_SETTINGS,
    parseMergeDraft,
    parseMergeViewState,
} from "../../../src/webviews/protocol/mergeWorkbench";
import {
    navigationIndices,
    nextNavigationIndex,
    buildWorkbenchDocument,
} from "../../../src/webviews/react/merge-editor/workbenchModel";
import { commonFoldRanges } from "../../../src/webviews/react/merge-editor/useWorkbenchReading";
import { parseConflictVersions } from "../../../src/mergeEditor/conflictParser";
import { MergeResultHistory } from "../../../src/views/mergeResultHistory";

const view = {
    settings: { ...DEFAULT_MERGE_VIEW_SETTINGS },
    activeId: 1,
    anchor: 0,
    head: 2,
    scrollTop: 30,
    scrollLeft: 15,
};
describe("bounded merge view metadata", () => {
    it("normalizes supported settings without carrying unknown properties", () => {
        expect(parseMergeViewState({ ...view, extra: "ignored" }, 10)).toEqual(view);
        expect(parseMergeViewState({ ...view, activeId: null }, 10)?.activeId).toBeNull();
    });
    it.each([
        { anchor: -1 },
        { head: 11 },
        { scrollTop: Infinity },
        { scrollLeft: -1 },
        { activeId: "1" },
        { activeId: 1.5 },
        { settings: { ...view.settings, contextLines: 21 } },
        { settings: { ...view.settings, contextLines: 2.5 } },
        { settings: { ...view.settings, navigation: "arbitrary" } },
        { settings: { ...view.settings, highlight: "semantic" } },
        { settings: { ...view.settings, wrap: "yes" } },
    ])("rejects invalid optional state %j", (change) => {
        expect(parseMergeViewState({ ...view, ...change }, 10)).toBeNull();
    });
    it("recovers text while dropping invalid presentation metadata", () => {
        const draft = {
            snapshotId: "b".repeat(64),
            content: "kept",
            hunks: [{ id: 0, from: 0, to: 4, resolved: true, reviewed: true }],
            view: { ...view, anchor: 100 },
        };
        const parsed = parseMergeDraft(draft);
        expect(parsed?.content).toBe("kept");
        expect(parsed?.hunks[0].reviewed).toBe(true);
        expect(parsed?.view).toBeUndefined();
        expect(
            parseMergeDraft({ ...draft, hunks: [{ ...draft.hunks[0], reviewed: "yes" }] }),
        ).toBeNull();
    });
});

describe("source-order navigation and common folding", () => {
    const data = {
        filePath: "f.txt",
        oursLabel: "ours",
        theirsLabel: "theirs",
        segments: parseConflictVersions(
            "first\nkeep one\nsolo\nkeep two\nlast\n",
            "ours first\nkeep one\nOURS\nkeep two\nours last\n",
            "theirs first\nkeep one\nsolo\nkeep two\ntheirs last\n",
        ),
    };
    it("filters conflicts, all changes, pending decisions and automatic candidates", () => {
        const { hunks } = buildWorkbenchDocument(data);
        expect(navigationIndices(hunks, "changes")).toEqual([0, 1, 2]);
        expect(navigationIndices(hunks, "conflicts")).toEqual([0, 2]);
        expect(
            navigationIndices([{ ...hunks[0], resolved: true }, ...hunks.slice(1)], "unresolved"),
        ).toEqual([2]);
        expect(navigationIndices(hunks, "automatic")).toEqual([]);
        expect(
            navigationIndices(
                [{ ...hunks[0], segment: { ...hunks[0].segment, autoResolvedLines: ["merged"] } }],
                "automatic",
            ),
        ).toEqual([0]);
    });
    it("wraps in both directions and skips filtered-out active changes", () => {
        expect(nextNavigationIndex([], null, 1)).toBeUndefined();
        expect(nextNavigationIndex([0, 2], null, -1)).toBe(2);
        expect(nextNavigationIndex([0, 2], 1, 1)).toBe(2);
        expect(nextNavigationIndex([0, 2], 1, -1)).toBe(0);
        expect(nextNavigationIndex([0, 2], 2, 1)).toBe(0);
        expect(nextNavigationIndex([0, 2], 0, -1)).toBe(2);
    });
    it("bounds folded ranges to identical text and preserves context on both edges", () => {
        const doc = Text.of(Array.from({ length: 20 }, (_, index) => `line ${index}`));
        const ranges = commonFoldRanges([doc, doc, doc], [], 3);
        expect(ranges).toHaveLength(3);
        expect(ranges[0][0].from).toBe(doc.line(4).from);
        expect(ranges[0][0].to).toBe(doc.line(17).to);
        expect(commonFoldRanges([doc, Text.of(["edited"]), doc], [], 3)).toEqual([[], [], []]);
        expect(commonFoldRanges([Text.empty, Text.empty, Text.empty], [], 0)).toEqual([[], [], []]);
    });
});

describe("operation-scoped saved-result review history", () => {
    it("keeps repositories and operations isolated and returns copies", () => {
        const history = new MergeResultHistory();
        history.record("/one", "merge A", { path: "a.ts", base: "base", result: "saved" });
        expect(history.list("/two", "merge A")).toEqual([]);
        expect(history.list("/one", "merge B")).toEqual([]);
        history.list("/one", "merge A")[0].result = "mutated";
        expect(history.list("/one", "merge A")[0].result).toBe("saved");
        history.record("/one", "merge A", { path: "a.ts", base: "base", result: "replaced" });
        expect(history.list("/one", "merge A")).toHaveLength(1);
        expect(history.list("/one", "merge A")[0].result).toBe("replaced");
    });
    it("bounds both entry count and total UTF-8 payload bytes", () => {
        const history = new MergeResultHistory();
        for (let index = 0; index < 65; index++)
            history.record("/one", "op", { path: `${index}.txt`, base: "", result: "" });
        expect(history.list("/one", "op")).toHaveLength(64);
        expect(history.list("/one", "op").some((file) => file.path === "0.txt")).toBe(false);
        history.record("/two", "op", {
            path: "huge.txt",
            base: "x".repeat(16 * 1024 * 1024),
            result: "more",
        });
        expect(history.list("/two", "op")).toEqual([]);
    });
});
