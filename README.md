# AIAppNest

Windows 本地 AI 应用工作台。当前提供 Electron + Vue 3 + TypeScript 基础工程，包含独立 Node Service Host 和类型化 IPC；应用管理、SQLite 仓储、模型凭据与 Pi 执行尚未接入。

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

**当前验证限制：**前置 [Pi Spike 报告](docs/technical/pi-windows-spike-report.md)仍为 BLOCKED（真实模型与 DPAPI 验收未完成）。本次执行环境还因 Windows 运行时目录 ACL 阻止 Electron 创建沙箱进程，桌面集成验证尚未通过。没有关闭沙箱、跳过桌面测试或以模拟结果替代验收。请以验证记录及 CI 实际结果为准。

发行安装包、签名、自动更新不在本次范围；`dist` 是本机运行的构建目录，不是可分发安装包。已有 Pi 验证入口保留于 [spikes/pi-windows](spikes/pi-windows/README.md)。
