# 第 02 卷：九大域契约与异步/计划纯函数派生（src/core/contracts/）

> **取证方法**：本卷全部结论均先经 `read` 逐行精读 `src/core/contracts/` 全部 9 个文件（合计 1578 行，零遗漏），再以 `rg` 在全仓（`src/`、`components/`、`app/`、`tests/`）检索每个契约类型、规范文本常量与运行时纯函数的真实调用点，行号以当前工作区为准。讲解用语一律遵循 `学习文档/glossary.md` 规范名（SSE 事件流、持久化、回合收尾、插纸条、唤醒流水线、异步协议、标记消息、原生记录、投影、桶导出、导入法则、schema版本戳、唯一写入口等）；代码标识符与英文规范文本常量原样引用。
>
> **命名勘误（先读）**：任务简报中举例的 `buildSubagentAbortSteer`、`steerMarkerId`、`chainArgumentId` 三个名字**在全仓不存在**（`rg` 零命中）。真实名字是：中止插纸条构造器 `buildAbortSteer`（`src/core/contracts/jobs.ts:391`）；steer 的确定性 id 是**内联模板字符串** `steer_${job.id}`（`jobs.ts:373`、`:396`）与 `steer_probe_${chatId}`（`src/core/native-messages.ts:229`），没有独立的 `steerMarkerId` 函数；链身份的纯计算（`newGraphChainId` / `chainKey`）住在 **`src/core/graph.ts:86-95`**，不在契约文件里——`contracts/graph.ts` 只拥有链的**形状**，id 铸造与归并键属于 core 的图派生模块。本卷按真实代码讲解。

---

## 0. 总览：契约域拆分、桶导出拓扑与纯度边界

### 0.1 契约是什么（glossary 词条 90）

`src/core/contracts.ts:1-11` 的文件头给出了契约的宪法：

- **单一事实来源**（single source of truth）：每个组件都面向同一份契约编程；
- **按域拆分**：`plan.ts`（会话计划树）、`graph.ts`（全局知识图谱 + 抽取流水线）、`chat.ts`（会话记录 + UI 扩展点）、`jobs.ts`（异步 sub-agent 协议）等；
- **所有权**：每个域文件由其所属流（stream）**完全拥有**；改别人的域的 schema 必须走 master（`contracts.ts:7-9`、各文件头重复同一句）；
- **内容纪律**：`Pure types + protocol docs + tiny pure helpers`——纯类型 + 协议文档 + 小型纯辅助函数。但注意：**"tiny" 不等于不重要**——`jobs.ts` 的 8 个导出纯函数是异步协议的幂等性与模型面文本的唯一来源，`plan.ts` 的 3 个派生纯函数是计划位置语义的全部实现。

### 0.2 九文件总表

| 文件 | 行数 | 导出类型/接口 | 导出常量 | 导出运行时函数 | 内部辅助 | 进 `contracts.ts` 桶 |
|---|---|---|---|---|---|---|
| `chat.ts` | 322 | 11 | 6（含 `CURRENT_CHAT_VERSION` + 5 段规范文本） | 0 | 0 | ✅ `contracts.ts:15` |
| `plan.ts` | 149 | 7（含内部 `PartsCarrier` 不导出） | 0 | 3 | `PartsCarrier`（类型） | ✅ `contracts.ts:13` |
| `graph.ts` | 385 | 17 | 2（`CURRENT_GRAPH_FORMAT_VERSION`、`TITLE_MAX_CHARS`） | 1（`titleFromPrompt`） | 0 | ✅ `contracts.ts:14` |
| `jobs.ts` | 438 | 17 | 0 | 8 | `steerText`、`abortText`（函数） | ✅ `contracts.ts:16` |
| `probe.ts` | 94 | 4 | 2（`probeDoneInputSchema`、`PROBE_DONE_ACK_TEXT`） | 1（`probeDoneSchemaLock`，编译期锁） | 0 | ✅ `contracts.ts:17` |
| `models.ts` | 83 | 6 | 0 | 0 | 0 | ✅ `contracts.ts:18` |
| `subscriptions.ts` | 68 | 8 | 1（`NATIVE_SUBSCRIPTIONS`） | 0 | 0 | ❌ 由 `core/index.ts:60-61` 选择性再导出 |
| `chatgpt.ts` | 27 | 2 | 0 | 0 | 0 | ❌ 由 `core/index.ts:59` 仅类型再导出 |
| `claude-code.ts` | 12 | 1 | 2（`CLAUDE_CODE_PROVIDER`、`CLAUDE_CODE_MINIMUM_VERSION`） | 0 | 0 | ❌ 由 `core/index.ts:63` 再导出 |

### 0.3 两层桶导出拓扑（glossary 词条 86）

1. **域桶** `src/core/contracts.ts:13-18`：`export * from` 六个域文件（plan / graph / chat / jobs / probe / models）。它保持所有历史 import 路径（`"@/src/core"` 与 `"./contracts.ts"`）不变（`contracts.ts:9-10`）。
2. **core 公开桶** `src/core/index.ts:18`：`export * from "./contracts.ts"` 把六域整体抬进 shell 的唯一合法 import 面。三个**连接域**文件不走域桶，而是被 `core/index.ts` 精确点名：
   - `core/index.ts:59`：`export type { ChatGPTStatus, ChatGPTControlBridge } from "./contracts/chatgpt.ts"`（**仅类型**）；
   - `core/index.ts:60`：`export { NATIVE_SUBSCRIPTIONS }`（唯一运行时值）；`:61`：8 个订阅类型仅类型再导出；
   - `core/index.ts:63`：`export { CLAUDE_CODE_PROVIDER, CLAUDE_CODE_MINIMUM_VERSION, type ClaudeCodeStatus }`。

**导入法则**（glossary 词条 89，`eslint.config.mjs:6-19`）：`components/**` 只准进 `@/src/core`；`app/**` 准进 `@/src/core` + `@/src/server`；`src/core/**` 永不 import `src/agent`、`src/server`、`src/store`。契约文件是这条法则的最底层地基——它们被所有层引用，自己只引用纯模块。

### 0.4 纯度边界逐文件判定

| 文件 | 运行时 import | 纯度判定 |
|---|---|---|
| `chat.ts:8-12` | 无（5 条全部 `import type`） | 零运行时足迹；常量是字符串/数字 |
| `plan.ts:128` | 无（仅文件中部的 `import type { LhMessage }`） | 三个派生函数纯计算，无 IO |
| `graph.ts:21` | 无（`import type { CallUsage, ExtractionRunUsage }`；其中 `CallUsage` 是**残留未使用导入**，全文件仅第 21 行出现） | `titleFromPrompt` 纯字符串计算 |
| `jobs.ts:9-11` | **有**：`import { newHandoffMessage } from "../native-messages.ts"`（`:11`） | 依赖的 `native-messages.ts` 本身纯且浏览器安全，故 jobs.ts 仍是纯模块；`buildSubagentSteer`/`buildAbortSteer` 内含 `Date.now()`（见 §4.3 的诚实说明） |
| `probe.ts:18` | **有**：`import { Type, type Static } from "typebox"` | TypeBox 是浏览器安全的 schema 构造器；schema 对象是运行时值 |
| `models.ts:8-9` | 无（`ThinkingLevel`、`../settings.ts` 均仅类型） | 纯类型文件 |
| `subscriptions.ts:1` | 无（`import type { Api, Model } from "@earendil-works/pi-ai"`） | 纯类型 + 一个 `as const` 描述符数组 |
| `chatgpt.ts` | 无 | 纯类型 |
| `claude-code.ts` | 无 | 纯类型 + 两个字符串常量 |

全部 9 个文件都满足 `core/index.ts:1-4` 的桶承诺：**浏览器安全，无 node 内建、无 fs、无网络**。

### 0.5 贯穿九文件的四条设计教义

1. **规范文本单源律（marker law）**：`chat.ts:194-196`——"每个自定义标记消息的模型面文本都住在 core/contracts，绝不住在展平缝（flattening seam）"。`HANDOFF_TEXT`、`THINKING_LABEL`、`CONCLUDE_ACK_TEXT`、`NEXT_PROBLEM_TEXT`、`COMPACTED_HISTORY_HEADER`、`PROBE_DONE_ACK_TEXT` 与 jobs.ts 内部的 `steerText`/`abortText` 共同构成模型读到的全部应用自定义文本的唯一来源。
2. **确定性 id = 幂等键**：`steer_<jobId>`（结果/中止共用一个 id 空间）、`steer_probe_<chatId>`（每会话恰一次交接）、`TurnUsage.id`（每请求唯一）、`ExtractionRunUsage.startedAt`、`NotesSource.id`（文件路径哈希）。重复投递靠 `steerDelivered` 按 id 去重，重复记账靠 append 前的 some 检查。
3. **派生量永不存储**：计划节点状态（`plan.ts:36-43`）、图的边/簇/逻辑箭头（`graph.ts:24-32`、`:303-347`）、覆盖度的"未覆盖"侧（`graph.ts:158-164`）全部读时重算。
4. **金钱通道教义：缺席 ≠ 零**：`CallUsage` 的 `number | undefined`（`chat.ts:117-134`）、`JobUsage` 的同形字段（`jobs.ts:46-73`）——provider 没报告的字段保持 undefined，渲染器显示"—"，绝不显示 $0。

---

## 1. `src/core/contracts/chat.ts`（322 行）——会话记录、金钱通道与规范文本

### 1.1 模块定位与纯度边界

- **契约所有权**：会话域（chat stream）完全拥有；文件头 `chat.ts:1-7` 声明域拆分宪法。
- **桶导出**：经 `contracts.ts:15` → `core/index.ts:18` 全量进入 shell import 面。
- **纯度**：`chat.ts:8-12` 五条 import 全部 `import type`（`ThinkingLevel`、`LhMessage`、`Phase3`、`PlanNodeStatus`/`PlanTree`、`EmissionStats`）。**本文件没有任何运行时函数**——它是纯类型 + 6 个常量。跨域引用方向值得注意：chat.ts 引 plan.ts 与 graph.ts 的类型，而 graph.ts:21 与 jobs.ts:9 又反向引 chat.ts 的 `CallUsage`/`ExtractionRunUsage`——类型-only 循环在 TS 中无害，但说明**金钱通道形状（CallUsage）的事实源头在 chat 域**。

### 1.2 核心数据结构、常量与 Schema 契约逐项精讲

#### 1.2.1 `ChatKind`（`chat.ts:28`）与 `ChatRecord`（`chat.ts:30-61`）

`ChatKind = "teach" | "practice"`。注释（`chat.ts:24-27`，owner 2026-10-04）：**"teach" 是默认值且在练习会话出现之前的记录上缺席**——缺席读作 teach，无迁移。练习会话（glossary 词条 31）用练习者 agent、problem/conclude 两工具，无抽取、无图谱写入。

`ChatRecord` 是持久化的磁盘形状（glossary 词条 2）：每会话一个 `data/chats/<id>.json`。文件头注释（`chat.ts:16-23`，Wave B owner-approved 2026-09-26）是原生记录教义（glossary 词条 43）的契约表述：**存储的消息是 pi 原生历史（LhMessage），规范会话记录就是 agent 状态本身；回放 = `state.messages = record.messages` + continue()**。客户端形状视图是客户端自己的分组折叠计算（core/view.ts，Wave D）——待答 quiz 就是一个未回答的 question 工具调用，这正是"题中恢复免费"的原因。

字段逐项（行号经 rg 核实）：

| 字段 | 行 | 业务含义 |
|---|---|---|
| `id` / `title` / `createdAt` / `updatedAt` | 31-34 | 记录身份与时间戳。`updatedAt` 只被会话活动 bumps——改名、改设置、存树都刻意不动它（`src/store/chats.ts:165-167`、`:176-178`、`:203-205`），侧栏排序不因元数据编辑抖动 |
| `messages: LhMessage[]` | 35 | 唯一存储格式；server 独占写权 |
| `kind?: ChatKind` | 37 | 缺席 = teach。注意：`ChatKind` 这个标识符在契约文件外**零直接引用**（rg 核实）——消费者用字面量：`src/store/chats.ts:35`（`kind?: "practice"`）、`:45`（`kind: "practice" as const`）、`app/api/chats/route.ts:27`、`components/new-session.tsx:60` |
| `tree?: PlanTree` | 39 | 会话计划树（glossary 词条 46），由 plan 工具经 `saveTree` 写入（`src/store/chats.ts:199-206`） |
| `turns?: TurnUsage[]` | 47 | append-only 教学回合用量日志（见 §1.2.4） |
| `extractions?: ExtractionRunUsage[]` | 52 | append-only 背景抽取用量日志（见 §1.2.3） |
| `settings?: ChatSettings` | 54 | 每会话模型/思考级别覆盖（见 §1.2.2） |
| `version?: number` | 60 | schema版本戳（见 §1.2.5） |

**平行日志纪律**（`chat.ts:40-46` 注释）：`turns` 刻意是平行日志而非每消息元数据。注释记录的历史动因是旧体制下客户端每回合重 POST 自己的消息列表、其副本永不携带 server 盖戳字段，消息对象内的任何附加字段都会被下一次持久化冲掉。在当前输入事件体制（glossary 词条 4：客户端只发输入事件、从不提交消息列表）下这条纪律依然成立——**server 盖戳的记账字段永不骑在消息对象里**。日志按 `messageId` 键控，让持久化视图能把每条用量折叠到对应消息上；聚合是对日志的折叠计算（core/prices.ts）。

真实上游：`src/store/chats.ts:37`（createChat 构造）、`:57-59`（writeChat 唯一写入口）、`:61-76`（getChat 读 + 版本守卫）、`src/core/ports.ts:14`（ChatStore 端口类型引用）。

#### 1.2.2 `ChatSettings`（`chat.ts:73-81`）

每会话模型覆盖（model-control wave，2026-09-12，注释 `chat.ts:66-72`）：

- `model?: { provider: string; id: string }`（`:77`）——pi-ai catalog 坐标。注释明言今天只配置了 "openrouter"，字段存在是为了第二个 provider 无需改 schema。
- `thinkingLevel?: ThinkingLevel`（`:80`）——必须在所选模型的支持列表内（`getSupportedThinkingLevels`；由 settings 路由强制）。

语义要点：缺席字段回落 config；由模型选择器（`PUT /api/chats/[id]/settings`）写入、在回合组装时读取——**agent 每回合无状态，所以改动按构造在下一回合生效**。**背景 sub-agent 永不被覆盖**（config 钉死：它们是基础设施，不是会话）。

真实上游：`src/store/chats.ts:161-168`（saveSettings，replace-whole，不 bump updatedAt）、`app/api/chats/[id]/settings/route.ts:9`、`app/api/settings/[section]/route.ts:74`（validateChatSettings）、`:121`（clampChatLevel）、`app/api/chats/route.ts:38-41`（**出生盖戳**：新会话从 STRONG 槽逐字抄一份 model/thinkingLevel，此后 strong 槽不再触及该会话）、`components/chat.tsx:47`。

#### 1.2.3 抽取侧金钱通道：`ExtractionStageUsage`（`chat.ts:89-94`）与 `ExtractionRunUsage`（`chat.ts:100-113`）

- `ExtractionStageUsage`：`model: string`（`:92`，provider 限定 `"provider:id"`，读时做与密钥无关的 Pi catalog 查找）+ `steps: CallUsage[]`（`:93`）。**存步骤不存总和**——成本与上下文折叠发生在读时（core/prices.ts）。
- `ExtractionRunUsage`：一次完成（或中途失败）的抽取流水线运行的用量记录。`startedAt: number`（`:102`，registry 的 ms 时间戳，**幂等键**）、`at`（`:103`）、`durationMs`（`:104`）、`stats?: EmissionStats`（`:106`，仅当合并器真的跑了才在场）、`stages: { extractor; auditor }`（`:109-112`，按流水线顺序；**合并器是确定性的——无模型调用、无条目**）。注释（`:96-99`）：成功或失败都追加，因为钱两种情况都花了。

真实上游：`src/store/chats.ts:150-157`（appendExtractionUsage，按 startedAt 幂等——中止重放到达两次也不重复计钱）、`src/store/graph.ts:193`（appendSourceUsage，笔记源侧镜像）、`src/core/cost-summary.ts:80-82`、`:129`（foldExtractionRun）、`src/agent/subagents/extraction.ts:1029`（persistRunUsage）。

#### 1.2.4 教学侧金钱通道：`CallUsage`（`chat.ts:120-134`）与 `TurnUsage`（`chat.ts:140-155`）

`CallUsage` 是一次模型调用的 token 记账——SDK 的 LanguageModelUsage 展平到持久化字段（注释 `:117-119`：**undefined = provider 没报告；渲染器显示缺席，绝不显示零**）：

