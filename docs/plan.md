# 构建计划 v1 — 从愿景到系统 (Build Plan v1 — from vision to system)

针对 `docs/vision.md` 的执行计划。章节引用 (§) 均指向该文档。本计划并非事无巨细 — 它是具有依赖顺序并且配有验证门控 (verification gates) 的波段结构。编写于 2026-08-22。

## 执行模型 (Execution model)

- **工作者们 (Workers) (GLM 5.3) 负责实现一切。** 每一份任务简报 (task brief) 均包含：明确的文件所有权 (file ownership)，用于编写代码的契约 (contracts)，验收标准 (acceptance criteria)，以及常设指令 (standing instruction) — *当任何事情未做决定或存在歧义时，请通过提问工具向协调者 (orchestrator，即我) 提问；绝不要去靠猜来确定细节。*
- **协调者 (Orchestrator) (我) 拥有 (owns):** 共享的契约文件（第 0 波段 — 其他所有东西都依赖于它；这里的失误将会毒害下游所有的工作），所有基于浏览器的验证（只有我才拥有浏览器工具），门控审查 (gate reviews) 以及问题升级 (escalations)。
- **向用户升级 (Escalation to the user):** 只有当出现了真正全新的、我们从未讨论过的实现/设计决定，且它带有意义重大、难以撤销的后果时，才会将其升级给用户。其他情况全由我做主并记录下来。
- **依据文件所有权的并行工作 (Parallelism by file ownership)。** 处于同一波段里的各个工作者，将会领到互不重叠的文件清单。若想触碰你清单之外的文件，必须先问过我。每个工作者离开时必须保证各个门控一路绿灯：`npx tsc --noEmit`, `npm test`, `npm run build`。要求每次提交 (commits) 的范围必须尽可能小；我在各个门控处进行代码审查。
- **提示词架构 (Prompt architecture):** 将教师智能体的系统提示词拆解为拼接片段 (`src/agent/prompts/*.md`)，如此一来并行开工的工作者们就能各自向里面塞提示词的段落，而不用挤在同一个文件里产生冲突。

## 第 0 波段 (Wave 0) — 契约 (由我执行，在任何工作者派生之前)

`src/core/contracts.ts` + 各大存储格式：包含了 `PlanTree`/`PlanNode`/`PlanEdge` 类型以及工具的 I/O 数据结构校验模式 (vision §2 计划树 plan tree)；`GraphNode`/`GraphEdge`/`LedgerEvent` 的类型定义 (§1, 同一基础底层 substrate)；为测验/提问工具 (quiz/ask tool) 的输入增加了可选参数 `nodeId` (结果将会给节点打上标签)；聊天持久化里增加 `tree` 字段；`data/graph/` 的存储格式；未来新加的人工制品类型所能扩展用的片段渲染接入点 (part-renderer extension points)；异步任务 (async-job) 协议（见下方）。

**异步子智能体协议 (Async sub-agent protocol) (在此确立):** 发起一个子智能体工具调用 (sub-agent tool call) 时，会在服务器端创建一个任务 (job)；在此期间聊天里的工具片段 (tool part) 会一直保持着 `input-available` (输入就绪) 的状态，并挂载着它的 `jobId` 继续运行（非阻塞 — 教学仍将继续）。一旦大功告成，服务器会将该片段覆写为带有输出结果的 `output-available` (输出就绪) 状态，而此时客户端 (仅在此类任务活跃期间进行轮询 polling) 将自动捡走它；利用现有的 `sendAutomaticallyWhen` 触发延续动作 (continuation)，于是那位教师便像接到一次普普通通的工具输出一样，接收到这笔结果。同样还是这个片段数据，也将肩负起为活动指示器 (activity-indicator) 输送数据源的任务。

## 第 1 波段 (Wave 1) — 三位并行工作者

