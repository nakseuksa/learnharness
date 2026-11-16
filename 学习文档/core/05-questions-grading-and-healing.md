# 第 05 卷：题目契约、确定性洗牌判分与弱模型参数修复

> **负责源码**（合计 1,110 行，全部逐行精读，零遗漏）：
> `src/core/question-core.ts`（802 行）、`src/core/tool-parts.ts`（129 行）、`src/core/answer-presentation.ts`（57 行）、`src/core/argument-heal.ts`（96 行）、`src/core/value-debris.ts`（26 行）。
> 讲解用语一律遵循 `学习文档/glossary.md` 规范名；代码标识符原样保留。所有结论均经 grep/read 取证，出处以 `path:line` 标注。
> 本卷按**依赖自底向上**排列：value-debris → argument-heal → question-core → tool-parts → answer-presentation。

---

## 本卷导读

### 0.1 一条完整的数据流：模型出题 → 双缝修复与校验 → 前端确定性洗牌与置信度采集 → 客户端判分组装 → 历史已答题卡无损回显

这五个文件承载了 learnharness 教学回路里"一个问题从模型嘴里出生、到学习者答完、再到历史回显"的全部纯逻辑。整条链路可以拆成八站：

**① 模型出题（声明与修复）。** 教师／探测者 agent 的题目工具以 TypeBox Schema 声明输入契约：teach quiz 用 `quizInputObject`（`src/agent/tools.ts:380`、`src/agent/teacher-agent.ts:331`），probe quiz 用 `probeQuizInputSchema`（`src/agent/tools.ts:209`），teach explain 用 `explainInputObject`（`src/agent/tools.ts:228`），probe recall 用 `explainInputBase`（`src/agent/tools.ts:253`），ask 用 `askInputSchema`（`src/agent/tools.ts:87`）。模型发出的原始参数先经过 pi 的 `prepareArguments` 缝：题目工具自带的 `prepareQuestionArguments`（`src/agent/tools.ts:67-77`）调用 `parseOptionsIfString` 解开字符串编码的 `options`；随后注册表级包装 `withArgumentHeal`（`src/agent/tools/heal.ts:34-41`）对**每个工具**跑 `healEncodedArguments`，修复 JSON 字符串编码的枚举／布尔／数字／数组（模型抖动的通用修复，2026-10-09 所有者裁定"一个标准模式，处处应用"）。

**② 双缝校验（结构 + 跨字段）。** pi 在 execute 之前用 TypeBox 校验参数（`Value.Convert` → `Value.Check`，见 `src/agent/tool-execute.ts:29-33` 注释与 `tests/tool-parts.test.ts` 对 `validateToolArguments` 的端到端驱动）。结构校验管不了跨字段语义，所以 execute 顶部再跑出题契约精炼：`quizInputProblems`（`src/agent/tools.ts:213`、`:384`；`src/agent/teacher-agent.ts:334`）、`explainInputProblems`（`src/agent/tools.ts:232`、`:257`）、`askOptionProblems`（`src/agent/tools.ts:91`）；teach 侧另加读取活动记录的 `nodeIdProblem` 计划位置校验（`src/agent/tools.ts:354`、`:385-386`）。任何问题 → `invalidInputResult`（`src/agent/tool-execute.ts:118`）以 isError 结果退回模型，**出题重试**同回合进行；`question_stopper`（`src/agent/teacher-agent.ts:169`）见到错误结果就继续回合（`:185-188`），干净出题才结束回合等学习者。干净出题的 execute 返回 `questionResult()` 占位（`src/agent/tool-execute.ts:237-249`，`terminate: true`）——它是循环装置，**永不落盘**。

**③ 持久化保留原始字节。** pi 持久化工具调用时保存的是**修复前的 RAW 参数**（`src/agent/tools.ts:63-64`、`src/core/tool-parts.ts:41-44` 注释明确此点）；持久化记录同样保留被拒绝调用的原始输入（记录诚实 + 回放不变量：每个 toolCall 之后必有一个 result，`src/core/tool-parts.ts:13-14`）。这是本卷全部对称性设计的根：**写侧不改字节，读侧负责重放同一条修复**。

**④ 读侧状态判定与待答问题闸门。** SSE 事件流在模型还在"打字"时就推送原始 tool-input 增量（`input-streaming` 态，校验不可能先于调用完成运行，`src/core/tool-parts.ts:11-12`）。原生记录扫描 `questionCallsOf`（`src/core/native-messages.ts:724-742`）用 `parseQuestionInput`（`:734`）给每个未答调用定状态：`streaming / answerable / malformed / failed`；`pendingQuestionOf`（`:685`）定权威，view 侧 `findPendingToolCall`（`src/core/pending.ts:143-148`）必须命中同一调用。有问题待答时输入框被答题 dock 取代（`components/chat.tsx:755` 的 `sendAllowed`、`:2396` 挂载点）。

**⑤ 答题 dock：解析 gate → 确定性洗牌 → 置信度采集。** `QuestionDock` 挂载即解析（`components/question-dock.tsx:134-138`）：按题型分派 `parseQuizInput / parseExplainInput / parseAskInput`，失败渲染 `MalformedQuestion`，绝不崩溃。解析成功后在 `useMemo` 里组装 `QuestionData`（`:274-319`）：`normalizeOptions`（`:289`）归一选项 → `shuffleOptions(options, seededRandom(toolCallId))`（`:292`）做**确定性洗牌**（hydration 安全）→ 洗牌**之后** `resolveCorrect`（`:306`）把按值键控的 `correctAnswer` 解析成 1-based 显示索引。quiz 的置信度滑杆吸附 `CONFIDENCE_STOPS`（`:799-811`），键盘 ←/→ 循环档位（`:527-539`），静止默认 50（`:340`）。

**⑥ 客户端判分组装。** 提交时 `doSubmit`（`components/question-dock.tsx:392-414`）构造 `AnswerRequest`（`:394-403`，quiz 恒发 `CONFIDENCE_STOPS[confIdx]`），调 `buildAnswer(qd, req, toolName)`（`:413`）：quiz 在客户端用 `isCorrect` 精确集合判分（`src/core/question-core.ts:737`）；explain 只快照模型承诺、**绝不客户端判分**；ask 不判分。`chat.tsx` 的 `onSubmitAnswer`（`:1760-1775`）把阅读思考并入答案，经 `session-core.submitAnswer`（`components/session-core.ts:845-848`）发出 **answer 输入事件**。

**⑦ 回合收尾前的预写与双受众结果。** server 侧 `inputAppends`（`src/core/input-events.ts:221-227`）校验答案必须命中悬空问题调用，然后 `newAnswerResult`（`src/core/native-messages.ts:206-222`）构造 toolResult：**content** 是 `compactAnswerForModel` 的 JSON（`:216`）——只含学习者新增的信息（选择／文字／判定／置信度／两条思考通道），模型自己写过的题目、选项、解释、承诺一概不复述（tool-result diet，2026-10-02）；**details** 携带完整 `QuestionAnswerData` 供记录与 UI。该追加在 agent 运行前预写（write-ahead，`src/server/chat-handler.ts:377-394`）。ESC 丢弃走 `dismissedAnswer`（`components/chat.tsx:417`）→ dismiss 输入事件 → `dismissAppends`（`src/core/input-events.ts:141-157`）→ 同一个 `newAnswerResult`，模型只见 `{kind, dismissed:true}`。

**⑧ 历史已答题卡无损回显。** 持久化的 tool part 到达 `output-available` 后渲染 `AnsweredCard`（`components/chat.tsx:1603`）。卡片第一步就调 `answerForPresentation(savedAnswer, input)`（`components/answered-card.tsx:25`）：把原始调用参数再走一遍**同一条读侧解析通道**，从调用里刷新模型-authored 的显示文本（题干、解释、承诺、选项标签的数学修复），而答案身份、顺序、判分、学习者文字一律以记录快照为准；选项标签用"值身份 → 标签双匹配 → 双射补全"三级绑定，歧义时保留快照绝不猜。details 行与 ask 选项描述同样从原始调用重读（`components/answered-card.tsx:46-48`），使全部历史记录无需迁移即可享受新渲染。

### 0.2 设计对称性：为什么读侧与执行侧必须共享同一条参数修复（heal）与残渣剥离通道

持久化记录存的是**修复前的原始字节**（③）。于是同一个模型抖动会在两个时刻被看见：

- **执行侧**：agent 校验参数之前，`withArgumentHeal` 在 `prepareArguments` 缝跑 `healEncodedArguments`（`src/agent/tools/heal.ts:38`），修复后的参数通过校验、题目被干净提出；
- **读侧**：浏览器解析持久化的原始参数时，`parseQuizInput` 在 `boundaryParse` 之前跑**同一个** `healEncodedArguments`（`src/core/tool-parts.ts:83`）。

若读侧不镜像执行侧的修复，就会出现 tool-parts 法则描述的死锁：**一个在边界被修复后接受的 quiz，其记录里的 RAW 参数在读侧解析失败 → 不可见的待答问题（invisible pending quiz）→ 学习者被锁死**（`src/core/argument-heal.ts:4-13`、`src/core/tool-parts.ts:78-82` 注释）。同理，`Value.Convert` 也必须在读侧镜像（live-smoke 修复：模型发 `correctAnswer: 17` 数字，边界 Convert 成 `"17"` 接受，记录存 17，读侧跳过 Convert 就会拒掉边界刚接受的输入，`src/core/tool-parts.ts:36-44`）。

残渣剥离（`stripModelValueDebris`）同样三处锁步：调用边界（`quizInputProblems` → `coerceCorrectAnswer`）、显示解析（`normalizeQuizType`）、判分（`resolveCorrect` → `coerceCorrectAnswer`）——`src/core/value-debris.ts:14-17` 注释点名这三个消费者由 tool-parts 法则保持同步。修复是幂等的、良构参数原样通过（同引用），所以"执行侧修一次、读侧再修一次"是无害的第二遍（`src/agent/tools/heal.ts:20-22`）。

一句话概括本卷的架构教义：**持久化只存事实（原始字节 + 学习者答案），一切修复与投影都是读侧纯函数，且读侧必须逐字镜像执行侧的强制通道。**

### 0.3 事故时间线（本卷全部历史背景的出处）

| 日期 | 事故／裁定 | 留下的机制 | 取证 |
|---|---|---|---|
| 2026-09-12 | 线上崩溃：消费者用 TS cast（`part.input as X`）信任模型字节 | "parse, don't cast" 铁律，显示侧解析缝诞生 | `src/core/tool-parts.ts:1-28`；`tests/tool-parts.test.ts:4-8` |
| 2026-09-25 | 所有者裁定：推理先于承诺 | `explanation` 在 schema 里紧挨 `correctAnswer` 之前；Option A `terminate:true` | `src/core/question-core.ts:154-157`；`src/agent/tool-execute.ts:230-236` |
| 2026-09-26 | GLM 把 `options` 发成 JSON 编码字符串；quiz 选项 `description` 被模型用来泄漏正确性；live-smoke 模型发数字 `correctAnswer: 17` | `parseOptionsIfString`；quiz 选项删除 description；`boundaryParse` 先 Convert | `src/core/question-core.ts:57-62`、`:34-38`；`src/core/tool-parts.ts:36-44` |
| 2026-09-27 | explain 自由回忆出题；反谄媚结构化 | 承诺先于出题、不可撤销、模型对着承诺判分 | `src/core/question-core.ts:291-301`、`:308-314` |
| 2026-10-01 | 置信度滑杆裁定 | `CONFIDENCE_STOPS` 非均匀档位；50 是真抛硬币；dontKnow 永不发送 | `src/core/question-core.ts:495-501`、`:465` |
| 2026-10-02 | tool-result diet；ESC 丢弃 | `compactAnswerForModel` 只回学习者新增信息；`dismissedAnswer` 最小诚实答案；答案删 questionId | `src/core/question-core.ts:753-761`、`:762-767`、`:433-435` |
| 2026-10-03 | 教学循环角色；思考通道改名 | `predict`/`check` + reveal 法则；`note`→`thinking`；`readingThinking` 独立通道 | `src/core/question-core.ts:209`、`:223-235`、`:455-464` |
| 2026-10-04 | **GLM 19 次拒调**：`problem` 调用连发 19 次 `"mode": "\"recall\""`，TypeBox 错误文本不点名期望值，模型逐字节重发直到 dev server 被杀 | practice heal（`healEncodedArguments` 前身） | `src/core/argument-heal.ts:15-19`；`tests/practice-heal.test.ts:1-7` |
| 2026-10-09 | **whitehead 事故**：quiz `type: "\"predict\""` 十连拒（逐字节相同，课程从未开始）+ `correctAnswer: [":parmenides"]` 四连拒 | heal 泛化为 `healToolRecord` 全覆盖；`stripModelValueDebris` 成员值残渣剥离；读侧镜像；probe/recall 改名；必填对前置 | `src/core/value-debris.ts:1-10`；`tests/tool-heal.test.ts:1-21`；`src/agent/tools/heal.ts:1-23`；`src/core/question-core.ts:251-255` |
| 2026-10-12 | **calculus 事故**：选项标签末尾的句点是内容不是残渣，先剥残渣会剥掉合法答案 | `coerceCorrectAnswer` 精确键优先于残渣清理；已答题卡 details/描述从原始调用重读 | `src/core/question-core.ts:624-630`；`tests/question-core.test.ts:314-345`；`components/answered-card.tsx:40-48` |

