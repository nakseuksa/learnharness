# 第 12 卷：跨平台快捷键引擎与模糊匹配评分

> **覆盖源码文件**：`src/core/keyboard.ts`（234 行） · `src/core/fuzzy.ts`（37 行）  
> **合计行数**：271 行 | **桶导出状态**：2 个文件均全量导出于 `src/core/index.ts`（浏览器安全）  
> **纯度概览**：`fuzzy.ts` 为 100% 严格纯函数；`keyboard.ts` 中核心归一化、格式化、事件名合成为严格纯函数，`loadOverrides` / `saveOverrides` 带有受 SSR 守卫保护的浏览器 `window.localStorage` 读写边界（已明确标注）。

---

## 本卷导读与客户端交互一致性设计

本卷包含两个精悍但贯穿整个桌面/Web 交互体验的客户端基础模块：

1. **快捷键单一事实源（`keyboard.ts`）**：集中定义了全局及各视图（会话、图谱、答题 dock）的 17 项键盘动作、跨 macOS/Windows/Linux 的修饰键归一化规则、**非 ASCII 键盘布局（如俄语、希腊语或 macOS `Option` 特殊字符）向物理 `KeyA–KeyZ`/`Comma` 键位的自动回退算法**、以及防止事件名拼写错位的单一事件名构造函数 `kbdEventForAction`。
2. **多字段分词模糊打分器（`fuzzy.ts`）**：移植自 Pi `/model` 选择器的紧凑评分算法，同时驱动模型菜单搜索、侧边栏会话搜索、图谱命题链搜索与来源文件夹树过滤。

---

## 1. `src/core/keyboard.ts`（234 行）

### 1.1 模块定位与纯度边界

* **设计目的**（`src/core/keyboard.ts:1-20`）：将快捷键定义、平台符号渲染、DOM `KeyboardEvent` 归一化与用户自定义改键合并集中在一个零 React 依赖的模块中，供全局分发器（`components/keyboard-shortcuts.tsx`）、快捷键提示组件（`Hint`）、快捷键一览表（cheat sheet）和设置页改键面板共享。
* **桶导出状态**：由 `src/core/index.ts:67` 全量导出。
* **非纯边界标注**：
  > **[非纯边界说明]**：
  > 1. `IS_MAC`（`204-205`）在模块加载时读取一次 `navigator.platform || navigator.userAgent`（SSR 下安全求值为 `false`），导致 `formatBinding` 的输出随运行宿主平台（macOS `⌘⇧F` vs Windows/Linux `Ctrl+Shift+F`）而定。
  > 2. `loadOverrides`（`95-106`）与 `saveOverrides`（`111-119`）读写浏览器本地 `window.localStorage["lh:keymap"]`（SSR 无 `window` 或隐私模式禁用存储时均 try-catch 静默回退默认键位，绝不抛错）。注意改键覆盖**仅保存在当前设备浏览器本地**，刻意不写入跨设备学习数据 `data/settings.json`。

### 1.2 核心类型与注册表常量契约

| 类型 / 常量 | 行号 | 结构与业务规则 |
|---|---|---|
| `KeyAction` | `22-39` | 全部 17 种动作字面量联合（如 `"toggle-dictation"`、`"cycle-thinking"`、`"toggle-sidebar"`、`"question-focus"` 等）。 |
| `KeyScope` | `43` | `"global" \| "chat" \| "graph"`：仅用于快捷键一览表分组展示；实际事件派发为全局广播，未挂载的界面自动忽略。 |
| `KeyActionDef` | `45-55` | `{ id: KeyAction; label: string; scope: KeyScope; binding: string; displayOnly?: boolean }`。**关键字段 `displayOnly`**：标记为 `true` 的 5 个答题 dock 行内导航键（`tab`、`arrowdown`、`arrowup`、`space`、`enter`）**只在一览表和设置页作为固定说明展示，绝不由全局快捷键注册表派发，也不可改键**，从而避免在非答题场景抢占方向键、空格和回车。 |
| `KEYBOARD_ACTIONS` | `57-88` | 17 项默认快捷键权威清单（规范化绑定格式固定为 `mod+alt+shift+<key>` 小写顺序，如 `"mod+shift+f"`、`"shift+tab"`、`"?"`、`"f2"`）。 |
| `STORAGE_KEY` | `90` | `"lh:keymap"`：`localStorage` 存储键名。 |

---

### 1.3 导出函数与核心内部算法精讲

#### `loadOverrides`、`saveOverrides`、`effectiveKeymap`、`actionForBinding` 与 `bindingForAction`（`src/core/keyboard.ts:95-145`）

