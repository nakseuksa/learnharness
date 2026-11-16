# 第 07 卷：知识图谱合并、推理链化简、溯源删除与覆盖度

> **覆盖源码文件（共 6 个）**：`src/core/graph.ts`（695 行） · `src/core/graph-deletion.ts`（343 行） · `src/core/coverage.ts`（192 行） · `src/core/chains.ts`（93 行） · `src/core/proposition-candidates.ts`（169 行） · `src/core/clusters.ts`（14 行）  
> **合计行数**：1,506 行 | **桶导出边界**：`graph.ts`、`clusters.ts` **刻意排除在 `src/core/index.ts` 之外**（`graph-deletion.ts` 仅在桶中再导出 TS 类型）；`chains.ts`、`proposition-candidates.ts`、`coverage.ts` 在桶中导出（注意 `coverage.ts:22` 引用了 `node:crypto`，浏览器端无运行时调用者）。  
> **纯度概览**：`simplifyChains`、`deriveView`、`coverage.ts`、`chains.ts`、`proposition-candidates.ts` 为 **100% 无副作用确定性纯函数**；`mergeFindings`、`getGraph`、`graphSnapshot`、`graphSessionIndex`、`graphSessionPropositions`、`deleteSourcesTraces`、`deleteNodeTraces` 为**面向显式注入端口（`GraphStore` / `ChatStore`）的确定性领域逻辑**（无全局可变状态，端口读写与随机 ID/时钟边界已在各节显式标出）。

---

## 本卷导读：“存事件账本，读时派生世界（Store Events, Derive State）”

LearnHarness 知识图谱定型于 2026 年 9 月下旬的“推理链优先（Chains-Primary）”重构。六个文件严密分工，构成一条完整的**覆盖检测 → 候选召回 → 确定性合并与化简 → 读时归并投影 → 精确爆炸半径删除**管线：

```text
[会话教师正文 (coverage.ts)] ──SHA-256 指纹差分──▶ coverageOf ──贪心分批──▶ batchRuns
                                                                              │
                                                                 (抽取器 LLM 产出 SessionFindings)
                                                                              │
[现存图谱节点] ──BM25 候选检索 (proposition-candidates.ts)──▶ (审计器 LLM 产出 AuditVerdicts.links)
                                                                              │
                                                                              ▼
                                              确定性合并器 mergeFindings (graph.ts)
                                              ├─ 命题：等价追加行 / 新建 n_ 节点
                                              ├─ 推理链：混合命名空间解析 + 同源去重追加 arg_
                                              ├─ 全账本化简：simplifyChains（最少前提 + 祖先覆盖）
                                              └─ 最后一步写覆盖度检查点（崩溃安全纪律）
                                                                              │
                                    ┌─────────────────────────────────────────┴──────────────────────┐
                                    ▼ 读路径（graph.ts + chains.ts + clusters.ts）                    ▼ 删除路径（graph-deletion.ts）
                       getGraph（多行归并） → deriveView（单前提直连 / 多前提汇合点 ⟹）      deleteSourcesTraces / deleteNodeTraces
                       → graphSnapshot（含出生会话簇与静止坐标）                            （共享身份保留、孤儿清理、原子重写账本）
```

---

## 1. `src/core/graph.ts`（695 行）

### 1.1 模块定位与纯度边界

* **设计目的**（`src/core/graph.ts:1-50`）：抽取流水线的**唯一确定性落盘阶段（合并器 Merger）**与**唯一账本归并读取器**。大模型只负责提供语义裁决（命题文本、联合前提链、等价身份链接 `linkTo`），而 ID 生成、时间戳、出处（`provenance`）并集、冗余推导链剔除全部由确定性代码执行。
* **桶导出状态**：**不进入** `src/core/index.ts`（因依赖 `node:crypto` 的 `randomBytes` 且直接操作存储端口，仅由 `src/server/`、`src/agent/` 与 `scripts/` 导入）。
* **非纯与端口边界**：
  > **[端口与非确定性边界说明]**：
  > * `simplifyChains`（`301-383`）与 `deriveView`（`457-506`）为 **100% 严格纯函数**。
  > * `getGraph`、`graphSnapshot`、`graphSessionIndex`、`graphSessionPropositions` 仅通过参数传入的 `GraphStore` / `ChatStore` 执行**同步只读查询**，无写副作用。
  > * `mergeFindings`（`149-292`）通过传入的 `deps.graphStore` 追加/重写账本，并调用 `randomBytes(6)` 生成 `n_<12hex>` / `arg_<12hex>` ID 及 `new Date().toISOString()` 记录创建时间。

