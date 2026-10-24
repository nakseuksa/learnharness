/**
 * 唤醒管道（THE WAKE PIPELINE，contracts.ts "THE ASYNC PROTOCOL" §4）—
 * 已完成的子代理作业（sub-agent jobs）的服务器端操控交付（steer delivery）。
 * Wave C（2026-09-26）：当运行处于活动状态时，交付乘坐 pi 自己的后续队列，
 * 否则使用空闲唤醒（idle wake）。一个注册表，两种工具。
 *
 *   deliverJobResult(steer) — 运行器在作业完成时调用它。
 *     操控加入每个聊天的序列化注册表，泵（pump）将其沿着两条路径之一驱动：
 *
 *       1. 实时运行（LIVE RUN） → pi steering：标记被传递给实时（LIVE）
 *          代理的操控队列（agent.steer）。pi 在回合边界（TURN BOUNDARIES）轮询该队列 —
 *          在完成的助手消息及其工具结果之后（从不在 toolCall 及其结果之间），
 *          并在运行开始时再次轮询（延续（continuation）在其第一次 LLM 调用之前排空队列）
 *          — 并继续相同的运行（CONTINUES THE SAME RUN）：标记在课程中途加入上下文，
 *          乘坐实时事件流（message_start/message_end），并在该运行的持久化时落在记录中。
 *          这是 owner 的 2026-09-26 修正：真正的课程是一个连续的 teach→quiz→teach
 *          循环，因此交付必须发生在运行内部的消息之间 — 等待运行停止（后续）只会在
 *          停止器出口（stopper exit）触发，而这正是它绝不能发生的时候。
 *          问题停止器在回合后轮询之前运行并退出循环，因此以测验终止的运行从不注入：
 *          交付的标记滞留（见 settleSteers）并等待 — 然后答案（ANSWER）运行在其
 *          开始轮询时将其拾取。探测移交（probe-handoff）标记从不走这条路径（owner ruling：
 *          移交必须启动老师（TEACHER）的运行 — 一个只有新的唤醒才能做出的记录级分支）。
 *       2. 空闲唤醒（IDLE WAKE）：没有实时回合。等待空闲（WAIT FOR IDLE）
 *          （回合活跃度或悬而未决的问题 — 未回答的客户端工具调用会破坏提供商转换），
 *          然后触发一个服务器端唤醒回合，携带每个排队的标记作为其输入追加
 *          （预写持久化、活跃度、提取 — 单一代码路径，与客户端请求相同的组合）。
 *          409 意味着客户端回合抢先了 — 重新排队并使用退避（backoff）重试。
 *          按 jobId 幂等（steerDelivered）：崩溃的唤醒或重复交付会被跳过，而不是重复。
 *
 *   settleSteers(chatId, persisted) — 处理程序在回合结算时调用它
 *     （在 unregisterLiveAgent 之后）：运行交付（DELIVERED）的条目
 *     解析 + 翻转它们的作业；传递给垂死运行但从未注入的条目（停止器出口、中止、
 *     错过的最后轮询）返回到待处理（pending），泵重新启动 — 没有滞留，没有丢失。
 *
 *   崩溃恢复（Crash recovery，recoverStaleJobs）：进程重启可能会使作业孤立 —
 *     具有结果的“running”（唤醒从未触发）或没有结果的“running”
 *     （子代理循环本身死了）。扫描重新交付完成的结果（幂等地）并重新生成未完成的
 *     循环，两者都通过注入的接缝（injected seams）。它懒惰地运行在 /api/jobs 轮询上，受限流控制。
 *
 * 所有可变状态都驻留在 globalThis 上（回合活跃度教训：Next dev 给每个路由入口自己
 * 的模块实例 — 模块级 Map 在每个实例中将是一个不同的对象）。
 */

import {
	buildAbortSteer,
	buildSubagentSteer,
	isSubagentFailure,
	steerDelivered,
	type JobRecord,
	type SteerMessage,
} from "../core/contracts.ts";
import type { TurnInput } from "../core/input-events.ts";
import { danglingQuestionOf, endsInDismissal, type LhMessage } from "../core/native-messages.ts";
import { fireJobAbort, isJobLive } from "../agent/subagents/aborts.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import type { Agent } from "@earendil-works/pi-agent-core";

