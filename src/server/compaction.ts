/**
 * 压缩服务（THE COMPACTION SERVICE，owner round 14，2026-10-05）：
 * 围绕 core/compaction 的纯粹切割和标记的触发管道（trigger plumbing）。
 *
 * 拓扑结构（为什么这很简单）：提问（question）和问题（problem）提出会终止（TERMINATE）
 * 它们的运行，因此“用户正在思考”的暂停始终是运行之间的窗口（BETWEEN-RUNS window）。
 * 因此，压缩永远不会触碰实时运行（live run）：
 *
 *   - 结算踢出（SETTLE KICK） — 回合结算（onFinish，在持久化之后）且预计的上下文超过阈值：
 *     摘要现在开始，在后台进行，与此同时学习者正在阅读/回答 — 通常在下一个输入到达之前很久就完成了。
 *   - 回合开始门控（TURN-START GATE） — 每个回合（客户端 POST 或唤醒）都在追加或 beginTurn 之前
 *     等待其聊天的任何飞行中（in-flight）压缩；如果记录仍然超过阈值（冷会话，失去引擎的踢出），
 *     压缩会在请求内同步运行。结构性门控（Structurally gated）：聊天的任何面向模型的内容
 *     都不会与正在运行的压缩交错（owner ruling — 将出错的表面积降至最低）。
 *   - 溢出恢复（OVERFLOW RECOVERY） — 因上下文长度而死掉的运行不需要特殊路径：
 *     下一个回合的门控会压缩，新的运行会从小开始。
 *
 * 摘要由会话自己的对话模型（owner ruling）通过零工具（zero-tool）、一次性（one-shot）
 * 子代理接缝（sub-agent seam）编写；其使用量（usage）落在聊天仅追加的回合日志（资金通道）中，
 * 以标记的 id 为键。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
	activeCompactionOf,
	buildCompactionPrompt,
	compactionCutIndex,
	COMPACTION_RESERVE_TOKENS,
	estimateContextTokens,
	estimateTokens,
	newCompactionMarker,
	planTreeToText,
	serializeForSummary,
	toLlmMessages,
	type CompactionDetails,
	type LhMessage,
	type LhMarkerMessage,
} from "../core/index.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { PiEngine } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";

/**
 * 摘要器的系统提示 — 服务器拥有的操作框架，而不是面向模型的教条
 * （buildCompactionPrompt 携带了形状）。
 */
const SUMMARIZER_SYSTEM_PROMPT =
	"You are the session-compaction summarizer for a tutoring agent. You receive the transcript span to summarize and write exactly the summary the instructions demand — nothing else, no preamble, no meta-commentary.";

/**
 * 一次性摘要调用：零工具，一回合，文本输出。引擎是聊天自己的对话引擎
 * （owner ruling：会话的模型编写自己的摘要）。可用于测试注入。
 */
export type Summarizer = (prompt: string, engine: PiEngine) => Promise<{ summary: string; usage: Usage }>;

/** 基于子代理接缝的生产环境摘要器。 */
async function subagentSummarizer(prompt: string, engine: PiEngine): Promise<{ summary: string; usage: Usage }> {
	let usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const { text } = await runSubagent([], {
		// The engine override is always present (the chat's own conversation
		// engine — owner ruling), so the role label never resolves an
		// engine; "researcher" is the least-wrong existing ModelRole label
		// for a one-shot text job (the cast documents the dead path).
		role: "researcher" as never,
		prompt,
		engine,
		systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
		maxTurns: 1,
		onUsage: (u) => {
			usage = u;
		},
	});
	return { summary: text, usage };
}

/**
 * 服务从其主机需要的所有内容（chat-handler 连接生产版本；测试注入）。
 */
