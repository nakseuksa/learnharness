/**
 * 通知通道（THE NOTIFICATION CHANNEL，推送架构切片 1）：GET /api/events 是
 * 基于核心事件总线的 SSE 响应 — 每个打开的窗口一个连接，保持打开直到视图消失，
 * 由每个发射器（回合生命周期、作业/聊天存储、提取注册表）馈送。
 *
 * 通知 → 抓取（NOTIFY → FETCH，架构的全部技巧）：帧只携带事件类型 + 微小的负载；
 * 消费者通过抓取真实数据（/api/chats/:id，/api/jobs，/api/activity）来响应。没有负载版本控制，
 * 没有重播协议 — 重新连接通过每个消费者的一次普通抓取来重新同步。这是一个与 localhost
 * 对话的桌面（DESKTOP）应用程序：保持 N≈1-3 个连接需要每个套接字对的成本，空闲时零流量
 * （owner ruling 2026-10-02 — 轮询的云经济学在环回地址不存在；它留下的轮询网格被此替代）。
 *
 * 线路方言（Wire dialect）反映了回合流（pi/ui-stream.ts）：text/event-stream，
 * no-cache/no-transform，X-Accel-Buffering off — 加上每 25 秒一个 `: ping` 注释，
 * 以防止任何中间件使套接字空闲（在本地是不必要的，无害的，并且它使得死连接检测变得廉价）。
 *
 * 与回合流的不同之处在于生命周期：回合流在结算（[DONE]）时结束；此通道在客户端消失时结束
 * — cancel() 是唯一的终点，并且它必须保持总线不受其他窗口的影响。
 * 闭包形状（在 start 中分配的拆卸函数，在 cancel 中调用）是 ui-stream subscribe() 模式。
 */
import { subscribe, type ServerEvent } from "../core/events.ts";

/**
 * 一个窗口的订阅，作为一个 SSE 响应。
 *
 * 建立并返回针对当前窗口/标签页的 SSE（Server-Sent Events）响应流。
 * - 该响应流通过核心事件总线订阅后端发生的各类事件，并将事件转换为标准的 SSE 格式（`event: \n data: \n\n`）推送到客户端。
 * - 使用 25 秒的定期心跳（`: ping`）保持连接存活。
 * - 当客户端断开（`cancel` 被调用）时，自动清理事件订阅和心跳定时器。
 *
 * @returns 包含持续推送事件流的 HTTP Response 对象。
 */
export function eventsResponse(): Response {
	const encoder = new TextEncoder();
	let teardown: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			let unsubscribe: (() => void) | undefined;

			const stop = () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				if (heartbeat) clearInterval(heartbeat);
			};
			// Enqueue is the ONLY place the socket can reject us (the reader
			// died) — any failure routes through stop() so the listener and
			// the heartbeat never outlive the connection.
			const frame = (chunk: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					stop();
				}
			};

			// Attach FIRST, synchronously: no event can fall between
			// construction and subscription (single-threaded — the same
			// attach-then-replay law as ui-stream's subscribe()).
			unsubscribe = subscribe((event: ServerEvent) => {
				const { type, ...payload } = event;
				frame(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
			});
			heartbeat = setInterval(() => frame(": ping\n\n"), 25_000);

			teardown = stop;
		},
		cancel() {
			// The view went away: drop the listener + timer. The bus keeps
			// serving every other window untouched.
			teardown?.();
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
