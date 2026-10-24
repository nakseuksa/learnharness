/**
 * 共享的 settings-PUT 请求体解析器 — 每个设置表面一个接缝。
 * 逐字从 per-chat 路由中提取（default-settings wave，2026-09-18）：
 * 相同的解析，相同的错误。部分解析器（section parsers，
 * settings-storage wave，2026-09-19）遵循相同的内部规则。
 *
 * 整体替换语义（Replace-whole semantics）：客户端发送完整的所需部分（SECTION）；
 * 缺少的字段意味着缺少覆盖（{} 清除一切）。没有合并（No merges），因此过时的客户端
 * 永远无法复活已清除的覆盖。未知的请求体键被丢弃（与 parseSettingsBody 相同的容忍度）
 * — 未知的磁盘（DISK）键是另一回事，由消毒器（sanitizer，core/settings.ts）保留。
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isHexColor, type ChatSettings } from "../core";
import type {
	AgentSettings,
	AppearanceSettings,
	BackgroundModelRole,
	CompactionSettings,
	GeneralSettings,
	GraphSettings,
	ModelsSettings,
	RoleModelOverride,
} from "../core/settings.ts";
import { BACKGROUND_MODEL_ROLES, COMPACTION_THRESHOLD_FLOOR, EXTRACTION_CHUNK_TOKENS_FLOOR, MODEL_SLOTS } from "../core/settings.ts";
import { WRITABLE_TOOL_KEYS } from "../core/pending.ts";

/** 解析或拒绝 — `ok: false` 携带 400 的错误消息。 */
/**
 * 校验解析请求体的结果类型，封装成功时带回的泛型实体对象以及失败时的错误描述。
 */
export type SettingsBodyResult<T> =
	| { ok: true; settings: T }
	| { ok: false; error: string };

/**
 * 解析并校验来自请求体的独立会话配置（ChatSettings）。
 * 它负责验证传入 JSON 结构，并确保 `model` 及 `thinkingLevel` 字段满足应用所需的合法性约束。
 * (旧版未包含在 models 节点下的内容会按向下兼容被解析)。
 *
 * @param body 待解析的 JSON 格式未知载荷。
 * @returns 验证成功返回包含设置的成功结果，否则返回具体的错误信息。
 */
export function parseSettingsBody(body: unknown): SettingsBodyResult<ChatSettings> {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "Invalid JSON body" };
	}
	const raw = body as {
		model?: { provider?: unknown; id?: unknown };
		thinkingLevel?: unknown;
	};
	const settings: ChatSettings = {};
	if (raw.model !== undefined) {
		if (
			typeof raw.model !== "object" ||
			raw.model === null ||
			typeof raw.model.provider !== "string" ||
			typeof raw.model.id !== "string"
		) {
			return { ok: false, error: "model must be {provider, id}" };
		}
		settings.model = { provider: raw.model.provider, id: raw.model.id };
	}
	if (raw.thinkingLevel !== undefined) {
		if (typeof raw.thinkingLevel !== "string") {
			return { ok: false, error: "thinkingLevel must be a string" };
		}
		settings.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}
	// Wave 7 杀死了图谱上下文注入（owner：除了聊天模型之外零配置
	// — prober 现在通过工具读取它的地图）；它的预算刻度盘也随之消失了。
	// 发送旧键的过时客户端在这里被静默丢弃（向前兼容，就像任何未知键一样）。
	return { ok: true, settings };
}

// ─── 部分解析器 (settings-storage wave, 2026-09-19) ────────────────────
// settings.json 的每个部分一个解析器；路由通过下面的 SETTINGS_SECTIONS
// 将 URL 部分映射到其解析器。与 parseSettingsBody 相同的规则：对每个
// 已知字段严格（错误的类型/形状返回 400，从不静默钳制/丢弃），丢弃未知键。

function asRecord(body: unknown): Record<string, unknown> | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}

/**
 * 常规设置（general）：{ autoUpdate?: boolean }
 *
 * 解析并校验基础/全局配置项（GeneralSettings）。
 * 包括：`autoScroll`（自动滚动开关）和 `titleGeneration`（由模型驱动的智能标题生成开关及触发时间）。
 * 由于是全量替换接口，未传递的键等同于被清除（使用出厂默认值）。
 *
 * @param body 待解析的请求体载荷。
 * @returns 验证成功或失败的解析结果。
 */
