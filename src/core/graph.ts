/**
 * The knowledge graph: merger (the deterministic final stage of the
 * extraction pipeline — vision §1 construction) + derivation (reads).
 *
 * The extraction pipeline is the SOLE graph writer, tree-blind and post-hoc
 * (2026-09-27 cleanup — clear separation of work):
 *
 *   extractor (LLM)  → SessionFindings: the raw reasoning chains —
 *                      propositions (lonely relevant ones included) and
 *                      chains, from the stretch (one batch) PLUS the
 *                      same-source digest (digest-aware, 2026-09-30
 *                      evening: the extractor continues its own source,
 *                      references existing ids verbatim, assembles
 *                      cross-stretch itself). Session propositions carry
 *                      their passage's messageId (2026-10-13) — the
 *                      merger's provenance anchor. Fully trusted: no
 *                      stage re-checks it.
 *   auditor (LLM)    → AuditVerdicts: identity links (local id → an existing
 *                      node, or create) via graph-exploration tools —
 *                      links ONLY (owner, 2026-09-28 evening: the auditor
 *                      never mints edges; cross-source connection happens
 *                      solely through identified equivalences). Never sees
 *                      the source; never drops; never sees chains — its
 *                      input is the fresh propositions only.
 *   merger (HERE)    → mergeFindings(): deterministic ledger appends
 *                      + the chain-simplification maintenance pass
 *                      (2026-09-30 evening — simplifyChains below).
 *
 * The merger is deliberately the ONLY stage that touches the ledgers, and it
 * is pure code: the LLM supplies exactly the judgment calls (what the
 * propositions are, what follows/supports what, whether a proposition IS an
 * existing node), while timestamps/provenance — anything the model could
 * silently mis-copy — are rebuilt deterministically. Idempotent +
 * incremental: edges dedupe by (from,to,type)-already-asserted-by-this-chat,
 * mapping lines dedupe by (chat, sourceId), and coverage entries /
 * sessions.jsonl checkpoints which messages and chats have been extracted
 * (never the same turns twice). No events: the events ledger is GONE
 * (2026-09-27) — the graph carries propositions + edges, nothing else.
 *
 * Identity across re-encounters is the AUDITOR's judgment (link-or-create
 * with an equivalence bias — paraphrases merge), not string matching.
 * A re-extracted session's propositions link to the existing nodes; the
 * link appends a node line whose phrasings join `aliases` and whose
 * provenance unions (getGraph merges lines by id).
 *
 * Derivation below (getGraph / graphSnapshot) is reads only — everything
 * is recomputed from the ledgers. Every function takes the storage ports
 * (core/ports.ts) as explicit parameters — pure core, no adapter imports;
 * the composition root (src/server/stores.ts) wires the fs adapters in.
 */

import { randomBytes } from "node:crypto";
import type { CoverageEntry,
} from "./contracts/graph.ts";
import type {
	AuditVerdicts,
	ExtractedChain,
	GraphChain,
	SessionFindings,
	Cluster,
	EmissionStats,
	GraphEdge,
	GraphNode,
	ProvenancePoint,
	GraphSnapshot,
} from "./contracts.ts";
import { MIN_CLUSTER_SIZE } from "./clusters.ts";
import { formatChainLine } from "./chains.ts";
import { attachImpToCommunities, birthSessionOf, birthSessionPartition } from "./session-clusters.ts";
import type { ChatStore, GraphStore } from "./ports.ts";

/** The storage ports every graph operation needs, passed explicitly. */
export interface GraphDeps {
	chatStore: ChatStore;
	graphStore: GraphStore;
}

/** "n_" + 12 hex chars (contracts.ts GraphNode.id — store-assigned). */
function newGraphNodeId(): string {
	return `n_${randomBytes(6).toString("hex")}`;
}

/** "arg_" + 12 hex chars — the implication-node namespace (a chain's id
 *  IS its derived node's id; collision-free with n_ by construction). */
function newGraphChainId(): string {
	return `arg_${randomBytes(6).toString("hex")}`;
}

/** A chain's merge key: sorted premises + conclusion — the identity an
 *  assertion re-stating the same argument merges under. */
