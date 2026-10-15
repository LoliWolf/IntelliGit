import { createHash } from "node:crypto";
import type { ChangeBlock, ChangeLine } from "../webviews/protocol/changeSelection";
import { changeIds, selectedContent } from "./selection";
const LINE_KINDS: Partial<Record<string, ChangeLine["kind"]>> = {
    "+": "add",
    "-": "remove",
    " ": "context",
};

/** Identifies snapshot content without retaining full text in metadata keys. */
export function changeFingerprint(content: string | Uint8Array): string {
    return createHash("sha256").update(content).digest("hex");
}

/** Parses Git's bounded text diff and proves that all changes reconstruct the captured target. */
export function parseChangeDiff(diff: string, base: string, target: string): ChangeBlock[] {
    const blocks: ChangeBlock[] = [];
    let current: ChangeBlock | undefined;
    let oldLine = 0;
    let newLine = 0;
    for (const raw of diff.split("\n")) {
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(raw);
        if (header) {
            current = {
                id: String(blocks.length),
                fingerprint: "",
                oldStart: Number(header[1]),
                oldCount: Number(header[2] ?? 1),
                newStart: Number(header[3]),
                newCount: Number(header[4] ?? 1),
                lines: [],
            };
            oldLine = current.oldStart;
            newLine = current.newStart;
            blocks.push(current);
            continue;
        }
        if (!current || raw === "") continue;
        if (raw === "\\ No newline at end of file") {
            const previous = current.lines.at(-1);
            if (!previous || !previous.text.endsWith("\n"))
                throw new Error("Invalid newline marker.");
            previous.text = previous.text.slice(0, -1);
            continue;
        }
        const kind = LINE_KINDS[raw[0]];
        if (!kind) throw new Error("Unsupported Git diff content.");
        const line: ChangeLine = {
            id: `${current.id}:${current.lines.length}`,
            fingerprint: "",
            kind,
            text: raw.slice(1) + "\n",
            oldLine: kind === "add" ? null : oldLine++,
            newLine: kind === "remove" ? null : newLine++,
        };
        current.lines.push(line);
    }
    for (const block of blocks) finalizeBlock(block);
    if (selectedContent(base, blocks, changeIds(blocks)) !== target) {
        throw new Error("Git diff does not reconstruct the captured file.");
    }
    return blocks;
}

function finalizeBlock(block: ChangeBlock): void {
    const additions = block.lines.filter((line) => line.kind !== "remove").length;
    const removals = block.lines.filter((line) => line.kind !== "add").length;
    if (additions !== block.newCount || removals !== block.oldCount) {
        throw new Error("Invalid Git diff counts.");
    }
    block.fingerprint = changeFingerprint(
        JSON.stringify([
            block.oldStart,
            block.newStart,
            block.lines.map((line) => [line.kind, line.text]),
        ]),
    );
    for (const line of block.lines) {
        line.fingerprint = changeFingerprint(
            JSON.stringify([block.fingerprint, line.id.split(":")[1], line.kind, line.text]),
        );
    }
}