/**
 * 触发一个服务器端教师回合：(chatId, input) → HTTP-ish 状态。
 * Wave C：输入是空闲唤醒（IDLE WAKE） — 每个排队的标记作为回合的输入追加
 * （处理程序在唤醒自己的回合声明下原生追加它们；每个回合一个组合）。
 */
export type TurnRunner = (chatId: string, input: TurnInput) => Promise<number>;

/** 重新运行作业的子代理循环（孤立作业的崩溃恢复）。 */
export type JobRespawn = (jobId: string) => void;

interface QueuedSteer {
	steer: SteerMessage;
	resolve: () => void;
	reject: (reason: Error) => void;
	/**
	 * 此标记被操控进入的实时代理（agent.steer） — 由移交助手设置。
	 * 防止双重移交（重新泵送的循环或重新注册的运行绝不能重新排队运行已持有的内容），
	 * 并在垂死运行从未注入的标记结算时被清除（CLEARED）。
	 */
	handedTo?: Agent;
}

interface WakeState {
	turnRunner?: TurnRunner;
	respawn?: JobRespawn;
	/**
	 * chatId → 等待交付的操控，按到达顺序。单一交付注册表
	 * （Wave C：代理自己的后续队列是每个运行的工具（VEHICLE），
	 * 而不是注册表 — 结算在这里调和）。
	 */
	queues: Map<string, QueuedSteer[]>;
	/**
	 * chatId → 等待排空的用户操控消息（合成器操控，2026-10-03）。
	 * 与作业标记相同的交付或重新排队生命周期：实时代理的操控队列是工具（VEHICLE），
	 * 这是注册表 — 滞留在问题或中止之后的操控会停泊在这里，
	 * 并乘坐聊天的下一次运行（handOffEligible）。
	 */
	userSteers: Map<string, UserSteerEntry[]>;
	/**
	 * chatId → 当前正在流式传输回合的代理（在结算时，settleSteers 之前被清除）。
	 * 泵的实时路径将标记交给此代理的后续队列。
	 */
	liveAgents: Map<string, Agent>;
	/** 其泵循环当前处于活动状态的聊天（每个聊天序列化）。 */
	pumping: Set<string>;
	/** 过期作业扫描的限流簿记。 */
	lastSweepAt: number;
}

interface LhWakeGlobal {
	__lhWakePipeline?: WakeState;
}

function state(): WakeState {
	const g = globalThis as typeof globalThis & LhWakeGlobal;
	return (g.__lhWakePipeline ??= { queues: new Map(), liveAgents: new Map(), userSteers: new Map(), pumping: new Set(), lastSweepAt: 0 });
}

/** chat-handler wires this at module init: its adapter around handleChatRequest. */
/**
 * 注入服务器端的后台 Agent 回合运行器。
 * 当需要通过 idle wake 机制自动推进一个回合（处理排队的 steers）时使用。
 * @param run 负责启动对话回合的函数。
 */
export function setTurnRunner(run: TurnRunner): void {
	state().turnRunner = run;
}

/** chat-handler wires this at module init: its job runner's runJob. */
/**
 * 注入后台任务复活机制（当系统崩溃重启后恢复正在运行但已死掉的任务）。
 * @param respawn 负责重新生成任务实例的函数。
 */
export function setJobRespawn(respawn: JobRespawn): void {
	state().respawn = respawn;
}

const POLL_MS = 400;
/**
 * 大门打开后，等待一拍再触发 — 刚回答问题的客户端即将发送其延续；不要返回 409。
 *
 * 750 的证据：竞争窗口正是学习者的 answer→POST 飞行时间 —
 * sendAutomaticallyWhen 在 addToolOutput 时同步调度，答案仅在
 * 预写持久化时命中记录，并且 beginTurn 紧接着翻转回合注册表，所有这些都在宽限期
 * 触发之前完成（测量的 localhost RTT ~10ms；典型的 LAN/生产环境 RTT <300ms）。
 * 750ms 是最差实际飞行时间的 2.5 倍。未命中会自我修复：泵在宽限期后重新检查
 * 大门，并且唤醒管道使用退避斜坡重试 409 — 而且由于传输的合并重试
 * （chat-transport.ts）使得客户端 409 变得非致命，即使是病态的 RTT 也能优雅降级。
 * （曾是 1500 — 纯粹的猜测；750 收回了 750ms 的回答后交付延迟，而没有削弱防护。）
 */