function chainKey(premises: ReadonlyArray<string>, conclusion: string): string {
	return `${[...premises].sort().join("+")}>${conclusion}`;
}

/** What one merge run merges FROM (the caller supplies it — the merger never
 *  reads the chat store): the coverage checkpoint for a session batch, or —
 *  for the format-agnostic notes front door (2026-09-13) — no coverage at
 *  all: the whole-file checkpoint stamps the import.
 *
 *  Coverage (vision-extraction-coverage.md, settled 2026-09-15): a chat merge
 *  passes the BATCH it extracted — the caller computed the fingerprints
 *  before the run, from the same snapshot the merger sees — and the final
 *  step appends one CoverageEntry per message on success ("covered" means
 *  exactly this merge happened). The notes path passes neither and keeps
 *  the whole-file checkpoint. */
export interface MergeSource {
	foldedAt: string;
	/** The batch being merged (chat path): one entry per message in the
	 *  extracted batch — undefined (notes path / coverage-less callers) →
	 *  the legacy whole-chat checkpoint is written instead. */
	coverage?: CoverageEntry[];
}

/** The run's provenance point. Chat-level by default (submit-schema slim,
 *  2026-09-28 — the run's source key is the whole point); since the anchor
 *  restore (owner, 2026-10-13) a SESSION birth may carry its passage's
 *  message id — the extractor-copied messageId, validated at the submit
 *  seam against the current batch. Chains, notes imports, and
 *  legacy/core callers lacking an anchor keep "" (chat-level). */
function pointOf(chatId: string, messageId?: string): ProvenancePoint[] {
	return [{ chatId, messageId: messageId ?? "" }];
}

const samePoint = (a: ProvenancePoint, b: ProvenancePoint): boolean =>
	a.chatId === b.chatId && a.messageId === b.messageId;

// ─── the merger (extraction pipeline stage 3 — deterministic) ────────────────

/**
 * Merge one job's audited findings into the graph ledgers — the pipeline's
 * apply stage. Deterministic. Each chunk/batch job merges INDEPENDENTLY
 * (owner, 2026-09-29): resolution is a job-local in-memory map from this
 * submit's proposition ids to graph node ids — nothing persists between
 * jobs, so no job can see (or collide with) another's ids. Cross-job
 * identity is the auditor's alone: it links this job's propositions to
 * existing nodes before this function is ever called.
 *
 * Identity inside the job is the auditor's link-or-create verdict: `linkTo`
 * an existing node (validated against the ledger — an unknown id falls
 * back to create) appends a LINK line (the job's phrasings join the node's
 * aliases and the provenance unions; getGraph merges lines by id);
 * absent → a new node.
 *
 * `chatId` is the job's source key: a real chat, or a notes source id
 * ("src_…") for the format-agnostic import path. The `source` parameter
 * carries the checkpoint stamp; the merger itself is chat-store-free.
 */
