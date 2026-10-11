const MERGE_CHOICES = ["ours", "theirs", "both", "both-reversed", "base", "none"] as const;

/** Available replacements for a merge hunk. */
export type MergeChoice = (typeof MERGE_CHOICES)[number];

/** Presentation preferences never change the saved merge result. */
export interface MergeViewSettings {
    navigation: "conflicts" | "changes" | "unresolved" | "automatic";
    advance: boolean;
    wrap: boolean;
    collapse: boolean;
    contextLines: number;
    highlight: "line" | "word" | "character";
}

/** File-local cursor and reading state restored with a matching immutable snapshot. */
export interface MergeViewState {
    settings: MergeViewSettings;
    activeId: number | null;
    anchor: number;
    head: number;
    scrollTop: number;
    scrollLeft: number;
}

/** Preserves the classic editor's initial appearance and navigation policy. */
export const DEFAULT_MERGE_VIEW_SETTINGS: MergeViewSettings = {
    navigation: "conflicts",
    advance: false,
    wrap: false,
    collapse: false,
    contextLines: 3,
    highlight: "word",
};

/** Discards invalid optional presentation metadata without losing a valid text draft. */
export function parseMergeViewState(value: unknown, length: number): MergeViewState | null {
    if (!value || typeof value !== "object") return null;
    const source = value as Record<string, unknown>;
    const settings = source.settings as Record<string, unknown> | undefined;
    if (
        !settings ||
        typeof settings !== "object" ||
        typeof settings.navigation !== "string" ||
        typeof settings.highlight !== "string" ||
        !["conflicts", "changes", "unresolved", "automatic"].includes(
            String(settings.navigation),
        ) ||
        !["line", "word", "character"].includes(String(settings.highlight)) ||
        typeof settings.advance !== "boolean" ||
        typeof settings.wrap !== "boolean" ||
        typeof settings.collapse !== "boolean" ||
        typeof settings.contextLines !== "number" ||
        !Number.isSafeInteger(settings.contextLines) ||
        settings.contextLines < 0 ||
        settings.contextLines > 20 ||
        (source.activeId !== null &&
            (typeof source.activeId !== "number" ||
                !Number.isSafeInteger(source.activeId) ||
                source.activeId < 0)) ||
        !["anchor", "head"].every(
            (key) =>
                typeof source[key] === "number" &&
                Number.isSafeInteger(source[key]) &&
                source[key] >= 0 &&
                source[key] <= length,
        ) ||
        !["scrollTop", "scrollLeft"].every(
            (key) =>
                typeof source[key] === "number" &&
                Number.isFinite(source[key]) &&
                source[key] >= 0 &&
                source[key] <= 1_000_000_000,
        )
    )
        return null;
    return {
        settings: {
            navigation: settings.navigation as MergeViewSettings["navigation"],
            highlight: settings.highlight as MergeViewSettings["highlight"],
            advance: settings.advance,
            wrap: settings.wrap,
            collapse: settings.collapse,
            contextLines: settings.contextLines,
        },
        activeId: source.activeId,
        anchor: source.anchor as number,
        head: source.head as number,
        scrollTop: source.scrollTop as number,
        scrollLeft: source.scrollLeft as number,
    };
}

/** Persisted result text and decisions, owned by one immutable conflict snapshot. */
export interface MergeDraft {
    snapshotId: string;
    content: string;
    hunks: Array<{
        id: number;
        from: number;
        to: number;
        resolved: boolean;
        decision?: MergeChoice;
        edited?: boolean;
        dismissedOurs?: boolean;
        dismissedTheirs?: boolean;
        reviewed?: boolean;
    }>;
    ignoreWhitespace?: boolean;
    view?: MergeViewState;
}

/** Accepts absent values and booleans without treating null as absent. */
function isOptionalBoolean(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === "boolean";
}

