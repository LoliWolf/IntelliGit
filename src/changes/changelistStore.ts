import { randomUUID } from "node:crypto";
import { assertRepoRelativePath } from "../utils/repoRelativePath";
import type { ChangelistState, ChangeOwnership } from "../webviews/protocol/changeSelection";

interface MetadataStorage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

interface CommitInclusion {
    path: string;
    contentId: string;
    lineIds: readonly string[];
    total: number;
}

const STORAGE_KEY = "intelligit.changelists.v1";
/** A stable fallback independent of locale or a user-created list name. */
export const DEFAULT_CHANGELIST_ID = "default";
const instances = new WeakMap<MetadataStorage, ChangelistStore>();
const MAX_LISTS = 100;
const MAX_FILES = 20_000;

function emptyState(): ChangelistState {
    return {
        revision: 0,
        activeId: DEFAULT_CHANGELIST_ID,
        lists: [{ id: DEFAULT_CHANGELIST_ID, name: "Default" }],
        files: Object.create(null) as Record<string, string>,
        changes: Object.create(null) as Record<string, ChangeOwnership>,
    };
}

function nameFor(value: string): string {
    const name = value.trim();
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) {
        throw new Error("A changelist name must contain 1 to 80 printable characters.");
    }
    return name;
}

/** Serialized, revisioned worktree metadata shared by docked and undocked providers. */
export class ChangelistStore {
    private readonly roots = new Map<string, ChangelistState>();
    private writes = Promise.resolve();
    private readonly listeners = new Set<(root: string, state: ChangelistState) => void>();
    private loadError?: string;
    private readonly commitLeases = new Map<string, string>();

    /** Reuses the workspace store so independent panels cannot overwrite each other's lists. */
    static forStorage(storage?: MetadataStorage): ChangelistStore {
        if (!storage) return new ChangelistStore();
        const previous = instances.get(storage);
        if (previous) return previous;
        const store = new ChangelistStore(storage);
        instances.set(storage, store);
        return store;
    }

    /** Loads only bounded, well-formed metadata; corrupt records never redirect Git. */
    constructor(private readonly storage?: MetadataStorage) {
        const saved = storage?.get<unknown>(STORAGE_KEY);
        if (saved === undefined) return;
        if (
            !saved ||
            typeof saved !== "object" ||
            !("entries" in saved) ||
            !("schemaVersion" in saved) ||
            saved.schemaVersion !== 1
        ) {
            this.loadError = "Changelist metadata is invalid and will not be overwritten.";
            return;
        }
        const entries = (saved as { entries?: unknown }).entries;
        if (!Array.isArray(entries) || entries.length > 128) {
            this.loadError = "Changelist metadata is invalid and will not be overwritten.";
            return;
        }
        for (const value of entries as unknown[]) {
            const entry = metadataRecord(value);
            if (
                !entry ||
                typeof entry.root !== "string" ||
                !entry.state ||
                this.roots.has(entry.root)
            ) {
                this.loadError = "Changelist metadata is invalid and will not be overwritten.";
                return;
            }
            const state = parseState(entry.state);
            if (!state) {
                this.loadError = "Changelist metadata is invalid and will not be overwritten.";
                return;
            }
            this.roots.set(entry.root, state);
        }
    }

    /** Returns an independent snapshot without exposing mutable host-owned maps. */
    get(root: string): ChangelistState {
        if (this.loadError) throw new Error(this.loadError);
        return structuredClone(this.roots.get(root) ?? emptyState());
    }

    /** Subscriptions report metadata changes only, never Git or filesystem mutations. */
    subscribe(listener: (root: string, state: ChangelistState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Reserves metadata after pending writes, preventing membership changes during a commit. */
    async beginCommit(root: string): Promise<() => void> {
        const operation = this.writes.then(() => {
            if (this.commitLeases.has(root))
                throw new Error("A selected commit is already in progress.");
            const state = this.get(root);
            const token = randomUUID();
            this.commitLeases.set(root, token);
            this.notify(root, state);
            return () => {
                if (this.commitLeases.get(root) !== token) return;
                this.commitLeases.delete(root);
                this.notify(root, this.get(root));
            };
        });
        this.writes = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    /** Shared providers expose the same root's semantic commit fence. */
    isCommitting(root: string): boolean {
        return this.commitLeases.has(root);
    }

    /** Assigns first-seen files to the active list without rescanning any file's diff. */
    async reconcileFiles(root: string, paths: readonly string[]): Promise<ChangelistState> {
        if (paths.length > MAX_FILES) throw new Error("Too many changelist files.");
        const safe = [...new Set(paths.map(assertRepoRelativePath))];
        if (safe.length > MAX_FILES) throw new Error("Too many changelist files.");
        return this.write(
            root,
            undefined,
            (state) => {
                const current = new Set(safe);
                for (const file of Object.keys(state.files)) {
                    if (!current.has(file)) {
                        delete state.files[file];
                        delete state.changes[file];
                    }
                }
                for (const file of safe) {
                    if (!Object.hasOwn(state.files, file)) state.files[file] = state.activeId;
                }
            },
            false,
        );
    }

    /** Creates a named list under revision compare-and-swap. */
    create(root: string, revision: number, name: string): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            if (state.lists.length >= MAX_LISTS) throw new Error("Too many changelists.");
            const accepted = nameFor(name);
            if (state.lists.some((list) => list.name.toLowerCase() === accepted.toLowerCase())) {
                throw new Error("A changelist with this name already exists.");
            }
            state.lists.push({ id: randomUUID(), name: accepted });
        });
    }

