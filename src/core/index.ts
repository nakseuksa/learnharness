/**
 * 核心公共 API (THE CORE PUBLIC API) — 壳层（shell，即 app/ 和 components/ 目录）
 * 允许导入的唯一模块。此处导出的所有内容在浏览器环境中都是安全的：仅包含纯逻辑和类型定义，
 * 不包含任何 Node.js 内置模块、文件系统 (fs) 或网络调用。
 *
 * 服务端相关的接口（例如聊天流、存储读取）位于 src/server 的统一导出文件中。
 * 导入规范（参见 eslint.config.mjs）：
 *
 *   components/**  →  仅能导入 "@/src/core" (本文件)
 *   app/**         →  可以导入 "@/src/core" 以及 "@/src/server"
 *
 * 服务端专用的核心模块（如 core/graph.ts 中的图生成与派生逻辑）虽然也是纯逻辑，
 * 但需要服务端调用方传入存储端口（storage ports），因此故意不在此处重新导出 —
 * 服务端代码直接导入它们。
 * 而存储端口的类型定义 (PORT TYPES) 只是类型且在浏览器中安全，因此在这里重新导出。
 */

export * from "./contracts.ts";
export * from "./ports.ts";
export * from "./chains.ts";
export * from "./render-settings.ts";

export * from "./question-core.ts";
// 事件总线 (2026-10-02 引入的推送架构): 包含各层的词汇表 (vocabulary) 以及发布/订阅机制；
// 浏览器壳层通过此文件使用相关类型和运行时名称 (符合壳层规范：仅通过 @/src/core 访问纯核心逻辑)。
export * from "./events.ts";
// 故意不重新导出 clusters.ts (Louvain 算法): 壳层(shell)中没有任何代码运行社区发现逻辑 —
// 客户端接收的快照已包含来自服务端的划分结果。将其排除在外可以避免客户端打包时引入沉重的聚类依赖库
// (于 2026-09-13 验证过：当该行存在时，分包中确实包含了它)。layout-settle.ts 也是同样的逻辑。
export * from "./layout.ts";
export * from "./plan-tree.ts";
export * from "./phases.ts";
export * from "./pending.ts";
export * from "./prompt-segments.ts";
export * from "./math-delims.ts";
// Wave B (经所有者批准于 2026-09-26 引入): 原生记录 (LhMessage) 以及 input-events 契约 —
// 全都是浏览器安全的纯逻辑。
export * from "./native-messages.ts";
export * from "./compaction.ts";
export * from "./input-events.ts";
// Wave D (经所有者批准于 2026-09-26 引入): 客户端视图模型 —
// 从已删除的服务端投影移植到客户端的分组规范 (将单个连续的助手文档与步骤分隔符结合)。
// 它是纯逻辑的，在浏览器中安全。
export * from "./view.ts";
export * from "./tool-parts.ts";
export * from "./prices.ts";
export * from "./cost-summary.ts";
export * from "./fuzzy.ts";
// settings.ts + settings-resolution.ts (2026-09-19 引入的设置存储):
// 用户设置记录的数据结构/清理器 (纯逻辑) 及其完全解析后的视图。
// 浏览器安全 — Wave-4 设置面板直接导入它们。
export * from "./settings.ts";
// graph-deletion.ts (wave 6): 整个模块是纯逻辑(PURE)，但受存储端口驱动 —
// 删除操作仅在服务端运行。壳层(shell)仅仅需要从中获取两个纯类型的定义：
// ChatDeleteMode 联合类型 (代表删除对话框中两种选项的设计及 DELETE 查询参数)，
// 以及它成功执行后返回的统计信息的数据形状 (ChatDeletionStats)，因此这里仅做类型的重新导出。
export type { ChatDeleteMode, ChatDeletionStats } from "./graph-deletion.ts";
export * from "./settings-resolution.ts";
export * from "./search.ts"; // 搜索端口 (2026-09-20 引入)
export * from "./session-find.ts";
export * from "./session-navigation.ts";
// auth-keys.ts (2026-09-19 引入的授权密钥): 精选的密钥目录 + 数据形状验证规则 + 脱敏处理 —
// 纯逻辑，浏览器安全 (身份验证页面会调用基于它构建的 /api/keys 路由)。
export * from "./auth-keys.ts";
// keyboard.ts: 快捷键注册表 + 绑定规格化处理 (纯逻辑，浏览器安全)。
export * from "./keyboard.ts";
export * from "./coverage.ts";
// session-markdown.ts (2026-09-27 引擎; 于 2026-10-06 首次使用):
// 唯一的 session→markdown 格式化器 — 提取器的视图与面向用户的导出功能共用。
// 纯逻辑，浏览器安全。
export * from "./session-markdown.ts";
