/**
 * AuthStore 适配器 (auth-keys wave, 2026-09-19)：
 * 对应 config.AUTH_FILE 中扁平的 {VAR: value} 结构的 auth.json。
 * 这是 Electron 应用程序一直以来手动编辑的同一个文件（所有者决定：
 * 选项 A — 相同的文件，基于环境变量定位，零迁移）。
 * 文件权限为 0600，保证原子写入，支持手动编辑（每次访问时都会重新从磁盘读取该文件）。
 *
 * 服务器端 (src/server/keys.ts) 是唯一的预期写入者：它在调用 setAuthVar 之前
 * 会进行格式验证，并在 authVars() 返回的基础上应用环境变量的优先级。
 * 本适配器负责持久化传入的数据，并且从不抛出异常（文件不存在或损坏则当作 {}，
 * 即“尚未设置密钥”，这符合有据可查的首次启动状态以及设置相关的规范），
 * 并且它会原样保留未知的变量（保证向前兼容：未来可能加入的新条目，例如
 * plans-login 令牌，在被规范条目正式采用前会完好无损地留在文件中）。
 */

import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import type { AuthStore } from "../core/ports.ts";

/**
 * 读取配置字典，返回扁平的 string→string 映射对象。
 * 如果文件缺失、损坏或者内容非对象结构，则返回 {}
 */
function readMap(): Record<string, string> {
	try {
		const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(
			Object.entries(raw).filter(([, v]) => typeof v === "string") as [string, string][],
		);
	} catch {
		return {}; // 缺失或损坏 — 符合文档描述的 "尚未设置密钥 (no keys yet)" 的初始状态
	}
}

/**
 * 以 0600 权限原子化写入字典：部分写入绝对不能留下 0644 的文件（包含秘密信息）
 * 或者截断损坏的 JSON 文件（会导致读取出 "尚未设置密钥"）。
 * 采用在同目录下创建临时文件再重命名的方式来保证替换过程的原子性；
 * 在重命名之前进行 chmod，从而确保在最终路径上不会出现权限宽松的状态。
 */
function writeMap(map: Record<string, string>): void {
	const dir = path.dirname(AUTH_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.auth.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(map, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600); // umask may have relaxed the create mode
	fs.renameSync(tmp, AUTH_FILE);
}

export const authStore: AuthStore = {
	authVars() {
		return readMap();
	},
	setAuthVar(name, value) {
		const map = readMap();
		map[name] = value;
		writeMap(map);
	},
	deleteAuthVar(name) {
		const map = readMap();
		if (!(name in map)) return; // 若不存在则默默成功，保证幂等性 (idempotent)
		delete map[name];
		writeMap(map);
	},
};
