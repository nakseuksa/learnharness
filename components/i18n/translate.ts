import type { ResolvedLocale } from "@/src/core";
import type { I18nKey } from "./types.ts";
import { en, type TranslationSchema } from "./locales/en.ts";
import { zhCN } from "./locales/zh-CN.ts";
import { interpolate } from "./interpolate.ts";

export type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

const DICTIONARIES: Record<ResolvedLocale, TranslationSchema> = {
	en,
	"zh-CN": zhCN,
};

function getTranslation(dict: TranslationSchema, path: string): string | undefined {
	let curr: unknown = dict;
	for (const part of path.split(".")) {
		if (!curr || typeof curr !== "object" || !Object.hasOwn(curr, part)) return undefined;
		curr = (curr as Record<string, unknown>)[part];
	}
	return typeof curr === "string" ? curr : undefined;
}

/** Pure translator: lookup in the active dictionary, English fallback, then
 * the key itself; `{param}` interpolation. Shared by the provider, the
 * provider-less fallback, and tests. */
export function createTranslator(locale: ResolvedLocale): Translate {
	const dict = Object.hasOwn(DICTIONARIES, locale) ? DICTIONARIES[locale] : en;
	return (key, params) => {
		let text = getTranslation(dict, key);
		if (text === undefined && dict !== en) text = getTranslation(en, key);
		if (text === undefined) return key;
		return interpolate(text, params);
	};
}

/** Paired `_one` / `_other` keys; the caller passes both, typed. */
export function pluralKey<K extends I18nKey>(count: number, one: K, other: K): K {
	return count === 1 ? one : other;
}
