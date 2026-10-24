import type { Metadata } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

/**
 * RootLayout 是 Next.js 应用的根布局组件，它包裹着整个应用的所有页面。
 * 它的主要作用是注入全局依赖的 Context 提供者，比如服务器事件流、外观设置、
 * 侧边栏状态以及活动停靠栏状态，并构建整个应用的外壳 (AppShell)。
 *
 * 根据架构设计，Stage 层 (这里) 是没有任何服务端业务逻辑的，它仅作为纯粹的 UI 容器。
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`dark ${ui.variable} ${prose.variable}`}>
			{/* min-h-dvh 保证应用最小高度充满视口（考虑到移动端动态视口高度），antialiased 开启平滑字体渲染 */}
			<body className="min-h-dvh antialiased">
			{/* ServerEventsProvider 提供了全局的服务器事件(SSE)通知通道。
			    它在应用的最外层被挂载，保证侧边栏、停靠栏和具体页面组件都可以订阅到最新的服务器推送更新。
			    取代了之前的轮询机制。 */}
			<ServerEventsProvider>
				{/* 外观/主题设置的提供者 */}
				<AppearanceProvider>
					{/* 侧边栏状态的提供者 */}
					<SidebarProvider>
						{/* 右下角/底部活动停靠栏（监控后台任务等）的提供者 */}
						<ActivityProvider>
							{/* 应用的主外壳，内部包裹着具体的页面内容 */}
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* 自动更新提示横幅：这是一个独立于主页面的固定卡片，仅在 Electron 环境下有效，用于通知新版本。 */}
			<UpdateBanner />
		</body>
		</html>
	);
}
