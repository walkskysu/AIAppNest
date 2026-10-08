# Recovery 验证记录

Refs #17。2026-10-08 执行授权允许开发、自动化验证与草稿 PR；本记录不宣称最终验收或关闭 Issue。

## 自动化复现

- `npm.cmd run recovery:verify`：构建后执行 recovery.test.mjs，生成脱敏 `evidence/recovery-windows-validation.json`。
- `npm.cmd test`：宿主规定的全量检查，包含类型、构建、实际服务、Pi、SQLite、Windows Job 和 Electron 测试。
- `node --test --test-concurrency=1 tests/integration/recovery.test.mjs`：只执行恢复故障注入。所有进程/文件均为测试新建，不接触真实模型或生产数据。

| 编号 | 自动化覆盖 | 真实环境/人工边界 |
|---|---|---|
| X01 | 重放/实时交错、重复 seq、刷新；Electron 恢复用例 | 人工多窗口体验 PENDING |
| X02 | 未来游标、删除事件形成缺口、订阅回收；UI 重连重读快照 | 人工网络/窗口切换 PENDING |
| X03 | 实际 Windows WorkerHost 强杀、父创建身份不匹配拒绝启动、无关进程存活 | 确定性模型夹具，不是真实模型 |
| X04 | 实际 Service Host 强杀后重启；旧排队取消；无重复请求；显式 retryOf | 平台整体人工强关 PENDING |
| X05 | 实际 Pi sessionFile，删除 SQLite 完成投影后修复；重复不插入；工具归属 | 包装原文和记忆维持原关联 |
| X06 | 截断与不兼容版本；修复前后原文件字节相同 | 不改写/迁移 JSONL |
| X07 | 时钟跳变后不超时/不重发的确定性测试 | **ACTUAL_SLEEP_PENDING** |
| X08 | 实际 Pi 大输出夹具；UI 文本/工具缓冲上限；序号持续推进 | 人工持续输出交互性能 PENDING |
| X09 | 完成事件持久化异常，完整事务回滚；真实 SQLite max_page_count 限额导致 SQLITE_FULL，零派发 | **PHYSICAL_RESTRICTED_VOLUME_PENDING**，数据库页限额不等同物理磁盘满 |
| X10 | 测试凭据/记忆/工具敏感标记不进入导出/轮转日志；Main 导出对话框 UI 测试 | 人工检查导出 PENDING |
| X11 | 缺失用量与价格显示 unknown；绝不以零价配置编造费用 | 无价格配置时不估算 |

首轮恢复专项 11/11 通过。全量检查在受限执行令牌中遇到 Electron AppContainer ACL 和 CurrentUser DPAPI 环境错误；不移除沙箱、不替换真实 DPAPI、不把这些错误改成通过。宿主发布工具会再次执行强制检查，最终结果以其返回为准。

## 尚未完成的最终验收

Engine E01/E05/E06/E09 真实模型；Chat C01 真实模型 UI 闭环及 C01–C10 人工；File 真实模型文件流程及 F01–F10；Memory M01–M10 真实存储/模型与人工验收继续保留前置文档中的 NOT_RUN / PENDING。本项没有显式真实模型测试应用，不擅自调用用户模型。

还需在可交互普通 Windows 用户环境：运行中睡眠/唤醒（包含授权等待）、平台整体强关、实际受限磁盘卷填满后停止及释放空间重启核对；记录进程存活/归属、持久化 seq、原 session 哈希、请求计数及副作用计数。不要在当前共享宿主上强制睡眠或耗尽系统卷。

所有人工操作应确认：没有重复执行、没有错误成功提示、旧运行只能显式继续、导出不含敏感内容。发现未知副作用必须保留中断状态并人工核对。PR 保持草稿，使用 Refs #17，不能自动关闭本项。
