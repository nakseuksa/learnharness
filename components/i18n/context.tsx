"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { AppLocale, ResolvedLocale } from "@/src/core";
import type { I18nContextValue } from "./types.ts";
import { createTranslator } from "./translate.ts";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";

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

const I18nContext = createContext<I18nContextValue | null>(null);
const EN_TRANSLATOR = createTranslator("en");

export function I18nProvider({ children, initialLocale = "auto" }: {
	children: React.ReactNode;
	/** Test seam only; production starts at "auto" and loads /api/settings. */
	initialLocale?: AppLocale;
}) {
	const [locale, setLocaleState] = useState<AppLocale>(initialLocale);
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

	// Keep <html lang> in step with the resolved UI language.
	useEffect(() => {
		document.documentElement.lang = resolvedLocale;
	}, [resolvedLocale]);

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

	const t = useMemo(() => createTranslator(resolvedLocale), [resolvedLocale]);

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
		// Fallback for SSR or tests without Provider: always English, so output
		// never depends on the host machine's language (production always
		// mounts the provider in app/layout.tsx).
		return {
			locale: "auto",
			resolvedLocale: "en",
			setLocale: async () => {},
			t: EN_TRANSLATOR,
		};
	}
	return context;
}
