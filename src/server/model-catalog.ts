/**
 * The model catalog's server surface (model-control wave, 2026-09-12;
 * federated since the model-slots wave, 2026-09-20): pi-ai's catalog for
 * every KEYED provider, projected to client-safe DTOs for the picker (GET
 * /api/models), plus the validation gate for settings writes (PUT
 * /api/settings/* — the per-chat settings PUT is retired from the UI;
 * legacy records' per-chat overrides still resolve server-side).
 *
 * pi-ai owns ALL the data: the catalog (id/name/cost/context/modality/
 * thinkingLevelMap) and the per-model thinking truth
 * (getSupportedThinkingLevels / clampThinkingLevel). This module only
 * projects and validates — no second registry to drift out of sync.
 *
 * Federation: `getModels()` is called per keyed provider (federated, the
 * model-slots wave), so a provider appears in the picker exactly when its
 * key is present — piModels() in src/agent/models.ts owns the provider
 * set; nothing here changes.
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

/** The picker's client-safe model entry (contract: core/contracts/models.ts). */
export type ModelDto = ModelCatalogEntry;

/**
 * The conversation agents' resolved default (pure form — the strong slot
 * in, CatalogDefaults out; `catalogDefaults()` below is the fs wrapper).
 * PER-SESSION MODELS (owner, 2026-09-28): every session owns its model +
 * thinking level from birth, stamped verbatim from the strong slot — the
 * STRONG SLOT IS THE NEW-SESSION DEFAULT, and the resolve-time fallback
 * for legacy settings-less records. BYOK (owner, 2026-09-22): there is no
 * factory floor — when the strong slot names no model, the default is
 * NULL and the turn gate refuses with the 503 models_not_configured
 * envelope. An unset thinkingLevel resolves from DEFAULT_THINKING_ORDER at
 * engine build (reported as absent here).
 */
/**
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

/** The conversation agents' resolved default — what a settings-less chat
 *  runs: the strong slot, i.e. the birth-default for new sessions. */
/**
 * 解析系统级的所有模型默认选项（用于首选项/备用填充）。
 * @returns 包含各提供商的推荐模型映射对象。
 */
export function catalogDefaults(): CatalogDefaults | null {
	return catalogDefaultsFor(effectiveSettings().models.strong);
}

/** Project the resolved per-role specs to the client DTO (pure — the
 *  settings UI's "Default: <actual pinned model>" caption reads this).
 *  BYOK (owner, 2026-09-22): an empty chain projects to NULL — the caption
 *  honestly shows "not configured", never a phantom default. */
/**
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

/** The background roles' RESOLVED pins: the user's agent-models
 *  override → tier slot → nothing — the same resolution the agent wiring
 *  uses (src/server/stores.ts effectiveSettings), so the caption can
 *  never drift from what actually runs. */
/**
 * 集中获取全系统定义的各模型角色对应推荐的模型配置。
 * @returns 各角色绑定的模型及选项信息。
 */
export function catalogRolePins(): RolePins {
	return rolePinsFor(effectiveSettings().agent.models);
}

/** The three slot tiers' RESOLVED pins — effectiveSettings().models
 *  verbatim: the same resolution the engine wiring uses, so the Models
 *  settings page's captions cannot drift from what actually runs. NULL
 *  per tier that holds no model. */
/**
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

/** The providers surface (model slots wave, 2026-09-20): one row per
 *  plain-key model provider (core/auth-keys.ts's pi-ai-derived table),
 *  with keyPresent read env-wins through the keys seam, fresh per call —
 *  saving a key immediately federates the provider into the picker. */
/**
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

/** The providers whose key is present — the picker federates exactly
 *  these (a keyless provider's models are unreachable by design; the
 *  Keys page is the discovery surface, same discipline as search). */
function keyedProviderIds(): Set<string> {
	return new Set(catalogProviders().filter((p) => p.keyPresent).map((p) => p.id));
}

/** Project one catalog model to the client DTO. */
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

/** The live-limits index (context-meter amendment, owner 2026-09-23):
 *  provider:id → contextWindow from pi's catalog, over the SAME keyed
 *  providers the picker federates. The one source for every context
 *  meter's denominator — the stats-bar join holds /api/models' copy,
 *  and the activity feed (observability.ts) resolves job limits
 *  server-side through this. No hardcoded fallback exists anywhere:
 *  a model missing here reads limit-null (usage-only, honest render). */
/**
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

/** The full picker payload: every model of every configured provider
 *  (sorted by provider then id — stable, diff-friendly) + the config
 *  defaults a settings-less chat runs + the background roles' resolved
 *  pins (the settings UI's per-role default captions). */
/**
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

/** One validated outcome for a settings write. */
export type SettingsValidation =
	| { ok: true }
	| { ok: false; error: string; supported?: ThinkingLevel[] };

/** Validate a picker write against the catalog (the settings route's gate).
 *  `settings` is replace-whole: absent fields mean "config default".
 *  - model: provider must be configured, id must exist in its catalog.
 *  - thinkingLevel: must be in the resolved model's supported list —
 *    the model the picker writes against (settings.model, else config's
 *    prober/teacher pin; one controller, so the two specs share it). */
/**
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
	// BYOK interlude (owner, 2026-09-22): thinking levels NEVER reject a
	// write — a model swap with a pinned level JUST WORKS. The WRITE clamps
	// the pin to the new model's nearest supported level (clampChatLevel
	// below, applied by the routes) and stores the clamped result; a bare
	// level with no model anywhere rides unchecked and clamps against
	// whatever the chain later holds at engine build.
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
	// BYOK interlude (owner, 2026-09-22): the supported-level verdict is
	// DEAD — a slot write with a pinned level never rejects; the WRITE
	// clamps the level to the model's nearest supported (clampModelsLevels
	// below, applied by the route) and stores the clamped result.
	return { ok: true };
}

// ─── clamp-on-write (owner ruling, interlude 2026-09-22) ─────────────────────
// A model swap with a pinned thinking level must JUST WORK: the pin
// translates to the new model's nearest supported level — pi's
// clampThinkingLevel, the SAME translation piEngineForSpec applies at
// runtime — and the clamped value is what lands in the record. The
// server is the truth: the record shows the clamped level after write.

/** Clamp one level against one model (identity when the model is unknown
 *  or the level already supported — the existence gate rejects unknown
 *  models separately, so this only ever sees real ones in practice). */
function clampLevelFor(provider: string, id: string, level: ThinkingLevel): ThinkingLevel {
	const model = piModels().getModel(provider, id);
	return model ? clampThinkingLevel(model, level) : level;
}

/** The models-section write's level translation: every slot's pinned
 *  thinkingLevel clamps against THE SLOT'S OWN model (the parser requires
 *  a model on every slot write — owner, 2026-09-22). Pure: catalog in,
 *  clamped section out; the route applies it after validation. */
/**
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

/** The chat-section write's level translation: a pinned thinkingLevel
 *  clamps against the body's own model, else the record's resolved strong
 *  slot (the conversation chain's fallback — what a settings-less chat
 *  would run). No model anywhere → rides unchecked (runtime clamps at
 *  engine build; the turn gate refuses the model-less chat anyway). */
/**
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
