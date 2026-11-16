# 第 09 卷：来源树组织、文本路径解析与数学排版恢复

> **覆盖源码文件（共 10 个）**：  
> • 来源系统（4）：`src/core/source-organization.ts`（152 行） · `src/core/source-selection.ts`（43 行） · `src/core/source-label.ts`（6 行） · `src/core/source-errors.ts`（22 行）  
> • 内容与文本处理（6）：`src/core/content-reader.ts`（215 行） · `src/core/math-delims.ts`（121 行） · `src/core/file-paths.ts`（86 行） · `src/core/session-markdown.ts`（205 行） · `src/core/session-find.ts`（20 行） · `src/core/session-navigation.ts`（47 行）  
> **合计行数**：877 行 | **桶导出边界**：除 `content-reader.ts` 为内部底层模块（经 `math-delims.ts` 向外服务）外，其余 9 个文件均导出于 `src/core/index.ts`（浏览器安全，无 Node 依赖）。  
> **纯度概览**：全卷 **39 个函数均为 100% 确定性纯函数**（仅 `content-reader.ts:94` 的 `knownTexCommand` 带有确定性布尔结果记忆化缓存 `knownCommands: Map<string, boolean>`，对输入输出语义完全透明）。

---

## 本卷导读：“表现层投影永不污染持久化源数据”

本卷涵盖“知识图谱来源管理（`source`）”与“会话/工具文本解析与数学排版恢复”两大子域，10 个文件严格贯彻同一条铁律——**一切美化、树组织、路径胶囊化与数学转义恢复均是无损只读投影**：

1. **来源组织仅是展示元数据（`source-*.ts`）**：自定义显示名与嵌套文件夹存放在独立的 `data/graph/source-organization.json` 侧车文件中，**绝不改变图谱的来源身份哈希（`src_<hash>`）与节点出处（`provenance`）**。
2. **工具数学内容三层分离恢复（`content-reader.ts` + `math-delims.ts`）**：持久化的工具参数保留模型原始字节（确保选项身份、洗牌种子与判分永不变更）；仅在 UI 展示层通过 `repairMathForDisplay` 先用 CommonMark 语法树锁死代码禁区，再还原文档换行、JSON 吞噬控制字符与过度转义反斜杠。
3. **UTF-16 偏移无损对齐与消息粒度深链（`file-paths.ts` · `session-find.ts` · `session-navigation.ts` · `session-markdown.ts`）**：无论是输入框反引号路径胶囊、会话内 `Mod+F` 查找，还是从图谱节点精确跳回首次讲出该命题的教师段落（`#message-<id>`），全部基于精确偏移量或稳定部件 ID 运行。

---

## 1. `src/core/source-organization.ts`（152 行）

### 1.1 模块定位与纯度边界

* **设计目的**（`src/core/source-organization.ts:3-4`）：以原子操作（Operation-based）方式维护链表视图中会话与导入笔记的树状目录结构，防止整包覆盖导致的并发修改丢失。
* **桶导出与纯度**：导出于 `src/core/index.ts`；全部 8 个导出函数均为 **100% 纯函数**（状态演进一律先执行 `structuredClone(state)`，新文件夹 ID 与时间戳通过参数显式注入）。

### 1.2 核心接口与动作契约（`src/core/source-organization.ts:5-39`）

* `SourceFolder`（`5-12`）：`{ id, name, parentId: string | null, createdAt, importPath?: string }`（`importPath` 跨越重命名与移动保留导入时的原始相对目录路径）。
* `SourcePlacement`（`13-17`）：`{ folderId: string | null; name?: string }`（`name` 仅覆盖导入文件的展示名；会话标题归 `ChatStore` 管理）。
* `SourceOrganization`（`18-22`）、`SourceEntry`（`23-29`）、`SourceDirectory`（`30-33`）、以及 5 种原子动作联合 `OrganizationAction`（`34-39`：`create-folder`、`rename-folder`、`rename-source`、`move`、`delete-folder`）。

### 1.3 导出函数逐一五要素精讲

#### `emptySourceOrganization` · `placementOf` · `folderIsEmpty` · `canMoveFolder`（`src/core/source-organization.ts:41-61`）

