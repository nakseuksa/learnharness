# 第 11 卷：上下文压缩切割、用量测量与诚实计费折叠

> **覆盖源码文件**：`src/core/compaction.ts`（406 行） · `src/core/context-usage.ts`（27 行） · `src/core/prices.ts`（103 行） · `src/core/cost-summary.ts`（192 行）  
> **合计行数**：728 行 | **桶导出状态**：4 个文件均全量导出于 `src/core/index.ts`（浏览器安全，无 Node 依赖）  
> **纯度概览**：除 `newCompactionMarker` 生成新消息 ID 与当前毫秒时间戳外，全卷其余 **26 个导出/内部函数均为 100% 严格确定性纯函数**。

---

## 本卷导读与“上下文 × 费用”两大核心法则

本卷覆盖 LearnHarness 对大模型运行时最关键的两项物理资源——**上下文窗口（Token）**与**调用花费（USD / 订阅）**——的纯函数核算逻辑。四个模块由两条严格区分的设计法则统治：

1. **全量历史留盘、投影层按切口裁剪（`compaction.ts` + `context-usage.ts`）**：
   * 上下文压缩**绝不删除或改写持久化的早期消息**（抽取流水线与学习者会话界面依然读取全量历史）。压缩只在持久化末尾追加一条 `customType: "compaction"` 标记消息，内含 4 段式教学连续性摘要与 `firstKeptMessageId` 切口指针。
   * 系统中同时存在**两套语义截然不同的 Token 计算函数**，严禁混用：
     - **触发估算（`estimateContextTokens`）**：锚定最后一条有效 `assistant` 的真实 provider `usage`，加上其后增量消息的 `chars/4` 启发式估算，专门供 `src/server/compaction.ts` 判断“下一轮请求前要不要触发上下文压缩”；
     - **实测读数（`measuredContextTokens`）**：只取最近一次已完成对话回复的真实 `input + output + cacheRead + cacheWrite`，遇到更新的 `compaction` 标记立即归零返回 `null`（显示 `?`），专门供顶栏状态条诚实展示“上一轮实际占了多少窗口”。
2. **费率驻留服务端、美元读时推断且缺失绝不猜零（`prices.ts` + `cost-summary.ts`）**：
   * 持久化记录中**只存 Token 计数，永不存储美元金额**（目录费率更新后重读即可自动重算历史账单，无需数据迁移）。
   * 计费折叠通过高阶函数注入 `price: CallPricer`：内置订阅连接（ChatGPT / Copilot / Grok）单独统计订阅次数，Claude Code CLI、自定义端点及目录缺失/历史缓存精度丢失的记录统一返回 `null` 并计入 `unpriced` / `unpricedRuns`（UI 诚实显示 `"—"`，绝不静默当成 `$0` 免费累加）。

---

## 1. `src/core/compaction.ts`（406 行）

### 1.1 模块定位与纯度边界

* **设计目的**（`src/core/compaction.ts:1-34`）：在无 `@earendil-works/pi-coding-agent` 运行时依赖的前提下，本地受控移植 Pi 1.4.0（MIT 协议）的尾部保留切割点选择与消息体积启发式算法，并结合 LearnHarness 专属的 **4 段式教学摘要契约**（完整保留学习者认知演变与会话计划树 DAG）。
* **桶导出状态**：由 `src/core/index.ts:62` 全量导出。
* **纯度边界**：除 `newCompactionMarker`（`263-273`）调用 `newMessageId()` 与 `Date.now()` 外，其余 13 个函数全部为严格确定性纯函数。

### 1.2 核心常量与接口契约

