# 第 10 卷：Delta 设置清洗、模型槽位解析与安全凭据边界

> **覆盖源码文件（共 8 个）**：`src/core/settings.ts`（861 行） · `src/core/settings-resolution.ts`（277 行） · `src/core/auth-keys.ts`（218 行） · `src/core/auth-env.ts`（24 行） · `src/core/custom-provider-auth.ts`（26 行） · `src/core/dictation.ts`（90 行） · `src/core/search.ts`（53 行） · `src/core/prompt-segments.ts`（50 行）  
> **合计行数**：1,599 行 | **桶导出边界**：`settings.ts`、`settings-resolution.ts`、`auth-keys.ts`、`dictation.ts`、`search.ts`、`prompt-segments.ts` 导出于 `src/core/index.ts`；`auth-env.ts` 与 `custom-provider-auth.ts` 不进浏览器桶导出，专供服务端与 Agent 进程隔离层导入。  
> **纯度概览**：除 `auth-env.ts` 读写 `globalThis[Symbol.for("lh.authBoot")]` 追踪进程启动环境变量来源外，其余 7 个文件的 **43 个函数全部为 100% 无副作用确定性纯函数**。

---

## 本卷导读：“Delta 增量存储 × 彻底 BYOK × 凭据零串发零污染”

本卷八个模块共同定义了 LearnHarness 的配置与安全基础设施：

1. **Delta 增量设置与宽进清洗（`settings.ts` + `settings-resolution.ts`）**：`data/settings.json` 只保存用户显式修改的键，缺失键在读取时由 `resolveSettings` 纯函数合入 `FACTORY_SETTINGS`（未来新增开关无需写数据迁移脚本）；**唯独模型槽位贯彻“彻底 BYOK”**——无任何出厂默认模型，解析为空时由各处门禁诚实返回 503 结构化拒绝信封。
2. **三道凭据安全隔离墙（`auth-keys.ts` · `custom-provider-auth.ts` · `auth-env.ts`）**：
   * 写入密钥时做纯本地格式与防截断检查，绝不向外发网络探针，读取时永远掩码脱敏；
   * 自定义 OpenAI 兼容端点通过 `auth.json` 内置影子记录将密钥与规范化 URL、鉴权模式、32 位随机 `credentialBindingId` 强绑定，改地址或中途崩溃绝不把旧密钥泄漏给新服务器；
   * 启动外部 Claude Code CLI 前，精准剥离应用从 `auth.json` 反射进 `process.env` 的密钥，保留操作系统原生环境。

---

## 1. `src/core/settings.ts`（861 行）

### 1.1 模块定位与纯度边界

* **设计目的**（`src/core/settings.ts:1-29`）：定义非敏感用户偏好记录 `UserSettings`、编译期默认常量 `FACTORY_SETTINGS`、503 拒绝信封契约，以及永不抛错的清洗器 `sanitizeUserSettings`。
* **桶导出与纯度**：导出于 `src/core/index.ts`；全文件 12 个导出函数/类构造器与 13 个私有清洗辅助函数均为 **100% 严格纯函数**。

### 1.2 核心常量与类型体系（`src/core/settings.ts:41-543`）

* **角色与三大模型槽位**：`MODEL_SLOTS = ["strong", "cheap", "vision"]`（`72`）；`ROLE_SLOT`（`320-329`）将 `prober`/`teacher` 映射到 `strong`，将 `researcher`/`demoBuilder`/`extractor`/`auditor` 映射到 `cheap`，将 `visualMaker`/`pdfReader` 映射到 `vision`；`BACKGROUND_MODEL_ROLES`（`46-52`）列出可在设置页独立覆盖的 5 个后台角色。
* **思考预算与缓存偏好**：`DEFAULT_THINKING_ORDER = ["medium", "low", "high", "minimal", "xhigh", "max"]`（`89-96`）；`CACHE_RETENTIONS = ["none", "short", "long"]`（`191`）。
* **自定义端点与下限保护常量**：`CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW = 8192`、`CUSTOM_MODEL_DEFAULT_MAX_TOKENS = 4096`、`CUSTOM_MODEL_PIN_FLOOR = 1`（`224-228`）；`EXTRACTION_CHUNK_TOKENS_FLOOR = 500`（`536`，出厂默认 `4096`）；`COMPACTION_THRESHOLD_FLOOR = 32_000`（`793`，出厂默认 `150_000`）；正文字号范围 `[12, 24]`（`540-541`）。
* **顶层记录契约 `UserSettings`**（`475-491`）：含 `version`、`general`、`dictation`、`claudeCode`、`agent`、`models`、`customProvider`、`appearance`、`graph`、`compaction` 及前向兼容索引签名 `[key: string]: unknown`。