* **① 签名与职责定位**：
  * `export const emptySourceOrganization = (): SourceOrganization`（`41`）· `[纯函数]`
  * `export const placementOf = (state: SourceOrganization, id: string): SourcePlacement | undefined`（`42-43`）· `[纯函数]`
  * `export function folderIsEmpty(state: SourceOrganization, id: string, sourceIds: ReadonlySet<string>): boolean`（`45-48`）· `[纯函数]`
  * `export function canMoveFolder(state: SourceOrganization, id: string, parentId: string | null): boolean`（`51-61`）· `[纯函数]`
* **② 输入、输出与核心不变量**：
  * `placementOf` 强制使用 `Object.hasOwn(state.placements, id)` 防御 `"__proto__"` / `"constructor"` 原型链属性伪命中；
  * `folderIsEmpty` 只认**当前存活来源集 `sourceIds`** 中的成员（残留已删旧源的孤儿 `placement` 不阻塞空文件夹判定）；
  * `canMoveFolder` 保证把文件夹 `id` 挂到 `parentId` 下后祖先链严格有穷无环且每一跳父文件夹真实存在。
* **③ `canMoveFolder` 逐步推导**：令 `seen = new Set([id])`，从 `next = parentId` 循环上溯直到 `null`：若 `seen.has(next)`（拖入自身或自身后代，或既有环）返回 `false`；将 `next` 加入 `seen`，在 `state.folders` 中查找该父节点，未找到返回 `false`，否则推进 `next = folder.parentId`；到达 `null` 返回 `true`。
* **④–⑤ 调用方**：`components/source-folder-tree.tsx:49, 125, 144, 162, 180`、`src/server/source-deletion.ts:59`、本文件 `parseSourceOrganization` 与 `applyOrganizationAction`。

---

#### `parseSourceOrganization(raw)` 与 `parseOrganizationAction(raw)`（`src/core/source-organization.ts:64-100`）

* **① 签名与职责定位**：
  * `export function parseSourceOrganization(raw: unknown): SourceOrganization`（`64-83`）· `[纯函数]` · 侧车文件读写双端完整性守卫。
  * `export function parseOrganizationAction(raw: unknown): OrganizationAction`（`85-100`）· `[纯函数]` · HTTP 请求动作解析与字符串 `trim()` 清洗。
* **②–③ 核心逻辑推导**：
  * `parseSourceOrganization` 采用 **Fail-Closed 拒绝覆盖策略**：校验 `version === 1`、`folders` 数组与普通对象 `placements` → 遍历文件夹校验非空唯一 `id`、非空白 `name`、字符串 `createdAt` → 对每个文件夹调用 `canMoveFolder(state, f.id, f.parentId)` 验证全树无环 → 遍历 `placements` 确认每个非 `null` 的 `folderId` 都在 `ids` 中且可选 `name` 非空白；任何违例立即抛错，绝不静默重置为空状态冲掉用户数据。
  * `parseOrganizationAction` 按 5 个 `r.action` 分支校验必填 `id()`、去首尾空白的 `name()`、`parentId`（`null | string`）及 `move` 的 `kind`（`"source" | "folder"`）。
* **④–⑤ 调用方**：`src/store/source-organization.ts:19, 23`、`src/server/source-organization.ts:40`。

---

#### `applyOrganizationAction` 与 `placeImportedSource`（`src/core/source-organization.ts:103-152`）

* **`applyOrganizationAction(state, action, sourceIds, newFolder)`**（`103-128`）· `[纯函数]`：
  * **①–③ 逐步推导**：`structuredClone(state)` 深拷贝 → 若动作含非空 `parentId` 且目标父文件夹不存在，抛 `SourceOrganizationError(..., "parent_folder_missing")` → `create-folder` 推入新文件夹返回 → `move` + `source` 校验 `sourceIds.has(action.id)`（否则抛 `"source_missing"`）后更新 `placements[id].folderId` → 其余动作定位目标 `folder`（不存在抛 `"folder_missing"`）：`rename-folder` 改名；`move` 调 `canMoveFolder`（成环抛 `"folder_cycle"`）改 `parentId`；`delete-folder` 调 `folderIsEmpty`（非空抛错拒绝），移除文件夹并将任何指向它的残留孤儿 `placements` 置回 `folderId: null`。
  * **④–⑤ 调用方**：`src/server/source-organization.ts:55`。
