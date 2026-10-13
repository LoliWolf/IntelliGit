interface SavedMergeResult {
    path: string;
    base: string;
    result: string;
}

/** Bounded, read-only review snapshots; never used to restore files or Git index stages. */
export class MergeResultHistory {
    private readonly entries = new Map<
        string,
        {
            root: string;
            operation: string;
            value: SavedMergeResult;
            bytes: number;
        }
    >();
    private bytes = 0;

    /** Records only a successfully staged result, evicting the oldest review snapshots. */
    record(root: string, operation: string, value: SavedMergeResult): void {
        const key = JSON.stringify([root, operation, value.path]);
        this.bytes -= this.entries.get(key)?.bytes ?? 0;
        this.entries.delete(key);
        const bytes =
            Buffer.byteLength(value.base, "utf8") + Buffer.byteLength(value.result, "utf8");
        this.entries.set(key, { root, operation, value: { ...value }, bytes });
        this.bytes += bytes;
        while (this.bytes > 16 * 1024 * 1024 || this.entries.size > 64) {
            const oldest = this.entries.entries().next().value!;
            this.bytes -= oldest[1].bytes;
            this.entries.delete(oldest[0]);
        }
    }

    /** Keeps unrelated repositories and Git operation identities out of a file queue. */
    list(root: string, operation: string): SavedMergeResult[] {
        return [...this.entries.values()]
            .filter((entry) => entry.root === root && entry.operation === operation)
            .map((entry) => ({ ...entry.value }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
}
