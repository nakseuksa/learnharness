/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
/**
 * 组装并暴露所有已连接的具体存储适配器（实现）。
 * 结构上满足核心领域（如 `core/graph.ts`）依赖所需的接口，
 * 通过单一入口替换此处的导入，即可无缝更换底层的存储实现（比如从 FS 文件系统替换为 SQLite）。
 */
export const stores = {
	chatStore,
	graphStore,
	jobStore,
	settingsStore,
};

export type Stores = typeof stores;

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
/**
 * 获取基于出厂默认值聚合后的全局有效配置。
 * - 该函数在每次调用时都会实时读取并解析配置，不设置任何缓存。
 * - 因为配置文件很小，而且调用频率（按次 turn 或页面加载）较低。实时读取可以避免配置 PUT 后的不一致。
 * - 注意：BYOK 机制（自 2026-09-22 起生效）下的模型选项不提供出厂备用值（无内置提供商）。如果未配置则解析为 null，
 * 由各个具体调用链路下游各自抛出 "未配置" 拒绝。
 *
 * @returns 合并并解析完全的有效配置对象。
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}
