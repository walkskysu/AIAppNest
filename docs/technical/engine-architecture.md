# PiAdapter 与精确会话恢复

依据固定需求 v1 的 §6、7、9.1、10.2、12、15 及 Issue #12。前置 #11 已 completed，PR #25 合入基线。正式接口位于 `packages/pi-adapter/src/index.ts`；尚未接入聊天 UI 或全局 RunScheduler。

## 内部 API

仅可信 Service Host 调用，不能把此对象、运行时路径、原始 RPC 或权限管道暴露给 renderer。传入现有 Storage、AppService、ProviderService、PolicyService，所有归属从数据库解析。

| 接口 | 契约 |
|---|---|
| `readEngineRuntime(dist)` | 读取构建产物清单；每次启动校验 Node/Pi/adapter/extension 版本及 Node、CLI、扩展、Job helper 的 SHA-256 |
| `PiAdapter.start(services, runtime, appId, conversationId, options)` | 仅接受尚无 piSessionFile 的会话；解析原 AppRevision、Skill、固定模型配置及当前绑定凭据，启动后保存 Pi 返回的路径 |
| `PiAdapter.restore(...)` | 仅接受已保存路径的会话；只读预检后传 `--session <exactFile>`，核对引擎实际路径，不提交 prompt |
| `getState()` | 返回平台状态、固定归属、sessionFile、streaming 和 pendingMessages；已关闭句柄报告 closed |
| `getMessages()` | 用 Pi `get_messages` 读取权威消息，供展示投影核对；结果为引擎版本的只读消息快照，不是 renderer DTO |
| `prompt(runId, text)` | 宿主先创建 Run 并转到 starting/running。校验 Run→Conversation 归属、重新校验 Skill、绑定本轮 PolicyService；单 Worker 仅允许一轮。返回 EngineResult，不自行写 Run 状态 |
| `abort(timeoutMs=1500)` | 立即撤销本轮权限/等待确认，发送 abort 并在同一期限等待本轮结束；返回 requested/acknowledged/idle/forced/exited 证据 |
| `close(force=false)` | 幂等关闭；stdin EOF 后等待 1500ms，再强制关闭 Job，最多再等 1500ms。无法证实进程关闭则抛 CLOSE_TIMEOUT 并保留会话租约 |
| `readEvents(afterSeq=0)` / `onEvent` | 平台事件、单调序号、有界展示窗口和截断统计；订阅回调必须快速返回，异常被隔离 |

新建/恢复在一个 Storage 宿主内持有会话租约，启动期间也拒绝重复 Worker。跨宿主互斥依赖单 Service Host 的部署约定；全局队列不在这里实现。每轮结束会取消该轮的权限绑定，下轮必须使用新的 Run；重用已绑定 runId 被权限服务拒绝。

## 固定启动与权限

组合为 Windows x64、Node 24.19.0、Pi 0.73.1、engine-v1、policy-v1、Pi session v3。`npm ci` 和 lockfile 固定依赖，不自动升级。构建生成 `engine-runtime.json`、`platform-extension.mjs`、`worker-host.exe` 和固定 Node sidecar。当前是本机开发构建，Pi CLI 仍定位到锁定的 node_modules；清单不是防篡改签名或发行安装包。发行时还需交付完整依赖、许可证及签名。

Node 使用参数数组、`shell:false` 启动 Job helper；helper 使用 CreateProcessW 的真实 Node/CLI JS 入口，在 suspended 状态加入 KILL_ON_JOB_CLOSE Job 后恢复执行。Job 句柄不继承、无 breakaway，宿主进程退出会关闭整个 Worker 进程树。该实现来自已验证 Spike，正式 helper 不包含 Spike 的 DPAPI/文件锁测试命令。

每个会话的 `agent/` 下生成无密钥 engine.json、role.md、settings.json，以及独立 cwd、home、temp；真实业务文件仍在 workspace/artifacts。PI_CODING_AGENT_DIR、HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP 均指向本会话；Windows 系统目录与 PATH 明确列出，不继承 NODE_OPTIONS、代理、其他应用 Key 或用户 PATH。只有 AIAPPNEST_MODEL_API_KEY 注入本 Worker，进程级 process.env 不被修改。可信 shell 模式仅允许已安装在明确 ProgramFiles/Git 位置的 Bash，缺失时 RESOURCE_INVALID；不自动安装工具。

禁用 Skill、扩展、上下文、模板、主题自动发现，指定角色文件；关闭自动 retry/compaction。CLI 的 `--no-builtin-tools` 只关闭默认激活，仍保留工具注册信息；正式实现使用 **`--no-tools --tools <显式集合>`**，并核对活动集合和工具来源，拒绝残余 builtin。拒绝私有 cwd 中的项目 settings、agent 中的 models.json 和非空 auth.json，避免 CLI 在 discovery 标志之外读入配置。Skill 只加载已校验快照入口，显式调用模式沿用快照的 disable-model-invocation。

权限扩展与既有 SDK 权限测试宿主共用 `policyExtension`。每个 Worker 连接独立随机 Windows named pipe，用仅在环境中的随机令牌认证。宿主捕获当前 RunBoundary；受控读写在宿主执行，工具请求无法自带 appId/conversationId/runId 取得权限。可信工具先由宿主完成一次性确认，再在 Worker 中执行包装工具。取消先撤销宿主权限，再请求 Pi abort。管道断开即时取消权限，并在短暂退出码收集窗口后退役仍存活的 Worker。