export function mergeFindings(
	chatId: string,
	findings: SessionFindings,
	verdicts: AuditVerdicts,
	deps: GraphDeps,
	source: MergeSource,
): EmissionStats {
	const { graphStore: ledgers } = deps;
	const stats: EmissionStats = { nodes: 0, chains: 0 };

	// 1. Resolution: THIS job's propositions → graph node ids, built
	//    in-memory as the propositions resolve (owner, 2026-09-29: the
	//    mappings ledger is gone — a persisted table was a shared namespace
	//    across independent jobs, and cross-job id collisions silently
	//    dropped propositions and welded wrong edges). Dedupe across runs
	//    is the coverage ledger (nothing re-extracts) and the auditor's
	//    equivalence links (re-encountered knowledge merges in).
	const existingIds = new Set(ledgers.readNodes().map((n) => n.id));
	const mapping = new Map<string, string>();
	const now = new Date().toISOString();
	const linkOf = new Map(verdicts.links.map((l) => [l.id, l.linkTo]));

	// VERDICTS-ONLY (owner, 2026-09-28): the propositions come from the
	// extractor's findings verbatim; the auditor's links join here by id.
	for (const p of findings.propositions) {
		if (mapping.has(p.id)) continue; // duplicate id WITHIN this submit — first resolution stands
		// The anchor (2026-10-13): a session proposition may carry its
		// passage's messageId — it rides BOTH the create and the link-append
		// line (each re-encounter anchors to ITS passage); absent (notes,
		// legacy/core callers) → "", chat-level as before.
		const points = pointOf(chatId, p.messageId);
		const linkTo = linkOf.get(p.id);
		let graphNodeId: string;
		if (linkTo !== undefined && existingIds.has(linkTo)) {
			// Identity verdict: this proposition IS that node. Append a link
			// line — the session's phrasings (statement + aliases) join the
			// node's aliases, the provenance unions. Reads merge by id.
			graphNodeId = linkTo;
			// Link-append: phrasings + provenance join at read time (the
			// first line's name/statement/createdAt stand).
			ledgers.appendNode({
				id: graphNodeId,
				name: p.name,
				statement: p.statement,
				aliases: [...p.aliases],
				createdAt: now,
				provenance: points,
			});
		} else {
			const node: GraphNode = {
				id: newGraphNodeId(),
				name: p.name,
				statement: p.statement,
				aliases: [...p.aliases],
				createdAt: now,
				provenance: points,
			};
			ledgers.appendNode(node);
			stats.nodes++;
			graphNodeId = node.id;
			existingIds.add(graphNodeId);
		}
		mapping.set(p.id, graphNodeId);
	}

	// 2. Chains — the extractor's alone since the digest-aware redesign
	//    (owner, 2026-09-30 evening: the extractor continues its own
	//    source, so ITS chains may span stretches and digests). Endpoints
	//    resolve through the job-local map OR pass through verbatim when
	//    they name an existing node (digest references, ids verbatim);
	//    chains carry the run's chat-level provenance point and
	//    dedupe by (premises, conclusion) already asserted by THIS chat —
	//    an assertion by another chat stays untouched (provenance unions
	//    at read time; a known argument re-stated appends under the SAME
	//    arg_ id — link-style, exactly like node link-appends; the first
	//    line's premises/createdAt stand at read time).
	const assertedByChat = new Set<string>();
	const idOfKey = new Map<string, string>();
	for (const line of ledgers.readChains()) {
		const key = chainKey(line.premises, line.conclusion);
		if (!idOfKey.has(key)) idOfKey.set(key, line.id);
		if (line.provenance.some((pt) => pt.chatId === chatId)) assertedByChat.add(key);
	}
	const emitChain = (chain: ExtractedChain): void => {
		// Mixed namespace (digest-aware extraction, 2026-09-30): an
		// endpoint resolves through the job-local map (this submit's
		// propositions) OR passes through verbatim when it names an
		// existing node (THE GRAPH SO FAR references, ids verbatim).
		// Anything else is unresolvable — skip.
		const resolve = (endpoint: string): string | undefined =>
			mapping.get(endpoint) ?? (existingIds.has(endpoint) ? endpoint : undefined);
		const conclusion = resolve(chain.conclusion);
		if (conclusion === undefined) return; // unresolvable endpoint — skip
		// Duplicate local ids resolving to one node (two phrasings of one
		// premise) collapse; a premise equal to the conclusion is dropped.
		const premises = [...new Set(chain.premises.map(resolve))].filter(
			(p): p is string => p !== undefined && p !== conclusion,
		);
		if (premises.length === 0) return; // a chain IS an argument — bare propositions ride the node ledger alone
		const key = chainKey(premises, conclusion);
		if (assertedByChat.has(key)) return; // this chat already asserted this argument
		const id = idOfKey.get(key) ?? newGraphChainId();
		ledgers.appendChain({ id, premises, conclusion, createdAt: now, provenance: pointOf(chatId) });
		idOfKey.set(key, id);
		assertedByChat.add(key);
		stats.chains!++;
	};
	for (const chain of findings.chains) emitChain(chain); // the extractor's chains — the one chain source (digest-aware, owner 2026-09-30)

	// 2b. Simplification (owner, 2026-09-30 evening) — the deterministic
	//     dedupe pass over the WHOLE chain ledger (this merge runs inside
	//     the serialized audit section, so the rewrite is race-free). Two
	//     rules, decided per conclusion group, greedy in (premiseCount,
	//     createdAt, key) order — the leanest, earliest derivation stands:
	//     • prefer-fewest-premises: a chain whose premise set strictly
	//       contains a kept chain's premise set is redundant;
	//     • ancestry-cover: a chain whose every premise is a premise of a
	//       kept chain, or derivable from one (transitively, through the
	//       FULL pre-simplification chain set) is redundant — [A,B]⟹X
	//       plus [X,C]⟹Y makes [A,B,C]⟹Y redundant.
	//     Dropped keys take every provenance line with them (the rewrite is
	//     atomic); stats count APPENDS only — simplification is maintenance.
	const allChains = ledgers.readChains();
	const keptChains = simplifyChains(allChains);
	if (keptChains.length !== allChains.length) {
		ledgers.rewriteLedgers({ chains: keptChains });
		stats.droppedChains = allChains.length - keptChains.length;
	}

	// 3. Checkpoint — THE COVERAGE DISCIPLINE (vision-extraction-coverage.md):
	//    only now, after every append succeeded, is the batch covered. The
	//    chat path appends one CoverageEntry per message (per-batch atomic —
	//    an abort or failure mid-run leaves earlier batches covered, this
	//    batch's messages uncovered); the notes path keeps the whole-file
	//    checkpoint (a file is one shot).
	if (source.coverage !== undefined) {
		for (const entry of source.coverage) ledgers.appendCoverage(entry);
	} else {
		ledgers.appendCheckpoint({ chatId, foldedAt: source.foldedAt });
	}
	return stats;
}

