# pi 引擎更换 — 设计记录 (The pi engine swap — design record)

日期: 2026-09-12。状态：已计划 (PLANNED)（事实已核实，等待执行）。

决定 (用户 user, 2026-09-12): 将服务器端的智能体引擎 (B 频段 Band B) 和 UI 流桥接层 (C 频段 Band C) 从 Vercel AI SDK 替换为 **@earendil-works/pi-ai** (提供商/目录/流式处理层 provider/catalog/streaming layer) + **@earendil-works/pi-agent-core** (智能体循环 agent loop)。客户端 (D 频段 Band D: `useChat`、传输 transport、UI 工具包 UI kit) **保留在 (stays)** AI SDK 上。转录本契约 (A 频段 Band A: UIMessage 形状的记录, `TeacherUIMessage`) **原样保留 (stays)**。模型/思维控制功能的引入将在此次更换之后进行，且下面的架构设计能够使其自然而然地通过 pi 的目录体系实现。

动机：SDK 的模糊不清已经让我们付出了反复的代价（数据片段的约定 data-part conventions、UIMessage 合并规则、重试路径、续传合并 continuation coalescing — 这些全都需要像法医一样去解剖才能搞懂）。而 pi 的抽象层极为轻量，且用户对它们有深度的了解。在这次更换之后，轮次管道 (turn pipeline) 的每一个组件要么是我们自己写的，要么是 pi 的，每一个都能被完全掌控和理解。

已验证的包事实 (所有三个考察点 + npm 注册表):
- `@earendil-works/pi-ai` + `pi-agent-core` 最新版本 **0.85.1**，MIT 协议，仅支持 ESM (ESM-only)，要求 Node `>=22.19.0`（本地开发跑在 26.7 上 — 没问题；Electron 发布波段必须打包 ≥22 的 Node 环境）。这些是直接从普通的包注册表安装的，没有 vendor 依赖。旧版的原型代码 (/Volumes/T7/code/learning-system) 在同样的接线方式下能干净利落地运行在 0.84.2 版本。
- pi-ai = 仅包含提供商/目录/流式处理：`createModels()`、`models.streamSimple`、`calculateCost`、`getSupportedThinkingLevels`、`validateToolArguments`。**没有智能体循环，没有 zod，没有 React，没有 SSE。**
- pi-agent-core = 循环：`Agent` (引导 steer/追问 followUp/中止 abort/订阅 subscribe)、`agentLoop`、`AgentTool` (执行 execute + `terminate`)、JSON-Schema 验证器能够接受纯粹的 JSON Schema (zod 导出的 `z.toJSONSchema` 是可行的，而且带强制类型转换 coercion — 已在 `validation.js:285` 中验证)。

## 1. 引擎架构 — 每轮次无状态的 Agent，记录即真理 (Engine architecture — stateless per-turn Agent, record is the truth)

**持久化记录仍然是唯一的真实来源 (The record stays the source of truth)。** 每一个轮次都会通过我们的 `convertToLlm` 适配器，利用持久化的 UIMessage 记录构建一个 *崭新 (fresh)* 的 `Agent`。运行它，然后将新生成的部分存回到记录中，随后丢弃该 Agent。pi 原生的 `steer()`/`followUp()` 队列是 **内存级的 (in-memory)**（直接以数组形式挂在实例上），会随着进程的消亡而丢失 — 它们是为那些 *持久存活 (held-live)* 的智能体设计的（比如 pi-coding-agent 会在一个会话的生命周期内始终维持一个 Agent 实例）。而 lh (学习线束) 的架构恰恰相反：我们的轮次是依附于 HTTP 请求生命周期的 (HTTP request-scoped turns)、拥有持久化的唤醒管道 (durable wake pipeline)、采用预写式持久化 (write-ahead persistence)，以及 409 单一轮次并发防护。这些设计都将完全保持原样。

