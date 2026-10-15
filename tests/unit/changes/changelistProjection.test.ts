import { describe, expect, it } from "vitest";
import { changelistFiles } from "../../../src/webviews/react/commit-panel/hooks/useChangelists";
import type { ChangelistState } from "../../../src/webviews/protocol/changeSelection";
import type { WorkingFile } from "../../../src/types";

const file: WorkingFile = {
    path: "one.txt",
    status: "M",
    staged: false,
    additions: 2,
    deletions: 2,
};

describe("changelist file projection", () => {
    it("does not show an empty default membership when all known lines moved to another list", () => {
        const state: ChangelistState = {
            revision: 1,
            activeId: "default",
            lists: [
                { id: "default", name: "Default" },
                { id: "feature", name: "Feature" },
            ],
            files: { "one.txt": "default" },
            changes: {
                "one.txt": {
                    contentId: "content",
                    totalChanges: 2,
                    lines: { first: "feature", second: "feature" },
                },
            },
        };
        expect(changelistFiles([file], state, "default")).toEqual([]);
        expect(changelistFiles([file], state, "feature")).toEqual([file]);
        expect(changelistFiles([file], state, "all")).toEqual([file]);
    });

    it("retains whole-file structural changes and stale assignments for explicit review", () => {
        const state: ChangelistState = {
            revision: 1,
            activeId: "default",
            lists: [{ id: "default", name: "Default" }],
            files: { "one.txt": "default" },
            changes: { "one.txt": { contentId: "content", totalChanges: 0, lines: {} } },
        };
        expect(changelistFiles([file], state, "default")).toEqual([file]);
    });
});
