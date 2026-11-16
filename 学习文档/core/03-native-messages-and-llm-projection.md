# 第 03 卷：原生消息记录与唯一模型向投影枢纽（native-messages.ts）

> **目标文件**：`src/core/native-messages.ts`（937 行；**38 个函数** = 34 个导出函数 + 4 个私有函数；另有 4 个导出常量、7 个导出类型、1 处 `declare module` 声明合并）。
> **取证约定**：本卷每条结论均经 grep/read 取证，出处以 `path:line` 标注；**不带路径前缀的行号一律指 `src/core/native-messages.ts`**。
> **术语约定**：严格遵循 `学习文档/glossary.md`——实时通道称 **SSE 事件流**；落盘记录称 **持久化**（`ChatRecord`）；回合结束处理称 **回合收尾**（代码标识符 `persistTurn` / `endTurn` / `settleWith` 原样保留）。"悬空调用"（无对应结果的 tool call）与"孤儿 result"（所属 assistant 消息已不在投影中的 toolResult）在本卷中是描述性短语，尚未入术语表（glossary 使用规则 5），首次出现处均给出定义。

---

## 1. 模块定位与核心设计哲学

### 1.1 记录即 Agent 状态（THE NATIVE MESSAGE RECORD）

文件头注释（:1-7，Wave B，owner-approved 2026-09-26）宣告本文件的设计原理：持久化记录存储的是 **pi 自己的消息形状**——agent 循环构建的那份确切历史——而不是 AI-SDK UIMessages。provider、model、usage、stopReason、thinking 签名全部由 pi 自己盖章，应用不做二次拼装。

回放因此是一个等式（:5-7）：

```
state.messages = record.messages   +   continue()
```

**记录就是 agent 状态**（术语表词条 43"原生记录"）。这个等式的物理实现有两处：

- `src/server/chat-handler.ts:448/464`：`asAgentMessages(agentMessages)` 直接作为 `initialMessages` / `messages` 传入 agent 构造；
- `src/agent/teacher-agent.ts:232`：`messages: opts.messages ?? []` 进入 `initialState.messages`。

每个回合都从记录**无状态地**新建一个 agent（`src/server/chat-handler.ts:438-441` 注释："the agent is stateless per turn, so each request builds a fresh one off the record"）。不存在需要与记录同步的第二份状态副本——这是崩溃恢复、多标签页一致、回合收尾后任意客户端 fetch 即真相的根源。

### 1.2 唯一的附加字段：id（与可选的 cliContextWindow）

pi 的会话格式给每个 **entry** 一个 id，却从不给 **message** 一个 id（:9-14）。应用需要消息级身份：React keys、append-only adoption（客户端乐观消息被记录副本吸收）、续跑缝。因此每条记录消息在原生形状之外**恰好携带一个额外字段 `id`**；`toLlmMessages` 在模型向边界剥掉它（:642），provider 永远看不到——文件头称之为 "verified single site"（全系统唯一剥离点）。

第二个可选字段 `cliContextWindow`（:97-99）是 CLI 报告的**有效上下文预算**，不是模型目录上限；同为 app-only 元数据，在同一处剥离，永不作为 provider/model 消息内容传输。它的唯一写入方是 `src/agent/claude-code/stream.ts:246`（详见 §3.7.4）。

### 1.3 UI-only 内容与唯一模型向缝

probe→teach 交接、sub-agent 插纸条、计划块都是 `LhMarkerMessage`（:16-27）——本应用通过**声明合并**注入 pi-agent-core `CustomAgentMessages` 扩展点的成员（:88-92），形状与 pi 自己的 `CustomMessage` 完全一致：`{role:"custom", customType, content, display, details}`。

双受众纪律（:58-65）：

| 字段 | 受众 | 纪律 |
|---|---|---|
| `content` | **模型** | 模型向文本，单一来源于 `core/contracts`，永不伪装人类话语 |
| `details` | **UI** | 每 customType 各自的 UI 载荷，永不对模型可见 |
| `display` | 文档性 | 标记 UI 会渲染的消息；本应用投影按 `customType` 键控渲染，此旗标记录意图 |

**唯一的缝（seam）**——`toLlmMessages`，接线为 agent 的 `convertToLlm`（:583；接线点 `src/agent/teacher-agent.ts:256`）——拥有全部模型向决策：marker 展平为规范 user 文本、计划块作为 UI-only 被过滤、中止回合的悬空调用获得 provider 协议要求的中断结果合成。

### 1.4 答案即工具结果（fork 1，owner 2026-09-26）

学习者的答案**就是**问题调用的 `ToolResultMessage`，在答题时刻原生追加（:29-35；物理追加位 `src/core/input-events.ts:156/226`）。合成的 "question posed" 占位是**内存循环装置**（Wave A 的 terminate；`src/agent/tool-execute.ts:237-249` 的 `questionResult()`，`details:null, terminate:true`），**永不落盘**：回合收尾的 `persistTurn` 在写盘前把它过滤掉（`src/server/turn-service.ts:72-79`）。

因此在 pose→answer 窗口内，记录恰好止于一条未回答的调用，且此窗口内**没有任何回合能运行**——待答问题闸门（术语表词条 10）hold 住插纸条，POST 会 409。这是"一次只答一个问题"的记录级根基。

### 1.5 纯度边界：非确定性源的精确标明

**全文件的扫描/折叠/投影函数都是纯函数**：只读输入数组，无 IO，不修改输入，无副作用。非确定性被严格限制在**构造器组**，共两种形态：

| 非确定性源 | 位置 | 说明 |
|---|---|---|
| `Date.now()` + `crypto.randomUUID()` | `newMessageId` :174-176 | 全应用消息 id 铸造 |
| 同形状内联 id 铸造 | `newPlanBlockMessage` :247 | `pb_` 前缀，未复用 `newMessageId` |
| `timestamp: Date.now()` | 全部 10 个消息构造器 | :187、:197、:221、:235、:253、:306、:324、:342、:360、:375 |
| `newMessageId()` ×2 | `concludedByDismissalPair` :396/:403 | 合成对的**记录消息 id** 每次新铸 |

**精确区分**：`concludedByDismissalPair` 的注释（:368-370）说 "Pure; ids are deterministic off the problem call id"——这里确定的是**合成工具调用 id** `call_conc_${problemCallId}`（:374），不是记录消息 id。"幂等形状"指：同一 problem call id 合成出的调用形状全同；`pendingProblemDismissalOf` 闸门保证每个 marker 至多追加一次该对。两条记录消息 id 仍由 `newMessageId()` 新铸——不影响幂等，因为去重键是 marker 而非消息 id。

另一侧的纯度坚守：`toLlmMessages` 合成的中断结果取 `assistant.timestamp`（:661）而非 `Date.now()`——投影不为记录引入任何新时间源。

### 1.6 桶导出、导入法则与依赖拓扑

**桶导出**：`src/core/index.ts:46` `export * from "./native-messages.ts"`——本文件全部导出进入 core barrel，即 shell 的唯一合法 import 面（术语表词条 86）。barrel 头注释（`src/core/index.ts:1-16`）保证 browser-safe：纯逻辑 + 类型，无 node builtins、无 fs、无 network。本文件的 import（:37-49）全部是 pi 包的类型导入 + core 兄弟模块，零 IO 依赖。

**导入法则的实际形态**（术语表词条 89）：

- `components/chat.tsx:39-50`、`components/session-core.ts:18-35` 从 `"@/src/core"`（barrel）导入；
- server/agent 直接导入模块路径：`src/server/chat-handler.ts:14/48`、`src/server/jobs.ts:69`、`src/agent/teacher-agent.ts:24`、`src/agent/tools/probe.ts:4`、`src/agent/tools/practice.ts:26`、`src/agent/subagents/extraction.ts:31`、`src/agent/subscription-request-cycle.ts:3`；
- sandtable 脚本直接导入源路径：`scripts/sandtable/board.ts:23`（脚本在 shell 导入法则之外）。

**依赖拓扑**（:37-49 的 import 清单）：

| 依赖 | 导入成员 | 用途 |
|---|---|---|
| `@earendil-works/pi-agent-core`（type） | `AgentMessage` | 签名边界 |
| `@earendil-works/pi-ai`（type） | `AssistantMessage`、`Message`、`ToolResultMessage`、`UserMessage` | 原生形状 |
| `./pending.ts` | `QUESTION_TOOLS`（pending.ts:53-59）、`PendingQuestion`（pending.ts:43-49） | 问题工具词表 + 客户端身份形状 |
| `./contracts/claude-code.ts` | `CLAUDE_CODE_PROVIDER`（该文件 :1，值 `"claude-code"`） | CLI 元数据的 provider 判别 |
| `./contracts/chat.ts` | `CONCLUDE_ACK_TEXT`（:213）、`HANDOFF_TEXT`（:187）、`NEXT_PROBLEM_TEXT`（:220）、`THINKING_LABEL`（:204） | 模型向文本单一来源 |
| `./question-core.ts` | `compactAnswerForModel`（:779-802）、`QuestionAnswerData`（:436） | 答案瘦身 |
| `./compaction.ts` | `activeCompactionOf`（:278-291）、`keptIndexFor`（:296-302） | 压缩切割 |
| `./tool-parts.ts` | `parseQuestionInput`（:118-125） | 题目显示有效性判定 |

**注意双向依赖**：`src/core/compaction.ts:39-40` 反过来从本文件导入 `LhMessage`/`LhMarkerMessage` 类型与 `newMessageId`。这是一个**函数级 ESM 循环**——两个模块都不在模块求值期调用对方函数，函数提升使其安全；但它说明这两个文件是"记录 + 压缩"的紧耦合核心。

---

## 2. 核心消息类型体系与 9 种 LhMarkerMessage 全景矩阵

### 2.1 LhMessage：持久化联合类型（:95-100）

```ts
export type LhMessage = (UserMessage | AssistantMessage | ToolResultMessage | LhMarkerMessage) & {
	id: string;
	cliContextWindow?: number;
};
```

三种原生角色 + 一种自定义角色，交叉 `{id, cliContextWindow?}`。它是**唯一存储格式**（术语表词条 3）；从同一份 `LhMessage[]` 派生两条投影（术语表词条 9）：`toLlmMessages` 面向模型（本文件 :583），`projectView` 面向浏览器（`src/core/view.ts:128`）。两者都不修改记录本身。

### 2.2 LhMarkerMessage（:66-86）与声明合并（:88-92）

接口字段逐一：

