import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { SteerMessage } from "../../core/contracts.ts";
import { noteSteerVisible } from "../jobs.ts";
import { ToolCallIdUniquifier } from "./call-ids.ts";

/**
 * 原生线路（THE NATIVE WIRE，Wave D，owner-approved 2026-09-26）：
 * 一个代理回合，作为 pi AgentEvents 流式传输到每个视图 — 没有转换，没有部分组装。
 * 唯一认可的重写（Lacan 修复，2026-10-04）：当提供商在每次响应时重置工具调用 ID
 * （DeepSeek 每回合都是 `call_0`）时，ID 会在此边界进行唯一化
 * — 参见 call-ids.ts 和 PiTurnSpec.usedToolCallIds。
 * SSE 请求体是代理自己的事件流：
 *
 *   data: {"type":"agent_start"}\n\n
 *   data: {"type":"message_update","message":{…}}\n\n
 *   …
 *   data: {"type":"agent_end","messages":[…]}\n\n
 *   data: [DONE]\n\n
 *
 * 承重协议事实（已针对 pi-agent-core 验证）：
 * - 每个 `message_update` 都携带完整（FULL）的部分助手消息（每个
 *   AssistantMessageEvent 传送 `partial`） — 视图使用 `event.message`
 *   替换（REPLACES）其流式助手；任何地方都不存在增量组装。
 * - 线路瘦身（WIRE DIET，owner，2026-10-09 — 流式冻结事后分析）：我们的
 *   边界发出纤细的（SLIM）message_update（仅 `message`）。pi 的事件还
 *   第二次（SECOND time）作为 `assistantMessageEvent` 携带了相同的完整部分
 *   — 这个应用中没有任何东西读取过它，每块重新序列化它会使每个流帧加倍。
 *   客户端总是读取 `event.message`。
 * - 提问工具（quiz / ask_user_question）：没有（NO）抑制（owner 规则，
 *   Wave D 分叉 2） — 带有内存中“问题已提出”占位符的结束 `tool_execution_end`
 *   流向客户端，客户端忽略它（提问工具由客户端拥有；答案作为输入事件到达）。
 *   占位符仍然从不持久化，也从不到达模型。
 * - 根据构造，工具调用验证门控存活：`tool_execution_end` 仅在调用
 *   清除边界后触发（无效调用作为 isError 到达 — 从不是干净的结束），
 *   因此 dock 的挂载规则以其为键。
 * - 超出 pi 分类法的应用级事件：重新附加终端 {"type":"turn-settled"}
 *   （由 turn-runs 在没有转弯运行时提供）和循环级 {"type":"error","errorText"}
 *   （agent.continue() 在事件流之外抛出异常 — 通过处理程序的屏蔽策略进行映射）。
 * - 流级提供商错误会逐字携带其消息
 *   （带有 stopReason "error" + errorMessage 的 message_end）。
 *
 * 后台回合运行器（BACKGROUND-TURN RUNNER，owner 规则，2026-09-25）：
 * 回合作为脱离于任何单个 HTTP 响应的服务器端后台对象执行 — 客户端是视图（VIEWS）。
 * runPiTurn 返回句柄（压缩状态 + 订阅者集合）；piTurnResponse 将订阅者流
 * 包装为 SSE 响应，POST /api/chat 响应和 GET /api/chats/[id]/stream 两者（BOTH）都是它。
 * 取消一个视图仅（ONLY）使其分离 — 从不中止回合；句柄的 abort() 是唯一的远程杀死。
 *
 * 压缩法则（THE COMPACTION LAW，owner，2026-10-09 — 取代了 2026-09-25 的无界日志规则）：
 * 回合日志存储状态（STATE），而不是块。pi 的本机事件是完整快照 —
 * 每个提供商块一个 — 因此保留每一个会使得内存和重放成本随消息长度呈二次方增长
 * （一条高度思考的消息保留数百 MB，并且每次重新附加都会在一次阻塞的伸展中
 * 重新序列化整个历史记录 — 并发会话导航冻结）。日志现在逐字保留已结算的事件，
 * 加上每个飞行中消息/工具调用的最新（LATEST）更新，就地替换；
 * 实时更新扇出合并为每个刷新窗口最多一帧（最新者获胜 — 视图按插槽替换，
 * 并且 message_end 携带完整的最终消息，因此丢弃的中间件是无损的）。
 * 因此，重放只花费内容一次的成本，从不是块的数量。
 */

