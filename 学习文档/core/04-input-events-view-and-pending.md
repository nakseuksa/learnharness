# 第 04 卷：输入事件折叠、浏览器视图投影与待答问题闸门

> **覆盖源码文件**：`src/core/input-events.ts`（345 行） · `src/core/view.ts`（490 行） · `src/core/pending.ts`（196 行）  
> **合计行数**：1,031 行 | **桶导出状态**：3 个文件均全量导出于 `src/core/index.ts`（浏览器安全，无 Node 依赖）  
> **纯度概览**：除消息构造辅助函数生成随机消息 ID 与当前毫秒时间戳外，全部解析、投影、折叠、扫描逻辑均为 **100% 无副作用纯函数**。

---

## 本卷导读与闭环协作关系

本卷的三个模块共同构成了 **“浏览器交互 ⇄ 服务端持久化 `LhMessage[]`”** 的双向闭环：

```text
[学习者操作（输入框 / 答题 dock / ESC 跳过 / 插纸条 / 失败重试）]
       │
       ▼  1. 解析与合法性门禁（input-events.ts）
parseChatInput / parseDismissInput / parseUserSteerInput
       │
       ▼  2. 事件 → 原生追加项折叠（input-events.ts）
inputAppends / dismissAppends / retryDrops  ──(write-ahead 预写)──▶  ChatRecord.messages: LhMessage[]
                                                                             │
       ┌─────────────────────────────────────────────────────────────────────┘
       ▼  3. 原生记录 (+ 进行中回合状态 LiveTurnState) → 视图投影（view.ts）
projectView(messages, live)  ──▶  LhViewMessage[]（连续文档块、计划块内联拼接、工具状态机）
       │
       ▼  4. 双层权威对齐的待答问题闸门（pending.ts × native-messages.ts）
findPendingToolCall(viewMessages, pendingQuestionOf(nativeMessages))
       │
       ▼
[挂载 QuestionDock 或开放输入框 composer，进入下一轮循环]
```

**为什么要把 `pending.ts`（视图层扫描）和 `native-messages.ts`（原生记录层扫描）分成两层并同时校验？**  
因为原生记录决定了**业务上哪道题真正未答**（`pendingQuestionOf`），但浏览器渲染时，一道正在通过 SSE 事件流传输的题目可能尚未跨过服务端参数校验边界（`tool_execution_end`），在视图层仍处于 `input-streaming` 状态，或者在校验失败后处于 `output-error` 状态。如果仅凭原生记录就挂载答题 dock，损坏或半成品的题目参数会直接把前端组件炸崩。因此 `components/chat.tsx:453` 要求**原生层权威指针与视图层 `input-available` 部件精确命中同一个调用实例**，答题 dock 才会真正打开。

---

## 1. `src/core/input-events.ts`（345 行）

### 1.1 模块定位与纯度边界

* **设计目的**（`src/core/input-events.ts:1-31`）：彻底废除客户端提交完整消息列表的旧契约（Wave B，2026-09-26 所有者裁定）。服务端独占持久化写权，`POST /api/chat`（及周边的 `/dismiss`、`/steer` 路由）只接收**单个显式输入事件**。当请求因 409 回合冲突或 503 缺模型被拒时，持久化未发生任何追加，客户端无需做消息合并，直接幂等重发原事件即可。
* **桶导出状态**：由 `src/core/index.ts:27` 全量导出（`export * from "./input-events.ts"`）。
* **纯度边界**：
  * `parseChatInput`、`parseDismissInput`、`parseUserSteerInput`、`failedResponseAtEnd`、`endsInFailedTurn`、`retryDrops`、`failedTail`、`isQuestionTool` 为**严格确定性纯函数**。
  * `inputAppends`、`dismissAppends`、`questionRecoveryAppends`、`dismissalConclusion` **无任何外部状态读写与 I/O 副作用**，但内部在构造新 `LhMessage` 时会调用 `newMessageId()` 与 `Date.now()` 生成新消息 ID 与时间戳（结构与业务语义完全确定）。

### 1.2 核心类型与异常契约

| 类型 / 类名 | 行号 | 结构与业务不变量说明 |
|---|---|---|
| `ChatInput` | `49-67` | 客户端发起、**会启动一个新回合（`turn`）**的 7 种输入事件联合类型：<br>1. `{ type: "text"; text: string }`：普通文本发送（含首条开场消息、计划确认回复等）。<br>2. `{ type: "answer"; toolCallId: string; answer: QuestionAnswerData }`：答题 dock 提交的已判分/已填写答案。<br>3. `{ type: "continue" }`：挂载续跑（记录末尾已是回答完的题目但尚无教师反应时触发）。<br>4. `{ type: "retry" }`：失败重试（issue #110，不追加新输入，仅临时剥离尾部报错的 assistant 消息重跑）。<br>5. `{ type: "retry-question"; messageId: string; contentIndex: number; toolCallId: string }`：显式替换当前损坏的题目批次。<br>6. `{ type: "thinking"; problemCallId: string; text: string }`：练习会话中针对当前活动题提交思考草稿或声称答案（一道题可跨多回合提交多次）。<br>7. `{ type: "next" }`：练习会话在题目收尾后的停顿期明确发出“下一题”推进信号。 |
| `SteerInput` | `73` | `{ type: "steers"; steers: LhMessage[] }`：服务端唤醒流水线（`idle wake`）在会话空闲时携带全部待投递标记消息进入 `handleChatInput` 的内部输入类型。 |
| `TurnInput` | `76` | `ChatInput \| SteerInput`：回合组合根 `handleChatInput` 接受的完整输入联合，保证客户端请求与服务端后台唤醒复用同一套 `write-ahead`（预写）与回合活性登记流程。 |
| `DismissInput` | `84-89` | **绝不启动新回合**的静默丢弃事件联合：<br>• `{ type: "dismiss"; toolCallId: string; answer: QuestionAnswerData }`：跳过待答问题（要求 `answer.dismissed === true`）。<br>• `{ type: "dismiss-problem"; problemCallId: string }`：练习会话丢弃当前活动题（先写 UI 标记，合成 `conclude` 对延迟至学习者下次输入时捎带）。 |
| `UserSteerInput` | `122` | `{ type: "steer"; id: string; text: string }`：回合运行途中的插纸条输入。`id` 由客户端预先生成（`steer_<localid>`），排入 Pi 的 steering rail 在同一回合的下一响应边界消化，绝不自成回合。 |
| `ChatInputError` | `160` | 继承自 `Error` 的语义校验异常类。路由层捕获后统一映射为诚实的 HTTP `400` 响应（“孤儿 400 纪律”）。 |

