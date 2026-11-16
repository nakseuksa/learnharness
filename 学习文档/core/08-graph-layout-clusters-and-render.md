# 第 08 卷：出生会话聚类、确定性物理布局引擎与渲染参数清洗

> **覆盖源码文件（共 4 个）**：`src/core/session-clusters.ts`（130 行） · `src/core/layout.ts`（720 行） · `src/core/layout-settle.ts`（54 行） · `src/core/render-settings.ts`（394 行）  
> **合计行数**：1,298 行 | **桶导出边界**：`layout.ts` 与 `render-settings.ts` 全量导出于 `src/core/index.ts`（供画布实时模拟与设置面板共享）；`session-clusters.ts` 与 `layout-settle.ts` **刻意排除在桶导出之外**，仅由服务端与抽取流水线直接导入。  
> **纯度概览**：`render-settings.ts`（14 个函数）、`inferenceDepths`、`incrementalLayout`、`birthSessionOf`、`birthSessionPartition`、`impClusterKey` 均为 **100% 严格无副作用纯函数**；`attachImpToCommunities` 显式就地扩展传入的局部簇数组；`createGraphSimulation` 构造按 d3-force 零分配惯例就地演化的模拟器；`settleGraphLayout` 为基于显式 `GraphStore` 端口的确定性同步编排函数。

---

## 本卷导读：“同一套物理定律统治离线落盘态与画布拖拽态”

本卷四个模块共同解决了动态增长知识图谱的空间布局、视觉区域划分与调参安全问题：

1. **出生会话聚类取代嵌入与社区发现（`session-clusters.ts`）**：废弃向量嵌入、Louvain 社区检测与 LLM 簇命名，规定**“一个命题首次存活出处属于哪场会话/哪份笔记（`provenance[0].chatId`），它就归属哪个簇”**——零模型成本、每次读取即时派生、删除来源后共享节点自动顺延重归属。
2. **双端同源 d3-force 增量演化引擎（`layout.ts` + `layout-settle.ts`）**：服务端抽取合并后的离线静止布局计算（`settleGraphLayout` → `incrementalLayout`）与浏览器画布实时拖拽模拟（`createGraphSimulation`）共用**同一套五合力场**（度数缩放弹簧 + 半长蕴涵边 + 多体斥力 + 簇质心引力 + 基于 Tarjan 强连通分量缩点的推导深度锚定），配合位置空间 `0.85` 锚点回混（Anchor Re-blend），使图谱平滑生长而非每次重洗牌。
3. **世界单位（World Units）与双轨安全滑杆（`render-settings.ts`）**：统一使用与图规模无关的世界单位；视觉旋钮吸附在 11 档离散整值阶梯上（默认值居于正中 50 刻度），物理旋钮采用几何均值居中的防爆炸对数区间。

---

## 1. `src/core/session-clusters.ts`（130 行）

### 1.1 模块定位与纯度边界

* **设计目的**（`src/core/session-clusters.ts:1-34`）：从客观命题的出处序列确定性地派生世界模型的区域划分（簇 `cluster`），并为多前提推理链生成的几何蕴涵汇合点（`arg_...`）分配归属簇。
* **桶导出与纯度**：不进 `src/core/index.ts`；零 I/O、零 Node 内置依赖。前 3 个导出函数为严格纯函数，第 4 个函数 `attachImpToCommunities` 按契约就地（in-place）向调用方刚创建的簇列表追加成员并排序。

### 1.2 核心接口契约

* `BirthSessionCluster`（`41-46`）：`{ id: string; members: string[] }`——`id` 为 `chatId` 或导入源 `src_...`，`members` 为按字典序排好的节点 ID 数组。

### 1.3 导出函数逐一五要素精讲

#### `birthSessionOf(node)`（`src/core/session-clusters.ts:50-52`）

* **① 签名与职责定位**：`export function birthSessionOf(node: Pick<GraphNode, "provenance">): string | null` · `[纯函数]` · 提取单个命题节点的出生来源 ID。
* **② 输入、输出与核心不变量**：返回 `node.provenance[0]?.chatId ?? null`。由于 `getGraph` 按账本追加顺序合并出处，当原创建会话以 `delete-nodes` 被清除后，最早的存活贡献会话自然前移至 `provenance[0]` 实现零代码自愈重归属；完全无出处的节点返回 `null`。
* **③–⑤ 推导与调用方**：单行可选链回退；调用方为本文件 `birthSessionPartition`（`67`）、`attachImpToCommunities`（`119`）及 `src/core/graph.ts:686`。