- **W1 · 计划树工具 (Plan-tree tools)** (§2 "正式的计划树 formal plan tree"): `src/core/plan-tree.ts` (纯净的经校验的操作方法: add_node, add_edge, reparent, remove, set_current)，智能体的工具外表面，挂在聊天存储下的 `tree` 树数据持久化操作，用于计划树编写的提示词片段，外加单元测试。
- **W2 · 子智能体基础设施 + 研究员 (Sub-agent infrastructure + researcher)** (§2.5): 服务器端的异步任务运行器 (一种有着严格限制工具集的智能体循环、附带状态事件与任务存储机制)，即前文第 0 波段中说好的异步协议，在服务器端挂载 `web_search`/`web_fetch`，移植研究员的提示词，给教师智能体配上 `research` (研究) 工具，极其简易版的活动指示器 UI + 客户端侧的轮询，最后是用虚假大模型跑的各种测试。
- **W3 · 展现问题修复 (Presentation fixes)** (§3): 将 LaTeX 公式界定符强行切换至 `\(...\)` / `\[...\]` (通过前处理加上提示词片段；让 `$` 乖乖去当货币符号)，校验并消灭那该死的换行错误 (很可能是 `remark-breaks` 搞的鬼)，提供一个像样点的 mermaid 渲染组件 (做到整合在一起、能够正儿八经地缩放平移)，以及写好测试。

**门控 1 (Gate 1) (我，在浏览器中测试):** 确保既有的老会话依然能干净利落地加载出来；在一个实时会话里通过大模型编写一棵树 (校验 JSON 格式是否正确)；能正常渲染新的数学公式定界符且让 `$` 乖乖只作货币符号；mermaid 正常渲染；研究 (research) 任务能开启一个伴随有实时指示器的异步运行流，而且教师能借助接续 (continuation) 流程正确回收结果。以上门控全部绿灯通过。

**门控 1 测试结果 (GATE 1 RESULTS) (2026-08-22, 通过 PASSED):** 旧会话渲染一切干净，控制台 (console) 零报错。利用链式求导法则 (chain-rule) 的实时会话，通过 plan_init + plan_set_current 成功编写出了一棵挂着 4 个节点的树，并将其持久化到了聊天记录里。整节课中 \(…\) KaTeX 的表现完全无懈可击。Mermaid：合法的图表可以正常套用在暗色主题下渲染，还能用缩放/平移框框 (pan/zoom chrome)；如果是大模型吐出的代码有语法错误，则优雅降级到了 W3 特供的深色后备箱上去了 (通过修改提示词修好的: 加了条必须给标注套上引号 label-quoting 的死规矩)。研究任务老老实实跑了 88 秒，并带出了带有实时动静的 `web_search:`/`web_fetch:` 活动反馈行；最后也老老实实带回了出处简报。**发现+修复 (Found+fixed):** setMessages 根本就没有唤醒 sendAutomaticallyWhen (原来 SDK 这家伙只在 addToolOutput 里面下钩子) — 于是，现在 syncFromServer 也顺带包办了延续动作 (continuation) 的触发，另外还在组件重载的路上加上了应对重启挂载时触发延续动作的效果 (mount-continuation effect)。另外奉送的根源修复 (Bonus root cause) (W3)：少了 streamdown `@source` Tailwind 指令，结果直接把所有的 streamdown 框框 (streamdown chrome) 给搞成了零样式 (unstyled)。

## 第 2 波段 (Wave 2) — 三位并行工作者

- **W4 · 图谱存储 + 首页视图 (Graph store + home view)** (§1): 编写 `src/core/graph.ts` (模型，基于会话树 + 带标签的测验结果，进行天真的合并式的数据分发 emit)，建设 `data/graph/` 的存储机制，在聊天落幕 (chat completion) 时激发数据传输，搞定 `GET /api/graph`，写好 `components/graph-view.tsx` (基于 sigma.js + forceatlas2 算法，采用先运算后冻结 run-then-freeze 的手法，配合根据不同状态上色的机制，加上缩放才能显示的标签，缩放和平移功能 — 完全按照先前的渲染规划执行)，搞定跟主页大盘的融合接入，外加一份含有两千节点负载压力的合成基准压测脚本，当然，还有测试。
- **W5 · 阶段划分与考题揭示 (Phases & question reveal)** (§2 "两个阶段 two phases"): 提供 探测→教学 (probe→teach) 结构化标志位 + 转录本的分隔线，确保处于教学阶段 (teach-phase) 的那些考查项统统躲藏在一个展开按钮之下 (就是 QuestionDock 的那一套变体玩法)，而探测阶段 (probe) 则保持该自动打开就自动打开的属性。*这里有个简短警告：在 chat.tsx 里的那套搞滚动与防抖 (scroll/hysteresis) 的状态机，可是个承重墙级别的活儿 — 所以代码 Diff 越小越好。*
- **W6 · 演示制品 + 构建器/视觉效果工作者 (Demo artifacts + builder/visual workers)** (§2 demos + §2.5): 完成从 `demo` (演示) 工具片段到沙盒中的 iframe 渲染器的转变 (含自适应调整桥 resize bridge，报错提示块 error chip，修复闭环 fix loop)；打造那个发货前先跑无头测试 (headless tests) 的 演示构建器 (demo-builder) 子智能体；完成视觉制作者 (visual-maker) 子智能体 (这是从保险库 vault 中 `svg-maker` 移植来的版本: 实现 编写/修改/渲染 + 根据图面验证 verify-by-looking)；加上 SVG 块渲染器，以及测试。

