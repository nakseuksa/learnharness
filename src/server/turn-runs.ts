/**
 * The running-turn registry (background-turn runner wave, owner ruling
 * 2026-09-25): chatId → the live PiTurnHandle. THE reattach surface —
 * GET /api/chats/[id]/stream resolves here, and the remote abort
 * (/api/activity/abort, kind "turn") kills through here.
 *
 * Same globalThis discipline as turn-liveness.ts (read its header): Next
 * dev compiles each route as its own module instance, so a module-level
 * Map would be a DIFFERENT registry in the POST /api/chat entry and the
 * GET .../stream entry. globalThis spans module instances within the
 * process.
 *
 * Registration lifecycle: chat-handler registers the handle the moment
 * the turn starts (after the 409 guard) and its onFinish unregisters LAST
 * — after persist, usage, extraction, and endTurn — so anything that sees
 * "no running turn" also sees an already-persisted record. The per-chat
 * 409 guard means a chatId can hold at most one handle, and beginTurn's
 * 30-minute TTL bounds the pathological never-settling case the same way
 * it does for the liveness map: if onFinish never fires, the stale entry
 * is overwritten by the next turn's registration (Map.set) and garbage
 * collected — no unbounded leak beyond the same pathology turn-liveness
 * already accepts.
 *
 * App-quit mid-turn (the process dying with an un-persisted turn) is the
 * SAME residual as before the wave: the registry is memory-only, the
 * write-ahead record + liveness TTL recovery cover the next mount.
 */

import type { PiTurnHandle } from "./pi/ui-stream.ts";

interface LhTurnRunsGlobal {
	__lhTurnRuns?: Map<string, PiTurnHandle>;
}

function runs(): Map<string, PiTurnHandle> {
	const g = globalThis as typeof globalThis & LhTurnRunsGlobal;
	return (g.__lhTurnRuns ??= new Map<string, PiTurnHandle>());
}

/** Register the chat's running turn (chat-handler, right after the turn
 *  starts). One per chat by construction — the 409 guard. */
/**
 * 注册一个正在运行的后台回合句柄。
 * 该函数在 `chat-handler` 开始生成后台运行对象后立即调用。
 * 由于 409 门控机制的保证，每个会话最多只能有一个正在运行的回合。
 * @param chatId 会话的唯一标识符。
 * @param handle 用于控制和订阅该后台回合的 PiTurnHandle 句柄。
 */
export function registerTurn(chatId: string, handle: PiTurnHandle): void {
	runs().set(chatId, handle);
}

/** Unregister at settle — chat-handler's onFinish, LAST (after endTurn). */
/**
 * 注销一个回合句柄。
 * 该函数在 `chat-handler` 的 onFinish 阶段最后一步调用（在 persist、端点释放之后），
 * 以确保如果在其它地方检测到没有运行中的句柄，他们读取到的一定是已经持久化存储完最新状态的数据。
 * @param chatId 会话的唯一标识符。
 */
export function unregisterTurn(chatId: string): void {
	runs().delete(chatId);
}

/** The live turn handle for a chat, or undefined — the subscribe endpoint's
 *  and the abort channel's resolution point. */
/**
 * 获取指定会话当前活跃的回合句柄。
 * 供重新连接的流式端点（GET `/api/chats/[id]/stream`）或者远端中断操作（`abortTurn`）获取上下文对象。
 * @param chatId 会话的唯一标识符。
 * @returns 相应的回合句柄，若不存在则为 undefined。
 */
export function runningTurn(chatId: string): PiTurnHandle | undefined {
	return runs().get(chatId);
}

/** The remote kill: any client (original sender, reattached viewer, future
 *  surfaces) may stop a running turn. not_running mirrors abortJob's
 *  honest 409 — there was nothing to abort, the caller refetches. */
/**
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

/** The cheap terminal when GET /api/chats/[id]/stream finds no running
 *  turn (raced settle, or the client checked turnInFlight a beat too
 *  late): a same-dialect SSE response whose single chunk tells the client
 *  "nothing to attach to — the record is current, refetch it". Chosen as
 *  an EVENT (not a status code) so the reattach path consumes ONE wire
 *  protocol end to end. */
/**
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