---

### 1.3 导出函数与核心内部算法精讲

#### `parseDismissInput(input)`（`src/core/input-events.ts:92-112`）

* **① 签名与职责定位**：`export function parseDismissInput(input: unknown): DismissInput` · `[纯函数]` · 解析并校验静默丢弃请求体中的 `input` 字段。
* **② 输入、输出与核心不变量**：接收未知 JSON 值，合法时返回强类型 `DismissInput`，非法时抛出 `ChatInputError`。**安全不变量**：严禁任何非丢弃态的正常答案（`answer.dismissed !== true`）混入静默丢弃通道（否则学习者答了题却不会唤醒教师回合）。
* **③ 核心逻辑与分支逐步推导**：
  1. 非非空对象直接抛 `ChatInputError("input must be an object")`。
  2. 分支 `i.type === "dismiss-problem"`：校验 `problemCallId` 为非空字符串后返回 `{ type: "dismiss-problem", problemCallId }`。
  3. 若 `i.type !== "dismiss"`，抛出未知类型错误。
  4. 校验 `toolCallId` 非空字符串、`answer` 为非空对象，且**严格断言 `answer.dismissed === true`**（第 `108` 行），全部通过后返回。
* **④ 边界条件与历史事故背景**：2026-10-03 "A2" 设计裁定：如果允许普通 `answer` 走静默路由，题目会被标为已答但永远不触发反应回合；此处的 `answer.dismissed !== true` 守卫从边界上封死了误用可能。
* **⑤ 上游调用方与系统接线**：`app/api/chats/[id]/dismiss/route.ts:35`（处理 `POST /api/chats/:id/dismiss`）。

---

#### `parseUserSteerInput(input)`（`src/core/input-events.ts:125-137`）

* **① 签名与职责定位**：`export function parseUserSteerInput(input: unknown): UserSteerInput` · `[纯函数]` · 解析并校验运行中回合的插纸条请求体。
* **② 输入、输出与核心不变量**：要求必须同时具备非空客户端预生成 `id` 与 `trim()` 后非空的 `text`。
* **③ 核心逻辑与分支逐步推导**：依次检查非空对象 → `i.type === "steer"` → `typeof i.id === "string" && i.id.length > 0` → `typeof i.text === "string" && i.text.trim().length > 0`，返回 `{ type: "steer", id: i.id, text: i.text }`（注意保留原始 `i.text`，仅用 `trim()` 判空）。
* **④ 边界条件与历史事故背景**：客户端必须自带 `id`，以便前端排队指示器（queued steers UI）与后续 SSE 事件流消费该插纸条后推送的真实卡片按同一 `id` 原地对齐替换，避免消息闪烁或重复。
* **⑤ 上游调用方与系统接线**：`app/api/chats/[id]/steer/route.ts:22`。

---

#### `dismissAppends(record, input)`（`src/core/input-events.ts:141-157`）

* **① 签名与职责定位**：`export function dismissAppends(record: { messages: LhMessage[] }, input: DismissInput): LhMessage[]` · `[纯逻辑 + 新消息 ID/时间戳]` · 计算一次静默丢弃事件需要向持久化追加的 `LhMessage` 数组。
* **② 输入、输出与核心不变量**：**孤儿拦截不变量**——丢弃目标必须是当前记录中真正处于悬空待答的题目或当前活动的练习题；题型 `kind` 必须与被丢弃工具严格匹配。
* **③ 核心逻辑与分支逐步推导**：
  1. 若 `input.type === "dismiss-problem"`：调用 `activeProblemOf(record.messages)` 查找当前活动练习题；若不存在或 `active.toolCallId !== input.problemCallId`，抛 `ChatInputError`；否则返回单元素数组 `[newProblemDismissedMarker(input.problemCallId)]`。
  2. 若为普通问题丢弃：调用 `danglingQuestionOf(record.messages)` 查找当前首个未决问题；若不存在或 `pending.toolCallId !== input.toolCallId`，抛 `ChatInputError`。
  3. 校验 `input.answer.kind === toolQuestionKind(pending.tool)`（例如不能拿 `"ask"` 形状的丢弃对象去关掉 `"quiz"` 调用），通过后返回 `[newAnswerResult(input.toolCallId, pending.tool, input.answer)]`。
* **④ 边界条件与历史事故背景**：多道并列题目（parallel question calls）各自独立发送 `dismiss` 事件；由于每次追加后 `danglingQuestionOf` 会自然推进到下一道未决题，逐个丢弃保持严格有序且幂等拒绝重复提交。
* **⑤ 上游调用方与系统接线**：
  * `app/api/chats/[id]/dismiss/route.ts:54`（回合空闲时直接落盘）；
  * `src/server/dismissal-park.ts:73`（回合运行途中被丢弃暂存接住，待回合收尾落盘后回放执行同一函数）。

---

#### `parseChatInput(input)`（`src/core/input-events.ts:163-204`）

* **① 签名与职责定位**：`export function parseChatInput(input: unknown): ChatInput` · `[纯函数]` · 解析并结构化校验 `POST /api/chat` 的 7 种客户端输入事件。
* **② 输入、输出与核心不变量**：只做与持久化无关的**报文结构校验**（字段类型、非空文本、非负安全整数下标等），不触碰磁盘记录。
* **③ 核心逻辑与分支逐步推导**：
  * `"text"`：要求 `text` 为字符串且 `trim().length > 0`。
  * `"answer"`：要求 `toolCallId` 非空字符串且 `answer` 为非空对象。
  * `"continue"` / `"retry"`：无额外载荷，直接返回字面量对象。
  * `"retry-question"`：要求 `messageId`、`toolCallId` 非空字符串，且 `contentIndex` 为 `>= 0` 的安全整数（`Number.isSafeInteger`），以精确定位某条原生 assistant 消息内的第几个内容块。
  * `"thinking"`：要求 `problemCallId` 非空且 `text.trim().length > 0`。
  * `"next"`：无额外载荷。
  * `default`：抛出 `ChatInputError("unknown input type: ...")`。