**门控 2 (Gate 2) (我，在浏览器中测试):** 全旅程检测 — 全新的教学话题：探测阶段能够自动拉开 (probe auto-opens)；计划树能正常搭建出来；教学阶段的考察题会处于折叠态且展开按钮完好可用；首页上的那张具有布局冻结态势的图谱也能显示无虞；演示小组件 (demo artifact) 在沙盒化保护下渲染并且 SVG 正确送达；所有关于滚动的行为都要过一遍防退化大盘排查 (regression-checked)。以上全部绿灯通过。

**门控 2 测试结果 (GATE 2 RESULTS) (2026-08-22, 通过 PASSED):** 完整版现场检验 (课题依然是链式求导，教师智能体 = 通过 `LH_MODEL` 挂载的 GLM 5.3)。探测阶段按预想地弹了出来 → 没答上来 → 于是教师随势调整了教学套路 → 触动 `plan_init` → "正在教学 (Teaching) · 4 个节点 (nodes)" 分界线赫然在列 → 然后就看到教学的那些考考你乖乖躲在了 "检查你的理解情况 (Check your understanding) › 展开 (Open)" 的引导大门后 (特地截了图存了证)，一点击立马就乖乖现形，再也没有滚到底下自作主张给自动弹开的事情。演示 (Demo) 方面：构建器只写了并顺带在无头环境下自己验证通过了那总共 16 KB 的 HTML 代码；带沙盒环境约束的 iframe 照样能渲染开来 (已核验过隔离源 opaque origin 的情况)，且尺寸桥 (resize bridge) 运作自如 (直接撑到了 1111 像素)。图谱 (Graph) 方面：这会儿在通过 sigma/forceAtlas2 的加持下首页上已经能清清楚楚看到那四个呈现链状排布 (chain rule) 的节点了；调用 `/api/graph` 能显示出已有 3 个状态在教，1 个处于候选期；同时，总账本也一丝不苟地依靠了幂等性参考线机制将 没蒙对 (probe-miss) / 检得准 (check-correct) / 检得虚 (check-incorrect) / 授毕 (taught) 这些动静全部封存在了里头；跑一波 `foldStaleChats` 也非常听话地替建树操作前的老底子会话统统顺利兜了回去 (毕竟在之前那些测验就是拿来做探测事件 (probe events) 用)。视觉效果 (Visual) 部分：第一回算是很有风度地砸了牌子 (GLM 5.3 它是只认字的呆子 — "没摸着哪个 API 支持能吃下那图像 (No endpoints found that support image input)")；报错的警示牌连带着那极具坦诚感的教师续接机制全都完好显现了出来；后来给它老实巴交在 .env.local 下锁住了 `LH_VISUAL_MODEL=anthropic/claude-sonnet-4.5` 就啥毛病也没了；紧接着在这个完全能够自成一派环境里，它通过了 (画完 → 渲染 → 自己瞅一眼验证) 干净利落的一次成型动作。各个门限的脾气都很稳定：无论是处于悬而未决的测验局或是没跑完的任务局时，这边的文本编译器 (composer) 都被封得严严实实；至于任务挂在那，它的延续动作自然也是滴水不漏地健在着。只有个东西是不能直接通过浏览器的：那基于 sigma 上点着节点时冒出来的覆盖层是不受待见的 (合成的那套指针点击流可到不了这接管了 sigma 场子的头儿那儿的；不过那套针对这种操作所配套的各种细项测试单元早已布下天罗地网，所用之数据也是能借 API 对上板的)。

## 第 3 波段 (Wave 3) — 两位并行工作者

