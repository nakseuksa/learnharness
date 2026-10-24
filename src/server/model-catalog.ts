/**
 * 模型目录的服务器端表面（model-control wave, 2026-09-12；自 model-slots wave 以来联邦化, 2026-09-20）：
 * pi-ai 为每个拥有密钥（KEYED）的提供商提供的目录，投影到选择器的客户端安全 DTO（GET /api/models），
 * 加上设置写入的验证门控（PUT /api/settings/* — 每个聊天的设置 PUT 已从 UI 中退役；
 * 旧记录的每个聊天覆盖仍在服务器端解析）。
 *
 * pi-ai 拥有所有数据：目录（id/name/cost/context/modality/thinkingLevelMap）
 * 和每个模型的思考真相（getSupportedThinkingLevels / clampThinkingLevel）。
 * 此模块仅进行投影和验证 — 没有第二个会失去同步的注册表。
 *
 * 联邦（Federation）：`getModels()` 为每个拥有密钥的提供商调用（联邦化，model-slots wave），
 * 因此提供商仅在其密钥存在时才出现在选择器中 — src/agent/models.ts 中的 piModels()
 * 拥有提供商集合；这里没有任何改变。
 */

import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { piModels } from "../agent/models.ts";
import { settingsStore } from "../store/settings.ts";
import { effectiveSettings } from "./stores.ts";
import { keyValue } from "./keys.ts";
import type { ChatSettings } from "../core/contracts/chat.ts";
import type {
	CatalogDefaults,
	CatalogProvider,
	ModelCatalogEntry,
	ModelCatalogResponse,
	RolePins,
	SlotPins,
} from "../core/contracts/models.ts";
import type { EffectiveModelSpec, EffectiveSlot } from "../core/settings-resolution.ts";
import { AUTH_PROVIDER_KEYS } from "../core/auth-keys.ts";
import { BACKGROUND_MODEL_ROLES, MODEL_SLOTS, type BackgroundModelRole, type ModelSlotName, type ModelsSettings } from "../core/settings.ts";

/** 选择器的客户端安全模型条目（contract: core/contracts/models.ts）。 */
export type ModelDto = ModelCatalogEntry;

/**
 * 对话代理的解析默认值（纯形式 — strong 槽位输入，CatalogDefaults 输出；
 * 下面的 `catalogDefaults()` 是 fs 包装器）。
 * 每个会话的模型（PER-SESSION MODELS，owner，2026-09-28）：每个会话从诞生起就拥有其模型 +
 * 思考级别，逐字从 strong 槽位打上烙印 — STRONG SLOT 是新会话的默认值，
 * 以及旧的无设置记录的解析时回退。BYOK（owner，2026-09-22）：没有出厂预设
 * — 当 strong 槽位没有指定模型时，默认值为 NULL，回合门控以 503 models_not_configured
 * 拒绝。未设置的 thinkingLevel 在引擎构建时从 DEFAULT_THINKING_ORDER 解析（在此处报告为缺失）。
 *
 * 确定指定平台的默认模型配置（如果存在）。用于 "Defaults" 按钮一键填充，或在新用户引导时使用。
 * 根据提供的模型提供商和型号，回落匹配出对应的配置。
 * @param models 支持的模型枚举记录。
 * @param provider 指定的模型提供商（"openai" 或 "anthropic"）。
 * @returns 匹配的平台默认模型及选项。
 */
export function catalogDefaultsFor(
	strong: EffectiveSlot | null,
): CatalogDefaults | null {
	const model = strong ? { provider: strong.provider, id: strong.id } : undefined;
	if (!model) return null;
	const level = strong?.thinkingLevel;
	return {
		model,
		...(level !== undefined ? { thinkingLevel: level } : {}),
	};
}

/**
 * 对话代理的解析默认值 — 无设置的聊天运行的内容：strong 槽位，即新会话的诞生默认值。
 *
 * 解析系统级的所有模型默认选项（用于首选项/备用填充）。
 * @returns 包含各提供商的推荐模型映射对象。
 */
export function catalogDefaults(): CatalogDefaults | null {
	return catalogDefaultsFor(effectiveSettings().models.strong);
}