const GRACE_MS = 750;
/** 409 退避：有上限的斜坡，这样繁忙的客户端就不会让泵空转。 */
const RETRY_BACKOFF_MS = [500, 1000, 2000, 5000] as const;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 操控所属的作业，如果它是一个作业操控（结果/中止）；探测移交操控没有作业 — 为 null。 */
function jobIdOf(steer: SteerMessage): string | null {
	const details = steer.details as { jobId?: string } | undefined;
	return typeof details?.jobId === "string" ? details.jobId : null;
}

/**
 * Dock 簿记：标记到达了学习者的视图 — 现在（NOW）翻转其作业，而不是等待
 * 交付的回合结算。从两个（BOTH）可见性接缝调用：标记的 message_end 线路事件
 * （实时操控注入 — 老师继续教学时卡片在屏幕上）和 handleChatInput 中的预写持久化
 * （唤醒的输入追加 — 卡片在记录中是持久的）。注册表的交付承诺仍然通过
 * settleSteers / runner-200 路径结算；finalizeJob 是幂等的，因此后面的翻转是无操作。
 * Owner ruling (2026-09-26): 交付的子代理在其结果可见的那一刻离开后台 dock，
 * 而不是在老师的回合结束时。
 *
 * 标记特定 steer（来自后台任务的结果）已向用户可见，即已被渲染。
 * 此时就可以把关联的任务状态从 "running" 转换为 "done/failed"。
 * @param steer 操控消息。
 */
export function noteSteerVisible(steer: SteerMessage): void {
	finalizeSteer(steer);
}

/** 完成已交付操控的作业簿记 — 仅限作业操控。 */
function finalizeSteer(steer: SteerMessage): void {
	const jobId = jobIdOf(steer);
	if (jobId) finalizeJob(jobId);
}

/** 在不可恢复的交付失败时使操控的作业失败 — 仅限作业操控。 */
function failSteer(steer: SteerMessage, err: Error): void {
	const jobId = jobIdOf(steer);
	if (jobId) failJob(jobId, err);
}

/**
 * 通过管道排队任何（ANY）操控（结果、中止、探测移交）。
 * 当唤醒回合完成时 resolve；当交付不可恢复地失败时 reject。永远不会因为排队本身而 reject。
 *
 * 将后台任务的结果（打包成 SteerMessage）投递给对应的聊天对话。
 * 该函数负责排队投递请求，然后启动队列泵处理这些操控消息（或者递交给活跃运行的回合，或者作为独立回合驱动）。
 * @param steer 包含任务结果和目标关联信息的操控消息。
 * @returns 当该 steer 已确认送达且持久化（或者遇到不可恢复的错误）时，Promise 才会 resolve/reject。
 */
export function deliverJobResult(steer: SteerMessage): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const s = state();
		const chatId = chatIdOf(steer);
		const queue = s.queues.get(chatId) ?? [];
		queue.push({ steer, resolve, reject });
		s.queues.set(chatId, queue);
		void pump(chatId);
	});
}

/**
 * 将每个符合条件的待处理标记交给实时代理的操控队列（通过 handedTo 对每个代理幂等）。
 * 从泵的实时路径和 registerLiveAgent 两者（BOTH）调用 — 停泊的标记（滞留在测验之后）
 * 绝不能等待泵循环注意到新的运行：处理程序在 runPiTurn 之前（BEFORE）注册答案运行的代理，
 * 因此此移交在循环的同步 start-poll 排空之前完成，标记乘坐该运行的第一次 LLM 调用
 * （旧延续合并的本机等效物）。
 */
function handOffEligible(chatId: string, agent: Agent): void {
	const queue = state().queues.get(chatId);
	if (queue && queue.length > 0) {
		for (const entry of queue) {
			if (entry.handedTo !== agent && entry.steer.customType !== "probe-handoff") {
				agent.steer(entry.steer);
				entry.handedTo = agent;
			}
		}
	}
	// User steers (2026-10-03): same hand-off, any live run — a steer
	// stranded behind a question or abort rides the chat's next run's
	// first boundary. No probe-handoff exclusion: these are learner
	// words, owed to whatever run is live.
	const userQueue = state().userSteers.get(chatId);
	if (userQueue && userQueue.length > 0) {
		for (const entry of userQueue) {
			if (entry.handedTo !== agent) {
				agent.steer(entry.message);
				entry.handedTo = agent;
			}
		}
	}
}

