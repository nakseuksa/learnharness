# 第 06 卷：显式阶段状态机与会话计划树 DAG（phases · plan-tree · plan-blocks）

> **负责源码**（合计 419 行，已逐行精读，零遗漏）：
>
> | 文件 | 行数 | 职责一句话 |
> |---|---|---|
> | `src/core/phases.ts` | 192 | 阶段 = 对持久化记录的纯事件折叠：`probe` → `plan` → `teach`，双投影各一套折叠 |
> | `src/core/plan-tree.ts` | 132 | 计划树的纯校验构造：DAG 不变量 + 面向 agent 的错误消息，唯一生产入口 `createTree` |
> | `src/core/plan-blocks.ts` | 95 | 计划块的发射缝：回合收尾时幂等地为最后一次成功 `plan_init` 生成冻结快照 marker |
>
> **取证方法**：三个文件全文 `read`；全部导出符号的调用点用 `rg` 在 `src/agent/tools/plan.ts`、`src/agent/tools/mermaid-plan.ts`、`src/server/turn-service.ts`、`src/core/view.ts`、`components/`、`scripts/sandtable/board.ts` 及全仓检索核实。所有 `path:line` 均为 rg/read 实测。术语一律遵循 `学习文档/glossary.md`（阶段＝词条 32，计划树／计划块＝46，计划位置＝47，probe_done＝33，折叠计算＝44，标记消息＝42，原生记录＝43，投影＝9，持久化＝2，回合收尾＝20，桶导出＝86，导入法则＝89，所有者裁定＝93，wave＝92，出题机制＝37，揭示(reveal)＝81）。

---

## 本卷导读

### 0.1 教学会话的宏观骨架

一个教学会话（`kind` 缺省即 teach，`src/core/contracts/chat.ts:36-37`）在宏观上只有三个**阶段**（词条 32）：

```
probe（探测者）──probe_done 干净收尾──▶ plan（教师）──首个带 nodeId 的提问调用──▶ teach（教师）
```

- **probe**：探测者（词条 29）用评分 quiz 沿每条知识 strand 夹逼学习者的边缘（下限／上限／边缘，词条 41），以 `probe_done`（词条 33）交接——评估内容就骑在调用的 input 里，随 SSE 事件流（词条 1）实时流给学习者，并由 toolResult 本身落进持久化（词条 2）。
- **plan**：教师（词条 30）接管。注意 **agent 切换发生在 probe→plan 这条缝**：记录里一旦出现干净收尾的 `probe_done`，组合根就构造教师 agent（`docs/probe-teach-split.md` §1）；规划需要完整的教学知识，所以教师从规划期就开始跑。plan→teach **不换 agent**，只换阶段标签与 UI 行为。
- **teach**：教师逐节点教学。每道 quiz/explain 都带 `nodeId`——**计划位置**（词条 47）：「这道题是关于这个节点的」，是位置信号，**绝非完成信号**。

关键设计：**阶段不是存储字段**。`ChatRecord`（`src/core/contracts/chat.ts:30`）里没有 phase；会话选择器看到的 `ChatSummary.phase`（`contracts/chat.ts:268`）是 store 在 `listChats` 里用 `phaseAt3Lh` 现算的（`src/store/chats.ts:108`）；客户端的分隔线与答题 dock 用的是 `phaseTimeline`/`phaseAt3` 现算的视图折叠（`components/chat.tsx:518`、`:558`）。唯一真相是持久化记录里的事件序列，阶段是它的**纯折叠计算**（词条 44）——因此阶段永远不会「卡住」，也永远不需要迁移。

### 0.2 两次废弃：占用推断与计划接受确认门

**废弃一：`currentNodeId` 占用推断（stuck-on-plan bug）。** 早期的 `phaseOfTree` 读树里的 `currentNodeId` 来推断「当前占用哪个节点 → 处于哪个阶段」。但 author-once 协议（2026-09-03）规定教师**只写地图、从不跟踪进度**——没有任何代码会设置 `currentNodeId`，于是阶段在结构上永远逃不出 plan。2026-09-11 的用户测试轮（Nietzsche + Lacan 会话，minimal-effort GLM）集中暴露了三件事（`docs/probe-teach-split.md` 末尾 Diagnosis context）：

1. 教师从不给 quiz 打 `nodeId`——两个会话的所有题全是 untagged，任何派生都无从发生；
2. 阶段系统结构性卡在 plan（`phaseOfTree` 读一个没人设置的字段）；
3. 若按「答对即 done」的结果派生，一次通过的检验就会虚假地「完成」一个节点。

裁定是**替换而非修补**：`currentNodeId`/`doneNodeIds` 从树里删除（`src/core/contracts/plan.ts:35-40` 的 NOTE），树只承载结构；阶段改为显式事件折叠；位置改为从 tagged 调用派生（`derivePlanStatuses`，`contracts/plan.ts:82`）。无任何向后兼容——旧会话是待清除的数据（`phases.ts:24-26`；`docs/probe-teach-split.md` §8）。

**废弃二：计划接受确认门（verdict gate）。** accept-plan UI 于 2026-09-11 落地，又于 2026-09-26 被所有者裁定移除（注释原文 "the verdict death"，`phases.ts:4-5`、`:16-22`；`docs/probe-teach-split.md` §4、§7）。新语义：

- **呈现计划即结束教师回合**（question_stopper 教义，词条 34）；
- 学习者的下一条消息是**自然回复**——要么是修改请求（教师重写、再呈现、再结束回合），要么是放行信号；
- 不存在任何显式「接受」事件，verdict-marker 折叠一并删除。

于是 plan→teach 这条缝只能**推断**：**首个带 `nodeId` 的 quiz/explain 调用**就是教学开始的地方。代价由所有者接受：**实时阶段指示器故意滞后**——「teach」要等第一道节点题真正问出来才显示（`phases.ts:18-19`）。中途 `plan_init` 重写则完全不需要门。

**为什么推断是可靠的（结构性而非提示词性）**：`nodeId` 在 teach quiz/explain 的 schema 里是 **required**（所有者裁定 2026-09-26；`src/agent/tools.ts:157-158`、`:190-191`），而探测者的 quiz 是**同名不同 schema** 的另一个工具声明，**根本没有 `nodeId` 字段**（`tools.ts:36-37`、`:208`；probe 的自由回忆变体 recall 同样无 nodeId，`:241-242`）。所以：探测题不可能误触发 teach；「从不打 tag 的教师」在结构上不可能存在——untagged 调用在边界就被拒回重试（返回 agent 教义）。缝信号是结构保证的，不是靠提示词恳求来的（`phases.ts:20-22`）。

### 0.3 纯事件折叠：两条缝的精确语义

| 缝 | 触发事件 | 语义要点 |
|---|---|---|
| probe→plan | `probe_done` 调用**干净收尾**（clean toolResult） | 要的是**收尾权威**：失败/中止生成里的调用不算数； mere 调用（还没结果）不算数；显式拒绝 `ok:false` 不算数 |
| plan→teach | 首个 input/arguments 带非空字符串 `nodeId` 的 `quiz`/`explain` **调用** | 要的是**发生事实**：**CALL 即缝，不是它的回答**——出错后被重试的调用照样证明教学已开始，悬空调用照样算（`phases.ts:79-82`） |

两条缝都**严格顺序、只进不退**：probe 阶段里出现的 tagged 提问不会翻转（还没到 plan）；teach 之后再出现的 `probe_done` 结果不会回退。quiz 与 explain 双机制都认（出题机制，词条 37；所有者 2026-09-27，`phases.ts:89-90`）。

同一套事件有**两套折叠**（Wave D，`phases.ts:28-34`）：

- **视图折叠**：`phaseAt3`/`phaseTimeline`（内部步进 `advance`）读 `PhaseMessage`——UI 消息的 part 形状（`type`/`state`/`input`/`output`），供客户端分隔线、header chip、答题 dock 用；
- **原生折叠**：`phaseAt3Lh` 读 `LhMessage[]` 原生记录（词条 43）——probe→plan 推进在 `probe_done` 的 **RESULT 消息**处，plan→teach 推进在携带首个 tagged 提问 **CALL** 的 assistant 消息处，供 server 摘要与测试用。

两套推导在**任何已收尾记录上结论一致**（调用的 part 与其结果投影进同一个视图边界，`phases.ts:33-34`）。

### 0.4 PlanTree 与 plan-block：结构版本 vs 冻结快照

这是本卷最重要的职责分离，三个「计划呈现面」各管一摊：

| 呈现面 | 数据源 | 时效 | 锚点 |
|---|---|---|---|
| **计划树**（词条 46）`record.tree` | `plan_init` 经 `createTree` 校验后 `saveTree` 整树替换 | **可变结构版本**：重写即 wholesale 替换；只有结构（nodes/edges/version），**无任何进度字段** | `contracts/chat.ts:39`；`src/store/chats.ts:199-206` |
| **计划块**（词条 46）plan-block marker | 回合收尾时 `planBlocksFor` 发射的 `PlanBlockData` | **流内冻结呈现快照**：状态在发射瞬间定格，渲染时**永不重派生** | `src/core/plan-blocks.ts`；`native-messages.ts:242-255` |
| 计划弹窗 + 持久 DAG 窗口 | `latestTree`（最近一次成功 plan 工具输出）+ `derivePlanStatuses` 现算 | **实时派生**：位置随 tagged 调用移动 | `components/plan-block.tsx:716`、`:751-756`；`components/plan-window.tsx:40`、`:46` |

- 计划块是**呈现时刻**（presentation moment）：计划在流内渲染一次，就在携带成功 `plan_init` 调用的 assistant 组之后，兼作弹窗的流内入口。快照上的状态在那一瞬间是准确的——首次作者期 `current = null`、全部 upcoming；**除非是课中重写**，那快照就忠实显示「当时」的位置（`plan-blocks.ts:5-9`）。
- Wave B（所有者批准 2026-09-26）把计划块从 UIMessage 时代的 attach 改为**原生 plan-block 标记消息**（词条 42）：回合收尾时追加、按 `plan_init` 调用 id 幂等；投影再把它的 data part **拼回流内**原位（`plan-blocks.ts:11-15`；`src/core/view.ts:478-488`）。存储位置（记录尾部）≠ 呈现位置（流内）——位置在投影时从记录派生。
- neighborhood-block（冻结邻域碎片）机制已退役：快照表达不了实时派生的移动；其继任者是持久 DAG 窗口（`docs/probe-teach-split.md` §6）。
- 计划块**没有模型面**：`toLlmMessages` 过滤它（`native-messages.ts:239-241` 注释），模型永远看不到这块 UI 历史——这是双投影矩阵（词条 9）的又一个实例。