/** The deterministic chain-simplification pass (owner, 2026-09-30
 *  evening): strips redundant derivations — same-conclusion chains whose
 *  premises add nothing a leaner kept chain doesn't already derive. Pure
 *  over the input list; the caller owns the ledger rewrite. Exported for
 *  tests.
 *
 *  Same (premises, conclusion) lines are ONE logical chain (read-time
 *  merge semantics) — a key is kept or dropped as a whole, every
 *  provenance line with it. */
export function simplifyChains(lines: GraphChain[]): GraphChain[] {
	if (lines.length < 2) return lines;

	// Group lines by chain key (logical chains).
	const groups = new Map<string, GraphChain[]>();
	for (const line of lines) {
		const key = chainKey(line.premises, line.conclusion);
		const bucket = groups.get(key);
		if (bucket === undefined) groups.set(key, [line]);
		else bucket.push(line);
	}

	// Ancestry over the FULL chain set: every node id reachable as a
	// premise behind an id (A⟹X makes A an ancestor of X; [X,C]⟹Y makes
	// both A and C ancestors of Y). Memoized walk, cycle-guarded (a cycle
	// cannot be minted by the extractor — a premise equal to the
	// conclusion is refused — but the walk stays honest if one ever lands).
	const premisesOf = new Map<string, string[][]>();
	for (const line of lines) {
		const bucket = premisesOf.get(line.conclusion);
		if (bucket === undefined) premisesOf.set(line.conclusion, [line.premises]);
		else bucket.push(line.premises);
	}
	const ancestryMemo = new Map<string, Set<string>>();
	const ancestry = (id: string, visiting: Set<string>): Set<string> => {
		const memo = ancestryMemo.get(id);
		if (memo !== undefined) return memo;
		const out = new Set<string>();
		if (visiting.has(id)) return out;
		visiting.add(id);
		for (const premises of premisesOf.get(id) ?? []) {
			for (const premise of premises) {
				out.add(premise);
				for (const ancestor of ancestry(premise, visiting)) out.add(ancestor);
			}
		}
		visiting.delete(id);
		ancestryMemo.set(id, out);
		return out;
	};

	// Per conclusion: greedy in (premiseCount, createdAt, key).
	const byConclusion = new Map<
		string,
		Array<{ key: string; premises: string[]; createdAt: string }>
	>();
	for (const [key, bucket] of groups) {
		const head = bucket[0]!; // the representative — its premises stand
		const entry = { key, premises: head.premises, createdAt: head.createdAt };
		const list = byConclusion.get(head.conclusion);
		if (list === undefined) byConclusion.set(head.conclusion, [entry]);
		else list.push(entry);
	}
	const droppedKeys = new Set<string>();
	for (const candidates of byConclusion.values()) {
		candidates.sort(
				(a, b) =>
					a.premises.length - b.premises.length ||
					a.createdAt.localeCompare(b.createdAt) ||
					a.key.localeCompare(b.key),
		);
		const kept: typeof candidates = [];
		for (const candidate of candidates) {
			const candidateSet = new Set(candidate.premises);
			const redundant = kept.some((k) => {
					// Rule 1 — prefer-fewest-premises: strict subset (equal keys are
					// grouped, so a kept ⊆ candidate with fewer premises is strict).
					if (k.premises.every((p) => candidateSet.has(p))) return true;
					// Rule 2 — ancestry-cover: every candidate premise is a kept
					// premise, or reachable behind one.
					const covered = new Set(k.premises);
					for (const p of k.premises) {
						for (const ancestor of ancestry(p, new Set())) covered.add(ancestor);
					}
					return candidate.premises.every((p) => covered.has(p));
			});
			if (redundant) droppedKeys.add(candidate.key);
			else kept.push(candidate);
		}
	}
	if (droppedKeys.size === 0) return lines;
	return lines.filter((line) => !droppedKeys.has(chainKey(line.premises, line.conclusion)));
}

