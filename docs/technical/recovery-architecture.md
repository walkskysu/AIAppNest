# 运行恢复与诊断

Refs #17。使用既有 runs / run_events / messages / run_memory_links 和固定 Pi 0.73.1，不另建运行来源。最终验收尚未完成，PR 必须保持草稿。

## 启动与故障边界

Service Host 在暴露 ready 前同步核对所有遗留非终态运行，先写 `recovery.pending`，不把任何遗留任务加入派发队列。排队任务取消，原因 `RECOVERY_QUEUE_CANCELLED`；其他任务默认中断并标记 `RECOVERY_REQUIRED`。仅原 running 状态、已持久化的 idle/barrier 完成证据、没有工具错误、稳定最终消息 ID 和内容摘要完全匹配时修复成功。取消中、未知工具副作用、仅有 stop 文本或流式片段不能成为成功依据。

Windows WorkerHost 以 PID **及进程创建 FILETIME** 校验父进程，在创建 suspended child 前核对身份，并持有该父进程句柄。子进程加入 KILL_ON_JOB_CLOSE Job 后才恢复执行。`worker.identity` 保存 service generation、launchId、父身份和 WorkerHost PID；重启不根据旧 PID 杀进程或接管进程。服务死亡由原 Job 的父句柄触发进程树退出，旧 generation 从不自动重放。

用户在聊天运行卡选择“手动重试”，检查副作用提示后发送。新 requestId / runId 通过 retryOf 关联原运行，原记录不改写。已发生的文件写入、外部请求、授权消费不能自动回滚。首次请求在模型输出前崩溃且 Pi 尚未创建 sessionFile 时，继续原会话可能因映射文件缺失而失败；应保留记录并新建会话，不能自动换绑或伪造 JSONL。

## 会话展示修复

派发前持久化 sessionId、叶节点、原文件字节长度/前缀 SHA-256 和引擎输入摘要。平台扩展通过受支持的 `pi.appendEntry` 写入只含 runId / inputHash 的 custom metadata；它不是消息，不进入模型输入。此标记将 Skill 展开后的用户输入绑定原 Run。新 marker 或下一个 user message 截断本 Run 的归属范围。

只读 parser 只接受 session v3 的线性、完整 JSONL，限制 32 MiB，并验证 UTF-8、节点唯一性、parentId 和工具调用关联。分支、压缩、未知结构、截断、前缀被改写或版本不兼容均停止自动修复并保留原文件；不调用可能升级原件的 SessionManager.open。旧记录没有可信边界时返回 no_boundary，不凭时间或文本相似度猜测归属。

工具消息 ID 来自 runId / toolCallId，助手消息 ID 来自 runId / Pi entryId。修复重复执行不会重复插入；用户消息完全沿用 SQLite 原文，记忆关联沿用 run_memory_links。正式完成时，投影插入、运行终态和完成事件在同一 SQLite 事务提交。恢复修复可在完成事务失败之后，凭已落盘完成证据和原始会话补齐。中断运行可恢复已经存在的引擎消息，但不因此把运行标为成功。报告区分 repaired / unchanged / no_boundary / no_session / session_invalid / busy。

## 重连与资源边界

UI 仅查询 history / get / subscribe / next。afterSeq 对同一 SQLite 持久日志分页，没有单独的历史到实时切换队列；单写者同步读取提供一致顺序。按 runId / seq 连续消费，重复不追加，缺口或越界返回 resetRequired 和 snapshotSeq，UI 刷新投影并从该高水位继续。连接失败取消旧订阅，按 0.5–5 秒退避重读快照并恢复订阅，不生成提交请求。

窗口 sessionStorage 最多缓存 128 个序号，不包含文本。丢失缓存可从头重放；从已缓存游标打开时，未保存流式文本不冒充完成内容。切换会话用 generation 丢弃旧回复并 unsubscribe；订阅最多 128 个、60 秒租期，UI 每次只保留活动运行缓冲。周期快照发现其他窗口新提交的 Run。

服务事件 40 ms 批量落盘；一次至多 128 条 / 256 KiB。单输出事件 64 KiB；每 Run 展示事件累计至多 1 MiB，后续输出变为明确截断标记，控制、权限、错误和状态事件继续记录。stdout/stderr 持续排空，不依赖 UI 消费速度。单助手展示最多 65,536 字符；UI 工具窗口最多 128 个、每结果 8,192 字符。已完成运行从流式缓存移除。

“展示截断”不等于完整文件已保存：独立完整工具输出文件默认不创建，原始 Pi 会话仅在可验证时作为恢复来源。超过解析限制或未落盘的输出不能承诺恢复；界面明确告知该差异。受控文件工具的产物仍走原有 FileService 配额、完整性和权限流程。诊断日志不保存任何完整工具输出。

持久化失败封锁 admission、清空待派发/展示缓冲并终止活动 Worker。读取结果带 `storage: unsaved`，不会伪造已保存终态；释放空间后须显式重启服务核对。日志导出失败独立反馈，不能声称已保存。

## 睡眠、诊断与保留

计时器检测大于 5 秒的事件循环停顿，从超时预算中排除该时间。Worker 恢复后只查询 get_state 和精确 sessionFile；最终仍须经过原有 idle / get_messages 完成核对。不重发 prompt。队列等待预算也排除停顿，服务 IPC 计时器不因一次唤醒延迟直接杀死 Host。权限授权的绝对有效期仍必须满足，睡眠不延长用户授权。实际 Windows 睡眠/唤醒尚待独立测试，时钟模拟不能替代。

运行诊断显示 Run ID、阶段、排队/启动/运行/授权等待耗时、错误类别、退出码、用量、权限计数和恢复动作。无明确价格配置时费用恒为 unknown；不把零价默认配置当真实报价。界面提供白名单诊断预览及 Main 原生保存对话框导出 JSON。自由文本错误统一 UNKNOWN；不导出原始事件、路径、prompt、记忆、凭据或工具结果。

`logs/recovery-{0,1,2}.jsonl` 仅包含同一白名单元数据，单文件 256 KiB，最多三份，七天过期；启动和写入时轮转/清理。日志失败显示 logSaved=false，不影响已经提交的运行结果。数据库事件与 Pi 会话属于运行历史，不按诊断日志保留策略删除；本任务不实现备份或历史清理。