- `id: string`（:68）——记录身份（pi 消息无 id，见文件头）；
- `role: "custom"`（:69）——pi 自定义消息的角色字面量；
- `customType`（:70-79）——9 种取值的联合（见 §2.3 矩阵）；
- `content: string`（:81）——模型向文本（计划块为 `""`，UI-only）；
- `display: boolean`（:82）——UI 渲染意图旗标；
- `details: unknown`（:84）——每 customType 各自的 UI 载荷，永不对模型可见；
- `timestamp: number`（:85）。

`declare module "@earendil-works/pi-agent-core"`（:88-92）把 `lhMarker: LhMarkerMessage` 注入 `CustomAgentMessages` 接口——pi 的 agent 循环由此合法携带本应用的自定义消息于 `state.messages`，`asAgentMessages` 的类型断言（:118-120）因此有契约依据。

### 2.3 9 种标记消息全景矩阵

命运三分类：**展平保留**（7 种 → user 角色文本消息）、**丢弃过滤**（plan-block、problem-dismissed）、**切割头特例**（compaction）。

| # | customType | 构造器（出处） | id 形状 | content（模型向） | details（UI 载荷） | 产生时机 | toLlmMessages 中的命运 |
|---|---|---|---|---|---|---|---|
| 1 | `graph-context` | `newGraphContextMessage` :279-308 | `msg_…`（newMessageId） | `[Session context]…` 前言 + 带 id 命题行 + 推理链行 | `{propositions: GraphContextPick[], chains: string[]}` | 创建会话时学习者从知识图谱挑选命题（`app/api/chats/route.ts:68`），置于第一条 user 消息**之前** | **展平保留** → user 文本（:634-638） |
| 2 | `probe-handoff` | `newHandoffMessage` :227-237 | `steer_probe_<chatId>`（**确定性**） | `HANDOFF_TEXT`（contracts/chat.ts:187） | `{chatId}` | probe_done 成功后经唤醒流水线排队（`src/core/contracts/jobs.ts:429` `buildProbeHandoffSteer`） | **展平保留** |
| 3 | `subagent-steer` | `src/core/contracts/jobs.ts:368-386`（**不在本文件**） | `steer_<jobId>`（确定性） | `steerText(kind, result)` | `{jobId, kind, toolCallId, result}` | 后台任务完成，pump 投递（`src/server/jobs.ts`） | **展平保留** |
| 4 | `subagent-abort` | `src/core/contracts/jobs.ts:391-404`（**不在本文件**） | `steer_<jobId>`（确定性） | `abortText(kind)` | `{jobId, kind, toolCallId, aborted:true}` | 后台任务被学习者中止 | **展平保留** |
| 5 | `plan-block` | `newPlanBlockMessage` :242-255 | `pb_<ts36>_<rand8>`（内联铸造） | `""`（空） | `{planCallId, block}` | plan_init 成功（`details.ok===true`）后每次调用一块冻结快照（`src/core/plan-blocks.ts:82-94`，幂等去重） | **丢弃过滤**（:629） |
| 6 | `practice-thinking` | `newThinkingMessage` :316-326 | `msg_…` | `"Your thinking:\n<text>"`（THINKING_LABEL） | `{problemCallId, text}` | thinking 输入事件（`src/core/input-events.ts:241`）；一道题可承载多次提交 | **展平保留** |
| 7 | `practice-next` | `newNextMessage` :334-344 | `msg_…` | `NEXT_PROBLEM_TEXT`（contracts/chat.ts:220） | `{}` | next 输入事件（`src/core/input-events.ts:254`）：题间暂停时的 Next chip 或空输入框 Enter | **展平保留** |
| 8 | `problem-dismissed` | `newProblemDismissedMarker` :352-362 | `msg_…` | `""`（空） | `{problemCallId}` | dismiss-problem 输入事件（`src/core/input-events.ts:147`） | **丢弃过滤**（:629）——模型向面孔延迟到合成 conclude 对 |
| 9 | `compaction` | `src/core/compaction.ts:263-273` `newCompactionMarker`（**不在本文件**） | `msg_…` | `COMPACTED_HISTORY_HEADER` + 摘要 | `CompactionDetails`（含 `firstKeptMessageId`） | 上下文压缩服务在回合间窗口执行（`src/server/compaction.ts`） | **特例**：活动 marker 的 content 作为 head 顶部渲染一次（:595-605）；head 已解析时保留尾内**所有** compaction marker 跳过（:633）；head 未解析时退化为展平保留（:634-638） |

矩阵要点：

- 9 种中只有 6 种的构造器在本文件；`subagent-steer`/`subagent-abort` 在 `contracts/jobs.ts`，`compaction` 在 `core/compaction.ts`——但**全部 9 种的模型向命运都由本文件的 `toLlmMessages` 裁决**，这正是"唯一缝"的含义。
- 确定性 id 的两种（probe-handoff、subagent-steer/abort）都是**投递幂等键**：`steerDelivered`（contracts/jobs.ts:435-436）按 id 查记录判重。
- 两种 UI-only marker 的 `content` 为空串并非偶然：它们没有模型向面孔。problem-dismissed 的模型向语义由 `concludedByDismissalPair` 在用户下一次输入时以 agent 自己的词汇（conclude 调用）补上。

### 2.4 导出常量（:53-54、:124、:261-262）

| 常量 | 行号 | 值 / 语义 |
|---|---|---|
| `INTERRUPTED_TEXT` | :53-54 | 中止回合未回答调用的硬不变量措辞："The question was interrupted — the learner never answered; continue without holding a result for it." 从 pre-native 时代**逐字**沿用，模型视图永不漂移 |
| `SEND_TO_USER_TOOL` | :124 | `"send_to_user"`——显式输出工具名 |
| `PRACTICE_PROBLEM_TOOL` | :261 | `"problem"`——练习题出题工具 |
| `PRACTICE_CONCLUDE_TOOL` | :262 | `"conclude"`——练习题收尾工具 |

后两者是 conclude-before-next-problem 闸门的词汇表（:259-260 注释：工具本体在 tool-execute 层，`src/agent/tools/practice.ts`）。

### 2.5 其余导出类型

| 类型 | 行号 | 形状 |
|---|---|---|
| `GraphContextPick` | :266-270 | `{id, name, statement}`——学习者挑选时刻**所见**的命题快照 |
| `QuestionCall` | :717-719 | `Omit<PendingQuestion,"key">` + `status: "streaming" \| "answerable" \| "malformed" \| "failed"` |
| `RequestCause` | :840 | `"foreground" \| "background"` |
| `ReconstructedCause` | :841 | `RequestCause \| "ambiguous"` |
| `NativeInputCause` | :842 | `"learner" \| "automatic" \| "neutral" \| "unrecognizable"` |

`PendingQuestion`（`src/core/pending.ts:43-49`）= `PendingToolCall`（toolCallId/tool/input，pending.ts:34-40）+ `messageId` + `contentIndex` + `key`（客户端-only 身份，永不持久化、永不随 answer 事件发送）。

---

## 3. 分组逐函数五要素深度拆解

五要素：**①** 完整签名、精确行号与纯度标签；**②** 输入输出与系统不变量；**③** 核心逻辑与分支逐步推导；**④** 边界条件与历史事故背景；**⑤** 真实上游调用方 `path:line`。

### 组① ID 与原生消息 / Marker 构造器组（11 个函数）

#### 3.1.1 `newMessageId`（:174-176）

- **①** `export function newMessageId(): string`——**非确定性**（`Date.now` + `crypto.randomUUID`）。
- **②** 输出 `msg_<ts36>_<rand8>`，全应用消息 id 形状（与 UIMessage 时代的铸造相同，:173 注释）。不变量：id 只是记录身份，永不进入模型向 wire（`toLlmMessages` :642 剥离）。
- **③** 单表达式：base36 时间戳 + 随机 UUID 前 8 字符。
- **④** 时间戳前缀给出粗略时间序，随机后缀防碰撞。客户端乐观消息**不**用它——用 `c_` 前缀的 `localId`（`components/session-core.ts:57-59`：`c_<ts36>_<seq>`），adoption 由此区分局部副本与记录副本（`isLiveQuestionPlaceholder` 与 `pendingQuestionOf` 都键控此前缀）。
- **⑤** 文件内：9 个构造器调用它；文件外：`src/server/turn-service.ts:80`（唯一规范写盘处为缺 id 的 pi 消息盖戳）、`src/core/input-events.ts:271`（出题重试的 error result）、`src/core/compaction.ts:265`（压缩 marker）。

#### 3.1.2 `newUserMessage`（:182-189）

- **①** `export function newUserMessage(text: string): LhMessage & UserMessage`——非确定性（id + timestamp）。
- **②** 学习者撰写的 user 消息（text 输入、verdict note，:181 注释）。content 为纯字符串。
- **③** 对象字面量：`id: newMessageId()`、`role:"user"`、`content:text`、`timestamp:Date.now()`。
- **④** 客户端乐观副本构造后**覆盖 id** 为 localId（`components/session-core.ts:703`：`{ ...newUserMessage(input.text), id: localId() }`）——构造器双端共用，身份各端自赋；server 预写的是构造器原样产物。
- **⑤** `src/core/input-events.ts:220`（text 输入追加）；`components/session-core.ts:703`（乐观追加）。

#### 3.1.3 `newUserSteer`（:196-198）

- **①** `export function newUserSteer(text: string, id: string): LhMessage & UserMessage`——id 由调用方传入（**客户端铸造**）；timestamp 非确定性。
- **②** 被插纸条的 user 消息（回合中 composer steering，owner 2026-10-03，:191-195 注释）。不变量：**同一个 id 贯穿三处**——`agent.steer()`、SSE 事件流的 message 事件、持久化记录——乐观排队指示器与记录卡片按同一身份 upsert。
- **③** 单行对象字面量；与 `newUserMessage` 的唯一区别是 id 不新铸。
- **④** id 来自客户端 steer 输入事件（`parseUserSteerInput`）。若 server 自铸 id，客户端乐观队列项将无法与记录副本对上——这是插纸条（术语表词条 13）乐观渲染的身份根基。
- **⑤** `app/api/chats/[id]/steer/route.ts:27`（唯一生产调用点；无运行中回合时 409 "no live turn to steer"，:28-30）。

#### 3.1.4 `newAnswerResult`（:206-223）

