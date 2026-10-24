# LearnHarness 项目定制化学习计划

这份学习计划旨在帮助你系统地理解 LearnHarness 项目的架构设计、核心机制以及数据流转，并最终让你能够得心应手地进行定制化开发。LearnHarness 是一个高度结构化的应用程序，它不使用标准的 Web 应用架构（如传统的 MVC 或前后端分离中常见的胖前端），而是采用了非常严格的领域驱动和分层架构。

## 阶段一：建立全局认知 (The Big Picture)

在深入代码之前，必须先理解项目的设计哲学和运行形态。

**目标**：理解 LearnHarness 的核心概念、目标以及它如何与传统的聊天应用区分开来。

1.  **阅读核心文档**：
    *   `README.md`：了解产品的功能定位和主要特性（教学、知识图谱、练习）。
    *   `docs/vision.md`：这是非常关键的设计文档。重点理解：
        *   **知识图谱理论**：所有的节点都是客观命题（Propositions），边代表逻辑推导关系（Reasoning Chains）。不存在“错误认知”节点。
        *   **课程体验 vs 通用聊天**：教学会话中，AI 负责建立正式的“依赖树（Plan Tree）”，并不是简单的对话。界面交互打破了传统的左右气泡（Bubbles），而是类似“批注”和“文章结构”。
        *   **理解（Understanding）是推导出的**，不直接存在于图谱节点中。

2.  **本地运行与体验**：
    *   确保环境（Node.js >= 20, `.env.local` 准备好 `OPENROUTER_API_KEY`）。
    *   运行 `npm install` 后，执行 `npm run dev` 启动 Web 版。
    *   随便输入一个你想学习的知识点，体验 **Probe（探测） -> Teach（教学）** 阶段的无缝切换，观察右侧大纲（Plan Tree）的生成和变化。
    *   前往 Home 页查看默认状态的图谱（可能为空或只有少量节点）。

## 阶段二：掌握核心架构规则 (The Hexagon Architecture)

这是代码库中最重要的部分。LearnHarness 使用了极为严格的架构分层，并且通过 ESLint 在机器层面强制执行。

**目标**：理解各个目录的职责以及数据流向。

1.  **阅读架构规范**：
    *   `docs/architecture.md`：仔细阅读 "The layers and the import law" 章节。

2.  **深入分层 (Layers)**：
    *   **CORE (`src/core/`)**：纯粹的业务领域（Domain）。没有 I/O 操作，没有 Node.js 内置模块（绝大部分），没有对外部适配器的依赖。包含了核心逻辑如 `graph.ts` (图谱合并与派生), `practice.ts`, `plan-tree.ts`, 以及定义的 Ports (接口)。
    *   **STORE (`src/store/`)**：数据存储层，所有直接操作文件系统读写 (`data/` 目录) 的代码全在这里。它们实现了 `core` 中定义的 Ports。
    *   **AGENT (`src/agent/`)**：大语言模型 (LLM) 的逻辑核心。包含 Prompt、工具调用 (Tools) 以及提取管道 (Extraction Pipeline)。这里不直接引入 `server` 或 `store`，依赖都是通过工厂模式注入的。
    *   **SERVER (`src/server/`)**：服务端组装层（Composition Roots）。这里没有业务逻辑，只有将各个部分组合起来的胶水代码（如 `chat-handler.ts`, `stores.ts`）和向客户端提供的 API Seams。
    *   **SHELL (`app/` 和 `components/`)**：Next.js 的路由与 UI 展示层，它们只消费核心数据，不执行业务逻辑。

3.  **理解单向依赖原则**：
    *   **外层只能依赖内层**，反之绝对禁止。`components` -> `core`，`server` -> `core/store/agent`，但 `core` 不能依赖任何外部。
    *   去查看 `.eslintrc` 或 `eslint.config.mjs` 中是如何配置 `import/no-restricted-paths` 来强制这种依赖的。

## 阶段三：攻克六大核心系统 (The Six Systems)

LearnHarness 的运行时是由六个系统构成的，每个系统负责不同的领域，并且有且只有该系统负责对其相关数据进行写入。

**目标**：理解每个系统的运作机制以及它们之间是如何通信的。

1.  **Classroom（课堂引擎） - 负责 `data/chats/*.json`**：
    *   核心代码入口：`src/server/chat-handler.ts`。
    *   重点理解一个 Turn（对话回合）的完整生命周期。客户端不执行工具调用（如 quiz 工具在客户端被渲染和判分，然后将结果传回）。
    *   理解 `prober`（探查者）到 `teacher`（教师）的过渡机制。