export interface CompactionDeps {
	chatStore: ChatStore;
	/** 聊天的对话引擎 — 也是摘要器的。 */
	engine: PiEngine;
	/** 引擎的 provider:id（使用量 + 标记出处）。 */
	modelId: string;
	/** 会话类型（摘要器措辞：tutor vs practice）。 */
	kind: "teach" | "practice" | "probe";
	/**
	 * 实际触发阈值，由调用者解析（RESOLVED）：
	 * min(设置阈值, contextWindow − reserve) — owner 的有效触发规则。
	 * 目录窗口查找是调用者的（chat-handler 手头有模型 id）。
	 */
	thresholdTokens: number;
	/**
	 * 组合的系统提示的 token 估计值（字符数/4）—
	 * 提供商实际接收到的投影以它开始。
	 */
	systemPromptTokens: number;
	/** 可注入的摘要器（测试用）；默认 = 子代理的一次性调用。 */
	summarize?: Summarizer;
}

// ─── the registry (module-global on globalThis, jobs.ts's pattern) ─────────

interface CompactionState {
	inFlight: Map<string, Promise<void>>;
}
const g = globalThis as typeof globalThis & { __lhCompaction?: CompactionState };
function state(): CompactionState {
	return (g.__lhCompaction ??= { inFlight: new Map() });
}

/**
 * 此聊天是否正在运行压缩？（客户端状态事件的服务器端孪生兄弟 — 测试和 SSE 发射器读取它。）
 *
 * 检查指定会话是否正在后台执行上下文压缩（汇总）操作。
 * @param chatId 会话的唯一标识符。
 * @returns 若该会话的压缩任务正在运行中则返回 true，否则返回 false。
 */
export function compactionInFlight(chatId: string): boolean {
	return state().inFlight.has(chatId);
}

/**
 * 等待聊天的任何飞行中（in-flight）压缩 —
 * 聊天的每个模型交互都要通过的结构门。
 *
 * 等待指定会话的后台压缩任务完成（若存在）。
 * 如果该会话有正在运行的压缩任务，函数将挂起并每隔 100ms 轮询直到任务完成。
 * @param chatId 会话的唯一标识符。
 */
export async function awaitCompaction(chatId: string): Promise<void> {
	const running = state().inFlight.get(chatId);
	if (running) await running;
}

// ─── the effective threshold (owner ruling: min(setting, window − reserve)) ─

/**
 * 解析有效触发器。未知窗口 → 仅使用设置（诚实：没有假窗口 — 目录索引先例）。
 *
 * 计算实际生效的上下文压缩阈值（Token 数）。
 * 优先使用用户设置的阈值，如果未设置，则根据所用模型的上下文窗口大小降级计算：
 * 如果模型上下文未提供，则回退至硬编码的 `COMPACTION_THRESHOLD_DEFAULT` (150k)。
 * 如果上下文小于安全下限，则返回最大值（表示永远不触发压缩）。
 * @param settingTokens 用户设置的阈值。
 * @param contextWindowTokens 模型支持的最大上下文窗口。
 * @returns 计算后的实际压缩阈值（Token数）。
 */
export function effectiveThresholdTokens(settingTokens: number | undefined, contextWindowTokens: number | undefined): number {
	const setting = settingTokens ?? 150_000;
	if (contextWindowTokens === undefined) return setting;
	return Math.min(setting, Math.max(contextWindowTokens - COMPACTION_RESERVE_TOKENS, 1));
}

// ─── the estimate over the ACTIVE projection ────────────────────────────────

/**
 * 预计的上下文估计：下一次 LLM 调用将携带的内容。
 * 触发法则（THE TRIGGER LAW，pi's，verified 2026-10-05）：锚定在最后一条
 * 助手消息的提供商报告使用量上 — 它已经计算了系统提示、工具声明和提供商
 * 自己的分词器 — 并且仅对追加在它之后的消息进行 chars/4 估计。
 * estimateContextTokens 拒绝早于压缩标记的锚点（该使用量描述了下一个请求
 * 不会携带的上下文），因此回退路径对 CUT-HONORED 投影（从不是丢弃的跨度）
 * 运行纯粹的启发式方法，加上锚点原本会覆盖的附加提示项。
 *
 * 估算给定消息历史记录中的总 Token 数。
 * 粗略估算规则为：将所有消息的内容、角色、调用以及工具返回的文本转换为字符串，长度除以 4。
 * 加上预估的系统提示词 Token 数，从而决定是否需要进行上下文压缩。
 * @param messages 聊天消息记录。
 * @param systemPromptTokens 系统提示词的预估 Token 数量。
 * @returns 预估的总 Token 数。
 */
