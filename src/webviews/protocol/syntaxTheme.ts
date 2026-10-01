/** Serializable TextMate rules from the active VS Code color theme. */
export interface SyntaxThemeRule {
    scope?: string | string[];
    settings: {
        foreground?: string;
        background?: string;
        fontStyle?: string;
    };
}

/** Only syntax data crosses the webview boundary; UI colors come from host CSS variables. */
export interface SyntaxTheme {
    name: string;
    type: "light" | "dark";
    fg?: string;
    bg?: string;
    colors: Record<string, string>;
    tokenColors: SyntaxThemeRule[];
}

/** Shared by standalone and embedded Diff viewers without reloading their document data. */
export type SyntaxThemeInbound = { type: "setSyntaxTheme"; theme: SyntaxTheme | null };
/** Repeated by each Diff renderer when its webview mounts. */
export type SyntaxThemeOutbound = { type: "requestSyntaxTheme" };