- **①** `export function newAnswerResult(toolCallId: string, toolName: string, answer: unknown): LhMessage & ToolResultMessage`——非确定性。
- **②** 学习者的答案 = 问题调用的工具结果（fork 1）。**双受众**（owner，tool-result diet 2026-10-02，:200-205 注释）：
  - `content` = `JSON.stringify(compactAnswerForModel(answer))`——模型看到紧凑的学习者-only 记录；
  - `details` = **完整**评分后 `QuestionAnswerData`——给记录与 UI。
- **③** 瘦身逻辑在 `compactAnswerForModel`（`src/core/question-core.ts:779-802`）：dismissed → `{kind, dismissed:true}`；否则保留 kind、dontKnow、answers（仅 index+label）、text、other、correct（dontKnow 时隐含不写）、confidence、thinking（旧键 `note` 兼容）、thinkingWhileReading（`readingThinking`）。**题干/选项/解释/承诺已在调用自己的 arguments 里**——复述它们会让每条答案的 token 翻倍（:203-204）。
- **④** 0.87.1 版把 `ToolResultMessage.details` 收窄为 `JsonRepresentation`；注释（:217-218）声明 cast 诚实——答案结构 JSON-safe。`isError` 恒 false：被拒答案不走此构造器；error result 由 `questionRecoveryAppends` 构造（`src/core/input-events.ts:270-273`）。details 的完整载荷还是 `nativeInputCause` 形状校验（§3.6.5）与 `isDismissedResult`（§3.6.1）的数据源——双受众设计在记录侧推导中持续付息。
- **⑤** `src/core/input-events.ts:156`（dismiss）、`:226`（answer）；`components/session-core.ts:715`（answer 乐观）、`:862`（dismissQuestion 乐观）。

#### 3.1.5 `newHandoffMessage`（:227-237）

- **①** `export function newHandoffMessage(chatId: string): LhMarkerMessage`——**id 确定性**（`steer_probe_${chatId}`）；timestamp 非确定性。
- **②** probe→teach 交接唤醒：脚手架而非话语（:225-226 注释）——模型读 `HANDOFF_TEXT`，UI 渲染安静的系统行。
- **③** `customType:"probe-handoff"`、`content:HANDOFF_TEXT`、`display:true`、`details:{chatId}`。
- **④** 确定性 id 是幂等投递键：每会话恰好一次交接；`steerDelivered`（`src/core/contracts/jobs.ts:435-436`）按 id 查记录判重，重复投递安全。`HANDOFF_TEXT`（contracts/chat.ts:187-191）是学习者口吻的下一步指令（"Next: plan the full teaching arc…"）——marker 展平为 user 角色后必须读作学习者话语通道里的注入上下文，而非系统广播。
- **⑤** `src/core/contracts/jobs.ts:429`（`buildProbeHandoffSteer`）→ probe_done 的 execute 排队（`src/agent/tools/probe.ts`）→ 唤醒流水线 pump 在探测者回合结束后点火。

#### 3.1.6 `newPlanBlockMessage`（:242-255）

- **①** `export function newPlanBlockMessage(planCallId: string, block: unknown): LhMarkerMessage`——非确定性（内联 id 铸造 + timestamp）。
- **②** 计划呈现块：纯 UI 历史（冻结快照），无模型面孔——`toLlmMessages` 过滤（:239-241 注释）。
- **③** id 为 `pb_<ts36>_<rand8>`（:247 内联，与 `newMessageId` 同形不同前缀）；`content:""`；`details:{planCallId, block}`。
- **④** `planCallId` 键控幂等发射：每次成功 plan_init 调用一块。去重在上游 `src/core/plan-blocks.ts:82-94`：`emittedPlanBlockCalls` 扫记录中已发射的 call id，`details.ok !== true` 跳过，取最后一个合格 result——持久化重放安全（turn-service.ts:54-55 注释）。
- **⑤** `src/core/plan-blocks.ts:94`（唯一生产调用点；由 `persistTurn` 调用，`src/server/turn-service.ts:83`）。

#### 3.1.7 `newGraphContextMessage`（:279-308）

- **①** `export function newGraphContextMessage(picks: readonly GraphContextPick[], chains: readonly string[]): LhMarkerMessage`——非确定性。
- **②** 会话的地图上下文（owner 2026-10-04，:272-278 注释）：**独立** custom 消息，置于学习者第一条 user 消息**之前**——挑选的命题 + 其间推理链（预格式化 `formatChainLine` 行）。不再把种子文本粘进第一条 prompt。
- **③** 文本组装含两条 owner 裁定：
  1. **IDS FIRST**（round 9，2026-10-05，mastery-trace 契约，:280-284）：每个命题以 id/name/statement 引入一次（`- [id] name: statement`，:294）；problem 工具的 `target` 字段取这些 id（名字在缝处归一化为 id）。推理链保持**名字**——它们是理解上下文，不是标签；"names read, ids reference"。
  2. **PREAMBLE LAW**（owner 2026-10-10，:286-290）：marker 在 wire 上展平为 USER 角色，此文本抵达学习者话语通道，故不得读作系统广播——方括号约定 `[Session context]`（`NEXT_PROBLEM_TEXT` 的同族）诚实标记其为注入的会话上下文，而非学习者话语。
- **④** chains 为空时省略推理链段（:296-298）。`details:{propositions:picks, chains}` 喂可折叠 GraphContextCard（`components/graph-context-card.tsx:8-20`）。picks 是挑选时刻快照，不是图谱活引用——图谱后续合并不改写会话开场。
- **⑤** `app/api/chats/route.ts:68`（创建会话路由：picks 校验并截断至 64，`chainsForSelection` + `formatChainLine` 预格式化后 `saveMessages`）。

#### 3.1.8 `newThinkingMessage`（:316-326）

- **①** `export function newThinkingMessage(problemCallId: string, text: string): LhMarkerMessage`——非确定性。
- **②** 学习者的思考提交（**一条发送 lane**，owner round 2026-10-05，:310-315 注释）：语域不再由按钮声明——模型**读文本**分辨 working trace 与 claimed answer。
- **③** `content = `${THINKING_LABEL}:\n${text}``（唯一标签 "Your thinking"，contracts/chat.ts:204）；`details:{problemCallId, text}` 保留原始载荷给记录卡片。
- **④** 一道题可承载多次提交（一对多）；`problemCallId` 锚定归属。输入闸门：必须命中活动题（`activeProblemOf`），否则诚实 400（input-events.ts:237-240）。客户端乐观副本令卡片在按钮点火瞬间渲染（session-core.ts:706-708 注释）。
- **⑤** `src/core/input-events.ts:241`（thinking 输入，前置 `dismissalConclusion`）；`components/session-core.ts:708`（乐观）。

#### 3.1.9 `newNextMessage`（:334-344）

- **①** `export function newNextMessage(): LhMarkerMessage`——非确定性。
- **②** 学习者的显式 move-on 信号（owner round 16，:328-333 注释）：由 next 输入追加——composer band 的 chip，或题间暂停时空 composer 的 Enter。
- **③** `content = NEXT_PROBLEM_TEXT`（单一来源，contracts/chat.ts:220-221："[NEXT PROBLEM] — the learner's explicit go-ahead…"）；`details:{}`；UI 从 marker 渲染自己的紧凑行，**永不渲染 content**（:332-333）。
- **④** 输入闸门严格（input-events.ts:243-255）：仅 practice 会话、无活动题，否则诚实 400——"the signal is a between-problems affordance"。模型读到此文后按 doctrine 出下一题或以散文收尾。
- **⑤** `src/core/input-events.ts:254`；`components/session-core.ts:712`（乐观）。

#### 3.1.10 `newProblemDismissedMarker`（:352-362）

- **①** `export function newProblemDismissedMarker(problemCallId: string): LhMarkerMessage`——非确定性。
- **②** 练习题丢弃 marker（ask-style discard，owner 2026-10-04，:346-351 注释）：**UI-only**——`toLlmMessages` 过滤。
- **③** `content:""`；`details:{problemCallId}`。
- **④** 模型向面孔**延迟抵达**：用户下一次输入时，合成 conclude 对（`concludedByDismissalPair`）前置——agent 把丢弃读作它自己"做出"的 outcome 为 `"dismissed"` 的 conclude 调用，槽位释放与丢弃都通过它拥有的唯一词汇表达。这是"延迟合成"设计的核心：marker 立即落盘（UI 立即释放槽位、composer 回归），模型向面孔等下一次输入（不唤醒任何回合）。
- **⑤** `src/core/input-events.ts:147`（dismiss-problem）；`components/session-core.ts:883`（乐观，随后 SILENT 路由持久化——无回合、无流、无唤醒）。

#### 3.1.11 `concludedByDismissalPair`（:371-413）

- **①** `export function concludedByDismissalPair(problemCallId: string): [LhMessage & AssistantMessage, LhMessage & ToolResultMessage]`——记录消息 id 非确定性；**合成调用 id 确定性**。
- **②** 丢弃的延迟 conclude（owner ruling 2026-10-04，:364-370 注释）：前置到用户**下一次**输入的对——合成 assistant 消息携带 conclude 调用（outcome `"dismissed"`）+ 其 ack 结果，使记录与模型上下文都把该题读作"由丢弃收尾、槽位已释放"。
- **③** 逐步：
  1. `callId = `call_conc_${problemCallId}``（:374）——确定性，幂等形状键；
  2. `syntheticStamps`（:380-393）：`api:"faux"`、`provider:"synthetic"`、`model:"synthetic-conclude"`、全零 usage（含全零 cost）、`stopReason:"toolUse"`；
  3. 第一条（:395-401）：assistant，content 为单个 toolCall 块（`conclude`，`arguments:{outcome:"dismissed"}`），展开 syntheticStamps；
  4. 第二条（:402-411）：toolResult，`toolCallId=callId`，content 为 `CONCLUDE_ACK_TEXT`（contracts/chat.ts:213-214，与真实 conclude 执行**共享**——"a concluded problem reads identically to the model however it concluded"），`details:{outcome:"dismissed", problemCallId}`，`isError:false`。
- **④** **假戳为何安全**（:376-379）：历史序列化只读 content 块（已在 pi-ai 的 converters 中验证）；应用的金钱通道是并行的 turns log，从不是消息对象——"synthetic" 永不污染 wire 视图或成本折叠。`stopReason:"toolUse"` 使所有扫描把它当作完成 generation。`reconstructRequestCause`（:886）以四重匹配（provider+api+model+outcome）精确识别此形状，**不**把它当请求批次边界。幂等由 `pendingProblemDismissalOf` 闸门保证：每 marker 至多一对（对落盘后，clean conclude 令扫描返回 null）。
- **⑤** `src/core/input-events.ts:339`（`dismissalConclusion`，骑 text/continue/thinking/next 四种追加的前置）。