具体到向 `/api/chat` 发起的每次 POST 请求：
1. `beginTurn` / 409 守卫 / 预写持久化 (保持不变，`chat-handler.ts`)。
2. 认领并合并引导信息 `claimSteers` (保持不变 — 服务端唤醒消息会在轮次 *开始之前 (before)* 被追加到记录中，目前的逻辑就是如此)。
3. 构建 `initialState.messages` = `recordToPiMessages(record)` (§4)。
4. `new Agent({ initialState, streamFn, convertToLlm, getApiKey, tools })`。
5. 运行至完成（循环能够顺利往下走，因为提问类型的工具会提前终止当前循环，参见 §2；否则的话通过 `stop`/`length` 结束原因 stopReason 来终止）。
6. 桥接层 Bridge (§3) 会在运行过程中实时发出 SSE 块数据；收集事件用于计算用量。
7. 相当于 `onFinish` 的处理：`persistTurn` (针对计划树区块进行拼接，不变)、`appendTurnUsage`、`triggerExtraction`、`endTurn` (全部保持不变)。

以下是我们有意 **不采用 (not)** 的机制：
- 跨请求保持存活的 Agents (这会丧失持久性保证，并打破现有的 409 / 单一写入器模型)。
- pi 原生的循环内引导注入机制 (即在轮次进行中途注入 steers) — 目前我们的唤醒机制是等待当前正在运行的轮次结束 (即在请求边界处 claimSteers)。通过 `getSteeringMessages` 实现在循环内部注入可能是未来的一项增强功能，已在 §8 中注明；但在此次更换中不包含。
- pi 原生的 JSONL 会话管理机制 (`harness/session/jsonl`) — 我们的聊天记录存储层已经扮演了这个角色。

## 2. 测验/提问模式 — 此次更换的核心 (The quiz/ask pattern — the heart of the swap)

我们在 pi 本身和原型中发现了三种形态；由于 lh 的提问工具是 **由客户端作答且以轮次为作用域的 (client-answered and turn-scoped)**，所以 lh 需要第三种变体：

- pi 自身的 `ask_question` (在交互式子智能体扩展 interactive-subagents ext 中)：其 execute 会写出一个附属文件然后立刻返回；由 *会话层 (session layer)* 在未来某条消息中将回复进行编排组织。这适用于一个持久存活 (held-live) 的子智能体，而不适合我们的轮次模型。
- 原型 (prototype) 曾经的计划：采用 **阻塞型执行 (blocking execute)**，在那死等学习者作答，然后将打好分的结果当成返回值。这适合 TUI 终端界面，而非 HTTP — 因为 HTTP 不能为了等学习者作答就把一个 POST 请求挂起好几分钟。

**lh 的变体 (也是最终设计)：** 问题工具 (`quiz`、`ask_user_question`) 也是 `AgentTool`，但是它们的 `execute()` 会 *立刻* 返回一个合成的结果：

```ts
execute: async () => ({
  content: [{ type: "text",
    text: "Question posed to the learner. Turn ends here; the answer arrives as this call's result next turn." }], // 问题已向学习者提出。轮次到此结束；答案将作为该调用的结果在下一轮中到达。
})
```

