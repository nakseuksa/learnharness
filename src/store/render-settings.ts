/**
 * 图谱渲染设置 (设置面板控件) 的服务器端持久化：位于 data/render-settings.json —
 * 采用“读取-修改-写入 (read-modify-write)” 模式，它**不是**一个账本 (NOT a ledger)。
 *
 * 数据结构的定义、默认值以及数据清理函数 (sanitizer) 位于 src/core/render-settings.ts 中
 * (它是纯函数，与客户端共享)；本模块只负责搬运字节 (moves bytes)。
 * 无论从磁盘读取出什么内容，调用者都会在加载时对其进行清理和校验 — 并且在写入时
 * 也会进行清理，因此该文件永远不会保存可能导致滑块异常偏移的越界值。
 */

import fs from "node:fs";
import path from "node:path";
import { RENDER_SETTINGS_FILE } from "../../config.ts";
import { DEFAULT_RENDER_SETTINGS, sanitizeRenderSettings, type GraphRenderSettings } from "../core/render-settings.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";

/**
 * 读取持久化的设置。当文件尚未建立 (即首次启动) 时返回 null。
 */
export function readRenderSettings(): GraphRenderSettings | null {
	assertGraphFormat(); // 基于较新版本戳数据目录的诚实拒绝 (honest refusal)
	let raw: string;
	try {
		raw = fs.readFileSync(RENDER_SETTINGS_FILE, "utf-8");
	} catch {
		return null; // 尚未启动过 / 文件不可读 → 调用者将使用默认值
	}
	try {
		return sanitizeRenderSettings(JSON.parse(raw));
	} catch {
		return null; // 文件损坏 → 返回 null 以使用默认值，绝不能让视图崩溃
	}
}

/**
 * 持久化设置 (写入前会进行数据清理)。返回实际写入的清理后的设置对象。
 */
export function writeRenderSettings(raw: unknown): GraphRenderSettings {
	const settings = sanitizeRenderSettings(raw);
	fs.mkdirSync(path.dirname(RENDER_SETTINGS_FILE), { recursive: true });
	ensureGraphFormat(); // 惰性格式印记 (graph-format.ts)
	fs.writeFileSync(RENDER_SETTINGS_FILE, JSON.stringify(settings, null, "\t"), "utf-8");
	return settings;
}

export { DEFAULT_RENDER_SETTINGS };
