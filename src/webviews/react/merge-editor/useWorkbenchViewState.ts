import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type MutableRefObject,
} from "react";
import type { createMergeCodeEditor } from "./codeEditor";
import type { WorkbenchHunk } from "./workbenchModel";
import type { useWorkbenchLayout } from "./useWorkbenchLayout";
import {
    DEFAULT_MERGE_VIEW_SETTINGS,
    type MergeViewState,
    type MergeViewSettings,
    type MergeWorkbenchOutbound,
} from "../../protocol/mergeWorkbench";
import { getVsCodeApi } from "../shared/vscodeApi";

/** Keeps presentation state separate from result history and merge decisions. */
export function useWorkbenchViewState() {
    const [settings, setSettings] = useState<MergeViewSettings>({ ...DEFAULT_MERGE_VIEW_SETTINGS });
    const presentation = useRef<MergeViewState | null>(null);
    const restoredView = useRef<MergeViewState | null>(null);
    const restoreView = useCallback((view: MergeViewState) => {
        setSettings(view.settings);
        restoredView.current = view;
    }, []);
    return { settings, setSettings, presentation, restoredView, restoreView };
}

/** Captures file-local reading positions and restores them only after editor layout. */
export function useWorkbenchViewPersistence(
    context: ReturnType<typeof useWorkbenchViewState>,
    editors: MutableRefObject<ReturnType<typeof createMergeCodeEditor>[]>,
    hunks: readonly WorkbenchHunk[],
    active: number | null,
    layout: ReturnType<typeof useWorkbenchLayout>,
    savePresentation: () => void,
    editorStats: unknown,
) {
    const { settings, setSettings, presentation, restoredView } = context;
    const { contentRef, horizontalRef, onHorizontalScroll, onScroll } = layout;
    useLayoutEffect(() => {
        if (!restoredView.current || !contentRef.current || !horizontalRef.current) return;
        const restored = restoredView.current;
        const frame = requestAnimationFrame(() => {
            contentRef.current!.scrollTop = restored.scrollTop;
            if (settings.wrap) contentRef.current!.scrollLeft = restored.scrollLeft;
            else {
                horizontalRef.current!.scrollLeft = restored.scrollLeft;
                onHorizontalScroll();
            }
            onScroll();
            restoredView.current = null;
        });
        return () => cancelAnimationFrame(frame);
    }, [
        settings,
        editorStats,
        contentRef,
        horizontalRef,
        onHorizontalScroll,
        onScroll,
        restoredView,
    ]);
    presentation.current = {
        settings,
        activeId: active === null ? null : (hunks[active]?.id ?? null),
        anchor: editors.current[1]?.view.state.selection.main.anchor ?? 0,
        head: editors.current[1]?.view.state.selection.main.head ?? 0,
        scrollTop: restoredView.current?.scrollTop ?? contentRef.current?.scrollTop ?? 0,
        scrollLeft:
            restoredView.current?.scrollLeft ??
            (settings.wrap ? contentRef.current?.scrollLeft : horizontalRef.current?.scrollLeft) ??
            0,
    };
    return {
        changeSettings: (next: Partial<MergeViewSettings>) => {
            const changed = { ...settings, ...next };
            setSettings(changed);
            if (presentation.current) presentation.current.settings = changed;
            savePresentation();
        },
        rememberScroll: () => {
            if (!presentation.current || restoredView.current) return;
            presentation.current.scrollTop = contentRef.current?.scrollTop ?? 0;
            presentation.current.scrollLeft =
                (settings.wrap
                    ? contentRef.current?.scrollLeft
                    : horizontalRef.current?.scrollLeft) ?? 0;
            savePresentation();
        },
    };
}

/** Requests the fixed host repository's queue, preserving drafts before navigation. */
export function useMergeFileQueue(flushDraft: () => void) {
    const [showFiles, setShowFiles] = useState(false);
    const [files, setFiles] = useState<Array<{ path: string; resolved: boolean }>>([]);
    useEffect(() => {
        const receive = (event: MessageEvent<unknown>) => {
            if (!event.data || typeof event.data !== "object") return;
            const message = event.data as Record<string, unknown>;
            if (message.type !== "mergeFileQueue" || !Array.isArray(message.files)) return;
            if (
                !message.files.every(
                    (file: unknown) =>
                        file !== null &&
                        typeof file === "object" &&
                        "path" in file &&
                        typeof file.path === "string" &&
                        "resolved" in file &&
                        typeof file.resolved === "boolean",
                )
            )
                return;
            setFiles(
                message.files.map((file: { path: string; resolved: boolean }) => ({
                    path: file.path,
                    resolved: file.resolved,
                })),
            );
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
    }, []);
    return {
        showFiles,
        files,
        toggleFiles: () => {
            flushDraft();
            setShowFiles(!showFiles);
            getVsCodeApi<MergeWorkbenchOutbound>().postMessage({ type: "loadMergeFiles" });
        },
        openFile: (file: { path: string; resolved: boolean }) => {
            flushDraft();
            getVsCodeApi<MergeWorkbenchOutbound>().postMessage({
                type: file.resolved ? "reviewMergeFile" : "openMergeFile",
                filePath: file.path,
            });
        },
    };
}