### 0.5 三文件血缘与全卷函数清单

一次计划作者期的完整调用链（每步的出处见对应小节）：

```
教师发出 plan_init(mermaid 文本)
  → parseMermaidPlan 解析（src/agent/tools/mermaid-plan.ts，产出 PlanNode[]/PlanEdge[]）
  → createTree 校验结构（src/core/plan-tree.ts:112；失败抛 PlanTreeError）
  → chatStore.saveTree 整树落盘（src/agent/tools/plan.ts:90）
  → 成功结果 details = { ok:true, tree }（plan.ts:101；content 只带 nodeIds+提醒，上下文节食）
  → 回合收尾 persistTurn（src/server/turn-service.ts:59）
      → planBlocksFor(record.messages, stamped, tree, 全量记录)（turn-service.ts:83-86）
          → emittedPlanBlockCalls 幂等集 → snapshot 冻结状态 → newPlanBlockMessage
      → saveMessages([...record, ...stamped, ...blocks])（turn-service.ts:87）
  → projectView 把 marker 拼回 assistant 组内 plan_init part 之后（view.ts:478-488）
  → chat.tsx 渲染冻结 PlanBlock（:1577-1585）；弹窗/窗口另行实时派生
```

阶段折叠则贯穿另一条消费链：`phaseAt3Lh` → 会话选择器摘要（`store/chats.ts:108`）与沙盘（`scripts/sandtable/board.ts:207`）；`phaseTimeline`/`phaseAt3`/`teachStepIndex` → header chip、流内分隔线、答题 dock 的揭示(reveal)与思考字段尺度（`components/chat.tsx`）。

全卷函数清单（18 个函数级实体 + 3 个类型 + 1 个错误类；「五要素」＝①签名/行号/纯度 ②输入输出与不变量 ③逻辑分支逐步推导 ④边界与历史事故 ⑤真实上游调用方）：

| 文件 | 五要素精讲 | 归并表 |
|---|---|---|
| phases.ts | `taggedNodeId`、`phaseAt3`、`advance`、`teachStepIndex`、`phaseTimeline`、`phaseAt3Lh`（6） | 无轻量私有辅助（全覆盖表见 1.4） |
| plan-tree.ts | `PlanTreeError`（类）、`emptyTree`、`nodeMap`、`createsCycle`、`assertValidEdge`、`createTree`（6） | `assertValidNode`、`requireNode`、`edgeKey`（死代码）（3） |
| plan-blocks.ts | `snapshot`、`emittedPlanBlockCalls`、`planBlocksFor`（3） | 无（全覆盖表见 3.4） |

---

## 1. src/core/phases.ts（192 行）

### 1.1 模块定位与纯度边界

- **桶导出**（词条 86）：`src/core/index.ts:39` `export * from "./phases.ts"`。按导入法则（词条 89，`eslint.config.mjs:7-18`），`components/**` 只能经 `@/src/core` 桶拿它——`chat.tsx:81-83` 正是从桶 import `phaseAt3`/`phaseTimeline`/`teachStepIndex`，`phase-divider.tsx:1` 与 `question-dock.tsx:40` 从桶拿 `Phase3` 类型。server 侧（`store/chats.ts:19`）与 scripts（`board.ts:24`，scripts 不受导入法则约束）直接路径 import。
- **100% 纯函数**：无 IO、无 mutation、完全确定（同输入必同输出）。唯一运行时依赖是文件**中部**的 `import { probeDoneResultIds, type LhMessage } from "./native-messages.ts"`（`:159`）——这是有意的分节缝：157 行的分节注释把文件劈成「视图折叠」与「原生折叠」两半，import 跟着它服务的半区走。`native-messages.ts` 是浏览器安全 core，所以整个模块在 server、client、tests 三处都安全（头注释 `:36`）。
- **头注释（1-37 行）是设计史浓缩**，逐段对应：显式事件绝非占用（2-5）；三相位定义与「CALL 即缝」（7-14）；verdict gate 已死、指示器故意滞后（16-19）；nodeId schema-required 的结构性保证（20-22）；占用推断与 verdict 折叠已删、无向后兼容（24-26）；双折叠及其一致性（28-34）；纯度声明（36）。
- 本模块**不读树**：阶段与 `record.tree` 完全解耦——这正是 stuck-on-plan bug 的根治（树没人写进度字段，阶段就不再依赖树）。

### 1.2 核心数据结构与类型契约

**`Phase3`（39-40 行）**：

```ts
export type Phase3 = "probe" | "plan" | "teach";
```

三个字面量即会话的宏观状态机。消费面：会话选择器（`ChatSummary.phase`，`contracts/chat.ts:268`）、header chip（`PhaseChip`，`phase-divider.tsx:41`，标签 Probing/Planning/Teaching，`:28-32`）、流内分隔线（`PhaseDivider`，`:62`）、答题 dock 的 `phase` prop（`question-dock.tsx:90`，teach 阶段思考字段更高：`:912` `min-h-[4.5rem]` vs `min-h-10`）。

**`PhaseMessage`（42-49 行）**：

```ts
export interface PhaseMessage {
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }>;
}
```

UI 消息的**最小结构切片**：只要「带 type/state/input/output 的 parts」这个形状，不 import 任何视图类型。这是本仓反复使用的 shape-of-shapes 手法（同 `contracts/plan.ts:64` 的 `PartsCarrier`、`plan-block.tsx:711-713` 的 `PopupMessage`）：`LhViewMessage` 结构上可赋值给它，折叠因此与投影实现解耦、可在任何层测试。`input` 是工具调用的已解析参数，`output` 是已收尾调用的结果（即 native toolResult 的 `details`，见 `view.ts:111`）。

**状态机转移表**（`advance` 的两个分支，83-97 行）：

| 现态 | 视图形状触发条件 | 原生形状触发条件（`phaseAt3Lh`） | 次态 |
|---|---|---|---|
| `probe` | part `type === "tool-probe_done"` 且 `state === "output-available"` 且 `output?.ok !== false` | `toolResult` 消息且 `id ∈ probeDoneResultIds(前缀)` | `plan` |
| `plan` | part `type === "tool-quiz" ∥ "tool-explain"` 且 `taggedNodeId(input)`（**不看 state**） | assistant 消息 content 里首个 `toolCall` block，`name === "quiz" ∥ "explain"` 且 `taggedNodeId(arguments)` | `teach` |
| `teach` | 无出边（吸收态） | 同 | `teach` |

### 1.3 全部导出函数与核心内部算法五要素精讲

#### 1.3.1 `taggedNodeId`（53-60 行）[纯函数]

**① 签名与定位**：`function taggedNodeId(input: unknown): boolean`（私有，53 行；doc 51-52）。它是整条 plan→teach 缝的**信号定义**：什么叫「带 tag」。

**② 输入输出与不变量**：输入是任意 unknown（调用参数可能是任何东西——弱模型抖动、流式半截 JSON、null）；输出 boolean。不变量：**当且仅当** input 是对象、非 null、其 `nodeId` 属性是字符串且长度 > 0 时为 true。

**③ 逻辑逐步推导**（54-59 行，四条件合取，短路求值）：

1. `typeof input === "object"`——排除字符串/数字/布尔/undefined；
2. `input !== null`——JS 的 `typeof null === "object"` 陷阱必须显式排掉；
3. `typeof (input as { nodeId?: unknown }).nodeId === "string"`——数字 nodeId、缺失、null 都不算；
4. `(input as { nodeId: string }).nodeId.length > 0`——**空字符串不算 tag**。

**④ 边界与历史背景**：数组也是 object，但没有 `nodeId` 属性 → 第 3 条 false，安全。探测 quiz 的 schema 根本没有 `nodeId` 字段（`tools.ts:36-37`、`:208`），所以探测题在结构上永远 false——这就是头注释「nothing false-triggers」（11-12 行）的实现。历史上 untagged 检查曾普遍存在（2026-09-11 测试轮教师从不打 tag）；所有者裁定 2026-09-26 后 teach 边界 schema-required，但折叠仍防御性拒绝 untagged——旧记录、被拒调用的原始参数（持久化存原始字节，词条 2）都可能缺 tag。注意它**不校验 nodeId 是否在树里**——那是 `derivePlanStatusesLh` 的事（`contracts/plan.ts:141`）；阶段折叠只认「有 tag」这个结构事实，哪怕 tag 指向重写后已删除的 slug，教学也已经开始。

**⑤ 上游调用方**：`advance`（`phases.ts:95`）、`teachStepIndex`（`:129`）、`phaseAt3Lh`（`:182`）——三个折叠/定位函数共用同一个信号定义，保证视图与原生两端口径一致。

#### 1.3.2 `phaseAt3`（63-70 行）[纯函数]

**① 签名与定位**：`export function phaseAt3(messages: readonly PhaseMessage[], upToIndex?: number): Phase3`（doc 62）。视图折叠的**点查询**：前缀 `messages[0..upToIndex]`（**含端点**） fold 完后的阶段。

**② 输入输出与不变量**：输入只读消息数组 + 可选索引；输出三相位之一。不变量：`phaseAt3(m, i) === phaseTimeline(m)[i]`（`phaseTimeline` 的 doc 145 行明文承诺）；空输入恒 `"probe"`。

**③ 逻辑逐步推导**：

1. `let phase: Phase3 = "probe"`（64）——初态；
2. `const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1)`（65）——缺省取最后一条；给值则**钳制到数组上界**（越界索引不报错，读到末尾为止）；
3. `for (let i = 0; i <= last; i++) phase = advance(phase, messages[i]?.parts)`（66-68）——顺序折叠，`?.` 防御稀疏数组；
4. 返回 phase（69）。

**④ 边界与历史背景**：空数组 → `last = -1` → 循环零次 → `"probe"`（tests/phases.test.ts:136 钉住）；负 upToIndex 同样零次循环 → probe。含端点语义容易误读成排他——`upToIndex` 指的是「算到这条消息为止（含它）」。每次调用都从 probe 重扫前缀，单点 O(n)；逐索引调用会平方爆炸，这正是 `phaseTimeline` 存在的理由（141-146 行注释）。无 probe_done 的旧记录读作 probe（tests/phases.test.ts:116）——无向后兼容，旧数据是待清除的垃圾（§0.2）。

