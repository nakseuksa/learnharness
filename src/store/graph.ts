/**
 * GraphStore — 基于文件系统的 JSONL 适配器：位于 config.LEDGER_FILES
 * 的仅追加 (append-only) 账本 (对应 contracts.ts 中的 "v1 emission")。
 *   nodes.jsonl     GraphNode        — 每次节点写入占一行：同一 ID 的**第一行**定义该节点；
 *                                      之后带有**重复** ID 的行表示一次链接追加 (link-append)
 *                                      (会话措辞会被加入到 aliases 中，出处(provenance)会进行合并)；
 *                                      读取时会根据 ID 进行合并 (详见 core/graph.ts 中的 getGraph)
 *   chains.jsonl    GraphChain       — 每次推理链断言 (chain ASSERTION) 占一行 (如果有第二个会话
 *                                      断言了相同的 (premises, conclusion) 前提与结论，则会追加
 *                                      新的一行；读取器负责合并它们)
 *   sessions.jsonl  SessionCheckpoint— 提取生成的检查点记录 (包含 foldedAt)
 *   coverage.jsonl  CoverageEntry    — 每条消息对应的提取覆盖率 (extraction coverage) 数据
 *
 * CHAINS-PRIMARY (推理链主导原则) (owner, 2026-09-30): **没有**边 (edges) 账本 — 边视图
 * (包含 implication 节点和无类型箭头) 是每次读取时在 core/graph.ts 中计算得出的，永远不会持久化。
 * 适配器加载时，会在此处一次性清理掉由引入推理链功能前 (pre-chains) 的旧版本遗留下来的
 * 废弃的 edges.jsonl 文件 (这与下方清理 events-ledger 的规范相同)。
 *
 * 另外还有 config.SOURCES_FILE (sources.json): 导入笔记的簿记文件
 * (这**不是**账本) — 它是一个简单的 JSON 映射: src-id → NotesSource，
 * 采用类似聊天文件的“读取-修改-写入”模式。这是独立于格式的统一入口 (2026-09-13)。
 *
 * 实现了 core/ports.ts 中的 GraphStore 接口。 data/graph/* 目录完全由该适配器独占管理。
 * 读取操作严格遵循 contracts.ts 定义的形状 (基于 2026-09-02 的图谱重构)：损坏的行会被跳过，
 * 绝不会进行猜测 — 账本是唯一的真相来源 (source of truth)，其他一切数据均由此推导而来
 * (由接收该端口作为参数的 core/graph.ts 负责推导)。
 * 编程风格与 src/store/chats.ts 相同：采用同步的文件系统操作，不依赖任何框架。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LEDGER_FILES, POSITIONS_FILE, SOURCES_FILE } from "../../config.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import type {
	GraphChain,
	GraphNode,
	ExtractionRunUsage,
	NotesSource,
	Position,
	ProvenancePoint,
	CoverageEntry,
	SessionCheckpoint,
} from "../core/contracts.ts";
import type { GraphStore } from "../core/ports.ts";

// ─── JSONL 基础操作原语 (JSONL primitives) ────────────────────────────────────────────────────────

function appendLine<T>(file: string, record: T): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	ensureGraphFormat(); // 惰性格式印记 (graph-format.ts)
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
}

function readRawLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return []; // 尚未建立账本 — 从未进行过数据生成 (emission)
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// 损坏的行：直接跳过，而不是让整个读取操作失败 —
			// 一次被截断 (torn) 的追加操作绝不能让整个基础图谱崩溃。
		}
	}
	return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const isString = (v: unknown): v is string => typeof v === "string";

/**
 * 严格的数据结构守卫 (Strict shape guards) — 任何不符合 W4 账本结构的行都会被跳过。
 */
function readValid<T>(file: string, isValid: (v: unknown) => v is T): T[] {
	assertGraphFormat(); // 基于较新版本戳数据目录的诚实拒绝 (honest refusal)
	return readRawLines(file).filter(isValid);
}

/**
 * 数据出处点 (Provenance points) 是由 (chatId, messageId) 组成的元组 — 具备消息级别的颗粒度。
 */
const isProvenancePoint = (v: unknown): v is ProvenancePoint =>
	isRecord(v) && isString(v.chatId) && isString(v.messageId);


const isGraphNode = (v: unknown): v is GraphNode =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

/**
 * 推理链的单行数据：premises (前提) ≥ 1 (一个 chain 就是一个论点论证 — 而那些孤立的命题
 * 仅单独存在于节点账本 (node ledger) 中)，其中每个成员必须是字符串，且 conclusion (结论) 也是字符串。
 * 端点是否存在的校验 (Endpoint EXISTENCE) 是数据推导层 (derivation) 的责任 (它会丢弃孤立悬空的链)；
 * 存储层这里只负责校验数据形态 (shapes)。
 */
