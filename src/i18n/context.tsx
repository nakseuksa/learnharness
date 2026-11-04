"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { AppLocale, ResolvedLocale } from "../core/settings.ts";
import type { I18nContextValue, I18nKey } from "./types.ts";
import { en, type TranslationSchema } from "./locales/en.ts";
import { zhCN } from "./locales/zh-CN.ts";
import { interpolate } from "./interpolate.ts";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";

const DICTIONARIES: Record<ResolvedLocale, TranslationSchema> = {
	en,
	"zh-CN": zhCN,
};

export function resolveEffectiveLocale(
	preference: AppLocale | undefined,
	systemLang?: string,
): ResolvedLocale {
	if (preference === "zh-CN" || preference === "en") {
		return preference;
	}
	// Default / "auto": follow browser/system language
	const lang = systemLang ?? (typeof window !== "undefined" && typeof navigator !== "undefined" ? navigator.language : "en");
	return lang.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function getTranslation(dict: TranslationSchema, path: string): string | undefined {
	const parts = path.split(".");
	let curr: any = dict;
	for (const part of parts) {
		if (!curr || typeof curr !== "object") return undefined;
		curr = curr[part];
	}
	return typeof curr === "string" ? curr : undefined;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
	const [locale, setLocaleState] = useState<AppLocale>("auto");
	const [systemLang, setSystemLang] = useState<string>("en");

	// Client-side detection of system language
	useEffect(() => {
		if (typeof navigator !== "undefined" && navigator.language) {
			setSystemLang(navigator.language);
		}
	}, []);

	// Initial load from /api/settings
	const loadSettings = useCallback(() => {
		fetch("/api/settings")
			.then((res) => (res.ok ? res.json() : null))
			.then((body: { settings?: { general?: { language?: AppLocale } } } | null) => {
				const lang = body?.settings?.general?.language;
				if (lang === "auto" || lang === "en" || lang === "zh-CN") {
					setLocaleState(lang);
				}
			})
			.catch(() => {});
	}, []);

	useEffect(() => {
		loadSettings();
	}, [loadSettings]);

	// Listen for settings save signals
	useSettingsSaved((section) => {
		if (section === "general") {
			loadSettings();
		}
	});

	const resolvedLocale: ResolvedLocale = useMemo(() => {
		return resolveEffectiveLocale(locale, systemLang);
	}, [locale, systemLang]);

	const setLocale = useCallback(async (nextLocale: AppLocale) => {
		setLocaleState(nextLocale);
		try {
			await fetch("/api/settings/general", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ language: nextLocale }),
			});
			notifySettingsSaved("general");
		} catch {
			// Best effort
		}
	}, []);

	const t = useCallback(
		(key: I18nKey, params?: Record<string, string | number>): string => {
			const activeDict = DICTIONARIES[resolvedLocale] ?? en;
			let text = getTranslation(activeDict, key);
			// Fallback to English if translation is missing
			if (text === undefined && activeDict !== en) {
				text = getTranslation(en, key);
			}
			if (text === undefined) {
				return key;
			}
			return interpolate(text, params);
		},
		[resolvedLocale],
	);

	const value = useMemo<I18nContextValue>(
		() => ({
			locale,
			resolvedLocale,
			setLocale,
			t,
		}),
		[locale, resolvedLocale, setLocale, t],
	);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
	const context = useContext(I18nContext);
	if (!context) {
		// Fallback for SSR or tests without Provider
		const resolvedLocale = resolveEffectiveLocale("auto");
		return {
			locale: "auto",
			resolvedLocale,
			setLocale: async () => {},
			t: (key: I18nKey, params?: Record<string, string | number>) => {
				const text = getTranslation(DICTIONARIES[resolvedLocale], key) ?? getTranslation(en, key) ?? key;
				return interpolate(text, params);
			},
		};
	}
	return context;
}
