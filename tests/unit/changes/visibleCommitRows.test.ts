// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { visibleCommitRows } from "../../../src/webviews/react/commit-panel/components/VirtualFileTreeRows";
import type { WorkingFile } from "../../../src/types";

const file: WorkingFile = {
    path: "one/a.txt",
    status: "M",
    staged: false,
    additions: 1,
    deletions: 0,
};

describe("virtual commit tree projection", () => {
    it("retains folders but omits collapsed children", () => {
        const entries = [
            {
                type: "folder" as const,
                name: "one",
                path: "one",
                children: [{ type: "file" as const, file }],
            },
        ];
        expect(visibleCommitRows(entries, () => false)).toHaveLength(1);
        expect(visibleCommitRows(entries, () => true).map((row) => row.depth)).toEqual([0, 1]);
    });

    it("does not collapse staged and unstaged rows with the same path", () => {
        const rows = visibleCommitRows(
            [
                { type: "file", file },
                { type: "file", file: { ...file, staged: true } },
            ],
            () => true,
        );
        expect(rows).toHaveLength(2);
    });
});