### 0.4 依赖图与桶导出总览

```
value-debris.ts ──────────────┐
                              ├─→ question-core.ts ─→ tool-parts.ts ─→ answer-presentation.ts
argument-heal.ts ─────────────┘         ↑                    ↑                  ↑
   ↑（agent 侧直接 import）        typebox              typebox/value      math-delims.ts
   heal.ts / practice.ts / submit-agent.ts                                  （core 内模块）
```

| 文件 | 行数 | 桶导出（`src/core/index.ts`） | 浏览器安全 | 纯度 |
|---|---|---|---|---|
| `value-debris.ts` | 26 | **否**（core 内部 + 测试直接 import） | 是（无 IO、无框架） | 全纯、幂等 |
| `argument-heal.ts` | 96 | **否**（agent 侧 `heal.ts:26` 等直接 import；core 内 `tool-parts.ts:33`） | 是 | 全纯、copy-on-write |
| `question-core.ts` | 802 | 是（`index.ts:27` `export *`） | 是 | 纯（两处读时钟、一处可注入 RNG，见各函数标签） |
| `tool-parts.ts` | 129 | 是（`index.ts:55`） | 是 | 全纯（`structuredClone` 只动克隆） |
| `answer-presentation.ts` | 57 | 是（`index.ts:56`） | 是 | 全纯 |

导入法则（`eslint.config.mjs:6-19`）：components 只准进 `@/src/core` 桶；core 永不 import agent/server/store。`argument-heal` 与 `value-debris` 虽纯且浏览器安全，但 shell 不直接消费它们（shell 经由 `parse*` 间接享受修复），故不入桶——与 `index.ts:12-15` 描述的"server-only core 模块不入桶"同一逻辑的轻量版。

---

## 1. `src/core/value-debris.ts` — 成员值残渣剥离（26 行）

### 1.1 模块定位与纯度边界

全模块只有一个导出函数，是整条题目链路最底层的叶子依赖。无 import、无 IO、无框架依赖，浏览器安全；不在桶导出内，消费者是 core 内部（`question-core.ts:21`、`chains.ts:2`）与测试（`tests/tool-heal.test.ts:27`）。头注释（`:1-18`）完整记录了 whitehead 事故（2026-10-09）与"只在成员比较处剥离、绝不碰自由文本"的缝纪律。

### 1.2 `stripModelValueDebris` 五要素精讲

**① 签名、行号与纯度标签**

```ts
export function stripModelValueDebris(value: string): string   // :24-26  [纯函数]（幂等）
```

**② 输入输出与不变量**

- 输入：任意字符串（模型抄写的"成员值"：correctAnswer 对选项值、quiz type 对字面量对、practice target 对命题 id）。
- 输出：剥掉**首尾**复制语法残渣后的字符串；内部字符一律不动（`:22-23` doc）。
- 不变量一：**幂等**——剥离字符集不含合法内部内容，二次调用结果不变（`:17` "Idempotent by construction"）。
- 不变量二：**只用于成员比较**。命题 statement、题干、解释等自由文本可能合法携带冒号／引号／反引号，对它们调用本函数是误用（`:12-14` "never on free text"）。
- 不变量三：不修改输入（字符串不可变，`replace` 返回新串）。

**③ 核心逻辑与分支逐步推导**

函数体一行（`:25`）：

