import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { slotsConfigured } from "@/src/core";
import { compactionInFlight, getChat, isTurnRunning, readSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * ChatPage 组件负责渲染一个特定 ID 的会话页面。
 * 它通过动态路由 /chat/[id] 被调用。
 */
export default async function ChatPage({
	params,
	searchParams,
}: {
	// Next.js 15+ 动态路由参数是 Promise
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);

	// 从服务端存储获取对应的会话记录，如果找不到则返回 404 (notFound)
	const chat = getChat(id);
	if (!chat) notFound();

	// 首次运行拦截/设置状态读取：检查用户是否配置了必需的模型插槽。
	// 虽然实际拦截发生在服务端的 503 响应处，这里的配置状态会决定客户端
	// 是否显示 "Setup CTA" 提示药丸 (pill)。与主页读取逻辑保持一致。
	const record = readSettingsRecord();

	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"} // 兼容历史数据，未指定类型的默认为教学会话
			// Wave D 架构特性：这里传递的是原生的智能体历史消息记录，
			// 客户端（组件内部）会使用 core/view.ts 将其派生转化为适合呈现的 UI 消息数组。
			initialMessages={chat.messages}
			// 将用户的模型配置状态传递下去，决定是否显示设置提示
			initialConfigured={slotsConfigured(record?.models)}
			initialPrompt={prompt}
			// 处理断线重连/热重载情况：如果服务端该会话的 turn 还在运行中，
			// 客户端挂载后会进入 loading 状态并附加到该事件流上，避免覆盖脏数据。
			initiallyInFlight={isTurnRunning(chat.id)}
			// 标记后台是否正在对该会话的数据文件进行紧缩处理 (compaction)
			initiallyCompacting={compactionInFlight(chat.id)}
		/>
	);
}