| 常量 / 接口 | 行号 | 取值 / 结构与设计依据 |
|---|---|---|
| `KEEP_RECENT_TOKENS` | `49` | `20_000`：压缩切割时默认保留的最近原始消息尾部预算（约 2 万 Token，防止摘要丢失近期对话细节）。 |
| `COMPACTION_RESERVE_TOKENS` | `53` | `16_384`：当模型窗口小于用户设定阈值时，从模型最大上下文窗口中预留出的安全余量（有效阈值 = `min(用户阈值, 窗口 - 16384)`）。 |
| `DEFAULT_COMPACTION_THRESHOLD_TOKENS` | `56` | `150_000`：用户未改设置时的出厂默认压缩触发阈值。 |
| `SUMMARY_TOOL_RESULT_TRUNCATE` | `61` | `2_000`：序列化待压缩区间喂给摘要模型时，单条 `toolResult` 文本的最大截断字符数（近期尾部已保留完整原文，摘要无需吞入数万字搜索简报）。 |
| `ESTIMATED_IMAGE_CHARS` | `114` | `4_800`：单张图片块折算的固定字符数（除以 4 后恰好对应 Pi 原生固定的 `1,200` Token 图片估算额）。 |
| `ContextTokenEstimate` | `150-159` | `{ tokens: number; usageTokens: number; trailingTokens: number; lastUsageIndex: number \| null }`：触发估算器返回的可诊断结构。 |
| `CompactionDetails` | `245-257` | `{ firstKeptMessageId: string; tokensBefore: number; model?: string; at: string }`：挂载在压缩标记 `details` 上的元数据（仅供 UI 切口定位与详情查看，不发给模型）。 |

---

### 1.3 导出函数与核心内部算法精讲

#### `calculateContextTokens(usage)`（`src/core/compaction.ts:68-79`）

* **① 签名与职责定位**：`export function calculateContextTokens(usage: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): number` · `[纯函数]` · 从单条模型回复的 `usage` 对象提取该次请求实际承载的总上下文 Token 数。
* **② 输入、输出与核心不变量**：优先取非零 `usage.totalTokens`，缺省或为 `0` 时累加 `(input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)`（Pi 已将输入拆分为互不重叠的新鲜输入与缓存读/写桶）。
* **③ 核心逻辑与分支逐步推导**：单表达式短路求值 `usage.totalTokens || (...)`。
* **④ 边界条件与历史事故背景**：供触发估算器读取锚点使用（注意：顶栏仪表盘 `measuredContextTokens` 刻意不使用 `totalTokens` 覆盖，见下文 §2）。
* **⑤ 上游调用方与系统接线**：由本文件 `lastAssistantUsageIndex`（`144`）与 `estimateContextTokens`（`176`）调用。

---

#### `estimateMessageTokens(message)` 与 `estimateTokens(messages)`（`src/core/compaction.ts:86-124, 184-188`）

* **① 签名与职责定位**：
  * `export function estimateMessageTokens(message: LhMessage | AgentMessage): number`（`86-110`）· `[纯函数]` · 估算单条消息的模型可见 Token 数。
  * `export function estimateTokens(messages: readonly (LhMessage | AgentMessage)[]): number`（`184-188`）· `[纯函数]` · 对消息列表逐条累加 `estimateMessageTokens`。
* **② 输入、输出与核心不变量**：**严禁整条消息 `JSON.stringify(message)` 不变量**——只统计真正发往模型的文本、可见思考块、工具名+参数 JSON、系统分段以及图片固定配额，最后执行 `Math.ceil(chars / 4)`。
* **③ 核心逻辑与分支逐步推导**：
  1. 若 `role === "assistant"`：遍历 `content` 数组，`"text"` 累加 `block.text.length`，`"thinking"` 累加 `block.thinking.length`，`"toolCall"` 累加 `name.length + JSON.stringify(arguments ?? {}).length`（自动忽略加密签名 `thinkingSignature` 等无关元数据）。
  2. 其他角色：调用私有辅助 `textCharsOfContent(content)`（`115-124`）统计字符串或文本块长度，每个 `"image"` 块固定加 `4_800` 字符；若 `role === "system"` 额外加上 `sections` 与 `toolsAdded` 长度。
  3. 返回 `Math.ceil(chars / 4)`。
* **④ 边界条件与历史事故背景**：**2026-10-05 关系型数据库会话误压缩事故**：早期直接对整条持久化消息执行 `JSON.stringify(m).length / 4`，结果消息 ID、`usage`、转义反斜杠与应用侧 `details` 把真实约 30k Token 的会话虚高估成了 84k，在 80k 阈值下过早触发了不必要的上下文压缩。改用内容精准提取后彻底根除 3 倍膨胀。
* **⑤ 上游调用方与系统接线**：`estimateContextTokens`（`172, 178`）与 `compactionCutIndex`（`223`）。

