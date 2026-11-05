# `src/core` 全量源码文件概要与技术要点索引（共 59 个文件）

> [!NOTE]
> 本文档汇总了 [`src/core`](file:///d:/0.default/learnharness/src/core/index.ts) 目录下全部 **59 个 TypeScript 核心源码文件**（50 个顶层模块 + 9 个 `contracts/` 子模块）的职责概要与核心架构不变量，既可作为日常阅读源码的**单行速查字典**，也可作为架构复盘资产。

---

## 一、契约与存储端口层（Contracts & Storage Ports，12 个文件）

[`src/core/index.ts`](file:///d:/0.default/learnharness/src/core/index.ts)：核心公共 API 门面入口、单向依赖导入门禁与客户端重型算法（聚类/布局沉降）打包隔离。

[`src/core/contracts.ts`](file:///d:/0.default/learnharness/src/core/contracts.ts)：全局领域契约聚合重导出桶（Barrel），维持单一事实来源（Single Source of Truth）与向后兼容导入路径。

[`src/core/ports.ts`](file:///d:/0.default/learnharness/src/core/ports.ts)：六边形架构存储端口接口（`ChatStore` / `GraphStore` / `JobStore` / `SettingsStore` / `PromptOverrideStore` / `AuthStore`）、按实体隔离契约与崩溃安全原子替换（`rewriteLedgers`）。

[`src/core/contracts/chat.ts`](file:///d:/0.default/learnharness/src/core/contracts/chat.ts)：会话记录契约、三值逻辑 Token 记账通道（区分 `undefined` 与 `0`）、按请求去重的计费轮次（`TurnUsage`）及 UI 计划快照块定义。

[`src/core/contracts/chatgpt.ts`](file:///d:/0.default/learnharness/src/core/contracts/chatgpt.ts)：ChatGPT 订阅客户端安全状态契约与前后端控制桥接接口（`ChatGPTControlBridge`），确保 OAuth 令牌绝不跨出服务端边界。

[`src/core/contracts/claude-code.ts`](file:///d:/0.default/learnharness/src/core/contracts/claude-code.ts)：Claude Code 本地 CLI 最小版本门禁常量与安装/认证状态联合类型契约。

[`src/core/contracts/graph.ts`](file:///d:/0.default/learnharness/src/core/contracts/graph.ts)：知识图谱仅追加账本（Append-Only Ledgers）契约、命题节点与多前提推理链模型、三阶段提取流水线（Extractor $\rightarrow$ Auditor $\rightarrow$ Merger）及派生视图几何结构。

[`src/core/contracts/jobs.ts`](file:///d:/0.default/learnharness/src/core/contracts/jobs.ts)：后台异步子智能体“立即确认、后续导向（Ack-and-Steer）”协议契约、工件结构化元数据与后台任务 Token 用量累积。

[`src/core/contracts/models.ts`](file:///d:/0.default/learnharness/src/core/contracts/models.ts)：大模型目录条目契约、四大功能槽位（`default` / `Conversation` / `Sub-agents` / `Extraction`）与阶梯式回退决议规格。

[`src/core/contracts/plan.ts`](file:///d:/0.default/learnharness/src/core/contracts/plan.ts)：教学计划有向无环图（DAG）契约、Mermaid 声明式一次性构图工具 Schema 与基于工具调用（Calls）无状态派生节点进度的纯函数法则。

[`src/core/contracts/probe.ts`](file:///d:/0.default/learnharness/src/core/contracts/probe.ts)：水平探测（Probe）阶段完成契约、TypeBox Schema 双向锁与模型上下文去重瘦身（剥离冗余题目详情省 Token）。

[`src/core/contracts/subscriptions.ts`](file:///d:/0.default/learnharness/src/core/contracts/subscriptions.ts)：原生订阅提供商（ChatGPT Codex / Claude Code）注册表契约、多作用域状态快照与 OAuth 设备流安全交互模型。

---

## 二、原生消息、输入事件与视图投影（Messages, Input Events & View，10 个文件）

[`src/core/native-messages.ts`](file:///d:/0.default/learnharness/src/core/native-messages.ts)：原生消息记录（`LhMessage`，“记录即 Agent 状态”）、自定义扩展标记（`LhMarkerMessage`）、双受众答案构造、唯一模型转换切面（`toLlmMessages` 压缩裁剪与悬空调用合成修复）及诚实激活状态扫描探针。

[`src/core/input-events.ts`](file:///d:/0.default/learnharness/src/core/input-events.ts)：客户端原子输入事件契约（`ChatInput` 7 种命令）、孤儿调用 400 严格校验门禁、写前追加消息计算（`inputAppends`）、延迟结题合成与失败轮次临时剔除重试（`retryDrops`）。

[`src/core/view.ts`](file:///d:/0.default/learnharness/src/core/view.ts)：客户端连续文档视图投影（`projectView`）、思考链置顶重排定律、工具结果逆向配对回填、正向流式证据（`streamingIds`）闪烁门禁与计划块内联拼接。

[`src/core/compaction.ts`](file:///d:/0.default/learnharness/src/core/compaction.ts)：长对话上下文压缩切面（Compaction Cut）纯逻辑、安全切点边界搜索（防撕裂工具调用与结果对）、链式压缩最新生效法则与压缩摘要标记构造。

[`src/core/session-clusters.ts`](file:///d:/0.default/learnharness/src/core/session-clusters.ts)：会话与知识图谱簇群关联映射、按会话归属聚合命题节点与主题簇投影计算。

[`src/core/session-find.ts`](file:///d:/0.default/learnharness/src/core/session-find.ts)：会话内文本大小写不敏感子串检索、非重叠匹配区间计算与高亮切分纯函数。

[`src/core/session-markdown.ts`](file:///d:/0.default/learnharness/src/core/session-markdown.ts)：全系统唯一的会话转 Markdown 格式化引擎（供知识提取器视图与用户导出文档共用）、师生对话保真排版与结构化答题记录渲染。

[`src/core/session-navigation.ts`](file:///d:/0.default/learnharness/src/core/session-navigation.ts)：会话题目与锚点导航索引提取、前后跳转游标边界保护与无状态定位计算。

[`src/core/events.ts`](file:///d:/0.default/learnharness/src/core/events.ts)：全栈推模式（Push Architecture）强类型事件总线、服务端与客户端事件词典定义及发布/订阅生命周期管理。

[`src/core/logger.ts`](file:///d:/0.default/learnharness/src/core/logger.ts)：同构结构化日志记录器（`lhLog`）、基于 ES Proxy + WeakMap 的零侵入方法调用追踪（`traceObject`）与异常无损透传。

---

## 三、教学互动、题目判分与计划树（Pedagogy, Questions & Plan Tree，12 个文件）

[`src/core/question-core.ts`](file:///d:/0.default/learnharness/src/core/question-core.ts)：题目核心逻辑契约、跨字段校验、纯函数评分引擎、确定性洗牌与紧凑型反馈载荷。

[`src/core/answer-presentation.ts`](file:///d:/0.default/learnharness/src/core/answer-presentation.ts)：历史题目卡片只读展示投影、双射对齐候选匹配与不可篡改保证。

[`src/core/argument-heal.ts`](file:///d:/0.default/learnharness/src/core/argument-heal.ts)：弱模型参数自愈纯逻辑核心、Tool-Parts 统一法则、字面量/标量/数组安全修复。

[`src/core/value-debris.ts`](file:///d:/0.default/learnharness/src/core/value-debris.ts)：模型值残余标点剥离、集合成员比较作用域隔离与幂等设计。

[`src/core/tool-parts.ts`](file:///d:/0.default/learnharness/src/core/tool-parts.ts)：UI 展示解析接缝（解析而非类型强转）、服务端边界 Convert 镜像与多智能体展示模式。

[`src/core/pending.ts`](file:///d:/0.default/learnharness/src/core/pending.ts)：悬挂题目门禁、消息与部件正向扫描顺序、工具配置可用性白名单。

[`src/core/phases.ts`](file:///d:/0.default/learnharness/src/core/phases.ts)：会话三阶段显式推导、Step 边界分割线定位算法、视图与原生记录双视角同构。

[`src/core/plan-blocks.ts`](file:///d:/0.default/learnharness/src/core/plan-blocks.ts)：教学计划流内卡片发射、时间点不可变快照与发射幂等性。

[`src/core/plan-tree.ts`](file:///d:/0.default/learnharness/src/core/plan-tree.ts)：计划树不可变操作、DAG 有向无环图校验与模型自愈友好型异常设计。

[`src/core/prompt-segments.ts`](file:///d:/0.default/learnharness/src/core/prompt-segments.ts)：提示词片段纯文法、白名单路径校验与练习智能体独立隔离。

[`src/core/math-delims.ts`](file:///d:/0.default/learnharness/src/core/math-delims.ts)：数学定界符 KaTeX 规范化转换、JSON 吞噬控制字符还原与过度转义修复。

[`src/core/content-reader.ts`](file:///d:/0.default/learnharness/src/core/content-reader.ts)：Markdown 源码保真切片、代码区间保护与 KaTeX 沙箱化无害探针。

---

## 四、知识图谱、力导向布局与信源管理（Knowledge Graph, Layout & Sources，12 个文件）

[`src/core/graph.ts`](file:///d:/0.default/learnharness/src/core/graph.ts)：知识图谱事件溯源合并器（`mergeFindings`）、推理链传递归约简化（`simplifyChains`）、单/多前提几何视图派生（`deriveView`）与会话出生聚类快照。

[`src/core/graph-deletion.ts`](file:///d:/0.default/learnharness/src/core/graph-deletion.ts)：会话级联删除双模式（保留图谱 vs 连带删节点）、基于出处引用计数的存活判定、单节点完全消亡（Full Death）与同步无穿插原子计算。

[`src/core/chains.ts`](file:///d:/0.default/learnharness/src/core/chains.ts)：面向选区的封闭子图推理链过滤（`chainsForSelection`）、双字典序规范化排序、目标命题名称/ID 消歧解析与单行可读格式化。

[`src/core/clusters.ts`](file:///d:/0.default/learnharness/src/core/clusters.ts)：图谱社区聚类呈现规则、二维凸包退化边界保护与最小聚类规模阈值（`MIN_CLUSTER_SIZE = 3`）视觉降噪。

[`src/core/layout.ts`](file:///d:/0.default/learnharness/src/core/layout.ts)：基于 `d3-force` 的同构力导向布局引擎、Tarjan 强连通分量（SCC）缩点环路安全深度计算、蕴含节点几何中点锚定与保护空间记忆的增量沉降（`incrementalLayout`）。

[`src/core/layout-settle.ts`](file:///d:/0.default/learnharness/src/core/layout-settle.ts)：服务端合并期离线布局沉降（`settleGraphLayout`）、派生视图片元物理受力对齐与客户端 Bundle 体积隔离边界。

[`src/core/coverage.ts`](file:///d:/0.default/learnharness/src/core/coverage.ts)：知识提取覆盖率纯逻辑、导师正文段落唯源提取（过滤思维链与学员口语噪声）、内容 SHA-256 指纹自愈差集推导与按 Token 预算连续分批（`batchRuns`）。

[`src/core/proposition-candidates.ts`](file:///d:/0.default/learnharness/src/core/proposition-candidates.ts)：BM25 内存词法候选命题检索引擎、节点级文档频率（Node-level DF）防别名膨胀计分与高召回粗筛分页（检索召回与 LLM 裁决严格正交）。

[`src/core/source-label.ts`](file:///d:/0.default/learnharness/src/core/source-label.ts)：导入信源文件只读展示标签提取（剥离目录与扩展名），保持展示名称与底层不可变出处主键解耦。

[`src/core/source-organization.ts`](file:///d:/0.default/learnharness/src/core/source-organization.ts)：信源虚拟目录树纯视图状态管理、防环路移动校验（`canMoveFolder`）、指令化增量更新（`applyOrganizationAction`）与导入路径自动建层。

[`src/core/source-selection.ts`](file:///d:/0.default/learnharness/src/core/source-selection.ts)：信源目录树勾选联动纯逻辑、递归条目收集与自底向上（由叶至根）的三态复选框（全选/半选/未选）收敛算法。

[`src/core/file-paths.ts`](file:///d:/0.default/learnharness/src/core/file-paths.ts)：零文件系统依赖的跨平台文件路径语法识别、CommonMark 规范反引号包裹转义与基于 UTF-16 偏移量的无损文本切片解析。

---

## 五、配置决议、密钥认证、计费与检索工具（Settings, Auth, Cost & Utils，13 个文件）

[`src/core/settings.ts`](file:///d:/0.default/learnharness/src/core/settings.ts)：用户设置增量语义（Delta Semantics）契约、编译期出厂默认值（`FACTORY_SETTINGS`）、自带密钥（BYOK）三阶槽位定义与“截断而不拒绝（Clamp-Never-Reject）”的向前兼容净化器。

[`src/core/settings-resolution.ts`](file:///d:/0.default/learnharness/src/core/settings-resolution.ts)：增量设置向生效设置（`EffectiveSettings`）的纯函数投影、角色模型回退决议链（角色覆盖 $\rightarrow$ 功能槽位 $\rightarrow$ 空）与知识图谱三通道开关门禁。

[`src/core/render-settings.ts`](file:///d:/0.default/learnharness/src/core/render-settings.ts)：图谱渲染世界坐标单位（World Units）语义、11 阶对数离散滑块阶梯量化（Nice-Number Series）与物理仿真安全参数区间校验。

[`src/core/auth-env.ts`](file:///d:/0.default/learnharness/src/core/auth-env.ts)：进程环境变量与 `auth.json` 凭据溯源合并及外部 CLI 子进程环境垫片剥离安全过滤（`externalCliEnv`）。

[`src/core/auth-keys.ts`](file:///d:/0.default/learnharness/src/core/auth-keys.ts)：精选认证密钥目录（`AUTH_KEYS`）、提供商环境变量零漂移映射表、写入侧离线形态校验（`validateKeyShape`）与密钥首尾掩码脱敏（`maskKey`）。

[`src/core/custom-provider-auth.ts`](file:///d:/0.default/learnharness/src/core/custom-provider-auth.ts)：自定义端点私有凭据授权绑定（`CustomAuthBinding`）、随机 Nonce 令牌解耦与状态一致性校验。

[`src/core/prices.ts`](file:///d:/0.default/learnharness/src/core/prices.ts)：客户端安全 Token 计费折叠计算、动态计价器注入（`CallPricer`）、缺失细分项原样保留原则与按输入 Token 加权的会话缓存命中率计算。

[`src/core/cost-summary.ts`](file:///d:/0.default/learnharness/src/core/cost-summary.ts)：知识图谱全流水线成本汇总折叠（`graphCostSummary`）、多源账单聚合与未定价模型显式标记（`unpricedModels`，绝不静默伪造为 0 美元）。

[`src/core/context-usage.ts`](file:///d:/0.default/learnharness/src/core/context-usage.ts)：会话上下文实测 Token 用量倒序扫描（`measuredContextTokens`）、上下文压缩边界截断隔离与有效 Token 桶守卫断言。

[`src/core/dictation.ts`](file:///d:/0.default/learnharness/src/core/dictation.ts)：Deepgram Nova-3 实时语音听写语言代码表、多语种自适应模式映射与 WebSocket 流式音频参数规范。

[`src/core/fuzzy.ts`](file:///d:/0.default/learnharness/src/core/fuzzy.ts)：纯内存多字段模糊检索打分引擎（`fuzzyScore`），支持精确匹配、前缀匹配、带深度惩罚的子串匹配及全词命中加分。

[`src/core/keyboard.ts`](file:///d:/0.default/learnharness/src/core/keyboard.ts)：全局键盘快捷键注册表、跨平台修饰键归一化（`Mod` $\rightarrow$ `Cmd`/`Ctrl`）、非拉丁键盘物理键位回退与输入焦点表面保护（`isTypingSurface`）。

[`src/core/search.ts`](file:///d:/0.default/learnharness/src/core/search.ts)：外部搜索引擎提供商六边形端口定义（`SearchProvider`）、凭据驱动的自动激活门禁与诚实状态探针契约。