/**
 * chat-handler 在 runPiTurn 之前（BEFORE）注册当前正在流式传输（CURRENTLY STREAMING）
 * 回合的代理（循环开始的 steering-poll 在该调用内同步排空 — 后面的注册将错过它）。
 * 待处理的注册表标记就在这里被引导到运行中。结算接缝无法击败注册：结算需要流式响应，
 * 这永远不会在构造函数调用内发生。
 *
 * 注册一个正在当前会话中运行的活跃 Agent 实例。
 * 这样就可以将排队的操控消息（Steer）实时递交给它，而无需等待它结束。
 * @param chatId 会话 ID。
 * @param agent 活跃的 Pi Agent 实例。
 */
export function registerLiveAgent(chatId: string, agent: Agent): void {
	state().liveAgents.set(chatId, agent);
	handOffEligible(chatId, agent);
}

/**
 * 停泊的用户操控：消息加上它最后一次交接的代理（双重移交防护 — 调和过程仅在其
 * id 从未落在持久化记录中时才保留它）。
 */
export interface UserSteerEntry {
	message: LhMessage;
	handedTo?: Agent;
}

/**
 * 操控路由的实时移交（合成器操控，2026-10-03）。
 * 设计为同步 — 实时代理检查和 queue() 之间没有交错意味着结算回合永远无法与移交竞争。
 * 当没有回合处于活动状态时返回 false：调用者返回 409，客户端回退到纯文本发送（结算竞争）。
 * 注册表副本是滞留安全网：如果此代理在未交付时死亡（问题终止、中止），
 * reconcileUserSteers 会将其保留为该聊天下一次运行的停泊状态。
 *
 * 用户主动发送的新鲜内容，尝试动态投递给正在运行的对话 Agent。
 * 如果存在支持 Composer（合成器）机制的活跃 Agent，它将消耗这个消息并返回 true。
 * @param chatId 目标对话会话 ID。
 * @param message 要投递的消息。
 * @returns 是否成功动态投递给了活跃 Agent。
 */
export function steerLiveChat(chatId: string, message: LhMessage): boolean {
	const agent = state().liveAgents.get(chatId);
	if (!agent) return false;
	const entry: UserSteerEntry = { message };
	const q = state().userSteers.get(chatId) ?? [];
	q.push(entry);
	state().userSteers.set(chatId, q);
	agent.steer(message);
	entry.handedTo = agent;
	return true;
}

/**
 * 用户操控的回合结算调和（TURN SETTLEMENT RECONCILIATION）：已交付的 id 丢弃
 * （记录保留它们）；未交付的保留停泊等待下一次运行。
 * 设计上仅限内存（与作业标记相同的权衡）：服务器重启会丢弃停泊的操控 —
 * 无论如何，整个回合都会随之死亡。
 *
 * 调和用户端的 steer 数据：当活跃回合结束且消息被持久化后，检查哪些用户投递的
 * steer 真正落盘了，清理已送达的条目，未送达的保留在队列供下次重试。
 * @param chatId 会话 ID。
 * @param persisted 当前已持久化的最新消息列表。
 */
export function reconcileUserSteers(chatId: string, persisted: readonly LhMessage[]): void {
	const q = state().userSteers.get(chatId);
	if (!q || q.length === 0) return;
	const ids = new Set(persisted.map((m) => (m as { id?: string }).id));
	const kept = q.filter((e) => !ids.has(e.message.id));
	if (kept.length === 0) state().userSteers.delete(chatId);
	else state().userSteers.set(chatId, kept);
}

/**
 * 在结算时清除实时代理 — 必须在 settleSteers 之前运行，这样调和过程的
 * 重新泵送绝不会将标记交给垂死的代理。
 *
 * 注销当前活跃运行的 Agent。在回合结束或者因错误崩溃时调用。
 * @param chatId 会话 ID。
 */
export function unregisterLiveAgent(chatId: string): void {
	state().liveAgents.delete(chatId);
}