* **④ 边界条件与历史事故背景**：将纯语法校验（`parseChatInput`）与依赖最新持久化的状态校验（`inputAppends`）拆成两步，使得服务端可以在等待上下文压缩（`ensureCompacted`）**之前**先拒绝格式错误的请求，等压缩完成后再基于最新 `record` 执行 `inputAppends`。
* **⑤ 上游调用方与系统接线**：`src/server/chat-handler.ts:180`。

---

#### `inputAppends(record, input)`（`src/core/input-events.ts:214-257`）

* **① 签名与职责定位**：`export function inputAppends(record: { messages: LhMessage[]; kind?: string }, input: ChatInput): LhMessage[]` · `[纯逻辑 + 新消息 ID/时间戳]` · 将合法的 `ChatInput` 针对当前会话记录折叠为即将 `write-ahead`（预写）到磁盘的追加消息序列。
* **② 输入、输出与核心不变量**：
  * **无孤儿结果不变量**：`answer` 只能命中 `danglingQuestionOf(record.messages)` 当前指出的那道悬空问题；`thinking` 只能命中 `activeProblemOf`；`next` 只能在 `kind === "practice"` 且无活动题时触发。
  * **延迟丢弃收尾捎带不变量**：凡是开启新用户交互的分支（`text`、`continue`、`thinking`、`next`），都会前置拼接 `...dismissalConclusion(record)`，把此前静默丢弃练习题欠下的合成 `conclude` 调用+结果对补齐到模型上下文中。
* **③ 核心逻辑与分支逐步推导**：
  * `"text"` → `[...dismissalConclusion(record), newUserMessage(input.text)]`。
  * `"answer"` → 核对 `danglingQuestionOf(record.messages)` 与 `input.toolCallId` 一致后，返回 `[newAnswerResult(input.toolCallId, pending.tool, input.answer)]`。
  * `"continue"` → 仅返回 `dismissalConclusion(record)`（正常挂载续跑时为空数组 `[]`，不污染记录，直接基于现有已答记录启动模型回合）。
  * `"retry"` → 返回 `[]`（输入早已预写落盘，失败重试不追加任何新消息，靠 `retryDrops` 过滤临时上下文）。
  * `"retry-question"` → 委托 `questionRecoveryAppends(record.messages, input)`。
  * `"thinking"` → 校验 `activeProblemOf` 匹配 `input.problemCallId`，返回 `[...dismissalConclusion(record), newThinkingMessage(input.problemCallId, input.text)]`（注：有活动题时 `dismissalConclusion` 实际必为空，保持统一写法）。
  * `"next"` → 校验 `record.kind === "practice"` 且 `!activeProblemOf(record.messages)`，返回 `[...dismissalConclusion(record), newNextMessage()]`。
* **④ 边界条件与历史事故背景**：练习题按 ESC 丢弃时（`dismiss-problem`）为了做到零延迟静默响应，当时只写了 UI 标记 `problem-dismissed` 而没有写模型可见的 `conclude` 工具对；通过在这里前置拼入 `dismissalConclusion(record)`，确保学习者下一次发话或点“下一题”时，模型在自己的工具词汇表里看到的是一道已正式以 `"dismissed"` 收尾的题目，从而释放单活动题门控。
* **⑤ 上游调用方与系统接线**：`src/server/chat-handler.ts:338`。

---

#### `questionRecoveryAppends(messages, input)`（`src/core/input-events.ts:262-275`）

* **① 签名与职责定位**：`export function questionRecoveryAppends(messages: readonly LhMessage[], input: Extract<ChatInput, { type: "retry-question" }>): LhMessage[]` · `[纯逻辑 + 新消息 ID/时间戳]` · 针对前端渲染为 `MalformedQuestion` 的损坏出题批次，校验可恢复性并构造让模型重新出题的错误 `toolResult` 消息列表。
* **② 输入、输出与核心不变量**：目标调用当前必须仍处于 `"malformed"` 状态，且同一批次中**不得存在任何尚可正常作答的姊妹题（`status === "answerable"`）**。
* **③ 核心逻辑与分支逐步推导**：
  1. 调用 `questionCallsOf(messages)` 盘点当前所有问题调用的状态（`"answered" | "answerable" | "malformed"` 等）。
  2. 按 `(messageId, contentIndex, toolCallId)` 三元组精确匹配目标调用；若未找到或 `target.status !== "malformed"`，抛 `ChatInputError("This malformed question is no longer available to retry. Refresh the session.")`。
  3. 若 `calls.some(call => call.status === "answerable")`，抛 `ChatInputError("Answer or discard the remaining question before retrying this one.")`（防止把正常待答题误伤冲掉）。
  4. 将所有 `status === "malformed"` 的调用映射为 `isError: true`、`details: { questionRecovery: true }` 的 `toolResult` 消息，提示词明确告诉模型：“学习者请求替换损坏题目而非作答，请用完整合法参数重新出题”。
* **④ 边界条件与历史事故背景**：部分模型在流式输出工具参数时可能截断或写出无法通过显示侧 Schema 校验的坏题目，若不提供显式恢复通道，会话会永久卡死在坏题上。
* **⑤ 上游调用方与系统接线**：`src/server/chat-handler.ts:231`（准入预检）与 `src/core/input-events.ts:236`（`inputAppends` 内调用）。

---

#### `failedResponseAtEnd(messages)`、`endsInFailedTurn(messages)` 与 `retryDrops(messages)`（`src/core/input-events.ts:280-330`）