**⑤ 上游调用方**：`components/chat.tsx:518`——`requiresReveal = pending !== null && questionNeedsReveal(pending.tool, pending.input, phaseAt3(messages))`。这是揭示(reveal)机制（词条 81）的阶段输入：`question-core.ts:232-235` 规定只有 **teach 阶段**的 quiz/explain **检验题**（非 predict）才折叠在「Check your understanding」按钮后；探测/规划期问题与预测题永远展开。chat.tsx:515-517 的注释给出关键推理：待答问题在记录里不可能先于其阶段的缝（教师回合止于提问调用），所以**会话当前阶段就是该问题的阶段**——点查询取全量末尾即可。测试：tests/phases.test.ts:48、:84、:101、:106、:136、:207。

#### 1.3.3 `advance`（73-100 行）[纯函数 · 核心折叠步进]

**① 签名与定位**：`function advance(phase: Phase3, parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }> | undefined): Phase3`（私有，doc 72「One message's advance of the phase (pure fold step)」）。**一条消息**对阶段的一次推进，是两套视图折叠共用的唯一状态转移实现。

**② 输入输出与不变量**：输入现态 + 该消息的 parts（可 undefined）；输出新态。不变量：**单调**（probe→plan→teach 只进不退）、**顺序敏感**（parts 按数组序扫描，同一消息内可连跳两级）、无副作用。

**③ 逻辑逐步推导**：

1. `if (!parts) return phase`（77）——parts 缺位原样返回（防御 `messages[i]?.parts` 的 undefined）；
2. 顺序遍历每个 part，两个**独立的 if**（不是 else-if）：
   - **分支一（83-88）probe→plan**：`phase === "probe" && part.type === "tool-probe_done" && part.state === "output-available" && (part.output as { ok?: unknown } | null | undefined)?.ok !== false` → `phase = "plan"`。四个条件缺一不可：工具名、**已收尾状态**、非显式拒绝。
   - **分支二（91-97）plan→teach**：`phase === "plan" && (part.type === "tool-quiz" || part.type === "tool-explain") && taggedNodeId(part.input)` → `phase = "teach"`。**没有 state 条件**——调用即缝。
3. 返回 phase（99）。

两个 if 的顺序 + 现态守卫意味着：同一条 assistant 消息里若先有干净收尾的 `probe_done` part、后有 tagged 提问 part，一次 `advance` 就能 probe→plan→teach 连跳（先满足分支一进入 plan，分支二随即在同轮循环里命中）。反过来，tagged 提问在 `probe_done` 之前出现则永不翻转——严格顺序（79-82 行注释「STRICTLY SEQUENTIAL」）。

**④ 边界与历史背景——失败/中止的调用为何不算阶段跃迁**：

- **probe→plan 要收尾权威**：mere 调用（`input-streaming`/`input-available`，还没有结果）不满足 `output-available`，探测保持开放（tests/phases.test.ts:101 钉住）。错误结果投影为 `output-error`（`view.ts:104-108`：`isError` → state `output-error` + errorText），同样不满足；显式拒绝（`details.ok:false`，比如「先解决未决问题」「已经收尾过」，`docs/probe-teach-split.md` §2）被 `ok !== false` 挡下（tests/phases.test.ts:106）。注意 `ok !== false` 的**宽松侧**：缺 ok 字段的旧式干净 ack 仍算数——与原生侧 `probeDoneResultIds` 的口径逐字对齐（`native-messages.ts:758-759`、`:772`）。失败/中止**生成**里的调用在原生侧被 `stopReason === "error" || "aborted"` 显式过滤（`native-messages.ts:765`）；视图侧则靠投影形状兜底——失败生成的调用拿不到干净的 `output-available` part。两端口径在已收尾记录上一致（头注释 33-34）。
- **plan→teach 要发生事实**：注释 79-82 明文——「an errored-and-retried call still proves teaching began, and the retry lands in the same group anyway」。出题校验失败退回模型重试（出题重试，词条 23）时，那个 errored 调用照样把阶段翻到 teach；重试落在同一组，分隔线位置不受影响。悬空调用（还没有结果）同样算。这与 probe 缝的不对称是**有意的语义差**：评估必须干净落地才有权威，而提问只要问出来教学就已开始。
- **双机制**：quiz 或 explain 都认（89-90 行注释）——出题机制（词条 37）是设置开关（`tools.ts:422` `quizMechanics`），explain:true 武装自由回忆并撤掉选择题，两种机制的 teach 工具都带 nodeId（所有者 2026-09-27）。tests/phases.test.ts:207 钉住 explain 缝。
- 自然语言文本、untagged 问题永不启动教学（tests/phases.test.ts:84）——verdict death 之后没有任何「文本接受」能翻转阶段。

**⑤ 上游调用方**：仅模块内——`phaseAt3:67`、`phaseTimeline:151`。私有保证转移逻辑单点存在，两个导出折叠不可能口径漂移。

#### 1.3.4 `teachStepIndex`（115-139 行）[纯函数]

**① 签名与定位**：`export function teachStepIndex(parts: ReadonlyArray<{ type: string; state?: string; input?: unknown }>): number`（doc 102-114）。回答的问题是：**在发生翻转的那条消息内部**，教学从哪个 part 边界开始？返回治理首个 tagged 提问调用的 **step 边界**：`-1` = 调用位于消息第一个 step（分隔线应前置到整条消息之前）；否则 = 包含该调用的那个 `step-start` part 的索引（分隔线渲染在那里，取代该处普通细线）。

**② 输入输出与不变量**：输入一条消息的 parts（注意切片比 `PhaseMessage` 还小——不需要 output）；输出 part 索引或 -1。不变量：只认**首个** tagged quiz/explain 调用；返回值要么 -1 要么某个 `step-start` part 的真实索引。它是**结构定位器**，不读阶段——调用方负责只在翻转消息上使用它。

**③ 逻辑逐步推导**：

1. `let stepStarts = 0`（118，已见 step-start 计数）、`let latest = -1`（119，最近一个 step-start 的索引）；
2. 顺序扫描（120-137）：
   - `part.type === "step-start"` → `stepStarts++`、`latest = i`、`continue`（122-126）；
   - `(part.type === "tool-quiz" || part.type === "tool-explain") && taggedNodeId(part.input)`（127-130）→ **立即返回** `stepStarts <= 1 ? -1 : latest`（135）；
3. 扫完没有 tagged 调用 → 返回 -1（138）。

`stepStarts <= 1` 的推导（131-134 行注释）：pi 的 assistant 消息第一个 provider step 可能带也可能不带 `step-start` part——见过 0 个或 1 个 step-start 都说明调用还在**第一个 step** 里，分隔线属于整条消息之前；见过 ≥2 个则调用在后续 step，`latest` 正是治理它的 step 起点。

**④ 边界与历史事故背景**：本函数是 **stacked-dividers bug** 的修复（所有者 round 8，2026-10-05，doc 103-108）：plan→teach 在首个 tagged 调用处翻转，但**计划呈现经常住在同一条 assistant 消息里**——比提问调用更早的一个 provider step。消息级缝于是把 Teaching 分隔线画到了计划呈现**之前**，Planning 与 Teaching 两条分隔线背靠背叠着、中间什么都没有。修复就是把缝从消息级细化到 step 级。配套事故（`chat.tsx:1485-1487` 注释）：Lacan 会话 2026-09-27——分隔线必须 **PREPEND**（前置追加），曾用替换式三元分支渲染分隔线，结果**吞掉了整个第一教学块**（teach 组是有内容的真消息）。防御边界：完全没有 step-start parts → `stepStarts = 0` → -1（tests/render-phase-divider.test.tsx:105）；untagged quiz 不终止扫描，继续找 tagged 的（:109）；explain 同样认（:119）；多个 tagged 调用只认第一个（返回即止）。

**⑤ 上游调用方**（全部在 `components/chat.tsx`，且都被翻转守卫包住）：

- `:1492`——`teachStepIndex(m.parts) === -1` 时整消息前置 `<PhaseDivider phase="teach">`（:1493）；守卫是 `m.role === "assistant" && mi > 0 && phases[mi] === "teach" && phases[mi-1] !== "teach"`（:1488-1492）——本索引翻转、上一索引未翻转，保证**每会话恰好一条** Teaching 分隔线；
- `:1537`——`teachBoundary = ... && teachStepIndex(m.parts) === pi`（:1533-1537 同款守卫）；
- `:1575`——part 循环的 `case "step-start"`：`teachBoundary` 为真则渲染 `<PhaseDivider phase="teach">` **取代**该边界的普通 `<Separator>`（:1573-1576，注释 :1529-1531「replaces this boundary's plain hairline」；另见 :1482-1483「a labeled phase rule supersedes it」）。
- 测试：tests/render-phase-divider.test.tsx:83-128（首 step → -1、后 step → 边界索引、无 step-start 防御、untagged 跳过、explain 同缝）。

**教学分隔线到底锚在哪条消息之前**（本卷导读问题的精确答案）：锚在**首个 tagged quiz/explain 调用所在的 assistant 消息**——若该调用在消息第一个 step，分隔线前置到整条消息之前；若在后续 step，分隔线锚在消息**内部**那个 step-start part 处（计划呈现与教学块之间）。而 **Planning 分隔线不走折叠**：它锚在 probe-handoff 唤醒 marker 上（`chat.tsx:1421-1430`，`m.role === "user" && parts.some(p => p.type === "data-probe-handoff")` → `<PhaseDivider phase="plan">`；marker 投影自 `view.ts:395`）。注释（:1422-1429）给出原因：Wave D 分组把整个探测期合并成一个巨型 assistant 组后，旧的折叠式 plan 分隔线会漂到记录顶端；handoff marker 由记录构造保证落在正确位置，所以 Planning 缝改由 marker 锚定（所有者裁定 2026-09-26，它取代了「Preparing your plan…」系统行）。`phase-divider.tsx:62-66` 另规定 probe 永不渲染分隔线（阶段只进不退，probe 是记录起点）。

#### 1.3.5 `phaseTimeline`（147-155 行）[纯函数]