---

#### `lastAssistantUsageIndex(messages)` 与 `estimateContextTokens(messages)`（`src/core/compaction.ts:135-181`）

* **① 签名与职责定位**：
  * `export function lastAssistantUsageIndex(messages: readonly (LhMessage | AgentMessage)[]): number | null`（`135-148`）· `[纯函数]` · 倒序定位最新一条携带有效 provider `usage` 的 `assistant` 消息下标。
  * `export function estimateContextTokens(messages: readonly (LhMessage | AgentMessage)[]): ContextTokenEstimate`（`167-181`）· `[纯函数]` · **触发法则（Trigger Law）核心实现**：计算下一次请求前会话的预测上下文大小。
* **② 输入、输出与核心不变量**：
  * **跨压缩锚点失效不变量**：`lastAssistantUsageIndex` 从尾部向前扫描时，一旦先撞上 `role === "custom" && customType === "compaction"`，**立即返回 `null`**！因为压缩标记之前的 `usage` 描述的是压缩前的巨型上下文，绝不能用来代表压缩后的【摘要 + 20k 尾部】。
  * **跳过残次回复不变量**：`stopReason === "aborted"`、`"error"` 或计算出的 Token 总数为 `0` 的回复一律跳过，绝不作为锚点。
* **③ 核心逻辑与分支逐步推导**：
  1. `lastAssistantUsageIndex` 倒扫找到合法锚点下标 `anchor`（找不到则为 `null`）。
  2. 在 `estimateContextTokens` 中：若 `anchor === null`，对全部消息累加 `estimateMessageTokens`，返回 `{ tokens: trailing, usageTokens: 0, trailingTokens: trailing, lastUsageIndex: null }`；
  3. 若找到 `anchor`，取 `usageTokens = calculateContextTokens(anchored.usage)`，仅对 `anchor + 1 .. messages.length - 1` 的新增尾部消息累加 `estimateMessageTokens`，返回总和 `usageTokens + trailing`。
* **④ 边界条件与历史事故背景**：真实 provider `usage` 天然包含了系统提示词、工具 Schema 声明与模型自身分词器密度，比任何本地 `chars/4` 都准；本地启发式只负责弥补“最后一次回复之后刚追加的用户答案或后台结果”。
* **⑤ 上游调用方与系统接线**：`src/server/compaction.ts:165`（决定是否启动压缩及写入 `tokensBefore`）。

---

#### `compactionCutIndex(messages, keepRecentTokens)`（`src/core/compaction.ts:209-239`）

* **① 签名与职责定位**：`export function compactionCutIndex(messages: readonly LhMessage[], keepRecentTokens = KEEP_RECENT_TOKENS): number` · `[纯函数]` · 计算本次上下文压缩应当从哪一个消息下标开始保留原文（返回首个保留消息在 `messages` 中的下标）。
* **② 输入、输出与核心不变量**：
  1. **单调前进不变量**：搜索起点 `start = Math.max(0, previousKept)`，绝不回退到上一次有效压缩切口之前。
  2. **禁止在 `toolResult` 处下刀不变量**：合法切点候选集 `points` **只允许包含模型可见的 `user`、`assistant` 或可见 `custom` 消息**，绝不允许把一条 `toolResult` 作为保留区间的第一条消息（否则它的前置 `assistant` `toolCall` 被切进摘要，大模型 API 会因孤立 `toolResult` 直接报 400 协议错误！）。
  3. **超大尾部兜底不变量**：如果末尾一连串巨型 `toolResult` 本身就已经超过 `20,000` Token，切点会落在它们前面的那条 `assistant` 调用上（当后面没有更新的合法切点时回退到 `points.at(-1)!`），既不切断调用对，也不会退化成保留整个会话。
