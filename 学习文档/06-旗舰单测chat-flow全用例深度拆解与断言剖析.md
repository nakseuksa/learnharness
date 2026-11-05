# 06 - 旗舰单测 chat-flow 41个用例深度拆解与断言剖析

> **文档定位**：本文档针对 `learnharness` 体系中最核心、分量最重、代码量最大（1,745 行）的旗舰单测文件——[tests/chat-flow.test.ts](file:///d:/0.default/learnharness/tests/chat-flow.test.ts) 进行全面深度拆解。逐一剖析其包含的全部 **41 个测试用例（Test Cases）** 的**测试目的、业务场景用途与断言逻辑（Why Assert What it Asserts）**，帮助开发者从“单测反推”的最高维度彻底吃透整个对话引擎的运行时机制。

---

## 目录索引

- [一、 为什么 `chat-flow.test.ts` 是系统的生命线？](#一-为什么-chat-flowtestts-是系统的生命线)
  - [1.1 仿真大模型（`scriptedEngine`）与测试架构](#11-仿真大模型scriptedengine与测试架构)
  - [1.2 41 个用例所属的 12 大功能模块总览](#12-41-个用例所属的-12-大功能模块总览)
- [二、 41 个测试用例逐一深度拆解](#二-41-个测试用例逐一深度拆解)
  - [模块 1：教学主流程与出题作答闭环 (Case 1 ~ 4)](#模块-1教学主流程与出题作答闭环-case-1--4)
  - [模块 2：运行中纸条引导与原子对防撞 (Case 5 ~ 6)](#模块-2运行中纸条引导与原子对防撞-case-5--6)
  - [模块 3：视图投影规范与思考过程折叠 (Case 7 ~ 8)](#模块-3视图投影规范与思考过程折叠-case-7--8)
  - [模块 4：健壮性、题目自愈与模型自我纠错 (Case 9 ~ 12)](#模块-4健壮性题目自愈与模型自我纠错-case-9--12)
  - [模块 5：仓储持久化与读写故障隔离 (Case 13 ~ 17)](#模块-5仓储持久化与读写故障隔离-case-13--17)
  - [模块 6：并发排他锁（409）与预写日志 WAL (Case 18 ~ 19)](#模块-6并发排他锁409与预写日志-wal-case-18--19)
  - [模块 7：会话重命名与侧边栏排序防跳 (Case 20 ~ 21)](#模块-7会话重命名与侧边栏排序防跳-case-20--21)
  - [模块 8：模型槽位与 API Key 门禁 (Case 22 ~ 25)](#模块-8模型槽位与-api-key-门禁-case-22--25)
  - [模块 9：Diet B 后台运行与 SSE 完整重放 (Case 26 ~ 32)](#模块-9diet-b-后台运行与-sse-完整重放-case-26--32)
  - [模块 10：静默放弃作答 (Dismissal) 机制 (Case 33 ~ 35)](#模块-10静默放弃作答-dismissal-机制-case-33--35)
  - [模块 11：并行多道题目答题时序控制 (Case 36 ~ 38)](#模块-11并行多道题目答题时序控制-case-36--38)
  - [模块 12：打断引导与工具 ID 防撞 (Case 39 ~ 41)](#模块-12打断引导与工具-id-防撞-case-39--41)
- [三、 `chat-flow.test.ts` 蕴含的五大架构黄金法则](#三-chat-flowtestts-蕴含的五大架构黄金法则)
- [四、 如何利用 VS Code 断点调试 `chat-flow.test.ts`](#四-如何利用-vs-code-断点调试-chat-flowtestts)

---

## 一、 为什么 `chat-flow.test.ts` 是系统的生命线？

在 `learnharness` 中，大部分代码都在为**“一轮高质量的教学对话（Turn）”**服务。
而 `tests/chat-flow.test.ts` 则是这套核心交互的“最高法典”：
- 它涵盖了从用户发问、模型调用、出题、思考、答题、批改、重连、报错、防撞等**全流程状态机**；
- 它的全部测试**不发一次真实网络请求、不花一分钱 API 费用**，运行仅需几秒钟；
- 读懂了这 41 个测试用例，就等于彻底吃透了整套对话服务端的实现机理。

### 1.1 仿真大模型（`scriptedEngine`）与测试架构
该测试文件通过 `scriptedEngine` 构造可预测的大模型交互剧本：
```typescript
// 构造一个由两轮交互组成的仿真大模型引擎
const engine = scriptedEngine([
  // 第 1 步：大模型回复思考文本并调用测验工具 quiz
  {
    thinking: "Probe the basics first.",
    toolCalls: [{ name: "quiz", args: QUIZ_INPUT }]
  },
  // 第 2 步：拿到学生答案后，模型批改并输出最终正文
  {
    text: "Correct! Mercury is the closest planet to the Sun."
  }
]);
```
通过这种确定性注入，测试可以精确断言每个网络包、每个事件、每个文件写入是否 100% 符合预期。

### 1.2 41 个用例所属的 12 大功能模块总览

| 模块序号 | 模块主题 | 用例范围 | 核心验证领域 |
| :---: | :--- | :---: | :--- |
| **模块 1** | 教学主流程与出题闭环 | Case 01 ~ 04 | 测验出题、学生作答、参数校验、流式事件先后时序 |
| **模块 2** | 运行中纸条引导 (Steering) | Case 05 ~ 06 | 任务唤醒防重写、Mid-run 插队不破坏工具绑定对 |
| **模块 3** | 视图推导与思考折叠 | Case 07 ~ 08 | 思考置顶（Hoisting）、空消息占位与结算后清理 |
| **模块 4** | 健壮性与题目自愈重试 | Case 09 ~ 12 | 客户端断开不杀进程、无法评分题目的自愈重试、并行出题 |
| **模块 5** | 仓储持久化与故障隔离 | Case 13 ~ 17 | 存储往返读写、更新会话设置、磁盘写入故障隔离 |
| **模块 6** | 并发排他锁与预写日志 | Case 18 ~ 19 | 单会话单轮次互斥（409）、预写日志（WAL）先落盘 |
| **模块 7** | 会话重命名与排序防跳 | Case 20 ~ 21 | 重命名不刷修改时间戳（防跳序）、全空格兜底 |
| **模块 8** | 模型槽位与 Key 门禁 | Case 22 ~ 25 | 无模型 503 拒绝、单会话模型放行、Key 缺失防御 |
| **模块 9** | Diet B 协议与完整重放 | Case 26 ~ 32 | POST 即刻 ACK、中途挂载 SSE 全量重播、远程中断 |
| **模块 10**| 静默放弃作答 (Dismissal) | Case 33 ~ 35 | ESC 放弃不耗 Token、无挂起题目拦截、逐题放弃 |
| **模块 11**| 并行多道题目答题时序 | Case 36 ~ 38 | 答完一道不唤醒、全部答完才唤醒、答题与放弃混合 |
| **模块 12**| 打断引导与工具 ID 防撞 | Case 39 ~ 41 | 外部引导接口鉴权、第三方模型重复 `call_0` 自动消歧 |

---

## 二、 41 个测试用例逐一深度拆解

---

### 模块 1：教学主流程与出题作答闭环 (Case 1 ~ 4)

#### Case 01: `quiz tool call persists as a pending part; the answer continues the lesson` (L278)
- **测试目的**：验证最核心的教学全生命周期闭环——老师发问出题 $\rightarrow$ 题目持久化挂起 $\rightarrow$ 学生提交答案 $\rightarrow$ 老师判定并继续讲课。
- **业务场景**：用户与老师对话，老师讲完一段后出一道选择题，用户点击选项提交，老师根据选项进行解析。
- **断言逻辑（Why Assert What it Asserts）**：
  1. `assert.equal(saved1.messages.length, 2)`：第 1 轮结束后磁盘严格只有 2 条消息（User 发问 + Assistant 回复），断言没有多余的空消息；
  2. `assert.ok(quizCall && quizCall.type === "toolCall")`：大模型必须通过标准的 `toolCall` 协议抛出测验题，校验入参匹配预设 `QUIZ_INPUT`；
  3. `assert.equal(pending.toolCallId, "call-1")`：通过核心推导函数 `danglingQuestionOf`，断言系统能准确抓取出当前处于“等待作答”状态的题目；
  4. 提交答案后：`assert.equal(saved2.messages.length, 4)`（追加了学生的 `toolResult` 和老师批改后的最新回复）；
  5. `assert.equal(danglingQuestionOf(saved2.messages), null)`：断言答题后挂起状态被彻底清除，会话平滑恢复正常交流。

#### Case 02: `rejects unknown chats` (L357)
- **测试目的**：测试向一个不存在或已被删除的 `chatId` 发送聊天请求时的安全性。
- **业务场景**：网络脏请求、客户端缓存过期或黑客伪造非法 ID 发送。
- **断言逻辑**：
  - `assert.equal(res.status, 404)`：必须严格返回 404，不生成任何孤儿对象，不留存空文件。

#### Case 03: `refuses malformed inputs with a clean 400 — no liveness effects, no lockout` (L362)
- **测试目的**：验证当用户发来的 JSON 损坏或结构缺失时，系统优雅拒绝且**绝不引发死锁**。
- **业务场景**：网络传输丢包导致 JSON 残缺，或前端传递了错误类型。
- **断言逻辑**：
  - `assert.equal(res.status, 400)`：返回 400 Bad Request；
  - `assert.equal(isTurnRunning(chat.id), false)`：断言拒绝后**绝对不能残留运行中锁（Liveness Lock）**，随后紧接着发送正常请求必须能立即返回 200，证明系统没有被恶意坏包卡死。

#### Case 04: `streams the toolCall partial before tool_execution_start/end` (L389)
- **测试目的**：验证流式事件的时间线前后顺序（Protocol Pinning）。
- **业务场景**：在流式生成过程中，前端 UI 必须在工具开始执行前就拿到卡片骨架并渲染到屏幕上。
- **断言逻辑**：
  - `assert.ok(callSeen < execStart && execStart < execEnd)`：严格断言事件流必须按 `message_update(toolCall)` $\rightarrow$ `tool_execution_start` $\rightarrow$ `tool_execution_end` 的先后时序发射。

---

### 模块 2：运行中纸条引导与原子对防撞 (Case 5 ~ 6)

#### Case 05: `a pump-fired wake turn never double-appends its steer` (L413)
- **测试目的**：防回归测试（防止 2026-09-18 历史 Bug 复现）。
- **业务场景**：当后台子任务（如研究员）跑完唤醒主会话时，引导纸条（Steer Marker）必须仅写入历史一次。
- **断言逻辑**：
  - `assert.equal(copies.length, 1)`：断言历史记录中该 steer marker 的出现频次严格为 1，绝不允许重复追加。

#### Case 06: `Wave C steering: a mid-run result injects BETWEEN turn units — never splitting a toolCall from its toolResult` (L465)
- **测试目的**：验证大模型协议的“原子绑定对”（Bonded Pair）铁律。
- **业务场景**：智能体在调用工具时，如果中途有一条外部纸条（如子任务完成提醒）插进来，它绝不能插在 `toolCall` 和它的 `toolResult` 之间（否则大模型 API 会报错说工具调用缺失结果）。
- **断言逻辑**：
  - `assert.ok(callAt < resultAt)`：工具调用必然先于工具结果；
  - `assert.equal(steerAt, resultAt + 1)`：引导纸条必须精确插入在 `toolResult` 之后、下一个 Assistant 消息之前。

---

### 模块 3：视图投影规范与思考过程折叠 (Case 7 ~ 8)

#### Case 07: `the view canon HOISTS reasoning above the message text` (L560)
- **测试目的**：验证视图推导法则：思考过程（Thinking / Reasoning）必须置于正文文本上方（Hoisting）。
- **业务场景**：符合人类心理学阅读规律——先展示模型的思考折叠框，下方展示最终输出的解答。
- **断言逻辑**：
  - `assert.equal(order[0], "reasoning")`；
  - `assert.ok(order.indexOf("text") > order.indexOf("reasoning"))`：断言前端 view 中的部件顺序必然是思考在前、文本在后。

#### Case 08: `an arrived-but-empty STREAMING message projects the thinking row; a settled empty one stays hidden` (L602)
- **测试目的**：测试流式开始时的乐观占位与结算后的空内容清理。
- **业务场景**：大模型刚连上但还没输出字时，前端展示思考骨架屏；如果生成结束依然没有任何内容，则必须自动隐藏该行，不能留下一行空白占位符。
- **断言逻辑**：
  - 流式阶段部件包含 `reasoning`；
  - 一旦结算后断言 `settled.length === 1`（自动抹去空消息）。

---

### 模块 4：健壮性、题目自愈与模型自我纠错 (Case 9 ~ 12)

#### Case 09: `a cancelled view NEVER aborts the turn — it runs to completion` (L626)
- **测试目的**：验证前端断网或关闭网页时，服务端生成不被强行掐断（Diet B 独立进程原则）。
- **业务场景**：学生点击了发送，然后不小心刷新了页面或合上了笔记本电脑盖子。
- **断言逻辑**：
  - 断开客户端连接后，断言 `isTurnRunning(chat.id)` 依然为 `true`，`runningTurn(chat.id)` 句柄在服务端依然存活，直到大模型生成完毕并把完整结果写盘。

#### Case 10: `an ungradeable quiz is rejected at the call boundary, the error reaches the model, and the model retries` (L654)
- **测试目的**：测试模型出的测验题自身有逻辑 Bug（如题目的 `correctAnswer` 根本不在选项 `options` 中）时的自我纠错能力。
- **业务场景**：大模型出现幻觉，出了一道四不像的错题。系统绝不能把崩溃展示给学生，而应在内部拦截并让大模型当场重出。
- **断言逻辑**：
  - 拦截到错题：`assert.equal(badEnd.isError, true)`，错误日志明确提示答案不在选项内；
  - 模型收到错误日志立刻在内部重试：`assert.equal(goodEnd.isError, false)`；
  - 最终落盘的记录中，学生看到的始终是一道格式完美的题目。

#### Case 11: `structurally invalid quiz input (unhealable garbage) never reaches the dock and retries clean` (L732)
- **测试目的**：测试模型返回完全无法解析的结构性垃圾数据时的防御。
- **断言逻辑**：非法的 quiz 绝不会变成前端交互卡片，模型内部重试后以新的合法 call 取代。

#### Case 12: `parallel quiz calls are asked, saved, and answered in the model` (L777)
- **测试目的**：测试模型在同一次回复中一口气并行抛出两道测验题。
- **断言逻辑**：断言两条 toolCall 均被持久化，并能分别独立绑定作答。

---

### 模块 5：仓储持久化与读写故障隔离 (Case 13 ~ 17)

#### Case 13: `round-trips and lists chats` (L827)
- **测试目的**：验证 `chatStore` 写入、读取和列表汇总的基本一致性。
- **断言逻辑**：`assert.equal(chats[0].id, chat.id)`。

#### Case 14: `persist the per-chat model settings (replace-whole, no updatedAt churn)` (L836)
- **测试目的**：测试会话专属模型配置的保存逻辑。
- **断言逻辑**：修改会话模型后，断言 `updatedAt` 时间戳绝不变更（避免修改设置导致左侧边栏重新跳序）。

#### Case 15: `refuses a failed input save without building an agent or leaving a live turn` (L852)
- **测试目的**：测试磁盘满或文件系统拒绝写入时的故障隔离。
- **断言逻辑**：若用户发来的消息写入磁盘失败，系统坚决拒绝启动 Agent，不产生内存死锁。

#### Case 16: `reports a failed reply save before DONE while keeping the accepted answer durable` (L880)
- **测试目的**：测试模型回复写入失败时的异常处理。
- **断言逻辑**：即使模型回复写盘失败，学生的答题记录依然安全留存（保证学生心血不丢）。

#### Case 17: `does not redeliver a persisted learner steer after usage bookkeeping fails` (L920)
- **测试目的**：测试费用统计写入失败时，已经生效的 steer 纸条不被重复消费。

---

### 模块 6：并发排他锁（409）与预写日志 WAL (Case 18 ~ 19)

#### Case 18: `one turn per chat: a concurrent request is 409` (L949)
- **测试目的**：验证单会话单轮次的排他互斥锁（Mutual Exclusion）。
- **业务场景**：用户快速双击发送按钮，或弱网环境下前端重发请求。
- **断言逻辑**：
  - 第 1 个请求返回 200 并开始运行；
  - 第 2 个并发请求立即被拦截并返回 `409 Conflict`，拒绝同时执行两个大模型进程。

#### Case 19: `write-ahead: the learner's message persists BEFORE the agent starts` (L970)
- **测试目的**：验证预写日志（WAL）原则。
- **业务场景**：即使在模型调用前一毫秒系统断电，学生刚敲进去的长篇大论也绝不能丢失。
- **断言逻辑**：在大模型还没开始生成任何字符之前，断言读取磁盘文件就已经能查到这条用户消息。

---

### 模块 7：会话重命名与侧边栏排序防跳 (Case 20 ~ 21)

#### Case 20: `persists the title and does NOT bump updatedAt — sidebar order must not churn` (L1002)
- **测试目的**：验证重命名会话不会刷新修改时间。
- **断言逻辑**：`assert.equal(renamed.title, "New title")` 且 `assert.equal(renamed.updatedAt, originalUpdatedAt)`。

#### Case 21: `falls back to Untitled session on an all-whitespace title` (L1021)
- **测试目的**：边界测试，全空格标题自动降级为 `"Untitled session"`。

---

### 模块 8：模型槽位与 API Key 门禁 (Case 22 ~ 25)

#### Case 22: `a chat with no model refuses the turn with the 503 envelope — nothing lingers` (L1030)
- **测试目的**：未配置任何大模型时的门禁拦截。
- **断言逻辑**：返回 503，错误体明确说明缺少 `strong` 模型槽位，且不留存任何卡死锁。

#### Case 23: `a per-chat model alone opens the gate` (L1061)
- **测试目的**：全局未配模型，但当前会话单独配置了模型时，能够正常放行。

#### Case 24: `a pinned provider whose key is gone refuses with 503 provider_key_missing` (L1076)
- **测试目的**：指定的厂商 API Key 被删掉时的门禁拦截（返回 503 与缺少 Key 的厂商名）。

#### Case 25: `an env-present key passes the gate` (L1101)
- **测试目的**：验证通过系统环境变量传入的 Key 同样能正常通过鉴权。

---

### 模块 9：Diet B 后台运行与 SSE 完整重放 (Case 26 ~ 32)

#### Case 26: `CONNECTION DIET B: the POST acks and closes — the response never holds the turn` (L1122)
- **测试目的**：**Diet B 核心协议断言**——POST 请求收到输入后立即返回 ACK 200 并关闭连接，生成任务转入后台。

#### Case 27: `subscribe mid-turn: a second view gets the FULL replay, then live, same dialect` (L1143)
- **测试目的**：多窗口/中途刷新测试。客户端中途挂载 SSE 时，先收到之前的完整事件重放，再无缝衔接实时生成块。

#### Case 28: `COMPACTION LAW: the log stores state, not chunks` (L1188)
- **测试目的**：事件压缩法则，验证一瞬间涌入的多个流式小 Chunk 在重放日志中被合并为一个状态包，降低网络开销。

#### Case 29: `remote abort: any client can stop a running turn; the partial persists` (L1221)
- **测试目的**：测试用户主动点击 Stop 按钮终止生成，已生成的局部内容安全落盘，所有订阅窗口干净关闭。

#### Case 30: `subscribe after settle: the cheap terminal tells the client the record is current` (L1247)
- **测试目的**：轮次已经生成完毕后客户端才建立 SSE 连接，立即返回 `turn-settled` 终结标示并关闭流。

#### Case 31: `concurrent two-chat reattach: two turns in flight, two views, both settle independently` (L1263)
- **测试目的**：两个不同会话同时在后台并发生成，两个前端窗口各自订阅，互不干扰独立收尾。

#### Case 32: `explain tool call persists as a pending part; the free-text answer reveals the commitment and reaches the model` (L1299)
- **测试目的**：测试主观问答题（Explain）工具的提问、暂存与学生输入自由文本提交作答的闭环。

---

### 模块 10：静默放弃作答 (Dismissal) 机制 (Case 33 ~ 35)

#### Case 33: `writes the toolResult with NO wake — the next plain message carries it to the model` (L1381)
- **测试目的**：测试学生按下 ESC 放弃做题。
- **业务场景**：学生不会做或不想做当前题目，按 ESC 跳过。
- **断言逻辑**：
  - 返回 200，在记录中将该题目标记为 `dismissed: true`；
  - 断言 `isTurnRunning === false`：**不唤醒大模型、不消耗任何 Token**，直到下一次学生发送普通消息时才把该放弃状态一并带给模型。

#### Case 34: `rejects honestly: unknown chat 404, no dangling question 400` (L1411)
- **测试目的**：防御测试，在没有题目挂起时调用放弃接口直接返回 400。

#### Case 35: `parallel quizzes dismiss call-by-call — the composer returns only when nothing dangles` (L1419)
- **测试目的**：如果有两道题，用户一道一道放弃，直到最后一道题也被放弃后，输入框才恢复可用。

---

### 模块 11：并行多道题目答题时序控制 (Case 36 ~ 38)

#### Case 36: `the sibling answer wakes NOTHING; the last answer fires the one turn with both results adjacent` (L1485)
- **测试目的**：模型出了两道题，学生答完第 1 题时**不唤醒模型**，等第 2 题也答完时，才统一打包触发一次大模型调用。
- **断言逻辑**：答完第 1 题时 `calls.length === 1`（没有新调用），答完第 2 题时 `calls.length === 2`，且模型的 Prompt 里紧邻着两个答案。

#### Case 37: `round 1 — answer then dismiss: NO wake at all (ending on a dismissal pauses)` (L1553)
- **测试目的**：两道题中，学生“答了一道，放弃了一道”。因为最后是以放弃（Dismiss）收尾，**会话保持暂停状态，不唤醒大模型**。

#### Case 38: `round 2 — dismiss then answer: exactly one wake carrying both results` (L1573)
- **测试目的**：两道题中，学生“放弃了一道，答了一道”。因为最后是以作答收尾，**正常触发一次唤醒**，并将放弃和作答结果同时呈递给模型。

---

### 模块 12：打断引导与工具 ID 防撞 (Case 39 ~ 41)

#### Case 39: `honest rejections: 404 unknown chat, 400 bad input, 409 when no turn is live` (L1603)
- **测试目的**：测试实时插队接口 `/api/chats/[id]/steer` 的参数校验。当会话没有在运行时调用插队直接返回 409（因为无可插队对象）。

#### Case 40: `200 + the live steering queue when a turn runs; the drain lands the card and the model sees it` (L1613)
- **测试目的**：会话正在运行时，通过 steer 接口成功插入纸条，模型在下一轮生成步中看到了这条指导并调整了讲解方向。

#### Case 41: `every call_0 turn keeps its identity: ask answered as ask, quiz as quiz, ids unique in the record` (L1678)
- **测试目的**：**著名的 Lacan 修复**。某些国产或开源模型每一轮都固定使用 `call_0` 作为工具 ID。
- **业务场景**：防止跨轮次的工具调用由于重名 ID 导致答案错位。
- **断言逻辑**：系统在内部自动注入了消歧后缀（如 `call_0~1`），断言落盘记录中所有的工具调用 ID 均严格唯一（`Set(callIds).size === callIds.length`）。

---

## 三、 `chat-flow.test.ts` 蕴含的五大架构黄金法则

研读完这 41 个用例，你会发现整套系统对话设计的精髓：

1. **预写优先（WAL）**：用户输入先落盘，再调大模型，绝不丢字；
2. **连接解耦（Diet B）**：POST 立即断开返回，SSE 负责独立重播，网络波动绝不影响后台推理；
3. **静默放弃（Dismissal 零成本）**：ESC 跳过不耗 Token，不打扰大模型，待下次发问一并带入；
4. **排他互斥（Mutex 409）**：单会话严格串行，防止多线程脏写；
5. **视图纯净（Projection）**：服务端只存原生事实，卡片折叠与思考展示完全由前端纯函数动态推导。

---

## 四、 如何利用 VS Code 断点调试 `chat-flow.test.ts`

既然已经配置好了 `.vscode/launch.json`，你可以非常方便地进行断点跟踪：

1. 打开 [tests/chat-flow.test.ts](file:///d:/0.default/learnharness/tests/chat-flow.test.ts)；
2. 在第 280 行左右（即第一个测试用例内部）打上红点断点 🔴；
3. 打开左侧“运行和调试”面板，下拉选择 **`🎯 调试对话主干: chat-flow.test.ts`**，直接按 **`F5`**；
4. 程序会精准暂停在断点处，你可以单步查看 `scriptedEngine` 如何依次交出控制权并触发状态流转。
