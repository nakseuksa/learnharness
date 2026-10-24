/**
 * 暂存的取消动作（PARKED DISMISSALS，owner, 2026-10-04）：
 * 当回合仍在工作时，使用 ESC 丢弃。在回合进行中，存储的记录（STORED record）
 * 不包含挂起的问题或练习（该回合尚未持久化 — 其消息在结算时落盘），因此
 * 现在到达的取消无法验证；旧的行为是硬性返回 409，这导致学习者被一个幽灵问题困住，
 * 直到该回合结束（GLM 练习循环事件：唯一的逃生方式是杀死开发服务器）。
 *
 * 暂存（The park，owner ruling: "server-side park"）：取消路由（dismiss route）
 * 发现实时回合后，暂存该意图并返回 202；该回合的结算路径（chat-handler onFinish，
 * 在 persistTurn 之后，在 endTurn 之前 — 相同的顺序法则，使得 turn-settled 意味着持久的真相）
 * 针对新持久化的记录应用它。验证在应用时（APPLY time）针对真实状态运行：如果被取消的
 * 问题/练习确实挂起在那里，则取消就像路由本会写入的那样落地；如果它从未具体化（调用出错，
 * 模型重新提出并回答），则静默丢弃该暂存 — 用户取消的东西不再存在。
 *
 * 驻留在 globalThis 上，而不是模块级 Map — 与 turn-liveness 相同的 Next.js
 * 模块实例规则：取消路由和 chat-handler 入口必须看到相同的注册表，否则暂存
 * 会写入一个世界而在另一个世界中读取。设计为短暂的（Ephemeral）；每个聊天
 * 只有一个暂存的取消动作（最后一次写入获胜 — 只有一个 dock，一次丢弃）。
 */

import { ChatInputError, dismissAppends, emit } from "../core";
import type { ChatStore } from "../core/ports.ts";

/**
 * 暂存的取消请求体 — 与 dismiss 路由接受的解析输入完全相同
 * （{type:"dismiss", toolCallId, answer} 或
 * {type:"dismiss-problem", problemCallId}）。
 */
export type ParkedDismissal = unknown;

interface LhGlobal {
	__lhParkedDismissals?: Map<string, ParkedDismissal>;
}

function registry(): Map<string, ParkedDismissal> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhParkedDismissals ??= new Map<string, ParkedDismissal>());
}

/**
 * 暂存（或覆盖）聊天的取消意图。当某个回合拥有该聊天时，由取消路由调用。
 *
 * 暂存（或覆盖）指定会话的取消（dismissal）意图。
 * 当 `dismiss` 路由发现对话正在运行时，它会调用此函数将会话的取消动作暂存。
 *
 * @param chatId 会话的唯一标识符。
 * @param input 暂存的取消动作负载（包含要被取消的 ID 和数据）。
 */
export function parkDismissal(chatId: string, input: ParkedDismissal): void {
	registry().set(chatId, input);
}

/**
 * 取走聊天的暂存取消意图（并将其删除）。当没有内容被暂存时返回 null。
 *
 * 获取并移除指定会话暂存的取消意图。
 * 如果没有暂存的意图，则返回 null。
 *
 * @param chatId 会话的唯一标识符。
 * @returns 暂存的取消负载数据，或者 null。
 */
export function takeParkedDismissal(chatId: string): ParkedDismissal | null {
	const parked = registry().get(chatId);
	if (parked === undefined) return null;
	registry().delete(chatId);
	return parked;
}

/**
 * 如果存在暂存的取消意图，则将其应用于当前记录。
 * 在回合的 onFinish 中运行 — 位于 persistTurn 和 endTurn 之间，因此
 * 响应 "turn-settled" 的客户端会读取到已经存在于记录中的取消。
 * 追加路径是路由自身的（dismissAppends）；ChatInputError 表示被取消的
 * 东西从未具体化 — 暂存被丢弃，保持静默是正确的结果。完全在有内容写入时触发 "record-changed"。
 *
 * 将指定会话中暂存的取消意图应用到当前会话的持久化记录中。
 * 这个函数在会话回合完成阶段（onFinish）被调用——在回合结果保存（persistTurn）之后、结束标记（endTurn）之前。
 * 如果在验证时抛出 `ChatInputError`，说明暂存的取消目标从未存在，静默丢弃即可。
 *
 * @param chatStore 负责读写聊天记录的存储模块。
 * @param chatId 会话的唯一标识符。
 */
export function applyParkedDismissal(chatStore: ChatStore, chatId: string): void {
	const input = takeParkedDismissal(chatId);
	if (input === null) return;
	const record = chatStore.getChat(chatId);
	if (!record) return;
	try {
		const appends = dismissAppends(record, input as Parameters<typeof dismissAppends>[1]);
		chatStore.saveMessages(chatId, [...record.messages, ...appends]);
		emit("record-changed", { chatId });
	} catch (err) {
		if (err instanceof ChatInputError) return; // never materialized — drop
		throw err;
	}
}