* **③ 核心逻辑与分支逐步推导**：
  1. 查找当前生效的 `previous = activeCompactionOf(messages)` 及其切口下标 `previousKept`，令 `start = Math.max(0, previousKept)`。
  2. 正向遍历 `start .. messages.length - 1`：通过私有辅助 `cutMessage`（`195-199`，过滤掉 `"compaction"`、`"plan-block"`、`"problem-dismissed"` 三种非上下文标记）收集所有角色为 `user | assistant | custom` 的下标进入 `points`；若 `points` 为空直接返回 `start`。
  3. 默认令 `cut = points[0]!`，从末尾 `messages.length - 1` 倒序向 `start` 累加 `estimateMessageTokens`：一旦 `accumulated >= keepRecentTokens`，在 `points` 中查找**第一个 `>= i` 的合法候选点**（若 `i` 落在尾部 `toolResult` 上且后面已无候选点，则取 `points.at(-1)!` 即发起该调用的 `assistant`），随即 `break`。
  4. **回退吸附相邻无上下文元数据（`232-237`）**：若 `cut - 1` 是紧挨着的 `plan-block` 或 `problem-dismissed`（`!cutMessage(before)` 且不是旧 `"compaction"` 标记），将 `cut` 左移把它们一并保留在切口内，避免丢失紧邻 UI 标记。
* **④ 边界条件与历史事故背景**：与 `@earendil-works/pi-coding-agent` 1.4.0 的原生黄金测试集（`tests/compaction-native-parity.test.ts`）保持逐例对齐。若返回 `cut <= start`（没有切掉任何活跃历史），调用方 `src/server/compaction.ts` 将直接放弃启动摘要器。
* **⑤ 上游调用方与系统接线**：`src/server/compaction.ts:183`。

---

#### `newCompactionMarker`、`activeCompactionOf` 与 `keptIndexFor`（`src/core/compaction.ts:263-303`）

* **① 签名与职责定位**：
  * `export function newCompactionMarker(summary: string, details: CompactionDetails): LhMarkerMessage`（`263-273`）· `[纯逻辑 + 新 ID/时间戳]` · 组装带统一标题前缀 `COMPACTED_HISTORY_HEADER` 的压缩标记消息。
  * `export function activeCompactionOf(messages: readonly LhMessage[]): (LhMarkerMessage & { details: CompactionDetails }) | null`（`278-290`）· `[纯函数]` · 倒序查找最新一条合法生效的压缩标记。
  * `export function keptIndexFor(messages: readonly LhMessage[], marker: LhMarkerMessage & { details: CompactionDetails }): number`（`296-302`）· `[纯函数]` · 在 `messages` 中查找 `marker.details.firstKeptMessageId` 对应的数组下标，找不到返回 `-1`。
* **② 输入、输出与核心不变量**：新的上下文压缩生成的摘要完全取代旧摘要；若记录损坏导致 `firstKeptMessageId` 找不到（返回 `-1`），下游 `toLlmMessages` 会安全退化为发送完整历史而绝不抛异常。
* **③ 核心逻辑与分支逐步推导**：`activeCompactionOf` 从后向前找第一个 `role === "custom" && customType === "compaction"` 且 `typeof details.firstKeptMessageId === "string"` 的元素；`keptIndexFor` 正向线性匹配 `id`。
* **④ 边界条件与历史事故背景**：压缩标记追加在数组末尾（代表压缩发生的时间点），而它指向的 `firstKeptMessageId` 位于历史深处（代表上下文切口），两处位置分离使得 `view.ts` 能同时渲染切口提示线与时间点 `moment_divider`。
* **⑤ 上游调用方与系统接线**：`src/core/native-messages.ts:592-596`（`toLlmMessages` 裁剪模型输入）、`src/core/view.ts:165`、`src/server/compaction.ts:188, 240`。

---

#### `serializeForSummary`、`planTreeToText` 与 `buildCompactionPrompt`（`src/core/compaction.ts:309-406`）

* **① 签名与职责定位**：
  * `export function serializeForSummary(messages: readonly LhMessage[]): string`（`309-342`）· `[纯函数]` · 将被切掉的历史消息片段序列化为带 `[LEARNER]` / `[TUTOR]` / `[RESULT ...]` / `[SYSTEM NOTE]` 标签的纯文本。
  * `export function planTreeToText(tree: PlanTree | undefined, messages: readonly LhMessage[]): string | null`（`348-362`）· `[纯函数]` · 将会话当前的计划依赖树连同派生出的节点状态（`current` / `visited` / `upcoming`）渲染为逐字保留的 Markdown 列表。
  * `export function buildCompactionPrompt(input: { spanText: string; planTreeText: string | null; kind: "teach" | "practice" | "probe" }): string`（`373-406`）· `[纯函数]` · 构造发给当前会话模型自写摘要的完整教学压缩提示词。
