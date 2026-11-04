/**
 * Isomorphic observability logger — pure, browser-safe, zero dependencies.
 *
 * Lives in `src/core` so every layer (`components`, `app`, `server`, `agent`,
 * `store`) can import it without violating the ESLint import boundary law.
 *
 * Activation:
 * - Default ON in development (`NODE_ENV !== "test"` and `NODE_ENV !== "production"`),
 *   so running `npm run dev` immediately prints system behavior in both the
 *   Node terminal and Browser DevTools console.
 * - Default OFF in tests (`NODE_ENV === "test"`) so test runners stay clean,
 *   unless explicitly enabled via `LH_LOG=1` or `LH_LOG=turn,agent,...`.
 * - Can be muted anytime with `LH_LOG=0` / `LH_LOG=false` (or in browser
 *   DevTools: `localStorage.setItem("LH_LOG", "0")`).
 * - High-frequency streaming chunks (`stream` scope) are off by default unless
 *   `LH_LOG=*,stream` or `LH_LOG=stream` is set.
 */

export type LogScope =
	| "TURN"
	| "AGENT"
	| "TOOL"
	| "JOB"
	| "EVENT"
	| "STORE"
	| "SESSION"
	| "STREAM";

const ANSI_COLORS: Record<LogScope, string> = {
	TURN: "\x1b[36m", // Cyan
	AGENT: "\x1b[35m", // Magenta
	TOOL: "\x1b[33m", // Yellow
	JOB: "\x1b[34m", // Blue
	EVENT: "\x1b[32m", // Green
	STORE: "\x1b[90m", // Gray
	SESSION: "\x1b[96m", // Bright Cyan
	STREAM: "\x1b[90m", // Gray
};

const CSS_COLORS: Record<LogScope, string> = {
	TURN: "color:#0891b2;font-weight:bold",
	AGENT: "color:#9333ea;font-weight:bold",
	TOOL: "color:#ca8a04;font-weight:bold",
	JOB: "color:#2563eb;font-weight:bold",
	EVENT: "color:#16a34a;font-weight:bold",
	STORE: "color:#6b7280;font-weight:bold",
	SESSION: "color:#ea580c;font-weight:bold",
	STREAM: "color:#9ca3af;font-weight:normal",
};

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";

function isBrowser(): boolean {
	return typeof window !== "undefined" && typeof window.document !== "undefined";
}

function readLogConfig(): string | undefined {
	if (isBrowser()) {
		try {
			const val = window.localStorage?.getItem("LH_LOG");
			if (val !== null) return val;
		} catch {
			// localStorage may be blocked in sandboxed iframes
		}
	}
	if (typeof process !== "undefined" && process.env) {
		return process.env.LH_LOG;
	}
	return undefined;
}

function isTestEnv(): boolean {
	return typeof process !== "undefined" && process.env?.NODE_ENV === "test";
}

function isProdEnv(): boolean {
	return typeof process !== "undefined" && process.env?.NODE_ENV === "production";
}

export function isLogEnabled(scope: LogScope): boolean {
	const raw = readLogConfig()?.trim();
	if (raw === "0" || raw === "false" || raw === "off") return false;
	if (!raw) {
		// Default behavior when LH_LOG is not explicitly set:
		// Off in test and production; On in development (except noisy STREAM).
		if (isTestEnv() || isProdEnv()) return false;
		return scope !== "STREAM";
	}
	if (raw === "1" || raw === "true" || raw === "on" || raw === "*") {
		return scope !== "STREAM";
	}
	const parts = raw
		.toLowerCase()
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (parts.includes("all") || (parts.includes("*") && parts.includes("stream"))) {
		return true;
	}
	if (parts.includes("*")) {
		return scope !== "STREAM" || parts.includes("stream");
	}
	return parts.includes(scope.toLowerCase());
}

function timestamp(): string {
	const d = new Date();
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	const ms = String(d.getMilliseconds()).padStart(3, "0");
	return `${hh}:${mm}:${ss}.${ms}`;
}

export function truncateLogValue(value: unknown, maxLen = 160): string {
	if (value === undefined) return "";
	if (typeof value === "string") {
		const clean = value.replace(/\s+/g, " ").trim();
		return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
	}
	try {
		const json = JSON.stringify(value);
		if (!json) return "";
		return json.length > maxLen ? `${json.slice(0, maxLen)}…` : json;
	} catch {
		return String(value);
	}
}

