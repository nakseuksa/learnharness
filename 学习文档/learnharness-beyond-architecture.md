# 彻底掌握 LearnHarness：技术架构之外的七大关键知识维度

> 说明：本文档完全基于仓库源代码与英文文档推导整理，未参考任何既有中文学习资料。

如果只掌握 LearnHarness 的**技术架构**（如 Next.js + Electron 双进程拓扑、基于 Pi 的无状态单回合 `Agent` 重建、JSON/JSONL 持久化、双通道 SSE 事件流、后台任务队列等），你只理解了“字节与控制流如何运转”，但一旦去改 Prompt、调整工具 Schema、改动交互按钮或解读磁盘数据，极易直接破坏系统的核心不变量。

从代码实现与英文文档来看，LearnHarness 是一个**将教学法理论、认知心理学、知识本体论、LLM 行为缺陷防御与产品交互铁律直接“编译”进代码契约**的系统。除技术架构外，要彻底掌握它，还需要掌握以下 **7 个维度的关键信息**：

---

## 1. 核心教学法与认知科学理论（系统的“第一性原理”）

代码中的阶段划分（`probe → plan → teach` 与独立的 `practice`）和工具约束并非随意设计的流程，而是严格对应一套成文的学习理论（见 `docs/teaching-methodology.md`、`src/agent/system-prompt.md`、`src/agent/prompts/`）：

* **学习的终态定义（Self-Evidence & "The Click"）**：
  * 系统的目标明确**不是**背诵、做对题或覆盖知识点（coverage），而是让目标概念对学习者而言**“感觉显而易见地为真（feel obviously true）”**。
  * **认知锁定机制（`src/agent/prompts/teacher/05-method.md`）**：大脑如果担心某个事实未来会被更底层的事实推翻，或觉得它纯属人为规定（arbitrary），就会保留怀疑（hedge）而拒绝长期记忆。当孤立事实坍缩为由少数基础事实推导出的生成结构时，就会发生顿悟（**The Click**：从 knowing *that* 变成 knowing *why*）。
* **教学的两大放置动作（Principle i & Principle ii）**：
  * **Principle i（无条件真命题优先，Unconditional Truths First）**：先建立无需附带“通常情况下……”等限定条件即可直接接受的底层事实。文档严格区分了 **Unconditional truth**（认知属性：如何被大脑安全接受）与 **Axiom**（图拓扑属性：无入边的根节点）。
  * **Principle ii（受动机驱动的发现式推导，3Blue1Brown 准则）**：每一步推导都必须先呈现“为什么要往这个方向想、它解决什么问题”，消除任意感。
  * **单步推进与即时错误定位**：教学严格每次只走**一个推理步（one reasoning step）**并立刻验证，绝不在未验证的步骤上继续搭建，从而让误解在发生当刻被精准定位。
* **两项独立优化目标（`docs/teaching-methodology.md` §7）**：
  * **精力分配优化**：最大化学习者直接花在学科内容本身上的挣扎（struggle locks it in），将一切**后勤负担（logistics：规划路径、查资料、核实事实、决定顺序）压缩为零**，全部由 Harness 吸收。
  * **最小依赖树（Minimal Tree）**：已掌握的前置分支必须剪除，偏离目标的旁支再有趣也不教。
* **Prober 的“高位切入二分搜索”法则（`src/agent/prompts/prober/10-probe-doctrine.md`）**：
  * 探测阶段严禁从基础题“热身”，必须从接近目标上限的高位切入（*Enter near the top, not the bottom*），在每条依赖链（strand）上通过答对/答错 + 自信度快速夹逼出理解的下界（floor）与上界（ceiling）。
* **Teacher 的 `predict → teach → check` 微循环（`src/agent/prompts/teacher/28-predictions.md`、`30-question-principles.md`）**：
  * `type: "predict"` 在讲解**前**抛出，用于制造动机（不要求此时能推导出来，UI 中**直接展开**以阻断后续阅读）；`type: "check"` 在讲解**后**抛出，要求必须能从本节内容推理得出且优先考察应用而非复述（UI 中**默认折叠**在按钮后，绝不打断阅读）。
