# RunScheduler：设计与 R01–R12 验证

2026-10-07，Issue #13，基于 main 已合并的 PiAdapter。维护者已授权在真实模型验收前开发及提交草稿 PR。本记录不将确定性模型夹具计为真实模型验收，也不作为关闭 Issue 的依据。

## 调度和持久化

Service Host 是唯一调度/数据库写入者。`runs.submit` 验证应用、会话、固定 revisionId、UTF-8 请求大小、附件归属/完整性、Skill 和凭据就绪状态。文本附件仅接受已登记、同会话的 `text/*` 产物，每件最多 256 KiB；二进制附件明确拒绝。完整输入（含附件和记忆装配结果）最多 1 MiB。Renderer 不能指定文件路径、Worker、模型凭据或原始 RPC。

同步事务创建 Run、唯一用户消息和初始事件。幂等键为 `(conversationId, requestId)`；相同载荷返回原 runId，修改文字、附件或版本返回 `VERSION_CONFLICT`。重复请求不重新验证当前配置、不重新启动 Worker；手动重试须生成新 requestId。保证的是平台不重复启动，不能保证外部副作用恰好一次。

锁按会话、全局额度、模型额度、排序后的目录集合一次性检查和占用，不持有部分锁等待。全局默认 2，同 endpoint/model 的本地模型默认 1；模型额度永远嵌套在全局额度内。FIFO 扫描允许无冲突任务越过受阻任务，但更早的同会话/重叠目录任务保留优先权。Windows 路径经真实目录规范化，拒绝链接、UNC、设备路径等，再保守忽略大小写比较完整路径组件。父子目录冲突，兄弟目录可并行。可信自动化能越过受控目录，故保守独占全部执行额度。

排队期间权限可能改变：派发前重新解析计划和目录锁，在创建 Worker 前冻结 Policy boundary；PiAdapter 只领取该次 boundary。之后新增授权不扩大本次执行权限，撤销仍即时生效。运行快照记录固定版本、配置摘要、权限、grant 版本、凭据引用、附件 ID 和记忆摘要，不记录明文密钥。`SchedulerOptions.memory` 是可信宿主的同步记忆装配接口，默认空。配置/凭据摘要变化会回收缓存 Worker，再按精确会话文件恢复。

`run.queued`、`run.state(starting)`、`run.snapshot`、`worker.ready`、prompt accepted 和完成分别持久化。SQLite 分配单调 run seq。显示事件每 40ms 或达到 128 件/256 KiB 批量写入。完成时读取适配器权威消息，在同一事务提交助手消息、用量、终态和 `run.completed`；磁盘失败不报告成功，并停止派发新任务。Schema migration 6 允许已接受的扩展命令由 running 转 handled，不修改旧迁移。

## 业务 IPC 与订阅

`window.desktop.runs(request)` 经 preload、可信 Main、ServiceManager 到 Service Host，全部使用严格契约。操作包括 `submit/get/cancel/subscribe/next/unsubscribe`，返回业务 Run（state、phase、error、时间、usage），无 Worker/RPC 暴露。

订阅采用有界拉取：`subscribe({appId, conversationId, runId, afterSeq})` 返回 subscriptionId、events、afterSeq、terminal；之后调用 `next({subscriptionId, afterSeq})`。建议 UI 每 40–100ms 拉取并保存**最后处理成功**的序号；重复调用相同游标可重放，用 `(runId, seq)` 去重。重新连接可直接重新 subscribe。

每批最多 128 件、约 256 KiB payload。历史与新增事件共用 SQLite 游标，不存在切换丢事件窗口；超大历史事件以同序号的 `output.truncated` 返回，避免游标卡死。没有每客户端输出队列，客户端断开不影响 stdout 消费。最多 128 个订阅，60 秒未拉取自动失效；unsubscribe 幂等。取消订阅不等于批准权限或取消运行。

## 取消、回收和退出

`cancel` 返回 `accepted: true`，`terminated` 单独表示是否已进入终态。排队取消同步移除，不启动 Worker。停止活动运行同时取消该会话已有的排队输入；之后显式提交的新请求仍可进入队列。启动期间用 AbortSignal 关闭适配器；运行期间撤销 policy boundary 并请求 abort，不向 Pi 的隐式队列添加消息。重复取消幂等。

默认 1500ms 等待 abort，失败经 PiAdapter 的 Windows Job Object 关闭所属进程树。合作取消也回收 Worker，以清理可能存在的工具子进程。终止后才写 cancelled；取消和自然完成竞态只提交一个终态，强制终止的晚到证据会合并保存。已发生的文件写入和外部操作不会自动回滚。

审批拒绝、到期、撤销取消该运行；批准只恢复对应 call/digest，消费后恢复 running。所有退出分支释放 policy reservation、额度和会话占用。空闲 Worker 默认保留 5 分钟，活动 Worker（含审批和取消等待）不参加 TTL 回收；回收进行中禁止重用。空闲 Worker 崩溃也会被移除。

