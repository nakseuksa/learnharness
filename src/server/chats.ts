import { abortExtraction, extractionStatuses } from "../agent/subagents/extraction.ts";
import { coverageOf } from "../core/coverage.ts";
import { deleteChatTraces, type ChatDeleteMode, type ChatDeletionStats } from "../core/graph-deletion.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import { graphRevision } from "./graph.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/**
 * Server-side chat entries for the transport layer (app/api/chats*,
 * app/chat/[id]). Today these delegate straight to the ChatStore port; the
 * services stage carves the real orchestration behind this same surface.
 *
 * deleteChatSession (wave 6, session deletion — the FIRST destructive
 * operation on the graph ledgers) is the one real orchestration here:
 * gates → extraction wind-down → one synchronous deletion block. See
 * core/graph-deletion.ts for the ledger semantics and the atomicity
 * argument.
 */

/**
 * 暴露自 `stores.chatStore` 的聊天记录基本操作方法。
 * - createChat: 创建新的会话。
 * - getChat: 获取指定会话详细内容。
 * - listChats: 列出所有会话。
 */
export const { createChat, getChat, listChats } = stores.chatStore;
export { titleFromPrompt };
export type { ChatDeleteMode, ChatDeletionStats } from "../core/graph-deletion.ts";

/** How long the wind-down wait may take before the caller gets a retryable
 *  503 (an aborted extraction ends at its next model-call boundary —
 *  provider cancellation is normally sub-second, but a wedged provider
 *  must never wedge deletion). */
const WIND_DOWN_TIMEOUT_MS = 10_000;
const WIND_DOWN_POLL_MS = 50;

/** What deleteChatSession did — the route maps it straight to HTTP. */
export type ChatDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "turn_in_flight" | "jobs_running"; error: string; jobIds: string[] }
	| { ok: false; status: 503; code: "extraction_winding_down"; error: string }
	| {
			ok: true;
			mode: ChatDeleteMode;
			stats: ChatDeletionStats;
			jobsRemoved: number;
			graphRevision: number;
	  };

/**
 * Delete a session (owner rulings 2026-09-22/23): gates first, then the
 * purge. The owner-locked choreography:
 *
 *   1. GATES — a turn in flight or a running background job refuses with
 *      409 (they write the chat record and steer into it; deleting
 *      mid-flight would corrupt the write-ahead flow). The UI retries once
 *      work drains.
 *   2. EXTRACTION WIND-DOWN — the chat's own pipeline run is TRUE-
 *      CANCELLED (abortExtraction: spend stops, nothing merges), then
 *      awaited off the registry. A timeout is a retryable 503, never a
 *      forced race.
 *   3. THE SYNC BLOCK — everything below runs without a single await:
 *      no extraction append can interleave (the event loop never yields
 *      mid-block), so the read-filter-write of the ledger rewrites is
 *      atomic against the pipeline. Ledgers first, jobs next, the chat
 *      record LAST (a crash mid-block leaves a deletable chat with a
 *      purged graph — re-running DELETE fixes it — never a deleted chat
 *      with live traces). The pipeline's per-batch liveness guard
 *      (extraction.ts) closes the last window: a run that slipped past
 *      the wind-down finds the chat gone at its merge and aborts with
 *      nothing merged.
 */
/**
 * 删除一个会话（遵循 2026-09-22/23 的决定）：先进行状态门控校验，然后执行清理。
 * 具有严格的编排顺序以保证数据一致性：
 *
 * 1. 门控（GATES）：如果有正在运行的 turn 或后台任务，则拒绝删除并返回 409 错误，因为在运行中删除会导致并发写入时的状态损坏。UI 会在任务完成后重试。
 * 2. 提取管线终止（EXTRACTION WIND-DOWN）：如果会话有提取任务在运行，调用 `abortExtraction` 真实终止任务（不再合并提取结果），并等待退出。如果超时会返回可重试的 503 错误。
 * 3. 同步清理块（THE SYNC BLOCK）：清理底层数据时绝对不能有 await 等待。这样可以保证事件循环不会在清理期间释放给其他任务，从而确保知识图谱账本、任务以及会话记录的删除是原子性的。删除顺序为：图谱账本 -> 任务 -> 会话记录。
 *
 * @param chatId 要删除的会话的唯一标识符。
 * @param mode 删除模式（控制图谱数据删除范围）。
 * @returns 包含删除成功与否状态及统计信息的对象。
 */