### 组② 唯一模型向投影缝 toLlmMessages（3 个函数）

#### 3.2.1 `asAgentMessages`（:118-120）

- **①** `export function asAgentMessages(messages: readonly LhMessage[]): AgentMessage[]`——**纯**（仅类型断言，零运行时逻辑）。
- **②** 记录消息列表可赋值给 agent 上下文——**这个可赋值性就是回放本身**（:116-117 注释）。双重断言 `as unknown as AgentMessage[]`：`LhMessage` 的 id/cliContextWindow 是额外字段；声明合并（:88-92）使 `LhMarkerMessage` 成为 `AgentMessage` 的合法成员。
- **③** 单行 return。
- **④** 注释指向物理赋值位：ui-stream/chat-handler 把它赋给 `initialState.messages`。断言的诚实性由"记录即 pi 形状 + 一个 id 字段"的设计保证。
- **⑤** `src/server/chat-handler.ts:448`（initialMessages）、`:449`（staged）、`:464`（messages）；tests：send-to-user.test.ts:340/357、practice-record.test.ts:315/323/328、retry-failed-turn.test.ts:386/406/422、claude-code-context-window.test.ts:75。

#### 3.2.2 `resultIdsFrom`（私有，:555-563）

- **①** `function resultIdsFrom(messages: readonly AgentMessage[]): Set<string>`——纯。
- **②** 收集给定消息段中每条 toolResult 的 `toolCallId`（:554 注释："for the dangling-call scan"）。不变量：调用"已回答"当且仅当其 id 出现在此集合——**无论结果是否 error**（error result 也是解析，重试上下文占据槽位）。
- **③** 单循环：`role==="toolResult"` → `ids.add(toolCallId)`。
- **④** 三个调用位传入不同段：`toLlmMessages` 传 `messages.slice(i+1)`（:652，某 assistant 之后的**整个尾部**）；`questionCallsOf` 传 `messages.slice(mi+1)`（:728）；`answeredCallIds` 传全记录（:789）。尾部不限相邻消息——与并行问题闸门下的 provider 形状法则一致（所有 result 与调用 assistant 相邻，`src/server/chat-handler.ts:346-355`）。
- **⑤** 文件内：:652、:728、:789。

#### 3.2.3 `toLlmMessages`（:583-667）——本卷核心

- **①** `export function toLlmMessages(messages: readonly AgentMessage[]): Message[]`——**纯投影**（合成结果的 timestamp 取 `assistant.timestamp`，不引入新非确定性源）。
- **②** 输入：agent 上下文消息（记录路径 = `LhMessage[]`；live 路径 = 含领先 SystemMessage 的 pi 消息）。输出：provider wire 的 `Message[]`。**契约（pi-agent-core）：never throws**——未知形状原样通过，绝不杀死循环（:580-581）。接线为 agent 的 `convertToLlm`（`src/agent/teacher-agent.ts:256`），是模型向决策的唯一居所（:565-582 注释）。
- **③** 五段流水线逐步推导：

  **第一段——压缩切割（THE COMPACTION CUT，owner round 14，2026-10-05，:584-605）**：
  1. `activeCompactionOf(lhMessages)`（core/compaction.ts:278-291）：从尾部找**最新**的、带 `details.firstKeptMessageId` 的 compaction marker——链式压缩，最后一个说了算；
  2. `keptIndexFor`（core/compaction.ts:296-302）：在记录中查该 id 的下标；找不到返回 -1；
  3. 仅当 `kept > 0` 才切割：`start = kept`，`head` = 携带 `marker.content`（header+摘要）的 user 消息，timestamp 取 marker 的。head **顶部渲染一次**；
  4. 两种诚实退化：`kept===0`（无可丢弃）与 `kept===-1`（切割指向缺失 id，corrupt/foreign）都保持 `start=0, head=null`——全部渲染，永不 throw（:589-590 注释）。

  **第二段——领先系统消息是请求装具，永不可压缩（THE LEADING SYSTEM MESSAGE IS REQUEST CHROME，the OpenRouter no-tools incident，owner 2026-10-05，:606-621）**：
  - pi-agent-core 的 Agent 在 `state.messages[0]` 播种一条 SystemMessage，携带系统提示词**与工具声明**（`createInitialSystemMessage`——"messages declare the provider-visible loadout"）；
  - 记录从不持久化它（ui-stream 的 `settleWith` 按角色整体过滤，`src/server/pi/ui-stream.ts:228-231`），所以**记录路径**调用者看不到它——但 Agent 的 `convertToLlm` 看得到；
  - 因此当 `messages[0].role==="system"` 时，它必须被携带在压缩 head **之前**（:617-620），恰如 pi 自己的 `prepareRequest` 在其投影周围重新施加 `context.systemPrompt + context.tools`；
  - 循环起点变为 `leading ? Math.max(start, 1) : start`（:622）——chrome 已 push，永不重复渲染；切割切的是**记录的历史**，永远切不到 chrome。事故背景：OpenRouter 路径上工具声明随系统消息走，若被压缩切割吞掉，模型将看不到任何工具（no-tools incident）。

  **第三段——marker 展平 / 过滤（:625-640）**：
  - `plan-block` 与 `problem-dismissed` → `continue`（UI-only；后者的模型面孔由合成 conclude 对携带，:627-629）；
  - `compaction` 且 `head !== null` → `continue`——**head 取代每一个 compaction marker**，不只是它自己存储位置的那个：旧摘要的存储位置可能仍在切割点之后，无此规则会被二次渲染（:630-633）；
  - `head === null`（切割未解析）→ compaction marker 落入通用展平，保留含摘要文本的全历史回退（:630-633）；
  - 其余 marker → `{role:"user", content:[{type:"text", text:marker.content}], timestamp:marker.timestamp}`（:634-638）——id/details/display/customType 全部留在记录侧，模型只见规范文本。

  **第四段——原生直通 + 元数据剥离（:641-643）**：
  ```ts
  const { id: _id, cliContextWindow: _cliContextWindow, ...native } = m as LhMessage;
  out.push(native as Message);
  ```
  user/assistant/toolResult **逐字**通过——签名、usage、provider 戳全原生——仅减去两个 app-only 字段。这就是文件头所说的 "verified single site"：provider 永不见记录 id。其余字段（含 toolResult 的原生 details）随原生形状通过，最终进入 provider 请求体的内容由 pi-ai 的 converters 决定。

  **第五段——悬空调用合成（:644-664）**：
  - 仅 assistant 消息触发；`stopReason === "error" || "aborted"` → **跳过合成**（:649）；
  - 收集 content 中全部 toolCall 块；无 → continue；
  - `answered = resultIdsFrom(messages.slice(i + 1))`——此 assistant 之后的整个尾部；
  - 对每条未回答调用 push 合成 toolResult：`{toolCallId: call.id, toolName: call.name, content:[{type:"text", text: INTERRUPTED_TEXT}], isError:false, timestamp: assistant.timestamp}`（:655-662）。

- **④** 边界与事故背景（本函数是全文件精妙细节最密集处）：
  - **失败/中止生成的调用为何不能合成孤儿 result**（:575-578、:644-646）：Pi 自己会丢弃那些 assistant 消息（pi filters error/aborted assistants itself）。若在此为它们**从未执行**的调用制造结果，这些结果在 wire 上将失去所属 assistant——成为**孤儿 result**（定义：所属 assistant 消息已被过滤掉的 toolResult），被 provider 协议拒绝。失败生成根本不执行其调用，"无结果"是它们的正常态，不是悬空态。
  - **只有成功生成的 assistant 才可能留下真悬空调用**：典型是中止回合里未回答的问题——注意区分"回合被中止"与"生成失败"：前者的 assistant 是完成 generation（stopReason 非 error/aborted），其问题调用合法悬空，必须合成；后者的 assistant 整条被 pi 丢弃，合成即制造孤儿。
  - `INTERRUPTED_TEXT` 的 `isError:false`——它不是错误结果；措辞指示模型"continue without holding a result for it"。措辞从 pre-native 时代逐字沿用（:50-52），模型视图永不漂移。
  - 合成结果紧跟其所属 assistant 插入，保持 provider 的顺序要求；历史中段的悬空调用（例如学习者放弃旧问题直接发新文本）同样被修复，而非只处理尾部。
  - never-throws 契约：全函数无 throw 路径；未知角色走第四段直通。
- **⑤** `src/agent/teacher-agent.ts:256`（convertToLlm，唯一生产接线）；`src/server/compaction.ts:167`（`projectedContextTokens` 的回退路径在**切割 honored 的投影**上估算——触发法则的回退永不估算被丢弃段）；tests：retry-failed-turn.test.ts:386/406/422（孤儿 result 防范）、practice-record.test.ts:315/323/328（marker 命运）、compaction.test.ts:285、send-to-user.test.ts:357、claude-code-context-window.test.ts:75（元数据剥离）。

### 组③ 提问与答题配对 / 待答扫描折叠组（7 个函数）

#### 3.3.1 `questionCallsOf`（:724-742）

- **①** `export function questionCallsOf(messages: readonly LhMessage[]): QuestionCall[]`——纯。
- **②** 问题调用的权威扫描：**只看最新一条原生 assistant 消息**，siblings 保持调用顺序（:721-723 注释）。不变量："No result alone is NOT proof of a posed question"——失败生成从不执行其调用，旧记录可能含截断/未校验输入。
- **③** 逐步：
  1. 从尾部找第一条 `role==="assistant"` 消息（:725-727）；
  2. `answered = resultIdsFrom(其后尾部)`（:728）；
  3. 按 content 顺序遍历：仅 name 在 `QUESTION_TOOLS`（quiz/probe/ask_user_question/explain/recall，pending.ts:53-59）且 id 不在 answered 的 toolCall 块进入分类；
  4. status 优先级（:732-735）：
     - `stopReason` error/aborted → **failed**；
     - `stopReason` pending → **streaming**；
     - `stopReason` length **或** `block.argumentsError` **或** `!parseQuestionInput(name, args)` → **malformed**；
     - 否则 → **answerable**；
  5. **立即 return**（:739 注释："never revive older calls, even when this message has none"）——最新 assistant 是纯文本时返回 `[]`，绝不复活更旧的调用。
