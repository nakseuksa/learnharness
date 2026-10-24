/**
 * 聚类展示规则 (CLUSTER PRESENTATION RULES) (愿景 §1)。
 * 聚类的“检测(DETECTION)”自 wave 7 以来已改为基于诞生会话进行聚类
 * (参见 core/session-clusters.ts；过去的语义嵌入器、Louvain 算法前身，
 * 以及大语言模型(LLM)标签匹配器均已被废弃 — 现在聚类标签直接就是会话的名称)。
 * 本文件保留的仅仅是快照和渲染器共用的那一个展示规则。
 *
 * 浏览器安全的纯逻辑 (不依赖 node 内置模块或文件系统 fs)。
 */

/**
 * 小于此大小的社区(communities)将不会被渲染和命名 —
 * 这是一项展示规则 (由用户在 2026-09-13 决定)：世界模型中的某个区域
 * 至少需要包含三个命题 (propositions)，才值得为其绘制外壳并添加标签。
 */
export const MIN_CLUSTER_SIZE = 3;