export function parseGeneralSettingsBody(body: unknown): SettingsBodyResult<GeneralSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: GeneralSettings = {};
	if (raw.autoUpdate !== undefined) {
		if (typeof raw.autoUpdate !== "boolean") {
			return { ok: false, error: "autoUpdate must be a boolean" };
		}
		settings.autoUpdate = raw.autoUpdate;
	}
	return { ok: true, settings };
}

/**
 * agent.models：只有六个已知的后台角色；每个覆盖的字段
 * 镜像 ChatSettings（模型对 + 独立的 thinkingLevel）。
 */
function parseRoleOverride(value: unknown, role: string): { ok: true; override: RoleModelOverride } | { ok: false; error: string } {
	const raw = asRecord(value);
	if (!raw) return { ok: false, error: `${role} must be an object` };
	const override: RoleModelOverride = {};
	if (raw.model !== undefined) {
		if (
			typeof raw.model !== "object" ||
			raw.model === null ||
			typeof (raw.model as Record<string, unknown>).provider !== "string" ||
			typeof (raw.model as Record<string, unknown>).id !== "string"
		) {
			return { ok: false, error: `${role}.model must be {provider, id}` };
		}
		override.model = {
			provider: (raw.model as { provider: string }).provider,
			id: (raw.model as { id: string }).id,
		};
	}
	if (raw.thinkingLevel !== undefined) {
		if (typeof raw.thinkingLevel !== "string") {
			return { ok: false, error: `${role}.thinkingLevel must be a string` };
		}
		override.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}
	return { ok: true, override };
}

/** 布尔映射（工具 / 提示开关）：每个值都必须是布尔值。 */
function parseBooleanMap(value: unknown, field: string): { map?: Record<string, boolean>; error?: string } {
	if (value === undefined) return {};
	const raw = asRecord(value);
	if (!raw) return { error: `${field} must be an object` };
	const out: Record<string, boolean> = {};
	for (const [key, entry] of Object.entries(raw)) {
		if (typeof entry !== "boolean") return { error: `${field}.${key} must be a boolean` };
		out[key] = entry;
	}
	return { map: out };
}

/**
 * agent：{ models?, tools?, prompts? } — 模型/思考针对目录的有效性
 * 由路由检查（validateChatSettings 规则）；提示开关的成员资格由路由检查（需要存储）。
 *
 * 解析并校验有关模型 Agent 行为机制的相关配置项（AgentSettings）。
 * 包括了用于多工具调用的全局限流、重试机制、以及控制代理能够使用哪些外围工具（如图谱和搜索）。
 *
 * @param body 待校验的请求体。
 * @returns 解析得到的安全合法的 AgentSettings 对象结果。
 */
