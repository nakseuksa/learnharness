/**
 * ChatStore — 基于文件系统的 JSON 适配器（在 data/chats/ 目录下每个聊天一个文件）。
 *
 * 实现了 core/ports.ts 中的 ChatStore 接口；记录(record)的结构定义在
 * core/contracts.ts (ChatRecord/ChatSummary) 中。
 * 编程风格 (Idioms)：同步文件系统操作，微型记录，基于 ID 保护的文件名，以及使用 Tab 缩进的 JSON。
 * 在组合根 (composition root, src/server/stores.ts) 中进行装配；其他任何地方都不会直接构造它。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, PlanTree, TurnUsage } from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";

function chatFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(PATHS.chats, `${id}.json`);
}

/**
 * THE SILENCE LAW (静默法则) (push S6, 2026-10-02)：
 * chats-changed 事件只广播“列表结构性 (list-SHAPE)” 的变更 ——
 * createChat (创建聊天), renameChat (重命名聊天), deleteChat (删除聊天)（在下方，
 * 这些函数在写入后会发出通知）。
 * 内容写入者 (saveMessages, appendTurnUsage, appendExtractionUsage, saveSettings, saveTree)
 * 则是有意保持静默的 (DELIBERATELY SILENT)：saveMessages 会在每一次对话回合持久化时触发，
 * 如果发送事件会造成总线垃圾信息 (spam the bus)，而它引起的每一个对列表可见的更改
 * （标题、顺序、阶段、忙碌状态、待处理问题）都已经通过 turn-started / turn-settled 事件通知过了，
 * 侧边栏会基于这些事件进行重新获取。在这里，静默是一项法则，而不是疏忽。
 */
function createChat(title: string, kind?: "practice"): ChatRecord {
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		messages: [],
		// 练习 (Practice) 会话带有该标记；教学 (teach) 会话保持缺失该字段
		// (字段缺失即表示教学 — 早于练习功能出现的旧记录永远不需要迁移)。
		...(kind === "practice" ? { kind: "practice" as const } : {}),
	};
	fs.mkdirSync(PATHS.chats, { recursive: true });
	writeChat(record);
	emit("chats-changed", {});
	return { ...record, version: CURRENT_CHAT_VERSION }; // 返回与写入磁盘内容一致的内存副本
}

/**
 * THE WRITE CHOKE POINT (统一写入关卡) (schema-versioning wave, owner 2026-10-10)：
 * 每一次记录持久化操作都必须经过这里，并且打上 CURRENT_CHAT_VERSION (当前版本) 的印记 ——
 * 惰性迁移 (lazy migration) 意味着现有的旧文件只有在下一次被写入时才会被打上新版本戳。
 * 未来版本保护 (future-version guard) 逻辑存在于读取端 (getChat) 中。
 */
function writeChat(record: ChatRecord): void {
	fs.writeFileSync(chatFile(record.id), JSON.stringify({ ...record, version: CURRENT_CHAT_VERSION }, null, "\t"), "utf-8");
}

function getChat(id: string): ChatRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(chatFile(id), "utf-8"));
	} catch {
		return null;
	}
	// Honest refusal (诚实拒绝原则) (owner ruling 2026-10-10)：
	// 如果记录上的版本戳比当前应用构建版本还要新 (即应用降级场景)，
	// 将被视作记录不存在，而绝对不能错误解析 (misparsed) ——
	// 接下来的读取-修改-写入操作绝不能重写它无法理解的内容。
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	return parsed as ChatRecord;
}

