"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "./backdrop-dismiss";
import type { SourceEntry, SourceFolder } from "@/src/core";
import { pluralKey, useI18n } from "@/components/i18n";
import { sourceErrorText } from "./source-error-text";

export function DeleteSourceBody({ sources, folders, deleteSessions, onDeleteSessions, busy, failure, onClose, onRun }: {
	sources: SourceEntry[]; folders: SourceFolder[]; deleteSessions: boolean; onDeleteSessions: (checked: boolean) => void;
	/** An Error (localized by code when it is a SourceRequestError) or plain text; empty/undefined = none. */
	busy: boolean; failure: unknown; onClose: () => void; onRun: () => void;
}) {
	const { t } = useI18n();
	const chats = sources.filter((s) => s.kind === "chat");
	const names = [...sources.map((s) => s.label ?? s.id), ...folders.map((f) => f.name)];
	const failureText = failure ? sourceErrorText(t, failure) : "";
	return <div role="dialog" aria-modal="true" aria-label={t("sources.deleteDialog.label")} data-testid="delete-source-dialog"
		onClick={(e) => e.stopPropagation()} className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl">
		<h2 className="text-sm font-semibold text-destructive">{t("sources.deleteDialog.title")}</h2>
		<p className="mt-1.5 font-mono text-sm" data-testid="source-deletion-names">{names.slice(0, 8).join(t("sources.deleteDialog.nameSeparator"))}{names.length > 8 ? t("sources.deleteDialog.andMore", { count: names.length - 8 }) : ""}</p>
		{sources.length > 0 && <p className="mt-2 text-sm text-muted-foreground" data-testid="source-deletion-contributions">
			{t("sources.deleteDialog.contributions")}
		</p>}
		<p className="mt-2 text-xs text-muted-foreground">{t("sources.deleteDialog.filesNote")}</p>
		{chats.length > 0 && <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3">
			<input type="checkbox" data-testid="delete-source-sessions" checked={deleteSessions} disabled={busy}
				onChange={(e) => onDeleteSessions(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" />
			<span className="min-w-0"><span className="block text-sm">{t(pluralKey(chats.length, "sources.deleteDialog.alsoDeleteSessions_one", "sources.deleteDialog.alsoDeleteSessions_other"), { count: chats.length })}</span>
				<span className="mt-1 block text-xs text-muted-foreground">{t("sources.deleteDialog.sessionsHint")}</span>
			</span>
		</label>}
		{failureText && <p role="alert" data-testid="source-delete-failure" className="mt-3 text-xs text-foreground">{failureText}</p>}
		<div className="mt-4 flex justify-end gap-2">
			<button type="button" data-testid="source-delete-cancel" disabled={busy} onClick={onClose} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40">{t("common.cancel")}</button>
			<button type="button" data-testid="source-delete-confirm" disabled={busy} onClick={onRun} className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40">{busy ? t("sources.deleteDialog.deleting") : failureText ? t("sources.deleteDialog.tryAgain") : t("common.delete")}</button>
		</div>
	</div>;
}

export function DeleteSourceDialog({ open, sources, folders, onDelete, onClose }: {
	open: boolean; sources: SourceEntry[]; folders: SourceFolder[]; onDelete: (deleteSessions: boolean) => Promise<void>; onClose: () => void;
}) {
	const [deleteSessions, setDeleteSessions] = useState(false), [busy, setBusy] = useState(false), [failure, setFailure] = useState<unknown>(undefined);
	useEffect(() => { if (!open) { setDeleteSessions(false); setBusy(false); setFailure(undefined); } }, [open]);
	const backdrop = useBackdropDismiss(() => { if (!busy) onClose(); });
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); } };
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, busy, onClose]);
	if (!open) return null;
	const run = async () => {
		if (busy) return;
		setBusy(true); setFailure(undefined);
		try { await onDelete(deleteSessions); onClose(); }
		catch (error) { setFailure(error instanceof Error ? error : String(error)); }
		finally { setBusy(false); }
	};
	return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdrop}>
		<DeleteSourceBody sources={sources} folders={folders} deleteSessions={deleteSessions} onDeleteSessions={setDeleteSessions}
			busy={busy} failure={failure} onClose={onClose} onRun={() => { void run(); }} />
	</div>, document.body);
}