---

### 1.3 导出函数逐一五要素精讲

#### 缺模型与缺密钥 503 信封组：`modelsNotConfigured` · `isModelsRefusal` · `providerKeyMissing` · `isProviderKeyRefusal`（`src/core/settings.ts:113-189`）

* **① 签名与职责定位**：
  * `export function modelsNotConfigured(missing: ModelSlotName[]): ModelsNotConfigured`（`113-119`）· `[纯函数]`
  * `export function isModelsRefusal(error: string | undefined): boolean`（`125-127`）· `[纯函数]`
  * `export function providerKeyMissing(provider: string, slots: ModelSlotName[]): ProviderKeyMissing`（`162-170`）· `[纯函数]`
  * `export function isProviderKeyRefusal(error: string | undefined): boolean`（`175-177`）· `[纯函数]`
  * 配套强类型异常类：`ModelsNotConfiguredError`（`131-137`）与 `ProviderKeyMissingError`（`181-189`）。
* **② 输入、输出与核心不变量**：**写端与匹配端同源不变量**——错误文案前缀/后缀与前端 `isModelsRefusal` / `isProviderKeyRefusal` 判别器共处同一模块，杜绝文案微调后前端无法识别而把正常的首次未配模型引导渲染成红色系统故障；`provider === "claude-code"` 特判输出启用外部 CLI 提示，其余查 `AUTH_PROVIDER_KEYS` 显示友好提供商名。
* **③–⑤ 调用接线**：`src/server/chat-handler.ts:111, 133, 249, 270`、`src/server/turn-service.ts:126, 130`、`src/agent/subagents/runner.ts:246`、`src/agent/subagents/extraction.ts:825, 834`、`app/api/graph/import/route.ts:168-171`、`components/activity-dock.tsx:234-236`、`components/artifacts/dispatch-card.tsx:43-46`、`components/chat.tsx:165`。

---

#### `parseModelIds` · `normalizeBaseUrl` · `customProviderUsable` · `slotsConfigured` · `isAppLocale` · `isHexColor`（`src/core/settings.ts:278-338, 546-548`）

* **`parseModelIds(raw)`**（`278-282`）· `[纯函数]`：将空白/逗号分隔字符串或数组过滤出非空字符串、`trim()` 并用 `Set` 保序去重（调用方：`sanitizeCustomProvider` 与 `src/server/custom-provider-http.ts:127`）。
* **`normalizeBaseUrl(raw)`**（`286-298`）· `[纯函数]`：
  * **①–③ 严格安全归一化推导**：`trim()` 空串返回 `""` → `new URL(value)` 解析失败返回 `""` → 协议非 `http:` / `https:` 返回 `""` → **若含 `username`、`password`、`search`、`hash` 或字面包含 `?` / `#`（包括空查询 `?`）一律拒绝返回 `""`**（严防用户误把密钥塞进 URL 查询串或通过锚点绕过绑定比对！）→ 剥去末尾 `/` 返回（绝不自动补 `/v1`）。
  * **④–⑤ 调用方**：`src/core/custom-provider-auth.ts:19-20`、`src/server/custom-provider.ts:130`、`src/server/custom-provider-http.ts:109`、`components/settings/keys-section.tsx:825`。
* **`customProviderUsable(cp)`**（`302-306`）· `[纯类型守卫]`：`Boolean(cp?.baseUrl)`，供模型目录判断是否挂载自定义端点（`src/server/model-catalog.ts:161`、`src/server/custom-provider.ts:46`）。
* **`slotsConfigured(models)`**（`313-315`）· `[纯函数]`：`Boolean(models?.strong?.model && models?.cheap?.model && models?.vision?.model)`，决定首页与新建会话页是否弹出首次模型配置引导（`app/page.tsx:20`、`app/chat/[id]/page.tsx:33`、`app/chat/new/page.tsx:26`）。
* **`isAppLocale(value)`**（`336-338`）与 **`isHexColor(value)`**（`546-548`）· `[纯函数]`：校验 `"auto" | "en" | "zh-CN"` 与 3/6 位 `#hex` 颜色（调用方：`src/server/settings-body.ts:94, 223`）。