这三个纯函数与私有辅助函数 `failedTail` 共同构成 **失败重试（issue #110）状态判定组**：

* **① 签名与职责定位**：
  * `export function failedResponseAtEnd(messages: readonly LhMessage[]): Extract<LhMessage, { role: "assistant" }> | undefined`（`280-287`）· `[纯函数]` · 查找记录末尾是否挂着一条驱动错误横幅显示的失败 `assistant` 消息。
  * `export function endsInFailedTurn(messages: readonly LhMessage[]): boolean`（`292-295`）· `[纯函数]` · 判定当前记录是否满足点击“Retry”按钮重试的完整条件。
  * `export function retryDrops(messages: readonly LhMessage[]): Set<string>`（`305-317`）· `[纯函数]` · 计算在构造失败重试的临时 `Agent` 上下文时需要剔除的尾部失败消息 ID 集合（磁盘记录原样保留不删！）。
* **② 输入、输出与核心不变量**：
  * **中止不是失败**：`stopReason === "aborted"` 是用户主动停止，绝不可触发失败重试，仅认 `stopReason === "error"`。
  * **压缩不可跨越不变量**：`failedResponseAtEnd` 从尾部倒扫时会跳过 `plan-block` **和** `compaction` 标记（因此压缩后错误横幅依然可见，告知用户刚才报错了）；但 `failedTail` 倒扫时**只跳过 `plan-block`，遇到 `compaction` 立即停止**！这意味着：**如果失败之后发生过上下文压缩，绝对禁止原位 `retry`**，必须由学习者发新消息继续。
* **③ 核心逻辑与分支逐步推导**：
  1. 私有函数 `failedTail(messages)`（`321-330`）从数组末尾向前扫描：遇到 `role === "assistant" && stopReason === "error"` 则将其 `id` 加入 `ids` 集合；遇到 `customType === "plan-block"` 继续向前；遇到任何其他消息（包括 `compaction`、`user`、`toolResult` 或成功的 `assistant`）立即 `break`，并将该停步处的消息记为 `before`。
  2. `endsInFailedTurn`：要求 `ids.size > 0` 且 `before !== undefined && before.role !== "assistant"`（即剥掉失败的 assistant 后，露出的最后一条消息必须是 `user`、`toolResult` 或可展平的 `custom` 标记，满足 Pi `agent.continue()` 要求最后一条消息不能是 `assistant` 的前置条件）。
  3. `retryDrops`：若 `ids.size === 0`，进一步调用 `failedResponseAtEnd(messages)` 区分是因为“失败后发生了上下文压缩”（报专属提示：`"...cannot be retried after compaction. Send a new message to continue."`）还是根本没有失败回合；若 `!before || before.role === "assistant"` 则报无输入可续跑；全部合法则返回 `ids`。
* **④ 边界条件与历史事故背景**：Pi 引擎的 `toLlmMessages` 虽然会自动跳过 `error` 状态的回复，但 `Agent.continue()` 在转换前就会检查 `state.messages` 末尾角色，若是 `assistant` 会直接抛错；同时如果保留失败消息在计数基准外又会导致 `persistTurn` 漏存新输出。`retryDrops` 在不删磁盘历史的前提下精准剥离尾部失败 ID，完美对齐了续跑与收尾落盘。
* **⑤ 上游调用方与系统接线**：
  * `failedResponseAtEnd`：`components/session-core.ts:296`；
  * `endsInFailedTurn`：`components/chat.tsx:753`（控制 Retry 按钮显隐）；
  * `retryDrops`：`src/server/chat-handler.ts:223`（前置快检）与 `:319`（压缩门后重算）。

---

### 1.4 轻量私有辅助与工具函数归并表

| 函数名 | 行号 | 纯度 | 作用与调用归属 |
|---|---|---|---|
| `failedTail` | `321-330` | `[纯函数]` | 从记录尾部倒扫连续报错的 `assistant` 消息（跳过 `plan-block`，在 `compaction` 处停步），供 `endsInFailedTurn` 与 `retryDrops` 共用。 |
| `dismissalConclusion` | `337-340` | `[纯逻辑 + 新 ID]` | 检查 `pendingProblemDismissalOf(record.messages)`，若有未结清的练习题丢弃标记，调用 `concludedByDismissalPair` 生成合成 `conclude` 调用+结果对，供 `inputAppends` 前置拼接。 |
| `isQuestionTool` | `343-345` | `[纯函数]` | 导出辅助函数：判断工具名是否属于 `QUESTION_TOOLS`（答题 dock 接管的 5 种提问工具）。 |

---

## 2. `src/core/view.ts`（490 行）

### 2.1 模块定位与纯度边界

* **设计目的**（`src/core/view.ts:1-34`）：Wave D（2026-09-26）将视图投影从服务端彻底迁移至客户端，彻底摆脱 Vercel AI SDK 的 `UIMessage` 类型束缚。它把持久化的扁平 `LhMessage[]` 与正在进行的实时回合状态（`LiveTurnState`）纯函数映射为“连续教案文档”形态的 `LhViewMessage[]`——同一轮循环里的连续 `assistant` 与 `toolResult` 聚合成单个连续的文档消息组（中间插 `step-start` 分隔），工具结果回填到发起调用的卡片上，`plan-block` 内联拼入紧随 `plan_init` 之后的位置。
* **桶导出状态**：由 `src/core/index.ts:28` 全量导出。
* **纯度边界**：全文件 **100% 严格确定性纯函数**（无 I/O、无随机 ID、无时间戳、不修改入参 `messages`）。

### 2.2 核心数据结构与接口契约