### 1.2 核心接口契约

| 接口名 | 行号 | 字段与契约说明 |
|---|---|---|
| `GraphDeps` | `74-77` | `{ chatStore: ChatStore; graphStore: GraphStore }`：显式注入的双存储端口。 |
| `MergeSource` | `107-113` | `{ foldedAt: string; coverage?: CoverageEntry[] }`：会话批次合并传入逐消息 `coverage` 指纹数组；笔记导入传 `undefined` 以写入整文件检查点 `sessions.jsonl`。 |
| `DerivedGraph` | `392-395` | `{ nodes: GraphNode[]; chains: GraphChain[] }`：归并后的语义真相（仅含客观命题与推理链，不含画布几何汇合点）。 |
| `GraphSessionEntry` | `614-631` | 探测者 `list_sessions` 工具消费的出生会话条目：`{ id, name, kind: "chat" \| "file", createdAt, updatedAt, propositions }`。 |
| `GraphSessionProposition` | `677-681` | 探测者 `list_propositions` 工具消费的单条出生命题摘要：`{ nodeId: string; name: string }`。 |

---

### 1.3 导出函数与核心内部算法精讲

#### `mergeFindings(chatId, findings, verdicts, deps, source)`（`src/core/graph.ts:149-292`）

* **① 签名与职责定位**：
  ```ts
  export function mergeFindings(
    chatId: string,
    findings: SessionFindings,
    verdicts: AuditVerdicts,
    deps: GraphDeps,
    source: MergeSource,
  ): EmissionStats
  ```
  `[端口驱动写操作 + 随机 ID/时钟]` · 将单批次抽取器产物与审计器等价裁决确定性地写入图谱账本。
* **② 输入、输出与核心不变量**：
  1. **任务局部命名空间隔离（2026-09-29 修复）**：抽取器局部 ID（`"p1"`, `"p2"`）到真实图节点 ID（`"n_..."`）的映射 `mapping` 仅驻留本次调用栈内存，彻底废除持久化映射表，根除跨任务局部 ID 碰撞导致的丢点焊错边。
  2. **安全回退的等价追加律**：当 `verdicts.links` 将 `p.id` 指向已有节点 `linkTo` 时，必须核验 `existingIds.has(linkTo)`——若审计器编造了不存在的节点 ID，自动降级为创建新节点！合法链接则追加一条同 `id` 节点行（首行 `name`/`statement`/`createdAt` 保持权威，新表述在读时归入 `aliases`）。
  3. **混合命名空间端点解析（Digest-Aware，2026-09-30）**：链的前提/结论既可解析本批局部 ID（`mapping.get(endpoint)`），也可直接穿透引用同源 `digest` 中的现存节点 ID（`existingIds.has(endpoint)`）。
  4. **覆盖度检查点殿后纪律（Coverage Discipline）**：节点追加、链追加、全账本 `simplifyChains` 重写全部落盘成功后，最后一步才写 `coverage.jsonl` 或 `sessions.jsonl`。
* **③ 核心逻辑逐步推导**：
  1. 读取 `existingIds`，建立审计链接查找表 `linkOf`（`166-169`）。
  2. 遍历 `findings.propositions`（批内重复 `p.id` 跳过后者）：构造 `points = pointOf(chatId, p.messageId)`；命中现存 `linkTo` 则 `appendNode` 追加链接行；否则用 `newGraphNodeId()` 新建节点追加，`stats.nodes++` 并加入 `existingIds`；登记 `mapping.set(p.id, graphNodeId)`（`173-214`）。
  3. 预扫现存链账本，记录 `chainKey(premises, conclusion) -> arg_id` 表 `idOfKey` 以及当前 `chatId` 已断言过的 `assertedByChat` 集合（`227-234`）。
  4. 对每条 `findings.chains` 执行 `emitChain`：解析 `conclusion`，将 `premises` 解析后去重并过滤掉 `undefined` 与等于 `conclusion` 的自环前提；若前提非空且 `!assertedByChat.has(key)`，复用 `idOfKey.get(key)`（跨会话复述同一论证共享同一个 `arg_` ID！）或生成新 `newGraphChainId()` 执行 `appendChain`，`stats.chains++`（`235-259`）。
  5. 读取全部链运行 `simplifyChains(allChains)`，若条数减少则调用 `ledgers.rewriteLedgers({ chains: keptChains })` 并记录 `stats.droppedChains`（`274-279`）。
  6. 写入 `source.coverage` 逐条记录或整文件检查点，返回 `stats`（`287-291`）。
