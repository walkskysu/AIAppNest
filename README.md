# AIAppNest

Windows 本地 AI 应用工作台。当前提供 Electron + Vue 3 + TypeScript 基础工程、独立 Node Service Host、类型化 IPC、SQLite 持久化、应用首页与配置编辑、不可变版本、复制与归档，以及模型设置、Windows DPAPI 凭据保护和显式连接测试。聊天、试运行与 Pi 会话执行尚未接入。

## 开发启动

要求 Windows x64、Node **24.19.0**、npm **11.17.0**。请使用锁文件安装：

```powershell
npm.cmd ci
npm.cmd run dev
```

`dev` 一条命令构建并启动桌面和服务。首次启动 Electron 44.5.1 会下载官方运行时，也可提前执行 `node node_modules/electron/install.js`。代理环境可按 Node 的代理配置使用 `NODE_USE_ENV_PROXY=1`。服务使用构建时复制到 `dist/runtime/node.exe` 的固定 Node，不使用 Electron 内置 Node、全局 `node` 命令或 Pi spike 脚本。

开发模式从本地 `app://desktop/index.html` 加载 Vite 构建资源，允许 DevTools 和 source map；不启动 Vite HTTP/HMR 服务器。修改源文件后关闭窗口并重新执行 `npm.cmd run dev`。

```powershell
npm.cmd run build   # 生产构建：不含 source map，禁用 DevTools
npm.cmd start       # 启动 dist 中的构建
npm.cmd test        # 类型检查、生产构建、真实进程测试及已有 Pi 回归
```

`npm.cmd run test:foundation` 仅执行本次 Foundation 检查。Windows CI 使用同一 `npm test`，不需要模型密钥、全局 Pi 或个人配置。Playwright 会为自动化临时启用调试端口；应用正常启动不开放网络服务。

## 界面与生命周期

- 首页展示启动中、服务就绪、服务异常或停止状态；“检查连接”执行完整跨进程诊断。
- 服务启动失败、协议错误、崩溃或请求超时会显示错误。“重试服务”由用户显式触发；不会重放旧请求。
- 刷新页面仅重新订阅和读取状态。再次启动同一应用会聚焦已有窗口，不创建新服务。
- 关闭最后一个窗口会停止 Service Host。正常关闭超时后终止本应用的服务进程；Main 意外退出时 Service Host 收到 IPC disconnect 后退出。

详见[架构边界](docs/technical/foundation-architecture.md)和[F01–F14 验证记录](docs/technical/foundation-validation.md)。

## 本地持久化

首页无需编辑 JSON 即可创建、搜索、收藏、编辑、复制和归档应用。基础编辑使用草稿乐观锁，发布生成不可变快照；旧会话不随新版本升级。复制清空模型关联和外部目录授权，需重新配置。打开只进入应用空间，不启动 Worker。“可使用（配置就绪）”不代表通过模型连接或端到端试运行。详见[版本与补偿规则](docs/technical/app-architecture.md)和[A01–A10 验证记录](docs/technical/app-validation.md)。

“模型设置”可添加 OpenAI 官方、DeepSeek 官方或本地回环 OpenAI 兼容文本模型。选择 DeepSeek 会填入 `https://api.deepseek.com` 和 `deepseek-flash`；在密码控件输入对应 Key，保存后显式点击“测试模型连接”，超时可设为 60000 ms。保存不产生模型调用，测试可能产生少量费用，仅验证非思考文本连接。数据库仅存凭据引用，测试使用锁定的 Pi 0.73.1。支持范围、凭据生命周期和失败补偿见[Provider 架构](docs/technical/provider-architecture.md)，自动测试与尚待真实模型验收的记录见[P01–P18 / D01–D11](docs/technical/provider-validation.md)。兼容本地接入当前为预览，不代表任意兼容服务已认证。

真实验收先在界面保存云端和本地配置并记录显示的配置 UUID，然后关闭桌面，执行 `npm.cmd run provider:live -- --data-root=<受控数据目录> --cloud=<云端配置UUID> --local=<本地配置UUID>`。命令不接受 Key；完整通过必须同时满足真实云端和真实本地文本测试。根据 #9 于 2026-10-06 更新的开发前置条件，本地模型与完整 provider:live 验收不阻塞应用管理开发；这不代表完整真实模型验收已通过，操作步骤与脱敏证据说明见[人工集成门禁](docs/technical/provider-validation.md#p18-人工集成门禁)。

Service Host 在数据库初始化成功后报告就绪。默认数据目录为 `%LOCALAPPDATA%/LocalAIHub`，数据库位于 `data/platform.db`；显式 Electron `--user-data-dir` profile 使用其 `platform` 子目录。数据库启用外键、WAL 和 busy timeout，初始化失败保留原数据并报告错误。只有 Service Host 操作产品数据库。

领域与仓储已覆盖应用配置版本、Skill、会话、执行、消息/事件、版本化记忆、产物、提供商凭据引用和授权。详见[存储架构与一致性约定](docs/technical/storage-architecture.md)和[S01–S18 真实 SQLite 验证](docs/technical/storage-validation.md)。存储测试使用临时目录，不依赖个人数据或模型密钥；自动恢复核对、跨文件原子提交和备份恢复不在当前实现范围。

**验证状态：**既有 Foundation/Storage 已在托管 Windows 环境通过完整回归，包含真实 Electron 和 Node 的安全与生命周期验证；新增 Provider 的测试状态见 [P01–P18](docs/technical/provider-validation.md)。受限 shell 的 Electron sandbox ACL 失败记录仍保留；没有关闭沙箱或以模拟结果替代桌面验收。前置 [Pi Spike 报告](docs/technical/pi-windows-spike-report.md)的真实模型验收仍未完成，既有 DPAPI 回归通过不代表此前全部验收门禁解除。GitHub Actions 结果须以远端实际执行为准。

发行安装包、签名、自动更新不在本次范围；`dist` 是本机运行的构建目录，不是可分发安装包。已有 Pi 验证入口保留于 [spikes/pi-windows](spikes/pi-windows/README.md)。
