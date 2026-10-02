import { useEffect, useState } from "react";
import type { SyntaxThemeInbound, SyntaxThemeOutbound } from "../../protocol/syntaxTheme";
import { getVsCodeApi } from "../shared/vscodeApi";
import { detectTheme, type ShikiTheme } from "../diff-core/shikiHighlighter";

/** Theme updates are independent of the document protocol, so open drafts keep their ownership. */
export function useDiffSyntaxTheme(): ShikiTheme {
    const [theme, setTheme] = useState<ShikiTheme>(() => detectTheme());
    useEffect(() => {
        const receive = (event: MessageEvent<SyntaxThemeInbound>) => {
            if (event.data.type === "setSyntaxTheme") {
                const next = event.data.theme;
                setTheme(
                    next
                        ? {
                              ...next,
                              fg: "var(--vscode-editor-foreground)",
                              bg: "var(--vscode-editor-background)",
                              tokenColors: next.tokenColors.filter((rule) => Boolean(rule.scope)),
                          }
                        : detectTheme(),
                );
            }
        };
        window.addEventListener("message", receive);
        const request = () =>
            getVsCodeApi<SyntaxThemeOutbound>().postMessage({ type: "requestSyntaxTheme" });
        const visible = () => {
            if (!document.hidden) request();
        };
        document.addEventListener("visibilitychange", visible);
        const observer = new MutationObserver(() => {
            setTheme((current) => (typeof current === "string" ? detectTheme() : current));
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
        request();
        return () => {
            observer.disconnect();
            window.removeEventListener("message", receive);
            document.removeEventListener("visibilitychange", visible);
        };
    }, []);
    return theme;
}