- **④** malformed 的三个来源对应三种真实失败形态：length = 截断生成；`argumentsError` = pi 原生参数解析失败（模型抖动，术语表词条 95 的对象）；`parseQuestionInput` 失败 = 显示有效性（tool-parts.ts:118-125，与答题 dock 运行**同一**解析——boundary-valid ⇔ consumer-parseable）。failed 状态保持调用"未决"（`hasUnresolvedQuestion` 计数它）但不赋予可答性——失败重试（术语表词条 22）路径拥有它。
- **⑤** `src/core/input-events.ts:266`（questionRecoveryAppends 的目标校验）；文件内：danglingQuestionOf :677、pendingQuestionOf :689、hasUnresolvedQuestion :747、malformedQuestionsOf :752、nativeInputCause :854。

#### 3.3.2 `isLiveQuestionPlaceholder`（私有，:711-715）

- **①** `function isLiveQuestionPlaceholder(message: LhMessage): boolean`——纯类型守卫。
- **②** 识别客户端瞬态占位结果：`role==="toolResult"` **且** id 以 `c_` 开头 **且** `!isError` **且** `details===null` **且** toolName 在 QUESTION_TOOLS——五条件缺一不可。
- **③** 单布尔表达式。
- **④** 注释（:708-710）划出三条边界：真实答案有 details（`newAnswerResult` 必写完整载荷）；errors/aborts 仍是解析性结果（error result 占槽，不是占位）；**已保存的 null 结果不被这个 client-only 兼容缝重新解释**——server/持久化结果策略原样。占位的物理原型是 `questionResult()`（src/agent/tool-execute.ts:237-249，details:null、terminate:true）；server 的 `persistTurn` 整体过滤它（turn-service.ts:72-79），故它只能出现在客户端乐观尾（`c_` 前缀，session-core.ts:57-59）。
- **⑤** 文件内：pendingQuestionOf :689、malformedQuestionsOf :752。

#### 3.3.3 `danglingQuestionOf`（:674-679）

- **①** `export function danglingQuestionOf(messages: readonly LhMessage[]): {toolCallId: string; tool: string; input: unknown} | null`——纯。
- **②** 待答问题闸门的**server 权威**（:671-673 注释："findPendingToolCall's native twin"）：`questionCallsOf` 的第一个 answerable 调用。**不过滤占位**——server 记录不含占位（persistTurn 已过滤），无需过滤。
- **③** 一次 find + 形状投影（丢 messageId/contentIndex/status，留三元组）。
- **④** answer/dismiss 输入事件以它校验：目标调用必须存在且可答，否则诚实 400（input-events.ts:150-152/223-225）。会话列表的 pendingQuestion 徽标也派生自它（store/chats.ts:109）。"最新 assistant 的第一个可答调用"意味着并列题目按 content 顺序逐题推进（chat-flow.test.ts:781 钉住此语义）。
- **⑤** `src/core/input-events.ts:149`（dismissAppends）、`:222`（inputAppends answer）；`src/store/chats.ts:109`（列表摘要）；tests：pending-authority.test.ts:58（"server authority/shape unchanged"）、chat-flow.test.ts:313/727/773/816 等、dismissal-park.test.ts:107/154、claude-code-harness.test.ts:218/246/281、golden-fixtures.test.ts:82。

#### 3.3.4 `pendingQuestionOf`（:685-706）

- **①** `export function pendingQuestionOf(messages: readonly LhMessage[]): PendingQuestion | null`——纯。
- **②** 同一权威的**客户端版本**，为答题 dock 保留原生边界（messageId/contentIndex），外加 `key` 供草稿/重置身份。不变量（:681-684）：唯一化调用 id 在 live 消息的局部 id 被持久化戳替换时仍稳定；只有碰撞 id 需要 occurrence-qualified key；**永不改变存储 id 或 answer wire**。
- **③** 逐步：
  1. 先过滤 `isLiveQuestionPlaceholder`（:689）——turn_end 包含临时 questionResult 确认，它**不是**学习者的答案；仅从客户端权威排除，持久化/server 结果策略原样（:686-688 注释）；
  2. find 第一个 answerable；无 → null；
  3. occurrence 计数（:692-699）：遍历**全部**消息，仅 id 不以 `c_` 开头的 assistant（settled history），数其中 id 等于问题 toolCallId 的 toolCall 块；
  4. key（:703）：`occurrences > 1` → `JSON.stringify([messageId, contentIndex, toolCallId])`；否则 toolCallId 本身。
- **④** **为何计数排除 c_ assistant**（:693-696 注释）：流式 c_ assistant 在 append-only adoption 期间可能与其已保存副本短暂共存——计入会虚增 occurrence。新 live 调用已被唯一化（native wire 的唯一 sanctioned 重写，the Lacan fix 2026-10-04，`src/server/pi/ui-stream.ts:9-11`：DeepSeek 每响应重置 `call_0`，`ToolCallIdUniquifier` 在边界唯一化）；**只有 settled 历史确立复用**。key 是 client-only：`questionDrafts`/`unconfirmedAnswers` 以它为键（session-core.ts:918-925），send 校验 questionKey 防止 render-scoped 答案移动到共享 id 的另一 occurrence（session-core.ts:656-661）。
- **⑤** `components/chat.tsx:453`（与 `findPendingToolCall`（pending.ts:143-145）交叉校验——view 扫描必须命中同一调用，术语表词条 10）；`components/session-core.ts:656`（send 校验）、`:684`（error-recovery 重 fetch 校验）、`:858`（dismissQuestion 校验）、`:918`（forgetResolvedDrafts）；`scripts/sandtable/board.ts:225`（沙盘 question 棋子派生）。

#### 3.3.5 `hasUnresolvedQuestion`（:746-748）

- **①** `export function hasUnresolvedQuestion(messages: readonly LhMessage[]): boolean`——纯。
- **②** `questionCallsOf(messages).length > 0`——**任何 status 都算**（streaming/answerable/malformed/failed）。不变量（:744-745）：问题不可用时，后台唤醒仍须等待显式学习者动作；释放 composer 不是重试许可。
- **③** 单表达式。
- **④** 这是"问题悬空期间 nothing else can generate"（chat-handler.ts:354-355）的记录级表达：job 唤醒等待、续跑折叠拒绝、composer 闸门。**deepseek parallel batch incident**（owner 2026-10-03，chat-handler.ts:346-355）：留下 sibling 问题悬空的答案延迟其唤醒；最后一个答案点火唯一反应回合，所有 result 与调用 assistant **相邻**——provider 形状法则（在 intervening assistant 之后追加的 tool result 会被拒绝，修复前曾把 sibling 问题永久搁浅）。
- **⑤** `src/server/chat-handler.ts:356`（并行问题闸门：保存答案、延迟唤醒）；`src/server/jobs.ts:707/714`（waitForIdle 双重检查）；`src/agent/tools/probe.ts:69`（probe_done 在问题未决时拒绝）。

#### 3.3.6 `malformedQuestionsOf`（:751-753）

- **①** `export function malformedQuestionsOf(messages: readonly LhMessage[]): QuestionCall[]`——纯。
- **②** 过滤占位后取 `status==="malformed"`——出题重试 UI 的数据源。
- **③** 两次 filter 链。
- **④** 与 `pendingQuestionOf` 共享同一占位排除——客户端临时 ack 不得被计为 malformed 问题。retry-question 输入事件的校验直接走 `questionCallsOf`（input-events.ts:266-269）：目标必须仍是 malformed，且不得有 answerable sibling 残留（"Answer or discard the remaining question before retrying this one"）。
- **⑤** `components/chat.tsx:454`（malformedQuestions → 重试入口）；tests：malformed-question-recovery.test.ts:73/117/131/142/195。

#### 3.3.7 `answeredCallIds`（:788-790）

- **①** `export function answeredCallIds(messages: readonly LhMessage[]): Set<string>`——纯。
- **②** 记录中每条 toolResult 的 id——answer 事件校验词汇（:786-787 注释：调用必须是悬空问题调用，而非已回答者）。
- **③** 直接委托 `resultIdsFrom`。
- **④** error result 也算 answered（槽位被占）——与 `resultIdsFrom` 不变量一致。
- **⑤** 当前无生产调用点（生产校验走 `danglingQuestionOf` 的 answerable 语义）；导出由测试钉住：`tests/dismissal-park.test.ts:123`（丢弃暂存落账后调用进入 answered 集）。

### 组④ 探测交接判定组（2 个函数）

#### 3.4.1 `probeDoneResultIds`（:760-778）

- **①** `export function probeDoneResultIds(messages: readonly LhMessage[]): Set<string>`——纯。注意：返回**结果消息 id**，不是调用 id。
- **②** 成功的 probe_done 结果消息 id，按记录顺序（:755-759 注释）。不变量：失败/中止生成的调用不授予完成权威；其后的结果必须同时匹配 call id 与 tool name、必须非 error、必须未以 `details.ok:false` 显式拒绝；旧的无 `ok:true` 的干净确认仍计数；不改历史。
- **③** 前向单遍、两个集合：
  1. assistant 且 stopReason 非 error/aborted → 收集 probe_done 调用 id 入 `calls`（:764-768）；
  2. toolResult 且 `toolName==="probe_done"` 且 `toolCallId ∈ calls` 且 `!isError` 且 `details?.ok !== false` → 收集 **m.id** 入 `results`（:769-775）。
- **④** 前向扫描保证调用先于结果（calls 增量填充，结果只能匹配已见调用）。拒绝判别三重：isError（执行失败）、ok:false（显式拒绝：问题未决或已收尾，probe.ts:69-75）、失败生成（无权威）。旧记录兼容：老干净确认无 ok 字段，`!== false` 放行。返回消息 id 而非调用 id，因为 phases.ts 在**结果消息的位置**推进阶段（phases.ts:169-173：probe→plan 在干净 result 处 advances）。
- **⑤** `src/core/phases.ts:169`（phaseAt3Lh 的 concluded 集）；文件内：hasProbeDone :783。

#### 3.4.2 `hasProbeDone`（:782-784）

- **①** `export function hasProbeDone(messages: readonly LhMessage[]): boolean`——纯。
- **②** probe→teach 的**构造缝**（:780-781 注释）：只有收尾的调用加匹配的成功结果才意味着 teach。
- **③** `probeDoneResultIds(messages).size > 0`。
- **④** 此布尔决定每回合构建哪个 agent：true → TEACHER（planning + 全工具集），false → PROBER（quiz/ask + probe_done）（chat-handler.ts:425-429）。裸调用与被拒结果保持 probing（probe.ts:44-46 注释）。阶段折叠（phases.ts）与构造缝读同一权威——永不分歧；沙盘用同一折叠推断角色（board.ts:206）。
- **⑤** `src/server/chat-handler.ts:429`（agent 构造）、`:301`/`:709`（压缩服务的 kind 参数）；`src/agent/tools/probe.ts:22`（probeConcluded：拒绝二次交接）；`scripts/sandtable/board.ts:206`（角色派生）、`:238`（handoff 投递推断）。