export function parseAgentSettingsBody(body: unknown): SettingsBodyResult<AgentSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: AgentSettings = {};
	if (raw.models !== undefined) {
		const models = asRecord(raw.models);
		if (!models) return { ok: false, error: "models must be an object" };
		const known = BACKGROUND_MODEL_ROLES as readonly string[];
		const parsed: NonNullable<AgentSettings["models"]> = {};
		for (const [role, value] of Object.entries(models)) {
			if (!known.includes(role)) {
				return { ok: false, error: `unknown role "${role}" (supported: ${known.join(", ")})` };
			}
			const override = parseRoleOverride(value, role);
			if (!override.ok) return { ok: false, error: override.error };
			if (Object.keys(override.override).length) parsed[role as BackgroundModelRole] = override.override;
		}
		if (Object.keys(parsed).length) settings.models = parsed;
	}
	const tools = parseBooleanMap(raw.tools, "tools");
	if (tools.error) return { ok: false, error: tools.error };
	if (tools.map) {
		// 未知的工具键在写入（WRITE）时被拒绝（用户决定 2026-09-19）：
		// 增量在未读时是惰性的，但是一旦桥梁承认它，持久化的假键就会漂移。
		// 可写集是作业工具 + 测验机制开关（explain，owner 2026-09-27）。
		// 读侧的消毒器保持宽容以实现向前兼容。
		const supported = WRITABLE_TOOL_KEYS as readonly string[];
		for (const key of Object.keys(tools.map)) {
			if (!supported.includes(key)) {
				return { ok: false, error: `unknown tool "${key}" (supported: ${supported.join(", ")})` };
			}
		}
		settings.tools = tools.map;
	}
	const prompts = parseBooleanMap(raw.prompts, "prompts");
	if (prompts.error) return { ok: false, error: prompts.error };
	if (prompts.map) settings.prompts = prompts.map;
	if (raw.search !== undefined) {
		const search = asRecord(raw.search);
		if (!search) return { ok: false, error: "search must be an object" };
		if (search.engine !== undefined) {
			if (search.engine !== "tavily" && search.engine !== "brave") {
				return { ok: false, error: 'search.engine must be "tavily" or "brave"' };
			}
			settings.search = { engine: search.engine };
		}
	}
	// Prober 图谱工具（wave 7，owner ruling 2026-09-23）：一个代理部分（agent-section）
	// 的子部分，而不是一个工具切换键 — 机制是代理能力（工具注册），主题是图谱。
	// 严格的写入端：仅限对象形状；存在时为 `enabled` 布尔值。缺失 = 开启（ON）。
	if (raw.graphTools !== undefined) {
		const graphTools = asRecord(raw.graphTools);
		if (!graphTools) return { ok: false, error: "graphTools must be an object" };
		if (graphTools.enabled !== undefined && typeof graphTools.enabled !== "boolean") {
			return { ok: false, error: "graphTools.enabled must be a boolean" };
		}
		settings.graphTools = graphTools.enabled === undefined ? {} : { enabled: graphTools.enabled };
	}
	return { ok: true, settings };
}

/** 十六进制或 null 颜色字段（外观颜色）：null = 默认。 */
function parseHexOrNull(value: unknown, field: string): { color?: string | null; error?: string } {
	if (value === null) return { color: null };
	if (typeof value !== "string" || !isHexColor(value)) {
		return { error: `${field} must be a #hex color or null` };
	}
	return { color: value };
}

/**
 * appearance: { mode?, background?, fontFamily?, proseFontSize?,
 * sessionNameSerif?, mdRendering? }
 *
 * 解析并校验应用外观样式的偏好设置项（AppearanceSettings）。
 * 处理的字段包括：亮暗模式 (`mode`)、背景色 (`background`)、字体 (`fontFamily`)、
 * 字号 (`proseFontSize`)，以及Markdown富文本渲染中特殊元素的自定义颜色和加粗设置。
 *
 * @param body 需要校验的载荷。
 * @returns 成功或失败包裹的外观设置项。
 */
