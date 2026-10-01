import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    theme: "Custom Theme",
    kind: 2,
    extensions: [] as Array<{ extensionPath: string; packageJSON: unknown }>,
    tokens: {} as unknown,
    colors: {} as unknown,
}));
vi.mock("vscode", () => ({
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    window: {
        get activeColorTheme() {
            return { kind: state.kind };
        },
    },
    extensions: {
        get all() {
            return state.extensions;
        },
    },
    workspace: {
        getConfiguration: (section: string) => ({
            get: (key: string) =>
                section === "editor"
                    ? state.tokens
                    : key === "colorTheme"
                      ? state.theme
                      : state.colors,
        }),
    },
}));
import { resolveSyntaxTheme } from "../../../src/utils/syntaxTheme";

let directory: string;
beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "intelligit-syntax-theme-"));
    await mkdir(path.join(directory, "themes"));
    state.theme = "Custom Theme";
    state.kind = 2;
    state.tokens = {};
    state.colors = {};
    state.extensions = [
        {
            extensionPath: directory,
            packageJSON: {
                contributes: {
                    themes: [
                        { id: "Custom Theme", label: "Custom Label", path: "themes/child.json" },
                    ],
                },
            },
        },
    ];
});
afterEach(async () => {
    await removeScratchDirectories(directory);
});

async function theme(value: unknown): Promise<void> {
    await writeFile(path.join(directory, "themes/child.json"), JSON.stringify(value));
}

describe("active syntax theme", () => {
    it("loads JSONC parents and appends child rules without losing inherited syntax", async () => {
        await writeFile(
            path.join(directory, "themes/parent.json"),
            `{
            // Theme comments are valid JSONC.
            "colors": {"editor.foreground": "#abcdef", "editor.background": "#112233"},
            "tokenColors": [{"scope": "comment", "settings": {"foreground": "#778899"}}],
        }`,
        );
        await theme({
            include: "parent.json",
            colors: { "editor.background": "#223344" },
            tokenColors: [
                {
                    scope: ["keyword", "storage"],
                    settings: { foreground: "#bbccdd", fontStyle: "bold" },
                },
            ],
        });
        const result = await resolveSyntaxTheme();
        expect(result).toMatchObject({
            type: "dark",
            colors: { "editor.foreground": "#abcdef", "editor.background": "#223344" },
        });
        expect(result?.tokenColors.map((rule) => rule.scope)).toEqual([
            "comment",
            ["keyword", "storage"],
        ]);
    });

    it("applies global, wildcard and theme-specific rules after theme rules", async () => {
        await theme({ colors: { "editor.foreground": "#112233" }, tokenColors: [] });
        state.tokens = {
            comments: "#111111",
            textMateRules: [{ scope: "string", settings: { foreground: "#222222" } }],
            "[Custom*][Other]": { keywords: { foreground: "#333333", fontStyle: "italic" } },
            "[Custom Label]": {
                textMateRules: [{ scope: "keyword", settings: { foreground: "#444444" } }],
            },
            "[Unrelated]": { strings: "#ffffff" },
        };
        state.colors = {
            "editor.foreground": "#555555",
            "[Custom Theme]": { "editor.foreground": "#666666" },
        };
        const result = await resolveSyntaxTheme();
        expect(result?.tokenColors.map((rule) => rule.settings.foreground)).toEqual([
            "#111111",
            "#222222",
            "#333333",
            "#444444",
        ]);
        expect(result?.colors["editor.foreground"]).toBe("#666666");
    });

    it("matches contribution labels and both light theme kinds", async () => {
        await theme({ tokenColors: [] });
        state.theme = "Custom Label";
        for (const kind of [1, 4]) {
            state.kind = kind;
            expect((await resolveSyntaxTheme())?.type).toBe("light");
        }
    });

    it("sanitizes malformed colors, scopes and settings before sending them to Shiki", async () => {
        await theme({
            colors: { "editor.foreground": "url(unsafe)", "editor.background": "#fff" },
            tokenColors: [
                { scope: "comment", settings: { foreground: "red; display:none" } },
                { scope: ["keyword", 3], settings: { foreground: "#abcdef" } },
                { scope: "string", settings: { foreground: "#1234", fontStyle: "" } },
            ],
        });
        const result = await resolveSyntaxTheme();
        expect(result?.colors).toEqual({ "editor.background": "#fff" });
        expect(result?.tokenColors).toHaveLength(1);
        expect(result?.tokenColors[0].settings.fontStyle).toBe("");
    });

    it("rejects include cycles, malformed JSON and missing parents", async () => {
        await theme({ include: "child.json" });
        await expect(resolveSyntaxTheme()).rejects.toThrow("Cyclic");
        await writeFile(path.join(directory, "themes/child.json"), "{invalid");
        await expect(resolveSyntaxTheme()).rejects.toThrow("Invalid");
        await theme({ include: "missing.json" });
        await expect(resolveSyntaxTheme()).rejects.toThrow();
    });

    it("loads legacy plist token rules through the structured XML parser", async () => {
        await theme({ tokenColors: "legacy.tmTheme" });
        await writeFile(
            path.join(directory, "themes/legacy.tmTheme"),
            `<?xml version="1.0" encoding="UTF-8"?>
            <plist version="1.0"><dict><key>settings</key><array><dict>
            <key>scope</key><string>comment</string><key>settings</key><dict>
            <key>foreground</key><string>#123456</string></dict></dict></array></dict></plist>`,
        );
        expect((await resolveSyntaxTheme())?.tokenColors).toEqual([
            { scope: "comment", settings: { foreground: "#123456" } },
        ]);
    });

    it("returns a safe fallback when no active contribution can be resolved", async () => {
        state.theme = "Missing";
        expect(await resolveSyntaxTheme()).toBeNull();
        state.theme = "";
        expect(await resolveSyntaxTheme()).toBeNull();
    });
});
