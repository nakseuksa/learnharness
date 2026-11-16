# 第 01 卷：架构骨架、六边形端口与进程基础设施

> 负责源码（逐行精读，零遗漏）：`src/core/index.ts`（91 行）、`src/core/contracts.ts`（18 行）、`src/core/ports.ts`（232 行）、`src/core/events.ts`（120 行）、`src/core/logger.ts`（278 行）。
> 术语一律遵循 `学习文档/glossary.md`：回合的实时通道称 **SSE 事件流**（词条 1），`GET /api/events` 称 **通知通道**（词条 6），二者严格区分；对话记录的落盘称 **持久化**（词条 2）；回合结束处理称 **回合收尾**（词条 20，代码标识符 `persistTurn` / `endTurn` / `turn-settled` 原样保留）。所有代码标识符原样引用。
> 每条结论均带 `path:line` 出处，取证方式为 `read` 全文精读 + `rg` 全仓检索。

---

## 本卷导读

### src/core 在全仓架构中的地位：纯域层

`src/core` 是全仓的纯域层：51 个顶层模块（另有 `contracts/` 子目录 9 个域文件），合计约 1.1 万行（`wc -l src/core/*.ts` = 11310）。它不拥有任何 IO 实现——文件系统、网络、模型调用全部在外层；core 只拥有**类型契约**与**纯逻辑**，外加两个刻意例外的进程基础设施（事件总线 `events.ts`、日志器 `logger.ts`，见下文纯度标签）。

分层依赖由 **导入法则**（glossary 词条 89）在 lint 层强制，`eslint.config.mjs` 的唯一职责就是它（`eslint.config.mjs:6-9` 头注释："ESLint with one job here: ENFORCE THE IMPORT LAW"）。规则本体是 `import/no-restricted-paths`（`eslint.config.mjs:38`），四个 zone：

| zone | target（被约束方） | from（禁止导入的来源） | except（唯一豁免） | 行号 |
|---|---|---|---|---|
| 浏览器组件 | `./components` | `./src` 全部 | `./core/index.ts` | `eslint.config.mjs:43-49`（except 在 `:46`） |
| 传输层 | `./app` | `./src` 全部 | `./core/index.ts` + `./server/index.ts` | `eslint.config.mjs:51-56`（except 在 `:53`） |
| 纯域层 | `./src/core` | `./src/agent`、`./src/server`、`./src/store` | 无 | `eslint.config.mjs:58-62` |
| agent 层 | `./src/agent` | `./src/server`、`./src/store` | 无 | `eslint.config.mjs:64-68` |

即：**components 只进 core 桶导出；app 只进两个桶；core 永不 import IO 层；agent 的存储端口经工厂/闭包注入，绝不自己 import 适配器**（`eslint.config.mjs:11-17` 注释原文语义）。`tests/`、`scripts/`、`electron/` 不受约束（`eslint.config.mjs:19-20`、`:25` globalIgnores）。

**桶导出**（glossary 词条 86）因此是 shell 的唯一合法 import 面：`src/core/index.ts` 与 `src/server/index.ts`。真实消费证据：`components/session-core.ts:18-37` 的多行 import 以 `} from "../src/core";`（`:37`）收口，`lhLog` 就在其中（`:29`）；`components/server-events.tsx:28` 从 `"@/src/core"` 取 `SERVER_EVENT_TYPES` 与事件类型；`app/api/chats/[id]/dismiss/route.ts:22` 从 `"@/src/core"` 取 `emit` 等。

### 端口与事件总线拓扑

本卷五个文件构成架构骨架的四个角色：

```
shell (app/, components/)
   │  只准 import 桶导出（导入法则）
   ▼
src/core/index.ts ──★── contracts.ts（类型契约桶）
   │                └── ports.ts（六边形存储端口，types-only）
   │                          ▲ 实现（依赖单向：适配器 import core，core 永不 import 适配器）
   │                src/store/*（fs JSON/JSONL 适配器）
   │                          ▲ 唯一装配点
   │                src/server/stores.ts（组合根，traceObject 包装）
   ├──★── events.ts（事件总线：globalThis.__lhEventBus，server/store/agent 全层 emit）
   │            └── subscribe → src/server/events-stream.ts → GET /api/events（通知通道）
   │            └── 浏览器 EventSource → notify→fetch（components/server-events.tsx）
   └──★── logger.ts（同构日志器：lhLog / traceObject，全层可 import）
```

- **端口／适配器**（glossary 词条 87）：`ports.ts:1-10` 头注释立教义——每实体一个端口、绝不做一个通用 key/value 接口；core 与环绕它的服务层只面向端口类型编程；具体适配器在 `src/store/`（今天 fs JSON/JSONL，将来 SQLite 直接替换），且**只在组合根装配一次**。
- **组合根**（glossary 词条 88）：`src/server/stores.ts:1-7`（THE COMPOSITION ROOT）。换存储实现只改这一个文件加适配器本体。
- **事件总线**（glossary 词条 5）：全层共享的进程内发布/订阅，监听者集合挂 `globalThis.__lhEventBus`（`events.ts:90-93`）；事件只携带事实、不携带数据（`events.ts:9-11`）。
- **通知通道**（glossary 词条 6）：`GET /api/events`（`app/api/events/route.ts:13-15`）把总线的每次 emission 变成小帧，浏览器收到后自行 fetch 真相（notify→fetch）。它**不是** SSE 事件流：后者（`GET /api/chats/[id]/stream` 与 POST 响应流）携带回合的完整工作消息，前者只有类型 + 极小 payload。

### 纯度标签约定

- **[纯]**：无副作用、无环境读取的确定性逻辑或类型声明。
- **[非纯边界]**：模块整体触碰可变全局状态、环境（`process.env` / `localStorage`）、时钟或 console IO。本卷中 `events.ts` 与 `logger.ts` 必须标此标签，且要拆解其副作用来源、区分其内部的纯格式化/解析函数。
- 注意 **browser-safe ≠ 纯**：`index.ts:3-4` 宣称桶内一切 "browser-safe: pure logic + types, no node builtins, no fs, no network"。`events.ts`（可变全局监听器集合）与 `logger.ts`（console 输出、环境读取）是 browser-safe 的（能在浏览器运行），但不是无副作用的纯模块；而 "no node builtins" 这一句存在一个真实的字面例外——`coverage.ts`（详见第 1 节）。

### 本卷文件清单

| 节 | 文件 | 行数 | 角色 | 纯度 | 进桶导出？ |
|---|---|---|---|---|---|
| 1 | `src/core/index.ts` | 91 | core 公开 API 桶 | [纯]（自身只做再导出） | 它本身就是桶 |
| 2 | `src/core/contracts.ts` | 18 | 契约桶（单一事实来源） | [纯]（types-only） | 是（`index.ts:18`） |
| 3 | `src/core/ports.ts` | 232 | 六边形存储端口 | [纯]（types-only） | 是（`index.ts:19`） |
| 4 | `src/core/events.ts` | 120 | 事件总线 | **[[非纯边界]]** | 是（`index.ts:31`） |
| 5 | `src/core/logger.ts` | 278 | 同构观测日志器 | **[[非纯边界]]** | 是（`index.ts:91`） |

---

## 1. src/core/index.ts

### 1.1 模块定位与纯度边界

**定位**：THE CORE PUBLIC API（`index.ts:1-2`）——shell（`app/`、`components/`）唯一可 import 的 core 模块。自身没有任何运行时逻辑，91 行全部是头注释（1-16）与再导出语句（18-91），因此模块本身 [纯]；但它再导出的**导出面**包含两个 [非纯边界] 模块（`events.ts` 于 `:31`、`logger.ts` 于 `:91`）和一个含 node 内建导入的模块（`coverage.ts` 于 `:86`）。

**头注释的三条契约**（`index.ts:1-16`）：

1. **browser-safe 宣称**（`:3-4`）："Everything exported here is browser-safe: pure logic + types, no node builtins, no fs, no network." —— 如导读所述，这句话对 `events.ts`/`logger.ts` 的"pure"措辞偏宽（二者有副作用但无 fs/network），对 "no node builtins" 则有一个字面例外（`coverage.ts:22`，见 1.3）。
2. **进口法摘要**（`:6-10`）：server 侧表面（chat streaming、store reads）走 `src/server` 桶；`components/** → "@/src/core"`（ONLY），`app/** → "@/src/core" + "@/src/server"`。与 `eslint.config.mjs:43-56` 逐字对应。
3. **刻意排除宣言**（`:12-15`）：server-only 的 core 模块（点名 `core/graph.ts` 的 emission/derivation）"are pure but need storage ports passed in by a server caller, so they are deliberately NOT re-exported here — the server imports them directly"；而存储**端口类型**是 types-only、browser-safe，故再导出（`:15`，对应 `:19` 的 `export * from "./ports.ts"`）。

**进桶边界**：本文件就是桶。它不再被任何更上层桶包含；`src/server/index.ts` 是另一个独立的桶（`app/` 专用）。

### 1.2 导出清单（逐行，100% 覆盖）

**全量星再导出（`export *`）**：

| 行号 | 模块 | 一句话用途 |
|---|---|---|
| 18 | `./contracts.ts` | 契约桶（第 2 节） |
| 19 | `./ports.ts` | 存储端口类型（第 3 节）；types-only，编译期擦除，零运行时成本 |
| 20 | `./chains.ts` | 推理链格式化等纯逻辑（`graph.ts:68` 亦直接消费 `formatChainLine`） |
| 21 | `./source-organization.ts` | source 组织（展示元数据，glossary 词条 49） |
| 22 | `./source-selection.ts` | source 选择 |
| 23 | `./source-label.ts` | source 展示标签 |
| 24 | `./source-errors.ts` | source 错误类型 |
| 25 | `./render-settings.ts` | 渲染设置 |
| 27 | `./question-core.ts` | 题目核心（quiz/ask/explain、置信度，glossary 词条 38/39） |
| 31 | `./events.ts` | 事件总线（第 4 节）；注释 `:28-30` 明示浏览器 shell 经桶消费"类型 + 运行时名字" |
| 37 | `./layout.ts` | 图谱布局物理（browser 侧实时物理模拟用；与 server-only 的 `layout-settle.ts` 刻意分家，见 1.3） |
| 38 | `./plan-tree.ts` | 计划树（glossary 词条 46） |
| 39 | `./phases.ts` | 阶段折叠（glossary 词条 32/44） |
| 40 | `./pending.ts` | 待答问题闸门 view 侧扫描 + 微光文案（glossary 词条 10/78） |
| 41 | `./prompt-segments.ts` | 提示词分段文法（`isValidSegmentPath` 在 `:45`） |
| 42 | `./math-delims.ts` | 数学定界符 |
| 46 | `./native-messages.ts` | 原生记录 `LhMessage` + `toLlmMessages` 投影（Wave B，owner-approved 2026-09-26，注释 `:43-45`） |
| 47 | `./compaction.ts` | 上下文压缩纯逻辑（glossary 词条 25） |
| 48 | `./input-events.ts` | 输入事件契约 `ChatInput` / `parseChatInput` / `inputAppends`（glossary 词条 4） |
| 54 | `./view.ts` | 客户端视图模型 `projectView`（Wave D，owner-approved 2026-09-26，注释 `:51-53`） |
| 55 | `./tool-parts.ts` | 工具 part 显示侧（含参数修复镜像，glossary 词条 12） |
| 56 | `./answer-presentation.ts` | 答案呈现 |
| 57 | `./prices.ts` | 价格/成本折叠 |
| 58 | `./context-usage.ts` | 上下文用量 |
| 62 | `./cost-summary.ts` | 成本汇总 |
| 64 | `./fuzzy.ts` | 模糊匹配 |
| 68 | `./settings.ts` | 用户设置记录形状/清洗器（settings-storage wave 2026-09-19，注释 `:65-67`） |
| 69 | `./dictation.ts` | 听写语言码（glossary 词条 50） |
| 76 | `./settings-resolution.ts` | 设置完全解析视图 |
| 77 | `./search.ts` | search 端口（search wave 2026-09-20，行尾注释） |
| 78 | `./session-find.ts` | 会话查找 |
| 79 | `./session-navigation.ts` | 会话导航 |
| 83 | `./auth-keys.ts` | 自带密钥（BYOK）目录 + 形状规则 + 掩码（auth-keys wave 2026-09-19，注释 `:80-82`） |
| 85 | `./keyboard.ts` | 快捷键注册表 + 绑定归一化（注释 `:84`） |
| 86 | `./coverage.ts` | 覆盖度纯核心（glossary 词条 55）——**含 `node:crypto` 的例外**，见 1.3 |
| 90 | `./session-markdown.ts` | 唯一的会话→markdown 格式化器（2026-09-27 引擎，注释 `:87-89`） |
| 91 | `./logger.ts` | 同构日志器（第 5 节） |

**选择性再导出（点名导出，收窄导出面）**：

| 行号 | 语句 | 说明 |
|---|---|---|
| 49 | `export { parseFilePaths, quoteFilePath, filePathLabel } from "./file-paths.ts"` | 只放行三个函数 |
| 50 | `export type { FilePathPart } from "./file-paths.ts"` | 类型 |
| 59 | `export type { ChatGPTStatus, ChatGPTControlBridge } from "./contracts/chatgpt.ts"` | 绕过 contracts 桶、直连域文件的类型 |
| 60 | `export { NATIVE_SUBSCRIPTIONS } from "./contracts/subscriptions.ts"` | 唯一运行时名字 |
| 61 | `export type { NativeSubscriptionProviderId, …, SubscriptionPrompt } from "./contracts/subscriptions.ts"` | 8 个订阅类型 |
| 63 | `export { CLAUDE_CODE_PROVIDER, CLAUDE_CODE_MINIMUM_VERSION, type ClaudeCodeStatus } from "./contracts/claude-code.ts"` | 两常量一类型 |
| 75 | `export type { ChatDeleteMode, ChatDeletionStats } from "./graph-deletion.ts"` | **type-only**：`graph-deletion.ts` 整模块纯但由存储端口驱动、删除只在 server 运行（注释 `:70-74`）；shell 只需要删除对话框二选一设计的 `ChatDeleteMode` 联合与成功文案的统计形状 |