export function parseAppearanceSettingsBody(body: unknown): SettingsBodyResult<AppearanceSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: AppearanceSettings = {};
	if (raw.mode !== undefined) {
		if (raw.mode !== "dark" && raw.mode !== "light") {
			return { ok: false, error: "mode must be \"dark\" or \"light\"" };
		}
		settings.mode = raw.mode;
	}
	if (raw.background !== undefined) {
		const parsed = parseHexOrNull(raw.background, "background");
		if (parsed.error) return { ok: false, error: parsed.error };
		settings.background = parsed.color ?? null;
	}
	if (raw.fontFamily !== undefined) {
		if (raw.fontFamily !== null && (typeof raw.fontFamily !== "string" || !raw.fontFamily.trim())) {
			return { ok: false, error: "fontFamily must be a non-empty string or null" };
		}
		settings.fontFamily = raw.fontFamily as string | null;
	}
	if (raw.proseFontSize !== undefined) {
		if (
			typeof raw.proseFontSize !== "number" ||
			!Number.isInteger(raw.proseFontSize) ||
			raw.proseFontSize < 12 ||
			raw.proseFontSize > 24
		) {
			return { ok: false, error: "proseFontSize must be an integer between 12 and 24" };
		}
		settings.proseFontSize = raw.proseFontSize;
	}
	if (raw.sessionNameSerif !== undefined) {
		if (typeof raw.sessionNameSerif !== "boolean") {
			return { ok: false, error: "sessionNameSerif must be a boolean" };
		}
		settings.sessionNameSerif = raw.sessionNameSerif;
	}
	if (raw.mdRendering !== undefined) {
		const md = asRecord(raw.mdRendering);
		if (!md) return { ok: false, error: "mdRendering must be an object" };
		const rendering: NonNullable<AppearanceSettings["mdRendering"]> = {};
		if (md.headingWeight !== undefined) {
			if (
				typeof md.headingWeight !== "number" ||
				!Number.isInteger(md.headingWeight) ||
				md.headingWeight < 100 ||
				md.headingWeight > 900
			) {
				return { ok: false, error: "mdRendering.headingWeight must be an integer between 100 and 900" };
			}
			rendering.headingWeight = md.headingWeight;
		}
		if (md.boldColor !== undefined) {
			const parsed = parseHexOrNull(md.boldColor, "mdRendering.boldColor");
			if (parsed.error) return { ok: false, error: parsed.error };
			rendering.boldColor = parsed.color ?? null;
		}
		if (md.italicColor !== undefined) {
			const parsed = parseHexOrNull(md.italicColor, "mdRendering.italicColor");
			if (parsed.error) return { ok: false, error: parsed.error };
			rendering.italicColor = parsed.color ?? null;
		}
		if (Object.keys(rendering).length) settings.mdRendering = rendering;
	}
	return { ok: true, settings };
}

/**
 * graph：折叠部分 { enabled? }（wave 7，owner ruling 2026-09-23）：
 * 仅限（ONLY）主开关 — 嵌入/聚类/标签梯级和 BYOK embeddingModel
 * 随着提供商嵌入器一起消亡（聚类是免费的出生会话分区，标签是会话名称）。
 * 请求体中的旧形状键被忽略，而不是被拒绝。
 *
 * 解析并校验与知识图谱功能相关的偏好配置（GraphSettings）。
 * 当前由于经过了架构精简合并（Wave 7 / 2026-09-23），这部分主要只保留主控开关（enabled）、
 * 渲染开关（rendering）以及提取模块切分大小时需要的预算数（extractionChunkTokens）。
 *
 * @param body 要解析的请求数据体。
 * @returns 验证合法后的 `GraphSettings` 结果。
 */
export function parseGraphSettingsBody(body: unknown): SettingsBodyResult<GraphSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	// Wave 7 折叠（owner ruling 2026-09-23）+ extraction-UX 重新设计
	// （2026-09-24）：该部分是主开关和块预算。PUT 是整体替换 —
	// 像 {enabled: true} 这样的请求体就是（IS）整个部分（extractionChunkTokens 缺失
	// = 解析时的出厂默认值）；旧记录中死梯级的键未被读取（消毒器会丢弃它们；参见 sanitizeGraph）。
	const settings: GraphSettings = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
		settings.enabled = raw.enabled;
	}
	if (raw.rendering !== undefined) {
		if (typeof raw.rendering !== "boolean") return { ok: false, error: "rendering must be a boolean" };
		settings.rendering = raw.rendering;
	}
	if (raw.extractionChunkTokens !== undefined) {
		if (typeof raw.extractionChunkTokens !== "number" || !Number.isFinite(raw.extractionChunkTokens)) {
			return { ok: false, error: "extractionChunkTokens must be a number" };
		}
		const floored = Math.floor(raw.extractionChunkTokens);
		if (floored < EXTRACTION_CHUNK_TOKENS_FLOOR) {
			// 下限的理由存在于 GraphSettings.extractionChunkTokens：
			// 每次运行都支付携带图谱的提示开销 — 每提取一个 token，一分钱批次的
			// 成本比内容本身的价值还要高。
			return {
				ok: false,
				error: `extractionChunkTokens must be at least ${EXTRACTION_CHUNK_TOKENS_FLOOR} (smaller batches waste the per-run graph overhead)`,
			};
		}
		settings.extractionChunkTokens = floored;
	}
	return { ok: true, settings };
}

