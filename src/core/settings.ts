/**
 * THE USER SETTINGS RECORD's shape + sanitizer (settings-storage wave,
 * 2026-09-19): one versioned, DELTA-shaped record at the data-dir seam
 * (config.SETTINGS_FILE) holding every non-secret product preference.
 *
 * DELTA SEMANTICS (owner decision, 2026-09-19): the record stores EXPLICIT
 * user choices only — ABSENT keys resolve to the factory defaults compiled
 * into this module (FACTORY_SETTINGS). MODELS are the exception (owner,
 * 2026-09-22 — BYOK all the way down): no factory pins exist, so an absent
 * model key resolves to EMPTY and the per-need gates refuse honestly. A
 * software update that ADDS a knob (new
 * tool, new role, new appearance field) therefore needs no migration: old
 * records simply lack the new keys. `version` is a PRIVATE schema counter
 * for BREAKING shape changes only (field renamed / meaning changed) —
 * unrelated to the app release version. Migrations live in the adapter
 * (src/store/settings.ts), not here.
 *
 * Sanitizer contract (mirrors render-settings.ts discipline): whatever
 * arrives from disk or the network passes through sanitizeUserSettings
 * before use — never trusted raw. Strict on known fields, PRESERVES
 * unknown keys verbatim (a newer record must never be destroyed by an
 * older app reading it). Invalid known values degrade gracefully:
 * out-of-range numbers CLAMP, wrong-typed/invalid fields DROP (resolve to
 * factory default), never throw.
 *
 * Browser-safe: pure logic + types only, no node imports. The resolved
 * (fully concrete) view lives in settings-resolution.ts.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { AUTH_PROVIDER_KEYS } from "./auth-keys.ts";
import type { ModelRole } from "../../config.ts";
import type { ChatSettings } from "./contracts/chat.ts";
import type { SearchEngineId } from "./search.ts";

/** The schema version this code understands. Bump ONLY for breaking shape
 *  changes (a field renamed/meaning changed); pure additions never bump. */
export const CURRENT_SETTINGS_VERSION = 1;

/** The background-agent roles whose models the Agent settings expose.
 *  The conversation pair (prober/teacher) stays out — chat-controlled via
 *  the strong slot (one controller, the model picker). Tests pin the set. */
export const BACKGROUND_MODEL_ROLES = [
	"researcher",
	"demoBuilder",
	"visualMaker",
	"extractor",
	"auditor",
] as const;

export type BackgroundModelRole = (typeof BACKGROUND_MODEL_ROLES)[number];

/** A per-role model/thinking override — every field independent (absent
 *  field = that aspect falls back to config.ts's pin for the role). */
export interface RoleModelOverride {
	/** The model swap: both coordinates or neither (mirrors ChatSettings.model). */
	model?: { provider: string; id: string };
	/** The thinking budget swap. */
	thinkingLevel?: ThinkingLevel;
}

// ─── Model slots (model slots wave, 2026-09-20) ──────────────────────────────

/** The capability tiers a user can pin models into (owner-settled mapping):
 *  strong = prober + teacher (also the per-session default-teacher
 *  starting point); cheap = researcher, demo-builder, extractor, auditor,
; vision = visual-maker + pdf-reader. Resolution per role:
 *  ROLE OVERRIDE → slot → factory pin. */
export const MODEL_SLOTS = ["strong", "cheap", "vision"] as const;
export type ModelSlotName = (typeof MODEL_SLOTS)[number];

/** The DEFAULT thinking level for UNSET levels only (owner, 2026-09-22):
 *  a slot/override/chat that names a model but no thinking level resolves
 *  to the FIRST entry in this order that the model supports
 *  (getSupportedThinkingLevels); a non-reasoning model resolves "off"
 *  regardless (pi reports exactly ["off"]). EXPLICITLY set levels never
 *  consult this list — they clamp nearest via pi's native
 *  clampThinkingLevel on model switches.
 *
 *  Client surface (interlude, 2026-09-22): this constant lives in the CORE
 *  BARREL — the UI imports it to auto-populate a thinking level on a FRESH
 *  model pick (one source of truth, AUTH_KEYS precedent; per-model
 *  supportedLevels already reach the client via the catalog). The ordering
 *  has NO other client role: legacy unset records keep the runtime
 *  defaultThinkingLevel fallback at engine build. */
