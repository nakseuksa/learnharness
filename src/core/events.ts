/**
 * 事件总线 (THE EVENT BUS) (属于推送架构的第一部分，基于所有者在 2026-10-02 的决策：
 * 直接采用最终方案 — "通知(notify) → 获取(fetch)" 模式，抛弃长轮询)。
 *
 * 这是一个贯穿所有层的单一事件总线：服务器在这里发出轮次(turn)的生命周期事件，
 * 存储适配器发出任务(job)和聊天(chat)的变更事件，代理层的后台注册表(如提取过程)
 * 发出活动状态的改变 — 而 GET /api/events 路由将把每次触发转化为服务器发送事件 (SSE)
 * 帧传递给任何打开的浏览器窗口。事件负载仅包含“有事情发生”这个事实 (FACT)，绝不携带具体数据：
 * 消费端在收到通知后会自行获取最新真实数据 (推送触发信号，拉取实际数据)。
 * 因此负载非常小，无结构要求且具有幂等性 — 重连后只需重新拉取一次数据即可自愈。
 *
 * 为什么使用 globalThis (参照 turn-liveness 的原则，理由相同)：
 * Next.js 的开发模式将每个路由编译为一个独立的模块入口，所以如果只用模块级别的单例，
 * 页面渲染、事件路由以及每个触发器的入口处拿到的将会是完全不同(DIFFERENT)的实例 —
 * 它们各自持有私有的监听器集合，导致事件根本无法传播。`globalThis` 可以跨越同一进程内的
 * 不同模块实例；这是 Next.js 推荐的标准单例通道 (查阅 src/server/turn-liveness.ts 获取原始事故记录)。
 *
 * 根据系统法则，这里是纯核心 (Pure core) 模块：不依赖 React、无 IO 操作、无外部导入 —
 * 这是唯一一个让服务器 (server)、存储 (store) 和代理 (agent) 可以共同依赖的共享层。
 */

/** 完整的事件词汇表 — 从制定日 (2026-10-02 计划) 起就固定了事件类型的定义。 */
export interface ServerEvents {
	/** 一次教学轮次在服务端开始了 (beginTurn) — 无论是由客户端发起的发送操作、
	 *  唤醒轮次，还是其他标签页触发的轮次：所有来源都触发同一个事件。 */
	"turn-started": { chatId: string };
	/** 轮次已稳定结束 (endTurn — 它发生在 persistTurn 之后，因此由这个事件触发的任何
	 *  数据拉取操作都能读到已被持久化的记录；该顺序在 chat-handler 的 onFinish 中得到保证)。 */
	"turn-settled": { chatId: string };
	/** 任务(job)记录发生了变更 (派发、进度更新、完成、中止、恢复等)。
	 *  当关联的聊天 ID 已知时会包含 chatId — 负责显示某一个聊天的消费者可通过它进行过滤。 */
	"jobs-changed": { chatId?: string };
	/** 提取(extraction)运行阶段发生改变 (驱动 activity dock 动态更新)。 */
	"activity-changed": Record<string, never>;
	/** 会话列表发生改变 (创建、删除、修改标题)。 */
	"chats-changed": Record<string, never>;
	/** 聊天记录发生了变更，但并未产生新的轮次对话 (例如后台静默更新了免打扰/忽略标记)。
	 *  这与 turn 事件遵循同样的“通知-然后-获取”契约：该聊天窗口当前处于打开状态的视图
	 *  将会重新拉取数据，并采用这份已持久化的记录。 */
	"record-changed": { chatId: string };
	/** 针对该聊天的压缩操作(compaction)已开始或结束 (所有者第 14 轮审查，2026-10-05)。
	 *  running=true 状态充当了发送门控 (SEND GATE)：当压缩操作正在飞行(执行)中时，
	 *  服务端会在结构上拒绝针对该聊天的所有模型交互请求；客户端同样也会通过禁用
	 *  输入框(composer)及状态坞的提交按钮来镜像这一行为。 */
	"compaction-changed": { chatId: string; running: boolean };
}

/** 服务器事件的类型 (键名集合) */
export type ServerEventType = keyof ServerEvents;

/**
 * 事件词汇表在运行时的字符串数组名称 — 客户端为这里的每一个名称注册一个监听器
 * (由于 TypeScript 的类型在运行时会被擦除，这个列表成为了 SSE 通道能承载哪些事件的唯一真相源)。
 */
export const SERVER_EVENT_TYPES = [
	"turn-started",
	"turn-settled",
	"jobs-changed",
	"activity-changed",
	"chats-changed",
	"record-changed",
	"compaction-changed",
] as const satisfies readonly ServerEventType[];

/** 单条通知数据结构：通过 type 字段来进行有效载荷 (payload) 的类型鉴别。 */
export type ServerEvent<K extends ServerEventType = ServerEventType> = {
	type: K;
} & ServerEvents[K];

/** 服务器事件监听器的回调函数签名 */
export type ServerEventListener = (event: ServerEvent) => void;

interface LhEventsGlobal {
	__lhEventBus?: Set<ServerEventListener>;
}

/**
 * 共享的监听器集合 — 由 globalThis 提供支持，从而使得所有的 Next.js 模块入口
 * （以及系统架构的每一层）都看到并共享“这同一个”事件总线。
 * 在设计上它是易失性的（Ephemeral）：进程重启会丢弃所有现存监听器及其连接；触发器(emitter)永远不会去排队缓存事件。
 */
function listeners(): Set<ServerEventListener> {
	const g = globalThis as typeof globalThis & LhEventsGlobal;
	return (g.__lhEventBus ??= new Set());
}

/**
 * 订阅(监听)事件。返回一个取消订阅的函数 — SSE 路由断开时以及所有
 * 测试清理代码都会调用此函数；被妥善清理的监听器不会导致任何内存泄漏。
 * @param listener 事件触发时的回调函数
 * @returns 取消订阅的清理函数
 */
export function subscribe(listener: ServerEventListener): () => void {
	const set = listeners();
	set.add(listener);
	return () => set.delete(listener);
}

/**
 * 通知每一个监听器。如果没有订阅者，那么这就是一个空操作（说明没有打开任何浏览器窗口 —
 * 这类事件发射往往只是为了存储层自身的记账/更新需求）。
 * 如果某个监听器抛出异常，绝不应该破坏其他监听器的执行，也不应导致触发器崩溃：
 * 每次调用都是隔离处理的，发生错误会被记录到日志中，然后循环继续向下执行。
 *
 * @param type 要发出的事件类型
 * @param payload 事件对应的有效载荷数据
 */
export function emit<K extends ServerEventType>(type: K, payload: ServerEvents[K]): void {
	// Snapshot: a listener that unsubscribes (or subscribes) mid-emit must
	// not mutate the set under iteration.
	for (const listener of [...listeners()]) {
		try {
			listener({ type, ...payload } as ServerEvent);
		} catch (err) {
			console.error(`[events] listener failed on ${type}:`, err);
		}
	}
}