function formatDetails(details?: Record<string, unknown>): string {
	if (!details) return "";
	const parts: string[] = [];
	for (const [k, v] of Object.entries(details)) {
		if (v === undefined) continue;
		if (typeof v === "number" || typeof v === "boolean") {
			parts.push(`${k}=${v}`);
		} else if (typeof v === "string") {
			parts.push(`${k}=${truncateLogValue(v, 100)}`);
		} else {
			parts.push(`${k}=${truncateLogValue(v, 140)}`);
		}
	}
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * Emit a best-effort console log line for system behavior tracing.
 */
export function lhLog(
	scope: LogScope,
	action: string,
	details?: Record<string, unknown>,
	contextId?: string,
): void {
	try {
		if (!isLogEnabled(scope)) return;
		const ts = timestamp();
		const idTag = contextId ? `[${contextId}] ` : "";
		const detailStr = formatDetails(details);

		if (isBrowser()) {
			const badge = `%c[${ts}] [${scope.padEnd(7)}]%c ${idTag}${action}${detailStr}`;
			console.log(badge, CSS_COLORS[scope], "color:inherit");
		} else {
			const color = ANSI_COLORS[scope] ?? "";
			const line = `${ANSI_DIM}[${ts}]${ANSI_RESET} ${color}[${scope.padEnd(7)}]${ANSI_RESET} ${idTag}${action}${detailStr}`;
			console.info(line);
		}
	} catch {
		// Diagnostics must not interrupt a turn or change a store/tool result.
	}
}

/**
 * Wrap a store or service object in a transparent ES Proxy that logs
 * method calls (arguments summary + execution time) under the given scope.
 */
export function traceObject<T extends object>(
	scope: LogScope,
	label: string,
	target: T,
	options?: {
		/** Only log methods in this set (if omitted, logs all methods). */
		include?: ReadonlySet<string>;
		/** Skip methods in this set (e.g. high-frequency pure getters). */
		exclude?: ReadonlySet<string>;
	},
): T {
	// Cache wrapped functions per original function so reading `store.method`
	// returns a stable reference, while direct mutation in tests
	// (`store.method = mockFn`) updates `target` and is respected immediately.
	const cache = new WeakMap<Function, Function>();
	return new Proxy(target, {
		get(obj, prop, receiver) {
			const value = Reflect.get(obj, prop, receiver);
			if (typeof prop !== "string" || typeof value !== "function") {
				return value;
			}
			if (options?.include && !options.include.has(prop)) {
				return value;
			}
			if (options?.exclude?.has(prop)) {
				return value;
			}
			let wrapped = cache.get(value);
			if (!wrapped) {
				wrapped = function (this: unknown, ...args: unknown[]) {
					if (!isLogEnabled(scope)) {
						return value.apply(this === receiver ? obj : this, args);
					}
					const t0 = performance.now();
					const firstArg = typeof args[0] === "string" ? args[0] : undefined;
					try {
						const res = value.apply(this === receiver ? obj : this, args);
						if (res && typeof (res as Promise<unknown>).then === "function") {
							return (res as Promise<unknown>).then(
								(resolved) => {
									const ms = Math.round(performance.now() - t0);
									lhLog(scope, `${label}.${prop}`, summarizeStoreCall(prop, args, resolved, ms), firstArg);
									return resolved;
								},
								(err) => {
									const ms = Math.round(performance.now() - t0);
									lhLog(scope, `${label}.${prop} FAILED`, { ms, error: String(err) }, firstArg);
									throw err;
								},
							);
						}
						const ms = Math.round(performance.now() - t0);
						lhLog(scope, `${label}.${prop}`, summarizeStoreCall(prop, args, res, ms), firstArg);
						return res;
					} catch (err) {
						const ms = Math.round(performance.now() - t0);
						lhLog(scope, `${label}.${prop} FAILED`, { ms, error: String(err) }, firstArg);
						throw err;
					}
				};
				cache.set(value, wrapped);
			}
			return wrapped;
		},
		set(obj, prop, newValue, receiver) {
			return Reflect.set(obj, prop, newValue, receiver);
		},
	});
}

function summarizeStoreCall(
	method: string,
	args: unknown[],
	result: unknown,
	ms: number,
): Record<string, unknown> {
	const info: Record<string, unknown> = {};
	if (method === "saveMessages" && Array.isArray(args[1])) {
		info.messages = args[1].length;
	} else if (method === "createChat" && args[0] && typeof args[0] === "object") {
		const rec = args[0] as { id?: string; kind?: string; title?: string };
		if (rec.id) info.id = rec.id;
		if (rec.kind) info.kind = rec.kind;
		if (rec.title) info.title = rec.title;
	} else if (method === "updateJob" && args[1] && typeof args[1] === "object") {
		const patch = args[1] as { status?: string; activity?: string; error?: string };
		if (patch.status) info.status = patch.status;
		if (patch.activity) info.activity = patch.activity;
		if (patch.error) info.error = patch.error;
	} else if (method === "createJob" && args[0] && typeof args[0] === "object") {
		const job = args[0] as { id?: string; chatId?: string; kind?: string };
		if (job.id) info.jobId = job.id;
		if (job.chatId) info.chatId = job.chatId;
		if (job.kind) info.kind = job.kind;
	} else if (Array.isArray(result)) {
		info.count = result.length;
	}
	info.ms = `${ms}ms`;
	return info;
}
