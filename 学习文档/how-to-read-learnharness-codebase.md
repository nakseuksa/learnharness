# 如何高效阅读 LearnHarness 代码库：降维拆解复杂状态与守卫的方法论

在阅读 `src/core/input-events.ts` 和 `src/server/chat-handler.ts` 等核心文件时，如果遇到 `ChatInput` 的 7 种类型、层层堆叠的前置守卫以及散落在多处的 `globalThis` 内存状态，产生强烈的认知过载感是非常正常的。这主要由本代码库的两个结构特征导致：

1. **没有中间件隐藏细节，所有横切逻辑平铺在同一个漏斗里**：在传统 Web 框架里，鉴权、限流、锁、参数校验、异常重试分散在不同注解或拦截器里；而 LearnHarness 采用单一组合根（`handleChatInput`），把配置检查、上下文压缩、并发互斥、预写、唤醒投递全部按顺序摊开在同一个 500 行的函数里。
2. **“20% 核心主干 + 80% 历史事故补丁”混排在同一层级**：如果从第 1 行往第 500 行线性平推，大脑会试图同时维护 `7 种输入事件 × 6 道前置守卫 × 6 个内存表 = 250+ 种状态组合`，工作记忆必然超载。

要迅速把复杂度降下来，核心心法是**“先立不变量分水岭，再剥离事故补丁”**。以下是针对三大高频痛点的具体拆解方法：

---

## 方法一：用“生命周期角色”折叠联合类型，绝不平铺记忆（以 `ChatInput` 为例）

看到 `src/core/input-events.ts` 里的 7 种 `ChatInput`（外加旁边的 `SteerInput`、`DismissInput`、`UserSteerInput`），不要当成 10 个平级概念去记。先问一个问题：**“它要启动一个新回合（`turn`）吗？”**

* **不启动新回合的直接分出去**：
  * `DismissInput`（按 ESC 跳过题目）：静默写入持久化，**绝不唤醒模型**。
  * `UserSteerInput`（插纸条 `steer`）：往**正在跑**的回合里塞消息，不自己开新回合。
* **剩下的 `ChatInput`（全都要启动新回合），按场景折叠成 `2 + 2 + 3`**：
  1. **教学主干（只有 2 个！第一遍看代码只看这俩，就能跑通 90% 的流程）**：
     * `text`：学习者在输入框发话。
     * `answer`：学习者在答题 dock 提交答案。
  2. **练习会话专属（只有 2 个！不看练习模块时直接整块跳过）**：
     * `thinking`：一道练习题（`problem`）未结束前，多次提交思考草稿。
     * `next`：练习题收尾（`conclude`）后的停顿期，明确点击“下一题”。
  3. **异常补偿与恢复（只有 3 个！全是不产生普通对话的“修补动作”，主干读通前一律无视）**：
     * `continue`：挂载续跑（持久化末尾已有答案、但上次没等来教师回复，补跑一轮）。
     * `retry`：失败重试（模型报错了，不加新消息重跑一次）。
     * `retry-question`：坏题重出（模型发出的题目参数损坏渲染成 `MalformedQuestion`，要求重出）。

通过这一层折叠，第一遍走读代码时脑中**只需追踪 `text` 和 `answer` 两个分支**，分支负担立即减少 70%。

---

## 方法二：用一条“无副作用分水岭定律”看懂所有前置守卫

读 `src/server/chat-handler.ts` 的前半部分时，会看到一长串 `if / try / await` 守卫（甚至 `retry` 还校验了两次）。不必死记顺序，直接在代码里圈出**唯一的一条分水岭**：

> **分水岭：`beginTurn(chatId)`（占锁） + `saveMessages`（`write-ahead` 预写）**（`src/server/chat-handler.ts:371-394`）

分水岭之前的约 150 行代码，全都只服务于同一条铁律：**“任何被拒绝的请求，必须做到零副作用——既不能占着回合活性登记（409 锁），也不能往持久化里写半个字节，保证客户端下次可以原样幂等重试。”**

抓住这条定律后，前面所有守卫自然归为三步安检：

1. **安检 1：弹药够不够？（纯只读，不够就 503/403 劝退）**
   * `universal_turn_gate`：配模型了吗？
   * `KEY-PRESENCE GATE` + 订阅后台准入：有 API Key 吗？如果是唤醒流水线触发的后台请求，用户的订阅连接允许后台跑吗？
2. **安检 2：历史账本整理好了吗？（等待上下文压缩 `ensureCompacted`）**
   * 如果上一轮回合收尾触发（`settle kick`）的上下文压缩还在后台跑，必须在这里 `await` 等它落盘，并**重新读取一次 `record`**。
   * *为什么前面校验过一次 `retry`，这里又要重新算一次 `retryDrops`？* 因为等待压缩期间，持久化末尾可能刚被追加了一条压缩标记消息，磁盘真相变了。
3. **安检 3：本次追加的消息合法吗？（纯函数试算 `inputAppends`）**
   * 在真正写盘前，先用纯函数算出这次输入事件要追加哪些 `LhMessage`（例如拿一个过期的 `toolCallId` 来 `answer`，直接在这儿抛 400 拦住）。
   * *为什么会有 `PARALLEL-QUESTION GATE`？* 如果模型一口气出了两道并列题，答第一道时发现还有姊妹题悬空待答，这里会**只写盘、不调 `beginTurn`、不开回合**，等最后一道题答完再一起发给模型（否则中间插进一条 assistant 回复，会被大模型 API 判定工具调用结果错位而报错）。