| 接口名 | 行号 | 字段与状态机语义 |
|---|---|---|
| `LhViewPart` | `49-63` | 渲染器消费的统一部件结构：`type`（如 `"text"`、`"reasoning"`、`"step-start"`、`"tool-quiz"`、`"data-plan-block"`、`"data-compaction-cut"` 等）、`state`（工具状态机：`"input-streaming"` → `"input-available"` / `"output-available"` / `"output-error"`）、`toolCallId`、`sourceMessageId` / `sourceContentIndex`（跨聚合保留原生定位，供 `findPendingToolCall` 与 `retry-question` 使用）、`input` / `output` / `rawInput` / `errorText` / `data`。 |
| `LhViewMessage` | `66-72` | 视图层顶层消息：`{ id: string; role: "user" \| "assistant"; parts: LhViewPart[]; metadata?: unknown }`。连续的多个原生 `assistant` + `toolResult` 会合并为一个 `role: "assistant"` 组，`id` 取该组**第一条**原生 `assistant` 消息的 `id`。 |
| `LiveExecution` | `75-81` | 进行中回合里某个 `toolCallId` 已收到的 `tool_execution_end` 结果快照：`{ isError: boolean; output?: unknown; errorText?: string }`。 |
| `LiveTurnState` | `84-96` | 客户端会话状态机传入的实时层：<br>• `executions: ReadonlyMap<string, LiveExecution>`：本轮已执行完的工具结果表；<br>• `inFlight: boolean`：当前是否有回合在跑；<br>• `streamingIds: ReadonlySet<string>`：**正向证据集合**——记录本轮正在通过 SSE 事件流流式到达的消息 `id`。 |

---

### 2.3 导出函数与核心内部状态机精讲

#### `projectView(messages, live)`（`src/core/view.ts:128-293`）

* **① 签名与职责定位**：`export function projectView(messages: readonly LhMessage[], live?: LiveTurnState): LhViewMessage[]` · `[纯函数]` · 全系统唯一的浏览器端视图投影主引擎。
* **② 输入、输出与核心不变量**：
  1. **思考置顶不变量（2026-09-26 所有者裁定）**：部分模型（如 GLM）会在正文输出结束后再吐出一段尾部 `thinking` 块；若按原始块顺序渲染，思考块会掉到正文下方。`projectView` 对每条 `assistant` 消息做稳定分区，强制所有 `reasoning` 部件排在该消息所有正文与工具部件**上方**。
  2. **实时态正向证据不变量（2026-10-05 修复）**：一个未决工具调用只有在 `live?.streamingIds.has(m.id) === true`（即它所属的这条消息本轮正在流式传输）时才能渲染为加载微光态 `"input-streaming"`；绝不能仅凭“会话正忙（`inFlight`）”就把历史已落盘的练习题重新变回转圈加载态。
  3. **完整历史可见不变量**：即使存在上下文压缩（`activeCompactionOf`），`projectView` **绝不隐藏任何早期消息**，只在 `firstKeptMessageId` 紧前方插入一条 `"data-compaction-cut"` 切割提示线，并在压缩发生时刻（消息流尾部）渲染 `"data-compaction"`（`moment_divider`）。
* **③ 核心逻辑与分支逐步推导**：
  1. **预扫描失败的 `send_to_user`（`132-137`）**：收集所有 `toolName === "send_to_user" && isError === true` 的 `toolResult` 存入 `outputErrors` 表（因为正常的 `send_to_user` 会直接化作普通文本块而非工具卡片，只有报错的调用才保留为错误工具部件）。
  2. **最新优先工具回填查找器 `findToolPart`（`143-157`）**：消息倒序、部件倒序扫描 `out` 中已生成的 `"tool-*"` 部件。在早期历史数据存在重复 ID（如 DeepSeek 每轮都从 `call_0` 开始编号）时，倒序扫描确保 `toolResult` 精确命中**最近的前置同名调用**（2026-10-04 "Lacan heal" 修复）。
  3. **定位活跃压缩切口（`164`）**：调用 `activeCompactionOf(messages)` 获取当前生效的压缩标记。
  4. **主循环遍历每条 `m`（`166-290`）**：
     * **压缩切口注入（`169-181`）**：若 `m.id === compaction.details.firstKeptMessageId`，先推入一条 `id: "cut_" + compaction.id`、含 `"data-compaction-cut"` 部件的视图消息。
     * **`role === "user"`（`183-190`）**：提取纯文本或数组中的文本块，推入 `role: "user"` 视图消息（打断此前的连续 `assistant` 组）。
     * **`role === "custom"`（`192-195`）**：委托 `projectMarker(m, out)` 处理 9 种自定义标记消息。
     * **`role === "toolResult"`（`197-200`）**：通过 `findToolPart` 找到原调用部件并调用 `applyResultTo` 更新其状态与输出。
     * **`role === "assistant"`（`202-289`）**：
       - 计算 `streamingMessage = live?.streamingIds.has(m.id) === true`；
       - 遍历 `assistant.content`：`"text"` 入 `rest` 数组；`"thinking"` 入 `reasoning` 数组；`"toolCall"` 先经 `toolPartOf` 生成部件：
         - 若属 `QUESTION_TOOLS`，记录 `sourceMessageId = m.id` 与 `sourceContentIndex`；
         - 若属 `send_to_user`：当整条消息 `stopReason` 为 `"error"` 或 `"aborted"` 时直接跳过；若在 `outputErrors` 中有报错结果则转为 `output-error` 部件保留；否则通过 `sendToUserText(block)` 提取消息文本，直接变成普通 `"text"` 部件推入 `rest`（无工具卡片痕迹）；
         - 若属练习题收尾 `conclude`（`PRACTICE_CONCLUDE_TOOL`）：调用 `modelSolutionForConclude` 与 `problemInputForConclude` 将出题时预提交的标准解答 `reveal` 和原题干关联注入到部件上，让前端卡片纯函数直接渲染；
       - 合并 `parts = [...reasoning, ...rest]`；
       - **空流式消息无缝交接（`266-279`）**：若 `parts.length === 0` 且该消息正在流式到达（`live?.streamingIds.has(m.id)`），注入一个空 `"reasoning"` 部件以承接“正在思考”占位动画；若是已落盘的空消息则直接忽略；
       - **连续聚合（`280-287`）**：若 `out` 末尾已是 `assistant` 消息，则追加 `{ type: "step-start" }, ...parts` 到同一组；否则新建一条以 `{ type: "step-start" }` 开头的 `assistant` 视图消息。