export async function deleteChatSession(chatId: string, mode: ChatDeleteMode): Promise<ChatDeleteOutcome> {
	if (!stores.chatStore.getChat(chatId)) {
		return { ok: false, status: 404, code: "not_found", error: "No such session" };
	}
	if (isTurnRunning(chatId)) {
		return {
			ok: false,
			status: 409,
			code: "turn_in_flight",
			error: "A turn is running in this session — try again when it finishes",
			jobIds: [],
		};
	}
	const runningJobs = stores.jobStore.listJobs(chatId).filter((job) => job.status === "running");
	if (runningJobs.length > 0) {
		return {
			ok: false,
			status: 409,
			code: "jobs_running",
			error: "Background jobs are still running in this session — try again when they finish",
			jobIds: runningJobs.map((job) => job.id),
		};
	}
	if (extractionStatuses().some((run) => run.chatId === chatId)) {
		abortExtraction(chatId); // true cancellation — spend stops, nothing merges
		const deadline = Date.now() + WIND_DOWN_TIMEOUT_MS;
		while (extractionStatuses().some((run) => run.chatId === chatId)) {
			if (Date.now() > deadline) {
				return {
					ok: false,
					status: 503,
					code: "extraction_winding_down",
					error: "The session's extraction is still winding down — try again in a moment",
				};
			}
			await new Promise((resolve) => setTimeout(resolve, WIND_DOWN_POLL_MS));
		}
	}

	// THE SYNC BLOCK — no awaits below (see the doc comment). Order:
	// ledgers → jobs → the chat record.
	const stats = deleteChatTraces(stores.graphStore, chatId, mode);
	const jobsRemoved = stores.jobStore.deleteJobsForChat(chatId);
	stores.chatStore.deleteChat(chatId);
	return { ok: true, mode, stats, jobsRemoved, graphRevision: graphRevision() };
}

/** One session's coverage read (extraction-UX redesign, owner dispatch
 *  2026-09-24): the chat view's ring meter + popover data, scoped to one
 *  chat (the all-sessions GET died with this redesign — nothing consumed
 *  it once the sidebar and ring read here; the Extract POST stays).
 *  Uncovered stays DERIVED per request (fingerprint the transcript,
 *  diff the coverage ledger — never dual-tracked).
 *
 *  lastFoldedAt: the newest coverage row's fold timestamp — a cheap single
 *  pass over the chat's ledger rows (the ring popover's "last extraction"
 *  line); null before the session's first fold. */
export interface SessionCoverage {
	totalMessages: number;
	coveredCount: number;
	uncoveredCount: number;
	coveredTokens: number;
	uncoveredTokens: number;
	/** True while a chat-kind extraction run is registered for this session. */
	running: boolean;
	/** ISO of the newest fold in this session's coverage rows; null before any. */
	lastFoldedAt: string | null;
}

/** The per-session coverage block (see SessionCoverage). Null when the
 *  chat doesn't exist — callers own the 404. */
/**
 * 获取指定会话的覆盖率统计区块信息（参考 `SessionCoverage` 接口）。
 * 该统计数据用于 UI 显示会话中已经被提取到图谱中的内容比例。
 *
 * 若会话不存在，则返回 null，由调用方负责处理 404 响应。
 *
 * @param chatId 会话的唯一标识符。
 * @returns 包含提取统计、运行状态、和最后合并时间的 `SessionCoverage` 对象；若会话不存在返回 null。
 */
export function sessionCoverage(chatId: string): SessionCoverage | null {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return null;
	const entries = stores.graphStore.readCoverage();
	// Wave B: the record is native history — coverage reads through the
	// projection (same view the extraction pipeline folds).
	const cov = coverageOf(record.messages, entries, chatId);
	let lastFoldedAt: string | null = null;
	for (const entry of entries) {
		if (entry.chatId !== chatId) continue;
		if (lastFoldedAt === null || entry.foldedAt > lastFoldedAt) lastFoldedAt = entry.foldedAt;
	}
	return {
		totalMessages: cov.slots.length,
		coveredCount: cov.coveredCount,
		uncoveredCount: cov.uncoveredCount,
		coveredTokens: cov.coveredTokens,
		uncoveredTokens: cov.uncoveredTokens,
		running: extractionStatuses().some((run) => run.kind === "chat" && run.chatId === chatId),
		lastFoldedAt,
	};
}