* **④ 边界条件与历史事故背景**：会话来源的命题携带 `p.messageId` 精确消息锚点，而链行与笔记导入命题使用会话/文件级空锚点 `""`；无法解析端点的坏链静默跳过，绝不阻塞整批落盘。
* **⑤ 上游调用方与系统接线**：`src/agent/subagents/extraction.ts:1206`（会话抽取合并）与 `:1370`（笔记导入抽取合并）。

---

#### `simplifyChains(lines)`（`src/core/graph.ts:301-383`）

* **① 签名与职责定位**：`export function simplifyChains(lines: GraphChain[]): GraphChain[]` · `[纯函数]` · 在全量推理链集合上剔除同结论下的前提超集冗余链与跨级传递冗余链。
* **② 输入、输出与核心不变量**：
  * `lines.length < 2` 直接原样返回；若无任何链被剔除（`droppedKeys.size === 0`），直接返回原引用避免无谓重写账本；
  * 相同 `chainKey` 的多条出处行同生共死；同结论内严格按 `(前提数升序, createdAt 升序, key 字典序)` 贪心保留最精炼且最早建立的论证。
* **③ 核心逻辑逐步推导**：
  1. 按 `chainKey` 聚合成逻辑链桶 `groups`（`305-311`）。
  2. 建立 `conclusion -> premises[][]` 反向索引 `premisesOf`，定义带环检测集合 `visiting` 与结果缓存 `ancestryMemo` 的递归闭包 `ancestry(id, visiting)`（`319-342`），求出任意节点背后的全部直接与间接前提集合。
  3. 按 `head.conclusion` 将逻辑链分组并按三维优先级排序（`345-360`）。
  4. 组内顺序扫描每个 `candidate`，若已保留列表 `kept` 中存在某条链 `k` 满足以下任一条件，则将 `candidate.key` 标入 `droppedKeys`（`361-379`）：
     * **最少前提法则（Rule 1）**：`k.premises.every(p => candidateSet.has(p))`（`k` 的前提集是 `candidate` 的真子集）；
     * **传递祖先覆盖法则（Rule 2）**：构造 `covered = k.premises ∪ ⋃_{p ∈ k.premises} ancestry(p)`，满足 `candidate.premises.every(p => covered.has(p))`（例如已有 `[A, B] ⟹ X` 与 `[X, C] ⟹ Y` 时，自动消除跨级冗余链 `[A, B, C] ⟹ Y`）。
  5. 过滤掉 `droppedKeys` 对应的账本行后返回（`381-382`）。
* **④ 边界条件与历史事故背景**：即使极端情况下外部手工写入了循环链，`visiting.has(id)` 也会立即截断递归返回空集，保证 $O(V \cdot E)$ 有界终止。
* **⑤ 上游调用方与系统接线**：`mergeFindings`（`src/core/graph.ts:275`）及测试套件。

---

#### `getGraph(graphStore)`（`src/core/graph.ts:406-442`）

* **① 签名与职责定位**：`export function getGraph(graphStore: Pick<GraphStore, "readNodes" | "readChains">): DerivedGraph` · `[端口只读纯派生]` · 将追加式 `nodes.jsonl` 与 `chains.jsonl` 多行断言折叠归并为唯一的语义图真相。
* **② 输入、输出与核心不变量**：
  * **首行定身份、后续行扩充别名与出处**：同一节点 `id` 的首行固定 `name`、`statement`、`createdAt`；后续行的 `statement` 与 `aliases` 经非空去重并入 `existing.aliases`（永不篡改首行 `name` 与 `statement`），`provenance` 按 `samePoint` 保序去重并入。
  * **链按 `chainKey` 归并**：首行固定 `id`（`arg_...`）、`premises` 数组顺序与 `createdAt`，后续同键行的 `provenance` 保序并入。
* **③ 核心逻辑逐步推导**：两次线性扫描——第一遍用 `byId: Map<string, GraphNode>` 归并节点行（首遇浅拷贝数组，重遇合并短语与出处点）；第二遍用 `byKey: Map<string, GraphChain>` 归并链行，输出 `{ nodes: [...byId.values()], chains }`。
* **④ 边界条件与历史事故背景**：完全免疫重复行（重复导入或重试产生的相同 `(chatId, messageId)` 点被 `samePoint` 幂等吸收）。
* **⑤ 上游调用方与系统接线**：本文件 `graphSnapshot`（`511`）、`graphSessionIndex`（`637`）、`graphSessionPropositions`（`686`），以及 `src/core/layout-settle.ts:32`、`src/server/commit-positions.ts:42`、`src/server/source-organization.ts:32`、`src/agent/tools/graph.ts:143, 199`、`src/agent/subagents/extraction.ts:939, 967, 1293`。