---

#### `sanitizeCustomModelOverrides(raw, liveIds)` 与 `sanitizeUserSettings(raw)`（`src/core/settings.ts:639-653, 810-860`）

* **`sanitizeCustomModelOverrides(raw, liveIds)`**（`639-653`）· `[纯函数]`：
  * **①–③**：非普通对象返回 `{}`；遍历键值对，对 `key.trim()` 判空并在传入 `liveIds` 时丢弃不在当前端点模型列表中的过期覆盖项；调用私有 `sanitizeCustomModelOverride`（正整数钳制下限 `1` + 布尔 `reasoning`），通过 **`Object.defineProperty(out, id, ...)`** 安全写入结果字典（防御 `"__proto__"` 原型污染）。调用方：`src/server/custom-provider-http.ts:104, 139`。
* **`sanitizeUserSettings(raw)`**（`810-860`）· `[纯函数]`：
  * **①–③**：非普通对象返回 `null`；校验正整数 `version`（非法回退 `1`）；依次清洗 `general`、`dictation`、`claudeCode`、`agent`、`appearance`、`models`、`customProvider`、`graph` 与 `compaction`；最后遍历原对象键，**显式剔除已废弃的顶层 `"chat"` 化石键**，并将其余所有未识别的新版本顶层键原样复制到 `out` 中实现前向兼容。
  * **④ 真实代码细节标注（第 `843-848` 行）**：当前实现中 `if (r.compaction !== undefined ...)` 缩进位于 `if (r.graph !== null ...)` 代码块内部；当 `r.graph` 存在时 `compaction` 经 `sanitizeCompaction` 钳制 `32_000` 下限，若 `r.graph` 缺席而单独存在 `r.compaction`，则会由第 `856` 行原样透传。
  * **⑤ 调用方**：`src/store/settings.ts:44, 54`、`components/dictation-preference.ts:39`。

### 1.4 轻量私有清洗辅助函数归并表

| 函数名 | 行号 | 纯度 | 作用 |
|---|---|---|---|
| `clamp` / `positiveInt` / `boolOrDrop` / `sanitizeHexOrNull` | `543, 552, 558, 619` | `[纯函数]` | 数值裁剪、正整数提取、布尔提取与合法十六进制颜色或 `null` 归一。 |
| `sanitizeGeneral` / `sanitizeRoleOverride` / `sanitizeModels` | `561, 579, 604` | `[纯函数]` | 清洗通用节、单角色 `{ model, thinkingLevel }` 与三槽位（含 `cacheRetention`）。 |
| `sanitizeCustomModelOverride` / `sanitizeCustomProvider` | `624, 658` | `[纯函数]` | 清洗单个自定义模型预算 pin 及完整自定义端点配置节。 |
| `sanitizeBooleanMap` / `sanitizeAgent` | `692, 701` | `[纯函数]` | 清洗布尔开关字典及 `agent` 节（后台角色、工具开关、提示词开关、搜索引擎、图谱工具）。 |
| `sanitizeMdRendering` / `sanitizeAppearance` / `sanitizeGraph` / `sanitizeCompaction` | `735, 747, 763, 795` | `[纯函数]` | 清洗排版样式、外观字号、图谱开关/分块预算下限（`500`）及压缩阈值下限（`32000`）。 |

---

## 2. `src/core/settings-resolution.ts`（277 行）

### 2.1 导出函数逐一五要素精讲（全部 8 个函数均为 `[纯函数]`）

#### `resolveSlot` · `resolveModelSpec` · `resolveRoleSpec` · `resolveConversationSpec`（`src/core/settings-resolution.ts:111-168`）