---

#### `birthSessionPartition(nodes)`（`src/core/session-clusters.ts:61-77`）

* **① 签名与职责定位**：`export function birthSessionPartition(nodes: readonly GraphNode[]): BirthSessionCluster[]` · `[纯函数]` · 对客观命题列表按出生来源执行确定性分簇。
* **② 输入、输出与核心不变量**：重复节点 `id` 仅首次出现生效（与 `getGraph` 首行定义规则一致）；`birthSessionOf(node) === null` 的无出处节点不归入任何簇；输出簇按**成员数量降序、平局按簇 `id` 字典序升序**排列，簇内 `members` 亦按字典序升序排列。
* **③–⑤ 推导与调用方**：用 `seen: Set<string>` 去重、用 `members: Map<string, string[]>` 分桶后映射排序返回；调用方：`src/core/graph.ts:566, 638`、`src/core/layout-settle.ts:40`、`scripts/replay-layout.ts:48`。

---

#### `impClusterKey(chain, birthOf)`（`src/core/session-clusters.ts:85-105`）

* **① 签名与职责定位**：`export function impClusterKey(chain: Pick<GraphChain, "premises" | "provenance">, birthOf: (nodeId: string) => string | null): string | null` · `[纯函数]` · 通过前提多数决投票计算多前提蕴涵汇合点（`arg_...`）应归属的簇键。
* **② 输入、输出与核心不变量**：**只对前提投票，结论不参与投票**（2026-09-30 裁定）；平票时优先归入该推理链自身的首次断言来源 `own = chain.provenance[0]?.chatId ?? null`，连 `own` 也缺失时取并列最高票字典序最小者 `winners.sort()[0]!`。
* **③ 核心逻辑逐步推导**：遍历 `chain.premises` 调 `birthOf(premise)` 统计非空票数 `counts`；若 `counts.size === 0` 直接返回 `own`；求最大票数 `max` 及全部得 `max` 票的候选数组 `winners`；若 `winners.length === 1` 返回唯一胜者，否则返回 `own ?? winners.sort()[0]!`。
* **④–⑤ 调用方**：由本文件 `attachImpToCommunities`（`124`）及单测 `tests/session-clusters.test.ts` 调用。

---

#### `attachImpToCommunities(communities, propositions, chains)`（`src/core/session-clusters.ts:114-130`）

* **① 签名与职责定位**：`export function attachImpToCommunities(communities: Array<{ id: string; members: string[] }>, propositions, chains): void` · `[就地修改传入的局部 communities]` · 将所有存活的多前提蕴涵汇合点 `arg_` ID 挂入各自归属簇。
* **② 输入、输出与核心不变量**：跳过单前提链（`chain.premises.length < 2`）及任何端点不在存活命题集 `live` 中的悬空链；若目标簇未出现在 `communities` 中（例如在 `graphSnapshot` 中因客观命题不足 3 个已被凸包过滤器筛掉），则不挂载，确保蕴涵汇合点永远不会把只有 2 个客观命题的小簇“虚胖”复活成凸包。
* **③–⑤ 推导与调用方**：预建 `birthById` 与 `live` 集合 → 遍历合格多前提链求 `impClusterKey` 并推入命中簇的 `members` → 最后统一将每个簇的 `members.sort()` 排好序；调用方：`src/core/graph.ts:584` 与 `src/core/layout-settle.ts:46`。

---

## 2. `src/core/layout.ts`（720 行）与 `src/core/layout-settle.ts`（54 行）

### 2.1 模块定位与纯度边界

* **`layout.ts`**：前后端共享的纯物理引擎（由 `src/core/index.ts:84` 全量导出，零文件/网络 I/O，随机源由 `seededRandom(node.id)` 锁死）。
* **`layout-settle.ts`**：服务端落盘编排模块（不进桶导出，操作显式传入的 `graphStore` 端口）。

### 2.2 核心常量与接口契约（`src/core/layout.ts:39-251, 513-535`）

