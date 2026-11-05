# 03 - 系统 API 与路由接口全景参考手册

> **文档定位**：本文档针对 `learnharness` 系统的所有 HTTP 路由接口（基于 Next.js App Router 架构），提供全景式的接口清单、请求参数、返回结构、底层业务逻辑与设计哲学解读，为全栈开发、二次开发、API 联调与架构维护提供权威参考。

---

## 目录索引

- [一、 整体架构与通信协议规范](#一-整体架构与通信协议规范)
  - [1.1 路由层在系统中的定位](#11-路由层在系统中的定位)
  - [1.2 安全门禁与鉴权拦截（`proxy.ts`）](#12-安全门禁与鉴权拦截proxyts)
  - [1.3 Diet B 异步解耦与 SSE 流式推送规范](#13-diet-b-异步解耦与-sse-流式推送规范)
- [二、 路由接口全景快速索引（35 个端点）](#二-路由接口全景快速索引35-个端点)
- [三、 详细接口规格与底层逻辑解读](#三-详细接口规格与底层逻辑解读)
  - [3.1 对话与会话管理 (Chat & Sessions) - 10 个端点](#31-对话与会话管理-chat--sessions---10-个端点)
  - [3.2 知识图谱体系 (Knowledge Graph) - 10 个端点](#32-知识图谱体系-knowledge-graph---10-个端点)
  - [3.3 后台任务与活动调度 (Activity & Jobs) - 3 个端点](#33-后台任务与活动调度-activity--jobs---3-个端点)
  - [3.4 系统配置与 Prompt 治理 (Settings & Prompts) - 5 个端点](#34-系统配置与-prompt-治理-settings--prompts---5-个端点)
  - [3.5 API 密钥与凭证安全 (Keys & Auth) - 2 个端点](#35-api-密钥与凭证安全-keys--auth---2-个端点)
  - [3.6 第三方订阅与外部工具 (Subscriptions & Claude Code) - 3 个端点](#36-第三方订阅与外部工具-subscriptions--claude-code---3-个端点)
  - [3.7 自定义模型供应商 (Custom Provider) - 1 个端点](#37-自定义模型供应商-custom-provider---1-个端点)
  - [3.8 系统模型、全局事件与辅助能力 (System, Events, STT & Search) - 4 个端点](#38-系统模型全局事件与辅助能力-system-events-stt--search---4-个端点)
- [四、 核心架构设计哲学与高频踩坑点](#四-核心架构设计哲学与高频踩坑点)

---

## 一、 整体架构与通信协议规范

### 1.1 路由层在系统中的定位
在 `learnharness` 架构中，`app/api/**/route.ts` 遵循**薄传输层（Thin Transport Layer）**原则：
- **禁止在路由文件中编写重度业务逻辑**：所有的状态变迁、数据仓储读写、智能体调度、管线执行均位于 `src/server/*` 与 `src/core/*`；
- **纯粹的 HTTP 适配器**：路由文件仅负责处理 Request JSON 解析、参数边界校验、调用服务端领域服务（Domain Services），并将结果封装为标准的 `Response.json(...)`。

### 1.2 安全门禁与鉴权拦截（`proxy.ts`）
所有匹配 `/api/:path*` 的请求，在进入具体路由前均受 Next.js Middleware (`proxy.ts`) 统一守卫：
```typescript
// proxy.ts
export function proxy(request: NextRequest) {
  if (!desktopAPIAuthorized(request.headers)) {
    return NextResponse.json(
      { error: "Desktop API access requires the trusted LearnHarness window." },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.next();
}
export const config = { matcher: "/api/:path*" };
```
- 确保桌面端渲染进程（Electron Renderer）与 Web 服务之间存在可信凭证握手，防止外部跨域嗅探或未经授权的脚本注入。

### 1.3 Diet B 异步解耦与 SSE 流式推送规范
系统摒弃了“长链接直连大模型生成，客户端网络抖动即导致生成崩溃”的传统模式，采用 **Connection Diet B 架构**：
1. **轻量即时 ACK**：用户发起聊天请求 `POST /api/chat` 时，服务端校验参数通过后立即在后台注册 Turn 实例，并返回 HTTP 200 确认；
2. **状态解耦于网络**：生成过程由服务端后台接管，即使用户关闭页面、刷新或切换 Tab，智能体生成和工具调用也不会中断；
3. **独立流式订阅**：客户端统一通过 `GET /api/chats/[id]/stream` 挂载 SSE 管道消费实时生成块。客户端断线重连会自动重放完整事件日志，直到生成收尾标记 `[DONE]`。

---

## 二、 路由接口全景快速索引（35 个端点）

| 分类 | HTTP 方法 | 接口路径 | 核心入参摘要 | 功能简述 |
| :--- | :--- | :--- | :--- | :--- |
| **会话** | `POST` | `/api/chat` | `{ chatId, input }` | 发送聊天内容/回答问题，开启新一轮智能体教学轮次 |
| **会话** | `GET` | `/api/chats` | 无 | 获取所有会话列表摘要及其实时运行与压缩状态 |
| **会话** | `POST` | `/api/chats` | `{ title?, kind?, graphContext? }` | 创建新会话（支持常规会话与练习模式） |
| **会话** | `GET` | `/api/chats/[id]` | 路径参数: `id` | 获取会话详情、消息全集、实时计费与图谱覆盖率 |
| **会话** | `PUT` | `/api/chats/[id]` | `{ title }` | 重命名会话标题 |
| **会话** | `DELETE`| `/api/chats/[id]` | Query: `mode=preserve-graph\|delete-nodes` | 删除会话（可选保留或彻底抹除关联图谱数据） |
| **会话** | `POST` | `/api/chats/[id]/steer` | `{ input: { text, id? } }` | 在正在运行的生成轮次中动态插入引导指令（插队） |
| **会话** | `GET` | `/api/chats/[id]/stream` | 路径参数: `id` | 订阅指定会话的 SSE 实时生成事件流 |
| **会话** | `POST` | `/api/chats/[id]/dismiss` | `{ input: { toolCallId, messageId? } }` | 静默放弃等待作答的问题（ESC 跳过），不触发生成 |
| **会话** | `POST` | `/api/chats/[id]/artifact-ui` | `{ input: { messageId, inverted } }` | 保存演示组件/图表暗黑高对比反色开关状态 |
| **会话** | `PUT` | `/api/chats/[id]/settings` | `{ ...chatSettings }` | 独立设置当前会话专属的模型与思考档位配置 |
| **会话** | `GET` | `/api/chats/[id]/markdown` | 路径参数: `id` | 将会话历史完整导出为可下载的 Markdown 文件 |
| **图谱** | `GET` | `/api/graph` | 无 | 获取全量知识图谱（节点、连线、会话溯源、理解度） |
| **图谱** | `GET` | `/api/graph/status` | 无 | 获取后台正在执行的图谱提取任务阶段与 Token 统计 |
| **图谱** | `GET` | `/api/graph/costs` | 无 | 汇总图谱构建（提取、笔记导入、聚类）的总消耗与费用 |
| **图谱** | `POST` | `/api/graph/coverage/extract` | `{ chatId }` | 手动触发对指定会话未覆盖内容的图谱概念提取 |
| **图谱** | `POST` | `/api/graph/import` | `Multipart Form: files` | 上传个人笔记或文档（Markdown/TXT/PDF）批量提取图谱 |
| **图谱** | `DELETE`| `/api/graph/nodes/[id]` | 路径参数: `id` | 级联删除单个图谱概念节点及其关联的所有连线与坐标 |
| **图谱** | `PUT` | `/api/graph/positions` | `{ [nodeId]: [x, y] }` | 保存前端画布拖拽调整后的节点空间坐标位置 |
| **图谱** | `GET` | `/api/graph/render-settings` | 无 | 读取图谱渲染视图控制配置（尺寸、缩放阈值、聚类） |
| **图谱** | `PUT` | `/api/graph/render-settings` | `{ ...settings }` | 保存图谱渲染视图的样式控制参数 |
| **图谱** | `GET` | `/api/graph/sources` | 无 | 读取图谱数据源目录结构（笔记文件、会话来源分组） |
| **图谱** | `POST` | `/api/graph/sources` | `{ action }` | 更新图谱数据源目录树（重命名、移动分类） |
| **图谱** | `DELETE`| `/api/graph/sources` | `{ action }` | 删除指定数据源及其提取的图谱关联数据 |
| **活动** | `GET` | `/api/activity` | 无 | 全局活动总览（活动坞 Dock 轮询：所有运行中进程） |
| **活动** | `POST` | `/api/activity/abort` | `{ kind: "job"\|"extraction"\|"turn", id }` | 统一取消/中止指定的后台任务、图谱提取或对话轮次 |
| **活动** | `GET` | `/api/jobs` | Query: `chatId` | 查询指定会话下的子智能体异步任务列表与状态 |
| **配置** | `GET` | `/api/settings` | 无 | 获取系统全局配置（非敏感配置项） |
| **配置** | `PUT` | `/api/settings/[section]` | 路径参数: `section`, Body: 对应配置 | 分区原子性更新全局配置（外观、模型槽位、对话等） |
| **配置** | `GET` | `/api/settings/prompts` | 无 | 获取所有系统提示词切片（Prober 与 Teacher）的源码与覆盖 |
| **配置** | `PUT` | `/api/settings/prompts/[...segment]` | `{ text }` | 覆盖保存指定系统 Prompt 切片的自定义内容 |
| **配置** | `DELETE`| `/api/settings/prompts/[...segment]` | 路径参数: `segment` | 删除自定义覆盖文件，恢复 Prompt 源码默认定义 |
| **鉴权** | `GET` | `/api/keys` | 无 | 获取各供应商 API Key 脱敏掩码与环境变量生效状态 |
| **鉴权** | `PUT` | `/api/keys/[id]` | `{ value }` | 保存指定服务的 API Key（格式校验后落盘即时生效） |
| **鉴权** | `DELETE`| `/api/keys/[id]` | 路径参数: `id` | 删除已保存的 API Key 凭证 |
| **订阅** | `GET` | `/api/subscriptions` | 无 | 查询 Web 订阅（ChatGPT、Claude、xAI 等）连接状态 |
| **订阅** | `POST` | `/api/subscriptions` | `{ providerId, op, ... }` | 执行订阅连接/断开/授权交互等控制指令 |
| **订阅** | `GET/POST`| `/api/subscriptions/browser` | Query: `id` | 一次性授权重定向端点，跳向第三方官方鉴权页面 |
| **工具** | `GET` | `/api/claude-code` | 无 | 检测本地 Claude Code CLI 的安装环境与版本号 |
| **供应商** | `GET` | `/api/custom-provider` | Query: `authMode?` | 获取自定义 OpenAI 兼容接口（如 Ollama）配置与模型 |
| **供应商** | `POST` | `/api/custom-provider` | `{ baseUrl, authMode, key?, ... }` | 探测并接入自定义 OpenAI 兼容端点，拉取可用模型 |
| **供应商** | `PATCH`| `/api/custom-provider` | `{ overrides }` | 覆盖调整自定义模型的上下文大小、思考档位等属性 |
| **供应商** | `DELETE`| `/api/custom-provider` | 无 | 清理断开自定义供应商连接 |
| **系统** | `GET` | `/api/models` | 无 | 刷新并获取全局可用模型字典（单价、上下文、思考档位） |
| **系统** | `GET` | `/api/search` | 无 | 探查网络搜索引擎（Tavily/Brave）可用性与激活状态 |
| **系统** | `GET` | `/api/stt/token` | 无 | 服务端代换 Deepgram 临时 Token（TTL 300s）供浏览器直连 |
| **事件** | `GET` | `/api/events` | 无 | 全局 SSE 通知通道（广播会话、任务、图谱数据源变动） |

---

## 三、 详细接口规格与底层逻辑解读

### 3.1 对话与会话管理 (Chat & Sessions) - 10 个端点

#### 1. `POST /api/chat`
- **功能**：向会话发送指令以启动一轮智能体教学交互。
- **请求体（JSON）**：
  ```json
  {
    "chatId": "chat_abc123",
    "input": {
      "type": "text",
      "text": "请给我讲讲微积分基本定理"
    }
  }
  ```
  `input` 支持的联合类型：
  - `{ type: "text", text: string }`：普通用户发问；
  - `{ type: "answer", toolCallId: string, answer: any }`：用户答题提交；
  - `{ type: "retry" }`：失败重试当前轮次。
- **响应**：`200 OK` `{ ok: true }`
- **底层流转**：委托给 `src/server/chat-handler.ts:handleChatRequest`。校验通过后触发 `handleChatInput`，轮次进入后台执行并挂载到全局运行注册表 `turn-runs`。

#### 2. `GET /api/chats`
- **功能**：获取左侧边栏所需的会话列表及其实时忙碌状态。
- **响应结构**：
  ```json
  {
    "chats": [
      {
        "id": "chat_abc123",
        "title": "量子力学基础",
        "phase": "teaching",
        "busy": true,
        "compacting": false,
        "updatedAt": 1730000000000
      }
    ]
  }
  ```
- **核心机制**：数据层与运行态合并——从 `chatStore` 读取静态记录，并在路由层动态汇入 `isTurnRunning(c.id)` 与 `compactionInFlight(c.id)`。

#### 3. `POST /api/chats`
- **功能**：新建会话。
- **请求体（JSON）**：
  ```json
  {
    "title": "可选自定义标题",
    "kind": "practice",
    "graphContext": {
      "nodeIds": ["node_1", "node_2"]
    }
  }
  ```
- **参数说明**：
  - `kind`: 若传入 `"practice"`，则该会话标记为练习模式（加载 Practice Agent，禁用图谱提取）；
  - `graphContext`: 携带的前置图谱概念节点，系统会自动生成一条携带节点背景的初始系统引导。

#### 4. `GET /api/chats/[id]`
- **功能**：获取指定会话的全量详情。
- **响应关键字段**：
  - `messages`: 原生消息历史数组；
  - `pricing`: 当前会话产生的累计费用（输入/输出 Token 计费）；
  - `turnInFlight`: 当前会话是否有生成轮次在运行；
  - `turnError`: 轮次失败时的错误对象；
  - `coverage`: 知识图谱提取覆盖率统计（未提取/已提取字符与比例）。

#### 5. `PUT /api/chats/[id]`
- **功能**：会话重命名。
- **请求体**：`{ "title": "新标题" }`
- **特殊约束**：更新标题时刻意**不刷新** `updatedAt` 时间戳，避免用户改名导致侧边栏会话排序发生跳跃。

#### 6. `DELETE /api/chats/[id]?mode=preserve-graph|delete-nodes`
- **功能**：删除会话。
- **Query 参数**：
  - `preserve-graph`：仅删除对话记录，图谱中已合入的节点和边予以保留；
  - `delete-nodes`：“如同未发生过”，追溯并物理删除由该会话单独贡献的全部图谱节点及边。
- **并发互斥**：若当前会话正在运行轮次、后台任务或正在退出提取管线，返回 `409 Conflict` 拒绝删除。

#### 7. `POST /api/chats/[id]/steer`
- **功能**：在当前轮次运行中途插入引导指令。
- **请求体**：`{ "input": { "text": "注意用通俗比喻解释", "id": "optional_client_id" } }`
- **状态约束**：若当前会话并无正在运行的轮次，返回 `409 Conflict`，客户端需降级为普通输入发送。

#### 8. `GET /api/chats/[id]/stream`
- **功能**：SSE 长连接流。
- **机制**：
  - 轮次运行中：挂载到 PiEngine 实时流，下发增量 Chunk；客户端断网重连时，会自动从头重放本轮全部历史事件以防丢字；
  - 轮次已结算：返回 `{"type": "turn-settled"}` 标记并立即关闭流。

#### 9. `POST /api/chats/[id]/dismiss`
- **功能**：ESC 静默跳过题目作答。
- **请求体**：`{ "input": { "toolCallId": "call_123" } }`
- **设计哲学**：不调用大模型、不消耗 Token，仅将题目的 Tool Result 标记为 `dismissed` 写入存储，待用户下次正常发问时一并带入上下文。

#### 10. `POST /api/chats/[id]/artifact-ui`
- **功能**：持久化演示组件/图表的反色状态。
- **请求体**：`{ "input": { "messageId": "msg_123", "inverted": true } }`

#### 11. `PUT /api/chats/[id]/settings`
- **功能**：覆盖当前会话的模型与思考级别。
- **请求体**：传入完整的会话级配置对象（支持 provider、model、thinkingLevel）；传 `{}` 则代表清空覆盖、遵从全局默认。

#### 12. `GET /api/chats/[id]/markdown`
- **功能**：将会话全量消息渲染并作为附件下载（导出 Markdown）。

---

### 3.2 知识图谱体系 (Knowledge Graph) - 10 个端点

#### 1. `GET /api/graph`
- **功能**：读取全局知识图谱，包含全部概念节点、关联边、节点所绑定的会话出处（Provenance）及理解度观测数据。

#### 2. `GET /api/graph/status`
- **功能**：监控当前图谱提取任务的队列状态，返回各提取任务所处阶段（`queued` / `extracting` / `auditing` / `merging`）及分块切片进度。

#### 3. `GET /api/graph/costs`
- **功能**：获取图谱构建各个管线（会话提取、笔记导入、聚类命名）的 Token 与费用统计。

#### 4. `POST /api/graph/coverage/extract`
- **功能**：手动触发指定会话的知识图谱提取。
- **请求体**：`{ "chatId": "chat_abc123" }`
- **防重保证**：若当前会话提取已在进行中，返回 `409 Conflict`。成功触发后返回 `202 Accepted`，后台异步运行。

#### 5. `POST /api/graph/import`
- **功能**：导入本地个人笔记或资料。
- **请求体**：`multipart/form-data`（字段名为 `files`，支持 Markdown、TXT、PDF）。
- **处理流**：PDF 自动提取文本转为 Markdown -> 经由 Extractor -> Auditor -> Merger 标准三级管线合并入图谱。内置最大 3 线程并发池，防止瞬时并发打满供应商速率。

#### 6. `DELETE /api/graph/nodes/[id]`
- **功能**：物理删除单个图谱概念节点。
- **破坏性**：会级联清理该节点的全部连线、事件记录与坐标，并触发前端图谱版本号 `graphRevision` 递增。若有提取任务在运行则返回 409。

#### 7. `PUT /api/graph/positions`
- **功能**：批量持久化节点在 2D/3D 画布中的坐标。
- **请求体**：`{ "node_1": [120.5, 340.2], "node_2": [-45.0, 80.1] }`

#### 8. `GET & PUT /api/graph/render-settings`
- **功能**：读取与写入图谱界面的渲染样式参数（节点半径、连线粗细、箭头尺寸、文字缩放显示阈值、聚类标签展示等）。

#### 9. `GET & POST & DELETE /api/graph/sources`
- **功能**：图谱知识源目录树管理：
  - `GET`：查看知识源分类与文件列表；
  - `POST`：对知识源文件进行移动、重命名或重组；
  - `DELETE`：物理删除指定知识源，同时从图谱中抹除该源贡献的知识。

---

### 3.3 后台任务与活动调度 (Activity & Jobs) - 3 个端点

#### 1. `GET /api/activity`
- **功能**：活动坞（Activity Dock）核心轮询接口。返回当前整个系统正在运行的所有后台操作（活跃会话轮次、异步子智能体任务、图谱提取任务），并附带实时费用预估。

#### 2. `POST /api/activity/abort`
- **功能**：全局统一中断/取消接口。
- **请求体**：
  ```json
  {
    "kind": "turn", // 可选 "turn" | "job" | "extraction"
    "id": "chat_abc123" // turn/extraction 为 chatId，job 为 jobId
  }
  ```
- **返回结果**：
  - 任务已不在运行：返回 `409 Conflict`；
  - 中断成功：返回 `200 OK` `{ "ok": true }`。

#### 3. `GET /api/jobs?chatId=...`
- **功能**：查询指定会话关联的所有后台子智能体任务（Sub-agent Jobs，如代码沙箱、深度调研等）的执行状态及产物。

---

### 3.4 系统配置与 Prompt 治理 (Settings & Prompts) - 5 个端点

#### 1. `GET /api/settings`
- **功能**：获取全局配置文件 `data/settings.json`（不包含任何敏感密钥凭据）。

#### 2. `PUT /api/settings/[section]`
- **功能**：按分区原子性更新系统设置。
- **支持分区**：`general`、`chat`、`agent`、`appearance`、`graph`、`compaction`、`models`、`dictation`。
- **校验逻辑**：通过 `settings-body.ts` 严格白名单校验；写入前会自动依据当前模型支持的思考档位执行自适应截断（Clamp）。

#### 3. `GET /api/settings/prompts`
- **功能**：获取系统中 Prober 与 Teacher 两个智能体所由的所有 Prompt 文本切片元信息。

#### 4. `PUT & DELETE /api/settings/prompts/[...segment]`
- **功能**：针对指定的 Prompt 片段执行本地覆盖写入或还原：
  - `PUT { "text": "自定义 prompt 内容" }`：在 `data/prompts/` 写入同名覆盖文件；
  - `DELETE`：删除覆盖文件，并重置开关，使系统恢复使用内置代码中定义的提示词。

---

### 3.5 API 密钥与凭证安全 (Keys & Auth) - 2 个端点

#### 1. `GET /api/keys`
- **功能**：获取全部已注册供应商的 Key 配置状态。
- **安全设计**：接口输出绝不泄露明文密钥，普通 Key 仅展示末尾 4 位及掩码长度，自定义密钥全量脱敏；同时标记 `shadowedByEnv`（环境变量覆盖指示）。

#### 2. `PUT & DELETE /api/keys/[id]`
- **功能**：新增、修改或移除指定环境变量形式的密钥凭证（如 `OPENROUTER_API_KEY`、`OPENAI_API_KEY`）。
- **请求体**：`{ "value": "sk-..." }`（格式合法性静态校验，通过后持久化至本地 `auth.json` 并动态注入进程环境变量）。

---

### 3.6 第三方订阅与外部工具 (Subscriptions & Claude Code) - 3 个端点

#### 1. `GET & POST /api/subscriptions`
- **功能**：管理第三方 Web 订阅（ChatGPT Plus、Claude Pro、xAI 等）：
  - `GET`：查询当前各订阅渠道的会话凭证状态与可用模型；
  - `POST { "providerId": "chatgpt", "op": "login"|"disconnect"|"consent" }`：控制订阅认证生命周期。

#### 2. `GET & POST /api/subscriptions/browser?id=...`
- **功能**：单次使用的浏览器顶层重定向端点。根据一次性随机 ID 执行 303 重定向跳转至第三方官方认证页面，避免授权链接暴露给前端 JS。

#### 3. `GET /api/claude-code`
- **功能**：轻量级探测本地是否安装了 Claude Code CLI，返回可用状态与版本号。

---

### 3.7 自定义模型供应商 (Custom Provider) - 1 个端点

#### `GET & POST & PATCH & DELETE /api/custom-provider`
提供针对 OpenAI 兼容接口（如本地 Ollama、vLLM、LM Studio、OpenAI 网关）的完整生命周期管理：
- `GET`：查询当前连接的自定义接口地址、认证方式（免密 Keyless 或 API Key）及已发现的模型清单；
- `POST { baseUrl, authMode, key?, reuseKey?, manualModels? }`：测试端点连通性，自动探测 `/models` 接口拉取模型列表并持久化保存；
- `PATCH { overrides }`：针对特定模型覆盖修改上下文窗口长度（Context Window）、最大输出 Token 数等；
- `DELETE`：清除自定义模型供应商配置并恢复初始状态。

---

### 3.8 系统模型、全局事件与辅助能力 (System, Events, STT & Search) - 4 个端点

#### 1. `GET /api/models`
- **功能**：获取当前系统中所有已激活供应商可用的全量模型字典（包含单价、上下文上限、模态支持、各模型支持的 Thinking Level 档位）。

#### 2. `GET /api/search`
- **功能**：检测外部搜索引擎能力（Tavily 或 Brave Search）的可用状态、当前生效的引擎类型及未就绪原因。

#### 3. `GET /api/stt/token`
- **功能**：语音听写（STT）临时凭证签发接口。服务端使用 Deepgram 密钥向官方换取有效时长为 300 秒的临时 Access Token，前端直接以此 Token 建立与 Deepgram 的 WebSocket 直连传输音频，语音数据不经过本应用服务端。

#### 4. `GET /api/events`
- **功能**：全局核心 SSE 事件总线。所有打开的客户端页面均维持一条长连接，当服务端发生数据变更时广播对应事件（`chats-changed`、`jobs-changed`、`activity-changed`、`sources-changed` 等），前端据此实现响应式静默刷新。

---

## 四、 核心架构设计哲学与高频踩坑点

### 1. 为什么很多请求返回 `409 Conflict`？
系统在设计上严厉禁止竞态条件（Race Conditions）：
- 当某会话已经在运行一个 Turn 时，再次调用 `POST /api/chat` 会返回 409；
- 当图谱提取正在进行中时，再次调用 `/api/graph/coverage/extract` 或删除关联节点会返回 409；
- 当任务已经执行完毕或已被取消时，调用 `/api/activity/abort` 会返回 409。
> **原则**：诚实反馈“当前状态不允许此操作”，要求调用方重新拉取最新状态（Refetch），而不是在服务端进行不可控的并发交织。

### 2. 为什么写操作推荐使用“全量替换 (Replace-Whole)”？
如 `/api/chats/[id]/settings` 和 `/api/settings/[section]`，均要求客户端传入该分区的完整期望对象，不采用服务端深度 Merge：
- **收益**：避免客户端清空某项配置时，因 Partial Merge 导致已清空的项被服务端默认值复活（Resurrected）；传入 `{}` 即明确代表“清空所有覆盖项”。

### 3. 为什么密钥（Secret）与配置（Settings）严格物理隔离？
- 所有非敏感配置统一存放在 `data/settings.json` 中；
- 所有 API Key 与鉴权凭据统一存放在 `auth.json` 或环境变量中；
- 无论是 `GET /api/settings` 还是 `GET /api/keys`，系统均从数据结构层面彻底杜绝明文 Key 的返回，避免日志打印、前端缓存或网络抓包造成凭据泄漏。
