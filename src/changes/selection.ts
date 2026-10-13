import type { ChangeBlock } from "../webviews/protocol/changeSelection";

/** Keeps newline bytes, including a final line without a newline. */
function textLines(content: string): string[] {
    return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Returns only editable change identities; context lines cannot become mutations. */
export function changeIds(blocks: readonly ChangeBlock[]): string[] {
    return blocks.flatMap((block) =>
        block.lines.filter((line) => line.kind !== "context").map((line) => line.id),
    );
}

/** Validates a bounded selection before any host can construct a commit blob. */
export function validateSelection(
    blocks: readonly ChangeBlock[],
    ids: readonly string[],
): Set<string> {
    const available = new Set(changeIds(blocks));
    if (ids.length > available.size || new Set(ids).size !== ids.length) {
        throw new Error("Invalid or duplicate change selection.");
    }
    for (const id of ids) if (!available.has(id)) throw new Error("The change selection is stale.");
    return new Set(ids);
}

/** Constructs selected content without touching a worktree or accepting a browser patch. */
export function selectedContent(
    base: string,
    blocks: readonly ChangeBlock[],
    ids: readonly string[],
): string {
    const selected = validateSelection(blocks, ids);
    const source = textLines(base);
    const output: string[] = [];
    let offset = 0;
    for (const block of blocks) {
        const start = block.oldCount === 0 ? block.oldStart : block.oldStart - 1;
        if (start < offset || start > source.length) throw new Error("Invalid diff block range.");
        output.push(...source.slice(offset, start));
        offset = start;
        for (const line of block.lines) {
            if (line.kind === "add") {
                if (selected.has(line.id)) output.push(line.text);
                continue;
            }
            if (source[offset] !== line.text)
                throw new Error("The diff no longer matches its base.");
            if (line.kind === "context" || !selected.has(line.id)) output.push(line.text);
            offset++;
        }
        if (offset !== start + block.oldCount) throw new Error("Invalid diff block length.");
    }
    output.push(...source.slice(offset));
    return output.join("");
}