* **④ 边界条件与历史事故背景**：集中解决了四大真实线上问题：GLM 尾部思考块倒挂、DeepSeek 重复 `call_0` 覆盖旧答题卡、练习会话提交思考时旧题卡重新转圈闪烁、以及首包空消息到达时思考占位符双影跳动。
* **⑤ 上游调用方与系统接线**：`components/session-core.ts:306`（每次状态更新或收到 SSE 事件流帧时纯函数重算视图）。

---

#### `toolPartOf(block, live, streamingMessage)` 与 `applyResultTo(part, result)`（`src/core/view.ts:311-375`）

这两个内部核心函数实现了 **工具部件四态状态机与占位符分叉（Fork 2）**：

* **① 签名与职责定位**：
  * `function toolPartOf(block: { id: string; name: string; arguments?: unknown }, live: LiveTurnState | undefined, streamingMessage: boolean): LhViewPart`（`311-348`）· `[纯函数]`
  * `function applyResultTo(part: LhViewPart | undefined, result: ToolResultMessage): void`（`350-375`）· `[纯逻辑，仅修改本次 projectView 新建的局部 part 对象]`
* **② 输入、输出与核心不变量**：
  * **答题/出题占位符绝不转 `output-available` 不变量（Wave D Fork 2）**：提问工具（`QUESTION_TOOLS`）和练习出题工具（`problem`）在服务端执行成功时，为了结束 Pi 循环会返回一个 `details: null` 的临时“Question posed”占位结果。如果前端把它当成普通工具结果把状态翻成 `output-available`，`AnsweredCard` 拿到 `output: null` 会当场渲染崩溃（2026-09-26 真实崩溃事故）！因此干净的占位结果必须让部件停留在 `"input-available"`，只有学习者提交真实答案（`result.details != null`）后才进入 `"output-available"`。
  * **校验失败绝不挂载答题 dock 不变量**：一旦 `exec.isError === true`（模型出题参数不合法正在同回合触发出题重试），状态立即设为 `"output-error"`，绝不进入 `"input-available"`。
* **③ 状态转换矩阵推导**：
  1. 在 `toolPartOf` 中（处理 `assistant` 消息块时）：
     * 若 `live.executions` 已有该调用的执行结果 `exec`：
       - `exec.isError === true` → `state = "output-error"`，保留 `rawInput` 与 `errorText`；
       - `!exec.isError && isPlaceholderResultTool(block.name)` → `state = "input-available"`（此时刚过完服务端校验门，答题 dock 安全挂载！）；
       - `!exec.isError` 且为普通服务端工具（如 `plan_init`、`read`、`conclude`）→ `state = "output-available"`，`output = exec.output`。
     * 若 `live.executions` 尚无记录：
       - `streamingMessage === true` → `state = "input-streaming"`（参数仍在流式生成或校验中，显示微光文案）；
       - `streamingMessage === false` → `state = "input-available"`（历史已落盘的悬空待答题）。
  2. 在 `applyResultTo` 中（处理持久化的 `toolResult` 消息时）：
     * 若属于 `isPlaceholderResultTool` 且 `!result.isError && result.details == null`：强制固定 `part.state = "input-available"` 并提前返回（防止练习题的持久化空回执把状态弄错）；
     * 否则调用 `applyResult(part, result)`：错误结果置 `"output-error"`，正常结果置 `"output-available"` 且 `part.output = result.details`。
* **④ 边界条件与历史事故背景**：2026-09-26 模态框崩溃事故与 2026-10-05 练习题重现加载旋转图标事故均由此状态机封堵。
* **⑤ 上游调用方与系统接线**：仅由 `projectView`（`src/core/view.ts:200, 224`）内部调用。

---

#### `projectMarker(marker, out)`（`src/core/view.ts:378-489`）

* **① 签名与职责定位**：`function projectMarker(marker: LhMarkerMessage, out: LhViewMessage[]): void` · `[纯逻辑，向局部输出数组 out 推入或内联拼接]` · 定义全部 **9 种应用自定义标记消息（`LhMarkerMessage`）** 在浏览器视图中的呈现形态。
* **② 输入、输出与核心不变量**：绝大多数标记打断当前 `assistant` 组，以 `role: "user"` 身份推入专用 `data-*` 视图卡片；唯独 `problem-dismissed` 在视图中静默忽略，`plan-block` **不新建消息而是内联拼入前一个 `assistant` 组**。
* **③ 九种分支逐一拆解**：
  1. `"graph-context"` → 推入含 `"data-graph-context"` 部件的消息（首条用户消息上方的可折叠知识图谱上下文卡）。
  2. `"probe-handoff"` → 推入含 `"data-probe-handoff"` 部件的交接提示卡。
  3. `"subagent-steer"` → 推入同时含文本说明与 `"data-subagent-artifact"`（携带 `demo` HTML / `visual` SVG / `research` 或 `pdf` 简报）的制品消息，并在 `metadata.subagentResult` 挂上元信息。
  4. `"subagent-abort"` → 推入含文本与 `"data-subagent-aborted"` 部件的中止通知卡。
  5. `"practice-thinking"` → 推入含 `"data-practice-thinking"` 的学习者练习草稿/作答卡片。
  6. `"practice-next"` → 推入含 `"data-practice-next"` 的极简居中推进提示行（模型读其英文提示词，UI 只渲染统一 chrome 标签）。
  7. `"problem-dismissed"` → 直接 `return` 不渲染独立卡片（由下一次输入捎带的合成 `conclude` 卡片统一呈现）。
  8. `"compaction"` → 推入含 `"data-compaction"` 部件的消息，即 **`moment_divider`**（在压缩发生的时间点渲染居中极简小字，点击可弹窗查看完整摘要；而切口处的 `"data-compaction-cut"` 已由主循环在 `firstKeptMessageId` 处生成）。
  9. `"plan-block"` → 检查 `out` 末尾是否为 `assistant` 组，调用 `lastSuccessfulPlanInit(group.parts)` 找到该组最后一个 `output.ok === true` 的 `tool-plan_init` 部件下标 `idx`，通过 `group.parts.splice(idx + 1, 0, { type: "data-plan-block", ... })` 将冻结的计划快照**紧贴着 `plan_init` 调用原地插入文档流中**！