2.  **Library（知识图谱） - 负责 `data/graph/*.jsonl`**：
    *   这是最复杂的后台流水线 (Extraction Pipeline)。
    *   核心机制：**触发式提取**。基于未覆盖的 Token 数量（`triggerExtraction`）。
    *   三步走：Extractor (LLM 提取，只能看到教师内容) -> Auditor (LLM 审计，只负责判断节点身份，不修改结构) -> Merger (代码硬逻辑合并入库)。
    *   代码路径：`src/agent/subagents/extraction-pipeline.ts` 以及 `src/core/graph.ts`（重点看 `mergeFindings` 和推导视图 `deriveView`）。
    *   理解追加写入（Append-only ledger）模式。

3.  **Workbench（后台工作台） - 负责 `data/jobs/*.json`**：
    *   包含 Researcher（搜索）, Demo-builder（生成交互式组件）, Visual-maker。
    *   核心机制：**唤醒管道 (Wake Pipeline)**。子代理异步执行，成功后排队，等待当前聊天回合结束后，自动以 "steer message" 的形式无缝注入到下一轮教学中。

4.  **Practice（练习系统） - 负责 `data/practice/*.json`**：
    *   理解这只是为了“强化”，不涉及评估（即不回写成绩到图谱）。
    *   两阶段生成：Partitioner（分配问题） -> ProblemGenerator（生成题目）。
    *   打分逻辑：即时判分，生成详细评价。

5.  **Stage（UI 展示层）**：
    *   研究 `components/` 目录。重点看图谱的渲染 (`components/graph-canvas.tsx` 依赖 `sigma.js` 和手写的 Canvas 2D)。
    *   理解 UI 是如何通过全局 SSE 通道 (`/api/events`) 被动获取更新通知然后触发数据重新拉取的（Push model）。

6.  **Machine Room（宿主环境）**：
    *   了解 Electron 的包装：它仅仅是一个启动器，运行了一个独立的 Next.js 服务器子进程。数据存储通过 `LH_DATA_DIR` 控制。

## 阶段四：定制化开发实战路径

在你了解了系统结构后，可以尝试按照以下顺序进行定制化开发：

1.  **修改/新增提示词 (Prompts)**：
    *   *入口*：`src/agent/prompts/` 和 `src/agent/system-prompt.md`。
    *   *练习*：修改 Teacher 的提示词，让它的教学风格更幽默，或者修改 Extractor 的规则以提取特定类型的知识（例如加入代码片段的提取偏好）。

2.  **修改知识图谱的展现形式**：
    *   *入口*：`components/graph-canvas.tsx` (UI 渲染) 以及 `src/core/graph.ts` (`deriveView` 函数)。
    *   *练习*：当前的图谱会将 `chains` 派生为“蕴含 (Implication, ⟹)”节点。尝试修改前端渲染逻辑，为不同的子领域集群（Clusters）应用不同的配色方案，或者实现自定义的物理受力（调整 d3-force 的参数在 `layout.ts`）。

3.  **扩展大模型支持 (Models)**：
    *   *入口*：`src/agent/models.ts` (`piEngineFor`)。
    *   *练习*：系统目前依赖 OpenRouter，尝试添加对本地大模型（如 Ollama）或特定云厂商的直连支持。

4.  **增加新的背景子代理 (Sub-agent)**：
    *   *入口*：`src/agent/subagents/` 以及 `src/core/contracts/jobs.ts`。
    *   *练习*：参照 Researcher，实现一个 "CodeReviewer" 代理，当用户粘贴代码时，后台自动进行审查并生成报告，然后通过 Wake 管道推送到会话中。

5.  **添加新的练习题型 (Practice)**：
    *   *入口*：`src/core/practice.ts` (参数定义) 和 `src/agent/subagents/practice-pipeline.ts`。
    *   *练习*：新增一个 “纠错题” 类型 (Ladder rung)，并让 Practice 管道能够生成带有错误前提的逻辑推导让用户指出错误。

## 阶段五：测试与工程纪律

定制开发时，千万不要破坏既有的架构约束。

1.  **无网络确定性测试**：
    *   项目重度依赖测试。所有的核心逻辑测试都不联网。LLM 引擎通过 `createFauxCore` 被 mock 掉。
    *   运行 `npm run test`。如果你修改了 `src/core`，必须要添加相应的纯逻辑单元测试。
2.  **Lint 检查是铁律**：
    *   当你试图在一个组件中直接引入 `fs` 或试图从 `src/server` 引入内容到 `src/agent` 时，ESLint 必定报错。
    *   在提交任何修改前，请务必保证 `npm run lint` 和 `npm run typecheck` 是通过的。

---
祝你在探索 LearnHarness 的旅程中获得启发！遵循其严格但优雅的架构规范，你将能够构建出非常强大的教育 AI 代理。