export const DEFAULT_THINKING_ORDER = [
	"medium",
	"low",
	"high",
	"minimal",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

/** The machine-readable NOT-CONFIGURED refusal envelope (owner, 2026-09-22):
 *  every per-need gate — the turn gate in chat-handler, a job spawn, a
 *  notes import — refuses with this exact shape. HTTP callers get 503 +
 *  this JSON; in-band consumers (the job record's error field) carry the
 *  human `error` line. `missing` names the slot TIER(S) the refused
 *  action needs and found unset. */
export const MODELS_NOT_CONFIGURED_CODE = "models_not_configured" as const;
export interface ModelsNotConfigured {
	/** Human-readable — safe to render as-is. */
	error: string;
	/** The machine discriminator the client switches on. */
	code: typeof MODELS_NOT_CONFIGURED_CODE;
	/** Which slot tiers the refused action needs ("strong" | "cheap" | "vision"). */
	missing: ModelSlotName[];
}
export function modelsNotConfigured(missing: ModelSlotName[]): ModelsNotConfigured {
	return {
		error: "No model configured — set up your models first",
		code: MODELS_NOT_CONFIGURED_CODE,
		missing,
	};
}

/** The refusal error text (BYOK, 2026-09-22): job/turn surfaces compose the
 *  record wording around this prefix; UI consumers detect refused work by
 *  it (info tone, not scary-error) — the envelope's home module owns the
 *  string so the writer and the matcher can never drift. */
export function isModelsRefusal(error: string | undefined): boolean {
	return !!error && error.startsWith(modelsNotConfigured([]).error);
}
/** The typed throw for in-process seams (extraction pipeline): callers
 *  catch it to skip honestly (trigger) or surface the 503 envelope
 *  (routes) instead of logging a failure. */
export class ModelsNotConfiguredError extends Error {
	readonly envelope: ModelsNotConfigured;
	constructor(missing: ModelSlotName[]) {
		super(modelsNotConfigured(missing).error);
		this.name = "ModelsNotConfiguredError";
		this.envelope = modelsNotConfigured(missing);
	}
}

/** The key-presence refusal (provider-key interlude, owner, 2026-09-25):
 * a PINNED model is not enough — its provider's key must be present, or
 * the action dies mid-stream masked to a generic error. Same envelope
 * family as modelsNotConfigured: HTTP callers get 503 + this JSON;
 * in-band consumers (the job record's error field) carry the human
 * `error` line. `provider` names whose key is gone; `slots` names the
 * slot tier(s) the refused action resolves to that provider. */
export const PROVIDER_KEY_MISSING_CODE = "provider_key_missing" as const;
export interface ProviderKeyMissing {
	/** Human-readable — safe to render as-is. */
	error: string;
	/** The machine discriminator the client switches on. */
	code: typeof PROVIDER_KEY_MISSING_CODE;
	/** The provider whose key is gone, e.g. "openrouter". */
	provider: string;
	/** Which slot tiers the refused action resolves to that provider. */
	slots: ModelSlotName[];
}
/** The refusal wording's invariant tail — the matcher below keys on it
 * (the label prefix varies by provider). */
const PROVIDER_KEY_MISSING_TAIL = "key is set — add one in Settings → Keys";
export function providerKeyMissing(provider: string, slots: ModelSlotName[]): ProviderKeyMissing {
	const label = AUTH_PROVIDER_KEYS.find((p) => p.id === provider)?.label ?? provider;
	return {
		error: `No ${label} ${PROVIDER_KEY_MISSING_TAIL}`,
		code: PROVIDER_KEY_MISSING_CODE,
		provider,
		slots,
	};
}
/** The refusal error text (same discipline as isModelsRefusal): UI
 * consumers detect key-refused work by the wording (info tone, not
 * scary-error) — the envelope's home module owns the string so the
 * writer and the matcher can never drift. */
export function isProviderKeyRefusal(error: string | undefined): boolean {
	return !!error && error.endsWith(PROVIDER_KEY_MISSING_TAIL);
}
/** The typed throw for in-process seams (extraction pipeline) — the
 * ProviderKeyMissing sibling of ModelsNotConfiguredError: callers catch
 * it to skip honestly (trigger) or surface the 503 envelope (routes). */
export class ProviderKeyMissingError extends Error {
	readonly envelope: ProviderKeyMissing;
	constructor(provider: string, slots: ModelSlotName[]) {
		const envelope = providerKeyMissing(provider, slots);
		super(envelope.error);
		this.name = "ProviderKeyMissingError";
		this.envelope = envelope;
	}
}

/** One slot's stored state. BYOK (owner, 2026-09-22): the WRITE side
 *  requires model (a level alone can never run — no factory floor); the
 *  sanitizer keeps whatever is on disk, but RESOLUTION treats a slot
 *  without a model as unset (inert level, no phantom default). */
export interface ModelSlot {
	/** The model swap: both coordinates or neither. */
	model?: { provider: string; id: string };
	/** The thinking budget swap. */
	thinkingLevel?: ThinkingLevel;
}

/** The `models` settings section (owner decision 2026-09-20: a dedicated
 *  section — slots are engine-level choices, not one session's). All slots
 *  optional: an absent slot means every role of its tier runs whatever the
 *  deeper tiers of the chain resolve to (per-role override → factory pin). */
export interface ModelsSettings {
	strong?: ModelSlot;
	cheap?: ModelSlot;
	vision?: ModelSlot;
}

/** First-run gate (model-slots wave, owner 2026-09-20): the app refuses
 *  to start chats until the user has actively picked all three slots —
 *  there ARE no defaults for 33 providers; a configured app is one whose
 *  models section carries a model in every slot. Thinking levels stay
 *  optional (absent = the resolved tier's budget). */
export function slotsConfigured(models: ModelsSettings | undefined): boolean {
	return Boolean(models?.strong?.model && models?.cheap?.model && models?.vision?.model);
}

/** Which slot a role draws from (model slots wave, 2026-09-20). Includes the
 *  conversation pair and pdfReader (not BackgroundModelRoles — the slot
 *  tier spans every role; only background roles surface per-role overrides). */
export const ROLE_SLOT: Readonly<Record<ModelRole, ModelSlotName>> = {
	prober: "strong",
	teacher: "strong",
	researcher: "cheap",
	demoBuilder: "cheap",
	extractor: "cheap",
	auditor: "cheap",
	visualMaker: "vision",
	pdfReader: "vision",
};

/** General settings — app-level behavior. Version DISPLAY and plans login
 *  live outside the record (package.json / auth.json) by owner decision. */
export interface GeneralSettings {
	/** Auto-update the app (default ON). Mechanism ships in a later wave. */
	autoUpdate?: boolean;
}

/** Agent settings — everything about the non-conversation machinery. */
export interface AgentSettings {
	/** Background-role model/thinking overrides (absent role = config pin). */
	models?: Partial<Record<BackgroundModelRole, RoleModelOverride>>;
	/** Tool toggles keyed by tool id (absent key = enabled). User-level
	 *  only — no per-chat override (owner decision 2026-09-19). */
	tools?: Record<string, boolean>;
	/** Search-engine preference (search wave, 2026-09-20). OPTIONAL by
	 *  owner decision: setting a key auto-activates its engine — the user
	 *  never chooses an engine to make search work. An explicit choice only
	 *  pins the preference (e.g. when BOTH keys are present); the chosen
	 *  engine must still have its key, else search is honestly unavailable.
	 *  Absent + no key = unavailable (no silent fallback, no default). */
	search?: { engine?: SearchEngineId };
	/** Prober graph tools (wave 7, owner ruling 2026-09-23): read-only
	 *  knowledge-graph views for the prober agent — a session list +
	 *  per-session propositions with understanding levels. Its SUBJECT
	 *  is the graph but its MECHANISM is agent capability (tool
	 *  registration), so it lives here in its OWN subsection, not in the
	 *  tool-toggles map. Absent = enabled (the toggle discipline); the
	 *  effective gate composes graph.enabled AND this switch. */
	graphTools?: { enabled?: boolean };
	/** System-prompt override SWITCHES keyed by segment path (absent key =
	 *  off). Switch-on requires the override file to exist (enforced by the
	 *  route); the switch is explicit so users keep a file on disk but run
	 *  the source default to compare (owner decision 2026-09-19). */
	prompts?: Record<string, boolean>;
}

/** Markdown-rendering knobs — the bare-bones set (owner decision). */
export interface MdRenderingSettings {
	/** Heading font weight (100–900, default 900). CSS resolves the nearest
	 *  available weight of the chosen font — no font introspection needed. */
	headingWeight?: number;
	/** Color for **bold** spans (default #ffffff). */
	boldColor?: string | null;
	/** Color for *italic* spans (default #ffffff). */
	italicColor?: string | null;
}

/** Appearance settings — mode, colors, type, markdown emphasis. */
export interface AppearanceSettings {
	/** "dark" | "light" (default dark). */
	mode?: "dark" | "light";
	/** The one user-chosen color; everything else derives per-mode in code.
	 *  null = the mode's default background. */
	background?: string | null;
	/** The main reading font (everything that is Source Sans 3 today), by
	 *  name — user-chosen from installed fonts. null = Source Sans 3. */
	fontFamily?: string | null;
	/** Reading font size in px (12–24, default 16). Headings render as
	 *  multiples of this, so one knob scales the document coherently. */
	proseFontSize?: number;
	/** Session names in CMU Serif (default true — today's look). */
	sessionNameSerif?: boolean;
	mdRendering?: MdRenderingSettings;
}

/** Knowledge-graph settings — a strict dependency ladder (owner decision
 *  2026-09-19): graph → embedding → clustering → labeling, each rung only
 *  meaningful when its parent is on (the UI grays dependents out; stored
 *  values persist but resolve inert). All default true. */
export interface GraphSettings {
	/** MASTER (and, since wave 7, ONLY): off = no extraction, no auditor.
	 *  The wave-7 collapse (owner ruling 2026-09-23) deleted the three
	 *  subordinate rungs — embedding/clustering/labeling — and the BYOK
	 *  embeddingModel: clustering is the free birth-session partition
	 *  derived on read (core/session-clusters.ts), labels ARE session
	 *  names, and the prober graph tools read the ledgers directly — there
	 *  is nothing left to configure. Data stays stored either way. */
	enabled?: boolean;
	/** GRAPH RENDERING (owner, 2026-10-06 — the release graph-controls
	 *  round): gates ONLY the home's main view. Off = the home shows the
	 *  chains view instead of the canvas; the ledgers, the extraction
	 *  pipeline, and every write path are untouched — this is a display
	 *  switch, not a data switch (the extraction master above is the
	 *  data switch). Default on. */
	rendering?: boolean;
	/** The chunk budget (extraction-UX redesign, owner 2026-09-24): the
	 *  transcript-token share of the extractor's context — a run fires
	 *  when a chat's UNCOVERED tokens reach it, and the run batches the
	 *  oldest uncovered messages into runs of ≤ this many tokens. It
	 *  bounds both cost and chunk size (the extractor prompt also
	 *  carries the whole graph + instructions, so a smaller budget means
	 *  more, smaller runs — each paying that fixed overhead).
	 *
	 *  FACTORY DEFAULT 4096 (owner, 2026-10-13: halved back from the
	 *  digest-era 8192 — the labeled passages + message anchors made
	 *  smaller batches worth their overhead again; the pre-setting
	 *  constant was 4096, vision-extraction-coverage.md, 2026-09-15).
	 *  Only the FACTORY moves: an explicit user value always wins.
	 *
	 *  FLOOR 500 (EXTRACTION_CHUNK_TOKENS_FLOOR, the implementer's call
	 *  per the owner's dispatch): every run pays the graph-carrying
	 *  prompt overhead out of the write channel's money — a budget below
	 *  ~500 tokens would fire penny-batches that cost more per extracted
	 *  token than the content is worth, so the sanitizer clamps and the
	 *  PUT rejects below it. NO CEILING on purpose: a large budget just
	 *  delays extraction — the user's stated cost/thoroughness tradeoff,
	 *  not a misconfiguration to police. */
	extractionChunkTokens?: number;
}

/**
 * COMPACTION (owner round 14, 2026-10-05): the context-fitting mechanic's
 * user-facing knob. One number — the trigger threshold in context tokens.
 * The effective trigger is min(this, model contextWindow − 16k reserve)
 * (owner ruling: on big models the setting rules; on small ones the
 * window rules before the provider overflows).
 *
 * FACTORY DEFAULT 150_000 (owner ruling).
 *
 * FLOOR 32_000 (implementer's call, the chunk-budget discipline): below
 * the kept tail (20k) + a summary the chat would re-compact every turn —
 * a burn, not a preference. NO CEILING: a huge threshold just means "fit
 * everything" until the window rule binds.
 */
export interface CompactionSettings {
	thresholdTokens?: number;
}

/** THE record. Every section optional (delta); unknown top-level keys are
 *  preserved verbatim by the sanitizer (forward-compat with newer records). */
export interface UserSettings {
	version: number;
	general?: GeneralSettings;
	agent?: AgentSettings;
	/** The strong/cheap/vision model slots (model slots wave, 2026-09-20). */
	models?: ModelsSettings;
	appearance?: AppearanceSettings;
	graph?: GraphSettings;
	compaction?: CompactionSettings;
	[key: string]: unknown;
}

/** Factory defaults for everything core can pin (owner decisions
 *  2026-09-19). NO factory models exist anywhere (owner, 2026-09-22 — BYOK
 *  all the way down): the chat section and every slot stay empty until the
 *  user picks, and the per-need gates refuse honestly; tools default on;
 *  prompts default off — hence their absence here. */
export interface FactorySettings {
	version: number;
	general: Required<GeneralSettings>;
	appearance: {
		mode: "dark" | "light";
		background: string | null;
		fontFamily: string | null;
		proseFontSize: number;
		sessionNameSerif: boolean;
		mdRendering: {
			headingWeight: number;
			boldColor: string | null;
			italicColor: string | null;
		};
	};
	graph: Required<GraphSettings>;
	compaction: Required<CompactionSettings>;
}

export const FACTORY_SETTINGS: FactorySettings = {
	version: CURRENT_SETTINGS_VERSION,
	general: { autoUpdate: true },
	appearance: {
		mode: "dark",
		background: null, // the dark default (#141414) lives in the mode's derivation curve
		fontFamily: null, // Source Sans 3
		proseFontSize: 16,
		sessionNameSerif: true,
		mdRendering: { headingWeight: 900, boldColor: null, italicColor: null },
	},
	graph: { enabled: true, rendering: true, extractionChunkTokens: 4096 },
	compaction: { thresholdTokens: 150_000 },
};

/** The chunk budget's validated floor (GraphSettings.extractionChunkTokens
 *  — see its doc for the penny-batch rationale; the settings PUT names this
 *  in its rejection, the sanitizer clamps to it). */
export const EXTRACTION_CHUNK_TOKENS_FLOOR = 500;

// ─── Sanitizer ─────────────────────────────────────────────────────────────

const PROSE_FONT_MIN = 12;
const PROSE_FONT_MAX = 24;

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** 检查是否为 #rgb 或 #rrggbb 格式（不区分大小写） — 这是我们唯一接受的颜色格式。 */
export function isHexColor(value: string): boolean {
	return /^#[0-9a-fA-F]{3}$/.test(value) || /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * 强制转换任意的十六进制(hex)或 null 字段：null 和有效的十六进制颜色值将直接通过，
 * 其他任何无效值都将变为 null (即回退到出厂/当前模式的默认值)。
 */
function sanitizeHexOrNull(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value === "string" && isHexColor(value)) return value;
	return null;
}

const boolOrDrop = (value: unknown): boolean | undefined =>
	typeof value === "boolean" ? value : undefined;

function sanitizeGeneral(raw: Record<string, unknown>): GeneralSettings {
	const out: GeneralSettings = {};
	const autoUpdate = boolOrDrop(raw.autoUpdate);
	if (autoUpdate !== undefined) out.autoUpdate = autoUpdate;
	return out;
}

/** 允许的思考级别 (ThinkingLevel) 列表 */
const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * 清理并验证针对某个角色的模型覆盖设置 (RoleModelOverride)。
 * 如果数据结构无效则返回 undefined。
 */
function sanitizeRoleOverride(raw: unknown): RoleModelOverride | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const out: RoleModelOverride = {};
	if (
		typeof r.model === "object" &&
		r.model !== null &&
		!Array.isArray(r.model) &&
		typeof (r.model as Record<string, unknown>).provider === "string" &&
		typeof (r.model as Record<string, unknown>).id === "string"
	) {
		out.model = {
			provider: (r.model as { provider: string }).provider,
			id: (r.model as { id: string }).id,
		};
	}
	if (typeof r.thinkingLevel === "string" && THINKING_LEVELS.includes(r.thinkingLevel as ThinkingLevel)) {
		out.thinkingLevel = r.thinkingLevel as ThinkingLevel;
	}
	return Object.keys(out).length ? out : undefined;
}

