# Provider P01–P18 验证记录

日期：2026-10-03。Windows x64 / Node 24.19.0 / Pi 0.73.1。实现与支持边界见 [provider-architecture.md](provider-architecture.md)。

本地执行 `npm.cmd test`：类型检查与生产构建通过，协议/存储/进程测试通过；首次完整执行 68 项：64 通过、3 失败、1 skip。失败为新 P09 CurrentUser DPAPI 不可用，以及 Electron 运行时尚未安装导致桌面/开发测试文件无法加载。原 Spike DPAPI 明确 skip 为环境阻塞。保留这些失败事实，不弱化凭据测试、不关闭 Electron sandbox。宿主发布工具会在托管检查环境重新运行完整命令，最终自动回归结果以 PR 发布检查为准。

随后使用工作区缓存安装 Electron 后重试：P17 和既有 F01 桌面启动仍各约 87 秒后失败，已停止这一轮受限 shell 回归；不因此修改安全配置。P09 后续增加了真实 DPAPI→ProviderService→本地 HTTP 请求的凭据注入与文件扫描，P17 增加了成功保存 Key 后的清空/调用检查，交由宿主完整检查验证。`npm.cmd run provider:live` 缺参数分支实际返回 `BLOCKED / MISSING_EXPLICIT_PROFILES`，没有模型调用。

第 9 次恢复执行重新完成本地 `npm.cmd test`：类型检查、生产构建通过；Electron 测试明确报运行时目录缺少 `ALL APPLICATION PACKAGES` 读取 ACL，P09 仍报 `CREDENTIAL_UNAVAILABLE`，既有 Spike 记录 CurrentUser DPAPI `0x80131430`。这些是受限执行环境中的失败证据，未禁用 sandbox 或跳过产品 DPAPI 测试。审查另修复了畸形 URL 导致 schema refinement 抛异常的问题；追加空端点、无效 URL、损坏 IPv6 及实际 ServiceManager IPC 脱敏/存活断言后，类型检查、构建和 P01/P16 定向回归全部通过。宿主发布检查独立运行完整测试，结果以宿主返回为准。

**真实模型验收仍未完成。** 没有提供受控云端 Key、精确模型 ID 或正在运行的本地推理模型；本次未向真实模型发送请求。模拟服务通过不能替代真实 OpenAI/Ollama 验收，不能宣称 Issue 的全部完成标准已满足。

| 编号 | 自动测试/验收 | 本地证据 |
|---|---|---|
| P01 | 配置白名单、端点认证限制、手输模型 ID | PASS，未知字段/SDK 参数/headers/env/URL secrets 拒绝 |
| P02 | 持久化、脱敏返回、保存不调用 | PASS，SQLite/WAL 文件不含测试 Key，DTO 无 secretRef |
| P03 | v1→v2 迁移、保留凭据引用和校验和 | PASS，迁移重复执行、旧行待配置 |
| P04 | 乐观并发控制 | PASS，旧表单不能写配置或创建新凭据 |
| P05 | 保留、替换、清空、端点换绑 | PASS，使用故障可控内存凭据替身 |
| P06 | 凭据写失败 | PASS，旧修订和旧 Key 保持可用 |
| P07 | DB 失败、补偿失败、崩溃孤立文件 | PASS，启动恢复只清理未引用凭据 |
| P08 | 提交后清理失败、外键引用保护、删除 | PASS，新 Key 可用，旧凭据可重试清理 |
| P09 | 产品 helper Windows DPAPI，密文、重开、损坏/缺失 | 本地环境失败；Windows CI 硬检查，不用替代加密、不 skip |
| P10 | Pi 协议真实 HTTP/SSE 固定短请求 | PASS，POST chat/completions，无认证无 Authorization |
| P11 | 401/403、404、429、5xx，无重试、错误脱敏 | PASS，不回传上游回显 Key |
| P12 | 坏/空/截断/超大响应、重定向拒绝 | PASS，重定向目标零请求 |
| P13 | 总时限与 Worker 终止 | PASS，挂起流及时终止 |
| P14 | 在途配置变更、缺失凭据 | PASS，stale 标记、失败关闭 |
| P15 | 多模型并行、环境白名单、并发上限 | PASS，实际模型请求对应不同 Key，全局 env 不变 |
| P16 | 实际 Main manager→Service Host IPC | PASS，非法明文读取请求拒绝，完整本地协议调用 |
| P17 | 实际 Electron 设置页、显式调用、Key 清空、结果失效 | 已加入 Playwright 硬检查；最新受限 shell 执行被 Electron sandbox 目录 ACL 阻塞 |
| P18 | 云端和兼容本地真实模型 | BLOCKED，人工集成配置未提供；独立门禁入口见下 |