/**
 * 回合结算调和（TURN SETTLEMENT RECONCILIATION，Wave C）：处理程序在
 * unregisterLiveAgent 之后（AFTER）使用运行的持久化消息调用它。两项工作：
 *
 *   - 运行交付（DELIVERED）其标记的条目（运行中后续注入 — 它们的 id
 *     在持久化切片中）解析并翻转它们的作业；
 *   - 传递给垂死运行但从未注入的条目（问题停止器在后续轮询之前退出；中止；
 *     与最终轮询竞争的交付）返回到待处理（PENDING，handedTo 被清除），并且
 *     泵重新启动 — 大门打开后空闲唤醒交付它们。
 *
 * 这就是使实时移交安全的原因：pi 对于滞留在已结算代理队列中的标记没有重试机制，
 * 因此注册表保持为事实，死代理的副本只是被丢弃（与代理一起 GC）。
 *
 * 回合结束时的最终调和机制：它会对比投递队列中“已递交给上一个回合”的消息
 * 是否存在于新持久化的记录中。在记录中存在的会被标记完成；丢失的（如由于运行中断）
 * 则取消其递交标记，并重新唤醒 `pump` 处理它们。
 * @param chatId 会话 ID。
 * @param persisted 本回合持久化落地的消息片段。
 */
export function settleSteers(chatId: string, persisted: { id?: string }[]): void {
	const queue = state().queues.get(chatId);
	if (!queue || queue.length === 0) return;
	const deliveredIds = new Set(persisted.map((m) => m.id).filter(Boolean));
	const remaining: QueuedSteer[] = [];
	for (const entry of queue) {
		if (deliveredIds.has(entry.steer.id)) {
			finalizeSteer(entry.steer);
			entry.resolve();
		} else {
			entry.handedTo = undefined;
			remaining.push(entry);
		}
	}
	if (remaining.length === 0) state().queues.delete(chatId);
	else {
		state().queues.set(chatId, remaining);
		void pump(chatId);
	}
}

/** 尝试中止的结果 — 端点将这些映射到 HTTP。 */
export interface AbortOutcome {
	ok: boolean;
	reason?: "not_found" | "not_running";
}

/**
 * 中止（ABORT，2026-09 dock 语义，用户决定）：真正的杀死，带原因的错误，老师仍在学习。
 * dock 的 END 按钮通过 POST /api/activity/abort（body {kind: "job", id: jobId}）
 * 访问这里；路由是 master 的精简组合 — 这是作业端（job-side）的机制。
 * 按顺序发生四件事：
 *
 *   1. 杀死（KILL）花费：触发作业注册的 AbortController（运行器在循环开始时注册它）
 *      — 飞行中的模型调用被中止，而不仅仅是下一次循环检查。运行器静默展开
 *      （其 catch 检查 abortSignal.aborted；finishJob 检查状态）。
 *   2. 丢弃（DROP）此作业的任何排队结果操控（正在交付结果的阶段）：
 *      解析其条目而不触发唤醒。如果唤醒回合已经在飞行中（泵移动了条目），
 *      为时已晚 — 结果操控落地，取消操控通过 steerDelivered（相同的 jobId 元数据）
 *      对其进行去重。
 *   3. 立即将记录翻转（FLIP）为错误 "Aborted by learner" — 轮询立即反映
 *      用户的操作（用户选择了 error-with-reason 而不是独特的 cancelled 状态）。
 *      finalizeJob 永远不会覆盖非运行状态，因此无论唤醒做什么，翻转都是最终的。
 *   4. 引导（STEER）老师：通过相同的唤醒管道发送一条一行的中止说明（buildAbortSteer），
 *      这样老师的结果承诺就不会在课程中静默挂起。
 *
 * 运行器在其 finally 中写入到目前为止折叠的使用量（合并补丁），
 * 因此被中止的作业的金钱记录能在杀死中幸存下来。
 *
 * 用户发起主动中断（Abort）后台任务的请求处理函数。
 * 任务会被标记为 abort（这会自动终止任务底层的执行），如果该任务还没有结果，就产生一个 abort 类型的 steer 传递给对话。
 * @param jobId 要中断的任务 ID。
 * @returns 中断操作的结果及其详情。
 */
