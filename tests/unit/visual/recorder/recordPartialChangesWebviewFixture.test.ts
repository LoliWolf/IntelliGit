import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";
vi.mock("vscode", () => createCommitInfoVscodeDouble());
import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { REPOSITORY_SCENARIOS } from "../../../fixtures/repo/scenarios";
import { recordPartialChangesWebviewFixture } from "../../../visual/recorder/recordPartialChangesWebviewFixture";
import { serializeWebviewFixture } from "../../../visual/recorder/webviewFixtureFile";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";

afterEach(() => setE2eControlChannelActive(false));

it("records an ordinary diff through production and keeps the committed fixture reproducible", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "intelligit-partial-recorder-"));
    try {
        const scenario = REPOSITORY_SCENARIOS.find((entry) => entry.id === "dirty")!;
        const workspace = await scenario.prepare(path.join(scratch, "repository"));
        if (!workspace.template) throw new Error("Dirty recording needs a template.");
        setE2eControlChannelActive(true);
        const fixture = await recordPartialChangesWebviewFixture({
            repoRoot: workspace.root,
            roots: {
                root: workspace.root,
                originRoot: workspace.template.originRoot,
                profileDir: "",
            },
            env: workspace.env,
        });
        const bytes = serializeWebviewFixture(fixture);
        const destination = path.resolve(
            __dirname,
            "../../../visual/fixtures/partial-changes/dirty.json",
        );
        if (process.env.UPDATE_PARTIAL_FIXTURE === "1") await writeFile(destination, bytes);
        expect(await readFile(destination, "utf8")).toBe(bytes);
        expect(fixture.messages).toHaveLength(1);
    } finally {
        await removeScratchDirectories(scratch);
    }
}, 60_000);
