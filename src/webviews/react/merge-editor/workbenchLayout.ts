import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { DiffVerticalLayout, SegmentPaneLines } from "../diff-core/mergeScrollLayout";
import { connectorSideSpecs, type ConnectorRenderSpec, type MergePaneId } from "./mergeRibbons";
import type { OverviewMarker } from "./segments";
import type { Grouping, WorkbenchHunk } from "./workbenchModel";
import { resolutionOf, rowsInRange } from "./workbenchRows";
import { LINE_HEIGHT_PX } from "../diff-core/mergeScrollLayout";

/** Keeps ribbons aligned to current hunk rows; manual edits supersede prior side slices. */
export function workbenchConnectors(
    hunks: readonly WorkbenchHunk[],
    segments: Grouping["segments"],
): ConnectorRenderSpec[] {
    return hunks
        .filter(
            (hunk) =>
                !(
                    hunk.segment.autoResolvedLines !== undefined &&
                    hunk.decision === undefined &&
                    !hunk.edited
                ),
        )
        .map((hunk) => {
            const index = segments.indexOf(hunk.segment);
            if (index === -1)
                throw new Error("merge-editor: ribbon hunk is missing from the current segments");
            return {
                id: hunk.id,
                index,
                ...connectorSideSpecs(
                    hunk.segment,
                    hunk.edited ? undefined : resolutionOf(hunk),
                    hunk.edited ? undefined : hunk.dismissed,
                ),
            };
        });
}

/** Counts the current document's rows in segment order. */
export function layoutSegments(
    segments: Grouping["segments"],
    hunks: readonly WorkbenchHunk[],
    resultDoc: Text,
) {
    let hunkIndex = 0;
    let previousTo = 0;
    let line = 1;
    const startLine: number[] = [];
    const canonicalLineCount: number[] = [];
    const paneLines: SegmentPaneLines<MergePaneId>[] = segments.map((segment) => {
        let item: SegmentPaneLines<MergePaneId>;
        if (segment.type === "common") {
            item = {
                paneLines: {
                    left: segment.lines.length,
                    middle: rowsInRange(
                        resultDoc,
                        previousTo,
                        hunks[hunkIndex]?.from ?? resultDoc.length,
                    ),
                    right: segment.lines.length,
                },
                conflict: false,
            };
        } else {
            const hunk = hunks[hunkIndex++];
            if (!hunk || hunk.segment !== segment)
                throw new Error("merge-editor: layout segment does not match its current hunk");
            item = {
                paneLines: {
                    left: segment.oursLines.length,
                    middle: rowsInRange(resultDoc, hunk.from, hunk.to),
                    right: segment.theirsLines.length,
                },
                conflict: true,
                id: segment.id,
            };
            previousTo = hunk.to;
        }
        const count = Math.max(...Object.values(item.paneLines), 1);
        startLine.push(line);
        canonicalLineCount.push(count);
        line += count;
        return item;
    });
    if (hunkIndex !== hunks.length)
        throw new Error("merge-editor: current hunks are missing layout segments");
    return { paneLines, canonicalLineCount, startLine };
}

/** Measures wrapped and folded blocks through CodeMirror's public geometry, not DOM row guesses. */
export function measuredLayoutSegments(
    segments: Grouping["segments"],
    hunks: readonly WorkbenchHunk[],
    views: readonly EditorView[],
) {
    const info = layoutSegments(segments, hunks, views[1].state.doc);
    const starts = [0, 0, 0];
    let hunkIndex = 0;
    const paneLines = segments.map((segment, index) => {
        const hunk = segment.type === "conflict" ? hunks[hunkIndex++] : undefined;
        const ends = hunk
            ? [hunk.oursTo, hunk.to, hunk.theirsTo]
            : [
                  hunks[hunkIndex]?.oursFrom ?? views[0].state.doc.length,
                  hunks[hunkIndex]?.from ?? views[1].state.doc.length,
                  hunks[hunkIndex]?.theirsFrom ?? views[2].state.doc.length,
              ];
        if (hunk) {
            starts[0] = hunk.oursFrom;
            starts[1] = hunk.from;
            starts[2] = hunk.theirsFrom;
        }
        const heights = views.map((view, pane) => {
            if (ends[pane] <= starts[pane]) return 0;
            const first = view.lineBlockAt(starts[pane]);
            const last = view.lineBlockAt(ends[pane] - 1);
            return Math.max(0, last.bottom - first.top) / LINE_HEIGHT_PX;
        });
        starts.splice(0, 3, ...ends);
        return {
            ...info.paneLines[index],
            paneLines: { left: heights[0], middle: heights[1], right: heights[2] },
        };
    });
    const canonicalLineCount = paneLines.map((item) => Math.max(...Object.values(item.paneLines)));
    let line = 1;
    const startLine = canonicalLineCount.map((count) => {
        const start = line;
        line += count;
        return start;
    });
    return { paneLines, canonicalLineCount, startLine };
}

