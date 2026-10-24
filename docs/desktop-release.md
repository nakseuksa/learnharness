# 桌面端构建与发布 (Desktop builds and releases)

## 平台 (Platforms)

| 平台 (Platform) | 构建运行器 (Build runner) | 软件包 (Packages) | 应用内更新 (In-app update) |
|---|---|---|---|
| macOS, Apple Silicon | `macos-26` (arm64) | 签名/公证的 DMG + ZIP | 通过 Squirrel.Mac 使用 ZIP |
| Windows, x64 | `windows-2025` | 未签名的单用户 NSIS 安装程序 | NSIS |
| Linux, x64 | `ubuntu-24.04` | AppImage + `.deb` | AppImage 替换；`.deb` 通过 dpkg/apt，如需要会提权 |

首次发布时故意禁用了 Windows 签名。初次安装时，SmartScreen 可能会警告存在未知发布者。AppImage 是 Linux 首选下载方式，因为它自带完整环境，而且更新无需管理员权限。打包的 `electron-updater` 6.8.9 也支持 `.deb` 更新；但更新时可能会要求输入管理员密码。两者使用相同的下载/重启横幅提示。

所有三个平台都保留了自定义的应用栏 (custom app bar)。macOS 保留左侧的红绿灯按钮 (traffic lights)；Windows/Linux 则使用 Electron 原生的右侧窗口控制覆盖层 (Window Controls Overlay)，并从覆盖层的实际几何区域预留出 CSS 空间。Windows/Linux 在按下 Alt 键前隐藏原生菜单。macOS 保留其系统菜单。

图标按平台区分 (2026-10-13)：macOS 通过 actool 将 Icon Composer 文档 `build/icon.icon` 编译进 `Assets.car` 中 (macOS 26 Liquid Glass 风格)，再生成一个后备 icns，最后 `scripts/after-pack.cjs` 会将它替换为手动打包的全分辨率 `build/icon.icns` (actool 的上限是 256px)；Windows 嵌入 `build/icon.ico`，Linux 使用 `build/icon.png`，两者都是由 `node scripts/make-icons.mjs` 基于扁平设计 (`build/icon-flat.svg`) 生成的。构建 mac 图标需要 **macOS 26+ 和 Xcode 26+** (`actool`)：Xcode 26 的资源编译器在 macOS 15 上会崩溃，因为其宿主框架缺少必需的符号。`desktop:dist` 在本地注入了 `DEVELOPER_DIR`；发布打包环节使用 `macos-26`，并通过 setup-xcode 选取 Xcode。旧版本系统的降级图标仍然被保留。Linux 的桌面标识是 `learnharness.desktop`。公共包维护者的元数据使用的是负责人的 GitHub no-reply 邮箱；支持请求需通过 [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues) 提交。

## 构建管道 (Build pipeline)

各操作系统自行安装依赖项，并构建自身的 Next 独立项目树 (standalone tree)：

1. `npm ci`
2. 运行针对该操作系统的原生 PDF/SVG 渲染器测试，测试跑在 Electron 绑定的 Node 环境下（无需显示）。
3. `npm run build` (`output: "standalone"`)。
4. `node scripts/build-server.mjs` — 拷贝静态资源，拦截泄漏的数据/密钥，仅移除 standalone 根目录下的 `dist/` 和 `node_modules/electron/` (旧版安装程序及开发时运行时环境)，检查提示词资源 (prompt assets)。运行时依赖项自带的 `dist/` 目录和原生渲染器二进制文件保持不变。
5. `node scripts/smoke-server.mjs --electron` — 在 Electron 绑定的 Node 环境下启动这个独立服务器 (standalone server)，采用空的临时数据/认证信息，随后检查主页路由与只读 (GET-only) API。
6. `npx electron-builder <platform flags> --publish <policy>`。

外壳/更新程序被打包进 `app.asar`；独立服务器与原生渲染器二进制文件以不打包的形式放在 `extraResources` 中提供。**绝不要跨平台构建服务端载荷 (server payload)**。Next 会追踪构建机器上的原生二进制文件，因此在 macOS 下构建出来的独立程序树绝不能作为 Windows/Linux 的载荷。

本地的 macOS 签名流程仍由 `npm run desktop:dist` 处理，需用到 `LH_NOTARY` 钥匙串配置。若要在本地构建 Windows/Linux 包，请先执行上方的步骤 1–5，然后再运行：

```sh
# 在 Windows 上:
npx electron-builder --win --x64 --publish never

# 在 Linux 上:
npx electron-builder --linux --x64 --publish never
```

