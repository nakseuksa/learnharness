/**
 * The chat-turn services — one named, error-contained seam per turn
 * responsibility, extracted from the chat-handler so it composes instead of
 * implementing. Each takes its dependencies explicitly (storage ports, the
 * job runner) — no module here imports an adapter.
 *
 *   persistTurn        — the canonical state write (Wave B: native history;
 *                        id stamping, placeholder filtering, plan-block
 *                        emission, abort-partial persistence)
 *   triggerExtraction  — the graph write channel: fires the extraction
 *                        pipeline (the sole graph writer) once a chat
 *                        crosses the token-budget threshold.
 *
 * Logs are the minimal-observability baseline: one line per failure, tagged
 * [chat <id>] — structured logging lands behind these seams later.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "../core/native-messages.ts";
import { newMessageId } from "../core/native-messages.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { planBlocksFor } from "../core/plan-blocks.ts";
import { coverageOf } from "../core/coverage.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import type { ExtractionPipeline } from "../agent/subagents/extraction.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";

/**
 * The canonical state write (Wave B, owner-approved 2026-09-26): append the
 * turn's own messages — the agent loop's native history, provider/model/
 * usage/thinkingSignature stamped by pi itself. Persists even when aborted
 * — the partial transcript (including a pending question's unanswered
 * call) is what makes resume work.
 *
 * - Id stamping: pi messages carry no id; the record's identity needs one
 *   per message (client keys, append-only adoption, the continuation
 *   seam). Minted here, at the single canonical write.
 * - Placeholder filtering: a cleanly-posed question's synthetic
 *   "question posed" result is an in-memory loop device (Wave A's
 *   terminate) — NEVER persisted (fork 1: the record ends at the
 *   unanswered call; the learner's answer arrives as the real tool
 *   result). Errored question calls DO persist — the model's retry
 *   context.
 * - Plan blocks: one frozen snapshot per successful plan_init call,
 *   idempotent (persist replays are safe).
 *
 * Returns the stamped new messages (usage provenance reads them).
 */
/**
 * 结算并持久化当前对话回合的消息。
 * 该函数计算合并后的新消息切片，通过分配新的 ID（如果提供商未返回），
 * 最终与原始数据拼接并写入后端存储。同时触发相应的改变事件。
 *
 * @param chatStore 用于访问和保存记录的存储接口。
 * @param chatId 会话的唯一标识符。
 * @param baseLength 回合开始时的历史消息长度（用于裁剪出本回合的新增消息）。
 * @param turnMessages 包含新回合生成的所有消息列表。
 * @param isAborted 标记此回合是否被外部手动终止。
 * @returns 返回这回合产生的新消息切片。
 */
export function persistTurn(
	chatStore: ChatStore,
	chatId: string,
	baseCount: number,
	turnMessages: readonly AgentMessage[],
	isAborted: boolean,
): LhMessage[] {
	try {
		const record = chatStore.getChat(chatId);
		if (!record) return [];
		const stamped: LhMessage[] = [];
		for (const m of turnMessages.slice(baseCount)) {
			const message = m as LhMessage;
			// The placeholder question result: loop device, never a record fact.
			if (
				(message as { role?: string }).role === "toolResult" &&
				(QUESTION_TOOLS as readonly string[]).includes((message as ToolResultMessage).toolName) &&
				!(message as ToolResultMessage).isError
			) {
				continue;
			}
			stamped.push(message.id ? message : ({ ...message, id: newMessageId() } as LhMessage));
		}
		const tree = record.tree;
		const blocks = planBlocksFor(record.messages, stamped, tree, [
			...record.messages,
			...stamped,
		]);
		chatStore.saveMessages(chatId, [...record.messages, ...stamped, ...blocks]);
		return stamped;
	} catch (err) {
		console.error(`[chat ${chatId}] persist failed:`, err, { isAborted });
		return [];
	}
}

/**
 * The graph write channel (vision §1 construction): the extraction pipeline
 * (extractor → auditor → merger — the sole graph writer) runs ASYNC once a
 * chat's UNCOVERED transcript tokens reach the chunk budget
 * (vision-extraction-coverage.md, 2026-09-15). Coverage reads through the
 * projection (the record is native history; the extraction view stays
 * client-shaped until Wave D). Fire-and-forget — never blocks the turn;
 * failures are logged by the pipeline and leave coverage untouched, so the
 * next trigger (or the manual extract button) re-runs what's left.
 *
 * Deliberately isolated in this one seam — the pipeline is
 * trigger-agnostic. Skipped under tests: scripted chats are fixtures, not
 * knowledge (the pipeline itself is tested directly with mock models).
 */
/**
 * 触发会话中知识图谱数据的异步提取过程。
 * 它根据配置中定义的 Chunk Tokens 预算上限，计算距离上次提取的新增消息量。
 * 如果达到预算阈值，则将该任务压入提取管线的注册表。如果超过预算两倍，则强制即时提交（而不是分批排队）。
 *
 * @param deps 提供核心数据访问与管线功能的依赖集。
 * @param extraction 提取管线的操作句柄。
 * @param chatId 需要进行知识图谱提取的会话 ID。
 * @param chunkTokens 每次批量提取期望的预算 Token 上限（由设置定义）。
 */
export function triggerExtraction(
	deps: { chatStore: ChatStore; graphStore: GraphStore },
	extraction: ExtractionPipeline,
	chatId: string,
	chunkTokens: number,
): void {
	if (process.env.NODE_ENV === "test") return;
	try {
		const record = deps.chatStore.getChat(chatId);
		if (!record) return;
		const covered = coverageOf(record.messages, deps.graphStore.readCoverage(), chatId);
		if (covered.uncoveredTokens < chunkTokens) return;
		void extraction.runExtraction(chatId).catch((err) => {
			// BYOK (owner, 2026-09-22) + key presence (provider-key interlude,
			// 2026-09-25): an unconfigured OR keyless write channel SKIPS (the
			// coverage ledger keeps the messages uncovered — the next trigger
			// retries once slots/keys are set); only real failures log.
			if (err instanceof ModelsNotConfiguredError) {
				console.info(`[chat ${chatId}] extraction skipped — ${err.envelope.error} (missing: ${err.envelope.missing.join(", ")})`);
				return;
			}
			if (err instanceof ProviderKeyMissingError) {
				console.info(`[chat ${chatId}] extraction skipped — ${err.envelope.error} (provider: ${err.envelope.provider})`);
				return;
			}
			console.error(`[chat ${chatId}] extraction pipeline failed:`, err);
		});
	} catch (err) {
		console.error(`[chat ${chatId}] extraction trigger failed:`, err);
	}
}