- **负责停止循环的机制是 `shouldStopAfterTurn` 回调钩子，而不是 `terminate`。** (已在 `agent-loop.js` 中确认：terminate 是依附在 *结果 (result)* 上的，而且只有当整批调用 execute 完毕后才触发，并且必须是这批调用中的 *每一个 (every)* 结果都将其设为 true 时才会终止循环 — 所以如果是一个 测验+研究 的调用批次，循环是不会停的，模型会在发布测验后继续教学。`terminate` 这种设计本就是为了那些标志着工作流终结的工具而设，并不是为了等待输入而暂停准备的；所以我们不能挪用它。) 我们包装层里的钩子是这样判断的：*当前这一轮已完成的 assistant (助手) 消息中是否包含问题类型工具的调用？→ 若包含，返回 true → 于是智能体循环就会在发起下一次大模型调用前停止。* 这对于任何形状的批处理调用来说都是确定可靠的；如果同批次中还包含服务器端的工具调用（比如研究 research 等），这些工具依然会先执行并通过流返回结果，这同现有的 SDK 表现一致——即客户端工具的调用宣告该轮次流式输出的终止。
- 这个人工合成的执行结果之所以存在，仅仅是因为 pi 自己的循环机制要求 **在当前轮次内 (within that turn)** 所有已执行的工具调用都必须带着一个结果以进入干净的终结状态。这个结果 *绝不会被持久化 (never persisted)* — 就像现在一样，我们的聊天记录仅保留工具调用的片段，而把它对应的 **输出留空 (no output)**，直到客户端作答为止。那次无效执行（死跑 dead run）中积攒在内存里的上下文（包括占位结果）全被抛弃掉了；学习者回答的内容将直接附加在 *记录 (record)* 上，而在下一轮次里，一个崭新的 Agent 将通过适配器 (§4) 把该解答正常地视为该工具的调用结果。
- 学习者的回答 (发生在 dock → 调用 `addToolOutput` → 随身携带着修改后的转录本记录发起下一次 POST 请求) 将通过 `recordToPiMessages` 重新进入循环：带有答案的工具片段会转变成一条带有原 `toolCallId` 的 `ToolResultMessage`，从而让模型顺理成章地将解答认作该工具执行的结果。这完美契合了 pi 对于 `continue()` 机制的要求 ("最后一条消息必须是 user (用户) 或者 tool-result (工具结果) 类型的消息") — 差别仅在于我们是通过自己的聊天记录喂给它的，而不是塞进一个持久存活的 Agent 中。
- **关于编写端的数据校验，我们仍然使用 zod，并保留自己的校验逻辑。** `z.toJSONSchema` 的输出摇身一变成为了工具的 `parameters` 供模型参考 (pi 也会进行结构校验并尝试强制类型转换 coercion)，但是我们定义的利用 `superRefine` 校验的跨字段规则 (例如，correctAnswer 必须在 options 之内 — 这可是修复过两次的表述逻辑) 是无法在 JSON Schema 里幸存的。所以，我们的包装器会在执行前的那一刻自己亲自去跑一下 zod 校验：如果校验失败，它就会沿着与 pi 自家验证机制相同的路线，把错误直接顶回去 — 生成一条带有错误信息的 `ToolResultMessage` 丢给模型，好让它看到并重新尝试 (已证实：这正是 pi 原生的自我修复路径，即 `prepareToolCall` 中的 catch 分支 → 走到 `createErrorToolResult`)。这在语义上跟现行的 `InvalidToolInputError` 是完全一样的。
- **关于被悬空的问答调用 (Dangling question calls)**（例如在模型还未跑完一半，留下一道没人作答的测验就被强行中止轮次，或者终止了 LLM 的生成 — pi 会回收那些具有 `aborted` stopReason 状态的残缺助手消息片段）：在遇到紧接着 LLM 调用的、缺少结果的 toolCall 时，`recordToPiMessages` 必须为它人工合成一条 `ToolResultMessage` (内书："问题遭到中断")，否则大模型提供商那边会直接拒绝此类请求。这是适配器的一条铁律 (hard invariant)，并且已经由测试完全覆盖。

## 3. 桥接层 — pi AgentEvents → UIMessageChunk SSE 格式 (The bridge)

我们重写了一份大约 200 行代码的 `src/server/ui-stream-bridge.ts`，彻底替换掉了 `createAgentUIStreamResponse`。连线格式 (从 SDK 源码核实)：

- 响应：`text/event-stream`，一个个打平的 JSON 数据块：`data: {"type":"text-delta","id":"…","delta":"…"}\n\n`，以 `data: [DONE]\n\n` 结尾。至于 Vercel 的那些 HTTP 头则不需要 (客户端会无视它们)；但我们还是会发 `content-type` + `cache-control: no-cache`。
- 每个分块在客户端都会接受 zod 校验 (`looseObjects` 模式)；格式畸形或者缺少必填字段将会使聊天框直接跳红进入报错状态。在编写组装数据块的逻辑时，我们都是带类型约束 (typed) 并对照着 `uiMessageChunkSchema` 的形状编写了单元测试。