* **Practice（练习）与 Teaching 的本质分野（`src/agent/prompts/practice/10-doctrine.md`）**：
  * 教学的产物是一个**事件**（激活状态下的理解顿悟）；练习的产物是一种**状态**（当目标命题在工作记忆中处于**未激活（inactive）**状态、且题目绝不点破用哪条知识时，能仅靠情境特征自动提取并运行）。
  * 因此练习必须默认**穿插（interleaving）**不同目标以清空工作记忆，追求每分钟有效决策点密度（decision points per minute）及约 **85% 的单步提取成功率**，按 `Recall → Discrimination → Composition` 三种前置递进模式出题，并严格执行 **6 级最小提示阶梯（`R0` 注意力重定向 → `R5` 给出步骤）**——因为信息一旦泄露就无法撤回（信息经济学）。

---

## 2. 知识本体论与数据语义边界（“存了什么”与“刻意不存什么”）

如果不理解 LearnHarness 的认识论契约，极易误读持久化文件的含义（见 `skills/learnharness/SKILL.md`、`skills/learnharness/references/data-format.md`、`src/agent/subagents/extraction.ts`、`docs/probe-teach-split.md`）：

* **全局知识图谱 ≠ 学习者掌握度模型**：
  * `data/graph/`（`nodes.jsonl`、`chains.jsonl`）只存储**关于客观世界的真命题与联合蕴涵推理链**，完全不含学习者能力评分、熟练度、间隔重复权重或“已学会”标记。
  * **没有“误解节点”**：学习者的错误观念绝不作为负面节点入图，只能以其**客观正确的纠正命题**形式入图。图中存在某命题不代表学习者懂了，不存在也不代表不懂。
  * **仅抽取教师输出**：会话抽取只读取教师面向学习者的正文（普通 `text` 与成功的 `send_to_user`），带精确 `messageId` 溯源；学习者的发言、思考与做题记录绝不进入抽取源。
* **联合蕴涵（Joint Entailment）与等价归并**：
  * `chains.jsonl` 中的一条链表示所有 `premises` **共同（jointly）**推出 `conclusion`（独立理由必须拆成多条链；叙事顺序或历史关联不构成链）。画布上的边与汇合点只是有损视觉投影。
  * 跨来源（不同会话或导入笔记）的连接**只能**通过 Auditor 对命题判定的语义等价链接（`linkTo`）自然汇合，严禁 Auditor 跨来源凭空捏造推理边。
* **计划树 `nodeId` 是“位置信号”而非“完成度账本”**：
  * `plan_init` 生成的 DAG 是粗粒度路标图（“是地图，不是教学章节”）。题目上的 `nodeId` 仅表示“当前问题关于此节点”，没有 `done` 状态账本；答错不会回退节点，答对也不会自动完结节点，推进完全取决于教师何时切换到下一个 `nodeId`。
* **学习者多维证据与心理测量学解读（`src/agent/prompts/shared/16-mental-model.md`、`25-confidence.md`）**：
  * **双通道出声思考（Thinking Out Loud）**：区分作答时的 `thinking` 与阅读讲解时的 `readingThinking`（`thinkingWhileReading`）。在系统哲学中，思考文本才是**主数据（primary data）**，对错只是 1 bit 信号；且因大量由语音听写（dictation）产生，要求 Agent 对语音识别同音错字保持宽容。
  * **自信度校准矩阵（Confidence Calibration）**：`confidence`（0–100%）改变对错的定性——**高自信答错**是最强信号（根深蒂固的误解，必须拆解修复）；对于 $n$ 选项题，自信度 $\le 1/n$ 代表被迫盲猜且怀疑有陷阱；`50%` 无法区分“刻意五五开”与“未触碰滑块默认值”；`dontKnow: true` 不携带自信度（诚实的知识空白，绝不当作答错）。
  * **选项洗牌与归档视角陷阱**：前端会对选择题选项做确定性乱序，因此记录中的 `index` 是展示顺序而非原始数组下标；此外工具调用参数中预提交的 `correctAnswer` / `modelSolution` 在学习者作答前就已落盘，分析历史数据时绝不能把未作答/已跳过的预提交答案当成学习者已见过的内容。

