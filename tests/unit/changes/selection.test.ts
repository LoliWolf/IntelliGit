import { describe, expect, it } from "vitest";
import { parseChangeDiff } from "../../../src/changes/parseDiff";
import { changeIds, selectedContent, validateSelection } from "../../../src/changes/selection";

const base = "one\ntwo\nthree\n";
const target = "one\nchanged\nthree\n";
const diff = "@@ -1,3 +1,3 @@\n one\n-two\n+changed\n three\n";

describe("partial change selections", () => {
    it("selects a complete replacement, a deletion, or an addition without editing other lines", () => {
        const blocks = parseChangeDiff(diff, base, target);
        expect(selectedContent(base, blocks, [])).toBe(base);
        expect(selectedContent(base, blocks, changeIds(blocks))).toBe(target);
        expect(selectedContent(base, blocks, ["0:1"])).toBe("one\nthree\n");
        expect(selectedContent(base, blocks, ["0:2"])).toBe("one\ntwo\nchanged\nthree\n");
    });

    it("retains exact CRLF and a final line without a newline", () => {
        const blocks = parseChangeDiff(
            "@@ -1,2 +1,2 @@\n one\r\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
            "one\r\nold",
            "one\r\nnew",
        );
        expect(selectedContent("one\r\nold", blocks, changeIds(blocks))).toBe("one\r\nnew");
    });

    it("handles an empty base and an insertion after the last existing line", () => {
        const empty = parseChangeDiff("@@ -0,0 +1 @@\n+new\n", "", "new\n");
        expect(selectedContent("", empty, changeIds(empty))).toBe("new\n");
        const append = parseChangeDiff("@@ -1,0 +2 @@\n+next\n", "one\n", "one\nnext\n");
        expect(selectedContent("one\n", append, changeIds(append))).toBe("one\nnext\n");
    });

    it("refuses duplicate, unknown and context identities", () => {
        const blocks = parseChangeDiff(diff, base, target);
        expect(() => validateSelection(blocks, ["0:1", "0:1"])).toThrow();
        expect(() => validateSelection(blocks, ["0:0"])).toThrow();
        expect(() => validateSelection(blocks, ["bad"])).toThrow();
    });

    it("rejects truncated diffs and mismatched targets", () => {
        expect(() => parseChangeDiff(diff.slice(0, -8), base, target)).toThrow();
        expect(() => parseChangeDiff(diff, base, target + "extra")).toThrow();
    });
});