export function projectedContextTokens(messages: readonly LhMessage[], systemPromptTokens: number): number {
	const est = estimateContextTokens(messages);
	if (est.lastUsageIndex !== null) return est.tokens;
	return estimateTokens(toLlmMessages(messages as readonly AgentMessage[]) as unknown as readonly LhMessage[]) + systemPromptTokens;
}

// ─── the compaction run ─────────────────────────────────────────────────────

/**
 * 为聊天运行一次压缩（注册表互斥锁由调用者持有 — ensureCompacted）。
 * 重新读取记录，切割，总结，追加标记，记录使用量，通知。永远不会向上抛出异常超过注册表清理。
 */
async function compact(deps: CompactionDeps, chatId: string): Promise<void> {
	const record = deps.chatStore.getChat(chatId);
	if (!record) return;
	const messages = record.messages;
	const tokensBefore = projectedContextTokens(messages, deps.systemPromptTokens);
	if (tokensBefore <= deps.thresholdTokens) return; // settled beneath while we waited

	const cut = compactionCutIndex(messages);
	if (cut >= messages.length) return; // nothing to drop (defensive)

	// The previous compaction's kept boundary (chained compactions
	// summarize the old summary + what rode after it).
	const previous = activeCompactionOf(messages);
	const prevKept = previous ? messages.findIndex((m) => m.id === previous.details.firstKeptMessageId) : -1;
	// ANTI-CHURN GUARD: when the cut cannot advance past the previous
	// kept boundary, the span is empty (or repeats it) — the kept tail
	// alone carries the projection and re-summarizing the same span
	// cannot shrink it. Reachable only when the threshold sits below
	// kept-tail + summary (a hand-edited record below the settings
	// floor); skipping keeps the loop honest instead of churning.
	if (previous && prevKept !== -1 && cut <= prevKept) {
		console.info(
			`[chat ${chatId}] compaction skipped — the kept tail alone exceeds the threshold (raise it or shrink the tail)`,
		);
		return;
	}

	// The span: from the PREVIOUS kept boundary through the cut.
	let spanStart = 0;
	let priorSummary: string | null = null;
	if (previous && prevKept > 0) {
		spanStart = prevKept;
		priorSummary = previous.content;
	}
	const spanText = serializeForSummary(messages.slice(spanStart, cut));
	const fullSpan = priorSummary ? `[SYSTEM NOTE — prior compaction summary, still authoritative where not superseded]\n${priorSummary}\n\n${spanText}` : spanText;

	const prompt = buildCompactionPrompt({
		spanText: fullSpan,
		planTreeText: planTreeToText(record.tree, messages),
		kind: deps.kind,
	});

	emit("compaction-changed", { chatId, running: true });
	try {
		const summarize = deps.summarize ?? subagentSummarizer;
		const { summary, usage } = await summarize(prompt, deps.engine);
		const trimmed = summary.trim();
		if (!trimmed) return; // an empty summary is a refusal artifact — leave the record honest

		const firstKept = messages[cut]!;
		const details: CompactionDetails = {
			firstKeptMessageId: firstKept.id,
			tokensBefore,
			model: deps.modelId,
			at: new Date().toISOString(),
		};
		const marker = newCompactionMarker(trimmed, details);
		deps.chatStore.saveMessages(chatId, [...messages, marker]);
		// The money channel: the summary is a real model call on the
		// session's own engine — its usage keys to the marker (provenance:
		// the transcript shows the compaction divider at the marker).
		deps.chatStore.appendTurnUsage(chatId, {
			id: crypto.randomUUID(),
			messageId: marker.id,
			at: details.at,
			model: deps.modelId,
			steps: [
				{
					inputTokens: usage.input,
					outputTokens: usage.output,
					cacheReadTokens: usage.cacheRead,
					cacheWriteTokens: usage.cacheWrite,
					reasoningTokens: usage.reasoning ?? 0,
				},
			],
		});
		// Notify-then-fetch: the record gained the marker (the client's
		// dividers appear) and the status event ends the send gate.
		emit("record-changed", { chatId });
	} catch (err) {
		// A failed compaction leaves the record untouched — the next
		// turn-start gate retries (the same self-healing law as the
		// extraction trigger).
		console.error(`[chat ${chatId}] compaction failed:`, err);
	} finally {
		emit("compaction-changed", { chatId, running: false });
	}
}

