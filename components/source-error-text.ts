import type { SourceErrorCode } from "@/src/core";
import type { I18nKey, Translate } from "@/components/i18n";

/** Codes the client mints itself when a source request fails without a
 * usable server message. */
export type ClientSourceErrorCode = "client_directory_read_failed" | "client_save_failed" | "client_delete_failed";

/** A failed source request. `message` is always the English text (the server's
 * `error`, or the client fallback); `code`/`params` drive localization. */
export class SourceRequestError extends Error {
	constructor(message: string, readonly code?: string, readonly params?: Record<string, string | number>) { super(message); }
}

const CODE_KEYS: Partial<Record<SourceErrorCode | ClientSourceErrorCode, I18nKey>> = {
	client_directory_read_failed: "sources.errors.directoryReadFailed",
	client_save_failed: "sources.errors.saveFailed",
	client_delete_failed: "sources.errors.deleteFailed",
	directory_read_failed: "sources.errors.directoryReadFailed",
	organization_save_failed: "sources.errors.saveFailed",
	deletion_incomplete: "sources.errors.deletionIncomplete",
	parent_folder_missing: "sources.errors.parentFolderMissing",
	source_missing: "sources.errors.sourceMissing",
	folder_missing: "sources.errors.folderMissing",
	folder_cycle: "sources.errors.folderCycle",
	extraction_running: "sources.errors.extractionRunning",
	turn_in_flight: "sources.errors.turnInFlight",
	jobs_running: "sources.errors.jobsRunning",
	extraction_winding_down: "sources.errors.extractionWindingDown",
	import_body_too_large: "sources.errors.importBodyTooLarge",
	import_body_unreadable: "sources.errors.importBodyUnreadable",
	import_too_big: "sources.errors.importTooBig",
	pdf_unreadable: "sources.errors.pdfUnreadable",
	pdf_too_long: "sources.errors.pdfTooLong",
	pdf_no_text: "sources.errors.pdfNoText",
	import_busy: "sources.errors.importBusy",
};

/** The dictionary key for a code, or undefined when it is not localized. */
export function sourceErrorKey(code: string | undefined): I18nKey | undefined {
	return code !== undefined && Object.hasOwn(CODE_KEYS, code) ? CODE_KEYS[code as keyof typeof CODE_KEYS] : undefined;
}

/** Localize by code; unknown codes and plain errors show their English text. */
export function sourceErrorText(t: Translate, error: unknown): string {
	if (error instanceof SourceRequestError) {
		const key = sourceErrorKey(error.code);
		if (key) return t(key, error.params);
	}
	return error instanceof Error ? error.message : String(error);
}
