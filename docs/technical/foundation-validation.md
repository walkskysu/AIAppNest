# Foundation F01–F14 验证记录

日期：2026-10-02。环境：Windows x64、Node 24.19.0、npm 11.17.0。Issue #3 正文没有逐条定义 F01–F14，本表将完成标准映射为可复现测试编号，不声称引用了额外验收原文。

## 当前实测

- `npm.cmd run typecheck`：PASS。
- `npm.cmd run build`：PASS，生成 Electron Main/preload、Vue 生产资源和固定 Node sidecar。
- `node --test --test-concurrency=1 tests/integration/service.test.mjs`：7 组全部 PASS，运行真实 Node 子进程；故障注入 fixture 明确位于 tests，不进入应用入口。
- `node --test --test-concurrency=1 tests/integration/desktop.test.mjs`：3 组 FAIL，全部在 Electron 创建窗口之前因 Windows sandbox 的运行时目录访问检查退出。没有完成这些桌面断言，不能记为 PASS。
- 完整 `npm.cmd test`：35 项，30 PASS、4 FAIL、1 SKIP，退出码 1；4 项失败是上述 3 项桌面测试加开发构建桌面测试，均为同一 sandbox ACL 启动错误。SKIP 是已有 Spike 的 DPAPI 环境门禁。开发构建本身成功，但不能据此认定开发桌面启动通过。

Electron 44.5.1 的启动错误为：`Sandboxed processes cannot read ... node_modules/electron/dist ... its ACL has an entry for an AppContainer package SID but none for ALL APPLICATION PACKAGES`。本任务未修改受管理工作区 ACL、禁用 sandbox 或改为跳过测试。需要宿主提供符合 Electron Windows 沙箱读取要求的运行环境，然后完整执行 `npm.cmd test`。测试会在失败时保持非零退出。

托管发布检查的首轮结果不同于受限 shell：宿主可成功启动真实 Electron，完整测试 32 PASS、3 FAIL、0 SKIP，既有 DPAPI 也通过。中文空格路径下缺 sidecar 的失败反馈与手动重试 PASS。其余测试暴露 DevTools 偏好快照不包含该开关、Windows launcher PID 不等于实际 Main PID；已改为检查 DevTools 实际开启行为并终止实际 Main PID，待托管复查。

第二轮托管检查完成了生产窗口安全、完整调用链、页面刷新、第二实例、服务崩溃/重试、退订与 Main crash 清理的实际断言，但两个测试在收尾访问已经释放的 Playwright process 对象时失败；已改为跟踪 close 事件。开发 DevTools 测试等待超时，已给事件等待设置 5 秒上限，并允许仅开发构建读取内置 `devtools:` 资源。最终托管检查结果以发布工具的检查记录为准；下表保留受限 shell 的原始结果，不将尚未结束的复查提前记为 PASS。

## 验收矩阵

| 编号 | 覆盖场景 | 本次结果 / 证据 |
|---|---|---|
| F01 | 固定 workspace/运行时，一条命令启动 | 构建 PASS；完整桌面启动 BLOCKED |
| F02 | Renderer 无 Node/fs/process/通用 IPC，安全窗口和 CSP | BLOCKED；desktop.test 真实窗口断言待运行 |
| F03 | Renderer→preload→Main→Host 调用链和响应关联 | Node Host 并发回显 PASS；完整链路 BLOCKED |
| F04 | 输入与输出 schema 校验、非法方法/额外字段/错误响应 | 真实 Host 非法输入与故障进程输出 PASS；preload/外来窗口验证 BLOCKED |
| F05 | 缺 Node/入口、握手超时、协议不匹配 | Node 真实进程 PASS；UI 失败反馈 BLOCKED |
| F06 | 服务崩溃事件与不可用状态 | Node 真实进程 PASS；UI 通知 BLOCKED |
| F07 | 手动重试、无自动重启、重试代隔离 | Node 真实进程 PASS；按钮行为 BLOCKED |
| F08 | 正常退出无遗留服务 | Node 真实进程 PASS；关闭窗口行为 BLOCKED |
| F09 | 请求超时拒绝所有 pending、不重放、强制关闭 | 真实故障进程 PASS；乱序响应关联 PASS |
| F10 | 页面刷新不创建新服务、不累积监听 | BLOCKED；desktop.test 连续三次 reload 与退订测试 |
| F11 | 单实例与重复启动不增服务 | BLOCKED；desktop.test 启动第二个真实 Electron |
| F12 | Main 被终止后 Service Host 退出 | BLOCKED；desktop.test 终止真实 Main 并查询 sidecar PID |
| F13 | 环境白名单、无凭据/Node 注入、无模型依赖 | 白名单断言和真实 Host 启动 PASS；未测业务凭据（范围外） |
| F14 | 开发/生产构建、中文空格路径、Windows CI | 生产构建 PASS；实际桌面与 CI 结果待验证 |

## 复现和已知限制

`npm.cmd test` 包含类型检查、生产构建、全部 Foundation 集成测试以及现有 Pi 回归。`development.test.mjs` 独立创建开发构建并启动真实 Electron，检查开发工具可用且隔离仍开启。每次测试使用工作区内独立 user-data-dir；中文空格路径测试复制实际运行时，并通过暂时移走 sidecar 文件制造启动失败，恢复后点击重试。生产代码没有测试模式、任意可配置入口或故障命令。

Playwright 使用真实 Electron 自动化，测试本身需要临时 inspector/远程调试端口；这不属于应用服务端口。正常 dev/start 不设置这些参数。测试异常不会降级为 `--no-sandbox`。故障 fixture 只用于可控地产生不响应、协议损坏和乱序，不能代替真实 Electron 安全验证。

前置 [Issue #1](pi-windows-spike-report.md) 仍存在真实模型和 DPAPI 阻塞；它的回归中有明确 DPAPI BLOCKED skip，不代表完整 Spike 通过。此骨架没有接入这些业务能力。Windows CI 配置已提供，但本地检查不等同于 GitHub Actions 已通过；只有远端实际执行成功才能补充 CI PASS 结论。
