import type { Usage } from "@earendil-works/pi-ai";
import {
	createPracticeAgent,
	createProberAgent,
	createTeacherAgent,
	type AgentBuildOptions,
	type TeachingAgent,
} from "../agent/teacher-agent.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { createJobRunner } from "../agent/subagents/runner.ts";
import { createExtractionPipeline } from "../agent/subagents/extraction.ts";
import type { ModelRole } from "../../config.ts";
import {
	deliverJobResult,
	noteSteerVisible,
	reconcileUserSteers,
	registerLiveAgent,
	setJobRespawn,
	setTurnRunner,
	settleSteers,
	steerLiveChat,
	unregisterLiveAgent,
} from "./jobs.ts";
import { runPiTurn } from "./pi/ui-stream.ts";
import { collectToolCallIds } from "./pi/call-ids.ts";
import { providerEventNote } from "../agent/provider-events.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { searchAvailable, searchProvider } from "./search.ts";
import { providerKeyPresent } from "./keys.ts";
import {
	extractionEnabled,
	graphToolsEnabled,
	resolveConversationSpec,
	resolveRoleSpec,
} from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope, type ProviderKeyMissing } from "../core/settings.ts";
import { beginTurn, endTurn } from "./turn-liveness.ts";
import { applyParkedDismissal } from "./dismissal-park.ts";
import { registerTurn, unregisterTurn } from "./turn-runs.ts";
import { persistTurn, triggerExtraction } from "./turn-service.ts";
import { hasProbeDone, danglingQuestionOf } from "../core/native-messages.ts";
import { composeInstructions } from "../agent/teacher-agent.ts";
import { ensureCompacted, kickCompaction, effectiveThresholdTokens } from "./compaction.ts";
import { catalogContextLimits } from "./model-catalog.ts";
import { emit } from "../core/events.ts";
import { settledTurnResponse } from "./turn-runs.ts";
import { asAgentMessages } from "../core/native-messages.ts";
import {
	ChatInputError,
	inputAppends,
	parseChatInput,
	type TurnInput,
} from "../core/input-events.ts";
import { steerDelivered } from "../core/contracts.ts";
import type {CallUsage, SteerMessage} from "../core/contracts.ts";

/**
 * 基于服务器拥有的原生记录的单个聊天回合（One chat turn）。无框架依赖（纯
 * Request/Response），因此测试可以使用脚本伪造引擎直接驱动它 — app/api/chat
 * 中的 Next 路由处理程序只是一个单行包装器。
 *
 * 输入事件契约（THE INPUT-EVENTS CONTRACT，Wave B，owner ruling 2026-09-26）：POST /api/chat
 * 携带 {chatId, input} — 一个明确的事件（文本 / 回答 / 裁决 / 继续），从不是客户端转录。
 * 服务器拥有该记录；此模块是 回合组合根（TURN COMPOSITION ROOT）：它将事件转换为原生
 * 记录追加（core/input-events.ts），从记录构建代理（记录即是代理状态（agent state） —
 * state.messages = record.messages，continue()），并作为后台对象运行该回合（pi/ui-stream.ts）。
 * 唤醒管道（Wake-pipeline）操控（steers）运行在同一个组合上（TurnInput 的 steer 种类）。
 *
 * 相同的组合（THE SAME COMPOSITION）服务于两个入口点：客户端请求和唤醒管道的
 * 服务器端操控（src/server/jobs.ts）— 为预写持久化（write-ahead persistence）、回合活跃度（turn liveness）
 * 和回合服务提供单一代码路径。
 */