---

## 3. Agent 人格铁律、命题工艺与指令组装治理

LearnHarness 对大模型的默认 RLHF 讨好习气做了极强的逆向约束（见 `src/agent/prompts/shared/` 与 `src/agent/prompts/README.md`）：

* **“纯减法”干爽语态（Anti-Sycophancy Voice，`src/agent/prompts/shared/10-voice.md`）**：
  * 明令禁止任何夸奖（如 "Great question!"、"Excellent!"）、表演式兴奋、迎合偏见、故作高深或软化错误。“继续下一步本身就是对进步的认可”，唯一的温度体现在为学习者量身定制内容的工匠精神上。
* **事实核查零容忍阈值（`src/agent/prompts/shared/15-accuracy.md`、`src/agent/prompts/teacher/40-jobs.md`）**：
  * 触发后台 `research` 的门槛是**“哪怕有一丝不确定”**（尤其是对学科结构或概念解释的把握，而非仅限版本号/日期），且必须在说出口之前异步派发；但严禁把数学推导或逻辑思考外包给搜索。无法消除的不确定性必须当面明示并在会话结尾回访。
* **高质量测评题与干扰项工艺（`src/agent/prompts/shared/20-question-tools.md`、`src/agent/prompts/practice/00-base.md`）**：
  * **先承诺后评判（Pre-commitment）**：选择题必须先写 `explanation` 再填 `correctAnswer`；练习题必须在出题前由 Agent 自己完整求解并**排查捷径（shortcut-hunting）**——如果一道题能绕过目标命题用旁门左道解出，这道题就是废题。
  * **选项对称性与诊断型干扰项**：所有选项只能是纯粹的命题陈述（严禁把解释写进正确选项或用不对称加粗暴露答案）；每个错误选项必须由正确命题按特定错误心智模型变异而来，使学习者一旦选错就能直接暴露其具体误解。
* **指令硬约束 vs. 软教条的区分（`src/agent/prompts/README.md`）**：
  * 必须分清哪些行为靠代码机械强制（如 `makeQuestionStopper` 截停回合、`probe_done` 状态校验、`practice` 单活跃题目门控），哪些仅靠 Prompt 教条维持（如 `plan_init` 后等待确认再开讲、`conclude` 后停顿等待学习者点击 *Next problem*），以及用户覆写 Prompt 需要 `data/prompts/` 文件与 `settings.json` 开关**双重生效**。

---

## 4. 反聊天化的产品 UX 哲学与全键盘人体工学

LearnHarness 的界面与交互有一套非常鲜明的设计法则（见 `docs/vision.md` §2、`docs/keyboard.md`、`docs/release-0.3.md`、`src/agent/prompts/teacher/50-demos.md`）：

* **“这不是聊天软件（It is not a chat）”——产物不对称性**：
  * 底层虽是轮次对话，但视觉呈现追求**教材文档与批注的不对称性**：教师产出结构化文档（标题、表格、谨慎使用的 `> [!IMPORTANT]`、Mermaid 图、沙箱交互式 HTML `demo`、经视觉模型自检渲染的精确几何 `visual` SVG）；学习者产出穿插卡片与思考记录。
  * **反斯金纳箱（Anti-Gamification）**：严禁积分（XP）、连胜（streaks）、撒花特效等外部成瘾机制。
  * **交互教具的分工纪律**：动态参数扫描/模拟必须造 `demo`（“拖十秒滑块胜过一段文字描述”），精确空间/坐标几何用 `visual`（因为自动布局错一像素就会断言错误的几何事实），结构流向用内联 Mermaid；且教具送达后教师必须在正文中点名引用其控件，否则视为失败的装饰。
