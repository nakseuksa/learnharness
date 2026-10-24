# ⚠️ 已归档 (ARCHIVED) — 于 2026-09-18 被取代。请参阅 [`docs/architecture.md`](../architecture.md)。

这是审计前的架构规范（最后维护于 2026-09-08）。在一次全代码审计发现它与实际建成的系统存在偏差后，它已被取代；保留它仅仅是为了提供历史参考 — **请不要将其作为规范来信任，也不要更新它 (do not trust it as a spec, do not update it)**。

在此副本中已知的过时内容包括：单一的 `contracts.ts`（现在是六个领域文件），`everyNQuizAnswers` 的提取触发机制（现在基于 token 覆盖率），热点 (hotspot) + 1-跳 图谱上下文（现在基于语义 top-K），sigma.js + forceAtlas2 渲染（现在是手写的 Canvas 2D 渲染器 + d3-force），Louvain 聚类（现在是基于嵌入的凝聚聚类 embedding-based agglomerative clustering），`MockLanguageModelV4` 测试（现在是 pi-ai 提供的伪造提供商 faux provider），三个文件的存储列表（现在有五个适配器），以及自那以后已经发布过的曾被“刻意推迟 (deliberately deferred)”的特性（听写、笔记导入、嵌入、聚类、模型设置）。当前规范的决策历史附录记录了每一次的取代过程。

---

# 学习线束 — 架构 (Learning Harness — Architecture)

状态：**规范的目标架构规范 (the canonical target-architecture spec)** — 描述了实际建成的系统 (as-built system)（转型之后，重构阶段 1–5 完成）。转型前的 v0 版脚手架文档 (基于 pi，Fastify/Vite) 保留在 git 历史记录中；产品思考记录在 [`docs/vision.md`](vision.md) 中；逐文件布局说明位于 README 中。

**这是什么。** 一个独立的 Next.js 学习应用：学习者的知识将积累到一个持久化、跨会话的知识图谱 (knowledge graph) 中，该图谱基于辅导会话 (tutoring sessions) 构建。在这些会话中，教师智能体 (teacher agent) 编写正式且可见的依赖树（计划树 plan tree）并通过结构化的问题验证理解情况。图谱是应用的主页；会话是教室；其他所有一切都服务于这两者。

**设计原则，按优先级排列：**

1. **最大化控制 (Maximum control)。** 每条依赖关系 (dependency edge) 都是明确且由机器检查的。没有任何东西可以为了方便而进行横向调用。
2. **易于编辑 (Easy editability)。** 开发者可以将任何行为追踪到某一个文件中。分层 (Layers) 是按责任而不是框架的偶然性来命名的。
3. **零技术债务 (Zero technical debt)。** 你看到的形状就是系统运行的形状。废弃的代码路径直接删除，绝不搁置保留。
4. **清晰明了的架构 (Crystal-clear architecture)。** 一个契约文件 (contracts file)，一个组合根 (composition root)，每个存储对应一个写入者，一个触发接缝 (trigger seam)。只要一条规则可以写成 lint 规则，那它就应该是 lint 规则。

---

## 1. 架构分层 (The layers)

依赖箭头 **只能向下 (down only)** 指向。每一层都可以导入核心的“桶文件 (barrel)”；没有任何东西可以为了图方便而越过边界。

