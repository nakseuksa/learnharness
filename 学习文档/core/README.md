# `src/core/` 全量源码与纯函数精讲总索引（12 卷 · 60 文件）

本目录完整覆盖 LearnHarness 核心纯域层 `src/core/` 下的**全部 60 个源码文件（51 个顶层模块 + 9 个 `contracts/` 子模块，合计 12,132 行代码、310+ 个函数与契约定义）**。所有讲解严格遵循 [`../glossary.md`](../glossary.md) 术语规范，并对每个导出函数与核心内部算法提供带精确 `文件:行号` 锚点及全仓真实调用点的五要素拆解。

---

## 一、十二分卷目录与推荐精读路径

### 推荐学习顺序（由浅入深四阶段）

1. **阶段 A · 会话状态与双投影主干（最先读）**：第 `02` 卷（`chat.ts` / `plan.ts` / `jobs.ts`）→ 第 `03` 卷（`native-messages.ts`）→ 第 `04` 卷（`input-events.ts` + `view.ts` + `pending.ts`）
2. **阶段 B · 教学出题、阶段推进与参数自愈**：第 `05` 卷（题目洗牌判分与 `heal` 双缝修复）→ 第 `06` 卷（三阶段折叠与计划树 DAG）→ 第 `09` 卷 §3–§4（工具数学排版非破坏恢复）
3. **阶段 C · 知识图谱账本与空间物理引擎**：第 `07` 卷（覆盖度指纹、BM25 候选、确定性合并化简与溯源删除）→ 第 `08` 卷（出生会话簇、Tarjan 深度与同源 d3-force 演化）→ 第 `09` 卷 §1–§2（来源文件夹树）
4. **阶段 D · 架构地基、配置治理、记账与键盘交互**：第 `01` 卷（桶导出、六边形端口、事件总线与日志）→ 第 `10` 卷（Delta 设置、BYOK 槽位与凭据隔离）→ 第 `11` 卷（上下文压缩切割与诚实计费折叠）→ 第 `12` 卷（跨布局快捷键与模糊评分）

### 十二卷总览表

| 卷号 | 文档文件 | 覆盖子域 | 源码文件数 | 源码总行数 |
|---|---|---|---|---|
| **01** | [`01-architecture-and-runtime-spine.md`](./01-architecture-and-runtime-spine.md) | 桶导出边界、六边形存储端口、事件总线与同构日志 | 5 | 739 |
| **02** | [`02-domain-contracts.md`](./02-domain-contracts.md) | `contracts/` 九大域契约、计划状态派生与异步 `steer` 纯构造 | 9 | 1,578 |
| **03** | [`03-native-messages-and-llm-projection.md`](./03-native-messages-and-llm-projection.md) | `LhMessage` 体系、9 种标记消息与唯一模型向投影 `toLlmMessages` | 1 | 937 |
| **04** | [`04-input-events-view-and-pending.md`](./04-input-events-view-and-pending.md) | 输入事件折叠、`projectView` 浏览器视图投影与待答问题闸门 | 3 | 1,031 |
| **05** | [`05-questions-grading-and-healing.md`](./05-questions-grading-and-healing.md) | 题目 Schema、确定性洗牌判分、双缝参数修复（`heal`）与残渣剥离 | 5 | 1,110 |
| **06** | [`06-phases-and-plan-dag.md`](./06-phases-and-plan-dag.md) | 显式事件三阶段状态机、计划树 DAG 校验与流内快照 `plan-block` | 3 | 419 |
| **07** | [`07-knowledge-graph-core.md`](./07-knowledge-graph-core.md) | 图谱合并 `mergeFindings`、链化简 `simplifyChains`、删除与覆盖度 | 6 | 1,505 |
| **08** | [`08-graph-layout-clusters-and-render.md`](./08-graph-layout-clusters-and-render.md) | 出生会话聚类、Tarjan 深度 + d3-force 增量布局与渲染参数清洗 | 4 | 1,298 |
| **09** | [`09-sources-and-content-recovery.md`](./09-sources-and-content-recovery.md) | 来源文件夹树、路径胶囊、Markdown 导出、会话查找与数学显示恢复 | 10 | 873 |
| **10** | [`10-settings-and-credentials.md`](./10-settings-and-credentials.md) | Delta 设置清洗、BYOK 槽位解析、密钥形状门禁与外部 CLI 凭据净化 | 8 | 1,599 |
| **11** | [`11-compaction-context-and-pricing.md`](./11-compaction-context-and-pricing.md) | 上下文压缩触发与切割、实测窗口仪表盘、会话与图谱诚实计费折叠 | 4 | 728 |
| **12** | [`12-keyboard-and-fuzzy-ui.md`](./12-keyboard-and-fuzzy-ui.md) | 跨平台/跨键盘布局快捷键归一化引擎与多字段分词模糊打分器 | 2 | 271 |
| **合计** | **12 卷** | **`src/core/` 100% 全覆盖** | **60** | **12,132** |