P01–P16 位于 `tests/integration/providers.test.mjs`，P17 位于 `desktop.test.mjs`；P18 的缺少显式配置门禁分支也有自动测试，其通过不代表真实模型验收通过。普通 CI 只使用本地 HTTP 服务和非敏感测试标记；DPAPI 测试使用真正的产品 helper。Foundation/Storage 的已有测试保留，迁移测试随新增版本更新，生产 IPC 暴露表仅增加一个严格的 providers 请求入口。

## P18 人工集成门禁

1. 在正常 Windows 当前用户会话执行 `npm.cmd ci`、`npm.cmd run build`、`npm.cmd test`，确保 P09/P17 通过。
2. 启动桌面“模型设置”。选择“DeepSeek 官方”，确认 `https://api.deepseek.com`、`deepseek-flash`，超时可输入 60000 ms；Key 仅在本机密码控件输入并保存。也可使用已有 OpenAI 官方非 reasoning 文本配置。再配置一条本地兼容服务（计划 Ollama `/v1`，先在本机准备并启动真实模型）。记录准确服务/模型版本，不把 Key 写入仓库、环境变量、命令行或普通 CI。
3. 分别点击“测试模型连接”，核对修订与结果。从设置页的“配置 UUID”复制这两条非秘密 ID，不需要导出数据库。记录实际数据根：默认 `%LOCALAPPDATA%\LocalAIHub`；若通过 Electron `--user-data-dir=<profile>` 启动，则使用 `<profile>\platform`。
4. 关闭桌面并等待 Service Host 退出，避免人工验收进程与 Service Host 同时写同一数据库。显式执行下列命令。参数不包含 Key；脚本从 DPAPI 解析已存凭据，只发固定短请求，可能产生少量模型费用。

```powershell
npm.cmd run provider:live -- --data-root=C:\受控数据目录 --cloud=<云端配置UUID> --local=<本地配置UUID>
```

脚本接受 OpenAI 或 DeepSeek 官方作为 `--cloud`，必须同时提供 `--local`。两条配置的准确修订、运行配置和凭据均在任何调用之前校验；只有两者均完整生成文本成功且未过期才返回 PASS/退出码 0。失败或缺参数为 BLOCKED/退出码 2。证据写入独立忽略目录 `.test-provider-live-*/report.json`，仅含提供商、模型 ID、修订、非思考文本 SSE 测试模式、时间、耗时和固定分类，无端点、Key、secretRef、请求/回复或异常正文。分享前核对模型 ID 不含敏感业务标识。保存原始失败证据后重跑，不手改结果。缺参数不会发生模型调用；无凭据/配置时明确 BLOCKED，不提供冒充完整验收的云端单独 PASS。

验收需补充具体模型/本地服务版本、产品 DPAPI 成功记录与报告；跨账户解密失败需在另一个正常 Windows 用户会话人工验证。本 Issue 不以一次文本成功认证工具、多模态或完整任务执行能力。前置 Spike 的其余真实会话门禁仍按原报告单独完成。

## Issue #21：D01–D11（2026-10-03）