const isGraphChain = (v: unknown): v is GraphChain =>
	isRecord(v) &&
	isString(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isString) &&
	isString(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint) &&
	isString(v.createdAt);

const isCheckpoint = (v: unknown): v is SessionCheckpoint =>
	isRecord(v) && isString(v.chatId) && isString(v.foldedAt);

const isCoverageEntry = (v: unknown): v is CoverageEntry =>
	isRecord(v) && isString(v.chatId) && isString(v.fp) && typeof v.tokens === "number" && isString(v.foldedAt);

// ─── 端口实现 (the port implementation) ────────────────────────────────────────────────

export const graphStore: GraphStore = {
	appendNode(node: GraphNode): void {
		appendLine(LEDGER_FILES.nodes, node);
	},
	/**
	 * 按照追加顺序返回原始的节点行数据。同一个节点 ID 可能会出现在多行中
	 * (例如后来的会话进行了 LINK-append：追加了措辞 phrasing 和出处 provenance)；
	 * 数据推导层 (core/graph.ts getGraph) 会负责按 ID 对行进行合并。
	 */
	readNodes(): GraphNode[] {
		return readValid(LEDGER_FILES.nodes, isGraphNode);
	},

	/**
	 * 追加一个推理链断言 (chain ASSERTION)；读取器会按 (premises, conclusion) 进行合并。
	 */
	appendChain(assertion: GraphChain): void {
		appendLine(LEDGER_FILES.chains, assertion);
	},
	readChains(): GraphChain[] {
		return readValid(LEDGER_FILES.chains, isGraphChain);
	},

	appendCheckpoint(checkpoint: SessionCheckpoint): void {
		appendLine(LEDGER_FILES.sessions, checkpoint);
	},
	readCheckpoints(): SessionCheckpoint[] {
		return readValid(LEDGER_FILES.sessions, isCheckpoint);
	},

	appendCoverage(entry: CoverageEntry): void {
		appendLine(LEDGER_FILES.coverage, entry);
	},
	readCoverage(): CoverageEntry[] {
		return readValid(LEDGER_FILES.coverage, isCoverageEntry);
	},

	// ── 导入笔记簿记 (imported-notes bookkeeping, config.SOURCES_FILE — 一个 JSON 映射) ──

	/**
	 * 插入或更新 (Upsert): 在重新导入时，保留现有记录的使用日志 (usage log)。
	 */
	upsertSource(source: NotesSource): void {
		const all = readSourceMap();
		const prev = all[source.id];
		all[source.id] = prev ? { ...source, extractions: prev.extractions } : source;
		writeSourceMap(all);
	},
	readSources(): NotesSource[] {
		return Object.values(readSourceMap());
	},
	/**
	 * 按 startedAt 保证幂等性 (Idempotent per startedAt) — 与 chats.appendExtractionUsage 遵循相同的原则。
	 */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): void {
		const all = readSourceMap();
		const source = all[id];
		if (!source) return; // no such source — nothing to bill against
		source.extractions = source.extractions?.some((r) => r.startedAt === entry.startedAt)
			? source.extractions
			: [...(source.extractions ?? []), entry];
		writeSourceMap(all);
	},

	// ── 布局账本 (the layout ledger, config.POSITIONS_FILE — 一个 JSON 映射) ──
	readPositions(): Record<string, Position> {
		return readPositionMap();
	},
	writePositions(positions: Record<string, Position>): void {
		writePositionMap(positions);
	},

	/**
	 * 破坏性接缝 (THE DESTRUCTIVE SEAM) (wave 6 会话删除机制): 对于提供的每个账本进行原子级的完整内容替换 —
	 * 在原账本旁边写入一个具有唯一名称的临时文件，然后将其重命名覆盖原文件 (符合 POSIX 原子性操作：
	 * 若在写入中途发生崩溃，会保留原始账本以及一个孤立的 .tmp-* 临时文件，绝不会出现被破坏截断的账本)。
	 * 空数组会写入一个空文件 — 一个被清空的账本读取时表现为“尚未建立 (nothing yet)”，这与从未生成过数据是等同的。
	 */
	rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
	}): void {
		const files = {
			nodes: LEDGER_FILES.nodes,
			chains: LEDGER_FILES.chains,
			coverage: LEDGER_FILES.coverage,
			checkpoints: LEDGER_FILES.sessions,
		} as const;
		for (const [key, records] of Object.entries(next) as [keyof typeof files, unknown[]][]) {
			const file = files[key];
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
			try {
				// JSONL 格式：每行一条记录，尾部换行 —
				// 读取器必须能看到与使用 appendLine 逐行追加时完全一致的内容。
				const body = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
				fs.writeFileSync(tmp, body, "utf-8");
				fs.renameSync(tmp, file);
			} catch (err) {
				try {
					fs.unlinkSync(tmp);
				} catch {
					/* the rename either already happened or the tmp never existed */
				}
				throw err;
			}
		}
	},
};

