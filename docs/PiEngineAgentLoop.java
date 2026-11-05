package com.learnharness.agent.engine;

import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;

/**
 * ====================================================================================================
 * PiEngine Agent Loop 核心架构与自主闭环 (Java 伪代码大纲)
 * 
 * 对应真实源码位置：
 * 1. HTTP 门禁与生命周期: src/server/chat-handler.ts, src/server/turn-runs.ts, src/server/turn-liveness.ts
 * 2. 内存事件总线与压实: src/server/pi/ui-stream.ts, src/server/pi/call-ids.ts
 * 3. 教学智能体与问答门禁: src/agent/teacher-agent.ts, src/agent/tool-execute.ts
 * 4. 底层自主推进循环: @earendil-works/pi-agent-core/dist/agent-loop.js
 * 
 * 【特别说明】
 * 本代码为概念阐释性质的 Java 伪代码，语法上融合了 async/await 语义以保持事件驱动与异步推进的简洁性，
 * 旨在通过 Java 的类型体系和面向对象模式，1:1 精确还原系统在 Node.js 内存中的执行闭环。
 * ====================================================================================================
 */

// ====================================================================================================
// 第一部分：领域模型与数据契约 (Domain Models & Message Contracts)
// ====================================================================================================

/**
 * 智能体原生消息模型 (AgentMessage)
 * 对应: @earendil-works/pi-agent-core 的 AgentMessage
 */
class AgentMessage {
    String id;                          // 全局唯一消息 ID (如 uuid)
    String role;                        // "system" | "user" | "assistant" | "toolResult"
    List<ContentPart> content;          // 消息内容分块 (文本、ToolCall 等)
    String stopReason;                  // 终止原因: "stop" | "tool_use" | "error" | "aborted" | "length"
    Usage usage;                        // 消耗的 Token 统计
    long timestamp;

    public AgentMessage(String role, List<ContentPart> content) {
        this.id = UUID.randomUUID().toString();
        this.role = role;
        this.content = content != null ? content : new ArrayList<>();
        this.timestamp = System.currentTimeMillis();
    }
}

interface ContentPart {}

class TextPart implements ContentPart {
    String text;
    public TextPart(String text) { this.text = text; }
}

class ToolCallPart implements ContentPart {
    String id;                          // 本次工具调用的唯一 ID (如 call_987xyz)
    String name;                        // 工具名称 (如 read, search, quiz, ask_user_question)
    Map<String, Object> arguments;      // 模型生成的调用实参
}

class ToolResult {
    List<ContentPart> content;          // 工具执行输出内容
    boolean isError;                    // 是否执行失败或入参校验失败
    boolean terminate;                  // 【关键特殊标志】: 是否强制要求自主循环到此终止 (如出题后等待答题)
    Object details;

    public ToolResult(List<ContentPart> content, boolean isError, boolean terminate) {
        this.content = content;
        this.isError = isError;
        this.terminate = terminate;
    }
}

class ToolResultMessage extends AgentMessage {
    String toolCallId;
    String toolName;
    boolean isError;

    public ToolResultMessage(String toolCallId, String toolName, ToolResult result) {
        super("toolResult", result.content);
        this.toolCallId = toolCallId;
        this.toolName = toolName;
        this.isError = result.isError;
    }
}

class Usage {
    int inputTokens;
    int outputTokens;
    int reasoningTokens;
}

/**
 * SSE 广播给前端的实时事件模型 (AgentEvent)
 */
class AgentEvent {
    String type;                        // "agent_start" | "message_update" | "tool_execution_start" | ...
    String toolCallId;
    String toolName;
    AgentMessage message;
    ToolResult result;
    Map<String, Object> extra;
}


// ====================================================================================================
// 第二部分：HTTP 调度与生命周期管理 (ChatHandler & TurnRunsRegistry)
// 对应源码: src/server/chat-handler.ts, src/server/turn-runs.ts
// ====================================================================================================

class ChatHandler {
    private ChatStore chatStore;
    private TurnRunsRegistry turnRunsRegistry;
    private TurnLiveness turnLiveness;