* **② 输入、输出与核心不变量**：
  1. **剥离内部思考草稿**：`serializeForSummary` 在序列化 `assistant` 时只保留 `"text"` 与 `"toolCall"`，跳过模型私有的 `"thinking"` 块以节省摘要输入并过滤噪声；`toolResult` 超过 `2,000` 字符自动截断并附 `…[truncated]`；`plan-block` 纯 UI 标记直接跳过。
  2. **四段式教学连续性硬契约**：`buildCompactionPrompt` 强制要求按固定顺序输出四节：`## The learner's understanding`（权重最高：答题表现、置信度、已暴露及未消除的误解）→ `## The teaching arc` → `## The plan dependency tree`（原样照抄 `planTreeText`，绝不因 `plan_init` 落在切口前而丢失计划树！）→ `## The current moment`（切口当刻悬空的题目或承诺），并严令保留精确 ID、禁止寒暄夸奖或脑补。
* **③ 核心逻辑与分支逐步推导**：`planTreeToText` 先调 `derivePlanStatusesLh(tree, messages)` 算出每个节点的实时派生状态，输出 `- [status] title (id) — summary` 及所有边 `- fromTitle → toTitle (fromId → toId)`；`buildCompactionPrompt` 将其与 `spanText` 拼入模板。
* **④ 边界条件与历史事故背景**：若直接复用通用编程 Agent 的压缩提示词，模型会丢掉学习者的心智模型细节与早期的 `plan_init` 树结构，导致压缩后教师瞬间“失忆”重教已懂内容或用错 `nodeId`。
* **⑤ 上游调用方与系统接线**：`src/server/compaction.ts:217-222`。

---

### 1.4 轻量私有辅助函数归并表

| 函数名 | 行号 | 纯度 | 作用与调用归属 |
|---|---|---|---|
| `textCharsOfContent` | `115-124` | `[纯函数]` | 统计非 `assistant` 消息内容的文本字符数及图片固定折算字符数（`4800`/张），供 `estimateMessageTokens` 使用。 |
| `cutMessage` | `195-199` | `[纯函数]` | 过滤 `"compaction"`、`"plan-block"`、`"problem-dismissed"` 三类不占模型上下文的标记消息，供 `compactionCutIndex` 使用。 |

---

## 2. `src/core/context-usage.ts`（27 行）

### 2.1 模块定位与纯度边界

* **设计目的**：为会话顶栏仪表盘（`components/stats-bar.tsx`）提供**最近一次已完成对话回复的真实上下文 Token 读数**，严格区别于下一轮压缩估算值。
* **桶导出状态**：由 `src/core/index.ts:63` 全量导出。
* **纯度边界**：单函数模块，**100% 严格确定性纯函数**。

### 2.2 导出函数精讲

#### `measuredContextTokens(messages, incompleteIds)`（`src/core/context-usage.ts:9-26`）

* **① 签名与职责定位**：`export function measuredContextTokens(messages: readonly LhMessage[], incompleteIds: ReadonlySet<string> = new Set()): number | null` · `[纯函数]` · 倒序扫描获取最新已完成对话回复的实测上下文大小。
* **② 输入、输出与核心不变量**：
  1. **压缩立即失效**：倒扫先遇到 `customType === "compaction"` 立即返回 `null`（UI 展示 `? / 最大窗口`，直到压缩后完成一次新回复）。
  2. **流式半成品排除**：凡在 `incompleteIds`（尚未收到 `message_end` 的流式消息槽位）中，或 `stopReason` 不属于 `["stop", "length", "toolUse"]`（即排除 `"error"` 与 `"aborted"`）的消息一律跳过。
  3. **严禁使用 `totalTokens` 覆盖**：固定累加 `[usage.input, usage.output, usage.cacheRead, usage.cacheWrite]`（推理 Token 已包含在 `output` 内），任一桶非有限数、小于 `0` 或四桶总和 `<= 0`（全零占位 usage）均跳过。