* **`resolveSlot(slot)`**（`140-146`）：若 `!slot?.model` 返回 `null`（孤立的 `thinkingLevel` 或 `cacheRetention` 不构成可用槽位）；否则返回具体化的 `EffectiveSlot`。
* **`resolveModelSpec(role, override, slots)`**（`154-168`）：根据 `ROLE_SLOT[role]` 找到所属槽位，`model = override?.model ?? slot?.model`（空则返回 `undefined`），`thinkingLevel = override?.thinkingLevel ?? slot?.thinkingLevel`（模型与思考预算**字段级独立继承**！）。
* **`resolveRoleSpec(role, record)`**（`131-135`）：仅当 `role` 属于 `BACKGROUND_MODEL_ROLES` 时读取 `record?.agent?.models?.[role]` 作为覆盖项传入 `resolveModelSpec`。调用方：`src/server/chat-handler.ts:153`。
* **`resolveConversationSpec(chat, strong)`**（`111-122`）：前景对话会话专用解析链——`model = chat?.model ?? strong`，空返回 `null`；`thinkingLevel = chat?.thinkingLevel ?? strong?.thinkingLevel`。调用方：`src/server/chat-handler.ts:247, 697`、`src/server/jobs.ts:256`。

---

#### `resolveSettings(record)` 与三条图谱门控函数（`src/core/settings-resolution.ts:174-276`）

* **`resolveSettings(record: UserSettings | null): EffectiveSettings`**（`174-241`）：
  * **①–③**：允许传入 `null`（首次启动无 `settings.json`）；对 `general`、`dictation`、`appearance`（及嵌套 `mdRendering`）、`graph`、`compaction` 逐字段执行 `recordVal ?? FACTORY_SETTINGS.xxx` 合入默认值；对 5 个后台角色调用 `resolveModelSpec`，对 `strong/cheap/vision` 调用 `resolveSlot`（未配置保持 `undefined` / `null`）；`agent` 下的开关字典与 `customProvider` 缺省归一为空对象/空数组。
  * **④–⑤ 调用方**：`src/server/stores.ts:47`（`effectiveSettings()` 源头）、`app/page.tsx:18`、`components/settings/agent-section.tsx:589`、`appearance-section.tsx:357`、`extraction-coverage.tsx:75`。
* **`extractionEnabled(graph)`**（`250-252`）、**`renderingEnabled(graph)`**（`259-261`）、**`graphToolsEnabled(effective)`**（`270-276`）：
  * 分别控制后台自动抽取写通道（`graph.enabled`）、首页画布 vs 链表展示（`graph.rendering`），以及探测者/练习者图谱只读工具注册门控（**`effective.graph.enabled && (effective.agent.graphTools.enabled ?? true)`**——总开关关闭时自动连带关闭 Agent 图谱工具）。调用方：`src/server/chat-handler.ts:515, 546, 653`。

---

## 3. `src/core/auth-keys.ts`（218 行）

### 3.1 导出函数逐一五要素精讲（全部 5 个函数均为 `[纯函数]`）

* **`isKnownAuthKey(id)`**（`55-57`）与 **`isProviderEnvVar(envVar)`**（`144-146`）：分别基于预构建集合 `AUTH_KEY_IDS`（3 个精选外围服务 Key：`DEEPGRAM_API_KEY`、`TAVILY_API_KEY`、`BRAVE_API_KEY`）与 `AUTH_PROVIDER_ENV_VARS`（35 个 Pi 模型提供商对应的去重环境变量集合）做 $O(1)$ 校验。调用方：`src/server/keys.ts:69, 217`。
* **`validateKeyShape(id, rawValue)`**（`163-183`）：对 `rawValue.trim()` 检查无内部空白字符（`!/\s/.test(value)`）且长度 `>= 20`；其中 `TAVILY_API_KEY` 额外校验 `value.startsWith("tvly-")`；不在 3 个精选键之列一律返回 `{ ok: false, error: "unknown key ..." }`。调用方：`src/server/keys.ts:217`。
* **`genericProviderKeyGuard(id, rawValue)`**（`187-191`）：对模型提供商密钥校验 `trim()` 后长度 `>= 12` 且无任何空白字符，拦截粘贴半截或夹带换行的坏 Key。调用方：`src/server/keys.ts:217`。
* **`maskKey(value)`**（`196-200`）：`trim()` 后若长度 `<= 4` 返回 `` `…${v}` ``，否则返回末尾 4 字符 `` `…${v.slice(-4)}` ``，确保明文密钥永不经 API 流出服务端。调用方：`src/server/keys.ts:167`。

---

## 4. `auth-env.ts`（24 行） · `custom-provider-auth.ts`（26 行） · `dictation.ts`（90 行） · `search.ts`（53 行） · `prompt-segments.ts`（50 行）

### 4.1 `src/core/auth-env.ts`——环境变量溯源与外部 CLI 净化