/**
 * 清理 models 节点配置 (2026-09-20 引入的模型插槽机制)：
 * 每个插槽 (slot) 仅保留格式正确的部分 — 校验规则和 role override 相同，
 * 这可以防止过时的旧客户端在插槽中塞入垃圾数据。
 */
function sanitizeModels(raw: Record<string, unknown>): ModelsSettings {
	const out: ModelsSettings = {};
	for (const slot of MODEL_SLOTS) {
		const cleaned = sanitizeRoleOverride(raw[slot]);
		if (cleaned) out[slot] = cleaned;
	}
	return out;
}

function sanitizeBooleanMap(raw: unknown): Record<string, boolean> | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "boolean") out[key] = value;
	}
	return Object.keys(out).length ? out : undefined;
}

/** 清理代理(Agent)相关的设置 */
function sanitizeAgent(raw: Record<string, unknown>): AgentSettings {
	const out: AgentSettings = {};
	if (raw.models !== null && typeof raw.models === "object" && !Array.isArray(raw.models)) {
		const models: Partial<Record<BackgroundModelRole, RoleModelOverride>> = {};
		for (const [role, override] of Object.entries(raw.models as Record<string, unknown>)) {
			if ((BACKGROUND_MODEL_ROLES as readonly string[]).includes(role)) {
				const cleaned = sanitizeRoleOverride(override);
				if (cleaned) models[role as BackgroundModelRole] = cleaned;
			}
		}
		if (Object.keys(models).length) out.models = models;
	}
	const tools = sanitizeBooleanMap(raw.tools);
	if (tools) out.tools = tools;
	const prompts = sanitizeBooleanMap(raw.prompts);
	if (prompts) out.prompts = prompts;
	// 搜索(Search)偏好设置：读取端策略非常宽松 (未知的引擎 ID 会被直接丢弃；
	// 但写入端的解析器是严格的 — 过时的客户端无法破坏记录，最多只会丢失固定的偏好设置
	// 并恢复到自动检测模式)。
	if (raw.search !== null && typeof raw.search === "object" && !Array.isArray(raw.search)) {
		const engine = (raw.search as Record<string, unknown>).engine;
		if (engine === "tavily" || engine === "brave") out.search = { engine };
	}
	// 探针图工具 (wave 7): 这是 agent 节点下的一个独立子节点 —
	// 读取端同样宽松 (糟糕的数据结构会使该键被丢弃并恢复为默认的 ON 开启状态；
	// 写入端的解析器是严格的)。
	if (raw.graphTools !== null && typeof raw.graphTools === "object" && !Array.isArray(raw.graphTools)) {
		const enabled = (raw.graphTools as Record<string, unknown>).enabled;
		if (enabled === undefined) out.graphTools = {};
		else if (typeof enabled === "boolean") out.graphTools = { enabled };
	}
	return out;
}