/**
 * 将解析的每个角色的规范投影到客户端 DTO（纯 — 设置 UI 的
 * “默认值：<实际固定的模型>”标题读取此内容）。
 * BYOK (owner, 2026-09-22)：空链投影为 NULL — 标题诚实地显示“未配置”，绝不是虚幻的默认值。
 *
 * 解析各种独立模型角色（如提取、图谱总结、翻译）预置绑定的推荐模型。
 * 平台不同的默认引擎被分配给了不同的职责，这能保证最优的工作流体验。
 * @param models 支持的模型列表。
 * @param provider 提供商上下文。
 * @returns 模型角色到实际模型配置的映射。
 */
export function rolePinsFor(
	models: Record<BackgroundModelRole, EffectiveModelSpec | undefined>,
): RolePins {
	const pins = {} as RolePins;
	for (const role of BACKGROUND_MODEL_ROLES) {
		const spec = models[role];
		pins[role] = spec
			? {
					model: { provider: spec.provider, id: spec.id },
					...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}),
				}
			: null;
	}
	return pins;
}

/**
 * 后台角色的解析（RESOLVED）绑定：用户的 agent-models 覆盖 → 层级槽位 → nothing
 * — 与代理连线使用的相同解析（src/server/stores.ts effectiveSettings），
 * 因此标题永远不会偏离实际运行的内容。
 *
 * 集中获取全系统定义的各模型角色对应推荐的模型配置。
 * @returns 各角色绑定的模型及选项信息。
 */
export function catalogRolePins(): RolePins {
	return rolePinsFor(effectiveSettings().agent.models);
}

/**
 * 三个槽位层级的解析（RESOLVED）绑定 — 逐字有效设置().models：
 * 与引擎连线使用的相同解析，因此模型设置页面的标题不能偏离实际运行的内容。
 * 不包含模型的层级为 NULL。
 *
 * （Wave 7 / 2026-09-20）槽位绑定解析。它提取 `ModelCatalog` 里预设的各插槽（strong, cheap 等）推荐。
 * 这些槽位的解析是为了填充用户的偏好模型选择界面。
 * @returns 定义的不同档位推荐的模型配置。
 */
export function catalogSlots(): SlotPins {
	const slots = effectiveSettings().models;
	const pins = {} as SlotPins;
	for (const name of ["strong", "cheap", "vision"] as const) {
		const slot: EffectiveSlot | null = slots[name];
		pins[name] = slot
			? {
					model: { provider: slot.provider, id: slot.id },
					...(slot.thinkingLevel !== undefined ? { thinkingLevel: slot.thinkingLevel } : {}),
				}
			: null;
	}
	return pins;
}

/**
 * 提供商表面（model slots wave, 2026-09-20）：每个纯密钥模型提供商一行
 * （core/auth-keys.ts 的 pi-ai 派生表），通过 keys 接缝按环境优先读取 keyPresent，
 * 每次调用都是最新的 — 保存密钥会立即将提供商联邦化到选择器中。
 *
 * 获取可用的所有提供商信息，并按其显示顺序排序。用于配置页面的渲染。
 * @returns 提供商列表。
 */
