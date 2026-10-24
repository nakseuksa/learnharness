# 首次发布 (0.3.0) — 打磨清单与锁定考量 (First Release (0.3.0) — polish list + lock question)

> **历史规划说明（2026-10-06），这不是当前的发布检查单。**
> 下文提及的几个事项现已推出，包括签名/公证 (signing/notarization) 以及自动更新 (automatic updates)。关于当前的构建、验证及发布流程，请参阅 [桌面端构建与发布 (Desktop builds and releases)](desktop-release.md)。

2026-10-06 开始，一轮来自负责人的脑暴倾泻 (brain-dump round)。优先级 1 — 其他所有事情（评估级别 assessment levels → `docs/vision-assessment.md`）都排在后面。各项内容均按原话记录；除非特别标注，否则其中的设计决定均为 **未裁定 (unruled)** 状态。

## 打磨清单 (负责人提供，2026-10-06) (Polish items)

1. **图谱渲染的开关 — 必须与提取管道 (extraction pipeline) 分开。**
   现在的图谱开关控制的是整个提取过程。想要的效果：两个开关 —
   一个控制 *管道 (pipeline)* (根据它的实际作用命名)，另一个控制 *渲染 (rendering)*
   (“图谱开关 graph on/off” = 图谱视图是否渲染)。在关闭渲染的情况下，数据、推理链模型以及提取过程都要保持正常运转。
   - 待解决 (Open)：**在图谱渲染关闭时，主页视图应该展示什么？** 它必须保留 导入笔记按钮 (import-notes button)、链视图按钮 (chains-view button)，以及图谱管道的成本显示 (cost readout)。有人提议保留链视图 (因为链表格 chain table 本身就已经是一个完整脱离图形展现形式的 命题+逻辑链 的清单了)，该提议尚未被否决。还有人提过放一个“巨型 DAG”，已被否决。状态：未裁定。
2. **针对问题的键盘导航 (Keyboard navigation for questions)** — 现在的方向按钮 (上一题/下一题 next/previous question) 只能点击；要把它们做成真正的快捷键 (keybinds)，最终目标是支持 VIM 的键位 (比如 j/k)。也许允许自定义改键，也许不 — 状态：未裁定。
3. **会话命名 (Session naming)。** 拿第一句话当名字不够干净（第一句话总是很长）。负责人不喜欢用大模型 (LLM) 自动生成名字。曾经考虑过在发完第一条消息后弹出一个命名框 — 但可能会惹人烦；状态：未裁定。（事实：顶栏标题 top-bar title 现在已经支持点击重命名了；无论最终敲定什么方案，都得跟它对齐。）
4. **将会话导出为 Markdown (Export sessions as markdown)** — 很可能会做成在侧边栏会话上右键操作的功能。（事实：`core/session-markdown.ts` 本来就能为了提取功能将会话完整渲染成 markdown — 所以序列化的能力早就在那了。）
5. **导出推理链 / 图谱 (Export the reasoning chains / graph)** — 格式未定（最显而易见的候选是 JSON：直接把图谱快照吐出来）。入口放哪未定。
6. **打磨图谱的默认设置 (Graph default settings refinement)** — 当前的默认值不太理想；小问题。
7. **总结概括对话框 (Compaction summary dialog)** — 它把整个屏幕都遮住了，这不好看；按 Esc 键时它不是直接关掉，而是弹个确认框问你要不要关。已确立的法则：**Esc 永远只作用于屏幕上最当前的元素 (Esc always acts on the current element on screen.)**
8. **全局键盘操作核查 (General keyboard audit)** — 所有的功能都必须能用键盘操作；有几处小地方目前还不行。在下一轮排查时会逐一列举这些例子。

## “发布”对开发意味着什么变化？（关于锁定的考量）(What does "released" change in development? (the lock question))

2026-10-06 达成的共识：发布意味着 **对存储在磁盘上的用户数据承担起兼容义务 (on-disk user data acquires compatibility obligations)** — 在 0.3.0 之后，所有持久化存储的模式变更 (persistent-schema changes) 必须采用包含容错读取 (tolerant reads) 在内的数据迁移 (migrations) 手段，而不能再像开发阶段那样随心所欲地改结构，然后大手一挥让别人去清空数据。没有什么是被永远冻结的；只是行事纪律变了。

持久化的作用面（也就是义务范围）：
- `data/chats/*.json` — 聊天记录 (ChatRecord)：包含消息内容（采用 pi-ai 的网络数据形态：思维块 thinking blocks，工具调用 toolCalls，使用量 usage），轮次 (turns)，类型 (kind)，图谱上下文 (graphContext)。这是最深的一把锁 — 而且它还跟 pi-ai 库的序列化逻辑强耦合（在发布之后，pi-ai 的升级就等同于一次数据迁移事件）。
- `data/graph/` — nodes.jsonl, chains.jsonl, coverage.jsonl, sources.json, sessions.jsonl（这些是只加不改的账本 append-only ledgers），positions.json, render-settings.json。
- `data/settings.json`（模型 models，开关 toggles，总结概括 compaction…），`auth.json`（自带的密钥 BYOK keys）。
- 客户端的 localStorage（镜头 camera，滤镜 filters，缩放 zoom，类型过滤 kind filter）。
- `data/jobs/` — 把它们当成用完即弃的草稿纸/临时数据，不对其承担任何兼容义务。

在发布 *前 (before)* 需要填补的已知空白（以下为提案，未裁定 unruled）：
- **任何地方都没有 schemaVersion 版本戳记。** 现在加上成本很低，以后却需要它来承重：在写入 ChatRecord、设置项 (settings) 和各种账本 (ledgers) 时打上一个版本戳；读取器在没读到戳记时默认按当前版本处理。这正是让日后的数据迁移变得没有痛感的关键。
- **锁定 pi-ai/pi-agent-core 的确切版本 (Pin pi-ai/pi-agent-core exact versions)**，从而确保记录结构的每一次变动都是深思熟虑的。
- 代码之外的发布工程任务：签名/公证 (signing/notarization) 还需要等加入了 Apple 开发者计划之后才能搞定（目前的 DMG 还是未签名的）；还没有自动更新器 (auto-updater)（如果在发布时说清楚了，那在 0.3.0 版本通过手动下载更新也是可以接受的）；打包后的应用数据存放位置已经对了（LH_DATA_DIR → userData）。