* 核心默认常量：`LINK_DISTANCE = 40`、`IMP_ID_PREFIX = "arg_"`、`CHARGE_STRENGTH = -240`、`ANCHOR_RETENTION = 0.85`、`BOOTSTRAP_GRAVITY = 0.2`、`INCREMENTAL_GRAVITY = 0.12`、`CLUSTER_PULL_STRENGTH = 0.15`。
* 核心配置接口：`LayoutNode`（`39-41`）、`DepthAnchorMode = "off" | "vertical" | "radial"`（`54`）、`DepthAnchor`（`56-67`）、`SimOptions`（`162-203`）、`LayoutEdge`（`206-209`）、`ImpLink`（`213-218`）、`IncrementalLayoutOptions`（`513-535`）。

---

### 2.3 导出函数逐一五要素精讲

#### `inferenceDepths(nodes, edges)`（`src/core/layout.ts:76-160`）

* **① 签名与职责定位**：`export function inferenceDepths(nodes: ReadonlyArray<Pick<GraphNode, "id">>, edges: ReadonlyArray<LayoutEdge>): Map<string, number>` · `[纯函数]` · 在任意有向图（允许含环）上以 $O(V + E)$ 时间和显式栈空间计算每个节点距基础层的最长推导深度。
* **② 输入、输出与核心不变量**：
  * 自环与指向不存在端点的边一律忽略；
  * 同一强连通分量（有向环）内的所有命题获得**完全相同的推导深度**（互相推导视为同一层级）；
  * 无入边的基础命题（无条件真命题/根节点）深度恒为 `0`，结论深度恒 $\ge$ 所有前提深度 $+ 1$（除非同处一环）。
* **③ 核心逻辑逐步推导**：
  1. 过滤有效边建立邻接表 `adj`（`79-88`）。
  2. 使用显式工作栈 `work: [string, number][]` 运行非递归 **Tarjan 强连通分量算法**（`89-142`）：维护访问时间戳 `num`、最小回边值 `low`、路径栈 `stack`/`onStack`，每当 `low.get(v) === num.get(v)` 时弹出一个完整强连通分量赋编号 `compCount++`。
  3. 利用 Tarjan **逆拓扑序编号性质**（汇点先出栈编号小，源点后出栈编号大），建立缩点前驱表 `preds`，直接按 `c = compCount - 1` 递减至 `0` 执行动态规划 `depth[c] = max_{p ∈ preds[c]}(depth[p] + 1)`，映射回原节点 ID 返回（`146-159`）。
* **④ 边界条件与历史事故背景**：非递归设计避免了数百层深链导致的 V8 调用栈溢出（`RangeError: Maximum call stack size exceeded`）。
* **⑤ 上游调用方与系统接线**：`createGraphSimulation`（`src/core/layout.ts:334`）及 `tests/layout.test.ts`。

---

#### `createGraphSimulation(nodes, edges, options)`（`src/core/layout.ts:258-511`）

* **① 签名与职责定位**：`export function createGraphSimulation(nodes: LayoutNode[], edges: ReadonlyArray<LayoutEdge>, options: SimOptions = {}): Simulation<LayoutNode, SimLink>` · `[构造停止态模拟器；tick 时就地更新传入的 nodes]` · 组装离线静止演化与前端实时画布完全同源的五合力场。
* **② 输入、输出与核心不变量**：
  1. **蕴涵边半长法则**：连接 `"arg_"` 汇合点的边静止弹簧长度强制减半为 `linkDistance / 2`（默认 `20`），普通命题间直连边保持 `linkDistance`（默认 `40`）。
  2. **孤立点豁免法则（Orphan Rule）与汇合点半层锚定（Imp Midpoint Anchor）**：深度模式开启时，在 `logicalEdges` 上没有任何合法边的孤立命题置 `orphan[i] = 1` 豁免深度力；多前提汇合点 `arg_` 的深度锚定在 **`(最高前提深度 + 结论深度) / 2`**，严格居中于最高前提与结论之间。
  3. **多力场正交不打架不变量**：在 `"vertical"` 模式下，向心力与非孤立点的簇质心引力**只作用于 `x` 轴**（`y` 轴完全让给推导层级行）；在 `"radial"` 模式下，结构化节点中心向心力归零，簇质心引力通过 `u - (u · r̂)r̂` **只保留圆环切向分量**（半径完全让给推导同心圆环）。