// ─── derivation (reads only — everything below is recomputable) ─────────────

/** The merged STORED truth: propositions + chains (chains-primary, owner
 *  2026-09-30). `nodes` are PROPOSITIONS ONLY — no derived implication
 *  nodes; the auditor's and prober's views see the world, not the
 *  rendering. The canvas-facing VIEW (implication nodes + untyped
 *  arrows) is deriveView() below — the lossy image. */
export interface DerivedGraph {
	nodes: GraphNode[];
	chains: GraphChain[];
}

/**
 * The whole graph from the ledgers. Node LINES may repeat an id (link-
 * appends): the FIRST line defines name/statement/createdAt; later
 * lines' statements and aliases join `aliases`, provenance unions — the
 * name never changes after creation. Chain LINES are assertions, merged
 * by (premises, conclusion) with unioned provenance; the first line's
 * arg_ id / premises / createdAt are the chain's identity.
 * `store events, derive state` — this is the only reader that matters.
 */
export function getGraph(graphStore: Pick<GraphStore, "readNodes" | "readChains">): DerivedGraph {
	// Merge node lines by id (first line defines; later lines add phrasings).
	const byId = new Map<string, GraphNode>();
	for (const line of graphStore.readNodes()) {
		const existing = byId.get(line.id);
		if (!existing) {
			byId.set(line.id, { ...line, aliases: [...line.aliases], provenance: [...line.provenance] });
			continue;
		}
		// A later line's statement is a phrasing, not a replacement.
		for (const phrasing of [line.statement, ...line.aliases]) {
			if (phrasing.length > 0 && !existing.aliases.includes(phrasing)) existing.aliases.push(phrasing);
		}
		for (const pt of line.provenance) {
			if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
		}
	}

	// Merge chain assertion lines by (premises, conclusion): the first
	// line's id/premises/createdAt stand, provenance unions.
	const chains: GraphChain[] = [];
	const byKey = new Map<string, GraphChain>();
	for (const line of graphStore.readChains()) {
		const key = chainKey(line.premises, line.conclusion);
		const existing = byKey.get(key);
		if (existing) {
			for (const pt of line.provenance) {
				if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
			}
		} else {
			const chain: GraphChain = { ...line, premises: [...line.premises], provenance: [...line.provenance] };
			byKey.set(key, chain);
			chains.push(chain);
		}
	}
	return { nodes: [...byId.values()], chains };
}