### 1.3 刻意排除与例外：真实代码事实核验

#### (a) `graph.ts` 为什么不在桶里

三重原因，全部可取证：

1. **node 内建**：`src/core/graph.ts:52` `import { randomBytes } from "node:crypto"`，用于生成节点 id（`:81` `n_${randomBytes(6)…}`）与派生蕴含节点 id（`:87` `arg_${randomBytes(6)…}`）。这直接违反桶的 "no node builtins" 宣称。
2. **存储端口驱动的纯派生**：`graph.ts:71` `import type { ChatStore, GraphStore } from "./ports.ts"`——它纯，但必须有一个 server 调用方把端口实例递进来才能运行（`index.ts:12-14` 注释原文语义）。
3. **shell 不需要它**：图谱派生/合并只在 server 与 agent 运行。真实直接进口点：`src/server/graph.ts:6`（`graphSnapshot`）、`src/server/commit-positions.ts:22`（`deriveView, getGraph`）、`src/server/source-organization.ts:4`（`getGraph`）、`src/agent/tools/graph.ts:5`、`src/agent/subagents/extraction.ts:26`（`getGraph, mergeFindings, …`）。浏览器拿到的是 server 算好的快照（`GraphSnapshot`，`contracts/graph.ts:303`），不需要派生引擎。

#### (b) `layout-settle.ts` 为什么不在桶里

模块自己的头注释就是裁定记录（`src/core/layout-settle.ts:20-24`）："SPLIT FROM layout.ts deliberately (2026-09-13): layout.ts is in the browser barrel, and the settle needs the cluster partition for the cluster centroid pull — this module must not ship in the client bundle. Server code imports it DIRECTLY; it is never re-exported through src/core/index.ts."

代码事实支撑：`layout-settle.ts:4` `import { deriveView, getGraph } from "./graph.ts"`——它传递性地把 `graph.ts`（含 `node:crypto`）拉进依赖图；`:3` 还 import `session-clusters.ts` 的出生会话分区。唯一导出 `settleGraphLayout`（`:26-54`）是合并后的布局重算：读当前图 + 位置账本 → `incrementalLayout`（`:48-52`）→ `writePositions` 整体替换（`:53`）。真实进口点只有两处，都在 server/agent：`src/server/commit-positions.ts:23`、`src/agent/subagents/extraction.ts:29`。`index.ts:36` 的 "Same logic as layout-settle.ts below" 指的就是这套逻辑（注意：桶里实际只有 `layout.ts`（`:37`），`layout-settle.ts` 没有任何导出行——"below" 指的是同段注释描述的排除逻辑，而非一条存在的导出语句）。

#### (c) `clusters.ts` 为什么不在桶里——注释与现状的时差

`index.ts:32-36` 的排除注释写道："clusters.ts (Louvain) is deliberately NOT re-exported: nothing in the shell runs community detection — the snapshot carries the partition from the server. Keeping it out keeps the heavy clustering deps out of the client bundle (verified 2026-09-13: chunks contained it while this line existed)."

**但必须讲清今天的真实代码**：`src/core/clusters.ts` 全文只有 14 行，唯一导出是常量 `MIN_CLUSTER_SIZE = 3`（`clusters.ts:14`，user-decided 2026-09-13，注释 `:11-13`：少于三个命题的社区不值得画 hull 和标签）。其头注释（`:2-6`）明示：社区**检测**自 wave 7 起是出生会话聚类（`core/session-clusters.ts`），"the semantic embedder, its Louvain predecessor, and the LLM label matcher are all dead — labels are session names now"。也就是说：

- 排除注释里的 "Louvain / heavy clustering deps" 是 **2026-09-13 时点的历史理由**，与今日模块内容（一个纯常量）已有时差；
- 排除本身依然成立且零成本：`MIN_CLUSTER_SIZE` 的唯一运行时消费者是 server-only 的 `graph.ts:67`（import）与 `:568`（hull 过滤）；shell 的分区来自快照，`session-clusters.ts` 同样不在桶里；
- 这正体现了桶的纪律：**排除决定不随模块瘦身而自动回收**，注释保留裁定日期供审计。

#### (d) `coverage.ts` 含 `node:crypto` 却仍在桶里——字面例外的完整事实

这是头注释 "no node builtins"（`index.ts:3-4`）的**唯一字面反例**，逐条核实如下：

1. **再导出事实**：`index.ts:86` `export * from "./coverage.ts"`，无条件星导出，没有任何 type-only 收窄。
2. **node 内建事实**：`src/core/coverage.ts:22` `import { createHash } from "node:crypto"`——运行时 import（非 `import type`）。全 core 顶层模块中只有两个文件 import node 内建（`rg 'from "node:' src/core/*.ts`）：`graph.ts:52`（被排除）与 `coverage.ts:22`（在桶内）。`createHash` 的唯一使用点是 `messageFingerprint`（`coverage.ts:77-82`，sha256 指纹）。
3. **真实消费者全部在 server/agent，且全部直接 import**：`src/agent/subagents/extraction.ts:30`（`batchRuns, coverageOf, messageViewLines`）、`src/server/turn-service.ts:24`（`coverageOf`）、`src/server/chats.ts:3`（`coverageOf`）。
4. **浏览器侧零运行时消费**：对 `components/` 与 `app/` 全量检索 `messageViewLines|messageFingerprint|coverageSlots|coverageOf|batchRuns|batchTag|teacherProseBlocks|viewTokens|coveredSet|CoverageEntry`，没有任何文件从桶里取 coverage 的运行时绑定或类型。浏览器的覆盖度数据走 API：`GET /api/chats/[id]` 携带 `coverage` 块（`app/api/chats/[id]/route.ts:25`，由 `src/server/chats.ts:183` 的 `sessionCoverage` 计算）；客户端甚至在本地**镜像**了类型而非 import——`components/extraction-coverage.tsx:32-34`（"Client-safe mirror of the server's SessionCoverage"）。
5. **构建配置无特殊处理**：`next.config.ts` 中检索 `crypto|fallback|webpack|turbopack` 零命中——没有为 `node:crypto` 配置浏览器 polyfill/fallback。

**结论（如实陈述）**：`coverage.ts` 的桶导出对浏览器而言今天事实上是 type-only 价值（它再导出的 `CoverageEntry` 类型，`coverage.ts:27`）；由于没有任何浏览器代码引用其运行时绑定，`createHash` 是否进入 client chunk 取决于打包器对未使用星导出的 tree-shaking，仓库内没有兜底配置。头注释的 "no node builtins" 宣称与 `index.ts:86` + `coverage.ts:22` 并存，是**注释滞后于导出面**的真实代码事实，本卷如实登记（见附录差异表），不替它圆谎。

### 1.4 导出函数与核心内部函数五要素精讲

本文件**没有任何函数声明**（91 行 = 16 行头注释 + 44 条再导出语句（37 条星导出 + 7 条点名导出）+ 注释/空行）。五要素不适用；其"契约"即 1.2 的导出清单与 1.3 的排除边界。

### 1.5 轻量私有辅助函数归并表

无辅助函数、无常量、无类型声明——本文件是纯再导出桶。零遗漏声明：1.2 已覆盖全部 44 条导出语句（37 条星导出 + 7 条点名导出；`rg -c "^export" src/core/index.ts` = 44，18-91 行区间内每一条 `export`）。

---

## 2. src/core/contracts.ts

### 2.1 模块定位与纯度边界

**定位**：共享契约的桶（`contracts.ts:1-2`："Shared contracts — the single source of truth every component codes against"），glossary 词条 90 的锚点本体。**[纯]**：18 行 = 11 行头注释 + 6 条星再导出（`:13-18`）+ 空行，全部是类型域文件的转发，无运行时逻辑。

**进桶**：是，`index.ts:18` 第一条星导出。shell 经 `@/src/core` 拿到的 `ChatRecord`、`LhMessage` 相关契约、`JobRecord` 等全部源于此。

**域所有权纪律**（`contracts.ts:7-9`）：每个域文件由其所属 stream 完全拥有（"owned outright by its stream"）；改别人域的 schema 必须走 master。这是契约作为"单一事实来源"的组织保障。

**桶的兼容性职责**（`contracts.ts:9-10`）：拆分后保持一切既有 import 路径（`"@/src/core"` 与 `"./contracts.ts"`）不变——`ports.ts:13-28` 正是经 `"./contracts.ts"` 取 14 个类型的真实消费者。

### 2.2 核心类型、接口与常量契约

#### 六条星再导出（逐行）与域内容

| 行号 | 域文件 | 域 | 关键导出（path:line 取证） |
|---|---|---|---|
| 13 | `./contracts/plan.ts` | 会话计划树 | `PlanNode`（plan.ts:13）、`PlanEdge`（:22）、`PlanTree`（:29）、`PlanNodeStatus`（:43）、`DerivedPlanStatuses`（:68）、`PlanToolResult`（:114） |
| 14 | `./contracts/graph.ts` | 全局知识图谱 + 抽取流水线 | `GraphEdge`（graph.ts:29）、`GraphChain`（:42）、`EmissionStats`（:61）、`ProvenancePoint`（:77）、`NotesSource`（:93）、`NamingRunStats`（:110）、`CURRENT_GRAPH_FORMAT_VERSION`（:123）、`GraphNode`（:126）、`SessionCheckpoint`（:151）、`CoverageEntry`（:165）、`ExtractedProposition`（:215）、`ExtractedChain`（:251）、`SessionFindings`（:259）、`IdentityLink`（:271）、`AuditVerdicts`（:284）、`Cluster`（:293）、`GraphSnapshot`（:303） |
| 15 | `./contracts/chat.ts` | 会话记录 + UI 扩展点 | `ChatKind`（chat.ts:28）、`ChatRecord`（:30）、`CURRENT_CHAT_VERSION`（:64）、`ChatSettings`（:73）、`ExtractionStageUsage`（:89）、`ExtractionRunUsage`（:100）、`CallUsage`（:120）、`TurnUsage`（:140）、`HANDOFF_TEXT`（:187）、`THINKING_LABEL`（:204）、`CONCLUDE_ACK_TEXT`（:213）、`NEXT_PROBLEM_TEXT`（:220）、`COMPACTED_HISTORY_HEADER`（:230）、`PlanBlockData`（:234）、`ChatSummary`（:259）、`ChatListItem`（:287）、`ArtifactPartProps`（:306） |
| 16 | `./contracts/jobs.ts` | 异步 sub-agent 协议 | `JobKind`（jobs.ts:15）、`JobStatus`（:16）、`JobRecord`（:18）、`JobUsage`（:50）、`UsageStepLike`（:78）、THE ASYNC PROTOCOL 注释（:140，"ack now, steer later"，glossary 词条 66）、四种 job 的 input/result 契约（:190-239）、`SubagentResultMeta`（:266）、`SubagentArtifactData`（:278）、`SteerDetails`（:287）、`SteerMessage`（:314） |
| 17 | `./contracts/probe.ts` | 探测交接 | `ProbeStrand`（probe.ts:21）、`ProbeAssessment`（:30）、`ProbeDoneInput`（:37）、`probeDoneInputSchema`（:47）、`probeDoneSchemaLock`（:77）、`ProbeDoneResult`（:80）、`PROBE_DONE_ACK_TEXT`（:93） |
| 18 | `./contracts/models.ts` | 模型目录 | `ModelCatalogEntry`（models.ts:14）、`CatalogDefaults`（:35）、`RolePins`（:44）、`SlotPins`（:52）、`ModelCatalogResponse`（:55）、`CatalogProvider`（:78） |

**注释与代码的小时差**：头注释（`:4-7`）只列举了 plan/graph/chat/jobs 四个域，实际星导出是六个（`:17-18` 的 probe/models 未被注释提及）——如实登记。

#### contracts/ 目录有 9 个文件，3 个不走本桶

`ls src/core/contracts/` = chat.ts、chatgpt.ts、claude-code.ts、graph.ts、jobs.ts、models.ts、plan.ts、probe.ts、subscriptions.ts。其中 **chatgpt / subscriptions / claude-code** 不经 `contracts.ts`，而由 `index.ts` 选择性直连再导出（`index.ts:59`、`:60-61`、`:63`，见第 1 节 1.2）——桶中桶的收窄设计：订阅与 ClaudeCode 的导出面被点名控制，不整域放行。

#### 本卷端口直接依赖的核心契约细读

**`ChatRecord`**（`contracts/chat.ts:30-62`，glossary 词条 2 锚点）——持久化的对话记录，每会话一个 JSON 文件：

- `id`/`title`/`createdAt`/`updatedAt`（`:31-34`）；`messages: LhMessage[]`（`:35`）是核心——记录即 agent 状态（glossary 词条 43）。
- `kind?: ChatKind`（`:37`）：缺省 = teach（练习会话显式 `"practice"`，glossary 词条 31）。
- `tree?: PlanTree`（`:39`）：计划树，由 plan 工具经 `saveTree` 写入。
- `turns?: TurnUsage[]`（`:47`）：append-only 用量日志（money channel）。注释（`:40-46`）明示**刻意做成平行日志而非消息内元数据**：客户端副本不携带 server 盖章字段，塞进消息对象会被下一次持久化冲掉；按 messageId 键控，聚合是对日志的折叠（`core/prices.ts`）。
- `extractions?: ExtractionRunUsage[]`（`:52`）：背景抽取用量日志，同一平行日志纪律，按 `startedAt` 键控、幂等追加（`:48-51`）。
- `settings?: ChatSettings`（`:54`）：每会话模型/思考级别覆盖（`:73-88`；背景 sub-agent 永不被覆盖，config 钉死）。
- `version?: number`（`:61`）：**schema版本戳**（glossary 词条 101），lazy v1——旧记录无戳（缺省读作 v1），每次写入盖当前戳；比本构建更新的戳**拒读**（`:55-60` 注释：read-modify-write 的 store 绝不能重写自己看不懂的东西）。`CURRENT_CHAT_VERSION = 1`（`:64`）。

