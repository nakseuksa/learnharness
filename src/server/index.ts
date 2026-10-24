/**
 * THE SERVER-SIDE SURFACE — 这是除了 core 入口以外，唯一允许 `app/` 目录导入的后端模块。
 * Next.js 路由处理程序（Route handlers）和服务器组件（Server components）的所有调用都通过此处导出。
 * 严格遵守架构：`app/` 下的任何代码均不允许直接访问 `src/store` 或 `src/agent`。
 */

export * from "./chat-handler.ts";
export * from "./events-stream.ts";
export * from "./chats.ts";
export * from "./graph.ts";
export { NotesImportError } from "../agent/subagents/extraction.ts";
export * from "./commit-positions.ts";
export * from "./jobs.ts";
export * from "./stores.ts";
export { readRenderSettings, writeRenderSettings } from "../store/render-settings.ts";
// 设置记录 + 提示覆盖（settings record + prompt overrides，settings-storage wave, 2026-09-19）。
// *Record 别名使得 app/api/settings 路由明确它们触及的是哪个接缝（原始记录，而不是 chat-section 便捷视图）。
export {
	readSettings as readSettingsRecord,
	writeSettings as writeSettingsRecord,
	settingsStore,
} from "../store/settings.ts";
export { promptOverrides } from "../store/prompt-overrides.ts";
export { isValidSegmentPath } from "../core/prompt-segments.ts";
// 规范的片段发现/解析位于代理层（组合是代理的关注点）；
// 桶（barrel）为路由重新导出它 — server→agent 是合法的方向（chat-handler 先例）。
export { effectivePromptSegments, allSegmentPaths, readPromptOverride } from "../agent/prompt-segments.ts";

// auth/keys 组合（auth-keys wave, 2026-09-19）：精选的
// 密钥目录 + GET/PUT/DELETE /api/keys 后面的环境反映存储。
// 导入此模块运行幂等的启动间隙填充（boot fill-gap） — 每个消费者
// 保持其普通的 process.env 读取（那个接缝就是重点）。
export * from "./keys.ts";
export * from "./search.ts";
export { authStore } from "../store/auth.ts";
export * from "./settings-body.ts";
export * from "./turn-liveness.ts";
export * from "./turn-runs.ts";
export * from "./dismissal-park.ts";
export * from "./compaction.ts";
export { runPiTurn, piTurnResponse, type PiTurnHandle, type PiTurnSpec } from "./pi/ui-stream.ts";
export * from "./observability.ts";
export * from "./model-catalog.ts";