    /** Renames only a user list; the default list remains a stable fallback. */
    rename(root: string, revision: number, id: string, name: string): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            const list = requireList(state, id);
            if (id === DEFAULT_CHANGELIST_ID)
                throw new Error("The default changelist cannot be renamed.");
            const accepted = nameFor(name);
            if (
                state.lists.some(
                    (item) => item.id !== id && item.name.toLowerCase() === accepted.toLowerCase(),
                )
            ) {
                throw new Error("A changelist with this name already exists.");
            }
            list.name = accepted;
        });
    }

    /** Changes where subsequently discovered files are assigned, not Git's index. */
    activate(root: string, revision: number, id: string): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            requireList(state, id);
            state.activeId = id;
        });
    }

    /** Moves checked files atomically and drops their obsolete per-line ownership. */
    moveFiles(
        root: string,
        revision: number,
        id: string,
        paths: readonly string[],
    ): Promise<ChangelistState> {
        if (paths.length > MAX_FILES) throw new Error("Too many changelist files.");
        const safe = paths.map(assertRepoRelativePath);
        return this.write(root, revision, (state) => {
            requireList(state, id);
            for (const file of safe) {
                if (!Object.hasOwn(state.files, file)) throw new Error("The file list changed.");
                state.files[file] = id;
                delete state.changes[file];
            }
        });
    }

    /** Removing a list moves its members to Default without staging or deleting anything. */
    remove(root: string, revision: number, id: string): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            requireList(state, id);
            if (id === DEFAULT_CHANGELIST_ID)
                throw new Error("The default changelist cannot be removed.");
            state.lists = state.lists.filter((list) => list.id !== id);
            if (state.activeId === id) state.activeId = DEFAULT_CHANGELIST_ID;
            for (const file of Object.keys(state.files)) {
                if (state.files[file] === id) state.files[file] = DEFAULT_CHANGELIST_ID;
            }
            for (const ownership of Object.values(state.changes)) {
                if (ownership.selections) delete ownership.selections[id];
                for (const line of Object.keys(ownership.lines)) {
                    if (ownership.lines[line] === id) ownership.lines[line] = DEFAULT_CHANGELIST_ID;
                }
            }
        });
    }

    /** Pins line ownership to a content identity and marks changed assignments for review. */
    registerChanges(
        root: string,
        file: string,
        contentId: string,
        totalChanges?: number,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        return this.write(
            root,
            undefined,
            (state) => {
                if (!Object.hasOwn(state.files, safe)) state.files[safe] = state.activeId;
                const previous = state.changes[safe];
                if (!previous) state.changes[safe] = { contentId, lines: {}, totalChanges };
                else if (previous.contentId !== contentId) {
                    state.changes[safe] = {
                        ...previous,
                        contentId,
                        stale: Object.keys(previous.lines).length > 0,
                        totalChanges,
                    };
                }
            },
            false,
        );
    }

    /** Explicitly reviewed line assignments replace the current snapshot's metadata only. */
    assignChanges(
        root: string,
        revision: number,
        file: string,
        contentId: string,
        id: string,
        fingerprints: readonly string[],
        validFingerprints: ReadonlySet<string>,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        return this.write(root, revision, (state) => {
            requireList(state, id);
            const ownership = state.changes[safe];
            if (!ownership || ownership.contentId !== contentId)
                throw new Error("The change snapshot is stale.");
            if (ownership.stale && new Set(fingerprints).size !== validFingerprints.size) {
                throw new Error(
                    "Review all current changes before replacing outdated assignments.",
                );
            }
            const lines = ownership.stale ? {} : { ...ownership.lines };
            for (const fingerprint of fingerprints) {
                if (!validFingerprints.has(fingerprint))
                    throw new Error("Unknown change assignment.");
                lines[fingerprint] = id;
            }
            state.changes[safe] = { ...ownership, contentId, lines, stale: false };
        });
    }

    /** Records explicit commit inclusion separately from list membership or the Git index. */
    recordSelection(
        root: string,
        file: string,
        contentId: string,
        scope: string,
        lineIds: readonly string[],
        total: number,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        if (lineIds.length > 100_000 || !Number.isSafeInteger(total) || total < lineIds.length) {
            throw new Error("Invalid partial commit selection.");
        }
        return this.write(root, undefined, (state) => {
            if (scope !== "all") requireList(state, scope);
            const previous = state.changes[safe] ?? { contentId, lines: {} };
            state.changes[safe] = {
                ...previous,
                selections: {
                    ...previous.selections,
                    [scope]: { contentId, lineIds: [...lineIds], total },
                },
            };
        });
    }

    /** The explicit whole-file action removes only the current view's partial inclusion. */
    resetSelection(
        root: string,
        revision: number,
        scope: string,
        paths: readonly string[],
    ): Promise<ChangelistState> {
        if (paths.length > MAX_FILES) throw new Error("Too many changelist files.");
        return this.write(root, revision, (state) => {
            if (scope !== "all") requireList(state, scope);
            for (const file of paths.map(assertRepoRelativePath)) {
                const selections = state.changes[file]?.selections;
                if (selections) delete selections[scope];
            }
        });
    }

    /** Persists exclusion fences before Git can publish, including the whole-file All view. */
    prepareCommitInclusion(
        root: string,
        revision: number,
        scope: string,
        files: readonly CommitInclusion[],
    ): Promise<ChangelistState> {
        if (!files.length || files.length > 64) throw new Error("Invalid selected commit files.");
        return this.write(
            root,
            revision,
            (state) => {
                if (!this.commitLeases.has(root))
                    throw new Error("A selected commit lease is required.");
                if (scope !== "all") requireList(state, scope);
                for (const file of files) {
                    const safe = assertRepoRelativePath(file.path);
                    if (
                        !Number.isSafeInteger(file.total) ||
                        file.total > 100_000 ||
                        file.lineIds.length === 0 ||
                        file.lineIds.length > file.total ||
                        new Set(file.lineIds).size !== file.lineIds.length
                    ) {
                        throw new Error("Invalid selected commit inclusion.");
                    }
                    const previous = state.changes[safe] ?? {
                        contentId: file.contentId,
                        lines: {},
                    };
                    const inclusion = {
                        contentId: file.contentId,
                        lineIds: [...file.lineIds],
                        total: file.total,
                    };
                    state.changes[safe] = {
                        ...previous,
                        selections: { ...previous.selections, all: inclusion, [scope]: inclusion },
                    };
                }
            },
            false,
        );
    }

    private async write(
        root: string,
        revision: number | undefined,
        mutate: (state: ChangelistState) => void,
        userMutation = true,
    ): Promise<ChangelistState> {
        const operation = this.writes
            .catch(() => undefined)
            .then(async () => {
                if (userMutation && this.commitLeases.has(root)) {
                    throw new Error("Changelists cannot change during a selected commit.");
                }
                const before = this.get(root);
                if (revision !== undefined && revision !== before.revision) {
                    throw new Error("Changelists changed. Refresh before retrying.");
                }
                const next = structuredClone(before);
                next.files = Object.assign(Object.create(null), next.files) as Record<
                    string,
                    string
                >;
                next.changes = Object.assign(Object.create(null), next.changes) as Record<
                    string,
                    ChangeOwnership
                >;
                mutate(next);
                if (JSON.stringify(before) === JSON.stringify(next)) return before;
                next.revision++;
                const entries = [...this.roots]
                    .filter(([key]) => key !== root)
                    .map(([key, state]) => ({ root: key, state }));
                entries.push({ root, state: next });
                if (entries.length > 128) throw new Error("Too many changelist repositories.");
                if (Buffer.byteLength(JSON.stringify(entries)) > 4 * 1024 * 1024) {
                    throw new Error("Changelist metadata exceeds its storage budget.");
                }
                await this.storage?.update(STORAGE_KEY, { schemaVersion: 1, entries });
                this.roots.set(root, next);
                this.notify(root, next);
                return structuredClone(next);
            });
        this.writes = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    /** Only known committed identities are consumed; unmatched remaining groups require review. */
    consumeCommitted(
        root: string,
        file: string,
        contentId: string,
        scope: string,
        committed: ReadonlySet<string>,
        available: ReadonlySet<string>,
        total: number,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        return this.write(
            root,
            undefined,
            (state) => {
                const previous = state.changes[safe] ?? { contentId, lines: {} };
                const lines = Object.fromEntries(
                    Object.entries(previous.lines).filter(([id]) => !committed.has(id)),
                );
                state.changes[safe] = {
                    ...previous,
                    contentId,
                    lines,
                    stale: Object.keys(lines).some((id) => !available.has(id)),
                    totalChanges: total,
                    selections: {
                        ...previous.selections,
                        all: { contentId, lineIds: [], total },
                        [scope]: { contentId, lineIds: [], total },
                    },
                };
            },
            false,
        );
    }

    private notify(root: string, state: ChangelistState): void {
        for (const listener of this.listeners) {
            try {
                listener(root, structuredClone(state));
            } catch (error) {
                console.error("[IntelliGit] Changelist delivery failed:", error);
            }
        }
    }
}