| 字段 | 行 | 含义 |
|---|---|---|
| `inputTokens` / `outputTokens` | 122-123 | Pi 归一化的新鲜输入/输出 token；缓存桶互不相交 |
| `cacheReadTokens` | 125 | 缓存**读** token（按 cache-read 费率计费，如有） |
| `cacheWriteTokens` | 128 | 本次调用写入缓存的输入 token（OpenRouter 对某些 provider 计写费；undefined = 未报告/未计费） |
| `cacheWrite1hTokens?` | 131 | cacheWriteTokens 中以一小时保留期写入的子集。旧日志缺失；新的原生捕获显式记零 |
| `reasoningTokens` | 133 | 输出 token 中的推理部分 |

`TurnUsage` 是一个计费回合（注释 `:136-139`：一次教师完整调用——客户端回合或唤醒回合，同一 handler、同一日志；带工具调用的回合跨多个 agent step，每 step 单独计费；捕获落在持久化缝，成本读时从 core/prices.ts 推断）：

- `id: string`（`:145`）——**每请求（回合）唯一**，append-only 日志的幂等键。注释特别警告：续跑回合共享响应消息 id（SDK 合并它们），按 messageId 键控会吞掉它们的用量。
- `messageId: string`（`:148`）——本回合产出的 assistant 消息，出处锚，把条目键到持久记录的对应块。
- `at`（`:149`）、`model: string`（`:152`，provider 限定）、`steps: CallUsage[]`（`:154`，每 agent step 一条）。

真实上游：`src/server/chat-handler.ts:410`（steps 捕获）、`:640`（appendTurnUsage 落账）、`src/store/chats.ts:138-145`（按 turn id 幂等追加）、`src/server/pricing.ts:20`（callCost）、`src/core/cost-summary.ts:35`、`:52`、`:86`（ZERO_TOKENS）、`components/chat.tsx:926`、`components/stats-bar.tsx:4`。

#### 1.2.5 `CURRENT_CHAT_VERSION`（`chat.ts:64`）与 schema版本戳策略

`= 1`。注释（`chat.ts:55-59`，schema-versioning wave，owner 2026-10-10）定义 **lazy v1**（glossary 词条 101）：旧记录保持无戳（缺席读作 v1）；每次写入盖当前版本；**盖着比本构建更新的戳的记录（降级场景）在读侧被拒**——读-改-写存储绝不能重写它不理解的东西。

三段式落地（glossary 词条 97 唯一写入口）：
- 写侧盖戳：`src/store/chats.ts:58`（writeChat，`{ ...record, version: CURRENT_CHAT_VERSION }`）；
- 内存孪生：`src/store/chats.ts:50`（createChat 返回与磁盘一致的盖戳副本）；
- 读侧守卫：`src/store/chats.ts:72-74`（`v > CURRENT_CHAT_VERSION` → console.error + 返回 null，诚实拒绝）。

图家族有平行的第二套版本戳：`CURRENT_GRAPH_FORMAT_VERSION`（见 §3.2.6）。

#### 1.2.6 五段规范文本常量（模型面文本的单源）

**(a) `HANDOFF_TEXT`（`chat.ts:187-192`）**——探测→教学交接唤醒的模型面文本。注释（`:169-186`）：唤醒消息只携带 data-probe-handoff part，适配器把它展平成这段文本；单源使探测者的缝、测试与现实无法漂移。**REASONING-FIRST PACING**（owner 2026-09-26，`:178-186`）：旧的一句话读起来像_dispatch 命令（"现在就写"），教师跳过了计划片段要求的审慎；所以唤醒文本给节奏——在 plan_init **之前**先推理出教这个人这个东西的最优方式。对机器诚实：plan_init 仍是第一个工具、计划图仍是第一个制品、呈现仍结束回合（verdict death，2026-09-26：学习者的下一条消息是自然回复——修改请求或放行）。文本原文：

```text
Next: plan the full teaching arc from my current understanding to the goal understanding. Apply the teaching methodology in your system prompt, and find the optimal way to teach me this. Find the unconditional truths, plan the motivated derivations/discoveries, so every reasoning step has to land as obviously true. Take your time here and really think this through. When it's genuinely reasoned out, call plan_init and present the plan; I'll accept it or ask for changes.
```

真实上游：`src/core/native-messages.ts:42`（import）、`:232`（newHandoffMessage 的 content）；`tests/probe-done.test.ts:85`（断言投递内容逐字等于它）；`src/agent/teacher-agent.ts:252`（注释引用）。

**(b) `THINKING_LABEL`（`chat.ts:204`）** = `"Your thinking"`。注释（`:198-203`，owner round 2026-10-05）：**单一提交标签、一条发送道**——提交是否声称答案从文本读出，不由按钮声明；提示与承诺骑同一通道，标签是模型看到的唯一区别。真实上游：`src/core/native-messages.ts:44`、`:321`（newThinkingMessage 以 `${THINKING_LABEL}:\n${text}` 作 content）；调用链 `src/core/input-events.ts:241`（thinking 输入事件）与 `components/session-core.ts:708`（乐观追加）。**同名撞车警告**：`components/thinking-default.ts:23` 另有一个 `THINKING_LABEL`（思考级别显示名的 Record，供 model-picker/setup-dialog 用），与本常量毫无关系——rg 时务必分辨。

**(c) `CONCLUDE_ACK_TEXT`（`chat.ts:213-214`）**——练习题收尾工具（conclude，glossary 词条 36）的 ack。注释（`:206-212`）：被执行调用（agent 层）与丢弃合成对（input-events）共享，使收尾的练习题无论怎么收尾对模型读起来都一样。**Owner round 16：收尾后回合结束**——这是系统提示词法则，**没有工具级 terminate**：模型可以先说结束语，然后必须停止调用工具；下一道题等学习者的明确放行。文本原文：

```text
Problem concluded. Say your closing words about the learner's work if useful, then END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, answer their questions about the concluded one.
```

真实上游：`src/agent/tool-execute.ts:3`、`:275`（concludeResult 的 content；`:270-272` 注释说明它不带 terminate 标志——回合机械上继续，结束靠系统提示词法则。注意该注释里 "pose the next problem" 的措辞早于 owner round 16，与本常量文本冲突时**以契约文本为准**）；`src/core/native-messages.ts:41`、`:407`（丢弃合成对的 toolResult content，经 `src/core/input-events.ts:337` dismissalConclusion 使用）；`tests/practice-agents.test.ts:322`、`tests/practice-record.test.ts:278`。

**(d) `NEXT_PROBLEM_TEXT`（`chat.ts:220-221`）**——学习者明确前进信号的模型面文本（owner round 16，2026-10-06）。按钮/空输入框回车路径追加 practice-next 标记消息；模型读到它按教义出下一题或收尾。文本原文：

```text
[NEXT PROBLEM] — the learner's explicit go-ahead: pose the next problem now per the selection rules, or wrap the session in text if the arc is complete.
```

真实上游：`src/core/native-messages.ts:43`、`:339`（newNextMessage content）；`src/core/input-events.ts:254`（next 输入事件）；`components/session-core.ts:712`（乐观追加）。方括号约定是标记消息的家族特征（`native-messages.ts:289` 注释）。

**(e) `COMPACTED_HISTORY_HEADER`（`chat.ts:230-231`）**——上下文压缩（glossary 词条 25）标记消息的模型面头部（owner round 14，2026-10-05）。标记内容 = 头部 + 摘要，是 provider 在被丢弃区间位置上看到的唯一文本。**措辞法则**（注释 `:224-229`）必须告诉模型：(a) 发生了切割且是常规操作，(b) 摘要取代它之前的一切，(c) 它之后是逐字的近期记录——使模型既不重问已覆盖的地面，也不怀疑缝。文本原文（英文常量原样保留）：

```text
[SESSION HISTORY COMPACTED] The transcript before this point was summarized to fit the context window; the summary below replaces it. Everything after this message is the verbatim recent transcript.
```

真实上游：`src/core/compaction.ts:38`（import）、`:268`（newCompactionMarker：`content = `${COMPACTED_HISTORY_HEADER}\n\n${summary.trim()}``）；`tests/compaction.test.ts:200`、`:271`、`:301`（一条/两条摘要的计数断言）、`tests/compaction-service.test.ts:171-172`（摘要恰供应一次）。

#### 1.2.7 `PlanBlockData`（`chat.ts:234-247`）——计划块快照

计划块（glossary 词条 46）是 UI-only 标记消息的 payload。节注释（`chat.ts:157-168`，2026-09 design）：它是**计划变化那一刻的快照**，作为块渲染在会话流中；data part 永不到达模型；块是纯 UI 历史，重载时原样重现因为它住在记录里。

- `kind: "full"`（`:239`）——**只有 "full" 存活**（2026-09-11 转向）：计划在 authored 那一刻在流中渲染一次；neighborhood 碎片已退役——位置从持久记录活派生（持久 DAG 窗口是后继）。
- `at: string`（`:240`）、`current: string | null`（`:242`，快照时刻的当前节点，发光目标；null = 无）。
- `nodes: Array<{ id; title; status: PlanNodeStatus }>`（`:245`）——**状态是快照的，发射时派生；块在渲染时绝不重派生**。
- `edges: Array<{ from; to }>`（`:246`）。

真实上游：`src/core/plan-blocks.ts:37-49`（snapshot 构造，发射时调 derivePlanStatusesLh）、`src/core/view.ts:485`（投影把 marker.details 拼成 data-plan-block part）、`components/plan-block.tsx:678`（PlanBlock 渲染）、`components/chat.tsx:1583`。冻结快照 vs 活视图的分工见 `components/plan-block.tsx:33-35` 注释：块按携带原样渲染，弹窗才是活视图（点击时重派生）。

#### 1.2.8 `ChatSummary`（`chat.ts:259-278`）与 `ChatListItem`（`chat.ts:287-294`）

`ChatSummary` 是列表视图形状（messageCount 代替完整 messages）+ 选择器渲染的每会话状态。注释（`:249-258`）：`phase` 与 `pendingQuestion` 从存储记录（tree + messages）派生，store 在 listChats 里计算；**活性（busy）不是记录派生的**——API 路由合并它。阶段语义（三阶段、事件驱动）：probe 终于干净收尾的 probe_done，plan 终于成功的 plan_init；从持久记录派生（core/phases.ts phaseAt3）。

字段：`kind: ChatKind`（`:265`，归一化——缺席记录字段读作 teach）、`messageCount`（`:266`）、`phase: Phase3`（`:268`）、`pendingQuestion: boolean`（`:270`）、`pendingProblem: boolean`（`:273`，练习会话：已出题未收尾——侧栏 meta 的 "Problem waiting"；教学会话上缺席）、`settings?`（`:277`，经 summary spread 骑列表 payload）。

`ChatListItem extends ChatSummary` 加两个**活性**字段（注释 `:280-286`）：
- `busy: boolean`（`:288`）——chats 列表路由**只**从回合活性登记（glossary 词条 19）附加：运行中的教学回合（owner minimal-color round：背景任务不再计入——侧栏 Background agents 节是它们的通道，行 spinner 恰好意为"一个回合在飞"）。
- `compacting: boolean`（`:293`）——背景上下文压缩持有该会话模型门时为 true；路由从压缩 registry 附加——**绝非记录派生**（标记消息会持久化，运行本身是易失的）。

store 看不见活性（导入法则：store 永不 import server），所以分裂恰好在记录/活性缝上。真实上游：`src/store/chats.ts:79`（listChats）、`app/api/chats/route.ts:14-18`（合并点：`busy: isTurnRunning(c.id)`、`compacting: compactionInFlight(c.id)`）、`components/sidebar.tsx:275`、`:299`、`:345`、`components/minimal-home.tsx:99`。

#### 1.2.9 `ArtifactPartProps`（`chat.ts:306-322`）——制品渲染器注册表扩展点

节注释（`chat.ts:296-305`）：`components/chat.tsx` 把它不特殊处理的任何工具 part 经 `components/artifacts/index.ts` 的注册表按工具名（"research"、"demo"、"visual"…）渲染。**工作者在那里加渲染器——chat.tsx 对制品工作禁区**。渲染器收原始工具 part：state 为 input-available 时通常渲染活动卡（poll /api/jobs），output-available 时渲染制品（iframe / svg）。

`part` 字段：`type` / `state` / `toolCallId` / `input?` / `output?`，加两个视图缝折叠字段：
- `problemInput?: unknown`（`:316`）——出题侧折叠（owner round 17）：整个 problem 调用参数由 projectView 拼到 conclude part 上，供观察抽屉。
- `reveal?: unknown`（`:320`）——conclude 卡的视图缝拼接（owner round 2026-10-05）：**出题时**提交的 modelSolution，由 projectView 折到 part 上——揭示绝不重新 authored。

真实上游：`components/artifacts/index.ts:22`（`artifactRenderers: Record<string, ComponentType<ArtifactPartProps>>`）、`components/chat.tsx:1615`、`:1622`、`components/practice-cards.tsx:58`（ProblemCard）、`:96`（ConcludeCard）、`components/artifacts/visual-card.tsx:38`。

### 1.3 导出纯函数与核心内部算法五要素精讲

**本文件没有运行时函数。** 6 个常量（§1.2.5、§1.2.6）是它的全部运行时导出；所有"算法"都以注释形态存在（lazy v1 策略、平行日志纪律、措辞法则），由 store/compaction/native-messages 的执行缝落地。这是契约域"纯类型 + 协议文档"纪律的极端样本。

### 1.4 轻量辅助函数归并说明

无。文件内无内部函数、无内部类型（全部导出）。

---

## 2. `src/core/contracts/plan.ts`（149 行）——计划树与"位置从调用派生"

### 2.1 模块定位与纯度边界

- **契约所有权**：计划域。文件头（`plan.ts:1-8`）：会话作用域依赖树；与全局图谱同一基底——树节点折叠进图节点。
- **桶导出**：`contracts.ts:13` → core 桶。
- **纯度**：唯一 import 是文件中部的 `import type { LhMessage }`（`plan.ts:128`）。三个导出函数全是纯折叠计算，无运行时依赖，server/client/tests 三处安全（`PartsCarrier` 注释 `:62-63` 明言 mirrors phases.ts 的纯结构切片手法）。

### 2.2 核心数据结构与契约逐项精讲

#### 2.2.1 `PlanNode`（`plan.ts:13-20`）、`PlanEdge`（`:22-27`）、`PlanTree`（`:29-34`）

- `PlanNode.id`（`:15`）——**不透明、agent 自选的 slug，跨编辑稳定**（如 "chain-rule-intuition"）。`title`（`:17`）树面板短标签；`summary?`（`:19`）1-2 句覆盖说明。
- `PlanEdge.from`（`:24`）先修节点 id；`to`（`:26`）依赖 from 的节点。
- `PlanTree.version`（`:33`）——**每次变更递增**，让 UI 对变化做动画/反应。注意它与 ChatRecord.version（schema版本戳）是两回事：这是树内容的变更计数。

**2026-09-11 转向注释**（`plan.ts:36-40`）是全卷最重要的设计声明之一：树曾携带 `currentNodeId` / `doneNodeIds` 进度字段，**按设计已删除**——树只携带结构；位置与到访性在渲染时从持久记录派生（derivePlanStatuses）。**没有任何形式的完成账本。旧记录无向后兼容。**

`PlanNodeStatus`（`:43`）= `"current" | "visited" | "upcoming"`——**派生，永不存储**。

#### 2.2.2 派生教义注释（`plan.ts:45-61`）——位置从调用，绝不从结果

2026-09-11 转向（docs/probe-teach-split.md §3）的完整表述：教师 author 地图（plan_init，mermaid，可重调重写），**从不跟踪进度**。quiz 的 `nodeId` 意为"这道题**关于**这个节点"——是计划位置信号（glossary 词条 47），绝非完成信号。派生只读**调用**：

- `current` —— 最近一次带标签 quiz 调用的节点（**任何状态**）；
- `visited` —— 更早的带标签调用引用过的每个节点。

推论链（注释逐条）：一个节点自然跨多个回合/检验（几道题可标同一节点——地图保持不动）；移到新节点是教师判断前一个已完成，**与检验结果无关**（检验失败然后继续前进，仍是 visited）；**结果什么都不喂**；**没有兜底 current**（第一次带标签检验之前无 current）；无标签检验已不存在（teach quiz 的 nodeId 必填，owner ruling 2026-09-26）；当前树中缺失的 nodeId 被忽略（重写可能已删掉该节点）。

#### 2.2.3 `PartsCarrier`（`plan.ts:64-66`，内部类型）与 `DerivedPlanStatuses`（`:68-73`）

`PartsCarrier` 是最小结构消息切片：`{ parts: Array<{ type: string; state?: string; input?: unknown; output?: unknown }> }`——任何带类型 part 的东西都满足它（客户端投影的 UIMessage 形状）。不导出，是视图侧折叠的结构 duck-typing 缝。

`DerivedPlanStatuses`：`current: string | null`（`:70`，最近带标签 quiz 调用关于的节点；之前为 null）+ `visited: ReadonlySet<string>`（`:72`，更早带标签调用引用的节点——去过，单调）。