### 组⑤ 练习题生命周期扫描组（5 个函数）

#### 3.5.1 `cleanToolCallIds`（私有，:422-430）

- **①** `function cleanToolCallIds(messages: readonly LhMessage[]): Set<string>`——纯。
- **②** 结果**干净**（非 error）的调用 id 集——"the only calls that ever happened"，per honest-activation ruling（:420-421 注释）。
- **③** 单循环：role toolResult 且 `!isError` → add toolCallId。
- **④** 与 `resultIdsFrom` 的区别：后者把 error result 也算解析（**槽位语义**），前者只认干净结果为"发生过"（**激活语义**）。悬空调用（无结果）两者都不在。
- **⑤** 文件内：problemInputForConclude :464、activeProblemOf :488、pendingProblemDismissalOf :521。

#### 3.5.2 `activeProblemOf`（:481-514）

- **①** `export function activeProblemOf(messages: readonly LhMessage[]): {toolCallId: string; input: unknown} | null`——纯。
- **②** 活动题折叠（conclude-before-next-problem 闸门）：**最新的、其后无任何收尾的 problem 工具调用**（:415-419 注释）。conclude 调用或丢弃 marker 都使其失活；**pose 时刻的 ack 结果不会**——题在 nudges 期间保持在屏；dock 的主题是调用，不是悬空结果。
- **③** 反向扫描（:489-512）：
  1. custom 消息：`problem-dismissed` → **return null**（丢弃失活）；其他 marker continue；
  2. assistant 消息：content 块**逆序**遍历（后块优先）：
     - conclude 调用：id ∈ cleanCallIds → return null（**干净 conclude 释放**）；否则 continue（errored/dangling conclude：释放从未发生）；
     - problem 调用：id ∈ cleanCallIds → return `{toolCallId, input: block.arguments}`（**激活**）；否则继续扫描（errored/dangling pose——它没通过）；
     - 其他块跳过；
  3. 扫描耗尽 → null。
- **④** **HONEST ACTIVATION**（owner ruling 2026-10-05，**the BKT incident**，:484-487）：调用只通过其**结果**计数——题在干净 ack 上激活，conclude 在干净 ack 上释放；errored 与 dangling 调用被跳过（"either it goes through or it doesn't"）。事故前折叠计数裸调用，被拒 pose 会虚假占槽。注意练习 pose ack **持久化**（与问题占位不同；模型之后读自己的 "Problem posed" 结果，:924-926），且 details==null、isError false——故进入 cleanCallIds、激活题目。逆序块遍历处理单消息多调用：较后的 conclude 先于较早的 pose 被考虑。
- **⑤** `components/chat.tsx:464`（dock 所有权：活动题取代 composer，与待答问题同规则）；`src/agent/tools/practice.ts:67`（createPracticeGate：每回合从记录种子化一次闸门，executes 翻转闭包——记录尚不能持有的回合内真相）；`src/core/input-events.ts:143`（dismiss-problem 校验）、`:237`（thinking 校验）、`:251`（next 要求无活动题）。

#### 3.5.3 `pendingProblemDismissalOf`（:520-550）

- **①** `export function pendingProblemDismissalOf(messages: readonly LhMessage[]): string | null`——纯。
- **②** 是否有 problem-dismissal marker 在等它的 conclude 合成？（:516-519 注释）text/continue 追加读它：对骑用户下一次输入。**Newest-marker-wins 扫描**：从尾部起的第一个丢弃 marker 或 conclude 调用决定。
- **③** 反向扫描：
  1. `problem-dismissed` marker → return 其 `details.problemCallId`；
  2. assistant 块逆序：干净 conclude → null（settles it）；干净 problem pose → null（**supersedes it**——丢弃之后又出了新题，旧 marker 作废）；errored/dangling conclude/pose → continue（从未发生）；
  3. 耗尽 → null。
- **④** "clean pose supersedes"分支（:541-544）处理序列：丢弃 → 新题已出 → 旧丢弃不再需要合成。`input-events.ts` 的 `dismissalConclusion`（:337-340）在每次 text/continue/thinking/next 追加时调用——对至多前置一次（对落盘后，干净 conclude 令扫描返回 null，幂等闭环）。
- **⑤** `src/core/input-events.ts:338`（唯一生产调用点）。

#### 3.5.4 `problemInputForConclude`（:452-479）

- **①** `export function problemInputForConclude(messages: readonly LhMessage[], concludeCallId: string): {statement?: unknown; mode?: unknown; target?: unknown; modelSolution?: unknown} | undefined`——纯。
- **②** 完整 pose 侧折叠（owner round 17，2026-10-06，observability，:446-451 注释）：agent 填入 problem 调用的一切——mode、target ids、statement、承诺的解答——joined 到 conclude part，使卡片的可折叠 "agent's data" 抽屉纯渲染。
- **③** 逐步：
  1. findIndex 含该 conclude 调用的 assistant 消息（:456-462）；找不到 → undefined；
  2. `clean = cleanToolCallIds(messages)`；
  3. 从该消息**向前**，仅 assistant 消息，块逆序：第一个 id 干净的 problem toolCall → return 其 arguments（:465-476）；
  4. 耗尽 → undefined。
- **④** **与 reveal 同一行走与拒绝法则**：记录从未 ack 的 pose（被拒调用）不折叠任何东西（:472 注释 "a refused pose revealed nothing"）。向前行走找到的是**此 conclude 之前最近的干净 pose**——并列题目序列匹配最近前置调用（practice-record.test.ts:397-398 钉住：两个 pose 各自的 conclude 各取其近）。conclude 调用本身可以 errored/dangling——此折叠不检查 conclude 的干净性（它回答"这个 conclude 指向的 pose 是什么"，供显示；激活闸门是 `activeProblemOf` 的职责）。
- **⑤** `src/core/view.ts:259`（part.problemInput 富化）；`src/core/session-markdown.ts:129`（Markdown 导出的 model solution 引用）。

#### 3.5.5 `modelSolutionForConclude`（:438-444）

- **①** `export function modelSolutionForConclude(messages: readonly LhMessage[], concludeCallId: string): string | undefined`——纯。
- **②** 结论的揭示（owner round 2026-10-05，:432-437 注释）：conclude 卡片的主角是 **pose 时刻承诺的 modelSolution**——此 conclude 调用之前最新的干净 pose。
- **③** 委托 `problemInputForConclude`；仅当 `modelSolution` 是 string 时返回。
- **④** 揭示**永不重新撰写**（slim schema  dropped solutionReveal）；仍携带自己 solutionReveal 的 legacy conclude 输入在卡片层回退到它（回退在卡片，不在本函数）。pose 无 string solution 时 undefined。
- **⑤** `src/core/view.ts:258`（part.reveal 富化）；tests：practice-record.test.ts:377-398。

### 组⑥ 续跑与请求起因推导组（6 个函数 + 3 个类型）

#### 3.6.1 `isDismissedResult`（私有，:814-818）

- **①** `function isDismissedResult(m: LhMessage): boolean`——纯类型守卫。
- **②** 该记录消息是否用户丢弃的问题结果？完整答案骑 toolResult 的 details（newAnswerResult）——丢弃暂停与续跑折叠都读它（:811-813 注释）。
- **③** role toolResult 且 `details?.dismissed === true`。
- **④** 丢弃答案由 `dismissedAnswer` 构造（question-core.ts:768-777：dismissed:true、dontKnow:false、answers:[]），模型向瘦身为 `{kind, dismissed:true}`（question-core.ts:780）。
- **⑤** 文件内：endsInDismissal :828、needsContinuation :914。

#### 3.6.2 `endsInDismissal`（:826-829）

- **①** `export function endsInDismissal(messages: readonly LhMessage[]): boolean`——纯。
- **②** 丢弃暂停（owner design 2026-10-03，"A2"，:820-825 注释）：记录止于用户丢弃——会话等待**用户**。
- **③** 最后一条消息存在且 `isDismissedResult`。
- **④** **从尾部派生——无 latch 需持久化或清除**：暂停期间无任何自动唤醒（续跑折叠不要求、唤醒流水线把 job 投递 hold 在 steer 队列直到下一次 send）；任何用户消息通过改变记录把它翻 off。这是"记录即状态"哲学在暂停状态上的应用：没有第二面旗标需要保持一致。
- **⑤** `src/server/jobs.ts:574`（pump 的暂停分支：parked=true，hold 全部 marker）。

#### 3.6.3 `endsInQuestionRecovery`（:834-838）

- **①** `export function endsInQuestionRecovery(messages: readonly LhMessage[]): boolean`——纯。
- **②** 记录止于出题重试 error result：最后一条是 toolResult 且 isError 且 `details.questionRecovery === true`。
- **③** 单布尔表达式。
- **④** 恢复点击授权其**立即的替换回合**，而非仅 write-ahead error results 幸存时的自动重启（:831-833 注释）。无新存储 latch：显式输入或替换输出改变此尾部。error results 由 `questionRecoveryAppends` 构造（input-events.ts:270-273，details:{questionRecovery:true}），每个 malformed 调用一条。
- **⑤** `src/server/jobs.ts:574`（与 endsInDismissal 同一暂停分支：排队 job 不得重启其替换回合）。

#### 3.6.4 `needsContinuation`（:894-937）

- **①** `export function needsContinuation(messages: readonly LhMessage[]): boolean`——纯折叠。
- **②** 记录是否止于未消费的 tool results——一个工具跑完后停下的回合（job dispatch 的 ack、中止的答案回合），agent 欠一次续跑？（:795-810 注释）这是挂载/同步续跑缝的闸门：true 且无回合运行时，客户端发 `{type:"continue"}`，教师从记录接手。Wave D：SDK `lastAssistantMessageIsCompleteWithToolCalls` 的原生孪生。
- **③** 逐步：
  1. last 必须是 toolResult，否则 false（:895-896）；
  2. 回溯连续尾部 toolResult 批至 start（:900-906）——连续**由构造保证**：agent 整批追加；问题闸门保持 quiz 调用与其学习者答案相邻；
  3. **丢弃法则**（A2 + owner ruling 2026-10-03，round-1 incident，:907-916）：批的**最后一条**解析决定——`isDismissedResult(last)` 或 `endsInQuestionRecovery` → false。止于丢弃 = 用户信号 STOP，无唤醒、此刻不欠反应（答案们的反应骑用户下一条普通消息）；止于真实答案 = 反应被欠。**与 pump 的暂停同一法则**（endsInDismissal 读同一条最后结果），续跑、投递 hold、暂停三者永不分歧；
  4. owner = `messages[start-1]` 必须是 assistant 且 content 为数组，否则 false（:917-920）；
  5. **练习 pose-ack 法则**（owner design 2026-10-04，:922-931）：批中任一 result 满足 `toolName===problem && !isError && details==null` → false。terminate:true **故意**结束了那个回合（学习者的下一次 thinking 提交才是下一回合）；与问题占位不同，此 ack 持久化。无此折叠，pose 后 reload 会唤醒幻影续跑回合；
  6. answered = 批的 toolCallId 集；calls = owner 的 toolCall 块（id 为 string）；return **calls.length > 0 && 每条调用都已回答**（:932-936）。
