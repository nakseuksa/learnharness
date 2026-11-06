import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChainTableBody } from "../components/chain-table.tsx";
import { DeleteSourceBody } from "../components/delete-source-dialog.tsx";
import { NotesImportControl } from "../components/notes-import.tsx";
import { formatImportMessage, type ImportMessage } from "../components/notes-import-queue.ts";
import { SourceRequestError, sourceErrorText } from "../components/source-error-text.ts";
import { createTranslator, I18nProvider, pluralKey, useI18n } from "../components/i18n/index.ts";
import type { SourceDirectory } from "../src/core/index.ts";

const en = createTranslator("en");
const zh = createTranslator("zh-CN");
const zhRender = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider initialLocale="zh-CN">{node}</I18nProvider>);

const directory: SourceDirectory = {
	organization: { version: 1, folders: [{ id: "f1", name: "Course", parentId: null, createdAt: "2026-10-30" }], placements: { notes: { folderId: "f1" } } },
	sources: [
		{ id: "chat", kind: "chat", label: "A chat", createdAt: "2026-10-29" },
		{ id: "notes", kind: "notes", label: "Book", filePath: "Course/book.md", createdAt: "2026-10-29" },
	],
};
const tableProps: Parameters<typeof ChainTableBody>[0] = {
	nodes: [], chains: [], sessions: {}, fileSources: {}, query: "", onQuery() {}, sort: { col: "name", dir: 1 }, onSort() {}, selection: new Set(),
	expandedClusters: new Set(["f1"]), expandedChains: new Set(), onToggleCluster() {}, onToggleChain() {}, onToggleNodes() {}, onClear() {}, onDelete() {}, onClose() {},
	directory, onOrganizationChange: async () => {},
};

describe("translator core", () => {
	it("looks up, interpolates, falls back to English, then to the key", () => {
		assert.equal(en("sources.table.selectSource", { name: "X" }), "Select source X");
		assert.equal(zh("sources.table.selectSource", { name: "X" }), "选择来源“X”");
		assert.equal(zh("sources.nope" as never), "sources.nope");
		assert.equal(en("constructor" as never), "constructor", "prototype keys never resolve");
	});
	it("pluralKey picks _one only for exactly one", () => {
		assert.equal(pluralKey(1, "sources.table.chainCount_one", "sources.table.chainCount_other"), "sources.table.chainCount_one");
		for (const n of [0, 2]) assert.equal(pluralKey(n, "sources.table.chainCount_one", "sources.table.chainCount_other"), "sources.table.chainCount_other");
	});
	it("the provider-less fallback is English regardless of the host language", () => {
		let seen = "";
		function Probe() { const { t, resolvedLocale } = useI18n(); seen = `${resolvedLocale}:${t("sources.entry.chains")}`; return null; }
		renderToStaticMarkup(<Probe />);
		assert.equal(seen, "en:Chains");
	});
});

describe("source surfaces render in zh-CN", () => {
	it("chain table chrome, rows and folder tree", () => {
		const html = zhRender(<ChainTableBody {...tableProps} />);
		assert.match(html, /0 条推理链 · 0 个节点/);
		assert.match(html, /aria-label="新建文件夹"/);
		assert.match(html, /placeholder="搜索节点…"/);
		assert.match(html, /aria-label="关闭推理链列表"/);
		assert.match(html, /名称/); assert.match(html, /命题数/); assert.match(html, /创建时间/);
		assert.match(html, /aria-label="选择文件夹“Course”"/);
		assert.match(html, /aria-label="展开文件夹“Course”"/);
		assert.match(html, /aria-label="移出文件夹"/);
		assert.match(html, /笔记/);
		assert.match(html, /title="重命名"/);
		assert.doesNotMatch(html, /Search nodes|Add folder|Close chains/);
	});
	it("selection bar", () => {
		const html = zhRender(<ChainTableBody {...tableProps} selectedSources={new Set(["notes"])} />);
		assert.match(html, /1 个来源/); assert.match(html, />清除</); assert.match(html, /aria-label="删除所选来源和文件夹"/);
	});
	it("delete dialog, including the session opt-in and a localized failure", () => {
		const html = zhRender(<DeleteSourceBody sources={directory.sources} folders={[]} deleteSessions={false} onDeleteSessions={() => {}} busy={false}
			failure={new SourceRequestError("An extraction is running — try again when the activity dock drains.", "extraction_running")} onClose={() => {}} onRun={() => {}} />);
		assert.match(html, /删除所选来源和文件夹？/);
		assert.match(html, /A chat、Book/);
		assert.match(html, /同时删除所选的 1 个会话/);
		assert.match(html, /有提取任务正在运行/);
		assert.match(html, />重试</); assert.match(html, />取消</);
	});
	it("delete dialog in English stays byte-identical in wording", () => {
		const html = renderToStaticMarkup(<DeleteSourceBody sources={directory.sources} folders={[]} deleteSessions={false} onDeleteSessions={() => {}} busy={false}
			failure="" onClose={() => {}} onRun={() => {}} />);
		assert.match(html, /Delete selected sources and folders\?/); assert.match(html, /Also delete the 1 selected session</); assert.match(html, />Delete</);
	});
	it("import control", () => {
		const html = zhRender(<NotesImportControl importing={false} onImportFiles={() => {}} />);
		assert.match(html, /导入笔记…/);
		assert.match(zhRender(<NotesImportControl importing onImportFiles={() => {}} />), /正在导入…/);
	});
});