#### 2.2.4 `PlanToolResult`（`plan.ts:114-124`）——author-once 协议的工具结果

注释（`:105-113`，author-once protocol 2026-09-03）：**一个** server 侧工具 plan_init（tools/plan.ts）——mermaid `graph TD` 块规范化为结构树，在探测→教学缝调用一次，可重调重写。旧的变更/跟踪工具已消失。树面板仍从持久记录中**最新的 plan 工具输出**派生显示——加上派生状态——无独立状态通道。

- `ok: boolean`（`:115`）、`error?: string`（`:116`）。
- `tree?: PlanTree`（`:122`）——**仅成功结果携带**（owner，context diet 2026-10-09）：这是记录/UI 面的 `details` 值；**agent 面 content 永不携带它**——content 是校验过的 nodeIds + 提醒；失败只带 error。计划弹窗的 latestTree 缝读这个字段。

真实上游：`src/agent/tools/plan.ts:4`（import）、`:101`（`details: { ok: true, tree: next }`；`:82`、`:92-93` 注释说明 content 不回声树——模型一分钟前刚写了 mermaid）；`components/plan-block.tsx:716-728`（latestTree 从 `tool-plan_` 前缀、output-available 的 part 读 `output.tree`）。

### 2.3 导出纯函数五要素精讲（3 个）

#### 2.3.1 `derivedNodeStatus` `[纯函数]`

**① 完整签名与行号**（`plan.ts:76-80`）：

```ts
export function derivedNodeStatus(statuses: DerivedPlanStatuses, nodeId: string): PlanNodeStatus
```

**② 输入输出与不变量**：输入派生状态集 + 节点 id；输出三词之一。不变量：**current 优先于 visited**——重访节点（a→b→a）同时在两个集合里，渲染时 current 赢；不在任何集合 → upcoming。函数无状态、无副作用、对同一输入恒返回同一词。

**③ 核心逻辑逐步推导**：
1. `statuses.current === nodeId` → 返回 `"current"`（`:77`）；
2. `statuses.visited.has(nodeId)` → 返回 `"visited"`（`:78`）；
3. 兜底返回 `"upcoming"`（`:79`）。

三分支即全部——优先级编码在 if 顺序里。

**④ 边界条件与历史背景**：current 为 null 时第一分支永不命中（null !== 任何字符串 id），全部节点走 visited/upcoming 二分支——"第一次带标签检验前无 current"的教义由此自然成立。2026-09-11 转向前这个函数不存在（状态是存储字段）；它是"无完成账本"设计的渲染端出口。

**⑤ 真实上游调用方**：
- `components/plan-block.tsx:757`（PlanPopup 的 statusOf）；
- `components/plan-window.tsx:52`（PlanMarginalia 的 statusOf）；
- `src/core/compaction.ts:354`（planTreeToText 给每个节点打 `[status]` 标签——树经上下文压缩存活）；
- `tests/plan-tree.test.ts:397-407`（"current wins over visited; upcoming otherwise"）。
- 注意 `src/core/plan-blocks.ts:46` 的 snapshot **内联了同一三元式**而未调用本函数——语义相同，是发射侧的独立写法。

#### 2.3.2 `derivePlanStatuses` `[纯函数]`（视图侧折叠）

**① 完整签名与行号**（`plan.ts:82-103`）：

```ts
export function derivePlanStatuses(tree: PlanTree, messages: readonly PartsCarrier[]): DerivedPlanStatuses
```

**② 输入输出与不变量**：输入计划树 + 任何带类型 part 的消息切片序列（客户端投影视图）；输出 `{ current, visited }`。不变量：
- **位置只从调用派生**——part 的 `state` 字段被完全无视（input-available / output-available / output-error 一视同仁）；结果（output）什么都不喂；
- visited 单调：一旦节点进入更早停留集，后续折叠不会把它移出（除非树重写删了它）；
- 连续重复折叠：同一节点的多次连续检验 = 一次停留。

**③ 核心逻辑逐步推导**：
1. `ids = new Set(tree.nodes.map(n => n.id))`（`:83`）——当前树的合法节点集；
2. `runs: string[] = []`（`:84`）——按调用顺序的**相异**带标签节点序列，连续重复已折叠（注释：一个节点上的几次检验 = 停留在它上面一次）；
3. 双重循环 messages → parts（`:86-87`）；
4. 类型闸（`:90`）：`part.type !== "tool-quiz" && part.type !== "tool-explain"` → continue。**两种出题工具都标位置**——mechanic 是设置开关（出题机制，glossary 词条 37），折叠两者都认（owner 2026-09-27）；
5. 取标签（`:91`）：`nodeId = (part.input as { nodeId?: unknown })?.nodeId`；
6. 合法性闸（`:92`）：非 string 或不在 ids → continue（注释：无标签/未知——什么都不移动）；
7. 折叠（`:93`）：`runs.at(-1) !== nodeId` 才 push——连续重复被吸收；
8. `current = runs.at(-1) ?? null`（`:95`）；
9. `visited = new Set(runs.slice(0, -1))`（`:99`）——**当前停留之前的一切**。注释（`:96-98`）：重访（a→b→a）把 a 同时放进 visited 与 current——渲染时 current 赢（derivedNodeStatus），visited 记录它曾被离开过。

**④ 边界条件与历史背景**：
- 空消息 → `{ current: null, visited: ∅ }`（无兜底 current）；
- 树重写删节点 → 旧标签被第 6 步忽略（`tests/plan-tree.test.ts:389` 钉住）；
- 非连续重访 a→b→a：runs = [a,b,a]，current=a，visited={a,b}——a 双籍；
- 悬空调用（无结果）照样移动位置——`tests/plan-tree.test.ts:341` 用 input-available part 钉住；
- 历史：2026-09-11 转向删除存储进度；2026-09-26 nodeId 必填；2026-09-27 explain 加入识别集。

**⑤ 真实上游调用方**：
- `components/plan-block.tsx:754`（PlanPopup：点击时从 latestTree + 全部投影消息重派生——活视图）；
- `components/plan-window.tsx:48`（PlanMarginalia：每次渲染重派生，带标签检验一流入发光就移动——`:19-21` 注释）；
- `tests/plan-tree.test.ts:309-446`（整个 describe 块：位置非完成、explain 同权、重访、重写）。
- 两处组件都用 `messages as Parameters<typeof derivePlanStatuses>[1]` 做结构适配——PartsCarrier 的 duck-typing 设计使投影消息无需转换即可喂入。

#### 2.3.3 `derivePlanStatusesLh` `[纯函数]`（原生侧折叠，Wave D）

**① 完整签名与行号**（`plan.ts:132-149`，节头 `:126`）：

```ts
export function derivePlanStatusesLh(tree: PlanTree, messages: readonly LhMessage[]): DerivedPlanStatuses
```

**② 输入输出与不变量**：同一派生 over **原生记录**（LhMessage[]）。注释（`:130-131`）：只读 quiz **调用**（任何状态——悬空调用仍移动位置；结果什么都不喂）。输出形状与视图侧完全一致（同一 DerivedPlanStatuses）。

**③ 核心逻辑逐步推导**（与视图侧同构，过滤层不同）：
1. ids 集（`:133`）、runs 数组（`:134`）同上；
2. 消息闸（`:136`）：`(m as { role?: string }).role !== "assistant"` → continue——原生记录里工具调用只住在 assistant 消息；
3. content 闸（`:137-138`）：content 非数组 → continue；
4. 块闸（`:140`）：`block.type !== "toolCall" || (block.name !== "quiz" && block.name !== "explain")` → continue——原生形状是 `{ type: "toolCall", name, arguments }`，对应视图侧的 `tool-<name>` part；
5. 标签取自 `block.arguments.nodeId`（`:141`），合法性闸（`:142`）、连续折叠（`:143`）、current/visited 收尾（`:145-147`）与视图侧逐字同构。

**④ 边界条件与历史背景**：原生 toolCall 块**没有 state 字段**——"任何状态"在原生侧是结构性的：调用块存在即计数，悬空调用（无匹配 toolResult）天然移动位置。这是 Wave D（owner-approved 2026-09-26）把派生从已删除的 server 投影搬到原生记录上的产物；两个折叠并存是因为消费者分处两端：客户端组件吃投影 part（用 derivePlanStatuses），core 的压缩/发射缝吃原生记录（用本函数）。

**⑤ 真实上游调用方**：
- `src/core/compaction.ts:350`（planTreeToText，`:348-364`：树经压缩逐字存活——结构来自 record.tree，状态来自持久记录，空树 → 缺席节）；
- `src/core/plan-blocks.ts:38`（snapshot：计划块发射时派生状态，块永不重派生）；
- `tests/plan-tree.test.ts` 与 `tests/plan-blocks.test.ts:8`（退役声明引用）。

### 2.4 轻量辅助函数归并说明

- `PartsCarrier`（`:64-66`）：内部结构类型，已在 §2.2.3 精讲。
- 本文件无内部函数。三个导出函数之外零遗漏。

---

## 3. `src/core/contracts/graph.ts`（385 行）——知识图谱形状、账本契约与标题纯函数

### 3.1 模块定位与纯度边界

- **契约所有权**：图谱域。文件头（`graph.ts:1-18`）是图谱愿景的最小实现声明（docs/vision.md §1，2026-09-02 重设计）：每个节点是一个**真命题**；边是 follows（可导出）与 supports（有理据支持但不蕴含）；出处消息粒度；抽取自由形式、事后、与会话计划树完全解耦。**图是所有教学会话（与导入笔记）推理链的抽取——别无其他：无 quiz 结果、无理解度评估（2026-09-27 清理）**。尚未决定的东西（状态模型、强度派生、选择策略）刻意不在这里。
- **桶导出**：`contracts.ts:14` → core 桶。
- **纯度**：唯一 import 是 `:21` 的 `import type { CallUsage, ExtractionRunUsage } from "./chat.ts"`。其中 **`CallUsage` 是残留未使用导入**（rg 核实全文件仅 :21 出现）—— ExtractionRunUsage 被 NotesSource.extractions 使用。唯一运行时函数 `titleFromPrompt` 是纯字符串计算。
- **边界澄清**：链/节点 id 的铸造与归并键**不在本文件**——`newGraphNodeId`（`src/core/graph.ts:80`，`n_` + 12 hex）、`newGraphChainId`（`:86`，`arg_` + 12 hex）、`chainKey`（`:92-95`，排序前提 + `>` + 结论）住在 core 的图派生模块（server 侧纯模块，经端口注入存储）。契约拥有形状，core/graph.ts 拥有算法。

### 3.2 核心数据结构与契约逐项精讲

#### 3.2.1 `GraphEdge`（`graph.ts:29-32`）与 `GraphChain`（`:42-54`）——chains-primary

`GraphEdge` 只有 `from` / `to`。注释（`:24-28`，owner 2026-09-30："图是真实存储之物的有损图像"）：它是**派生视图**的关系——链才是存储真相；快照从链派生**无类型箭头**：每个前提 → 链的蕴含节点，蕴含节点 → 结论。 nothing 存储或变更这些——每次变化后重建，绝不转换回去。

`GraphChain` 是一条存储的**推理链**——一个论证：前提**联合**蕴含结论（chains-primary，owner 2026-09-30）：

| 字段 | 行 | 含义 |
|---|---|---|
| `id` | 44 | `"arg_" + nanoid-like`，store 分配（节点铸造模式）。**链的 id 就是其派生蕴含节点的 id**——arg_ 命名空间自有，与 n_ 无撞 |
| `premises: string[]` | 47 | 论证前提的节点 id——至少一个，联合充分。线上是抽取器局部 id；解析后是节点 id |
| `conclusion` | 49 | 前提联合蕴含的节点 id |
| `provenance: ProvenancePoint[]` | 52 | 此论证被断言的每个 (chat, message) 点——读时跨断言行 union |
| `createdAt` | 53 | 首行时间 |

语义要点（注释 `:33-41`）：同一结论的**独立论证是不同链**（可共享 conclusion）；一条链内的共前提**一起**使用。引用死节点的链随它死（完全死亡级联穿过每条引用链）。

真实上游：`src/store/graph.ts:40`、`:112`（isGraphChain 守卫）、`:144`（appendChain）、`:147`（readChains）；`src/core/graph.ts:232-254`（emitChain）；`src/core/ports.ts`（GraphStore 端口）；`components/chain-table.tsx:72`；`src/core/chains.ts:36-40`（chainsForSelection 以结构 Pick 消费链形状）。

#### 3.2.2 `EmissionStats`（`graph.ts:61-72`）——合并器输出

一次抽取运行合并进图账本的东西——合并器输出，也持久化在抽取运行用量记录里（contracts/chat）。

- `nodes: number`（`:63`）——新增图节点数。
- `chains?: number`（`:65`）——新增推理链数。**仅在旧记录中可选**：前链时代的用量历史携带 `edges` 代替——读时容忍，绝不再写（无向后兼容体制，owner 2026-09-30）。
- `droppedChains?: number`（`:71`）——本次合并中简化通道移除的链（owner 2026-09-30 晚——ancestry-cover / prefer-fewest-premises）。**是维护不是抽取**：追加无论如何计入 chains。无东西被丢时 undefined（前简化记录读作零）。

真实上游：`src/core/graph.ts:155-157`（mergeFindings 初始化 `{ nodes: 0, chains: 0 }`）、`:207`（stats.nodes++）、`:253`（stats.chains!++）；`src/agent/subagents/extraction.ts:766`、`:778`、`:783`、`:1029`；`app/api/graph/import/route.ts:39`；`src/core/cost-summary.ts:20`。

#### 3.2.3 `ProvenancePoint`（`graph.ts:77-84`）——出处（glossary 词条 56）

`chatId`（`:81`）——锚定的会话，**或笔记源 id（"src_…"）**：导入无消息锚（出处是文件本身，经映射行 + 源记录记录）。`messageId`（`:82`）。DECIDED 2026-09-02：消息粒度——节点与边记录它们出现过的每个 (chat, message)，可深链到精确的持久记录点。

真实上游：`src/core/graph.ts:121`（pointOf：messageId 缺席 → `""` 会话级）、`:125`（samePoint）；`src/store/graph.ts:93`（isProvenancePoint 守卫）。

#### 3.2.4 `NotesSource`（`graph.ts:93-105`）——格式无关前门

一个导入笔记文件的簿记（DECIDED 2026-09-13）：任意格式的个人笔记走同一 抽取器→审计器→合并器 流水线，文件本身是出处锚。**没有 chat**：详情卡把文件路径显示为静态条目（不是链接）。

- `id`（`:94`）——`"src_" + 文件路径哈希`，**确定性**：重导同一文件对同一源 id 重跑抽取（映射按它去重）。
- `filePath`（`:95`）、`importedAt`（`:97`，ISO，即 checkpoint 的 foldedAt）。
- `contentFp?`（`:101`）——**遗留内容指纹**：读旧记录时接受但忽略；每次显式笔记导入处理整个文件；新导入不计算不写入；无需迁移。
- `extractions?: ExtractionRunUsage[]`（`:104`）——运行的用量日志，与 ChatRecord.extractions 同一 append-only 纪律，按 startedAt 幂等。

真实上游：`src/store/graph.ts:168`（upsertSource）、`:174`（readSources）、`:298-300`（sources.json 是读-改-写 JSON map，**不是** append-only 账本）。

#### 3.2.5 `NamingRunStats`（`graph.ts:110-120`）——结构孪生契约（现状：休眠）

一次簇命名刷新做了什么——namer 的 ClusterRefreshStats 的合同形状，"使 agent 层无需 import contracts；结构孪生保持可互换"。四字段：`detected`（`:112`，当前图分出的社区数，所有尺寸）、`claimed`（`:114`，经簇标签核心存活规则保住标签的社区）、`named`（`:116`，送去 namer 的社区：未命名且 size ≥ MIN_CLUSTER_SIZE）、`appended`（`:118`，实际追加的 labeling 记录，幂等去重可能收缩）。

**诚实的现状注记**：rg 全仓核实本类型**零直接引用**（`ClusterRefreshStats` 也只出现在本注释里）。当前图谱的簇是**出生会话社区**（`src/core/graph.ts:556-564` 注释："embeddings 已死……无 LLM 命名通道、无持久化分区"；`src/core/session-clusters.ts:61` birthSessionPartition），标签直接取会话名/文件路径。本类型是命名通道时代的遗留契约形状，按"结构孪生"纪律保留——讲解时不应把它描述为现役流水线。

#### 3.2.6 `CURRENT_GRAPH_FORMAT_VERSION`（`graph.ts:123`）