退出先封闭提交入口，取消排队和活动任务，等待 Worker/Job 退出及终态落盘，再关闭 Policy/SQLite。Main 默认给予宿主 15 秒退出窗口，最终强杀宿主时 Job helper 的父进程监控负责清理子树。启动只把遗留队列标 cancelled、活动记录标 interrupted，并写 `RECOVERY_REQUIRED`；不盲目重放。完整 JSONL/投影修复仍由可靠性任务处理。Pi 自动重试已禁用，Scheduler 不自动重试 prompt。

## 配置

可在数据根目录放置 `run-settings.json`，重启服务生效。不是 Renderer 路径输入；无文件使用默认值。格式错误导致服务明确初始化失败。

```json
{"concurrency":2,"localConcurrency":1,"queueLimit":100,"queueTimeoutMs":300000,"idleTtlMs":300000,"abortMs":1500}
```

可选 `modelLimits` 按 `SHA256(JSON.stringify([endpoint, modelId]))` 设置额度（运行快照中的 model 字段）；上限仍受 concurrency 约束。额度最大 32，队列最大 1000，abortMs 最大 3000ms。队列满返回 `BUSY`，排队超时终态携带 `QUEUE_TIMEOUT`；等待期间配置不可用携带 `CONFIGURATION_UNAVAILABLE`。

## 验证矩阵

测试位于 `tests/integration/runs.test.mjs`。共享模型服务是本地确定性 HTTP SSE 夹具；实际 Pi、平台扩展、SQLite、Windows 文件系统和 Job helper 均使用生产实现。手控 Worker 测试只用于精确调度/竞态注入，并与真实进程测试分开。

| 编号 | 证据 |
|---|---|
| R01 | 手控队列顺序及 Worker 复用；真实 Pi 多轮排队无并行 prompt |
| R02 | 手控多模型上限/全局上限/FIFO；生产计划的本地模型默认额度为 1 |
| R03 | 30 次并发重复提交同 runId、唯一用户消息；载荷冲突；生产 IPC 重复请求 |
| R04 | 父子目录互斥、兄弟目录并行；真实目录 canonical grant 及排队后新增授权重新锁定 |
| R05 | 排队取消/队列上限/等待到期；手控和真实 Pi 启动取消、无后续意外 prompt |
| R06 | 受理和终止分离；真实 Pi 丢失 abort 回应后强制关闭；生产 Job 实际子孙退出，无关进程存活 |
| R07 | 受理取消后注入自然成功，唯一 cancelled 终态、清空同会话排队输入 |
| R08 | 真实工具审批拒绝/到期/撤销/宿主断连不写文件；精确批准、订阅断连不批准后续调用 |
| R09 | 300 事件跨批历史补发和实时续取连续序号，游标重放/退订；故障注入验证完成事务回滚；生产 IPC 游标 |
| R10 | 活动 Worker 超过 TTL 不被回收；真实 Pi 空闲回收后精确 sessionFile 恢复及回忆夹具 |
| R11 | 启动失败/执行异常后队列前进、policy map 清理；PiAdapter 原有实际崩溃/错误 stdout 测试仍通过 |
| R12 | 停止封闭新请求/取消排队/落盘；生产 Service Host IPC 退出；真实 Windows Job 子孙清理；启动不重放 |

另测归属、固定版本、请求字节数、文本附件完整性和不支持的命令。无需凭据的测试不会调用外部模型。

测试环境：Windows x64 10.0.26300、Node 24.19.0、Pi 0.73.1、SQLite FULL/WAL，本地 SSE。已观测直接 submit 3.1ms，生产 IPC 两次幂等 submit 共 96.0ms，IPC cancel 3.4ms；这是单次开发机样本，非 P95 或真实模型延迟承诺。脱敏证据见 [run-windows-validation.json](evidence/run-windows-validation.json)。

最终调度专项 21/21 通过；引擎专项 20/20、存储专项 18/18 通过。最近完整回归（新增空闲崩溃测试之前）165 项：154 通过、10 失败、1 个既有 Spike DPAPI 前置环境跳过。

本地完整 `npm.cmd test` 包含桌面 Electron 和 DPAPI；受限 shell 存在之前已记录的桌面 sandbox ACL、CurrentUser DPAPI 环境失败。未通过删除、跳过或放宽测试规避；发布工具将在托管环境执行同一必需检查，最终结果以草稿 PR 的 Validation 为准。

## 最终验收仍未完成

`npm.cmd run engine:live` 于本次再次返回 `BLOCKED / MISSING_EXPLICIT_TEST_APP`，未进行真实模型调用。E01 流式完成、E05 真实双会话隔离、E06 模型精确恢复/回忆、E09 真实流式取消仍是 Issue 最终验收与关闭前的条件。需要显式提供已配置凭据的测试数据目录与已发布测试 appId，按 [engine-validation.md](engine-validation.md) 执行；报告不得包含明文 Key。本 PR 可审查与提交，不能宣称真实模型验收通过或关闭本项。