```
┌──────────────────────────────────────────────────────────────┐
│ SHELL (外壳层) app/            Next.js 路由处理器 (传输层 transport) │
│            components/     会话 + 主页 UI (仅负责渲染 render only)    │
├──────────────────────────────────────────────────────────────┤
│ SERVER (服务层) src/server      轻量级的组合 (thin composition)，零业务    │
│            逻辑：chat-handler (轮次的组合根)，       │
│            turn-service (轮次相关的接缝)，stores.ts           │
│            (核心的 THE 组合根)，路由入口点         │
├──────────────────────────────────────────────────────────────┤
│ AGENT (智能体层) src/agent       教师 + 子智能体 (sub-agents)：LLM      │
│            循环，工具表面 (tool surfaces)，提示词 (prompts)。依赖项通过      │
│            工厂/闭包 (factories/closures) 注入 — 绝不从下方导入     │
├──────────────────────────────────────────────────────────────┤
│ CORE (核心层) src/core        纯正的业务领域 (pure domain)：contracts.ts (唯一的 THE     │
│            模式 schema)，ports.ts，计划树 (plan-tree)，问题核心 (question-core)，       │
│            图谱合并 + 派生 (graph merger + derivation)，图谱上下文 (graph-context)，          │
│            阶段 (phases)，待处理项 (pending)，数学定界符 (math delims)。绝对没有任何 IO (No IO, ever)          │
├──────────────────────────────────────────────────────────────┤
│ STORE (存储层) src/store       fs (文件系统) 适配器：聊天 · 图谱        │
│            账本 (ledgers) · 任务 (jobs)。这是唯一 (ONLY) 会接触       │
│            data/ 目录的模块。它们负责实现核心端口；而没有任何东西能          │
│            实现它们                                   │
└──────────────────────────────────────────────────────────────┘
```

**导入法则 (The import law)**（`eslint.config.mjs`，由机器强制划分的四个区域 — 违规会导致 lint 失败，且每个区域都已经过验证能正确触发报错）：

| 区域 (Zone) | 允许导入 (May import) | 理由 (Rationale) |
|---|---|---|
| `components/**` | 仅 `@/src/core`（桶文件） | UI 渲染领域数据；它从不运行领域逻辑或接触 IO |
| `app/**` | `@/src/core` + `@/src/server`（桶文件） | 路由处理器 (Route handlers) 是传输层；它们将工作委托给服务层的入口点 |
| `src/core/**` | 不能导入其下方的任何内容 (绝不能导入 `agent`/`server`/`store`) | 核心是纯粹的；是适配器实现它的端口，绝不能反过来 |
| `src/agent/**` | 绝不能导入 `server`/`store` | 智能体层通过从服务器层传来的工厂/闭包接收它的依赖（存储端口 storage ports，线路连接 wiring） |

有两条规则在设计上仅以文档形式存在：`src/server/stores.ts` 是唯一允许导入适配器 (adapters) 的服务器模块（ESLint 插件的 `except` 规则无法干净利落地表达“除了一个以外的所有”），而 `src/core/graph.ts` + `graph-context.ts` 不包含在核心桶文件中，从而保证桶文件对于浏览器的安全性 (browser-safe)（它们的类型依然通过 `ports.ts`/`contracts.ts` 集中导出）。

---

## 2. 端口、适配器以及组合根 (Ports, adapters, and the composition roots)

存储采用的是 **各实体专属的语义端口 (per-entity semantic ports)**，而不是一个大一统的泛型接口：`ChatStore`、`GraphStore`、`JobStore`（`src/core/ports.ts` — 仅包含类型定义）。fs 适配器 (`src/store/{chats,graph,jobs}.ts`) 实现了它们，并且仅仅包含了数据持久化的逻辑，此外别无他物。

- **`src/server/stores.ts` 是统领所有存储的唯一组合根 (THE composition root for storage)**：它实例化各种适配器并将端口对象分发给其他一切模块 (服务器模块、任务运行器、提取管道、智能体工具)。这里是唯一能够重新指定存储决策（比如 JSON 还是 SQLite，本地还是远程）的地方。
- **`src/server/chat-handler.ts` 是统领每个对话轮次的组合根 (THE composition root for a turn)**：它负责将各个存储模块、任务运行器、教师工具以及轮次服务连接进 SDK 流式响应中。所有的业务逻辑都生活在它所调用的接缝 (seams) 的背后。
- 智能体层自始至终遵循依赖倒置 (dependency-inverted) 原则：`createJobRunner({ chatStore, jobStore, deliver })` (其中的 `deliver` 接缝负责将引导指令 steer 传递给唤醒管道)，`createExtractionPipeline({ chatStore, graphStore, extractor?, auditor? })`，`createTeacherTools({ chatId, chatStore, jobStore, spawn })`，`createTeacherAgent(model?, tools?, graphContext?)`。测试环境里所注入的也是生产环境里的这同一套端口连线。

---

## 3. 知识图谱 — 两条管道，唯一的写入者 (The knowledge graph — two channels, one writer)