**① 签名与定位**：`export function phaseTimeline(messages: readonly PhaseMessage[]): Phase3[]`（doc 141-146）。**每个消息索引处的阶段**，一次前向折叠全部算出。

**② 输入输出与不变量**：输出数组与输入等长；**`out[i] === phaseAt3(messages, i)` 对每个 i 成立**（145 行明文契约）。这是分隔线渲染的性能形态：逐边界调 `phaseAt3(m, i)` 每次重扫 0..i，总体平方；本函数同一推导、线性（142-144 行注释）。

**③ 逻辑逐步推导**：`out: Phase3[] = []`（148）、`phase = "probe"`（149）；对每条消息 `phase = advance(phase, messages[i]?.parts)` 后 `out.push(phase)`（150-153）；返回 out（154）。与 `phaseAt3` 共用 `advance`，口径不可能漂移。

**④ 边界与历史背景**：空数组 → `[]`（不是 `[probe]`）。输出是**逐消息**的阶段而非「边界列表」——边界由消费方用相邻差分检测（`phases[mi] !== phases[mi-1]`）。因为阶段单调，差分至多命中两次（probe→plan、plan→teach），但如 1.3.4 所述客户端只用它检测 teach 缝；plan 缝由 handoff marker 锚定。

**⑤ 上游调用方**：`components/chat.tsx:558`——`const phases = useMemo(() => phaseTimeline(messages), [messages])`。消费点：`:1396` header `<PhaseChip phase={phases.at(-1) ?? "probe"}>`；`:1488-1492` 与 `:1533-1537` 的 teach 翻转守卫；`:1709` 与 `:2402` 把 `phases.at(-1) ?? "probe"` 作为 `phase` prop 传给答题 dock 区（QuestionDock 的思考字段尺度与 Probe/Recall 标签随阶段变化，`question-dock.tsx:88-90`、`:118-125`、`:912`）。测试：tests/phases.test.ts:121（折叠成相位跨度）、:106（拒绝不推进）。

#### 1.3.6 `phaseAt3Lh`（166-192 行）[纯函数]

**① 签名与定位**：`export function phaseAt3Lh(messages: readonly LhMessage[], upToIndex?: number): Phase3`（doc 161-165；分节注释 157「the native fold (Wave D: record-side phase over LhMessage[])」）。**原生记录**上的点查询，与视图折叠同缝、原生形状。

**② 输入输出与不变量**：输入 `LhMessage[]`（pi 原生 user/assistant/toolResult + custom marker，词条 3/43）；输出三相位。不变量：与 `phaseAt3` 在任何已收尾记录上结论一致；单调、严格顺序；空记录 → probe。

**③ 逻辑逐步推导**：

1. `phase = "probe"`（167）；`last = Math.min(upToIndex ?? len-1, len-1)`（168，与 phaseAt3 同款钳制）；
2. **预计算收尾集**：`const concluded = probeDoneResultIds(messages.slice(0, last + 1))`（169）——对**前缀**调用 `native-messages.ts:760-778` 的权威判定，得到「干净收尾的 probe_done **结果消息 id**」集合。该判定的四道闸（`native-messages.ts:763-775`）：
   - assistant 消息若 `stopReason === "error" || "aborted"` → **整条跳过**，其中的 probe_done 调用不进 calls 集（765）——失败/中止生成不授予收尾权威；
   - 只有 `toolCall && name === "probe_done"` 的 block id 进 calls 集（767）；
   - toolResult 必须 `toolName === "probe_done"` **且** `calls.has(m.toolCallId)`（双匹配：调用 id + 工具名，770-771）——孤儿 result、错配 result 不算；
   - `!m.isError` 且 `details?.ok !== false`（771-772）——错误结果与显式拒绝不算；缺 ok 的旧式干净 ack 仍算（758-759 注释）。
3. 顺序扫描 `i = 0..last`（170-190）：
   - `role === "toolResult"`：`phase === "probe" && concluded.has(m.id)` → `phase = "plan"`（173-174）。**推进点在 RESULT 消息**，不是调用消息；
   - `role === "assistant"`：取 `content ?? []`（176），仅当 `phase === "plan"`（177）时遍历 blocks：`block.type === "toolCall" && (name === "quiz" || name === "explain") && taggedNodeId(block.arguments)` → `phase = "teach"` 并 `break`（179-185）。**推进点在携带 CALL 的 assistant 消息**；break 只退出 block 循环，消息循环继续（但 teach 是吸收态，后续无可推进）；
   - 其他 role（user/custom marker）直接略过。
4. 返回 phase（191）。

**④ 边界与历史背景**：

- **顺序守卫的微妙处**：concluded 集是对整个前缀预计算的，但翻转仍受顺序扫描约束——probe_done 结果**之前**出现的 tagged 提问不会翻转（当时 phase 还是 probe）；teach **之后**的 probe_done 结果不会回退（分支要求 phase === "probe"）。预计算只是把「干净与否」的判定交给单一权威函数，顺序语义仍由扫描保证。
- **与视图折叠的推进点差异**：视图侧 probe→plan 翻在调用 part 拿到干净 output 之时（part 属于 assistant 组），原生侧翻在 RESULT 消息处——两者在已收尾记录上落进**同一个视图边界**（Wave D 分组把调用与结果并入同一 assistant 组），所以结论一致（头注释 31-34）。
- **失败/中止不算跃迁**的原生实现就是 `stopReason` 过滤 + `isError`/`ok:false` 闸；失败尝试保留在记录中（失败重试，词条 22），本函数不改历史（`native-messages.ts:759`「No history changes」）。
- 悬空 tagged 调用（无结果）照样翻 teach——与视图侧一致（CALL 即缝）；`derivePlanStatusesLh` 的 doc 同样明文「a dangling call still moves position」（`contracts/plan.ts:130-131`）。
- 无 probe_done 的旧记录 → probe（无向后兼容）。

**⑤ 上游调用方**：

- `src/store/chats.ts:108`——`listChats` 为每个会话算 `ChatSummary.phase`（会话选择器的阶段标签；注释 101-107 说明 Wave D 后两个折叠都读原生记录，活性 busy 另行由 API 路由合并）。这是**store 层**消费纯 core 折叠的实例（导入法则：core 永不 import IO 层，反向合法）。
- `scripts/sandtable/board.ts:207`——沙盘在 `record` 报告上用 `phaseAt3Lh(messages)` 与 `hasProbeDone` 推出的 role 一起更新 turn 的 `{role, phase}`（:206-212），与生产 handler/视图同一套折叠（:10 注释、:205 注释「the same folds the production handler/view use」）。
- 测试：tests/phases.test.ts:178（原生缝：干净结果处 probe→plan、首个 tagged CALL 处 plan→teach）、:207（explain 同缝）。

### 1.4 轻量私有辅助归并表与全行覆盖

本文件无私有轻量辅助（`taggedNodeId` 与 `advance` 均已在 1.3 五要素精讲）。全 192 行覆盖表：

| 行范围 | 内容 | 讲解位置 |
|---|---|---|
| 1-37 | 头注释：设计史（占用推断废弃、verdict death、滞后裁定、双折叠、纯度） | 导读 0.2/0.3；1.1 |
| 39-40 | `Phase3` 类型 | 1.2 |
| 42-49 | `PhaseMessage` 接口 | 1.2 |
| 51-60 | `taggedNodeId` | 1.3.1 |
| 62-70 | `phaseAt3` | 1.3.2 |
| 72-100 | `advance`（含 79-82、89-90 两段分支注释） | 1.3.3 |
| 102-139 | `teachStepIndex`（含 stacked-dividers 事故注释） | 1.3.4 |
| 141-155 | `phaseTimeline`（含平方→线性动机注释） | 1.3.5 |
| 157-159 | 原生折叠分节注释 + 中部 import | 1.1、1.3.6 |
| 161-192 | `phaseAt3Lh` | 1.3.6 |

（其余行均为空白分隔行。）**覆盖率 192/192。**

---

## 2. src/core/plan-tree.ts（132 行）

### 2.1 模块定位与纯度边界

- **桶导出**：`src/core/index.ts:38` `export * from "./plan-tree.ts"`。但生产调用方在 **agent 层**：`src/agent/tools/plan.ts:6` 直接路径 import `createTree, PlanTreeError`（agent 层可以直连 core 文件；导入法则只限制 shell 与 core 的反向依赖）。客户端经桶拿的是**类型**（`PlanTree` 等来自 contracts，`mermaid-plan.ts:30` 经 `@/src/core` 拿 `PlanEdge`/`PlanNode`）。
- **100% 纯函数 + 一个 Error 子类**：唯一 import 是类型-only 的 `import type { PlanEdge, PlanNode, PlanTree } from "./contracts.ts"`（1 行）——运行时零依赖。无 IO、无 mutation、完全确定。
- **错误即协议**（头注释 6-9）：所有校验失败抛 `PlanTreeError`，**消息是写给 agent 看的**——它原样流回成为 tool-result error（`plan.ts:104` `return { ok: false, error: err.message }`），精确说明哪里错、哪个 id/哪条边有错。这是返回 agent 教义的实例：模型读到可操作的错误、同回合重试（tests/plan-tree.test.ts:178「structural failures (cycle) become ok:false without persisting」）。
- **历史定位**（128-132 行尾注释）：七个逐节点 mutation/tracking 操作（addNode/updateNode/removeNode/addEdge/removeEdge/setCurrent/markDone）随 author-once 协议（2026-09-03）删除，死导出随 2026-09-11 pivot 清理。树**只承载结构**——没有进度字段可供 mutate；**重构 = plan_init 重写**。tests/plan-tree.test.ts:189 钉住「only plan_init exists — the seven mutation/tracking tools are gone by design」。今天模块只剩两个生产者：`createTree`（version 1）与 `emptyTree`（version 0）。

### 2.2 核心数据结构与类型契约

**契约类型**（`src/core/contracts/plan.ts`，经 `contracts.ts:13` 桶式再导出）：

