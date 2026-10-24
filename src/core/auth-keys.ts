/**
 * 精选的授权密钥目录及形状验证规则 (2026-09-19 引入)。
 * 纯逻辑(PURE)，浏览器安全 — 不依赖文件系统 (fs) 或环境变量 (env)。
 * 该目录驱动授权页面的密钥列表展示（包括标签、描述、获取密钥的文档链接），
 * 并用于写入时的形状验证（所有者决策：仅验证形状，不进行实时连通性测试 —
 * 吊销的密钥在实际调用失败前看起来是正常的；这是权衡后不主动向提供商发送请求的结果）。
 *
 * 存储本身是一个长期存在的扁平键值对映射 {变量名: 值}，保存在 auth.json 中
 * (参见 config.AUTH_FILE)：密钥的标识符就是它们的“环境变量名” — 也就是
 * 现今消费者读取时使用的名称（例如 OPENROUTER_API_KEY，…），
 * 因此目录的 ID 既是文件中的键名，也是环境变量名，全局统一命名。
 *
 * 如果在文件中发现了未知变量（不在当前目录中的键），它们将被原样保留 (PRESERVED)，
 * 并作为通用条目展示 — 这是为了向下兼容未来的新条目（如登录令牌），
 * 而无需更改数据结构。但是，通过精选 API 无法手动编辑这些未知键
 * （只有目录中的键才具有值得校验的数据形状以及值得展示的文档链接）。
 */

/** 单个精选密钥条目。`id` 即为环境变量名/文件中的键名。 */
export interface AuthKeyInfo {
	id: string;
	/** 用于在设置页面展示的人类可读标签。 */
	label: string;
	/** 简明扼要的一句话说明该密钥的用途。 */
	description: string;
	/** 用户获取密钥的地址 (通过壳层在真实的浏览器中打开)。 */
	docsUrl: string;
}

/** 精选授权密钥的预定义配置列表 */
export const AUTH_KEYS: readonly AuthKeyInfo[] = [
	{
		id: "DEEPGRAM_API_KEY",
		label: "Deepgram",
		description: "用于听写的语音转文本密钥 — 需要在 Deepgram 控制台中拥有 ≥ Member(成员) 权限才能生成令牌。",
		docsUrl: "https://console.deepgram.com/",
	},
	{
		id: "TAVILY_API_KEY",
		label: "Tavily",
		description: "供研究员子代理使用的网络搜索引擎 (AI原生搜索 API)。设置此密钥即可激活它 — 不需要额外的引擎切换按钮。",
		docsUrl: "https://app.tavily.com/",
	},
	{
		id: "BRAVE_API_KEY",
		label: "Brave Search",
		description: "供研究员子代理使用的网络搜索引擎 — Tavily 的替代方案。设置此密钥即可激活它。",
		docsUrl: "https://brave.com/search/api/",
	},
] as const;

/** 已知授权密钥 ID 集合 */
const AUTH_KEY_IDS: ReadonlySet<string> = new Set(AUTH_KEYS.map((k) => k.id));

/**
 * 检查给定的 ID 是否是已知的精选授权密钥。
 * @param id 要检查的密钥 ID
 * @returns 如果是已知密钥则返回 true，否则返回 false
 */
export function isKnownAuthKey(id: string): boolean {
	return AUTH_KEY_IDS.has(id);
}

/**
 * 设置页面下拉列表中的模型提供商密钥配置行：
 * 包含这是哪个 pi-ai 提供商，其密钥关联的环境变量名，
 * 以及人类可读的标签 (通常为 pi 内部 Provider.name)。
 */
export interface AuthProviderInfo {
	id: string;
	envVar: string;
	label: string;
}

/**
 * 模型提供商密钥表 (2026-09-19 引入)：
 * 包含每一个接受“普通 API 密钥环境变量”的 pi-ai 提供商 — 该表是在构建时从
 * pi-ai 自身的 provider→env-var 映射表派生而来的，因此它绝不会与 pi 实际读取的内容产生偏差：
 * tests/auth-provider-keys.test.ts 测试文件会从 pi-ai 中重新推导真相
 * (通过组合 builtinProviders 以及一个包含所有变量的代理环境去调用 findEnvKeys)，
 * 并断言与该表完全相等 — 当 pi-ai 升级并添加/重命名提供商密钥时，测试将大声失败以阻止合并，
 * 而不是在静默中产生差异。
 *
 * 根据所有者规范，以下情况被排除 (当前阶段授权方式不是普通密钥的提供商)：
 * github-copilot (OAuth), amazon-bedrock (AWS 凭据), google-vertex (ADC),
 * azure (需要基础 URL), cloudflare 的账户范围密钥对。
 * Anthropic 仅保留 ANTHROPIC_API_KEY — 它的 AUTH_TOKEN/OAUTH_TOKEN 替代方案仅保留在环境变量中。
 * openai-codex 没有暴露 env-key (自然缺席)。
 * 共享同一个环境变量的提供商 (如 moonshotai / moonshotai-cn, opencode / opencode-go,
 * qwen-token-plan 系列, xiaomi 变体等) 仍各自保留独立的行 — 用户界面(UI)可以自由对它们进行分组。
 */