事件映射 (pi 事件 → chunk(s))：
- `agent_start`/`turn_start` → `start` (参考 id 规则) + `start-step`。
- `message_update` (带着 pi 文本事件时): `text_start/delta/end` → `text-start`/`text-delta`/`text-end` (每一个文本块都配有固定的 id，例如 `${messageId}-t${n}`)。
- 思考类型的事件 → `reasoning-start`/`reasoning-delta`/`reasoning-end`。
- `toolcall_start/delta/end` → `tool-input-start`/`tool-input-delta`（这一步是可选的；你可以跳过 delta，而在 end 时直接发送 `tool-input-available` — 这个干净的路径已经验证过）/ `tool-input-available` (局部状态设为 `input-available`，名字固定写为 `tool-${toolName}`)。
- `tool_execution_start/end` (仅限那些在服务器端执行的工具：research, demo, visual, plan_init, probe_done) → 输出 `tool-output-available` 并带上序列化后的执行结果。**绝不要 (Never)** 为客户端的问题工具发送任何结果（它们是由客户端处理的；为一个不存在于客户端列表里的 callId 发送输出会导致客户端抛错 → 进而引发 error 状态）。
- `tool_execution_end` 带着那些校验报错的结果 → 发送同样的 `tool-output-available` (填入报错信息 content)，这跟现在的表现一模一样。
- `message_end` → 收集使用量信息 (§5)；`turn_end` → 发送 `finish-step`。
- `agent_end` → 发送 `finish {finishReason}` — 无论如何都要发 (给 `onFinish` 提供可靠性保证)；`stop`/`length` 会自然而然地映射过去。
- 运行中途遇到报错：发送 `error {errorText}` (流并不会因此终结；客户端收到后会将其扔进报错状态)，然后关闭流。跟现在一样，揭开校验或遇到未知工具产生的错误。
- **续传的 ID 规则 (这是决定成败的核心规则，源于客户端 `makeRequest`/`createStreamingUIMessageState` 的源码)：** 如果转录本中的最后一条消息是一条 *assistant (助手)* 消息，那么客户端流媒体状态将会克隆那条消息的形态并作为起始点，而且随后过来的流内容必须在原有的那条消息之上进行续传 — 所以 `start` 事件所带的 `messageId` 必须等于最后一条 assistant 消息的 id。否则 (如果是崭新的轮次)，就得在服务器端新鲜生成一个 id。如果不守规矩，就会导致之前 assistant 消息里的每块内容都被复制一遍 (连考题卡片都会显示两次，工具调用 id toolCallIds 也全部重复)。
- **中止机制 (Abort)：** 客户端点击 Stop 按钮终止抓取请求 → 触发 Node 的 `request.signal` 事件。桥接层负责监听此信号：一旦收到便执行 `agent.abort()`，随后打捞机制会将已有的残局记录持久化下来 (pi 也会将此残局以 `aborted` 作为 stopReason 保存下来)，整个持久化的 isAborted 判断与今日毫无二致。Job/提取任务的中止功能 (`abortJob`, `abortExtraction`) 会直接在被登记的任务上调用 `agent.abort()` — 这个中止信号不仅贯穿 `streamFn`，还会渗入到每一个 `execute()` 当中，已获证实。

## 4. 记录适配器 — `recordToPiMessages` / 消息数据形状 (The record adapter)

`convertToLlm` (我们自己写的) 负责将系统记录里的 UIMessages 转换成 pi 的 `Message[]` 格式：
- user 文字消息 → `UserMessage {role:"user", content, timestamp}`。所有附加数据部分 (如 `data-plan-accepted`, `data-plan-block`) 统统剥离丢弃 (那纯粹是给 UI 用的)，这跟现在 `convertToModelMessages` 的干法一模一样。
- assistant 消息 → `AssistantMessage {role:"assistant", content:[…]}` — 文字部分 → 转换为文本块；推理部分 → 转换为思维块 (+ 在 Anthropic 续传所需的被持久化在记录里的 `thinkingSignature`)；工具调用部分 → `ToolCall {id, name, arguments, thoughtSignature?}`。
- 被作答完毕的工具片段 → 在其从属的 assistant 消息之后，追加一条根据它输出结果拼起来的 `ToolResultMessage {role:"toolResult", toolCallId, toolName, content, isError?, timestamp}`。问题类工具的解答结果最终变成了纯文本的 content (也就是模型现在能看到的那条经过评分判定的反馈信息)。
- 没有收到答案的问题 toolCall → 采用人工合成的已被中断结果 (§2)。
- 在 user 消息上的 `data-plan-accepted` 标记 → 为此消息追加一段文本 "计划已被接受 — 开始教学。 (The plan is accepted — begin teaching.)" (现行的逻辑是：发出去一条带有 `data-plan-accepted` 的部分 + 包含该句文本的部分；模型自始至终只看到了那句文本而已 — 所以效果等同)。
- 探测者/教师 智能体的分叉接缝保持不变：教师分支依旧靠抓取转录本记录里的 `tool-probe_done` 片段来决定走向；而且每新起一轮，这俩智能体都会通过同一条聊天记录重新被构建。