`= 1`。图家族格式版本——format.json sidecar（`src/store/graph-format.ts`）。与 chat 的 lazy v1 平行但机制略异：
- 读侧守卫：`src/store/graph-format.ts:44-52`（assertGraphFormat：`v > CURRENT_GRAPH_FORMAT_VERSION` → **throw**，每个图家族读都调；绝不写——黄金夹具钉读为字节一致）；
- 写侧盖戳：`:56-60`（ensureGraphFormat：首次图家族写时 lazy 创建 sidecar）；
- 无戳/损坏 sidecar 读作 v1（`:28-38`），不致命。

#### 3.2.7 `GraphNode`（`graph.ts:126-147`）——命题节点（glossary 词条 52）

| 字段 | 行 | 含义 |
|---|---|---|
| `id` | 128 | 不透明稳定 id，store 分配：`"n_" + nanoid-like` |
| `name` | 134 | 极短标签——词汇表词条式的紧凑把手（"Will to power"）。**仅展示用**：不唯一、不是身份键、永不精确——statement 承载精确性。创建时设定（首行定义）；link-append 永不改变它 |
| `statement` | 140 | 最小命题——一条真的、自足的、全精确陈述。**身份锚**：审计器靠对它的判断（link-or-create）识别重遇，不是字符串匹配。详情卡显示它；画布标签是 name |
| `aliases: string[]` | 143 | 会话用过的逐字措辞——身份审计轨迹（世界如何说节点所说） |
| `createdAt` | 144 | 首行时间 |
| `provenance` | 146 | 命题出现过的每个 (chat, message) 点 |

真实上游：`src/store/graph.ts:97`（isGraphNode）、`:132`（appendNode）、`:138`（readNodes）；`src/core/graph.ts:198-205`（创建）、`:189-196`（link-append）；`src/core/chains.ts:1`；`components/chain-table.tsx:72`。

#### 3.2.8 账本行契约：`SessionCheckpoint`（`graph.ts:151-155`）与 `CoverageEntry`（`:165-173`）

`SessionCheckpoint`——sessions.jsonl 行，一个 chat 的发射 checkpoint（哪些 chat 已折叠、折到哪个 updatedAt——**绝不折叠两次**）：`chatId`（`:152`）+ `foldedAt`（`:154`，折叠时 chat 记录的 updatedAt）。

`CoverageEntry`——coverage.jsonl 行（vision-extraction-coverage.md，settled 2026-09-15，注释 `:158-164`）：**一个 chat 的一条消息已被抽取**——按抽取视图所见内容的指纹。**消息是覆盖度单位**（glossary 词条 55）；"未覆盖"是派生的（给当前持久记录打指纹、做 diff）——绝不双轨跟踪。quiz 答案合并进提问消息会改变其指纹：**消息重开自己，只重开自己**。chat 抽取写这些代替整 chat checkpoint；笔记导入保留 checkpoint（文件是一次性的）。

- `chatId`（`:166`）、`fp`（`:168`，消息视图行的 sha256——"covered"恰好意为这个）、`tokens`（`:170`，视图的 chars/4 估算——显示 + 预算）、`foldedAt`（`:172`，该消息最近一次抽取运行合并的 ISO 时间）。

真实上游：`src/store/graph.ts:123`（isCheckpoint）、`:126`（isCoverageEntry）、`:151-161`（append/read 两族）；`src/core/coverage.ts:24-27`（import + 再导出）、`:102`（coveredSet）、`:117`；`src/core/graph.ts:108-113`（MergeSource：chat 路径传 coverage 批，notes 路径不传 → 写整 chat checkpoint）；`src/agent/subagents/extraction.ts:1205-1210`（每消息追加）、`:1375`（notes checkpoint）；`src/core/graph-deletion.ts:58-61`。

#### 3.2.9 存储格式与流水线教义注释（`graph.ts:175-209`）

JSONL 账本（glossary 词条 54）在 config.LEDGER_FILES（nodes/chains/sessions），全部 append-only。**边永不存储**——派生视图（蕴含节点 + 无类型箭头）每次读从链重建（chains-primary）。

- `nodes.jsonl`：每节点一行——**一个 id 的首行定义 name/statement/createdAt**；同 id 的后续行是 link-append（会话的重遇）：其 statements/aliases 并入 aliases，provenance union；name 保持首行的。getGraph 按 id 归并。
- `chains.jsonl`：每链**断言**一行；读者按 (premises, conclusion) 归并、union provenance——**首行的 arg_ id 是链的身份**。
- sessions.jsonl 是抽取 checkpoint。

**抽取流水线是唯一的图写入者**（抽取器→审计器→合并器），树盲、事后（2026-09-27 清理）：抽取器是**唯一**看见原始源的阶段（整会话可读 markdown 或原始笔记）；审计器**从不见源**——它的工作是准备合并：身份裁决（link-or-create）经图探索工具（find / list_sessions / list_propositions）；合并器（core/graph.ts，确定性）应用裁决并追加。quiz 事件与理解度观察已消失——流水线是唯一的会话→图桥梁，只携带命题 + 结构。

**注释地层学注记**：本段注释仍保留 2026-09-30 之前的边缘措辞（"follows/supports edges"、审计器"可画 BRIDGING edges"）。操作性契约以 `SessionFindings`（propositions + chains）与 `AuditVerdicts`（**仅 links**，`:280-283` 明言 edges 参数已删）为准；`src/agent/subagents/extraction.ts:244-248` 的审计 schema 注释同步确认"审计器永不铸造边——图跨源连接只经识别的等价"。读注释时以类型声明与更晚的 owner 裁定为权威。

#### 3.2.10 抽取流水线三段形状（`graph.ts:212-286`）

**`ExtractedProposition`（`:215-246`）**——一个提议命题（节点候选或重遇）：
- `id`（`:217`）——抽取器局部 id（"p1"…），被链引用；
- `name`（`:222`）——几个词的紧凑把手；创建时成为节点 name；link 时既有节点保留其 name；
- `statement`（`:228`）——最小命题：真、自足、面向世界、全精确。**无学习者/教师/会话引用**：误解被陈述为真的纠正，错误永不记入图（2026-09-27：事件账本已删）；
- `aliases`（`:230`）——会话用过的逐字措辞；
- **submit-schema slim 注释**（`:232-236`，owner 2026-09-28）：`messages` 与 `evidence` 已删——逐字引用字段从未持久化，弱模型却为它们烧光重试（"propositions.0: must be object"——字符串化 payload 坍缩，模型抖动 glossary 词条 95 的典型案例）。抽取器只报告命题 + 结构；
- `messageId?`（`:245`，owner 2026-10-13）——**可选、仅会话路径**：命题来源的**那一条**教师段落的 messageId。抽取器从视图的 "TEACHER [id]" 标签（core/coverage.ts messageViewLines）抄它，submit 缝对**当前批**校验它。合并器把它盖进节点出处点 {chatId, messageId}（新节点**与** link-append 都盖）；链保持会话级。笔记导入与遗留/core 调用者没有：undefined → messageId ""（会话级），所以**无持久化形状或格式版本变化**（GraphNode / ProvenancePoint 不动）。

**`ExtractedChain`（`:251-256`）**——一个提议论证（2026-09-30 重设计）：`premises`（`:253`，联合蕴含结论的命题局部 id）+ `conclusion`（`:255`）。端点是抽取器局部 id——**抽取器是唯一提议链的阶段**；合并器解析为节点 id。

**`SessionFindings`（`:259-262`）**——抽取器输出形状：`propositions: ExtractedProposition[]`（`:260`）+ `chains: ExtractedChain[]`（`:261`）。

**`IdentityLink`（`:271-274`）**——一条身份裁决：`id`（`:272`，抽取器局部命题 id）→ `linkTo`（`:273`，该命题**就是**的既有图节点）。link 时会话措辞（statement、aliases）并入节点 aliases、provenance union。**等价偏置**（2026-09-27）：同一主张的转述、改写、压缩**合并**——不因措辞不同而创建重复；只有真正不同的命题分开。

**`AuditVerdicts`（`:284-286`）**——审计器输出，**仅裁决**（owner 2026-09-28）：审计器从不改抽取器发现，所以不复述它们；确定性合并器拼接 findings + verdicts。`links: IdentityLink[]` 是审计器的**全部**交付（owner 2026-09-28 晚：edges 参数已删——审计器永不铸造边）。**无 drop 通道**——审计器从不拒绝；抽取器被完全信任（2026-09-27）。

真实上游（结构消费——`ExtractedProposition` 与 `IdentityLink` 两个标识符在契约外零直接引用，经索引访问消费）：
- `src/core/graph.ts:151-152`（mergeFindings 收 SessionFindings + AuditVerdicts）、`:168`（`linkOf = new Map(verdicts.links.map(l => [l.id, l.linkTo]))`——IdentityLink 的消费点）、`:173-211`（for-of findings.propositions——ExtractedProposition 的消费点，含 messageId 锚 `:177-180`）、`:232-254`（emitChain 消费 ExtractedChain，混合命名空间解析：job 局部 map 或既有节点 id 逐字通过）；
- `src/agent/subagents/extraction.ts:24`、`:267`（NotesFindings = SessionFindings）、`:356-364`（asSessionFindings：aliases 补 []）、`:366-370`（fillAudit）、`:595`、`:964`（audit）。

#### 3.2.11 快照契约：`Cluster`（`graph.ts:293-300`）、`GraphSnapshot`（`:303-347`）、`Position`（`:350-353`）

`Cluster`——快照中一个渲染簇：`id`（`:296`，claimed 时是 labeling 记录 id；未命名簇仍出现——有 hull 无名字——用成员哈希 id）、`label: string | null`（`:298`）、`members: string[]`（`:300`，节点 id，已排序；hull + 质心是渲染器关切）。当前派生：出生会话社区（`src/core/graph.ts:566-577`），MIN_CLUSTER_SIZE ≥ 3 是 hull 呈现规则（`src/core/clusters.ts:14`）；**仅命题**——蕴含节点永不被分区。

`GraphSnapshot`——GET /api/graph payload，主页视图**纯渲染器**所需的一切。字段矩阵（存储真相 vs 派生图像是本契约的核心对称）：

| 字段 | 行 | 存储/派生 | 含义 |
|---|---|---|---|
| `nodes` | 306 | 混合 | 命题节点 + 派生蕴含节点（每链一个，id = 链 id）——画布渲染之物 |
| `propositions` | 310 | **存储** | 仅存储命题节点——读世界的消费者（链表）取这个列表，绝不取画布图像 |
| `edges` | 313 | 派生 | 无类型箭头 premise→imp→conclusion；存储链的有损图像；每次变化后重建，永不存储 |
| `logicalEdges` | 318 | 派生 | 每链收缩为直接 premise→conclusion，**仅命题 id**（imp 跳被折叠）。深度通道消费这些——推理深度是命题的属性，绝非几何点的（owner 2026-09-30） |
| `impLinks` | 323 | 派生 | 每个**多前提**活链一个：深度通道把每个 junction 锚在最高前提行与结论行的平均——严格在前提之上、结论之下（owner 2026-09-30） |
| `chains` | 327 | **存储** | 存储推理链（读时按 (premises, conclusion) 归并）——链表与练习流水线的输入；读真相，绝不读派生扇出 |
| `sessions` | 329 | 索引 | chatId → title，每个触及图的 chat |
| `fileSources` | 333 | 索引 | srcId → 文件路径，每个触及图的导入笔记文件；静态出处条目——详情卡显示纯文本路径，不是链接 |
| `nodeSessions` | 335 | 索引 | nodeId → 触及它的 chatIds（点击穿透出处） |
| `clusters` | 342 | 派生 | 出生会话社区；纯出处派生——永不依赖布局 |
| `positions?` | 346 | 可选存储 | 每节点静息布局位置（positions 账本，core/layout.ts settle 写）。新图缺席——视图回落自己的一次性 forceAtlas2 |

`Position`（`:350-353`）：`x` / `y`——布局空间静息位置。

真实上游：`src/core/graph.ts:510`（graphSnapshot 构造）、`src/server/graph.ts:22`（graphView）、`app/api/graph/route.ts:12`（薄传输）、`components/graph-view.tsx:950`、`:1059`、`components/minimal-home.tsx:97`；Position：`src/store/graph.ts:204-207`（readPositions/writePositions）、`src/core/layout.ts:35`、`:545-547`。

### 3.3 导出纯函数五要素精讲（1 个）

#### 3.3.1 `titleFromPrompt` `[纯函数]`

**① 完整签名与行号**（`graph.ts:368-385`；常量 `TITLE_MAX_CHARS = 72` 在 `:359`）：

```ts
export function titleFromPrompt(prompt: string): string
```

**② 输入输出与不变量**：输入学习者第一条消息（或任意 prompt）；输出短标题。不变量（注释 `:361-367`，owner 2026-10-06）：
- 结果长度 ≤ TITLE_MAX_CHARS + 1（72 字符 + 省略号）；
- 切口**吸附到不超过上限的词边界**——标题永不结束在词中间；唯一例外是单个超长词（标识符、URL）：在上限处切，劈开词；
- 空白先折叠为单空格，所以边界总是单空格边界；
- 确定性——测试可钉住。

**③ 核心逻辑逐步推导**：
1. `oneLine = prompt.replace(/\s+/g, " ").trim()`（`:369`）——所有空白（换行、tab、多空格）折叠为单空格并去首尾；
2. `oneLine.length <= TITLE_MAX_CHARS` → 原样返回（`:370`）——短消息不加省略号；
3. 边界扫描（`:373-378`）：`cut = -1`；`for (let i = TITLE_MAX_CHARS; i > 0; i--)`，若 `oneLine[i - 1] === " "` 则 `cut = i - 1; break`——从上限往回找**第一个**空格，切口坐在它**之前**，无尾随空格骑进标题；
4. 单词特例（`:382`）：`cut < 0`（上限内无边界）→ `cut = TITLE_MAX_CHARS`——劈开长词（owner 特例）。注释：首词恰好填满上限时这也落对——在上限处切**就是**边界；
5. 返回 `` `${oneLine.slice(0, cut)}…` ``（`:384`）。

**④ 边界条件与历史背景**：
- 恰好 72 字符 → 第 2 步原样返回，无省略号（`tests/title-from-prompt.test.ts:20-21`）；
- 首词恰好 72 字符后跟空格 → 扫描查 oneLine[71]（词尾字符）非空格，一路到 i=1 无命中 → cut=72 → 词 + "…"（`tests/title-from-prompt.test.ts:39-43`）；
- 单个 102 字符巨词 → 72 个 x + "…"（`:46-47`）；
- 多行/tab 输入 → 折叠为单空格一行（`:16`）；
- 历史：owner 2026-10-06 智能截断裁定——"长到在侧栏与顶栏保持信息量，短到第一条消息永不读成段落。可调——一个数字，一个地方"（`:355-358`）。
- **域位置注记**：这是 chat 标题助手，却住在 graph 域文件尾部（`:355-385` 独立节）——它是 graph.ts 唯一的运行时函数，组织位置是历史遗留；经域桶与 `src/server/chats.ts:25` 再导出供会话创建使用。

**⑤ 真实上游调用方**：
- `app/api/chats/route.ts:3`（import 自 server 桶）、`:28`（`createChat(titleFromPrompt(title || "Untitled session"), kind)`——会话创建的唯一标题来源）；
- `src/server/chats.ts:5`、`:25`（core → server 再导出缝）；
- `tests/title-from-prompt.test.ts:11-52`（全部边界钉住）。

### 3.4 轻量辅助函数归并说明

本文件无内部函数。唯一残留物是 `:21` 的未使用类型导入 `CallUsage`（§3.1 已注记）。链身份纯计算（`newGraphChainId` / `chainKey`）的归属边界已在 §3.1 澄清——它们不在契约内，本卷不越界展开（属 core/graph.ts 卷）。

---

## 4. `src/core/contracts/jobs.ts`（438 行）——异步协议的核心纯函数群

### 4.1 模块定位与纯度边界

- **契约所有权**：后台任务域（jobs stream）。文件头（`jobs.ts:1-8`）：sub-agent job 契约——异步 ack-and-steer 协议（glossary 词条 66）。
- **桶导出**：`contracts.ts:16` → core 桶。
- **纯度**：`:9-10` 仅类型 import（CallUsage、LhMessage/LhMarkerMessage）；`:11` 有一条**运行时** import：`newHandoffMessage`（来自纯且浏览器安全的 native-messages.ts）。8 个导出函数 + 2 个内部函数全部无 IO、无共享状态修改；两个 steer 构造器内含 `Date.now()` 时间戳（§4.3.5 诚实说明）。
- **协议文档地位**：`jobs.ts:139-188` 的 THE ASYNC PROTOCOL 注释是全应用异步语义的规范文本（glossary 词条 66 锚点 `:140-152`），server/jobs.ts 的文件头（`src/server/jobs.ts:2`）直接引用它。

### 4.2 核心数据结构与协议契约逐项精讲

#### 4.2.1 `JobKind`（`jobs.ts:15`）、`JobStatus`（`:16`）、`JobRecord`（`:18-43`）