- `PlanNode`（13-20 行）：`id`（opaque、agent 自选的 slug，跨编辑稳定，如 "chain-rule-intuition"）、`title`（树面板短标签）、`summary?`（1-2 句覆盖说明）。
- `PlanEdge`（22-27 行）：`from` = **先修节点**，`to` = 依赖 from 的节点。语义方向：「from must be understood before to」（96、104-105 行错误消息原话）。
- `PlanTree`（29-33 行）：`nodes: PlanNode[]`、`edges: PlanEdge[]`、`version: number`。**没有别的**——35-40 行 NOTE 明文：曾有的 `currentNodeId`/`doneNodeIds` 进度字段已按设计删除；位置与 visited 在渲染时从记录派生；**没有任何 done 账本**；旧记录无向后兼容。
- 存储位：`ChatRecord.tree?: PlanTree`（`contracts/chat.ts:39`）——可选字段，缺位即「尚无计划」；由 plan 工具经 `saveTree` 写入（`store/chats.ts:199-206`：整树替换、**不 bump updatedAt**（树编辑不是会话活动，侧栏排序不许抖动）、经唯一写入口 writeChat 落盘并盖 schema 版本戳；且按静默法则（词条 96）不发事件）。

**`PlanTreeError` 错误消息契约**（22-27 行类定义；消息全文如下，全部 agent-readable）：

| # | 触发条件 | 消息（代码原样） | 抛出行 |
|---|---|---|---|
| 1 | node falsy / id 非字符串 / id trim 后为空 | ``Every node needs a non-empty `id` (a stable slug like 'chain-rule-intuition').`` | 38 |
| 2 | title 非字符串 / trim 后为空 | ``Node "${node.id}" needs a non-empty `title`.`` | 41 |
| 3 | 节点 id 重复 | `Duplicate node id "${node.id}" — node ids must be unique.` | 50 |
| 4 | 边端点不存在 | `${what} references unknown node id "${id}" — it is not in the tree.`（what = ``Edge `from` `` 或 ``Edge `to` ``） | 59 |
| 5 | 自环 | `Edge "${from}" → "${to}" is a self-loop — a node can't require itself.` | 96 |
| 6 | 重复边 | `Edge "${from}" → "${to}" already exists — duplicate edges are not allowed.` | 99 |
| 7 | 成环 | `Edge "${from}" → "${to}" would create a cycle: "${to}" already leads (directly or transitively) back to "${from}". "from" must be understood before "to" — the tree is a DAG.` | 102-105 |

每条消息都**点名肇事者**（具体 id/边）并解释规则本身——模型不需要猜。`PlanTreeError` 的 `name` 固定为 `"PlanTreeError"`（25 行），供 `plan.ts:104` 的 `instanceof` 判别：是它 → 转 `{ok:false,error}` 返回 agent；不是它 → 原样 rethrow（`plan.ts:105`），绝不吃掉意外错误。

**`version` 递增规则——契约与现状的精确区分**：

- **契约**（头注释 15-18）：每次成功的**状态改变**操作 version 递增；**真 no-op**（setCurrent 到已在的当前节点、markDone 已 done 的节点）返回输入树原样、version 不动——因为 version 驱动 UI 重动画，非变化不许 tick 它。`createTree` 恒从 version 1 开始。
- **现状**：mutation ops 删除后，全仓只剩两个 version 生产者——`emptyTree` → 0（31 行）、`createTree` → 1（125 行字面量）。`saveTree` 原样存储不 bump（`store/chats.ts:199-206`），rg 全仓无任何 `tree.version` 递增代码。因此**今天任何落盘树的 version ≡ 1**：重写产生的是一个新的 version-1 树对象（对象身份变化，数字不再递增）。递增机器随 mutation ops 一起退役，字段留在契约里（`contracts/plan.ts:32-33` 注释仍写「Increments on every mutation」——那是契约遗产，读代码时以本模块实际行为为准）。no-op 不 tick 的规则如今没有可触发的操作，属于历史契约。

### 2.3 全部导出函数与核心内部算法五要素精讲

#### 2.3.1 `PlanTreeError`（22-27 行）[类 · 纯构造]

**① 签名与定位**：`export class PlanTreeError extends Error`，`constructor(message: string)`（23-26）：`super(message)` + `this.name = "PlanTreeError"`。doc 21「Error thrown by every op on invalid input. Message is agent-readable.」

**② 输入输出与不变量**：输入一条 agent-readable 消息；输出 Error 实例。不变量：`name` 恒为 `"PlanTreeError"`（跨 realm/序列化后仍可按 name 判别）；本模块**所有**校验失败都抛它、只抛它。

**③ 逻辑**：两行构造，无分支。它的「算法」在消费侧：`plan.ts:103-105` catch 后 `instanceof` 分流——PlanTreeError → `{ok:false, error: err.message}`（经 `toToolResult` 成为干净 toolResult，`details` 携带原始对象，`tool-execute.ts:178-181`；模型读到错误文本重试）；其他异常 → rethrow（基础设施故障不该伪装成教学反馈）。

**④ 边界与历史背景**：错误消息是**协议的一部分**而非日志——tests/plan-tree.test.ts:61-111 逐条钉住消息内容（duplicate ids、missing endpoints、self-loops/duplicates/cycles、invalid node shapes）。消息措辞面向模型的教学语气（「a node can't require itself」「the tree is a DAG」）是返回 agent 教义的刻意设计。

**⑤ 上游调用方**：抛出点遍布本模块（38、41、50、59、96、99、102）；捕获点 `src/agent/tools/plan.ts:104`；测试 import `tests/plan-tree.test.ts:16`。经桶导出（index.ts:38）。

#### 2.3.2 `emptyTree`（30-32 行）[纯函数]

**① 签名与定位**：`export function emptyTree(): PlanTree`（doc 29「An empty, never-stored tree used as the seed before plan_init runs」）。返回 `{ nodes: [], edges: [], version: 0 }`（31）。

**② 输入输出与不变量**：无输入；每次返回**全新对象**（无共享引用）；version 0 是「未作者」的标记值，与 createTree 的 1 区分。**never-stored**：它不落盘。

**③ 逻辑**：单行字面量，无分支。

**④ 边界与历史背景**：生产代码如何表达「尚无计划」？答案是 **`record.tree` 字段缺位**（`contracts/chat.ts:39` 可选），而不是存一个空树——rg 全仓（src/app/components/scripts/tests/electron）核实：`emptyTree()` **当前没有任何生产调用点**；`tests/plan-tree.test.ts:16` import 了它但文件内未实际调用；`tests/plan-blocks.test.ts:212-213` 用等价手写字面量 `{nodes:[],edges:[],version:0}` 测「空树不发射」。它是经桶导出的语义种子/测试便利，「seed before plan_init」的角色今天由字段缺位承担。读代码时不要误以为某处在运行时调用它。

**⑤ 上游调用方**：无生产调用（见④）；导出面 `src/core/index.ts:38`；测试 import `tests/plan-tree.test.ts:16`。

#### 2.3.3 `nodeMap`（45-55 行）[纯函数 · 节点校验核心]

**① 签名与定位**：`function nodeMap(nodes: PlanNode[]): Map<string, PlanNode>`（私有）。把节点数组变成 id → node 的 Map，**顺带完成全部节点级校验**。

**② 输入输出与不变量**：成功返回时保证——每个节点 id 是非空字符串（trim 意义下）、title 非空、**id 全局唯一**；Map 保持输入顺序。失败抛 PlanTreeError（消息 #1/#2/#3），不返回半成品。

**③ 逻辑逐步推导**（46-54）：

1. 建空 Map（46）；
2. 对每个 node：先 `assertValidNode(node)`（48，形状校验，见 2.4 表）；
3. `if (map.has(node.id))` → 抛 `Duplicate node id "${node.id}" — node ids must be unique.`（49-51）——**首个重复即抛**，消息点名肇事 id；
4. `map.set(node.id, node)`（52）；
5. 返回 map（54）。

**④ 边界与历史背景**：空数组 → 空 Map（合法——`createTree([], [])` 产生 version-1 空树；下游 `planBlocksFor` 用 `nodes.length === 0` 挡住空树的快照发射，`plan-blocks.ts:81`）。校验顺序是**先形状后重复**：一个 id 为空的节点报消息 #1 而不是「重复的空 id」。注意 Map 存的是**输入节点对象的引用**——nodeMap 本身不拷贝；拷贝发生在 createTree 的返回处（125 行 `{...n}`），所以 nodeMap 作为内部索引不构成 mutation 风险（它只读）。性能注脚：`assertValidEdge` 每验一条边都重建一次 nodeMap（92 行），总体 O(E·N) 重复校验——树规模 5-15 节点（`plan.ts:71` 工具描述「5–15 nodes: a map, not a syllabus」），刻意用冗余换「每条违规都能点名肇事边」的简单实现。

**⑤ 上游调用方**：`createTree:113`（整树节点校验）、`assertValidEdge:92`（每边重建，注释「also re-validates nodes on createTree」）。

#### 2.3.4 `createsCycle`（71-88 行）[纯函数 · DAG 拓扑环检测]

**① 签名与定位**：`function createsCycle(edges: PlanEdge[], from: string, to: string): boolean`（私有；doc 67-70）。回答：**新增边 from→to 会不会闭环？** 算法等价命题：沿既有边从 `to` 出发前向行走，若能到达 `from`，新边就 closes a loop。

**② 输入输出与不变量**：输入既有边集 + 候选边两端；输出 boolean。不变量：不修改 edges；对任意（可能含环的——防御性）输入都终止。

**③ 逻辑逐步推导**：

1. **建邻接表**（72-77）：`adjacency = new Map<string, string[]>()`；对每条既有边 `e`，把 `e.to` 追加到 `adjacency.get(e.from)` 的列表（无则新建 `[e.to]`）。方向是 from → to（先修 → 依赖者）。
2. **显式栈迭代 DFS**（78-86）：`stack = [to]`（78）、`seen = new Set<string>()`（79）；循环 `while (stack.length > 0)`：
   - `current = stack.pop()!`（81）；
   - `if (current === from) return true`（82）——**命中即环**：to 能走到 from，加上 from→to 就是闭环；
   - `if (seen.has(current)) continue`（83）——已访问节点跳过；
   - `seen.add(current)`（84）；
   - 把 `adjacency.get(current) ?? []` 的所有后继压栈（85）。
3. 栈空未命中 → `return false`（87）。

**④ 边界与历史背景**：