---

#### `deriveView(graph)`（`src/core/graph.ts:457-506`）

* **① 签名与职责定位**：
  ```ts
  export function deriveView(graph: DerivedGraph): {
    nodes: GraphNode[];
    edges: GraphEdge[];
    logicalEdges: GraphEdge[];
    impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
  }
  ```
  `[纯函数]` · 将客观语义图派生为画布几何渲染视图与物理深度结构视图。
* **② 输入、输出与核心不变量**：
  * **悬空链自愈过滤**：任何结论或前提不在存活节点集 `live` 中的链直接跳过。
  * **单前提直连折叠 vs 多前提几何汇合点**：`premises.length === 1` 直接产出一条 `premise → conclusion` 画布边，不造多余中间节点；`premises.length >= 2` 铸造一个 `id = chain.id`（`arg_...`）、`name = "⟹"`、`statement = formatChainLine(...)` 的蕴涵汇合节点，产出 `各前提 → chain.id` 与 `chain.id → conclusion` 的星型画布边，同时向 `impLinks` 登记汇合连接关系。
  * **`logicalEdges` 语义保持**：无论单前提还是多前提，都在 `logicalEdges` 中按 `\u0000` 复合键去重记录直接的 `premise → conclusion` 命题级有向边。
* **③–⑤ 调用接线**：`graphSnapshot`（`516`）、`src/core/layout-settle.ts:34`、`src/server/commit-positions.ts:42`、`scripts/replay-layout.ts:33`。

---

#### `graphSnapshot(deps, sourceNames)` · `graphSessionIndex(deps)` · `graphSessionPropositions(deps, sessionId)`（`src/core/graph.ts:510-691`）

* **`graphSnapshot`**（`510-601`）· `[端口只读纯派生]`：
  * **①–② 职责与不变量**：组装 `GET /api/graph` 完整响应。确保自定义展示名 `sourceNames` 只影响簇标签显示而绝不覆盖 `fileSources` 中的原始出处路径；确保 `MIN_CLUSTER_SIZE (3)` 凸包门槛只统计真实客观命题（`graph.nodes`），过滤完之后再调用 `attachImpToCommunities` 挂入多前提 `arg_` 汇合点。
  * **③ 逐步推导**：`getGraph` → `deriveView` → 收集所有节点涉及的 `sourceIds` 分别查 `chatStore.getChat`（填 `sessions`）和 `graphStore.readSources`（填 `fileSources`）→ 过滤存活来源构建 `nodeSessions` → `birthSessionPartition(graph.nodes)` 过滤 `>= 3` 构造 `clusters` → `attachImpToCommunities` → 附加非空 `positions` 返回。
  * **④–⑤ 调用方**：`src/server/graph.ts:25`。
* **`graphSessionIndex(deps)`**（`635-672`）与 **`graphSessionPropositions(deps, sessionId)`**（`685-691`）· `[端口只读纯派生]`：
  * **①–③ 逻辑推导**：`graphSessionIndex` 对 `getGraph` 的节点跑 `birthSessionPartition` 统计每个出生来源的命题数，关联会话标题/时间戳或导入文件路径/导入时间（记录已删的孤儿来源回退以 `id` 为名、`kind: "file"`、日期 `null`），按 `updatedAt` 降序 → `createdAt` 降序 → `id` 升序排列；`graphSessionPropositions` 过滤 `birthSessionOf(node) === sessionId` 的节点并按 `nodeId` 升序返回 `{ nodeId, name }[]`。
  * **④–⑤ 调用方**：`src/agent/tools/graph.ts:55, 72, 183, 197`。

### 1.4 轻量私有辅助函数归并表

| 函数名 | 行号 | 纯度 | 作用与调用归属 |
|---|---|---|---|
| `newGraphNodeId` | `80-82` | `[随机 ID]` | 生成 `"n_" + randomBytes(6).toString("hex")`。 |
| `newGraphChainId` | `86-88` | `[随机 ID]` | 生成 `"arg_" + randomBytes(6).toString("hex")`（与 `n_` 命名空间天然零碰撞）。 |
| `chainKey` | `92-94` | `[纯函数]` | 计算 `${[...premises].sort().join("+")}>${conclusion}` 逻辑链唯一键。 |
| `pointOf` | `121-123` | `[纯函数]` | 构造单元素出处数组 `[{ chatId, messageId: messageId ?? "" }]`。 |
| `samePoint` | `125-126` | `[纯函数]` | 判断两个 `ProvenancePoint` 的 `chatId` 与 `messageId` 是否完全相同。 |

---

