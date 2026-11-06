import { IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, validNotesPath } from "@/lib/notes-import-limits";
import type { ResolvedLocale } from "@/src/core";
import { pluralKey, type I18nKey, type Translate } from "@/components/i18n";
import { sourceErrorKey } from "./source-error-text";
import type { NotesImportResult } from "./notes-import";

export const notesPath = (file: File): string => file.webkitRelativePath || file.name;

/** One queue row, kept structured so it re-renders in the current language.
 * `text` is always the English wording (the server's, or the client's own). */
export interface ImportMessage {
	path: string;
	text: string;
	code?: string;
	params?: Record<string, string | number>;
	/** The configuration-refusal machine line (BYOK codes only), never localized. */
	details?: string;
	/** For `import_request_failed`: the wrapped HTTP refusal. */
	request?: { status: number; serverError?: string; serverCode?: string };
}
export interface ImportQueueSnapshot {
	importing: boolean;
	errors: ImportMessage[];
	notices: ImportMessage[];
	completion: number;
}
export const EMPTY_IMPORT_QUEUE: ImportQueueSnapshot = { importing: false, errors: [], notices: [], completion: 0 };

export const INVALID_IMPORT_RESPONSE = "Invalid import response. Check the graph before retrying.";
const CONFIG_REFUSAL_CODES = new Set(["models_not_configured", "provider_key_missing"]);

/** The transport saw a malformed or unparseable response. */
export class NotesImportInvalidResponseError extends Error {
	constructor() { super(INVALID_IMPORT_RESPONSE); }
}
/** A non-2xx import response; `message` keeps the historical English text. */
export class NotesImportRequestError extends Error {
	constructor(readonly status: number, readonly serverError?: string, readonly serverCode?: string) {
		const detail = serverError === undefined ? "" : `: ${serverError}`;
		super(`Import request failed (HTTP ${status})${detail}${/[.!?]$/.test(detail) ? "" : "."} Check the graph before retrying.`);
	}
}

const CLIENT_KEYS: Record<string, I18nKey> = {
	import_invalid_response: "sources.errors.importInvalidResponse",
	import_unsupported: "sources.errors.importUnsupported",
};

function formatParams(params: Record<string, string | number> | undefined, locale: ResolvedLocale): Record<string, string | number> {
	const number = new Intl.NumberFormat(locale === "zh-CN" ? "zh-CN" : "en-US");
	const out: Record<string, string | number> = { maxMB: MAX_IMPORT_BYTES / (1024 * 1024) };
	for (const [key, value] of Object.entries(params ?? {})) out[key] = typeof value === "number" ? number.format(value) : value;
	return out;
}

/** The localized body for a code, or undefined when the code is not localized. */
function localizedText(code: string | undefined, params: Record<string, string | number> | undefined, t: Translate, locale: ResolvedLocale): string | undefined {
	if (code === undefined) return undefined;
	if (code === "pdf_scanned") {
		const skipped = Number(params?.skipped ?? 0);
		if (skipped <= 0) return t("sources.import.pdfNotice");
		return t(pluralKey(skipped, "sources.import.pdfNoticeSkipped_one", "sources.import.pdfNoticeSkipped_other"), formatParams({ count: skipped }, locale));
	}
	const key = Object.hasOwn(CLIENT_KEYS, code) ? CLIENT_KEYS[code] : sourceErrorKey(code);
	return key ? t(key, formatParams(params, locale)) : undefined;
}

/** `path: message[\ndetails]`, localized by code; English output is unchanged
 * from the pre-i18n wording. Unknown codes show the English text as-is. */
