# Pi Windows 运行时兼容性（spike-v1）

## 锁定清单

| 项目 | 固定值 / 实测值 |
|---|---|
| Node | 24.19.0，Windows x64，Node ABI 137 |
| Pi CLI | `@mariozechner/pi-coding-agent@0.73.1` |
| Pi agent-core / ai / tui | 均为 0.73.1；完整传递依赖以根目录 package-lock.json 为准 |
| 真实入口 | `node_modules/@mariozechner/pi-coding-agent/dist/cli.js`，包 manifest 的 `bin.pi` |
| 适配器 / fixture | `spike-v1` / `deterministic-v1` |
| Windows | Windows 11 Home China，10.0.26200，x64 |
| 测试机器 | AMD Ryzen 9 8945H，16 逻辑处理器，约 31 GiB 可见内存；不记录机器名/账户名 |
| SQLite | Node 自带 `node:sqlite` / SQLite 3.53.3，文件建表、参数化写入、读取已实测 |
| Windows helper | .NET Framework 4.x 的 x64 csc 编译 C#；Win32 Job Object / ProtectedData CurrentUser |

来源：[Node 固定发行目录](https://nodejs.org/download/release/v24.19.0/)、[Pi 固定版本源码](https://github.com/earendil-works/pi/tree/v0.73.1/packages/coding-agent)、[npm 固定 tarball](https://registry.npmjs.org/@mariozechner/pi-coding-agent/-/pi-coding-agent-0.73.1.tgz)。tarball SHA-512 integrity 保存在 lockfile，测试记录还保存 lockfile SHA-256。

安装仅 `npm ci --ignore-scripts`，保留 lockfile。Pi 旧命名空间已被标记 deprecated，后续必须评估迁移到新命名空间，不能把此次验证结论直接套用于新包。当前代码要求 Node 和 Pi 精确版本匹配；模型按 provider/id 校验，拒绝模糊匹配后的其他模型。

## 启动契约与配置发现

Node 使用参数数组和 `shell:false` 启动本仓库 NativeHost；NativeHost 使用 `CreateProcessW` 启动该 Node 的绝对路径和真实 Pi JS 入口，Windows CRT 参数引用经过中文、空格、引号、尾部反斜杠和空参数测试。没有 `pi.cmd`、shell 拼接、`--continue` 或全局 Pi 配置依赖。

已在包内 `dist/cli/args.js`、`dist/main.js`、`dist/core/resource-loader.js`、`dist/core/settings-manager.js` 及启动测试核对：

| 参数 / 配置 | 本版本行为与用法 |
|---|---|
| `--mode rpc` | stdout JSONL；stderr 与协议分开 |
| `--session-dir` / `--session` | 独立会话目录；恢复使用实际返回的绝对 sessionFile |
| `PI_CODING_AGENT_DIR` | 每会话独立 agent 目录；另设私有 HOME/USERPROFILE、TEMP 等 |
| `--no-skills --skill <file>` | 关闭自动发现，保留显式 Skill；同名 identity 在两个应用分别展开 |
| `--no-extensions --extension <file>` | 关闭自动扩展，保留显式平台扩展；fixture 扩展仅在确定性测试加载 |
| `--no-context-files` | 不加载 AGENTS.md/CLAUDE.md |
| `--no-prompt-templates --no-themes` | 关闭相应自动发现 |
| `--system-prompt` / `--append-system-prompt <role>` | 同时显式设置，覆盖 SYSTEM.md/APPEND_SYSTEM.md 自动来源 |
| `--no-builtin-tools` | 内置工具禁用，可信扩展在 session_start 通过 setActiveTools 再限定集合 |
| `--offline` / `PI_OFFLINE=1` | 禁止启动时联网操作；不表示后续模型调用离线 |
| `retry.enabled=false` / `compaction.enabled=false` | 关闭自动后续执行；用于本 Spike 的可证明结束契约 |

**本版本没有禁用项目 settings 的 CLI 参数。** `--no-extensions` 等标志也不阻止 settings/package 解析。方案调整为宿主拥有私有 `cwd`，业务工作区与之分离，启动前检测 `cwd/.pi/settings.json` 并拒绝；不能直接把用户项目作为 cwd。测试在 cwd 与业务工作区都放置带标记资源，验证它们不会进入系统提示词或命令清单，并验证项目 settings 会在启动前被拒绝。

每个子进程重新构造 env，仅保留必要 Windows 目录和会话私有配置变量；指定的 `*_API_KEY` 单独注入目标 Worker。原生编译/保护 helper 也使用最小 env。无 process.env 写入或全量继承。未开放代理环境、自定义模型配置、个人 OAuth 凭据。

## RPC 与平台状态映射

依据安装包的 `docs/rpc.md`、`dist/modes/rpc/rpc-mode.js`、`dist/core/agent-session.js`、`docs/extensions.md` 与本地实测。原始需求的 `agent_settled` 不存在于 0.73.1，不能等待不存在的事件。

| 输入 / 证据 | 平台语义 |
|---|---|
| prompt response `success:true` | 接受；也可能是扩展立即处理，没有新 run |
| prompt response `success:false` | 接受前失败 |
| agent_start / message / tool events | 执行中；事件通常无 command id，同 Worker 单运行关联 |
| tool_execution_start | 还不是已产生副作用；tool_call 权限钩子随后可阻止 |
| tool_execution_end `isError:true` | 工具失败；本 Spike 将整次运行保守记为 failed |
| assistant message_end `stopReason:error` | 模型失败，不把 agent_end 当作成功 |
| agent_end | 候选结束；等待受信扩展的 waitForIdle barrier，再查 get_state / get_messages |
| isStreaming=false、isCompacting=false、pendingMessageCount=0 + 结果消息 | 限定配置下已空闲；成功还要求末条会话消息与本轮最终 assistant 事件一致、stopReason=stop，且无错误；length/toolUse 不记成功 |
| input hook `{action:'handled'}` | RPC 仍只有 success:true，没有标准 handled 字段/结束事件；平台扩展额外发 SPIKE_HANDLED 通知，映射 handled |
| abort response | 取消请求完成，仍须在同一取消期限内等待运行结束；否则关闭 Job 强制清理，实测核对工具子进程退出 |
| 超时、解码错误、进程退出 | 拒绝所有 pending 请求，退休 Worker，不复用不确定状态；运行 interrupted/失败 |

不假设响应一定先于事件；按 id 关联响应，按一个 Worker 的活动 run 关联事件。barrier 是受信任的扩展命令，不能用于任意扩展组合：如重新启用自动重试、压缩、消息队列、扩展异步跟进，必须重做稳定结束验证。空闲时间窗口本身不被视作完成证明。

读取状态用 get_state/get_messages，平台不修改 Pi JSONL。恢复前只读检查绝对路径、realpath 归属、文件类型、可读性和会话 header/cwd，恢复后再确认引擎返回路径。header 是锁定版本的只读防错预检，不是自行实现的会话恢复器。

## 原生能力、权限和分发

Job 原型用 `CREATE_SUSPENDED` 消除分配前创建子进程的窗口，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，Job 句柄不继承，不允许 breakaway。宿主监测使用进程句柄，避免不断按 PID 枚举和误杀。测试包含 abort、取消超时、正常关闭、强杀 Worker、宿主异常退出及无关进程存活。实现依据 [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。WMI/服务启动等越出普通子进程模型的行为不在此沙箱承诺内。

DPAPI 使用 .NET ProtectedData、CurrentUser，经 stdin 传入数据，密文保存本地；没有命令行密钥。当前受限自动化令牌下 Protect 报 `CryptographicException 0x80131430`，未完成保存/读取，需普通用户环境重测。依据 [CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)，此保护与用户/机器相关，迁移机器或账户需要重新绑定凭据。

SQLite 选择 Node 内置绑定，不引入 better-sqlite3 等外部 ABI 包。后续继续使用单独 Node 24.19.0 sidecar，不能假设 Electron 自带 Node 可直接替代。NativeHost 是 .NET Framework x64 程序，无 Node addon ABI；生产包应预编译、签名并验证目标系统 .NET，不要求用户装编译器。Pi 依赖含 Photon WASM 和可选 clipboard/koffi 二进制，本次仅验证 RPC 文字路径，不代表交互剪贴板和图片功能已通过打包测试。

许可证核对见 [锁文件清单](evidence/pi-license-inventory.json)：197 个依赖条目均有声明，MIT 121、Apache-2.0 37、BSD-3-Clause 15、ISC 13、BSD-2-Clause 5、BlueOak-1.0.0 5、0BSD 1（含其他平台的 optional 包，不全是本机安装项）。Pi 为 MIT；Node 的发行 LICENSE 含第三方 notices，SQLite 自身为公有领域，Node 绑定仍随 Node 许可证交付。对照来源：[Node v24.19.0 LICENSE](https://github.com/nodejs/node/blob/v24.19.0/LICENSE)、[Pi v0.73.1 LICENSE](https://github.com/earendil-works/pi/blob/v0.73.1/LICENSE)。

分发要求：保留 MIT/ISC/BSD/BlueOak 等版权及许可文本；Apache-2.0 组件保留许可证与存在的 NOTICE、标明修改；随 Node 分发其完整 LICENSE 和第三方声明；保留可选本机二进制及 WASM 的相应声明。此清单是声明核对，不是安装包许可证附件。本 Issue 不分发第三方二进制；正式安装包必须收集实际包含组件的 LICENSE/NOTICE 并核对实际产物，不能仅附一个 MIT 文件。系统 .NET/Windows 组件依赖系统提供，不从本仓库复制分发。