* **③ 核心逻辑逐步推导**：
  1. 统计各点度数 `degree`，用 `forceSimulation(nodes)` 挂载度数缩放弹簧力 `"link"` 与库仑斥力 `"charge"`，配置 `alphaDecay`（默认 `0.0228`）与 `velocityDecay`（默认 `0.4`）后立即 `.stop()`（`265-298`）。
  2. 若 `mode !== "off"`：基于 `depthEdges = options.logicalEdges ?? edges` 识别连通点集 `connected`，对非 `arg_` 命题求 `inferenceDepths`，再遍历 `options.impLinks` 计算每个汇合点的半层深度写入 `depthsComputed`，最后标记孤立点掩码 `orphan: Uint8Array`（`316-364`）。
  3. 按 `mode` 挂载正交投影后的向心力（`"x"`/`"y"` 或自定义 `"gravity"`，`365-389`）。
  4. 若启用 `clusterPull`：预编译节点所属簇下标 `nodeCluster` 并预分配复用 `sumX / sumY / cnt` 三个 `Float64Array`（每 tick 零 GC 分配！），挂载正交投影后的 `"clusterPull"` 力（`394-459`）。
  5. 若启用 `depthAnchor`：挂载 `"vertical"`（拉向 `baseY - depth * spacing`）或 `"radial"`（拉向 `baseR + depth * spacing`，圆心零距离退化点沿 `(1, 0)` 确定性推开）的 `"depth"` 力并返回 `sim`（`466-510`）。
* **④–⑤ 调用接线**：本文件 `incrementalLayout`（`655`）与 `components/graph-canvas.ts:1314`（私有辅助 `impLinkId` 在 `227-228` 行兼容 d3 初始化前字符串 ID 与初始化后节点对象引用）。

---

#### `incrementalLayout(nodes, edges, previous, options)`（`src/core/layout.ts:542-719`）

* **① 签名与职责定位**：`export function incrementalLayout(nodes, edges, previous, options): Map<string, Position>` · `[100% 确定性纯函数]` · 从上一版静止坐标账本 `previous` 温启动，计算包含新增节点在内的全图新静止坐标。
* **② 输入、输出与核心不变量**：
  * 相同输入必得逐位相同的输出坐标（伪随机数完全由 `seededRandom(node.id)` 决定）；
  * 外圈孤立点半径 `rimRadius` 仅由**有边相连的老锚点平均半径 × 1.7** 导出，斩断孤立点逐批向外膨胀的正反馈链；
  * 位置空间锚点回混（`retention = 0.85`）同样严格投影到自由维度（`"vertical"` 仅回混 `x`，`"radial"` 仅沿圆弧最短角差回混极角 `theta`，`"off"` 回混二维 `x, y`）。
* **③ 核心逻辑逐步推导**：
  1. 提取存活老节点的锚点 `anchors` 并计算核心区包围盒与质心 `(cx, cy)`（`551-575`）。
  2. 构建无向邻接表 `adjacency`，统计连通老锚点计算 `rimRadius`（`578-603`）。
  3. 遍历 `nodes` 确定性播种 `simNodes`：老节点取旧坐标；有老邻居的新节点播在老邻居均值 `±4` 处；无老邻居的新孤立点（`hasCore`）播在 `rimRadius + [0, 8]` 圆周上并自注册进 `anchors`；全空冷启动播在 `[-50, 50]` 方框内；`(0, 0)` 重合点微调至 `x = 0.5`（`606-653`）。
  4. 调用 `createGraphSimulation` 跑满 `ticks`（默认 `300`）步，每步 `sim.tick()` 后对未固定（`fx/fy == null`）的锚点节点按 `dMode` 执行自由维度 `0.85` 位置回混，最终组装 `Map<string, Position>` 返回（`655-718`）。
* **④–⑤ 调用接线**：`src/core/layout-settle.ts:47`、`components/graph-view.tsx:1272`、`scripts/replay-layout.ts:100`。

---

#### `settleGraphLayout(graphStore)`（`src/core/layout-settle.ts:26-53`）

