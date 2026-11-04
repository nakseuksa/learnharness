"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AppLocale } from "@/src/core";
import { useI18n } from "@/components/i18n";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { SettingsMenuTrigger, SettingsRow } from "./controls";

interface LocaleOption {
	code: AppLocale;
	label: string;
	desc?: string;
}

const LOCALE_OPTIONS: readonly LocaleOption[] = [
	{ code: "auto", label: "Auto / 跟随系统", desc: "Follow system preferences" },
	{ code: "zh-CN", label: "简体中文 (Chinese)", desc: "Simplified Chinese" },
	{ code: "en", label: "English", desc: "English" },
];

export function InterfaceLanguageSetting() {
	const { locale, setLocale, t } = useI18n();
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);

	const defaultOption: LocaleOption = LOCALE_OPTIONS[0]!;
	const activeOption: LocaleOption = LOCALE_OPTIONS.find((item) => item.code === locale) ?? defaultOption;

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="interface-language-menu"]')) return;
			if (!triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	const closeOnEscape = (event: ReactKeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		setOpen(false);
		triggerRef.current?.focus();
	};

	const pick = async (code: AppLocale) => {
		await setLocale(code);
		setOpen(false);
		triggerRef.current?.focus();
	};

	return (
		<SettingsRow
			label={t("settings.general.languageLabel")}
			hint={t("settings.general.languageHint")}
			testid="row-interface-language"
		>
			<Hint label={activeOption.label} side="top">
				<SettingsMenuTrigger
					ref={triggerRef}
					value={activeOption.label}
					data-testid="interface-language-trigger"
					aria-label={`Interface language: ${activeOption.label}`}
					aria-expanded={open}
					onKeyDown={(event) => {
						if (open) closeOnEscape(event);
					}}
					onClick={() => setOpen((prev) => !prev)}
					className="min-w-32 max-w-[65%]"
				/>
			</Hint>
			{open && (
				<MenuShell
					anchorRef={triggerRef}
					testid="interface-language-menu"
					preferredSide="down"
					menuClass="flex w-64 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-1.5 text-xs shadow-xl"
				>
					<div
						className="flex flex-col gap-1"
						onKeyDown={(event) => {
							closeOnEscape(event);
						}}
					>
						{LOCALE_OPTIONS.map((item) => {
							const isSelected = item.code === locale;
							return (
								<button
									key={item.code}
									type="button"
									data-testid={`interface-language-option-${item.code}`}
									onClick={() => void pick(item.code)}
									className={`flex flex-col items-start rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent ${
										isSelected ? "bg-accent/70 font-medium text-foreground" : "text-muted-foreground"
									}`}
								>
									<span className="text-xs text-foreground">{item.label}</span>
									{item.desc && <span className="text-[10px] text-muted-foreground/70">{item.desc}</span>}
								</button>
							);
						})}
					</div>
				</MenuShell>
			)}
		</SettingsRow>
	);
}