`JobKind = "research" | "demo" | "visual" | "pdf"`——四种 sub-agent 角色（glossary 词条 68）。`JobStatus = "running" | "done" | "error"`——**仅 worker 计算状态**。

`JobRecord`（JobStore 记录，glossary 词条 65，以 toolCallId 为键）：

| 字段 | 行 | 含义 |
|---|---|---|
| `id` / `kind` / `chatId` | 19-21 | 身份与归属 |
| `toolCallId` | 23 | 此 job 履行的工具 part |
| `input?: unknown` | 25 | **派发时参数，spawn 前保存**（异步协议 §3）。旧 job 从历史解析 |
| `delivery?: { kind: "result" \| "abort"; status: "pending" \| "delivered" }` | 28 | **会话拥有的投递**，独立于 worker 终态。遗留记录缺席：旧终态 job 绝不重放 |
| `status: JobStatus` | 30 | 仅 worker 计算；pending 投递不让它保持 running |
| `activity` | 32 | 最新人类可读活动行（如 `web_search: "sigma.js v3"`） |
| `createdAt` / `updatedAt` | 33-34 | 时间戳 |
| `result?: unknown` | 36 | sub-agent 结果（steer-artifact payload） |
| `error?` | 37 | 错误文本 |
| `usage?: JobUsage` | 42 | 金钱通道：runner 随 step 完成写入的累计 token 用量；成本读时推断。2026-09 前 job 与捕获落地前缺席——渲染器显示"—"，绝不零 |

**worker 状态与投递状态的正交分解**是本契约的精髓：计算完成（done/error）≠ 课程已消费结果（delivered）。问题待答可让结果 pending 任意久，worker 资源早已释放。

真实上游：`src/store/jobs.ts:31-48`（createJob）、`:61-64`（updateJob merge patch）、`src/core/ports.ts:141-159`（CreateJobInit / JobPatch = Partial<Omit<JobRecord, 身份字段>> / JobStore 端口）、`app/api/jobs/route.ts:22`（listJobs 响应）、`components/activity-dock.tsx:6`（活动流，glossary 词条 73）。`JobStatus` 标识符在契约外零直接引用——消费者经 `JobRecord.status` 与字面量比较（如 `src/server/jobs.ts:439` `job.status !== "running"`）。

#### 4.2.2 `JobUsage`（`jobs.ts:50-73`）与 `UsageStepLike`（`:78-84`）

`JobUsage`——sub-agent 运行的累计用量，与 chat 回合同一记账形状（CallUsage）展平为一个运行总和 + step 计数。token 字段与 CallUsage 一样可选：**没有任何模型调用报告过的字段保持 undefined——缺席不是零**（金钱通道教义；成本渲染"—"，绝不 $0）。

- `model`（`:53`）——provider 限定（model slots wave 2026-09-20；匹配 Pi catalog 查找键）；
- 运行总和五字段（`:55-59`）+ `cacheWrite1hTokens?`（`:60`）；
- `calls?: CallUsage[]`（`:63`）——逐次调用，供当前 catalog 的按调用分层定价。旧 job 缺席；**绝不从累计总和回填**；
- `steps: number`（`:65`）——模型调用计数（每次单独计费）；
- `lastStep?: CallUsage`（`:72`）——**最近一次**模型调用的记账（2026-09 dock 契约）：每 blob 上下文行读 last-step input+output 对照模型的**活** catalog 上限（server 拼到活动流上——绝不用累计总和，绝不用客户端表）。首次调用完成前缺席；缺席 provider 字段保持缺席。

`UsageStepLike`——折叠进 JobUsage 的每调用形状：SDK LanguageModelUsage 的**结构窄化**（注释 `:75-77`：无运行时 "ai" import——任何带这些字段的对象都可折叠，包括真品与测试假货）。字段：`inputTokens?`、`inputTokenDetails? { cacheReadTokens?; cacheWriteTokens?; cacheWrite1hTokens? }`、`outputTokens?`、`outputTokenDetails? { reasoningTokens? }`。

真实上游：`src/agent/subagents/runner.ts:12`、`:134`（usageTotals Map）、`:117`（LoopContext.onUsage 收 UsageStepLike）；`components/activity-dock.tsx:46-48`（JobUsage 扩展 lastStep 的上下文行）、`:199-214`（lastStep.inputTokens + output + cacheRead 对照 limit）。

#### 4.2.3 THE ASYNC PROTOCOL（`jobs.ts:139-188`）——五条协议条款

"ack now, steer later"（pi sub-agents 模型，vision §2.5）：

1. **§1（`:143-149`）**：job 工具（research/demo/visual/pdf）**server 执行**。模型回合中调用；execute 创建 job 记录、点燃背景 runner、**立即**以 ack 解决（"dispatched — continue your turn"）。教师回合**不**在调用处结束：继续教、可派发其他独立 job（完全并行）、何时结束何时结束。**工具 part 的 output 永远是 ack**。
2. **§2（`:151-158`）**：背景 runner（src/agent/subagents/runner.ts）跑该 kind 的 sub-agent 循环——隔离上下文、modelFor(role)、verify-never-one-shot 教义（headless 测试过的 demo、看过的 SVG、有出处的 brief）——在 job 记录里跟踪活活动行。**一个**中央客户端 poll `GET /api/jobs?chatId=…`（在 Chat 里）驱动每个 job 表面：持久记录派发卡（按 toolCallId 的活活动，worker 完成后安静一行）、sub-agents 侧栏面板、job 落定时的一次 re-sync。
3. **§3（`:160-166`）**：派发在 spawn 前存 input。完成时 runner 在**一次** job update 里存 result + 终态 worker 状态 + pending 投递，然后排队 buildSubagentSteer **不等投递**。原生自定义标记的 content 是模型面文本；details 携带完整制品 payload 供 UI。即使问题让结果无限期 pending，worker 资源也释放。只有计算中的 worker 出现在 Background agents 或接受中止。
4. **§4（`:168-182`）**：会话投递拥有**每确定性 steer ID 一个 registry 条目**，包括 wake 在飞或 409/403 退回货物时。活 agent 经 pi steering 取走；registration 在答题运行首次 poll 前恢复保存的 pending job。否则 idle wake 用正常回合组装，尊重待答问题、丢弃、背景同意。**保存的持久化标记完成投递；HTTP 200 或流可见性 alone 不算**。失败启动安静 pending 直到学习者运行或重启恢复，无新定时器、无可见投递错误、无 worker 状态变化。既有 409 backoff 与同意延迟保留。被接受的回合绝不自动重放。遗留 running+result 记录变 finished/pending；遗留终态无投递元数据记录不动。会话删除丢弃 pending 投递而非当作运行中工作。
5. **§5（`:184-187`）**：**永不存在 pending job part**，所以输入框（glossary 词条 75）从不因 job 闸门（学习者可 mid-job 插话；steer 排在他们回合后面）；job 工具输出永不触发客户端 sendAutomatically 续跑——那机制保持 quiz/ask-only。

#### 4.2.4 四 kind 的工具输入/结果契约（`jobs.ts:190-252`）

| kind | 输入 | 结果 | 关键约束 |
|---|---|---|---|
| research | `ResearchToolInput`（`:190-194`）：`question` + `context?`（教师用它做什么——聚焦研究 brief） | `ResearchResult`（`:196-199`）：`brief` + `sources: {title,url}[]` | 失败形状：sources 空 **且** brief 匹配 `/^Research failed:/i` |
| demo | `DemoToolInput`（`:201-205`）：`title` + `brief`（概念、参数/交互、视觉风格） | `DemoResult`（`:207-214`）：`title` + `html`（自足单文件 HTML/JS，sandboxed-iframe ready）+ **`tested: true`**（builder sub-agent 交付前 headless 执行过）+ `notes?` | 失败形状：html 非 string 或空 |
| visual | `VisualToolInput`（`:216-219`）：`brief`（**一个**视觉的精确 brief） | `VisualResult`（`:221-225`）：`svg`（maker 看过渲染验证）+ `notes?` | 失败形状：svg 非 string 或空 |
| pdf | `PdfToolInput`（`:232-237`）：`path`（学习者 PDF）+ `question` | `PdfResult`（`:239-252`）：`path` + `question` + `brief`（页引用指向 pagesConsulted；失败 `/^PDF failed:/i` 镜像 research）+ `pagesRead` + `pagesConsulted` | 见下 |

`PdfResult` 的两个页集合是诚实计数契约（注释 `:245-251`）：`pagesRead`（`:249`）——reader **真读过**的页（extract 或 render 输出进入循环；UI 徽章的诚实计数；**搜索命中片段不算**——sources v1 split 2026-09-19，起因是长书 search-first 阅读的 "78 pages consulted" 夸大）；`pagesConsulted`（`:252`）——内容进入循环的每页，含搜索命中上下文行——完整审计集（brief 引用可指向这里）。pdf-reader 的用户裁定（`:227-231`）：渲染图像永不离开 sub-agent 上下文；教师只拿文本。

真实上游：`src/agent/subagents/runner.ts:66`（JobToolInput 联合）、`:363`（research）、`:433`（demo）、`:470`（visual）、`:508`（pdf）、`:406`（ResearchResult 构造）、`:571-572`（parseSources）；`src/agent/subagents/pdf-reader.ts:10`、`:26`；`components/artifacts/demo-card.tsx:103`、`visual-card.tsx:53`、`steer-card.tsx:4`。

#### 4.2.5 steer 标记消息契约（`jobs.ts:255-314`）

节注释（`:255-263`，Wave B owner-approved 2026-09-26）：steer 是**原生记录消息**——LhMarkerMessage customs（role "custom"，glossary 词条 42），自定义消息分类学的 wake 成员。模型面文本骑 `content`（下方单源）；UI payload（制品、中止徽章）骑 `details`，**永不到达模型**（toLlmMessages 把标记映射为只携带 content 的 user 消息，`src/core/native-messages.ts:583`）。**确定性 id（`steer_<jobId>`）就是幂等键**——steerDelivered 按它匹配。

- `SubagentResultMeta`（`:266-275`）：`jobId` / `kind` / `toolCallId` + `aborted?: true`（`:274`，仅中止 steer：学习者中止了 job——它落为 error "Aborted by learner"；告诉教师，使其对结果的许诺不在课程里无声悬空）。
- `SubagentArtifactData`（`:278-283`）：data-subagent-artifact part 的 payload（glossary 词条 77 制品）——`kind` + `result`（四结果联合）+ `ui? { inverted? }`（学习者钉住的 UI 状态骑记录）。
- `SteerDetails extends SubagentResultMeta`（`:287-294`）：结果 steer 的标记 details——UI 的 meta + 制品一个 payload（投影把它拆成 metadata + data part）。`result`（`:288`）+ `ui?`（`:293`，owner 2026-10-07：反色开关位置持久化，导航离开再回（或重启）保持。**视图偏好——永不进教师上下文，永不导出**（markdown 引擎只读 result））。
- `SteerMessage`（`:314`）= `LhMarkerMessage` 别名——"唤醒流水线可排队投递的任何东西——一个原生标记"。

真实上游：`src/core/view.ts:400-418`（subagent-steer 投影：details 拆为 metadata.subagentResult + data-subagent-artifact part）、`:421-428`（subagent-abort 投影：data-subagent-aborted part）；`components/artifacts/steer-card.tsx:30`；`app/api/chats/[id]/artifact-ui/route.ts:33`（SteerDetails 守卫）；`src/server/jobs.ts:88`（QueuedSteer.steer）、`:175-178`（jobIdOf 从 details.jobId 取 job，probe-handoff 无 job → null）。

### 4.3 导出纯函数与核心内部算法五要素精讲（8 导出 + 2 内部）

#### 4.3.1 `piUsageToStep` `[纯函数]`

**① 完整签名与行号**（`jobs.ts:88-102`）：

```ts
export function piUsageToStep(usage: {
	input: number; output: number; cacheRead: number; cacheWrite: number;
	cacheWrite1h?: number; reasoning?: number;
}): UsageStepLike
```

**② 输入输出与不变量**：输入 pi-ai 的 Usage 形状（input/output/cacheRead/cacheWrite/reasoning?）；输出 SDK 结构的 UsageStepLike。不变量：**结构映射，此处无 pi import**（注释 `:85-87`）——引擎带在它的边界做映射；缺席语义保持：reasoning 未报告 → outputTokenDetails 整体 undefined（不是 {reasoningTokens: 0}）。

**③ 核心逻辑逐步推导**：
1. `inputTokens: usage.input`、`outputTokens: usage.output`（`:97-98`）——直接改名；
2. `inputTokenDetails`（`:99`）：cacheRead/cacheWrite 直传，`cacheWrite1hTokens: usage.cacheWrite1h ?? 0`——**pi 侧缺席显式落零**（与 CallUsage 新原生捕获"显式记零"纪律一致，chat.ts:129-130）；
3. `outputTokenDetails`（`:100`）：`usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : undefined`——三元保缺席。

**④ 边界条件与历史背景**：reasoning=0 与 reasoning=undefined 不同——前者产 {reasoningTokens:0}，后者产 undefined。这是金钱通道"缺席≠零"在引擎边界的第一道闸。对比 `src/agent/subagents/extraction.ts:790-800` 的 callUsage（抽取侧捕获把 reasoning ?? 0 落零）——两条捕获路径对缺席的处理刻意不同，本函数保缺席是因为 JobUsage 的 add 折叠需要区分"从未报告"与"报告为零"。

**⑤ 真实上游调用方**：`src/agent/subagents/runner.ts:7`（import）、`:396`（research 循环 onUsage）、`:445`（demo）、`:481`（visual）、`:520`（pdf）——四 kind 循环的同一接线 `onUsage: (usage) => loop.onUsage(piUsageToStep(usage))`；`tests/pricing-native-parity.test.ts:35`、`:43`（与原生定价对齐）。

#### 4.3.2 `accumulateJobUsage` `[纯函数]`

**① 完整签名与行号**（`jobs.ts:108-137`）：

```ts
export function accumulateJobUsage(
	total: JobUsage | undefined,
	model: string,
	step: UsageStepLike,
): JobUsage
```

**② 输入输出与不变量**：把一次模型调用的用量折叠进运行总和（注释 `:104-107`）。不变量：
- **总和与步骤都没报告的字段保持 undefined**；一旦报告过，后续未报告的调用贡献 0；
- `steps` 是计费计数：每模型调用 +1，**报告与否都计**；
- 不修改输入 total——返回全新对象（纯折叠）；
- 遗留 total 无 calls 数组 → 输出也无（绝不回填）。

**③ 核心逻辑逐步推导**：
1. 局部 `add`（`:113-114`）：`a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)`——双缺席保缺席，单缺席按零加；
2. 构造 `call: CallUsage`（`:115-122`）：从 step 的展平字段与 details 子对象取六字段；
3. 五个运行总和经 add 折叠（`:125-129`）：input/output/cacheRead/cacheWrite/reasoning；
4. **cacheWrite1h 诚实守卫**（`:130-132`）：若 `(total.cacheWriteTokens > 0 且 total.cacheWrite1hTokens undefined)` **或** `(call.cacheWriteTokens > 0 且 call.cacheWrite1hTokens undefined)` → 结果 undefined；否则 add。语义：只要任一有缓存写入的一侧缺 1h 细分，就无法诚实求和 1h 子集——整体落缺席，而不是把未知当零；
5. `steps: (total?.steps ?? 0) + 1`（`:133`）；
6. **calls 条件展开**（`:134`）：`...(!total || total.calls ? { calls: [...(total?.calls ?? []), call] } : {})`——首次折叠（total undefined）开数组；既有数组追加；遗留 total 无 calls → 展开空对象，字段保持缺席（注释 `:61-62`：绝不从累计总和回填）；
7. `lastStep: call`（`:135`）——最近调用永远是本次；`model` 参数盖戳（`:124`）。

**④ 边界条件与历史背景**：
- total undefined（首调用）：所有 add 走"单缺席按零加"分支，结果 = step 值；steps=1；calls=[call]；
- 全缺席 step（provider 什么都不报）：总和不变形（undefined 保持），但 steps 仍 +1、lastStep 仍记录全缺席 call——计费计数与报告解耦；
- 1h 守卫的触发例：旧 total 有 cacheWrite 但无 1h 细分（前 1h 时代日志），新 call 带 1h → 结果 1h undefined（不能把旧写入的未知细分当零）；
- 历史：calls 数组是"当前 catalog 按调用分层定价"需要（`:61-62`）；lastStep 是 2026-09 dock 契约（`:66-71`）；1h 守卫对应 chat.ts:129-131 的 cacheWrite1hTokens 子集语义。

**⑤ 真实上游调用方**：
- `src/agent/subagents/runner.ts:4`（import）、`:150-152`（makeLoopContext.onUsage：`accumulateJobUsage(usageTotals.get(jobId), model, step)` → Map 回写 → `jobStore.updateJob(jobId, { usage: next })` merge patch，状态不动）；
- `tests/jobs.test.ts:340-368`（"sums per model call; fields NO call reported stay undefined"）；
- `tests/pricing-native-parity.test.ts:35`（两次折叠）、`:43`（遗留恢复：`{ ...total, calls: undefined }` 再折叠）；
- `tests/claude-code-usage.test.tsx:25`（CLI job 成本 null）。