/**
 * 门控 + 触发器合二为一：等待任何飞行中（in-flight）的压缩，然后 — 如果
 * 记录仍然超过阈值 — 同步运行一个（调用者的请求等待；owner 的结构门规则）。
 * 通过注册表互斥锁在并发下是幂等的。
 *
 * 保证当前会话上下文已经被压缩。
 * 如果该会话已经有一个正在进行的压缩任务，该函数会等待其完成。
 * 若没有，且估算的 Token 超过阈值，则会立即在当前线程上启动压缩。
 * （该函数在聊天请求的门控阶段被调用，用来阻止请求直到上下文适合传递给模型）。
 * @param deps 压缩所需的依赖（包括引擎、模型、数据库接口等）。
 * @param chatId 会话的唯一标识符。
 */
export async function ensureCompacted(deps: CompactionDeps, chatId: string): Promise<void> {
	// Skipped under tests, the extraction-trigger precedent: scripted
	// chats are fixtures — the service itself is tested directly with an
	// injected summarizer.
	if (process.env.NODE_ENV === "test" && !deps.summarize) return;
	await awaitCompaction(chatId);
	const record = deps.chatStore.getChat(chatId);
	if (!record) return;
	if (projectedContextTokens(record.messages, deps.systemPromptTokens) <= deps.thresholdTokens) return;
	if (state().inFlight.has(chatId)) return; // a concurrent caller started it while we awaited
	const run = compact(deps, chatId);
	state().inFlight.set(chatId, run);
	try {
		await run;
	} finally {
		state().inFlight.delete(chatId);
	}
}

/**
 * 结算踢出（触发即忘）：回合已结算，学习者即将阅读/回答 — 如果投影超过阈值，
 * 摘要现在开始，并在暂停期间完成。在 chat-handler 的 onFinish 尾部连接；
 * 无引擎或超过阈值但无内容是静默的无操作。下一个回合的 ensureCompacted 门控
 * 会接管这里留下的任何运行。
 *
 * 触发后台上下文压缩。
 * 如果当前上下文超过了 Token 阈值，并且当前没有正在运行的压缩任务，
 * 就会在后台生成一个异步任务进行汇总合并。如果依赖不足或无需压缩，则无操作。
 *
 * @param buildDeps 一个工厂函数，用于提供压缩执行所需要的依赖配置（若返回 null 则中止触发）。
 * @param chatId 目标会话的唯一标识符。
 */
export function kickCompaction(buildDeps: () => CompactionDeps | null, chatId: string): void {
	if (state().inFlight.has(chatId)) return;
	const deps = buildDeps();
	if (!deps) return;
	const record = deps.chatStore.getChat(chatId);
	if (!record) return;
	if (projectedContextTokens(record.messages, deps.systemPromptTokens) <= deps.thresholdTokens) return;
	const run = compact(deps, chatId);
	state().inFlight.set(chatId, run);
	void run.finally(() => state().inFlight.delete(chatId));
}