**`JobRecord`**（`contracts/jobs.ts:18-43`，glossary 词条 65）：`id`/`kind`/`chatId`/`toolCallId` 为身份；`input?` 在派发时、worker 出生前保存；`delivery?`（result|abort × pending|delivered）是会话拥有的投递状态，与 worker 终态解耦（旧记录缺省，绝不重放）；`status` 只描述 worker 计算（running|done|error）；`activity` 最新人类可读活动行；`result?`/`error?`/`usage?`（money channel，缺省渲染 "—" 而非 0）。

### 2.3 导出函数与核心内部函数五要素精讲

本文件**没有任何函数、常量或类型声明**——6 行全是 `export *`。五要素不适用。

### 2.4 轻量私有辅助函数归并表

无。零遗漏声明：18 行中除头注释（1-11）与空行（12）外，全部内容即 `:13-18` 六条星导出，已在 2.2 逐行覆盖。

---

## 3. src/core/ports.ts

### 3.1 模块定位与纯度边界

**定位**：六边形缝（`ports.ts:1`："Storage ports (the hexagonal seams — vision §1 'storage stays swappable')"），glossary 词条 87 锚点。**[纯]**：232 行全部是注释、type-only import 与接口/类型别名声明，无任何运行时语句。

**头注释教义**（`ports.ts:1-10`），四条：

1. **每实体一个端口**，带域操作——绝不是一个通用 key/value 接口（`:4-5`）。
2. core 与环绕它的服务层**只面向这些类型编程**；具体适配器住 `src/store/`（今天 fs JSON/JSONL，将来 SQLite drop-in）（`:5-7`）。
3. **只装配一次**，在组合根 `src/server/stores.ts`（`:7-8`）。
4. **依赖单向**：适配器可以 import core；core 永不 import 适配器（`:8-9`）。这正是 `eslint.config.mjs:58-62` zone 强制的形状。

**进桶**：是（`index.ts:19`）。types-only 意味着编译期擦除——浏览器拿到端口类型零运行时成本（`index.ts:15` 注释明示此理由）。

**import 面（全部 type-only）**：`ports.ts:12` `import type { LhMessage } from "./native-messages.ts"`；`:13-28` 从 `"./contracts.ts"` 取 14 个类型（ChatRecord、ChatSettings、ChatSummary、GraphChain、GraphNode、JobKind、JobRecord、ExtractionRunUsage、PlanTree、Position、CoverageEntry、SessionCheckpoint、TurnUsage、NotesSource）；`:29` `import type { UserSettings } from "./settings.ts"`。core 内部互引，不越层。

### 3.2 装配拓扑：端口 → 适配器 → 组合根 → 数据文件

七个接口（任务点名的 6 大存储端口 + 文件内实际存在的第七个 `SourceOrganizationStore`，一并覆盖）。适配器声明行、装配点、数据文件常量全部取证：

| 端口（ports.ts 行号） | fs 适配器（声明行） | 装配点 | 数据文件（config.ts 行号） |
|---|---|---|---|
| `ChatStore`（33-66） | `src/store/chats.ts:208` `chatStore` | 组合根 `stores.ts:19-21`（traceObject，exclude `getChat`/`listChats`）；另经 `src/server/observability.ts:31` 再导出裸适配器 | `PATHS.chats`（config.ts:27）`<data>/chats/<id>.json` |
| `GraphStore`（76-131） | `src/store/graph.ts:131` `graphStore` | 组合根 `stores.ts:22-24`（exclude 六个 read 方法） | `LEDGER_FILES`（config.ts:62-70：nodes/chains/sessions/coverage 四个 .jsonl）、`SOURCES_FILE`（:77）、`POSITIONS_FILE`（:83） |
| `SourceOrganizationStore`（134-137） | `src/store/source-organization.ts:10` | 组合根 `stores.ts:25-27`（exclude `read`） | `SOURCE_ORGANIZATION_FILE`（config.ts:79） |
| `JobStore`（154-169） | `src/store/jobs.ts:113` `jobStore` | 组合根 `stores.ts:28-30`（exclude `getJob`/`listJobs`/`findJobByToolCallId`） | `JOBS_DIR`（**不在 config.ts**，`src/store/jobs.ts:20` 自定义，注释 :19 "orchestrator-owned"） |
| `SettingsStore`（182-187） | `src/store/settings.ts:62` `settingsStore` | 组合根 `stores.ts:31-33`（exclude `readSettings`）；另经 `src/server/index.ts:26` 再导出 | `SETTINGS_FILE`（config.ts:114） |
| `PromptOverrideStore`（200-211） | `src/store/prompt-overrides.ts:43` `promptOverrides` | **不进组合根**；经 server 桶 `src/server/index.ts:28` 再导出；消费者 `app/api/settings/prompts/[...segment]/route.ts:31`（写 :59 / 删 :76）、`app/api/settings/[section]/route.ts:40`（孤儿检查 :99） | `PROMPTS_OVERRIDE_DIR`（config.ts:129） |
| `AuthStore`（223-231） | `src/store/auth.ts:51` `authStore` | **不进组合根**；经 server 桶 `src/server/index.ts:41` 再导出；核心消费者 `src/server/keys.ts:55`（import；:95/:131/:177/:189/:190 读，:220 写，:237 删） | `AUTH_FILE`（config.ts:145-147，`$LH_AUTH_FILE` 或 `<root>/auth.json`） |

组合根本体（`src/server/stores.ts:18-34`）：五个适配器各包一层 `traceObject("STORE", …)`（第 5 节的透明 Proxy），exclude 集合全是高频读方法——**读不记日志、写才记**，避免日志噪音。`Stores` 类型（`:36`）结构化满足 `core/graph.ts` 的 `GraphDeps`（`:17` 注释）。`effectiveSettings()`（`:46-48`）每次现读现解析、无缓存（`:43-44` 注释：设置 PUT 后的陈旧开关比现读更糟）。模块加载即 `syncCustomProvider()`（`:52`）。

**为什么 PromptOverrideStore / AuthStore 不进组合根**：组合根注释（`stores.ts:2-6`）说它是"唯一装配具体 store 适配器的地方"，而这两个适配器是模块级单例、由 server 桶直接再导出给路由/keys 服务使用——它们同样"只装配一次"（单例 export），只是不经过 `stores` 对象聚合，也不被 traceObject 包装（密钥与提示词覆盖的读写不进 STORE 日志）。这是如实的代码形状，不强行圆成"七端口全在 stores.ts"。

### 3.3 六大存储端口 + 第七接口：逐方法语义契约

以下每个方法给出：签名（行号）、参数/返回、语义契约、幂等/原子性要求与适配器实现证据。适配器写入 durability 分三档（scout 取证汇总）：**原子 temp+rename**（graph 的 rewriteLedgers/writePositions/deleteSources、auth writeMap、source-organization write）、**append-only JSONL**（graph appendLine）、**普通覆写**（chats writeChat、jobs、settings、sources map、prompt overrides）。

#### 3.3.1 ChatStore（ports.ts:33-66）——会话记录之家（data/chats）

| 方法（行号） | 参数 → 返回 | 语义契约 | 幂等/原子性（适配器证据） |
|---|---|---|---|
| `createChat`（37） | `(title: string, kind?: "practice") → ChatRecord` | 创建会话记录并**立即持久化**（:34 注释）；`kind:"practice"` 标记练习会话，缺省 = teach（:35-36） | 非幂等（每次新 id）。适配器 `chats.ts:35-51`：id = `chat_<base36时间>_<uuid8>`（:38），title trim 兜底 "Untitled session"（:39），经唯一写入口 `writeChat`（:48）盖 schema 版本戳，返回与落盘内容一致的内存孪生（:50）；**emit `chats-changed`**（:49） |
| `getChat`（39） | `(id: string) → ChatRecord \| null` | 完整记录；未知 id / 损坏文件 = null（:38 注释） | 只读。适配器 `chats.ts:61-77`：读+parse 同一 try，任何异常 → null（:63-68）；**未来版本守卫**（:71-76）：`version > CURRENT_CHAT_VERSION` 拒读返回 null（降级构建绝不重写看不懂的记录，glossary 词条 101） |
| `listChats`（41） | `() → ChatSummary[]` | 全部会话，最新活动在前（侧栏列表视图，:40 注释） | 只读。适配器 `chats.ts:79-121`：逐记录 try（:92-113）保证一条坏记录不拖垮整个侧栏；剥离 messages/tree/turns/extractions 只留摘要（:87）；派生 kind/messageCount/phase/pendingQuestion（:99-109）；按 `updatedAt` 降序（:117）；外层异常 → `[]`（:118-120）。活性/busy 不在这里（API 路由合并） |
| `saveMessages`（44） | `(id: string, messages: LhMessage[]) → void` | 持久化**完整**原生消息列表——记录即 agent 状态（Wave B，owner-approved 2026-09-26，:42-43 注释） | 整体替换（非增量）。适配器 `chats.ts:126-132`：未知 id 抛 `Chat not found`（:128）；替换 messages（:129）并** bump `updatedAt`**（:130）；经 writeChat（:131）。**刻意静默**（SILENCE LAW，见下） |
| `saveTree`（46） | `(id: string, tree: PlanTree) → void` | 持久化计划树；plan 工具在 execute 中调用（:45 注释） | 整体替换。适配器 `chats.ts:199-206`：**不 bump updatedAt**（:201-202 注释）；静默 |
| `appendTurnUsage`（51） | `(id: string, entry: TurnUsage) → void` | 向记录的回合金钱日志追加一条（:47-50 注释）；**按 turn id 幂等**——每个请求携带自己的 id，同一回合持久化两次只追加一次；而 continuation 回合（共享响应消息 id）各自保留用量 | 幂等键 = `entry.id`。适配器 `chats.ts:138-145`：`record.turns.some(t => t.id === entry.id)` 命中则原样保留（:141-143）；不 bump updatedAt；静默 |
| `appendExtractionUsage`（53） | `(id: string, entry: ExtractionRunUsage) → void` | 追加一条抽取运行用量——**按 startedAt 幂等**（:52 注释） | 幂等键 = `entry.startedAt`（适配器 `chats.ts:150-157`，:153-155），中止/重放的抽取运行不被重复计费；静默 |
| `saveSettings`（56） | `(id: string, settings: ChatSettings) → void` | 持久化每会话模型/思考设置；**replace-whole**——picker 发送完整设置对象（:54-55 注释） | 整体替换。适配器 `chats.ts:161-168`：**不 bump updatedAt**（:163-165 注释："sidebar order must not churn"）；静默 |
| `renameChat`（60） | `(id: string, title: string) → ChatRecord` | 重命名（header 点击编辑，2026-09-17）；重命名**不是会话活动**——updatedAt 原地不动，侧栏顺序永不因重命名抖动（:57-59 注释） | 适配器 `chats.ts:175-182`：title trim 兜底（:178），不动 updatedAt（:170-174 注释），**emit `chats-changed`**（:180，列表形状变化） |
| `deleteChat`（65） | `(id: string) → boolean` | 整体删除会话记录（session-deletion wave 6，owner 2026-09-22）；未知 id = false；**图谱账本清洗与 job 清理是调用方的编排**（core/graph-deletion.ts + DELETE 路由），不是 store 的职责（:61-64 注释） | 适配器 `chats.ts:188-196`：unlink 成功才 **emit `chats-changed`**（:191，"only a real removal — the present-entry law"）并返回 true；任何异常（未知 id/已删/不可读）→ false（:192-195），同一答案 |

**两条支配性纪律**（适配器侧，解释上表所有静默/盖章行为）：

- **静默法则**（glossary 词条 96；`src/store/chats.ts:26-34` THE SILENCE LAW）：`chats-changed` 只通知**列表形状**变化（create/rename/delete）；内容写入器（saveMessages/appendTurnUsage/appendExtractionUsage/saveSettings/saveTree）刻意静默——回合的列表可见效应已由 `turn-started`/`turn-settled` 通知。
- **唯一写入口**（glossary 词条 97；`src/store/chats.ts:53-59` THE WRITE CHOKE POINT）：一切持久化经 `writeChat`（:57-59），统一盖 `version: CURRENT_CHAT_VERSION`。注意 durability 事实：chats 用普通 `fs.writeFileSync`，**没有** temp+rename（与 graph/auth 不同）——崩溃语义靠 write-ahead（预写，glossary 词条 8）与回合收尾的持久化策略兜底，而非单文件原子替换。

#### 3.3.2 GraphStore（ports.ts:76-131）——append-only 证据账本（data/graph）

**段头教义**（`ports.ts:68-74`）：链是存储真相（owner 2026-09-30）——节点 + 推理链；**边是派生视图**（core/graph.ts），永不触碰此缝。读返回原始追加顺序行；按 (premises, conclusion) 合并链断言是 core/graph.ts 的**派生**职责——store 从不做决定。抽取流水线是唯一写入方；此读面保留。账本 = glossary 词条 54（append-only JSONL，`ports.ts:68` 锚点）。