**提取管道是唯一的图谱写入者 (The extraction pipeline is the sole graph writer)。** 除此之外没有任何东西能往 `data/graph/*.jsonl` 文件追加内容 — 教师不行，服务器不行，甚至数据迁移脚本也不行。

```
聊天记录 (chat record) ──▶ 提取器 EXTRACTOR (LLM) ──▶ 审计器 AUDITOR (LLM) ──▶ 合并器 MERGER (core, 确定性的) ──▶ 账本 (ledgers)
                            提出 (proposes)             验证 (verifies)            应用 (applies)
```

**无视树结构及事后诸葛亮机制 (Tree-blind and post-hoc)** (2026-09-02 的重新设计，见 docs/vision.md §1)：提取器仅读取转录记录 (transcript) — 绝不去看会话的计划树 — 并且根据这些信息自由提出各种命题 (没有误解的真实断言，如果遇到误解则用纠正后的真相来表述)，提出 `follows` (派生于) / `supports` (支持) 的关系边缘，还能给出每个命题的理解水平批注，并且附上精确到消息级别的来源凭据。图谱上的每一个节点都是代表这个世界客观规律的真相；学习者与这些节点发生的关系则统统只记载到事件账本 (event ledger) 当中。

**责任分工制 (Division of trust)** (管道运作的核心法则)：几个跑在 LLM 阶段的过程只负责输出判断结论 — *具体学到了啥*、*到底是谁推导/支撑了谁*、*每一次测验到底在考量图谱上的哪个命题* (在事后拿整个转录记录重走一遍)，以及 — 属于审计器职权的 — *身份认证问题*：确认某个命题到底是不是图谱里早就有的某位老熟人 (即链接或新建 link-or-create)。像事件种类 (`correct` 对 / `miss` 错 / `dont-know` 弃权)、时间戳、防重放凭据、批注、原始凭证位置这些模型可能在背后静悄悄给你抄错的东西 — 统统交给负责打下死手的合并器，由它依据转录记录里留存下来的工具信息进行机械性且绝对精准的重建工作。提取器专门记录原文中用过的真凭实据字眼；而审计器 (能同时统揽提取器的输出和当下整个图谱的状态) 会负责砍掉一切缺乏实据支撑的信息，不仅把每一次刀下留魂的过程登记在案，而且还会给幸存下来的每一个命题敲上一枚身份认证大印 (`linkTo` 结果结论)。全过程贯彻保守疗法：宁可弄出重复建档，也绝不能放任发生错误的合并行为 (duplicates over wrong merges)，宁可直接扔掉也绝不能容忍凭空捏造 (drop over invent)。

**合并器的护法铁律 (Merger invariants)** (`src/core/graph.ts`, `mergeFindings`)：做到具备幂等特性且可逐步推进 (idempotent and incremental) — 身份标识完全取决于审计器的 `linkTo` 判决结果 (对照账本进行验证；绝不使用字符串匹配)，每次通过 (聊天记录, 来源Id) 的配对留下一行映射记录作为判定审计追踪 (这也使得同一聊天的重复合并具备幂等性)，同时包含追加链接：一个被链接的命题会追加一行节点信息，将其不同措辞加入节点的 `aliases` 别名中，并取来源的并集 (读取时按 id 合并)，基于在该聊天中已被断言过的 `(from, to, type)` 进行带消息级精确来源的边去重 (edge dedupe)，基于聊天范围引用的事件去重 (如测验的 toolCallId，给理解评估观察用的 `obs:<sourceId>`)，以及在 sessions.jsonl 中打上一个检查点 (`foldedAt`) 来标记哪些轮次已被处理。在合并器写下检查点之前的任何环节失败都不会留下记录；在下次触发时会重新运行。

**触发器是一个 v1 版本的占位符，且被隔离在唯一的一个接缝处 (The trigger is a v1 placeholder, isolated in ONE seam)。** `src/server/turn-service.ts` (`triggerExtraction`) 负责统计尚未记入账本的已回答测验数量 (`pendingQuizAnswers`，位于核心层)，一旦一场聊天突破了 `EXTRACTION.everyNQuizAnswers` 的数量 (默认 3，在 config.ts 中配置) — 就会针对每场聊天以单路 (single-flight) 模式异步发射。这个管道是跟触发器解耦的：若是以后有了更好的触发机制（例如在会话结束时、空闲时或明确的冲洗指令），只需修改这一接缝处即可。

