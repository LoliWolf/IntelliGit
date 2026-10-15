/** One host-parsed line in an immutable ordinary-text diff. */
export interface ChangeLine {
    id: string;
    fingerprint: string;
    kind: "context" | "add" | "remove";
    text: string;
    oldLine: number | null;
    newLine: number | null;
}

/** A selectable diff block; context lines are never selectable. */
export interface ChangeBlock {
    id: string;
    fingerprint: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: ChangeLine[];
}

/** Browser-safe snapshot; filesystem and index identities remain in the host. */
export interface ChangeFileView {
    snapshotId: string;
    path: string;
    side: "working" | "index";
    base: string;
    blocks: ChangeBlock[];
}

/** Named worktree metadata, independent of Git's index. */
interface Changelist {
    id: string;
    name: string;
}

/** Only fingerprints, not complete file contents, are persisted for block ownership. */
export interface ChangeOwnership {
    contentId: string;
    lines: Record<string, string>;
    stale?: boolean;
    totalChanges?: number;
    selections?: Record<
        string,
        {
            contentId: string;
            lineIds: string[];
            total: number;
        }
    >;
}

/** Revisioned host-owned lists for one captured repository. */
export interface ChangelistState {
    revision: number;
    activeId: string;
    lists: Changelist[];
    files: Record<string, string>;
    changes: Record<string, ChangeOwnership>;
}

/** One correlated selection; the host resolves every identifier from its own snapshot. */
export interface SelectedFileChanges {
    snapshotId: string;
    lineIds: string[];
}
