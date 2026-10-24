/**
 * 提示词覆盖存储层 (prompt-override STORE) (settings-storage wave, 2026-09-19; P2 对账同日进行):
 * 这是提供核心端口支持的、覆盖文件的增删改查 (CRUD) 实现 —
 * 在 config.PROMPTS_OVERRIDE_DIR 目录下进行 list (列表)、read (读取)、write (写入) 和 delete (删除)。
 *
 * 权威的 (CANONICAL) 提示词段落发现与解析逻辑 (包括 listSourceSegments,
 * effectivePromptSegments, allSegmentPaths) 位于代理层 (agent layer)
 * (src/agent/prompt-segments.ts) — 提示词的组装 (composition) 属于代理层的职责，
 * 架构法则严格隔离了这些层级 (store 绝对不能引入 agent；agent 也绝对不能引入 store)。
 * 两端都共享了位于 core 的纯路径语法 (pure path grammar, 详见 src/core/prompt-segments.ts)；
 * store 的 readOverride 和 agent 的 readPromptOverride 读取的是完全相同的镜像布局。
 *
 * 提示词段落 (SEGMENTS): 一个提示词由共享的基础部分 (src/agent/system-prompt.md)、
 * shared/ 目录下的片段 (由多个代理共同组装) 以及各代理自身目录下带有数字前缀的 *.md
 * 片段组成 — 完整规则请参阅 agent 模块。
 *
 * 覆盖机制 (OVERRIDES): 覆盖文件在 config.PROMPTS_OVERRIDE_DIR 下镜像了原始源码目录布局 —
 * 根目录下的 "system-prompt.md"，以及 "shared/<file>", "teacher/<file>" 或 "prober/<file>"
 * (使用 POSIX 相对路径，这与设置记录中 agent.prompts 的开关键是一致的)。
 * 文件的**存在**并不意味着它被采用为覆盖：生效与否是由开关决定的 (所有者决定) —
 * 用户可以保留他们编写的覆盖文件，并随意切换回源码默认值来进行对比。
 *
 * 路径纪律 (Path discipline): 只能操作覆盖目录下的 .md 文件，严禁路径遍历
 * (不得包含 "..", 绝对路径或空的路径分段) — 任何指向镜像布局之外的手动构造路径都会被拒绝
 * (返回 null 或执行无操作 no-op)，绝不会被写入。
 */

import fs from "node:fs";
import path from "node:path";
import { PROMPTS_OVERRIDE_DIR } from "../../config.ts";
import { isValidSegmentPath } from "../core/prompt-segments.ts";
import type { PromptOverrideStore } from "../core/ports.ts";

/**
 * 根据段落路径获取覆盖文件的绝对路径 (未经过滤 — 调用前需进行验证)。
 */
function overrideFileFor(segmentPath: string): string {
	return path.join(PROMPTS_OVERRIDE_DIR, ...segmentPath.split("/"));
}

/**
 * 存储层适配器 (对应 core/ports.ts 中的接口)。
 */
export const promptOverrides: PromptOverrideStore = {
	listOverrides(): string[] {
		const out: string[] = [];
		const walk = (dir: string, prefix: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return; // no dir yet = no overrides
			}
			for (const entry of entries) {
				const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
				else if (entry.isFile() && entry.name.endsWith(".md") && isValidSegmentPath(rel)) out.push(rel);
			}
		};
		walk(PROMPTS_OVERRIDE_DIR, "");
		return out.sort();
	},

	/** 读取指定段落路径的覆盖文件内容，路径非法或文件不存在时返回 null。 */
	readOverride(segmentPath: string): string | null {
		if (!isValidSegmentPath(segmentPath)) return null;
		try {
			return fs.readFileSync(overrideFileFor(segmentPath), "utf-8");
		} catch {
			return null;
		}
	},

	/** 写入覆盖文件，会自动创建缺失的目录。路径非法时执行空操作。 */
	writeOverride(segmentPath: string, text: string): void {
		if (!isValidSegmentPath(segmentPath)) return;
		const file = overrideFileFor(segmentPath);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text, "utf-8");
	},

	/** 删除覆盖文件。若文件本身已不存在则视作成功。 */
	deleteOverride(segmentPath: string): void {
		if (!isValidSegmentPath(segmentPath)) return;
		try {
			fs.unlinkSync(overrideFileFor(segmentPath));
		} catch {
			// 文件原本就不存在 = 删除完成
		}
	},
};
