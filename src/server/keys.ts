/**
 * The auth/keys composition (auth-keys wave, 2026-09-19): the server-side
 * key manager behind GET/PUT/DELETE /api/keys.
 *
 * THE ENV SEAM (the architecture keystone): every consumer — models.ts's
 * openRouterApiKey(), the sub-agents, web.ts, the STT route — reads
 * process.env directly, and the agent layer may not import the store
 * layer. Instead of rewiring five consumers across lanes, the store
 * REFLECTS itself into the child's env: at boot (idempotent, anchored on
 * globalThis like the extraction registry) every file var UNSET in the
 * real env is fill-gapped into process.env, and each save/delete updates
 * file + env together. Keys therefore take effect immediately — no restart
 * — which is also why main.cjs's old spawn-time injection HAD to retire:
 * an env copy made at spawn would shadow every settings-page change until
 * restart (env wins over file).
 *
 * PRECEDENCE (owner decision): real environment variables (incl.
 * .env.local in dev) always win over the file. Boot-time real-env vars
 * are snapshotted once per process and never mutated; a PUT to one of
 * them persists to the file (for when the env goes away) and the status
 * honestly reports shadowedByEnv — the page explains why the saved key
 * is not the live one.
 *
 * Unknown vars in the file are preserved verbatim and surfaced as
 * generic status rows (no catalog form to edit through — only curated
 * keys have shapes and docs; core/auth-keys.ts).
 *
 * THE FRESH-USER SWITCH (owner, interlude 2026-09-22): LH_IGNORE_ENV_KEYS=1
 * makes every env key invisible APP-WIDE — the exact new-user simulation
 * (a fresh empty data dir + the switch = zero keys, zero federated
 * providers, setup stage 1). Under the switch real env vars are DELETED
 * from the process (not merely ignored by this seam): pi-ai resolves
 * provider keys from process.env NATIVELY at every request
 * (auth/context.js's defaultProviderAuthContext reads live env), so
 * deletion is the one mechanism that hides keys from every consumer —
 * model engines included. Only the file store (auth.json) counts; the
 * fill-gap still reflects file keys so a fresh user can add keys
 * mid-session and the engines see them with no restart. Unset switch =
 * today's behavior, byte-for-byte.
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

// The once-per-process boot record — globalThis anchor (HMR re-imports the
// module; the snapshot must not re-run and misread fill-gapped vars as real
// env). Same pattern as globalThis.__lhExtractionRuns.
interface AuthBoot {
	/** Vars that were in the REAL env at first init — env precedence's
	 *  untouchable set. Fill-gapped vars are everything else we set. */
	realEnv: Set<string>;
	/** Vars WE put into process.env (the file's reflection) — deletable. */
	fillGap: Set<string>;
}
const BOOT_KEY = Symbol.for("lh.authBoot");

function boot(): AuthBoot {
	const g = globalThis as Record<symbol, AuthBoot | undefined>;
	if (!g[BOOT_KEY]) g[BOOT_KEY] = { realEnv: new Set(), fillGap: new Set() };
	return g[BOOT_KEY];
}

/** Is `id` a WRITABLE key name — curated catalog or model-provider env
 *  var (provider-keys interlude: PUT/DELETE accept both). */
/**
 * 检查指定的键 ID 是否允许由应用写入（在可写入白名单中）。
 * 只有属于 `AUTH_KEYS` 中定义的提供商及服务密钥才可以被持久化存储。
 * @param id 密钥的唯一标识（一般对应大写的环境变量名）。
 * @returns 是否允许写入。
 */
export function isWritableAuthKey(id: string): boolean {
	return isKnownAuthKey(id) || isProviderEnvVar(id);
}

/** The settings page's provider dropdown: every pi-ai provider that takes
 *  a plain key ({id, envVar, label} — no-drift-pinned, see the table's doc
 *  in core/auth-keys.ts and tests/auth-provider-keys.test.ts). Sorted by
 *  id for a stable payload. */
/**
 * 获取当前所有受支持和允许持久化的认证密钥元数据列表。
 * @returns `AUTH_KEYS` 配置对象的数组表示。
 */
export function providerKeyList() {
	return [...AUTH_PROVIDER_KEYS].sort((a, b) => a.id.localeCompare(b.id));
}

/** The fresh-user switch (owner, interlude 2026-09-22): env keys are
 *  invisible app-wide — deleted from the process at boot, file keys only.
 *  Read live per call (the launcher exports it before boot). */
/**
 * 检查是否启动了 "忽略环境变量密钥" 模式 (`LH_IGNORE_ENV_KEYS`)。
 * @returns 如果设置为 "1"，则返回 true（忽略系统的环境变量，仅使用本地存储）。
 */
export function envKeysIgnored(): boolean {
	return process.env.LH_IGNORE_ENV_KEYS === "1";
}

/**
 * The boot fill-gap — idempotent. First call snapshots which managed names
 * are real env; later calls (HMR re-import, or after a hand-edit) only fill
 * vars still unset in the env, so a var deleted through the API never
 * resurrects (its file entry is gone too).
 */
/**
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

/** Is this env-var name one the keys system manages (curated, provider,
 *  or held in the file)? */
function isManagedName(name: string): boolean {
	return isWritableAuthKey(name) || name in authStore.authVars();
}

/**
 * The pure status projection — exported for tests. `env` is the live
 * process env view; `realEnv` the boot snapshot (env precedence).
 */
/**
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
	/** The model-provider env vars (provider-keys interlude): PRESENT ones
	 *  join the status rows — absent ones never spam (the dropdown is the
	 *  discovery surface). Curated keys always get rows, present or not. */
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

/** The GET view: every curated key (present or not) + unknown file vars. */
/**
 * 获取实际的密钥配置状态列表（用于前端展示每个服务密钥当前是配置在 ENV 还是 FILE 或者是缺失）。
 * @returns 密钥状态列表。
 */
export function keyStatuses(): AuthKeyStatus[] {
	return resolveKeyStatuses(authStore.authVars(), process.env, boot().realEnv, AUTH_PROVIDER_ENV_VARS);
}

/** The live value for one var, env-first (the env-wins rule) — the canonical
 *  read for consumers that don't live behind the @/src/server barrel (the
 *  STT route was the one cold-boot hole: a first-ever request to it would
 *  otherwise read env before any fill-gap ran). */
/**
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

/** The key-presence truth for one model provider (provider-key interlude,
 * 2026-09-25): would this provider's key be present at request time?
 * Reads through keyValue — the SAME env-first lookup pi-ai performs
 * natively at every request — so an env-shadowed key counts as present
 * (gate by what would run). Providers absent from AUTH_PROVIDER_KEYS take
 * no key at all: nothing to gate, present by definition. */
/**
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
 * Save one key (PUT). Shape gate first (owner decision: bad pastes are
 * 400s, never stored), then the file write, then the env reflection. A
 * var that the REAL env owns is not reflected (env wins — the status row
 * reports shadowedByEnv so the page can explain it).
 */
/**
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
 * Remove one key (DELETE): gone from the file always; gone from the env
 * only when the env copy was OURS (fill-gap) — a real env var stays (env
 * wins) and the status shows the key still present from env.
 */
/**
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