    /**
     * POST /api/chat 处理入口
     *
     * 【关键技术点 1：Connection Diet B (连接节食)】
     * 传统的全双工 HTTP 长轮询或单请求长流会霸占浏览器的 HTTP/1.1 连接池（同域通常限 6 个连接）。
     * 此处收到 POST 请求、完成防并发校验与预写落盘后，立即启动后台内存循环，并瞬间向客户端响应 200 OK！
     * 随后客户端再通过独立的 GET /api/chats/{id}/stream 端点挂载 SSE 进行视口监听 (View)。
     * 核心逻辑与 HTTP 连接完全解耦，客户端断连也不会掐断服务端正在进行的思考和工具调用。
     */
    public async HttpResponse handleChatRequest(HttpRequest req) {
        ChatInput input = parseChatInput(req.getBody());
        String chatId = input.getChatId();
        ChatRecord record = chatStore.getChat(chatId);
        if (record == null) return HttpResponse.status(404).json("Unknown chat");

        // [门禁 1]: 409 单会话并发锁 (Single-Flight Guard via turn-liveness.ts)
        // 保证同一个会话在同一时刻只能有一个智能体 Turn 在推进，防止并发竞争破坏会话树
        if (!turnLiveness.beginTurn(chatId)) {
            return HttpResponse.status(409).json("A turn is already running for this session");
        }

        // [门禁 2]: 预写式持久化 (Write-Ahead Persistence, WAL)
        // 规则：用户输入的学生答案/提问，在进入智能体循环之前必须先完成持久化落库！
        // 确保无论后端进程在此刻崩溃还是发生网络闪断，用户输入都不会遗失。
        List<AgentMessage> mergedMessages = new ArrayList<>(record.getMessages());
        List<AgentMessage> inputAppends = input.toNativeMessages();
        mergedMessages.addAll(inputAppends);
        chatStore.saveMessages(chatId, mergedMessages);

        // [智能体工厂装配]: 动态装配 Teacher 或 Practice 智能体
        TeachingAgent agent = AgentFactory.createTeachingAgent(record, mergedMessages);

        // [拉起后台 Turn 运行对象]: 将整个 Agent Loop 作为独立后台对象托管在内存中
        int persistBaseCount = mergedMessages.size(); // 记录基线，Turn 结算时只持久化新增的增量切片
        PiTurnHandle handle = PiTurnRunner.runPiTurn(new PiTurnSpec(
            chatId,
            agent,
            // 事务结算回调 (Settle Seam)
            (finalMessages, isAborted) -> {
                // 1. 抽取本轮新增的消息进行增量持久化落库
                List<AgentMessage> newMessages = finalMessages.subList(persistBaseCount, finalMessages.size());
                chatStore.persistTurn(chatId, newMessages, isAborted);
                // 2. 释放 409 会话锁，从内存活跃注册表中注销
                turnLiveness.endTurn(chatId);
                turnRunsRegistry.unregisterTurn(chatId);
                // 3. 结算触发后台轻量会话压缩 (Kick Compaction)
                CompactionService.kickCompactionAsync(chatId);
            }
        ));

        // 注册到内存注册中心 (供客户端重连挂载与远程 Abort 中断)
        turnRunsRegistry.registerTurn(chatId, handle);

        // 立即返回 200 OK，释放 POST HTTP Socket 连接！
        return HttpResponse.status(200).json(Map.of("ok", true));
    }

    /**
     * GET /api/chats/{id}/stream
     * 客户端用于挂载/重新挂载 (Reattach) 的 SSE 端点
     */
    public HttpResponse streamEvents(String chatId) {
        PiTurnHandle handle = turnRunsRegistry.runningTurn(chatId);
        if (handle == null) {
            // 如果请求时当前 Turn 已经运行完毕，返回纯事件终态帧，引导前端直接从 DB 获取最终数据
            return HttpResponse.sse("data: {\"type\":\"turn-settled\"}\n\ndata: [DONE]\n\n");
        }
        // 挂载新的观察者视口 (Subscriber View)
        return HttpResponse.sse(handle.subscribe());
    }
}

/**
 * 全局运行态 Turn 注册表 (对应 globalThis.__lhTurnRuns)
 */
class TurnRunsRegistry {
    // 跨 Next.js 模块隔离的单例注册中心
    private static final Map<String, PiTurnHandle> RUNS = new ConcurrentHashMap<>();

