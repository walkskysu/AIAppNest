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
2. 启动桌面“模型设置”。配置一条 OpenAI 官方云端模型（非 reasoning 文本模型，实际可用精确 ID）；Key 仅在本机密码控件输入。再配置一条本地兼容服务（计划 Ollama `/v1`，先在本机准备并启动真实模型）。记录准确服务/模型版本，不把测试 Key 写入仓库或普通 CI。
3. 分别点击“测试模型连接”，核对修订与结果。关闭桌面，避免人工验收进程与 Service Host 同时操作同一数据根。
4. 从数据库中只获取两条配置的 UUID，显式执行下列命令。参数不包含 Key；脚本从 DPAPI 解析已存凭据，只发固定短请求，可能产生少量模型费用。

```powershell
npm.cmd run provider:live -- --data-root=C:\受控数据目录 --cloud=<云端配置UUID> --local=<本地配置UUID>
```

脚本仅当两条真实配置的当前修订均生成文本成功才返回 PASS/退出码 0；失败或缺参数为 BLOCKED/退出码 2。证据写入独立忽略目录 `.test-provider-live-*/report.json`，仅含模型 ID、修订、时间、耗时和固定分类，无端点、Key、secretRef、请求/回复或异常正文。分享前核对模型 ID 不含敏感业务标识。保存原始失败证据后重跑，不手改结果。缺参数不会发生模型调用。

验收需补充具体模型/本地服务版本、产品 DPAPI 成功记录与报告；跨账户解密失败需在另一个正常 Windows 用户会话人工验证。本 Issue 不以一次文本成功认证工具、多模态或完整任务执行能力。前置 Spike 的其余真实会话门禁仍按原报告单独完成。