- **为什么从 `to` 走到 `from` 而不是反向**：边语义是「from 必须先于 to 被理解」。若 to 已经（直接或间接）是先修链上 from 的祖先，再要求 from 先于 to 就自相矛盾——错误消息 #7 正是这样向模型解释的（102-105）。
- **迭代而非递归**：显式栈避免深链（几十节点的先修链）递归爆栈；`seen` 集既防既有环状结构上的死循环（防御——既有边按不变量本应无环），也防 DAG 重汇聚路径上的指数级重访。
- **自环与重复边不在这里管**：`assertValidEdge` 先用专门检查拦截（95-100），各自有专属消息。顺序有意：若先跑环检测，自环 from===to 会让 `stack=[to]` 弹出即命中、误报成 cycle 消息；重复边 a→b（b 已通向 a）也会误报 cycle 而非 duplicate。检查顺序 = 错误 precedence（见 2.3.5）。
- 空 edges → 邻接表空 → 弹出 to ≠ from → false（首个节点对之间加边永不成环）。
- 这是「结构是 DAG」不变量（头注释 14）的唯一执法算法；配合自环/重复检查，保证 createTree 产出的树可做拓扑排序（先修序教学的路径基础）。

**⑤ 上游调用方**：`assertValidEdge:101`。测试：tests/plan-tree.test.ts:70（self-loops/duplicates/cycles 拒绝）、:178（环 → ok:false 且不落盘）。

#### 2.3.5 `assertValidEdge`（91-107 行）[纯函数 · 边全量校验]

**① 签名与定位**：`function assertValidEdge(from: string, to: string, nodes: PlanNode[], existingEdges: PlanEdge[]): void`（私有；doc 90「Full edge validation against existing nodes/edges: endpoints exist, no self-loop, no duplicate, acyclic」）。

**② 输入输出与不变量**：无返回值——通过即静默，失败抛 PlanTreeError。关键参数语义：`existingEdges` 是**已接受前缀**（不是全量输入边集），调用方用它做增量验收。

**③ 逻辑逐步推导**（五道闸，顺序即错误 precedence）：

1. `const map = nodeMap(nodes)`（92）——重建节点索引，**顺带重新校验全部节点**（注释明说）；
2. ``requireNode(map, from, "Edge `from`")``、``requireNode(map, to, "Edge `to`")``（93-94）——两端点必须存在（消息 #4，what 参数点名是哪一端）；
3. `from === to` → 抛自环（95-97，消息 #5）；
4. `existingEdges.some(e => e.from === from && e.to === to)` → 抛重复边（98-100，消息 #6）——线性扫描已接受前缀；
5. `createsCycle(existingEdges, from, to)` → 抛环（101-106，消息 #7）。

**④ 边界与历史背景**：五道闸的顺序保证模型收到**最具体**的错误：端点不存在优先于结构问题（createTree 另有预检保证这一点，见 2.3.6）；自环优先于环（专属消息）；重复优先于环。每边重建 nodeMap 的冗余是刻意的简单性取舍（见 2.3.3④）。`existingEdges` 传前缀而非全集，使「违规」永远相对于**已接受的结构**判定——任何环/重复都能点名**肇事边**（createTree 119-121 行注释），而不是含糊地说「输入里有环」。

**⑤ 上游调用方**：`createTree:122`（增量验收循环内，每条输入边一次）。

#### 2.3.6 `createTree`（112-126 行）[纯函数 · 唯一生产入口]

**① 签名与定位**：`export function createTree(nodes: PlanNode[], edges: PlanEdge[]): PlanTree`（doc 111「Build a fresh tree (version 1) from node and edge lists, validating all invariants」）。author-once 协议下**唯一**的树构造操作：首次作者与每次重写都走它。

**② 输入输出与不变量**：输入解析器产出的节点/边数组；输出**全新树对象**，满足全部不变量（id 唯一非空、端点存在、无自环/重复边/环、version 1）。**绝不 mutate 输入**（头注释 6-7）：节点经 `nodes.map(n => ({...n}))` 浅拷贝（125），边经 `accepted.push({from: e.from, to: e.to})` 重建（123）——重建还**剥掉输入边对象上的任何多余字段**，落盘形状被规范化为纯 `{from,to}`。失败抛 PlanTreeError，调用方不落盘。

**③ 逻辑逐步推导**（三段）：

1. **节点全量校验**（113）：`const map = nodeMap(nodes)`——形状 + 唯一性一次过；
2. **端点预检循环**（114-117）：对**每条**输入边先 `requireNode(map, e.from, ...)` / `requireNode(map, e.to, ...)`——保证「任何端点缺失」的错误先于一切边结构错误抛出（否则第一条边成环、第二条边端点缺失时，模型会先收到环消息，修完环再撞端点错误，多一轮往返）；
3. **增量验收循环**（118-124）：`accepted: PlanEdge[] = []`；对每条边 `assertValidEdge(e.from, e.to, nodes, accepted)`（122）——对着**已接受前缀**验自环/重复/环——通过后 `accepted.push({from, to})`（123）。注释 120-121：「Each edge is checked against the ones already accepted, so any violation names the culprit edge.」
4. 返回 `{ nodes: nodes.map(n => ({...n})), edges: accepted, version: 1 }`（125）。

**④ 边界与历史背景**：

- **完整错误 precedence 链**：节点形状（#1/#2，按节点序）→ 重复 id（#3）→ 端点缺失（#4，预检按边序）→ 逐边自环（#5）/重复（#6）/环（#7，按输入边序，相对已接受前缀）。模型每次收到一个精确、可操作的错误。
- **端点双重校验是有意的**：预检（114-117）与 assertValidEdge 内部（93-94）重复——预检买的是错误 precedence，内部检查买的是 assertValidEdge 作为独立函数的自足性。
- 空 nodes + 空 edges → 合法 version-1 空树（不抛）；下游 planBlocksFor 挡快照（`plan-blocks.ts:81`）。
- **浅拷贝的边界**：`{...n}` 拷贝 id/title/summary 三个自有字段；summary 是字符串（不可变），无深拷贝需求。输入数组本身不被改动（tests/plan-tree.test.ts:47「createTree builds version 1 with no mutation of its inputs」钉住）。
- **失败零副作用**：`plan.ts:89-90` 的顺序是 createTree 成功**之后**才 saveTree——结构失败（如环）时什么都没写（tests/plan-tree.test.ts:178）；解析失败更早被拦（`plan.ts:79-85`，parseMermaidPlan 收集**全部**问题带行号一次退回，:161 测试）。
- **重写语义**：re-callable——新块整树替换旧树（tests/plan-tree.test.ts:139「RE-CALLABLE: a rewrite replaces the tree wholesale (the mutation tools are gone)」）；节点 slug 永久，但重写丢掉的 slug 在位置派生里不再计数（`contracts/plan.ts:59-60`；tests/plan-tree.test.ts:387）。version 恒 1 的现状见 2.2。
- 复杂度：O(E·(N+E))（每边重建 nodeMap + 线性重复扫描 + 一次 DFS）——5-15 节点的地图尺度下刻意不做优化。

**⑤ 上游调用方**：

- `src/agent/tools/plan.ts:89`——`plan_init` 的 execute 内：`const next = createTree(parsed.plan.nodes, parsed.plan.edges)`；输入来自 `parseMermaidPlan(mermaid)`（`plan.ts:79`；解析器在 `src/agent/tools/mermaid-plan.ts`，其 `ParsedPlan` 形状即 `{nodes: PlanNode[], edges: PlanEdge[]}`，:33-34，边收集 :92）。**mermaid-plan.ts 不调用本模块任何函数**——它只消费契约类型（经 `@/src/core` 桶，:30），产出 createTree 的输入；解析与结构校验是两道分离的缝（解析失败收集全部问题，结构失败抛单条肇事消息）。
- 成功后 `chatStore.saveTree(chatId, next)`（`plan.ts:90`）→ 结果 `details: {ok:true, tree: next}`（:101）供记录与计划弹窗的 latestTree 缝读取（`contracts/plan.ts:114-123` PlanToolResult；content 只带 nodeIds + 绑定提醒，上下文节食，所有者 2026-10-09，`plan.ts:14-15`、`:96-100`）。
- 测试：tests/plan-tree.test.ts:47-111（纯 ops 五连）、:114-204（plan_init 对真实 store 的 execute 集成）。

### 2.4 轻量私有辅助归并表与全行覆盖

| 函数 | 行范围 | 签名 | 全部逻辑（逐行） | 调用方 |
|---|---|---|---|---|
| `assertValidNode` | 36-43 | `(node: PlanNode) => void` | 37-39：`!node ∥ typeof node.id !== "string" ∥ node.id.trim() === ""` → 抛消息 #1（falsy node 也拒）；40-42：`typeof node.title !== "string" ∥ title.trim() === ""` → 抛消息 #2（点名 id）。trim 语义：纯空白 id/title 不算非空 | `nodeMap:48` |
| `requireNode` | 57-61 | `(map: Map<string, PlanNode>, id: string, what: string) => void` | 58-60：`!map.has(id)` → 抛消息 #4；`what` 参数携带肇事端点名（``Edge `from` `` / ``Edge `to` ``），消息模板单点存在 | `createTree:115-116`（预检）、`assertValidEdge:93-94` |
| `edgeKey` | 63-65 | `(from: string, to: string) => string` | 64：返回 `` `${from}\u0000${to}` ``——NUL（U+0000）分隔保证键的单射性（id 含任何字符都不会撞键）。**死代码**：rg 全仓（src/app/components/scripts/tests/electron）仅有定义、零调用——已删除的 mutation ops 曾用它做边 Map 的键，清理死导出时（2026-09-11）遗留至今。读代码时不要为它寻找不存在的调用链 | 无 |

全 132 行覆盖表：

| 行范围 | 内容 | 讲解位置 |
|---|---|---|
| 1 | 类型-only import（contracts） | 2.1 |
| 3-19 | 头注释：纯度、错误即协议、DAG 不变量、version 规则 | 2.1、2.2 |
| 21-27 | `PlanTreeError` 类 | 2.3.1 |
| 29-32 | `emptyTree` | 2.3.2 |
| 34 | validation helpers 分节注释 | 2.4 |
| 36-43 | `assertValidNode` | 2.4 表 |
| 45-55 | `nodeMap` | 2.3.3 |
| 57-61 | `requireNode` | 2.4 表 |
| 63-65 | `edgeKey`（死代码） | 2.4 表 |
| 67-88 | `createsCycle`（含 doc） | 2.3.4 |
| 90-107 | `assertValidEdge`（含 doc） | 2.3.5 |
| 109 | ops 分节注释 | 2.1 |
| 111-126 | `createTree`（含 doc 与增量验收注释） | 2.3.6 |
| 128-132 | 尾注释：七个 mutation ops 的删除史 | 2.1、2.2 |

