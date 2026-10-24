/**
 * JobStore — 基于文件系统的 JSON 适配器：针对每一个后台子代理 (sub-agent) 任务，
 * 都会在 data/jobs/ 目录下生成一个单独的文件 (参考 contracts.ts 中的 "异步协议 (THE ASYNC PROTOCOL)")。
 * 使用 toolCallId 作为键来进行去重 (dedup)：聊天处理程序的生成钩子 (spawn hook)
 * 绝不会为同一个工具部件创建两个任务。
 * 本模块实现了 core/ports.ts 中的 JobStore 接口。
 * 编程风格 (Idioms)：同步文件系统操作，基于 ID 保护的文件名，以及使用 Tab 缩进的 JSON。
 * 写入操作是小数据量且不频繁的 (主要用于更新活动状态行)；
 * 运行器 (runner) 中执行“读取-修改-写入”的代码段不包含 await，
 * 因此在单线程的事件循环中，它们具备原子性。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { JobStore } from "../core/ports.ts";
import type { CreateJobInit, JobPatch } from "../core/ports.ts";
import type { JobRecord } from "../core/contracts.ts";

/**
 * 存放后台任务的目录 (data/jobs)。
 * 它并未定义在 config.ts 的 PATHS 中 (因其由 orchestrator 统一管理和所有)。
 */
const JOBS_DIR = path.join(PATHS.data, "jobs");

function jobFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid job id: ${id}`);
	return path.join(JOBS_DIR, `${id}.json`);
}

/**
 * 在写入操作落地之后，向事件频道发布写入通知 (the notify-after-write law，即“写后通知法则”，
 * 遵循 beginTurn 的先例) — `jobs-changed` 事件是用来替代视图层的定时轮询机制的
 * (push S4, 2026-10-02)：调度卡片 (dispatch cards)、进度行、结算和中断，所有的状态变更
 * 都会通过这单次拉取表面化呈现。
 */
function createJob(init: CreateJobInit): JobRecord {
	const now = new Date().toISOString();
	const record: JobRecord = {
		id: `job_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		kind: init.kind,
		chatId: init.chatId,
		toolCallId: init.toolCallId,
		status: "running",
		activity: init.activity ?? "starting",
		createdAt: now,
		updatedAt: now,
	};
	fs.mkdirSync(JOBS_DIR, { recursive: true });
	fs.writeFileSync(jobFile(record.id), JSON.stringify(record, null, "\t"), "utf-8");
	emit("jobs-changed", { chatId: init.chatId });
	return record;
}

function getJob(id: string): JobRecord | null {
	try {
		return JSON.parse(fs.readFileSync(jobFile(id), "utf-8")) as JobRecord;
	} catch {
		return null;
	}
}

/**
 * 将局部补丁 (patch) 合并到任务记录中（身份识别字段是不可变的）。
 * 如果 patch 明确指定了 updatedAt，则会采用它（用于在测试中固定确定性的排序）；
 * 否则，合并操作会自动将其更新为当前时间。
 */
function updateJob(id: string, patch: JobPatch): JobRecord | null {
	const record = getJob(id);
	if (!record) return null;
	const next: JobRecord = { ...record, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
	fs.writeFileSync(jobFile(id), JSON.stringify(next, null, "\t"), "utf-8");
	// 每一次写入（不仅限于状态翻转）都会触发：因为进度行的更新也必须被推送到调度卡片上
	// (视图层会对这些突发的拉取请求进行防抖 debounce)。
	// 如果找不到对应的 ID 则什么也不写入，并且保持静默。
	emit("jobs-changed", { chatId: next.chatId });
	return next;
}

/**
 * 获取某个聊天会话的所有后台任务，按照最新的活动时间排序。
 */
function listJobs(chatId: string): JobRecord[] {
	try {
		fs.mkdirSync(JOBS_DIR, { recursive: true });
		return fs
			.readdirSync(JOBS_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => getJob(f.slice(0, -5)))
			.filter((j): j is JobRecord => j !== null && j.chatId === chatId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/**
 * 根据指定的 toolCallId 查找负责该工具部件的任务 (如果有的话，用于生成钩子去重)。
 */
function findJobByToolCallId(chatId: string, toolCallId: string): JobRecord | null {
	return listJobs(chatId).find((j) => j.toolCallId === toolCallId) ?? null;
}

/**
 * 删除某个聊天会话的所有任务记录文件 (会话删除阶段 wave 6) —
 * 无论是正在运行还是已完成，这些任务都属于该聊天的记录，并与之同生共死。
 * 返回被移除的文件数量。删除路由会在任务仍在运行时拒绝删除请求，
 * 因此到达这里的每条记录都是处于终端状态的 (terminal)。
 */
function deleteJobsForChat(chatId: string): number {
	let removed = 0;
	for (const job of listJobs(chatId)) {
		try {
			fs.unlinkSync(jobFile(job.id));
			removed++;
		} catch {
			/* 文件已被移除 — 数量统计是尽力而为的结果 (best-effort truth) */
		}
	}
	// 仅当确实有文件被删除时才触发事件 — 删除零个文件意味着没有发生写入
	// (符合 endTurn 的原有条目法则 present-entry law)。
	if (removed > 0) emit("jobs-changed", { chatId });
	return removed;
}

export const jobStore: JobStore = {
	createJob,
	getJob,
	updateJob,
	listJobs,
	findJobByToolCallId,
	deleteJobsForChat,
};
