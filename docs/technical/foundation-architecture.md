# Desktop / Service Host 基础架构

需求基线：[设计 v1 固定 commit](https://github.com/walkskysu/AIAppNest/blob/c6bdd1a6fdbb5b56486678d7169da8eb9b6f4dd7/docs/requirements/Windows_AI_App_Platform_Design_v1.md)，§5、§6、§11、§12.3、§13.3、§15。前置：[Issue #1 技术报告](pi-windows-spike-report.md)、[运行时兼容清单](pi-runtime-compatibility.md)。前置完整验收未通过，本次只建立不依赖模型与凭据的基础通信，不宣称解除其门禁。

## 工程边界

| Workspace | 职责 |
|---|---|
| apps/desktop | Electron 窗口、安全边界、服务生命周期与消息转发；Vue 状态界面 |
| apps/service-host | 独立 Node 24.19.0 进程，握手、诊断请求、关闭；后续承载业务服务 |
| packages/contracts | Zod 严格运行时 schema、错误码、状态事件、DesktopAPI 类型 |
| packages/domain | 与 Electron 无关的领域类型与固定运行时版本 |
| packages/storage | SQLite 和仓储预留边界，无伪造实现 |
| packages/pi-adapter | 正式 Pi 适配预留边界，不导入 spike |
| packages/memory | 记忆服务预留边界 |
| packages/policy | 权限与审计预留边界，无默认放行实现 |
| tests/integration | 实际 Node/Electron 生命周期、安全及故障注入测试 |

使用 npm workspace；直接依赖采用精确版本，完整传递依赖在根 `package-lock.json`。TypeScript 5.9.3、Electron 44.5.1、Vue 3.5.43、Vite 8.3.2、Zod 4.6.5。esbuild 编译 Main/preload/Service Host，Vite 构建 Vue；生产 preload 为可在 Electron sandbox 加载的单文件 CJS。

## 运行时与通信

```text
Vue Renderer → contextBridge DesktopAPI → Electron ipcMain
                                             ↓ Node child_process.fork IPC pipe
                                      Node 24.19.0 Service Host
```

构建拒绝非 24.19.0 的 Node，将当前 Node 可执行文件复制到 `dist/runtime`。Main 只使用该固定绝对路径和固定服务入口，通过 `fork` 的私有 IPC 通道通信，`execArgv: []`，不启动 shell 或 HTTP/WebSocket 服务。Service Host 不继承模型密钥、PATH、NODE_OPTIONS 等；仅保留基础系统目录与临时目录环境变量。启动器也仅向 Electron 传递系统/UI 所需环境白名单。

Service Host 拒绝不匹配的 Node 版本。Main 发送协议版本与随机 nonce；服务就绪消息必须匹配版本、nonce、真实 PID 和固定 Node 版本。默认 5 秒握手超时，3 秒请求超时，1.5 秒退出宽限期。每个请求由 Main 分配 UUID，按 ID 匹配响应；最多 64 个 pending 请求。异常或超时会拒绝该代全部 pending 并终止服务；迟到消息不得使服务恢复为 ready。

最小白名单 API：

| Renderer 方法 | 输入 | 结果 |
|---|---|---|
| getStatus() | 无 | 当前 phase/revision/pid/error 快照 |
| ping({text}) | 最多 256 字符，无额外字段 | 服务回显、实际 PID 和 Node 版本 |
| retryService() | 无 | 显式启动或现有状态；并发启动合并 |
| onStatusChanged(callback) | 状态回调 | 幂等取消订阅函数 |

没有任意 channel、RPC、文件或命令方法。Renderer → preload 输入校验，Main 再校验输入与发送者；Service Host 再校验收到的命令。Main 校验 Host 消息，preload 校验返回结果和状态事件。错误只含固定码和公共消息，不透传堆栈、文件路径或环境变量。

状态序号单调递增，Vue 先订阅后取快照并忽略旧序号，避免刷新过程中的状态覆盖。每个 preload 文档只有一个原生状态监听，订阅数量有上限；取消订阅与文档销毁均释放回调。Main 只注册一套处理器，页面刷新不启动 Service Host。

## 窗口安全

开发与生产均启用 contextIsolation、sandbox、webSecurity，关闭 Node integration、worker/subframe Node、webview 和混合内容。生产编译移除 DevTools 开关和 source map。固定 `app://desktop` 协议仅返回构建目录的 index.html 和 assets 中的 JS/CSS；CSP 禁止连接、框架、外部脚本、表单及内联脚本。session 拒绝外部请求与权限申请，禁止弹窗、导航及 webview 挂载。

ipcMain 同时核验拥有窗口的 webContents、主 frame 和精确文档 URL。外来窗口、子 frame 与非固定页面均不能使用服务接口。实现参考 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。

## 退出和后续扩展限制

先获取 Electron 单实例锁，再创建服务和窗口。正常退出先关闭服务；宽限期后只终止保存的 ChildProcess。Main 异常退出后私有 IPC 断开，服务主动退出。当前 Service Host 不创建子进程、不接受插件、没有业务任务，因此没有进程树托管实现。引入 Worker 前必须落实经过验证的 Windows Job Object，不能把当前 disconnect 清理视为任意进程树或阻塞事件循环的保证。

失败代进程 close 前拒绝再次启动，避免服务重叠；关闭开始后永久拒绝新请求和重试。首次启动、手动重试与页面刷新均不重放任何已发送业务请求。业务执行幂等、数据落盘和崩溃恢复属于后续实现。

构建目前只复制 Node 可执行文件，未形成发布物。安装包工作须单独完成 Node/Electron/npm 的 LICENSE/NOTICE 收集、固定 sidecar 校验、Windows 签名和实际安装路径/权限测试；不得把本机构建目录当作已完成发行包。
