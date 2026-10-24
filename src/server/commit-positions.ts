/**
 * Server-side commit for the live physics drag (PUT /api/graph/positions).
 * The client's renderer anneals a drag to rest and PUTs the new rest
 * state; the server trusts it for the nodes it knows about and, if the
 * graph grew while the user was dragging (a merge landed), runs ONE
 * incremental settle (settleGraphLayout) so the fresh nodes are absorbed
 * into the frame the user just arranged — client positions act as
 * anchors, never as a clobber.
 *
 * Every body is sanitized: garbage coordinates clamp or drop, unknown
 * ids are discarded, nothing throws.
 *
 * KNOWN IDS = THE CANVAS'S WORLD (owner fix, 2026-10-06 — the splatter
 * bug): the derived view's nodes — stored propositions AND the derived
 * arg_ implication nodes. The canvas persists all of them; stripping
 * the args here purged their ledger entries on every drag-commit, so
 * each mount re-seeded them on a giant ring (the "splattered from the
 * middle" report) until a drag annealed them back. arg_ ids are stable
 * (minted from the chain ledger), so persisting them is sound.
 */
import type { Position } from "../core/contracts.ts";
import { deriveView, getGraph } from "../core/graph.ts";
import { settleGraphLayout } from "../core/layout-settle.ts";
import { stores } from "./stores.ts";

/** Max |x| or |y| accepted — NaN/Infinity clamp here, absurd too. */
const MAX_COORD = 1e6;

/**
 * Accepts the raw PUT body (a Record of id → {x, y}) and returns the
 * sanitized positions actually persisted (empty object = nothing written,
 * e.g. a body with no known ids — the caller reports but never fails).
 */
/**
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