/** The DERIVED view — what the canvas renders. A SINGLE-premise chain
 *  collapses to ONE direct arrow premise → conclusion (no imp node:
 *  a chain is always N-in/1-out, so one premise is the degenerate
 *  1-in-1-out case). A MULTI-premise chain mints an implication NODE
 *  (id = the chain's arg_ id; name "⟹"; statement = the chain line;
 *  the chain's provenance/createdAt) plus arrows: each premise → the
 *  implication node, the implication node → the conclusion — the
 *  canvas renders imp nodes as pure geometry (owner, rendering arc:
 *  invisible, unpickable; co-premise lines converge headless to a
 *  point, one arrowed line leaves it). Physics keeps imp nodes as
 *  regular citizens (half link distance — layout.ts). Dangling chains
 *  (a member node missing) drop here — the deletion cascades should
 *  prevent them; this is the honest belt. */
export function deriveView(graph: DerivedGraph): {
	nodes: GraphNode[];
	edges: GraphEdge[];
	logicalEdges: GraphEdge[];
	impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
} {
	const names: Record<string, { name: string }> = {};
	for (const node of graph.nodes) names[node.id] = { name: node.name };
	const live = new Set(graph.nodes.map((node) => node.id));
	const impNodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	// The LOGICAL edge set (owner, 2026-09-30): every chain contracted to
	// direct premise→conclusion arrows over PROPOSITION ids only —
	// what inference semantics (the depth pass) consumes. The drawn edges
	// are the canvas image; these are the meaning.
	const impLinks: Array<{ id: string; premises: string[]; conclusion: string }> = [];
	const logicalEdges: GraphEdge[] = [];
	const logicalSeen = new Set<string>();
	const emitLogical = (from: string, to: string): void => {
		const key = from + "\u0000" + to;
		if (logicalSeen.has(key)) return;
		logicalSeen.add(key);
		logicalEdges.push({ from, to });
	};
	for (const chain of graph.chains) {
		if (!live.has(chain.conclusion) || !chain.premises.every((premise) => live.has(premise))) continue;
		for (const premise of chain.premises) emitLogical(premise, chain.conclusion);
		// Single premise: the argument IS a plain arrow — no geometry
		// point needed (the 1-in/1-out collapse; rendering arc, owner).
		if (chain.premises.length === 1) {
			edges.push({ from: chain.premises[0]!, to: chain.conclusion });
			continue;
		}
		impNodes.push({
			id: chain.id,
			name: "⟹",
			statement: formatChainLine(chain, names),
			aliases: [],
			createdAt: chain.createdAt,
			provenance: [...chain.provenance],
		});
		// The junction's linkage — what the depth pass needs for the
		// midpoint anchor (owner, 2026-09-30).
		impLinks.push({ id: chain.id, premises: [...chain.premises], conclusion: chain.conclusion });
		for (const premise of chain.premises) edges.push({ from: premise, to: chain.id });
		edges.push({ from: chain.id, to: chain.conclusion });
	}
	return { nodes: [...graph.nodes, ...impNodes], edges, logicalEdges, impLinks };
}

// ─── /api/graph 接口的有效载荷 (payload) ──────────────────────────────────────────────────

