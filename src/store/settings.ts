/**
 * THE (唯一的) 用户设置记录的服务器端持久化 (settings-storage wave, 2026-09-19):
 * 存储于 data/settings.json (对应 config.SETTINGS_FILE)，位于 LH_DATA_DIR 的隔离边界下 —
 * 采用“读取-修改-写入 (read-modify-write)” 模式，而非账本 (NOT a ledger)。
 * 这里仅存储非机密的产品偏好设置；机密信息 (secrets) 保留在 auth.json 或 .env.local 中。
 *
 * 该适配器拥有 (OWNS) 惰性迁移 (lazy migrations) 的职责：
 *  1. 数据结构版本 (schema-version) 的升级逻辑 (对应 CURRENT_SETTINGS_VERSION) 会插在这里 —
 *     目前的迁移链是空的 (v1 是第一个结构版本)；纯新增字段的操作永远不会触发版本升级，
 *     因此对于已经是最新版本的文件来说，这里永远是直接透传 (no-op pass-through)。
 *    (传统的 default-settings.json 机制已经随着聊天配置的改版而消亡 —
 *     现在模型是基于每会话单独配置的，owner 2026-09-28。)
 *
 * 从磁盘读取的所有内容在交付给调用者之前，都会被清理并校验 (通过 core/settings.ts)；
 * 所有准备写入的内容在路由层 (settings-body.ts) 已经过验证，并且在这里会再次被清理 —
 * 这确保了文件中绝不会包含任何能够导致设置旋钮 (knob) 发生意外偏移的非法值。
 */

import fs from "node:fs";
import path from "node:path";
import { SETTINGS_FILE } from "../../config.ts";
import {
	sanitizeUserSettings,
	type UserSettings,
} from "../core/settings.ts";
import type { SettingsStore } from "../core/ports.ts";

/**
 * 读取持久化的设置记录。当文件不存在 (首次启动) 时返回 null。
 * 每次读取都会执行迁移链 (migration chain) — 由于对于最新版本的文件只做空检查，因此开销极低。
 */
export function readSettings(): UserSettings | null {
	let raw: string;
	try {
		raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
	} catch {
		return null; // settings.json 尚不存在 — 首次启动，应用所有出厂默认设置
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null; // 文件损坏 → 采用首次启动的语义 (应用所有出厂默认设置)
	}
	const record = sanitizeUserSettings(parsed);
	if (!record) return null;
	// 版本迁移链 (目前为空): 未来的 v2 迁移逻辑会放在这里 —
	// 例如 `if (record.version > CURRENT_SETTINGS_VERSION) …`。
	// 未知的、更新的版本 (NEWER versions) 会原封不动地透传 (清理函数会保留这些未知字段)。
	return record;
}

/**
 * 持久化记录 (写入前会进行数据清理)。返回实际写入的内容。
 */
export function writeSettings(raw: unknown): UserSettings {
	const settings = sanitizeUserSettings(raw);
	if (!settings) throw new Error("settings record must be a JSON object");
	fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, "\t"), "utf-8");
	return settings;
}

/**
 * 类型化的适配器 (对应 core/ports.ts 中的 SettingsStore)，用于组合根 (composition root)。
 */
export const settingsStore: SettingsStore = {
	readSettings,
	writeSettings,
};
