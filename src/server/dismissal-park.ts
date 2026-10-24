/**
 * PARKED DISMISSALS (owner, 2026-10-04): ESC-discard while the turn is
 * still working. Mid-turn the STORED record holds no pending question or
 * problem (the turn hasn't persisted — its messages land at settle), so a
 * dismissal arriving now CANNOT validate; the old behavior was a hard 409,
 * which left the learner trapped with a phantom question until the turn
 * died (the GLM practice-loop incident: the only escape was killing the
 * dev server).
 *
 * The park (owner ruling: "server-side park"): the dismiss route, finding
 * a live turn, parks the intent and answers 202; the turn's settle path
 * (chat-handler onFinish, AFTER persistTurn, BEFORE endTurn — the same
 * ordering law that makes turn-settled imply durable truth) applies it
 * against the freshly persisted record. Validation runs at APPLY time
 * against real state: if the dismissed question/problem really is pending
 * there, the dismissal lands exactly as the route would have written it;
 * if it never materialized (the call errored, the model re-posed and
 * answered), the park is dropped silently — the thing the user dismissed
 * no longer exists.
 *
 * Lives on globalThis, NOT a module-level Map — the same Next.js module
 * instance discipline as turn-liveness: the dismiss route and the
 * chat-handler entry must see the SAME registry or the park is written in
 * one world and read in another. Ephemeral by design; one parked
 * dismissal per chat (last write wins — there is one dock, one discard).
 */

import { ChatInputError, dismissAppends, emit } from "../core";
import type { ChatStore } from "../core/ports.ts";

/** The parked dismissal body — exactly the parsed input the dismiss route
 *  accepted ({type:"dismiss", toolCallId, answer} or
 *  {type:"dismiss-problem", problemCallId}). */
export type ParkedDismissal = unknown;

interface LhGlobal {
	__lhParkedDismissals?: Map<string, ParkedDismissal>;
}

function registry(): Map<string, ParkedDismissal> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhParkedDismissals ??= new Map<string, ParkedDismissal>());
}

/** Park (or overwrite) the chat's dismissal intent. Called by the dismiss
 *  route when a turn owns the chat. */
/**
 * 暂存（或覆盖）指定会话的取消（dismissal）意图。
 * 当 `dismiss` 路由发现对话正在运行时，它会调用此函数将会话的取消动作暂存。
 *
 * @param chatId 会话的唯一标识符。
 * @param input 暂存的取消动作负载（包含要被取消的 ID 和数据）。
 */
export function parkDismissal(chatId: string, input: ParkedDismissal): void {
	registry().set(chatId, input);
}

/** Take the chat's parked dismissal (removes it). Returns null when
 *  nothing is parked. */
/**
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

/** Apply the chat's parked dismissal, if any, against the current record.
 *  Runs in the turn's onFinish — between persistTurn and endTurn, so a
 *  client reacting to "turn-settled" reads the dismissal already in the
 *  record. The append path is the route's own (dismissAppends); a
 *  ChatInputError means the dismissed thing never materialized — the park
 *  is dropped, silence is the correct outcome. Emits "record-changed"
 *  exactly when something was written. */
/**
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