export function abortJob(jobId: string): AbortOutcome {
	const job = stores.jobStore.getJob(jobId);
	if (!job) return { ok: false, reason: "not_found" };
	if (job.status !== "running") return { ok: false, reason: "not_running" };

	fireJobAbort(jobId); // no-op when the loop already returned (delivering)

	// Drop any queued steers for this job (their deliver() resolves unfired).
	// HANDED entries (already in a live run's follow-up queue) are past
	// recall — same ruling as a fired wake: the result lands, and the abort
	// note below dedupes against it via steerDelivered (same jobId).
	const queue = state().queues.get(job.chatId);
	if (queue) {
		const remaining = queue.filter(
			(e) => jobIdOf(e.steer) !== jobId || e.handedTo !== undefined,
		);
		if (remaining.length === 0) state().queues.delete(job.chatId);
		else state().queues.set(job.chatId, remaining);
		for (const entry of queue) {
			if (jobIdOf(entry.steer) === jobId && entry.handedTo === undefined) entry.resolve();
		}
	}

	stores.jobStore.updateJob(jobId, { status: "error", error: "Aborted by learner", activity: "aborted" });
	void deliverJobResult(buildAbortSteer(job)).catch(() => {
		/* deliverJobResult marks the job error on unrecoverable failure */
	});
	return { ok: true };
}

function chatIdOf(steer: SteerMessage): string {
	// The probe handoff carries its chat directly in the marker details (the
	// job record would say it too, but the details are the cheap path).
	if (steer.customType === "probe-handoff") {
		return (steer.details as { chatId: string }).chatId;
	}
	// The chat is resolvable from the job record; the steer's details
	// carry jobId, which indexes the store.
	const jobId = jobIdOf(steer);
	const job = jobId ? stores.jobStore.getJob(jobId) : undefined;
	return job?.chatId ?? "";
}

/**
 * 每个聊天的泵：沿着 pi 的两条本机路径交付注册表。
 * 每个聊天一次只有一个循环；后来到达的乘坐注册表。
 *
 * 每次迭代首先清除死重（消失的聊天、已交付的标记），然后选择载具：
 * 实时（LIVE）回合通过 agent.followUp 获取每个符合条件的标记
 * （运行在其自己的停止处继续 — 在结算重新泵送之前，这里没有更多可做的事情）；
 * 否则，空闲唤醒（IDLE WAKE）触发一个回合，携带每个待处理的标记作为其输入追加。
 */