在已合并 Provider 基线上实现；以上 P01–P18 的历史失败和待验收记录保留。DeepSeek 官方文档及锁定 Pi 源码核对依据见 [参数兼容性](provider-architecture.md#deepseek-参数兼容性核对2026-10-03)。

| 编号 | 验证内容 | 当前证据与边界 |
|---|---|---|
| D01 | UI 默认值、保存、重载；SQLite 关闭重开 | 服务持久化自动测试通过；新增真实 Electron 设置页回归，完整结果见下 |
| D02 | 实际模型、thinking、Bearer、URL、输出预算 | PASS，正式 Service/Runtime/Pi 路径到 HTTP 捕获，精确完整请求体断言 |
| D03 | 正常 SSE 非空最终正文 | PASS，必须 stop、DONE、完整流结束 |
| D04 | 仅思考、空正文、length、缺标记、畸形/未知/错误/超大流 | PASS，全部拒绝误报成功，length 单独分类 |
| D05 | DPAPI、脱敏 DTO、日志/配置/SQLite/WAL/密文扫描 | 新增真实产品 DPAPI DeepSeek 测试；非 DPAPI 脱敏/持久化扫描已通过，完整结果见下。命令行路径沿用原 helper 仅传操作名、Key 走匿名管道的实现 |
| D06 | OpenAI → DeepSeek 不沿用 Key、旧修订无效 | PASS 服务测试；另有 Electron 清空/换绑测试 |
| D07 | 401/403/402/404/429/5xx、错误协议、超时、重定向 | PASS，单请求无重试、重定向目标零请求、总时限终止 |
| D08 | 三类 Provider 并行及既有兼容回归 | PASS，实际捕获对应端点/Key、全局环境不变 |
| D09 | DeepSeek 云端门禁、精确修订、缺本地/凭据/参数 | PASS，正式 Service gate 测试；模拟云端成功/本地失败仍 BLOCKED。测试里的模拟 PASS 不是 live 证据 |
| D10 | 本机真实 DeepSeek 非思考文本 | **BLOCKED / 待用户本机验证**：未提供真实受控 Key；未向 DeepSeek 发送真实请求 |
| D11 | 真实云端 + 真实本地完整前置门禁 | **BLOCKED / 待用户本机验证**：没有真实本地模型验收证据；本 PR 不解除 #9 阻塞 |

定向回归命令 `node --test --test-name-pattern='D0|P10|P11|P12|P13|P15' tests/integration/providers.test.mjs`：首轮 9 项全部通过（加入 D05 原生检查之前）。普通 CI 使用非敏感测试标记和本地 HTTP 服务，不需要真实 API Key。D10/D11 必须另附在正常 Windows 当前用户会话按上述步骤产生的脱敏报告，不因代码发布、合并或标签变化自动通过。

本次受限 shell 完整执行 `npm.cmd test`：类型检查、生产构建通过，74 项中 69 PASS、4 FAIL、1 SKIP。P09/D05 为 CurrentUser DPAPI `CREDENTIAL_UNAVAILABLE`；desktop/development 两个测试文件因 Electron 运行时下载 `fetch failed` 无法加载；既有 Spike DPAPI 报 `0x80131430` 并 skip。未关闭 sandbox、未替代明文存储、未跳过新增 DPAPI/桌面硬检查。随后修订失效、门禁预检报告及端点兼容审查后，再次类型检查/构建与无原生环境依赖的 Provider 定向回归通过；宿主发布工具会对最终文件独立运行完整 `npm.cmd test`，托管自动回归以其返回结果为准。

首次宿主完整检查：79 项，78 PASS、1 FAIL、0 SKIP。P09/D05 产品 DPAPI 和既有 Electron 测试全部通过；新增 D01/D06 桌面用例在 option 禁用断言失败。已改为直接检查原生 option.disabled（避免 Playwright 将状态查询重定向到外层带 label 的 select），保留该检查后重新提交完整回归。

恢复执行后的最终受限 shell 回归：`npm.cmd test` 类型检查及构建通过，79 项中 70 PASS、8 FAIL、1 SKIP。6 个 Electron 用例因运行时目录缺少 sandbox 所需的 `ALL APPLICATION PACKAGES` 读取 ACL 无法启动；P09/D05 仍因 CurrentUser DPAPI 不可用失败；原 Spike DPAPI 环境检查 skip。其余 Provider 实际请求、SSE、修订、隔离、门禁与存储测试通过。未修改 ACL、关闭 sandbox 或绕过 DPAPI；最终完整自动回归由宿主发布检查重新执行。D10/D11 仍没有真实模型证据。