**读取通道则是纯纯的派生物 (The read channel is pure derivation)。** `GET /api/graph` 会去读取那些账本 (`graphSnapshot`: 在里面合并边缘、派生出节点的状态、以及回溯会话来源) — 主页视图则永远不会触发哪怕一次的写入操作。在会话开始之际，`buildGraphContext` 会把派生而出的图谱渲染成一个紧凑的 markdown 小方块，接着将其贴到老师的教案指令后面（如果图还小就放全图；若节点过了 150 个，那就只上病历诊断重点区 + 周边一跳邻里的热点图）— 就是这手操作让接下来的探底提问能一针见血，而且让那份因人施教的个性化成果能在往后岁月里层层加码、越垒越高。`只能存事件，状态全都现场推 (store events, derive state)`: 任何节点的状态地位永远都是依靠账本的数据现场推算出来的，绝不是直接把“它目前啥状态”这种死数据给存在哪。

---

## 4. 单场会话的始末 (The session (one chat turn))

`handleChatRequest` 是无框架的（它就是个纯粹的 `Request`/`Response` 处理器），所以能极其方便地用事先写好剧本的模拟大模型来给它做测试。一回合的构成为：

1. **`buildTeacherContext`** — 这是看图谱信息的通道（它不仅自带更新功能，而且还把出错影响面控制住了：哪怕去取数据的过程中报错跌了，也绝不会让整个上课进程跟着一起陪葬）。
2. **`persistTurn`** — 是掌管正统大权的存档落锤：不管你是客户端发的还是大模型出来的消息，只要在这个回合结束那一刻，哪怕中途惨遭中断（aborts）也统统都得存进档案里（正是这份看似断臂缺腿的半截转录本，成就了所谓的即便中途断掉答题也能不花半分钱就无缝重新续上的奇迹（resume-mid-question free））。
3. **工作台里的差事全是跑在服务端的、只需确认即可引航的做派 (Job tools are server-executed, ack-and-steer)** — 例如发给 `research`/`demo`/`visual` 的调遣令会在那一回合中途当场抛出一个“知道了就去干”的免责签收回执后结束（授课的大老师该接着讲就接着讲）；`spawn(job, input)` 这时便会在后台拉响那跑腿的差事。活一干完，这个后台跑腿的就会攒出一条 **带向导意义的消息 (steer message)**（表面是一条批着用户身份外衣的 `UIMessage` 并在其正文部分写上了说给大模型听的通报 — 以及外挂在 `data-subagent-artifact` 里的那份专门呈给客户端赏玩的实体制品，当然如果要丢给供应商换代币时这类夹带会被无情丢弃）之后就会将它移交给 **唤醒大管线 (wake pipeline)**（`src/server/jobs.ts`: 在 `globalThis` 上挂着的一根只讲先来后到的专门认聊天包厢名的死脑筋排队管；它会苦等到这包厢闲着且没啥烂测验题卡着时，直接通过 chat-handler 里头的 `setTurnRunner` 接缝适配器直接在服务端发起一波由老师自己发言的攻势回合，还支持 409 防冲突重试机制，对准同一个 jobId 做到打死也不干重样的活）。工作任务的状态只有当这波发动的唤醒回合被彻底登记入库后才会标上已干完（done）或搞砸了（error）。至于客户端这边则是顺着它现成的那套用来搞半道连回去的大招机括 `turnInFlight` 救场系统（这不仅带那忽闪忽闪的忙碌提示动画 + 还不让你这时候乱在底下回话 — 这点跟半道无缝返回局里的待遇别无二致）直接把这波唤醒回合当自己人给接盘了，最终那些向导信息都会作为展示柜里的物件挂出来，绝不会出现在那大路货的气泡聊天框里。
4. **`triggerExtraction`** — 掌握着往图谱里写记录生杀大权的那根排污管 (§3)。