async function pump(chatId: string): Promise<void> {
	if (!chatId) return;
	const s = state();
	if (s.pumping.has(chatId)) return;
	s.pumping.add(chatId);
	try {
		for (let attempt = 0; ; ) {
			const queue = s.queues.get(chatId);
			if (!queue || queue.length === 0) {
				s.queues.delete(chatId);
				return;
			}

			// Gone chat: nothing to deliver into.
			const record = stores.chatStore.getChat(chatId);
			if (!record) {
				s.queues.delete(chatId);
				for (const entry of queue) {
					entry.reject(new Error(`chat ${chatId} not found — cannot deliver steer ${entry.steer.id}`));
				}
				continue;
			}

			// Idempotent delivery: the transcript already carries these steers
			// (an in-run injection persisted, a wake completed, or a duplicate
			// deliver raced in). Resolve and flip without re-firing anything.
			const stillPending = queue.filter((e) => !steerDelivered(record.messages, e.steer.id));
			for (const entry of queue) {
				if (!stillPending.includes(entry)) {
					finalizeSteer(entry.steer);
					entry.resolve();
				}
			}
			if (stillPending.length === 0) {
				s.queues.delete(chatId);
				return;
			}
			s.queues.set(chatId, stillPending);

			// VEHICLE 1 — THE LIVE RUN: pi's steering queue. The agent of the
			// streaming turn takes every eligible marker; pi injects at the
			// next turn boundary (message_start/message_end on the live wire,
			// between completed assistant+toolResult units) and continues the
			// run. Delivery resolves at settlement (settleSteers). Nothing else
			// to do in this loop iteration — the turn owns the delivery.
			const live = s.liveAgents.get(chatId);
			if (live && isTurnRunning(chatId)) {
				handOffEligible(chatId, live);
				const handable = stillPending.filter((e) => e.handedTo === live);
				// probe-handoffs never ride a live run (owner ruling: the
				// handoff must START the teacher's run) — if any remain
				// pending, wait the run out and loop to the wake below.
				const handoffWaits = stillPending.some(
					(e) => e.steer.customType === "probe-handoff",
				);
				if (handable.length > 0 && !handoffWaits) {
					return; // the run delivers; settleSteers re-pumps the rest
				}
				if (handable.length > 0) {
					await delay(POLL_MS);
					await waitForIdle(chatId);
					continue;
				}
			}

			// VEHICLE 2 — THE IDLE WAKE: one server-side turn carrying EVERY
			// pending marker as its input appends (the handler write-ahead
			// persists them under the wake's own turn claim).
			await waitForIdle(chatId);

			// Re-fetch AFTER the gates open — waitForIdle can wait out a quiz
			// answer (minutes), and sending the pre-wait snapshot would clobber
			// the client's answer + continuation in the write-ahead persist.
			const fresh = stores.chatStore.getChat(chatId);
			if (!fresh) {
				continue; // the gone-chat branch rejects next iteration
			}

			// The runner is required — chat-handler sets it at init. If some
			// module instance missed the wiring, fail loudly rather than hang.
			if (!s.turnRunner) {
				s.queues.delete(chatId);
				const err = new Error("wake pipeline: no turn runner wired (setTurnRunner)");
				for (const entry of stillPending) {
					failSteer(entry.steer, err);
					entry.reject(err);
				}
				return;
			}

			// A live run may have delivered some markers while the gates were
			// closed — re-check: only still-missing markers ride the wake.
			const fire = stillPending.filter((e) => !steerDelivered(fresh.messages, e.steer.id));
			for (const entry of stillPending) {
				if (!fire.includes(entry)) {
					finalizeSteer(entry.steer);
					entry.resolve();
				}
			}
			if (fire.length === 0) {
				s.queues.delete(chatId);
				return;
			}

			// THE DISMISSAL PAUSE (owner design 2026-10-03, "A2"): the record
			// ends in a user dismissal — the session waits for the USER. Hold
			// every marker in the queue (no wake fires) and return; the user's
			// next send is the wake that carries them (the in-run vehicle below
			// hands them to that turn once the text-claim lands — until then,
			// settlement re-pumps and lands them right after it). The pause is
			// derived from the tail, so any user message un-holds by construction.
			if (endsInDismissal(fresh.messages)) {
				return;
			}

			// DEQUEUE-AT-FIRE (the Wave C lesson from the Wave B regression):
			// the carried markers leave the registry BEFORE the turn runs —
			// the wake run's OWN follow-up poll must never see its own cargo,
			// and a 409 (client raced in) must be able to push them back.
			s.queues.delete(chatId);
			const steers = fire.map((e) => e.steer);

			// Fire the wake (every marker as the turn's input appends). A 409 =
			// a client turn raced in between idle and firing — push the cargo
			// back and retry after backoff (the racing turn's own settlement
			// re-pumps if it beats us to the re-queue).
			const status = await s.turnRunner(chatId, { type: "steers", steers }).catch((err: unknown) => {
				console.error(`[steer ${steers.map((x) => x.id).join(",")}] wake turn crashed:`, err);
				return -1;
			});
			if (status === 409) {
				const back = s.queues.get(chatId) ?? [];
				back.push(...fire);
				s.queues.set(chatId, back);
				await delay(RETRY_BACKOFF_MS[Math.min(attempt++, RETRY_BACKOFF_MS.length - 1)]!);
				continue;
			}
			attempt = 0;

			if (status === 200) {
				for (const entry of fire) {
					finalizeSteer(entry.steer);
					entry.resolve();
				}
			} else {
				const err = new Error(`wake turn failed with status ${status}`);
				for (const entry of fire) {
					failSteer(entry.steer, err);
					entry.reject(err);
				}
			}
		}
	} finally {
		s.pumping.delete(chatId);
		// A steer may have arrived between the last check and the finally —
		// restart the pump rather than strand it. Entries already handed to
		// a live run are NOT stragglers (settleSteers owns their resurrection)
		// — restarting for them would just park in waitForIdle forever.
		const q = state().queues.get(chatId) ?? [];
		if (q.some((e) => e.handedTo === undefined)) void pump(chatId);
	}
}

/** 现在课程已恢复，将作业翻转到其最终状态。 */
function finalizeJob(jobId: string): void {
	const job = stores.jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;
	const result = job.result;
	const failed = result ? isSubagentFailure(job.kind, result as never) : true;
	stores.jobStore.updateJob(jobId, {
		status: failed ? "error" : "done",
		activity: failed ? "failed" : "delivered",
	});
}

function failJob(jobId: string, err: Error): void {
	// An aborted job stays aborted even when its (abort) steer
	// delivery fails — the user's action is the terminal fact, not the
	// delivery error. Non-running records are never overwritten here.
	const job = stores.jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;
	stores.jobStore.updateJob(jobId, { status: "error", error: err.message, activity: "delivery failed" });
}

