# 学习线束 — 愿景与计划 (Learning Harness — Vision & Plans)

活文档 (Living document)。开始于 2026-08-22，记录当前的愿景和所有已敲定的决定。随着情况的发展进行修正。

主框架 (Master frame)：由三部分组成的学习模型以及扩展性/插件方向记录在 [`vision-extensibility.md`](vision-extensibility.md) (2026-10-02)。

先例 (Prior art)：Obsidian 库中的 `knowledge graph design.md`（2025-08-20 的构思） — 曾经是认识模型 (epistemic model) 的规范；§1 中 2026-09-02 的节点理论 + 构建重新设计进一步修正了它（没有误解节点 misconception nodes、用 `follows`/`supports` 替代、没有已教授事件 taught events、精确到消息来源 message-granular provenance）。本文档记录了今天的决定对它的 **修正 (amend)**，并补充了原始文档推迟讨论的会话体验 (session-experience) 和呈现层 (presentation layers)。

---

## 1. 知识图谱 — 核心 (The knowledge graph — the centerpiece)

学习者学到的一切都会积累到一个持久化、跨领域的图谱 (persistent, cross-domain graph) 中。它是应用的主页 (home page)，也是系统的心脏：结构会随着时间的推移清晰可见地建立起来，这些数据支持前沿探索 (frontier expansion)、“接下来学什么”查询 (what-next queries)、修复 (repairs) 和解锁价值 (unlock-value)（按照原始设计文档）。

**节点理论 + 构建重新设计 2026-09-02 (Node theory + construction redesigned 2026-09-02)** — 从“图谱是什么 (What the graph is)”到“理解是派生的 (Understanding is derived)”的小节是当前的哲学，部分取代了原始设计文档的认知模型 (epistemic model) 和 2026-08-22 的实时生成构建决定 (live-emission construction decision)（见修正表 amendments table）。

### 关键要求：频繁更新 (Critical requirement: frequent updates)

图谱更新是 **连续的，而不是按会话进行的 (continuously, not per-session)**。一个回答了几个问题然后离开、没有“完成”会话的学习者，仍然必须在主页上看到一些新东西。部分会话 (Partial sessions) 也能沉淀价值。后台提取管道的检查点机制 (checkpoint mechanism) 满足了这一点（在主页/空闲时折叠，绝不会重复相同的轮次）— 而不是实时生成 (live emission)。

### 图谱是什么 — 节点理论 (2026-09-02 决定) (What the graph is — node theory (DECIDED 2026-09-02))

全局图谱是 **学习者遇到过的领域的一个客观世界模型 (objective world-model of the domains the learner has encountered)**：包含事实 (facts)、它们的结构（什么派生于/被什么支持）、以及 — 从该结构加事件账本 (event ledger) 推断出的 — 学习者的理解状态。没有任何与学习者或会话相关的东西被存储 **在 (in)** 图谱中；理解是 **推断出来的，绝不被编码 (inferred, never encoded)**。

- **每个节点都是一个为真的命题 (Every node is a true proposition)。** 用客观的措辞，以符合其语境的最简形式存在。真理是相对语境的，这没问题：“重力是一种力”和“重力不是一种力”可以作为节点共存 — 各自在其语境（经典力学 vs. 广义相对论）中为真，以 **周围的子图作为语境 (the surrounding subgraph as the context)**。没有语境字段 (context field)，不强求事实拘泥于自我包含 (pedantic self-containment)。
- **节点模式 (Node schema):** `name` (名称) — 节点的一个极短的标签，一个像词汇表词条一样的紧凑句柄（“权力意志 Will to power”、“神圣命令理论 Divine command theory”）：是图谱一览中显示的内容。仅用于呈现 — 不唯一，不是身份键，绝不追求精准。在创建时设定；再次遇到时绝不改变它。`statement` (陈述) — 全精度的命题（身份锚点 the identity anchor；显示在详情卡片中）。`aliases` (别名) — 会话中使用的原话措辞（合并键 merge keys + 审计跟踪 audit trail）。**没有 `kind` (类型)** 并且 **没有 `description` (描述)** (2026-09-08 修正：有了真实数据后，全句子的画布标签被证明是行不通的 — 十行的标签，重叠在一起无法阅读。标签就是名称；精度在陈述 (statement) 的一次交互中体现)。
- **误解不是一个节点类别 (Misconceptions are not a node category)。** 一个神话以其真实的纠正形式进入图谱（“大脑只使用了10%的说法是一个神话”）；学习者持有错误想法的状态完全存在于事件账本中。错误是关于学习者的，而学习者存在于账本中。

### 边缘 (2026-09-02 决定) (Edges (DECIDED 2026-09-02))

两种，没有标量 (scalars)，没有编码的强度 (encoded strength) — 前提性是一个谱系，我们故意拒绝对其进行形式化：

- **`follows` (派生于)** — `A → B`：B 是从 A *可派生的 (derivable)*（A 是 B 的一个前提）。如果 C 同时派生于 A 和 B，那么 `A → C` 和 `B → C` 都存在；联合要求只是一组兄弟边缘。
- **`supports` (支持)** — `A → B`：A *奠定或证明 (grounds or justifies)* B，但不必然导致 B。

依赖的强度/深度是根据拓扑结构（链条 chains、印证 corroboration）**在读取时派生的 (derived at read time)**，绝不存储 — 这是未来理解模型所消耗的输入。

### 来源 — 消息粒度 (2026-09-02 决定) (Provenance — message granularity (DECIDED 2026-09-02))

每个节点记录它出现的每个 **(聊天, 消息) 点 ((chat, message) point)**；每个边缘记录断言它的每条消息。可以深度链接到确切的转录点 — 派生审计跟踪是一等功能，而不是副产品。

### 构建：自由形式提取，与会话完全解耦 (2026-09-02 决定 — 取代实时生成) (Construction: free-form extraction, fully decoupled from sessions (DECIDED 2026-09-02 — supersedes live emission))

*覆盖率在 2026-09-15 确定 — 见 `vision-extraction-coverage.md`：消息是覆盖率的单位（每个聊天一个覆盖指纹账本 covered-fingerprint ledger），运行受令牌预算限制的最早未覆盖消息批次，触发条件是未覆盖令牌 ≥ 块预算（取代了 everyNQuizAnswers — 没有测验的会话也会提取）。*

**第二次修正，推翻了 2026-08-22 的实时生成构建决定 (Second amendment, reversing the 2026-08-22 live-emission decision)。** 会话的计划树是教师为会话体验 (§2) 搭建的脚手架 (scaffolding)；全局图谱不依赖它 — 无论是在结构上还是其他方面。教师形式化的是相对于会话的；图谱决不能继承这些选择。（原始设计文档的事后 stance 毕竟是对的。）

三个阶段，一条管道 — 唯一的图谱写入者：