| 方法（行号） | 参数 → 返回 | 语义契约 | 幂等/原子性（适配器证据） |
|---|---|---|---|
| `appendNode`（78） | `(node: GraphNode) → void` | 追加一个节点；id 唯一——无需合并（:77 注释） | append-only。适配器 `graph.ts:132-134` → `appendLine`（:53-57）：mkdir + `ensureGraphFormat()`（:55，lazy 格式戳）+ `fs.appendFileSync`（:56）。重复 id 的链接追加也允许（合并是派生） |
| `readNodes`（80） | `() → GraphNode[]` | 原始节点行，追加顺序（:79 注释） | 只读。适配器 `graph.ts:138-140` → `readValid`（:87-90）：先 `assertGraphFormat()`（:88，更新格式戳的数据目录拒读）再逐行严格守卫过滤；`readRawLines`（:59-78）缺文件 → `[]`（:62-64），**坏行逐行跳过**（:71-76，"a torn append must never take the home graph down"） |
| `appendChain`（84） | `(assertion: GraphChain) → void` | 追加一条链**断言**：第二个会话断言同一 (premises, conclusion) 就再追加一行；读者合并（:82-83 注释） | append-only，不去重（去重是派生职责）。适配器 `graph.ts:144-146` |
| `readChains`（85） | `() → GraphChain[]` | 原始链断言行 | 只读。适配器 `graph.ts:147-149` |
| `appendCheckpoint`（88） | `(checkpoint: SessionCheckpoint) → void` | 追加一个 emission checkpoint（:87 注释） | append-only。适配器 `graph.ts:151-153`（`LEDGER_FILES.sessions`） |
| `readCheckpoints`（89） | `() → SessionCheckpoint[]` | 原始 checkpoint 行 | 只读。适配器 `graph.ts:154-156` |
| `appendCoverage`（93） | `(entry: CoverageEntry) → void` | 消息粒度抽取覆盖（vision-extraction-coverage.md）：append-only，每条被覆盖消息一行；它是 chat-extraction 的 checkpoint——**"uncovered" 由这些行派生，从不双轨跟踪**（:90-92 注释；glossary 词条 55） | append-only。适配器 `graph.ts:158-160` |
| `readCoverage`（94） | `() → CoverageEntry[]` | 原始覆盖行 | 只读。适配器 `graph.ts:161-163` |
| `upsertSource`（101） | `(source: NotesSource) → void` | upsert 一条导入笔记 source 记录（`config.SOURCES_FILE`——**JSON map，不是账本**）；upsert 保留既有 usage 日志（:99-100 注释） | 读-改-写。适配器 `graph.ts:168-173`：重导入时保留 `prev.extractions`（:170-171） |
| `readSources`（103） | `() → NotesSource[]` | 全部笔记 source 记录，id 顺序不敏感（:102 注释） | 只读。适配器 `graph.ts:174-176`：`Object.values(readSourceMap())`，无排序 |
| `deleteSources`（105） | `(ids: ReadonlySet<string>) → number` | **只删导入 source 的簿记**；图谱痕迹由服务先删（:104 注释） | 返回实删数。适配器 `graph.ts:177-191`：空集 → 0（:178）；只数 `Object.hasOwn` 命中（:181）；零命中不写盘（:182）；否则 **temp+rename 原子替换**（:183-186），finally 清残留 tmp（:187-189） |
| `appendSourceUsage`（108） | `(id: string, entry: ExtractionRunUsage) → void` | 向 source 记录追加一次运行用量——**按 startedAt 幂等**，镜像 `ChatRecord.extractions`（:106-107 注释） | 适配器 `graph.ts:193-201`：未知 source id 静默 return（:196，"nothing to bill against"）；startedAt 去重（:197-199）；写 map 非原子（:324 普通 writeFileSync） |
| `readPositions`（113） | `() → Record<string, Position>` | 布局账本（`config.POSITIONS_FILE`）：nodeId → 静止 {x,y}；**只由合并后的增量落定写入**（core/layout.ts `settleGraphLayout`——实际函数在 core/layout-settle.ts，见第 1 节），其余一切只读（:110-112 注释） | 只读。适配器 `graph.ts:204-206` → `readPositionMap`（:256-274）：缺文件 → `{}`（:259-261），逐坐标有限性校验（:265-269），损坏 → `{}`（:271-273） |
| `writePositions`（115） | `(positions: Record<string, Position>) → void` | 整体替换账本（落定是全图计算，:114 注释） | **temp+rename 原子**。适配器 `graph.ts:207-209` → `writePositionMap`（:276-293）：tmp（:281）写 `{positions, updatedAt}`（:283）rename（:284），失败清 tmp 再抛（:285-291） |
| `rewriteLedgers`（125-130） | `(next: { nodes?; chains?; coverage?; checkpoints? }) → void` | **THE DESTRUCTIVE SEAM**（session-deletion wave 6，owner 2026-09-22——这些账本上的第一个非 append 操作，:117-124 注释）：原子替换六个可重写账本中任意子集的全部内容；每个提供的数组写 temp 文件再 rename 覆盖（崩溃安全：撕裂写永不替换原件）；缺省 key 的账本不动；**纯计算在 core/graph-deletion.ts——store 只负责让替换原子化** | 逐账本 **temp+rename**。适配器 `graph.ts:217-249`：字段→文件映射（:223-228，checkpoints→sessions.jsonl），唯一 tmp（:232），JSONL 体（:236，空数组 ⇒ 空文件），writeFileSync(tmp)（:237）+ renameSync（:238），失败清 tmp 再抛（:239-245） |

**孤儿注释（真实代码事实）**：`ports.ts:96-97` 有一条文档注释 "Append one cluster-naming run's usage (graph-global money channel) — idempotent per startedAt."，**其下没有任何方法声明**（下一条是 :99 的 upsertSource 注释）。适配器 `src/store/graph.ts` 全文无 naming/cluster 相关代码（rg 零命中）。旁证：`src/core/cost-summary.ts:6-8`——"The cluster-naming channel died with the extraction-UX close-out, 2026-09-24 … historical naming-runs.jsonl spend is simply not displayed"。即：簇命名通道已死，注释是遗留残骸，端口面没有这个方法。

**graph 适配器全程静默**：`src/store/graph.ts` 没有 import `emit`，任何账本写入都不发事件——图谱视图的刷新由抽取流水线的 `activity-changed`（`extraction.ts:866/874`）与路由层编排通知，账本本身遵守"事实落盘、通知归编排"的分工。另有一个模块加载期副作用：legacy `edges.jsonl`/`events.jsonl` 的一次性清除（`graph.ts:330-343`）——边成为派生视图后的历史文件清扫。

#### 3.3.3 SourceOrganizationStore（ports.ts:134-137）——第七接口

`read(): SourceOrganization`（:135）/ `write(state: SourceOrganization): void`（:136），类型经内联 `import("./source-organization.ts")` 引用。段注释（:133）："Separate from graph ledgers and source identity, for future shared views"——组织是展示元数据，绝非图谱/抽取身份（glossary 词条 49）。

适配器 `src/store/source-organization.ts:10-33`，两个与其他 store 不同的严格性选择：

- `read`（:11-20）：先 `assertGraphFormat()`（:12）；ENOENT → `emptySourceOrganization()`（:15-17）；**其他错误重抛**（:17）、损坏文件经 `parseSourceOrganization` 抛错（:19）——不像 chats/auth 那样吞成 null/{}。
- `write`（:21-33）：assert（:22）→ 重新 parse 归一（:23，落盘的是清洗后的值）→ ensureGraphFormat（:25）→ **temp+rename**（:26-29）→ finally 清 tmp（:30）→ **emit `sources-changed`**（:31）。

#### 3.3.4 JobStore（ports.ts:154-169）——背景 sub-agent 任务（data/jobs）

**辅助契约**：`CreateJobInit`（:141-149）= kind/chatId/toolCallId + 可选 activity（缺省 "starting"，:145-146）与 input（**在 worker 出生前保存到 job 上**，:147-148）。`JobPatch`（:152）= `Partial<Omit<JobRecord, "id"|"kind"|"chatId"|"toolCallId"|"createdAt">>`——**身份字段不可变**由类型系统保证（:151 注释），适配器不再复查。

| 方法（行号） | 参数 → 返回 | 语义契约 | 幂等/原子性（适配器证据） |
|---|---|---|---|
| `createJob`（156） | `(init: CreateJobInit) → JobRecord` | 创建一个 running job；**以 toolCallId 为键做 spawn 去重**（:155 注释） | 去重是**调用方**职责（先 `findJobByToolCallId`），适配器自身不去重（`jobs.ts:5-6` 注释）。适配器 `jobs.ts:31-48`：id = `job_<base36>_<uuid8>`（:33），status running（:38），activity 兜底（:39），普通 writeFileSync（:45，非原子），**emit `jobs-changed` {chatId}**（:46） |
| `getJob`（157） | `(id: string) → JobRecord \| null` | 单条读取 | 只读。适配器 `jobs.ts:50-56`：任何错误 → null |
| `updateJob`（159） | `(id: string, patch: JobPatch) → JobRecord \| null` | 把 patch 合并进记录；未知 id → null（:158 注释） | 适配器 `jobs.ts:61-71`：null 时**不写不发**（:62-63）；合并 `{...record, ...patch, updatedAt: patch.updatedAt ?? now}`（:64，显式时间戳被尊重）；**每次写都 emit `jobs-changed`**（:69，注释 :66-68：进度行更新也必须到达派发卡片，视图侧 debounce fetch  bursts） |
| `listJobs`（161） | `(chatId: string) → JobRecord[]` | 一个 chat 的全部 job，最新活动在前（:160 注释） | 只读。适配器 `jobs.ts:74-86`：过滤 chatId（:81），updatedAt 降序（:82），异常 → [] |
| `findJobByToolCallId`（163） | `(chatId, toolCallId) → JobRecord \| null` | 找到履行某 tool part 的 job（spawn-hook 去重，:162 注释） | 只读。适配器 `jobs.ts:89-91`：listJobs 线性扫描 |
| `deleteJobsForChat`（168） | `(chatId: string) → number` | 删除一个 chat 的**全部** job 记录——运行中或已完成（wave 6）；返回删除文件数；删除路由在仍有运行中 job 时拒绝，所以触发时每条记录都已终态（:164-167 注释） | 适配器 `jobs.ts:97-111`：只数实删（:102-104，已消失的文件不计数）；**removed > 0 才 emit**（:109，present-entry law，与 endTurn 同款） |

#### 3.3.5 SettingsStore（ports.ts:182-187）——唯一用户设置记录

段注释（:173-181）：一切非秘密产品偏好的**唯一记录**（`core/settings.ts` `UserSettings`，delta 语义）；store 对记录 **replace-whole**；按 section 的作用域是 server-band 职责（单进程，此缝无需防陈旧客户端）；**schema 版本 lazy 迁移发生在 readSettings 内部，绝不在调用方**；legacy default-settings.json 折叠已随 chat section 死亡（每会话模型，owner 2026-09-28）。

| 方法（行号） | 参数 → 返回 | 语义契约 | 幂等/原子性（适配器证据） |
|---|---|---|---|
| `readSettings`（184） | `() → UserSettings \| null` | **清洗后**的记录；尚不存在（首次启动）→ null（:183 注释） | 只读、读时迁移。适配器 `settings.ts:31-50`：缺文件 → null（:35-37）；parse 失败 → null（:39-43，损坏 ⇒ 工厂默认）；`sanitizeUserSettings(parsed)`（:44）——磁盘上的一切值先清洗再到调用方；版本链当前为空（:46-48，v1 是第一个形状，纯增量不 bump）；读不写盘 |
| `writeSettings`（186） | `(settings: UserSettings) → void` | 持久化记录（replace-whole）；**调用方传入已清洗记录**（:185 注释） | 适配器 `settings.ts:53-59`：再清洗一次（:54，非对象抛错 :55）；普通 writeFileSync 整体覆写（:57，非原子）。适配器参数实为 `raw: unknown`（宽于端口，仍可赋值）；另有绕过端口的直接导出 `readSettings`/`writeSettings` 供 `src/server/custom-provider-http.ts:5` 使用 |

#### 3.3.6 PromptOverrideStore（ports.ts:200-211）——逐段系统提示词覆盖

段注释（:191-199）：用户文本覆盖**一个**源提示词段（共享 base 或一个数字 fragment），存于镜像源布局的 data-dir 缝（`config.PROMPTS_OVERRIDE_DIR`）。**文件存在 ≠ 覆盖生效**：设置记录的 `agent.prompts` 开关才是显式 on/off——用户可以把定制文件留在磁盘上同时跑源默认。段**列表**永远在运行时从源派生（loader 规则见适配器）。

| 方法（行号） | 参数 → 返回 | 语义契约 | 幂等/原子性（适配器证据） |
|---|---|---|---|
| `listOverrides`（203） | `() → string[]` | 当前磁盘上的全部覆盖路径（"system-prompt.md"、"teacher/20-teaching.md"…），POSIX 相对、已排序（:201-202 注释） | 只读。适配器 `prompt-overrides.ts:44-61`：递归 walk（:45-58），缺目录 → []（:50-52）；只收 `.md` 且 `isValidSegmentPath(rel)`（:56，文法在 `core/prompt-segments.ts:45`）；`out.sort()`（:60） |
| `readOverride`（205） | `(segmentPath: string) → string \| null` | 覆盖文本；该路径无文件 → null（:204 注释） | 只读。适配器 :63-70：非法路径 → null（:64，防遍历/绝对路径/空段）；读错误 → null（:68-69） |
| `writeOverride`（207） | `(segmentPath: string, text: string) → void` | 持久化某段的覆盖文本（**创建父目录**，:206 注释） | 适配器 :72-77：非法路径 → 静默 no-op（:73）；mkdir recursive（:75）；普通 writeFileSync（:76）；不发事件 |
| `deleteOverride`（210） | `(segmentPath: string) → void` | 删除覆盖文件（若存在）；**开关不动**——on 开关 + 无文件 = 组合源默认，惰性无害（:208-209 注释） | 幂等。适配器 :79-83：非法路径静默 return（:80）；文件缺席 = 静默成功（:81-83） |

