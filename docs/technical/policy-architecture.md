# PolicyService 与工具权限边界

依据：[固定需求 v1](../requirements/Windows_AI_App_Platform_Design_v1.md) §6.1、§7、§8、§11–13；Issue #11。锁定 Pi 0.73.1、Node 24.19.0。前置 #10 已 completed，PR #24 已合入；#1 的工具拦截机制记录见 [Spike 报告](pi-windows-spike-report.md)。本文不把该报告中尚未完成的真实模型验收改记为通过。

## 权限来源

`PolicyService.bindRun(appId, runId)` 仅供可信调度宿主调用。服务查询 Run 的 conversationId，再读取 Conversation 固定的 AppRevision，并通过 AppService 校验 manifest、配置文件及 Skill 哈希。工具参数不能提供 appId、conversationId、runId 或权限快照。新草稿、新发布版本不会改变旧会话上限。

| 模式 | 可执行工具 | 额外条件 |
|---|---|---|
| chat | 无 | 直接调用文件入口也拒绝 |
| controlled-files | platform_read、platform_list、platform_write、platform_output | 按固定版本 read/write 上限注册；还需对应资源授权 |
| trusted-automation | read/grep/find/ls、write/edit、bash 中符合固定上限的集合 | Main 原生对话框明确选择；每次通用工具调用还需一次确认 |

Skill、附件、模型输出和记忆均是数据。Skill 的 allowed-tools 不能注册工具、发起授权或批准操作。受控模式没有脚本执行、删除、重命名、通用 shell 或任意 exec 接口。

授权作用域是 appId + conversationId + revisionId，资源是服务计算的 workspace/output，或系统选择的 external。read 与 write 独立，写授权不隐含读授权。授权含 confirmation（never/always）、version 和 revoked；撤销递增版本，不删除历史。运行绑定时复制当时的授权集合，之后新增授权不能扩大这个运行；每次入口还与数据库当前版本逐项比对，撤销即时生效。旧的基础 `grants` 表不会被自动视为新授权。

外部目录的选择令牌由私有 Main→Service 管道产生，绑定 Main 文档世代、应用、会话、policy-directory 用途与五分钟期限，使用一次即失效。刷新产生新的 Main owner，旧令牌不可使用。Renderer 只能提交令牌，不能传任意绝对目录。平台数据目录、Node 与宿主程序目录及其祖先/后代不能作为 external 授权，防止文件工具重写自己的权限数据库、凭据或运行代码。

目录 grants 只在受控模式创建；可信模式的通用工具使用独立的 trust 同意与逐调用确认，不把目录 grants 当作可信代码的文件系统沙箱。

## 实际文件入口

受控文件操作全部在 PolicyService 内执行。参数用严格 schema 解析，内容上限 1 MiB；读取大小上限 1 MiB，列表最多返回 1000 个名称。新文件要求父目录已存在，output 用 `wx` 创建，不覆盖已有产物。本任务创建的是输出文件，Artifact 元数据登记由后续文件/产物服务负责。

路径处理策略：

- 接受本地绝对路径及授权根下的相对路径；Windows 大小写和两种分隔符经实际文件系统规范化。
- 拒绝 `..`、UNC（包括显式选择的 UNC）、设备/扩展命名空间、盘符相对路径、根相对路径、ADS、DOS 保留名、尾部空格/点、短名 `~`、控制字符和通配符。
- 对所有已有祖先进行 lstat，拒绝 junction/symlink；已有文件拒绝多硬链接、非普通文件。已存在目标使用 realpath，新文件验证真实父目录再拼接叶名称。
- 真实路径按完整组件比较，避免 `workspace`/`workspace-other` 前缀碰撞。不直接把字符串小写，因为 Windows 目录也可启用大小写敏感。
- 确认前检查一次，确认/撤销/取消检查后在操作前重新检查。已有写文件以 `r+` 打开，校验句柄的 inode、device、类型和链接数后才截断写入；读取使用同一已校验句柄。没有受控删除、重命名或递归创建接口。

这会缩小检查与使用间的变化窗口，**并不消除 OS 层 TOCTOU**。另一个本地进程仍可能在路径复查与打开/创建/列表操作之间改变目录。Node 路径 API 不是基于目录句柄的 Windows 强隔离；新文件创建后发生 OS 竞态或 I/O 故障也不保证回滚。首次写失败可能留下文件，已完成写入不会因取消自动回滚。拒绝恶意本地代码需要后续 OS 隔离，不能把本实现称为安全沙箱。

## Pi 权限扩展

