/**
 * auth/keys 组合（auth-keys wave, 2026-09-19）：GET/PUT/DELETE /api/keys
 * 后面的服务器端密钥管理器。
 *
 * 环境接缝（THE ENV SEAM，架构基石）：每个消费者 — models.ts 的
 * openRouterApiKey()、子代理、web.ts、STT 路由 — 都直接读取
 * process.env，并且代理层（agent layer）不能导入存储层（store layer）。
 * 与其跨通道重新连接五个消费者，不如存储层将自己反映（REFLECTS）到子进程的
 * 环境中：在启动时（幂等，像提取注册表一样锚定在 globalThis 上），真实环境中
 * 未设置的每个文件变量都会被间隙填充（fill-gapped）到 process.env 中，并且每次
 * 保存/删除都会同时更新文件 + 环境。因此，密钥立即生效 — 无需重启
 * — 这也是为什么 main.cjs 昔日的启动时注入必须退役的原因：
 * 启动时创建的环境副本会遮蔽每个设置页面的更改，直到重启（环境优先于文件）。
 *
 * 优先级（PRECEDENCE，owner 决定）：真实的系统环境变量（包括开发中的
 * .env.local）始终优先于文件。启动时的真实环境变量每个进程快照一次且从不突变；
 * 对其中一个执行 PUT 会持久化到文件（以防环境消失），并且状态
 * 会如实报告被环境遮蔽（shadowedByEnv）— 页面解释了为什么保存的密钥不是活跃的那个。
 *
 * 文件中未知的变量被逐字保留，并作为通用状态行显示
 * （没有用于编辑的目录表单 — 只有精选的密钥有形状和文档；core/auth-keys.ts）。
 *
 * 新用户开关（THE FRESH-USER SWITCH，owner，interlude 2026-09-22）：
 * LH_IGNORE_ENV_KEYS=1 使每个环境密钥在整个应用范围内不可见（APP-WIDE）— 完全的新用户模拟
 * （全新的空数据目录 + 该开关 = 零密钥，零联邦提供商，设置阶段 1）。
 * 在该开关下，真实环境变量从进程中被删除（不仅仅是被这个接缝忽略）：
 * pi-ai 在每次请求时原生（NATIVELY）从 process.env 解析提供商密钥
 * （auth/context.js 的 defaultProviderAuthContext 读取实时环境），因此
 * 删除是向每个消费者隐藏密钥的唯一机制 — 包括模型引擎。只有文件存储
 * （auth.json）有效；间隙填充仍然反映文件密钥，因此新用户可以在会话中途添加密钥，
 * 引擎无需重启即可看到它们。未设置开关 = 今天的行为，逐字节相同。
 */

import {
	AUTH_KEYS,
	AUTH_PROVIDER_KEYS,
	AUTH_PROVIDER_ENV_VARS,
	type AuthKeyInfo,
	type AuthKeyStatus,
	genericProviderKeyGuard,
	isKnownAuthKey,
	isProviderEnvVar,
	maskKey,
	validateKeyShape,
} from "../core/auth-keys.ts";
import { authStore } from "../store/auth.ts";

// 每个进程一次的启动记录 — globalThis 锚点（HMR 重新导入模块；
// 快照绝不能重新运行并将间隙填充的变量误读为真实环境）。
// 与 globalThis.__lhExtractionRuns 相同的模式。
interface AuthBoot {
	/**
	 * 首次初始化时在真实环境（REAL env）中的变量 — 环境优先级的不可触摸集。
	 * 间隙填充的变量是我们设置的所有其他变量。
	 */
	realEnv: Set<string>;
	/** 我们（WE）放入 process.env 的变量（文件的反映） — 可删除。 */
	fillGap: Set<string>;
}
const BOOT_KEY = Symbol.for("lh.authBoot");

function boot(): AuthBoot {
	const g = globalThis as Record<symbol, AuthBoot | undefined>;
	if (!g[BOOT_KEY]) g[BOOT_KEY] = { realEnv: new Set(), fillGap: new Set() };
	return g[BOOT_KEY];
}

/**
 * `id` 是否是一个可写的密钥名称 — 精选目录或模型提供商环境变量
 * （提供商密钥插曲：PUT/DELETE 接受两者）。
 *
 * 检查指定的键 ID 是否允许由应用写入（在可写入白名单中）。
 * 只有属于 `AUTH_KEYS` 中定义的提供商及服务密钥才可以被持久化存储。
 * @param id 密钥的唯一标识（一般对应大写的环境变量名）。
 * @returns 是否允许写入。
 */
export function isWritableAuthKey(id: string): boolean {
	return isKnownAuthKey(id) || isProviderEnvVar(id);
}

/**
 * 设置页面的提供商下拉列表：每个接受纯文本密钥的 pi-ai 提供商
 * （{id, envVar, label} — 无漂移固定，参见 core/auth-keys.ts 和
 * tests/auth-provider-keys.test.ts 中表格的文档）。按 id 排序以获得稳定的有效负载。
 *
 * 获取当前所有受支持和允许持久化的认证密钥元数据列表。
 * @returns `AUTH_KEYS` 配置对象的数组表示。
 */
