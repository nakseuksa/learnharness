/**
 * 服务器端回合活跃度（turn liveness）：目前哪些聊天有一个飞行中（in-flight）的教师回合。
 * “会话在后台持续运行”缺失的一半 — 连同 chat-handler 中的预写持久化，
 * 返回的客户端可以将“老师在回合中途 — 不要复活，不要启动任何东西”与“记录是最新的”区分开来。
 *
 * 驻留在 globalThis 上，而不是模块级 Map：Next dev 将每个路由编译为自己的入口，
 * 因此在页面渲染、GET /api/chats/[id] 和 POST /api/chat 中，模块级单例是一个
 * 不同的实例 — 页面会读取一个空的注册表，而聊天路由持有实时回合（此前的错误：
 * 在回合中途返回显示了 409 横幅而不是忙碌状态）。globalThis 跨越进程内的模块实例；
 * 它是标准的 Next.js 单例通道（Prisma 客户端驻留在那里的原因相同）。
 *
 * 根据设计仍然是短暂的（ephemeral BY DESIGN）：进程重启会清除它，因此没有需要清理的
 * 过时标志 — 崩溃的回合通过预写记录 + 下次访问时的挂载延续来恢复。
 * TTL 是针对 onFinish 从未触发（它甚至在中止时运行）的病态情况的泄漏防护；
 * 聊天回合最多只需几分钟，因此 30 分钟是非常安全的。
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
 * 将一个回合标记为开始。如果聊天的回合已经在运行则返回 false —
 * 调用者拒绝该请求（只有一个回合可以拥有一个聊天）。
 * 在注册表写入之后（AFTER）宣布 "turn-started"：读取 isTurnRunning
 * 或获取记录的监听器会看到一致的真相。被拒绝的双重开始（409 路径）
 * 保持静默 — 没有回合开始。
 *
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
 * 将聊天的回合标记为完成（在 onFinish 中运行，无论是否中止 —
 * 在 persistTurn 之后（AFTER），因此 "turn-settled" 保证后续的提取读取到持久的真相）。
 * 仅在条目实际存在时发出：防御性的无操作 endTurn 绝不能触发虚假的结算。
 *
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

/**
 * 当聊天的回合在飞行中（in flight）时为真；懒惰地驱逐过时的条目。
 * 驱逐路径故意（DELIBERATELY）没有事件：它是针对 onFinish 从未触发
 * （本身就是病态的）的回合的泄漏防护，它从读取懒惰地运行，并且从读取
 * 发出事件是一种副作用气味。这里的静默是一种选择，而不是疏忽。
 *
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
