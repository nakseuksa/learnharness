import { Home } from "@/components/home";
import { readSettingsRecord } from "@/src/server";
import { resolveSettings, slotsConfigured } from "@/src/core";

// Dynamic: the configured state is server-rendered into the page (the
// setup CTA's truth on the first frame), and every navigation re-reads
// the record (dynamic routes aren't cached client-side).
export const dynamic = "force-dynamic";

/**
 * HomePage 组件是应用的默认入口页面 (/)。
 * 它主要负责读取后端的设置记录，并将其传递给客户端的 Home 组件。
 */
export default function HomePage() {
	// 首次运行拦截（模型插槽配置）：在用户完成所有三个模型插槽的选取前，
	// 无法开始新的会话。这通过检查原始配置记录中的模型配置来实现，并在尚未配置时显示配置提示 (CTA)。
	const record = readSettingsRecord();

	// 图谱渲染模式判定：根据设置决定首页的主要视图是图表(canvas)还是逻辑链列表视图(chains view)。
	// 如果配置中不存在该字段，则通过 resolveSettings 解析为系统默认值（默认开启图形渲染）。
	// 因为页面被标记为 force-dynamic，每次导航都会重新读取这个配置。
	const rendering = resolveSettings(record ?? null).graph.rendering;
	return (
		<Home initialConfigured={slotsConfigured(record?.models)} rendering={rendering} />
	);
}
