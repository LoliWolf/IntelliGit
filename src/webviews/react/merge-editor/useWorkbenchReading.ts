import { useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { EditorView } from "@codemirror/view";
import { foldEffect, unfoldEffect, foldedRanges } from "@codemirror/language";
import { Compartment, StateEffect, Transaction, type Text } from "@codemirror/state";
import type { MergeViewSettings } from "../../protocol/mergeWorkbench";
import { setMergeHighlight, type createMergeCodeEditor } from "./codeEditor";
import type { WorkbenchHunk } from "./workbenchModel";

interface FoldRange {
    key: number;
    from: number;
    to: number;
}

/** Folds only byte-identical common text, leaving editable changes and context visible. */
export function commonFoldRanges(
    documents: readonly Text[],
    hunks: readonly WorkbenchHunk[],
    context: number,
): FoldRange[][] {
    const ranges: FoldRange[][] = [[], [], []];
    const starts = [0, 0, 0];
    for (let index = 0; index <= hunks.length; index++) {
        const hunk = hunks[index];
        const ends = hunk
            ? [hunk.oursFrom, hunk.from, hunk.theirsFrom]
            : documents.map((doc) => doc.length);
        const texts = documents.map((doc, pane) => doc.sliceString(starts[pane], ends[pane]));
        if (texts[0] === texts[1] && texts[1] === texts[2]) {
            documents.forEach((doc, pane) => {
                if (ends[pane] <= starts[pane]) return;
                const first = doc.lineAt(starts[pane]).number + context;
                const last = doc.lineAt(ends[pane] - 1).number - context;
                if (last <= first) return;
                ranges[pane].push({
                    key: index,
                    from: doc.line(first).from,
                    to: doc.line(last).to,
                });
            });
        }
        if (hunk) {
            starts[0] = hunk.oursTo;
            starts[1] = hunk.to;
            starts[2] = hunk.theirsTo;
        }
    }
    return ranges;
}

/** Coordinates CodeMirror's native fold state across all three inputs without editing text. */
export function useWorkbenchReading(
    editors: MutableRefObject<ReturnType<typeof createMergeCodeEditor>[]>,
    hunks: readonly WorkbenchHunk[],
    settings: MergeViewSettings,
) {
    const ranges = useRef<FoldRange[][]>([]);
    const synchronizing = useRef(false);
    const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
    const mounted = editors.current;
    useLayoutEffect(() => {
        const listeners = mounted.slice(0, 3).map(({ view }, pane) => {
            const compartment = new Compartment();
            view.dispatch({
                effects: StateEffect.appendConfig.of(
                    compartment.of(
                        EditorView.updateListener.of((update) => {
                            if (synchronizing.current) return;
                            for (const transaction of update.transactions)
                                for (const effect of transaction.effects) {
                                    if (!effect.is(unfoldEffect)) continue;
                                    const range = ranges.current[pane]?.find(
                                        (range) =>
                                            range.from === effect.value.from &&
                                            range.to === effect.value.to,
                                    );
                                    if (range)
                                        setExpanded(
                                            (previous) => new Set([...previous, range.key]),
                                        );
                                }
                        }),
                    ),
                ),
            });
            return () => view.dispatch({ effects: compartment.reconfigure([]) });
        });
        return () => listeners.forEach((dispose) => dispose());
    }, [mounted]);
    useLayoutEffect(() => {
        if (editors.current.length < 3) return;
        ranges.current = commonFoldRanges(
            editors.current.slice(0, 3).map(({ view }) => view.state.doc),
            hunks,
            settings.contextLines,
        );
        synchronizing.current = true;
        try {
            editors.current.forEach((editor, pane) => {
                editor.setWrapping(settings.wrap);
                const effects: StateEffect<unknown>[] = [setMergeHighlight.of(settings.highlight)];
                foldedRanges(editor.view.state).between(
                    0,
                    editor.view.state.doc.length,
                    (from, to) => {
                        effects.push(unfoldEffect.of({ from, to }));
                    },
                );
                if (settings.collapse && pane < 3)
                    for (const range of ranges.current[pane])
                        if (!expanded.has(range.key)) effects.push(foldEffect.of(range));
                editor.view.dispatch({ effects, annotations: Transaction.addToHistory.of(false) });
            });
        } finally {
            synchronizing.current = false;
        }
    }, [editors, hunks, settings, expanded]);
}