#### 3.3.7 AuthStore（ports.ts:223-231）——自带密钥（BYOK）provider keys

段注释（:215-222）：长期存在的扁平 `{VAR: value}` auth.json map（`config.AUTH_FILE`）——Electron 时代手编的同一文件，如今 server 一等管理。**值是不透明字符串**：形状校验是 server-band 职责（`core/auth-keys.ts` `validateKeyShape`，:163——store 给什么存什么）；env 优先级也是 server-band 职责（`src/server/keys.ts`）。未知变量原样随行。glossary 词条 98 锚点（:213）。

| 方法（行号） | 参数 → 返回 | 语义契约 | 幂等/原子性（适配器证据） |
|---|---|---|---|
| `authVars`（226） | `() → Record<string, string>` | 整个 map；**缺席或损坏文件 = {}**（"no keys yet"，文档化的首次启动态）；**永不抛**（:224-225 注释） | 只读。适配器 `auth.ts:52-54` → `readMap`（:26-36）：非对象/数组 → {}（:29）；只保留字符串值（:31-33）；catch → {}（:35） |
| `setAuthVar`（228） | `(name: string, value: string) → void` | 设置一个 VAR：**原子写、永远 mode 0600、其他变量保留**（:227 注释） | 读-改-写 + 原子替换。适配器 :55-60：`assertOrdinaryVar`（:56；:85-87 对 CUSTOM_AUTH_BINDING / 自定义 provider env var 抛 "Use the custom endpoint editor"）；`writeMap`（:42-49）：pid 后缀 tmp（:45）→ writeFileSync mode 0o600（:46）→ **rename 前 chmodSync 0o600**（:47，umask 可能放宽创建模式，最终路径上绝不存在放宽瞬间）→ renameSync（:48） |
| `deleteAuthVar`（230） | `(name: string) → void` | 删除一个 VAR（若存在）；**缺席 = no-op，仍是静默成功**（:229 注释） | 幂等。适配器 :61-67：同款 assert（:62）；`!(name in map)` 直接 return、不写盘（:64） |

**端口之外的额外导出**（适配器 `auth.ts`，不属于 AuthStore 契约）：`readCustomAuth`（:89-92）/`writeCustomAuth`（:94-105）——自定义 provider 绑定的严格读写（`readCustomMap` :73-83 对非 ENOENT 错误**抛**而非吞成 {}，绝不把不可读的私有记录覆写成空），消费者 `src/server/custom-provider-auth.ts:7`、`src/server/custom-provider-http.ts:6`。

### 3.4 导出函数与核心内部函数五要素精讲

本文件**没有任何运行时函数**——7 个 interface（ChatStore 33、GraphStore 76、SourceOrganizationStore 134、JobStore 154、SettingsStore 182、PromptOverrideStore 200、AuthStore 223）+ 1 个辅助 interface（CreateJobInit 141）+ 1 个类型别名（JobPatch 152），全部在 3.2/3.3 逐一覆盖。五要素不适用。

### 3.5 轻量私有辅助函数归并表

无函数。类型声明全清单（零遗漏）：`ChatStore`（33-66）、`GraphStore`（76-131）、`SourceOrganizationStore`（134-137）、`CreateJobInit`（141-149）、`JobPatch`（152）、`JobStore`（154-169）、`SettingsStore`（182-187）、`PromptOverrideStore`（200-211）、`AuthStore`（223-231）。私有类型：无（`LhEventsGlobal` 那类私有声明在本文件不存在）。

---

## 4. src/core/events.ts

### 4.1 模块定位与纯度边界

**定位**：THE EVENT BUS（`events.ts:1-2`），推送架构 slice 1，owner ruling 2026-10-02："go directly to the endgame — notify → fetch, no standing polls"。glossary 词条 5 的锚点本体。**进桶**：是（`index.ts:31`，注释 :28-30 明示浏览器 shell 经桶消费类型 + 运行时名字）。

**[非纯边界]**——副作用来源逐一拆解：

1. **进程内可变全局状态**：监听器集合挂 `globalThis.__lhEventBus`（`events.ts:90-93` 的 `listeners()`，`??=` 惰性初始化一个 `Set<ServerEventListener>`）。`subscribe` 向集合 add（:99），返回的闭包 delete（:100）——都是对进程级可变状态的写。
2. **任意副作用的放大点**：`emit`（:107-120）同步调用每个监听器（:115），监听器体内做什么（写 SSE socket、console 输出）总线无法控制——它是全层副作用的汇聚缝。
3. **日志 IO**：`emit` 每次调用 `lhLog("EVENT", …)`（:112，import 自 `./logger.ts` 于 :25），监听器抛错时 `console.error`（:117）。

**为什么 globalThis**（头注释 :14-19，与回合活性登记同款纪律，glossary 词条 19）：Next dev 把每个 route 编译成独立模块入口，模块级单例在页面渲染、events 路由、每个 emitter 的入口里是**不同实例**——各持私有监听器集合，什么都传播不出去。globalThis 横跨进程内模块实例，是标准 Next 单例通道（原始事故记录在 `src/server/turn-liveness.ts:8-14`）。**刻意短暂**：进程重启即丢监听器与连接；emitter 从不排队（:88-89 注释）。

**纯与非纯的内部切分**：

- [纯]：`ServerEvents` 词表（28-57）、`ServerEventType`（59）、`SERVER_EVENT_TYPES` 常量（64-74）、`ServerEvent`（77-79）、`ServerEventListener`（81）、`LhEventsGlobal`（83-85）——类型与常量契约，无副作用。
- [非纯边界]：`listeners()`（90-93）、`subscribe`（97-101）、`emit`（107-120）。

**注释与代码的时差（如实登记）**：头注释 :21-22 宣称 "Pure core by law: no React, no IO, no imports — the one layer that server, store, and agent may all depend on"，但 :25 实际 `import { lhLog } from "./logger.ts"`，且 emit 经它做 console IO。"no imports" 与 "no IO" 是字面过时的措辞；准确的现状是：**总线自身的传播逻辑无 IO**（纯内存 Set 操作），IO 只来自日志与监听器体内。依赖方向上它仍是唯一被 server/store/agent 全层依赖的 core 运行时模块（store 适配器 import 它不违反导入法则——core 内部互引）。

### 4.2 核心类型、接口与常量契约

#### ServerEvents 词表（events.ts:28-57）——逐项触发时机与 notify→fetch

事件只携带**事实**，不携带数据（:9-11）：payload 极小、无 schema 版本、幂等——重连靠重新 fetch 自愈。九个事件全部列出，emit 点与浏览器消费者全部取证：

| 事件（行号） | payload | 触发时机（emit 点 path:line） | 浏览器消费者（notify→fetch） |
|---|---|---|---|
| `turn-started`（31） | `{ chatId }` | 回合在 server 侧开始（`beginTurn`）——客户端发起的发送、唤醒回合、其他标签页的回合，**一切来源同一事件**（:29-30 注释）。emit 在登记表写入**之后**（`turn-liveness.ts:48→49`，注释 :41-43：监听者读 isTurnRunning 或 fetch 记录看到一致真相）；被拒的 double-begin（409 路径）保持静默 | `components/chat.tsx:1143`（busy 态/附着）、`components/sidebar.tsx:522`（scheduleEventRefresh 列表刷新） |
| `turn-settled`（35） | `{ chatId }` | 回合收尾（`endTurn`）——**在 persistTurn 之后**，由此事件触发的任何 fetch 读到的都是持久记录（:32-34 注释；顺序保证在 chat-handler 的 onFinish：`chat-handler.ts:616` persistTurn → `:668` endTurn）。仅当登记条目真实存在才 emit（`turn-liveness.ts:61`，防御性 no-op endTurn 不发假收尾） | `components/chat.tsx:1153`（重取持久记录）、`components/sidebar.tsx:523`。**注意区分**：SSE 事件流上也有同名终帧 `{"type":"turn-settled"}`，那是另一条通道的另一生产者——回合已收尾时 reattach 由 `src/server/turn-runs.ts:99` 直接伺服（`ui-stream.ts:37-38` 注释），客户端在 `components/session-core.ts:508-514` 消费；它不经事件总线 |
| `jobs-changed`（38） | `{ chatId? }` | job 记录变化（dispatch/progress/settle/abort/recovery，:36-37 注释）：创建（`store/jobs.ts:46`）、**每次**更新含进度行（`:69`，注释 :66-68）、删除且实删 >0（`:109`）。chatId 可知时携带，单会话消费者按它过滤 | `components/chat.tsx:1112`（fetchJobs）、`components/activity-dock.tsx:133`（活动流，glossary 词条 73） |
| `activity-changed`（40） | `{}`（`Record<string, never>`） | 抽取运行相位变化（活动 dock，:39 注释）：registry 每次相位迁移（`agent/subagents/extraction.ts:866`，notify-after-write，注释 :864-865）与运行结束（`:874` finishExtraction） | `components/activity-dock.tsx:132`、`components/graph-view.tsx:1120`（readPipelineStatus） |
| `chats-changed`（42） | `{}` | 会话**列表形状**变化（create/delete/title，:41 注释）：`store/chats.ts:49`（createChat）、`:180`（renameChat）、`:191`（deleteChat 实删）；内容写入器刻意静默（SILENCE LAW，`chats.ts:26-34`）。另：source 删除路由在 finally 三连发（`app/api/graph/sources/route.ts:18`） | `components/sidebar.tsx:521`、`components/chain-table.tsx:754`（目录重读） |
| `sources-changed`（44） | `{}` | source 清单、展示名或组织文件夹变化（:43 注释）：`store/source-organization.ts:31`（write）、`app/api/graph/import/route.ts:181`（finally，成败都通知）、`app/api/graph/sources/route.ts:18` | `components/chain-table.tsx:753` |
| `subscriptions-changed`（46） | `{}` | Web 订阅状态变化；**总线上没有账号或凭据数据**（:45 注释）：`src/server/web-subscriptions.ts:28`（publish 内） | `components/settings/subscription-client.ts:23`（hub.subscribe） |
| `record-changed`（50） | `{ chatId }` | 记录在**无回合**情况下变化（静默丢弃写，:47-49 注释）；与回合事件同一 notify-then-fetch 契约：打开的视图重取并采纳持久记录。四个 emit 点：ESC 丢弃路由（`app/api/chats/[id]/dismiss/route.ts:63`，write-ahead 无回合）、并行问题闸门存答案（`chat-handler.ts:364`）、丢弃暂存落账（`server/dismissal-park.ts:75`，glossary 词条 27）、压缩 marker 落盘（`server/compaction.ts:263`，注释 :261-262） | `components/chat.tsx:1190` |
| `compaction-changed`（56） | `{ chatId, running }` | 压缩开始/结束（owner round 14，2026-10-05，:51-55 注释）。**running=true 是 SEND GATE**：压缩在飞时 server 结构性拒绝该 chat 的模型交互，客户端镜像禁用 composer/dock 提交。emit：开始（`server/compaction.ts:226`，进入 try 之前）、结束（`:270`，finally 中，成败都发） | `components/chat.tsx:1182`（发送闸门）、`components/sidebar.tsx:524` |

#### 运行时词表与派生类型

- `ServerEventType = keyof ServerEvents`（:59）。
- `SERVER_EVENT_TYPES`（:64-74）：九个名字的字面量数组，`] as const satisfies readonly ServerEventType[]`（:74）——**编译期穷尽性校验**（漏写/多写任何一个词表成员都报错）+ 运行时单一事实来源（:61-63 注释：类型被擦除，这份列表是 SSE 通道能承载什么的唯一权威）。客户端按名字逐个接线：`components/server-events.tsx:110` `for (const name of SERVER_EVENT_TYPES) source.onEvent(name, …)`。
- `ServerEvent<K>`（:77-79）：`{ type: K } & ServerEvents[K]`——类型判别 payload 的通知形状。
- `ServerEventListener`（:81）：`(event: ServerEvent) => void`。
- `LhEventsGlobal`（:83-85，私有）：`{ __lhEventBus?: Set<ServerEventListener> }`——globalThis 的交叉类型补丁。

#### notify→fetch 全链路（机制拆解）

```
emit(type, payload)                          events.ts:107
  → 快照遍历监听器                            events.ts:110-115
  → 通知通道监听器（每窗口一个）               src/server/events-stream.ts:60-63
      frame(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
  → GET /api/events SSE 响应                  app/api/events/route.ts:13-15 → eventsResponse（events-stream.ts:30）
  → 浏览器 EventSource（每窗口一条）           components/server-events.tsx:38-49 openEventsChannel
  → wireSource 按 SERVER_EVENT_TYPES 接线     server-events.tsx:109-112
  → createNotifyHub.dispatch 解析+扇出        server-events.tsx:77-94（坏帧丢弃并 console.error，绝不半触发）
  → useServerEvent 回调（latest-ref）         server-events.tsx:132-143
  → 消费者自行 fetch 真相                     /api/chats/:id、/api/jobs、/api/activity …
```