/**
 * 线路事件：pi AgentEvent（带有我们纤细的 message_update — 见上文
 * WIRE DIET 注释），或两个应用事件之一。
 *
 * 前端流式通讯接口上的回合内网络事件定义。
 * 这个类型主要用来从后端同步生成中的部分状态。为了减少线缆（wire）通信负担，去掉了冗余封装。
 */
export type TurnWireEvent =
	| AgentEvent
	| { type: "message_update"; message: AgentMessage }
	| { type: "error"; errorText: string };

/**
 * 启动和运行后端 Agent 回合所需的配置规范。
 */
export interface PiTurnSpec {
	/** 每回合的代理（无状态引擎 — 从记录中构建）。 */
	agent: Agent;
	/**
	 * 处理程序对循环级（LOOP-level）失败的错误屏蔽策略
	 * （事件流本身是逐字的 — 提供商错误未受影响地乘坐其消息的
	 * stopReason/errorMessage 通过）。
	 */
	onError?: (error: unknown) => string;
	/**
	 * 规范的回合结束接缝：持久化 + 使用量记录 + 提取 + endTurn。
	 * 接收代理的完整（FULL）最终状态（本机消息）— 调用者持久化通过其自身基础计数的切片。
	 */
	onFinish: (messages: AgentMessage[], isAborted: boolean) => void;
	/**
	 * 此聊天记录中已使用的工具调用 ID（THE LACAN FIX，owner 批准，2026-10-04）：
	 * 存在时，ToolCallIdUniquifier 位于此边界 — 每次响应都重置 ID 的提供商
	 * （DeepSeek 每回合都是 `call_0`）的冲突 ID 会在这里重新铸造一次（ONCE），
	 * 因此线路视图、持久化记录、dock、答案路由以及下一个回合的提供商上下文
	 * 都能保持一致。缺失 → 逐字直通（下面的协议法则仍然适用）。
	 */
	usedToolCallIds?: ReadonlySet<string>;
	/**
	 * 更新扇出的合并窗口（见上文 COMPACTION LAW）。
	 * 默认为 100 毫秒；测试会收紧它。
	 */
	updateFlushMs?: number;
}

/**
 * 运行中回合的一个视图：push() 重放/流式传输事件，done() 终止视图
 * （[DONE] + 关闭）。作为 Set 成员成本很低。
 *
 * Agent 回合流事件订阅者的接口约束（视图附加在此，用于接收事件并写入底层 HTTP stream）。
 */
export interface PiTurnSubscriber {
	push(event: TurnWireEvent): void;
	done(): void;
}

/**
 * 服务器端回合对象（background-turn runner wave, 2026-09-25）：
 * 脱离任何单个 HTTP 响应运行代理，并拥有内存中的事件日志 +
 * 实时订阅者集合。POST 响应和重新附加流都是它的订阅者。
 *
 * 代表一个服务端独立在后台运行的回合句柄 (handle)。
 * - 该回合可以独立于单个 HTTP 响应独立运行；
 * - 它自己维护在内存中的事件日志和活动订阅者集合，允许迟延的客户端（或者网络中断的客户端）恢复连接后回放和接收。
 */
export interface PiTurnHandle {
	/**
	 * 全新的订阅者流：完整（FULL）重放日志，然后是实时事件，直到
	 * 回合结算（以 [DONE] 结束）。取消它仅（ONLY）分离视图 — 回合继续运行。
	 */
	subscribe(): ReadableStream<Uint8Array>;
	/**
	 * 远程杀死 — 运行中回合提前死亡的唯一（ONLY）方式：sawAbort + agent.abort()；
	 * 循环的 agent_end 处理剩下的事情（结算接缝将部分转录持久化给每个监听器）。
	 */
	abort(): void;
}

/**
 * 启动并运行一个 Agent 生成回合，返回其实例句柄。
 * 该方法封装了核心的循环机制（agent.continue()），并将 Pi Agent 事件：
 * 1. 经过 ID 去重器重构。
 * 2. 精简和合并为网络格式 `TurnWireEvent`，推送到内部日志和缓冲队列中。
 * 3. 并发派发给目前附着（attach）在该句柄上的所有活跃 SSE 订阅者。
 * 回合自然结束（或中止或错误）后将调用 `onFinish` 回调触发落地等收尾逻辑。
 *
 * @param spec 生成该回合所需的配置和钩子。
 * @returns 用于读取该回合进度或中止该回合的操作句柄 `PiTurnHandle`。
 */