/** Resolves stacked and append-edge targets from rendered blocks when rows wrap. */
export function measuredWorkbenchConnectors(
    connectors: readonly ConnectorRenderSpec[],
    hunks: readonly WorkbenchHunk[],
    view: EditorView,
): ConnectorRenderSpec[] {
    const byId = new Map(hunks.map((hunk) => [hunk.id, hunk]));
    return connectors.map((connector) => {
        const hunk = byId.get(connector.id)!;
        const firstLine = view.state.doc.lineAt(hunk.from).number;
        const origin = view.lineBlockAt(hunk.from).top;
        const edge = (offset: number) => {
            const number = firstLine + offset;
            return number <= view.state.doc.lines
                ? view.lineBlockAt(view.state.doc.line(number).from).top - origin
                : view.lineBlockAt(view.state.doc.length).bottom - origin;
        };
        const measured = { ...connector };
        for (const side of ["left", "right"] as const) {
            const spec = connector[side];
            if (!spec?.midSlice) continue;
            const top = edge(spec.midSlice.top);
            measured[side] = {
                ...spec,
                midSlice: {
                    ...spec.midSlice,
                    pixels: { top, height: edge(spec.midSlice.top + spec.midSlice.count) - top },
                },
            };
        }
        return measured;
    });
}

/** Maps a pane position back into the canonical space. */
export function canonicalForPaneY(
    layout: DiffVerticalLayout<MergePaneId>,
    pane: MergePaneId,
    y: number,
): number {
    const tops = layout.paneTopPx[pane];
    const heights = layout.paneHPx[pane];
    const index = tops.findIndex((top, i) => top === y || (top < y && y < top + heights[i]));
    if (index === -1) return y <= 0 ? 0 : layout.canonicalTotalPx;
    const fraction = heights[index] > 0 ? (y - tops[index]) / heights[index] : 0;
    return layout.canonicalTopPx[index] + fraction * layout.canonicalHPx[index];
}
/** Describes overview markers in canonical line space. */
export function overviewMarkers(
    hunks: readonly WorkbenchHunk[],
    layoutInfo: ReturnType<typeof layoutSegments>,
    _activeIndex: number | null,
): OverviewMarker[] {
    const total = Math.max(
        layoutInfo.canonicalLineCount.reduce((sum, count) => sum + count, 0),
        1,
    );
    const indices = new Map(layoutInfo.paneLines.map((item, index) => [item.id, index]));
    return hunks.map((hunk, index) => {
        const segmentIndex = indices.get(hunk.id);
        if (segmentIndex === undefined)
            throw new Error("merge-editor: overview hunk is missing from the layout");
        return {
            id: hunk.id,
            ordinal: index + 1,
            topPct: ((layoutInfo.startLine[segmentIndex] - 1) / total) * 100,
            heightPct: Math.min(
                Math.max((layoutInfo.canonicalLineCount[segmentIndex] / total) * 100, 1),
                30,
            ),
            changeKind: hunk.segment.changeKind,
            resolved: !hunk.conflict || hunk.resolved,
        };
    });
}
/** Counts confirmed true conflicts and automatic changes. */
export function workbenchCounts(hunks: readonly WorkbenchHunk[]) {
    const conflicts = hunks.filter((hunk) => hunk.conflict);
    const resolved = conflicts.filter((hunk) => hunk.resolved).length;
    return {
        total: conflicts.length,
        resolved,
        unresolved: conflicts.length - resolved,
        autoResolvedCount: hunks.filter(
            (hunk) => hunk.segment.changeKind !== "conflict" && !hunk.decision,
        ).length,
        nextUnresolvedIndex: hunks.findIndex((hunk) => hunk.conflict && !hunk.resolved),
    };
}
/** Sizes a shared track from the greatest pane overflow. */
export function horizontalInnerWidth(
    barClientWidth: number,
    views: readonly { scrollWidth: number; clientWidth: number }[],
): number {
    return (
        barClientWidth + Math.max(0, ...views.map((view) => view.scrollWidth - view.clientWidth))
    );
}