## 2. `src/core/graph-deletion.ts`（343 行）

### 2.1 模块定位与纯度边界

* **设计目的**（`src/core/graph-deletion.ts:1-58`）：图谱账本的第二个受控写入模块，提供全同步（无 `await`，在单线程事件循环中天然防并发交错）、幂等、严格限制爆炸半径的来源清理与单点删除操作。
* **桶导出与端口边界**：`src/core/index.ts:88` 仅导出其 TS 类型；运行时函数全部基于显式传入的 `graphStore: GraphStore` 同步读写账本与坐标。

### 2.2 导出函数精讲

#### `deleteSourcesTraces(graphStore, sourceIds, mode)` 与薄封装 `deleteChatTraces`（`src/core/graph-deletion.ts:95-242`）

* **① 签名与职责定位**：
  * `export function deleteChatTraces(graphStore: GraphStore, chatId: string, mode: ChatDeleteMode): ChatDeletionStats`（`95-97`）：将单个 `chatId` 包装为 `new Set([chatId])` 委托给 `deleteSourcesTraces`。
  * `export function deleteSourcesTraces(graphStore: GraphStore, sourceIds: ReadonlySet<string>, mode: ChatDeleteMode): ChatDeletionStats`（`101-242`）· `[端口同步读写]` · 一次账本重写批量清除多个会话或导入源的图谱痕迹。
* **② 输入、输出与核心不变量**：
  1. 非法 `mode` 直接抛异常拒绝；空集合 `sourceIds.size === 0` 零读写返回全 `0` 统计。
  2. **`"preserve-graph"` 铁律**：仅移除 `coverage.jsonl` 与 `sessions.jsonl` 中的抽取进度行，节点与推理链原封不动。
  3. **共享节点“首行留壳去痕”铁律（2026-09-23 裁定）**：若被删来源首次创建了某节点，但其他存活来源后来链接到了该节点，则保留首行的 `id / name / statement / createdAt` 身份锚，同时清空首行的 `provenance: []` 与 `aliases: []`；被删来源追加的非首行链接行则整行删除。
  4. **爆炸半径隔离铁律**：原本就无出处的遗留节点或成员本就不存在的异构链行绝不顺手误删；未发生实质行数变化的文件绝不空写以保持 `mtime` 稳定。
* **③ 核心逻辑逐步推导**：
  1. 过滤 `coverage` 与 `checkpoints` 计算移除数；若 `mode === "preserve-graph"`，按需重写这两份账本即返回（`109-123`）。
  2. 检查 `nodeLines` 与 `chainLines` 是否有任何出处命中 `sourceIds`（`!touched` 时同样仅更新进度账本即返回，不碰节点/链文件，`133-141`）。
  3. 判定存活节点集 `live`：未被触及的节点直接存活；被触及的节点仅当任意一行含 `!sourceIds.has(pt.chatId)` 出处点时才入 `live`（`150-157`）。
  4. 重建 `outNodes`：死节点全行跳过；存活节点中未受污染行原样保留，混合行剥去被删出处，整行出处被删光时**首行清空 `provenance` 与 `aliases` 留壳，非首行丢弃**（`167-186`）。
  5. 重建 `outChains`：含本次死节点（`deadNodes`）的链丢弃；原本有出处但剥除后变空的链丢弃；其余剥除被删出处后保留，统一调用 `rewriteLedgers`（`193-213`）。
  6. 同步从 `positions.json` 剔除 `deadNodes` 与本次死掉的 `deadChainIds`（`224-239`）。
* **④–⑤ 调用接线**：`src/server/chats.ts:145`（`deleteChatTraces`）与 `src/server/source-deletion.ts:40`（`deleteSourcesTraces`）。

---

#### `deleteNodeTraces(graphStore, nodeId)`（`src/core/graph-deletion.ts:297-342`）

* **① 签名与职责定位**：`export function deleteNodeTraces(graphStore: GraphStore, nodeId: string): NodeDeletionStats | null` · `[端口同步读写]` · 彻底删除单个客观命题（`"n_..."`）或单条论证链（`"arg_..."`）。
* **② 输入、输出与核心不变量**：目标不存在时返回 `null`（触发路由层 `404`）；删 `arg_` 链绝不伤及前提与结论命题；删 `n_` 命题则无视跨会话共享引用执行“完全处决（Full Death）”，级联清除所有引用它的推理链。
* **③ 核心逻辑逐步推导**：
  1. **论证链分支（`nodeId.startsWith("arg_")`，`303-314`）**：过滤 `chainLines` 中 `id !== nodeId` 的行；若长度未变返回 `null`；重写 `chains` 账本并按需删除 `positions[nodeId]`，返回 `{ chainsRemoved }`。
  2. **客观命题分支（`316-341`）**：通过私有 `nodeLinesOf`（`283-285`）确认存在性（空则返回 `null`）；过滤掉所有 `conclusion === nodeId || premises.includes(nodeId)` 的链行；过滤掉 `id === nodeId` 的节点行；调用 `rewriteLedgers`（仅在链确实减少时才传 `chains` 字段）；从 `positions.json` 一并清理 `nodeId` 与级联死链的 `arg_` 坐标后返回 `{ chainsRemoved }`。