* **④ 边界条件与历史事故背景**：若 `plan-block` 前面没有合法的 `assistant` 组或组内没有成功的 `plan_init`（例如异常残缺数据），`idx === -1` 安全无操作返回，绝不越界报错。
* **⑤ 上游调用方与系统接线**：由 `projectView`（`src/core/view.ts:193`）调用。

---

### 2.4 轻量私有辅助函数归并表

| 函数名 | 行号 | 纯度 | 作用与调用归属 |
|---|---|---|---|
| `textPart` | `98-100` | `[纯函数]` | 快捷构造 `{ type: "text", text, state: "done" }` 部件。 |
| `applyResult` | `103-113` | `[纯逻辑]` | 根据 `ToolResultMessage.isError` 将部件设为 `"output-error"`（提取错误文本）或 `"output-available"`（提取 `result.details`）。 |
| `lastSuccessfulPlanInit` | `116-123` | `[纯函数]` | 在 `parts` 中正向查找最后一个 `type === "tool-plan_init"` 且 `output.ok === true` 的下标，供 `"plan-block"` 内联拼接定位。 |
| `isPlaceholderResultTool` | `302-304` | `[纯函数]` | 判断工具名是否属于 `QUESTION_TOOLS` 或 `"problem"`（客户端接管交互、忽略服务端空回执的工具集）。 |

---

## 3. `src/core/pending.ts`（196 行）

### 3.1 模块定位与纯度边界

* **设计目的**（`src/core/pending.ts:1-33`）：管理客户端**视图层**的待答问题闸门扫描、工具开关集合过滤与流式工具微光文案（`shimmer`）。
* **桶导出状态**：由 `src/core/index.ts:29` 全量导出。
* **纯度边界**：全文件 **100% 严格确定性纯函数**。

### 3.2 核心常量与接口契约

| 常量 / 类型 | 行号 | 语义与设计裁定 |
|---|---|---|
| `PendingToolCall` | `34-39` | `{ toolCallId: string; tool: string; input: unknown }`：基础待答工具调用描述。 |
| `PendingQuestion` | `43-49` | 继承 `PendingToolCall`，附加客户端唯一定位坐标 `{ messageId: string; contentIndex: number; key: string }`（仅驻留客户端内存，从不发往服务端）。 |
| `QUESTION_TOOLS` | `53-59` | `["quiz", "probe", "ask_user_question", "explain", "recall"]`：由答题 dock 渲染并阻塞输入框的全部提问工具（探测阶段工具名与教学阶段成对并列）。 |
| `JOB_TOOLS` | `69` | `["research", "demo", "visual"]`：早期异步后台任务工具常量列表。 |
| `TOGGLEABLE_TOOLS` | `87` | `["research", "demo", "visual", "pdf"]`：用户在设置中**唯一允许开关**的工具集合（2026-09-19 裁定：提问工具、`probe_done`、计划工具、本地文件读取工具严禁关闭，否则会导致探测无法收尾或教学退化）。 |
| `WRITABLE_TOOL_KEYS` | `94` | `[...TOGGLEABLE_TOOLS, "explain"]`：设置写接口允许写入 `agent.tools` 的合法键（其中 `explain: true` 是切换自由回忆出题机制的开关，而非普通后台工具开关）。 |
| `EnabledTools` | `102` | `Partial<Record<string, boolean>>`：缺省或 `undefined` 一律视为启用，仅显式 `false` 表示禁用（Delta 语义）。 |
| `ACTIVITY_LABELS` | `162-173` | 10 种非提问工具在 `input-streaming` 执行期间展示在实时工具卡上的英文微光文案映射表（如 `read: "Reading a file…"`、`plan_init: "Drawing up the plan…"`）。 |

---

### 3.3 导出函数与核心内部算法精讲

#### `toolQuestionKind(tool)`（`src/core/pending.ts:64-66`）

* **① 签名与职责定位**：`export function toolQuestionKind(tool: string): "quiz" | "ask" | "explain"` · `[纯函数]` · 将 5 种具体工具名折叠为答题 dock 驱动渲染的 3 种题型分类。
* **② 输入、输出与核心不变量**：`"quiz"` 与 `"probe"` 映射为 `"quiz"`（多选题）；`"explain"` 与 `"recall"` 映射为 `"explain"`（简答自由回忆题）；其余（即 `"ask_user_question"`）映射为 `"ask"`。**一致性不变量**：答题 dock 与静默丢弃校验（`dismissAppends`）必须调用同一个映射函数，绝不允许对同一工具的 `kind` 产生分歧。
* **③ 核心逻辑与分支逐步推导**：两层三元表达式直接返回对应字面量。
* **④ 边界条件与历史事故背景**：探测与教学拆分后（`probe` vs `quiz`、`recall` vs `explain`），底层 UI 交互与答案载荷格式完全相同，靠此折叠函数消除前端重复分支。
* **⑤ 上游调用方与系统接线**：`src/core/input-events.ts:152`、`components/chat.tsx:417`、`components/question-dock.tsx:268`。

---

#### `filterEnabledTools(tools, enabled)`（`src/core/pending.ts:106-114`）

* **① 签名与职责定位**：`export function filterEnabledTools<T>(tools: Record<string, T>, enabled?: EnabledTools): Record<string, T>` · `[纯函数]` · 根据解析后的用户工具开关配置，从工具注册表字典中剔除被显式禁用的工具。
* **② 输入、输出与核心不变量**：不修改原 `tools` 对象；若 `enabled` 未传则直接原样返回；**仅当 `enabled[name] === false` 时才剔除**，`true` 或 `undefined` 均保留。
* **③ 核心逻辑与分支逐步推导**：遍历 `Object.entries(tools)`，跳过 `enabled[name] === false` 的条目，构造并返回新字典 `out`。
* **④ 边界条件与历史事故背景**：注意在 `src/agent/tools.ts:426`（`withoutMechanics`）中，调用方会先剥掉出题机制键 `"explain"` 再交给 `filterEnabledTools`，防止 `explain: false` 误伤正常的机制分发。
* **⑤ 上游调用方与系统接线**：`src/agent/tools.ts:318`（探测者工具集组装）与 `:448`（教师工具集组装）。

