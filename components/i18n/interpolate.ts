/**
 * Interpolates variables into a localized string template.
 * Example: interpolate("Hello, {name}!", { name: "Antigravity" }) -> "Hello, Antigravity!"
 */
export function interpolate(template: string, params?: Record<string, string | number>): string {
	if (!params || !template.includes("{")) return template;
	return template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (match, key) => {
		return key in params ? String(params[key]) : match;
	});
}