* **④–⑤ 调用接线**：`src/server/graph.ts:117`（注：私有辅助 `chainLinesOf` 在 `287-289` 行为对称保留辅助，当前主逻辑已内联过滤）。

---

## 3. `src/core/coverage.ts`（192 行）

### 3.1 模块定位与纯度边界

* **设计目的**（`src/core/coverage.ts:1-20`）：实现“教师正文是唯一抽取单位、未覆盖状态纯靠读时 SHA-256 指纹差分派生”的覆盖度计算核心。
* **纯度边界**：全部 9 个导出函数均为 **100% 确定性纯函数**。

### 3.2 导出函数逐一五要素精讲

#### `messageViewLines(message, mid, failedOutputCalls)` 与 `teacherProseBlocks(messages)`（`src/core/coverage.ts:38-65`）

* **① 签名与职责定位**：
  * `export function messageViewLines(message: LhMessage, mid: string, failedOutputCalls?: ReadonlySet<string>): string[]`（`38-49`）· `[纯函数]`
  * `export function teacherProseBlocks(messages: ReadonlyArray<LhMessage>): string[]`（`57-65`）· `[纯函数]`
* **② 输入、输出与核心不变量**：**抽取器输入与覆盖度指纹严格同源不变量**——凡非 `assistant` 角色的消息一律返回 `[]`；仅提取 `userFacingTextOf` 认可的普通文本块与成功的 `send_to_user` 消息（自动排除报错的 `send_to_user`、思考块、出题工具与所有标记消息）。`messageViewLines` 冠以 `` `TEACHER [${mid}] ` `` 前缀使消息 ID 参与哈希并供抽取器锚定出处。
* **③–⑤ 推导与调用方**：遍历 `assistant` 内容块 `trim()` 收集；`messageViewLines` 被本文件 `messageFingerprint` / `coverageSlots` 及 `src/agent/subagents/extraction.ts:140, 1176` 调用；`teacherProseBlocks` 由单测 `tests/extraction.test.ts` 用于无前缀正文一致性核验。

---

#### `viewTokens` · `messageFingerprint` · `coverageSlots` · `coveredSet`（`src/core/coverage.ts:68-106`）

* **① 签名与职责定位**：
  * `export function viewTokens(lines: string[]): number`（`68-70`）· `[纯函数]`：`Math.ceil(lines.join("\n").length / 4)`（空数组拼成 `""` 精确得 `0` Token！）。
  * `export function messageFingerprint(message: LhMessage, failedOutputCalls?: ReadonlySet<string>): string`（`77-81`）· `[纯函数]`：计算 `JSON.stringify([role, messageViewLines(message, message.id, failedOutputCalls)])` 的 SHA-256 hex 摘要。
  * `export function coverageSlots(messages: ReadonlyArray<LhMessage>): CoverageSlot[]`（`92-99`）· `[纯函数]`：预先计算一次全局 `failedOutputCallIds(messages)`，将每条消息映射为 `{ message, fp, tokens }`。
  * `export function coveredSet(entries: ReadonlyArray<CoverageEntry>, chatId: string): Set<string>`（`102-106`）· `[纯函数]`：提取账本中指定 `chatId` 的所有已覆盖指纹 `e.fp`。
* **②–⑤ 不变量与调用接线**：由于 `failedOutputCallIds` 需要配对后续的 `toolResult` 消息，`coverageSlots` 在整场会话级别预扫一次并透传给每条消息，确保失败的 `send_to_user` 获得 `tokens = 0` 而被下游自动归为隐形消息；供 `coverageOf` 内部组合调用。

---

#### `coverageOf(messages, entries, chatId)`（`src/core/coverage.ts:115-150`）