* **③ 核心逻辑与分支逐步推导**：单次从尾到头的 `for` 循环，依次过压缩门、角色与 `incompleteIds` 门、`stopReason` 白名单门、四桶非负有限校验门，返回首个 `tokens > 0` 的求和值；全未命中返回 `null`。
* **④ 边界条件与历史事故背景**：防止流式传输中途的全零/半截 usage 或用户按下中止后的残缺 usage 冲掉上一次真实有效的窗口读数（见 `docs/compaction-accounting.md` §Conversation meter）。
* **⑤ 上游调用方与系统接线**：`components/session-core.ts:309`。

---

## 3. `src/core/prices.ts`（103 行）

### 3.1 模块定位与纯度边界

* **设计目的**（`src/core/prices.ts:1-2`）：提供客户端与服务端共用的纯记账折叠函数。实际费率表与 `calculateCost` 留在服务端（`src/server/pricing.ts`），本模块通过函数参数 `price: CallPricer` 注入单步计价器，实现彻底解耦。
* **桶导出状态**：由 `src/core/index.ts:64` 全量导出。
* **纯度边界**：全部 9 个导出函数均为 **100% 严格确定性纯函数**。

### 3.2 核心类型契约

* `CallPricer`（`6`）：`(usage: Partial<CallUsage>, model: string) => number | null`——能够精确计价时返回美元数，无法计价（未知模型、CLI、自定义端点或缺失阶梯/缓存拆分细节）时返回 `null`。
* `SessionPricing`（`7-14`）：`{ cost: number; unpriced: number; subscription?: number; subscriptionProviders?: string[]; turnCosts: Record<string, number | null> }`——会话总花费派生结果。

### 3.3 导出函数精讲

#### 订阅模型识别组：`isChatGPTPlan` · `subscriptionLabel` · `isSubscriptionModel` · `subscriptionLabels`（`src/core/prices.ts:16-26`）

* **① 签名与职责定位**：
  * `isChatGPTPlan(model: string | undefined): boolean`（`16-18`）：检查前缀 `"chatgpt:"`。
  * `subscriptionLabel(model: string | undefined): string | undefined`（`19-22`）：匹配 `"chatgpt:"` 返回 `"ChatGPT"`，或匹配 `NATIVE_SUBSCRIPTIONS`（如 GitHub Copilot / Grok 的逻辑 provider 前缀 `${logicalId}:`）返回对应展示名。
  * `isSubscriptionModel(model: string | undefined): boolean`（`23`）：`subscriptionLabel(model) !== undefined`。
  * `subscriptionLabels(models: readonly (string | undefined)[]): string[]`（`24-26`）：提取并按首次出现顺序用 `Set` 去重全部订阅提供商名称。
* **② 输入、输出与核心不变量**：**只认逻辑连接前缀，绝不按模型名字猜测**！例如经 OpenRouter 调 `openai/gpt-4o` 是 API 计费，只有经内置订阅连接路由（`chatgpt:...`）才识别为订阅计划使用。
* **③–⑤ 调用接线**：广泛用于 `src/server/pricing.ts:16`、`components/stats-bar.tsx:112, 204`、`components/activity-dock.tsx:355, 430`、`components/settings/model-menu.tsx:88-93`。

---

#### `sumSteps(steps)`（`src/core/prices.ts:30-42`）

* **① 签名与职责定位**：`export function sumSteps(steps: readonly CallUsage[]): CallUsage` · `[纯函数]` · 将多次模型调用的 Token 明细安全汇总为一个聚合 `CallUsage`。
* **② 输入、输出与核心不变量**：
  1. **全缺省保持 `undefined`**：辅助函数 `sumIfAny` 规定，若某字段在所有 step 中均为 `undefined`（例如空列表或旧记录无该字段），结果保持 `undefined` 而非伪造 `0`。
  2. **1 小时缓存写入精度传染律（关键不变量！）**：对于 `cacheWrite1hTokens`，只要存在**任何一个**产生了缓存写入（`cacheWriteTokens > 0`）但 `cacheWrite1hTokens === undefined` 的旧记录步骤，整个聚合结果的 `cacheWrite1hTokens` 强制置为 `undefined`！绝不允许把缺失的拆分细节静默当成 `0`（在 Anthropic 上 5 分钟缓存写入是 `1.25×`，1 小时是 `2×`，当成 `0` 会算错账单）。
