/**
 * 图谱家族格式印记 (FORMAT STAMP) (schema-versioning wave, owner 2026-10-10):
 * data/graph/format.json — 一个独立的伴随文件 (sidecar)，用于对整个 graph 目录
 * 家族进行版本控制（包括四个 JSONL 账本文件，sources.json，以及 render-settings.json）。
 * 由于 JSONL 账本如果每行都内联印记会导致严重的数据膨胀，同时各 JSON 文件与整个家族的命运
 * 绑定，因此版本印记文件与它们放在同级目录。
 * positions.json 是可重建的（所有者决定），因此不需要这种保护。
 *
 * 约定 (The contract):
 *  - 惰性 v1 (LAZY v1): 没有伴随文件 = v1 版（印记机制出现前的旧数据永远保持有效）；
 *    对图谱家族的第一次“写入”会创建它。纯读取操作永远不会进行写入。
 *  - 诚实拒绝原则 (Honest refusal) (owner: refuse-honestly ruling):
 *    如果伴随文件记录的版本戳比当前应用构建版本更“新”（即降级场景 — 用户回退了
 *    应用程序版本），则图谱家族的读取操作会“抛出异常 (THROW)”。
 *    “读取-修改-写入 (Read-modify-write)” 的存储绝不能重写它们无法理解的数据；
 *    账本存储 (ledger store) 也绝不能默默跳过那些它无法解析为当前格式数据的行。
 *
 * 版本常量存放处: contracts/graph.ts 中的 CURRENT_GRAPH_FORMAT_VERSION。
 */

import fs from "node:fs";
import path from "node:path";
import { GRAPH_FORMAT_FILE } from "../../config.ts";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../core/contracts/graph.ts";

/**
 * 获取当前记录的版本戳。
 * @returns 整数版本号，如果文件不存在或解析失败则返回 null。
 */
function stampedVersion(): number | null {
	let raw: string;
	try {
		raw = fs.readFileSync(GRAPH_FORMAT_FILE, "utf-8");
	} catch {
		return null; // 没有伴随文件 — 属于惰性 v1 (印记出现前) 的世界
	}
	try {
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : null;
	} catch {
		return null; // 损坏的伴随文件被视为无印记 (v1)，不是致命错误
	}
}

/**
 * 读取端守卫 (READ-SIDE GUARD)：当数据目录由更新版本的应用构建写入时抛出异常。
 * 每一个图谱家族的读取操作都会调用它 — 绝不会进行写入（黄金测试固定数据 (golden fixtures)
 * 强制要求读取必须是字节一致的）。
 */
export function assertGraphFormat(): void {
	const v = stampedVersion();
	if (v !== null && v > CURRENT_GRAPH_FORMAT_VERSION) {
		throw new Error(
			`图谱数据版本戳为格式版本 ${v}，但当前应用构建仅支持 ${CURRENT_GRAPH_FORMAT_VERSION}。` +
				"当前应用版本老于其数据 — 在操作知识图谱之前，请先升级应用。",
		);
	}
}

/**
 * 写入端印记 (WRITE-SIDE STAMP)：在图谱家族发生首次写入时创建伴随文件
 * (采用惰性模式)；在这之后，只要文件存在就相当于空操作 (no-op)。
 * 调用者负责维护自己的 mkdir。
 */
export function ensureGraphFormat(): void {
	if (stampedVersion() !== null) return;
	fs.mkdirSync(path.dirname(GRAPH_FORMAT_FILE), { recursive: true });
	fs.writeFileSync(GRAPH_FORMAT_FILE, JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION }, null, "\t") + "\n", "utf-8");
}