/**
 * models: { strong?, cheap?, vision? } — 槽位层级（model slots wave, 2026-09-20）。
 * 每个槽位的形状与角色覆盖相同；存在但为空的槽位对象将被拒绝（缺失槽位 = 未设置；
 * 有话直说（say what you mean））。目录有效性由路由检查（validateChatSettings 规则）。
 *
 * 解析全局模型档位插槽（ModelsSettings）。
 * 将传递的模型指定参数（strong / cheap / vision 等插槽）验证并组装。
 * 这保证了系统始终使用 BYOK（Bring Your Own Key）并且明确声明底层使用的 `provider` 与 `model`。
 *
 * @param body 需要解析的插槽定义配置体。
 * @returns 验证合法后的模型档位设置。
 */
export function parseModelsSettingsBody(body: unknown): SettingsBodyResult<ModelsSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: ModelsSettings = {};
	for (const key of Object.keys(raw)) {
		const known = MODEL_SLOTS as readonly string[];
		if (!known.includes(key)) {
			return { ok: false, error: `unknown slot "${key}" (supported: ${known.join(", ")})` };
		}
		const parsed = parseRoleOverride(raw[key], key);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		// BYOK（owner，2026-09-22）：一个槽位就是（IS）一个模型选择 —
		// 不存在出厂底线，因此单靠 thinkingLevel 永远无法运行；
		// 每次插槽写入都必须携带模型（级别是一个可选的附加项）。
		// 缺失的槽位键会清除该层级（整体替换部分）。
		if (!parsed.override.model) {
			return { ok: false, error: `slot "${key}" must set a model (thinkingLevel alone cannot run — absent slot = unset)` };
		}
		settings[key as (typeof MODEL_SLOTS)[number]] = parsed.override;
	}
	return { ok: true, settings };
}

/**
 * 压缩（owner round 14）：上下文压缩阈值 — 预计的 token 预算，超过该预算
 * 会话将把自己的历史记录总结到压缩标记中。严格的写入端：存在的
 * thresholdTokens 必须是大于或等于下限的数字（下限是反抖动的：
 * 每次压缩保留一个约 20k token 的最近尾部，因此较小的阈值会重新总结
 * 它刚刚写入的尾部）。缺失 = 解析时的出厂默认值 150k。
 * 整体替换，像每个部分一样。
 *
 * 解析与长期记忆合并压缩（Compaction）关联的配置。
 * 允许用户设置触发展开模型对过长对话历史执行内容提取重写的 Token 预算阈值（thresholdTokens）。
 * 这个预算数有着严格防抖动的下限（防止不断重复触发）。
 *
 * @param body 需要解析的请求载荷。
 * @returns 解析合规的结果包装体。
 */
export function parseCompactionSettingsBody(body: unknown): SettingsBodyResult<CompactionSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: CompactionSettings = {};
	if (raw.thresholdTokens !== undefined) {
		if (typeof raw.thresholdTokens !== "number" || !Number.isFinite(raw.thresholdTokens)) {
			return { ok: false, error: "thresholdTokens must be a number" };
		}
		const floored = Math.floor(raw.thresholdTokens);
		if (floored < COMPACTION_THRESHOLD_FLOOR) {
			return {
				ok: false,
				error: `thresholdTokens must be at least ${COMPACTION_THRESHOLD_FLOOR} (compaction keeps a ~20k-token recent tail — smaller budgets would churn it)`,
			};
		}
		settings.thresholdTokens = floored;
	}
	return { ok: true, settings };
}

/**
 * PUT /api/settings/[section] 的 部分→解析器 映射
 * （该路由还携带特殊的 prompts 子资源）。
 *
 * 将不同的设置分类段落映射到对应的安全解析验证器。
 * 这一映射由后端的 `PUT /api/settings/[section]` 路由直接驱动，以确保存储更新安全性。
 */
export const SETTINGS_SECTIONS = {
	general: parseGeneralSettingsBody,
	chat: parseSettingsBody,
	agent: parseAgentSettingsBody,
	appearance: parseAppearanceSettingsBody,
	graph: parseGraphSettingsBody,
	compaction: parseCompactionSettingsBody,
	models: parseModelsSettingsBody,
} as const;

export type SettingsSectionName = keyof typeof SETTINGS_SECTIONS;