export const AUTH_PROVIDER_KEYS: readonly AuthProviderInfo[] = [
	{ id: "ant-ling", envVar: "ANT_LING_API_KEY", label: "Ant Ling" },
	{ id: "anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
	{ id: "baseten", envVar: "BASETEN_API_KEY", label: "Baseten" },
	{ id: "cerebras", envVar: "CEREBRAS_API_KEY", label: "Cerebras" },
	{ id: "deepseek", envVar: "DEEPSEEK_API_KEY", label: "DeepSeek" },
	{ id: "fireworks", envVar: "FIREWORKS_API_KEY", label: "Fireworks" },
	{ id: "google", envVar: "GEMINI_API_KEY", label: "Google" },
	{ id: "groq", envVar: "GROQ_API_KEY", label: "Groq" },
	{ id: "huggingface", envVar: "HF_TOKEN", label: "Hugging Face" },
	{ id: "kimi-coding", envVar: "KIMI_API_KEY", label: "Kimi For Coding" },
	{ id: "meta", envVar: "META_API_KEY", label: "Meta" },
	{ id: "minimax", envVar: "MINIMAX_API_KEY", label: "MiniMax" },
	{ id: "minimax-cn", envVar: "MINIMAX_CN_API_KEY", label: "MiniMax CN" },
	{ id: "mistral", envVar: "MISTRAL_API_KEY", label: "Mistral" },
	{ id: "moonshotai", envVar: "MOONSHOT_API_KEY", label: "Moonshot AI" },
	{ id: "moonshotai-cn", envVar: "MOONSHOT_API_KEY", label: "Moonshot AI CN" },
	{ id: "nvidia", envVar: "NVIDIA_API_KEY", label: "NVIDIA" },
	{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" },
	{ id: "opencode", envVar: "OPENCODE_API_KEY", label: "OpenCode Zen" },
	{ id: "opencode-go", envVar: "OPENCODE_API_KEY", label: "OpenCode Go" },
	{ id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter" },
	{ id: "qwen-token-plan", envVar: "QWEN_TOKEN_PLAN_API_KEY", label: "Qwen Token Plan" },
	{ id: "qwen-token-plan-cn", envVar: "QWEN_TOKEN_PLAN_CN_API_KEY", label: "Qwen Token Plan CN" },
	{ id: "qwen-token-plan-individual", envVar: "QWEN_TOKEN_PLAN_API_KEY", label: "Qwen Token Plan Individual" },
	{ id: "radius", envVar: "RADIUS_API_KEY", label: "Radius" },
	{ id: "together", envVar: "TOGETHER_API_KEY", label: "Together" },
	{ id: "typesafe", envVar: "TYPESAFE_API_KEY", label: "TypeSafe" },
	{ id: "vercel-ai-gateway", envVar: "AI_GATEWAY_API_KEY", label: "Vercel AI Gateway" },
	{ id: "xai", envVar: "XAI_API_KEY", label: "xAI" },
	{ id: "xiaomi", envVar: "XIAOMI_API_KEY", label: "Xiaomi" },
	{ id: "xiaomi-token-plan-ams", envVar: "XIAOMI_TOKEN_PLAN_AMS_API_KEY", label: "Xiaomi Token Plan AMS" },
	{ id: "xiaomi-token-plan-cn", envVar: "XIAOMI_TOKEN_PLAN_CN_API_KEY", label: "Xiaomi Token Plan CN" },
	{ id: "xiaomi-token-plan-sgp", envVar: "XIAOMI_TOKEN_PLAN_SGP_API_KEY", label: "Xiaomi Token Plan SGP" },
	{ id: "zai", envVar: "ZAI_API_KEY", label: "Z.AI" },
	{ id: "zai-coding-cn", envVar: "ZAI_CODING_CN_API_KEY", label: "Z.AI Coding CN" },
] as const;

/**
 * 模型提供商密钥所关联的所有不同的环境变量集合
 * (写入端的“可写性”检查 — 见下文 isProviderEnvVar；同时它也决定了
 * 哪些已存在的提供商变量应作为状态行显示)。
 */
export const AUTH_PROVIDER_ENV_VARS: ReadonlySet<string> = new Set(AUTH_PROVIDER_KEYS.map((p) => p.envVar));

/**
 * 检查此环境变量名是否属于某个 pi-ai 模型提供商的密钥？
 * @param envVar 环境变量名称
 * @returns 包含在提供商列表则返回 true
 */
export function isProviderEnvVar(envVar: string): boolean {
	return AUTH_PROVIDER_ENV_VARS.has(envVar);
}

/** 形状检查(Shape-check)的结果类型：如果成功则 ok 为 true，如果失败则包含返回给用户的 400 错误信息。 */
export type KeyShapeResult = { ok: true } | { ok: false; error: string };

/**
 * 写入端的形状校验门控 (所有者决策：通过 400 状态码拒绝不良的粘贴内容 —
 * 截断或不符合对应格式家族的密钥绝对不能保存入库)。
 * 值在校验前会先被修剪去头尾空白符 TRIMMED (粘贴卫生处理)；修剪后如果为空则始终失败。
 *
 * 精选(CURATED)密钥包含特定的家族规则 (例如 Tavily 的前缀是 tvly-…；Brave 和
 * Deepgram 没有公开特定的格式 — 因此只应用长度下限和粘贴卫生处理)。
 *
 * 模型提供商 (MODEL-PROVIDER) 的密钥则使用下方的 genericProviderKeyGuard
 * (因为提供商的密钥格式各异 — 所以只适用粘贴卫生处理；所有者规范为：最小长度约为12，且不能有空白符)。
 * 在提供商密钥过渡期，OPENROUTER_API_KEY 被移入此通用守护函数 — 不再进行 sk-or 家族格式校验。
 *
 * @param id 密钥 ID（环境变量名）
 * @param rawValue 未处理的原始密钥值
 * @returns 检查结果对象
 */
export function validateKeyShape(id: string, rawValue: string): KeyShapeResult {
	const value = rawValue.trim();
	// 辅助函数：校验非空、最小长度且不包含空白字符
	const nonEmpty = (min: number) =>
		value.length >= min && !/\s/.test(value)
			? { ok: true as const }
			: { ok: false as const, error: `${id} must be at least ${min} characters with no whitespace` };
	switch (id) {
		case "TAVILY_API_KEY":
			return value.startsWith("tvly-")
				? nonEmpty(20)
				: { ok: false, error: `${id} must start with "tvly-" (Tavily's key format)` };
		case "BRAVE_API_KEY":
			// 没有公开的统一格式 — 只有长度下限和基本的粘贴卫生校验。
			return nonEmpty(20);
		case "DEEPGRAM_API_KEY":
			// 没有公开的统一格式 — 长度下限主要是用来捕捉不完整的粘贴截断情况。
			return nonEmpty(20);
		default:
			return { ok: false, error: `unknown key "${id}" (supported: ${[...AUTH_KEY_IDS].join(", ")})` };
	}
}

/**
 * 面向模型提供商 (MODEL-PROVIDER) 密钥的通用截断保护器
 * (由于不同提供商的密钥族格式不同 — 此处仅应用粘贴卫生处理；
 * 根据所有者规范：修剪首尾空白、不允许有中间空格、最小长度为 12 字符)。
 *
 * @param id 密钥 ID (环境变量名)
 * @param rawValue 未处理的原始密钥值
 * @returns 检查结果对象
 */
export function genericProviderKeyGuard(id: string, rawValue: string): KeyShapeResult {
	const value = rawValue.trim();
	if (value.length >= 12 && !/\s/.test(value)) return { ok: true };
	return { ok: false, error: `${id} must be at least 12 characters with no whitespace` };
}

/**
 * 对密钥进行掩码脱敏。被脱敏处理的密钥绝不会以明文形式离开服务器
 * (所有者决策：展示最后的 4 个字符以标识密钥长度 — 这足以在轮换多个密钥时进行识别，
 * 并能让人发现误粘贴了其他家族的密钥)。
 *
 * @param value 需要脱敏的原始密钥
 * @returns 脱敏后的字符串（例如：…aB34）
 */
export function maskKey(value: string): string {
	const v = value.trim();
	if (v.length <= 4) return `…${v}`; // 退化粘贴情况（密钥过短）— 依然不能返回完整的明文
	return `…${v.slice(-4)}`;
}

/** 用于 GET 视图请求的单个密钥状态行数据结构 (绝对不会携带明文信息)。 */
export interface AuthKeyStatus {
	id: string;
	/** 如果是精选目录内的密钥则包含其元数据；对于未知的文件内变量，此值为 null
	 *  (未知变量会被原样保留并显示，但没有表单支持通过精选 API 修改)。 */
	info: AuthKeyInfo | null;
	/** 当前密钥是否存在 (环境变量或者文件中只要有一处存在，即为存在)。 */
	present: boolean;
	/** 脱敏后的尾部字符串，(以前还包括字符长度统计例如 "…ab12 (64 chars)"，目前只保留掩码结果)。 */
	masked: string | null;
	/** 当前生效值的来源。在优先级上，"env"（环境变量）胜过 "file"（文件）。"none" 表示全都不存在。 */
	source: "env" | "file" | "none";
	/** 当文件内保存了密钥值，但却被环境变量中的值覆盖（屏蔽）时，该值为 true —
	 *  这样在设置页面上可以向用户解释为什么他们保存的密钥没有生效。 */
	shadowedByEnv: boolean;
}