配套纪律：通知通道**先同步附着再谈其他**（`events-stream.ts:57-60` 注释：单线程下构造与订阅之间不会漏事件，与 SSE 事件流的 attach-then-replay 法则同款）；25s `: ping` 心跳（:64）；连接生命周期 = 客户端生命周期，cancel 是唯一终点且必须不动总线上的其他窗口（:21-25、:68-72）；EventSource 自动重连被**利用而非对抗**——每次 (re)open 触发 resync 回调，一个普通 fetch 自愈（`server-events.tsx:11-14`、`:70-73` onResync、`:147-158` useServerResync）。桌面应用对 localhost 持有 N≈1-3 条连接，空闲零流量（`events-stream.ts:11-15`，owner ruling 2026-10-02：轮询的云经济学在 loopback 不存在）。

### 4.3 导出函数与核心内部函数五要素精讲

#### 4.3.1 `listeners()`（私有，核心内部函数）

**① 完整签名、行号与纯度标签**：`function listeners(): Set<ServerEventListener>`，`events.ts:90-93`。**[非纯边界]**（读+惰性写 globalThis）。

**② 输入输出与不变量**：无参数；返回进程内**唯一**的监听器 Set。不变量：同一进程的所有模块入口拿到同一个 Set 引用；进程重启后重新为空（刻意短暂，:88-89）。

**③ 核心逻辑与分支逐步推导**：
1. `:91` 把 globalThis 交叉断言为 `typeof globalThis & LhEventsGlobal`——类型系统不知道 `__lhEventBus`，用私有接口（:83-85）补上。
2. `:92` `return (g.__lhEventBus ??= new Set())`——空值合并赋值：首次调用创建 Set 并挂上 globalThis，此后直接返回既有引用。一行完成惰性初始化 + 单例保证。

**④ 边界条件与设计背景**：Next dev 每 route 独立模块入口 → 模块级 `const listeners = new Set()` 会裂成多份（头注释 :14-19 的原始事故，同 `turn-liveness.ts:8-14`）。globalThis 是标准 Next 单例通道。无锁需求：Node 单线程事件循环内 `??=` 与 Set 操作都是同步原子的。

**⑤ 真实上游调用方**：`subscribe`（`events.ts:98`）、`emit`（`events.ts:110`）。仅此两处（模块内私有）。

#### 4.3.2 `subscribe`（导出）

**① 完整签名、行号与纯度标签**：`export function subscribe(listener: ServerEventListener): () => void`，`events.ts:97-101`。**[非纯边界]**（向全局 Set 写入）。

**② 输入输出与不变量**：入参一个监听器回调；返回**退订函数**。不变量：退订闭包捕获的是 `listeners()` 返回的**同一个 Set 引用**（:98 先取引用），即使将来 globalThis 上的集合被替换（实际不会），退订仍作用于当初加入的那个集合；重复 subscribe 同一函数引用 = Set 幂等（只存一份）；退订后再退订 = delete 幂等（返回 false，无异常）。

**③ 核心逻辑与分支逐步推导**：
1. `:98` `const set = listeners()`——取（或惰性创建）全局集合。
2. `:99` `set.add(listener)`。
3. `:100` `return () => set.delete(listener)`——闭包退订，无其他状态。

**④ 边界条件与设计背景**：注释 :95-96："Returns the unsubscribe function — the SSE route's cancel and any test cleanup call it; a dropped listener leaks nothing." 监听器生命周期 = 连接生命周期：通知通道的 `stop()` 调 `unsubscribe?.()`（`events-stream.ts:42`），cancel 路径保证监听器与心跳绝不比连接活得久（:45-47 注释）。总线不持监听器以外的任何 per-listener 状态，退订即彻底释放。

**⑤ 真实上游调用方**：`src/server/events-stream.ts:60`（通知通道每窗口附着，import 于 :27）；测试 `tests/events.test.ts:18、32、41、44`。浏览器侧**不**调用总线 subscribe——客户端用的是窗口本地 hub 的同名方法（`components/server-events.tsx:59`，那是另一个函数，勿混淆）。

#### 4.3.3 `emit`（导出）

**① 完整签名、行号与纯度标签**：`export function emit<K extends ServerEventType>(type: K, payload: ServerEvents[K]): void`，`events.ts:107-120`。**[非纯边界]**（调用任意监听器 + 日志 IO；对总线集合本身只读）。

**② 输入输出与不变量**：泛型 K 把 payload 钉死到词表对应形状（编译期保证 `emit("turn-started", {})` 缺 chatId 直接报错）。无返回。不变量：
- **零订阅者 = no-op**（:103-104 注释：没开窗时 emission 本来就是 store 自己的簿记）；
- **一个监听器抛错绝不破坏其他监听器或 emitter**（:105-106）：每次调用隔离、失败记日志、循环继续；
- **不排队、不重放**：emission 是即发即忘的事实通知，错过靠消费者重连 fetch 自愈；
- 遍历期间集合被增删不影响本次遍历（快照）。

**③ 核心逻辑与分支逐步推导**：
1. `:110` `const activeListeners = [...listeners()]`——**快照**（注释 :108-109：emit 中途退订/订阅的监听器不得在迭代下 mutate 集合）。展开成数组后，Set 的后续变化与本次遍历无关。
2. `:111` `const chatId = (payload as { chatId?: string } | undefined)?.chatId`——从 payload 可选地提取 chatId 作为日志 contextId；无 chatId 的事件（`Record<string, never>`）得 undefined。
3. `:112` `lhLog("EVENT", \`emit "${type}"\`, { ...payload, listeners: activeListeners.length }, chatId)`——每次 emission 记一行 EVENT 日志，附监听器数量（观测"有没有人在听"）。
4. `:113-119` for-of 快照：`try { listener({ type, ...payload } as ServerEvent) }`（:115，把 type 与 payload 摊平成判别联合形状）`catch (err) { console.error(\`[events] listener failed on ${type}:\`, err) }`（:117）——隔离失败，循环继续。

**④ 边界条件与设计背景**：同步调用意味着 emit 的耗时 = 所有监听器耗时之和；通知通道监听器只调用一次 `frame()`（`events-stream.ts:62`），其内是一次 `controller.enqueue`（:51），失败路由到 stop()（:52-54），所以 emitter 不会被死连接拖住。`as ServerEvent` 断言（:115）是泛型摊平后 TS 无法自动收窄判别联合的务实处理。事件词表"fixed from day one"（:27 注释）——新增事件必须同时改 ServerEvents 与 SERVER_EVENT_TYPES（satisfies 强制穷尽）。

**⑤ 真实上游调用方（全仓 22 个生产 emit 点，逐一取证）**：

| 层 | emit 点 | 事件 |
|---|---|---|
| store | `src/store/jobs.ts:46`（import :14） | jobs-changed（创建） |
| store | `src/store/jobs.ts:69` | jobs-changed（每次更新） |
| store | `src/store/jobs.ts:109` | jobs-changed（实删 >0） |
| store | `src/store/chats.ts:49`（import :13） | chats-changed（创建） |
| store | `src/store/chats.ts:180` | chats-changed（重命名） |
| store | `src/store/chats.ts:191` | chats-changed（实删） |
| store | `src/store/source-organization.ts:31`（import :7） | sources-changed |
| server | `src/server/turn-liveness.ts:49`（import :23） | turn-started |
| server | `src/server/turn-liveness.ts:61` | turn-settled |
| server | `src/server/chat-handler.ts:364`（import :52） | record-changed（并行问题闸门） |
| server | `src/server/compaction.ts:226`（import :47） | compaction-changed running=true |
| server | `src/server/compaction.ts:263` | record-changed（压缩 marker） |
| server | `src/server/compaction.ts:270` | compaction-changed running=false |
| server | `src/server/dismissal-park.ts:75` | record-changed（暂存落账） |
| server | `src/server/web-subscriptions.ts:28`（import :12） | subscriptions-changed |
| agent | `src/agent/subagents/extraction.ts:866`（import :28） | activity-changed（相位迁移） |
| agent | `src/agent/subagents/extraction.ts:874` | activity-changed（运行结束） |
| app 路由 | `app/api/chats/[id]/dismiss/route.ts:63`（经桶 import :22） | record-changed |
| app 路由 | `app/api/graph/import/route.ts:181`（经桶 import :23-30） | sources-changed |
| app 路由 | `app/api/graph/sources/route.ts:18`（经桶 import :2） | sources-changed + chats-changed + activity-changed（一行三连发） |

（22 个 emit() 调用 = 上表 20 行中 sources 路由一行计 3 次。）测试驱动：`tests/events.test.ts:19-21、33、35、45、51` 等。**浏览器侧零 emit 调用**（components/ 全量检索无命中）——总线运行时名字虽经桶可达浏览器，实际只有 server/store/agent/app 在发。

### 4.4 轻量私有辅助函数归并表（100% 覆盖）

| 名称 | 行号 | 类别 | 用途 |
|---|---|---|---|
| `LhEventsGlobal` | 83-85 | 私有 interface | globalThis 交叉类型补丁（`__lhEventBus?: Set<ServerEventListener>`） |
| `listeners()` | 90-93 | 私有函数 | 惰性初始化并返回进程唯一监听器 Set（五要素见 4.3.1） |

导出面全清单（零遗漏）：`ServerEvents`（28）、`ServerEventType`（59）、`SERVER_EVENT_TYPES`（64）、`ServerEvent`（77）、`ServerEventListener`（81）、`subscribe`（97）、`emit`（107）。文件内再无其他声明。

---

## 5. src/core/logger.ts

### 5.1 模块定位与纯度边界

**定位**：同构观测日志器（`logger.ts:1-2`："Isomorphic observability logger — pure, browser-safe, zero dependencies"），住在 `src/core` 使每一层（components/app/server/agent/store）都能 import 而不违反导入法则（:4-5）。**进桶**：是（`index.ts:91`，最后一条导出）。真实浏览器消费：`components/session-core.ts:29`（经 `"../src/core"` 桶，:37）。

**[非纯边界]**——尽管头注释自称 "pure"，必须如实拆解其副作用/环境读取来源：

1. **环境读取**：`process.env.LH_LOG`（:68）、`process.env.NODE_ENV`（:74、:78）；浏览器 `window.localStorage.getItem("LH_LOG")`（:61，沙箱 iframe 可能抛错，:63-65 吞掉）；`typeof window`/`typeof process` 环境探测（:55、:67、:74、:78）。
2. **console IO 输出**：浏览器 `console.log`（:164，%c CSS 徽章格式）、Node `console.info`（:168，ANSI 颜色行）。这是本模块存在的目的——可观测性输出本身就是副作用。
3. **时钟读取**：`new Date()`（:108，timestamp）、`performance.now()`（:212、:219、:224、:230、:234，traceObject 计时）。
4. **门控缓存（准确形状）**：`traceObject` 内 `const cache = new WeakMap<Function, Function>()`（:193）缓存**包装函数引用**（:206 查、:239 存），保证 `store.method` 读取返回稳定引用；**门控判定本身不缓存**——`isLogEnabled` 每次调用都重读配置（:157、:209 → readLogConfig），所以 `LH_LOG` 开关（env 或 localStorage）即时生效，无需重启或重新取属性。
5. **Proxy 包装**：`traceObject` 返回 ES Proxy（:194），get/set 陷阱改变属性访问行为（透明地插入日志）。

**内部纯函数切分**（任务要求的区分）：

- **[纯] 格式化/解析函数**：`truncateLogValue`（116-129）、`formatDetails`（131-145）、`summarizeStoreCall`（249-278）——输入→输出的确定性字符串/记录变换，无环境读取、无 IO。
- **[纯] 数据常量**：`ANSI_COLORS`（29-38）、`CSS_COLORS`（40-49）、`ANSI_RESET`（51）、`ANSI_DIM`（52）、`LogScope` 类型（19-27）。
- **[非纯边界] 环境探针**（只读不写，但依赖环境）：`isBrowser`（54-56）、`readLogConfig`（58-71）、`isTestEnv`（73-75）、`isProdEnv`（77-79）、`isLogEnabled`（81-105）。
- **[非纯边界] 时钟读取**：`timestamp`（107-114）——格式化逻辑纯，但 `new Date()` 使它不可重复。
- **[非纯边界] 输出/包装**：`lhLog`（150-173）、`traceObject`（179-247）。

**激活矩阵**（头注释 :7-16 + isLogEnabled 实现）：开发默认 ON（`npm run dev` 立即在 Node 终端与浏览器 DevTools 打印系统行为）；测试默认 OFF（保持 test runner 干净，除非 `LH_LOG=1` 或列表显式开启）；生产默认 OFF；`LH_LOG=0/false` 随时静音（浏览器 DevTools `localStorage.setItem("LH_LOG","0")`）；高频流式 chunk（STREAM scope）默认 OFF，除非 `LH_LOG=*,stream` 或 `LH_LOG=stream`。

### 5.2 核心类型、接口与常量契约

- **`LogScope`**（:19-27，导出类型）：8 个字面量——`TURN`（回合调度）、`AGENT`（agent 生命周期）、`TOOL`（工具执行）、`JOB`（背景任务）、`EVENT`（事件总线）、`STORE`（存储适配器）、`SESSION`（客户端会话状态机）、`STREAM`（高频流式 chunk）。
- **`ANSI_COLORS`**（:29-38）：Node 终端色——TURN 青、AGENT  magenta、TOOL 黄、JOB 蓝、EVENT 绿、STORE 灰、SESSION 亮青、STREAM 灰。
- **`CSS_COLORS`**（:40-49）：浏览器 DevTools `%c` 样式——同色系 hex + bold（STREAM 为 normal，:48）。
- **`ANSI_RESET`**（:51）`\x1b[0m`、**`ANSI_DIM`**（:52）`\x1b[2m`（时间戳弱化）。
- 无接口、无类。`traceObject` 的 options 形状（include/exclude 两个 `ReadonlySet<string>`）内联在签名里（:183-188）。

### 5.3 导出函数与核心内部函数五要素精讲

#### 5.3.1 `isLogEnabled`（导出）