（其余行均为空白分隔行。）**覆盖率 132/132。**

---

## 3. src/core/plan-blocks.ts（95 行）

### 3.1 模块定位与纯度边界

- **不经桶导出**：`src/core/index.ts` 没有 plan-blocks 行。它是 **server-only 发射缝**，与 `core/graph.ts` 同一模式（index.ts:12-15 注释：server-only core 模块是纯的，但刻意不再导出，由 server 调用方直接 import）。真实 import 面全仓仅两处：`src/server/turn-service.ts:23`（生产）与 `tests/plan-blocks.test.ts:15`（测试）。客户端**拿不到也不需要**发射逻辑——它只消费投影拼出来的 `data-plan-block` part。
- **纯度边界（本卷最微妙的一处）**：doc 67 自称「The native emission seam (pure)」——这里的 pure 指**无 IO、无输入 mutation**（不读盘、不写盘、不改 record/newMessages/tree/transcript 任何一个字节），但**不是引用透明**：`snapshot` 的 `at: new Date().toISOString()`（41 行）取墙钟；`newPlanBlockMessage` 的 id 用 `Date.now().toString(36)` + `crypto.randomUUID().slice(0,8)`、timestamp 用 `Date.now()`（`native-messages.ts:247`、`:253`）。同一输入两次调用产出不同 id/时间戳。**幂等性靠 emitted 集（按 planCallId 去重），不靠确定性**——这是读这个模块时必须分清的两件事。对比：phases.ts 与 plan-tree.ts 是 100% 确定性的真纯函数。
- **依赖面**（18-22 行）：`contracts.ts` 的 `PlanBlockData`/`PlanTree` 类型 + `derivePlanStatusesLh` 运行时（经 `contracts.ts:13` 再导出 `contracts/plan.ts`）；`native-messages.ts` 的 `LhMessage` 类型 + `newPlanBlockMessage` 运行时；`@earendil-works/pi-ai` 的 `ToolResultMessage` **类型-only**。全部浏览器安全 core，无 IO 层依赖（导入法则：core 永不 import agent/server/store）。
- **头注释（1-16 行）设计史**：INTERIM 呈现缝（2-9）——计划在作者期流内渲染一次、冻结快照、呈现时刻兼弹窗入口、状态在那一瞬间准确（课中重写则显示当时真相）；Wave B（11-15，所有者批准 2026-09-26）——原生 marker 在回合收尾追加、按 plan_init 调用幂等、投影拼回 UIMessage 时代 attach 的原位；neighborhood-block 机制保持退役，位置从记录实时派生。

### 3.2 核心数据结构与类型契约

**`PlanBlockPart`（27-31 行）**：

```ts
export interface PlanBlockPart {
	type: "data-plan-block";
	id: string;
	data: PlanBlockData;
}
```

聊天渲染器消费的消息 part 形状（doc 24-26：TeacherUIDataParts 的 key 是 `"plan-block"`——SDK 剥掉 `data-` 前缀；此接口为客户端渲染器保留，**投影发射这个形状**）。生产发射点：`view.ts:486` `group.parts.splice(idx + 1, 0, { type: "data-plan-block", id: marker.id, data: block })`——注意 part 的 `id` 用的是 **marker 消息 id**（`pb_...`），不是 planCallId。消费点：`chat.tsx:1577-1585` `case "data-plan-block"` → `<PlanBlock data={part.data as PlanBlockData} onOpen={() => setPlanOpen(true)} />`。

**`PlanBlockData`（`contracts/chat.ts:234-247`）——快照载荷**：

- `kind: "full"`——**只有 full 存活**（2026-09-11 pivot）：邻域碎片退役，位置从记录实时派生，持久 DAG 窗口是继任者（235-239 行注释）；
- `at: string`——发射时刻 ISO 串；
- `current: string | null`——快照时刻的当前节点（弹窗 glow 目标；null = 无）；
- `nodes: Array<{id, title, status: PlanNodeStatus}>`——**快照自己的状态**，发射时派生，渲染时永不重派生（243-244 行注释）；status 三词阶 `current | visited | upcoming`（`contracts/plan.ts:43`）；
- `edges: Array<{from, to}>`——结构边。

**plan-block 标记消息**（`newPlanBlockMessage`，`native-messages.ts:242-255`）：`id = pb_<base36时间>_<uuid8>`（247）、`role: "custom"`、`customType: "plan-block"`（249）、`content: ""`、`display: true`、`details: { planCallId, block }`（252）、`timestamp: Date.now()`（253）。doc（239-241）：纯 UI 历史（冻结快照），**无模型面——toLlmMessages 过滤它**；`planCallId` 是幂等发射的键（每个成功 plan_init 调用至多一块）。

**冻结 vs 实时的职责矩阵**（本卷导读 0.4 的落地细节）：

| 渲染面 | 结构来源 | 状态来源 | 锚点 |
|---|---|---|---|
| 流内 `PlanBlock` | 快照 `data.nodes/edges`（发射时定格） | 快照 `status`（**as carried, never re-derived**） | `plan-block.tsx:34`、`:673`、`:678`；`chat.tsx:1578-1579` 注释 |
| 计划弹窗 `PlanPopup` | `latestTree(messages)`——倒扫最近一个 `tool-plan_*` 且 `output-available` 且 `output.tree` 合法的工具输出（`plan-block.tsx:716-728`） | `derivePlanStatuses` **点击时现算**（:753-756） | `chat.tsx:918`（planTree memo）、弹窗挂载 |
| 持久 DAG 窗口 | 同 `latestTree` | 实时派生 | `plan-window.tsx:40`、`:46` |

### 3.3 全部导出函数与核心内部算法五要素精讲

#### 3.3.1 `snapshot`（37-50 行）[纯函数 · 含墙钟，非引用透明]

**① 签名与定位**：`function snapshot(tree: PlanTree, messages: readonly LhMessage[]): PlanBlockData`（私有；doc 33-36：快照载荷自 wave 4 未变；状态在**发射时**从记录派生——块永不重派生；Wave D 后派生读**原生记录**、只认 quiz **调用**，结果不喂养任何东西）。

**② 输入输出与不变量**：输入当前树 + 全量原生记录；输出完整 `PlanBlockData`。不变量：`kind` 恒 `"full"`；nodes 与树等长同序、edges 与树等长同序；每个 node 的 status 由同一份 statuses 决定（current 优先于 visited）；输出不引用输入对象（nodes/edges 全部 map 成新对象，且**剥掉 summary 等额外字段**——快照只带 id/title/status）。

**③ 逻辑逐步推导**：

1. `const statuses = derivePlanStatusesLh(tree, messages)`（38）——调用 `contracts/plan.ts:132-148` 的原生位置派生：只扫 assistant 消息 content 里的 `toolCall` block，名字 quiz/explain，`arguments.nodeId` 是字符串**且在当前树的 id 集里**（:141-142，重写丢掉的 slug 不计数）；连续重复 tag 折叠成 runs（同一节点多道题 = 一次停留，:143）；`current = runs.at(-1) ?? null`（:146，**无 fallback current**——首个 tagged 调用前没有当前节点）；`visited = new Set(runs.slice(0, -1))`（:147，更早停留过的节点，sticky；重访 a→b→a 使 a 同时在 visited 与 current，渲染时 current 赢）。**结果不喂养派生**：答对答错、甚至有没有结果，都不移动位置（计划位置＝词条 47 的「位置非完成度」）。
2. 组装载荷（39-49）：`kind: "full"`（40）；`at: new Date().toISOString()`（41，墙钟）；`current: statuses.current`（42）；
3. `nodes: tree.nodes.map(n => ({ id, title, status: statuses.current === n.id ? "current" : statuses.visited.has(n.id) ? "visited" : "upcoming" }))`（43-47）——三元链与 `derivedNodeStatus`（`contracts/plan.ts:76-80`）逐字同序：**current 赢过 visited**，否则 upcoming；
4. `edges: tree.edges.map(e => ({from: e.from, to: e.to}))`（48）——规范化重建。

**④ 边界与历史背景**：首次作者期——记录里还没有任何 tagged 调用 → current null、全部 upcoming（头注释 7 行；tests/plan-blocks.test.ts:99 钉住「全节点入快照、状态从记录派生」）。**课中重写**——statuses 读的是**全量**记录（含此前所有 tagged 调用），快照忠实显示重写那一刻的位置（tests/plan-blocks.test.ts:217（课中重写：快照状态从全量记录派生）；头注释 7-9）。空树不会走到这里（planBlocksFor:81 已挡）。墙钟与非确定性见 3.1——`at` 是快照的「拍摄时间」，不是派生输入。

**⑤ 上游调用方**：仅 `planBlocksFor:94`。私有保证「冻结」语义单点存在：全仓没有第二处构造 PlanBlockData 的生产代码。

#### 3.3.2 `emittedPlanBlockCalls`（54-64 行）[纯函数]

**① 签名与定位**：`export function emittedPlanBlockCalls(messages: readonly LhMessage[]): Set<string>`（doc 52-53：记录里的 plan-block marker，按它们所呈现的 plan_init 调用键控——**发射的幂等集**）。

**② 输入输出与不变量**：输入只读记录；输出已呈现过的 plan_init **toolCallId** 集合。不变量：只认结构完整的 marker（三重守卫），畸形/缺字段的 marker 不进集（宁可重发射也不崩溃——但生产上 marker 都由 newPlanBlockMessage 构造，形状有保证）。

**③ 逻辑逐步推导**（55-63）：

1. `out = new Set<string>()`；
2. 遍历每条消息：`(m as {role?: string}).role !== "custom"` → continue（57）——只看自定义标记消息（词条 42），pi 原生消息一律略过；
3. 结构 cast 后三重守卫（58-59）：`marker.customType === "plan-block"` **且** `typeof marker.details?.planCallId === "string"` → `out.add(marker.details.planCallId)`（60）；
4. 返回 out（63）。