describe("sourceErrorText", () => {
	it("localizes known codes and shows unknown ones in English", () => {
		assert.equal(sourceErrorText(zh, new SourceRequestError("Folder no longer exists.", "folder_missing")), "文件夹已不存在。");
		assert.equal(sourceErrorText(en, new SourceRequestError("Folder no longer exists.", "folder_missing")), "Folder no longer exists.");
		assert.equal(sourceErrorText(zh, new SourceRequestError("No such session", "not_found")), "No such session");
		assert.equal(sourceErrorText(zh, new Error("raw")), "raw");
		assert.equal(sourceErrorText(zh, "plain"), "plain");
		assert.equal(sourceErrorText(zh, new SourceRequestError("x", "toString")), "x", "prototype names are not codes");
	});
});

describe("formatImportMessage", () => {
	const cases: [ImportMessage, string, string][] = [
		[{ path: "a.md", text: "Too big. Max 25 MB.", code: "import_too_big" }, "a.md: Too big. Max 25 MB.", "a.md: 文件过大，上限 25 MB。"],
		[{ path: "a.pdf", text: "Too long. Max 1,000 pages.", code: "pdf_too_long", params: { maxPages: 1000 } }, "a.pdf: Too long. Max 1,000 pages.", "a.pdf: 页数过多，上限 1,000 页。"],
		[{ path: "a.pdf", text: "Scanned pages may have errors. Skipped 2 image-only pages; OCR is not supported.", code: "pdf_scanned", params: { skipped: 2 } },
			"a.pdf: Scanned pages may have errors. Skipped 2 image-only pages; OCR is not supported.", "a.pdf: 扫描页的识别结果可能有误。已跳过 2 个纯图片页面；暂不支持 OCR。"],
		[{ path: "a.pdf", text: "Scanned pages may have errors.", code: "pdf_scanned", params: { skipped: 0 } }, "a.pdf: Scanned pages may have errors.", "a.pdf: 扫描页的识别结果可能有误。"],
		[{ path: "x/a.png", text: "Unsupported format or unsafe relative path.", code: "import_unsupported" }, "x/a.png: Unsupported format or unsafe relative path.", "x/a.png: 格式不受支持，或相对路径不安全。"],
		[{ path: "a.md", text: "provider said no" }, "a.md: provider said no", "a.md: provider said no"],
		[{ path: "a.md", text: "No key", details: "provider_key_missing — openai" }, "a.md: No key\nprovider_key_missing — openai", "a.md: No key\nprovider_key_missing — openai"],
		[{ path: "a.md", text: "Import request failed (HTTP 413): Too big. Max 25 MB. Check the graph before retrying.", code: "import_request_failed",
			request: { status: 413, serverError: "Too big. Max 25 MB.", serverCode: "import_too_big" } },
			"a.md: Import request failed (HTTP 413): Too big. Max 25 MB. Check the graph before retrying.",
			"a.md: 导入请求失败（HTTP 413）：文件过大，上限 25 MB。请先检查图谱再重试。"],
		[{ path: "a.md", text: "Import request failed (HTTP 503): synthetic refused. Check the graph before retrying.", code: "import_request_failed",
			request: { status: 503, serverError: "synthetic refused" } },
			"a.md: Import request failed (HTTP 503): synthetic refused. Check the graph before retrying.",
			"a.md: 导入请求失败（HTTP 503）：synthetic refused。请先检查图谱再重试。"],
		[{ path: "a.md", text: "Import request failed (HTTP 500). Check the graph before retrying.", code: "import_request_failed", request: { status: 500 } },
			"a.md: Import request failed (HTTP 500). Check the graph before retrying.", "a.md: 导入请求失败（HTTP 500）。请先检查图谱再重试。"],
	];
	for (const [message, english, chinese] of cases) it(`${message.code ?? "raw"} → both languages`, () => {
		assert.equal(formatImportMessage(message, en), english);
		assert.equal(message.text === english.slice(message.path.length + 2).split("\n")[0], true, "the stored English equals the rendered English");
		assert.equal(formatImportMessage(message, zh, "zh-CN"), chinese);
	});
});