- **W7 · 右侧面板中展示的树状视图 (Right-panel tree view)** (§2 "持久化展示的树视图 persistent tree view"): 可以按需折叠的右侧挂件栏 (right panel)，各个节点当前的状态 (已完成 done / 当前 current / 即将到来的下一步 next / 未来的计划 upcoming)，能用荧光笔亮标出当下的进度，还拥有折叠收拢变条的形态 (collapse-to-strip)；此外，这一切还得能在丝毫不搅合到整个底部问题停靠栏 (dock) 的前提下被融入到主会话布局当中去。
- **W8 · 所谓的低配版内容夯实工作以及让图谱在背后推流当背景知识的功能 (Consolidation-lite + graph-as-context)** (§1): 将整个图谱当成一段引子给注射到会话初始时刻，属于教师的系统提示大框中 (当图谱还不大的时候那就把全图都放进去好了 + 若是查到痛点便按需要截取部分 — 完全依照 §1 里制定的分段下菜看药策略，从最不花哨的一套入手)，再挂入校准过标尺的准星用来套到事件身上，去大范围地强化一下那只靠“字面瞎碰 (naive)”的归并功能上的短板 (支持根据确凿的等长字符串匹配 (exact/alias matching) ；至于那些还得祭出全员全套打上标记搞语义融合然后再做断层裁决的大工程 (full embed+adjudication merge) 现在还得接着给憋着、往后排，只有一些小修小改才能现在入场)，以及测试。

**门控 3 (Gate 3) (我，在浏览器中测试):** 有关于侧栏那个树节点面板的各种习性检测；拿个已经被啃过的教学旧主题再去试开个新会话局，这要能真真切切从探测端看出来那种它能认得你底细，属于个性化探探门道的操作才算数 (可以扒开注射过的底细探查个究竟)；最后来上一回彻底从头扫到尾的防退化清查回扫 (full regression sweep)；跑通所有门限。

**门控 3 测试结果 (GATE 3 RESULTS) (2026-08-22, 通过 PASSED):** 这个树挂件可算是在那儿规规矩矩按拓扑排布的顺序亮出了 4 颗节点来，而且还非常显眼地标注了“进度 3/4”外加显示出眼下卡在第几块节点；这能“折叠起来缩在个栏条 (collapse-to-rail)”的操作也被利用上了 localStorage，即使是按了刷新之后那状态一样不会被冲跑并且还能按老样子再次给完全敞开。另外实操演示证明那种私人订制式探底动作算是通电启用了：一个上来直奔主题要求“跟我讲讲乘法法则 (teach me the product rule)”的全新对局才拉开阵势，立马就是一番 "好久不见了！我看咱们此前算是携手迈过了链式求导 (chain rule) 的考验 — 将合成全折腾成了一架架流水线上的工位、从那各种转动的齿轮里套出层层的比率叠加、也把相关的死公式背过手来了" — 这正是那教师将刚刚注射入它脑袋里带入的一堆老旧图谱知识读得滚瓜烂熟的印证 — 它随即便顺势往下在基础点上抛出了打探探测的手法。主页上的这幅大图和那一圈清查式防退化回扫 (regression sweep) 全过、干净清爽。附送观察日记 (Follow-up observed)：这位 GLM 大老师不知为何有时候会在发测验卷子时它自己脑子里想好的正确答案，居然怎么套都没法扣上给选项定的任何一根线路上 (这就全靠问题判定核心 (question-core) 那里死盯着，并随之做了优雅的容错回滚方案) — 这是一个要对模式校验或是要上强力提示词纠偏的种子选手 (schema/prompt hardening candidate)。

## 延期搁置的事项 (Deferred) (已记录，未包含在此计划中)

听写功能 (Dictation) (§2)，那种绝非聊天软件外表、带有实质革新样貌的陈述型改造工作以及搞起结构化特征 (structural-identity) 的杂项 (§2, 低优先级 LOW PRIORITY)，向正规军数据库发起的大进军大迁移 DB migration（现在 JSON 存储完全已经应付得了），回溯性质般去把那些散布在近 15 个原型小灶 (vault POC sessions) 里的陈年老历史资料全都用上自动化手段挖一遍的工作 (还得一直等到那个完整的大后勤数据清理编排萃取管线全做出来再说)，搞定抗遗忘的间歇性重复练习功能 (spaced repetition)，实操习题测试，套上 Electron 变身桌面应用，外加弄个 Pyodide。

## 完工定义 (Definition of done) (针对每一波段)

tsc 编译不报任何报错 · 所有测试案例全部绿灯跑通 · 打包 (build) 成果干净无瑕疵 · 这边把由浏览器门控检查后的结果一一清清楚楚如实记录在册 · 各个针对专项定点出手的 commits 皆已被妥当约束在指定边界区域内 · `vision.md` 下记载了各项长征路线的规划小方块皆已被点上打过勾 · 各相关记忆片段 (memory) 均已被同步更新。