`@aiappnest/pi-adapter/policy` 是独立适配入口，避免普通 Provider 连接测试加载整个 agent SDK。`createPolicySession` 使用锁定版本的 SDK、`ExtensionFactory/registerTool/tool_call/session_start` 接口。settings、auth 与模型注册表均在内存构造；禁用扩展、Skill、提示模板、主题和项目上下文自动发现。Skill 只接受宿主先经 `AppService.resolveSkills` 验证的路径，不接受普通 Skill 提供的扩展入口。

SDK 使用 `noTools: 'all'` 加显式 `tools` 白名单。受控模式只注册平台工具；可信模式也将每个允许的内置工具覆盖为入口确认包装。启动后比对活动工具集合、扩展数量和工具来源，不允许任何 built-in fallback。扩展工厂异常、session_start 被 Pi 捕获的异常、Skill 加载错误或权限快照损坏均不能得到可用任务；不会降级到默认内置工具。拒绝以 `{"code":"POLICY_DENIED","reason":"…"}` 供模型/UI 读取。

返回的宿主句柄仅有 prompt、cancel、close 和只读工具名，不暴露原始 session、reload、executeBash、工具注册或 setActiveTools。Pi 对不存在工具的拒绝发生在扩展事件前，因此也订阅实际 tool_execution_start 记录拒绝。

当前是权限适配与测试宿主，不是正式聊天 Worker/调度队列；session 使用内存存储。后续独立 Worker 集成必须保持 PolicyService 在可信服务端，通过专用内部协议调用这些入口，保留 Pi 精确会话恢复与 Job Object 清理机制。不得把 policy 判断搬成 Worker 可随意替换的快照布尔值。可信工具一旦执行，代码可能读取当前账户文件和注入凭据；正在执行的外部进程要由未来调度器调用 abort/进程树清理。授权撤销不能撤回已经发生的副作用。

## 确认、审计与集成契约

数据库迁移 5 增加 policy_records，保存 grants、trust 和 approvals，按应用/会话外键约束。参数先解析/复制，再按键排序序列化计算 SHA-256，绑定 appId、conversationId、runId、callId、工具名和完整参数。确认保存 grantId/version、资源标识和有效期（默认两分钟）；不保存文件内容、命令文本、API Key 或绝对访问路径。调用 ID 在同一绑定运行中只能使用一次。

状态为 pending → allowed/denied/expired/cancelled；allowed 在入口重新核查归属、摘要、期限、取消和授权版本后变为 consumed。重复决定、旧请求批准新调用、参数变化、模型文本的 approved 字段都无效。只挂起对应工具调用，IPC 本身立即返回。服务断连关闭会取消等待；异常重启会把持久化 pending/allowed 变为 cancelled，不恢复旧操作。取消与允许之间竞态仍以入口最终检查为准。

UI 的类型化接口：

- `selectGrantDirectory({appId, conversationId})` 调用系统目录选择器。
- `policy({operation:'grants.create'|'grants.list'|'grants.revoke', …})` 管理授权。
- `selectTrustedAutomation({appId, conversationId})` 显示真实风险说明，默认取消；只有 Main 收到明确选择才发送私有 trust 请求。草稿模式选择不是这份运行同意。
- `policy({operation:'approvals.list', appId, conversationId, runId})` 在刷新后重新读取。
- `policy({operation:'approvals.decide', …, approvalId, digest, decision:'allow'|'deny'})` 决定已存在请求。服务重验全部归属。
- `policy({operation:'trust.revoke', …})` 撤回可信模式同意并取消此会话绑定的运行权限。

可信调度宿主订阅 PolicyService 的 `event`，收到持久化 RunEvent（runId、单调 seq、type、payload、createdAt）。`policy.waiting` 表示 pending；`policy.resolved` 含 allowed/denied/expired/cancelled/consumed。调度器维护 waiting_approval/running 状态，聊天 UI 可按现有 run_events 序号重读；本任务不直接接管正式运行状态机。每次允许/拒绝保存 `policy.decision`，包含归属、调用 ID、工具、资源 ID、布尔决定和固定原因码，不记录原始参数。确认摘要用于绑定与审计，不是用户可提交的权限凭证。

最小测试宿主在 `tests/integration/policy.test.mjs` 与 `fixtures/policy-entry.ts`：创建真实版本/会话/运行、授权、驱动 Pi、读取待确认并决定、取消和重启 Service Host。不需要模型密钥；模型流为明确标注的确定性 fixture。正式审批页面、队列、跨用户权限和恶意代码沙箱不在本次范围。