* **接管浏览器默认行为的键盘人体工学（`docs/keyboard.md`）**：
  * **`Tab` 与 `Shift+Tab` 重定义**：`Tab` 接管原生焦点顺序，专门在当前挂载的输入区（`reading-thinking → 活跃答题坞 → composer`）或选项行与思考框之间循环；`Shift+Tab` 全局用于切换模型的 **Thinking Level**（即使正在打字时也生效）。
  * **`Esc` 严格分层消费法则**：每次按 `Esc` 只作用于最顶层活跃元素并拦截事件冒泡，逐层回退到关闭快捷键表 → 取消语音听写（丢弃草稿，区别于 `Mod+D` 保留文本停止）→ 弹出中止回合/跳过题目的确认框。
  * **跨键盘布局物理键位回退**：非 ASCII 字符（如俄语布局或 macOS `Option` 组合符号）自动回退匹配物理 `KeyA–KeyZ`/`Comma` 键位，而 AZERTY 等 ASCII 布局则尊重字符本身。

---

## 5. 真实大模型缺陷的工程防御经验（代码里的“实战伤疤”）

代码中大量看似特殊的逻辑，实则是针对不同大模型家族真实故障模式的防御机制（见 `docs/tool-content-recovery.md`、`src/agent/tools/send-to-user.ts`、`src/core/compaction.ts`、`src/core/argument-heal.ts`）：

* **Claude 家族正文吞没问题与 `send_to_user` 通道**：
  * Claude 系列模型在开启思考或经 CLI 桥接时，可能把面向用户的普通回复文本折叠进思考摘要中导致学习者看不到正文。因此系统仅对 Claude 模型动态注入 `send_to_user` 工具强制显式输出，且图谱抽取与覆盖率计算都必须同步识别该工具。
* **JSON 吞噬转义符与非破坏性 LaTeX 显示恢复（`docs/tool-content-recovery.md`）**：
  * 模型在 JSON 工具参数中写 `\text`、`\nu`、`\to` 时常漏写双反斜杠，被 JSON 解析成控制字符（`<TAB>ext`、`<LF>u`），或对矩阵换行过度转义。系统建立了严格的**三层分离契约**：持久化参数原样保留（绝不篡改选项值、洗牌顺序与判分快照），仅在 UI 展示投影层（`repairMathForDisplay`）结合 CommonMark 代码范围保护与 KaTeX 命令词表做确定性恢复，并由冻结语料库回归测试守护。
* **弱模型参数自愈与回合内重试闭环（`src/core/argument-heal.ts`、`src/agent/subagents/extraction.ts`）**：
  * 针对模型把数组序列化成字符串、截断重试时漏掉必填字段导致“无结构裸节点入图（degraded-retry hole）”、捏造非法 `nodeId` 等问题，先做结构自愈，再将语义校验错误作为 `isError: true` 工具结果退回模型（同时阻止 `makeQuestionStopper` 结束回合），逼迫模型在同一回合内自我修正。
* **上下文估算陷阱与教学专用压缩契约（`docs/compaction-accounting.md`、`src/core/compaction.ts`）**：
  * 直接用 `JSON.stringify` 估算消息长度曾导致约 **3 倍虚高**（元数据与转义膨胀），因此必须锚定最近一次有效响应的原生 `input + output + cacheRead + cacheWrite`，仅对锚点后的增量按字符估算，且跨压缩标记立即失效。
  * 上下文压缩不能套用编程 Agent 摘要，必须由当前会话模型按 **4 段教学连续性契约**生成（学习者理解状态及演变 → 教学推进弧线 → **原样保留的完整 Plan DAG** → 当前待答时刻），且若摘要因输出长度上限（`stopReason === "length"`）截断则直接判败回滚。

---

## 6. 模型槽位经济学、计费诚实性原则与安全信任边界

（见 `README.md`、`docs/compaction-accounting.md`、`docs/claude-code.md`、`docs/custom-providers.md`、`docs/development.md`、`src/agent/subscription-request-cycle.ts`）

* **“彻底 BYOK”与拒绝静默降级**：
  * 无任何出厂默认模型（未配置直接返回结构化 `503 models_not_configured` / `provider_key_missing`）。按 `strong` / `cheap` / `vision` 三层能力槽位解耦前景教学与后台子任务；新会话创建时拷贝 `strong` 槽位固化到会话配置中，改全局设置不会暗中篡改旧会话模型。
