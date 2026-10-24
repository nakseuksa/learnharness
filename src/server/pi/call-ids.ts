import type { AgentEvent } from "@earendil-works/pi-agent-core";

/**
 * 工具调用 ID 唯一化（TOOL-CALL ID UNIQUIFICATION，owner 批准的修复，2026-10-04 — Lacan 事件）：
 * 一些提供商（通过 OpenRouter 的 DeepSeek，实时观察到）返回的工具调用 id
 * 在每次响应时都会重置 — `call_0`, `call_1`, … — 因此一个每回合一次调用的
 * 会话将每个（EVERY）调用都命名为 `call_0`。此应用中的所有内容都以
 * toolCallId 为键（视图折叠的 call↔result 连接、挂起问题门控、答案路由、
 * 选项洗牌种子），因此跨回合的重复项同时破坏了所有这些：折叠将测验答案
 * 应用于 ASK 卡片，询问问题消失，顺序混乱。
 *
 * 法则（THE LAW）：id 在线路边界处唯一化一次（ONCE） — 此类位于
 * runPiTurn 内部，在任何视图之前看到每个 AgentEvent，并在结算时应用
 * 相同的铸造。客户端、持久化记录、dock、答案流以及下一个回合的提供商
 * 上下文（从记录重建）都正好看到一组唯一的 id。提供商上下文在内部
 * 保持配对（call 和 result 一起重写），OpenAI 兼容的 API 接受这一点 —
 * pi 本身会为不返回任何 id 的提供商合成 id，因此任意但配对的 id
 * 在协议上已经是合法的。历史记录从不（NEVER）被重写：记录消息原样通过，
 * 修复前重复的记录在折叠处愈合（view.ts 将结果从最新开始配对）。
 *
 * 方案（SCHEME）：一个每个聊天的 seen-set（在回合开始时从记录中播种）
 * 加上每个消息的表。流式消息不携带（NO）id（id 在持久化时打上标记），
 * 因此表按对象身份（OBJECT IDENTITY）键入 — message_end 事件的对象与
 * agent.state.messages 中的对象引用相同（已针对 pi-agent-core 验证），
 * 并且一个 WeakMap 将两者连接起来。在每个助手 message_start 时打开一个
 * 新的表（epoch）；该消息的 update/end 对象附加到它上面；每次消息
 * 声明一次铸造，因此回合的第二条消息（重试步骤）中的相同 id 会获得
 * 自己专属的铸造。碰撞的 id 变为 `${orig}~2`, `~3`, … 跳过已使用的。
 */

/** 在结构上遍历任何消息的内容以查找工具调用块。 */
function callBlocks(message: unknown): Array<{ id: string } & Record<string, unknown>> {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter(
		(b): b is { id: string } & Record<string, unknown> =>
			(b as { type?: string } | null)?.type === "toolCall" && typeof (b as { id?: unknown }).id === "string",
	);
}

/**
 * 每个消费者可能已经看到的 id：消息列表中的所有调用 id 和结果 id
 * （聊天记录 — 包括其旧的重复项，这就是重点：成员资格是驱动铸造的因素）。
 *
 * 遍历给定的对话记录列表，收集已出现的所有工具调用 ID (Tool Call IDs)。
 * 这是为了在去重器初始化时，将其置入 seen 集合，从而保证历史记录不会与当前生成回合的重复 ID 发生冲突。
 *
 * @param messages 历史对话消息列表。
 * @returns 所有已使用的 tool-call IDs。
 */
export function collectToolCallIds(messages: readonly unknown[]): string[] {
	const ids: string[] = [];
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "assistant") {
			for (const b of callBlocks(m)) ids.push(b.id);
		} else if (role === "toolResult") {
			const id = (m as { toolCallId?: unknown }).toolCallId;
			if (typeof id === "string") ids.push(id);
		}
	}
	return ids;
}

/**
 * 工具调用 ID 去重器（The Lacan Fix 修复方案）。
 * 由于一些模型提供商（如通过 OpenRouter 调用的 DeepSeek）每回合返回的 tool-call ids 会从 "call_0" 重新开始，
 * 该类负责拦截所有的代理流事件并在系统边界赋予全局唯一的标识。
 * 它确保：历史遗留不修改，同一响应批次中的 call 与 result 结对更新，避免发生键碰撞破坏应用内部的逻辑联结。
 */
export class ToolCallIdUniquifier {
	private readonly seen = new Set<string>();
	/**
	 * 助手消息对象 → 它的 (origId → uniqueId) 表。弱引用（Weak）：
	 * 代理的回合在结算时死亡；这里没有任何东西比它活得长。
	 */
	private readonly tables = new WeakMap<object, Map<string, string>>();
	/**
	 * 当前助手消息的表 — 在其 message_start 处打开，由其 update/end 对象共享，
	 * 并且是其 tool_execution 事件（在 message_end 之后但在下一个
	 * message_start 之前触发）的解析范围。
	 */
	private epoch: Map<string, string> | null = null;