**④ 边界与历史背景**：可选链 `details?.planCallId` 防御 details 缺位；非字符串 planCallId（数字/对象）忽略。空记录 → 空集。这个函数是**跨回合幂等**的根基：later-turn 重写之所以能拿到自己的新块，正因为旧块的 planCallId 已在集里、而新调用的 id 不在（golden-master 规则，见 3.3.3）。它扫的是**已持久化记录**——本回合新发射的块此刻还不在记录里，但 planBlocksFor 每回合至多发一块，不存在同回合自重复。

**⑤ 上游调用方**：`planBlocksFor:82`（生产唯一）；导出面供测试与未来 server 消费（当前 tests/plan-blocks.test.ts 经 planBlocksFor 间接覆盖，:123「idempotent — a call whose block the record already carries is never re-emitted」）。

#### 3.3.3 `planBlocksFor`（75-95 行）[纯函数 · 发射缝，含墙钟/随机 id]

**① 签名与定位**：

```ts
export function planBlocksFor(
	record: readonly LhMessage[],        // 已持久化记录（幂等集来源）
	newMessages: readonly LhMessage[],   // 本回合新消息（stamped）
	tree: PlanTree | null | undefined,   // 记录当前树（plan 工具本回合已 saveTree）
	transcript: readonly LhMessage[],    // 全量原生记录（状态派生读取；参数名原样保留）
): LhMessage[]
```

（doc 66-74：**每回合至多一个** plan-block marker——给本回合**最后一次**成功 plan_init 调用（同回合重写只呈现一次；后续回合的重写拿自己的块——UIMessage 时代 attach 的 golden-master 规则），且该调用尚未被记录呈现过。）

**② 输入输出与不变量**：输出 `LhMessage[]`，长度 **0 或 1**。核心不变量：**每个成功 plan_init 调用在全记录生命周期内至多被呈现一次**；同回合多次成功重写只呈现最后一次；失败调用永不呈现；无树/空树永不呈现。不 mutate 任何输入。

**③ 逻辑逐步推导**（五道闸 + last-wins）：

1. `if (!tree || tree.nodes.length === 0) return []`（81）——null/undefined/空树直接 no-op（tests/plan-blocks.test.ts:206）；
2. `const emitted = emittedPlanBlockCalls(record)`（82）——幂等集**只从已持久化记录**算（不含 newMessages）；
3. `let last: {toolCallId: string} | null = null`（83）；顺序扫 newMessages（84-92），四重过滤：
   - `role !== "toolResult"` → continue（85）——只看结果消息；
   - cast 为 `ToolResultMessage & {id: string}`（86）；`result.toolName !== "plan_init"` → continue（87）——**quiz 结果不发射任何东西**（neighborhood 机制已退役，tests/plan-blocks.test.ts:198）；
   - `const ok = (result.details as {ok?: unknown} | undefined)?.ok; if (ok !== true) continue`（88-89）——**严格 `=== true`**：失败（ok:false）、缺 ok、details 缺位全不算。与 probe_done 的宽松 `ok !== false` 形成对照：plan_init 成功结果**总是**显式写 `details: {ok:true, tree}`（`plan.ts:101`），失败路径经 `toToolResult` 把 `{ok:false,error}` 原样放进 details（`tool-execute.ts:178-181`），所以严格 true 不丢任何合法成功；而 probe_done 有历史遗留的无 ok 干净 ack 需要兼容（`native-messages.ts:758-759`）——两个工具两套口径，各自精确；
   - `if (emitted.has(result.toolCallId)) continue`（90）——已呈现过的调用跳过（跨回合幂等）；
   - 通过全部闸 → `last = {toolCallId: result.toolCallId}`（91）——**覆盖式赋值，last-wins**：同回合多次成功重写，只有最后一次留在 last 里；
4. `if (!last) return []`（93）——本回合没有可呈现的新成功调用；
5. `return [newPlanBlockMessage(last.toolCallId, snapshot(tree, transcript))]`（94）——构造唯一 marker：planCallId 锚定 last 调用，快照结构取 **tree 参数**（回合收尾时的记录当前树 = 本回合最终树），状态取 **transcript 参数**（全量记录）。

**④ 边界与历史背景**：

- **同回合重写**：两次成功 plan_init → 一个块，锚在**最后**一个调用后（tests/plan-blocks.test.ts:179）；快照结构是最终树（saveTree 在回合中已整树替换，`plan.ts:90`），不是第一次的树。
- **跨回合重写**：旧块已冻结在记录里（emitted 集含旧 callId），新回合的成功重写拿**自己的新块**；旧块保持冻结不变（tests/plan-blocks.test.ts:137「a plan REWRITE gets its own full block; the old stays frozen」）——这就是 golden-master 规则：呈现历史不可改写。
- **幂等重放**：同一回合的消息若被再次 persist（重试路径），record 已含该 callId 的块 → emitted 集挡下，绝不重复插入（tests/plan-blocks.test.ts:123）。**幂等扫描 plan_init 防重复插入快照**的机制全貌：emitted 集（按 callId）+ 每回合 last-wins 单块 + 投影侧 splice 只认组内最后一个成功 plan_init part（见⑤），三层合起来保证流内每个成功调用后至多一块。
- **失败零发射**：解析失败/结构失败（PlanTreeError）的 plan_init 结果 ok:false → 无块（tests/plan-blocks.test.ts:115）；且失败时根本没 saveTree，tree 参数还是旧树——但旧树不会为失败调用发射（ok 闸在前）。
- **占位过滤在上游**：persistTurn 先把问题类工具的占位结果（词条 45，循环装置永不落盘）从 stamped 里剔掉（`turn-service.ts:72-79`）；plan_init 不是问题工具，不受影响，但这说明 newMessages 已是「记录事实」而非运行装置。
- **存储位置 ≠ 呈现位置**：marker 被追加在记录**尾部**（`turn-service.ts:87` `[...record.messages, ...stamped, ...blocks]`），呈现位置由投影从记录派生（头注释 14-15）——Wave B 的核心收益：发射逻辑不需要知道 UI 分组，拼回原位是投影的单方面职责。
- **非确定性**：见 3.1——两次调用产出不同 marker id/at/timestamp；幂等靠 emitted 集。

**⑤ 上游调用方与下游消费链**：

- **生产唯一调用点**：`src/server/turn-service.ts:83-86`（`persistTurn` 内，回合收尾＝词条 20）：

  ```ts
  const tree = record.tree;
  const blocks = planBlocksFor(record.messages, stamped, tree, [
      ...record.messages,
      ...stamped,
  ]);
  chatStore.saveMessages(chatId, [...record.messages, ...stamped, ...blocks]);
  ```

  四个实参的语义在此对齐：record.messages = 幂等集来源；stamped = 本回合已盖 id 的新消息（`turn-service.ts:69-81`）；tree = 本回合 plan 工具落盘的当前树；第四参 = **记录 + 本回合**的全量原生记录（所以课中重写的快照能看到本回合之前的全部 tagged 调用）。发射发生在 saveMessages **之前**、agent 运行结束之后的回合收尾里——write-ahead（词条 8）管输入预写，这里管输出追加。
- **下游投影消费**：`src/core/view.ts:478-488` `case "plan-block"`——取 `out` 最后一条消息，必须是 assistant 组（否则静默丢弃）；`lastSuccessfulPlanInit(group.parts)`（:116-124：扫 `tool-plan_init` part 且 `output.ok === true`，保留**最后**一个索引——与发射侧 last-wins 对齐）；`splice(idx + 1, 0, {type:"data-plan-block", id: marker.id, data: block})`（:486）——**流内**紧跟成功 plan_init part 之后，不是追加在回合后续 parts 之下（tests/plan-blocks.test.ts:153 钉住）。无 assistant 组/无成功调用 → 防御性丢弃，绝不崩溃。
- **渲染消费**：`chat.tsx:1577-1585` → `PlanBlock`（冻结渲染，`plan-block.tsx:678`），点击 `setPlanOpen(true)` 打开实时弹窗——冻结块是弹窗的流内入口（头注释 5-6）。
- 测试：tests/plan-blocks.test.ts:99-231 九连（成功一块/失败无块/幂等/重写新块旧块冻结/流内位置/同回合 last-wins/quiz 无发射/空 no-op/课中重写全量派生）。

### 3.4 轻量私有辅助归并表与全行覆盖

本文件唯一的私有函数 `snapshot` 已在 3.3.1 五要素精讲（它是核心算法而非轻量辅助）；无其他私有辅助。全 95 行覆盖表：

| 行范围 | 内容 | 讲解位置 |
|---|---|---|
| 1-16 | 头注释：INTERIM 呈现缝、冻结快照语义、Wave B marker 方案、neighborhood 退役 | 3.1；导读 0.4 |
| 18-22 | import 面（contracts 类型+derivePlanStatusesLh、native-messages 类型+newPlanBlockMessage、pi-ai 类型） | 3.1 |
| 24-31 | `PlanBlockPart` 接口（含 doc） | 3.2 |
| 33-50 | `snapshot`（含 doc） | 3.3.1 |
| 52-64 | `emittedPlanBlockCalls`（含 doc） | 3.3.2 |
| 66-95 | `planBlocksFor`（含 doc） | 3.3.3 |

（其余行均为空白分隔行。）**覆盖率 95/95。**

---

## 全卷收束：三条不变量与它们的执法点

1. **阶段只由显式事件折叠，只进不退**——执法点：`advance` 的现态守卫（phases.ts:84、:92）与 `phaseAt3Lh` 的顺序扫描（:174、:177）；失败/中止不授予 probe 收尾权威（native-messages.ts:765、:771-772），而提问 CALL 的发生即教学开始（phases.ts:79-82）。占用推断与 verdict gate 的废弃使这条不变量不再有「卡住」的可能。
2. **计划树只承载结构，DAG 不变量在构造时全量执法**——执法点：`createTree` 三段校验（plan-tree.ts:113-124），错误消息点名肇事者并原样退回 agent（plan.ts:104）；进度（current/visited）永远从 tagged 调用派生（contracts/plan.ts:82、:132），树里没有任何可 mutate 的进度字段。
3. **每个成功 plan_init 调用至多被呈现一次，快照一经发射永不重派生**——执法点：`emittedPlanBlockCalls` 幂等集（plan-blocks.ts:54-64）+ `planBlocksFor` 的 ok===true 闸与 last-wins（:88-91）+ 投影 splice 的 lastSuccessfulPlanInit 对齐（view.ts:116-124、:486）；实时移动交给弹窗与持久 DAG 窗口，冻结块只负责「呈现时刻」的历史真相。