- **提取器 (Extractor) (LLM) — 单源范围。** 仅看源文本 (source text) — 会话转录（树盲 tree-blind，带消息 ids）或原始笔记（前门的第二个提示，见上）。带着原文证据自由报告：来自会话任何地方的命题（每个一个推理步骤；教师散文和教师形式化的任何内容一样重要），根据转录陈述的边缘，消息粒度的来源，追溯的测验归因，以及每个命题的 **理解水平 (understanding level)** — 学习者在本次会话中接受/理解它的强度，一个封闭的命名词级 (CLOSED named-word scale) (`solid 扎实` / `shaky 不稳` / `accepted 接受` / `resisted 抵触` / `not yet engaged 尚未涉及`；2026-09-08: 模式强制 — 只能是一个词，没有数字，没有理由 justifications，这些会被丢弃而不是存储）。这些水平是未来状态模型的数据；它们的处理待定 (TBD)。
- **审计器 (Auditor) (LLM) — 全局图谱范围。** 看到提取器的输出和现有的图谱。两项工作：忠实度网 (faithfulness net)（对照原文证据验证每个候选项 — 不变），以及 **同一性判断 (identity judgment)**：将每个命题链接到现有节点（将会话的措辞记录为别名 alias）或新建它。保守的：宁可重复，不要错误合并 (duplicates over wrong merges)。
- **合并器 (Merger) (确定性 deterministic)。** 仅追加的账本写入；从测验工具部件机械地重建测验事件类型/引用。每个判断都是 LLM 的；所有机械性的操作都由代码完成。

**事件账本 (修正) (Event ledger (amended)):** 测验结果从测验工具部件确定性地重建（正确 correct / 错误 miss / 不知道 don't-know，加上学习者的笔记）。**没有 `taught` (已教授) 事件** — 没有“标记完成 (marking-things-done)”。提取器按命题给出的理解水平作为会话范围的观察 (session-scoped observations) 加入账本（每个节点每个会话一个封闭词）。同一性不再是精确字符串匹配 (exact-string matching) — 它是审计器的判断，别名作为措辞记录。

### 与格式无关的前门 — 笔记导入 (2026-09-13 决定) (The format-agnostic front door — notes imports (DECIDED 2026-09-13))

相同的三阶段管道（提取器 → 审计器 → 合并器）在 **任意格式的原始个人笔记 (raw personal notes in arbitrary formats)** 上运行 — 一个 Obsidian 库、纯 markdown、任何文本。提取器在设计上对格式是盲目的（它总是看到渲染的文本，而不是 ChatRecord JSON），因此笔记路径只需要第二个提取器提示词（通用提取；理解词判断 **作者 (author's)** 对自己评论的掌握程度）和一个来源抽象：每个导入的文件成为一条 `NotesSource` 记录（由路径哈希决定的确定性 id — 重新导入是幂等的），在映射、检查点和观察事件中扮演 `chatId` 的角色。

决定的边缘 (Decided edges)：

- **没有会话塑造 (No session shaping)。** 笔记决不会被弯曲成教师/学习者对话的转录本；笔记中的测验结果只通过提取器的理解观察出现（确定性的测验事件重建是会话管道的功能 — 它需要结构化的测验工具部件）。
- **静态来源 (Static provenance)。** 导入的节点在会话列表中将其文件路径显示为静态条目 — 从不作为链接。理解评估水平适用于个人笔记，也适用于会话。
- **与会话运行相同的单航班注册表和可观察性 (Same single-flight registry and observability)**：实时状态，每个阶段的使用量核算，真正的中止。一个管道实例，两扇前门（由测验触发的会话；POST /api/graph/import）。

### 理解是派生的 (2026-09-02 修正) (Understanding is derived (amended 2026-09-02))

已知的与理解的 (Known vs. understood)，事件账本作为真实来源，派生状态在读取时重新计算 — 在精神上继承自设计文档。状态模型本身现在是一个明确的设计讨论：**节点状态应该与会话无关，并根据依赖的深度和强度 (the depth and strength of dependencies)** (`follows`/`supports` 拓扑) 加上测验事件和理解笔记 **计算出来**。该重新设计正在构思中；过渡性的五类派生（已教授 / 已知 / 错误 / 不知道 / 候选）已 **移除** (2026-09-08) — 图谱视图渲染状态中立的节点，直到状态模型设计出来。锚定的校准评分标准在有真实数据之前一直搁置。

### 聚类 — 世界模型的区域 (2026-09-13 决定，构思中) (Clusters — regions of the world model (DECIDED 2026-09-13, ideation))

当图谱被填满时，画布需要一种一目了然的可读结构：**聚类 (clusters)** — 世界模型的客观区域（如“拉康精神分析”或“光合作用”这样的领域），通过对 `follows`/`supports` 边缘的 **社区发现 (community detection)** 来发现。一个社区 = 节点之间的链接远远多于与其余节点的链接（模块度 modularity）。关于它们的一切都 **完全是从图谱数据中推断出来的 (entirely inferred from the graph data)** — 提取/审计管道绝不知道聚类的存在。

- **算法：Louvain (模块度最大化)，用种子保证确定性。** 栈内通过 graphology 的生态系统实现，接近线性，扩展性远超我们的规模。确定性提供了可重复性（相同图谱 → 相同聚类）；种子/graphology 选择也保留了升级路径：Louvain 的树状图 (dendrogram) 包含 **层级 (hierarchy)** — “数学 ⊃ 微积分 ⊃ 链式法则” 是向下一层 — 目前故意未构建（多尺度聚类暂时搁置）。驳回：Leiden（更好的分辨率保证，无 JS 移植），Infomap（启发式强，更重，JS 支持弱），Girvan–Newman (O(n³))，标签传播 label propagation（不稳定），谱聚类 spectral（需要传入 k）。
- **是结构，而不是布局 (Structure, not layout)。** 聚类是 *边缘 (edges)* 的纯函数，而不是视觉布局的。力导向布局已经将结构上相近的节点放在一起，所以聚类的外壳 (cluster hulls) 看起来会是连续的 — 但聚类同一性决不能继承布局的种子依赖和漂移。
- **派生，缓存，自动更新 (Derived, cached, auto-updated)。** 当账本发生变化时，聚类会重新计算，针对图谱版本戳进行缓存 — 与状态和强度遵循相同的原则：派生从不存储，没有任何东西需要手工维护。
- **尺寸门控意义 (Size-gated meaning)。** 只有 ≥ ~3 个节点的社区才会渲染为聚类（阈值可在真实数据上调整）— 一个可见的色块总是意味着“一个真正的领域”；孤立的节点和微小的社区保持原样。
- **命名：每个新增/更改的聚类仅需一次廉价的 LLM 调用 (Naming: one cheap LLM call per new/changed cluster)** — 将成员的名称 + 陈述传给 LLM（无智能体循环），生成一个简短的领域标签。绝不属于提取的一部分；这是一个独立的，带缓存的接缝 (seam)。
- **标签持久化 — 核心存活规则 (Labeling persistence — the core-survival rule)。** 每个标签记录（只追加，和我们持久化的所有东西一样）存储了标签及其据以生成该标签的成员集合（**核心 core**）。一个重新计算的社区只要其成员中 ≥ 一半来自该核心，就 **保留 (keeps)** 其标签；如果少于一半，它就会用当前所有节点重新 **贴标签 (relabels)**（追加一条新记录 — 旧记录作为历史保留：领域命名历程的审计跟踪）。唯一后继者 (Single successor)：在分裂/合并时，重合度最高 (strongest-overlap) 的社区继承标签，其他的获得新标签；如果没有 ≥50% 的后继者，该核心便没有现存的继承人。聚类颜色与标签记录绑定 — 颜色存在的寿命与标签完全一致。
- **渲染：一切背后的发光色块 (Rendering: glow blobs behind everything)。** 虚线边界包围聚类的外壳；填充是模糊的、低不透明度的，并且位于整个图谱的 *背面 (behind)*（边缘和节点漂浮在它上面，所以模糊效果自然地使聚类间的空间变得朦胧）。每个聚类具有稳定的色相 (stable hue)。**聚类标签采用反向门控 (Cluster labels are inverse-gated)** 对抗现有的相机比例跨度：缩小 = **领域视图 (domain view)**（聚类标签开启，节点标签关闭），放大 = **命题视图 (proposition view)**（节点标签开启，聚类标签淡出）— 一个画布的两个视图之间进行对称过渡。
- **边界几何体：在绘制时计算，绝不存储 (Boundary geometry: computed at draw time, never stored)** — 完全是成员位置的函数。这个约束使得未来的物理效果/移动节点（可能近期不会实现）不会使任何东西失效：凸包 (convex hull) + 填充 (padding) + 圆角 (rounded corners) 的每帧开销很低；有机的变形球外壳 (organic metaball hulls) 也属于同一家族。在此之前暂居次要位置。
- **跨聚类边缘保持可见 (Inter-cluster edges stay visible)。** 领域之间的桥梁意义重大（尼采的权力意志 *派生于 (follows)* 叔本华的意志）— 这是聚集视图 (clustered view) 中提供最多信息的内容之一，而不是杂波。
- **诚实的风险：稀疏性 (Honest risk: sparsity)。** 社区发现需要密度对比度 (density contrast)，而当前真实的图谱很稀疏 — 2k-节点合成基准（未决问题 1）不仅是布局/渲染速度的 *主要* 验证，更是对聚类质量的验证。

### 渲染 (决定 — 2026-08-22 研究报告) (Rendering (DECIDED — research report 2026-08-22))

**渲染设置 (2026-09-13) (Render settings (2026-09-13)):** 图谱视图中的四个基本控制 — 节点大小 (node size)、边缘宽度 (edge width)、箭头长度 (arrowhead length)、以及 **缩放级别控制 (the zoom-level control)**（标签可见度阈值；1× = 适合缩放 fit zoom）— 按浏览器持久化。缩放控制故意被设计为唯一 (THE) 的缩放旋钮：聚类标签在相同的淡出跨度内受其反向控制（已实现：当聚类标签淡入时，节点标签淡出 — 它们绝不共存）。设置改变仅重建渲染器：布局位置和相机从不移动。（边缘长度 (Edge-length) / 间距控制 (spacing controls) 故意搁置，直到有了聚类感知的间距设计。）

- **库：sigma.js v3 + graphology + graphology-layout-forceatlas2。** 全部 gzip 压缩后 ~40 KB — 是 vis-network 的一半，cytoscape 的三分之一，远低于 react-force-graph（依赖项 ~250 KB）和 cosmos.gl (luma.gl 栈)。
- **布局：同步的运行即冻结 (Layout: synchronous run-then-freeze)。** `forceAtlas2.assign(graph, { iterations: 100, settings: inferSettings(graph) })` 运行一次，写入 x/y 坐标，而且永远不启动动画循环 — 几乎零空闲 CPU（sigma 仅在相机/图谱事件时重绘）。在几百个节点下 <150 ms；在 ~2k 节点时启用 `barnesHutOptimize`，然后启用捆绑的 Web Worker，再服务器缓存位置 — 依此顺序，仅当延迟成为问题时才使用。
- **缩放时的标签 (Labels at zoom):** sigma 的 `labelRenderedSizeThreshold` 完美复制了 Obsidian 的 "text fade threshold"。
- **平移/缩放 (Pan/zoom)** 内置；悬停/点击事件 (`enterNode`, `clickNode`) 免费。类型化的边缘 (Typed edges)：`EdgeArrowProgram` 和/或 为 `follows` vs `supports` 使用两种边缘颜色。
- **React 集成：** 只有 ~40 行的 `useEffect` 轻量包装器（sigma 是命令式的；`@react-sigma/core` 存在，但可选）。
- **Obsidian 内部机制 (经研究证实):** PixiJS **WebGL** 渲染器 (canvas 回退)，自定义的 d3-force 风格模拟（它的四个力滑块 1:1 映射到 d3-force 的原语），受缩放门控的标签淡入淡出，alpha 衰减稳定 (alpha-decay settling)。我们选择的栈通过一个有文档且维护良好的库重现了这种感觉。
- 驳回：vis-network / cytoscape.js（Canvas 2D，3倍体积包，带有我们不需要的编辑功能），react-force-graph-2d（具有最好的冻结 API 但依赖树最重；它的强项是 *动画 (animated)* 模拟，这是我们明确不想要的），cosmos.gl（GPU 运算的力 — 在 ~10k 节点以下是大材小用）。
- 实施前验证 (低成本)：在确认实施前进行 2k 节点合成基准测试，确认布局时间 + 渲染流畅度。
- 物理效果仅用于 **放置 (placement only)** — 没有拖拽，没有滑块，没有编辑交互。仅平移 (Pan) + 缩放 (zoom)。

### 图谱作为会话上下文 (2026-08-22 决定) (The graph as session context (DECIDED 2026-08-22))

*选择问题 V1 解决于 2026-09-14 — 见 `vision-context-injection.md`：在每会话代币预算下的语义接近性 top-K (semantic-closeness top-K)，作为引导 (steer) 传递。下面提到的结构邻域 (structural-neighborhood) 和诊断热点 (diagnostic-hotspot) 策略暂缓实施。*

每次会话都以学习者的知识图谱作为教师的基础上下文开始。这使得探测 (probing) 变得 *精准* — 探测问题能够针对学习者实际掌握边界上的微妙之处和细微差别，而不是每次会话都从零开始重新发现。个性化会在多次会话中不断复合。

**选择问题 (开放中) (The selection problem (open)):** 整个图谱最终可能构成过多的上下文，且教学相关性 ≠ 语义相似性。对于一个新主题，重要的是：(a) 它的 **结构邻域 (structural neighborhood)** — 该主题所依赖的 `follows` 边缘子树，无论其表面有多不相似；(b) **诊断热点 (diagnostic hotspots)** — 账本标记为不稳 (shaky) / 误解 (misunderstood) / 有错觉 (misconceived) 的节点，位于图谱中任何位置（一个活生生的错觉 — 表明学习者掌握了错误节点的事件 — 永远是相关上下文）；(c) 该主题附近的前沿地带。候选策略，需在真实数据上调优：图谱较小时提供完整图谱；主题节点周围的 k-跳 结构邻域；通过账本信息的切片（首先选择薄弱/错觉/游离的）；通过给定的会话主题，进行低成本的路由运算以提取子树。

### 首页 (Home page)

图谱视图 (graph view) 取代了当前的占位符。v1版本：来自所有会话的所有节点，平移/缩放，缩放时显示标签，状态中立的节点（见“理解是派生的”），并且 — 一旦实现 — 在图谱后面的聚类发光色块带着虚线外壳，领域↔命题 作为缩放门控的两种视图（见“聚类”）。点击一个节点 → 显示它出现的确切的 (会话, 消息) 点 (消息粒度的来源，深度链接)。一切更丰富的内容 (前沿发光 frontier glow, 腐烂映射 rot map, 影响范围 blast radius) 将在状态模型建立之后再做。

---

## 2. 会话体验 — 绝非通用的聊天 (The session experience — not a generic chat)

目标：一堂学习课程 (learning session) 必须在外观和感觉上在结构上区分于 ChatGPT/Claude 那样的对话。区分点在于将会话的 **依赖树作为一个正式的、可见的、可被智能体编辑的对象 (dependency tree a formal, visible, agent-editable object)**，而不是一张用完即扔的 mermaid 草图。

### 正式的计划树 (决定) (The formal plan tree (DECIDED))

- 智能体通过 **结构化工具 (structured tools)** 编写这棵树 — `add_node` (添加节点)、`add_edge` (添加边缘)、`reparent` (重新指定父节点)、`remove_node` (移除节点)、`set_current` (设置当前位置)，… — 通过模式验证 (schema-validated)，并在编辑过程中保持稳定的节点同一性 (stable node identity)。将 Mermaid 文本作为事实来源的想法被否决了：因为编辑它就如同文本手术，节点的同一性会发生漂移 (drift)。
- 智能体可以在会话中途主动修改树（当学习者提出值得探讨的内容时绕道、深入探讨、修剪） — 这种权力是显式的。
- 这棵树 **仅仅是会话的脚手架 (session scaffolding only)**：全局图谱是由自由格式的、事后的提取建立的，提取在设计上是故意无视树结构的 (tree-blind)（§1，构建）。没有任何结构上的东西会从这棵树带入全局图谱中。
- **“我们当前在哪里”** 是作为结构化状态追踪的（通过 `set_current` 工具），而不是从转录本推断出来的。
- **Mermaid 仅留给即席的教学图表使用 (Mermaid survives only for ad-hoc lesson diagrams)**（流程图、循环图、对比图），也就是那些并非计划树的图表 — 而且明确 **鼓励教师在解释中自由使用图表 (encouraged to diagram freely in explanations)**；图表是一等教学输出，不是装饰品。它的渲染质量必须提高（集成显示，可用的缩放/平移 — 目前类似于代码块的渲染效果是不可接受的），但它现在已退居次要位置。

### 两个阶段，界限分明 (决定) (Two phases, clearly separated (DECIDED))

- **探测 (Probe)** 和 **教学 (teach)** 是仅有的两个真正的阶段；规划 (planning) 并不是一个阶段，只是一个瞬间（可能用个小指示器）。
- 智能体通过一个结构化标记 (structured marker) 发出 探测→教学 过渡的信号 → **在转录本中出现可见的分隔线 (visible divider in the transcript)**。
- **探测阶段的问题自动打开 (Probe-phase questions auto-open)**（跟现在一样 — 它们是探测的核心）。
- **教学阶段的检查题起初折叠 (Teaching-phase check questions start collapsed)** 在一个“检查你的理解”展开按钮后面。理由：在讲课中间突然弹出一个问题，会迫使学习者立即作答；学习者应该先阅读教学内容，准备好了再打开检查。

### 交互式演示 — 教师编写的制品 (决定方向) (Interactive demos — teacher-authored artifacts (DECIDED direction))

最通用和最有能力的演示运行时环境正是我们已有的：**Web 平台本身 (the web platform itself)。**

- **统一格式：一个独立的单文件 HTML/JS 文档 (a self-contained single-file HTML/JS document)**，由 `demo` (演示) 工具生成（客户端，类似于测验/提问工具），在转录本的 **沙盒化 iframe 中内联渲染 (sandboxed iframe)** (`sandbox="allow-scripts"`，禁止同源 → 无法访问应用的存储/Cookies/DOM)。纯原生 JS + Canvas 2D + SVG 能够涵盖绝大多数的教学演示（函数绘图、模拟、动画、参数扫描）；允许通过 CDN 引入库以支持更重型的任务（通用性最重要 — 毕竟这是学习者自己的机器，而且代码是教师写的）。
- **契约比技术更重要 (The contract matters more than the tech):** (a) 自动注入一个极小的桥接脚本 — ResizeObserver → postMessage → 父页面调整 iframe 大小；(b) 捕获 `window.onerror` 发送给父页面 → 在演示上显示错误小标签 (error chip) → 学习者（或者自动流程）将错误发送回教师，教师修复并重新发出演示。修复闭环 (fix loop) 正是高品质 Artifacts 产生的地方。(c) 再次调用该工具 = 生成该制品的一个新版本。
- **持久化是免费的 (Persistence is free):** HTML 保存在该消息的工具部位中，因此在重新加载会话时演示会重新渲染。
- **Python：暂缓 (Python: deferred)。** Pyodide (WASM CPython; numpy 可用; matplotlib 可渲染静态图) 是唯一不需要服务器的路径 — 体积庞大 (10–20 MB 懒下载 lazy download) 且互动性差 (面向静态图像重渲染)。等以后有课程真正需要 numpy 级别的计算能力时再重新考虑。**服务器端 Python：已否决 (Server-side Python: rejected)**（涉及沙盒基础设施、便携性问题）。
- 系统提示词应该像鼓励使用图表那样鼓励使用演示：*如果这个概念是动态的 — 比如需要扫描一个参数、需要给一个过程做动画、需要给一个分布做采样 — 请构建仪器，而不要只是去描述它 (build the instrument, don't describe it)。*

### 笔记，出声思考和听写 (决定方向；稍后构建) (Notes, thinking out loud, and dictation (DECIDED direction; build later))

笔记区域 (note field) 不是一个辅助的输入项 — 它是学习者 **说出推理过程 (reasons out loud)** 的渠道。课程应当顺着它展开：提示教师去诱导学习者畅所欲言 (yapping) (“跟我说说你的推理过程 talk me through your reasoning”)，在后面引用学习者用过的话，而且这些笔记作为诊断事件 (diagnostic events) 反哺给图谱（遵循设计文档：笔记是极好的校准材料 calibration gold）。UI 上应给笔记更突出的待遇。

**听写是硬性要求，不是奢侈品 (Dictation is a requirement, not a luxury)** — “畅所欲言 (yapping)” 指的是说出来，不是打字。Web 端的实现要求如下：
1. **捕捉 (Capture):** `getUserMedia` + AudioWorklet → 16 kHz linear16 PCM（浏览器原生；替代 pi 扩展中的 sox/`rec`）。
2. **传输 + 转录 (Transport + transcription):** pi 的 `dictate` 扩展已验证的配方可以直接移植 — Deepgram 流式处理 (`nova-3`, `smart_format`, `punctuate`, `endpointing=300`)，逐句最终结果。架构：一个服务器路由生成一个 **短效 Deepgram 令牌 (short-lived Deepgram token)**，浏览器直接连接至 Deepgram 的 WSS 接口（API 密钥绝不触达客户端）。基于设备本地的 whisper (transformers.js/WebGPU) 则是私密/离线的备用选项 — 除非 Deepgram 让人失望，否则推迟实现。
3. **用户体验 (UX):** 输入框组件里有个麦克风按钮；实时的电平表 (AnalyserNode — 重建了 pi 扩展响应灵敏的视觉效果)；转录内容直接落在文本框中，在发送前可编辑；按 Escape 取消；**已经完成的听写决不会丢失**（这是从 pi 扩展那来之不易的 UX 经验中直接继承的）。

### 这不是聊天 — 展现原则 (方向，2026-08-22 — 低优先级) (It is not a chat — the presentation principle (direction, 2026-08-22 — LOW PRIORITY))

从功能上看，一场会话就是一次交谈 — 学习者不断发言、推理和引导；这股双向信息流 *正是让系统工作得最好的方式*。但是，绝不能把它 **展现 (presented)** 得像个聊天室。把聊天界面全忘了吧。化解这个悖论的办法是：

**制品的不对称性 (Asymmetry of artifact)。** 在聊天中，双方在相同的车道里生成了同样的东西（消息）— 这就是它 *看起来* 像聊天的原因。而在课堂上，双方生产的东西在本质上是不同的：

- **教师在撰写文档 (The teacher writes the document)。** 包含散文 (Prose)、章节 (sections)、图表 (diagrams)、演示 (demos)、检查 (checks) — 教师输出的是具有结构化特征的内容；这就成了课程材料本身。教师并不是在“发消息”；它是在 *撰写课程 (writes the lesson)*。（白板 (The whiteboard)。）
- **学习者在边缘处做批注 (The learner writes in the margins)。** 包括回答、提问、推理过程、各种插话 (yaps) — 这些都属于贡献性内容，并且锚定在文档的各个位置。（地板 / 声音 (The floor / the voice)。）*(下文对此有修正：完整的插话卡片被留在主时间线上；边缘区只是一种视图方式，而非存储之地。)*

这是两种不同的乐器，而不是两个一模一样的键盘。其后果是：

- **气泡死去了 (Bubbles die)。** 教师的文本采用文档排版风格渲染（标题、散文、全宽的区块）。学习者的文本则渲染为注释块（带边框的笔记卡片、有锚点引用的引用块）— 绝不是靠右对齐的聊天气泡。
- **构成单元是区块，而不是消息 (The unit is the block, not the message)。** 例如章节、段落、图表、演示、检查、问答框、边缘笔记。
- **按时间顺序排列向结构妥协 (Chronology yields to structure)。** *(下文修正：只有一条按时间顺序排列的主时间线；结构通过类型化的区块以及链接叠加层来体现，而不是靠重新排列位置。)*
- **问答变成文档里的家具配置 (Q&A becomes document furniture)。** 学习者的提问渲染成一个带有引用的卡片，而教师的回答作为散文紧接在其下方 — 就像教科书里的“读者提问”栏一样，而不是一来一回的两个回合。
- **输入框变成了回复栏 (The composer becomes a response field)。** 还是同样的悬浮模块，换个思路：它输出的东西像批注一样挂在当前位置上，而不是像溪流中的下一个气泡一样跟着漂走。
- 保留什么：底层的轮流发言机制 — 对 LLM 而言，它看到的仍然是一次对话。这是 **呈现层 (presentation-layer)** 上的转变，而不是交互模型的改变。

参考案例：教材边缘批注，Hypothesis/Genius 批注，Observable 笔记本（一个充满活动单元的文档），研讨会（有白板和发言）。词汇选择很重要：它们是 **会话/课程 (sessions/lessons)**，决不能叫“聊天 (chats)”。

### 优化完善：主干时间线和打断插入 (2026-08-22，基于反馈) (Refinement: the spine and the interjection (2026-08-22, after feedback))

上述边缘批注模型在评审时暴露出两个真实的缺陷：(a) **定位 (placement)** — 当学习者发出一大段插话，里面包藏着对各种不同事物的提问时，若要把这片段正确投递至相应锚点，势必需要依赖并不可靠的 拆分并路由 (split-and-route) 的步骤；(b) **收到后的感知 & 时序 (receipt & chronology)** — 将学习者的内容零敲碎打地分发在各个边缘区，意味着当他们点击发送时，*肉眼看不到发生任何动静*，自己到底在何时贡献了啥内容全没了。再者：会话带来的价值主要是在 **当下这一刻 (in the moment)** — 人们很少回去翻阅过去的会话 — 因而把重点放在重构为了便于日后重读的制成品是优先级搞错了（HTML 的导出也被降级了）。

演进后的模型保留了干掉聊天界面的特点（不对称性）但丢弃了位置重排的念头：

- **一条主干时间线 (One chronological spine)。** 一切产生的内容全部严格按照时间顺序列在前线呈现。学习者发送的区块将 **永远** 保持 **原样完整、清晰可见并且带上时间戳 (intact, visible, and timestamped)**。
- **学习者的区块变成一张“打断插入 (interjection)”卡片，而不是气泡 (The learner block is an "interjection" card, not a bubble)。** 这成了一个独特的物种分支：独占一整行全宽，有底色，左侧带着标尺线，顶上打个醒目标签 `你 · 下午3:41 (You · 3:41 PM)` (语音录入的还加上个麦克风徽章)。再也没有什么右对齐了，气泡绝迹。依靠 **区块类型上的不对称以及采用文档级的排版方式 (type asymmetry and document typography)**，不仅杀死了“聊天味儿”，还无需通过搬弄学习者遣词造句的位置。
- **教师的回复自然地织进了文档内容中 (The teacher's reply is woven document content)。** 当遇到一段连发多问的插话时，就会引出一段 **问答插曲 (Q&A interlude)**：教师会挨个把这些片段引出来，然后在下面用正文风格作答（大模型生来就擅长这种“先引用再回答 (quote-then-answer)” 的活计 — 保证了上下文，也用不着挪动学习者的话）。点击发送动作会得到结构上的响应回报：树结构可能有了肉眼可见的更新（加入了绕道路线节点），接着这段问答插曲就把自己给写下来了。
- **锚定功能通过带超链接的叠加层活了下来，而不是靠挪位置 (Anchoring survives as a link overlay, never a relocation)。** 当一句提问摆明了是指着早前某段内容去的时候，就会有一条深度链接被贴上去（而且在被引用的这段内容那儿也会被打上一个反向链接回溯：“在此处被提问 questioned here ↩”）。边上的侧栏往后就可以借助这种计算而得出的 **视图 (view)** 来 *展示* “挂在这颗节点下的疑问们” — 它成了个观察镜头，而非真的在那里做物理存储。不再有东拼西凑；时间轴严丝合缝；那留作复习辅导作用的好处也顺理成章地当做副产品给保下来了。

### 结构上的特性认同 — 凭什么说会话不是聊天 (构思阶段, 2026-08-22) (Structural identity — how a session differs from a chat (ideation, 2026-08-22))

一个聊天室通常包含两种类型的气泡框，说完就忘，没有任何状态管理。但是利用这个媒介我们能做到以下改变 — 根据优先级从高到低排序：

1. **所有的转录记录被重构为一整份课程文档 (The transcript becomes the lesson document)。** 它绝非一份打平的消息清单 — 而是 **由各个树节点划分好的章节 (sectioned by tree node)**，并且是正在实时刻写中的文档：每个章节开头就顶着那个节点名，还附带可折叠功能，你当前读到的这段还会给高亮标记出来。你创造出来的成果其实是本动态生成的教科书的一章内容，根本不是什么聊天日志。顺着这棵树往下走就是在翻阅这篇文档。*(这算是和采用像聊天一样的 UX 最决裂的一点了。)*
2. **循序渐进的解锁机制 (Gated progression)。** 各项考查题目它就相当于一道道关卡，这可不是在聊天：你只有拿出你真弄懂了的能耐，这棵树才会让你往前走 — 眼看着节点被彻底打通点亮，接下来的内容才会给你解锁；你要是到了分岔口，那 **接下来就该由学习者来挑选该走哪条道了 (the learner chooses the branch)** (“前面摆了两条道 — 挑一条吧”)。看看 ChatGPT，它可从来不会在半道上设卡拦你。
3. **引入各具形态且带着截然不同视觉语法类型的区块 (Typed blocks with distinct visual grammar)。** 像讲授区 (Teach) / 测验卡 (check) / 演示器 (demo) / 图解 (diagram) / 学习者大道理区 (learner-reasoning) / 问答场 (Q&A) — 足足六类不仅形态各异而且门面截然不同的功能块，这就是来降维打击聊天室那仅有的两种干瘪气泡的。
4. **会话状态全程露脸 (Session state always visible)。** 顶上细细窄窄永远挂在那的进度条：它告诉你当前处于啥节点、这是啥阶段、到了这会儿这堂课都扯明白啥大道理了、当下这个节点非得先懂点啥。这简直就是防止金鱼脑袋犯失忆症的最强表面。
5. **在开启每段会话之前都必须先来一段知识回溯提取 (Sessions open with retrieval)。** 从事件大账本里揪出个花去 60 秒的往日回忆卡 (“想当初，关于某某这档事…”)，非得复习完了才会讲任何新活 — 这就是防忘曲线间隔复习的种子选手了；每次开局总是带着提取练习，坚决对啥也没有的一穷二白开头说不。
6. **这个会话可是为了编译出一本流传千古耐看的作品存在的 (The session compiles to a durable artifact)。** 它会汇成一个可被你反复阅读的课程页面 (各种章节、你当时做的批注、你的小测成绩，还有那些小演示器全在) — 往后图谱上的那些节点最后总有办法给勾回到当初把你教明白的这一章来。聊天室记录写完了基本就进了垃圾堆了；这玩意可是能越用越厚实的一本私人专享私塾读物。
7. **对树的修改全部成为看得到的事件记录 (Tree edits are visible events)。** 只要授课老师觉得中途讲着讲着需要大改结构 (像什么绕开走啦，往深了说啦，剪去枝叶不谈啦)，屏幕上就会有肉眼可见的变化 — 这份一边讲一边在你眼皮底下跟着画跟着变的地图，会无时无刻不在提醒你：哥们，你正在踏上一段征程，这不是在哪跟着帖水楼。

特别声明要竭力避开的东西：搞游戏化那套把戏 (像是什么打经验分 XP、打卡几连庄、撒花礼炮之类的)。我们要搭的是认知系统 (epistemic)，可不想干斯金纳箱 (Skinnerian) 训鸽子那套。

### 长驻可视的树状视图 (决定) (Persistent tree view (DECIDED))

- **藏于会话 UI 右侧可收缩自如的面板中 (Right-side collapsible panel)**：整棵大树、不管什么时候，你都能看到在各个节点状态之间那清清楚楚的分野 (是干掉的 done / 正在搞的 current / 下面一步的 next / 还是等着大后天的 upcoming)，只要你乐意甚至能缩成一线长条。
- 该面板同那些供智能体把玩的各类工具共享同一份老底子数据源 — 就是一棵具有两张面孔 (智能体在台后挥刀乱改，而 UI 在台前全盘端出给观众) 的神仙大树对象 (object) 罢了。

---

## 2.5 子智能体架构 (2026-08-22 决定) (Sub-agent architecture (DECIDED 2026-08-22))

给教师分配到的上下文窗口以及它那宝贵的专注力都是极金贵的 — 人家有大课要推，还有手里捏着的一大把整大树工具得随时准备着招呼。**凡是那些像机器般死板的，吃代币极多的，跟花大把时间的零碎杂活，通通被甩锅外包给了藏在幕后的那批子智能体 (outsourced to background sub-agents)。** 这家店定下的几条规矩是：

- **一律玩异步流，没得商量 (Async, always)。** 那帮子智能体全部在幕后憋大招，绝对不能因为干这活跑来把主课给阻塞停了。而在前端 UI 界面上会挂起一系列活生生的 **活动指示器 (activity indicators)** — 这些状态条光管播报这正在跑的智能体眼下在憋什么屁 (它正在使的工具还有它的参数)，别指望能看到它那边发生的全套戏码。这帮无头骑士 (Headless workers) 唯一跟家里通讯的方式就是通过个状态信道而已。
- **子智能体必须反复核验；从来都不允许赌一把过的事 (Sub-agents verify; they never one-shot)。** 也就是因为这帮家伙能干出这等绝活，把活甩给他们才配得上说是件明智之举：
  - **演示构建器 (Demo-builder)** — 负责去搭建一些带互动的演示小物件 (在 §2 章节讲的那些人工制品)，且 **绝不是交差就算了，非得先把这些代码拉去过一遍水看看究竟能不能跑起来 (tests that the code actually runs)** (无头运行模式) 确定全须全尾后才敢往会话的主舞台面上摆。凡是这种搞演示的，没人敢凭空只蒙一把直接生上的 (No demo is one-shotted live)。
  - **视觉制作者 (Visual-maker)** (主抓 SVG 等各类高精度画图) — 负责渲染，然后还得 **自己死死盯一眼跑出来的那个效果 (looks at the result)**，然后循环往复改到完美为止。这可是个照搬全抄自早年金库 (vault) 测试版上跑通的 `svg-maker` 智能体代码的手法 (`.pi/agents/svg-maker.md` 里的那套招数：`write_svg` / `edit_svg` / `render_svg` + 再加上最最要紧的那条死理 — 必须给我死盯着看是否真改对了)。
  - **至于搞 Mermaid 那玩意就不劳烦啥子智能体了 (Mermaid needs no sub-agent)** — 因为那位上大课的教师顺手就能在字里行间用 mermaid 顺带着画了；那帮大语言模型简直生下来就会玩这个，退一万步说，它要是哪画崩了这在页面上一眼不就看穿了吗。
- **研究员 (专门去刨根问底核查事实的) (Researcher (fact verification))** — 这是专为上课的教师准备去查证事实及资讯用的工具。这就是另一个满脑子只装着 `web_search` + `web_fetch` 循环转圈圈的智能体罢了。同样直接照搬过去两款久经沙场的老部件：pi 用来在网上倒腾的 `web-search` / `web-fetch` 扩展插件 (`~/.pi/agent/extensions/`)，以及当年那套教研究员如何做人的长篇说教系统提示语 (`~/.pi/agent/extensions/interactive-subagents/agents/researcher.md`：告诉它要学会把议题切碎 → 从多个各种稀奇古怪的角度发炮猛查 → 直接顺藤摸瓜去抓最顶级的原始信源回来 → 随后自己动手丰衣足食融合成一份能顶天立地且信源十足的简报呈递上来)。
- **到底代码长什么样 (基于 Next.js) (Implementation shape (Next.js)):** 在服务器那头开足马力跑着一堆后台智能体循环，产生的那些状态动静则通通顺着流式通道传向客户端上的指示器；干出来的活则全部变成工具所能输出给上课教师的结果 (包含实体制品 + 外加摘要小结报告)，彻底将那搜索与渲染过程中产生的残渣剩饭拦在了上课教师的视线 (上下文) 之外。

---

## 3. 呈现层 (记录在案，还没排上号) (Presentation layer (noted, not yet scheduled))

**现有的处理数学公式的契约规矩 (2026-10-12) (Current math authoring contract (2026-10-12)):** 行内统一用 `$...$`，如果是独占成行的展示用大公式统一用 `$$...$$`。这条规矩已经替代了下面原来规定把单美元符号彻底锁死留给造钱用 (currency-only dollar rule) 的主意了；因为写对反斜杠作界定符的代码毕竟还是能顺畅阅读的。至于那套老一套带修补 JSON 里逃逸破损代码功能的补丁现在也能认出这套新的界定符了，它当年设下的那一套救灾原则啥都没变。那些要求增加各类用例样本、做做公式合规性校验、防止过度转义的再维修工具、甚至包括全盘改变传输链路架构的设想统统先延后处理 (deferred)。下述最初立在 W3 波段的各项决断也因此成了具有历史参考价值的文档。

- **LaTeX 界定符：向 ChatGPT 老大看齐 (LaTeX delimiters: switch to the ChatGPT convention)。** 也就是说行内公式改用 `\(...\)`，展示用大公式改用 `\[...\]`。至于曾经单干的单美元符 `$` 则彻底从数学组领了退休金退居二线全职专干给钱当记号的闲差了 (彻底终结了那万恶的美元符号大惨案了，这回不论是发给教师还是日后开放给用户全用这规矩)。能落地干出来的路子是：得有个先把 `\(...\)`/`\[...\]` 的部分掏出来预处理一下的流程 → 转变成给 remark-math 用着舒服的形态 (要么专开一个由 micromark 打包好的专用插件)，顺便再把发给模型的系统大纲底子全给翻新一遍。随着这一出台，当年靠 `$`/`$$` 吃饭的老规矩便只能死在这上面了。
- **万恶的断行消失 Bug (Line breaks bug):** 在那套教材课文排版上活生生搞丢了单一回车换行符号的显示效果 (这事是因为 markdown 为了自己顺其自然的狗屁语义而全给碾平的缘故 — 估计把 `remark-breaks` 上去，或者去提示语大纲里逼着加空白空行的严规死令方能见效；需实地排查修理完毕)。
- **讲课教案内容的装潢粉刷作业 (Lesson-content formatting):** 就是把教的那些玩意搞得更花哨点，上上结构架子装装样子 (带点醒目的大标题、呼号挂件、还要来点实操范例啥的) — 知道该往这头去，至于咋折腾还没想好。
- **挂起暂定 (不知道猴年马月的事) (PARKED (long-term)):** 就为了让学习者发几道数学题好看，搞一套极其粗糙的带有实时预览功效的 LaTeX 编辑大框放到他面前。

---

## 4. 长征大局观 (依序按依赖挂果) (Roadmap (dependency-ordered))

1. **计划树那些干货工具 + 会话大盘管账状态机制 (Plan-tree tools + session state)** — 那一整套全是讲究条条框框带强力约束的工具，计划大树落实在聊天储蓄罐的持久化方案，把 `set_current` 这把追寻进度的梭子给放出来。(后面所有的大大小小的玩意全靠这个续命。) **✅ 第 1 波段 (W1): 8 个经由纯正的 DAG 进行验证过的铁血工具，外加搞定提示大纲拼凑块，而且还在活生生跑着的大盘上见过了真容 (在一个真正的会话对局里，当众耍了一把 plan_init + set_current 的活计)。**
2. **赤膊上阵版的骨架大图谱 + 主页看大盘 (Bare-bones global graph + home view)** — 将各种打树用工具所吐出来的结晶一路直通喷向那装着大图谱的底仓之中，采用傻瓜式大杂烩无脑并集拼接打法 (naive-union merge)，随后叫来那位只懂得轻装上阵的廉价渲染工把图谱的主页盘口给拉起来。*说白了这叫一个“随便你怎么只扯了几句课本，也能生搬硬套点图表让你看个响”的阶段性大跃进节点。* **✅ 第 2 波段 (W4): 那个只进不退的 JSONL 流水账本，就算来回折腾它也能保持绝不犯二幂等输出法，一套由 sigma.js + forceAtlas2 扛大梁打底凑出来的主页视图看图器，顺带靠着名为 foldStaleChats 的清理神教收拢旧山河。实弹冒烟演习 (Live-verified) 顺利拿下。**
3. **彻底分清楚各阶段的边界 (Phase separation)** — 插上 探测/教学 的大号红绿灯，给转录的文稿拉起斑马线分界限，然后把处于处于传道授业时的考核暗桩们通通盖上小折板藏起来。 **✅ 第 2 波段 (W5): 一抓住了这首个出笼的 plan_init 操作立马就能生生推出阶段走向，拉起带刺的 "教学进行时 (Teaching) · 算上了 N 个节点" 封路障，还竖了个客气邀请你敢不敢答的横条 + 后面藏了个一点才崩开答案的按钮。实弹验证无错 (Live-verified)。**
4. **长驻右路的大树视图 (Right-panel tree view)** — 死了都不离视线，还附带个高亮小灯只为那身在何方的当下时刻 (current) 而留。 **✅ 第 3 波段 (W7): 按大自然造化的拓扑顺序 (topo order) 排序，干掉的/干着的/等下搞的/将来总得弄的 (done/current/next/upcoming) 各显神通，外带能播报打怪进程的大字报头，哪怕是一折腾全收起来缩成条长蛇棍也能靠 localStorage 全存在底裤兜里不怕跑丢。全部在活场子里玩转了 (Live-verified)。**
5. **在暗地里狂跑的归拢大典 → 解除全束缚式的自由式萃取提炼流水作业大阵 (Background consolidation → free-form extraction pipeline)** — 那套什么负责收纳各种主张、去核定权重、全凭着瞎打的文字链。 **◐ 第 3 波段 (W8，Lite低配缩水版) 发射了凭着百分百文字相符和对别名的瞎撞运气式的合并法，外带了把整个图谱全给插进背景里去的猛药。但此路在 (2026-09-02) 已被新法子当场轰毙彻底抛弃：现在这一整条管线摇身全变成一种能无视所有条条框框之事后随意发挥瞎提取大仙 (变成了：提取神 (只能看场内局) → 转手交给审计局长手握查遍了全天下的权力定真伪 → 最后机械式大合并) 的套路，它现在成了瞎眼的瞎子什么大树结构全都靠边，能死死扣在到底是谁在哪说的每一个细节，也没有什么表示课上完大印 (taught events) 了，全都是按着一条一条的定理命题给你硬贴这到底听懂没有的一排注脚标签。关于实现 §1 里定下的哲学大理那可都是下面要下锅的极简料理篇了。**
6. **搞个耍猴的微雕绝活 (Demo capability)** — 弄那个用来跑交互演示小部件的契约 (`demo` artifact contract) (套在沙箱里的 iframe 围栏里，还能弄个自己犯错自己兜底修正循环)，并配上一个能在上菜前敢于自己先吞肚子里试毒的代码检验子智能体大厨 (**demo-builder sub-agent**) (见 §2.5)。这简直是极其出活的项目；只要熬过了第 1 步，随便抽个时候就能见缝插针塞进去。 **✅ 第 2 波段 (W6): 啥演示与造图小把戏统统全上，验证构建那些玩意儿的试毒太保也已到岗 (由无头幽灵版 Chrome 打底)，上得了沙箱安全屋保护卡槽，也玩得转 SVG 大片场卡片。全程真刀真枪演习过关 (视觉识别必须挂上一头懂得长眼睛看世界的视力级超大模 LH_VISUAL_MODEL 加持护法)。**
6b. **研究员大发神威 (Researcher tool)** — 为任课老师下配一个用于打探核查天下百事的锦衣卫工具 (见 §2.5)；这活直接原封不动套当年 pi 里玩通关的一堆破铜烂铁件就能搞定。 **✅ 第 1 波段 (W2): 这套能不卡人主轴独自放单飞的异步协议大旗竖起来了，现场还直接升起一面活动大招牌，那套有着根有底有考究的出巡简报送上，授课先生依旧闲庭信步接茬就讲。现场跑着完全过关 (Live-verified)。**
7. **门面装饰活抢险小分队 (Presentation fixes)** — 跟 LaTeX 分家隔离，解决文字不换行的憋屈破事，外加上搞定 mermaid 画图版。 **✅ 第 1 波段 (W3): 在那套 \(…\)/\[…\] 死规矩前 (那位 $ 老爷子从今往后一辈子都得跟铜臭味锁死在一块了)，引进了 remark-breaks 神器助阵，搞上了深色暗花纹版的 mermaid 外带上流高品味的流格式流云流水般的边框大包围 (styled streamdown chrome)。全场冒烟通过 (Live-verified)。**
8. **凭啥让你觉得这跟别处聊天不是一码事 (候选功能海选池) (Structural-identity candidates)** (来自 §2 那顿异想天开，等着翻牌子)：被拆成一道道段落章节编好的讲义版转录文书本，全靠过关才能往下走，用上排版精良样式不一的内容专区块，还要有个始终扒在脸上告诉你当前啥状况的状态条。
9. **至于后面的陈年旧账 (Later):** 什么跟 Deepgram 讨通关信物、凭 AudioWorklet 自己扯开嗓子录的听写发声 (dictation) 大阵啦，往这版图疆域外无脑硬扩领土瞎打听往哪继续钻 (针对没碰过的新天地 / 去大修旧知识 / 打转思路换着玩) 啦，靠着过往事件的流水账把抗遗忘重复做题的大招拿出来啦，练习实操作业大礼包啦，把身子整个变成用 Electron 搭的铁皮壳啦等等等等。

---

## 5. 公开挂着等回音的悬案大盘点 (Open questions)

1. ~~用来给画图铺底和规划坐标这活谁干 (Graph rendering library + layout architecture)~~ — **2026-08-22 一锤定音: sigma.js + forceatlas2，按上个按钮它去排坐标画完了就直接成标本死在那 (run-then-freeze)** (详见 §1)。剩下的这摊子烂账：就是得在它落地生根前非得先往它身上塞足 2 千个孤立点先拉起来溜溜看它抗不扛得住 (synthetic benchmark)。
2. ~~那些横跨多场对谈的雷同重复命题咋整 (Overlapping topics across sessions)~~ — 靠着 2026-09-02 定下的世界模型给活活劈开生解了：所谓的是不是同一个人这都是那位有无上权力的审计总督干的买卖 (判下究竟算是同一种说辞全塞一块作别名、还是新建山头)；有点分不清瞎撞一块的重名咱们容忍有错慢慢修 (duplicates are acceptable-and-correctable)，可要是胡乱乱配错的烂鸳鸯是坚决不能留的 (wrong merges are not)。
3. ~~假如面前一棵大树还连个苗子都没有这题咋往下问 (Probe questions when no tree exists yet)~~ — 这题在把提取工艺完全从套子里解放出来 (free-form extraction) 时就自行解了：这些出题算账这门营生全靠把过往的对话翻出底库重头来捋 (这是提取器的职权范围、由审计长拍板)，压根就不指望跟那棵啥用没有的大树存在半点儿血脉牵连。
4. 在 V1 版本里的主页大图谱，在这平移/缩放把戏之外它还能带人玩点啥 (哪怕是点中个圆疙瘩 → 它是不是能领着人滚到当初这帮祖宗开会的现场呢？ — 想必这是一顿不吃粮草能水到渠成白拿的大餐)。
5. 关于那群在颗粒度上能玩点涵盖大包大揽 (像什么包含 `subsumes` 这种做老子儿子的把戏) 到底是多久出现一回的问题 — 全凭最初的红头文件规定，这得等着看真正的账本底料吐出来的数据去定，绝对不能还没谱就瞎去把答案画死在那。
6. 对于能把大伙对知识的领会深浅 (understanding) 全部兜拢捏成一团算出个啥分来 (求低保 / 求全场平均分 / 分层开课) — 得全按实际真料喂饱之后，再对照原来立下的那个祖宗原旨。
7. 给那些聚集群在模样上描红画绿的细碎活 (Cluster visual details) — 那包裹轮廓究竟是拿尺子绷着的线条 (convex) 还是弄得像一堆有机水母囊一样 (organic hull)，这上面的字怎么贴怎么摆好看，用啥颜料给这涂色 — 全等这些货到了验试看各种花花绿绿的大色块斑 (real blobs) 时的相马大会上再拍板定案 (见 §1 聚类；理论在 2026-09-13 已经定调)。
8. 这个能被称为聚集抱团成块的起步人口数 (~3) 设在哪道门槛上 — 这活得靠在那些合成出来演练用的沙盘，外加真实的干货上好好拨拨算盘才能知道 (见 §1 聚类)。

---

## 致那尘封在保险柜里 (2025-08-20 出品) 原旨大纲的各项纠错修订案大汇编 — 长话短说篇 (Amendments to the vault design doc (2025-08-20) — summary)

| 原来的那些痴梦 (Original) | 醒了以后的事实 (Now) |
|---|---|
| 老师绝不敢修改这棵树半分；图谱全指着事后孔明来修楼 | 又是重新走回了事后算账老路 (2026-09-02 定夺)：随性不拘一格搞大萃取，这这流程和当初死死框着的上课框架彻底解了绑 — 而早前 2026-08-22 想着把现炒现卖全盘端上桌的这门倒霉的主意它自个儿反倒先被连根拔起了。 |
| 那些各种瞎迷信和错误的死点能当个祖宗供在牌坊上立成一大分类 (Misconception nodes) | 连分类 `kind` 这种玩意全没了：它里头每一条好汉个个都得是一条实打实的大真理 (true proposition)；那帮搞迷信犯错来的也得经过打脸被纠成真理才能被请进去，真真正正关于犯浑走火入魔的全账全死死被关在那本名为事件过错记录簿的铁笼里 (event ledger)。 |
| 凡是那些必须扯上先决依赖门槛的线 (`requires`) | 分了 `follows` (派生于) / `supports` (起辅助支撑的) — 这是用能纯生搬硬推 (derivability) 和起个衬托托底 (grounding) 的分界；到底这条线勒得紧不紧完全凭最后翻本子算账 (read time) 生推，谁也别想事先把分数藏在这上面。 |
| 那些贴满了光荣证书宣布老子这堂课已经教过这货的功名牌 (`taught` events) | 彻头彻尾地死绝了；那提取总局的钦差在每次核查完，只靠扔下一本根据针对这个命题该学员听懂几成的口供本 (全是只能从定好的那几句话里抠字的) 权且当作给本次问诊出的一份评估大单。 |
| 让那些对这知识到底是嚼烂了几成的档次全在 (2026-09-08) 给标准成统一度量衡了 | 凡是落笔评这水平的，必须在那封死在这个五字绝杀阵口决 (`扎实 solid`/`摇摇晃晃 shaky`/`认账了 accepted`/`拼死顽抗 resisted`/`还没翻到这面 not yet engaged`) 里挑一个盖戳，必须通过从提取流程时靠大阵死死守着的门规卡住 — 决不允许冒出一个数字，也绝不准罗里吧嗦半点废话；要是智能体非要在屁股后面补上一通为其开罪的原因解释啥的，直接让它全部喂狗 (dropped)。 |
| 一切落点根源都要死抠细化追责到哪一场对话里的那根鸡毛蒜皮上 | 那可是事无巨细把命根子 (chat, message) 全部挂在了所有的节点和每一根红线上的 — 就是为了一锤定音找出当年这罪证到底从哪一句话里扯出来的这个真理。 |
| 在每个节点上头刻着的大名 `name` + 它干了啥的状词 `statement` | 给改成了 `statement` (陈述，也就是一段毫无废话精简到底的大真理，它也充当最终渲染展示给人看的门面) + 再挂上那段洋洋洒洒 `description` (要求还得给细细道来) + 外面外加各种绰号黑话 `aliases` (当初在这上头扯的所有大白话全字不漏全记录在此) |
| 再后来那挂着的 `statement` + `description` 的二人转在 (2026-09-02) 也被改朝换代了 | 成了由 `name` (这就一行短得不能再短的简称暗号，就为了在图上不显臃肿的抓手) + 它的正主 `statement` (必须毫无瑕疵极为精准、定死它到底是啥身份的定海神针，就藏在它详细户口本里) 两口子过日子；那位 `description` 兄弟因为话太多把这好好的画布糊满了洋洋洒洒的大句子而导致图上脏乱差不堪入目 (这可是在 2026-09-08 亲眼见过了提取出那一摊真货之后做的痛定思痛)，最终落得被彻底满门抄斩除了名的下场。 |
| 以前是每次非得把课上全了才能更一把账 | 如今是时时刻刻在长；就算上厕所拉一半就走，也能把兜里的哪怕一两个钢镚都算成存下的家当。 |
| 那用 Mermaid 画在布上的图曾被当做这天下大计的神主牌 (DAG as the plan artifact) | 如今是各路用严严实实的模具冲压出来验证过的工具 (Structured tools) 才能当作不破真理的大法器；Mermaid 也就配平时拿着逗逗闷子做些乱七八糟草图解解释的破活干干。 |
| UI 那点小事一直全当着压根不在乎的“小事一桩 (not important)” | 这会 UI 可算是威风八面占足了排场地活现起来了 (全上了 Next.js, v3.4 大阵)；而且那位图谱看大图的老神仙早把这应用的前大门脸也就是主页面给死死霸占了。 |
| 把 pi 老大当成命根子一般的顶梁大柱 (core dependency) | 活生生把 pi 连根拔除了；现在的重坦是用独立拆分的 Next.js 铁底盘 + Vercel 大厂的 AI SDK 重装系统联手撑起来的。 |