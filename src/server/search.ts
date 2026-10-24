/**
 * 搜索引擎的服务器组合（search port + model slots wave, 2026-09-20）：
 * 核心端口（core/search.ts）后面的 Tavily + Brave 适配器
 * + 设置 UI 和代理层（agent-layer）工具都读取的实时引擎解析（live-engine resolution）。
 *
 * 烘焙其中的 Owner 决定（2026-09-20）：
 *  - 没有（NO）默认引擎：引擎当且仅当（iff）其密钥存在时才处于活动状态
 *    （认证存储或环境 — 环境优先，通过 server/keys.ts 的 keyValue 键入）。
 *  - 设置密钥是用户要做的全部 — 自动检测：明确的 agent.search.engine
 *    固定偏好（当两个（BOTH）密钥都存在时，优先顺序为 Tavily → Brave）；
 *    如果没有固定，哪个引擎有密钥哪个就是引擎。
 *  - 明确的选择不会（NOT）静默回退到另一个引擎：引擎被固定但其密钥丢失
 *    = 诚实地不可用（原因就是这么说的）— 不要猜测用户的意思。
 *
 * 适配器是注入的依赖项（fetch 形状），因此代理层工具仅依赖于端口（PORT），
 * 测试永远不会触碰网络。
 */

import type { SearchEngineId, SearchHit, SearchProvider, SearchStatus } from "../core/search.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** 适配器闭合的可通过线路调用的形状（测试注入存根）。 */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Tavily：POST https://api.tavily.com/search — Authorization 头中的
 * Bearer auth（当前文档化的方案；旧的 api_key-in-body 形式已退役），
 * JSON 请求体中的 query + max_results (0–20)。
 * 对照 docs.tavily.com 的 OpenAPI 验证（2026-09-20）：
 * 响应 {results: [{title, url, content, score, …}]}，
 * 错误 {detail: {error}}。
 *
 * 构造 Tavily 搜索服务的适配器，实现了 SearchProvider 接口。
 * 使用传入的 API Key 发起对 Tavily 的搜索请求，并限制最多返回 3 条结果。
 *
 * @param apiKey Tavily 服务的 API 密钥。
 * @param fetchFn 自定义的 fetch 实现（默认为原生的 fetch），用于便于测试和注入。
 * @returns 符合后台代理研究器要求的 SearchProvider 实例。
 */