* **计费核算的“绝对诚实”原则**：
  * 仅对目录已知的原生 API 调用估算美元花费；**订阅通道（ChatGPT / Copilot / Grok）、Claude Code CLI（标为 `CLI billing`）、自定义/本地端点一律标为未知/不计价（绝不伪装成 `$0` 免费，也不导入 CLI 自报的美元数）**；历史记录若缺失 1 小时缓存写入拆分或分阶梯明细导致算不准，宁可保持 unpriced 也绝不靠总额反推猜测。
  * **订阅制前后台权限隔离（`SubscriptionRequestCycle`）**：区分学习者主动输入（foreground）与后台自动唤醒（`probe-handoff`、子 Agent 结果投递等 automatic 输入），未经后台授权绝不静默消耗用户的订阅额度，被拒的后台投递保留在待发状态而不丢失。
* **安全与运行环境边界**：
  * **本地存储 ≠ 离线处理**，**Web/Dev 模式 ≠ 多租户服务**：开发服务是单机单主人信任模型（同源校验不是多用户鉴权）；文件读取工具默认锚定运行服务的 OS 用户主目录而非 `data/` 沙箱。
  * **凭据防泄漏绑定**：自定义端点通过 `__learnharness_custom_provider_binding` 将密钥与规范化 URL 强绑定（改 URL 或写入崩溃绝不把旧 Key 发往新地址）；Claude Code 启动前自动剥离 LearnHarness 注入环境变量的 API Key，并通过单进程随机 Bearer Token + `claudecode/toolUseId` 严格校验 MCP 工具调用授权；外部数据分析技能（`skills/learnharness`）严守只读与“绝不执行持久化 HTML/SVG/代码”的安全红线。

---

## 7. 项目治理、数据兼容契约、离线确定性验证与发布工程

如果想参与维护或二次开发，还必须掌握项目的工程纪律（见 `CONTRIBUTING.md`、`tests/fixtures/golden-data/README.md`、`docs/desktop-release.md`、`scripts/sandtable/main.ts`）：

* **发布后的数据兼容性锁与 Golden Fixtures 铁律**：
  * 发布版本对用户磁盘数据（`chats/*.json`、`graph/*.jsonl`、`settings.json`）负有长期兼容义务：采用惰性版本戳（缺省视为 v1，遇到更高版本拒绝读取以防写坏数据）与增量设置存储（未知新字段原样保留，非法值降级裁剪而不崩溃）。
  * **`tests/fixtures/golden-data/` 铁律**：必须是真实运行应用产出的原样数据，**严禁手工编辑 JSON**，任何有意的存储格式变更必须在同一提交内更新并跑通全部生产读取路径与 9 种 `LhMarkerMessage` 覆盖校验。
* **零网络/零真模型的确定性验证体系与推演沙盘**：
  * 全量测试要求 **100% 确定性、无网络、无真实 LLM 调用**（通过脚本化 `streamFn`、伪造 CLI 进程 `fake-claude.mjs` 等实现）；针对回合锁、答题阻塞与后台结果投递的复杂并发时序，配有专门的只读状态机沙盘工具 **`scripts/sandtable/`**，以及底层流录制开关 `LH_PROVIDER_EVENTS=1`。
* **跨平台原生构建约束与 Fail-Closed 发布门禁（`docs/desktop-release.md`）**：
  * 因包含原生模块（PDF/Canvas、resvg、Photon WASM），独立服务端产物**严禁跨操作系统交叉编译**；生产发布流水线在三端打包完成后，必须通过只读校验器 `scripts/verify-release.ts` 精确核对单草稿 Release 下的 **11 个安装包/blockmap 资产与 3 个自动更新 YAML 索引**完全一致后，才允许维护者人工点击公开。
* **开源协议与设计裁决权（`CONTRIBUTING.md`、`LICENSE`）**：
  * 项目采用 **AGPL-3.0** 协议（承诺本地可运行功能永久免费开源）；采用维护者主导制——修复预期内 Bug 与改变预期行为（设计提案）有严格界限，涉及核心教学法、状态语义或存储格式的变化必须先达成设计共识再动手实现。