function listChats(): ChatSummary[] {
	try {
		fs.mkdirSync(PATHS.chats, { recursive: true });
		return fs
			.readdirSync(PATHS.chats)
			.filter((f) => f.endsWith(".json"))
			.map((f) => getChat(f.slice(0, -5)))
			.filter((r): r is ChatRecord => r !== null)
			.map(({ messages, tree, turns, extractions, ...summary }) => {
				// 每条记录相互隔离 (Per-record isolation) (Wave B)：
				// 如果某条记录的 messages 在投影时失败（例如，Wave B 之前使用 UIMessage 格式的旧数据 ——
				// 这种零向下兼容的清理使其被视为"损坏"），绝不能导致整个侧边栏变成空白 ——
				// 这种隔离性与 getChat 针对单个文件的 try-catch 是一样的。
				try {
					return {
						// turns 和 extractions 不应包含在列表有效负载 (payload) 中 (列表 = summaries；
						// 聚合的用量数据依附于完整的记录，选择器组件永远用不到它们)。
						...summary,
						// 归一化 kind：如果记录中该字段缺失，则读取为 teach (教学)。
						kind: summary.kind ?? "teach",
						messageCount: messages.length,
						// 供会话选择器使用的、源于记录的状态：
						// phase (阶段) 取自对话副本的明确事件 (probe_done 结束 / verdict 接受 — 见 docs/probe-teach-split.md §4)，
						// pendingQuestion (待处理问题) 则通过原生悬空调用扫描得出。
						// Wave D 阶段：这两个折叠操作读取的是 原生 (NATIVE) 记录
						// (通过 core/phases.ts 的 phaseAt3Lh + native-messages.ts 的 danglingQuestionOf)。
						// Liveness (活跃/忙碌状态) 不是从记录导出的 —— 它由 API 路由进行合并 (ChatListItem)。
						phase: phaseAt3Lh(messages),
						pendingQuestion: danglingQuestionOf(messages) !== null,
					};
				} catch (err) {
					console.error(`[chat ${summary.id}] summary projection failed:`, err);
					return null;
				}
			})
			.filter((s): s is ChatSummary => s !== null)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/**
 * 持久化完整的原生消息列表（该记录就是代理的状态 —
 * Wave B 规定：回放 (replay) 的本质就是 state.messages = record.messages）。
 * 依据事件法则它是静默的 (SILENT) — 参阅 createChat 处的 THE SILENCE LAW 注释。
 */
function saveMessages(id: string, messages: LhMessage[]): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.messages = messages;
	record.updatedAt = new Date().toISOString();
	writeChat(record);
}

/**
 * 在记录的回合日志中追加一条使用量数据 (usage entry) — 针对不同的回合 ID 保证幂等性 (idempotent)：
 * 每个请求 (REQUEST) 都携带自己的 ID，因此同一个回合持久化的回放只会追加一次；
 * 而续写回合 (continuation turns，它们共享一个回复消息 ID) 则会各自保留它们的用量数据。
 */
function appendTurnUsage(id: string, entry: TurnUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.turns = record.turns?.some((t) => t.id === entry.id)
		? record.turns
		: [...(record.turns ?? []), entry];
	writeChat(record);
}

/**
 * 在记录的提取日志 (extractions log) 中追加一条提取运行的用量数据 (extraction-run usage entry) —
 * 根据 startedAt 字段保证幂等性：当重试操作导致达到两次追加时 (例如中断重放)，不会重复计算花费。
 */
function appendExtractionUsage(id: string, entry: ExtractionRunUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.extractions = record.extractions?.some((r) => r.startedAt === entry.startedAt)
		? record.extractions
		: [...(record.extractions ?? []), entry];
	writeChat(record);
}

/**
 * 持久化每个聊天的 模型/思考(model/thinking) 设置 — 这是整体替换 (replace-whole)
 * （选择器会发送完整的对象；缺失则意味着使用配置默认值）。
 */
function saveSettings(id: string, settings: ChatSettings): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// 与 saveTree 一样：修改设置并不属于实质性的对话活动，因此它
	// 故意不去更新 updatedAt（侧边栏的顺序不能因为这个而变动）。
	record.settings = settings;
	writeChat(record);
}

/**
 * 重命名会话 (顶部的点击编辑标题，2026-09-17)。与 saveSettings 类似，
 * 重命名并不属于对话活动：updatedAt 保持不变，这样侧边栏顺序永远不会被扰乱。
 * 具备与 createChat 相同的后备逻辑 (fallback) — 空字符串会变成 "Untitled session"
 * （API 网关会最先拒绝空字符串；这为其他调用者提供了最终保证）。
 */
function renameChat(id: string, title: string): ChatRecord {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.title = title.trim() || "Untitled session";
	writeChat(record);
	emit("chats-changed", {});
	return record;
}

/**
 * 彻底删除会话记录文件 (会话删除阶段 wave 6，owner 2026-09-22)。
 * 当 ID 未知时返回 False — 路由会将其转换为 404 错误。
 * 该记录对应的图谱追踪数据和后台作业的清理属于路由层的编排范畴
 * (core/graph-deletion.ts)，而不是由存储层 (store) 负责。
 */
function deleteChat(id: string): boolean {
	try {
		fs.unlinkSync(chatFile(id));
		emit("chats-changed", {}); // 仅当真正被移除时触发 — 原有条目法则 (the present-entry law)
		return true;
	} catch {
		return false; // 从未存在、已被删除，或不可读 — 均返回相同答案
	}
}

/**
 * 持久化会话的计划树 (plan tree) (计划工具会在执行 execute 时调用此方法)。
 */
function saveTree(id: string, tree: PlanTree): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.tree = tree;
	// 故意不去更新 updatedAt：计划树的变更依赖于回合的 saveMessages 进行，
	// 侧边栏排序不应该因为对计划树的编辑而产生不必要的波动。
	writeChat(record);
}

export const chatStore: ChatStore = {
	createChat,
	getChat,
	listChats,
	saveMessages,
	saveTree,
	saveSettings,
	renameChat,
	deleteChat,
	appendTurnUsage,
	appendExtractionUsage,
};