* **非纯边界标注**：`[非纯: 读写 globalThis[Symbol.for("lh.authBoot")]]`（不进桶导出）。
* **`authEnvRecord(): AuthBoot`**（`10-14`）：在 `globalThis` 的全局唯一 `Symbol.for("lh.authBoot")` 槽位上惰性初始化并返回 `{ realEnv: Set<string>, fillGap: Set<string> }` 单例（抗 Next.js 模块重复打包分裂）。调用方：`src/server/keys.ts:64`、`src/server/custom-provider-auth.ts:24, 38`。
* **`externalCliEnv(env = process.env): NodeJS.ProcessEnv`**（`17-24`）：浅拷贝传入环境字典，遍历 `fillGap`（由 LearnHarness 密钥库动态补入 `process.env` 的变量名），若 `!realEnv.has(name)` 则从拷贝字典中 `delete result[name]`，纯净化后交由 Claude Code 子进程启动器使用（`src/agent/claude-code/stream.ts:631`、`installation.ts:12`）。

### 4.2 `src/core/custom-provider-auth.ts`——自定义端点防串发授权校验

* **`parseCustomAuthBinding(value)`**（`13-23`）· `[纯函数]`：解析 `auth.json["__learnharness_custom_provider_binding"]` JSON 字符串，严验 `version === 1`、32 位小写 hex `id`、`authMode`（`"apiKey" | "keyless" | "disabled"`；非 `"disabled"` 必须带 `baseUrl`），且 `baseUrl` 与可选 `fileKeyBaseUrl` 必须与 `normalizeBaseUrl(...)` 完全相等，任何不合规返回 `undefined`。调用方：`src/store/auth.ts:81, 91, 96`。
* **`customBindingMatches(cp, binding)`**（`24-26`）· `[纯函数]`：校验 `cp?.baseUrl` 非空、`binding.authMode !== "disabled"`，且 `cp.credentialBindingId === binding.id`、`cp.baseUrl === binding.baseUrl`、`cp.authMode === binding.authMode` 三者全部一致才返回 `true`。调用方：`src/server/custom-provider.ts:46`、`src/server/custom-provider-auth.ts:22, 32`。

### 4.3 `src/core/dictation.ts`——听写语言目录与直连 URL 构造

* **`isDictationLanguage(value)`**（`80-82`）· `[纯类型守卫]`：检查输入是否属于 `DICTATION_LANGUAGES`（含 `"multi"` 多语混说模式及由 64 族语言展平排序出的全部 Nova-3 单语/区域代码）。调用方：`src/core/settings.ts:825`、`src/server/settings-body.ts:410`、`components/dictation-preference.ts:72`。
* **`deepgramListenUrl(language)`**（`85-90`）· `[纯函数]`：拼接固定音频流参数（`model=nova-3`、`encoding=linear16`、`sample_rate=16000`、`channels=1`、`smart_format=true`、`punctuate=true`、`endpointing=300`）并对 `language` 做 `encodeURIComponent`，生成浏览器直连 Deepgram 的 WSS URL。调用方：`components/dictation.tsx:375`。

### 4.4 `src/core/search.ts`——搜索提供商六边形端口契约

* **纯类型模块（零运行时函数）**：导出 `SearchHit`（`27-31`：`{ title, url, snippet }`）、`SearchEngineId = "tavily" | "brave"`（`34`）、`SearchProvider` 端口接口（`40-43`：`id` + `search(query, count)`）及 `SearchStatus`（`47-53`），使 Agent 层研究工具完全不依赖具体搜索引擎 HTTP 实现。

### 4.5 `src/core/prompt-segments.ts`——提示词片段镜像路径语法守卫

* **`isValidSegmentPath(segmentPath)`**（`45-50`）· `[纯函数]`：若严格等于 `"system-prompt.md"` 返回 `true`；否则必须匹配 `/^(prober|teacher|practice|shared)\/([\w.-]+\.md)$/` 且子文件名进一步匹配数字前缀正则 `FRAGMENT_RE = /^\d+-[\w.-]+\.md$/`（`17`）。单点锁死跨目录穿越（`..`）、嵌套子目录与 `README.md` 等非提示词文档。调用方：`src/agent/prompt-segments.ts:54`、`src/store/prompt-overrides.ts:56, 64, 73, 80`、`app/api/settings/prompts/[...segment]/route.ts:42`。
