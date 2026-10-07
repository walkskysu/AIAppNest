# Engine E01–E11 验证记录

2026-10-07，Windows x64 10.0.26300、Node 24.19.0、Pi 0.73.1。前置 #11 closed/completed，PR #25 已合入当前基线。

`npm.cmd run typecheck` 通过，生产构建通过。最终 `node --test --test-concurrency=1 --test-reporter=tap tests/integration/engine.test.mjs`：**20/20 通过，无跳过**。之前引擎 18 项与权限 19 项联合运行 **37/37 通过**；后续新增两项实际 CLI 扩展故障/坏 stdout 测试及增强的 Skill 隔离检查已包含最终 20 项。

测试使用生产 Node/CLI、平台扩展、Job helper、SQLite、Windows 文件系统和会话 JSONL。仅模型服务是显式本地确定性 HTTP SSE 夹具，测试凭据是无敏感性的标记。取消、文件写入及 Worker 重启恢复均实际发生，未用协议样例代替。脱敏协议样例在 `tests/integration/fixtures/engine-protocol.jsonl`，只用于解析测试。

| 编号 | 已取得证据 | 剩余门禁 |
|---|---|---|
| E01 | 真实 Pi 流式中文/Unicode、归属、输入输出 token 用量及成功结果 | **真实模型提供商调用未完成，不能宣称此行全部通过** |
| E02 | 每个 UTF-8 分块边界、多行/CRLF、响应反序与未知事件交错、坏 JSON/UTF-8/截断/超长拒绝；实际坏 stdout 退役 Worker 且无重放 | 无自动化缺口 |
| E03 | 平台 handled 无模型调用并结束；拒绝其他内部扩展命令 | 无自动化缺口 |
| E04 | 实际慢模型接受后仍运行；注入过早 agent_end 后屏障仍等待；length 不成功 | 无自动化缺口 |
| E05 | 两个真实 Worker 并行，Key、角色、同名 Skill、事件互不混用；不改全局 env，磁盘配置无 Key | 真实提供商双会话仍待人工验收 |
| E06 | 保存真实路径；关闭/重启 Worker 后消息完全相同、无额外 HTTP 请求；继续回忆唯一标记；新 AppRevision 不改变旧会话 | 真实模型回忆仍待人工验收 |
| E07 | 注入映射失败，无关联记录；Worker 关闭后可重新启动本会话 | 无自动化缺口 |
| E08 | 扩展哈希、角色/Skill 损坏、models.json、跨会话路径拒绝；实际 CLI session_start 异常无可用 Worker；启动超时回收 | 无自动化缺口 |
| E09 | 实际慢调用 cooperative abort；丢失 abort 响应后强制关闭；确认等待取消无文件；异常进程退出保留退出证据；模型错误区分；Job 子孙退出且无关进程存活 | 真实提供商流式取消仍待人工验收 |
| E10 | 无订阅/订阅抛错仍消费 45 万字节级输出，展示窗口有界、截断可见、权威消息可读 | 无自动化缺口 |
| E11 | 固定组合/扩展哈希不符拒绝；缺失、空、错误 header、版本不兼容及尾部损坏文件不被替换 | 无自动化缺口 |

完整本地 `npm.cmd test`：143 项，132 通过、10 失败、1 跳过。10 项失败是 8 项 Electron 桌面启动（sandbox 安装目录 ACL）及 2 项产品 DPAPI（受限 CurrentUser 令牌），既有 Spike DPAPI 明确跳过；引擎 18 项在该轮全部通过。没有修改安全设置、权限或现有测试以规避环境问题。该记录早于新增两项测试，最终完整检查由 `github_publish_pull_request` 在托管环境执行，其结果以 PR 的 Validation 为准。

## 真实模型门禁

没有提供可用于此次验收的数据目录和测试 appId；本次执行 `npm.cmd run engine:live` 返回 `BLOCKED / MISSING_EXPLICIT_TEST_APP`，未产生真实模型调用。**当前是可审查的实现，尚不能关闭全部 E01–E11 验收门禁。**

在正常 Windows 用户环境，通过已有应用管理界面配置 DPAPI 凭据、发布一个仅对话测试应用，关闭桌面后执行：

```powershell
npm.cmd run build
npm.cmd run engine:live -- --data-root=<测试数据绝对目录> --app=<已发布应用UUID>
```

该命令显式调用真实模型、创建新的验收 Conversation，可能产生费用；不接受命令行 Key，不读取或重放现有用户会话。验证流式调用、精确恢复消息不变、模型回忆唯一标记、流式中途取消。执行记录写入独立 `.test-engine-live-*/report.json`，只含结果、版本和取消证据；命令失败保留证据和会话。完整聊天消息保留在测试数据中的 Pi 会话，勿当作脱敏报告上传。过快完成而无法证实取消也返回 BLOCKED。此入口不替代真实双会话/工具子进程验收，合并验收时还需结合上述自动化与原 Spike 的真人提供商场景补齐证据。

目前没有把真实提供商门禁记为通过，也没有把本地受限 shell 的完整回归记为通过。