每个服务都是一个拥有响当当名号、出了乱子绝不殃及池鱼的接缝（seam），必须显式指明需要些什么靠山大树才能运作；万一崩了也就是冷冰冰在那日志里甩下一行打着 `[chat <id>]` 烙印的印记了事，绝不敢沾染任何回复的包袱半点。哪怕你想着要把这堆东西里的谁谁（比如那位大总管触发器）给扒下来换个种，你也休想伤到旁人分毫。

**正式版的定海神树 (The formal plan tree)**：授课大师靠着那些套在规矩里的法器 (`plan_init` … `plan_mark_done`) 把该传下的大计版图定下来；这神树不仅死死烙在聊天档案里不走，而且那块用来向外人显摆的树面板也是拿着这工具最后吐出的新鲜计划生生复刻出来的 — 就是同一个主子，长了两张应对上下的脸。**客户端这头的出题法宝 (Client-side question tools)** (`quiz`, `ask_user_question`) 在服务器里头那是半点开火权也没有：它只管把题目化成水管里的流沙冲向浏览器，然后就是学习者在停靠栏里面答题的时间，客户端顺手拿 `question-core` 打好分，连本带利把那道判词经由 `addToolOutput` 扔回去，随后便点燃了往下继续的导火索。

---

## 5. 看得见的透明化把控 (也是从简决策) (Observability (minimal, by decision))

目前搁置了结构化的日志记录框架；其基准是在各个接缝处为每个事件输出一行带有相关标签的日志：在轮次服务上标记 `[chat <id>]`，在管道上标记 `[extraction <id>]`（包含合并统计、审计丢弃），在运行器上标记 `[job <id>]`，在服务器图谱读取上标记 `[graph]`。将来落地结构化日志（类似 pino 风格的 JSON 格式，带有 `{chatId, jobId, toolCallId}`）时，它将被放置在这些接缝的后面 — 所有调用点都不需要改动。

---

## 6. 测试体系 (Testing)

所有的测试绝对都是按照刻度来的确定性走向，休想惹上半点网络请求：各个假人模型全是扎针注入进去的 (`MockLanguageModelV4`)，至于那库房则一律照搬了那些个要在前线扛枪干活时的老面孔 fs 适配器 (这些去干查水表验核的测试本身自备了那一套从备份带清仓一条龙的后勤活计)，剩下的纯讲理的路子统统由内存里供着的插座管线大包大揽了。天下分作四大阵营：纯粹只看理的各路核心大仙班；直接端出那套注入好剧本套路的大模假人顺着 `handleChatRequest` 跑大长途的车把式流程大练兵；专司外包脏活累活各种循环转圈的子智能体连轴兵团 (像什么包打听的、搞沙盘做前台样板的、包捏泥人画画的，还有那一连串打假提纯清算到底全链路流水作业管道 — 它可是敢做敢当，不合意就砍、中途崩盘绝对不留半点污点检查账本而且认准了死理单飞单挑上阵的)；以及跑在用 React 服务器直出手段做的渲染大关检测。每一回不管你想换下哪根毛发，都必须先过了这帮铁面阎王的大门限：过 `tsc` 拔光秃子，打通过所有的试卷大阵，让 `eslint` 清零，最终还能让 `next build` 搞出无暇成品。

---

## 7. 那些被有预谋的雪藏压箱底大单 (包含指路牌) (Deliberately deferred (links))

比如模糊或嵌入的合并裁决算法，基准对齐校准的评分尺码，从那陈年的原型机 (POC) 会话堆里重新溯源拔出底气 (愿景 §1 中的夯实融合阶段)；什么听写识别功能，不该把它弄得像是个聊天的门面装潢大整修，那些有门有槛必须解锁的晋级途径，以及用来防遗忘的抗遗忘复习机器 (愿景 §2/§4 蓝图大计)。要想给底下的数据库换个 SQLite 或其他什么器皿，只需在那些接口后面轻松替换就行了 (§2)。有关逾越 v1 版本的只拿回答次数来充当发令枪打把的提取触发器 (§3)。不管上面的哪项真能破土而出落地了，那这份卷宗就会和把这玩意扶上位的那个呈堂证供 (commit) 一块与时俱进 — 因为这份文书是为记下那些在这世上真活着的系统而作，绝不为那些空头支票背书。