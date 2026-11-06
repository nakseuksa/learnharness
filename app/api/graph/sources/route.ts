import { deleteSources, readOrganizationAction, sourceDirectory, SourceDeletionError, SourceOrganizationInputError } from "@/src/server";
import { emit } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET() {
	try { return Response.json(sourceDirectory.read()); }
	catch { return Response.json({ error: "Could not read source organization.", code: "directory_read_failed" }, { status: 500 }); }
}

export async function DELETE(request: Request) {
	try { return Response.json(deleteSources(await readOrganizationAction(request))); }
	catch (error) {
		if (error instanceof SourceDeletionError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
		if (error instanceof SourceOrganizationInputError) return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: 400 });
		return Response.json({ error: "Could not finish source deletion. Some entries may already have been removed; refresh or retry.", code: "deletion_incomplete" }, { status: 500 });
	} finally {
		emit("sources-changed", {}); emit("chats-changed", {}); emit("activity-changed", {});
	}
}

export async function POST(request: Request) {
	try { return Response.json(sourceDirectory.change(await readOrganizationAction(request))); }
	catch (error) {
		if (error instanceof SourceOrganizationInputError) return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: 400 });
		return Response.json({ error: "Could not save source organization.", code: "organization_save_failed" }, { status: 500 });
	}
}