* **① 签名与职责定位**：`export function coverageOf(messages: ReadonlyArray<LhMessage>, entries: ReadonlyArray<CoverageEntry>, chatId: string)` · `[纯函数]` · 派生单场会话当前的完整覆盖度统计与未覆盖槽位索引列表。
* **② 输入、输出与核心不变量**：**零 Token 消息彻底隐形不变量**——所有 `slot.tokens === 0` 的消息（学习者发言、答题、标记、仅调了工具无正文的助手消息）直接 `continue` 跳过，既不计入 `coveredCount` 也不计入 `uncoveredCount`！学习者回答一道题或修改笔记绝不会使已覆盖的会话重新变成未覆盖。
* **③ 核心逻辑逐步推导**：先求 `covered = coveredSet(...)` 与 `slots = coverageSlots(messages)`；遍历 `slots`，跳过 `tokens === 0` 项，命中 `covered.has(slot.fp)` 则累加 `coveredTokens`，否则将下标 `i` 推入 `uncovered` 并累加 `uncoveredTokens`；用可见消息总数减去 `uncovered.length` 得 `coveredCount` 后返回。
* **④–⑤ 调用方**：`src/server/turn-service.ts:119`、`src/server/chats.ts:189`、`src/agent/subagents/extraction.ts:1132`。

---

#### `batchRuns(slots, uncovered, budget)` 与 `batchTag(batch)`（`src/core/coverage.ts:159-192`）

* **① 签名与职责定位**：
  * `export function batchRuns(slots: ReadonlyArray<CoverageSlot>, uncovered: ReadonlyArray<number>, budget: number): CoverageSlot[][]`（`159-177`）· `[纯函数]` · 将未覆盖槽位按时间顺序贪心切分为不超过 `budget` 的连续批次。
  * `export function batchTag(batch: ReadonlyArray<CoverageSlot>): string`（`188-192`）· `[纯函数]` · 计算批次成员指纹序列的 12 位 SHA-256 前缀标识。
* **②–③ 核心逻辑与超大单消息边界**：`budget <= 0 || uncovered.length === 0` 返回 `[]`。遍历 `uncovered` 下标，仅当 `current.length > 0 && currentTokens + slot.tokens > budget` 时才先 `flush()` 开新桶——这意味着**如果单条教师长文自身就超过 `budget`（例如 6000 Token > 4096 预算），开新桶时 `current.length === 0` 不触发空刷，它会完整独占一个批次运行，绝不死循环、绝不丢弃、也绝不把单条消息劈成两半**！
* **④–⑤ 调用方**：`batchRuns` 由 `src/agent/subagents/extraction.ts:1142` 调用；`batchTag` 由 `tests/coverage.test.ts` 覆盖。

---

## 4. `src/core/chains.ts`（93 行）

### 4.1 模块定位与纯度边界

* **设计目的**：提供浏览器安全的选区推理链过滤、可读单行格式化与练习题目标命题宽松对齐函数（导出于 `src/core/index.ts:87`，全文件 **100% 纯函数**）。

### 4.2 导出函数逐一五要素精讲

#### `chainsForSelection(nodes, chains)`（`src/core/chains.ts:34-55`）

* **① 签名与职责定位**：`export function chainsForSelection(nodes, chains): ReasoningChain[]` · `[纯函数]` · 将存储的推理链集合裁剪至选定的节点子集，并将选区内未成链的节点补齐为单节点孤立链。
* **② 输入、输出与核心不变量**：一条链入选当且仅当其 `conclusion` **以及每一个 `premise`** 全都在选中节点集 `selected` 中；两条推导同一结论的独立链保留各自原本的 `arg_...` `id` 绝不合并；未被任何入选链覆盖的选中节点生成 `{ id: node.id, premises: [], conclusion: node.id }`；输出与前提数组均按 `id` 字典序排列。
* **③–⑤ 推导与调用方**：两轮遍历（筛链记 `chained` 集合 → 补未入链单点 → 排序）；调用方：`app/api/chats/route.ts:65`、`components/chain-table.tsx:189, 292`。

---

#### `resolveTargetId(target, nodes)` 与 `formatChainLine(chain, propositions)`（`src/core/chains.ts:70-93`）

* **`resolveTargetId(target, nodes)`**（`70-82`）· `[纯函数]`：
  * **①–③ 逻辑推导**：先经 `stripModelValueDebris(target)` 清理首尾冒号/引号/反引号残渣（空串返回 `null`）；先查是否存在精确匹配的 `n.id === t`（ID 最高优先级）；若无，转小写遍历 `nodes` 查找第一个 `stripModelValueDebris(n.name).toLowerCase() === lower` 的节点并返回其真实 `n.id`；全未命中返回 `null`。
  * **④–⑤ 事故背景与调用方**：练习者模型在填 `target` 时常把命题标题（`name`）当成 ID 填入或带上 `":n_xxx"` 语法残渣，此函数在全图节点集上自动将其归一化为规范 `n_` ID，供 `src/agent/tools/practice.ts:131, 150` 在参数自愈与语义校验两处调用。