* **① 签名与职责定位**：
  * `export function loadOverrides(): Partial<Record<KeyAction, string>>`（`95-106`）· `[非纯: 读 localStorage]`
  * `export function saveOverrides(overrides: Partial<Record<KeyAction, string>>): void`（`111-119`）· `[非纯: 写 localStorage]`
  * `export function effectiveKeymap(): Map<string, KeyAction>`（`122-131`）· `[依赖 loadOverrides]` · 构建“规范化按键字符串 → 动作 ID”的生效查找表。
  * `export function actionForBinding(binding: string): KeyAction | undefined`（`134-136`）· 根据规范化按键字符串反查触发动作。
  * `export function bindingForAction(id: KeyAction): string`（`139-145`）· 查询某动作当前生效的按键字符串（供按钮 Tooltip 与一览表显示）。
* **② 输入、输出与核心不变量**：
  * **仅存覆盖差量（Delta overrides）**：当用户全部恢复默认（`overrides` 为空对象 `{}`）时，`saveOverrides` 直接调用 `localStorage.removeItem("lh:keymap")` 清空存储条目。
  * **`displayOnly` 隔离不变量**：`effectiveKeymap` 遍历 `KEYBOARD_ACTIONS` 时遇到 `def.displayOnly` 立即 `continue` 跳过，即使有人手工篡改 `localStorage` 塞入 `question-submit` 覆盖键，也绝不会被全局分发器采纳。
* **③–⑤ 调用接线**：`components/settings/keyboard-section.tsx:57, 77, 86, 91`（设置页改键与重置）、`components/keyboard-shortcuts.tsx:108, 189`、`components/ui/hint.tsx:39`。

---

#### `eventBinding(e)` 与内部 `modifiedKey(e)`（`src/core/keyboard.ts:154-179`）

* **① 签名与职责定位**：
  * `export function eventBinding(e: KeyboardEvent): string`（`154-166`）· `[纯函数]` · 将原生键盘事件归一化为跨平台、跨语言输入法的标准绑定字符串。
  * `function modifiedKey(e: KeyboardEvent): string`（`171-179`）· `[纯函数]` · 解析带修饰键时的基础键名（含非 ASCII 物理键位回退）。
* **② 输入、输出与核心不变量**：
  1. **双修饰符统一为 `mod`**：`const mod = e.metaKey || e.ctrlKey`，在 macOS 上按 `⌘K` 或外接键盘按 `Ctrl+K` 均归一化为 `"mod+k"`。
  2. **裸可打印字符吞并 `shift`**：不带 `mod` 与 `alt` 的单字符可打印键（如按 `Shift+/` 打出 `"?"`），其 Shift 语义已经烘焙进字符本身，直接返回 `e.key.toLowerCase()`（即 `"?"` 而非 `"shift+?"`）；但若同时按了 `mod`/`alt`（如 `⌘⇧F`）或是非打印功能键（如 `Shift+Tab`、`Shift+Enter`），则显式保留 `"shift"` 前缀（生成 `"mod+shift+f"`、`"shift+tab"`）。
  3. **非 ASCII 布局物理键位回退（而 ASCII 布局保持字符语义）**：在按住 `Ctrl / ⌘ / Alt` 时，若 `e.key` 是单个非 ASCII 字符（`e.key.length === 1 && e.key > "\x7f"`，例如俄语键盘按 `Ctrl+л`、土耳其语特殊字母、或 macOS 按 `Option+K` 产生符号 `"˚"`），`modifiedKey` 会回退读取物理扫描码 `e.code`：`Comma` 映射为 `","`，`/^Key([A-Z])$/` 映射为对应小写英文字母 `"a"–"z"`！反之，法语 AZERTY 等 ASCII 布局在物理 `KeyA` 上报告 `"q"`（`<= "\x7f"`），则严格尊重用户布局返回 `"mod+q"`。
* **③ 微妙边界细节（第 `173` 行注释）**：为什么判断单字符与 ASCII 必须在原始 `e.key` 上做，而不是在 `const key = e.key.toLowerCase()` 之后做？因为像土耳其语大写字母 `"İ"`（单字符 U+0130）执行 `.toLowerCase()` 后会膨胀成两个码元 `"i\u0307"`（`length === 2`）！先检查原始 `e.key.length !== 1 || e.key <= "\x7f"` 避开了 Unicode 大小写折叠陷阱。
* **④–⑤ 调用接线**：`components/keyboard-shortcuts.tsx:108`（全局监听匹配）与 `components/settings/keyboard-section.tsx:74`（录入新快捷键时复用完全相同的归一化逻辑，确保“录进去什么就能匹配什么”）。

---

#### `kbdEventForAction`、`isTypingSurface` 与 `formatBinding`（`src/core/keyboard.ts:188-234`）

* **① 签名与职责定位**：
  * `export function kbdEventForAction(action: KeyAction): string`（`188-190`）· `[纯函数]` · 统一拼接自定义 DOM 事件名 `` `lh:kbd-${action}` ``。
  * `export function isTypingSurface(e: KeyboardEvent): boolean`（`195-201`）· `[纯函数]` · 判断键盘事件目标是否处于文本输入控件（`INPUT`、`TEXTAREA`、`SELECT` 或 `isContentEditable`）。
  * `export function formatBinding(binding: string): string`（`223-234`）· `[依赖平台常量 IS_MAC 的纯函数]` · 将 `"mod+shift+f"` 格式化为人类可读符号（macOS 为 `"⌘⇧F"`，其他平台为 `"Ctrl+Shift+F"`）。