/** Validates and normalizes one hunk against the preceding range and IDs. */
function parseMergeDraftHunk(
    raw: unknown,
    previous: number,
    ids: Set<number>,
    contentLength: number,
): MergeDraft["hunks"][number] | null {
    if (!raw || typeof raw !== "object") return null;
    const entry = raw as Record<string, unknown>;
    if (
        typeof entry.id !== "number" ||
        !Number.isSafeInteger(entry.id) ||
        entry.id < 0 ||
        ids.has(entry.id) ||
        typeof entry.from !== "number" ||
        !Number.isSafeInteger(entry.from) ||
        typeof entry.to !== "number" ||
        !Number.isSafeInteger(entry.to) ||
        entry.from < previous ||
        entry.to < entry.from ||
        entry.to > contentLength ||
        typeof entry.resolved !== "boolean" ||
        (entry.decision !== undefined && !MERGE_CHOICES.includes(entry.decision as MergeChoice)) ||
        !["edited", "dismissedOurs", "dismissedTheirs", "reviewed"].every((key) =>
            isOptionalBoolean(entry[key]),
        )
    )
        return null;
    return {
        id: entry.id,
        from: entry.from,
        to: entry.to,
        resolved: entry.resolved,
        ...(entry.decision !== undefined ? { decision: entry.decision as MergeChoice } : {}),
        ...(typeof entry.edited === "boolean" ? { edited: entry.edited } : {}),
        ...(typeof entry.dismissedOurs === "boolean" ? { dismissedOurs: entry.dismissedOurs } : {}),
        ...(typeof entry.dismissedTheirs === "boolean"
            ? { dismissedTheirs: entry.dismissedTheirs }
            : {}),
        ...(typeof entry.reviewed === "boolean" ? { reviewed: entry.reviewed } : {}),
    };
}

/** Bounded validation shared by the host and the result editor. */
export function parseMergeDraft(value: unknown): MergeDraft | null {
    if (!value || typeof value !== "object") return null;
    const source = value as Record<string, unknown>;
    if (
        typeof source.snapshotId !== "string" ||
        !/^[a-f\d]{64}$/.test(source.snapshotId) ||
        typeof source.content !== "string" ||
        new TextEncoder().encode(source.content).length > 2 * 1024 * 1024 ||
        !Array.isArray(source.hunks) ||
        source.hunks.length > 20_000 ||
        !isOptionalBoolean(source.ignoreWhitespace)
    )
        return null;
    const hunks: MergeDraft["hunks"] = [];
    const ids = new Set<number>();
    let previous = 0;
    for (const raw of source.hunks as unknown[]) {
        const entry = parseMergeDraftHunk(raw, previous, ids, source.content.length);
        if (!entry) return null;
        hunks.push(entry);
        ids.add(entry.id);
        previous = entry.to;
    }
    const view = parseMergeViewState(source.view, source.content.length);
    return {
        snapshotId: source.snapshotId,
        content: source.content,
        hunks,
        ...(source.ignoreWhitespace !== undefined
            ? { ignoreWhitespace: source.ignoreWhitespace }
            : {}),
        ...(view ? { view } : {}),
    };
}

/** Draft persistence and immutable-snapshot Apply commands for Git merge sessions. */
export type MergeWorkbenchOutbound =
    | { type: "loadMergeDraft" }
    | { type: "saveMergeDraft"; draft: MergeDraft; revision: number }
    | { type: "discardMergeDraft"; snapshotId: string }
    | { type: "applyResolution"; content: string; snapshotId: string; openNext?: boolean }
    | {
          type: "compareMergeVersion";
          snapshotId: string;
          side: "ours" | "theirs" | "result";
          content?: string;
      }
    | { type: "loadMergeFiles" }
    | { type: "openMergeFile"; filePath: string }
    | { type: "reviewMergeFile"; filePath: string };

/** Apply failures leave the editable document mounted and its history intact. */
export type MergeWorkbenchInbound =
    | { type: "mergeDraft"; draft: MergeDraft | null }
    | { type: "mergeDraftSaved"; revision: number }
    | { type: "resolutionError"; message: string }
    | { type: "resolutionApplied" }
    | { type: "mergeFileQueue"; files: Array<{ path: string; resolved: boolean }> };
