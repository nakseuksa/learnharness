import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveEffectiveLocale, interpolate, en, zhCN } from "../components/i18n/index.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";
import { LANGUAGE_PROMPT_DIRECTIVES, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

describe("i18n core resolution", () => {
	it("explicit user preference always wins over system language", () => {
		assert.equal(resolveEffectiveLocale("zh-CN", "en-US"), "zh-CN");
		assert.equal(resolveEffectiveLocale("en", "zh-CN"), "en");
	});

	it("auto mode resolves according to system language", () => {
		assert.equal(resolveEffectiveLocale("auto", "zh-CN"), "zh-CN");
		assert.equal(resolveEffectiveLocale("auto", "zh"), "zh-CN");
		assert.equal(resolveEffectiveLocale("auto", "zh-TW"), "zh-CN");
		assert.equal(resolveEffectiveLocale("auto", "en-US"), "en");
		assert.equal(resolveEffectiveLocale("auto", "de"), "en");
		assert.equal(resolveEffectiveLocale(undefined, "zh-CN"), "zh-CN");
		assert.equal(resolveEffectiveLocale(undefined, "en"), "en");
	});

	it("interpolate substitutes parameters cleanly", () => {
		assert.equal(interpolate("Hello {name}!", { name: "World" }), "Hello World!");
		assert.equal(interpolate("Thought for {time}s", { time: 5 }), "Thought for 5s");
		assert.equal(interpolate("No params here"), "No params here");
		assert.equal(interpolate("Missing {unprovided} key", {}), "Missing {unprovided} key");
	});

	it("en and zh-CN dictionaries have identical key structures", () => {
		function getKeys(obj: Record<string, unknown>, prefix = ""): string[] {
			let keys: string[] = [];
			for (const [k, v] of Object.entries(obj)) {
				const full = prefix ? `${prefix}.${k}` : k;
				if (typeof v === "object" && v !== null) {
					keys = keys.concat(getKeys(v as Record<string, unknown>, full));
				} else {
					keys.push(full);
				}
			}
			return keys.sort();
		}

		const enKeys = getKeys(en as unknown as Record<string, unknown>);
		const zhKeys = getKeys(zhCN as unknown as Record<string, unknown>);
		assert.deepEqual(zhKeys, enKeys, "zh-CN keys must exactly match en keys");
	});
});

describe("settings language parser and sanitizer", () => {
	it("parseGeneralSettingsBody accepts valid languages and rejects invalid ones", () => {
		const autoResult = parseGeneralSettingsBody({ language: "auto" });
		assert.equal(autoResult.ok, true);
		if (autoResult.ok) assert.equal(autoResult.settings.language, "auto");

		const zhResult = parseGeneralSettingsBody({ language: "zh-CN" });
		assert.equal(zhResult.ok, true);
		if (zhResult.ok) assert.equal(zhResult.settings.language, "zh-CN");

		const enResult = parseGeneralSettingsBody({ language: "en" });
		assert.equal(enResult.ok, true);
		if (enResult.ok) assert.equal(enResult.settings.language, "en");

		const invalidResult = parseGeneralSettingsBody({ language: "fr" });
		assert.equal(invalidResult.ok, false);

		const numResult = parseGeneralSettingsBody({ language: 123 });
		assert.equal(numResult.ok, false);
	});

	it("sanitizeUserSettings preserves valid language and ignores invalid ones", () => {
		const valid = sanitizeUserSettings({ version: 1, general: { language: "zh-CN" } });
		assert.equal(valid?.general?.language, "zh-CN");

		const invalid = sanitizeUserSettings({ version: 1, general: { language: "invalid" } });
		assert.equal(invalid?.general?.language, undefined);
	});
});

describe("agent system prompt language injection", () => {
	it("LANGUAGE_PROMPT_DIRECTIVES defines clear directives for supported languages", () => {
		assert.ok(LANGUAGE_PROMPT_DIRECTIVES["zh-CN"].includes("简体中文"));
		assert.ok(LANGUAGE_PROMPT_DIRECTIVES["en"].includes("English"));
	});

	it("createTeacherAgent includes Chinese language directive when language is zh-CN", () => {
		const agent = createTeacherAgent(undefined, {
			engine: fauxEngine(),
			language: "zh-CN",
		});
		const prompt = (agent as any).state?.systemPrompt ?? (agent as any).initialState?.systemPrompt ?? "";
		assert.ok(prompt.includes(LANGUAGE_PROMPT_DIRECTIVES["zh-CN"]));
	});

	it("createTeacherAgent includes English language directive when language is en", () => {
		const agent = createTeacherAgent(undefined, {
			engine: fauxEngine(),
			language: "en",
		});
		const prompt = (agent as any).state?.systemPrompt ?? (agent as any).initialState?.systemPrompt ?? "";
		assert.ok(prompt.includes(LANGUAGE_PROMPT_DIRECTIVES["en"]));
	});
});
