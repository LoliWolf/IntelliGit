import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { parse as parsePlist } from "@plist/xml.parse";
import * as vscode from "vscode";
import type { SyntaxTheme, SyntaxThemeRule } from "../webviews/protocol/syntaxTheme";

/** Treats malformed extension metadata and settings as empty objects. */
function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

/** Accepts only VS Code's hex color forms, keeping executable CSS out of webviews. */
function color(value: unknown): string | undefined {
    return typeof value === "string" &&
        /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
        ? value
        : undefined;
}

/** Drops unsupported values while retaining contributed VS Code color token names. */
function colors(value: unknown): Record<string, string> {
    return Object.fromEntries(
        Object.entries(record(value)).flatMap(([key, value]) => {
            const resolved = color(value);
            return resolved ? [[key, resolved]] : [];
        }),
    );
}

/** Normalizes TextMate scopes and settings without forwarding malformed rules. */
function rules(value: unknown): SyntaxThemeRule[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const source = record(entry);
        const settings = record(source.settings);
        const foreground = color(settings.foreground);
        const background = color(settings.background);
        const fontStyle = typeof settings.fontStyle === "string" ? settings.fontStyle : undefined;
        if (!foreground && !background && fontStyle === undefined) return [];
        const scope = source.scope;
        if (
            scope !== undefined &&
            typeof scope !== "string" &&
            !(Array.isArray(scope) && scope.every((item) => typeof item === "string"))
        )
            return [];
        return [
            {
                scope,
                settings: { foreground, background, fontStyle },
            },
        ];
    });
}

/** Loads JSONC includes in parent-first order and rejects cycles and malformed files. */
async function loadTheme(
    file: string,
    ancestors = new Set<string>(),
): Promise<Omit<SyntaxTheme, "name" | "type">> {
    const absolute = path.resolve(file);
    if (ancestors.has(absolute) || ancestors.size >= 32)
        throw new Error("Cyclic color theme include.");
    const errors: ParseError[] = [];
    const text = await readFile(absolute, "utf8");
    if (path.extname(absolute).toLowerCase() === ".tmtheme") {
        const settings = record(parsePlist(text)).settings;
        const defaults: unknown = Array.isArray(settings)
            ? settings.find((entry) => !record(entry).scope)
            : undefined;
        const global = record(record(defaults).settings);
        return {
            colors: colors({
                "editor.foreground": global.foreground,
                "editor.background": global.background,
            }),
            tokenColors: rules(settings),
        };
    }
    const source = record(parse(text, errors, { allowTrailingComma: true }));
    if (errors.length) throw new Error("Invalid color theme JSON.");
    const parent =
        typeof source.include === "string"
            ? await loadTheme(
                  path.resolve(path.dirname(absolute), source.include),
                  new Set([...ancestors, absolute]),
              )
            : { colors: {}, tokenColors: [] };
    const tokenColors =
        typeof source.tokenColors === "string"
            ? rules(
                  record(
                      parsePlist(
                          await readFile(
                              path.resolve(path.dirname(absolute), source.tokenColors),
                              "utf8",
                          ),
                      ),
                  ).settings,
              )
            : rules(source.tokenColors);
    return {
        colors: { ...parent.colors, ...colors(source.colors) },
        tokenColors: [...parent.tokenColors, ...tokenColors],
    };
}

/** VS Code accepts multiple bracketed selectors and '*' wildcards for theme-specific settings. */
function matchesTheme(selector: string, names: readonly string[]): boolean {
    const patterns = [...selector.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
    return patterns.some((pattern) => {
        const expression = pattern
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*");
        return names.some((name) => new RegExp(`^${expression}$`).test(name));
    });
}

/** Orders global overrides before matching selectors so theme-specific settings take precedence. */
function customizations(value: unknown, names: readonly string[]): Record<string, unknown>[] {
    const settings = record(value);
    return [
        settings,
        ...Object.entries(settings)
            .filter(([key]) => key.startsWith("[") && matchesTheme(key, names))
            .map(([, value]) => record(value)),
    ];
}

const GROUP_SCOPES: Record<string, string[]> = {
    comments: ["comment", "punctuation.definition.comment"],
    strings: ["string", "meta.embedded.assembly"],
    keywords: ["keyword - keyword.operator", "keyword.control", "storage", "storage.type"],
    numbers: ["constant.numeric"],
    types: ["entity.name.type", "entity.name.class", "support.type", "support.class"],
    functions: ["entity.name.function", "support.function"],
    variables: ["variable", "entity.name.variable"],
};

/** Expands editor token groups before applying explicit TextMate rules. */
function customizationRules(settings: Record<string, unknown>): SyntaxThemeRule[] {
    const groups = Object.entries(GROUP_SCOPES).flatMap(([key, scope]) => {
        const value = settings[key];
        return rules([
            { scope, settings: typeof value === "string" ? { foreground: value } : value },
        ]);
    });
    return [...groups, ...rules(settings.textMateRules)];
}

/** Resolves contributed theme IDs/labels using public extension metadata, then applies user overrides. */
export async function resolveSyntaxTheme(resource?: vscode.Uri): Promise<SyntaxTheme | null> {
    const configured = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
    if (!configured) return null;
    for (const extension of vscode.extensions.all) {
        const contributions = record(record(extension.packageJSON).contributes).themes;
        if (!Array.isArray(contributions)) continue;
        const contribution = contributions
            .map(record)
            .find((theme) => theme.id === configured || theme.label === configured);
        if (!contribution || typeof contribution.path !== "string") continue;
        const resolved = await loadTheme(path.resolve(extension.extensionPath, contribution.path));
        const names = [configured, contribution.id, contribution.label].filter(
            (value): value is string => typeof value === "string",
        );
        const editor = vscode.workspace.getConfiguration("editor", resource);
        const syntaxOverrides = customizations(editor.get("tokenColorCustomizations"), names);
        const workbench = vscode.workspace.getConfiguration("workbench");
        const colorOverrides = customizations(workbench.get("colorCustomizations"), names);
        const type =
            vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
            vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
                ? "light"
                : "dark";
        return {
            name: "intelligit-host-theme",
            type,
            colors: colorOverrides.reduce<Record<string, string>>(
                (result, override) => ({ ...result, ...colors(override) }),
                resolved.colors,
            ),
            tokenColors: [...resolved.tokenColors, ...syntaxOverrides.flatMap(customizationRules)],
        };
    }
    return null;
}
