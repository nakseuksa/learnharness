# 键盘快捷键 (Keyboard shortcuts)

2026-09-17 裁定（负责人在初稿后对键位映射 key-map 的审查；整个应用必须能 **仅凭 (only)** 键盘进行操作 — 语音是第一位的，而键盘作为第二支柱的输入方式）。

## 架构 (Architecture)

- **注册表 (Registry)**: `src/core/keyboard.ts` — `KEYBOARD_ACTIONS` 包含了所有的快捷键动作：`{ id, label, scope, binding }`。快捷键速查表 (cheat sheet) 是 **根据 (FROM)** 这个注册表渲染出来的，所以它绝对不可能列出一个不起作用的快捷键。
- **提供者 (Provider)**: `components/keyboard-shortcuts.tsx` — 一个 window 级别的 keydown 侦听器（在冒泡阶段 bubble phase 触发，仅在 AppShell 中挂载一次）。它将按键规范化为类似于 `mod+d` 风格的字符串，解析重写规则 (overrides)，并分发以 `lh:kbd-<action-id>` 命名的 window `CustomEvents`。各个呈现表面 (Surfaces) 自行侦听专属它们自己的事件（与现存的 `lh:chat-renamed` 接缝风格保持一致）。
- **持久化 (Persistence)**: 用户自定义的重写规则存活在 `localStorage` 的 `lh:keymap` 中，格式为 `{actionId: binding}`，并在应用时覆盖掉默认值。目前还没有编辑器 (editor) — 修改键位映射界面的功能留给了“设置 (settings)”里程碑阶段。
- **仅供展示 (displayOnly) 条目**: 注册表也列出了属于各个表面 (SURFACE-owned) 的按键（比如问题停靠栏 question dock 的按行导航机制），**仅仅 (only)** 是为了能展示在速查表里 — `effectiveKeymap` 在生成全局快捷键时会跳过它们，这样纯方向键就绝不会在那些没有挂载该表面的页面里泄露触发。

## 规则 (Rules)

- **Tab 键在任何地方都已失效 (Tab is dead everywhere)**（负责人的决定：放弃了浏览器原生利用 Tab 键切换焦点的导航方式）。Shift+Tab 用于循环切换大模型的思维等级 (thinking level) — 哪怕正在输入框里打字时也起作用（带修饰键 combos 的组合是 **唯一 (only)** 能在正在打字表面中触发操作的按键；单按一个键决不会触发快捷键）。
- **Esc 的优先级链 (Esc priority chain)**: 最顶层的弹出气泡 (popover) → 速查表 (cheat sheet) → 取消听写 (cancel dictation)（即 丢弃 DISCARD — 要想把已经转录的内容发送出去，只能按 Cmd+D 或者点击 停止 Stop 按钮，这也是负责人的整改决定）→ 终止轮次 (abort turn)（仅限本地请求的流式数据 — 服务器端触发的唤醒轮次 wake turn 并不存在一个可以被客户端强行中断的请求）。为了确保窗口级的事件链绝对不会造成双重触发，每一个实际执行了拦截动作的元素级/文档级 Esc 处理器都必须调用 `e.stopPropagation()`。会话搜索框接管 Esc 用于清除焦点并退回正常模式。
- **焦点环 (Focus ring)**: 既然基于浏览器的 Tab 焦点切换已被废弃，那么 `:focus-visible` 就不再带有任何样式修饰（之前曾实验过加上外部轮廓，但被立刻毙掉了 — 因为当时即便是最普通的点击输入框，都会显出一个刺眼的红色光环）。

## 键位映射 (Key map) (阶段 A — 全局 global)

| 动作 (Action) | 按键绑定 (Binding) | 接缝事件 (Seam) |
|---|---|---|
| 切换听写 (Toggle dictation) | ⌘D | `lh:kbd-toggle-dictation` (dictation.tsx) |
| 模型选择器 (Model selector) | ⌘K | `lh:kbd-open-model-picker` (model-picker.tsx) |
| 循环切换思维等级 (Cycle thinking level) | Shift+Tab | `lh:kbd-cycle-thinking` (model-picker.tsx) |
| 切换侧边栏 (Toggle sidebar) | ⌘B | `lh:toggle-sidebar` (sidebar.tsx) |
| 会话搜索 (Sessions search) | ⌘⇧F | `lh:kbd-sessions-search` (sidebar.tsx) |
| 遍历搜索结果 (Walk search results) | ↑ / ↓ *在搜索栏内 (in the search field)* | sidebar.tsx (循环切换已过滤的行，支持折返 wraps) |
| 打开搜索结果 (Open search result) | Enter *在搜索栏内 (in the search field)* | sidebar.tsx (若有选中的行则打开该行，否则打开匹配的第一项) |
| ~~循环切换会话 (Cycle session)~~ | ~~⌥↑ / ⌥↓~~ | 退役 (RETIRED) (负责人, 2026-10-10) — 已被上方的搜索遍历替代 |
| ~~打开选中的会话 (Open selected session)~~ | ~~⌥Enter~~ | 退役 (RETIRED) (负责人, 2026-10-10) — 已被上方的搜索 Enter 替代 |
| 跳转至图谱/主页 (Jump to graph (home)) | ⌘G | keyboard-shortcuts.tsx 内调用 router.push |
| 新建会话 (New session) | ⌘N | keyboard-shortcuts.tsx 内调用 router.push |
| 重命名会话 (Rename session) | F2 | `lh:kbd-rename-session` (chat.tsx) |
| 快捷键速查表 (Cheat sheet) | ? | keyboard-shortcuts.tsx |
| 查找 (图谱：节点搜索 Find (graph: node search)) | ⌘F | `lh:kbd-find` (graph-view.tsx；未来聊天记录搜索功能落地时，将复用同一个事件) |