## CI 与发布 (CI vs release)

`.github/workflows/ci.yml` 会在 main 分支的 push 操作与拉取请求 (pull requests) 上运行：

- 在 Ubuntu 环境中进行类型检查、运行完整且确定性的测试套件以及 lint 代码。
- 在 macOS (`macos-15`)、Windows 和 Linux 上进行原生渲染器测试，外加独立构建/启动冒烟测试 (standalone build/boot-smoke)。这个 macOS 作业无需编译 Icon Composer 资源；只有发布包需要较新的 runner。

`.github/workflows/release.yml` 包含两种刻意隔开的模式：

- **Manual / Run workflow (手动 / 运行工作流):** 这生成的是未签名的演练版安装包，会作为 workflow 制品 (artifacts) 保留 7 天。不需要任何签名密钥，不创建发布版本，并且不公布任何东西。macOS 的公证 (notarization) 流程被跳过。第一轮的人工冒烟测试请使用 Windows/Linux 平台下生成的制品。这些不是正式用于生产的 macOS 安装程序。
- **Push `v<package.json version>` (推送标签):** 先走门控检查，接着有一个作业创建或复用一个 **单一的 GitHub 草稿发布 (single draft GitHub Release)**，随后，三个操作系统的作业会并行打包、上传它们的制品并更新元数据。这就避免了争相创建草稿的情况。如果已经发布或者存在歧义的版本，会在准备阶段报错，而不会执行修改。相同引用 (ref) 下分开触发的运行将被序列化处理，决不允许中途取消上传。这个标签必须与 package 版本号一致。macOS 必须成功完成签名和公证；缺少机密数据会直接导致失败。这个工作流绝不会自动发布那个草稿 (publish the draft)。当这三个打包任务都成功之后，接下来是一个只读的 **验证草稿发布 (Verify draft release)** 任务（见下文），若草稿不完整或者不一致，该任务将令此次运行失败。

这三个打包作业会上传独立的更新 feed 文件：`latest-mac.yml`，`latest.yml`，`latest-linux.yml`，其中对应了相符的 ZIP/NSIS/AppImage/deb 制品以及 blockmaps。**一个半成品的草稿绝不能被拿去发布 — 这是由最后一个作业通过机制强制保障的。** 这个应用程序内置的是不带 Token 的 GitHub 更新源：**在最终用户可以下载更新之前，该代码仓库必须是公开的 (public)。** 将仓库设为公开，并最终发布该版本，这仍是负责人的工作。

### 验证作业 (The verification job)

`verify` 任务只会在推送 tag 时运行（需要 `needs: package`，因此会在 **所有三个 (all three)** 打包流程走完后执行；手动演练版啥都不上传，直接跳过此项）。它会检出包含该标签的修订版本，不保留任何凭据，并执行 `scripts/verify-release.ts`。由于 GitHub 需要有推送权限才能列出 **草稿 (draft)** 版本的发布项，故即便是只读操作（GET-only），该任务也需要 `contents: write` 的权限。这个 token 仅仅暴露给了 “列出发布版本” 以及 “下载 feed 文件” 的操作步骤里，而绝没有泄露在安装依赖和离线校验的环节中。校验器 (validator) 会：

- 使用与生成草稿时相同的标签匹配规则及 electron-builder 的发布者规则来寻找草稿版本 — 即 `tag_name` 必须等于 `v<version>` **或者** 单纯等于 `<version>`；如果匹配不到、匹配出两个或匹配到了一个已经公开的发布版，都会直接判任务失败，且若该草稿仅通过无 `v` 前缀的模式被匹配上，校验器也会抛出警告信息予以标注 (说明后来的运行有可能在带 `v` 前缀的情况下又建一个新草稿，从而导致资源分散 — 在对外发布前应予以重命名)；
- 若发布版本未 **精确且唯一地 (exactly)** 包含以下 11 个制品资源，则判作失败 — 绝对不能有遗漏，绝对不能有多出的内容 (从老版本的运行中遗留了过期名称则报错)，不能出现零字节的文件，也不能有状态不为 `uploaded` (已上传) 的项：