---

## 二、`src/core/` 全部 60 个源码文件精确检索与纯度分类表

纯度分类图例：
* **`[严格纯函数]`**：相同输入必得相同输出，零外部状态读写、零 I/O。
* **`[纯逻辑 + ID/时钟]`**：无外部可变状态与 I/O，仅在构造新记录对象时调用 `randomUUID`/`randomBytes` 或 `Date.now()`。
* **`[纯类型/常量/桶]`**：仅含 TypeScript 接口、TypeBox Schema、纯常量或模块重导出，无运行时函数。
* **`[端口驱动确定性逻辑]`**：无全局状态，所有外部读写均通过显式参数传入的六边形端口（`GraphStore`/`ChatStore`）同步执行。
* **`[非纯边界]`**：涉及 `globalThis` 单例、`process.env`、`console` 或浏览器 `localStorage`（对应分卷内已显式框出副作用边界）。

| # | 源码文件路径 | 行数 | 纯度分类 | 进 `core/index.ts` 桶？ | 所属分卷 |
|---|---|---|---|---|---|
| 1 | `src/core/answer-presentation.ts` | 57 | `[严格纯函数]` | 是 | [第 05 卷](./05-questions-grading-and-healing.md) |
| 2 | `src/core/argument-heal.ts` | 96 | `[严格纯函数]` | 否（内部/agent 直引） | [第 05 卷](./05-questions-grading-and-healing.md) |
| 3 | `src/core/auth-env.ts` | 24 | `[非纯边界: globalThis]` | 否 | [第 10 卷](./10-settings-and-credentials.md) |
| 4 | `src/core/auth-keys.ts` | 218 | `[严格纯函数]` | 是 | [第 10 卷](./10-settings-and-credentials.md) |
| 5 | `src/core/chains.ts` | 93 | `[严格纯函数]` | 是 | [第 07 卷](./07-knowledge-graph-core.md) |
| 6 | `src/core/clusters.ts` | 13 | `[纯类型/常量/桶]` | 否 | [第 07 卷](./07-knowledge-graph-core.md) |
| 7 | `src/core/compaction.ts` | 406 | `[严格纯函数]`（仅 marker 构造含 ID/时钟） | 是 | [第 11 卷](./11-compaction-context-and-pricing.md) |
| 8 | `src/core/content-reader.ts` | 215 | `[严格纯函数]`（含幂等命令表缓存） | 否（经 `math-delims`） | [第 09 卷](./09-sources-and-content-recovery.md) |
| 9 | `src/core/context-usage.ts` | 27 | `[严格纯函数]` | 是 | [第 11 卷](./11-compaction-context-and-pricing.md) |
| 10 | `src/core/contracts.ts` | 18 | `[纯类型/常量/桶]` | 是 | [第 01 卷](./01-architecture-and-runtime-spine.md) |
| 11 | `src/core/contracts/chat.ts` | 322 | `[纯类型/常量/桶]` | 是 | [第 02 卷](./02-domain-contracts.md) |
| 12 | `src/core/contracts/chatgpt.ts` | 27 | `[纯类型/常量/桶]` | 部分再导出 | [第 02 卷](./02-domain-contracts.md) |
| 13 | `src/core/contracts/claude-code.ts` | 12 | `[纯类型/常量/桶]` | 部分再导出 | [第 02 卷](./02-domain-contracts.md) |
| 14 | `src/core/contracts/graph.ts` | 385 | `[严格纯函数]`（含 `titleFromPrompt`） | 是 | [第 02 卷](./02-domain-contracts.md) |
| 15 | `src/core/contracts/jobs.ts` | 438 | `[纯逻辑 + ID/时钟]`（10 个函数） | 是 | [第 02 卷](./02-domain-contracts.md) |
| 16 | `src/core/contracts/models.ts` | 83 | `[纯类型/常量/桶]` | 是 | [第 02 卷](./02-domain-contracts.md) |
| 17 | `src/core/contracts/plan.ts` | 149 | `[严格纯函数]`（3 个状态派生函数） | 是 | [第 02 卷](./02-domain-contracts.md) |
| 18 | `src/core/contracts/probe.ts` | 94 | `[纯类型/常量/桶]`（TypeBox Schema） | 是 | [第 02 卷](./02-domain-contracts.md) |
| 19 | `src/core/contracts/subscriptions.ts` | 68 | `[纯类型/常量/桶]` | 部分再导出 | [第 02 卷](./02-domain-contracts.md) |
| 20 | `src/core/cost-summary.ts` | 192 | `[严格纯函数]` | 是 | [第 11 卷](./11-compaction-context-and-pricing.md) |
| 21 | `src/core/coverage.ts` | 192 | `[严格纯函数]`（含 `node:crypto` 哈希） | 是（注意 Node 依赖） | [第 07 卷](./07-knowledge-graph-core.md) |
| 22 | `src/core/custom-provider-auth.ts` | 26 | `[严格纯函数]` | 否 | [第 10 卷](./10-settings-and-credentials.md) |
| 23 | `src/core/dictation.ts` | 90 | `[严格纯函数]` | 是 | [第 10 卷](./10-settings-and-credentials.md) |
| 24 | `src/core/events.ts` | 120 | `[非纯边界: globalThis 事件总线]` | 是 | [第 01 卷](./01-architecture-and-runtime-spine.md) |
| 25 | `src/core/file-paths.ts` | 86 | `[严格纯函数]` | 是 | [第 09 卷](./09-sources-and-content-recovery.md) |
| 26 | `src/core/fuzzy.ts` | 37 | `[严格纯函数]` | 是 | [第 12 卷](./12-keyboard-and-fuzzy-ui.md) |
| 27 | `src/core/graph-deletion.ts` | 343 | `[端口驱动确定性逻辑]` | 仅类型导出 | [第 07 卷](./07-knowledge-graph-core.md) |
| 28 | `src/core/graph.ts` | 695 | `[端口驱动 + 纯函数 simplifyChains/deriveView]` | 否 | [第 07 卷](./07-knowledge-graph-core.md) |
| 29 | `src/core/index.ts` | 91 | `[纯类型/常量/桶]` | 自身即桶 | [第 01 卷](./01-architecture-and-runtime-spine.md) |
| 30 | `src/core/input-events.ts` | 345 | `[纯逻辑 + ID/时钟]` | 是 | [第 04 卷](./04-input-events-view-and-pending.md) |
| 31 | `src/core/keyboard.ts` | 234 | `[纯函数 + localStorage 覆盖读写]` | 是 | [第 12 卷](./12-keyboard-and-fuzzy-ui.md) |
| 32 | `src/core/layout-settle.ts` | 54 | `[端口驱动确定性逻辑]` | 否 | [第 08 卷](./08-graph-layout-clusters-and-render.md) |
| 33 | `src/core/layout.ts` | 720 | `[严格纯函数 + d3 就地演化模拟]` | 是 | [第 08 卷](./08-graph-layout-clusters-and-render.md) |
| 34 | `src/core/logger.ts` | 278 | `[非纯边界: env/console + 内部纯格式化]` | 是 | [第 01 卷](./01-architecture-and-runtime-spine.md) |
| 35 | `src/core/math-delims.ts` | 121 | `[严格纯函数]` | 是 | [第 09 卷](./09-sources-and-content-recovery.md) |
| 36 | `src/core/native-messages.ts` | 937 | `[严格纯函数 + 构造器组 ID/时钟]` | 是 | [第 03 卷](./03-native-messages-and-llm-projection.md) |
| 37 | `src/core/pending.ts` | 196 | `[严格纯函数]` | 是 | [第 04 卷](./04-input-events-view-and-pending.md) |
| 38 | `src/core/phases.ts` | 192 | `[严格纯函数]` | 是 | [第 06 卷](./06-phases-and-plan-dag.md) |
| 39 | `src/core/plan-blocks.ts` | 95 | `[纯逻辑 + ID/时钟]` | 是 | [第 06 卷](./06-phases-and-plan-dag.md) |
| 40 | `src/core/plan-tree.ts` | 132 | `[严格纯函数]` | 是 | [第 06 卷](./06-phases-and-plan-dag.md) |
| 41 | `src/core/ports.ts` | 232 | `[纯类型/常量/桶]`（存储端口接口） | 是 | [第 01 卷](./01-architecture-and-runtime-spine.md) |
| 42 | `src/core/prices.ts` | 103 | `[严格纯函数]` | 是 | [第 11 卷](./11-compaction-context-and-pricing.md) |
| 43 | `src/core/prompt-segments.ts` | 50 | `[严格纯函数]` | 是 | [第 10 卷](./10-settings-and-credentials.md) |
| 44 | `src/core/proposition-candidates.ts` | 169 | `[严格纯函数]` | 是 | [第 07 卷](./07-knowledge-graph-core.md) |
| 45 | `src/core/question-core.ts` | 802 | `[严格纯函数]`（`buildAnswer` 记答时间戳） | 是 | [第 05 卷](./05-questions-grading-and-healing.md) |
| 46 | `src/core/render-settings.ts` | 394 | `[严格纯函数]` | 是 | [第 08 卷](./08-graph-layout-clusters-and-render.md) |
| 47 | `src/core/search.ts` | 53 | `[纯类型/常量/桶]` | 是 | [第 10 卷](./10-settings-and-credentials.md) |
| 48 | `src/core/session-clusters.ts` | 130 | `[严格纯函数 + 局部数组挂载]` | 否 | [第 08 卷](./08-graph-layout-clusters-and-render.md) |
| 49 | `src/core/session-find.ts` | 20 | `[严格纯函数]` | 是 | [第 09 卷](./09-sources-and-content-recovery.md) |
| 50 | `src/core/session-markdown.ts` | 205 | `[严格纯函数]` | 是 | [第 09 卷](./09-sources-and-content-recovery.md) |
| 51 | `src/core/session-navigation.ts` | 47 | `[严格纯函数]` | 是 | [第 09 卷](./09-sources-and-content-recovery.md) |
| 52 | `src/core/settings-resolution.ts` | 277 | `[严格纯函数]` | 是 | [第 10 卷](./10-settings-and-credentials.md) |
| 53 | `src/core/settings.ts` | 861 | `[严格纯函数]` | 是 | [第 10 卷](./10-settings-and-credentials.md) |
| 54 | `src/core/source-errors.ts` | 22 | `[纯类型/常量/桶]`（含异常类） | 是 | [第 09 卷](./09-sources-and-content-recovery.md) |
| 55 | `src/core/source-label.ts` | 6 | `[严格纯函数]` | 是 | [第 09 卷](./09-sources-and-content-recovery.md) |
| 56 | `src/core/source-organization.ts` | 152 | `[严格纯函数]` | 是 | [第 09 卷](./09-sources-and-content-recovery.md) |
| 57 | `src/core/source-selection.ts` | 43 | `[严格纯函数]` | 是 | [第 09 卷](./09-sources-and-content-recovery.md) |
| 58 | `src/core/tool-parts.ts` | 129 | `[严格纯函数]` | 是 | [第 05 卷](./05-questions-grading-and-healing.md) |
| 59 | `src/core/value-debris.ts` | 26 | `[严格纯函数]` | 否（内部/agent 直引） | [第 05 卷](./05-questions-grading-and-healing.md) |
| 60 | `src/core/view.ts` | 490 | `[严格纯函数]` | 是 | [第 04 卷](./04-input-events-view-and-pending.md) |