这不是恶意代码 OS 沙箱。可信代码仍可读取账户文件和注入凭据；确认回复与 Worker 实际执行之间存在 IPC 竞态，受控路径仍有文档化的 OS TOCTOU 限制。撤销与取消不回滚已发生的副作用。

## 协议与完成判定

监听器在任何 RPC 发送前安装。stdout 持续按 LF 拆字节帧，完整帧用严格 UTF-8 解码，兼容跨块 Unicode、CRLF、单块多行；stderr 只计字节，不存原文。命令 ID 匹配响应，同时校验 command/type；无 ID 的执行事件关联该 Worker 的活动 Run。未知合法事件和迟到/未知响应只计数；无效 JSON/UTF-8、非法帧、截断或超过 8 MiB 的一行终止 Worker，拒绝全部 pending。最多 32 个宿主 pending RPC；权限通道单帧 2 MiB、最多 16 个在途请求。

统一输出 assistant.delta、tool.started、tool.result、status、error、usage、output.truncated。默认窗口为 512 条且总计不超过 256 KiB；单事件超过 64 KiB 或窗口预算时输出截断标记。UI 未订阅也持续排空 stdout。`onEvent` 是宿主批量落库/日志策略接入点；默认诊断只保存元数据和计数，避免日志泄露模型回显的 Key。被逐出窗口的事件通过 dropped/lastSeq 可检测；完整内容可在限制内从 Pi 消息读取核对。超过 RPC 单帧上限的历史读取会明确失败并退役 Worker，不静默截断权威消息。

完成条件按顺序为：

1. prompt response 只代表接受。即使先收到事件，也不丢失它们。
2. 收到 agent_end 候选或平台专用 handled 通知。
3. 执行受信扩展 `/aiappnest-barrier`，等待 Pi `waitForIdle()`。
4. get_state 同时确认非 streaming、非 compacting、pendingMessageCount=0；核对 sessionFile 不变；未结束工具集合为空。
5. get_messages 末条与本轮最后的 assistant message_end 完全相同，stopReason=stop，且无模型错误，才成功。

平台 `/aiappnest-handled` 明确不启动执行；只有本轮无 agent/assistant 执行证据时才返回 handled。其他扩展命令被 prompt 入口拒绝，允许已校验的 `/skill:name`；未知不执行响应最终超时，不猜测成功。不提供 steer/follow_up，不维护 Pi 待发队列。

工具错误保留为 tool.result/isError 和 EngineResult.toolErrors。模型消费工具失败后，若最终 assistant 正常 stop 且完成上述核对，可返回 succeeded；它表示模型本轮正常完成，不承诺用户业务目标已实现。模型 error、length 截断、悬空 toolUse、缺少最终消息或工具未完成都不能成功。取消标记优先；单独 abort acknowledgment 不足以证明结束。

## 恢复和一致性

数据库 Conversation 的固定 revisionId 与 piSessionFile 是唯一来源，不查询最近活动、不用 `--continue`、不编辑 Pi JSONL。恢复先验证绝对路径、预期目录、现有路径无链接、普通单链接文件、最大 64 MiB、UTF-8/JSONL、v3 header/cwd、条目类型/父节点链及消息基本结构。缺失/损坏/版本不符直接 SESSION_INVALID，不启动替代会话。恢复后再次核对引擎返回路径。

新会话的 get_state 可以返回尚未落盘的权威路径（Pi 首条 assistant 后才写文件）。平台先保存精确映射；若没有模型消息便关闭，恢复时会明确报告缺文件，需要宿主新建 Conversation，不能把原映射换成另一文件。映射写入事务失败立即回收 Worker，保留未关联的引擎文件供后续维护，不为凑出成功记录改写文件。

SQLite 与 Pi JSONL 没有跨文件事务。调度器应持久化 started/accepted/completed 阶段、结果与投影；刷新读取事件/消息，不重发 prompt。适配器不自动重试任何 prompt，Pi retry 与提供商 SDK retry 都关闭；未知结果由唯一调度责任方核对后决定是否请求用户显式重试。完整崩溃恢复/全局 requestId 去重仍由后续任务负责。

## 错误分类

EngineError 的消息是固定错误码，不透传可能含密钥/参数的底层异常。启动阶段 RESOURCE_INVALID、VERSION_MISMATCH、SESSION_INVALID、MAPPING_FAILED、START_TIMEOUT、EXTENSION_FAILED 明确拒绝可用句柄。运行 MODEL_ERROR 与 INCOMPLETE_RESULT 返回 failed；PROCESS_EXIT、PROTOCOL_ERROR、COMMAND_TIMEOUT、RUN_TIMEOUT 等不确定结果返回 interrupted，保留实际 exitCode/signal。用户取消且空闲核对或进程退出已确认时返回 cancelled；无法收回进程则不能宣称取消成功。宿主负责把固定错误码翻译为用户可理解提示。

验证结果及真实提供商尚待完成的门禁见 [Engine 验证记录](engine-validation.md)。