- **④** 悬空问题 failing the all-answered rule，永不点火回合——恰如 SDK 的 `every(output-available)`（:806-809）；dock 的领地不是续跑的。round-1 incident：早期版本读批内**任一**丢弃结果，"真实答案 + 丢弃"混合批会错误暂停；裁定改为只读最后一条解析。start===0（全记录皆结果、无 owner）→ false。
- **⑤** `components/session-core.ts:968`（continueIfOwed：ready 且无 error 且未被阻 → send continue）、`:974`（static 别名）；`components/chat.tsx:449`（挂载续跑）、`:804`（syncFromServer）；`src/agent/subscription-request-cycle.ts:71`（foregroundOwed 派生：非继承 background 的保留记录欠续跑即计前台债）。

#### 3.6.5 `nativeInputCause`（:844-863）

- **①** `export function nativeInputCause(message: AgentMessage, history: readonly AgentMessage[]): NativeInputCause`——纯。
- **②** 逐消息起因分类：learner / automatic / neutral / unrecognizable。不变量（:843 注释）：**只看原生起因——展平的 user 角色、ID 前缀与散文不授予任何权限**。起因从原生 role/形状派生，绝不从 id 前缀或文本内容派生。
- **③** 分支推导：
  - role user → **learner**（:845）；
  - role system/assistant → **neutral**（:846）；
  - role custom（:847-850）：probe-handoff/subagent-steer/subagent-abort → **automatic**；practice-thinking/practice-next → **learner**；graph-context/plan-block/problem-dismissed/compaction → **neutral**；其他 customType → **unrecognizable**；
  - role toolResult（:852-861）：
    1. isError 且 `details.questionRecovery===true` → 仅当 `questionCallsOf(history)` 含匹配 toolCallId **且** toolName 的 malformed 调用时 **learner**；否则 unrecognizable（恢复点击是学习者授权，但只针对真实 malformed 的问题）；
    2. 非问题工具、或 isError、或 `details==null`、或 `details.dismissed` → **neutral**（job ack、error result、pose ack、丢弃不携带起因）；
    3. details 形状校验：kind ∈ {quiz,ask,explain} 且 questionText 为 string 且 dontKnow 为 boolean 且 answers 为数组且 answeredAt 为 string——任一失败 → **unrecognizable**；
    4. 匹配调用唯一性：flatMap history 中所有 assistant 的 id===toolCallId 的 toolCall 块；**恰好一条**且 name 匹配 → **learner**；否则 unrecognizable（孤儿答案或歧义 occurrence 不授予前台权限）；
  - 其他角色 → **unrecognizable**。
- **④** history 参数是该消息**之前**的消息（调用方传 `messages.slice(0, indexOf(m))`）——匹配调用扫描不得看见未来。形状校验读 details 的完整 QuestionAnswerData（newAnswerResult 双受众设计在此付息：紧凑 content 给模型，完整 details 给记录侧推导）。
- **⑤** `src/agent/teacher-agent.ts:263`（prepareRequest：遍历请求消息、跳过 seen id，learner→foreground / automatic 或不可识别→background——"missing/unrecognized identity never grants foreground"）；`src/agent/subscription-request-cycle.ts:65`（prepare：automatic id 入 staged 集，learner 置 foregroundOwed）。

#### 3.6.6 `reconstructRequestCause`（:865-892）

- **①** `export function reconstructRequestCause(messages: readonly LhMessage[]): ReconstructedCause`——纯折叠。
- **②** 在**完整持久化原生记录**上重建请求起因，含压缩前的起因（:864 注释）。不变量：**永不猜测 foreground**——ambiguous 是诚实默认。
- **③** 状态机：`inherited="ambiguous"`、`triggers=[]`、`seen=Map<id, JSON.stringify(message)>`、`history=[]`；逐消息：
  1. `cause = nativeInputCause(message, 至今 history)`；
  2. **身份审计**（:881-885）：有 id——seen 重复且序列化值不同 → push unrecognizable（身份碰撞/篡改）；值相同 → skip（去重，如 adoption 重复）；新 → 记录。无 id 且 cause 非 neutral → push unrecognizable；
  3. **批次边界**（:886-888）：assistant 消息 → `inherited = resolve(); triggers = []`——模型响应关闭输入批次，其解析出的起因成为下一批次继承的基线。**例外**：精确的合成丢弃-conclude 形状（`provider==="synthetic"` 且 `api==="faux"` 且 `model==="synthetic-conclude"` 且 content 含 outcome==="dismissed" 的 conclude 调用）**不是**边界——它是骑用户下一次输入的应用合成脚手架，不是模型响应；
  4. 否则 cause 非 neutral → `triggers.push(cause)`；
  5. `history.push(message)`。
  终局 return `resolve()`。

  `resolve()`（嵌套闭包，:870-877）：
  - triggers 含 unrecognizable → **ambiguous**；
  - lastLearner/lastAutomatic = 两起因的最后下标；
  - 两者皆无 → **inherited**；
  - 无 automatic → **foreground**；
  - lastLearner < lastAutomatic → **background**（最后的话语是 automatic）；
  - 否则（learner 在 automatic 之后）→ **ambiguous**（混合批次不可归因）。
- **④** 压缩切割不影响此折叠——它读全记录（注释强调含 pre-compaction causes），因为起因是历史事实，不是上下文载荷。seen 去重使折叠对记录重复幂等；同 id 异内容碰撞被当作 unrecognizable 而非静默信任。合成对豁免（:886）与 `concludedByDismissalPair` 的 syntheticStamps（:380-393）是跨函数契约：四重匹配缺一不可。
- **⑤** `src/server/chat-handler.ts:284`（callPurpose.background：continue 输入除非重建起因为 foreground 否则按 background——订阅 provider 的前台/后台配额纪律）。

### 组⑦ 显式输出、失败识别与 CLI 元数据组（4 个函数）

#### 3.7.1 `sendToUserText`（:129-136）

- **①** `export function sendToUserText(block: unknown): string | undefined`——纯提取器。
- **②** 读输出工具的消息而不改原生调用（:126-128 注释）。流式期间接受 partial arguments；malformed/空输入不带散文。**与当前所选模型无关**。
- **③** 四重守卫：block 是对象；`type==="toolCall"` 且 `name===SEND_TO_USER_TOOL`；arguments 是对象；message 是 string 且 trim 非空 → 返回**原始** message（未 trim）。
- **④** 流式 partial 容忍让 SSE 事件流随到随渲染散文（view.ts:245-249：无 live 工具卡、无确认——此通道是普通散文，包括其 arguments 流式期间）。
- **⑤** `src/core/view.ts:245`（输出调用 → text part）；文件内：userFacingTextOf :148；tests：send-to-user.test.ts:150-152。

#### 3.7.2 `userFacingTextOf`（:141-152）

- **①** `export function userFacingTextOf(content: unknown, failedOutputCalls?: ReadonlySet<string>): string[]`——纯。
- **②** 学习者面向的散文，按 content 顺序（:138-140 注释）。只有显式输出工具与普通文本在此汇合——**thinking 与所有其他工具输入留在外面**。coverage/extraction 与 Markdown 共享；原生历史保持完整。
- **③** content 为 string → trim 非空 → `[content]`（原始）；非数组 → `[]`；数组遍历：跳过非对象；跳过 id ∈ failedOutputCalls 的 toolCall 块；text 块 → block.text；其他块 → sendToUserText；trim 非空的 string push（原始，调用方自行 trim）。
- **④** failedOutputCalls 参数是失败过滤的注入点——coverage/extraction 传全记录失败集（一条消息里的失败调用可能由另一条消息的结果识别），Markdown 默认单消息扫描（session-markdown.ts:173）。
- **⑤** `src/core/coverage.ts:45`（messageViewLines："TEACHER [id] text" 出处行）、`:62`（teacherProseBlocks：抽取器 prompt 材料）；`src/core/session-markdown.ts:169`（user）、`:173`（assistant）。

#### 3.7.3 `failedOutputCallIds`（:157-169）

- **①** `export function failedOutputCallIds(messages: readonly LhMessage[]): ReadonlySet<string>`——纯。
- **②** 失败输出调用仍是**重试上下文，不是已交付的教学**（:154-156 注释）。两个互补来源：
  1. toolResult 且 `toolName===send_to_user` 且 isError → add toolCallId（执行了但被拒）；
  2. assistant 且 stopReason error/aborted → add 其 content 中全部 send_to_user 调用 id（**根本未执行**，可能无结果）。
- **③** 单前向遍、两分支。
- **④** 截断调用可能有看起来有效的 partial arguments（:155）——无失败过滤，半流式的 send_to_user 会被计为已交付教学，污染覆盖度指纹与抽取器材料。view 层镜像同一判别（view.ts:236-240：失败/中止生成的输出调用跳过，provider error/abort UI 拥有那个结局）。
- **⑤** `src/agent/subagents/extraction.ts:138`（proseView 默认参数）、`:1133`（抽取运行全记录扫描）；`src/core/coverage.ts:41/59`（默认参数）；`src/core/session-markdown.ts:173`（单消息回退）。

#### 3.7.4 `cliContextWindowOf`（:104-114）