/** 通过一次 fetch 获取主页图形视图所需要的一切数据 (数据形状参见：contracts 契约)。 */
export function graphSnapshot(deps: GraphDeps): GraphSnapshot {
	const graph = getGraph(deps.graphStore);
	// 面向画布的有损视图映射：命题 (propositions) + 派生出的蕴含关系节点 (implication nodes) 以及无类型箭头。
	// `chains` (存储的真实数据) 随数据一同返回以供推理链表格使用 —
	// 表格直接读取真相(truth)，绝不读取派生出的扇出(fan-out)数据。
	const view = deriveView(graph);
	const nodes = view.nodes;

	const nodeChats = new Map<string, Set<string>>();
	const touch = (nodeId: string, chatId: string): void => {
		let chats = nodeChats.get(nodeId);
		if (!chats) {
			chats = new Set();
			nodeChats.set(nodeId, chats);
		}
		chats.add(chatId);
	};
	for (const node of nodes) {
		for (const pt of node.provenance) touch(node.id, pt.chatId);
	}
	// 为图(graph)可以指向的每一个数据源提供标签：包括真实的聊天
	// (聊天标题，支持深度链接 deep-linkable) 以及导入的笔记文件
	// (文件路径，静态的 — 这是与格式无关的入口点数据溯源)。
	const sourceIds = new Set<string>();
	for (const chats of nodeChats.values()) {
		for (const id of chats) sourceIds.add(id);
	}
	const sessions: Record<string, string> = {};
	const fileSources: Record<string, string> = {};
	for (const id of sourceIds) {
		const chat = deps.chatStore.getChat(id);
		if (chat) {
			sessions[id] = chat.title;
			continue;
		}
		const source = deps.graphStore.readSources().find((s) => s.id === id);
		if (source) fileSources[id] = source.filePath;
	}

	const nodeSessions: Record<string, string[]> = {};
	for (const [nodeId, chats] of nodeChats) {
		const ids = [...chats].filter((id) => sessions[id] !== undefined || fileSources[id] !== undefined);
		if (ids.length > 0) nodeSessions[nodeId] = ids;
	}

	// 基于“诞生会话”的聚类 (wave 7，由所有者锁定于 2026-09-23)：
	// 向量嵌入方案(embeddings)已被废弃 — 现在的聚类就是“创建了这些命题的会话”，
	// 在读取时根据出处信息(provenance)进行派生 (参见 core/session-clusters.ts)。
	// 聚类的标签就是该会话的名字 (聊天标题 / 文件路径)：不再需要大模型(LLM)去生成名字，
	// 也不再有持久化的分区数据需要处理失效逻辑。MIN_CLUSTER_SIZE 依然是用于控制外壳(hull)的
	// 展示规则 (一个区域 >= 3 个命题才值得画外壳)。
	// 如果某个诞生会话的记录已丢失 (比如聊天被删了)，它的成员仍会保留但会渲染为无标签状态 —
	// 诚实展示，绝不瞎猜。
	// 【仅限命题 (PROPOSITIONS ONLY)】 (所有者规则，2026-09-30)：派生出的蕴含关系节点
	// (implication nodes) 绝不参与划分 — 由存储的世界决定聚类，视图仅仅是跟随。
	const communities = birthSessionPartition(graph.nodes);
	const clusters: Cluster[] = communities
		.filter((community) => community.members.length >= MIN_CLUSTER_SIZE)
		.map((community) => ({
			id: community.id,
			label: sessions[community.id] ?? fileSources[community.id] ?? null,
			members: community.members,
		}));
	// 蕴含节点 (IMP-NODE) 的聚类分配 (所有者规则，2026-09-30)：
	// 基于前提节点所处诞生会话的多数票决定，平票时依据链自身的诞生时间处理 —
	// 这个操作发生在“外壳过滤器 (hull filter)”之后，因此一个 2 命题的社区 + 它的附属链
	// 绝对不会“复活”触发外壳渲染 (因为过滤器只计算命题数)。
	// 消费聚类成员关系的两方 (物理模拟(sim)的质心拉力 和 画布的区域栅格化)
	// 都会通过这唯一一个列表读取该信息。
	attachImpToCommunities(clusters, graph.nodes, graph.chains);

	// 静止布局(Resting layout) (选项 A)：位置账本 (当结算 settling 曾经运行过时)。
	// 在一个全新的图表上它是不存在的 — 视图会回退到它自己的一次性排版计算，
	// 直到第一次数据合并操作将位置写入账本。
	const positions = deps.graphStore.readPositions();

	return {
		nodes,
		propositions: graph.nodes,
		edges: view.edges,
		logicalEdges: view.logicalEdges,
		impLinks: view.impLinks,
		chains: graph.chains,
		sessions,
		fileSources,
		nodeSessions,
		clusters,
		...(Object.keys(positions).length > 0 ? { positions } : {}),
	};
}

// ─── 探针图工具 (Prober graph tools) — 数据接缝 (wave 7，由所有者锁定于 2026-09-23) ───