#### 4.3.3 `setSteerUiInverted` `[纯函数]`

**① 完整签名与行号**（`jobs.ts:300-311`）：

```ts
export function setSteerUiInverted(
	messages: readonly LhMessage[],
	messageId: string,
	inverted: boolean,
): LhMessage[]
```

**② 输入输出与不变量**：设置一条 steer 消息的 ui.inverted（注释 `:296-299`）。返回**新消息数组**，目标 details 更新；消息缺失或不是可反色制品 steer 时 no-op。**不可变性**：非目标元素保持原引用；目标元素浅拷贝三层（message → details → ui）。这是静默路由的整个身体——无 wake、无 agent、无 token、无 SSE（路由注释 `app/api/chats/[id]/artifact-ui/route.ts:1-10`）。

**③ 核心逻辑逐步推导**（map 逐元素，`:305-310`）：
1. `m.id !== messageId` → 原样返回该元素（`:306`）；
2. details 转 `Partial<SteerDetails> | undefined`（`:307`）；
3. 守卫（`:308`）：`!d || (d.kind !== "demo" && d.kind !== "visual")` → 原样返回——**只有 demo/visual 制品可反色**（research/pdf 无此开关）；
4. 命中（`:309`）：`{ ...m, details: { ...d, ui: { ...d.ui, inverted } } } as LhMessage`——保留 details 其余字段（jobId/kind/toolCallId/result），只覆盖 ui.inverted。

**④ 边界条件与历史背景**：
- 注释说 no-op 时"same array"——严格说 `map` 总返回新数组，no-op 的准确语义是**元素级恒等**（所有元素原引用）；路由在调用前已用 400 挡住非法目标（`artifact-ui/route.ts:32-36` 诚实守卫：目标必须真是 demo/figure steer），所以函数内守卫是防御性第二道；
- `d.ui` 缺席时 `{ ...undefined, inverted }` 合法展开——首次设置创建 ui 对象；
- 历史：owner 2026-10-07 反色开关持久化（SteerDetails.ui 注释 `:289-292`）；视图偏好永不进模型上下文（toLlmMessages 只携 content）、永不导出。
- 测试钉住：`tests/demos.test.tsx:590-591`（on→off 往返）、`:593`（缺失 id no-op）。

**⑤ 真实上游调用方**：
- `app/api/chats/[id]/artifact-ui/route.ts:12`（import）、`:38`（`setSteerUiInverted(chat.messages, input.messageId, input.inverted)` → `:39` saveMessages——记录是唯一移动的状态，客户端已乐观持有切换态，无 refetch 抖动）；
- `tests/demos.test.tsx:572-593`、`tests/artifact-ui.test.ts:5`（纯核心钉在 demos 测试）。

#### 4.3.4 `isSubagentFailure` `[纯函数]`

**① 完整签名与行号**（`jobs.ts:317-335`）：

```ts
export function isSubagentFailure(
	kind: JobKind,
	result: ResearchResult | DemoResult | VisualResult | PdfResult,
): boolean
```

**② 输入输出与不变量**：结果是否失败形状（注释 `:316`：html/svg 空、失败 brief）。它是 worker 终态（done/error）的**唯一判定器**——runner 与崩溃恢复共用，保证两处读法一致。

**③ 核心逻辑与分支逐步推导**：
1. research（`:320-323`）：`r.sources.length === 0 && /^Research failed:/i.test(r.brief)`——**双条件合取**：失败 brief 但带 sources 不算失败（部分成功）；
2. demo（`:324-327`）：`typeof r.html !== "string" || r.html.length === 0`；
3. pdf（`:328-331`）：`/^PDF failed:/i.test(r.brief)`——单条件（与 research 不同：pdf 无 sources 维度）；
4. visual 兜底（`:332-334`）：`typeof r.svg !== "string" || r.svg.length === 0`。

**④ 边界条件与历史背景**：
- research 的合取是刻意设计：`tests/jobs.test.ts:401` 钉住"失败 brief + 非空 sources → false"；
- 大小写不敏感正则（/i）容忍模型措辞抖动；
- pdf 失败形状镜像 research（PdfResult.brief 注释 `:242`）；
- 历史：sources v1 split（2026-09-19）后 pdf 加入；四 kind 判定集中在一个函数，使 runner 的 finishJob 与 server 的 normalizeLegacyResult 不会漂移。

**⑤ 真实上游调用方**：
- `src/agent/subagents/runner.ts:6`、`:319`（finishJob：`failed = isSubagentFailure(job.kind, result)` → `:326-331` 一次 update 写 result + status done/error + activity finished/failed + pending 投递）；
- `src/server/jobs.ts:63`、`:673`（normalizeLegacyResult：遗留 running+result 记录翻成 finished/pending）；
- `components/artifacts/steer-card.tsx:6`、`:47`（research 失败渲染）、`:53`（pdf 失败渲染）；
- `tests/jobs.test.ts:397-405`、`:439-440`、`tests/demos.test.tsx:83`。

#### 4.3.5 `buildSubagentSteer` `[纯函数]`（含内部 `steerText`）

**① 完整签名与行号**（`jobs.ts:368-388`）：

```ts
export function buildSubagentSteer(
	job: Pick<JobRecord, "id" | "kind" | "toolCallId">,
	result: ResearchResult | DemoResult | VisualResult | PdfResult,
): SteerMessage
```

**② 输入输出与不变量**：为完成的 job 构造 steer 标记消息（注释 `:365-367`：纯——runner、唤醒流水线、测试共享）。**每 job 确定性 id 使重投递幂等**。输出是 LhMarkerMessage：content 模型面、details UI 面，两面永不混流。

**③ 核心逻辑逐步推导**（构造字面量，`:372-385`）：
1. `id: `steer_${job.id}``（`:373`）——幂等键；
2. `role: "custom"`（`:374`）、`customType: "subagent-steer"`（`:375`）；
3. `content: steerText(job.kind, result)`（`:376`）——模型面文本由内部纯函数生成（见下）；
4. `display: true`（`:377`）；
5. `details: { jobId, kind, toolCallId, result }`（`:378-383`）——完整制品 payload；
6. `timestamp: Date.now()`（`:384`）。

**内部 `steerText` `[纯函数]`**（`jobs.ts:338-361`，不导出，唯一调用点 `:376`）——steer 的模型面文本：结果**是什么**、拿它**做什么**。8 分支（失败/成功 × 4 kind）：
- 失败 research（`:340-341`）：brief 原文 + "Continue with what you can establish and flag the uncertainty to the learner."；
- 失败 demo（`:342-345`）：`The demo "<title>" could not be built: <notes ?? "unknown reason">. Fall back to explaining in prose; if the brief was the problem, re-call demo with a tighter one.`；
- 失败 pdf（`:346-347`）：brief + "Continue with what you can establish from the session and flag the gap to the learner."；
- 失败 visual（`:348`）：`The figure could not be made: <notes ?? "unknown reason">. Fall back to prose or mermaid, or re-call visual with a tighter brief.`；
- 成功 research（`:350-351`）：`Research complete — the researcher's full brief follows. Weave it into the lesson and cite its sources when you use its findings:\n\n<brief>`；
- 成功 pdf（`:352-353`）：`PDF reading complete — the reader's brief on "<path>" follows, with page citations. Weave it into the lesson and cite pages when you use it:\n\n<brief>`；
- 成功 demo（`:354-357`）：`The demo "<title>" is built, headlessly tested, and rendered in the lesson. Builder notes: <notes ?? "(none)">.\nTeach with it — reference its controls by name and point the learner at what to try.`；
- 成功 visual（`:358-360`）：`The figure is drawn, verified by inspection, and rendered in the lesson. Maker notes: <notes ?? "(none)">.\nReference its elements as you teach.`。

失败分支先经 isSubagentFailure 判定（`:339`）——同一判定器驱动文本与状态。

**④ 边界条件与历史背景**：
- **诚实说明**：注释标"pure"，但 `Date.now()` 使输出时间戳随调用时刻变化——严格参照透明性不成立。**幂等性完全落在确定性 id 上**：steerDelivered 只比 id，时间戳不参与去重；重投递构造的新消息时间戳不同但 id 相同，被记录去重吸收。"pure"在此指无 IO、无共享状态修改、可被 runner/wake/tests 安全共享；
- notes 缺席的两种措辞：失败用 "unknown reason"，成功用 "(none)"——失败必须给模型一个可转述的原因占位；
- 历史：Wave B（2026-09-26）从 UIMessage 时代的 data-part steer 转为原生标记；content/details 双面分工是标记消息教义（native-messages.ts:60-65）的直接应用。

**⑤ 真实上游调用方**：
- `src/agent/subagents/runner.ts:5`、`:334`（finishJob：`void deliver(buildSubagentSteer(job, result)).catch(...)`——存盘后立即排队，不等投递）；
- `src/server/jobs.ts:62`、`:689`（restorePendingDeliveries：崩溃恢复/registration 从存储 result 重建 steer）；
- `tests/jobs.test.ts:323-325`（形状钉住：brief 在 content、制品在 details）、`:409`、`:422-424`（三 kind 失败文本）、`:433-441`（pdf）、`tests/chat-flow.test.ts:442`、`:526`、`tests/job-delivery-recovery.test.ts:55` 等。

#### 4.3.6 `buildAbortSteer` `[纯函数]`（含内部 `abortText`）

**① 完整签名与行号**（`jobs.ts:391-405`）：

```ts
export function buildAbortSteer(
	job: Pick<JobRecord, "id" | "kind" | "toolCallId">,
): SteerMessage
```

**② 输入输出与不变量**：为被中止 job 构造中止 steer（注释 `:389-390`：纯——src/server/jobs.ts 中止路径与测试共享）。**与结果 steer 同一 id 空间——恰好一个投递**（结果与中止互斥：steerDelivered 对两者一视同仁）。

**③ 核心逻辑逐步推导**：
1. `meta = { jobId, kind, toolCallId, aborted: true } as const`（`:394`）；
2. `id: `steer_${job.id}``（`:396`）——与结果 steer 逐字同键；
3. `role: "custom"`、`customType: "subagent-abort"`（`:397-398`）；
4. `content: abortText(job.kind)`（`:399`）；
5. `display: true`、`details: meta`（`:400-401`）——**无 result 字段**（中止没有制品）；
6. `timestamp: Date.now()`（`:402`，同 §4.3.5 的诚实说明）。

**内部 `abortText` `[纯函数]`**（`jobs.ts:408-416`，不导出，唯一调用点 `:399`）——教师读到的一行：结果不会来了、如何致意、允许重新派发。四 kind 分支：
- research（`:409-410`）："Research aborted — the learner aborted the research job, so no brief is coming. Acknowledge it in one line and continue teaching without it (or offer to re-dispatch it)."；
- demo（`:411-412`）："The demo job was aborted by the learner — no demo is coming. Acknowledge it in one line and teach the topic in prose instead (a re-dispatch is fine if the learner wants it)."；
- pdf（`:413-414`）："The PDF reading job was aborted by the learner — no brief is coming. …"；
- visual 兜底（`:415`）："The figure job was aborted by the learner — no figure is coming. …"。

**④ 边界条件与历史背景**：
- 同 id 空间是互斥投递的实现：若结果 steer 已落盘，中止 steer 被 steerDelivered 判为已投递而跳过（反之亦然）——一个 job 的课程里恰好出现一条终局通知；
- 2026-09 中止语义（SubagentResultMeta.aborted 注释 `:270-273`）：学习者中止落为 error "Aborted by learner"；教师被告知，许诺不悬空；
- abortJob 的前置守卫（`src/server/jobs.ts:439-444`）：计算已完成（有 result）则拒绝中止——**排队结果属于会话，不属于可中止的背景 worker**（协议 §3）。

**⑤ 真实上游调用方**：
- `src/server/jobs.ts:61`、`:450`（abortJob：fireJobAbort 杀花费 → updateJob 写 error + pending abort 投递 → `void deliverJobResult(buildAbortSteer(job))`）；
- `src/server/jobs.ts:688`（restorePendingDeliveries：`job.delivery.kind === "abort" ? buildAbortSteer(job) : ...`）；
- `tests/jobs.test.ts:386-388`（"same id space — steerDelivered treats either as delivered"）、`:444`（pdf 中止）、`tests/demos.test.tsx:398`。

#### 4.3.7 `buildProbeHandoffSteer` `[纯函数]`

**① 完整签名与行号**（`jobs.ts:428-430`）：

```ts
export function buildProbeHandoffSteer(chatId: string): SteerMessage
```

**② 输入输出与不变量**：探测→教学交接 steer。薄委托：`return newHandoffMessage(chatId)`——标记工厂住在 `src/core/native-messages.ts:227-237`：`id: `steer_probe_${chatId}``（`:229`）、`customType: "probe-handoff"`（`:231`）、`content: HANDOFF_TEXT`（`:232`，单源自 chat.ts:187）、`display: true`、`details: { chatId }`（`:234`）、timestamp。**每会话确定性 id：恰好一次交接，幂等重投递**。

**③ 核心逻辑**：单行委托。契约侧保留这个名字是为了让 probe 工具面向 contracts 编程（`src/agent/tools/probe.ts:6` import 自 contracts.ts），而标记形状的所有权留在 native-messages（LhMarkerMessage 的家）。节注释（`jobs.ts:418-426`）：probe_done 的 execute 经**同一唤醒流水线**排队它；pump 在探测者回合结束后（gates + grace）发射它。它**不携带制品**——它引用的评估作为 probe_done 工具结果持久在记录中。UI 按 customType 渲染安静系统行。**永不持久化任何像人说的话**。

**④ 边界条件与历史背景**：
- 与 job steer 的关键差异：无 jobId（`src/server/jobs.ts:175-178` jobIdOf 对它返回 null）、无 result payload、id 键是 chatId 而非 jobId；
- 路由差异（`src/server/jobs.ts:27-30` 注释，owner ruling）：probe-handoff 标记**永不走**"交给垂死 run 的 follow-up"路径——交接必须启动**教师的** run，这是只有新鲜 wake 才能做的记录级分支；
- 排队失败可恢复（`src/agent/tools/probe.ts:82-87`）：try/catch 吞掉排队错误仍记录评估——下一条客户端消息会从持久记录缝构造教师；**wake 是优化不是闸门**；
- 历史：probe→teach split（docs/probe-teach-split.md §2），auto-wake 用户裁定。

**⑤ 真实上游调用方**：
- `src/agent/tools/probe.ts:6`（import）、`:81`（`ctx.deliver(buildProbeHandoffSteer(ctx.chatId))`——在两道拒绝闸之后：hasUnresolvedQuestion `:69`、probeConcluded `:77`）；
- `tests/jobs.test.ts:415`（形状）、`:925`、`:943`、`:1185`（投递流水线）。

#### 4.3.8 `steerDelivered` `[纯函数]`

**① 完整签名与行号**（`jobs.ts:435-437`）：

```ts
export function steerDelivered(messages: LhMessage[], steerId: string): boolean
```

**② 输入输出与不变量**：持久记录是否已携带此 steer（注释 `:432-434`）——**任何 steer 种类**的幂等投递判定：每个 steer id 按其事件确定性（job 是 `steer_<jobId>`，交接是 `steer_probe_<chatId>`）。输出布尔；无副作用。

**③ 核心逻辑**：单行 `messages.some((m) => m.id === steerId)`——全记录 id 扫描。O(n) 但 n 是会话消息数，且只在投递/恢复路径调用。

**④ 边界条件与历史背景**：
- **保存的标记才算投递**（协议 §4，`:174-175`）：HTTP 200 或流可见性 alone 不算——所以判定读的是持久记录而非投递回执；
- 结果/中止同 id 空间使本函数天然实现互斥（§4.3.6）；
- 它是"崩溃的 wake 或重复 deliver 被跳过而非重复"（`src/server/jobs.ts:38-39`）的实现核心；
- Wave C 后 idle wake 输入是唯一的 steer 追加者（`src/server/chat-handler.ts:329-332` 注释：claimSteers 已删；run 内投递骑 pi 自己的 follow-up 队列，根本不构造输入事件）。

**⑤ 真实上游调用方**：
- `src/server/chat-handler.ts:64`（import）、`:337`（idle wake 输入过滤：`input.steers.filter((s) => !steerDelivered(record.messages, s.id))`——已落盘的重发射被滤掉）；
- `src/server/jobs.ts:64`、`:691`（restorePendingDeliveries：`if (steerDelivered(record.messages, steer.id)) finalizeSteer(steer); else queueSteer(chatId, steer)`——恢复时已投递的直接确认，未投递的重新排队）；
- `tests/jobs.test.ts:408-418`（任何种类、id 不匹配 false）、`:475`（沙盒 store 过滤）、`tests/sandtable.test.ts:90`。