- **①** `export function cliContextWindowOf(messages: readonly LhMessage[]): {model: string; tokens: number} | null`——纯。
- **②** 最新响应的 CLI 报告有效上下文预算（:102-103 注释）。不变量：**只看最新响应——新响应无元数据时绝不借用更旧进程/模型的窗口；压缩使旧报告失效**。
- **③** 反向扫描：遇 compaction marker → return null（旧报告描述的上下文下一请求不再携带）；遇第一条 assistant → 仅当 `provider===CLAUDE_CODE_PROVIDER` 且 tokens 为安全整数 >0 时返回 `{model: `${provider}:${model}`, tokens}`；否则 null；非 assistant 跳过；耗尽 → null。
- **④** 写入方唯一：`src/agent/claude-code/stream.ts:246`（CLI 流在 finished assistant 上盖戳；:145 声明输出类型）。CLI 别名无全局目录上限——只有本会话匹配的响应能供分母（stats-bar.tsx:13-19：contextLimitForModel 仅当 model 串精确匹配时返回 cliWindow.tokens，否则 null；其他 provider 保持目录 join）。
- **⑤** `components/chat.tsx:1712`（传入 StatsBar）；`components/stats-bar.tsx:16`（contextLimitForModel）；tests：claude-code-context-window.test.ts:73-91（latest-only、压缩失效、空记录）、claude-code-harness.test.ts:226-227（戳在 JSON round-trip 后幸存）。

---

## 4. 私有辅助归并表与 100% 覆盖台账

### 4.1 轻量私有辅助函数归并表

| 函数 | 行号 | 作用 | 详解节 |
|---|---|---|---|
| `cleanToolCallIds` | :422-430 | 干净（非 error）结果的调用 id 集——honest-activation 依据 | §3.5.1 |
| `resultIdsFrom` | :555-563 | 消息段内全部 toolResult 的 toolCallId 集——悬空扫描依据 | §3.2.2 |
| `isLiveQuestionPlaceholder` | :711-715 | 五条件守卫：客户端 c_ 瞬态占位结果 | §3.3.2 |
| `isDismissedResult` | :814-818 | `details.dismissed===true` 守卫——丢弃暂停依据 | §3.6.1 |
| `resolve`（嵌套闭包） | :870-877 | reconstructRequestCause 的批次起因解析器 | §3.6.6 |

### 4.2 38 函数全覆盖台账

| # | 函数 | 行号 | 导出 | 纯度 | 组 / 节 |
|---|---|---|---|---|---|
| 1 | `cliContextWindowOf` | :104-114 | ✓ | 纯 | ⑦ / §3.7.4 |
| 2 | `asAgentMessages` | :118-120 | ✓ | 纯（断言） | ② / §3.2.1 |
| 3 | `sendToUserText` | :129-136 | ✓ | 纯 | ⑦ / §3.7.1 |
| 4 | `userFacingTextOf` | :141-152 | ✓ | 纯 | ⑦ / §3.7.2 |
| 5 | `failedOutputCallIds` | :157-169 | ✓ | 纯 | ⑦ / §3.7.3 |
| 6 | `newMessageId` | :174-176 | ✓ | **非确定性** | ① / §3.1.1 |
| 7 | `newUserMessage` | :182-189 | ✓ | **非确定性** | ① / §3.1.2 |
| 8 | `newUserSteer` | :196-198 | ✓ | id 传入；ts 非确定性 | ① / §3.1.3 |
| 9 | `newAnswerResult` | :206-223 | ✓ | **非确定性** | ① / §3.1.4 |
| 10 | `newHandoffMessage` | :227-237 | ✓ | id 确定性；ts 非确定性 | ① / §3.1.5 |
| 11 | `newPlanBlockMessage` | :242-255 | ✓ | **非确定性** | ① / §3.1.6 |
| 12 | `newGraphContextMessage` | :279-308 | ✓ | **非确定性** | ① / §3.1.7 |
| 13 | `newThinkingMessage` | :316-326 | ✓ | **非确定性** | ① / §3.1.8 |
| 14 | `newNextMessage` | :334-344 | ✓ | **非确定性** | ① / §3.1.9 |
| 15 | `newProblemDismissedMarker` | :352-362 | ✓ | **非确定性** | ① / §3.1.10 |
| 16 | `concludedByDismissalPair` | :371-413 | ✓ | 调用 id 确定性；消息 id/ts 非确定性 | ① / §3.1.11 |
| 17 | `cleanToolCallIds` | :422-430 | ✗ | 纯 | ⑤ / §3.5.1 |
| 18 | `modelSolutionForConclude` | :438-444 | ✓ | 纯 | ⑤ / §3.5.5 |
| 19 | `problemInputForConclude` | :452-479 | ✓ | 纯 | ⑤ / §3.5.4 |
| 20 | `activeProblemOf` | :481-514 | ✓ | 纯 | ⑤ / §3.5.2 |
| 21 | `pendingProblemDismissalOf` | :520-550 | ✓ | 纯 | ⑤ / §3.5.3 |
| 22 | `resultIdsFrom` | :555-563 | ✗ | 纯 | ② / §3.2.2 |
| 23 | `toLlmMessages` | :583-667 | ✓ | 纯 | ② / §3.2.3 |
| 24 | `danglingQuestionOf` | :674-679 | ✓ | 纯 | ③ / §3.3.3 |
| 25 | `pendingQuestionOf` | :685-706 | ✓ | 纯 | ③ / §3.3.4 |
| 26 | `isLiveQuestionPlaceholder` | :711-715 | ✗ | 纯 | ③ / §3.3.2 |
| 27 | `questionCallsOf` | :724-742 | ✓ | 纯 | ③ / §3.3.1 |
| 28 | `hasUnresolvedQuestion` | :746-748 | ✓ | 纯 | ③ / §3.3.5 |
| 29 | `malformedQuestionsOf` | :751-753 | ✓ | 纯 | ③ / §3.3.6 |
| 30 | `probeDoneResultIds` | :760-778 | ✓ | 纯 | ④ / §3.4.1 |
| 31 | `hasProbeDone` | :782-784 | ✓ | 纯 | ④ / §3.4.2 |
| 32 | `answeredCallIds` | :788-790 | ✓ | 纯 | ③ / §3.3.7 |
| 33 | `isDismissedResult` | :814-818 | ✗ | 纯 | ⑥ / §3.6.1 |
| 34 | `endsInDismissal` | :826-829 | ✓ | 纯 | ⑥ / §3.6.2 |
| 35 | `endsInQuestionRecovery` | :834-838 | ✓ | 纯 | ⑥ / §3.6.3 |
| 36 | `nativeInputCause` | :844-863 | ✓ | 纯 | ⑥ / §3.6.5 |
| 37 | `reconstructRequestCause` | :865-892 | ✓ | 纯 | ⑥ / §3.6.6 |
| 38 | `needsContinuation` | :894-937 | ✓ | 纯 | ⑥ / §3.6.4 |

**38/38 全覆盖**（34 导出 + 4 私有），另含嵌套闭包 `resolve`（§4.1）。

### 4.3 常量与类型台账

| 成员 | 行号 | 类别 | 详解节 |
|---|---|---|---|
| `INTERRUPTED_TEXT` | :53-54 | 导出常量 | §2.4 / §3.2.3 |
| `LhMarkerMessage` | :66-86 | 导出接口 | §2.2 |
| `declare module … CustomAgentMessages.lhMarker` | :88-92 | 声明合并 | §2.2 |
| `LhMessage` | :95-100 | 导出类型 | §2.1 |
| `SEND_TO_USER_TOOL` | :124 | 导出常量 | §2.4 / §3.7.1 |
| `PRACTICE_PROBLEM_TOOL` / `PRACTICE_CONCLUDE_TOOL` | :261 / :262 | 导出常量 | §2.4 / §3.5.2 |
| `GraphContextPick` | :266-270 | 导出接口 | §2.5 / §3.1.7 |
| `QuestionCall` | :717-719 | 导出接口 | §2.5 / §3.3.1 |
| `RequestCause` / `ReconstructedCause` / `NativeInputCause` | :840 / :841 / :842 | 导出类型 | §2.5 / §3.6.5-6 |

---

## 5. 系统数据流中的本文件：一个回合的完整穿行

把 38 个函数放回回合生命周期（术语表词条 7），本文件的枢纽地位一目了然：

1. **输入事件抵达**（`POST /api/chat`）：`inputAppends`（input-events.ts:214）用本文件扫描定权威——`danglingQuestionOf` 校验 answer/dismiss 目标（:149/:222）、`activeProblemOf` 校验 thinking/next/dismiss-problem（:143/:237/:251）、`pendingProblemDismissalOf` 决定是否前置 `concludedByDismissalPair`（:338-339）——再用构造器（`newUserMessage`/`newAnswerResult`/`newThinkingMessage`/`newNextMessage`/`newProblemDismissedMarker`）计算追加。
2. **write-ahead 预写**（chat-handler.ts:377-394）：追加在 agent 运行前落盘；`hasUnresolvedQuestion` 决定并行问题闸门是否延迟唤醒（:356）；`reconstructRequestCause` 决定 continue 的前台/后台属性（:284）。
3. **agent 构造**：`hasProbeDone` 选 TEACHER/PROBER（:429）；`asAgentMessages` 把记录赋给 `initialState.messages`（:448/:464）——记录即状态。
4. **每次模型调用前**：`toLlmMessages` 作为 `convertToLlm`（teacher-agent.ts:256）执行五段流水线——压缩切割、chrome 携带、marker 展平/过滤、元数据剥离、悬空合成；`nativeInputCause` 在 prepareRequest 中定请求起因（teacher-agent.ts:263）。
5. **SSE 事件流与客户端**：乐观消息用同一批构造器（session-core.ts:703-715）；`pendingQuestionOf` 与 view 扫描交叉校验定答题 dock（chat.tsx:453）；`activeProblemOf` 定练习 dock（chat.tsx:464）；`malformedQuestionsOf` 定出题重试入口（chat.tsx:454）。
6. **回合收尾**（`persistTurn`，turn-service.ts:59）：`newMessageId` 为 pi 消息盖戳（:80），占位被过滤（:72-79），`newPlanBlockMessage` 经 plan-blocks.ts:94 幂等发射。
7. **收尾后的派生**：`needsContinuation` 决定挂载/同步续跑（session-core.ts:968）；`endsInDismissal`/`endsInQuestionRecovery` 决定唤醒流水线 hold（jobs.ts:574）；`cliContextWindowOf` 供统计条分母（chat.tsx:1712）；`failedOutputCallIds` + `userFacingTextOf` 供覆盖度与抽取器选材（coverage.ts:45/62、extraction.ts:138/1133）；`probeDoneResultIds` 供阶段折叠（phases.ts:169）；`danglingQuestionOf` 供会话列表徽标（store/chats.ts:109）。

一份记录，两条投影，38 个纯函数（构造器除外）——这就是"记录即 Agent 状态"的全部物理实现。