* **`placeImportedSource(state, sourceId, filePath, makeFolder)`**（`132-152`）· `[纯函数]`：
  * **①–③ 逐步推导**：若 `placementOf(state, sourceId)` 已存在直接原样返回 `state`（重导入绝不覆盖用户已有归档位置！）；提取目录段 `directories = filePath.split("/").slice(0, -1)`；**从最深层目录 `i = directories.length - 1` 倒序向根查找**是否已有 `f.importPath === prefix` 的现存文件夹——命中则直接从 `start = i + 1` 续建缺失子目录（不重建已被用户移走或删掉的上层空祖先目录！），最后将 `sourceId` 安放在最末级 `parentId` 下返回。
  * **④–⑤ 调用方**：`src/server/source-organization.ts:76`。

---

## 2. `src/core/source-selection.ts`（43 行） · `source-label.ts`（6 行） · `source-errors.ts`（22 行）

### 2.1 `source-selection.ts` 导出函数逐一五要素精讲

* **`folderEntries(directory, id)`**（`4-15`）· `[纯函数]`：
  * **①–⑤**：收集目标文件夹 `id` 自身及所有上溯祖先链能命中 `id` 的子孙文件夹集合 `folders`（内含 `seen` 防环），再过滤出 `folderId` 落在该集合内的全部存活 `sources` ID。供 `folderEntryCheck` 与 `toggleSourceEntries` 调用。
* **`folderEntryCheck(directory, id, selected)`**（`16-21`）· `[纯函数]`：
  * **①–⑤**：统计 `folderEntries` 返回的 `sources + folders` 中已选中的个数 `count` 与总数 `total`（因含文件夹自身，`total >= 1` 恒成立），返回 `{ checked: count === total, indeterminate: count > 0 && count < total }`，支持空文件夹的独立选中态展示。调用方：`components/chain-table.tsx:295, 778`、`components/source-folder-tree.tsx:182`。
* **`toggleSourceEntries(directory, selected, kind, id, checked)`**（`24-43`）· `[纯函数]`：
  * **①–⑤**：克隆 `sources` 与 `folders` 集合 → 按 `kind` 批量勾选或取消目标源/整棵子树 → 按文件夹深度**从深到浅（自底向上）**排序扫描：跳过无子文件夹且无子源的**空文件夹**（保护空文件夹自身的勾选状态不被清空！），对非空文件夹，当且仅当全部直接子文件夹与直接子源均已选中时将其加入 `folders`，否则移出。调用方：`components/chain-table.tsx:780`。

### 2.2 `source-label.ts` 导出函数五要素精讲

