/** Stable machine codes for source-system refusals (i18n phase 1). The wire
 * `error` stays the English text; clients localize by `code` and fall back to
 * that text for any code they do not know. */
export const SOURCE_ERROR_CODES = [
	// POST /api/graph/sources
	"parent_folder_missing", "source_missing", "folder_missing", "folder_cycle",
	"organization_save_failed", "directory_read_failed",
	// DELETE /api/graph/sources (the first four are pre-existing wire codes)
	"extraction_running", "turn_in_flight", "jobs_running", "extraction_winding_down",
	"deletion_incomplete",
	// POST /api/graph/import
	"import_body_too_large", "import_body_unreadable", "import_too_big",
	"pdf_unreadable", "pdf_too_long", "pdf_no_text", "import_busy",
] as const;
export type SourceErrorCode = (typeof SOURCE_ERROR_CODES)[number];

/** Notice codes beside a completed import. */
export type SourceNoticeCode = "pdf_scanned";

export class SourceOrganizationError extends Error {
	constructor(message: string, readonly code: SourceErrorCode) { super(message); }
}