const jobRunner = createJobRunner({
	chatStore: stores.chatStore,
	jobStore: stores.jobStore,
	deliver: deliverJobResult,
	// BYOK (owner, 2026-09-22): job engines resolve the chain — role
	// override → slot → NOTHING — read FRESH per job (a settings PUT
	// between dispatch and spawn lands); an empty chain flows through as
	// undefined and the runner refuses the spawn honestly.
	engineFor: (role) =>
		resolveEngine(role),
	// Key-presence gate (provider-key interlude, 2026-09-25): the runner
	// reads the resolved engine's provider and asks THIS check (the agent
	// layer may not read the key store); a missing key refuses the spawn
	// with the 503-envelope family instead of dying mid-run.
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
	// Search port wave (2026-09-20): the researcher's web_search runs on the
	// injected port — resolved FRESH per job (key rotations land immediately).
	// null = honestly unavailable; the dispatch-level drop (below) uses the
	// same signal so keyless servers never see the research tool at all.
	searchProvider,
});
/**
 * 应用程序的唯一提取管道（extraction pipeline）实例 — 两个前门共享它：
 * 测验触发的会话运行（turn-service）和笔记导入（/api/graph/import）命中同一个单一飞行注册表（single-flight registry）。
 */
export const extraction = createExtractionPipeline({
	...stores,
	// BYOK (owner, 2026-09-22): the extraction stages resolve the chain —
	// role override → slot → NOTHING — read FRESH per stage call; an empty
	// chain flows through as undefined and the pipeline refuses the run
	// with the typed ModelsNotConfiguredError. Direct test values still win.
	engineFor: (role) =>
		resolveEngine(role),
	// Key-presence gate (provider-key interlude, 2026-09-25): same check
	// the job runner gets — a stage engine whose provider key is gone
	// refuses BEFORE any batch runs (the typed throw), never mid-run.
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
});


// 唤醒管道连线（Wake-pipeline wiring，contracts.ts "THE ASYNC PROTOCOL" §4）：管道
// 通过此组合根交付其操控（steers）（一个事件：操控标记（steer marker），在回合声明下原生追加），
// 并且崩溃恢复（crash recovery）通过此运行器重新生成（re-spawns）孤立的子代理（sub-agent）循环。
setTurnRunner(async (chatId, input) => {
	const res = await handleChatInput(chatId, input);
	// Drive the stream to completion server-side — nobody else will read it,
	// and onFinish (persist, extraction, endTurn) only runs when it drains.
	await res.arrayBuffer().catch(() => undefined);
	return res.status;
});
/**
 * 为一个角色（role）解析设置的引擎 — BYOK (owner, 2026-09-22)：
 * 链（角色覆盖（role override） → 槽位（slot） → NOTHING）可能以空结束，undefined
 * 流经按需拒绝门控（per-need refusal gates，runner/extraction），每次 FRESH 读取，
 * 使得调度（dispatch）和生成（spawn）之间的设置 PUT 得以生效。
 */
function resolveEngine(role: ModelRole): PiEngine | undefined {
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	return spec ? piEngineForSpec(spec) : undefined;
}

setJobRespawn((jobId) => void jobRunner.runJob(jobId));

/**
 * 面向路由的入口：解析 {chatId, input} 并运行一个回合。
 * 处理针对特定聊天会话的 HTTP 请求入口（POST /api/chat）。
 * @param req 传入的 HTTP 请求对象，预期包含要提交的聊天内容或交互类型。
 * @param buildAgent 能够用来构建 AI Agent 的选项工厂函数，一般仅测试使用。
 * @returns 包含操作结果的响应对象（例如成功状态、或验证/权限错误）。
 */