/**
 * positions.json — 结构为 { positions, updatedAt }。
 * 它是“读取-修改-写入 (Read-modify-write)” 的，而非“仅追加 (append-only)”：
 * 布局结算 (settle) 是一个全图谱级的计算，因此它会替换整个映射表。
 * updatedAt 戳的存在是为了未来处理实时物理冲突 (live-physics conflict)
 * （浏览器的提交必须能够检测到“底层的图谱已经发生了改变”）；读取时只返回映射表即可。
 */
function readPositionMap(): Record<string, Position> {
	let raw: string;
	try {
		raw = fs.readFileSync(POSITIONS_FILE, "utf-8");
	} catch {
		return {}; // 尚未建立账本 — 从未进行过布局结算
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || !isRecord(parsed.positions)) return {};
		const out: Record<string, Position> = {};
		for (const [id, value] of Object.entries(parsed.positions)) {
			if (isPosition(value)) out[id] = { x: value.x, y: value.y };
		}
		return out;
	} catch {
		return {};
	}
}

function writePositionMap(positions: Record<string, Position>): void {
	fs.mkdirSync(path.dirname(POSITIONS_FILE), { recursive: true });
	// 采用 Tmp + rename (临时文件加重命名) — 与上面的 rewriteLedgers
	// 使用相同的防崩溃安全机制 (a9339b3 UI 标志)：
	// 绝不能让一次被截断的写入操作把一个半成品的空文件替换掉原有的账本。
	const tmp = `${POSITIONS_FILE}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify({ positions, updatedAt: new Date().toISOString() }, null, "\t"), "utf-8");
		fs.renameSync(tmp, POSITIONS_FILE);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* the rename either already happened or the tmp never existed */
		}
		throw err;
	}
}

const isPosition = (v: unknown): v is Position =>
	isRecord(v) && typeof v.x === "number" && Number.isFinite(v.x) && typeof v.y === "number" && Number.isFinite(v.y);

/**
 * sources.json — 结构为 { id: NotesSource }。
 * 它是“读取-修改-写入 (Read-modify-write)”，而非“仅追加”：
 * 使用量日志 (usage log) 保存在记录内部 (类似于聊天的 JSON 文件)。
 */
function readSourceMap(): Record<string, NotesSource> {
	assertGraphFormat(); // 基于较新版本戳数据目录的诚实拒绝 (honest refusal)
	let raw: string;
	try {
		raw = fs.readFileSync(SOURCES_FILE, "utf-8");
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return {};
		const out: Record<string, NotesSource> = {};
		for (const [id, value] of Object.entries(parsed)) {
			if (isNotesSource(value)) out[id] = value;
		}
		return out;
	} catch {
		return {};
	}
}

function writeSourceMap(map: Record<string, NotesSource>): void {
	fs.mkdirSync(path.dirname(SOURCES_FILE), { recursive: true });
	ensureGraphFormat(); // 惰性格式印记 (graph-format.ts)
	fs.writeFileSync(SOURCES_FILE, JSON.stringify(map, null, "\t"), "utf-8");
}

// ─── 适配器加载时的单向清理工作 (one-way purges at adapter load):
// 清理这些废弃的账本正是为了消除困扰 (遵循所有者信条 owner doctrine —
// 它们既不被读取，也不被写入，一个静静躺在那里的废弃文件本身就是一个谎言)。 ────────────────────────────────
{
	const graphDir = path.dirname(LEDGER_FILES.nodes);
	for (const legacy of ["edges.jsonl", "events.jsonl"]) {
		const file = path.join(graphDir, legacy);
		try {
			if (fs.existsSync(file)) {
				fs.rmSync(file);
				console.info(`[graph-store] purged legacy ledger: ${file}`);
			}
		} catch (err) {
			console.warn(`[graph-store] could not purge legacy ledger ${file}:`, err);
		}
	}
}

const isNotesSource = (v: unknown): v is NotesSource =>
	isRecord(v) && isString(v.id) && isString(v.filePath) && isString(v.importedAt);