这波改造中，记录本身的格式 **绝不会 (not)** 发生变更 (A 频段依然原封未动)；所谓的 thinkingSignature 支持也不过是在零件的模式校验 (part schema) 里新增加了一个可选字段而已 (且只在提供商真的退回带签名的思维过程时才会用到)。

## 5. 用量、成本与模型目录 (Usage, cost, and the model catalog)

- 用量统计 (Usage)：订阅 `message_end`/`turn_end` 事件 → 提取 `AssistantMessage.usage {input, output, cacheRead, cacheWrite, reasoning?, totalTokens, cost}` → 将其映射为咱们这边的 `CallUsage`/`TurnUsage` 契约定义 (只有些许字段更名：比如 `reasoningTokens` 改成了 `reasoning` 等)。原有的统计栏与活动停靠栏原封不动。
- 成本核算 (Cost)：pi 的 `Usage.cost` 字段是已经通过 `calculateCost` 提前计算好的 (按分层费率 tiered)。**本波段将继续保留 `core/prices.ts`** (包含了经测试的折叠计算逻辑，并与 OpenRouter 价目表保持同步) — 没有任何行为上的变更。待到后续模型控制波段时，由于无论如何都将以模型目录为准轴，那时用 pi 的目录成本替换掉 prices.ts 是一项早就写在备忘录里的清理任务。
- 目录 (Catalog)：调用 `createModels()` + `openrouterProvider()`；我们现阶段首要跑通使用的模型 (`z-ai/glm-5.3-flash`) 是 **通过程序直接注册写入的 (registered programmatically)**（包括 id，提供商 provider，api 以及由我们自己的数据赋予的 cost/contextWindow/thinkingLevelMap），这是因为它并不在 pi 的静态目录列表内 (经证实：它确实存在于 pi.dev 的外挂清单中，但我们绝不在运行期依赖 pi.dev)。用来凭取 API Key 的 `getApiKey: provider → key` 方法当前由环境变量 (`OPENROUTER_API_KEY`) 提供；下一个阶段里，信源将被切至 `data/auth.json`，而不需要去碰该接缝的一丝一毫代码。

## 6. 子智能体 (Sub-agents)

五个子智能体 (研究员运行器 research runner、演示构建器 demo-builder、视觉制作者 visual-maker、提取器 extractor、审计器 auditor) 统统从那些手搓的 `generateText`/ToolLoopAgent 循环迁移到 `new Agent` 抑或 `agentLoop` 上，并沿用原本相同的那套 tools+streamFn 连线。用于中断的 Abort signals 则会被串入其中 (`execute` 的第三个参数)，用量依然由相同的底层事件折叠算出，且支持在各阶段通过调用 `calculateCost` 获取该段成本。这一切简直就是个机械的体力活；最大的改动面落在那个采用了分阶段打补丁设计的提取器 (extractor) 循环里。

## 7. 测试线束 (Test harness)