    public void registerTurn(String chatId, PiTurnHandle handle) { RUNS.put(chatId, handle); }
    public void unregisterTurn(String chatId) { RUNS.remove(chatId); }
    public PiTurnHandle runningTurn(String chatId) { return RUNS.get(chatId); }

    /**
     * 远程中断接口 (POST /api/activity/abort)
     */
    public boolean abortTurn(String chatId) {
        PiTurnHandle handle = RUNS.get(chatId);
        if (handle == null) return false;
        handle.abort();
        return true;
    }
}


// ====================================================================================================
// 第三部分：后台 Turn 运行时与事件广播总线 (PiTurnRunner & PiTurnHandle)
// 对应源码: src/server/pi/ui-stream.ts, src/server/pi/call-ids.ts
// ====================================================================================================

class PiTurnRunner {
    public static PiTurnHandle runPiTurn(PiTurnSpec spec) {
        PiTurnHandle handle = new PiTurnHandle(spec);

        // 关键：在 Node.js 微任务队列 / 异步上下文启动，不阻塞主线程
        asyncRunBackground(() -> {
            try {
                // 进入核心自主推进循环（持续在内存递归推进，直到文本产出或问答题截断）
                await spec.agent.continueLoop();
            } catch (Exception err) {
                handle.handleError(err);
            } finally {
                handle.settle();
            }
        });

        return handle;
    }
}

class PiTurnHandle {
    private final PiTurnSpec spec;
    private final Set<SseSubscriber> subscribers = new CopyOnWriteArraySet<>();
    private boolean settled = false;
    private boolean sawAbort = false;

    /**
     * 【关键技术点 2：The Compaction Law (事件日志内存压实律)】
     * 如果将大模型流式输出的每个 Delta Chunk 毫无节制地保存在内存日志中，
     * 当遇到数十万 Token 的深度思考（High Reasoning）模型时，会产生数百兆的内存消耗，
     * 并且在前端重连重放时引发 CPU 阻塞死锁（Navigation Freeze）。
     * 
     * 策略：
     * 内存 Log 中，已完结的消息（如 user, toolResult, 结算的 assistant）原样追加；
     * 而流式生成中的 assistant 文本更新，则在 updateSlots 中执行【原地替换 (Replace-in-place)】！
     * 保证无论流式产生多少万个 Chunk，内存日志的大小始终等于最终文本体积，复杂度为 O(1)。
     */
    private final List<AgentEvent> compactedLog = new ArrayList<>();
    private final Map<String, Integer> updateSlots = new ConcurrentHashMap<>();

    /**
     * 【关键技术点 3：The Lacan Fix (工具 ID 重铸去重)】
     * 部分大模型提供商（如 DeepSeek）在多轮推理循环中，每一轮都会将工具调用的 ID 重置为 "call_0"！
     * 这会导致工具结果回填时出现 ID 碰撞覆盖。
     * 此处在进入广播总线和消息体之前，由 ToolCallIdUniquifier 进行全局内存去重与重铸，保证 ID 全局唯一。
     */
    private ToolCallIdUniquifier uniquifier = new ToolCallIdUniquifier();

    public PiTurnHandle(PiTurnSpec spec) {
        this.spec = spec;
        // 绑定底层的 Agent 订阅事件
        this.spec.agent.subscribe(event -> this.onAgentEvent(event));
    }

    private void onAgentEvent(AgentEvent rawEvent) {
        if (settled) return;
        AgentEvent event = uniquifier.uniquify(rawEvent);

        if ("message_update".equals(event.type)) {
            // 原地替换正在流式生成的草稿槽位
            Integer slot = updateSlots.get("message");
            if (slot != null) {
                compactedLog.set(slot, event);
            } else {
                updateSlots.put("message", compactedLog.size());
                compactedLog.add(event);
            }
        } else {
            if ("message_end".equals(event.type)) {
                updateSlots.remove("message");
            }
            compactedLog.add(event);
        }

        // 扇出广播给所有前端订阅端点 (SSE View)
        for (SseSubscriber sub : subscribers) {
            sub.send(event);
        }

        if ("agent_end".equals(event.type)) {
            settle();
        }
    }

