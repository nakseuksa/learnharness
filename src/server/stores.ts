/**
 * 存储的组合根（THE COMPOSITION ROOT） — 连接具体存储适配器的唯一位置。
 * 其他所有内容（核心、服务、代理）都针对 core/ports.ts 中的端口类型进行编码，
 * 并通过此模块接收实例。以后将 fs 适配器换成 SQLite 恰好会更改此文件
 * （以及 src/store/ 中的适配器实现）。
 */

import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
/**
 * 连接的适配器。在结构上满足 core/graph.ts 的 GraphDeps。
 *
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
 * 设置记录的解析视图（core/settings-resolution.ts）：
 * 每个旋钮都具体覆盖其出厂默认值 — 除了模型（EXCEPT MODELS，完全的 BYOK，
 * owner 2026-09-22）：不存在出厂固定值，因此未设置的模型槽位解析为 null，
 * 并且按需拒绝门控在下游触发。每次调用时都是全新读取 — 记录是一个小文件
 * 并且回合很少见，因此没有缓存层（设置 PUT 之后过时的切换会更糟）。
 *
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