* **`formatChainLine(chain, propositions)`**（`84-93`）· `[纯函数]`：
  * **①–⑤ 推导与调用方**：将 `chain.premises` 排序后映射为 `propositions[id]?.name ?? id` 并以 `", "` 连接；非空前提返回 `"${premises} → ${nameOf(conclusion)}"`，空前提单点返回 `"${nameOf(conclusion)} (no premises)"`。调用方：`src/core/graph.ts:494`、`app/api/chats/route.ts:66`、`components/chain-table.tsx:473`。

---

## 5. `src/core/proposition-candidates.ts`（169 行）与 `src/core/clusters.ts`（14 行）

### 5.1 `proposition-candidates.ts`——审计器无状态 BM25 候选检索引擎

* **模块定位与纯度**：导出于 `src/core/index.ts`，全文件 **100% 纯函数**（每次审计构建一个不可变内存索引闭包，无持久状态、无跨调用“已读隐藏”副作用）。

#### `createPropositionCandidateSearch(nodes)`（`src/core/proposition-candidates.ts:75-124`）

* **① 签名与职责定位**：`export function createPropositionCandidateSearch(nodes: readonly GraphNode[]): (proposition: CandidateProposition, hints?: readonly string[]) => Array<{ node: GraphNode; score: number; matchedAlias?: string }>` · `[纯高阶函数]` · 对现存图节点建立分表述 BM25 索引并返回查询打分器。
* **② 输入、输出与核心不变量**：
  1. **多别名不稀释长度惩罚**：每个节点的规范表述（`name + statement`）与每条去重非重复别名（`name + alias`）各自独立建立 `TextIndex`，打分时取该节点**得分最高的一条表述 `bestScore`**，防止老节点因积累了十几个别名导致文档长度暴涨而在 BM25 中吃亏！
  2. **文档频率 `df` 按节点去重计数**：同一词在一个节点的多条别名中出现只计 `1` 次节点频率，防止多别名抬高词频压低 IDF。
  3. **真实别名命中举证**：仅当最高分来自某条别名、且 `words(text.alias)` 自身（而非前置拼接的 `node.name`）命中了查询词时，才返回 `matchedAlias` 供审计器参考。
* **③ 核心逻辑逐步推导**：用私有 `words`（`47-50`，`NFKC` + 小写 + `/[\p{L}\p{N}]+/gu` + 过滤英文功能虚词 `STOP_WORDS`）与 `indexText`（`58-63`）建索引并计算平均表述长度 `averageLength`；查询时合并新命题的 `name/statement/aliases/hints` 词集，按标准 BM25（$k_1=1.2, b=0.75$）计算 `idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * len / avgLen))`，过滤 `bestScore > 0` 并按分数降序、ID 升序稳定返回。
* **④–⑤ 调用方**：`src/agent/tools/graph.ts:143`。

---

#### `propositionCandidateBatch(search, propositions, requests)`（`src/core/proposition-candidates.ts:128-169`）

* **① 签名与职责定位**：`export function propositionCandidateBatch(search, propositions, requests): CandidateBatch` · `[纯函数]` · 执行批量候选检索与每页 `5` 条（`CANDIDATE_PAGE_SIZE = 5`）的无状态分页切片。
* **②–③ 前置全有或全无校验与分页推导**：
  1. 建立待审命题表 `byId`（若有重复局部 `id`，严格保留**第一个**以与 `mergeFindings` 行为一致，`135-138`）。
  2. 先完整校验全部 `requests`：未知 `request.id`、同一批次内重复 `request.id`、或负数/非安全整数 `offset` 均立即抛 `Error`（在返回任何部分结果前拦截，交由工具层转 `isError: true` 让审计器修正重试，`140-146`）。
  3. 对每个请求执行 `search` 并切片 `[offset, offset + 5)`，跨请求去重汇总 `candidates` 详情（合并各页命中的 `matchedAliases` 与去重 `sessions` 出处），计算 `hasMore` 与 `nextOffset` 返回。
* **④–⑤ 调用方**：`src/agent/tools/graph.ts:144`。

### 5.2 `src/core/clusters.ts`（`1-14`）

* **模块定位与内容**：服务端内部常量模块（不进 `src/core/index.ts`），无函数，仅导出 `export const MIN_CLUSTER_SIZE = 3;`（`14`），规定出生会话簇至少包含 3 个客观命题才值得在画布上渲染凸包区域与簇标题（调用方：`src/core/graph.ts:67, 569`）。