| 资源 (Asset) | 角色 (Role) |
|---|---|
| `LearnHarness-<v>-arm64.dmg` + `.blockmap` | macOS 安装程序 |
| `LearnHarness-<v>-arm64-mac.zip` + `.blockmap` | macOS 更新负载 (Squirrel.Mac 会通过此 ZIP 安装) |
| `LearnHarness-<v>-x64-setup.exe` + `.blockmap` | Windows NSIS 安装程序 |
| `LearnHarness-<v>-x86_64.AppImage` | Linux AppImage (没有配套的 blockmap) |
| `LearnHarness-<v>-amd64.deb` | Linux deb (没有配套的 blockmap) |
| `latest-mac.yml` / `latest.yml` / `latest-linux.yml` | 更新 feeds |

  （Linux 下的这些命名是蓄意为之：由用户设置的 `linux.artifactName` 应用于两个 Linux 目标产物上，其中的 `${arch}` 变量在每个产物内部分别被展开 — AppImage 中展开为 `x86_64`，deb 中展开为 `amd64` — 这正好与 app-builder-lib 26.15.3 所产出的名称完全一致。如果 `electron-builder.yml` 的内容逐渐背离这些规范，脚本的预期也会直接按照失败闭环处理。）；
- 从草稿中下载那三份 feed 配置文件，只要发生解析失败、未包含 `package.json` 的版本号，或者其引用的资源未能 **完全对应 (exactly)** 上传列表中的资源，都判为失败 — 此处仅比对纯文件名 (不含路径，不含遍历字符，不含 URL)，所引用的文件大小需同 API 返回的大小一致，且 ZIP 必须位居 `latest-mac.yml` 里的首位，而最外层的 `path`/`sha512` 须与首个文件条目保持一致。

该任务只进行读取操作（发布列表 + 下载资源）；绝不创建、编辑、发布，也绝不删除任何数据。

## macOS CI 机密信息 (macOS CI secrets)

在仓库的 **Settings (设置) → Secrets and variables (机密与变量) → Actions** 路径下添加以下内容：

| Secret | 值 (Value) |
|---|---|
| `MAC_CSC_LINK` | 用 Base64 编码的 Developer ID Application `.p12` 备份证书，需包含私钥 |
| `MAC_CSC_KEY_PASSWORD` | 保护该 `.p12` 文件的密码 |
| `APPLE_ID` | 用于进行公证 (notarization) 的 Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | 对应上方 Apple ID 的 App 专用密码 |
| `APPLE_TEAM_ID` | `JS6XN22HY6` |

该工作流 (workflow) 将把证书类的 secret 映射到 electron-builder 的 `CSC_LINK` / `CSC_KEY_PASSWORD` 上去。GitHub 自身提供的 `GITHUB_TOKEN` 为 `GH_TOKEN` 补足了带有本作业作用域限制的 `contents: write` 权限；因此无需提供独立的 GitHub token secret。签名证书相关信息仅在此打包环节内可用，而在构建 Next 应用时是拿不到这些的。**任何时候都绝对不能将证书、密码以及 `.env.local` 提交到版本库中。**

## 首次发布操作指南 (First release runbook)

1. 将实现的代码推送 (Push) 上去；跑一遍针对桌面发布 (Desktop release) 的手动工作流。
2. 在 Windows/Linux 上进行人工冒烟测试：执行 安装/打开、检查窗口按钮及拖拽效果、将侧边栏缩小测试、检查缩放功能、检查设置/密钥项、会话/恢复状态、进行原生 PDF/SVG 测试并确认其能够使用演示辅助功能 (demo helper)。macOS 在生产环境中需始终保持已签名/公证 (signed/notarized) 的状态。
3. 添加 macOS 的 签名/公证 所需的机密信息。
4. 将 `package.json` 及锁文件提升至预先协商好的发布版本号；通过本地检测，并推送对应版本号的 `v...` 标签。
5. 等待 **所有三个 (all three)** 打包作业 **以及最终的 验证草稿发布作业 (Verify draft release job)** 全部完成 — 测试门控将机械地检查这 11 份草稿资源及三条更新 feed (是否是单草稿、对不对得起名称/版本/大小/上传状态、以及 feed 文件中是不是只包含该 release 实打实持有的资源)。若这环节没过，解决起因并在发布前重新运行该工作流；只要重新上传资源，electron-builder 就会覆盖掉原先同名资源，测试门控也会把多余的残留内容悉数拒之门外。
6. 负责人需把本代码仓库公开，将完整版草稿公开发布出去，并在先期安装过的旧版程序上确认真正的 GitHub 更新路径是否正常。

首次三平台发布前，**必须执行一轮完整的人工测试**。此后单纯内容的更新，就依赖那套确定性测试套件加上各系统自己执行构建/启动所形成的冒烟矩阵测试便可。若是 `electron/` 目录里的代码、原生模块、打包/更新流程的配置文件甚至 Electron 本身发生了更新，则需要重新开展跨平台的冒烟测试流程。