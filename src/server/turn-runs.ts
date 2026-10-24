/**
 * 运行中回合的注册表（background-turn runner wave, owner ruling 2026-09-25）：
 * chatId → 实时 PiTurnHandle。重新附加表面（THE reattach surface） —
 * GET /api/chats/[id]/stream 在这里解析，远程中止（/api/activity/abort, kind "turn"）也通过这里杀死。
 *
 * 与 turn-liveness.ts 相同的 globalThis 规则（阅读其头部注释）：Next dev
 * 将每个路由编译为自己的模块实例，因此模块级 Map 在 POST /api/chat 入口和
 * GET .../stream 入口中将是不同的（DIFFERENT）注册表。globalThis 跨越进程内的模块实例。
 *
 * 注册生命周期：chat-handler 在回合开始的那一刻（在 409 门控之后）注册句柄，
 * 其 onFinish 在最后（LAST）注销 — 在持久化、使用量记录、提取和 endTurn 之后
 * — 因此任何看到“没有运行中的回合”的东西也会看到一个已经持久化的记录。
 * 每个聊天的 409 门控意味着一个 chatId 最多只能持有一个句柄，
 * 并且 beginTurn 的 30 分钟 TTL 以与活跃度映射相同的方式限制了病态的永远不结算的情况：
 * 如果 onFinish 从未触发，则过时的条目将被下一个回合的注册（Map.set）覆盖并
 * 被垃圾回收 — 除了 turn-liveness 已经接受的相同病态之外，没有无边界的泄漏。
 *
 * 回合中途退出应用（进程在未持久化回合的情况下死亡）与该 wave 之前的残留相同（SAME）：
 * 注册表仅在内存中，预写记录 + 活跃度 TTL 恢复覆盖了下一次挂载。
 */

import type { PiTurnHandle } from "./pi/ui-stream.ts";

interface LhTurnRunsGlobal {
	__lhTurnRuns?: Map<string, PiTurnHandle>;
}

function runs(): Map<string, PiTurnHandle> {
	const g = globalThis as typeof globalThis & LhTurnRunsGlobal;
	return (g.__lhTurnRuns ??= new Map<string, PiTurnHandle>());
}

/**
 * 注册聊天的运行中回合（chat-handler，就在回合开始之后）。
 * 根据构造每个聊天一个 — 409 门控。
 *
 * 注册一个正在运行的后台回合句柄。
 * 该函数在 `chat-handler` 开始生成后台运行对象后立即调用。
 * 由于 409 门控机制的保证，每个会话最多只能有一个正在运行的回合。
 * @param chatId 会话的唯一标识符。
 * @param handle 用于控制和订阅该后台回合的 PiTurnHandle 句柄。
 */
export function registerTurn(chatId: string, handle: PiTurnHandle): void {
	runs().set(chatId, handle);
}

/**
 * 在结算时注销 — chat-handler 的 onFinish，最后一步（LAST，在 endTurn 之后）。
 *
 * 注销一个回合句柄。
 * 该函数在 `chat-handler` 的 onFinish 阶段最后一步调用（在 persist、端点释放之后），
 * 以确保如果在其它地方检测到没有运行中的句柄，他们读取到的一定是已经持久化存储完最新状态的数据。
 * @param chatId 会话的唯一标识符。
 */
export function unregisterTurn(chatId: string): void {
	runs().delete(chatId);
}

/**
 * 聊天的实时回合句柄，或为 undefined — 订阅端点和中止通道的解析点。
 *
 * 获取指定会话当前活跃的回合句柄。
 * 供重新连接的流式端点（GET `/api/chats/[id]/stream`）或者远端中断操作（`abortTurn`）获取上下文对象。
 * @param chatId 会话的唯一标识符。
 * @returns 相应的回合句柄，若不存在则为 undefined。
 */
export function runningTurn(chatId: string): PiTurnHandle | undefined {
	return runs().get(chatId);
}

/**
 * 远程杀死：任何客户端（原始发送者、重新附加的查看器、未来的表面）都可以
 * 停止运行中的回合。not_running 镜像了 abortJob 的诚实 409
 * — 没有什么可中止的，调用者重新获取。
 *
 * 远程中断一个正在运行的后台回合。
 * 允许任何客户端（无论是初始请求的发送者还是后来重新附加的视图）发起终止。
 * 如果发现并没有任务在运行，则会诚实地返回未运行的错误以提醒客户端刷新数据。
 * @param chatId 会话的唯一标识符。
 * @returns 成功或失败带有理由的对象。
 */
export function abortTurn(chatId: string): { ok: true } | { ok: false; reason: "not_running" } {
	const handle = runs().get(chatId);
	if (!handle) return { ok: false, reason: "not_running" };
	handle.abort();
	return { ok: true };
}

/**
 * 当 GET /api/chats/[id]/stream 找不到运行中的回合时的廉价终端
 * （竞争了结算，或者客户端检查 turnInFlight 晚了一拍）：
 * 一个相同方言的 SSE 响应，其单个块告诉客户端
 * “没有什么可附加的 — 记录是最新的，重新获取它”。
 * 选择作为事件（EVENT，而不是状态码），以便重新附加路径端到端使用同一种线路协议。
 *
 * 构造一个已结算状态的 SSE 空响应。
 * 当客户端请求附加到一个活跃对话（GET `/api/chats/[id]/stream`），
 * 却发现该对话已经不存在活跃的回合时，通过返回这个包含 `turn-settled` 和 `[DONE]` 的假流响应，
 * 使得客户端端侧的一致性解析逻辑能统一处理，通过这种一帧事件直接告诉客户端“该记录已经是最新的，去重新抓取吧”。
 * @returns 代表空对话流事件的 HTTP Response。
 */
export function settledTurnResponse(): Response {
	return new Response('data: {"type":"turn-settled"}\n\ndata: [DONE]\n\n', {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
