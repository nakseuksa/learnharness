"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { UploadIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { useI18n } from "@/components/i18n";
import { createNotesImportQueue, EMPTY_IMPORT_QUEUE, formatImportMessage, notesPath, NotesImportInvalidResponseError, NotesImportRequestError } from "./notes-import-queue";

export { MAX_IMPORT_BYTES } from "@/lib/notes-import-limits.ts";
export { notesPath } from "./notes-import-queue";

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
	notice?: string;
	/** i18n phase 1: localization codes/params beside the English text. */
	params?: Record<string, string | number>;
	noticeCode?: string;
	noticeParams?: Record<string, string | number>;
}

const isParams = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value)
	&& Object.values(value).every((v) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v)));

/** Contributor's strict attribution: validate the complete response before
 * applying any row, even when several files have identical basenames. */
export function parseNotesImportResults(body: unknown, files: readonly File[]): NotesImportResult[] {
	const invalid = () => new NotesImportInvalidResponseError();
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= files.length || seen.has(r.requestIndex) || r.filePath !== notesPath(files[r.requestIndex]!)) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.ok && !r.stats) throw invalid();
		if (!r.ok && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider", "notice", "noticeCode"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["params", "noticeParams"] as const) if (r[field] !== undefined && !isParams(r[field])) throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

export async function postNotesImport(files: readonly File[]): Promise<NotesImportResult[]> {
	const form = new FormData();
	for (const file of files) {
		form.append("files", file);
		form.append("paths", notesPath(file));
	}
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new NotesImportInvalidResponseError(); }
	if (!response.ok) {
		const serverError = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : undefined;
		const serverCode = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : undefined;
		throw new NotesImportRequestError(response.status, serverError, serverCode);
	}
	return parseNotesImportResults(body, files);
}

// Client module singleton: shared by both home views and successive selections.
// SSR never appends Files, and uses the immutable empty server snapshot.
const pageImportQueue = createNotesImportQueue(postNotesImport);
export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const snapshot = useSyncExternalStore(pageImportQueue.subscribe, pageImportQueue.getSnapshot, () => EMPTY_IMPORT_QUEUE);
	const { t, resolvedLocale } = useI18n();
	// Rows stay structured in the queue; render them in the current language.
	const errors = useMemo(() => snapshot.errors.map((m) => formatImportMessage(m, t, resolvedLocale)), [snapshot.errors, t, resolvedLocale]);
	const notices = useMemo(() => snapshot.notices.map((m) => formatImportMessage(m, t, resolvedLocale)), [snapshot.notices, t, resolvedLocale]);
	const latest = useRef(callbacks);
	latest.current = callbacks;
	const seenCompletion = useRef(snapshot.completion);
	useEffect(() => {
		if (seenCompletion.current !== snapshot.completion) {
			seenCompletion.current = snapshot.completion;
			latest.current.onFinish?.();
		}
	}, [snapshot.completion]);
	return {
		errors, notices, importing: snapshot.importing,
		onImportFiles: (files: FileList | null) => {
			if (!files || files.length === 0) return;
			latest.current.onStart?.();
			pageImportQueue.append(Array.from(files));
		},
	};
}

/** PR198's shared Files / Folder native picker. Unlike the donor, it remains
 * available while work is running; later selections join the SAME queue. */
export function NotesImportControl({ importing, onImportFiles }: { importing: boolean; onImportFiles: (files: FileList | null) => void }) {
	const filesRef = useRef<HTMLInputElement>(null);
	const folderRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const { t } = useI18n();
	const onChange = (event: ChangeEvent<HTMLInputElement>) => {
		onImportFiles(event.target.files);
		event.target.value = "";
	};
	const choices = [[t("sources.import.files"), filesRef], [t("sources.import.folder"), folderRef]] as const;
	return (
		<div className="relative shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur"
			onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
			onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
			<input ref={filesRef} type="file" multiple accept=".md,.markdown,.txt,.pdf" className="hidden" onChange={onChange} />
			<input ref={folderRef} type="file" {...{ webkitdirectory: "" }} className="hidden" onChange={onChange} />
			<Hint label={t("sources.import.hint")} side="bottom">
				<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" data-testid="import-notes"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent">
					<UploadIcon className="size-3" />{importing ? t("sources.import.importing") : t("sources.import.button")}
				</button>
			</Hint>
			{open && (
				<div role="menu" aria-label={t("sources.import.menuLabel")} className="absolute right-0 top-full z-50 mt-1 min-w-32 rounded-lg border bg-card p-1 shadow-lg">
					{choices.map(([label, input]) => <button key={label} type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
						onClick={() => { setOpen(false); input.current?.click(); }}>{label}</button>)}
				</div>
			)}
		</div>
	);
}

export function NotesImportErrors({ errors }: { errors: readonly string[] }) {
	return <>{errors.map((error, i) => <p key={i} role="alert" className="max-w-full whitespace-pre-wrap break-words text-xs text-red-400">{error}</p>)}</>;
}
export function NotesImportNotices({ notices }: { notices: readonly string[] }) {
	return <>{notices.map((notice, i) => <p key={i} role="status" className="max-w-full whitespace-pre-wrap break-words text-xs text-muted-foreground">{notice}</p>)}</>;
}