export function formatImportMessage(m: ImportMessage, t: Translate, locale: ResolvedLocale = "en"): string {
	let body: string;
	if (m.code === "import_request_failed" && m.request) {
		const { status, serverError, serverCode } = m.request;
		if (locale === "zh-CN") {
			const server = serverError === undefined ? undefined : localizedText(serverCode, undefined, t, locale) ?? serverError;
			// An unlocalized English refusal keeps its own period; add a space, not "。".
			const detail = server === undefined ? "。" : `：${server}${/[。！？]$/.test(server) ? "" : /[.!?]$/.test(server) ? " " : "。"}`;
			body = t("sources.errors.importRequestFailed", { status, detail });
		} else {
			const server = serverError === undefined ? undefined : localizedText(serverCode, undefined, t, locale) ?? serverError;
			const detail = server === undefined ? "" : `: ${server}`;
			body = t("sources.errors.importRequestFailed", { status, detail: `${detail}${/[.!?]$/.test(detail) ? "" : "."}` });
		}
	} else body = localizedText(m.code, m.params, t, locale) ?? m.text;
	return `${m.path}: ${body}${m.details ? `\n${m.details}` : ""}`;
}

/** PR198's refill-on-completion, one-request-per-file transport, extended to
 * accept later selections. One instance per page, NOT three workers per click.
 * Only pending/in-flight Files are retained; no retry or persisted upload queue. */
export function createNotesImportQueue(post: (files: readonly File[]) => Promise<NotesImportResult[]>) {
	const listeners = new Set<() => void>();
	const pending: { file: File; index: number }[] = [];
	const failures = new Map<number, ImportMessage>();
	const notices = new Map<number, ImportMessage>();
	let active = 0, sequence = 0;
	let snapshot = EMPTY_IMPORT_QUEUE;
	const ordered = (map: Map<number, ImportMessage>) => [...map].sort(([a], [b]) => a - b).map(([, message]) => message);
	const publish = (completed = false) => {
		snapshot = { importing: active > 0 || pending.length > 0, errors: ordered(failures), notices: ordered(notices), completion: snapshot.completion + Number(completed) };
		for (const listener of [...listeners]) listener();
	};
	// Normalize a synchronously throwing transport to the same async settlement.
	const send = async (file: File) => post([file]);
	function pump(): void {
		while (active < 3 && pending.length > 0) {
			const { file, index } = pending.shift()!;
			active++;
			void (async () => {
				try {
					const [r] = await send(file);
					if (!r) throw new NotesImportInvalidResponseError();
					if (!r.ok) {
						const config = r.code !== undefined && CONFIG_REFUSAL_CODES.has(r.code);
						const details = [r.provider, r.missing?.join(", "), r.slots?.join(", ")].filter(Boolean);
						failures.set(index, {
							path: r.filePath, text: r.error ?? "",
							...(r.code !== undefined && !config ? { code: r.code } : {}),
							...(r.params ? { params: r.params } : {}),
							...(config ? { details: [r.code, ...details].join(" — ") } : {}),
						});
					} else if (r.notice) notices.set(index, { path: r.filePath, text: r.notice, ...(r.noticeCode ? { code: r.noticeCode, params: r.noticeParams } : {}) });
				} catch (error) {
					// Never retry an ambiguous response: the merge may have committed.
					const path = notesPath(file);
					if (error instanceof NotesImportRequestError) {
						failures.set(index, { path, text: error.message, code: "import_request_failed",
							request: { status: error.status, serverError: error.serverError, serverCode: error.serverCode } });
					} else if (error instanceof NotesImportInvalidResponseError) {
						failures.set(index, { path, text: error.message, code: "import_invalid_response" });
					} else failures.set(index, { path, text: error instanceof Error ? error.message : String(error) });
				} finally {
					active--;
					pump();
					publish(active === 0 && pending.length === 0);
				}
			})();
		}
	}
	return {
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		append(files: readonly File[]) {
			if (files.length === 0) return;
			if (!snapshot.importing) { failures.clear(); notices.clear(); sequence = 0; }
			for (const file of files) {
				const index = sequence++;
				const path = notesPath(file);
				if (file.webkitRelativePath && file.name === ".DS_Store") continue;
				if (!IMPORT_EXTENSIONS.test(path) || !validNotesPath(path, file.name)) failures.set(index, { path, text: "Unsupported format or unsafe relative path.", code: "import_unsupported" });
				else if (file.size > MAX_IMPORT_BYTES) failures.set(index, { path, text: "Too big. Max 25 MB.", code: "import_too_big" });
				else pending.push({ file, index });
			}
			const hadWork = active > 0 || pending.length > 0;
			pump();
			publish(!hadWork);
		},
	};
}
