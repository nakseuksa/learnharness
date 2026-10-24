import * as fs from "node:fs";
import { LEDGER_FILES, POSITIONS_FILE } from "../../config.ts";
import type { GraphSnapshot } from "../core/contracts.ts";
import type { GraphCostSummary } from "../core/cost-summary.ts";
import { graphCostSummary } from "../core/cost-summary.ts";
import { graphSnapshot } from "../core/graph.ts";
import { birthSessionPartition } from "../core/session-clusters.ts";
import {
	deleteNodeTraces,
	type NodeDeletionStats,
} from "../core/graph-deletion.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { stores } from "./stores.ts";

/**
 * 主页视图（GET /api/graph）的服务器端图谱入口。纯粹的读取（PURE READ）：
 * 提取管道（唯一的图谱编写者）由会话中的测验答案（turn-service）触发，
 * 从不从这里触发 — 主页视图反映了管道到目前为止合并的任何内容。
 *
 * 获取图谱的只读快照视图（为 GET /api/graph 服务）。
 * 该操作为纯读取，因为数据提取管道是唯一写入图谱的地方。
 *
 * @returns 序列化后的全量图谱快照。
 */
export function graphView(): GraphSnapshot {
	return graphSnapshot(stores);
}

/**
 * 图谱视图的成本面（GET /api/graph/costs — 2026-09 成本药丸）：
 * 将每个使用渠道折叠为阶段总计 + 最近运行。对聊天记录（聊天前门运行）、
 * 笔记源（笔记前门运行）和命名账本（图谱全局运行）进行纯粹的读取；
 * 美元金额由纯核心折叠（core/cost-summary.ts + prices.ts）推断
 * — 这里没有任何东西存储或缓存金钱。
 *
 * 计算图谱相关的成本花销摘要（为 GET /api/graph/costs 服务）。
 * 它遍历系统内所有的聊天记录和图谱源文件，汇总并折算成金额。
 *
 * @returns 图谱不同操作和模型相关的成本汇总。
 */
export function graphCosts(): GraphCostSummary {
	const chats = stores.chatStore
		.listChats()
		.flatMap((summary) => {
			const record = stores.chatStore.getChat(summary.id);
			return record?.extractions?.length
				? [{ title: record.title ?? summary.id, extractions: record.extractions }]
				: [];
		});
	const sources = stores.graphStore
		.readSources()
		.filter((s) => s.extractions?.length)
		.map((s) => ({ filePath: s.filePath, extractions: s.extractions! }));
	return graphCostSummary({ chats, sources });
}

/**
 * 图谱的版本戳（会话删除 wave 6）：每个图谱数据文件
 * （账本、位置）的最大 mtime。在任何图谱写入（合并追加、结算或删除的原子重写）时移动，
 * 永远不会在读取时移动，也不需要自己的记账：文件系统（fs）就是计数器。
 * 消费者轮询它（活动源携带它；DELETE 响应返回它）以了解集群/布局
 * 必须重新获取 — “我底下的图谱改变了”信号。
 *
 * 计算整个图谱的版本戳（用于通知客户端需要重新拉取数据）。
 * 该版本号直接取所有图谱相关数据文件（节点、链、会话、覆盖率账本及坐标记录）的最大修改时间（mtime）。
 * 只要有任何写操作改变了文件，版本戳就会递增。不存在文件时返回 0。
 *
 * @returns 图谱数据的最大修改时间戳。
 */
export function graphRevision(): number {
	let revision = 0;
	for (const file of [
		LEDGER_FILES.nodes,
		LEDGER_FILES.chains,
		LEDGER_FILES.sessions,
		LEDGER_FILES.coverage,
		POSITIONS_FILE,
	]) {
		try {
			revision = Math.max(revision, fs.statSync(file).mtimeMs);
		} catch {
			/* absent — nothing has ever written it */
		}
	}
	return revision;
}

// ─── single-node deletion (node interlude, owner-locked full-death) ──────────

/** deleteGraphNode 所做的操作 — 路由将其直接映射到 HTTP。 */
export type NodeDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "extraction_running"; error: string }
	| { ok: true; stats: NodeDeletionStats; graphRevision: number };

/**
 * 通过 id 删除一个节点 — 彻底死亡（FULL DEATH，账本语义见 core/graph-deletion.ts）。
 * 防护组（guard family）故意不是聊天防护，其原因值得写下来：
 *
 *   - 没有回合/作业门控。回合和后台作业永远不会写入图谱账本；回合的后续提取注册为一个运行，
 *     并且这里的每个代码路径都是同步的 — 在门控和账本重写之间没有什么可以注册
 *     或合并（事件循环在此函数内部永远不会让步）。
 *   - 提取门控（THE EXTRACTION GATE） — 当任何管道运行注册在任何地方时返回 409。
 *     飞行中的运行保留了从删除之前的转录中提取的发现；其合并可能会向濒临死亡的节点
 *     重新添加别名、出处或事件（调度标记的重新引用风险）。与聊天删除不同，我们
 *     不中止该运行：它属于某个会话，终止该会话的花费超出了此删除的爆炸半径 —
 *     一旦 dock 排空，UI 就会重试。在删除之后开始的运行是合法的重新学习：它读取
 *     删除后的账本，为一个重新教授的主题铸造一个新节点，并且
 *     mergeFindings 忽略不再存在的 linkTo id（existingIds 守卫） — 没有悬空边，没有复活。
 *
 * 根据 ID 彻底删除单个图谱节点（包括清理与之相关的所有关联账本记录）。
 * 删除操作是原子且同步执行的，以确保不会发生数据一致性问题。
 * 如果当前后台有提取任务在运行，为了避免提取任务在稍后重新注入相关数据或关联不再存在的边，
 * 会拒绝该删除请求并返回 409。
 *
 * @param nodeId 需要删除的节点的唯一标识符。
 * @returns 包含删除成功与否状态及最新图谱修订号的结果对象。
 */
export function deleteGraphNode(nodeId: string): NodeDeleteOutcome {
	if (extractionStatuses().length > 0) {
		return {
			ok: false,
			status: 409,
			code: "extraction_running",
			error: "An extraction is running — try again when it finishes",
		};
	}
	// THE SYNC BLOCK — no awaits below (the doc above): the gate and the
	// rewrite are one atomic stretch of the event loop.
	const stats = deleteNodeTraces(stores.graphStore, nodeId);
	if (stats === null) {
		return { ok: false, status: 404, code: "not_found", error: "No such node" };
	}
	return { ok: true, stats, graphRevision: graphRevision() };
}