/**
 * 等待直到聊天可以进行唤醒回合：没有飞行中的回合并且没有未回答的问题调用
 * （记录中悬而未决的问题 — 答案作为其工具结果到达，在该窗口中不能运行任何回合）。
 * 轮询；学习者可能需要任意长的时间来回答，这是正确的 — 操控在他们的回答回合完成之后立即触发。
 */
async function waitForIdle(chatId: string): Promise<void> {
	for (;;) {
		const record = stores.chatStore.getChat(chatId);
		if (!record) return;
		const blocked = isTurnRunning(chatId) || danglingQuestionOf(record.messages) !== null;
		if (!blocked) {
			await delay(GRACE_MS);
			const recheck = stores.chatStore.getChat(chatId);
			if (
				!isTurnRunning(chatId) &&
				recheck &&
				danglingQuestionOf(recheck.messages) === null
			) {
				return;
			}
		}
		await delay(POLL_MS);
	}
}

// ─── crash recovery ──────────────────────────────────────────────────────────

const SWEEP_THROTTLE_MS = 30_000;

/**
 * 懒惰扫描（在 /api/jobs 轮询中被调用，限流），活跃度门控（LIVENESS-GATED）
 * （准确性 wave，2026-09-19）：一个没有实时循环注册（subagents/aborts.ts）的
 * “运行中”记录是进程死亡的孤儿 — 立即重新交付其存储的结果（幂等地）或重新生成循环
 * （旧的 15 分钟存活时间启发式方法会等待幽灵，并且在自身旁边重新运行挂起但存活的循环 —
 * 图表制作器事件，2026-09-18）。带有实时注册的记录可证明正在此（THIS）进程中执行 —
 * 无论多老都不去碰：挂起的第一次模型调用（从未计费）诚实地在 dock 中保持“运行中”，
 * 直到 END 杀死它。中止注册跨越循环开始到交付完成，因此实时注册绝不可能属于死运行。
 */
/**
 * 重新运行作业的子代理循环 — 暴露给扫描的测试
 * （/api/jobs 轮询是其唯一的生产调用者，在 NODE_ENV=test 下被禁用）。
 */
/**
 * 恢复过期的作业。该操作会被限流，并通过轮询端点定期被触发。
 * 它会识别 "running" 状态但实际上由于进程崩溃等原因死掉的任务，并尝试重新发起交付，或者利用 `respawn` 恢复任务的运行循环。
 */
export function recoverStaleJobs(): void {
	const s = state();
	const now = Date.now();
	if (now - s.lastSweepAt < SWEEP_THROTTLE_MS) return;
	s.lastSweepAt = now;
	try {
		for (const chat of stores.chatStore.listChats()) {
			for (const job of stores.jobStore.listJobs(chat.id)) {
				if (job.status !== "running") continue;
				if (isJobLive(job.id)) continue; // provably executing here — never re-run beside it
				if (!stores.chatStore.getChat(job.chatId)) continue;
				if (isTurnRunning(job.chatId)) continue; // a wake turn may be delivering it right now
				if (job.result) {
					// The wake never fired (or crashed mid-flight): re-deliver.
					const steer = buildSubagentSteer(job, job.result as never);
					stores.jobStore.updateJob(job.id, { activity: "recovering: re-delivering" });
					void deliverJobResult(steer).catch(() => {
						/* deliverJobResult marks the job error on failure */
					});
				} else {
					// The sub-agent loop itself died with the process: re-spawn.
					if (!s.respawn) continue;
					stores.jobStore.updateJob(job.id, { activity: "recovering: re-running" });
					s.respawn(job.id);
				}
			}
		}
	} catch (err) {
		console.error("[jobs] stale-job recovery sweep failed:", err);
	}
}

/** /api/jobs 入口：客户端轮询的作业列表（+ 懒惰恢复）。 */
/**
 * 获取指定会话中的所有任务记录，为客户端 `/api/jobs` 端点服务。
 * （该函数也会懒触发一次 `recoverStaleJobs` 以尝试修复陈旧任务）
 * @param chatId 会话的唯一标识符。
 * @returns 该会话关联的所有任务记录。
 */
export function listJobs(chatId: string): JobRecord[] {
	if (process.env.NODE_ENV !== "test") recoverStaleJobs();
	return stores.jobStore.listJobs(chatId);
}