export function catalogProviders(): CatalogProvider[] {
	return AUTH_PROVIDER_KEYS.map((p) => ({
		id: p.id,
		envVar: p.envVar,
		keyPresent: keyValue(p.envVar) !== undefined,
	})).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 其密钥存在的提供商 — 选择器精确地联邦化这些（按设计，没有密钥的提供商的模型是不可达的；
 * Keys 页面是发现表面，与搜索相同的规则）。
 */
function keyedProviderIds(): Set<string> {
	return new Set(catalogProviders().filter((p) => p.keyPresent).map((p) => p.id));
}

/** 将一个目录模型投影到客户端 DTO。 */
/**
 * 将底层的 `Model` 引擎配置转为用于传输和在 UI 渲染的简单 DTO（数据传输对象）格式。
 * @param model 需要转换的模型。
 * @returns 扁平化且包含显示标识信息的模型 DTO。
 */
export function toModelDto(model: Model<Api>): ModelDto {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		reasoning: model.reasoning,
		input: [...model.input],
		supportedLevels: getSupportedThinkingLevels(model),
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

/**
 * 实时限制索引（context-meter amendment, owner 2026-09-23）：
 * provider:id → 来自 pi 目录的 contextWindow，覆盖选择器联邦化的相同的（SAME）键控提供商。
 * 每个上下文仪表分母的唯一来源 — stats-bar 连接持有 /api/models 的副本，
 * 并且活动流（observability.ts）通过它在服务器端解析作业限制。
 * 任何地方都没有硬编码的回退：这里缺失的模型读取为 limit-null（仅限使用量，诚实渲染）。
 *
 * 解析并生成当前配置中各模型到其支持的最大上下文长度的映射。
 * 这被用来在上下文压缩等模块中计算安全阀值。
 * @returns 返回字典: `${provider}:${model_id}` -> Context limit tokens。
 */
export function catalogContextLimits(): Map<string, number> {
	const keyed = keyedProviderIds();
	const index = new Map<string, number>();
	for (const provider of piModels().getProviders()) {
		if (!keyed.has(provider.id)) continue;
		for (const model of piModels().getModels(provider.id)) {
			index.set(`${provider.id}:${model.id}`, model.contextWindow);
		}
	}
	return index;
}

/**
 * 完整的选择器负载：每个已配置提供商的每个模型（按提供商然后 id 排序 — 稳定，差异友好）
 * + 无设置聊天运行的配置默认值 + 后台角色的解析绑定（设置 UI 的每个角色的默认标题）。
 *
 * 用于 GET /api/models 接口的主函数。
 * 聚合当前的 `ModelCatalog`、提供商列表、各个等级角色插槽（SlotPins）、以及默认配置。
 * @returns 包括分类列表、提供商以及推荐信息的全量模型配置目录。
 */
export function modelCatalog(): ModelCatalogResponse {
	const keyed = keyedProviderIds();
	const models = piModels()
		.getProviders()
		.filter((p) => keyed.has(p.id))
		.flatMap((p) => piModels().getModels(p.id))
		.map(toModelDto)
		.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
	return {
		models,
		defaults: catalogDefaults(),
		rolePins: catalogRolePins(),
		slots: catalogSlots(),
		providers: catalogProviders(),
	};
}

/** 设置写入的一个经验证结果。 */
export type SettingsValidation =
	| { ok: true }
	| { ok: false; error: string; supported?: ThinkingLevel[] };

/**
 * 针对目录验证选择器写入（设置路由的门控）。
 * `settings` 是整体替换：缺少的字段意味着“配置默认值”。
 *  - model: 必须配置提供商，id 必须存在于其目录中。
 *  - thinkingLevel: 必须在解析模型的支持列表中 — 选择器写入针对的模型
 *    （settings.model，否则为配置的 prober/teacher 绑定；一个控制器，因此这两个规范共享它）。
 *
 * 验证独立聊天会话覆盖（ChatSettings）中的自定义模型配置。
 * 检查模型是否有效存在于图录中，是否支持当前会话的指定思考等级（thinkingLevel）。
 * @param settings 包含自定义模型配置的聊天设置对象。
 * @returns 如果一切合法则 ok 为 true，否则包含详细的报错原因及修正（cleared）建议。
 */
export function validateChatSettings(settings: ChatSettings): SettingsValidation {
	const providers = piModels().getProviders().map((p) => p.id);
	if (settings.model) {
		const { provider, id } = settings.model;
		if (!providers.includes(provider)) {
			return { ok: false, error: `Unknown provider "${provider}" — configured: ${providers.join(", ")}` };
		}
		if (!piModels().getModel(provider, id)) {
			return { ok: false, error: `No model "${id}" in the ${provider} catalog` };
		}
	}
	// BYOK 插曲（owner，2026-09-22）：思考级别从不（NEVER）拒绝写入
	// — 使用固定级别交换模型“就是能工作”（JUST WORKS）。写入会将
	// 绑定钳制到新模型最近的支持级别（下面的 clampChatLevel，由路由应用），
	// 并存储钳制的结果；没有模型支持的裸级别不受检查，并在引擎构建时根据
	// 链后来持有的任何内容进行钳制。
	return { ok: true };
}

/**
 * 验证全局模型偏好配置（ModelsSettings）里的各类插槽绑定（如 strong/cheap/vision）。
 * 遍历每一项检查模型有效性及思考级别的支持性。如果有不支持的高级思考模型被指定，
 * 返回的对象会包含错误以及被自动降级的 `cleared` 配置建议。
 * @param settings 全局模型设置（包含各槽位的映射）。
 * @returns 验证成功或失败信息，及修正后的 settings 拷贝。
 */
export function validateModelsSettings(settings: ModelsSettings): SettingsValidation {
	for (const name of MODEL_SLOTS) {
		const slot = settings[name];
		if (!slot) continue;
		const verdict = validateSlotSpec(name, slot);
		if (!verdict.ok) return verdict;
	}
	return { ok: true };
}

function validateSlotSpec(name: ModelSlotName, slot: { model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel }): SettingsValidation {
	const providers = piModels().getProviders().map((p) => p.id);
	if (slot.model) {
		const { provider, id } = slot.model;
		if (!providers.includes(provider)) {
			return { ok: false, error: `Unknown provider "${provider}" — configured: ${providers.join(", ")}` };
		}
		if (!piModels().getModel(provider, id)) {
			return { ok: false, error: `No model "${id}" in the ${provider} catalog` };
		}
	}
	// BYOK 插曲（owner，2026-09-22）：支持级别的裁决已经死亡（DEAD）
	// — 带有固定级别的插槽写入永远不会被拒绝；写入将级别钳制到模型最近的
	// 支持级别（下面的 clampModelsLevels，由路由应用），并存储钳制的结果。
	return { ok: true };
}

// ─── clamp-on-write (owner ruling, interlude 2026-09-22) ─────────────────────
// 与固定的思考级别进行模型交换必须“就是能工作”（JUST WORK）：该绑定转换为
// 新模型最近的支持级别 — pi 的 clampThinkingLevel，与 piEngineForSpec 在运行时
// 应用的翻译相同 — 钳制后的值将记录在案。服务器是事实：记录在写入后显示钳制后的级别。

/**
 * 根据一个模型钳制一个级别（当模型未知或级别已被支持时保持原样 — 存在性门控会单独拒绝未知模型，
 * 因此在实践中这只看到真实模型）。
 */
function clampLevelFor(provider: string, id: string, level: ThinkingLevel): ThinkingLevel {
	const model = piModels().getModel(provider, id);
	return model ? clampThinkingLevel(model, level) : level;
}

/**
 * 模型部分写入的级别转换：每个槽位的固定 thinkingLevel 根据其自身槽位的模型进行钳制
 * （解析器要求每次插槽写入都必须有一个模型 — owner，2026-09-22）。
 * 纯粹的：目录输入，钳制后的部分输出；路由在验证后应用它。
 *
 * 自动修正并钳制全局模型配置中不兼容的 thinkingLevel 级别（将不支持级别降为其兼容级别，或者 null）。
 * 在发生后台 API 提供商变更或支持变更时可以调用它清洗旧的配置。
 * @param settings 当前的模型设置。
 * @returns 修改（如果需要）兼容后的新模型设置。
 */
export function clampModelsLevels(settings: ModelsSettings): ModelsSettings {
	const out: ModelsSettings = {};
	for (const name of MODEL_SLOTS) {
		const slot = settings[name];
		if (!slot?.model) continue;
		out[name] =
			slot.thinkingLevel !== undefined
				? {
						model: slot.model,
						thinkingLevel: clampLevelFor(slot.model.provider, slot.model.id, slot.thinkingLevel),
					}
				: slot;
	}
	return out;
}

/**
 * 聊天部分写入的级别转换：固定的 thinkingLevel 根据自身模型进行钳制，
 * 否则根据记录的解析 strong 槽位（对话链的回退 — 无设置聊天将运行的模型）。
 * 任何地方都没有模型 → 不受检查地运行（运行时在引擎构建时进行钳制；无论如何，回合门控都会拒绝无模型聊天）。
 *
 * 自动修正并钳制当前对话中独立的模型配置。
 * @param settings 聊天级别设置。
 * @param strong 对应回退/默认的 strong 槽位（用于当聊天覆盖配置为空时的参考）。
 * @returns 调整后的兼容版本。
 */
export function clampChatLevel(settings: ChatSettings, strong: EffectiveSlot | null): ChatSettings {
	if (settings.thinkingLevel === undefined) return settings;
	const provider = settings.model?.provider ?? strong?.provider;
	const id = settings.model?.id ?? strong?.id;
	if (!provider || !id) return settings;
	return { ...settings, thinkingLevel: clampLevelFor(provider, id, settings.thinkingLevel) };
}