function sanitizeMdRendering(raw: unknown): MdRenderingSettings {
	const out: MdRenderingSettings = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
	const r = raw as Record<string, unknown>;
	if (typeof r.headingWeight === "number" && Number.isFinite(r.headingWeight)) {
		out.headingWeight = clamp(Math.round(r.headingWeight), 100, 900);
	}
	if (r.boldColor !== undefined) out.boldColor = sanitizeHexOrNull(r.boldColor);
	if (r.italicColor !== undefined) out.italicColor = sanitizeHexOrNull(r.italicColor);
	return out;
}

function sanitizeAppearance(raw: Record<string, unknown>): AppearanceSettings {
	const out: AppearanceSettings = {};
	if (raw.mode === "dark" || raw.mode === "light") out.mode = raw.mode;
	if (raw.background !== undefined) out.background = sanitizeHexOrNull(raw.background);
	if (raw.fontFamily !== undefined) {
		out.fontFamily = typeof raw.fontFamily === "string" && raw.fontFamily.trim() ? raw.fontFamily : null;
	}
	if (typeof raw.proseFontSize === "number" && Number.isFinite(raw.proseFontSize)) {
		out.proseFontSize = clamp(Math.round(raw.proseFontSize), PROSE_FONT_MIN, PROSE_FONT_MAX);
	}
	const sessionNameSerif = boolOrDrop(raw.sessionNameSerif);
	if (sessionNameSerif !== undefined) out.sessionNameSerif = sessionNameSerif;
	if (raw.mdRendering !== undefined) out.mdRendering = sanitizeMdRendering(raw.mdRendering);
	return out;
}