export async function handleChatRequest(
	req: Request,
	buildAgent?: (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent,
): Promise<Response> {
	let body: { chatId?: unknown; input?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const chatId = typeof body.chatId === "string" ? body.chatId : "";
	if (!chatId) return Response.json({ error: "Unknown chat" }, { status: 404 });
	let input: TurnInput;
	try {
		input = parseChatInput(body.input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}
	return handleChatInput(chatId, input, buildAgent);
}

/**
 * 回合组合（turn composition）：一个输入事件 → 原生记录追加 → 一个
 * 作为后台对象的代理回合（agent turn）。也是唤醒管道（wake pipeline）的入口
 * （TurnInput 的 steer 种类在相同声明下追加标记）。
 *
 * 处理解析后的聊天输入，更新对话上下文，并触发 AI 代理回合。此方法是单次对话回合构建核心。
 * 将单一的输入事件转换为原生的对话记录添加，然后在后台作为独立对象运行 Agent 回合。
 * 这也是后台作业(Wake pipeline)调度的入口。
 * @param chatId 对话会话的唯一标识符。
 * @param input 解析并验证后的输入负载（例如用户发言、后台操控 steer 标记等）。
 * @param buildAgent 能够用来构建 AI Agent 的选项工厂函数，一般仅测试使用。
 * @returns 若正常启动则返回代表成功的 Response，或者若遇并发冲突或未配置模型时返回对应错误响应。
 */
export async function handleChatInput(
	chatId: string,
	input: TurnInput,
	buildAgent?: (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent,
): Promise<Response> {
	let record = stores.chatStore.getChat(chatId);
	if (!record) {
		return Response.json({ error: "Unknown chat" }, { status: 404 });
	}

	// THE UNIVERSAL TURN GATE (BYOK, owner, 2026-09-22): a turn needs the
	// CONVERSATION chain — the chat's own model override over the strong
	// slot — and there is no factory floor; when both are empty the turn
	// refuses honestly with the machine-readable 503 envelope (new sessions
	// and continuing ones alike — wake-pipeline turns ride this same path).
	// Placement is deliberate: BEFORE beginTurn (no liveness effects), the
	// write-ahead persist (nothing durable changes), and every downstream
	// resolution (jobs/extraction gate per-need on their own tiers).
	const effective = effectiveSettings();
	const conversation = resolveConversationSpec(record.settings, effective.models.strong);
	if (!conversation) {
		const envelope = modelsNotConfigured(["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	// THE KEY-PRESENCE GATE (provider-key interlude, owner, 2026-09-25): a
	// pinned model is not enough — its PROVIDER's key must be present, or
	// the turn dies mid-stream masked to a generic error. Truth is env-first
	// (providerKeyPresent reads what pi-ai would read at request time), so
	// an env-shadowed key passes. Same placement discipline as the models
	// gate: BEFORE beginTurn (no liveness effects) and the write-ahead
	// persist (nothing durable changes); wake-pipeline turns ride the same
	// path. The affected tier is strong — the conversation chain's own tier
	// (a chat.model override still resolves through it).
	if (!providerKeyPresent(conversation.provider)) {
		const envelope = providerKeyMissingEnvelope(conversation.provider, ["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	// THE COMPACTION GATE (owner round 14, 2026-10-05 — the structural
	// ruling: NOTHING model-facing for this chat interleaves with a
	// running compaction): await any in-flight compaction (the settle
	// kick usually finished inside the learner's answer pause), and if
	// the record is STILL over threshold, compact synchronously — this
	// request waits. Skipped under tests (the extraction precedent);
	// placement mirrors the BYOK/key gates — BEFORE appends and
	// beginTurn, no liveness effects — and the record re-reads after
	// because compaction appends the marker.
	const conversationEngine = piEngineForSpec(conversation);
	const modelIdForCompaction = `${conversationEngine.model.provider}:${conversationEngine.model.id}`;
	await ensureCompacted(
		{
			chatStore: stores.chatStore,
			engine: conversationEngine,
			modelId: modelIdForCompaction,
			kind: record.kind === "practice" ? "practice" : hasProbeDone(record.messages) ? "teach" : "probe",
			thresholdTokens: effectiveThresholdTokens(
				effective.compaction?.thresholdTokens,
				catalogContextLimits().get(modelIdForCompaction),
			),
			systemPromptTokens: Math.ceil(composeInstructions(record.kind === "practice" ? "practice" : "teacher").length / 4),
		},
		chatId,
	);
	const compactedRecord = stores.chatStore.getChat(chatId);
	if (compactedRecord) record = compactedRecord;

	// The input's native appends (pure; the honest 400 for an answer with no
	// pending question call). Computed BEFORE beginTurn so a refused input
	// leaves no liveness effects; read against the CURRENT record. Wave C:
	// the idle wake carries EVERY queued marker (steerDelivered filters a
	// re-fire of an already-landed one) - with claimSteers gone, this wake
	// input is the only steer appender; in-run delivery rides pi's own
	// follow-up queue and never builds an input event at all.
	let appends;
	try {
		appends =
			input.type === "steers"
				? input.steers.filter((s) => !steerDelivered(record.messages, s.id))
				: inputAppends(record, input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}

	// THE PARALLEL-QUESTION GATE (owner, 2026-10-03 — the deepseek parallel
	// batch incident): an answer that leaves a SIBLING question dangling
	// defers its wake. The dock advances to the next question (the client's
	// optimistic result + record-changed carry the view); the LAST answer
	// fires the one reaction turn with every result ADJACENT to its calling
	// assistant message — the provider shape law (a tool result appended
	// after an intervening assistant message is rejected, which stranded
	// the sibling question permanently pre-fix). Nothing else can generate
	// while a question dangles (job wakes wait, continuation folds refuse,
	// the composer gates), so adjacency holds by construction.
	if (input.type === "answer" && danglingQuestionOf([...record.messages, ...appends]) !== null) {
		const merged = [...record.messages, ...appends];
		stores.chatStore.saveMessages(chatId, merged);
		emit("record-changed", { chatId });
		return settledTurnResponse(); // the cheap terminal — no beginTurn, no turn
	}

	// One turn per chat, ever. A second request while a turn runs means a
	// stale/remounted client raced a live one — letting it through would
	// double-run the teacher and clobber the first turn's persist.
	if (!beginTurn(chatId)) {
		console.info(`[chat ${chatId}] turn already in flight — request rejected`);
		return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
	}

	// Write-ahead persistence: the input's native appends go on disk BEFORE
	// the turn starts - the learner's answer is durable the instant the
	// request arrives, and any remount, second tab, or server crash reads
	// truth instead of the pre-answer record. (Wave C: the wake's markers
	// ride this same write-ahead - the pump de-queued them at fire, so this
	// is the ONLY copy ever appended.)
	const merged = [...record.messages, ...appends];
	try {
		stores.chatStore.saveMessages(chatId, merged);
		// Dock fix (owner ruling 2026-09-26): persisted markers are visible
		// in the record — flip their jobs now (the wake's steers ride this
		// write-ahead; the delivering turn may run for minutes).
		for (const appended of appends) {
			if ((appended as { role?: string }).role === "custom") noteSteerVisible(appended as SteerMessage);
		}
	} catch (err) {
		console.error(`[chat ${chatId}] write-ahead persist failed:`, err);
	}

	// MONEY CHANNEL (wave 4): one collector per request, fed by the agent's
	// message_end events. Every model call's usage lands in the chat record's
	// append-only turns log at onFinish — idempotent per turn id.
	const turnUsageId = crypto.randomUUID();
	const steps: CallUsage[] = [];
	const collectUsage = (usage: Usage) => {
		steps.push({
			inputTokens: usage.input,
			outputTokens: usage.output,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			// Optional in pi's Usage — persisted as 0, never dropped.
			reasoningTokens: usage.reasoning ?? 0,
		});
	};

	// AGENT CONSTRUCTION BRANCH (docs/probe-teach-split.md §2): the transcript
	// is the seam — a probe_done call in the record means the probe is
	// concluded: build the TEACHER (planning + the full toolset). Otherwise
	// the session is still probing: build the PROBER (quiz/ask + probe_done).
	// Both share this whole composition (write-ahead persist, liveness,
	// steers, usage, extraction) — only the agent differs.
	const teaching = hasProbeDone(merged);
	// BYOK (owner, 2026-09-22): the conversation chain was resolved by the
	// turn gate above (chat.model override → strong slot → refused) — the
	// engine build is pure from here; thinking levels clamp natively.
	// (Built once above the compaction gate; reused verbatim.)
	const engine = conversationEngine;
	// Provider-qualified stamp (model slots wave): matches the price table's
	// provider:id keys.
	const modelId = `${engine.model.provider}:${engine.model.id}`;
	// Tests inject a factory: the agent is stateless per turn, so each
	// request builds a fresh one off the record — the factory mirrors that
	// seam exactly. Wave B: the record IS the agent state (native messages;
	// the record's id field strips at the wire in toLlmMessages).
	// CROSS-STREAM SEAM (P2 reconciliation, 2026-09-19): `toolToggles`
	// rides the build opts as the user-level DELTA map (absent key =
	// enabled). The definitive toggleable set is TOGGLEABLE_TOOLS — the
	// sub-agent JOB tools (research/demo/visual/pdf; adjudicated with the
	// user: quiz/ask/fs/plan/probe_done are always-on).
	const agentOpts: AgentBuildOptions = {
		engine,
		messages: asAgentMessages(merged),
		onUsage: collectUsage,
		toolToggles: effective.agent.tools,
		// Debug (owner, 2026-10-04): teacher/prober raw provider events under
		// LH_PROVIDER_EVENTS=1 (provider-events.ts); no-op otherwise.
		chatId,
		// The prompt-override switches (P2, 2026-09-19): same resolution
		// point as the tool delta — the agent layer composes the system
		// prompt fresh per turn, swapping in any enabled override segments.
		promptSwitches: effective.agent.prompts,
	};
	// PRACTICE BRANCH (owner design, 2026-10-04): a kind:"practice"
	// session builds the practitioner from turn 1 — no prober→teacher
	// split, no plan/question/job tools; the whole registry is
	// problem + conclude. buildAgent stays honored (the test seam is
	// uniform across kinds).
	const constructed: TeachingAgent = buildAgent
		? buildAgent({ ...agentOpts, teaching })
		: record.kind === "practice"
			? createPracticeAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						// TARGET VALIDATION (owner round 9): the practice tools read the
						// WHOLE graph fresh per pose — targets validate against every
						// proposition, not just the session's picks (pickless sessions
						// and future graph-tools poses stay valid).
						graphNodes: () => stores.graphStore.readNodes(),
						// THE RARELY-NEEDED SET (owner round 10): research + pdf jobs
						// (same runner/gating as the teacher's — research honestly
						// absent when no engine is live) and the map readers behind
						// the SAME settings gate as the prober's.
						jobs: {
							chatId,
							jobStore: stores.jobStore,
							spawn: (job, input) => void jobRunner.runJob(job.id, input),
							searchAvailable,
						},
						...(graphToolsEnabled(effective) ? { graph: { chatStore: stores.chatStore, graphStore: stores.graphStore } } : {}),
					},
					agentOpts,
				)
			: teaching
			? createTeacherAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						jobStore: stores.jobStore,
						spawn: (job, input) => void jobRunner.runJob(job.id, input),
						// The registry drop's signal (2026-09-20): no live engine
						// = no research tool in the teacher's registry.
						searchAvailable,
					},
					agentOpts,
				)
			: createProberAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						deliver: (steer) => void deliverJobResult(steer),
						// Fix wave (2026-09-20): the prober carries research + pdf
						// dispatch (owner ruling — phase-omnipresent), so its ctx
						// needs the same job wiring as the teacher's.
						jobStore: stores.jobStore,
						spawn: (job, input) => void jobRunner.runJob(job.id, input),
						searchAvailable,
						// The map reader (wave 7): the prober reads the learner's
						// knowledge graph through tools when the gate opens —
						// graph master switch AND the agent.graphTools toggle.
						...(graphToolsEnabled(effective) ? { graphStore: stores.graphStore } : {}),
					},
					agentOpts,
				);

	// A test-injected agent gets no usage collector (tests assert the
	// transcript, not the money channel); when it's ours, usage flows through
	// the factory's subscription (wired above via onUsage).
	try {
		// THE TURN AS A BACKGROUND OBJECT (owner ruling, 2026-09-25):
		// runPiTurn executes decoupled from this response — the POST stream
		// is just the FIRST subscriber (a view). A client disconnect can no
		// longer abort the turn; the remote kill is the abort channel, and
		// late views reattach via GET /api/chats/[id]/stream.
		// Wave C (owner correction, 2026-09-26 — steering): register the live
		// agent BEFORE runPiTurn — the loop's start steering-poll drains the
		// queue SYNCHRONOUSLY inside that call, so a later registration would
		// miss it. Registration also steers any pending registry markers into
		// this run: a marker parked behind a just-answered quiz rides THIS
		// run's first LLM call (the native replacement for continuation
		// coalescing). Settlement still cannot beat the flow below: it needs
		// a streamed response, which never happens inside the constructor.
		registerLiveAgent(chatId, constructed);
		// Debug recorder run marker (owner, 2026-10-04): correlates the
		// JSONL event stream with the record's turns; no-op unless
		// LH_PROVIDER_EVENTS=1.
		providerEventNote(chatId, "turn", `run start (base: ${merged.length} messages)`);
		const handle = runPiTurn({
			agent: constructed,
			// The coalescing window seam (COMPACTION LAW, 2026-10-09): tests
			// tighten it via LH_UPDATE_FLUSH_MS; production rides the 100ms
			// default in ui-stream.
			...(process.env.LH_UPDATE_FLUSH_MS ? { updateFlushMs: Number(process.env.LH_UPDATE_FLUSH_MS) } : {}),
			// THE LACAN FIX (2026-10-04): seed the uniquifier with every
			// tool-call id the record already holds — a provider that resets
			// ids per response (DeepSeek) then gets fresh unique ids for this
			// turn's calls at the wire boundary, on the wire, in the record,
			// and in the next turn's context alike.
			usedToolCallIds: new Set(collectToolCallIds(merged)),
			// Stream-level failures are provider/transport internals — masked,
			// like the SDK defaults. Tool-input validation messages never
			// route through here: they ride the error-result path and reach the
			// transcript directly (the retry context the model saw).
			onError: (error) => {
				console.error(`[chat ${chatId}] turn error:`, error);
				return "An error occurred.";
			},
			onFinish: (turnMessages, isAborted) => {
				// Wave B: the record write is the agent's own final state —
				// the new messages are the slice past the merged base.
				const stamped = persistTurn(stores.chatStore, chatId, merged.length, turnMessages, isAborted);
				// usage log append (idempotent per turn id) — the stats bar
				// refolds this on the client after the turn settles. The
				// provenance message is the turn's FIRST new assistant message.
				const response = stamped.find((m) => (m as { role?: string }).role === "assistant");
				if (response && steps.length > 0) {
					stores.chatStore.appendTurnUsage(chatId, {
						id: turnUsageId,
						messageId: response.id,
						at: new Date().toISOString(),
						model: modelId,
						steps,
					});
				}
				// GRAPH GATE (settings-storage wave, 2026-09-19): the write channel —
				// extraction, its auditor — dies with the master switch.
				// PRACTICE (owner, 2026-10-04): practice sessions write nothing —
				// no extraction, no graph, no coverage (v1: the session itself
				// is the deliverable).
				if (record.kind !== "practice" && extractionEnabled(effective.graph)) {
					// Fresh per-turn read of the graph section's chunk budget
					// (extraction-UX redesign, 2026-09-24): the trigger compares
					// against it and the pipeline's batches share it.
					triggerExtraction(stores, extraction, chatId, effective.graph.extractionChunkTokens);
				}
				// PARKED DISMISSAL (owner, 2026-10-04): a dismissal that arrived
				// mid-turn was parked by the dismiss route (202); now that
				// persistTurn has landed the turn's messages, apply it against
				// real truth — BEFORE endTurn, so "turn-settled" guarantees a
				// subsequent fetch reads the dismissal already in the record
				// (the same ordering law as persistTurn itself).
				applyParkedDismissal(stores.chatStore, chatId);
				// LAST: a poller that sees not-in-flight must read an already-persisted
				// record — endTurn only after persistTurn has done its job.
				endTurn(chatId);
				// And only then does the turn stop being a running object
				// (background-turn wave, 2026-09-25): a reattach that finds
				// nothing must find the persisted record current — the same
				// ordering rule as endTurn.
				unregisterTurn(chatId);
				// Wave C steer settlement: the live agent is dead (no more
				// followUp handoffs) - reconcile the steer registry against
				// what this run actually persisted (in-run injections
				// resolve; stranded markers return to pending), then let
				// the pump take any stragglers down the idle wake.
				unregisterLiveAgent(chatId);
				settleSteers(chatId, stamped);
				// Composer steers (2026-10-03): delivered ids dropped, stranded
				// ones stay parked for the chat's next run (the registry is the
				// stranding safety net — the agent's undrained copy died above).
				reconcileUserSteers(chatId, stamped);
				// THE SETTLE KICK (owner round 14): the turn settled — if the
				// projection is now over threshold, the summary starts in the
				// background, INSIDE the learner's reading/answering pause
				// (question/problem poses end runs, so this moment is always a
				// between-runs window). The next turn's ensureCompacted gate
				// awaits whatever this leaves running; a lost engine or a
				// beneath-threshold record is a silent no-op. Skipped under
				// tests (the extraction precedent — scripted chats are
				// fixtures; the service itself is pinned directly).
				if (process.env.NODE_ENV !== "test")
					kickCompaction(() => {
						const fresh = effectiveSettings();
						const spec = resolveConversationSpec(stores.chatStore.getChat(chatId)?.settings, fresh.models.strong);
						if (!spec) return null;
						const kickEngine = piEngineForSpec(spec);
						const kickModelId = `${kickEngine.model.provider}:${kickEngine.model.id}`;
						const freshRecord = stores.chatStore.getChat(chatId);
						if (!freshRecord) return null;
						return {
							chatStore: stores.chatStore,
							engine: kickEngine,
							modelId: kickModelId,
							kind: freshRecord.kind === "practice" ? "practice" : hasProbeDone(freshRecord.messages) ? "teach" : "probe",
							thresholdTokens: effectiveThresholdTokens(
								fresh.compaction?.thresholdTokens,
								catalogContextLimits().get(kickModelId),
							),
							systemPromptTokens: Math.ceil(composeInstructions(freshRecord.kind === "practice" ? "practice" : "teacher").length / 4),
						};
					}, chatId);
			},
		});
		// The turn is now a live background object: register it so any view
		// can reattach (GET /api/chats/[id]/stream) or remotely abort it
		// (POST /api/activity/abort, kind "turn"). Registration after the
		// runPiTurn call is race-free: the agent loop only ticks in later
		// microtasks, so settle (and thus unregister) cannot beat us here.
		registerTurn(chatId, handle);
		// CONNECTION DIET B (owner, 2026-10-10 — the parallel-session freeze
		// postmortem): the POST no longer holds the turn's SSE stream open for
		// its whole duration. It acknowledges acceptance and CLOSES; the
		// submitter attaches through GET /api/chats/[id]/stream — the same
		// universal reattach wire a returning visitor uses. The browser's
		// 6-connections-per-origin pool is the scarce resource: a submission
		// must cost zero permanently-held slots beyond the one live view. The
		// turn itself is a server-side process (ruling 2026-09-25) — it never
		// needed this connection, only a view did.
		return Response.json({ ok: true });
	} catch (err) {
		// The stream never started, so no onFinish will fire — clear the registry
		// or a malformed request would lock the chat until the TTL eviction.
		endTurn(chatId);
		// Wave C: the live-agent registration (if it happened) dies with the
		// turn here too - nothing was handed (the loop never ticked).
		unregisterLiveAgent(chatId);
		console.error(`[chat ${chatId}] turn failed to start:`, err);
		return Response.json({ error: "Failed to start the turn" }, { status: 500 });
	}
}
