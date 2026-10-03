# 模型配置与凭据边界

需求基线：[设计 v1 固定版本](https://github.com/walkskysu/AIAppNest/blob/c6bdd1a6fdbb5b56486678d7169da8eb9b6f4dd7/docs/requirements/Windows_AI_App_Platform_Design_v1.md)。Issue #7 的实现复用 Foundation IPC 与 Storage 事务，不实现 Pi RPC 会话或 Worker 任务调度。

## 首发协议矩阵

| 配置类型 | 端点/认证 | 实现范围 | 验证状态 |
|---|---|---|---|
| `openai` | 固定 `https://api.openai.com/v1`，API Key | Pi 0.73.1 `openai-completions`，非 reasoning 文本模型，SSE | 协议实现与本地模拟服务已测；真实云端模型待提供受控凭据验收 |
| `deepseek` | 固定 `https://api.deepseek.com`，必需 DeepSeek API Key | 默认 `deepseek-flash`，同一 Pi 0.73.1 Chat Completions，显式 `thinking.disabled`，SSE | 实际请求捕获及模拟错误回归已测；真实 DeepSeek / 本地模型验收分别待验 |
| `local-openai`（预览） | `http(s)://127.0.0.1:<port>/v1` 或 IPv6 回环 `[::1]`，可无认证/可 API Key | 同一 Pi 协议；计划接入 Ollama 的 `/v1` 文本模型 | 实际 HTTP/SSE、无认证及带 Key 的本地模拟服务已测；真实 Ollama 模型待验收 |

不声称所有 OpenAI 兼容接口均可用。不开放 LAN、任意云端代理、URL 用户信息、查询参数、任意路径、OAuth、SDK 参数、headers、环境变量配置。无模型列表请求，模型 ID 手动输入。仅配置请求超时（100–60000 ms）。协议固定非 reasoning、文本输入；工具调用、视觉、reasoning 模型、上下文容量和完整任务能力未认证。内部模型的 8192 contextWindow/128 maxTokens 是本次短请求保守预算，不是模型能力声明；后续任务执行需独立能力配置与验证。

## 数据、IPC 与编辑

- 追加迁移 v2，保留 v1 SQL/checksum。将 `provider` 改名为 `providerType`，增加名称、模型 ID、认证模式、修订号和更新时间。旧行保留引用、原协议与时间，模型 ID 留空；运行前要求用户明确重新配置，不猜测模型。
- Issue #21 不需要新增 schema：`providerType` 已是开放文本列，领域模型与显示 DTO 为兼容旧行保留字符串类型，运行/保存契约加入 `deepseek` 白名单。v1/v2 SQL 和 checksum 不变，已有配置和 secretRef 原样保留。DeepSeek 官方根 URL（可带末尾 `/`）统一存为 `https://api.deepseek.com`；拒绝 `/v1`、完整生成路径、其他端口/来源、用户信息、查询及片段，不做隐式路径修复。OpenAI/本地端点保存行为不变。
- `ProviderProfile` 只含 `secretRef`。Renderer 输入由 `providerSaveSchema` 校验，保存 ID 由服务生成；编辑/删除/测试必须携带准确 revision。SQLite 事务及触发器防止旧表单覆盖。被不可变应用版本引用的配置不能删除。
- `providers:request` 只允许 `list/save/test/delete`。Preload、Main、Host 都校验输入；Main 继续检查所属主窗口、主 frame 与来源。结果严格验证。UI DTO 仅返回 `hasCredential`，没有 secretRef、明文读取接口或运行配置接口。
- 保存/打开/编辑/重新加载均无模型调用。测试只接收已经保存的 id/revision，每次由用户点击。结果含 revision、时间、耗时与固定状态类别，不返回模型输出、请求正文、SDK 错误/堆栈。测试中配置被改/删会标为 stale。页面编辑立即隐藏旧结果；结果不跨重启保存。
- Key 使用短期 Vue 组件状态和密码控件；提交（包括失败）前清空控件，离开设置/卸载/pagehide 清空，不使用 Pinia 持久化、浏览器存储或日志。不承诺 JS 字符串/IPC 副本能立即彻底从内存擦除。更换端点/协议时不允许沿用旧 Key，须重新输入。

## 凭据生命周期与补偿

`CredentialService` 只在 Service Host 构造，生产 helper 在构建阶段由 Windows 系统 .NET Framework 编译。使用 DPAPI `CurrentUser`，无替代明文后端；解密失败要求重新输入。helper 只接收操作名称，Key/密文经过匿名 stdin/stdout 的 Base64 管道，不进命令行、URL 或 stderr。helper 5 秒超时、有限输出，所有失败映射固定错误，不保留异常 cause。明文 Buffer 尽力清零，字符串不能保证擦除。

密文存于受管理数据根下 `credentials/<UUID>.bin`，独立于 SQLite、应用快照、logs/backups。拒绝非服务格式的 ref 和已有 junction/symlink；继承数据目录 ACL，并由 CurrentUser 加密保护，非 OS 沙箱，不承诺防御同一用户下的恶意程序/TOCTOU。

| 事件 | 行为 |
|---|---|
| 新增/替换 Key | 新建唯一 ref；先 DPAPI 加密并排他创建密文文件、fsync，再事务提交配置 |
| 凭据写失败 | 不提交配置；尝试清理不完整文件，原引用继续有效 |
| 数据库提交失败/修订冲突 | 删除新凭据；删除失败留下未引用密文，启动/后续变更时重试清理 |
| 数据库提交前崩溃 | 已创建文件没有 DB 引用，下次启动清理 |
| 提交后旧凭据删除失败/崩溃 | 保留新配置；返回 `cleanupPending`，旧文件作为孤立密文重试清理 |
| 切换无需认证/删除配置 | 先提交空引用/删除；再清理未引用密文。FK 阻止删除时保留凭据 |
| 凭据丢失、损坏或 Windows 账户变化 | 不回退环境 Key，不自动调用/重试；显示凭据不可用 |

清理查询全部现存引用，不受 UI 列表 1000 条上限影响。启动清理是确定的恢复策略，不在异步持久化事务中等待。服务唯一写入者假设延续 Storage；人工验收脚本使用同一目录时先关闭桌面。默认备份/诊断不得包含 credentials 目录；跨账户恢复需重新绑定 Key，完整备份实现仍在范围外。

## 运行与连接测试

内部 `ProviderService.runtime({id,revision})` 读取精确修订并解析凭据，返回新的模型对象、Key 和白名单环境。`buildRuntime` 每次独立创建 env，仅继承 SystemRoot/WINDIR/TEMP/TMP/LANG，Key 只注入该运行的 `AIAPPNEST_MODEL_API_KEY`。不修改全局 `process.env`，不继承 OPENAI_API_KEY、NODE_OPTIONS 等。运行对象只允许可信服务/后续 PiAdapter 使用，不可持久化或诊断导出。

`testRuntime` 用专用 Node Worker 执行 Pi 的 `streamOpenAICompletions`，固定发送 `Reply with OK.`，DeepSeek 最多 128 tokens，其余保持 16 tokens，不带工具、历史、文件、记忆、Skill 或系统提示词。不请求模型列表。无认证时明确移除 SDK 默认 Authorization，非秘密占位符阻止 SDK 环境回退。此同版本 Pi 协议及运行配置作为后续 PiAdapter 接入合同，正式 Pi 会话/工具循环仍未实现。

探针禁用 SDK 重试与重定向，要求 SSE、明确 stop、非空文本、`[DONE]` 与完整流结束，拒绝截断/工具/仅思考/无正文响应。`length` 完整结束分类为 `INCOMPLETE_RESPONSE`，未知 finish、畸形/错误事件、缺终止标记均为协议失败。最多接收 64 KiB 响应字节。Worker 内的 fetch 包装不会影响 Service Host/其他运行；模型端错误正文全部丢弃。父线程按总时限（含 Worker 启动）终止 Worker 后返回结果，最多 4 个同时测试，第 5 个返回 BUSY。Main 的 75 秒 IPC 时限大于最长模型测试，不把正常模型超时当服务崩溃。

## DeepSeek 参数兼容性核对（2026-10-03）

再次核对[官方接入说明](https://api-docs.deepseek.com/quick_start/pricing-details-cny/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)和[错误码](https://api-docs.deepseek.com/quick_start/error_codes/)。官方支持 `deepseek-flash`、Bearer 认证和根路径 Base URL；思考默认开启，所以必须发送 `thinking: {"type":"disabled"}`。DeepSeek 的 HTTP 402 明确表示余额不足，映射 `QUOTA_EXCEEDED`；401/403 为认证失败，404 为模型或接口不可用，429 为限流，5xx 为网络/服务不可用，其余错误不猜测上游原因。

核对锁文件安装的 `@mariozechner/pi-ai@0.73.1/dist/providers/openai-completions.js`：`buildParams` 支持 `maxTokensField: 'max_tokens'`、`supportsUsageInStreaming`；`onPayload` 在 `client.chat.completions.create` 序列化之前执行。虽然该版本也有 `thinkingFormat: 'deepseek'`，它只在 `model.reasoning` 开启时自动生成字段；本探针保持非思考能力边界，使用固定 `onPayload` 添加关闭字段，不暴露任意 SDK 参数给用户。

实际请求测试经 `ProviderService.runtime` → `testRuntime` → Pi → 本地 HTTP 捕获，断言最终 URL 是 `https://api.deepseek.com/chat/completions`、模型为 `deepseek-flash`、`max_tokens:128`、`stream:true`、`stream_options.include_usage:true` 和关闭思考字段；不含 `max_completion_tokens`、`store`、`reasoning_effort`、采样参数、tools 或缓存字段。测试 Worker 仅替换网络传输来源并保留实际路径，注入代码不打包进产品，生产校验仍拒绝任意云端和 LAN。依赖和锁文件未升级；这些是探针适配证据，不是完整 Pi 工具、思考多轮或多模态认证。

可信自动化代码仍可能读取注入 Worker 的 Key。本 Issue 不提供请求代理、OS 级隔离或跨 Windows 账户凭据迁移。