    public synchronized void settle() {
        if (settled) return;
        settled = true;
        // 剥离临时的 System Prompt 消息（不落盘污染持久层）
        List<AgentMessage> finalMessages = spec.agent.getMessagesWithoutSystemPrompt();
        // 触发持久化落盘与结算
        spec.onFinish.accept(finalMessages, sawAbort);
        // 向所有前端视口广播 [DONE]
        for (SseSubscriber sub : subscribers) {
            sub.complete();
        }
        subscribers.clear();
    }

    public void abort() {
        this.sawAbort = true;
        this.spec.agent.abort();
    }
}


// ====================================================================================================
// 第四部分：智能体核心自主循环状态机 (PiAgentLoop)
// 对应源码: @earendil-works/pi-agent-core/dist/agent-loop.js
// ====================================================================================================

class PiAgentLoop {
    private AgentContext context;
    private AgentConfig config;
    private LLMClient llmClient; // 负责发起唯一的网络出站 HTTPS 请求
    private AbortSignal signal;

    /**
     * 【关键技术点 4：PiEngine 自主多轮闭环 (The Autonomous Loop)】
     * 整个循环在 Node.js 内存进程中纯本地自动递归推进！
     * 循环期间：【没有任何内部 HTTP 接口调用】。所有的工具均以本地普通函数执行。
     * 唯一的网络通信只有向大模型厂商 (Anthropic/OpenAI/DeepSeek) 发起的外网流式调用。
     */
    public async void continueLoop() {
        emitEvent("agent_start");
        emitEvent("turn_start");

        boolean hasMoreToolCalls = true;
        List<AgentMessage> pendingSteering = config.getSteeringMessages(); // 注入中途插队消息

        // ==================== 核心自主循环状态机 ====================
        while (hasMoreToolCalls || !pendingSteering.isEmpty()) {
            
            // 1. 处理插队的引导消息 (User Steering)
            for (AgentMessage steer : pendingSteering) {
                context.appendMessage(steer);
                emitEvent("message_start", steer);
                emitEvent("message_end", steer);
            }
            pendingSteering.clear();

            // 2. 格式化上下文并转换成 LLM 供应商格式 (convertToLlm)
            // 剥离应用层私有字段，展平系统提示词
            LlmPayload payload = config.convertToLlm(context.getMessages());

            // 3. 向大模型发起推理调用 (唯一的外部网络调用)
            emitEvent("turn_start");
            AgentMessage assistantMessage = await streamLlmCall(payload);
            context.appendMessage(assistantMessage);

            // 若模型被用户主动 Abort 或因网络/配置故障报错，提前中断
            if ("error".equals(assistantMessage.stopReason) || "aborted".equals(assistantMessage.stopReason)) {
                break;
            }

            // 4. 解析本次模型响应中是否包含工具调用 (ToolCalls)
            List<ToolCallPart> toolCalls = assistantMessage.extractToolCalls();
            List<ToolResultMessage> toolResults = new ArrayList<>();
            hasMoreToolCalls = false;

            if (!toolCalls.isEmpty()) {
                // ==============================================================
                // 本地执行工具 (Local Tools Dispatch - 零内部 HTTP)
                // ==============================================================
                for (ToolCallPart toolCall : toolCalls) {
                    emitEvent("tool_execution_start", toolCall);

                    // 在当前 Node.js 进程内直接通过本地函数/服务执行
                    // 例如：查知识库、读文件、修改教学计划等
                    ToolResult result = await executeToolLocally(toolCall);

                    emitEvent("tool_execution_end", toolCall, result);

                    // 将工具结果打包为 ToolResult 消息直接塞入内存上下文
                    ToolResultMessage resultMessage = new ToolResultMessage(toolCall.id, toolCall.name, result);
                    toolResults.add(resultMessage);
                    context.appendMessage(resultMessage);
                }

                // 判断本批次工具是否全部带有 terminate: true 标记
                boolean batchTerminated = toolResults.stream()
                        .allMatch(r -> r.content != null && r.isError == false && isToolTerminated(r));

                // 若没有终止，说明还需要把结果喂给模型进入下一轮推理
                hasMoreToolCalls = !batchTerminated;
            }

            // ==============================================================
            // 【关键技术点 5：双重门禁问答题截断 (Belt-and-suspenders Stopper)】
            // ==============================================================
            // 策略 hook：finishTurn 拦截器 (由 TeacherAgentConfig 提供)
            // 解决问题：如果模型在同一条回复中既执行了普通工具（如 search），又发起了出题工具（quiz/problem），
            // 此时必须在出题成功后【强制终止】循环，将控制权交还给前端学生答题，不能让智能体继续自说自话！
            FinishDecision decision = config.finishTurn(assistantMessage, toolResults);
            
            if (decision == FinishDecision.END) {
                // 命中问答门禁，立即退出当前自主循环！
                break;
            }

            // 检查是否有排队的后续消息
            pendingSteering = config.getSteeringMessages();
        }

        // 整个自主循环正式结束，发出 agent_end 触发持久化落盘结算
        emitEvent("agent_end");
    }

