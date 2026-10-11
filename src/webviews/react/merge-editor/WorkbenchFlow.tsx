import React from "react";
import type { MergeViewSettings } from "../../protocol/mergeWorkbench";
import { t } from "../shared/i18n";

/** Compact reading and navigation controls, separate from merge decisions. */
export function WorkbenchFlowOptions({
    settings,
    onChange,
    automatic,
    reviewed,
    onReview,
}: {
    settings: MergeViewSettings;
    onChange: (next: Partial<MergeViewSettings>) => void;
    automatic: boolean;
    reviewed: boolean;
    onReview: () => void;
}) {
    return (
        <section id="merge-flow-options" className="workbench-flow-options">
            <label>
                {t("merge.flow.navigation")}
                <select
                    className="toolbar-select"
                    value={settings.navigation}
                    onChange={(event) =>
                        onChange({
                            navigation: event.target.value as MergeViewSettings["navigation"],
                        })
                    }
                >
                    <option value="conflicts">{t("merge.flow.conflicts")}</option>
                    <option value="changes">{t("merge.flow.changes")}</option>
                    <option value="unresolved">{t("merge.flow.pending")}</option>
                    <option value="automatic">{t("merge.flow.automatic")}</option>
                </select>
            </label>
            <label>
                <input
                    type="checkbox"
                    checked={settings.advance}
                    onChange={(event) => onChange({ advance: event.target.checked })}
                />
                {t("merge.flow.advance")}
            </label>
            <label>
                <input
                    type="checkbox"
                    checked={settings.wrap}
                    onChange={(event) => onChange({ wrap: event.target.checked })}
                />
                {t("merge.flow.wrap")}
            </label>
            <label>
                <input
                    type="checkbox"
                    checked={settings.collapse}
                    onChange={(event) => onChange({ collapse: event.target.checked })}
                />
                {t("merge.flow.collapse")}
            </label>
            <label>
                {t("merge.flow.context")}
                <input
                    type="number"
                    min={0}
                    max={20}
                    value={settings.contextLines}
                    onChange={(event) => {
                        const value = event.currentTarget.valueAsNumber;
                        if (Number.isSafeInteger(value) && value >= 0 && value <= 20)
                            onChange({ contextLines: value });
                    }}
                />
            </label>
            <label>
                {t("merge.flow.highlight")}
                <select
                    className="toolbar-select"
                    value={settings.highlight}
                    onChange={(event) =>
                        onChange({
                            highlight: event.target.value as MergeViewSettings["highlight"],
                        })
                    }
                >
                    <option value="line">{t("merge.flow.lines")}</option>
                    <option value="word">{t("merge.flow.words")}</option>
                    <option value="character">{t("merge.flow.characters")}</option>
                </select>
            </label>
            {automatic && (
                <label>
                    <input type="checkbox" checked={reviewed} onChange={onReview} />
                    {t("merge.flow.reviewed")}
                </label>
            )}
        </section>
    );
}

/** The host owns file membership; the webview submits only one explicit path command. */
export function WorkbenchFileQueue({
    files,
    current,
    busy,
    onOpen,
}: {
    files: ReadonlyArray<{ path: string; resolved: boolean }>;
    current: string;
    busy: boolean;
    onOpen: (file: { path: string; resolved: boolean }) => void;
}) {
    return (
        <section className="workbench-file-queue" aria-label={t("merge.flow.files")}>
            {files.map((file) => (
                <button
                    key={file.path}
                    type="button"
                    disabled={busy}
                    aria-current={file.path === current ? "true" : undefined}
                    onClick={() => onOpen(file)}
                >
                    <span className="file-name">{file.path}</span>
                    <span>{t(file.resolved ? "merge.flow.resolved" : "merge.flow.pending")}</span>
                </button>
            ))}
        </section>
    );
}