export function runPiTurn(spec: PiTurnSpec): PiTurnHandle {
	const { agent, onError, onFinish, usedToolCallIds, updateFlushMs = 100 } = spec;
	const uniquifier = usedToolCallIds ? new ToolCallIdUniquifier(usedToolCallIds) : undefined;

	let settled = false;
	let sawAbort = false;

	// 每回合状态日志（仅内存 — 仅限结算的磁盘写入未更改）。
	// 压缩法则（COMPACTION LAW，owner，2026-10-09，取代了 2026-09-25
	// 的无界日志规则）：结算的事件逐字追加；飞行中的 `message_update` /
	// `tool_execution_update` 运行减少为其最新（LATEST）成员，就地替换。
	// 保留由内容（CONTENT，结算的消息 + 每个流消息一个快照）限制，而不是
	// 由块计数限制 — 冻结并发会话的二次方膨胀现在在结构上是不可能的。
	// 日志在结算时与回合一起死亡。
	const log: TurnWireEvent[] = [];
	// 实时更新插槽：合并键 → 保留更新的日志索引。
	// 一次流式传输一条助手消息（pi 的严格每步 start → updates → end 排序），
	// 因此消息共享一个插槽；并行的工具执行各自拥有其插槽（toolCallId）。
	// End 事件释放该插槽 — 相同键的后续更新会开始一次新的运行。
	const updateSlots = new Map<string, number>();
	// 用于实时（LIVE）扇出的合并队列：键 → 最新事件，每个刷新窗口最多刷新一次
	// （Map 保留了首次插入的顺序，因此并发键的相对顺序保持按时间先后顺序排列）。
	const pending = new Map<string, TurnWireEvent>();
	const subscribers = new Set<PiTurnSubscriber>();

	const coalesceKey = (event: TurnWireEvent): string | null => {
		if (event.type === "message_update") return "message";
		if (event.type === "tool_execution_update") return `tool:${event.toolCallId}`;
		return null;
	};

	// 发送（Send） = 压缩日志 + 扇出到每个活动视图。视图自身的排队失败
	// （被取消的读取器）会被视图吞没 — 回合仍然必须结算；无论谁在监视，
	// onFinish 都会持久化。
	const send = (event: TurnWireEvent) => {
		if (settled) return;
		const key = coalesceKey(event);
		if (key !== null) {
			// 保留（Retention）：就地替换运行的最新快照。
			const idx = updateSlots.get(key);
			if (idx !== undefined) log[idx] = event;
			else {
				updateSlots.set(key, log.length);
				log.push(event);
			}
			// 扇出（Fan-out）：已合并 — 最新者获胜，以 ≤1次/窗口 刷新。
			pending.set(key, event);
			armFlush();
			return;
		}
		// 边界事件结束其更新运行（end 取代了 partial；该插槽为相同键的未来运行释放）。
		if (event.type === "message_end") updateSlots.delete("message");
		if (event.type === "tool_execution_end") updateSlots.delete(`tool:${event.toolCallId}`);
		// 严格的每订阅者排序：任何仍在排队的内容都在线路上位于此边界事件之前，绝不在它之后。
		flushPending();
		log.push(event);
		for (const sub of subscribers) sub.push(event);
	};

	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const flushPending = () => {
		if (flushTimer !== undefined) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		if (pending.size === 0) return;
		const batch = [...pending.values()];
		pending.clear();
		for (const sub of subscribers) for (const event of batch) sub.push(event);
	};
	const armFlush = () => {
		if (flushTimer !== undefined) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			flushPending();
		}, updateFlushMs);
		// 绝不为了落后者保持进程（或测试运行器）打开。
		(flushTimer as { unref?: () => void }).unref?.();
	};
	const closeAll = () => {
		if (settled) return;
		// 顺序到最后：最后一个待处理的快照在 [DONE] 之前。
		flushPending();
		settled = true;
		for (const sub of subscribers) sub.done();
		subscribers.clear();
	};
	// 结算接缝：记录写入是代理自己的（OWN）最终状态
	// （原生历史 — 签名、使用量、提供商标记都是真实的）。
	// 复制数组：代理的寿命可能超过此次调用的读取。
	// 0.87.1（转录重构）：代理从 initialState.systemPrompt（提示 + 工具声明）
	// 播种了一个前导的 SystemMessage — 它在每回合被合成，并且绝不能（NEVER）持久化
	// （否则记录会随着工具声明膨胀，并且重放时会看到 messages[0] === system，
	// 从而抑制了每回合的新鲜重新播种）。我们的应用自己不生成任何系统消息
	// （提示在每回合中组合），因此整体丢弃该角色是精确的；如果以后有 prompt-updates 则重新审视。
	const settleWith = () => {
		const settled_ = [...agent.state.messages].filter((m) => (m as { role?: string }).role !== "system");
		onFinish((uniquifier?.remapSettled(settled_) as AgentMessage[]) ?? settled_, sawAbort);
	};

	const handle = (event: AgentEvent) => {
		// THE LACAN FIX：id 在这里（HERE）唯一化，在任何视图之前
		// — 下游每个消费者共享的唯一接缝。没有去重器 → 逐字原样。
		const uniqued = uniquifier ? uniquifier.event(event) : event;
		// 线路瘦身（WIRE DIET）：精简 pi 双重填充的这一个事件
		// — 我们的视图读取 `message`，从不读取 `assistantMessageEvent`
		// （相同的完整内容两次）。
		const wire: TurnWireEvent =
			uniqued.type === "message_update"
				? { type: "message_update", message: uniqued.message }
				: uniqued;
		send(wire);
		if (event.type === "message_end") {
			const m = event.message as { role?: string; stopReason?: string } | undefined;
			if (m?.role === "assistant" && m.stopReason === "aborted") sawAbort = true;
			// Dock 修复（owner 规则 2026-09-26）：注入的操控标记的
			// message_end = 卡片对学习者可见 — 现在（now）就翻转
			// 作业的簿记（该回合可能会继续教学几分钟；
			// settleSteers 将幂等地将该翻转作为无操作重新运行）。
			if (m?.role === "custom") noteSteerVisible(event.message as SteerMessage);
		}
		if (event.type === "agent_end") {
			closeAll();
			settleWith();
		}
	};
	agent.subscribe(handle);

	void (async () => {
		try {
			await agent.continue();
		} catch (err) {
			// 循环级错误（不是提供商错误 — 提供商错误作为 stopReason "error"
			// 乘坐流）：暴露，关闭，持久化。如果代理已经结算（在抛出异常之前
			// 达到了 agent_end），那么接缝已经运行过 — 永远不要结算两次。
			if (settled) return;
			console.error("[turn] agent loop failed:", err);
			send({ type: "error", errorText: onError?.(err) ?? "An error occurred." });
			closeAll();
			settleWith();
		}
	})();

	return {
		subscribe() {
			let sub: PiTurnSubscriber | undefined;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					let closed = false;
					sub = {
						push(event) {
							if (closed) return;
							try {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
							} catch {
								/* 读取器取消 — 停止发射，继续运行 */
								closed = true;
							}
						},
						done() {
							if (closed) return;
							closed = true;
							try {
								controller.enqueue(encoder.encode("data: [DONE]\n\n"));
								controller.close();
							} catch {
								/* 已经取消 */
							}
						},
					};
					// 附加然后重放（Attach THEN replay）— 同步的，因此没有事件
					// 会掉在重放和实时流之间（单线程：代理的 handle() 只有在
					// 此调用栈返回后才运行）。压缩的日志重放结算的事件 +
					// 飞行中的消息的最新快照 — 完整内容，一次，从不重放分块历史记录
					// （COMPACTION LAW）。
					subscribers.add(sub);
					for (const event of log) sub.push(event);
					// 在结算后附加的订阅者（注销竞争）仍会获得完整的历史记录 + [DONE]。
					if (settled) sub.done();
				},
				cancel() {
					// THE OWNER RULING (2026-09-25): 视图离开永远不会（NEVER）
					// 杀死回合 — 只有明确的中止（abort）通道才会。回合继续运行；
					// 压缩日志保留状态供下一个视图使用。
					if (sub) subscribers.delete(sub);
				},
			});
			return stream;
		},
		abort() {
			if (settled) return;
			sawAbort = true;
			agent.abort();
		},
	};
}

/**
 * 订阅者形状的 SSE 响应 — POST /api/chat 响应和 GET /api/chats/[id]/stream
 * 两者（BOTH）都是这个：相同的头部，相同的线路方言，一个供客户端消费的协议。
 *
 * 将某个后台的回合句柄（handle）封装为针对客户端标准 SSE `text/event-stream` 格式的 Response。
 * 这个函数被 POST /api/chat 的初次提交和 GET /api/chats/[id]/stream 的断线重连共用。
 *
 * @param handle 用于订阅的代理后台实例。
 * @returns HTTP 响应流对象。
 */
export function piTurnResponse(handle: PiTurnHandle): Response {
	return new Response(handle.subscribe(), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