* **`sourceFileLabel(filePath)`**（`3-6`）· `[纯函数]`：
  * **①–⑤**：`const base = filePath.split(/[\\/]/).pop() || filePath; return base.replace(/\.[^.]+$/, "") || base;`——兼容 POSIX `/` 与 Windows `\` 取文件名，仅去掉最后一个后缀（以 `.` 开头的单段隐藏文件如 `".env"` 因替换为空串触发 `|| base` 安全保留原名），原样保留大小写与标点。调用方：`src/core/graph.ts:574`、`src/server/source-organization.ts:28`、`components/chain-table.tsx:187, 242`。

### 2.3 `source-errors.ts`（`1-22`）——机器错误码与异常类

* 无普通函数，导出 18 项字面量元组 `SOURCE_ERROR_CODES`（`4-14`）、`SourceErrorCode`（`15`）、`SourceNoticeCode = "pdf_scanned"`（`18`）以及带 `readonly code: SourceErrorCode` 属性的 `SourceOrganizationError` 类（`20-22`），供服务端路由返回稳定机器码、前端按语言词典本地化。

---

## 3. `src/core/content-reader.ts`（215 行）

### 3.1 模块定位与纯度边界

* **设计目的**（`1-2`）：为工具内容的数学与文档恢复提供**保持源码字节区间不变**的 Markdown/TeX 词法边界划分器（绝不将语法树重序列化回 Markdown）。
* **纯度边界**：全部 7 个导出函数与 3 个私有辅助均为纯函数（`knownCommands` 仅为 KaTeX 固定命令表的幂等缓存）。

### 3.2 导出函数逐一五要素精讲

#### `readContentSpans(text)` 与 `mapMathContent(text, transform)`（`src/core/content-reader.ts:36-92`）

* **① 签名与职责定位**：
  * `export function readContentSpans(text: string): ContentSpan[]`（`36-88`）· `[纯函数]`
  * `export function mapMathContent(text: string, transform: (body: string, display: boolean) => string): string`（`90-92`）· `[纯高阶函数]`
* **② 输入、输出与核心不变量**：`spans.map(s => s.raw).join("") === text` 恒成立；所有 `code` 与 `inlineCode` 区间由真实渲染栈解析器 `fromMarkdown`（私有 `literalRanges`，`21-31`）精确划定为不可穿透屏障 `barrier`；行内公式不可跨越代码屏障或空行 `blankLine`。
* **③ 核心逻辑逐步推导**：游标 `i` 扫描 `text` → 撞上 `barrier` 则切出整块 `{ kind: "code" }` → 撞上未转义 `\(` 或 `\[` 则向右找配对闭合符 → 撞上未转义 `$` 串（长度 `size`）：若 `size >= 2` 且独立成行，按行向下匹配闭合 `$` 行（`display = true`），否则在同一段落内匹配**等长 `size`** 的闭合 `$` 串 → 配对成功切出 `{ kind: "math", raw, open, body, close, display }`，未闭合则退化为普通 `"prose"`。`mapMathContent` 仅对 `"math"` 切片的 `body` 应用 `transform` 后原定界符拼回。
* **④–⑤ 调用方**：本文件 `recoverDocumentLayout`（`181`）及 `src/core/math-delims.ts:41, 69, 114`。

---

#### `knownTexCommand` · `canParseTex` · `numericPercentEscape` · `texRanges` · `outsideTexComments`（`src/core/content-reader.ts:97-176`）

* **`knownTexCommand(name)`**（`97-105`）· `[纯函数 + 记忆化]`：非纯英文字母返回 `false`；查缓存未命中时调用 `katex.renderToString("\\" + name, { throwOnError: true, trust: false, strict: false })`，只要异常消息不含 `"Undefined control sequence: \\" + name` 即判定为合法已知 TeX 命令并写入缓存。
* **`canParseTex(body, display)`**（`107-110`）· `[纯函数]`：测试 `body` 在指定 `displayMode` 下能否通过 KaTeX 解析，供反斜杠修复后做防劣化回滚检查。
* **`numericPercentEscape(inner, percent)`**（`113-121`）· `[纯函数]`：识别数字后紧跟偶数（$\ge 2$）个反斜杠与 `%`、且后面没有同行英文注释词或多行算式的过转义百分号（如 `95\\%`），避免将其误判为 TeX 注释。
* **`texRanges(inner)`**（`126-168`）· `[纯函数]`：单遍扫描公式内部，识别真正的 `"comment"` 区间，以及 `\begin{...}...\end{...}` 与 `\substack{...}` 环境区间——奇数个前导反斜杠标为原生环境（`kind: "row", factor: 1`），偶数个前导反斜杠标为整体过转义环境（`kind: "encoded", factor: count`），为矩阵换行符 `\\\\` 提供精确缩放倍率！
* **`outsideTexComments(body, transform)`**（`170-176`）· `[纯高阶函数]`：跳过 `texRanges` 中所有 `kind === "comment"` 区间，仅对非注释片段执行 `transform`。

---

#### `recoverDocumentLayout(text)`（`src/core/content-reader.ts:180-215`）

* **① 签名与职责定位**：`export function recoverDocumentLayout(text: string): string` · `[纯函数]` · 在不伤代码块、不伤 `\nu`/`\nabla`/`\neq`/自定义宏、不伤文件路径与 URL 的前提下，将工具参数中被写成两字符字面量的文档换行 `\n` 还原为真实换行符。
* **②–③ 四步推导**：① 提取文内 `\newcommand` / `\def` 声明的 `\n*` 自定义宏并入 `knownN`；② 校验是否存在结构性转义证据（至少两处未知 `\n*`、含 `"\\n\\n"`，或伴有偶反斜杠过转义已知命令），证据不足直接原样返回 `text`；③ 对 `"prose"` 与公式非注释区解码奇数反斜杠未知 `\n*`（排除 `C:\new`、`/path/n`、`https://...`）；④ 若解码导致原本单行的 `$$...$$` 内部出现换行，自动将首尾 `$$` 拆到独立行并补齐段落空行。
* **④–⑤ 调用方**：`src/core/math-delims.ts:120`（`repairMathForDisplay` 第一步）。

### 3.3 轻量私有辅助函数归并表

| 函数名 | 行号 | 纯度 | 作用与调用归属 |
|---|---|---|---|
| `escaped` | `12-15` | `[纯函数]` | 统计位置 `i` 左侧连续反斜杠数量是否为奇数，判断字符是否已被转义。 |
| `runLength` | `16` | `[纯函数]` | 统计从下标 `i` 开始连续相同字符 `char` 的长度。 |
| `literalRanges` | `21-31` | `[纯函数]` | 用 `fromMarkdown` 提取全部 `code` 与 `inlineCode` 的源码偏移区间。 |

---

## 4. `src/core/math-delims.ts`（121 行）

### 4.1 导出函数逐一五要素精讲（全文件 100% 纯函数）

#### `transformMathDelimiters(markdown)`（`src/core/math-delims.ts:39-55`）

* **①–③ 签名与推导**：`export function transformMathDelimiters(markdown: string): string` · `[纯函数]` · 遍历 `readContentSpans(markdown)`：普通文本与代码块原样返回；单 `$` 公式通过私有 `replaceEscapedDollars`（`27-35`）将未转义的 `\$` 替换为 `\text{\textdollar}`；遗留行内 `\(...\)` 转为 `$$${body}$$`；遗留块级 `\[...\]` 若处于缩进行（`indented`，如列表项内）折叠为单行 `$$...$$` 保护列表缩进，若处于顶格块位置（`blockPosition`）则转为带前后空行保护的多行 `$$\n${body}\n$$`。
* **④–⑤ 调用方**：`components/ai-elements/message.tsx:371`、`components/ai-elements/reasoning.tsx:219`。

---

#### `restoreMathEscapes(text)` · `healOverescapedCommands(text)` · `repairMathForDisplay(text)`（`src/core/math-delims.ts:67-121`）

* **`restoreMathEscapes(text)`**（`67-79`）· `[纯函数]`：
  * **①–③**：不含 `[\b\t\n\v\f\r]` 快速短路返回；在公式非注释区内，若控制字符（排除 `\r\n` 中的 `\r`）拼上紧随其后的完整英文字母串命中 `knownTexCommand`（如 `<TAB> + "ext" -> "text"`），还原为 `\\t` 等两字符前缀；仅在**行内公式（`!display`）**中额外把 `<LF> + suffix` 命中已知 `n` 命令的序列（如 `\nu`、`\neq`）还原为 `\\n + suffix`。
* **`healOverescapedCommands(text)`**（`113-115`）及核心私有算法 **`recoverCommandRuns(inner, display)`**（`87-111`）· `[纯函数]`：
  * **①–③**：先调 `texRanges(inner)` 获取环境上下文；对公式内每段偶数长度反斜杠串 `run`：位于原生 `"row"` 或 `"comment"` 内原样不动；位于过转义环境 `"encoded"`（倍率 `factor`）内，若满足换行符倍数 `run.length % (2 * factor) === 0` 或后跟已知命令/命令符号，精确缩减为 `run.length / factor` 个反斜杠（例如 `factor = 2` 时四反斜杠换行变回双反斜杠 `\\`，双反斜杠命令变回单反斜杠 `\`！）；环境外若后接 `numericPercentEscape`、长度 `> 1` 的已知命令或间距/括号符号 `[,;:!|{}%]` 则缩为单个 `\`；最后若原串可被 `canParseTex` 解析而新串解析失败，安全回退原串！
* **`repairMathForDisplay(text)`**（`119-121`）· `[纯函数]`：串联 `healOverescapedCommands(restoreMathEscapes(recoverDocumentLayout(text)))`。调用方：`components/ai-elements/message.tsx:403`、`components/question-dock.tsx:177`、`src/core/answer-presentation.ts:42`。

### 4.2 轻量私有辅助函数归并表

| 函数名 | 行号 | 纯度 | 作用 |
|---|---|---|---|
| `escaped` | `8-11` | `[纯函数]` | 奇数前导反斜杠转义判定。 |
| `indented` / `blockPosition` | `16-22` | `[纯函数]` | 判断下标 `i` 所在行首是否为非空纯缩进空白或纯空白行首。 |
| `replaceEscapedDollars` | `27-35` | `[纯函数]` | 将行内单 `$` 公式中的 `\$` 改写为 `\text{\textdollar}`。 |

---

## 5. `src/core/file-paths.ts`（86 行） · `session-markdown.ts`（205 行） · `session-find.ts`（20 行） · `session-navigation.ts`（47 行）

### 5.1 `file-paths.ts` 导出函数逐一五要素精讲

* **`quoteFilePath(path)`**（`20-27`）· `[纯函数]`：先经私有 `isFilePath`（`8-14`，拒绝控制字符/换行，要求满足 `/`、`~/`、Windows 盘符或 `\\server\share` UNC 四种有根语法之一，否则抛 `TypeError`）；取路径内最大连续反引号长度 $+ 1$ 作为外层定界符宽度 `width`，路径首尾若含反引号则对称各垫一个空格后返回。调用方：`components/path-input-dom.ts:199`、`components/file-path-drop-zone.tsx:73, 84`。
* **`parseFilePaths(text)`**（`35-77`）· `[纯函数]`：提取所有反引号串 `runs`，倒序扫描用 `next: Map<width, index>` 为每个开定界符线性配对右侧最近同宽闭定界符 `closing`；正向扫描配对区间，剥除 CommonMark 单空格内衬后若通过 `isFilePath(path)`，切分产出带精确 UTF-16 `start`/`end` 偏移的 `{ kind: "path", text, path, start, end }` 并令游标跳至 `closeIndex`，其余间隙产出 `{ kind: "text", ... }`。调用方：`components/path-input-dom.ts:146, 184, 209`、`components/file-path-chip.tsx:55`。
* **`filePathLabel(path)`**（`80-86`）· `[纯函数]`：按平台分隔符去尾斜杠后取末尾段作为胶囊短标签（根路径 `/`、`~`、`C:` 原样保留）。调用方：`components/file-path-chip.tsx:35`。

### 5.2 `session-markdown.ts` 导出函数逐一五要素精讲

* **`messageMarkdown(message, mid, anchors = true, ctx)`**（`158-184`）· `[纯函数]`：将单条 `LhMessage` 渲染为带可选 ` · <mid>` 锚点的 Markdown 节（`### Learner` / `### Teacher` / `### Quiz` / `### Problem` / `### Concluded` / `### Question` / `### Tool`）；报错的 `toolResult`、`send_to_user` 的空回执及所有 `custom` 标记消息均返回 `null` 静默跳过（内部依赖私有 `markdownContext` `47-64`、`outcomeLabel` `67-70` 与 `toolResultBody` `73-151` 关联题干与预提交 `modelSolution`）。
* **`sessionMarkdown(messages, opts)`**（`193-205`）· `[纯函数]`：可选输出 `# <title>` 一级标题，构建一次 `markdownContext(messages)`，顺序收集所有非 `null` 的 `messageMarkdown` 块并以 `"\n\n"` 拼接返回。调用方：`app/api/chats/[id]/markdown/route.ts:30`。

### 5.3 `session-find.ts` 导出函数逐一五要素精讲

* **`findSessionTextMatches(text, query)`**（`8-15`）· `[纯函数]`：空查询返回 `[]`；转义 `query` 中全部正则元字符后以 `new RegExp(literal, "giu")` 执行 `matchAll`，在不做 `toLowerCase()` 破坏特殊 Unicode 字符 UTF-16 长度的前提下输出精确 `{ start, end }[]`。调用方：`components/session-find-dom.ts:130`。
* **`stepSessionMatch(index, count, direction)`**（`17-20`）· `[纯函数]`：`count === 0` 返回 `-1`，否则返回 `((index + direction) % count + count) % count` 循环步进下标。调用方：`components/session-find.tsx:153`。

### 5.4 `session-navigation.ts` 导出函数逐一五要素精讲

* **`messageAnchorId(messageId)`**（`6-8`）与 **`messageIdFromHash(hash)`**（`10-19`）· `[纯函数]`：互逆编解码 DOM 锚点 ID `"message-" + messageId` 与 URL `#hash`（非法 URI 编码捕获异常返回 `null`）。调用方：`components/session-navigation.tsx:59, 61`、`components/chat.tsx:1559`。
* **`propositionSessionHref(node, chatId)`**（`23-26`）· `[纯函数]`：按账本顺序查找该节点在 `chatId` 下第一个非空 `messageId` 出处点（跳过早期 `""` 空锚点），拼装 `/chat/<chatId>#message-<messageId>` URL。调用方：`components/graph-view.tsx:1649`。
* **`textPartMessageId(partId)`**（`30-32`）与 **`firstSourceTextParts(messages)`**（`36-47`）· `[纯函数]`：从 `projectView` 文本部件 ID `"<nativeMessageId>-t<N>"` 中提取原生消息 ID，并为每条原生教师消息登记其**首个非空白文本部件**的 `part.id`，保证页面上每条教师消息有且仅有一个精确对应的滚动锚点。调用方：`components/chat.tsx:265, 1558-1559`。