**① 完整签名、行号与纯度标签**：`export function isLogEnabled(scope: LogScope): boolean`，`logger.ts:81-105`。**[非纯边界]**（经 readLogConfig 读 localStorage/process.env；无写副作用）。

**② 输入输出与不变量**：入参一个 scope；返回该 scope 此刻是否应输出。不变量：判定是**即时**的（无缓存），同一进程内改 env / 浏览器改 localStorage 立即改变结果；STREAM 永远需要显式 opting-in（任何默认路径都不开它）。

**③ 核心逻辑与分支逐步推导**（优先级自上而下）：
1. `:82` `const raw = readLogConfig()?.trim()`——浏览器 localStorage 优先，回落 process.env（见 5.3.5）。
2. `:83` 显式静音：`raw === "0" | "false" | "off"` → false（一票否决，优先于一切）。
3. `:84-89` 未设置（`!raw`，含 undefined/空串）：test 或 production → false（:87）；否则（开发）→ `scope !== "STREAM"`（:88，开发默认开、STREAM 除外）。
4. `:90-92` 显式全开：`"1" | "true" | "on" | "*"` → `scope !== "STREAM"`（注意裸 `*` 字符串仍不开 STREAM）。
5. `:93-97` 逗号列表解析：toLowerCase → split(",") → 逐段 trim → filter(Boolean)（空段丢弃）。
6. `:98-100` `parts.includes("all")` 或（`"*"` 与 `"stream"` 同时在列）→ true（全开含 STREAM）。
7. `:101-103` 含 `"*"`：`scope !== "STREAM" || parts.includes("stream")`——星号开一切非 STREAM，STREAM 需点名。
8. `:104` 否则成员判定：`parts.includes(scope.toLowerCase())`。

**④ 边界条件与设计背景**：大小写不敏感（:94、:104）；`"*,stream"` 与 `"stream,*"` 等价（:98 的合取）；`"stream"` 单独设置时走 :104 成员判定，只有 STREAM 开——精确对应头注释 :15-16 的两种写法。test 环境默认静音是为了 test runner 输出干净（:11-12），但 `LH_LOG=1` 可显式打开调试测试。

**⑤ 真实上游调用方**：模块内 `lhLog`（:157）、`traceObject` 包装函数（:209）；生产代码中模块外唯一直接调用 `src/server/pi/ui-stream.ts:374`（import :4）——SSE 事件流的 AgentEvent 日志钩子在逐事件映射前先做门控，避免高频 message_update 白做字符串拼装；测试侧 `tests/logger.test.ts:28-29、36-37` 直接断言门控矩阵。

#### 5.3.2 `truncateLogValue`（导出）

**① 完整签名、行号与纯度标签**：`export function truncateLogValue(value: unknown, maxLen = 160): string`，`logger.ts:116-129`。**[纯]**。

**② 输入输出与不变量**：任意值 → 单行、限长字符串。不变量：undefined → `""`；字符串先折叠空白（`\s+` → 单空格）再 trim；超长截断加 `…`；绝不抛（JSON.stringify 失败回落 String(value)）。

**③ 核心逻辑与分支逐步推导**：
1. `:117` undefined → ""（日志里不出现 "undefined" 字样）。
2. `:118-121` 字符串分支：`replace(/\s+/g, " ").trim()`（:119，多行文本压成单行）；长度 > maxLen → `slice(0, maxLen) + "…"`（:120）。
3. `:122-128` 非字符串：try `JSON.stringify(value)`（:123）；结果为空（undefined/函数等 stringify 产出 undefined）→ ""（:124）；超长截断（:125）；catch（循环引用等）→ `String(value)`（:127）。

**④ 边界条件与设计背景**：默认 160，但 formatDetails 对字符串用 100、其他值用 140（:139、:141）——分级限长控制单行日志总宽。注意截断按 UTF-16 code unit 计数，emoji 可能被切半（日志场景可接受）。null 走 JSON 分支得 `"null"`（4 字符），与 undefined 的 "" 刻意不同。

**⑤ 真实上游调用方**：模块内 `formatDetails`（:139、:141）。**模块外零调用**（src/app/components/tests/scripts/electron 全量检索无命中）——导出但暂无外部消费者，属公开工具面。

#### 5.3.3 `lhLog`（导出，核心输出函数）

**① 完整签名、行号与纯度标签**：`export function lhLog(scope: LogScope, action: string, details?: Record<string, unknown>, contextId?: string): void`，`logger.ts:150-173`（doc :147-149："Emit a best-effort console log line for system behavior tracing"）。**[非纯边界]**（门控读环境 + 时钟 + console 输出）。

**② 输入输出与不变量**：无返回。不变量：**best-effort**——整个函数体包在 try/catch（:156、:170-172），任何异常（localStorage 抛、console 抛、格式化抛）都被吞掉，注释 :171："Diagnostics must not interrupt a turn or change a store/tool result."（诊断绝不中断回合、绝不改变 store/tool 结果）；门控关闭时零输出零格式化成本（:157 先返回）；contextId 存在时渲染为 `[id] ` 前缀标签。

**③ 核心逻辑与分支逐步推导**：
1. `:157` `if (!isLogEnabled(scope)) return`——门控先行。
2. `:158` `const ts = timestamp()`——本地时间 HH:MM:SS.mmm。
3. `:159` `const idTag = contextId ? \`[${contextId}] \` : ""`。
4. `:160` `const detailStr = formatDetails(details)`。
5. `:162-164` **浏览器分支**（isBrowser()）：`%c` 徽章格式——`%c[${ts}] [${scope.padEnd(7)}]%c ${idTag}${action}${detailStr}`，`console.log(badge, CSS_COLORS[scope], "color:inherit")`：第一个 %c 吃 scope 颜色，第二个 %c 恢复继承色。
6. `:165-168` **Node 分支**：`ANSI_DIM` 包时间戳、`ANSI_COLORS[scope] ?? ""` 包 scope 徽章（padEnd(7) 对齐八列）、`ANSI_RESET` 收尾，`console.info(line)`。
7. `:170-172` catch 静默。

**④ 边界条件与设计背景**：`scope.padEnd(7)`——最长 scope 名 "SESSION"/"STREAM" 恰 7 字符，列对齐。Node 用 console.info 而非 log（stdout 语义分级）。同构双分支使同一调用点在终端与 DevTools 各得其所（头注释 :8-10）。它是全仓系统行为追踪的唯一入口：回合调度、工具执行、事件总线、存储写、客户端状态机全部经它。

**⑤ 真实上游调用方（生产代码 37 个调用点，src/app/components 范围，按 scope 分组，逐一取证）**：

| scope | 调用点（path:line） |
|---|---|
| SESSION（4） | `components/session-core.ts:332`（状态迁移）、`:512`（SSE 事件流收到 turn-settled 终帧→重取记录）、`:667`（send 输入事件）、`:961`（adoptRecord 吸收乐观消息） |
| TOOL（6） | `src/agent/tool-execute.ts:122`（invalidInputResult，模型将重试）、`:213`（execute 开始）、`:220`（finish）、`:223`（error）、`:238`（questionResult posed）、`:257`（problemResult posed） |
| AGENT（10） | `src/agent/teacher-agent.ts:186`（出题重试）、`:190`（question_stopper 干净出题→收尾等学习者）；`src/server/pi/ui-stream.ts:377`（agent_start）、`:380`（turn_start）、`:383`（message_start）、`:397`（message_end）、`:411`（tool_execution_start）、`:417`（tool_execution_end）、`:425`（turn_end）、`:428`（agent_end） |
| STREAM（2） | `src/server/pi/ui-stream.ts:388`（message_update）、`:414`（tool_execution_update）——默认静音的高频档 |
| TURN（6） | `src/server/chat-handler.ts:204`（404 拒绝）、`:208`（▶ handleChatInput）、`:363`（并行问题闸门）、`:373`（409 拒绝）、`:481`（constructing agent）、`:619`（✔ turn settled，回合收尾完成） |
| JOB（8） | `src/agent/subagents/runner.ts:263`（▶ runJob start）、`:271`（✔ runJob finished）、`:320`（finishJob 成败→queuing steer）；`src/server/jobs.ts:225`（deliverJobResult queued）、`:268`（插纸条交给运行中 agent）、`:388`（settleSteers 已投递且持久）、`:392`（stranded→重新入队 idle wake）、`:583`（▶ firing IDLE WAKE turn） |
| EVENT（1） | `src/core/events.ts:112`（每次 emit，附监听器数） |
| STORE（0 直接） | 无直接 lhLog 调用；经 `traceObject` 包装在方法调用时输出（`src/server/stores.ts:19-33`，见 5.3.4） |

import 路径证据：桶消费 `components/session-core.ts:29+37`；直接相对 import `src/core/events.ts:25`、`src/server/stores.ts:15`（traceObject）、`src/server/jobs.ts:70`、`src/server/chat-handler.ts:53`、`src/server/pi/ui-stream.ts:4`、`src/agent/tool-execute.ts:4`、`src/agent/teacher-agent.ts:25`、`src/agent/subagents/runner.ts:29`。测试侧驱动：`tests/logger.test.ts:43、49、53`（含"details 带抛错 getter 也不得中断"的 best-effort 验证），import 于 :6。

#### 5.3.4 `traceObject`（导出，透明 Proxy 包装器）

**① 完整签名、行号与纯度标签**：`export function traceObject<T extends object>(scope: LogScope, label: string, target: T, options?: { include?: ReadonlySet<string>; exclude?: ReadonlySet<string> }): T`，`logger.ts:179-247`（doc :175-178）。**[非纯边界]**（包装本身创建 Proxy/WeakMap；被包装方法的每次调用可能读时钟、读门控、写 console）。

**② 输入输出与不变量**：返回类型仍是 T——**透明**是核心契约：返回值、异常、this 语义不变，唯一可观察差异是日志行。不变量：
- 同一原函数引用多次读取返回**同一包装引用**（WeakMap 缓存，:193/:206/:239）；
- 测试直接改 `store.method = mockFn` 立即生效（set 陷阱透传 Reflect.set，:243-245；缓存按原函数键控，新函数自然未命中缓存）；
- 门控关闭时走快路径（:209-211），不计时不拼装，直接 apply 原函数；
- 异步方法的失败**原样重抛**（:226、:236），绝不吞错改结果。

**③ 核心逻辑与分支逐步推导**：

*get 陷阱（:195-242）*：
1. `:196` `Reflect.get(obj, prop, receiver)` 取原值。
2. `:197-199` 非字符串键（symbol）或非函数值 → 原样返回（数据属性零开销）。
3. `:200-202` include 集合存在且不含 prop → 原样返回（白名单模式）。
4. `:203-205` exclude 集合含 prop → 原样返回（黑名单模式，组合根用它豁免高频读）。
5. `:206` 查 WeakMap 缓存；命中直接返回（:241）。
6. `:208-238` 未命中则构造 wrapped 函数：
   - `:209-211` 门控关 → `value.apply(this === receiver ? obj : this, args)` 直接返回。**this 修正**：以 `proxy.method()` 调用时 this === receiver（Proxy 本身），改绑到裸 obj——避免原函数体内再经 Proxy 触发二次包装/日志；显式 `.call(other)` 时保留 other。
   - `:212` `t0 = performance.now()`；`:213` firstArg 为字符串时取作 contextId（store 方法第一参通常是 id）。
   - `:215` apply 原函数得 res。
   - `:216-229` **thenable 检测**：`res && typeof res.then === "function"` → 返回 `res.then(onFulfilled, onRejected)`：成功回调记 ms + `summarizeStoreCall(prop, args, resolved, ms)`（:219-221）并返回 resolved；失败回调记 `FAILED` + error（:224-226）并 **throw err** 保持拒绝语义。
   - `:230-232` 同步结果：记 ms + summarize，返回 res。
   - `:233-237` 同步抛错：记 `FAILED` + ms + error，**throw err** 原样重抛。
7. `:239` `cache.set(value, wrapped)`；`:241` 返回 wrapped。

*set 陷阱（:243-245）*：`Reflect.set(obj, prop, newValue, receiver)` 纯透传——写属性不被拦截，测试 mock 直达 target。

**④ 边界条件与设计背景**：
- 缓存注释（:190-192）明示两个目标的平衡：稳定引用（React/调用方比较函数引用不抖动）与测试可变性（mock 立即被尊重）。
- thenable 是鸭子类型检测而非 `instanceof Promise`——跨 realm/自定义 thenable 也覆盖。**透明性微瑕（如实指出）**：异步方法返回的是 `res.then(…)` 派生的**新** promise，而非原 res 引用——引用同一性不保持，值与拒绝语义保持。
- 门控在**调用时**判定（:209）而非 get 时——运行中切换 LH_LOG 立即生效。
- getter 属性在 Reflect.get（:196）时求值；返回函数的 getter 每次访问都会走包装流程（缓存按函数引用去重）。
- 组合根的真实配置（`src/server/stores.ts:19-33`）：五个适配器全部 `traceObject("STORE", …)`，exclude 全是读方法（chatStore: getChat/listChats；graphStore: readNodes/readChains/readCheckpoints/readCoverage/readSources/readPositions；sourceOrgStore: read；jobStore: getJob/listJobs/findJobByToolCallId；settingsStore: readSettings）——**写留痕、读静音**。

**⑤ 真实上游调用方**：生产代码仅组合根五处——`src/server/stores.ts:19`（chatStore）、`:22`（graphStore）、`:25`（sourceOrgStore）、`:28`（jobStore）、`:31`（settingsStore），import 于 `stores.ts:15`；测试侧 `tests/logger.test.ts:60` 以 fixture 驱动（import :6）。

#### 5.3.5 `readLogConfig`（私有，核心解析函数）

