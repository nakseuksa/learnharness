/**
 * 实时物理拖拽的服务器端提交（PUT /api/graph/positions）。
 * 客户端的渲染器将拖拽退火（anneals）至静止状态，并 PUT 新的静止状态；
 * 服务器信任它所知道的节点，并且如果图谱在用户拖拽时增长（合并（merge）已落盘），
 * 则运行一次增量结算（settleGraphLayout），使得新节点被吸收到用户刚刚排列的框架中 —
 * 客户端位置作为锚点（anchors），从不作为覆盖（clobber）。
 *
 * 每个请求体都被净化（sanitized）：垃圾坐标被钳制或丢弃，未知 id 被丢弃，不会抛出异常。
 *
 * 已知 ID = 画布的世界（KNOWN IDS = THE CANVAS'S WORLD，owner fix, 2026-10-06 — 飞溅错误）：
 * 派生视图的节点 — 存储的命题（propositions）和派生的 arg_ 含义节点（implication nodes）。
 * 画布持久化所有这些节点；在这里剥离 args 会在每次拖拽提交时清除它们的账本条目，
 * 因此每次挂载都会将它们重新播种到一个巨大的环上（“从中间飞溅”的报告），直到拖拽将它们退火回去。
 * arg_ ids 是稳定的（从链账本铸造），因此持久化它们是可靠的。
 */
import type { Position } from "../core/contracts.ts";
import { deriveView, getGraph } from "../core/graph.ts";
import { settleGraphLayout } from "../core/layout-settle.ts";
import { stores } from "./stores.ts";

/** 接受的最大 |x| 或 |y| — NaN/Infinity 在这里钳制，荒谬的值也一样。 */
const MAX_COORD = 1e6;

/**
 * 接受原始的 PUT body（一个 id → {x, y} 的记录（Record））并返回实际持久化的已净化位置
 * （空对象 = 未写入任何内容，例如没有已知 id 的请求体 — 调用者报告但从不失败）。
 *
 * 处理 PUT /api/graph/positions 的节点坐标持久化请求。
 * 客户端渲染器在完成拖拽并退火达到静止状态后提交新的节点位置。
 * 该函数负责清理与验证这些坐标，仅保存图谱中已知的节点 ID，同时抛弃或限制非法坐标。
 *
 * 若在拖动期间有新的节点提取并合并到图谱中，该函数会调用 `settleGraphLayout`，
 * 以客户端提交的位置为锚点进行一次增量的布局调整。
 *
 * @param input 客户端提交的原始请求体数据 (通常是 节点ID -> {x, y} 的映射)。
 * @returns 经过验证并真实持久化的坐标映射。如果输入无效或没有已知节点，则返回空对象。
 */
export function commitPositions(input: unknown): Record<string, Position> {
	if (typeof input !== "object" || input === null) return {};
	const raw = input as Record<string, unknown>;

	// Only ids the canvas's world actually has: stored propositions plus
	// the DERIVED arg_ implication nodes (deriveView of the current graph
	// — the same derivation the snapshot serves, so ids agree by
	// construction).
	const known = new Set(deriveView(getGraph(stores.graphStore)).nodes.map((n) => n.id));

	const positions: Record<string, Position> = {};
	for (const [id, value] of Object.entries(raw)) {
		if (!known.has(id)) continue;
		if (typeof value !== "object" || value === null) continue;
		const { x, y } = value as Record<string, unknown>;
		if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y))
			continue;
		positions[id] = {
			x: Math.min(Math.max(x, -MAX_COORD), MAX_COORD),
			y: Math.min(Math.max(y, -MAX_COORD), MAX_COORD),
		};
	}
	if (Object.keys(positions).length === 0) return {};

	stores.graphStore.writePositions(positions);

	// The graph grew past what the client knew (a merge landed mid-drag):
	// absorb the new nodes with the client's rest state as anchors. The
	// honest test: some node of the CURRENT view is absent from the
	// client's payload — proposition or arg_ alike (the old count
	// comparison broke once args counted as persistable).
	for (const id of known) {
		if (!(id in positions)) {
			settleGraphLayout(stores.graphStore);
			break;
		}
	}
	return positions;
}