* **③–⑤ 调用接线**：供 `src/core/cost-summary.ts:111, 160` 汇总图谱抽取阶段 Token 使用。

---

#### `sessionCacheHitRate(record)`（`src/core/prices.ts:50-65`）

* **① 签名与职责定位**：`export function sessionCacheHitRate(record: Pick<ChatRecord, "turns">): number | null` · `[纯函数]` · 计算整场会话已观测到的提示词缓存命中率。
* **② 输入、输出与核心不变量**：
  * **按总提示词 Token 加权，绝不按调用次数简单平均**；
  * 分母为 `inputTokens + cacheReadTokens + cacheWriteTokens`（Pi 的 `inputTokens` 是扣除读写缓存后的纯新增输入，`cacheWrite1hTokens` 是 `cacheWriteTokens` 的子集，因此只加一次 `cacheWriteTokens`）；
  * 任何一步缺少 `inputTokens` 或出现负数/非有限数，立即返回 `null`；若整场会话 `cacheReadTokens === 0`（尚未发生任何正缓存读取），也返回 `null`（UI 隐藏百分比，不把未开缓存渲染成 0% 命中率）。
* **③–⑤ 调用接线**：`components/stats-bar.tsx:107`。

---

#### `turnCost`、`sessionCost` 与 `jobCost`（`src/core/prices.ts:67-103`）

* **① 签名与职责定位**：
  * `export function turnCost(turn: Pick<TurnUsage, "model" | "steps">, price: CallPricer): number | null`（`67-76`）· `[纯函数]`
  * `export function sessionCost(record: Pick<ChatRecord, "turns">, price: CallPricer): SessionPricing`（`78-91`）· `[纯函数]`
  * `export function jobCost(job: Pick<JobRecord, "usage">, price: CallPricer): number | null`（`93-103`）· `[纯函数]`
* **② 输入、输出与核心不变量**：
  * **全有或全无（All-or-Nothing）单回合/单任务计价**：在 `turnCost` 中，若为订阅模型或 `steps` 为空返回 `null`；遍历每一步调用 `price(step, turn.model)`，**只要其中任何一步返回 `null`，整轮回合立刻返回 `null`**（绝不给出残缺的部分和误导用户）。
  * **三路分流统计**：`sessionCost` 遍历所有回合，订阅模型计入 `subscription++`，非订阅但 `dollars === null` 的计入 `unpriced++`，其余精确累加到 `cost` 并记录每轮 `turnCosts[turn.id]`。
  * **历史多步后台任务阶梯价保护**：`jobCost` 若发现新格式保存了逐次调用明细（`usage.calls.length === usage.steps`），直接委托 `turnCost` 逐次精确计价；若是只有汇总 Token 的旧格式任务，则交给服务端 `price(usage, usage.model)` 裁决（服务端对平价模型可直接算，对按单次请求大小阶梯计价的模型若 `steps > 1` 则诚实返回 `null`）。
* **③–⑤ 调用接线**：由 `src/server/pricing.ts:42-49` 注入真实 Pi 目录计价器后封装导出，供 `app/api/chats/[id]/route.ts:20` 与 `src/server/observability.ts:82` 调用。

---

## 4. `src/core/cost-summary.ts`（192 行）

### 4.1 模块定位与纯度边界

* **设计目的**（`src/core/cost-summary.ts:1-18`）：将知识图谱两条前门——教学会话自动/手动抽取（`ChatRecord.extractions`）与笔记导入抽取（`NotesSource.extractions`）——的运行日志折叠为图谱页右上角成本胶囊（cost pill）所需的分阶段汇总（`extraction` 抽取阶段 + `audit` 审计阶段）与最近运行列表。
* **桶导出状态**：由 `src/core/index.ts:65` 全量导出。
* **纯度边界**：全文件 **100% 严格确定性纯函数**。

### 4.2 核心接口契约

