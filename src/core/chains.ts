import type { GraphNode } from "./contracts/graph.ts";
import { stripModelValueDebris } from "./value-debris.ts";

/**
 * 面向选择的推理链视图 (Selection-facing chain views) — 纯逻辑 + 浏览器安全
 * (壳层的推理链表格组件会使用它；由核心 barrel(index.ts) 统一导出)。
 * 最初诞生于练习契约文件 (2026-09-29)，当批量练习模块被练习会话替代时
 * (2026-10-04)，被独立分离到这个模块中。
 */

/**
 * 一条推理链 (Reasoning chain) — 存储的“关注(follows)边缘”在选择视图中的体现：
 * 将所有指向同一个结论的边缘，表示为“前提 (premises) → 该结论 (conclusion)”。
 * 没有前提的单例链 (premises: []) 表示没有连接边缘的孤立节点。
 */
export interface ReasoningChain {
	/** 推理链的唯一标识 — 即结论节点 (CONCLUSION) 的 ID
	 *  (由于链是按照结论来分组的，所以这二者是等同的)。 */
	id: string;
	/** 前提节点的 ID 列表 — 所有指向该结论的关注边缘的源节点，已进行排序。
	 *  空数组 = 单例链 (无边缘连接的节点)。 */
	premises: string[];
	/** 结论节点 ID (与上述 id 相同；这里做一个镜像字段，
	 *  是为了在渲染时可以直接直观地读取 "premises → conclusion" 而无需间接转换)。 */
	conclusion: string;
}

/**
 * 根据选定的节点，过滤并生成存储的推理链集合 (由所有者于 2026-09-30 确立的 chains-primary 规则):
 * 仅当一条链的“结论”及其“所有前提”都被选中时，该链才会被包含进来；
 * 任何没有存在于存活链中的节点，都会作为“单例链”(premises: []) 被处理。
 * 如果某个仅作为前提的节点所属的链被排除了，那么该前提节点也会变成单例链 —
 * 这与引入链概念之前的边缘分组规则保持一致。
 * 每条被存储的链都会保留其专属的 ID (如 arg_…) — 这样指向同一个结论的两个独立论点
 * 就可以保持相互独立。
 * 确定性保证：结果列表按照链 ID 排序，链内前提 (premises) 也会进行排序。
 *
 * @param nodes 当前选中的节点集合 (只取 id 属性)
 * @param chains 当前所有图数据中的链集合 (只取 id, premises, conclusion)
 * @returns 过滤并整理后的 ReasoningChain 数组
 */
export function chainsForSelection(
	nodes: ReadonlyArray<Pick<{ id: string }, "id">>,
	chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>,
): ReasoningChain[] {
	const selected = new Set(nodes.map((n) => n.id));
	const chained = new Set<string>();
	const included: ReasoningChain[] = [];
	for (const chain of chains) {
		if (!selected.has(chain.conclusion)) continue;
		if (!chain.premises.every((premise) => selected.has(premise))) continue;
		included.push({ id: chain.id, premises: [...chain.premises].sort(), conclusion: chain.conclusion });
		chained.add(chain.conclusion);
		for (const premise of chain.premises) chained.add(premise);
	}
	for (const node of nodes) {
		if (!chained.has(node.id)) {
			included.push({ id: node.id, premises: [], conclusion: node.id });
		}
	}
	return included.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 将一个目标字符串解析为标准命题 ID (由所有者在 2026-10-05 第 9 轮确认 — 掌握度追踪契约)：
 * 解析顺序为：首先尝试精确匹配 ID；如果失败，则尝试匹配去除空白并忽略大小写的名称(name)。
 * 名称仅仅是展示句柄，并不保证唯一；因此遇到模糊（重复）的名称时，解析为存储顺序中遇到的第一个节点。
 * 当无法匹配时返回 null — 调用方负责拒绝处理。
 * 校验集合是“整个图 (WHOLE graph)”，而不仅仅是当前会话所挑选的节点：这能确保没有预选节点的会话，
 * 或是未来的图工具依然有效。
 * 在匹配前，会调用 debris strip 清除多余残余 (2026-10-09 whitehead 更新)，
 * 例如修复复制粘贴时产生的语法残留 (比如 `:node-id` 或者带引号的 ID) — 这是因为目标值通常是类似于 correctAnswer 的成员值。
 *
 * @param target 目标标识符（可能是 ID 也可能是名称）
 * @param nodes 整个图中需要匹配的节点集合
 * @returns 匹配到的节点 ID，找不到返回 null
 */
export function resolveTargetId(
	target: string,
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
): string | null {
	const t = stripModelValueDebris(target);
	if (t.length === 0) return null;
	if (nodes.some((n) => n.id === t)) return t;
	const lower = t.toLowerCase();
	for (const n of nodes) {
		if (stripModelValueDebris(n.name).toLowerCase() === lower) return n.id;
	}
	return null;
}

/**
 * 将推理链格式化为一行面向用户的文本表示 — 即通过推导箭头将命题的名称(NAMES)连接起来：
 * "前提一, 前提二 → 结论"；如果是一个单例链，则显示其 "(无前提)" 标记。纯逻辑 + 浏览器安全。
 * 对于未知的 ID，会回退显示原始 ID（老老实实显示，绝不进行猜测）。
 * 格式化时前提 (premises) 会按照 ID 排序 — 采用与 chainsForSelection 相同的确定性法则。
 *
 * @param chain 需要格式化的链
 * @param propositions 用于查找命题名称的映射字典
 * @returns 格式化后的链文本
 */
export function formatChainLine(
	chain: Pick<ReasoningChain, "premises" | "conclusion">,
	propositions: Readonly<Record<string, { name: string }>>,
): string {
	const nameOf = (id: string) => propositions[id]?.name ?? id;
	const premises = [...chain.premises].sort().map(nameOf).join(", ");
	return premises !== ""
		? `${premises} → ${nameOf(chain.conclusion)}`
		: `${nameOf(chain.conclusion)} (no premises)`;
}
