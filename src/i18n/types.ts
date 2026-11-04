import type { TranslationSchema } from "./locales/en.ts";
import type { AppLocale, ResolvedLocale } from "../core/settings.ts";

type NestedKeyOf<ObjectType extends object> = {
	[Key in keyof ObjectType & (string | number)]: ObjectType[Key] extends object
		? `${Key}` | `${Key}.${NestedKeyOf<ObjectType[Key]>}`
		: `${Key}`;
}[keyof ObjectType & (string | number)];

export type I18nKey = NestedKeyOf<TranslationSchema>;

export interface I18nContextValue {
	/** Configured preference ('auto' | 'en' | 'zh-CN') */
	locale: AppLocale;
	/** Actually resolved locale ('en' | 'zh-CN') */
	resolvedLocale: ResolvedLocale;
	/** Switch the configured locale */
	setLocale: (locale: AppLocale) => Promise<void>;
	/** Translate function with variable interpolation */
	t: (key: I18nKey, params?: Record<string, string | number>) => string;
}
