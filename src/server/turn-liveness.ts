/**
 * Server-side turn liveness: which chats currently have a teacher turn in
 * flight. The missing half of "sessions keep running in the background" —
 * together with the write-ahead persist in chat-handler, a returning client
 * can tell "the teacher is mid-turn — don't resurrect, don't start anything"
 * apart from "the record IS current".
 *
 * Lives on globalThis, NOT a module-level Map: Next dev compiles each route
 * as its own entry, so a module-level singleton is a DIFFERENT instance in
 * the page render, GET /api/chats/[id], and POST /api/chat — the page would
 * read an empty registry while the chat route holds the live turn (the bug:
 * returning mid-turn showed the 409 banner instead of the busy state).
 * globalThis spans module instances within the process; it is the standard
 * Next.js singleton channel (same reason Prisma clients live there).
 *
 * Still ephemeral BY DESIGN: a process restart clears it, so there are no
 * stale flags to clean up — a crashed turn recovers via the write-ahead
 * record + mount continuation on the next visit. The TTL is a leak guard for
 * the pathological case where onFinish never fires (it runs even on aborts);
 * chat turns are minutes at most, so 30 minutes is far on the safe side.
 */

import { emit } from "../core/events.ts";

interface LhGlobal {
	__lhTurnRegistry?: Map<string, number>;
}

function registry(): Map<string, number> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhTurnRegistry ??= new Map<string, number>());
}

const inFlight = registry();
const MAX_TURN_MS = 30 * 60_000;

/**
 * Mark a turn as starting. Returns false if one is already running for the
 * chat — the caller rejects the request (only one turn may own a chat).
 * Announces "turn-started" AFTER the registry write: a listener that reads
 * isTurnRunning or fetches the record sees consistent truth. The rejected
 * double-begin (the 409 path) stays silent — no turn began.
 */
/**
 * 标记某个会话的对话回合正在开始。
 * 如果该会话已经有一个正在运行的回合，则直接返回 false（通常导致调用方返回 409，即“只有一个回合可以占有会话”）。
 * 在成功标记为进行中之后会广播 `turn-started` 事件，以便通知其他模块或客户端状态已更新。
 *
 * @param chatId 会话 ID。
 * @returns 成功标记开始时返回 true；已有回合运行时返回 false。
 */
export function beginTurn(chatId: string): boolean {
	if (isTurnRunning(chatId)) return false;
	inFlight.set(chatId, Date.now());
	emit("turn-started", { chatId });
	return true;
}

/**
 * Mark the chat's turn as finished (runs in onFinish, aborted or not —
 * AFTER persistTurn, so "turn-settled" guarantees a subsequent fetch reads
 * durable truth). Emits only when an entry was actually present: a
 * defensive no-op endTurn must not fire a spurious settle.
 */
/**
 * 标记某个会话的对话回合已经结束。
 * (无论任务是成功还是终止，都会在 onFinish 中被调用，并且在 persistTurn 保存数据之后调用。这样，
 * 触发 `turn-settled` 时客户端读取到的会话数据一定是最新的)。
 * 仅在真的删除了一个注册项时才触发事件广播。
 *
 * @param chatId 会话 ID。
 */
export function endTurn(chatId: string): void {
	if (inFlight.delete(chatId)) emit("turn-settled", { chatId });
}

/** True while the chat's turn is in flight; lazily evicts stale entries.
 * The eviction path is DELIBERATELY event-free: it is a leak guard for a
 * turn whose onFinish never fired (itself pathological), it runs lazily
 * from a read, and emitting from a read is a side-effect smell. Silence
 * here is a choice, not an oversight. */
/**
 * 检查当前会话的后台回合是否在运行。
 * 当读取到超时的无效过期项时，会使用懒惰方式（Lazy eviction）自动清理，但刻意不触发任何事件通知。
 * （因为超时通常代表发生过意外的死锁崩溃。在只读操作中避免引入隐式副作能够提高系统的可靠性）。
 *
 * @param chatId 会话 ID。
 * @returns 是否有未超时的活跃回合。
 */
export function isTurnRunning(chatId: string): boolean {
	const since = inFlight.get(chatId);
	if (since === undefined) return false;
	if (Date.now() - since > MAX_TURN_MS) {
		inFlight.delete(chatId);
		return false;
	}
	return true;
}
