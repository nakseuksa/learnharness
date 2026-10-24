import { abortExtraction, extractionStatuses } from "../agent/subagents/extraction.ts";
import { coverageOf } from "../core/coverage.ts";
import { deleteChatTraces, type ChatDeleteMode, type ChatDeletionStats } from "../core/graph-deletion.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import { graphRevision } from "./graph.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/**
 * 传输层（transport layer，app/api/chats*, app/chat/[id]）的服务器端聊天入口。
 * 目前，这些直接委托给 ChatStore 端口（port）；服务阶段（services stage）在相同的表面下雕刻出真正的编排。
 *
 * deleteChatSession（wave 6，会话删除 — 图谱账本（graph ledgers）上的第一个破坏性操作）
 * 是这里唯一真正的编排：门控（gates） → 提取收尾（extraction wind-down） → 一个同步删除块。
 * 有关账本语义（ledger semantics）和原子性（atomicity）论据，请参见 core/graph-deletion.ts。
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

/**
 * 在调用者获得可重试的 503 之前，收尾等待（wind-down wait）可能需要多长时间
 * （中止的提取在其下一个模型调用边界结束 — 提供商取消通常在亚秒级，
 * 但卡住的提供商绝不能卡住删除操作）。
 */
const WIND_DOWN_TIMEOUT_MS = 10_000;
const WIND_DOWN_POLL_MS = 50;

/** deleteChatSession 所做的操作 — 路由将其直接映射到 HTTP。 */
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
 * 删除一个会话（遵循 2026-09-22/23 的决定）：先进行状态门控校验，然后执行清理。
 * 具有严格的编排顺序以保证数据一致性：
 *
 * 1. 门控（GATES）：如果有正在运行的 turn 或后台任务，则拒绝删除并返回 409 错误，因为在运行中删除会导致并发写入时的状态损坏（破坏预写流）。UI 会在任务完成后重试。
 * 2. 提取管线终止（EXTRACTION WIND-DOWN）：如果会话有提取任务在运行，调用 `abortExtraction` 真实终止任务（不再合并提取结果），并等待退出。如果超时会返回可重试的 503 错误。
 * 3. 同步清理块（THE SYNC BLOCK）：清理底层数据时绝对不能有 await 等待。这样可以保证事件循环不会在清理期间释放给其他任务，从而确保知识图谱账本、任务以及会话记录的删除是原子性的。删除顺序为：图谱账本 -> 任务 -> 会话记录。管道的每批活跃度守卫（liveness guard）关闭了最后一个窗口：滑过收尾的运行在其合并时发现聊天已消失，并中止且不合并任何内容。
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

/**
 * 单个会话的覆盖率读取（覆盖率（coverage）读取，extraction-UX 重新设计，
 * 2026-09-24）：聊天视图的环形仪表 + 弹出式数据，作用域为一个聊天
 * （all-sessions GET 随着这次重新设计而消亡 — 一旦侧边栏和环形仪表在这里读取，就没有任何东西消耗它；Extract POST 保留）。
 * 未覆盖（Uncovered）每次请求都保持派生（DERIVED）状态（对转录进行指纹识别，与覆盖率账本进行差异比较 — 从不进行双重跟踪）。
 *
 * lastFoldedAt: 最新覆盖率行的折叠时间戳 — 对聊天的账本行进行廉价的单遍遍历（环形弹出窗口的“上次提取”行）；在会话的第一次折叠之前为 null。
 */
export interface SessionCoverage {
	totalMessages: number;
	coveredCount: number;
	uncoveredCount: number;
	coveredTokens: number;
	uncoveredTokens: number;
	/** 当为此会话注册了聊天类型的提取运行时为 true。 */
	running: boolean;
	/** 此会话覆盖率行中最新折叠的 ISO 时间戳；在任何折叠之前为 null。 */
	lastFoldedAt: string | null;
}

/**
 * 获取指定会话的覆盖率统计区块信息（参考 `SessionCoverage` 接口）。
 *
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