### 4.4 轻量辅助函数归并说明

- `steerText`（`:338-361`）与 `abortText`（`:408-416`）：两个模块私有纯函数，已在 §4.3.5 / §4.3.6 按五要素完整拆解（各 8/4 分支）。它们不导出——模型面文本的生成细节封在契约内，外部只见构造器。
- 至此 jobs.ts 全部 10 个运行时函数（8 导出 + 2 内部）零遗漏。

---

## 5. `src/core/contracts/probe.ts`（94 行）——探测评估契约与 TypeBox 单源 schema

### 5.1 模块定位与纯度边界

- **契约所有权**：探测域（probe→teach split，docs/probe-teach-split.md）。文件头（`probe.ts:1-16`）：探测者（glossary 词条 29）以 probe_done 结束阶段——server 侧工具，其**输入是学习者评估**（模型 authored、流式给学习者、经工具调用参数持久）。持久记录中第一个 probe_done 是探测→计划缝：从那个点起构造教师 agent；工具 execute 经唤醒流水线排队交接 steer，使教师在探测者回合结束后立即启动（auto-wake，用户裁定）。评估形状 v1：探测是每依赖 strand 的二分搜索；评估恰好形式化它。
- **桶导出**：`contracts.ts:17` → core 桶。
- **纯度**：`:18` 运行时 import `{ Type, type Static } from "typebox"`——浏览器安全 schema 构造器。schema 对象是运行时值；锁函数是恒等函数。

### 5.2 核心数据结构、常量与 Schema 契约逐项精讲

#### 5.2.1 评估形状三接口（`probe.ts:21-39`）

- `ProbeStrand`（`:21-27`）：一条课程将依赖的依赖 strand（glossary 词条 40）。`strand`（`:23`，名称/描述，如 "the derivative as a limit"）+ `assessment`（`:26`，自由形式：学习者边缘（glossary 词条 41）在这条 strand 上的位置——下限 floor、上限 ceiling、发现的误解、从哪里建起）。
- `ProbeAssessment`（`:30-34`）：探测者对学习者的读数。`strands: ProbeStrand[]`（`:31`）+ `summary?`（`:33`，可选总体综合：表观目标与边缘）。
- `ProbeDoneInput`（`:37-39`）：probe_done 工具输入 = `{ assessment: ProbeAssessment }`。

`ProbeStrand` / `ProbeAssessment` 两个标识符在契约外零直接引用（rg 核实）——消费者经 `ProbeDoneInput["assessment"]` 结构访问：`components/artifacts/probe-done-card.tsx:40-41`（`input?.assessment` → `assessment.strands`）。

#### 5.2.2 `probeDoneInputSchema`（`probe.ts:47-72`）——TypeBox 单源 schema

注释（`:41-46`）是全卷最重要的边界契约声明之一：**单源事实**——工具（src/agent/tools/probe.ts）与 UI 解析缝（src/core/tool-parts.ts）**共同生活**于同一 schema：边界校验与消费者解析跑**字面同一个** schema，所以"边界处 schema-valid ⇔ 消费者可解析"是**结构性的，不是约定**。历史起因（live crash 2026-09-12）：模型把 `assessment` 发成**字符串**；卡片直接 cast 然后死在 `.strands.map`。

构造逐项：
- `Type.Object({ assessment: Type.Object({...}) })`（`:47-48`）；
- `strands: Type.Array(Type.Object({ strand: Type.String({description}), assessment: Type.String({description}) }), { minItems: 1, description })`（`:50-62`）——**minItems: 1**：至少一条 strand；两个 description 直接教模型写什么（strand 是"计划可以挂节点的名字"；assessment 是"下限/上限/误解/从哪里建"）；
- `summary: Type.Optional(Type.String({description}))`（`:64-68`）。

注意 description 是 schema 的一部分——它随工具声明进入模型上下文，是提示词工程的契约化。

真实上游（同一 schema 的两条命）：
- **边界命**：`src/agent/tools/probe.ts:3`（import）、`:64`（`parameters: probeDoneInputSchema`——工具声明）、`:65`（`serverExecute("probe_done", probeDoneInputSchema, ...)`——`src/agent/tool-execute.ts:198-211` 的 execute 包装，pi 循环已按 schema 运行时校验参数）；
- **消费命**：`src/core/tool-parts.ts:34`（import）、`:128-130`（`parseProbeDoneInput = boundaryParse<ProbeDoneInput>(probeDoneInputSchema, input)`——`:45-51` boundaryParse：structuredClone → Value.Convert → Value.Check → Value.Clean）。**注意**：与 quiz/ask/explain 的解析不同，probe_done 解析**没有**参数修复（heal，glossary 词条 12）前置步——它直接 boundaryParse；
- **UI 落地**：`components/artifacts/probe-done-card.tsx:35`（parse, don't cast——模型 authored 的输入只有同一 schema 说可信才可信；output-error part 的输入被校验**拒绝**过、可以是任何形状，绝不渲染；output 保持 cast 因为那是**我们的** execute authored 的）；
- `tests/tool-parts.test.ts:152`（Value.Check 钉住）。

#### 5.2.3 `ProbeDoneResult`（`probe.ts:80-84`）与 `PROBE_DONE_ACK_TEXT`（`:93-94`）

`ProbeDoneResult`：`ok: boolean`（`:81`）+ `error?`（`:83`，ok===false 时的拒绝原因：开放问题、已收尾）。

`PROBE_DONE_ACK_TEXT`——probe_done ack 的模型面文本（owner，context diet 2026-10-09，注释 `:86-92`）：评估是**调用的参数**——持久、流式给学习者——所以在结果里回声它会在每个未来上下文里重复探测阶段最大的 payload。agent 改看这段固定行；`details` 只携带 {ok:true} 供记录/UI。**与 CONCLUDE_ACK_TEXT 同一教义**。文本原文：

```text
Assessment recorded — it is shown to the learner now and the teacher plans from it. Say your closing sentence and end your turn; the teaching phase takes over from here.
```

真实上游：`src/agent/tools/probe.ts:3`、`:93`（execute 返回 `{ text: PROBE_DONE_ACK_TEXT, details: { ok: true } }`；`:40-43`、`:89-91` 注释重申 context-slim）。拒绝路径（`:67-78`）：记录不存在 → error；`hasUnresolvedQuestion`（`src/core/native-messages.ts:746`）→ "A question is still open…"；`probeConcluded`（`src/agent/tools/probe.ts:21`）→ "already concluded — fires exactly once"。

### 5.3 导出纯函数五要素精讲（1 个：编译期锁）

#### 5.3.1 `probeDoneSchemaLock` `[纯函数]`（编译期 schema↔interface 锁）

**① 完整签名与行号**（`probe.ts:77`）：

```ts
export const probeDoneSchemaLock = (v: Static<typeof probeDoneInputSchema>): ProbeDoneInput => v
```

**② 输入输出与不变量**：恒等函数——输入输出同值。它的**真正产物是编译期断言**：注释（`:74-76`）——旧 `satisfies z.ZodType` 保证的替代：声明与 ProbeDoneInput 永不漂移——**只有当 schema 的静态形状就是该接口时这才编译通过**。

**③ 核心逻辑**：函数体 `=> v` 零计算。类型签名是全部：`Static<typeof probeDoneInputSchema>`（TypeBox 推断的静态类型）必须可赋值给 `ProbeDoneInput`（手写接口）。任何一方改字段而另一方没跟上 → 编译错误。

**④ 边界条件与历史背景**：这是 zod→TypeBox 迁移的遗产——zod 时代用 `satisfies z.ZodType<ProbeDoneInput>` 锁形状；TypeBox 的 Static 推断方向相反，改用恒等函数赋值锁。**运行时零调用方**（rg 全仓核实：除定义外无任何引用）——它经桶导出但从不被调用；调用它毫无意义，价值全在类型检查。讲解时应把它归类为"以函数形态存在的编译期契约"，而非运行时算法。

**⑤ 真实上游调用方**：无运行时调用方（这是设计使然）。"调用方"是 TypeScript 编译器本身——每次 `tsc` 经过 `probe.ts:77` 都在执行这把锁。经 `contracts.ts:17` 导出保持可见。

### 5.4 轻量辅助函数归并说明

无内部函数。`probeDoneInputSchema` 是 TypeBox 构造器产出的运行时**常量**（schema 对象），已在 §5.2.2 按 schema 契约精讲；本文件运行时导出合计：1 schema 常量 + 1 文本常量 + 1 锁函数。

---

## 6. `src/core/contracts/models.ts`（83 行）——模型目录的客户端安全形状

### 6.1 模块定位与纯度边界

- **契约所有权**：模型控制域（model-control wave 2026-09-12）。文件头（`models.ts:1-7`）关键所有权声明：GET /api/models 与 PUT /api/chats/[id]/settings 响应的客户端安全形状；**server 投影住在 src/server/model-catalog.ts，它拥有这些形状**——契约定义在这里只是为了客户端组件永不 import server 带。这是"形状在 core、实现所有权在 server"的刻意分裂。
- **桶导出**：`contracts.ts:18` → core 桶。
- **纯度**：`:8-9` 仅类型 import（ThinkingLevel；BackgroundModelRole/ModelSlotName/ModelSlot 来自 ../settings.ts）。**纯类型文件，零运行时导出**。

### 6.2 核心数据结构逐项精讲

#### 6.2.1 `ModelCatalogEntry`（`models.ts:14-31`）——一个选择器行

从 pi-ai catalog 投影的模型全部 UI 信息。成本单位 USD/1M token（与 Pi server 侧定价计算器同一 catalog 同一单位）。

- `id` / `name` / `provider`（`:15-17`）；`reasoning: boolean`（`:18`）；`input: ("text"|"image")[]`（`:19`，模态）；
- `supportedLevels: ThinkingLevel[]`（`:23`）——模型**实际接受**的思考级别（pi 的 thinkingLevelMap，如 GLM-5.3-flash: low|high|max）。注释：思考选择器恰好列这些；**其他任何级别都是谎言**；
- `cost: { input; output; cacheRead; cacheWrite } | null`（`:25`）——LearnHarness 无法为此连接估价时 null（诚实缺席）；
- `contextWindow: number | null`（`:27`）——原生 CLI 别名为 null（有效上限是会话特定的）；`maxTokens: number | null`（`:28`）。

#### 6.2.2 `CatalogDefaults`（`models.ts:35-40`）——会话 agent 的解析默认

BYOK（glossary 词条 98 自带密钥），owner 2026-09-22：chat 的模型覆盖 over **STRONG 槽**——一个控制器，所以一个默认。`model: { provider; id }`（`:36`）+ `thinkingLevel?`（`:37`，未设时从烘焙的 DEFAULT_THINKING_ORDER 在引擎构建时解析）。

#### 6.2.3 `RolePins`（`models.ts:44-48`）与 `SlotPins`（`:52`）——解析钉

- `RolePins = Record<BackgroundModelRole, { model; thinkingLevel? } | null>`——一个背景角色的**解析**钉（BYOK 2026-09-22）：该角色今天实际跑什么——角色覆盖 → 层槽 → **什么都没有**。**NULL = 角色链为空**（按需闸门拒绝其工作）；设置 UI 从中显示 "not configured"。
- `SlotPins = Record<ModelSlotName, (ModelSlot & { model }) | null>`——一个槽层的解析钉：NULL = 该层无模型。设置 UI 用它注每个槽行，选择器从它预填。

#### 6.2.4 `ModelCatalogResponse`（`models.ts:55-75`）与 `CatalogProvider`（`:78-83`）

GET /api/models 响应五字段：
- `models: ModelCatalogEntry[]`（`:56`）；
- `defaults: CatalogDefaults | null`（`:60`）——**会话链为空时 NULL**（无工厂地板；回合闸门以 503 models_not_configured 拒绝——universal_turn_gate，glossary 词条 28）；
- `rolePins: RolePins`（`:64`）——六个背景角色的解析钉（与 agent 工厂同一解析——src/server/stores.ts effectiveSettings）；每角色 NULL = 链空；
- `slots: SlotPins`（`:68`）——三个槽层：角色覆盖 → 槽层粒度；effectiveSettings().models 逐字，每未设层 NULL；
- `providers: CatalogProvider[]`（`:74`）——**密钥在场**的 provider 及各自门控 env var（model slots wave 联邦表面 2026-09-20）：选择器只列这些 provider 的 pi-ai catalog 模型。**无密钥 provider 直接缺席**（Keys 页是发现表面，与搜索引擎同一纪律）。

`CatalogProvider`：`id`（`:79`）、`envVar`（`:81`，门控 env var；订阅与文件配置路由为空）、`keyPresent: boolean`（`:83`，凭据在场且自定义引用可解析）。

**安全边界**：整个文件只有 `keyPresent` 布尔——**密钥材料永不进入契约**；成本 null 是诚实缺席而非零。

### 6.3 导出纯函数与核心内部算法五要素精讲

**无函数、无常量。** 本文件是纯类型契约。

### 6.4 轻量辅助归并与真实上游

真实上游（投影所有者与消费者）：
- `src/server/model-catalog.ts:44-49`（import 五类型）、`:65`（`export type ModelDto = ModelCatalogEntry`——server 侧别名）、`:81`/`:93`（catalogDefaults）、`:103-104`/`:121`（catalogRolePins）、`:129-131`（catalogSlots）、`:149`（catalogProviders）、`:171`（keyPresent 过滤）、`:182`（supportedLevels: getSupportedThinkingLevels(model)）、`:233`（providers 装配）；
- `app/api/models/route.ts:11`（`Response.json(modelCatalog())`，no-store）；
- `components/model-catalog.ts:9`（catalogCache）、`:24`（fetch 解析）、`:34`（useModelCatalog）；
- `components/model-picker.tsx:4`、`components/setup-dialog.tsx:43`、`:87`（ModelSelection = Pick<ModelCatalogEntry, "provider"|"id">）、`components/setup-cta.tsx:42`（savedSlotsConfigured）。

---

## 7. `src/core/contracts/subscriptions.ts`（68 行）——原生订阅连接契约

### 7.1 模块定位与纯度边界

- **契约所有权**：订阅连接域（GitHub Copilot / xAI 原生 SDK 订阅）。
- **桶导出**：**不进 contracts.ts 域桶**；由 `core/index.ts:60`（NATIVE_SUBSCRIPTIONS 运行时值）与 `:61`（8 类型仅类型）选择性再导出。
- **纯度**：`:1` 仅类型 import `{ Api, Model } from "@earendil-works/pi-ai"`。唯一运行时值是 `as const` 描述符数组。
- **安全边界（文件级）**：凭据与 OAuth 事务数据绝不进入契约——`SubscriptionInteraction` 注释（`:20`）："只有公开设备 user code，绝无私有 device_code 或 token"。

### 7.2 核心数据结构与常量逐项精讲

#### 7.2.1 双 id 体系与 `NATIVE_SUBSCRIPTIONS`（`subscriptions.ts:4-10`）

- `NativeSubscriptionProviderId`（`:4`）= `"github-copilot" | "xai"`——**原生 SDK id**；
- `NativeSubscriptionLogicalId`（`:5`）= `"github-copilot-subscription" | "xai-subscription"`——应用持久化连接路由的逻辑 id。注释（`:3`）：两者刻意保持不同。
- `NATIVE_SUBSCRIPTIONS`（`:7-10`，`as const`）：两条描述符 `{ providerId, logicalId, label }`——label 分别是 "GitHub Copilot" 与 "Grok"。这是双 id 映射的**唯一事实表**。

真实上游：`src/agent/subscription-bridge.ts:17`（logicalId→providerId 反查）、`:33`（快照准入：providerId 必须在表内）、`:43`（描述符）、`:107`（scope 构造取 logicalId）；`src/agent/subscription-stream.ts:10`（标签）；`src/agent/background-capture.ts:146`（preparedPayloadProviders 集合）；`src/server/web-subscription-http.ts:50`（POST 命令的 providerId 白名单校验）；`components/settings/subscription-connections.tsx:28`、`:38`、`:123`、`:134`（渲染循环）、`:137`；`tests/subscription-background.test.ts:24-25`、`:40`。

#### 7.2.2 设备流交互：`SubscriptionPrompt`（`:12-18`）与 `SubscriptionInteraction`（`:21-27`）

- `SubscriptionPrompt`：`id`、`type: "text" | "secret" | "select" | "manual_code"`（`:14`——四种提示类型，secret 用于敏感输入）、`message`、`placeholder?`、`options?: readonly { id; label; description? }[]`。
- `SubscriptionInteraction`：`attemptId`（`:22`）、`prompt?`、`browser? { id; url }`（`:24`）、`userCode?`（`:25`——**公开**设备用户码）、`progress?`。安全注释（`:20`）：私有 device_code 与 token 永不出现。