/** 清理图(Graph)相关设置 */
function sanitizeGraph(raw: Record<string, unknown>): GraphSettings {
	// Wave 7 折叠处理 (基于所有者在 2026-09-23 的决策)：该部分目前只包含总开关。
	// 现有记录中已经废弃的阶梯键 (如 embedding/clustering/labeling/embeddingModel)
	// 在此次重构中仅仅是不被读取(UNREAD)并被丢弃(DROPPED) — 它的迁移故事是：
	// 下一次 graph 节点的写入 (PUT 是全量替换) 就会固化这种折叠后的新形状，
	// 而且不会有任何活跃的代码去查看这些陈旧的字段。
	//
	// extractionChunkTokens (2026-09-24 提取UX重新设计): 分块处理的预算(token 数量) —
	// 遵循“钳制而不拒绝(clamp-never-reject)”原则：必须是一个有限正数，并设置
	// EXTRACTION_CHUNK_TOKENS_FLOOR 作为下限 (小数向下取整)；任何不符合要求的值
	// 都会在解析时被丢弃并使用出厂默认值。如果磁盘里的旧记录低于下限(比如老版本应用或手动修改)，
	// 也会被强行钳制提升(clamps UP) — 设定下限是为了做成本保护，而不是为了尊重无效数据。
	const out: GraphSettings = {};
	const enabled = boolOrDrop(raw.enabled);
	if (enabled !== undefined) out.enabled = enabled;
	const rendering = boolOrDrop(raw.rendering);
	if (rendering !== undefined) out.rendering = rendering;
	const rawTokens = raw.extractionChunkTokens;
	if (typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens > 0) {
		out.extractionChunkTokens = Math.max(EXTRACTION_CHUNK_TOKENS_FLOOR, Math.floor(rawTokens));
	}
	return out;
}