过了这三道安检，才真正跨过分水岭：**`beginTurn` 占锁 → `write-ahead` 预写落盘 → 构造 Agent 开跑**。

---

## 方法三：给 `globalThis` 内存状态立一张“磁盘真相 vs. 瞬态协调”对照表

面对散落在不同模块里的 `globalThis.__lh*` 单例，先明确三条基本事实：

1. **为什么挂 `globalThis`？** 纯粹是为了工程隔离——Next.js 在开发热重载或不同路由入口打包时，普通模块级 `new Map()` 可能在同一 Node 进程里被实例化多份，挂在 `globalThis` 上能确保**单进程内真正共享同一个实例**。
2. **所有教学业务状态 100% 不在内存里，全在持久化的 `ChatRecord` 里**：
   当前处于探测阶段还是教学阶段（看有没有成功的 `probe_done`）、计划树走到哪个节点（看最近带 `nodeId` 的提问）、哪道题正在待答问题闸门里等待（`pendingQuestionOf` 扫描）——**全是从磁盘 `LhMessage[]` 纯函数推导出来的**。
3. **`globalThis` 里只放“进程一旦 `kill -9` 就理应消失的正在运行态”**。每个表只管一件瞬态协调工作：

| `globalThis` 变量（所在文件） | 只管哪一件瞬态小事？ | 回合/任务空闲时里面有什么？ |
|---|---|---|
| `__lhTurnRegistry` (`src/server/turn-liveness.ts`) | 这条会话此刻有没有回合在跑？（防并发 409 锁） | **空** |
| `__lhTurnRuns` (`src/server/turn-runs.ts`) | 正在跑的回合产生到哪一步了？（供刷新页面重连 SSE 事件流回放） | **空** |
| `__lhWakePipeline` (`src/server/jobs.ts`) | 活着的 `Agent` 引用 + 待投递的后台结果（决定走运行中插纸条还是空闲唤醒） | **空** |
| `__lhCompaction` (`src/server/compaction.ts`) | 正在跑的上下文压缩 `Promise`（供下一回合开头 `await` 等待） | **空** |
| `__lhDismissalPark` (`src/server/dismissal-park.ts`) | 回合运行途中用户按 ESC 产生的丢弃暂存（等回合收尾落盘后再补记） | **空** |
| `__lhEventBus` (`src/core/events.ts`) | 通知通道（`GET /api/events`）的浏览器连接集合，只广播“变了”的信号 | 仅打开的窗口监听 |

只要当前没有回合或后台任务在跑，前 5 张表全都是空的——它们只是并发交通警察，绝不承载业务记忆。

---

## 方法四：执行“三遍剥洋葱阅读法” + 善用单测与推演沙盘

在实际走读代码时，推荐调整阅读顺序：

1. **第一遍：只读 `src/core/` 里的纯函数（零异步、零锁、零网络）**
   先看 `LhMessage` 的结构，再看两条投影（向模型的 `toLlmMessages`、向浏览器的 `projectView`）和 `inputAppends`。这里全是“给定输入数组 → 返回输出数组”的确定性函数，先把持久化的真实形态立住。
2. **第二遍：给编辑器做“视觉折叠”，只追一条最窄主干**
   打开 `src/server/chat-handler.ts`，在脑中固定 `input = { type: "text", text: "教我链式法则" }`，遇到 `retry`、`isSubscriptionProvider`、`compaction`、`hasUnresolvedQuestion`、`dismissal` 的代码块**一律跳过不读**。真正负责跑通主流程的核心代码只有约 40 行。
3. **第三遍：遇到古怪分支，不死盯源码，反向查注释标题与一对一单测（`tests/`）**
   仓库里几乎每个复杂守卫上方都写明了事故起因（例如 `the deepseek parallel batch incident`、`issue #110`），且在 `tests/` 下配有专门的离线确定性单测（如 `tests/retry-failed-turn.test.ts`、`tests/dismissal-park.test.ts`、`tests/malformed-question-recovery.test.ts`）。看懂一个 15 行的单元测试构造的假模型序列只需 30 秒，远比对着处理器代码空想边界条件高效。
4. **运行仓库自带的推演沙盘（`scripts/sandtable/`）**
   针对“回合活性登记 + 待答问题闸门 + 唤醒流水线”交织的并发时序，仓库内置了只读状态机沙盘 `scripts/sandtable/`：
   ```bash
   npx tsx scripts/sandtable/main.ts --script scripts/sandtable/scenarios/probe-handoff.json
   npx tsx scripts/sandtable/main.ts --script scripts/sandtable/scenarios/question-blocks-delivery.json
   npx tsx scripts/sandtable/main.ts --script scripts/sandtable/scenarios/recycle-after-stopper.json
   ```
   它会像沙盘推演一样，逐步打印每个事件到来后 `turns`、`questions`、`delivery`、`workers` 棋子的移动，并在每一步旁直接标注对应的生产代码规则，把抽象的并发状态变成肉眼可见的棋盘。