* **① 签名与职责定位**：`export function settleGraphLayout(graphStore): void` · `[端口同步读写编排]` · 在图谱发生合并或客户端提交部分坐标但图已长大时，同步重算全图（含 `arg_` 汇合点）静止坐标并写回 `positions.json`。
* **②–⑤ 逻辑推导与调用接线**：
  1. `const graph = getGraph(graphStore); if (graph.nodes.length === 0) return;`（空图零写入短路）。
  2. 调 `deriveView(graph)` 获取含 `arg_` 节点的视图与 `logicalEdges`、`impLinks`，读取旧 `positions` 转为 `Map`。
  3. 调 `birthSessionPartition(graph.nodes)`（不做 `< 3` 凸包过滤，让小簇在物理上也自然聚拢！）并挂载 `attachImpToCommunities`。
  4. 运行 `incrementalLayout` 后通过 `graphStore.writePositions(Object.fromEntries(next))` 同步落盘。
  * **调用方**：`src/agent/subagents/extraction.ts:1214, 1384`、`src/server/commit-positions.ts:67`。

---

## 3. `src/core/render-settings.ts`（394 行）

### 3.1 模块定位与纯度边界

* **设计目的**（`src/core/render-settings.ts:1-34`）：三端（画布渲染器、设置面板、服务端 `render-settings.json` 存储路由）共享的唯一渲染与物理参数契约、清洗器及滑杆换算数学库。
* **桶导出与纯度**：导出于 `src/core/index.ts:85`；全文件 14 个函数（11 个导出 + 3 个轻量私有辅助）均为 **100% 严格纯函数**。

### 3.2 核心类型、阶梯与物理区间常量（`src/core/render-settings.ts:43-328`）

* 三层配置结构：`GraphRenderSettings`（`43-69`，含单位版本印记 `sizeUnits: "world"`）嵌套 `RegionTuning`（`130-155`，含 `enabled` 计算级总开关与一次模糊后透明叠加 `edgeAlpha`）与 `PhysicsTuning`（`195-216`）。
* 9 条 11 档离散阶梯常量（默认值全在正中央 `index = 5`）：`NODE_SIZE_LADDER`、`EDGE_WIDTH_LADDER`、`ARROW_LENGTH_LADDER`、`LABEL_SIZE_LADDER`、`CLUSTER_LABEL_SIZE_LADDER`、`LABEL_ZOOM_LADDER`、`REGION_DILATION_LADDER`、`REGION_BLUR_LADDER`、`REGION_EDGE_ALPHA_LADDER`（`288-318`），以及位图分辨率下拉固定集 `REGION_BITMAP_OPTIONS = [128, 192, 256, 384, 512]`（`157`）。
* 9 组经实测防发散验证的对数物理区间常量（默认值恰为区间端点几何均值 $\sqrt{\min \cdot \max}$）：`CHARGE_RANGE`、`LINK_STRENGTH_RANGE`、`LINK_DISTANCE_RANGE`、`GRAVITY_RANGE`、`CLUSTER_PULL_RANGE`、`VELOCITY_DECAY_RANGE`、`DEPTH_STRENGTH_RANGE`、`DEPTH_SPACING_RANGE`、`DEPTH_BASE_RADIUS_RANGE`（`320-328`）。

---

### 3.3 导出函数逐一五要素精讲

#### `sanitizeRenderSettings(raw)` · `sanitizeRegionTuning(input)` · `sanitizePhysicsTuning(input)`（`src/core/render-settings.ts:79-112, 174-190, 235-251`）

* **① 签名与职责定位**：
  * `export function sanitizeRenderSettings(raw: unknown): GraphRenderSettings`（`79-112`）· `[纯函数]`
  * `export function sanitizeRegionTuning(input: Partial<RegionTuning> | null | undefined): RegionTuning`（`174-190`）· `[纯函数]`
  * `export function sanitizePhysicsTuning(input: Partial<PhysicsTuning> | null | undefined): PhysicsTuning`（`235-251`）· `[纯函数]`