/**
 * 钳制而不拒绝 (clamp-never-reject，这是清理器的准则)：有限正数必须不小于
 * COMPACTION_THRESHOLD_FLOOR 下限，除此之外的其他任何值都会被丢弃
 * (在读取时会解析为出厂默认值)。导出供 PUT 接口的解析器使用以提供合理的拒绝信息
 * (这是图分块预算开创的先例)。
 */
export const COMPACTION_THRESHOLD_FLOOR = 32_000;

function sanitizeCompaction(raw: Record<string, unknown>): CompactionSettings {
	const out: CompactionSettings = {};
	const rawTokens = raw.thresholdTokens;
	if (typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens > 0) {
		out.thresholdTokens = Math.max(COMPACTION_THRESHOLD_FLOOR, Math.floor(rawTokens));
	}
	return out;
}

/**
 * 将任意的 JSON (例如来自磁盘文件或网络请求体) 强制转换为有效的差异记录 (delta record)：
 * 已知的字段受到严格的验证 (无效的值根据上述各模块规则会被丢弃/钳制)；
 * 对于【未知的键则会原样保留 (PRESERVED VERBATIM)】 (为了保证较新的配置记录在旧版应用中依然存活)。
 * 绝对不会抛出异常 (Never throws)。如果不是对象类型则返回 null。
 *
 * @param raw 原始输入数据
 * @returns 清理后的用户设置对象
 */