取代 `MockLanguageModelV4` (共 23 处) 的，是由脚本注入的 pi 端仿制品：
- 引擎层面 (Engine-level)：一个由脚本生成虚假 `streamFn` 并返回一套既定脚本化 `AssistantMessageEvent` 序列（包含文本、工具调用和终结符）的组件 — pi 的异步迭代器 (async-iterator) 形状要比 SDK 里的那套玩意简单得多。
- 桥接层层面 (Bridge-level)：采用黄金验证数据块 (golden-chunk) 去核对我们的 SSE 格式输出是否严格遵照验证通过的数据块形状（重点是针对连续 id 规则 (continuation id rule)、终结判定路径、断头孤儿修补 (dangling synthesis)、以及中止恢复动作 (abort salvage)）。
- 适配器层面 (Adapter-level)：`recordToPiMessages` 在各层间的穿梭与折返（包含答案处理、数据结构拼合、遭中途掐断的测验、以及针对计划接受 (plan-accepted) 的测试）。

## 8. 推行波段、门控与推迟的项目 (Waves, gates, and deferred items)

这完全是一波要么全上有么全无的原子级推进（毕竟引擎总不能切一半就发布了）：引入各依赖库 deps + 在 Next 的 `serverExternalPackages` 为 pi-ai/pi-agent-core 豁免 → 适配器 (§4) → 转移并挂载工具 tools port (§2，保留 zod 的用法) → 桥接层 bridge (§3) → 对 `chat-handler` 重新进行导线焊接 → 改造子智能体 (§6) → 全面移植测试 (§7) → 通过各道门控 (tsc 编译、运行全套测试用例、lint 扫描、build 打包) → **正式转舵时将彻底清空现有数据** (一项原则性清理；虽然因为这回根本就没动到记录存储的数据格式导致清不清空纯粹是个心理学问题而非技术必要，但此举维护了原则纯粹性) → 最后跑一遍 GLM 实弹冒烟演习：确保走通 探测→评估→转交→制订计划→打出判词→教学 (probe→assessment→handoff→plan→verdict→teach) 这套完整流程，并验证各类中止/抛弃路径（在中途砍断流、中止作业、中止提取），同时不报出一丁点控制台错误且能在状态条里算出分毫不差的统计量。

明确推迟解决的内容 (Deferred)：那些循环内的引导注入 (即在轮次进行中途的唤醒)；由 prices.ts → 向 pi catalog 取取成本信息的变迁；针对客户端频段 (D 频段 Band D) 所有权的最终宣判决断；脱离了 OpenRouter 之外的多供应商认证机制 auth (毕竟，上方写着的 `getApiKey`/catalog 两处接缝缝合已是将所有所需基础皆已夯实的见证)；顺带还有一份更新版的 pi.dev 叠加扩展包。

## 9. 带着开放标志带入到实施过程中的注意事项 (Open flags carried into implementation)

- 每个分派给文本/推理块的 Chunk `id` 必须在此条消息内部保持绝对唯一，并且在经历连续的转接回合里必须 **恒定不变** (倘若有 delta 块发给了那个已经挂掉或未激活的 id，客户端会立刻砸出一个抛错)。
- `tool-input-available` 要求在给定的 `input` 内填充一段合规的 JSON 值；pi 的设计逻辑是在工具调用宣告结束时才会把完全解析好的参数全部抖搂出来。
- 步数记账 (Step bookkeeping)：pi 里的 `turn` (轮) ≈ SDK 里的 `step` (步)；每进行一步所跨越的边界必须依然牢牢保留带有 `step-start` 标记的数据段，这是由于执行计划树模块的缝合 (plan-block splice) 及各种阶段时间线全靠扒着它们运作的 (拼接时完全锁定带 `tool-plan_init` 标识的工具段 — 不受此变动影响)。
- Next 切记 **绝不能 (must not)** 将属于 pi-ai 提供商的那些云端底层依赖 deps (比如 AWS/Google 各个 SDK) 也顺手一并给揉成面团塞进各个路由分发包里去 — 请善用 `serverExternalPackages` 豁免之。
- pi-agent-core 的天条是：每个 Agent `仅仅只能运行一轮` (`single-run per Agent`)（只要智能体还是处于活动期，再敢调用一次 `prompt()` 就等着被抛错吧）：但凭着咱们独创的那套基于每个新轮次必造出个崭新 Agent 的方案 (fresh-Agent-per-turn) 从根本上漂亮地绕开了它 (恰巧完美适配了咱们现行把着守卫大门的那套针对单写入器的一回合一动 (one-writer turn guard) 逻辑)。