* **② 输入、输出与核心不变量**：永不抛错；缺失或非有限数值一律回退默认；旧版缺失 `sizeUnits: "world"` 的配置自动将 `nodeSize`、`arrowLength`、`labelSize`、`regions.dilation` 四个改过单位语义的字段重置为世界单位默认值（`legacySizes` 守卫），防止旧屏幕像素值在新世界坐标系下异常放大或缩小；`regions.enabled` 缺省视为 `true`，仅显式 `false` 关闭区域光栅化计算。
* **③–⑤ 推导与调用接线**：`sanitizeRenderSettings` 先判定 `legacySizes = r.sizeUnits !== "world"`，对阶梯字段调用 `snapToLadder` 吸附，再组合 `sanitizeRegionTuning`（位图经 `snapToOption` 吸附）与 `sanitizePhysicsTuning`（9 个连续字段 `clamp` 进安全区间，`depthMode` 白名单校验 `"vertical" | "radial"` 否则 `"off"`）。调用方：`src/store/render-settings.ts:28, 36`、`components/graph-view.tsx:997`、`components/graph-canvas.ts:796, 814`。

---

#### 阶梯滑杆换算组：`snapToLadder` · `ladderIndex` · `toLadderPosition` · `fromLadderPosition`（`src/core/render-settings.ts:331-353`）

* **① 签名与职责定位**：全部 `[纯函数]`，在离散 11 档阶梯值与 `[0, 100]`（步长 `10`）UI 滑杆位置之间执行无损双向转换。
* **②–③ 核心逻辑逐步推导**：
  * `snapToLadder(value, ladder)`（`331-333`）与 `ladderIndex(value, ladder)`（`337-342`）：线性扫描阶梯数组，用严格小于号 `Math.abs(v - value) < Math.abs(best - value)` 选最近项——等距中点自动偏向较小档位（确定性平局决胜）。
  * `toLadderPosition(value, ladder)`（`345-347`）：先经 `clampToLadder` 限制在首尾档位内，再返回 `ladderIndex(...) * 10`。
  * `fromLadderPosition(position, ladder)`（`350-353`）：计算 `Math.round(position / 10)` 并钳制在 `[0, ladder.length - 1]`，直接返回 `ladder[i]` 精确整值。
* **④–⑤ 调用方**：`components/graph-view.tsx:506-666`（全部 9 个非物理视觉滑杆）。

---

#### 对数与带关闭档滑杆换算组：`toSliderPosition` · `fromSliderPosition` · `toOffSliderPosition` · `fromOffSliderPosition` · `labelZoomDisplay`（`src/core/render-settings.ts:362-394`）

* **① 签名与职责定位**：全部 `[纯函数]`，处理连续物理参数的对数轴滑杆双向映射、零值关闭档（Off-zone）以及标签缩放阈值展示格式化。
* **②–③ 数学推导与边界条件**：
  * `toSliderPosition(value, min, max)`（`374-378`）：将 `value` 钳制在 `[min, max]`（要求同正，负数 `chargeStrength` 由调用方取绝对值传入 `-CHARGE_RANGE.max, -CHARGE_RANGE.min`），返回 `100 * Math.log(v / min) / Math.log(max / min)`；当 $v = \sqrt{\min \cdot \max}$ 时恰好返回 `50`。
  * `fromSliderPosition(position, min, max)`（`381-385`）：严格逆函数 `min * Math.exp((clamp(position, 0, 100) / 100) * Math.log(max / min))`。
  * `toOffSliderPosition` / `fromOffSliderPosition`（`362-371`）：因为对数轴无法取到 `0`，专门在 `value <= 0` ↔ `position <= 0` 处开辟零值关闭特判，大于 `0` 时平滑衔接对数映射。
  * `labelZoomDisplay(labelZoom)`（`391-394`）：返回 `` `${Math.round((labelZoom / 0.5) * 100) / 100}×` ``，以 `0.5` 相机比率锚定为 `1×` 基准展示。
* **④–⑤ 调用方**：`components/graph-view.tsx:548, 689-822`。

### 3.4 轻量私有辅助函数归并表

| 函数名 | 行号 | 纯度 | 作用与调用归属 |
|---|---|---|---|
| `clamp` | `72` | `[纯函数]` | 数值闭区间裁剪 `Math.min(Math.max(v, min), max)`。 |
| `snapToOption` | `168-170` | `[纯函数]` | 将离屏位图尺寸吸附至固定下拉选项集 `REGION_BITMAP_OPTIONS` 中最近的一项。 |
| `clampToLadder` | `356-358` | `[纯函数]` | 将输入值限制在离散阶梯数组首元素与末元素之间，供 `toLadderPosition` 调用。 |