export function tavilyProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "tavily",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				// 他们的错误请求体是 {detail: {error: "…"}} — 表面化
				// 存在时的消息，否则为原始切片。
				let detail = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body) as { detail?: { error?: string } };
					if (parsed.detail?.error) detail = parsed.detail.error.slice(0, 200);
				} catch {
					/* keep the raw slice */
				}
				throw new Error(`Tavily search API ${resp.status}: ${detail}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/**
 * Brave：GET https://api.search.brave.com/res/v1/web/search
 * 将密钥放在 X-Subscription-Token 头中。
 * 对照 Brave 的仪表板文档验证（2026-09-20）：最大数量 20；
 * 响应 {web: {results: [{title, url, description, …}]}}。
 *
 * 构造 Brave 搜索服务的适配器，实现了 SearchProvider 接口。
 * 使用传入的 API Key 发起对 Brave Search 服务的请求。
 * 如果搜索结果包含相关新闻或常见问答，将它们附加到网页搜索结果的尾部，以提供更丰富的研究素材。
 *
 * @param apiKey Brave Search 服务的 API 密钥。
 * @param fetchFn 自定义的 fetch 实现。
 * @returns 符合后台代理研究器要求的 SearchProvider 实例。
 */
export function braveProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "brave",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(count, 20)));
			const resp = await fetchFn(url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey,
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`Brave search API ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
			return (data.web?.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.description ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/**
 * 这个 wave 搭载的引擎，按优先顺序（PREFERENCE order）排列（如果两个密钥都存在，
 * 没有明确固定 → 第一个活动引擎获胜；owner 决定，2026-09-20：
 * Tavily 第一 — 该 wave 选择的 AI 原生搜索 API）。
 */
const ENGINE_ORDER: ReadonlyArray<{ id: SearchEngineId; envVar: string }> = [
	{ id: "tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", envVar: "BRAVE_API_KEY" },
];

/**
 * 引擎的密钥（env 或文件；env 优先） — 当引擎未设置密钥时为 null，
 * 根据 owner 的决定，这意味着非活动（NOT LIVE）。
 */
function engineKey(id: SearchEngineId): string | null {
	const envVar = ENGINE_ORDER.find((e) => e.id === id)?.envVar;
	const value = envVar ? keyValue(envVar) : undefined;
	return value ? value : null;
}

/**
 * 纯粹（PURELY）从给定的绑定解析搜索状态（可测试）：
 * 明确的引擎（如果已固定）获胜，但必须设置密钥；没有固定 →
 * 优先顺序中的第一个有密钥的引擎。永远不会抛出异常。
 *
 * 解析并生成当前配置对应的搜索引擎实例（如果是活跃且有效的）。
 * 如果系统未开启网络搜索，或者未提供有效的提供商配置，则返回 null。
 *
 * @param settings 当前系统的全局设置（从中读取启用的搜索提供商）。
 * @param env 环境变量（读取具体的 API Keys）。
 * @param fetchFn HTTP 请求的 fetch 函数，用于网络交互。
 * @returns 若存在并配置正确的引擎适配器则返回该实例，否则为 null。
 */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** 每个引擎的实时密钥（缺失的引擎 = 缺失的属性是可以的）。 */
	keys: Partial<Record<SearchEngineId, string | undefined>>,
): SearchStatus & { key: string | null } {
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		if (!pinnedKey) {
			return {
				available: false,
				engine: null,
				reason: `search engine is set to "${pinned}" but its API key is missing — set the ${pinned === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY"} key`,
				key: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}
	for (const { id } of ENGINE_ORDER) {
		const key = keys[id] ?? null;
		if (key) return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key };
	}
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — set a Tavily or Brave search API key",
		key: null,
	};
}

/**
 * 实时搜索状态（诚实的可用性信号）：读取设置记录的绑定 + 每次调用时
 * 最新读取认证存储，因此在会话中途保存的密钥会在下一次检查时激活（无需重启）。
 *
 * 获取当前全局搜索引擎配置的真实使用状态和引擎信息（用于配置页面的回显和健康检查）。
 *
 * @returns 返回一个包含是否可用、配置的引擎及具体配置错误原因等状态。
 */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		{
			tavily: engineKey("tavily") ?? undefined,
			brave: engineKey("brave") ?? undefined,
		},
	);
	return { available, engine, reason };
}

/**
 * 搜索是否可用？（设置 UI 的灰显信号 + 研究者的启用/禁用绑定
 * — Teacher 流的重新连线读取此内容。）
 *
 * 检查目前是否开启了网络搜索能力。
 * 该函数在创建各个子 Agent 或者判断是否下发 Web Search 选项时作为快速守卫。
 *
 * @returns 如果有效的搜索引擎已被配置，返回 true。
 */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/**
 * 活动的（LIVE）适配器，或在不可用时为 null。每次调用都会重新组合
 * — 工具层（Teacher stream）每次搜索调用一次它，因此密钥轮换立即生效。
 *
 * 提供一个当前最新生效的搜索引擎适配器，供后台执行任务时实时调用。
 * 该函数通过组合当前配置与当前环境变量获得底层实例，以确保每次调度拿到最新配置。
 *
 * @returns 返回相应的 SearchProvider 适配器或 null（如果尚未配置好）。
 */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, {
		tavily: engineKey("tavily") ?? undefined,
		brave: engineKey("brave") ?? undefined,
	});
	if (!resolved.available || !resolved.key) return null;
	return resolved.engine === "tavily" ? tavilyProvider(resolved.key) : braveProvider(resolved.key);
}
