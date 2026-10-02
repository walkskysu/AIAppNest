# Windows Pi 技术验证

这是 Issue #1 的验证程序，不是平台业务实现。**当前结论为 BLOCKED**：真实模型凭据未提供，受限自动化令牌下 DPAPI CurrentUser 失败。`npm test` 的成功不等于 V01–V13 验收通过，不得据此推进依赖功能或关闭 Issue。

## 固定环境与安装

Windows 11 x64，Node **24.19.0**（必须精确一致），Pi **@mariozechner/pi-coding-agent 0.73.1**。从 [Node 固定版本发行目录](https://nodejs.org/download/release/v24.19.0/) 安装 x64 Node，按其 SHASUMS 校验下载；开发机需系统自带的 .NET Framework 4.x x64 编译器。所有操作从仓库根目录执行：

```powershell
node --version
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run spike:environment
npm.cmd test
npm.cmd run spike:native
```

`.npmrc` 将缓存放在工作区，`package-lock.json` 固定所有依赖及 integrity。不要执行全局 Pi、`npx ...@latest` 或升级命令。旧包名已被上游弃用，但本次保留已测版本；更换命名空间需重新验收。

`npm test` 使用 **真实 Pi CLI + 确定性 provider fixture**，不联网调用模型、不收费。覆盖真实 Windows 进程、工具调用、Skill 展开、会话落盘和恢复。DPAPI 的已知环境错误 `0x80131430` 会显示明确的 BLOCKED skip；其他错误仍使测试失败。`spike:native` 不跳过，DPAPI/SQLite 未全通过时退出码 2。

## 真实模型验收

用正常 Windows 用户令牌运行。预先通过你的凭据管理工具向当前终端提供一个测试用 API key；不要把密钥放进命令文本、源码、截图或 Issue。仅设置以下非敏感配置：

```powershell
$env:SPIKE_PROVIDER = '你的 Pi provider 名称'
$env:SPIKE_MODEL = '该 provider 的精确模型 ID'
$env:SPIKE_API_KEY_ENV = '该 provider 使用的环境变量名，如 OPENAI_API_KEY'
npm.cmd run spike:live
```

环境变量名必须符合 `*_API_KEY`；不读取个人 Pi auth、OAuth 登录或全局模型配置。本入口面向 Pi 内置 API-key provider，自定义 URL/代理/OAuth 需要单独的受审配置，不能用全量环境继承绕过。

真实验收会调用模型数十次（含 3 种路径、双应用、Skill、权限及长工具测试），可能产生费用。任务和文件均为无个人数据的标记。仅目标 Worker 得到指定 key；无 key 的观察 Worker 用来核对隔离。DPAPI 可用时实际保存并读回加密凭据后注入。DPAPI 不可用时仍可收集模型证据，但总门禁保持 BLOCKED。

`spike:live` 自动先跑确定性回归，再运行模型场景。只有全部条目 PASS 才退出 0；缺配置、原生保护失败、模型拒绝调用测试工具或任何断言失败均退出 2。单个模型调用上限 90 秒，取消 1.5 秒后强制关闭 Job。真实验收入口本次只验证了缺配置分支，成功分支尚需持有凭据的开发者执行。

## 文件和证据

每次运行在 `spikes/pi-windows/.runs/` 下创建唯一目录，不覆盖上次证据；该目录和编译出的 exe 已被 Git 忽略。每个会话独立拥有 `agent/`、`home/`、`cwd/`、`workspace/`、`sessions/`、`skills/` 和角色文件。

- `src/worker.mjs`：参数数组、`shell:false`、RPC 接受/事件/查询联合判定、取消、精确 sessionFile。
- `src/NativeHost.cs`：挂起创建进程 → 加入 KILL_ON_JOB_CLOSE Job → 恢复执行；监视宿主句柄；DPAPI CurrentUser。
- `src/policy.ts`：关闭内置工具，工具入口阻止写操作，realpath 限制的只读替代工具，测试用长进程。
- `fixtures/provider.ts`：仅确定性测试使用，绝不能充当真实模型通过证据。
- `test/`：JSONL 边界和真实 Windows/Pi 回归。
- `.runs/live-*/report.json`：脱敏事件元数据、逐项结论；`session-map.json` 记录引擎返回的精确路径。

stdout 持续按 LF 解码；stderr 单独统计字节数。故意不落原始 prompt、消息正文、stderr、错误正文或环境值，避免上游把 key 回显到日志。内存中仍有 RPC 消息和凭据；`.runs/` 的 Pi 原生会话包含测试对话，不能直接作为公共附件。真实验收会扫描该次运行文件中是否出现密钥原文，但这不能保证检测编码或拆分后的泄漏。

生成可公开的确定性记录与许可证清单：

```powershell
node spikes/pi-windows/src/record.mjs docs/technical/evidence/pi-windows-regression.json
node spikes/pi-windows/src/licenses.mjs docs/technical/evidence/pi-license-inventory.json
```

报告：[测试记录](../../docs/technical/pi-windows-spike-report.md)、[运行时兼容性](../../docs/technical/pi-runtime-compatibility.md)。只提交审查过的元数据，不提交 `.runs`。

## 权限与复现边界

`cwd` 是宿主管理的空目录，用户工作文件放在另一个 `workspace`。Pi 0.73.1 没有禁用项目 settings 的 CLI 开关，所以启动前拒绝 `cwd/.pi/settings.json`，并显式替换 system prompt、禁用资源自动发现。目录本身不构成 OS 沙箱。

仅信任本仓库扩展，关闭自动重试、自动压缩和排队/跟进功能。RPC 无通用 bash/new_session/switch_session 转发入口。测试工具 `test_wait` 和 `denied_write` 仅用于 Spike，不能直接发布到产品。

读工具检查 realpath，可拒绝 `..`、junction、UNC/盘符与 ADS；尚未实现抗并发路径替换的句柄级授权，不处理写授权，也不隔离恶意本地脚本。Job Object 用于清理进程，不是文件权限沙箱。当前宿主的权限令牌和上级 Job 限制可能使原生操作失败，必须保留失败证据。
