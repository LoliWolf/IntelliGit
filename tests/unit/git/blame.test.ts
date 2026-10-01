import { describe, expect, it } from "vitest";
import { blameDate, parseBlame } from "../../../src/git/blame";

const commit = "a".repeat(40);
const record = (line: number, source = "source", hash = commit) =>
    `${hash} ${line} ${line} 1\nauthor Ada Lovelace\nauthor-mail <ada@example.invalid>\nauthor-time 946684800\nauthor-tz -0800\ncommitter Ada\nsummary Fix *format* [link](command:bad)\nboundary\nfilename file with spaces.ts\n\t${source}\n`;

describe("line-porcelain blame", () => {
    it("parses metadata and zero-based line numbers for each line", () => {
        expect(parseBlame(record(1) + record(2, "\tauthor Fake"))).toEqual([
            {
                commit,
                line: 0,
                author: "Ada Lovelace",
                authorTime: 946684800,
                authorTimezone: "-0800",
                summary: "Fix *format* [link](command:bad)",
            },
            expect.objectContaining({ line: 1, author: "Ada Lovelace" }),
        ]);
    });

    it("handles SHA-256 repositories and uncommitted zero hashes", () => {
        expect(parseBlame(record(1, "", "b".repeat(64)))[0].commit).toHaveLength(64);
        expect(parseBlame(record(1, "", "0".repeat(40)))[0].commit).toBe("0".repeat(40));
    });

    it("accepts empty output and a final line without an output newline", () => {
        expect(parseBlame("")).toEqual([]);
        expect(parseBlame(record(1).trimEnd())).toHaveLength(1);
    });

    it.each([
        "unexpected",
        `${commit} 1 1\nauthor Ada\n`,
        "\tsource\n",
        `${commit} 1 1\n${commit} 2 2\n`,
    ])("rejects invalid or incomplete output %s", (output) =>
        expect(() => parseBlame(output)).toThrow(),
    );

    it("uses the author's timezone rather than the host timezone for the date", () => {
        const line = parseBlame(record(1))[0];
        expect(blameDate(line)).toBe("1999-12-31");
        expect(blameDate({ ...line, authorTimezone: "+1400" })).toBe("2000-01-01");
        expect(blameDate({ ...line, authorTime: NaN })).toBe("");
    });
});