#### 7.2.3 `NativeSubscriptionStatus`（`:29-42`）——每 provider 状态

`providerId`、`available`（SDK 可用）、`connected`、`pending`（登录在飞）、`committing?`、`allowBackgroundUse`（背景使用同意——独立于连接态）、`connectionId: string | null`、**三个修订号**：`epoch` / `authorityRevision` / `revision`（`:37-39`）、`error?`、`interaction?`。

三修订号是租约围栏：`src/agent/subscription-bridge.ts:33` 准入时要求三者都是安全非负整数；`NativeSubscriptionScope` 携带它们做陈旧租约判定（`subscriptionScopeCurrent`，`:111`）。

#### 7.2.4 `NativeSubscriptionSnapshot`（`:45-48`）、`NativeSubscriptionScope`（`:50-56`）、`NativeSubscriptionControlBridge`（`:58-68`）

- `Snapshot`：`statuses: NativeSubscriptionStatus[]` + `models: Partial<Record<NativeSubscriptionProviderId, Model<Api>[]>>`。注释（`:44`）：私有继承 IPC 也携带安全的、SDK 支持的 catalog 元数据。
- `Scope`：`providerId` + `connectionId` + `epoch` + `authorityRevision` + `selectedModelId`——租约/准入的作用域围栏（`src/agent/subscription-bridge.ts:105-123`：subscriptionScope / subscriptionScopeCurrent / subscriptionAdmissionScope / subscriptionLease）。
- `ControlBridge`：Promise 化控制面——`status()` / `login(providerId, enabled?)` / `cancel` / `respond(providerId, attemptId, promptId, value)`（设备流答复）/ `open(providerId, attemptId, actionId)`（打开浏览器动作）/ `retry` / `disconnect` / `consent(providerId, enabled)` / `onChange(listener): () => void`（返回退订函数）。

真实上游：`src/agent/subscription-bridge.ts:3`、`:29`（accept 快照）、`:96`（nativeSubscriptionStatus）；`src/server/web-subscriptions.ts:14`；`components/settings/subscription-client.ts:4`、`:15`（fetch `{ chatgpt, native }`）、`:57`（createWebNativeBridge——把 HTTP 命令面适配成桥接口）、`:74`（useNativeSubscriptionBridge）；`components/sidebar.tsx:72`。

### 7.3 导出纯函数与核心内部算法五要素精讲

**无函数。** 唯一运行时值 NATIVE_SUBSCRIPTIONS 是静态描述符表（§7.2.1）。

### 7.4 轻量辅助归并说明

无内部辅助。8 类型 + 1 常量全部导出（经 core/index.ts:60-61 点名）。

---

## 8. `src/core/contracts/chatgpt.ts`（27 行）——ChatGPT 连接的客户端安全状态

### 8.1 模块定位与纯度边界

- **契约所有权**：ChatGPT 连接域。文件第一行注释（`chatgpt.ts:1`）即安全宪法：**仅客户端安全状态。凭据与 OAuth 事务数据绝不进入此契约。**
- **桶导出**：不进域桶；`core/index.ts:59` **仅类型**再导出（本文件无任何运行时值）。
- **纯度**：零 import。私有数据（token、OAuth 事务）由 agent 带的桥（`src/agent/chatgpt-bridge.ts`）拥有，契约只暴露投影后的安全形状。

### 8.2 核心数据结构逐项精讲

#### 8.2.1 `ChatGPTStatus`（`chatgpt.ts:2-16`）

- `available` / `pending`（`:3-4`）；
- `allowBackgroundUse`（`:6`）——**应用级** ChatGPT 背景许可，独立于账号选择；
- `activeId: string | null`（`:7`）；
- `accounts`（`:8-13`）：`{ id; email; registration; connected; planEnabled?; canSignInAgain? }`。`canSignInAgain`（`:12`）注释：main 拥有的授权恢复资格。**缺失意为未知，不是有资格**；存储失败、暂停/关闭的连接、健康授权都为 false；
- `error: string | null`（`:14`）、`catalogError?: string | null`（`:15`）。

#### 8.2.2 `ChatGPTControlBridge`（`chatgpt.ts:17-27`）

`status()` / `login(id?)` / `cancel()` / `select(id)` / `disconnect(id)`（`:23` 注释：**显式遗忘此已验证身份的每个本地注册/凭据**）/ `logout(id)` / `consent(enabled)` / `onChange(callback): () => void`。与 native 桥不同：每个控制方法返回 `Promise<ChatGPTStatus>`（操作后状态直接随响应回来），且 select/disconnect/logout 按账号 id 操作（多账号）。

真实上游：`src/agent/chatgpt-bridge.ts:3`、`:5`（再导出）、`:7`、`:12`、`:16`（unavailable() 工厂：available:false / allowBackgroundUse:true / accounts:[]）、`:31`（IPC 消息形状）；`components/settings/subscription-client.ts:4`、`:46`（createWebChatGPTBridge）、`:70`（useChatGPTBridge）；`components/sidebar.tsx:71`；HTTP 面 `src/server/web-subscription-http.ts:25-56`（subscriptionControlsResponse：同源守卫、16KB 命令上限、op 白名单——chatgpt 允许 login/cancel/select/disconnect/logout/consent）。

### 8.3 导出纯函数与核心内部算法五要素精讲

**无函数、无常量。** 纯类型契约（2 接口）。

### 8.4 轻量辅助归并说明

无。

---

## 9. `src/core/contracts/claude-code.ts`（12 行）——Claude Code CLI 安装契约

### 9.1 模块定位与纯度边界

- **契约所有权**：Claude Code CLI 连接域。全文件 12 行，是九文件中最小的。
- **桶导出**：不进域桶；`core/index.ts:63` 再导出两常量 + 类型。
- **纯度**：零 import。
- **安全/诚实边界**：`ClaudeCodeStatus` 注释（`claude-code.ts:3`）：**仅安装/版本。绝非认证、配额或计费裁决。** 计费由 Claude Code 自己的配置决定（`components/settings/model-menu.tsx:88` 的 tooltip 原文）。

### 9.2 核心数据结构与常量逐项精讲

#### 9.2.1 `CLAUDE_CODE_PROVIDER`（`claude-code.ts:1`）

`= "claude-code"`——provider id 常量。它是 CLI 计费识别的键：`src/core/native-messages.ts:39`（import）、`:110`（cliContextWindowOf：只有 provider === CLAUDE_CODE_PROVIDER 且 tokens 为正安全整数时才认 CLI 报告的有效上下文预算——**CLI 报告的有效预算，不是 catalog 模型上限**，LhMessage.cliContextWindow 注释）；`components/stats-bar.tsx:18`、`:113`、`:168`、`:204`（`model.startsWith("claude-code:")` → CLI 计费标签）；`components/settings/model-menu.tsx:88-89`（"CLI billing"）。

**双路径单源**：`src/agent/claude-code/constants.ts:1` 是 `export { CLAUDE_CODE_PROVIDER } from "../../core/contracts/claude-code.ts"`——agent 带的别名再导出，不是第二定义。`src/agent/teacher-agent.ts:21` 经 agent 别名 import，`src/core/native-messages.ts:39` 经契约直接 import——同一常量两条路径。

#### 9.2.2 `ClaudeCodeStatus`（`claude-code.ts:4-8`）

- `state: "not-found" | "meets-minimum" | "update-required" | "version-unchecked"`（`:5`）——四态安装判定；
- `version: string | null`（`:6`）、`minimumVersion: string`（`:7`）。

#### 9.2.3 `CLAUDE_CODE_MINIMUM_VERSION`（`claude-code.ts:12`）

`= "2.1.259"`。注释（`:10-11`）：`--permission-prompts none` 在 2.1.259 加入。**这不是 claudecode/toolUseId 的官方最低版本/稳定性契约；准入 fail closed**（宁可拒绝也不冒险）。

真实上游：`src/agent/claude-code/installation.ts:4`（import）、`:21`（base.minimumVersion）、`:31`（`CLAUDE_CODE_MINIMUM_VERSION.split(".").map(Number)` 逐段数值比较）；`src/server/claude-code.ts:14-31`（claudeCodeInstallationResponse：同源 + 专用头 + sec-fetch-site 守卫，仅 GET，绝不读认证状态或发模型请求——`app/api/claude-code/route.ts:3` 注释）；`components/settings/claude-code-status.tsx:3`、`:86`（缓存失效比较 minimumVersion）、`:113`（"Requires v{...}+" 文案）。

### 9.3 导出纯函数与核心内部算法五要素精讲

**无函数。** 两常量一类型。

### 9.4 轻量辅助归并说明

无。

---

## 10. 跨文件汇总

### 10.1 全部运行时函数清单（13 导出 + 2 内部，零遗漏）

| # | 函数 | 文件:行 | 标签 | 一句话职责 | 关键上游 |
|---|---|---|---|---|---|
| 1 | `derivedNodeStatus` | plan.ts:76 | 纯函数 | 三词状态渲染优先级（current > visited > upcoming） | plan-block.tsx:757、plan-window.tsx:52、compaction.ts:354 |
| 2 | `derivePlanStatuses` | plan.ts:82 | 纯函数 | 视图侧折叠：从 quiz/explain 调用派生计划位置 | plan-block.tsx:754、plan-window.tsx:48 |
| 3 | `derivePlanStatusesLh` | plan.ts:132 | 纯函数 | 原生侧同构折叠（LhMessage[]） | compaction.ts:350、plan-blocks.ts:38 |
| 4 | `titleFromPrompt` | graph.ts:368 | 纯函数 | 首消息智能截断标题（≤72+…） | app/api/chats/route.ts:28 |
| 5 | `piUsageToStep` | jobs.ts:88 | 纯函数 | pi Usage → SDK 结构步骤（保缺席） | runner.ts:396/445/481/520 |
| 6 | `accumulateJobUsage` | jobs.ts:108 | 纯函数 | 运行用量折叠（缺席≠零、1h 诚实守卫、calls 不回填） | runner.ts:150 |
| 7 | `setSteerUiInverted` | jobs.ts:300 | 纯函数 | 反色开关持久化（不可变 map） | artifact-ui/route.ts:38 |
| 8 | `isSubagentFailure` | jobs.ts:317 | 纯函数 | 四 kind 失败形状唯一判定器 | runner.ts:319、server/jobs.ts:673、steer-card.tsx:47/53 |
| 9 | `buildSubagentSteer` | jobs.ts:368 | 纯函数* | 结果 steer 标记（steer_<jobId> 幂等键） | runner.ts:334、server/jobs.ts:689 |
| 10 | `buildAbortSteer` | jobs.ts:391 | 纯函数* | 中止 steer（同 id 空间，互斥投递） | server/jobs.ts:450/688 |
| 11 | `buildProbeHandoffSteer` | jobs.ts:428 | 纯函数* | 交接 steer 薄委托（steer_probe_<chatId>） | agent/tools/probe.ts:81 |
| 12 | `steerDelivered` | jobs.ts:435 | 纯函数 | 记录 id 扫描 = 投递幂等判定 | chat-handler.ts:337、server/jobs.ts:691 |
| 13 | `probeDoneSchemaLock` | probe.ts:77 | 纯函数（编译期锁） | schema↔interface 恒等锁，零运行时调用 | tsc 本身 |
| 14 | `steerText`（内部） | jobs.ts:338 | 纯函数 | 结果 steer 模型面文本 8 分支 | buildSubagentSteer:376 |
| 15 | `abortText`（内部） | jobs.ts:408 | 纯函数 | 中止 steer 模型面文本 4 分支 | buildAbortSteer:399 |

\* 三个构造器内含 `Date.now()` 时间戳：无 IO、无共享状态修改，但非严格参照透明；幂等性完全落在确定性 id 上（§4.3.5 ④）。

另有运行时**常量构造器** `probeDoneInputSchema`（probe.ts:47，TypeBox schema 对象，§5.2.2）。

### 10.2 规范文本常量单源表（marker law）

| 常量 | 定义 | 唯一消费缝 | 模型看到它的时机 |
|---|---|---|---|
| `HANDOFF_TEXT` | chat.ts:187 | native-messages.ts:232（newHandoffMessage） | 探测→教学交接唤醒回合 |
| `THINKING_LABEL` | chat.ts:204 | native-messages.ts:321（newThinkingMessage） | 练习思考提交 |
| `CONCLUDE_ACK_TEXT` | chat.ts:213 | tool-execute.ts:275 + native-messages.ts:407 | 练习题收尾（执行/丢弃两路同文） |
| `NEXT_PROBLEM_TEXT` | chat.ts:220 | native-messages.ts:339（newNextMessage） | 学习者明确放行下一题 |
| `COMPACTED_HISTORY_HEADER` | chat.ts:230 | compaction.ts:268（newCompactionMarker） | 上下文压缩后的每个后续上下文 |
| `PROBE_DONE_ACK_TEXT` | probe.ts:93 | agent/tools/probe.ts:93 | probe_done 成功 ack |
| `steerText`/`abortText`（函数） | jobs.ts:338/408 | buildSubagentSteer/buildAbortSteer | 后台任务结果/中止送达 |

### 10.3 确定性 id / 幂等键表

| 键 | 形状 | 定义点 | 去重机制 |
|---|---|---|---|
| 结果/中止 steer | `steer_<jobId>` | jobs.ts:373/396 | steerDelivered（jobs.ts:435） |
| 交接 steer | `steer_probe_<chatId>` | native-messages.ts:229 | 同上 |
| 回合计费 | `TurnUsage.id`（每请求） | chat.ts:145 | appendTurnUsage some 检查（store/chats.ts:141） |
| 抽取计费 | `ExtractionRunUsage.startedAt` | chat.ts:102 | appendExtractionUsage some（store/chats.ts:153）/ appendSourceUsage |
| 笔记源 | `src_` + 路径哈希 | graph.ts:94 注释 | 映射按 id 去重 |
| 链身份 | (排序 premises, conclusion) | core/graph.ts:92（契约外） | chains.jsonl 读时归并，首行 arg_ id 为准 |
| 计划块 | planCallId | native-messages.ts:242 注释 | emittedPlanBlockCalls（plan-blocks.ts:54） |

### 10.4 "派生永不存储"对照表

| 派生量 | 契约声明 | 派生函数（契约内/外） |
|---|---|---|
| 计划节点状态 | plan.ts:36-43 | derivePlanStatuses / derivePlanStatusesLh / derivedNodeStatus（契约内） |
| 图的边/逻辑箭头/impLinks | graph.ts:24-32、:311-323 | core/graph.ts graphSnapshot（契约外） |
| 簇 | graph.ts:336-342 | core/session-clusters.ts birthSessionPartition（契约外） |
| 覆盖度"未覆盖"侧 | graph.ts:158-164 | core/coverage.ts（契约外） |
| 会话 phase / pendingQuestion | chat.ts:249-258 | core/phases.ts phaseAt3、store listChats（契约外） |
| busy / compacting | chat.ts:280-294 | 路由合并活性 registry（契约外，绝非记录派生） |
| 成本 | chat.ts:136-139 | core/prices.ts 读时推断（契约外） |

### 10.5 版本戳双轨

| 轨 | 常量 | 载体 | 写侧 | 读侧 |
|---|---|---|---|---|
| 会话记录 | CURRENT_CHAT_VERSION=1（chat.ts:64） | 记录内 `version` 字段 | writeChat 每次盖戳（store/chats.ts:58） | getChat 拒新（store/chats.ts:72-74，返回 null） |
| 图家族 | CURRENT_GRAPH_FORMAT_VERSION=1（graph.ts:123） | format.json sidecar | ensureGraphFormat 首写 lazy（store/graph-format.ts:56-60） | assertGraphFormat 拒新（:44-52，throw） |

两轨同一 lazy v1 教义（缺席读作 v1、拒读更新戳），差异在拒绝形态（null vs throw）与载体（字段 vs sidecar）。

---

## 附：本卷取证覆盖核对

- 9 个契约文件逐行精读：chat.ts 322/322、plan.ts 149/149、graph.ts 385/385、jobs.ts 438/438、probe.ts 94/94、models.ts 83/83、subscriptions.ts 68/68、chatgpt.ts 27/27、claude-code.ts 12/12。
- 全部 15 个运行时函数（13 导出 + 2 内部）按五要素拆解；全部 6 个文本常量、2 个版本常量、2 个 CLI 常量、1 个订阅描述符表、1 个 TypeBox schema 逐项精讲并附真实调用点。
- 全部导出类型（约 70 个接口/类型别名）逐一给出定义行号、字段语义与至少一个真实上游；零直接引用的类型（ChatKind、JobStatus、ExtractedProposition、IdentityLink、NamingRunStats、ProbeStrand、ProbeAssessment、DerivedPlanStatuses 的外部引用形态）均经 rg 核实并如实注记其结构消费方式或休眠状态。
- 简报举例名与真实代码的差异（buildSubagentAbortSteer / steerMarkerId / chainArgumentId）已在卷首勘误并按真实名字讲解。