function requireList(state: ChangelistState, id: string) {
    const list = state.lists.find((entry) => entry.id === id);
    if (!list) throw new Error("The changelist no longer exists.");
    return list;
}

function parseState(value: unknown): ChangelistState | undefined {
    if (!metadataRecord(value)) return undefined;
    const state = value as ChangelistState;
    if (!validStateHeader(state)) return undefined;
    try {
        const ids = new Set<string>();
        for (const list of state.lists) {
            if (
                typeof list.id !== "string" ||
                typeof list.name !== "string" ||
                (list.id !== DEFAULT_CHANGELIST_ID && !/^[a-f0-9-]{36}$/.test(list.id))
            )
                return undefined;
            nameFor(list.name);
            if (ids.has(list.id)) return undefined;
            ids.add(list.id);
        }
        if (!ids.has(DEFAULT_CHANGELIST_ID) || !ids.has(state.activeId)) return undefined;
        if (Object.keys(state.files).length > MAX_FILES) return undefined;
        for (const [file, id] of Object.entries(state.files)) {
            assertRepoRelativePath(file);
            if (!ids.has(id)) return undefined;
        }
        for (const [file, ownership] of Object.entries(state.changes)) {
            assertRepoRelativePath(file);
            if (!validOwnership(ownership, ids)) return undefined;
        }
        return structuredClone(state);
    } catch {
        return undefined;
    }
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function validStateHeader(state: ChangelistState): boolean {
    return (
        Number.isSafeInteger(state.revision) &&
        state.revision >= 0 &&
        Array.isArray(state.lists) &&
        state.lists.length <= MAX_LISTS &&
        metadataRecord(state.files) !== undefined &&
        metadataRecord(state.changes) !== undefined
    );
}

function validOwnership(ownership: ChangeOwnership, ids: ReadonlySet<string>): boolean {
    if (
        !metadataRecord(ownership) ||
        typeof ownership.contentId !== "string" ||
        !metadataRecord(ownership.lines) ||
        (ownership.stale !== undefined && typeof ownership.stale !== "boolean")
    )
        return false;
    if (
        ownership.totalChanges !== undefined &&
        (!Number.isSafeInteger(ownership.totalChanges) ||
            ownership.totalChanges < 0 ||
            ownership.totalChanges > 100_000)
    )
        return false;
    for (const [fingerprint, id] of Object.entries(ownership.lines)) {
        if (!/^[a-f0-9]{64}$/.test(fingerprint) || !ids.has(id)) return false;
    }
    return validCommitSelections(ownership, ids);
}

function validCommitSelections(ownership: ChangeOwnership, ids: ReadonlySet<string>): boolean {
    if (ownership.selections === undefined) return true;
    if (!metadataRecord(ownership.selections)) return false;
    for (const [scope, selection] of Object.entries(ownership.selections)) {
        if (scope !== "all" && !ids.has(scope)) return false;
        if (
            !metadataRecord(selection) ||
            typeof selection.contentId !== "string" ||
            !Array.isArray(selection.lineIds) ||
            selection.lineIds.length > 100_000 ||
            selection.lineIds.some(
                (id) => typeof id !== "string" || !/^\d{1,5}:\d{1,6}$/.test(id),
            ) ||
            !Number.isSafeInteger(selection.total) ||
            selection.total < selection.lineIds.length ||
            selection.total > 100_000
        )
            return false;
    }
    return true;
}