export function providerKeyList() {
	return [...AUTH_PROVIDER_KEYS].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 新用户开关（owner，interlude 2026-09-22）：环境密钥在整个应用范围内不可见
 * — 在启动时从进程中删除，仅限文件密钥。
 * 每次调用时实时读取（启动器在启动前导出它）。
 *
 * 检查是否启动了 "忽略环境变量密钥" 模式 (`LH_IGNORE_ENV_KEYS`)。
 * @returns 如果设置为 "1"，则返回 true（忽略系统的环境变量，仅使用本地存储）。
 */
export function envKeysIgnored(): boolean {
	return process.env.LH_IGNORE_ENV_KEYS === "1";
}

/**
 * 启动间隙填充（boot fill-gap） — 幂等的。第一次调用会对哪些托管名称是真实环境进行快照；
 * 后续调用（HMR 重新导入，或在手动编辑后）仅填充环境中仍未设置的变量，
 * 因此通过 API 删除的变量永远不会复活（其文件条目也消失了）。
 *
 * 启动时初始化认证环境变量：将本地存储（`.env.local` 之类的机制或应用内文件）中的密钥合并到 `process.env` 中。
 * 这个动作确保了 `pi-ai` 等底层包无需更改逻辑即可正常读取到用户填写的 API Key。
 * （该函数在启动阶段被调用一次）
 */
export function initAuthEnv(): void {
	const record = boot();
	const fileVars = authStore.authVars();
	const managed = new Set<string>([
		...Object.keys(fileVars),
		...AUTH_KEYS.map((k) => k.id),
		// Provider env vars are managed names too (provider-keys interlude):
		// an env-exported OPENAI_API_KEY with a file copy gets honest shadow
		// semantics, exactly like the curated vars.
		...AUTH_PROVIDER_KEYS.map((p) => p.envVar),
	]);
	if (envKeysIgnored()) {
		// THE FRESH-USER SWITCH: delete every managed env var (re-run on
		// every call — a reintroduced var never resurrects). realEnv stays
		// EMPTY (nothing counts as env); the fill-gap below then reflects
		// auth.json keys so engines still see mid-session additions.
		for (const name of managed) {
			delete process.env[name];
		}
	} else if (record.realEnv.size === 0 && record.fillGap.size === 0) {
		// First init in this process: what's already in the env is REAL env.
		for (const name of managed) {
			if (process.env[name] !== undefined) record.realEnv.add(name);
		}
	}
	for (const [name, value] of Object.entries(fileVars)) {
		if (!isManagedName(name)) continue;
		if (process.env[name] === undefined) {
			process.env[name] = value;
			record.fillGap.add(name);
		}
	}
}

/**
 * 这个环境变量名称是密钥系统管理的吗（精选的、提供商的、或保存在文件中的）？
 */
function isManagedName(name: string): boolean {
	return isWritableAuthKey(name) || name in authStore.authVars();
}

/**
 * 纯状态投影 — 导出用于测试。`env` 是实时进程环境视图；
 * `realEnv` 是启动快照（环境优先级）。
 *
 * 纯粹的认证状态解析计算，用于生成包含状态的列表给 UI 展示，同时也作为可导出的纯逻辑供测试使用。
 * 计算结果反映某个键：它是缺失的、还是由环境变量注入的，抑或是保存在本地文件的。
 * @param catalog 系统支持的全部密钥清单配置。
 * @param readRecord 从本地存储读取当前保存值的回调。
 * @param env 运行时环境变量对象（`process.env`）。
 * @returns 每个键的详细状态。
 */
export function resolveKeyStatuses(
	fileVars: Record<string, string>,
	env: Record<string, string | undefined>,
	realEnv: ReadonlySet<string>,
	/**
	 * 模型提供商环境变量（提供商密钥插曲）：存在的（PRESENT）加入状态行 —
	 * 缺失的永远不会成为垃圾信息（下拉列表是发现表面）。
	 * 无论是否存在，精选密钥始终获得行。
	 */
	providerEnvVars: ReadonlySet<string> = new Set(),
): AuthKeyStatus[] {
	const ids = new Set<string>([...AUTH_KEYS.map((k) => k.id), ...Object.keys(fileVars)]);
	for (const envVar of providerEnvVars) {
		if (env[envVar] !== undefined || fileVars[envVar] !== undefined) ids.add(envVar);
	}
	const rows: AuthKeyStatus[] = [];
	for (const id of ids) {
		const envValue = env[id];
		const fileValue = fileVars[id];
		const isRealEnv = realEnv.has(id);
		// Env wins: the live value is the env's when set (real or reflected —
		// post fill-gap the file's values LIVE in env, so realEnv is what
		// distinguishes a REAL env var from the store's own reflection).
		const live = envValue !== undefined ? envValue : fileValue;
		rows.push({
			id,
			info: AUTH_KEYS.find((k) => k.id === id) ?? null,
			present: live !== undefined,
			masked: live !== undefined ? `${maskKey(live)} (${live.trim().length} chars)` : null,
			source: isRealEnv ? "env" : live !== undefined ? "file" : "none",
			shadowedByEnv: isRealEnv && fileValue !== undefined && envValue !== fileValue,
		});
	}
	return rows;
}

/** GET 视图：每个精选密钥（无论是否存在）+ 未知文件变量。 */
/**
 * 获取实际的密钥配置状态列表（用于前端展示每个服务密钥当前是配置在 ENV 还是 FILE 或者是缺失）。
 * @returns 密钥状态列表。
 */
export function keyStatuses(): AuthKeyStatus[] {
	return resolveKeyStatuses(authStore.authVars(), process.env, boot().realEnv, AUTH_PROVIDER_ENV_VARS);
}

/**
 * 一个变量的实时值，环境优先（env-wins 规则） — 不在 @/src/server 桶（barrel）后面的消费者的
 * 规范读取（STT 路由是唯一冷启动漏洞：否则，对它的第一次请求会在任何间隙填充运行之前读取环境）。
 *
 * 获取指定 ID 密钥的当前真实值。
 * 读取逻辑为：如果未开启屏蔽 ENV 功能，优先读取 `process.env`（可能来自环境变量或之前被文件填充），
 * 否则仅读取本地存储。
 * @param id 密钥的环境变量名（如 `OPENAI_API_KEY`）。
 * @returns 密钥字符串，如果不存在则返回 undefined。
 */
export function keyValue(id: string): string | undefined {
	// The fresh-user switch: ONLY the file store counts (belt-and-
	// suspenders — the boot deletion already emptied the env; this guards
	// any env key reintroduced after boot).
	if (envKeysIgnored()) return authStore.authVars()[id];
	return process.env[id] ?? authStore.authVars()[id];
}

/**
 * 一个模型提供商的密钥存在真相（提供商密钥插曲，2026-09-25）：
 * 该提供商的密钥在请求时会存在吗？
 * 通过 keyValue 读取 — 与 pi-ai 在每次请求时原生执行的相同的（SAME）环境优先查找 —
 * 因此被环境遮蔽的密钥算作存在（按将要运行的内容进行门控）。
 * AUTH_PROVIDER_KEYS 中没有的提供商根本不需要密钥：没有需要门控的东西，根据定义存在。
 *
 * 判断指定提供商 (Provider) 的密钥是否可用。
 * 它会查找提供商映射到的对应环境变量是否在当前运行时存在值。
 * @param provider 提供商名称 (例如 "openai", "anthropic")。
 * @returns 可用时返回 true。
 */
export function providerKeyPresent(provider: string): boolean {
	const info = AUTH_PROVIDER_KEYS.find((p) => p.id === provider);
	return info ? keyValue(info.envVar) !== undefined : true;
}

/**
 * 保存一个密钥（PUT）。首先是形状门控（owner decision：错误的粘贴返回 400，从不存储），
 * 然后是文件写入，然后是环境反映。真实（REAL）环境拥有的变量不会被反映
 * （环境优先 — 状态行报告 shadowedByEnv，以便页面可以解释它）。
 *
 * 保存或更新一个密钥值。
 * 它会先验证键是否允许写入，然后存入本地存储，如果当前未屏蔽 ENV，则将其注入 `process.env` 以立即生效。
 * @param id 密钥名称。
 * @param value 密钥的具体内容。
 * @returns 成功则返回新状态，否则返回错误信息。
 */
export function saveKey(id: string, value: string): { ok: true; status: AuthKeyStatus } | { ok: false; error: string } {
	const shape = isProviderEnvVar(id) ? genericProviderKeyGuard(id, value) : validateKeyShape(id, value);
	if (!shape.ok) return { ok: false, error: shape.error };
	const trimmed = value.trim();
	authStore.setAuthVar(id, trimmed);
	const record = boot();
	if (!record.realEnv.has(id)) {
		process.env[id] = trimmed;
		record.fillGap.add(id);
	}
	// validateKeyShape guarantees catalog membership, so the row exists.
	return { ok: true, status: keyStatuses().find((s) => s.id === id)! };
}

/**
 * 删除一个密钥（DELETE）：始终从文件中消失；只有当环境副本是我们自己创建的（间隙填充）时，
 * 才从环境中消失 — 真实环境变量保留（环境优先），状态显示密钥仍从环境中存在。
 *
 * 删除本地保存的某个密钥。
 * 只会删除本地文件存储并清理被注入到 `process.env` 中的同名本地残留。
 * 注意：真正定义在系统环境变量中的原始值不会被删除。
 * @param id 密钥名称。
 * @returns 删除操作后的键最新状态。
 */
export function deleteKey(id: string): AuthKeyStatus {
	authStore.deleteAuthVar(id);
	const record = boot();
	if (record.fillGap.has(id) && !record.realEnv.has(id)) {
		delete process.env[id];
		record.fillGap.delete(id);
	}
	return keyStatuses().find((s) => s.id === id)!;
}

// Reflect the file into the env at first import (idempotent; the module is
// imported by every route/handler path that touches keys).
initAuthEnv();