## 模型菜单的键盘机器机制 (Model menu keyboard machine) (负责人润色 polish, 2026-09-17)

(于 2026-10-10 从设置/速查表注册表中移除 — 它是显而易见的输入框内导航方式；下述行为保持不变。)

当模型菜单敞开时，焦点始终停留在搜索输入框内，而且该菜单接管了输入框自身的 ↑/↓/Enter 处理逻辑：

- **↑/↓** 遍历过滤后的结果 — 被限制在边界内 (clamped)，不会折返循环 (no wrap)。第一次按下 ↓ 时，焦点停在第一行；第一次按下 ↑ 时，焦点落在最后一行。被选中的行会套上一个柔和的圆环并被滚动至可视区域 (scrollIntoView)。
- **Enter** 确认选取已选中的那一行，若没选过则直接取 **第一条结果 (first result)**（负责人的决定）。一旦输入新的搜索词，这个选中的遍历位置就会立刻重置。
- 点击操作与按 Enter 键两者共享同一个 `pickModel` 处理路径；按 Esc 依然能够关掉菜单。

## 问题停靠栏的逐行机器机制 (Question dock row machine) (阶段 B，负责人审查轮次 rounds 2026-09-17)

当某个问题处于展开状态时，停靠栏 (dock) 彻底接管了 ↑/↓/Space/Enter/Tab 这些按键：

- **↑/↓** 按顺序遍历每一行可被作答的项目 — 选项排在前，随后是表示不知道的测验选项 "I don't know" / 提问中的 "Other…" 选项（二者绝不会同时出现）— **光标到达两端即停止，不再环绕折返 (clamped at the ends, no wrap)**（负责人注：走到底停住能让人选得更快）。被选中的行会获得一个隐秘微光的圆环 (`bg-accent/40`) 且被滚动至可视区域。
- **Space (空格)** 作用在被选中的那行上，效果跟用鼠标点一模一样：遇到多选就开/关，遇到单选则直接替换；碰到 "Other" 选项更是会将焦点一把拽入它的行内输入框里方便打字。
- **Enter** 一旦有答案被选中（`canSubmit` 为真）便立刻提交答案。
- **Tab (纯 Tab)** 纯粹在 思考框 (thinking field) 与 答案行区 (answer rows) 这两者间横跳 — 再没别的花样（负责人的第 3 轮审查）。如果在思考框这一侧按，它会将焦点移去刚才停在（或首行）的那行答案上；而在答案行区按的话，则乖乖返回思考框。在此期间只要用户混迹在各答案行中，浏览器的焦点始终如影随形，所以被聚焦的行 (focused) 和被选中要处理的行 (walked) 绝不分家。Shift+Tab 不归停靠栏管 — 这是那套用来循环全局思考强度的按键。
- 防御网 (Guards)：所有在正在打字的表面里敲下的按键都会乖乖干着原生该干的活（方向键乖乖移动光标，空格键正常敲空格 — 绝不劫持思考输入框），带修饰键 (modifier) 的组合也绝不归停靠栏管 — 你按 Alt+方向键 能够顺畅地切换不同会话，绝不至于 **同时 (ALSO)** 还在这破问题堆里乱窜（负责人的第 3 轮审查）。这套侦听器只有在停靠栏完全拉开时才活着 — 若在折叠状态下，该按键依旧能用栏条上原生的 Enter 键将它展开。

## 现状 (Status)

- 阶段 A（全局管道 global plumbing + 上方的各快捷键）— 已落地，并通过 CDP 验证 (CDP-verified)。
- 阶段 B（问题逐行机器机制 question row machine）— 已落地，并通过 CDP 验证。
- 阶段 C 剩余任务：⌘F 聊天记录搜索（全新功能，需要专属的设计阶段），⌘F 在图谱上的导入笔记功能。图谱里的 ⌘F 节点搜寻已经提前出货（由负责人对功能空档期进行了现场直测 live-tested）。