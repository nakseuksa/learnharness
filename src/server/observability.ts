/**
 * 服务器端可观测性（observability）表面 — barrel 批准的导出项，
 * 供传输层（app/api/*）读取后台进程状态。
 *
 * 活动流（THE ACTIVITY FEED，2026-09 可观测性设计）：右下角的 dock 在
 * 每个视图中都可见，因此它需要在一个轮询中获取完整的正在运行的进程图景 —
 * 跨所有聊天（不仅是打开的那个）的子代理作业（sub-agent jobs）加上全局
 * 提取运行。dock 仅显示后台进程（BACKGROUND PROCESSES ONLY，
 * 用户决定，2026-09-11）：教学会话已经有它们自己的可观测性，因此
 * 飞行中的教师回合故意不在流中。/api/jobs 保持聊天作用域不变：它是转录
 * 机制的轮询，并携带 turnInFlight 用于重新附加接缝（chat-transport）；
 * dock 是一个不同形状的不同消费者，在这里提供服务。单一事实来源保持不变：
 * 作业存储和管道注册表 — 此文件仅组合它们。
 *
 * dock 控件的提取侧也在这里表面化：
 * abortExtraction（真正的运行中取消，用户决定）从管道的模块中导出，
 * 供中止路由调用。
 */

import { extractionStatuses, type ExtractionPhase } from "../agent/subagents/extraction.ts";
import { chatStore } from "../store/chats.ts";
import { graphRevision } from "./graph.ts";
import { catalogContextLimits } from "./model-catalog.ts";
import { listJobs } from "./jobs.ts";
import type { JobRecord } from "../core/contracts.ts";

export { abortExtraction, extractionStatuses, type ExtractionPhase, type RunningExtraction } from "../agent/subagents/extraction.ts";
export { chatStore } from "../store/chats.ts";

/**
 * 正在运行的子代理作业，连接其聊天标题供 dock 使用。
 * contextLimit（context-meter amendment, owner 2026-09-23）：模型的
 * 实时目录限制，从 pi 的目录在服务器端（SERVER-SIDE）解析 — dock
 * 从信息流中读取它，而不是任何客户端表。当模型在目录中缺失时为 null
 * （此时 blob 不呈现上下文行 — 绝不是假窗口）。
 */
export interface ActivityJob extends JobRecord {
	title: string;
	contextLimit: number | null;
}

/**
 * 一个提取管道作业（连接了标题），最旧的优先。每块作业（Per-chunk jobs，
 * owner，2026-09-28）：一个多块源拥有多行 — id 是唯一的作业键
 * （源 id，或 "src#i"），chatId 保持为源（SOURCE）id（中止 + 聊天链接是源作用域的），
 * 并且标题带有 "· i/N" 部分后缀。
 */
export interface ActivityExtraction {
	id: string;
	chatId: string;
	part?: { i: number; n: number };
	title: string;
	phase: ExtractionPhase;
	startedAt: number;
}

/**
 * 在一个有效负载中包含 dock 的整个世界：每个正在运行的进程，每个视图。
 * 作业仅限于运行中（RUNNING-ONLY） — 完成的作业属于它们聊天的转录；
 * 当进程结束时，blob 消失。成本数学不在（NOT）这里进行：原始使用量
 * 附在记录上，客户端使用 core/prices.ts 中的纯助手（pure helpers）
 * 对其进行折叠（传输层保持纤薄）。
 *
 * dock 的整个世界 + 图谱的版本戳（wave 6 会话删除）：有效负载携带
 * graphRevision（跨图谱数据文件的最大 mtime — 见 server/graph.ts），
 * 因此任何视图都可以检测到“我底下的图谱改变了”（合并落盘，删除清除）并
 * 重新获取集群/布局。读取永远不会移动它；DELETE 响应返回相同的时间戳。
 *
 * 组装后台活动大盘的聚合负载数据（供 `/api/activity` 端点读取）。
 * 这里汇总了所有正在运行的“子代理作业 (jobs)”和“提取任务 (extractions)”，
 * 并且附加了最新的图谱版本戳（`graphRevision`）用于前端判定是否需要刷新知识图谱。
 * @returns 包含所有正在运行的作业、提取任务和当前图谱修订号的复合对象。
 */
export function activityFeed(): {
	jobs: ActivityJob[];
	extractions: ActivityExtraction[];
	graphRevision: number;
} {
	const chats = chatStore.listChats();
	const limits = catalogContextLimits();
	const jobs: ActivityJob[] = [];
	for (const chat of chats) {
		for (const job of listJobs(chat.id)) {
			if (job.status === "running") {
				jobs.push({
					...job,
					title: chat.title ?? chat.id,
					contextLimit: job.usage ? (limits.get(job.usage.model) ?? null) : null,
				});
			}
		}
	}
	const extractions: ActivityExtraction[] = extractionStatuses().map((run) => ({
		id: run.part ? `${run.chatId}#${run.part.i}` : run.chatId,
		chatId: run.chatId,
		part: run.part,
		// 运行自己的标签永远不会到达此信息流（与图谱状态路由不同）
		// — 聊天存储的标题，或笔记源的裸 id，加上当源散开（fanned out）时的块后缀。
		title:
			(run.label ?? chatStore.getChat(run.chatId)?.title ?? run.chatId) +
			(run.part ? ` · ${run.part.i}/${run.part.n}` : ""),
		phase: run.phase,
		startedAt: run.startedAt,
	}));
	// 按最后活动时间最旧优先：稳定的 blob 顺序（ISO 字符串按时间顺序排序）
	jobs.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
	return {
		jobs,
		extractions: extractions.sort((a, b) => a.startedAt - b.startedAt),
		graphRevision: graphRevision(),
	};
}