	constructor(usedIds: Iterable<string>) {
		for (const id of usedIds) this.seen.add(id);
	}

	/** 如果从未使用过则保留 `orig`；否则铸造一个未使用的 `${orig}~n`。 */
	private claim(orig: string): string {
		if (!this.seen.has(orig)) {
			this.seen.add(orig);
			return orig;
		}
		for (let n = 2; ; n++) {
			const candidate = `${orig}~${n}`;
			if (!this.seen.has(candidate)) {
				this.seen.add(candidate);
				return candidate;
			}
		}
	}

	/**
	 * 注册 + 重写一条消息的工具调用块（在 message_update 的重复片段中是幂等的）。
	 * 当任何 id 改变时返回克隆的消息，否则返回原始对象。
	 */
	private remapMessageContent(message: unknown): unknown {
		if ((message as { role?: string }).role !== "assistant") return message;
		const blocks = callBlocks(message);
		if (blocks.length === 0) return message;

		// 附加到当前的 epoch，除非该对象已经有一个表（重新发出的 update/end）。
		// 没有打开的 epoch 的消息事件（防御性：跳过 message_start 的流）会打开一个。
		let table = this.tables.get(message as object);
		if (!table) {
			table = this.epoch ?? new Map();
			this.epoch = table;
			this.tables.set(message as object, table);
		} else {
			this.epoch = table;
		}

		let changed = false;
		const content = (message as { content: unknown[] }).content.map((block) => {
			if ((block as { type?: string }).type !== "toolCall") return block;
			const orig = (block as { id?: unknown }).id;
			if (typeof orig !== "string") return block;
			let mapped = table!.get(orig);
			if (mapped === undefined) {
				mapped = this.claim(orig);
				table!.set(orig, mapped);
			}
			if (mapped === orig) return block;
			changed = true;
			return { ...(block as object), id: mapped };
		});
		return changed ? { ...(message as object), content } : message;
	}

	/**
	 * 每个 AgentEvent，id 都被唯一化。结构性的和总体的：
	 * 未知的事件形状原封不动地通过。
	 */
	event(event: AgentEvent): AgentEvent {
		switch (event.type) {
			case "message_start": {
				const e = event as { message: { role?: string } };
				// 新的助手消息会开启一个新的 epoch — 这可以防止以后（LATER）
				// 消息中重试的 id 重用早期消息的铸造。
				if (e.message?.role === "assistant") this.epoch = new Map();
				return this.remapEventMessage(event);
			}
			case "message_update":
			case "message_end":
				return this.remapEventMessage(event);
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end": {
				const { toolCallId } = event as { toolCallId: string };
				const mapped = this.epoch?.get(toolCallId) ?? toolCallId;
				if (mapped === toolCallId) return event;
				return { ...(event as object), toolCallId: mapped } as AgentEvent;
			}
			case "turn_end": {
				const e = event as { message: unknown; toolResults: Array<{ toolCallId?: string }> };
				const message = this.remapMessageContent(e.message);
				const table = this.epoch;
				const toolResults = table
					? e.toolResults.map((r) =>
							typeof r.toolCallId === "string" && table.has(r.toolCallId)
								? { ...r, toolCallId: table.get(r.toolCallId)! }
								: r,
						)
					: e.toolResults;
				return { ...(e as object), message, toolResults } as unknown as AgentEvent;
			}
			case "agent_end": {
				const e = event as { messages: unknown[] };
				return { ...(e as object), messages: this.remapSettled(e.messages) } as unknown as AgentEvent;
			}
			default:
				return event;
		}
	}

	private remapEventMessage(event: AgentEvent): AgentEvent {
		const e = event as { message: unknown };
		const remapped = this.remapMessageContent(e.message);
		if (remapped === e.message) return event;
		return { ...(event as object), message: remapped } as AgentEvent;
	}

	/**
	 * 结算接缝（settle seam）：代理的最终状态，重写为线路已经显示的 id。
	 * 只有这（THIS）个回合的消息才会被重写（那些由其事件对象注册的消息）；
	 * 前一回合的历史 — 包括旧的重复 id 记录 — 逐字通过。工具结果
	 * 与最近注册的助手消息配对（循环自身的结构：结果紧随其调用之后）。
	 */
	remapSettled(messages: readonly unknown[]): unknown[] {
		let scope: Map<string, string> | undefined;
		return messages.map((m) => {
			const role = (m as { role?: string }).role;
			if (role === "assistant") {
				const table = this.tables.get(m as object);
				if (!table) {
					// 前一回合或未注册的：历史从不被重写。
					scope = undefined;
					return m;
				}
				scope = table;
				return this.remapMessageContent(m);
			}
			if (role === "toolResult") {
				const orig = (m as { toolCallId?: unknown }).toolCallId;
				if (scope && typeof orig === "string" && scope.has(orig)) {
					return { ...(m as object), toolCallId: scope.get(orig)! };
				}
				return m;
			}
			return m;
		});
	}
}