    /**
     * 本地工具调度 (Local Tools Invocation)
     */
    private async ToolResult executeToolLocally(ToolCallPart toolCall) {
        AgentTool tool = config.getToolRegistry().get(toolCall.name);
        if (tool == null) {
            return new ToolResult(List.of(new TextPart("Unknown tool: " + toolCall.name)), true, false);
        }

        try {
            // 参数 Schema 校验
            tool.validateArgs(toolCall.arguments);
            // 本地执行 (纯内部代码调用，读本地文件、查本地 SQLite/JSON Store 等)
            return await tool.execute(toolCall.id, toolCall.arguments, signal);
        } catch (IllegalArgumentException valErr) {
            // 【关键特殊点】：若出题工具因参数校验失败报错，isError=true 且 terminate=false
            // 它不会导致循环终止，而是作为一条错误结果喂回给模型，模型会在下一个 micro-turn 自动重试纠错！
            return new ToolResult(List.of(new TextPart("Invalid arguments: " + valErr.getMessage())), true, false);
        } catch (Exception ex) {
            return new ToolResult(List.of(new TextPart("Execution failed: " + ex.getMessage())), true, false);
        }
    }
}


// ====================================================================================================
// 第五部分：教学智能体配置与问答截断策略 (TeacherAgent & Stopper)
// 对应源码: src/agent/teacher-agent.ts, src/agent/tool-execute.ts
// ====================================================================================================

class TeacherAgentConfig {
    // 问答类工具名清单
    private static final Set<String> QUESTION_TOOLS = Set.of(
        "quiz",
        "ask_user_question",
        "pose_practice_problem"
    );

    /**
     * 截断决策器 (Question Stopper)
     */
    public static FinishDecision finishTurnHook(AgentMessage assistantMessage, List<ToolResultMessage> toolResults) {
        // 提取本次 Assistant 消息中调用的所有问答类工具 Call ID
        Set<String> questionCallIds = new HashSet<>();
        for (ContentPart part : assistantMessage.content) {
            if (part instanceof ToolCallPart) {
                ToolCallPart tc = (ToolCallPart) part;
                if (QUESTION_TOOLS.contains(tc.name)) {
                    questionCallIds.add(tc.id);
                }
            }
        }

        // 如果本轮压根没有发起提问/出题，继续遵循默认调度 (若是普通工具则循环，若纯文本则结束)
        if (questionCallIds.isEmpty()) {
            return FinishDecision.CONTINUE_NORMAL;
        }

        // 【防御性容错验证】：检查是否有出题工具报错
        // 只有当所有的问答工具都执行成功 (无校验错误) 时，才予以截断！
        // 若出题参数非法（如漏了选项），让智能体原地重试重新出题
        for (ToolResultMessage result : toolResults) {
            if (questionCallIds.contains(result.toolCallId) && result.isError) {
                // 出题失败，不终止循环，让模型根据报错重新调用出题工具
                return FinishDecision.CONTINUE_NORMAL;
            }
        }

        // 成功向学生提出了问题/题目 -> 强制终止内存循环，释放 409 锁，进入静候状态！
        return FinishDecision.END;
    }

    /**
     * 问答工具的合成占位结果 (Synthetic Tool Result)
     * 对应: src/agent/tool-execute.ts 中的 questionResult()
     */
    public static ToolResult createQuestionToolResult() {
        return new ToolResult(
            List.of(new TextPart("Question posed — the turn ends here; awaiting learner answer.")),
            false,  // isError = false
            true    // terminate = true (通知 PiEngine 工具批次结束)
        );
    }
}

enum FinishDecision {
    CONTINUE_NORMAL,
    END
}