**① 签名、行号、纯度**：`function readLogConfig(): string | undefined`，`logger.ts:58-71`。**[非纯边界]**（读 localStorage/process.env；吞 localStorage 异常）。

**② 输入输出与不变量**：无参；返回 LH_LOG 原始字符串或 undefined。不变量：**浏览器 localStorage 优先于 process.env**（浏览器里两者可能同时存在——Next 会注入部分 env）；localStorage 被禁（沙箱 iframe）时静默回落 env；Node 侧无 window 直接走 env。

**③ 逻辑逐步**：`:59` isBrowser() → `:60-65` try 读 `window.localStorage?.getItem("LH_LOG")`，非 null 即返回（:62，空串也算显式设置，交给 isLogEnabled 的 `!raw` 分支）；catch 吞掉（:63-65 注释：sandboxed iframes）。`:67-68` `typeof process !== "undefined" && process.env` → 返回 `process.env.LH_LOG`。`:70` 都没有 → undefined。

**④ 边界与设计**：`?.` 防 localStorage 属性本身缺席；`val !== null` 区分"未设置"（null）与"设置为空串"。同构优先级使 DevTools 里 `localStorage.setItem("LH_LOG","0")` 能压过任何注入 env（头注释 :13-14 的静音手法）。

**⑤ 上游**：仅 `isLogEnabled`（:82）。

#### 5.3.6 `isBrowser`（私有）

**① 签名、行号、纯度**：`function isBrowser(): boolean`，`logger.ts:54-56`。**[非纯边界]**（环境探测，只读）。
**② 输入输出与不变量**：无参；true 当且仅当 `typeof window !== "undefined" && typeof window.document !== "undefined"`（:55）——双条件排除 Node 里偶然存在的全局 window  shim 与无 document 的 worker 环境。
**③ 逻辑**：单行合取，无分支。
**④ 边界与设计**：不用 `typeof document` 单独判定（worker 里可能有 document shim 的传闻不可靠，双探针更稳）；SSR 期间 Node 侧为 false，同一模块服务端渲染走 ANSI 分支。
**⑤ 上游**：`readLogConfig`（:59）、`lhLog`（:162）。

#### 5.3.7 `isTestEnv` / `isProdEnv`（私有，一对）

**① 签名、行号、纯度**：`function isTestEnv(): boolean`，`logger.ts:73-75`；`function isProdEnv(): boolean`，`logger.ts:77-79`。**[非纯边界]**（读 process.env.NODE_ENV）。
**② 输入输出与不变量**：无参；分别判定 `NODE_ENV === "test"` / `"production"`。`typeof process !== "undefined" && process.env?.NODE_ENV` 双重守卫——浏览器无 process 时安全返回 false（可选链防 env 缺席）。
**③ 逻辑**：单行布尔表达式，无分支。
**④ 边界与设计**：只在 isLogEnabled 的"未显式设置"默认分支被咨询（:87）——显式 LH_LOG 永远压过 NODE_ENV 默认。测试默认静音保持 runner 干净（头注释 :11-12）。
**⑤ 上游**：均仅 `isLogEnabled`（:87）。

#### 5.3.8 `timestamp`（私有，格式化函数）

**① 签名、行号、纯度**：`function timestamp(): string`，`logger.ts:107-114`。**[非纯边界]**（`new Date()` 时钟读取；格式化部分纯）。
**② 输入输出与不变量**：无参；`HH:MM:SS.mmm` 本地时间，时/分/秒 padStart(2,"0")、毫秒 padStart(3,"0")（:109-112），恒定 12 字符宽。
**③ 逻辑**：取 Date → 四段 padStart → 模板拼接（:113），无分支。
**④ 边界与设计**：本地时区（getHours 系）而非 UTC——日志与开发者墙钟对齐；不含日期（桌面应用日志按进程生命周期阅读，跨日场景由终端滚动上下文承担）。
**⑤ 上游**：仅 `lhLog`（:158）。

#### 5.3.9 `formatDetails`（私有，纯格式化函数）

**① 签名、行号、纯度**：`function formatDetails(details?: Record<string, unknown>): string`，`logger.ts:131-145`。**[纯]**。
**② 输入输出与不变量**：details 记录 → 以**一个前导空格**开头的 `k=v k=v` 串（:144），或空串（无 details / 全 undefined / 空对象）。不变量：undefined 值跳过（:135）；数字/布尔原样（:136-137）；字符串限长 100（:139）；其他值 JSON 化限长 140（:141）；键序 = Object.entries 插入序。
**③ 逻辑逐步**：`:132` 无 details → ""；`:134` 遍历 entries；`:135` undefined 跳过；`:136-142` 三路类型分支拼 `k=v`；`:144` 有 parts 则 `" " + join(" ")`，否则 ""。
**④ 边界与设计**：前导空格使 lhLog 拼接时 action 与 details 自然分隔（:163/:167 的 `${action}${detailStr}`）；分级限长（100/140）控制行宽；null 值走 else 分支得 `k=null`。
**⑤ 上游**：仅 `lhLog`（:160）。

#### 5.3.10 `summarizeStoreCall`（私有，纯解析/摘要函数）

**① 签名、行号、纯度**：`function summarizeStoreCall(method: string, args: unknown[], result: unknown, ms: number): Record<string, unknown>`，`logger.ts:249-278`。**[纯]**。
**② 输入输出与不变量**：方法名 + 参数数组 + 结果 + 耗时 → 日志 details 记录。不变量：`info.ms` 恒为 `"<n>ms"` 字符串（:276）；按方法名走特化摘要，兜底数组结果记 count（:273-274）；绝不抛（全部是类型守卫下的属性读取）。
**③ 逻辑逐步（分支全表）**：
1. `:256-257` `saveMessages` 且 args[1] 是数组 → `info.messages = args[1].length`（只记条数，不落消息内容——日志不泄露持久化正文）。
2. `:258-262` `createChat` 且 args[0] 是对象 → 摘 id/kind/title。**真实代码事实：此分支对当前端口签名不可达**——`ChatStore.createChat(title: string, kind?)`（`ports.ts:37`，适配器 `chats.ts:35`）的 args[0] 是字符串标题，`typeof args[0] === "object"` 恒 false，落入兜底；结果 ChatRecord 非数组，最终只记 ms。疑似早期 createChat(record) 签名的遗留。
3. `:263-267` `updateJob` 且 args[1] 是对象 → 摘 patch 的 status/activity/error（进度行可见性的日志侧）。
4. `:268-272` `createJob` 且 args[0] 是对象 → 摘 jobId/chatId/kind。**其中 `if (job.id)`（:270）不可达**：`CreateJobInit` 没有 id 字段（`ports.ts:141-149`），id 由适配器内部生成（`jobs.ts:33`）；chatId/kind 正常摘出。
5. `:273-274` 兜底：结果是数组 → `info.count = result.length`（listChats/listJobs/readNodes 等读方法的规模摘要——虽然组合根把多数读 exclude 了）。
6. `:276` 恒记 ms。
**④ 边界与设计**：特化分支只覆盖写方法与高频摘要需求；两处死分支如实登记（附录差异表），不替代码圆谎。摘要刻意不含消息正文/密钥值——观测与隐私的分界。
**⑤ 上游**：仅 `traceObject` 包装函数（:220 异步成功、:231 同步成功）。

### 5.4 轻量私有辅助函数归并表（100% 覆盖）

| 名称 | 行号 | 类别 | 纯度 | 用途 |
|---|---|---|---|---|
| `ANSI_COLORS` | 29-38 | 私有常量 | [纯] | Node 终端 scope 色表 |
| `CSS_COLORS` | 40-49 | 私有常量 | [纯] | 浏览器 DevTools %c 样式表 |
| `ANSI_RESET` | 51 | 私有常量 | [纯] | ANSI 复位 |
| `ANSI_DIM` | 52 | 私有常量 | [纯] | ANSI 弱化（时间戳） |
| `isBrowser()` | 54-56 | 私有函数 | [非纯边界]（环境探测） | window+document 双探针 |
| `readLogConfig()` | 58-71 | 私有函数 | [非纯边界]（环境读取） | LH_LOG：localStorage 优先，env 回落 |
| `isTestEnv()` | 73-75 | 私有函数 | [非纯边界]（环境读取） | NODE_ENV === "test" |
| `isProdEnv()` | 77-79 | 私有函数 | [非纯边界]（环境读取） | NODE_ENV === "production" |
| `timestamp()` | 107-114 | 私有函数 | [非纯边界]（时钟） | HH:MM:SS.mmm 本地时间 |
| `formatDetails()` | 131-145 | 私有函数 | [纯] | details → 限长 k=v 串 |
| `summarizeStoreCall()` | 249-278 | 私有函数 | [纯] | store 方法调用摘要（含两处死分支，见 5.3.10） |

导出面全清单（零遗漏）：`LogScope`（19）、`isLogEnabled`（81）、`truncateLogValue`（116）、`lhLog`（150）、`traceObject`（179）。文件内再无其他声明；278 行全部归属已覆盖。

---

## 附录 A：核验记录

本卷全部结论的取证方式（可复现）：

1. **全文精读**（read 工具，零遗漏）：`学习文档/glossary.md`（756 行，分两段）、`src/core/index.ts`（91）、`src/core/contracts.ts`（18）、`src/core/ports.ts`（232）、`src/core/events.ts`（120）、`src/core/logger.ts`（278）；辅助精读 `src/core/clusters.ts`（14）、`src/core/layout-settle.ts`（54）、`src/core/coverage.ts`（关键段）、`src/server/events-stream.ts`（81）、`src/server/turn-liveness.ts`（77）、`components/server-events.tsx`（158）、`app/api/events/route.ts`（15）、`eslint.config.mjs`、`src/server/stores.ts`（52）、`src/core/contracts/chat.ts`（ChatRecord 段）、`src/core/contracts/jobs.ts`（JobRecord 段）、`tests/logger.test.ts`（门控/包装器测试驱动点）。
2. **行号取证**（rg -n）：五文件全部声明/函数/常量行号；`ports.ts` 全部方法行号；`events.ts` 九事件行号；`logger.ts` 全部函数起止（`^}` 闭合行）。
3. **全仓调用点检索**（rg）：`subscribe|emit` 生产调用点（22 个 emit + 1 个总线 subscribe）；`lhLog|isLogEnabled|truncateLogValue|traceObject` 生产代码（src/app/components）共 43 处命中（37 lhLog + 5 traceObject + 1 isLogEnabled），测试侧另由 `tests/logger.test.ts` 驱动（lhLog :43/:49/:53、isLogEnabled :28-29/:36-37、traceObject :60）；`SERVER_EVENT_TYPES|useServerEvent|useServerResync` 消费者；`from "node:` 全 core 扫描（仅 graph.ts:52 与 coverage.ts:22）；coverage 函数名在 components/app 的零命中核验；`MIN_CLUSTER_SIZE` 消费者；`promptOverrides|authStore` 装配与消费点；`next.config.ts` 无 crypto/fallback/webpack 配置核验。
4. **适配器装配与语义**：scout 逐文件取证 `src/store/{chats,graph,jobs,settings,prompt-overrides,auth,source-organization}.ts` 与根 `config.ts` 的全部常量/方法行号（本卷 3.2/3.3 引用），关键纪律（SILENCE LAW chats.ts:26-34、WRITE CHOKE POINT chats.ts:53-59、rewriteLedgers 原子性 graph.ts:217-249、auth 0600 次序 auth.ts:42-49）另经 rg 直接复核。

## 附录 B：注释-代码差异登记（如实陈述，不圆谎）

| # | 位置 | 注释/宣称 | 真实代码 |
|---|---|---|---|
| 1 | `index.ts:3-4` | "no node builtins" | `index.ts:86` 星导出 `coverage.ts`，后者 `:22` 运行时 import `node:crypto`（createHash，唯一使用点 messageFingerprint :77-82）；浏览器侧零运行时消费者，无打包兜底配置（1.3d） |
| 2 | `index.ts:32-36` | clusters.ts 是 Louvain、"heavy clustering deps" | 今日 `clusters.ts` 仅 14 行、唯一导出 `MIN_CLUSTER_SIZE = 3`（:14）；Louvain/嵌入器/LLM 标签匹配器已死（wave 7，clusters.ts:2-6），检测在 session-clusters.ts；排除决定保留，注释是 2026-09-13 历史理由（1.3c） |
| 3 | `events.ts:21-22` | "no React, no IO, no imports" | `:25` import lhLog；emit 经 lhLog（:112）与 console.error（:117）做 IO；总线传播逻辑本身仍是纯内存操作（4.1） |
| 4 | `ports.ts:96-97` | cluster-naming usage 追加方法的 doc 注释 | 注释下无方法；适配器无对应实现；通道已死于 2026-09-24（cost-summary.ts:6-8）——孤儿注释（3.3.2） |
| 5 | `contracts.ts:4-7` | 头注释列举 plan/graph/chat/jobs 四域 | 实际星导出六域（:13-18，含 probe/models）（2.2） |
| 6 | `logger.ts:1-2` | "pure, browser-safe" | browser-safe 成立；"pure" 不成立——console IO、env/localStorage 读取、时钟、Proxy（5.1 已逐项拆解，内部纯函数已区分） |
| 7 | `logger.ts:258-262` | summarizeStoreCall 的 createChat 对象摘要分支 | 对当前签名 createChat(title: string)（ports.ts:37）不可达；`:270` 的 job.id 对 CreateJobInit（无 id 字段，ports.ts:141-149）不可达（5.3.10） |
| 8 | `ports.ts:110-112` | readPositions 注释写 "core/layout.ts settleGraphLayout" | `settleGraphLayout` 实际住在 `core/layout-settle.ts:26`（layout.ts 在桶内、settle 被排除的分家见 1.3b）——注释指错模块文件 |