---

#### `findPendingToolCall(messages, authority)` 及内部 `findPending`（`src/core/pending.ts:116-148`）

* **① 签名与职责定位**：
  ```ts
  export function findPendingToolCall(messages: UIMessage[], authority: PendingQuestion | null): PendingQuestion | null;
  export function findPendingToolCall(messages: UIMessage[], authority?: string | null): PendingToolCall | null;
  ```
  `[纯函数]` · 在分组后的视图消息列表 `LhViewMessage[]` 中确认当前可安全挂载到答题 dock 的待答问题。
* **② 输入、输出与核心不变量**：
  1. **显式空权威短路**：当传入 `authority === null`（即原生记录层 `pendingQuestionOf` 已确认没有任何未决问题）时，立即返回 `null`，绝不在视图层自行猜测。
  2. **消息倒序、消息内部件正序不变量**：外层从最新视图消息向旧消息扫描（新回合的问题优先），内层在同一视图消息的 `parts` 中**从前向后正向扫描**——确保当模型在单个批次里并列发出多道题时，学习者作答顺序与模型提问顺序、卡片上下渲染顺序完全一致（曾因内层倒序扫描导致“先答下面第二题、再答上面第一题”的反直觉故障）。
  3. **四元组精确核验不变量**：当 `authority` 为原生层传入的 `PendingQuestion` 对象时，视图部件不仅要处于 `state === "input-available"`，而且 `(part.toolCallId, tool, part.sourceMessageId, part.sourceContentIndex)` 四个坐标必须与 `authority` 完全吻合，才返回该 `authority`；若该题在实时流中仍处于 `input-streaming` 或已变为 `output-error`，则返回 `null`，绝不回退去打开更早的历史旧题！
* **③ 核心逻辑与分支逐步推导**：
  1. `if (authority === null) return null;`
  2. 进入 `findPending(messages, QUESTION_TOOLS, authority)`：外层 `m` 从 `messages.length - 1` 递减至 `0`，内层 `p` 从 `0` 递增至 `msg.parts.length - 1`。
  3. 检查 `isToolUIPart(part)`（`"tool-"` 前缀且含字符串 `toolCallId`）且 `part.state === "input-available"`。
  4. 截取工具名 `tool = part.type.slice("tool-".length)`，若不在 `QUESTION_TOOLS` 中则跳过。
  5. 若 `typeof authority === "object"`：逐一比对 `toolCallId`、`tool`、`sourceMessageId === authority.messageId`、`sourceContentIndex === authority.contentIndex`，匹配则直接原样返回 `authority`。
  6. 若 `authority` 为 `undefined` 或字符串 ID：在匹配时返回 `{ toolCallId, tool, input: part.input }`。
* **④ 边界条件与历史事故背景**：解决了两个棘手边界：① 合并后的 `LhViewMessage` 抹平了多条原生 `assistant` 边界，单靠可能重复的旧 `toolCallId` 不足以唯一定位，因此引入 `sourceMessageId + sourceContentIndex` 精确锁死；② 校验失败的题目处于 `output-error`，在此处被 `part.state === "input-available"` 干净挡在答题 dock 门外。
* **⑤ 上游调用方与系统接线**：`components/chat.tsx:453`（`const pending = findPendingToolCall(messages, pendingQuestionOf(nativeMessages))`）。

---

#### `toolActivityLabel(tool)` 与 `streamingToolActivity(messages)`（`src/core/pending.ts:180-194`）

* **① 签名与职责定位**：
  * `export function toolActivityLabel(tool: string): string`（`180-183`）· `[纯函数]` · 返回单个运行中工具的微光文案。
  * `export function streamingToolActivity(messages: UIMessage[]): string | null`（`185-194`）· `[纯函数]` · 扫描最后一条 `assistant` 视图消息中正在流式执行的工具并返回其微光文案。
* **② 输入、输出与核心不变量**：提问工具统一返回 `"Writing a question…"`；已知的 10 种读写/派发/规划工具返回各自的精确动词短语（如 `"Searching file contents…"`）；未知扩展工具兜底返回 `"Working…"`。
* **③ 核心逻辑与分支逐步推导**：
  * `toolActivityLabel`：先查 `QUESTION_TOOLS` 包含性，再查 `ACTIVITY_LABELS[tool] ?? "Working…"`。
  * `streamingToolActivity`：取 `messages.at(-1)`，若不存在或 `role !== "assistant"` 返回 `null`；正向遍历其 `parts`，命中第一个 `isToolUIPart(part) && part.state === "input-streaming"` 的部件即调用 `toolActivityLabel` 返回对应文案，全无则返回 `null`。
* **④ 边界条件与历史事故背景**：2026-09-19 修复前，系统把所有处于 `input-streaming` 的工具一律显示为 `"Writing a question…"`，导致教师调用 `grep` 搜索本地大目录耗时半分钟时，界面一直谎称“正在写问题”；拆分 `ACTIVITY_LABELS` 后，内联实时卡片（`live-tool-card.tsx`）能诚实反映当前动作。
* **⑤ 上游调用方与系统接线**：`components/artifacts/live-tool-card.tsx:50, 52`；`streamingToolActivity` 作为纯视图辅助供测试与状态栏探测使用。

---

### 3.4 轻量私有辅助函数归并表

| 函数名 | 行号 | 纯度 | 作用与调用归属 |
|---|---|---|---|
| `isToolUIPart` | `13-15` | `[纯函数]` | 结构化类型守卫：检查 `part.type.startsWith("tool-") && typeof part.toolCallId === "string"`，供 `findPending` 与 `streamingToolActivity` 调用。 |
| `findPending` | `116-135` | `[纯函数]` | `findPendingToolCall` 的底层实现核心，执行外层消息倒序、内层部件正序扫描及 `authority` 四元组核对。 |