* **②–④ 历史事故与边界设计**：
  * **`⌘B` 失灵事故（2026-09-25）**：此前侧边栏监听 `"lh:toggle-sidebar"`，而全局分发器派发 `"lh:kbd-toggle-sidebar"`，两边手写字符串导致侧边栏快捷键静默失效；抽成 `kbdEventForAction(action)` 后从类型与构造上彻底杜绝拼写分叉。
  * **`isTypingSurface` 的保护作用**：在输入框内打字时，单字符键（如输入问号 `?`）或 `F2` 被全局分发器放行给输入框正常录入，而带修饰符的快捷键（如 `Mod+K`、`Mod+D`）和专职切换思考级别的 `Shift+Tab` 仍可穿透触发。
* **⑤ 上游调用方与系统接线**：`components/keyboard-shortcuts.tsx:114, 137`、`components/sidebar.tsx:176`、`components/session-find.tsx:94`、`components/enter-submits.ts:69`、`components/ui/hint.tsx:39-41`。

---

## 2. `src/core/fuzzy.ts`（37 行）

### 2.1 模块定位与纯度边界

* **设计目的**（`src/core/fuzzy.ts:1-5`）：为模型选择器及全应用内联搜索列表提供零依赖、高区分度的多词多字段模糊匹配打分器。
* **桶导出状态**：由 `src/core/index.ts:68` 全量导出。
* **纯度边界**：单函数模块，**100% 严格确定性纯函数**。

### 2.2 导出函数精讲

#### `fuzzyScore(query, ...fields)`（`src/core/fuzzy.ts:16-37`）

* **① 签名与职责定位**：`export function fuzzyScore(query: string, ...fields: string[]): number | null` · `[纯函数]` · 对候选条目的多个文本字段针对用户输入查询词进行匹配判定与相关性打分。
* **② 输入、输出与核心不变量**：
  1. **空查询全匹配**：空白或空字符串查询返回 `0`（所有候选项得分相同，依赖外层稳定排序保持原始列表顺序）。
  2. **多词 AND、跨字段 OR 不变量**：查询词按空白拆分为多个小写 `tokens`；**每一个 `token` 都必须在至少一个 `field` 中作为子串命中**，只要有一个词在所有字段中都找不到（`best < 0`），立即返回 `null` 淘汰该候选（例如搜 `"anthropic sonnet"` 时，`"anthropic"` 命中 `provider` 字段、`"sonnet"` 命中 `id` 字段即可通过）。
  3. **四档阶梯分值体系**：完全相等 > 前缀匹配 > 靠前子串 > 靠后子串，且整句连续命中额外重奖。
* **③ 核心逻辑与打分公式逐步推导**：
  1. 预处理：`tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)`；若空返回 `0`；将所有 `fields` 转为小写数组 `hay`。
  2. 外层遍历每个 `token`，内层遍历每个字段 `f` 取单 token 最高分 `best`：
     * **精确全等（`f === token`）**：`100` 分；
     * **前缀匹配（`f.startsWith(token)`）**：`60` 分；
     * **内部子串命中（`at = f.indexOf(token), at !== -1`）**：`30 - Math.min(at, 27)` 分（即位置越靠前分越高，最低保底 `3` 分，绝不会扣成负数或 `0`）。
  3. 若某 `token` 的 `best < 0`，直接 `return null`；否则累加 `total += best`。
  4. **整词组连续奖励（Contiguity Bonus，第 `34-35` 行）**：令 `joined = tokens.join(" ")`，若任意单个字段 `f.includes(joined)` 为真，额外 `total += 50`！（例如搜 `"glm flash"` 时，字面包含 `"glm flash"` 的条目会比中间隔着版本号的 `"z-ai/glm-5.3-flash"` 多拿 50 分排在前面；单 token 查询因为本身包含自身，所有命中项同加 50 分不影响相对名次）。
* **④ 边界条件与历史事故背景**：对特殊正则字符完全免疫（全程使用 `startsWith` / `indexOf` / `includes` 字面量比较，无需正则转义，用户输入 `[`、`*`、`\` 绝不抛错）。
* **⑤ 上游调用方与系统接线**：
  * `components/settings/search-menu-list.tsx:46` & `components/settings/model-menu.tsx:175, 246, 252`（模型、提供商与字体选择菜单）；
  * `components/sidebar.tsx:435`（侧边栏会话搜索）；
  * `components/chain-table.tsx:214`（知识图谱链表搜索 `name`、`statement`、`aliases`）；
  * `components/source-folder-tree.tsx:47, 55, 138`（来源文件夹树过滤）。