export function sanitizeUserSettings(raw: unknown): UserSettings | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const out: UserSettings = {
		version: typeof r.version === "number" && Number.isInteger(r.version) && r.version >= 1 ? r.version : CURRENT_SETTINGS_VERSION,
	};
	if (r.general !== null && typeof r.general === "object" && !Array.isArray(r.general)) {
		out.general = sanitizeGeneral(r.general as Record<string, unknown>);
	}
	if (r.agent !== null && typeof r.agent === "object" && !Array.isArray(r.agent)) {
		out.agent = sanitizeAgent(r.agent as Record<string, unknown>);
	}
	if (r.appearance !== null && typeof r.appearance === "object" && !Array.isArray(r.appearance)) {
		out.appearance = sanitizeAppearance(r.appearance as Record<string, unknown>);
	}
	if (r.models !== null && typeof r.models === "object" && !Array.isArray(r.models)) {
		const models = sanitizeModels(r.models as Record<string, unknown>);
		if (Object.keys(models).length) out.models = models;
	}
	if (r.graph !== null && typeof r.graph === "object" && !Array.isArray(r.graph)) {
		out.graph = sanitizeGraph(r.graph as Record<string, unknown>);
		if (r.compaction !== undefined && r.compaction !== null && typeof r.compaction === "object") {
			out.compaction = sanitizeCompaction(r.compaction as Record<string, unknown>);
		}
	}
	// 未知的顶级键会被原封不动地保留以支持向下兼容(forward-compat)。
	// 但有一个已明确废弃 (known-DEAD) 的键会被剥离而非保留：`chat` (这是旧版本中的
	// 默认设置节点) 它在引入“按会话设置模型”的特性时已被淘汰 (所有者规则，2026-09-28) —
	// 磁盘上留存的化石级旧数据绝对不能通过读取被复活 (之后的任何写入操作都会将它永远从文件中清除)。
	for (const [key, value] of Object.entries(r)) {
		if (key === "chat") continue;
		if (!(key in out)) out[key] = value;
	}
	return out;
}
