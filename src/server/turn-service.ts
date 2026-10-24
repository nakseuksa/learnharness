/**
 * 聊天回合服务 — 每种回合责任一个命名的、包含错误的接缝，
 * 从 chat-handler 中提取出来，以便它进行组合而不是实现。
 * 每个服务都明确获取其依赖项（存储端口、作业运行器） —
 * 这里没有任何模块导入适配器。
 *
 *   persistTurn        — 规范的状态写入（Wave B：原生历史；
 *                        id 标记、占位符过滤、计划块发射、中止的部分持久化）
 *   triggerExtraction  — 图谱写入通道：一旦聊天超过 token 预算阈值，
 *                        就会触发提取管道（唯一的图谱写入器）。
 *
 * 日志是最小可观测性的基线：每次失败一行，标记为 [chat <id>]
 * — 结构化日志稍后会落在这些接缝后面。
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
 * 规范的状态写入（Wave B，owner-approved 2026-09-26）：追加回合自己的消息
 * — 代理循环的原生历史，提供商/模型/使用量/thinkingSignature 由 pi 本身打上标记。
 * 即使中止也会持久化 — 部分转录（包括挂起问题的未回答调用）是使恢复（resume）工作的关键。
 *
 * - Id 标记（Id stamping）：pi 消息不携带 id；记录的身份需要每条消息一个 id
 *   （客户端键、仅追加的采用、延续接缝）。在这里铸造，在单一的规范写入处。
 * - 占位符过滤（Placeholder filtering）：一个干净提出的问题的合成“已提出问题”结果
 *   是一个内存中的循环设备（Wave A 的 terminate）— 从不（NEVER）持久化
 *   （分叉 1：记录在未回答的调用处结束；学习者的回答作为真正的工具结果到达）。
 *   出错的问题调用确实会持久化 — 模型的重试上下文。
 * - 计划块（Plan blocks）：每次成功的 plan_init 调用一个冻结快照，幂等的（持久化重播是安全的）。
 *
 * 返回打上标记的新消息（使用量出处会读取它们）。
 *
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
 * 图谱写入通道（vision §1 结构）：一旦聊天的未覆盖（UNCOVERED）转录 token
 * 达到块预算（vision-extraction-coverage.md, 2026-09-15），提取管道
 * （提取器 → 审计员 → 合并器 — 唯一的图谱写入器）就会异步（ASYNC）运行。
 * 覆盖率通过投影进行读取（记录是原生历史；在 Wave D 之前，提取视图保持客户端形状）。
 * 触发即忘（Fire-and-forget）— 永远不会阻塞回合；失败由管道记录并保持覆盖率不变，
 * 因此下一次触发（或手动提取按钮）会重新运行剩下的内容。
 *
 * 故意隔离在这个接缝中 — 管道与触发器无关（trigger-agnostic）。
 * 在测试下跳过：脚本聊天是固定装置（fixtures），而不是知识（管道本身直接用模拟模型进行测试）。
 *
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
			// BYOK (owner, 2026-09-22) + 密钥存在（提供商密钥插曲，2026-09-25）：
			// 未配置或无密钥的写入通道会跳过（SKIPS）（覆盖率账本使消息保持未覆盖状态
			// — 一旦设置了插槽/密钥，下一次触发就会重试）；只有真正的失败才会记录。
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