* `StageCost`（`24-36`）：单阶段（`extraction` 或 `audit`）累计指标——`dollars`（已计价运行总美元）、`unpricedRuns`（无法计价的阶段运行次数）、`subscriptionRuns` / `subscriptionProviders`、`runs`（总运行次数）、`tokens: CallUsage`。
* `RecentRun`（`39-55`）：单次抽取运行摘要，含 `startedAt`、`durationMs`、`title`（会话标题或笔记文件路径）、`dollars`（仅当抽取与审计**两个阶段全都无法计价**时才为 `null`）、`tokens`、`merged?: EmissionStats`。
* `GraphCostSummary`（`58-75`）与 `CostSummaryInput`（`78-84`）：汇总输出与双前门输入结构（已淘汰早期的 `embedding` 与 `cluster naming` 阶段，遵循 2026-09-23/24 所有者裁定）。

### 4.3 导出函数与内部算法精讲

#### `graphCostSummary(input, price)`（`src/core/cost-summary.ts:124-191`）

* **① 签名与职责定位**：`export function graphCostSummary(input: CostSummaryInput, price: CallPricer): GraphCostSummary` · `[纯函数]` · 折叠全部会话与导入源的图谱抽取成本与 Token 账本。
* **② 输入、输出与核心不变量**：
  1. **Token 永远累加，美元严格按阶段诚实分流**：即使某个阶段的模型无法计价，其消耗的 Token 依然通过 `mergeTokens` 计入总 Token；美元仅累加已知 API 费率阶段。
  2. **1h 缓存未知态跨运行保留**：私有辅助 `mergeTokens`（`110-120`）在累加 `cacheWriteTokens` **之前**，先用 `sumSteps([into, summed]).cacheWrite1hTokens` 更新 1 小时缓存字段——这保证了只要历史上有一次写缓存缺少 1h 拆分，后续即使来了新数据，总账的 `cacheWrite1hTokens` 依然诚实保持 `undefined`。
  3. **整次运行的 `unpricedRuns` 判定（`182`）**：一次包含 `extractor + auditor` 两阶段的运行，仅当 `r.dollars === null` 且 `(r.subscriptionRuns ?? 0) < 2`（即既没有任何可计价阶段，也不全是订阅阶段，确实存在至少一个未知计费阶段）时，才计入顶层 `unpricedRuns`。
* **③ 核心逻辑与分支逐步推导**：
  1. 初始化空的 `extraction` 与 `audit` 两个 `StageCost` 桶及 `runs` 数组。
  2. 定义内部闭包 `foldExtractionRun(run, title)`：分别对 `stages.extractor` 和 `stages.auditor` 递增 `runs`、调用 `mergeTokens` 合并 Token、调用 `stageDollars`（`98-107`，逻辑与 `turnCost` 完全一致）计算美元，按订阅 / `null`（`unpricedRuns++`） / 正常美元三路归入各自阶段桶；随后合成单条 `RecentRun` 推入 `runs`。
  3. 依次遍历 `input.chats` 与 `input.sources` 中的所有 `extractions` 执行折叠。
  4. 将 `runs` 按 `b.startedAt - a.startedAt` 降序排列，截取前 `input.recentCap ?? 10` 条。
  5. 汇总顶层 `totalDollars = extraction.dollars + audit.dollars`、`unpricedRuns` 与订阅标签后返回。
* **④ 边界条件与历史事故背景**：若早期旧记录缺失 `run.stages`，第 `130` 行安全回退为 `{ extractor: { model: "unknown", steps: [] }, auditor: { model: "unknown", steps: [] } }`，确保零崩溃并自动归入 `unpricedRuns`。
* **⑤ 上游调用方与系统接线**：`src/server/graph.ts:47`（响应 `GET /api/graph/costs`）。

### 4.4 轻量私有辅助函数归并表

| 函数名 | 行号 | 纯度 | 作用与调用归属 |
|---|---|---|---|
| `emptyStage` | `94` | `[纯函数]` | 创建初始全 `undefined` Token 桶的空 `StageCost` 对象。 |
| `stageDollars` | `98-107` | `[纯函数]` | 计算单个阶段所有步骤的总美元花费（订阅模型或空步骤返回 `null`，任一步 `null` 则整阶段返回 `null`）。 |
| `mergeTokens` | `110-120` | `[纯逻辑]` | 将单阶段步骤集合的 Token 累加进局部 `StageCost.tokens`，并严格保持 `cacheWrite1hTokens` 的缺失传染语义。 |