```ts
return value.replace(/^[\s:."'`]+/, "").replace(/[\s:."'`]+$/, "");
```

两个锚定正则先后作用：`^[\s:."'`]+` 剥掉开头连续的任意空白、冒号、双引号、单引号、反引号（**任意交错**）；`[\s:."'`]+$` 对称地剥掉结尾。于是 `":parmenides"` → `parmenides`、`"\"predict\""` 的外层引号 → `predict`（内层转义引号由 `healEncodedArguments` 的 JSON.parse 通道处理，两者分工见 §2）、`` `value` `` → `value`、`: value` → `value`。字符类同时含五种残渣，所以 `: "'value'"` 这类混合粘连也能一次剥净。

**④ 边界条件与历史事故背景**

- **`":parmenides"` 事故**（2026-10-09，whitehead）：glm-5.3 发出 `correctAnswer: [":parmenides"]`——选项值粘上了 JSON 键值对的**冒号**——连续四次被拒（`:2-5`）。根因：成员字段是模型从自己上下文里**抄写**的，抄写会带上周边语法（冒号、引号、反引号、空白，`:8-10`）。
- **边界保护一（calculus 事故，2026-10-12）**：选项标签末尾的句点可能是**内容**（如 `"$f$ need not be differentiable at $a$."`）。因此本函数**绝不单独出现在成员判定入口**——`coerceCorrectAnswer` 先做精确键匹配、匹配不上才剥残渣（`question-core.ts:635-638`，详见 §3.3-C）。本函数自身无此保护，保护在调用方。
- **边界保护二（自由文本）**：`answerForPresentation` 刷新题干时**不**对题干剥残渣（`answer-presentation.ts:14` 直接取 `source.question`）；`normalizeQuizType` 只对 type 这个成员值剥（`question-core.ts:219`）。
- 空串／全残渣串 → 返回空串；调用方负责后续判定（如 `resolveTargetId` 对空串返回 null，`chains.ts:75`）。

**⑤ 真实上游调用方**

| 调用方 | 位置 | 用途 |
|---|---|---|
| `normalizeQuizType` | `src/core/question-core.ts:219` | 修复记录里 `"\"predict\""` 型 type 抖动 |
| `coerceCorrectAnswer` 内部 `clean` | `src/core/question-core.ts:637` | 非精确匹配的 correctAnswer 条目剥残渣（边界校验 + 判分共用） |
| `resolveTargetId` | `src/core/chains.ts:74`、`:79` | practice target 对命题 id/name 的成员匹配（whitehead 同源修复） |
| 测试 | `tests/tool-heal.test.ts:27`（import）、`:131-132`、`:188` | whitehead 事故钉子 |

### 1.3 轻量私有辅助函数归并表

本文件**无私有辅助函数**：唯一逻辑就是 `:25` 的两个内联正则。归并表为空（零遗漏声明：全文件 26 行 = 18 行头注释 + 1 空行 + 4 行 doc + 1 行签名 + 1 行函数体 + 1 行闭合）。

---

## 2. `src/core/argument-heal.ts` — 参数修复（heal）的纯核心（96 行）

### 2.1 模块定位与纯度边界

头注释（`:1-25`）自述定位：**THE WEAK-MODEL ARGUMENT HEAL 的纯核心**（所有者 2026-10-09 裁定，把 2026-10-04 的 practice heal 泛化）。放在 core 是因为**两条缝都需要它**（tool-parts 法则）：

- agent 边界：pi 的 `prepareArguments` 缝、TypeBox 校验**之前**（`withArgumentHeal` / `healToolRecord`，接线故事在 `src/agent/tools/heal.ts`）；
- 显示解析：`tool-parts.ts` 的 `parseQuizInput` 等在 `boundaryParse` 之前（`:10-13`）。

无 import（连 typebox 都不 import——schema 以**结构鸭子类型** `PropSchema` 传入），无 IO，浏览器安全；不入桶，agent 侧直接 import（`heal.ts:26`、`submit-agent.ts:18`，practice 经 `heal.ts:29` 转手）。全模块纯函数、copy-on-write：良构参数**同引用**原样通过（`:23-24`）。

**GLM 19 次拒调事故**（`:15-19`，所有者 2026-10-04）：glm-5.3 连续 19 次 `problem` 调用全部携带 `"mode": "\"recall\""`（JSON 字符串编码的枚举）；TypeBox 的错误文本 `must be equal to constant` **从不点名期望值**，模型每次原样重发同一 payload，直到 dev server 被杀。2026-10-09 whitehead 会话在 quiz `type` 上把同一循环跑了十回合（`:19-20`）。修复哲学：**机械可识别的抖动就修，其余留给校验诚实拒绝**（`heal.ts:11-15` 的所有者裁定原文转述）。

### 2.2 核心类型契约：`PropSchema`（`:29-33`）

```ts
type PropSchema = {
	type?: string;
	const?: unknown;
	anyOf?: PropSchema[];
};
```

这是 TypeBox 对象**单个属性 schema** 的最小结构投影（私有类型，不入桶）。注释（`:27-28`）说明本 fork 发出的形状：字面量联合携带 `anyOf[{const}]`，标量携带 `type`。`healEncodedArguments` 的 schema 参数类型是 `{ properties?: Record<string, PropSchema> }`（`:60`）——只读对象顶层属性，不递归进嵌套对象（修复对象是**一层**的；题目工具的抖动字段恰好都在顶层）。

### 2.3 `healEncodedArguments` 五要素精讲

**① 签名、行号与纯度标签**

```ts
export function healEncodedArguments(
	args: unknown,
	schema: { properties?: Record<string, PropSchema> },
): unknown                                                    // :58-96  [纯函数]
```

**② 输入输出与不变量**

- 输入：模型原始参数（任意 unknown）+ 工具声明的 schema（鸭子类型，只取 `properties`）。
- 输出：修复后的参数对象；**没有任何字段被修复时返回输入的同引用**（`:95` `return healed ?? args`）。
- 不变量一（良构不动）：非字符串值一律跳过（`:68`）；字符串值若已是合法字面量成员也跳过（`:73`）。
- 不变量二（修复有据）：只有 `JSON.parse` 成功**且**解析结果满足 schema 期望（字面量成员／null／布尔／数字／数组）才采纳；不可修复的值原样留下，让校验诚实拒绝（`:23-24`）。
- 不变量三（copy-on-write）：第一次真正修复时才浅拷贝 args（`:91` `healed ??= {...args}`），绝不修改输入对象。
- 不变量四（幂等）：修复后的值不再是字符串，第二遍必然跳过——所以注册表级包装下再叠工具级 heal 是无害的第二遍（`heal.ts:20-22`）。

**③ 核心逻辑与分支逐步推导**

1. **守卫**（`:62`）：args 非对象／null／数组 → 原样返回。heal 只处理对象形参数。
2. **取 properties**（`:63-64`）：schema 无 properties → 原样返回。
3. **惰性拷贝 accumulator**（`:65`）：`healed = null`。
4. **逐属性循环**（`:66-94`），对每个 `[key, prop]`：
   - `:67-68` 取 `raw = args[key]`；**非字符串直接 continue**——良构的布尔／数字／数组／枚举字面量全部原样通过。
   - `:69` `parsed = tryParse(raw)`：永不抛的 JSON.parse（坏 JSON → undefined）。
   - `:71-75` **字面量分支**：`literalsOf(prop)` 收集该属性接受的全部字面量（递归展开 anyOf）。若非空：
     - `:73` `literals.includes(raw)` → continue（字符串本身就是合法成员，如 `type: "predict"`，**绝不能**把合法字符串再 parse 一遍）；
     - `:74` `literals.includes(parsed)` → `fixed = parsed`（`"\"predict\""` parse 成 `"predict"` 命中成员 → 采纳）。
   - `:78` **null 分支**：字面量分支覆盖不了 null（`Type.Null` 无 const），联合"字面量 ∪ null"必须另外接受字符串 `"null"`（parse 成 null 且 `acceptsNull(prop)`）。
   - `:79-81` **布尔分支**：`prop.type === "boolean"` 且 parsed 是布尔 → 采纳（`"true"` → true）。
   - `:82-88` **数字分支**：`prop.type` 为 number/integer 且 parsed 是数字 → 采纳（`"17"` → 17）。
   - `:89` **数组分支**：`prop.type === "array"` 且 parsed 是数组 → 采纳（字符串编码的 options/target 列表）。
   - `:90-93` **提交**：`fixed !== undefined` 才惰性拷贝并写 `healed[key] = fixed`。注意 `fixed === undefined` 是"未修复"哨兵——parsed 恰为 undefined 的情况不存在（JSON.parse 不产出 undefined），而 null 修复由 `:78` 显式赋值，`fixed !== undefined` 对 null 成立，不会被误丢。
5. `:95` 返回 `healed ?? args`。

分支顺序即优先级：字面量 > null > 布尔 > 数字 > 数组，全部以 `fixed === undefined` 串联，互不覆盖。

**④ 边界条件与历史事故背景**

- **GLM 19 次拒调**（2026-10-04）与 **whitehead 十连拒**（2026-10-09）是本函数的出生证明（§2.1）。`tests/practice-heal.test.ts:28-30` 用事故的确切拼写 `QUOTED("recall")` 做钉子，并端到端驱动 pi-ai 自己的 `validateToolArguments`：修复后的参数通过、原始参数被拒。
- **字符串本身是合法成员**：`:73` 的 continue 是关键保护——枚举字面量本来就是字符串，若无此分支，`"predict"` 会被 JSON.parse 失败后落入后续分支（虽不会误修，但语义上必须显式短路）。
- **不可修复即诚实**：`"maybe"` 对 predict|check 联合 parse 失败 → fixed 保持 undefined → 原样留下 → TypeBox 拒绝并退回模型（出题重试）。heal 从不发明值。
- **一层修复**：嵌套对象内的抖动不在本函数射程（PropSchema 无 properties 递归）；题目契约的抖动字段全在顶层，这是有意的最小机制。
- **数组分支与 options 的分工**：quiz 的 `options` 字符串编码由更早的专用修复 `parseOptionsIfString`（2026-09-26）在 `prepareQuestionArguments` 里先处理；`healToolRecord` 的数组分支是它的通用兜底（两者幂等可叠加，`heal.ts:30-33`）。

**⑤ 真实上游调用方**

| 调用方 | 位置 | 场景 |
|---|---|---|
| `withArgumentHeal` | `src/agent/tools/heal.ts:38` | 注册表级标准 heal（每个工具的 prepareArguments 之后） |
| `parseQuizInput` | `src/core/tool-parts.ts:83` | 读侧镜像（quizDisplayInputSchema） |
| `parseAskInput` | `src/core/tool-parts.ts:97` | 读侧镜像（askInputSchema） |
| `parseExplainInput` | `src/core/tool-parts.ts:110` | 读侧镜像（explainDisplayInputSchema） |
| practice `problem` prepareArguments | `src/agent/tools/practice.ts:112` | 事故原发地的专用 heal（先于 target 归一） |
| practice `conclude` prepareArguments | `src/agent/tools/practice.ts:210` | 同标准 |
| submit-agent 通用工具工厂 | `src/agent/subagents/submit-agent.ts:96` | 抽取等 sub-agent 提交工具（叠在调用方 shim 之后） |
| 测试 | `tests/practice-heal.test.ts:21`、`tests/tool-heal.test.ts:26` | 事故钉子 |

### 2.4 轻量私有辅助函数归并表（100% 覆盖）

| 辅助 | 行号 | 用途 | 调用点 |
|---|---|---|---|
| `PropSchema`（私有类型） | `:29-33` | TypeBox 属性 schema 的最小结构投影（type/const/anyOf） | `:60` 签名、`:37`/`:44` 参数 |
| `literalsOf(prop)` [纯函数] | `:37-40` | 递归收集属性接受的字面量：有 anyOf 就 flatMap 递归成员；否则有 const 返回 `[const]`，无则 `[]`（非字面量属性） | `:71`；递归自调 `:38` |
| `acceptsNull(prop)` [纯函数] | `:44-47` | 属性是否接受 null：`type === "null"`  standalone，或 anyOf 成员里有 `type: "null"` | `:78` |
| `tryParse(raw)` [纯函数] | `:50-56` | 永不抛的 JSON.parse：坏输入返回 undefined（不是 null——null 是合法解析结果，必须可区分） | `:69` |

---

## 3. `src/core/question-core.ts` — 题目契约 + 纯判分逻辑（802 行）

### 3.1 模块定位与纯度边界

头注释（`:1-18`）自述：**question-core = 题目契约 + 纯判分逻辑。无框架 import、无 UI，一切确定性、可单测。** TypeBox schema 是工具输入契约（agent/tools 据此声明工具）；浏览器用同一批函数校验、洗牌、判分，再把判定经答案路径送回模型。三步循环（`:8-14`）：教师调 quiz 工具（无 server execute → 调用以 `input-available` 态的 typed tool part 落在 UI）→ 学习者在卡片作答、客户端用本模块判分 → 判定（选择 + 正确性 + 思考，**绝不含解释**——解释是模型自己写的）回到模型。因为待答问题**就是**持久化的消息 part，会话可以中途退出再免费续答（`:16-17`）。

- import 仅两个：`typebox`（`:20`）与 `./value-debris.ts`（`:21`）。浏览器安全，桶导出 `src/core/index.ts:27`。
- 纯度例外清单（全部显式标注）：`buildAnswer`/`dismissedAnswer` 读时钟（`answeredAt`）；`shuffleOptions` 默认参数 `Math.random` 非确定（注入 `seededRandom` 后确定）；`normalizeOptions` 对重复值**抛错**（确定性结果，无副作用）。其余全纯。
- 历史层说明：`QuestionData` 注释提到 `lh_question` custom entry（`:411`）、`ClientQuestion`/`toClientQuestion`（`:474-482`、`:688-697`）是**旧架构**（server 持有题目数据、经 bridge 下发）的遗留契约；原生记录架构下 `QuestionData` 是答题 dock 的内存组装结构（`components/question-dock.tsx:274-319`），`lh_question` 在 src/components 已无实体（全仓 grep 仅存这两处注释）。`correctIndices`/`committedAnswer`/`explanation` 上"NEVER send to the client before answering"（`:424-429`）同样是旧契约措辞——原生记录下原始调用参数本就随 SSE 事件流到达浏览器，防泄漏的实际执行者是渲染层（dock 不渲染正确索引与解释、检验题折叠在 reveal 后）。

### 3.2 核心 Schema、常量与类型契约

#### 3.2.1 选项属性：`quizOptionProps`（`:39-46`）与 `askOptionProps`（`:50-55`）

- `quizOptionProps`：`label`（必填，"bare claim, no reasoning"）+ `value`（可选机器可读值，缺省回落到 label）。**所有者裁定 2026-09-26：quiz 选项没有 `description` 字段**（`:34-38`）——模型可靠地用它泄漏正确性（"that's not the gradient"、"close but…"），使选择题可以靠排除法作答。中性阐述应放在题干或答后解释中；选项就是一个裸断言。
- `askOptionProps`：展开 quizOptionProps **再加回** `description`（`:48-49`）——ask 是不判分的偏好收集，没有正确性可泄漏。

#### 3.2.2 quiz 家族

**`quizInputBase`（`:158-193`）——共享出题字段（除 nodeId 外的一切）**，字段逐一：

| 字段 | 行号 | 契约要点（description 原文转述） |
|---|---|---|
| `question` | `:159-162` | 单一问题；**一回合一题**：问完就结束回合，答案决定下一题 |
| `options` | `:163-170` | 必填，≥2 项（minItems），**JSON 数组而非 JSON 编码字符串**；只有选项模式、无自由文本；每项给稳定 `value`，correctAnswer 按该值引用；**禁止模型自加 "I don't know" 选项**——该选择由系统添加 |
| `multiSelect` | `:171-175` | 可选布尔；多于一个正确选项且须全选时置 true |
| `explanation` | `:176-181` | 必填；答后揭示（对错都显示）；**刻意写在 correctAnswer 之前**：先推理、再承诺推理支持的答案 |
| `correctAnswer` | `:182-189` | 必填，`string \| string[]` 联合；单选单串、多选数组，学习者选择须与集合**精确相等**；**传值不传位置序号**——自检防误数；不匹配任何选项的值会被校验退回 |
| `details` | `:190-192` | 可选，题干下的附加上下文 |

**参数顺序裁定**（`:154-157`，所有者 2026-09-25）：解释是推理，推理发生在选答案**之前**；模型按 schema 顺序生成参数，所以 explanation 紧挨 correctAnswer 之前。所有消费者按键读取，顺序只是出题引导。

**`QUIZ_QUESTION_TYPES` / `QuizQuestionType`（`:209-210`）**：`["predict", "check"] as const` 及其索引类型。预测题／检验题是 teach quiz 的两种角色（所有者设计 2026-10-03"每个教学单元两问"）。**角色教义住在系统提示词里**，工具 description 只保持机械（`:195-200` 注释段）；枚举的一行说明只讲何时触发。

**`predictCheckType`（`:242-248`，私有）**：`Type.Union([Type.Literal("predict"), Type.Literal("check")])`，被两个 teach 出题工具**逐字共享**（所有者 2026-10-09：explain 加入循环角色）。description 强调 **bare word, no quotes**——正是 quote-copy 模型抖动（whitehead 钉子，`tests/tool-heal.test.ts`）的文案防线。predict = 教学步骤之前提出（自成回合，学习者作答后教学才展开；**到达即展开、永不折叠**）；check = 步骤教学完成后提出（折叠在 "Check your understanding" reveal 之后）。

**`quizInputObject`（`:256-268`）——TEACH 侧 quiz**：`type`（`:257`）+ `nodeId`（`:258-266`）领先，再展开 `quizInputBase.properties`。**必填对前置**（所有者 2026-10-09，`:251-255`）：glm-5.3 在长调用里丢弃 `type`/`nodeId`，**因为它们排在全部内容字段之后**——先生成的字段最不容易被丢。顺序同时也是出题顺序：先承诺节点与角色，再写题。`nodeId` 语义："这道题**关于**这个节点"——**计划位置信号，绝非完成度信号**（docs/probe-teach-split.md §3）；必须精确匹配本会话 plan_init 的节点 slug（调用时校验，不匹配退回）；一个节点配得上多少题就出多少题；离线检查走 ask_user_question。跨字段出题契约（Gate-3 硬化：**判不了的 quiz 绝不到达学习者**，schema-valid ⇔ gradeable）在工具 execute 的调用边界执行：`quizInputProblems` 在此，per-session nodeId 校验在 tools.ts（它读活动记录，本 core 永不触碰）。

**`probeQuizInputSchema`（`:277`）= `quizInputBase`**：PROBE 侧声明，**没有 nodeId 也没有 type**（`:270-276`）——会话地图尚不存在，探测只有一种问题角色（所有者 2026-10-03：探测者保留自己的工具，教学循环角色留给教师，杜绝误用邀请）。结构上与 base 全同（旧 superRefine 从未到达 wire——它在调用边界跑，如今由 quizInputProblems 承接）。

**`quizDisplayInputSchema`（`:286-289`）——显示解析专用**：base + `type: Type.Optional(Type.String())`（宽松 plain string）。原因（`:279-285`）：旧记录无 type；且 `Value.Clean` 只保留 schema 认识的键——若显示 schema 不含 type，dock 会丢失它据以渲染和 gate 的角色。归一化在读侧由 `normalizeQuizType` 完成；`nodeId` 保持被 Clean 剥掉（未知键）。PROBE quiz 按裸 base 解析（probe 调用无 type）。

#### 3.2.3 explain 家族（自由回忆出题，所有者 2026-09-27）

设计注释（`:291-301`）：**没有选项的出题机制**，学习者用自己的话作答。**反谄媚是结构化的**：模型在出题**之前**承诺完整正确答案——承诺随持久化调用参数旅行、提交时向学习者揭示、并复述进答案结果供模型对照判分；**客户端从不判自由文本**。一个承诺字段、含推理（所有者裁定 2026-09-27：独立的 explanation 字段是 quiz 残余，合并掉了）。机制教义住在工具 description（pi-native 裁定），不在系统提示词。

- **`explainInputBase`（`:303-318`）**：`question`（`:304-307`，一回合一题）+ `correctAnswer`（`:308-314`，必填字符串）+ `details`（`:315-317`）。correctAnswer 的 description 是反谄媚契约全文：完整答案含推理、**在学习者看到题目之前承诺**；承诺不可变——答案回来后严格对照本文判分，**绝不看了学习者的话再修订承诺，绝不为善意把错答案判对**；提交时展示给他，下一条回复判他文字的细微处。
- **`explainInputObject`（`:326-338`）——TEACH 侧**：`type`（`:327`）+ `nodeId`（`:328-336`，与 quiz 的 nodeId 语义逐字相同，缝识别两个工具名）领先，再展开 base；必填对前置与 teach quiz 完全一致（所有者 2026-10-09，`:322-325`）。
- **`explainDisplayInputSchema`（`:345-348`）**：base + 可选宽松 `type`——与 quiz 显示模式完全同构（`:340-344`）；旧记录无 type，`questionNeedsReveal` 视同 check（常备默认）；nodeId 被 Clean 剥掉；PROBE recall 按裸 base 解析。

#### 3.2.4 ask：`askInputSchema`（`:367-389`）

- **无 `mode` 参数**（`:368-370`）：pi 原版就没有——模式由 options 是否在场推断（dock 正是这么做的，`question-dock.tsx:279-288`）。少一个模型可误用的旋钮。
- `question`（`:371-374`）：单一问题、一回合一题。
- `details`（`:375-377`）：可选附加上下文。
- `options`（`:378-385`）：**可选**数组（minItems 2，askOptionProps）；省略即自由文本模式；有选项时学习者永远可以选 "Other" 输入自定义答案。
- `multiSelect`（`:386-388`）：可选布尔。
- ask 的选项 sanity（label 非空、值互异——ask 不判分，但重复值会破坏 dock 的值键控）在调用边界 execute 跑 `askOptionProblems`（`:390-392` 注释）。

#### 3.2.5 词表、别名与 Static 类型

- **`QUIZ_TOOL_NAMES`（`:362`）**：`["quiz", "explain"] as const`。注释（`:359-361`）称 teach 缝（phases）、计划位置折叠、pending gate 都识别"无论哪个被武装"。**取证事实**：全仓（src/components/app/tests/scripts/electron）grep 无外部消费点——实际闸门词表是 `pending.ts:53-59` 的 `QUESTION_TOOLS`（五名：quiz/probe/ask_user_question/explain/recall）。本常量是契约词表预留，讲解时不应把它当成现行闸门。
- **`quizInputSchema`（`:365`）= `quizInputObject`** 别名（教师 quiz 声明）。生产代码直接用 `quizInputObject`；别名消费者是测试（`tests/tool-parts.test.ts:22`、`:68`；`tests/question-core.test.ts:25`、`:65-71` 等）。
- **Static 类型（`:394-397`）**：`QuizToolInput = Static<typeof quizInputObject>`、`AskToolInput`、`ExplainToolInput`、`ProbeExplainToolInput = Static<typeof explainInputBase>`——schema 即类型，单一事实来源。

#### 3.2.6 数据接口（判分与渲染的形状契约）

- **`QuizOption`（`:25-29`）**：`{label, value, description?}`。description 仅 ask 使用（quiz schema 已删，但旧记录可能携带，normalizeOptions 仍会 trim 保留）。
- **`OptionAnswer`（`:401-405`）**：`{label, value, index}`，index 是 **1-based 显示索引**；"按选项展示顺序的真实选择"。
- **`QuestionKind` / `SelectMode` / `QuestionMode`（`:407-409`）**：`"quiz"|"ask"|"explain"`；`"single-select"|"multi-select"`；后者再并 `"text"`。
- **`QuestionData`（`:412-431`）**：dock 组装的完整题目数据。`id`（=toolCallId）、`kind`、`questionType?`（仅 teach quiz；probe 与旧记录缺省→一切 check 形）、`question`、`context?`、`mode`、`options`（**洗牌后的显示顺序**，`:423`）、`correctIndices?`（仅 quiz）、`committedAnswer?`（仅 explain）、`explanation?`（仅 quiz）、`createdAt`。三个答案字段带旧契约注释"答前绝不发给客户端"（见 §3.1 历史层说明）。
- **`QuestionAnswerData`（`:436-472`）**：学习者答案的完整结构记录，随 toolResult 的 details 持久化。字段全表：

| 字段 | 行号 | 语义 |
|---|---|---|
| `kind` | `:437` | 题型 |
| `tool?` | `:443` | **持久化调用的工具名**（所有者 2026-10-09）：probe 阶段是 `probe`/`recall`，teach 是 `quiz`/`explain`——卡片据此标 "Probe"/"Recall"，阶段边界在记录中可见；改名前记录缺省→按 kind 标 |
| `questionType?` | `:447` | 角色快照（预测题收起解释；日后校准分组）；旧记录与 probe 答案缺省 |
| `questionText` | `:448` | 题干快照 |
| `options?` | `:449` | `{index,label}[]` 渲染快照（**无 value**——这正是 answerForPresentation 需要值身份绑定的原因，见 §5） |
| `dontKnow` | `:450` | "I don't know" |
| `answers` | `:451` | `OptionAnswer[]`（含 value，稳定身份） |
| `other?` / `text?` | `:452-453` | ask 的 "Other" 自由文本 / ask·explain 的文本模式答案 |
| `thinking?` | `:456` | 对**题目**的推理（所有者 2026-10-03 由 `note` 改名——"that's what it is"） |
| `note?` | `:460` | **@deprecated** 改名前键，永不再写；旧记录经同一类型回放，读取用 `thinking ?? note` |
| `readingThinking?` | `:464` | **阅读教学散文时**的思考（所有者 2026-10-03）——与 thinking 分离的通道，由阅读字段捕获、随 check 答案旅行；空则缺省 |
| `confidence?` | `:465` | 仅 quiz：自报选对概率 0-100 原始值；dontKnow 永不发送（所有者 2026-10-01） |
| `correct?` / `correctIndices?` / `committed?` / `explanation?` | `:466-469` | 判定与渲染快照（correctIndices/explanation 仅 quiz；committed 仅 explain） |
| `dismissed?` | `:470` | ESC 丢弃标记 |
| `answeredAt` | `:471` | 时钟戳 |

  **无 questionId**（所有者 tool-result diet 2026-10-02，`:433-435`）：它曾是 toolCallId 的复述——toolResult 消息本就携带。
- **`ClientQuestion`（`:475-482`）**：旧架构客户端载荷，**刻意省略答案**（无 correctIndices/committedAnswer/explanation）；配套 `toClientQuestion` 见 §3.3-E。
- **`AnswerRequest`（`:485-493`）**：提交请求形状——`dontKnow?`、`values?`（选项值）、`other?`、`text?`、`thinking?`、`readingThinking?`、`confidence?`（0-100 原始概率，**50 是真抛硬币、恒发送**，所有者 2026-10-01）。注：现行 dock 不在 req 里填 readingThinking（`question-dock.tsx:394-403`），由 `chat.tsx:1770-1774` 在 buildAnswer 之后并入输出；字段保留供 bridge 路径。

#### 3.2.7 置信度常量与答题 dock 状态类型

- **`CONFIDENCE_STOPS`（`:500`）= `[0, 30, 50, 70, 90, 100]`**，`DEFAULT_CONFIDENCE_INDEX`（`:501`）= 2。所有者裁定 2026-10-01（`:495-499`）：滑杆吸附档位是"所选答案正确"的原始概率，**刻意非均匀**——分辨率集中在顶部，因为校准信号住在那里（**90 与 100 之分区分"会了"与"精通"**）；50 是真抛硬币、也是静止默认——**没碰过的 50 与刻意选的 50 是同一个数**（所以恒发送，不做"未触碰"特判）。
- **`DockSelection`（`:506-510`）**：`{selected: Set<number>（0-based 显示索引）, otherSelected, dontKnow}`。
- **`QuestionFormDraft`（`:516-522`）**：内存提交快照——挺过问题表单的乐观卸载，**永不写存储**；索引用调用的稳定洗牌。字段：selection/thinking/other/text/confidenceIndex。
- **`QuestionDraft`（`:524-527`）**：`{form?, readingThinking?}`——session-core 按 pending key 存取的草稿信封（`components/session-core.ts:244`、`:909-920`）。

### 3.3 导出函数与核心内部算法五要素精讲

#### A 组：出题校验（跨字段契约）

---

**A1. `parseOptionsIfString`**

**①** `export function parseOptionsIfString<T>(options: string | T[] | undefined): unknown` — `:63-72` **[纯函数]**

**②** 输入：可能是 JSON 编码字符串的 options；输出：解析出的数组，或**原样输入**。不变量：非字符串不动；parse 失败或结果非数组不动（"validation then reports honestly"，`:61-62`）；绝不抛。

**③** 逐步：`:64` 非字符串 → 原样返回；`:65-69` try `JSON.parse`，结果是数组 → 返回 parsed；catch 吞掉（不是 JSON）；`:71` 兜底返回原字符串。注意 `:67` 只认数组——parse 出对象/标量同样原样退回。

**④** GLM 模型抖动守卫（所有者批准 2026-09-26，`:57-62`）：模型有时把 `options` 发成 JSON 编码字符串而非数组。**共享于两处**：工具 prepareArguments（server，校验前）与 normalizeOptions（client——持久化调用保留原始字符串，dock 必须再强制一次）。不可解析时原样通过、让校验诚实报错，是"修复有据、其余诚实"哲学的第一次落地（早于通用 heal 十天）。

**⑤** 调用方：`src/agent/tools.ts:71`（`prepareQuestionArguments`，`:67-77`）；`src/core/question-core.ts:565`（`normalizeOptions`）；测试 `tests/question-tools.test.ts:325`（describe 钉子）。

---

**A2. `optionProblems`（私有核心）**

**①** `function optionProblems(options: Array<{label: string; value?: string}>): {problems: string[]; keys: string[]}` — `:85-103` **[纯函数]**

**②** 输入：原始选项数组；输出：问题列表 + **解析后的键列表**（供 correctAnswer 成员检查）。不变量：键的解析规则与 `normalizeOptions` **逐字一致**（trimmed value 回落 trimmed label，`:81-84` doc）——这是 schema-valid ⇔ gradeable 的基石。

**③** 逐选项（`:90-101`）：label.trim() 为空 → push "options[i].label is empty" 并 return（跳过键收集）；`key = option.value?.trim() || label`（`:96`）；keys 已含 key → push "Two options resolve to the same value"（`:97-99`）；无论重复与否都 `keys.push(key)`（`:100`——重复键保留在列表里，correctAnswer 检查仍能命中）。

**④** 空 label 选项被报告而非静默丢弃（与 normalizeOptions 的 filter 丢弃形成"边界拒绝、读侧防御"的分工）；重复值在边界是问题、在读侧 normalizeOptions 是抛错（`:577`）——因为能走到读侧的重复值意味着边界失守，必须响亮失败。

**⑤** 调用方：`askOptionProblems`（`:107`）、`quizInputProblems`（`:117`）。无外部调用（私有）。

---

**A3. `askOptionProblems`**

**①** `export function askOptionProblems(options: Array<{label: string; value?: string}>): string[]` — `:106-108` **[纯函数]**

**②** 输入选项数组，输出问题列表；ask 不判分，所以**只有共享 sanity、没有 correctAnswer 检查**（`:105` doc）。

**③** 一行：`return optionProblems(options).problems`——丢弃 keys。

**④** 重复值仍必须拒绝：它们破坏 dock 的值键控（`tool-parts.ts:92-94` doc）。自由文本模式传 `[]`（`cleaned.options ?? []`）。

**⑤** 调用方：`src/agent/tools.ts:91`（askUserQuestionTool execute）；`src/core/tool-parts.ts:99`（parseAskInput 读侧镜像）。

---

**A4. `quizInputProblems` —— 为什么不能只靠 JSON Schema**

**①** `export function quizInputProblems(input: {options: Array<{label: string; value?: string}>; correctAnswer: string | string[]; multiSelect?: boolean}): string[]` — `:112-142` **[纯函数]**

**②** 输入：结构已过 schema 的 quiz 参数；输出：问题列表，**空 = dock 可以武装并忠实判分的 quiz**（`:110-111` doc）。不变量：规则与判分路径（normalizeOptions / coerceCorrectAnswer / resolveCorrect）**精确镜像**，故 schema-valid ⇔ gradeable（`:74-79`）。

**③** 逐步推导：
1. `:117` `optionProblems` 拿 problems + keys（解析后的选项键）。
2. `:121` **先跑与显示/判分同一条选项感知强制**：`entries = coerceCorrectAnswer(input.correctAnswer, keys)`——精确选项键在残渣清理之前被保留（calculus 事故防线，注释 `:119-120`）。
3. `:122-126` `unique = [...new Set(entries)]`；空集或含空串 → push "correctAnswer is required" 并**提前返回**。
4. `:127-133` 逐个 unique 检查成员：不在 keys → push 详细错误，**列出全部合法值**并命令"Copy the exact value (or label) of the intended option — never a paraphrase or slug"。错误文本点名期望值，正是对 GLM 19 次拒调事故（TypeBox 错误不点名 → 模型盲目重发）的直接回应。
5. `:135-140` 基数一致性：`unique.length > 1 && multiSelect !== true` → push "a single-select question with several correct answers can never be answered correctly. Set multiSelect: true, or make exactly one option correct."

**④** **为何不能只靠 JSON Schema**：TypeBox 表达的是结构（类型、必填、minItems、字面量联合）；"correctAnswer 的每个值必须 ∈ 选项解析键集合"与"多正确值 ⇒ multiSelect 必须为 true"是**跨字段语义约束**，结构 schema 无法表达。于是分工：**TypeBox 把结构带给模型，problems 函数把精炼带给调用边界**（`:149-152` 注释）。执行位置在工具 execute（不是 schema 上的 superRefine——旧 superRefine 从未到达 wire，`:274-276`）：失败 → `invalidInputResult` isError 结果 → 出题重试，**无效问题绝不到达学习者**（`:75-77`）。边界条件：`correctAnswer: "[]"` 且无选项键为 `"[]"` → entries 空 → required 错误（`tests/question-core.test.ts:156` 钉子）；数字 17 经边界 Convert 成 "17" 后仍须命中选项键，否则同样退回。

**⑤** 调用方：`src/agent/tools.ts:213`（probeQuizTool）、`:384`（teachQuizToolFor）；`src/agent/teacher-agent.ts:334`（bareQuestionTools）；`src/core/tool-parts.ts:86`（parseQuizInput 读侧镜像）；测试 `tests/question-core.test.ts:78-156`、`tests/tool-heal.test.ts:32`。

---

**A5. `explainInputProblems`**

**①** `export function explainInputProblems(input: {correctAnswer: string}): string[]` — `:352-357` **[纯函数]**

**②** 输入：explain 参数；输出：问题列表。契约只有一条：**承诺必须存在**（`:350-351` doc）——空结果 = dock 可武装、模型可对照判分的 explain。

**③** `:353-355` `correctAnswer.trim().length === 0` → 返回单条问题 "correctAnswer is required — commit to the full correct answer BEFORE posing the question."；否则 `[]`。

**④** 没有选项、没有跨字段成员检查——explain 的判分者是模型，客户端只要求承诺非空。trim 判空意味着全空白承诺同样被拒。

**⑤** 调用方：`src/agent/tools.ts:232`（teachExplainToolFor，与 nodeIdProblem 合并）、`:257`（probeExplainTool）；`src/core/tool-parts.ts:112`（parseExplainInput 镜像）。

---

**A6. `normalizeQuizType`**

**①** `export function normalizeQuizType(raw: unknown): QuizQuestionType | undefined` — `:217-221` **[纯函数]**

**②** 输入：持久化 quiz 的原始 type（任意 unknown）；输出：`"predict" | "check" | undefined`。不变量：非字符串 → undefined；不可修复抖动 → undefined（调用方渲染 "Quiz" 与 check 形卡片，`:212-216` doc）。

**③** `:218` 非字符串返回 undefined；`:219` `stripModelValueDebris(raw)` 剥残渣；`:220` 精确三分：predict / check / undefined。

**④** 三类降级：旧记录无 type 字段（undefined）；whitehead 型 `"\"predict\""` 抖动——剥掉外层引号后命中 predict，**原始持久化记录显示出它本来的角色**（2026-10-09 注释）；彻底不可识别的值 → undefined → check 默认。注意它只剥**残渣**不做 JSON.parse——`"\"predict\""` 的外层引号属于残渣字符集；更深的编码由 healEncodedArguments 在读侧先行处理（tool-parts.ts:83）。

**⑤** 调用方：`components/question-dock.tsx:150`（collapsed bar 的 "Prediction" 标签）、`:298`（QuestionData.questionType 快照）；`src/core/question-core.ts:234`（questionNeedsReveal）；测试 `tests/tool-heal.test.ts:30`。

---

**A7. `questionNeedsReveal` —— reveal 法则的纯谓词**

**①** `export function questionNeedsReveal(tool: string, rawInput: unknown, phase: string): boolean` — `:232-235` **[纯函数]**

**②** 输入：工具名、原始调用参数、阶段；输出：是否需要折叠在 "Check your understanding" reveal 之后。法则（所有者 2026-10-03；explain 2026-10-09 加入，`:223-231` doc）：**teach 阶段的 CHECK 折叠；PREDICTION 永不折叠**——预测先于教学并 gate 教学，折叠它会颠倒循环；probe/plan 问题与 ask 也不折叠。两个 teach 出题工具（quiz 与 explain）服从同一法则。

**③** `:233` 工具非 quiz/explain 或 phase 非 "teach" → false；`:234` `normalizeQuizType(rawInput?.type) !== "predict"` → true。即：teach 的 quiz/explain 中，type 归一后不是 predict 的一切（含 undefined）都折叠。

**④** 先于 type 字段的记录无 type → 按 check 渲染（常备默认）。rawInput 为 null/非对象时可选链安全取 undefined。chat.tsx 对 pending question 调用本谓词；**阅读思考字段挂载在同一真相上**（`components/chat.tsx:2369-2386`：`pending && requiresReveal` 时挂 ReadingThinkingField）。

**⑤** 调用方：`components/chat.tsx:518`（`requiresReveal = pending !== null && questionNeedsReveal(pending.tool, pending.input, phaseAt3(messages))`）。

#### B 组：选项归一与确定性洗牌

---

**B1. `normalizeOptions`**

**①** `export function normalizeOptions(options: string | Array<{label: string; value?: string; description?: string}> | undefined): QuizOption[]` — `:558-581` **[纯函数]**（重复值抛错是确定性结果）

**②** 输入：原始 options（可能是 GLM 字符串编码）；输出：归一后的 `QuizOption[]`（**保持输入顺序**，洗牌是下一步的事）。不变量：键解析规则与 optionProblems 逐字一致；空 label 丢弃；重复值**抛错**。

**③** 逐步：`:561` seen 集合；`:565` `parseOptionsIfString` 强制（持久化调用可能携带字符串编码 options——与 server prepareArguments 同一条强制）；`:566-568` 非数组 → 空列表；`:570-574` map：label.trim()、`value = option.value?.trim() || option.label.trim()`、description trim 或 undefined；`:575-580` filter：空 label → false 丢弃；`:577` `seen.has(value)` → **throw `duplicate option value "…"`**；否则 seen.add 并保留。

**④** 抛错而非静默去重的理由：能到达读侧的重复值意味着边界校验失守（optionProblems 本应拒绝），此时静默去重会掩盖契约破裂并可能改变判分键——响亮失败优于错误数据。ask 的 description 在此保留（quiz 旧记录若携带也保留，渲染层自行决定用不用）。

**⑤** 调用方：`components/question-dock.tsx:289`（dock 武装）；`src/core/answer-presentation.ts:19`（历史回显取原始顺序选项）；测试 `tests/question-core.test.ts:328` 等。

---

**B2. `seededRandom` —— 字符串种子 → mulberry32 RNG**

**①** `export function seededRandom(seed: string): () => number` — `:588-602` **[纯函数（工厂）]**；返回的 RNG 是**有状态闭包**，但同种子必产生同一序列（确定性）。

**②** 输入：种子字符串（渲染组件传 toolCallId）；输出：`() => number`，值域 [0,1)。不变量：同种子 → 同序列；不同种子 → 不同序列；无外部状态、无 Math.random。

**③** 逐步推导（两段算法）：
1. **FNV-1a 哈希把字符串压成 32 位种子**（`:589-593`）：`h = 2166136261`（FNV 偏移基）；逐字符 `h ^= seed.charCodeAt(i)` 然后 `h = Math.imul(h, 16777619)`（FNV 素数，imul 保证 32 位整数乘法语义）。
2. **mulberry32 PRNG**（`:594-601`）：`a = h >>> 0`（无符号化）；每次调用：`a |= 0; a = (a + 0x6d2b79f5) | 0`（状态推进，黄金比例常数）；`t = Math.imul(a ^ (a >>> 15), 1 | a)`；`t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t`（两轮混淆）；`return ((t ^ (t >>> 14)) >>> 0) / 4294967296`（取高 32 位除以 2^32 → [0,1)）。

**④** 存在理由（`:587` doc）：**hydration 安全的确定性洗牌**。`Math.random()` 在 server 与 client 洗出不同顺序，破坏 React hydration（React #418 错误）；per-toolCallId 种子让顺序**跨刷新稳定**、又**逐题不同**。跨域复用：图谱布局也用它给节点播种（`src/core/layout.ts:611` `seededRandom(node.id)`）——同一确定性纪律。

**⑤** 调用方：`components/question-dock.tsx:292`（`shuffleOptions(options, seededRandom(toolCallId))`）；`src/core/layout.ts:611`；测试 `tests/question-core.test.ts`（shuffle 组）。

---

**B3. `shuffleOptions` —— 可注入 RNG 的 Fisher–Yates**

**①** `export function shuffleOptions(options: QuizOption[], rand: () => number = Math.random): QuizOption[]` — `:610-620` **[纯函数（注入确定性 RNG 时）]**；默认 `Math.random` 非确定，生产渲染路径**必须**注入 `seededRandom(toolCallId)`。

**②** 输入：归一后的选项 + RNG；输出：**副本**的洗牌（输入数组不动）。不变量：输出是输入的排列（元素不增不减不改）；`correctAnswer` 按值键控，所以显示顺序可以在解析索引**之前**安全洗牌（`:583-584` doc）。

**③** 逐步：`:611` `out = [...options]` 拷贝；`:612-618` 标准 Fisher–Yates 倒序：i 从 n-1 到 1，`j = Math.floor(rand() * (i + 1))`（`:613`，j ∈ [0,i] 均匀），交换 out[i] 与 out[j]（`:614-617` 经 a/b 临时量）；`:619` 返回 out。每个排列等概率（RNG 均匀时）。

**④** doc（`:604-609`）点名事故：Math.random 在 server/client 洗出不同顺序 → hydration 破裂（React #418）。**顺序契约**：dock 先 normalizeOptions → shuffleOptions → **之后** resolveCorrect（`question-dock.tsx:289-306`）；resolveCorrect 的 doc（`:654-656`）反向强调"Must run AFTER shuffling"。quiz 才洗牌；ask 不洗（`:292` 条件 `kind === "quiz"`）——ask 无判分，顺序即模型书写顺序。

**⑤** 调用方：`components/question-dock.tsx:292`（唯一生产调用点）；测试 `tests/question-core.test.ts`。

#### C 组：判分（值键控 → 索引 → 精确集合）

---

**C1. `coerceCorrectAnswer` —— 精确键优先的残渣清理**

**①** `export function coerceCorrectAnswer(correctAnswer: string | string[], optionValues: readonly string[]): string[]` — `:631-652` **[纯函数]**

**②** 输入：模型写的 correctAnswer（串或数组）+ **真实选项键集合**（必填参数——"no caller can strip a valid answer before membership"，`:627-628`）；输出：清理后的字符串数组。不变量：**规范选项键永不被改写**（`:630`）；精确匹配优先于一切清理。

**③** 逐步推导：
1. **内部 `clean` 闭包**（`:635-638`）：`trimmed = value.trim()`；若 `optionValues.includes(trimmed)` → **原样返回 trimmed**（精确键，哪怕它长得像残渣）；否则 `stripModelValueDebris(value)`（whitehead heal）。
2. `:639` 数组输入 → 逐项 map(clean)。
3. 字符串输入：`:640` trim；`:642` **整串精确命中选项键 → 直接 `[trimmed]`**——注释（`:641`）：一个精确字符串键**本身可以长得像 JSON 数组**（如选项值就是 `"[]"`，`tests/question-core.test.ts:274` 钉子）。
4. `:643-650` 形如 `[…]` 且非精确键 → try JSON.parse；解析出数组 → 逐项 `clean(String(v))`（JSON 字符串编码的多选强制）；parse 失败 → 当作单个字面值落下去。
5. `:651` 兜底 `[clean(correctAnswer)]`。

**④** **calculus 事故（2026-10-12）**是本函数的形状来源（`:624-630` doc）：选项标签末尾的句点、引号、反引号可以是**内容**——`"$f$ need not be differentiable at $a$."` 的句点若先剥残渣就剥掉了合法答案。所以精确键检查必须先于清理，且 optionValues 是必填参数（结构上杜绝"先剥后比"的调用方式）。非匹配项保留 whitehead heal（`[":parmenides"]` → `["parmenides"]`，`tests/tool-heal.test.ts:131`）。三处共享：边界（quizInputProblems:121）、显示（经 parse 链）、判分（resolveCorrect:662）。

**⑤** 调用方：`src/core/question-core.ts:121`（quizInputProblems）、`:662`（resolveCorrect）；测试 `tests/question-core.test.ts:252-274`、`tests/tool-heal.test.ts:130-132`、`:188`。

---

**C2. `resolveCorrect`**

**①** `export function resolveCorrect(correctAnswer: string | string[] | undefined, options: QuizOption[]): {indices: number[]; error?: string}` — `:657-676` **[纯函数]**

**②** 输入：作者给的值 + **洗牌后**的显示选项；输出：1-based 显示索引（去重、升序）或错误。不变量：**按值键控而非位置**——"a typo is a hard error instead of a silent wrong grade"（`:654-656` doc）；必须在洗牌之后运行。

**③** 逐步：`:661` undefined → `{indices:[], error:"correctAnswer is required"}`；`:662` coerceCorrectAnswer（选项感知清理）；`:663` 空数组 → 同 required 错误；`:664` `byValue = new Map(options.map((o,i) => [o.value, i+1]))`；`:666-673` 逐值：字符串再 trim，查 Map；**未命中 → 硬错误**，错误文本列出全部已知值（`correctAnswer "v" does not match any option value ("a", "b", …)`）；`:675` `Array.from(new Set(indices)).sort((a,b)=>a-b)` 去重升序返回。

**④** 硬错误设计：位置键控下模型数错选项会**静默判错**；值键控下拼错立即显形。dock 对 error 的处理是 `console.error` 并置空索引（`question-dock.tsx:307-308`）——但边界 quizInputProblems 已保证能走到这里的 correctAnswer 必可解析（schema-valid ⇔ gradeable），此分支是防御纵深。多选去重防止模型重复列值导致索引重复。

**⑤** 调用方：`components/question-dock.tsx:306`（唯一生产调用点，传入 `ordered`）；测试 `tests/question-core.test.ts:280-312`（含 calculus 钉子 `:329-330`）。

---

**C3. `isCorrect`**

**①** `export function isCorrect(selectedIndices: number[], correctIndices: number[]): boolean` — `:679-684` **[纯函数]**

**②** 输入：学习者选择的索引集合与正确索引集合；输出：布尔。不变量：**精确集合相等**——同数量、同成员（`:678` doc）；顺序无关；不修改输入（排序在副本上）。

**③** `:680` 长度不等 → false（多选漏选/多选立即判负，无部分分）；`:681-682` 两数组各自拷贝升序排序；`:683` 逐位全等。

**④** 空选择 vs 空正确集：长度相等（0=0）且 every 空真 → true——但生产路径 dontKnow 在 buildAnswer 里先行短路为 false（`:737`），空正确集只可能来自 resolveCorrect 失败（边界已拦截）。多选"选对一半"判负是精确集合语义的直接推例。

**⑤** 调用方：`src/core/question-core.ts:737`（buildAnswer quiz 分支）；测试 `tests/question-core.test.ts:399-403+`。

#### D 组：答题 dock 选择状态机（纯，供测试）

---

**D1. `emptyDockSelection`**

**①** `export const emptyDockSelection = (): DockSelection => ({selected: new Set(), otherSelected: false, dontKnow: false})` — `:512` **[纯函数（工厂）]**

**②** 输出全新空选择；每次调用新 Set（无共享可变状态）。

**③** 单行字面量。

**④** dock 初始化与草稿恢复的兜底（`initialDraft?.selection ?? emptyDockSelection()`）。

**⑤** 调用方：`components/question-dock.tsx:325`。

---

**D2. `toggleOption`**

**①** `export function toggleOption(mode: SelectMode, sel: DockSelection, idx: number): DockSelection` — `:535-543` **[纯函数]**

**②** 输入：选择模式、当前选择、0-based 显示索引；输出：**新** DockSelection。不变量（`:529-534` doc）：单选——该选项成为**唯一**答案并取代 "Other"；多选——选项与兄弟选项**及 "Other" 独立共存**（选选项绝不清自定义答案，反之亦然）；任何切换都清 dontKnow。

**③** `:536-541` 多选：拷贝 Set，has 则 delete 否则 add，返回 `{selected, otherSelected: sel.otherSelected, dontKnow: false}`；`:542` 单选：`{selected: new Set([idx]), otherSelected: false, dontKnow: false}`。

**④** 多选独立性是所有者裁定的 UX 契约（dock 注释 `question-dock.tsx:321-324` 复述）；dontKnow 与真实选择互斥——一旦选了就撤销"不知道"。

**⑤** 调用方：`components/question-dock.tsx:371`（`const toggle = (idx) => setSel(toggleOption(selectMode, sel, idx))`）。

---

**D3. `toggleOther`**

**①** `export function toggleOther(mode: SelectMode, sel: DockSelection): DockSelection` — `:551-554` **[纯函数]**

**②** 输入输出同上（无 idx）。不变量（`:545-550` doc）：单选——选 "Other…" 使其成为唯一答案、取代列表选项（**已输入的文字永远存活**——文字在独立 state，不在选择里）；多选——与列表选择共存切换、什么都不清。

**③** `:552` 多选：`{...sel, otherSelected: !sel.otherSelected, dontKnow: false}`；`:553` 单选：`{selected: new Set(), otherSelected: true, dontKnow: false}`。

**④** 单选没有"取消 Other"路径（它取代列表选项）——dock 注释（`question-dock.tsx:459`）点明这一点；键盘机在 Other 行上的行为据此设计。

**⑤** 调用方：`components/question-dock.tsx:423`（selectOther）、`:707`（文本输入聚焦时确保 Other 被选中）。

#### E 组：答案组装与模型可读文本

---

**E1. `buildAnswer`**

**①** `export function buildAnswer(qd: QuestionData, req: AnswerRequest, tool?: string): QuestionAnswerData` — `:708-751` **[纯函数*]**（逻辑全纯；唯一非确定性是 `answeredAt` 读时钟，`:719`）

**②** 输入：武装好的题目数据 + 提交请求 + 可选工具名；输出：完整答案记录。不变量：quiz 在此判分、ask 不判分（`:704-707` doc）；answers 按显示顺序；dontKnow ⇒ correct=false 且无 confidence；explain 只快照承诺、绝不客户端判分；不修改 qd/req。

**③** 逐步推导：
1. **base**（`:709-720`）：kind；`...(tool ? {tool} : {})`（工具名快照，卡片据此标 Probe/Recall）；questionType 快照；questionText；`options` 快照 `{index: i+1, label}`（**无 value**）；`dontKnow: req.dontKnow === true`；answers 空；thinking/readingThinking 各 trim 或 undefined；answeredAt 时钟。
2. **值 → OptionAnswer**（`:722-730`）：byValue Map（value → {...o, index: i+1}）；逐 req.values 查表，**未知值静默忽略**（`:726` continue）；命中 push `{label, value, index}`；`:729` 按 index 升序排序（显示顺序）。
3. `:731-732` other/text 各 trim 后非空才写。
4. **quiz 分支**（`:734-744`）：correctIndices 快照（`qd.correctIndices ?? []`）；explanation 快照；`:737` `correct = dontKnow ? false : isCorrect(answers.map(a=>a.index), qd.correctIndices ?? [])`；`:741-743` 置信度**只搭真实 quiz 答案**——`!dontKnow && req.confidence !== undefined` 时 `Math.max(0, Math.min(100, Math.round(req.confidence)))`（防御性夹取；dock 吸附档位，记录接受任意整数，注释 `:738-740`）。
5. **explain 分支**（`:745-749`）：`committed = qd.committedAnswer` 快照（供揭示与渲染）；无 correct 字段——模型在下一条回复里对着承诺判分。
6. ask：不进任何分支，无判分字段。

**④** 置信度裁定（所有者 2026-10-01）：没有答案就没有概率——dontKnow 时滑杆灰掉、什么都不发（`question-dock.tsx:829` 显示 "—"）；50 恒发送（没碰过与刻意选不可区分，也不应区分）。未知值忽略是防御：dock 只发真实选项值，外来请求可能带脏值。tool 参数是 2026-10-09 改名后的阶段标签来源；旧记录无 tool → kind 标签。

**⑤** 调用方：`components/question-dock.tsx:413`（`onSubmit(buildAnswer(qd, req, toolName))`，唯一生产调用点）；测试 `tests/question-core.test.ts:341-343`（calculus 钉子）等。

---

**E2. `dismissedAnswer`**

**①** `export function dismissedAnswer(kind: QuestionKind, questionText: string): QuestionAnswerData` — `:768-777` **[纯函数*]**（answeredAt 读时钟）

**②** 输入：题型 + 题干；输出：**最小诚实答案**（`:762-767` doc）：`{kind, questionText, dontKnow: false, answers: [], dismissed: true, answeredAt}`。

**③** 单字面量返回；无选择、无判分、无置信度。

**④** ESC 丢弃（所有者 2026-10-02）走**同一条答案路径**：模型经 compactAnswerForModel 只见 `{kind, dismissed:true}`；已答题卡渲染题干 + "skipped"（`answered-card.tsx:28-34`）；教师在下一回合承认跳过，与任何答案一样。回合中丢弃还会杀掉运行中回合并走丢弃暂存（`chat.tsx:406-411` 注释：2026-10-04 GLM 循环裁定）。

**⑤** 调用方：`components/chat.tsx:417`（ESC 处理，readingThinking 可在 `:418-422` 并入，合并点 `:420`）；下游 `session-core.dismissQuestion`（`components/session-core.ts:856`）→ dismiss 输入事件 → `dismissAppends`（`src/core/input-events.ts:141-157`，kind 必须匹配 `toolQuestionKind`，`:153-155`）。

---

**E3. `compactAnswerForModel` —— 模型可见的答案记录（tool-result diet）**

**①** `export function compactAnswerForModel(ad: QuestionAnswerData): Record<string, unknown>` — `:779-802` **[纯函数]**

**②** 输入：完整答案记录；输出：**只含学习者新增信息**的紧凑 JSON 对象。不变量（`:753-761` doc，所有者 2026-10-02）：工具调用已携带模型自己写的一切（题目、每个选项、正确答案、解释、explain 承诺），结果**只回**他的选择或文字、判定、自报置信度、思考。完整 QuestionAnswerData 走 details 供记录与 UI；本函数产出才是 agent 实际读的 JSON。

**③** 逐步：
1. `:780` dismissed → `{kind, dismissed: true}`（最小诚实）。
2. `:781-782` out={kind}；dontKnow 为真才写 `dontKnow: true`。
3. `:783-786` **Array.isArray 守卫**：缝会收到 unknown answers（测试夹具、外来记录）——降级为省略、绝不崩溃；非空才写 `answers: [{index, label}]`（**不含 value**——值是模型写的，调用里已有）。
4. `:787-788` text/other 非空才写。
5. `:789-792` `correct !== undefined && !dontKnow` 才写 correct——dontKnow 隐含不正确、且不带置信度，两者都保持隐式（注释：判定与置信度是学习者的**表现**，模型下一步需要的新信息）。
6. `:793` confidence 存在即写。
7. `:794-799` **两条思考通道明确键控**（所有者 2026-10-03，模型绝不可混淆）：`thinking = ad.thinking ?? ad.note`（改名前键回放，旧记录同路）→ `out.thinking`；
8. `:800` readingThinking → **`out.thinkingWhileReading`**（独立键）。

**④** diet 的动机是 token：复述模型自著内容曾使每个答案的 token 翻倍（`native-messages.ts:201-205` 注释）。dontKnow 时 correct/confidence 双隐式，避免模型把"不知道"读成"答错且置信度 0"。Array.isArray 守卫是 parse-don't-cast 精神在输出侧的延伸——尽管输出侧原则上可信（我们自己写的），外来记录回放仍须防御。

**⑤** 调用方：`src/core/native-messages.ts:216`（`newAnswerResult` 的 content JSON；details 在 `:219` 携带完整记录）；测试 `tests/chat-flow.test.ts` 等。

---

**E4. `toClientQuestion`（旧架构遗留）**

**①** `export function toClientQuestion(qd: QuestionData): ClientQuestion` — `:688-697` **[纯函数]**

**②** 输入 QuestionData，输出 ClientQuestion：逐字段拷贝 id/kind/question/context/mode/options，**刻意省略** correctIndices/committedAnswer/explanation（`:474` doc）。

**③** 单字面量投影，无分支。

**④** 历史层：这是旧架构（server 持有题目、经 bridge 下发客户端）的防泄漏投影。原生记录架构下原始调用参数本就随 SSE 事件流到达浏览器，本函数**无生产调用方**（全仓 grep 仅测试），防泄漏由渲染层执行（§3.1）。保留它是契约完整性与测试钉子。

**⑤** 调用方：`tests/question-core.test.ts:36`（import）、`:596`（断言答案字段被省略）。生产代码零调用。

### 3.4 轻量私有辅助函数归并表（100% 覆盖）

| 辅助 | 行号 | 用途 | 调用点／状态 |
|---|---|---|---|
| `quizOptionProps`（私有 schema 常量） | `:39-46` | quiz 选项属性：label 裸断言 + 可选 value；**无 description**（2026-09-26 泄漏裁定） | `quizInputBase.options`（`:163`）；被 askOptionProps 展开 |
| `askOptionProps`（私有 schema 常量） | `:50-55` | quizOptionProps + description（ask 不判分，无正确性可泄漏） | `askInputSchema.options`（`:378`） |
| `optionProblems`（私有函数） | `:85-103` | quiz+ask 共享选项 sanity；返回 problems + 解析键（五要素见 §3.3-A2） | `:107`、`:117` |
| `predictCheckType`（私有 schema 常量） | `:242-248` | predict/check 字面量联合，两个 teach 出题工具逐字共享；description 强调 bare word | `quizInputObject.type`（`:257`）、`explainInputObject.type`（`:327`） |
| `clean`（coerceCorrectAnswer 内闭包） | `:635-638` | 精确键优先、非匹配才剥残渣（calculus 防线） | `:639`、`:646`、`:651` |
| `formatOptionRef`（私有函数） | `:699-702` | 把 1-based 索引格式化为 `"N. label"`（未命中给 "(unknown)"） | **死代码**：全仓（src/tests）无任何调用点——旧模型可读答案格式的残余，被 compactAnswerForModel 的 diet 取代 |

（导出侧的轻量函数 `emptyDockSelection`/`toggleOption`/`toggleOther`/`isCorrect`/`askOptionProblems`/`explainInputProblems`/`normalizeQuizType`/`toClientQuestion` 已在 §3.3 各有五要素条目，不重复列表。）

---

## 4. `src/core/tool-parts.ts` — 显示侧解析缝："parse, don't cast"（129 行）

### 4.1 模块定位与纯度边界

头注释（`:1-28`）是本项目最重要的消费纪律之一，诞生于 **2026-09-12 线上崩溃**：

- **为什么存在**：校验确实**先**发生在模型-facing 边界——pi 在 execute 前用工具的 TypeBox schema 校验参数，出题精炼在 execute 缝跑，失败以 error tool result 同回合退回模型。但同一份字节还有两个消费者，它们**按设计**拿到的是未校验数据：
  1. SSE 事件流在模型还在写调用时就推送原始 tool-input 增量（校验不可能先于调用完成运行，`:11-12`）；
  2. 持久化记录连**被拒绝调用**的原始输入也保留（记录诚实 + 回放不变量：每个 toolCall 后必有 result，`:13-14`）。
- 所以无效输入永远可观察，part **状态**携带判定（input-streaming = 部分、input-available = 已校验、output-error = 垃圾，`:16-18`）。当年崩溃的缺陷：消费者用 **TypeScript cast** 信任这些形状——`part.input as X` 是编译器相信的**编译期谎言**，背后没有任何运行时检查（`:18-20`）。
- **法则（机械的，不靠警惕）**：模型-authored 的 INPUT 只准经这些解析器消费，每个解析器跑模型面对的**同一个 TypeBox schema**——boundary-valid ⇔ consumer-parseable，**结构性地**成立（`:22-24`）。server 与学习者-authored 的 OUTPUT 保持可信（我们自己写的：execute ack、学习者的 buildAnswer）。解析失败渲染安静兜底，**绝不崩溃**（`:26-27`）。

import：`typebox/value`、`typebox`（type-only）、question-core、argument-heal、contracts/probe（`:30-34`）。浏览器安全，桶导出 `index.ts:55`。全模块纯函数（`boundaryParse` 的 `structuredClone` 只动克隆，`Value.Convert` 的原地修改被隔离在克隆上）。

### 4.2 `boundaryParse`（私有核心）五要素精讲

**①** `function boundaryParse<T>(schema: TSchema, input: unknown): T | undefined` — `:45-51` **[纯函数]**

**②** 输入：schema + 原始 input；输出：Clean 后的类型化对象或 undefined。不变量：**与 pi 边界逐字同序**（Convert → Check → Clean）；不修改输入（先克隆）；非对象输入直接 undefined。

**③** 逐步：`:46` 非对象或 null → undefined；`:47` `converted = structuredClone(input)`；`:48` `Value.Convert(schema, converted)`（原地修改克隆）；`:49` `Value.Check` 失败 → undefined；`:50` `Value.Clean(schema, converted) as T`（剥掉 schema 不认识的键）。

**④** **live-smoke 修复（2026-09-26）**是本函数的出生证明（`:36-44` doc）：pi-ai 的 `validateToolArguments` 在 Check 之前跑 `Value.Convert`——live smoke 的模型实际发出**数字** `correctAnswer: 17`，边界 Convert 成 `"17"`，题目正常提出。但持久化记录保留 RAW 参数（17），读侧若跳过 Convert 就会拒掉边界刚接受的输入——**invisible pending quiz + 学习者锁死**。所以每个显示解析先 Convert，恰如边界；Convert 是原地修改，故先克隆。Clean 的剥键行为是 zod 时代 strip 的延续（`:58-59` doc）：teacher-only 的 `nodeId` 是未知键被剥掉，显示形状保持 dock 一贯所见。

**⑤** 调用方：`parseQuizInput`（`:84`）、`parseAskInput`（`:97`）、`parseExplainInput`（`:110`）、`parseProbeDoneInput`（`:129`）。

### 4.3 五个显示侧解析函数五要素精讲

---

**4.3.1 `parseQuizInput`**

**①** `export function parseQuizInput(input: unknown): QuizToolInput | undefined` — `:72-88` **[纯函数]**

**②** 输入：持久化 quiz/probe 调用的原始参数；输出：显示可用的 QuizToolInput 或 undefined。不变量：**宽松共同核心**——prober 边界（quizInputBase）与 teacher 边界（quizInputObject）共享同一 base 字段，任何过了任一边界的输入这里都能解析（`:54-62` doc）；严格的 per-agent 出题检查是边界的职责；但**共享判分精炼必须镜像**（`:62-67`）。形状解析**绝不修复 authored 文本**（`:69-71` doc）：dock 从这份源拷贝构建答案数据；恢复只属于 presentation（ToolContentResponse），绝不属于选项身份、判分或快照。

**③** 逐步（与边界全链同序）：
1. `:83` `healedInput = healEncodedArguments(input, quizDisplayInputSchema)`——**边界 heal 的显示镜像**（whitehead 2026-10-09，注释 `:78-82`）：记录存 RAW 参数，记录里的 `type: "\"predict\""` 抖动必须在这里也修，否则已提出的 quiz 渲染为不可见（tool-parts 法则）。
2. `:84` `boundaryParse(quizDisplayInputSchema, healedInput)`——Convert → Check → Clean。
3. `:85` 失败 → undefined。
4. `:86` `quizInputProblems(cleaned).length > 0` → undefined——镜像边界的精炼：pi 结构上接受 `correctAnswer: 17`（Convert → "17"），execute 的精炼才决定提出或拒绝；显示解析同序跟进，使**绝不可能被提出的输入**（如 `correctAnswer: undefined` 被 Convert 宽化成 ""）渲染为安静兜底而非坏 quiz（`:62-67` doc）。
5. `:87` 返回 cleaned。

**④** type 字段用显示 schema 的**可选 plain string**（2026-10-03，注释 `:73-77`）：新 teach 记录带 predict|check，dock 经 normalizeQuizType 在读缝归一；旧记录与 probe 记录无 type；nodeId 保持被 Clean 剥掉。probe 调用按同一 schema 解析（base 字段全同，type 可选缺省）。

**⑤** 调用方：`components/question-dock.tsx:135`（dock 解析 gate）、`components/answered-card.tsx:47`（details 重读）、`src/core/answer-presentation.ts:10`（历史回显）；测试 `tests/tool-parts.test.ts:54-130`（边界 parity 钉子、字符串 options 读侧修复、数字 correctAnswer 锁死修复）。

---

**4.3.2 `parseAskInput`**

**①** `export function parseAskInput(input: unknown): AskToolInput | undefined` — `:96-101` **[纯函数]**

**②** 输入：ask 调用原始参数；输出：AskToolInput 或 undefined。不变量：完整 ask schema（options 可选——自由文本模式就是无选项形状）+ 边界同款选项 sanity（`:90-95` doc）。

**③** `:97` heal + boundaryParse 一行链；`:98` 失败 → undefined；`:99` `askOptionProblems(cleaned.options ?? [])` 非空 → undefined（重复值破坏 dock 键控，与旧 zod 缝同样解析为 undefined）；`:100` 返回。

**④** 自由文本模式 options 缺省 → `?? []` 空数组过 sanity。字符串编码 options 经 heal 数组分支 + parseOptionsIfString 双通道（边界 prepareQuestionArguments 先修，读侧 heal 镜像）。

**⑤** 调用方：`components/question-dock.tsx:135`、`components/answered-card.tsx:46`、`src/core/answer-presentation.ts:12`；测试 `tests/tool-parts.test.ts:132-141`。

---

**4.3.3 `parseExplainInput`**

**①** `export function parseExplainInput(input: unknown): ExplainToolInput | undefined` — `:109-114` **[纯函数]**

**②** 输入：explain/recall 调用原始参数；输出：ExplainToolInput 或 undefined。不变量：显示 schema（base + 可选宽松 type，恰是 quiz 模式——teach explain 自 2026-10-09 携带角色）；承诺精炼镜像边界链；两个 explain 变体共享字段，teacher 的 nodeId 被 Clean 剥掉（`:103-108` doc）。

**③** `:110` heal + boundaryParse（explainDisplayInputSchema）；`:111` 失败 → undefined；`:112` `explainInputProblems(cleaned)` 非空 → undefined；`:113` 返回。

**④** probe 阶段的旧记录可能叫 `explain`（改名前），新记录叫 `recall`——显示缝两者都接受（`parseQuestionInput` 分派，`tools.ts:240-247` 注释）。承诺空串/全空白 → 精炼拒绝 → 安静兜底。

**⑤** 调用方：`components/question-dock.tsx:135`、`src/core/answer-presentation.ts:11`；测试 `tests/tool-parts.test.ts`。

---

**4.3.4 `parseQuestionInput`**

**①** `export function parseQuestionInput(tool: string, input: unknown): QuizToolInput | AskToolInput | ExplainToolInput | undefined` — `:118-125` **[纯函数]**

**②** 输入：工具名 + 原始参数；输出：按题型解析的结果或 undefined。不变量（`:116-117` doc）：**一个显示有效性判定**，供 dock 权威与恢复共用；不修改记录输入、不发明缺失的出题字段。

**③** switch（`:119-124`）：`quiz`/`probe` → parseQuizInput；`explain`/`recall` → parseExplainInput；`ask_user_question` → parseAskInput；default → undefined。**probe/recall 折叠到 teach 孪生题型**——与 `pending.ts:64-66` 的 `toolQuestionKind` 同一折叠纪律。

**④** 这是原生记录状态机的解析入口：`questionCallsOf` 用它区分 answerable 与 malformed（`native-messages.ts:734`）——stopReason 为 length、或 argumentsError、或解析失败 → malformed；error/aborted → failed；pending → streaming。malformed 问题不释放输入框（背景唤醒也必须等学习者显式动作，`native-messages.ts:744-745` 注释）。

**⑤** 调用方：`src/core/native-messages.ts:734`（questionCallsOf）；测试 `tests/malformed-question-recovery.test.ts`。

---

**4.3.5 `parseProbeDoneInput`**

**①** `export function parseProbeDoneInput(input: unknown): ProbeDoneInput | undefined` — `:128-130` **[纯函数]**

**②** 输入：probe_done 调用原始参数；输出：ProbeDoneInput 或 undefined。schema 是 core 拥有的 `probeDoneInputSchema`（`src/core/contracts/probe.ts:47`）——工具自己声明的同一份（`:127` doc）。

**③** 一行：`boundaryParse(probeDoneInputSchema, input)`。**注意：无 heal 前置**——probe_done 的抖动防线在边界 healToolRecord（探测者注册表 `tools.ts:317`），读侧此处只做 Convert/Check/Clean；若未来出现读侧锁死事故，按 tool-parts 法则应补 heal 镜像（现状取证如此，不作推测性改动）。

**④** 测试钉子（`tests/tool-parts.test.ts:143-167`）：合法评估解析；边界 parity；**线上崩溃形状——评估被字符串化——不解析**；流中部分（尚无 strands）不解析。

**⑤** 调用方：`components/artifacts/probe-done-card.tsx:34`（probe_done 卡片渲染 gate）。

### 4.4 轻量私有辅助函数归并表（100% 覆盖）

| 辅助 | 行号 | 用途 | 调用点 |
|---|---|---|---|
| `boundaryParse<T>`（私有泛型） | `:45-51` | pi 边界解析步的镜像：clone → Convert → Check → Clean（五要素见 §4.2） | `:84`、`:97`、`:110`、`:129` |

本文件无其他私有辅助；五个导出解析器全部在 §4.3 有五要素条目。

---

## 5. `src/core/answer-presentation.ts` — 历史已答题卡的只读出处投影（57 行）

### 5.1 模块定位与纯度边界

头注释（`:1-3`）一句话定纲：**历史问题卡片的只读出处（provenance）。绝不持久化这个投影**：答案身份、顺序、判分、学习者文字保持记录事实；**只有模型-authored 的显示文本来自调用**。

import：question-core（normalizeOptions + 类型）、tool-parts（三个解析器）、math-delims（repairMathForDisplay）（`:4-6`）。浏览器安全，桶导出 `index.ts:56`。全纯：不读时钟、不做 IO、不修改输入（展开拷贝）。它是 §0.2 对称性的最后一环——**读侧解析通道在历史回显处的第三次复用**（dock 挂载、状态判定之后）。

### 5.2 `answerForPresentation` 五要素精讲

**①** `export function answerForPresentation(answer: QuestionAnswerData, input: unknown): QuestionAnswerData` — `:8-57` **[纯函数]**

**②** 输入：持久化的答案快照 + 原始调用参数（unknown）；输出：显示用答案投影。不变量（铁律）：
- **只刷新四类模型-authored 文本**：questionText、quiz explanation、explain committed、选项 label；
- **绝不触碰**：answers（含 value/index）、correct、correctIndices、confidence、thinking/readingThinking、other/text、dontKnow、dismissed、answeredAt、选项 **index 与顺序**；
- 解析失败 → 原样返回旧答案（旧卡片渲染与从前完全一致）；
- 歧义 → 保留快照，**绝不猜**；
- 投影永不写回存储（`:1-2`）。

**③** 核心逻辑与分支逐步推导：

1. **dismissed 短路**（`:9`）：丢弃卡只显示题干 + skipped，无选项无解释，原样返回。
2. **按 kind 解析原始调用**（`:10-12`）：quiz → parseQuizInput；explain → parseExplainInput；`source = quiz ?? explain ?? (kind === "ask" ? parseAskInput(input) : undefined)`。三种 kind 各走自己的解析器（同一条 heal + Convert + Check + Clean + 精炼通道）。
3. **解析失败兜底**（`:13`）：!source → 返回原 answer。历史记录里被拒调用的脏参数、旧格式参数都在这里安静降级。
4. **文本刷新**（`:14-16`）：`projected = {...answer, questionText: source.question}`；quiz → `projected.explanation = quiz.explanation`；explain → `projected.committed = explain.correctAnswer`。题干与解释从此以**调用原文**为准（答案快照里的旧文本被刷新），数学修复由渲染层 ToolContentResponse 执行。
5. **选项守卫**（`:17`）：答案无选项快照、或 source 无 options 键、或 source.options 为空 → 返回 projected（文本已刷新，选项不动）。ask 自由文本模式走此路。
6. **取原始顺序选项**（`:19-20`）：`original = normalizeOptions(source.options)`——**洗牌前**的模型书写顺序，值已归一；`saved = answer.options`——答案里的 `{index,label}` 快照（**无 value**，见 §3.2.6）。问题本质：saved 行是洗牌后的显示顺序，original 是原始顺序，要刷新 label 就必须建立 **saved 位置 → original 位置** 的绑定，且不能重算洗牌（toolCallId 种子虽在，但重算洗牌属于"重判分"禁区——值身份才是稳定锚）。
7. **绑定机构**（`:21-22`）：`bindings: Map<number,number>`（saved→original）+ `used: Set<number>`（已占用的 original 位置）。
8. **`bindUnique(candidates)` 闭包**（`:23-35`）：对每个未绑定的 saved 行 si：取 `candidates[si]` 中未被 used 的候选；**候选数 ≠ 1 → 跳过**（零候选=无证据，多候选=歧义）；唯一候选 oi 还要过**交叉歧义 guard**（`:29-31`）：若存在另一未绑定行 sj 的候选也含 oi → 跳过——"两个 saved 行声称同一 source 是歧义，即使每行各自只有一个候选"（注释原文转述）；通过才 `bindings.set(si, oi)` + `used.add(oi)`。
9. **第一遍：值身份绑定**（`:36-41`）：对每个 saved 行，收集 `answer.answers` 中 index 等于该行 index 的 **value**（学习者选中的答案携带稳定值身份），候选 = original 中 value 命中的位置。**注释铁律**（`:36-37`）：选中答案的值是稳定身份——**绝不归一这些值、绝不重算洗牌、绝不重判分**。只有被选中的行有值证据；未选中行留给第二遍。
10. **第二遍：标签双匹配**（`:42-44`）：`recoveredLabels = original.map(o => repairMathForDisplay(o.label))`（math-delims.ts:119-121，纯显示修复：文档布局恢复 + 数学转义恢复 + 过度转义命令修复）；候选 = original 中 `label === saved.label` **或** `recoveredLabels[oi] === saved.label` 的位置。双匹配的原因：旧快照的 label 可能已是数学修复后的文本（渲染层写入），必须同时认原文与修复文。
11. **双射补全**（`:45-51`）：若 `saved.length === original.length` 且 `bindings.size === saved.length - 1`——等长且恰剩一对未绑定——则剩下的 saved 行与剩下的 original 位置**必然互相对应**（双射无排序歧义，注释 `:45-46`），直接绑定。多行未绑定时**保留快照不猜**。
12. **投影输出**（`:52-55`）：`projected.options = saved.map((option, si) => { const oi = bindings.get(si); return oi === undefined ? option : {...option, label: original[oi]!.label}; })`——**index 保持 saved 的**（显示顺序即历史事实），只换 label；未绑定行原样保留。`:56` 返回 projected。

**④** 边界条件与历史背景：
- **重复标签**：normalizeOptions 按 **value** 去重，label 可以合法重复（两个选项同文案不同值）。此时第二遍对未选中行给出多候选 → bindUnique 跳过；若恰剩一对则双射补全仍安全。交叉歧义 guard 防止"两行各自唯一候选却指向同一 source"的错误绑定。
- **calculus 句点**（2026-10-12）：值身份绑定不做任何残渣剥离，`"$f$ … at $a$."` 的句点原样保留；标签匹配是**全等**比较，不 trim 不剥残渣。
- **数学修复的不对称**：original 侧算 recoveredLabels 用于**匹配**，但写回 projected 的是 `original[oi].label` **原文**（`:54`）——修复属于渲染层（ToolContentResponse），投影不预修复，与"形状解析绝不修复 authored 文本"（tool-parts.ts:69-71）同一纪律。
- **details 与 ask 描述不走本函数**：answered-card 另行 parseAskInput/parseQuizInput 取 details 与 option.description（`answered-card.tsx:46-48`，所有者 2026-10-12）——本函数只管答案快照里已有的字段。
- 测试钉子：`tests/tool-content-presentation.test.tsx`（answerForPresentation 的投影与歧义行为）。

**⑤** 真实上游调用方：`components/answered-card.tsx:25`（`const answer = answerForPresentation(savedAnswer, input)`，卡片第一行）；挂载点 `components/chat.tsx:1603`（output-available part → AnsweredCard，input 即原始调用参数）。

### 5.3 轻量私有辅助函数归并表（100% 覆盖）

| 辅助 | 行号 | 用途 | 调用点 |
|---|---|---|---|
| `bindUnique(candidates)`（闭包） | `:23-35` | 唯一候选绑定 + 交叉歧义 guard + used 占用标记；两遍绑定共用 | `:38`（值身份遍）、`:43`（标签遍） |

本文件无其他辅助；`recoveredLabels`（`:42`）是中间常量而非函数。

---

## 6. 卷末对照矩阵

### 6.1 执行侧 vs 读侧：同一条通道的两次执行

| 通道步骤 | 执行侧（agent 调用边界） | 读侧（显示解析） | 共享纯函数 |
|---|---|---|---|
| options 字符串解包 | `prepareQuestionArguments`（tools.ts:67-77） | `normalizeOptions`（question-core.ts:565） | `parseOptionsIfString` |
| 通用参数修复（heal） | `withArgumentHeal`（heal.ts:34-41），TypeBox 校验前 | `parseQuizInput`/`parseAskInput`/`parseExplainInput` 首步（tool-parts.ts:83/97/110） | `healEncodedArguments` |
| 结构强制 | pi `validateToolArguments`：Convert → Check | `boundaryParse`：clone → Convert → Check → Clean（tool-parts.ts:45-51） | TypeBox Value API |
| 跨字段出题精炼 | execute 顶部（tools.ts:91/213/232/257/384；teacher-agent.ts:334） | 解析末步（tool-parts.ts:86/99/112） | `quizInputProblems` / `askOptionProblems` / `explainInputProblems` |
| 成员值残渣剥离 | `quizInputProblems` → `coerceCorrectAnswer`（question-core.ts:121→637） | `normalizeQuizType`（:219）；判分 `resolveCorrect` → `coerceCorrectAnswer`（:662→637） | `stripModelValueDebris` |
| 失败语义 | `invalidInputResult` isError → 出题重试（同回合） | undefined → `MalformedQuestion` 安静兜底 / 旧卡片原样 | — |

**对称性的根**：持久化保留修复前原始字节（tools.ts:63-64、tool-parts.ts:41-44）；修复幂等、良构同引用通过（argument-heal.ts:23-24、heal.ts:20-22），故读侧重放是无害第二遍；任何一侧缺席都会造成"边界接受、读侧拒绝"的 invisible pending quiz 与学习者锁死（argument-heal.ts:4-13、tool-parts.ts:36-44）。

### 6.2 测试锚点索引（本卷机制的事故钉子）

| 测试文件 | 钉住的机制 |
|---|---|
| `tests/question-core.test.ts` | schema 契约与 quizInputProblems（:78-156）；coerceCorrectAnswer 精确键优先（:252-274）；**calculus 句点全链路**（:314-345：边界→显示→洗牌→判分，且断言原始参数永不被改写）；isCorrect（:399+）；toClientQuestion 省略答案（:596） |
| `tests/tool-parts.test.ts` | 2026-09-12 崩溃形状与边界 parity（:4-8、:67-76）；字符串 options 读侧修复（:77）；数字 correctAnswer 锁死修复（:91）；probe_done 字符串化崩溃形状（:156） |
| `tests/tool-heal.test.ts` | **whitehead 事故**（:1-21）：标准 heal 全覆盖、成员值残渣剥离三处、显示镜像（:130-132、:188） |
| `tests/practice-heal.test.ts` | **GLM 19 次拒调**（:1-15）：端到端驱动 pi-ai validateToolArguments，修复后通过、原始被拒 |
| `tests/tool-content-presentation.test.tsx` | answerForPresentation 投影与歧义回退 |
| `tests/question-tools.test.ts` | nodeId 动态校验（:92）、probe 无 nodeId（:186）、prepareQuestionArguments 字符串 options（:325）、explain/recall 变体（:360、:415）、工具描述只带机制（:436） |
| `tests/malformed-question-recovery.test.ts`、`tests/pending-question-form.test.tsx`、`tests/dock-state-key.test.ts` | malformed 兜底、dock 表单与草稿键 |

### 6.3 全导出清单与生产调用方速查（零遗漏核对表）

| 导出 | 文件:行 | 生产调用方（path:line） |
|---|---|---|
| `stripModelValueDebris` | value-debris:24 | question-core:219、:637；chains:74、:79 |
| `healEncodedArguments` | argument-heal:58 | heal.ts:38；tool-parts:83、:97、:110；practice:112、:210；submit-agent:96 |
| `parseOptionsIfString` | question-core:63 | tools.ts:71；question-core:565 |
| `askOptionProblems` | question-core:106 | tools.ts:91；tool-parts:99 |
| `quizInputProblems` | question-core:112 | tools.ts:213、:384；teacher-agent:334；tool-parts:86 |
| `quizInputBase` | question-core:158 | 经 probeQuizInputSchema（tools.ts:209）；quizInputObject/quizDisplayInputSchema 展开 |
| `QUIZ_QUESTION_TYPES` / `QuizQuestionType` | question-core:209-210 | :210 类型派生；接口字段 :419、:447（无独立运行时消费点） |
| `normalizeQuizType` | question-core:217 | question-dock:150、:298；question-core:234 |
| `questionNeedsReveal` | question-core:232 | chat.tsx:518 |
| `quizInputObject` | question-core:256 | tools.ts:380；teacher-agent:331；Static :394 |
| `probeQuizInputSchema` | question-core:277 | tools.ts:209 |
| `quizDisplayInputSchema` | question-core:286 | tool-parts:83、:84 |
| `explainInputBase` | question-core:303 | tools.ts:253；explainInputObject/explainDisplayInputSchema 展开；Static :397 |
| `explainInputObject` | question-core:326 | tools.ts:228；Static :396 |
| `explainDisplayInputSchema` | question-core:345 | tool-parts:110 |
| `explainInputProblems` | question-core:352 | tools.ts:232、:257；tool-parts:112 |
| `QUIZ_TOOL_NAMES` | question-core:362 | **无消费点**（契约词表预留；现行闸门词表是 pending.ts:53 QUESTION_TOOLS） |
| `quizInputSchema` | question-core:365 | 仅测试（tool-parts.test:22；question-core.test:25） |
| `askInputSchema` | question-core:367 | tools.ts:87；tool-parts:97；Static :395 |
| `CONFIDENCE_STOPS` / `DEFAULT_CONFIDENCE_INDEX` | question-core:500-501 | question-dock:340、:402、:536、:786-829；confidence-rail:36 |
| `emptyDockSelection` | question-core:512 | question-dock:325 |
| `toggleOption` / `toggleOther` | question-core:535 / :551 | question-dock:371 / :423、:707 |
| `normalizeOptions` | question-core:558 | question-dock:289；answer-presentation:19 |
| `seededRandom` | question-core:588 | question-dock:292；layout:611 |
| `shuffleOptions` | question-core:610 | question-dock:292 |
| `coerceCorrectAnswer` | question-core:631 | question-core:121、:662（内部共享）；测试直接驱动 |
| `resolveCorrect` | question-core:657 | question-dock:306 |
| `isCorrect` | question-core:679 | question-core:737（buildAnswer） |
| `toClientQuestion` | question-core:688 | 仅测试（question-core.test:596；旧架构遗留） |
| `buildAnswer` | question-core:708 | question-dock:413 |
| `dismissedAnswer` | question-core:768 | chat.tsx:417 |
| `compactAnswerForModel` | question-core:779 | native-messages:216 |
| `parseQuizInput` | tool-parts:72 | question-dock:135；answered-card:47；answer-presentation:10 |
| `parseAskInput` | tool-parts:96 | question-dock:135；answered-card:46；answer-presentation:12 |
| `parseExplainInput` | tool-parts:109 | question-dock:135；answer-presentation:11 |
| `parseQuestionInput` | tool-parts:118 | native-messages:734 |
| `parseProbeDoneInput` | tool-parts:128 | probe-done-card:34 |
| `answerForPresentation` | answer-presentation:8 | answered-card:25 |

（类型导出 QuizOption/OptionAnswer/QuestionKind/SelectMode/QuestionMode/QuestionData/QuestionAnswerData/ClientQuestion/AnswerRequest/DockSelection/QuestionFormDraft/QuestionDraft/QuizToolInput/AskToolInput/ExplainToolInput/ProbeExplainToolInput 的消费点见 §3.2 各接口条目与 §0.1 数据流；私有辅助 100% 清单见各文件归并表：§1.3、§2.4、§3.4、§4.4、§5.3。）

---

**全卷完。** 五个文件 1,110 行逐行覆盖；全部导出函数与核心内部算法均有五要素条目，全部私有辅助均有归并表行号；事故背景（2026-09-12 崩溃、GLM 19 次拒调、whitehead `":parmenides"`、calculus 句点）均落实到源码注释与测试钉子出处。