/**
 * 探针图视图中的一个会话 (GraphSessionEntry)：代表图中能够命名的所有数据溯源锚点 —
 * 可以是一个真实的聊天 (支持深度链接) 或是一个导入的笔记文件
 * (所有者 2026-09-23 裁决：文件同样也被视为“诞生会话”，其 kind 为 "file")。
 * 探针的会话列表工具负责渲染它们；按会话查看详情视图由下方的 graphSessionPropositions 提供。
 * 这是完全通过和 snapshot 相同的读取端口派生而出的纯逻辑 —
 * 教师 (Teacher) 的工具处理程序在进程内调用它们。
 */
export interface GraphSessionEntry {
	/** chatId 或笔记数据源的 id (如 "src_…") — 它是诞生会话的唯一键。 */
	id: string;
	/** 聊天的标题，或文件的路径 — 也就是聚类标签的来源。 */
	name: string;
	/** 标识这是一个真实的聊天 (记录仍然存在) 还是导入的笔记文件。 */
	kind: "chat" | "file";
	/** 该会话开始的时间：即聊天的 createdAt，或文件的 importedAt。
	 *  当没有记录可以证明其日期时为 null。 */
	createdAt: string | null;
	/** 最近的活动时间：即聊天的 updatedAt，或文件的 importedAt。
	 *  当没有记录可以证明其日期时为 null。 */
	updatedAt: string | null;
	/** 有多少个命题是诞生 (BORN) 在该会话中的 (基于诞生会话聚类逻辑的计数 —
	 *  共享/再次相遇的节点只计算在其原始诞生会话中)。 */
	propositions: number;
}

/**
 * 探针的会话列表：返回每个诞生会话，按照“最近活跃”排序靠前
 * (无法确定日期的记录会沉到底部，并按 id 保持稳定的顺序)。
 * @param deps 图数据依赖端口
 * @returns 会话列表数组
 */
export function graphSessionIndex(deps: GraphDeps): GraphSessionEntry[] {
	const counts = new Map<string, number>();
	const born = getGraph(deps.graphStore);
	for (const cluster of birthSessionPartition(born.nodes)) {
		counts.set(cluster.id, cluster.members.length);
	}
	const chats = new Map(deps.chatStore.listChats().map((chat) => [chat.id, chat]));
	const sources = new Map(deps.graphStore.readSources().map((s) => [s.id, s]));
	const entries: GraphSessionEntry[] = [];
	for (const [id, propositions] of counts) {
		const chat = chats.get(id);		if (chat) {
			entries.push({
				id,
				name: chat.title,
				kind: "chat",
				createdAt: chat.createdAt,
				updatedAt: chat.updatedAt,
				propositions,
			});
			continue;
		}
		const source = sources.get(id);
		entries.push({
			id,
			name: source?.filePath ?? id,
			kind: "file",
			createdAt: source?.importedAt ?? null,
			updatedAt: source?.importedAt ?? null,
			propositions,
		});
	}
	return entries.sort(
		(a, b) =>
			(b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
			(b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
			(a.id < b.id ? -1 : 1),
	);
}

/**
 * 某个会话下诞生的单个命题 — 也就是该会话曾涉及(COVERED)的知识点
 * (2026-09-27 整理说明：这里不包含理解程度/掌握度；那是评估模块的领域，
 * 在该模块建立之前不会有任何代码尝试写入它)。
 */
export interface GraphSessionProposition {
	nodeId: string;
	/** 紧凑的展示句柄 — 也就是画布上显示的名字。 */
	name: string;
}

/**
 * 诞生 (BORN) 于特定某个会话中的命题 — 即该会话首次阐明的知识点。
 * 成员列表会根据 node id 进行排序 — 保证输出的确定性 (deterministic)。
 * @param deps 图数据依赖端口
 * @param sessionId 会话的唯一 ID
 * @returns 命题数组
 */
export function graphSessionPropositions(deps: GraphDeps, sessionId: string): GraphSessionProposition[] {
	const born = getGraph(deps.graphStore).nodes.filter((node) => birthSessionOf(node) === sessionId);
	return born
		.map((node) => ({ nodeId: node.id, name: node.name }))
		.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
}

// Re-export: the contract owns the shape; legacy importers still reach it.
export type { EmissionStats };


