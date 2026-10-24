import { NewSession } from "@/components/new-session";
import { readSettingsRecord } from "@/src/server";
import { slotsConfigured } from "@/src/core";

export const dynamic = "force-dynamic";

/**
 * 新建会话页面（"/chat/new"），对应于点击 "+ New session" 按钮后的草稿视图。
 *
 * 核心机制 (2026-09-13):
 * - 在用户发送第一条消息之前，**不会在服务端创建任何会话数据**。
 * - 这个视图是一个无状态、未实例化的空聊天界面。
 * - 当发送第一条消息时，系统会创建该会话（并将该消息作为标题），然后页面重定向
 *   到真正的会话页面 (`/chat/[id]`)，通过 `initialPrompt` 参数把那条消息传递过去作为第一回合。
 * - 路由优先级：静态路由 "new" 会优先于动态路由 "[id]" 被匹配。
 *
 * 模型设定机制:
 * - 在草稿状态下，模型的选择控件绑定的是 STRONG SLOT (强模型，作为新会话的默认模型)。
 * - 当发送第一条消息真正创建会话时，服务端会永久记录(stamp)该模型（每个会话独立维护自己使用的模型，独立 owner，于2026-09-28引入）。
 */
export default async function NewSessionPage({
	searchParams,
}: {
	searchParams: Promise<{ mode?: string }>; // 接受 mode 参数：可以是 teach(默认) 或 practice
}) {
	const { mode } = await searchParams;
	return (
		<NewSession
			// 同理，传递模型插槽配置状态以决定是否显示全局设置提示
			initialConfigured={slotsConfigured(readSettingsRecord()?.models)}
			// 根据 URL 参数决定当前草稿视图的模式，默认是教学模式 ("teach")
			mode={mode === "practice" ? "practice" : "teach"}
		/>
	);
}
