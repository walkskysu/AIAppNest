# Chat #14：创建向导与应用内工作空间

2026-10-08。依据固定需求 v1.0 §2.3、§4、§9、§11、§12、§13.3。按维护者本次授权开发并提交 **Draft / Refs #14**。代码合并、夹具通过均不构成真实模型验收，不自动关闭 Issue。

## 实现边界

- 创建页提供七段向导、前后导航、模型设置/连接测试、Skill 库入口、字段错误、草稿和试运行。记忆选项明确仅保存配置，附件、记忆管理、产物预览和物理回收没有伪造数据。
- `chat.trial.start` 在 SQLite 事务内建立候选不可变 AppRevision 和独立 conversation；不更新应用当前版本。每次候选使用独立 sessions/agent/workspace，调度器不向试运行注入正式记忆。用户必须提供非空任务，无自动测试 prompt。
- 候选与原草稿哈希、试运行会话及 requestId 持久化关联。草稿或模型修订改变后结果失效；试运行工作空间可显式授权、停止和手动重试，最新 Run 成功才可发布。候选保留原始配置和 Skill 文件；发布仅原子切换到该 revision，不重建文件。发布失败回滚且保留草稿；丢失响应重试不生成重复版本。
- 关闭测试页只退订，不取消执行。显式停止走 RunScheduler；诊断、候选快照、测试会话和工作文件保留。删除测试会话只移入回收区，完整回收站和物理清理由数据管理任务完成。可信自动化仍有既有 Windows 账户权限边界，不把独立目录声称为安全沙箱。
- `chat.list/create/history/rename/delete` 统一后端校验 appId/conversationId。列表和基础子串搜索（标题与消息）只在当前应用，排除测试和回收会话。新会话绑定当时已发布版本；打开应用只取列表。
- SQLite 是历史权威源。消息按 createdAt/id 排序分页，UI 按消息 id 合并；工具结果独立持久化。运行事件以 `(runId,seq)` 连续游标合并，重复/跨 Run 事件不追加；60ms 拉取批次、不并发轮询。页面切换销毁计时器并退订，晚到订阅也会退订；刷新从服务查询，不发送 prompt。
- 用户发送前生成 requestId；传输不确定时保留原载荷供显式相同请求确认，不自动重试。手动重试生成新 requestId，并在首条持久化事件保存 `retryOf`，复核原 Run 属于同会话且已终止。UI 提示已有副作用不会自动回滚。
- 软删除先封闭会话新提交、取消排队/活动任务、关闭闲置 Worker，确认已回收后写回收范围。聊天与附件逻辑移入回收区，保留来源记忆与产物；不执行物理删除。正在停止时可显式再次查询终止结果。
- 内容使用 Vue 文本节点和围栏代码白名单，无 `innerHTML`。原始 HTML、Markdown 图片和危险链接显示为文本，不载入资源。外链仅显式点击后经可信 Main 复核 http/https，禁止凭据 URL。复制、折叠不改变数据库原文。Enter 提交、Shift+Enter 换行、composition/isComposing/229 防误发。

## 自动验证与环境记录

新增 `tests/integration/chat.test.mjs` 覆盖服务和正式 IPC 的候选隔离、快照一致性、事务失败/重试、归属拒绝、中文搜索分页、重启、幂等提交、实际 Pi 取消与回收、retryOf、事件去重、URL 白名单及 IME 判定。仅模型为确定性 HTTP SSE；SQLite、正式服务、Pi、Windows Worker 和 sessionFile 均实际运行。

`desktop.test.mjs` 增加完整 UI 用例：不用 JSON 创建模型与应用 → 连接测试 → 试运行 → 修改配置使按钮失效 → 发布 → 新会话 → 中文输入法与双击 → 恶意内容 → 刷新历史无重发 → 活动删除。保留既有桌面和安全断言，没有跳过桌面测试或关闭 sandbox。

本地类型检查和构建通过；新增服务/正式 IPC 5 项通过。首次完整 `npm.cmd test` 为 171 项：158 PASS、12 FAIL、1 SKIP。9 个 Electron 用例在启动处受 Windows sandbox ACL/受限令牌阻挡；2 个产品 DPAPI 用例失败；1 个权限 IPC 用例遇到该轮执行期间源码与旧构建不一致，重建后的 Chat/Policy 定向回归用于复核。曾尝试给本工作区 Electron 依赖目录增加标准只读 ACL，仍无法启动，随后撤回该临时调整。最终完整检查由宿主 `github_publish_pull_request` 在托管环境执行，以工具结果与 PR Validation 为准。

## C01–C10 验收清单

重建后的 Chat + Policy 定向回归为 **24/24 PASS**，权限 IPC 启动复核通过。

首次宿主托管 `npm.cmd test`：**172 项，171 PASS、1 FAIL，无跳过**。新增生产 Electron 创建/连接/试运行/发布/IME/双击/恶意输出/刷新/活动删除闭环通过；既有真实 DPAPI 和桌面测试也可运行。唯一失败为旧 F01 对 preload 方法名集合的精确断言缺少新 `chat`、`openExternal`；已更新该白名单，保留 require/process/ipc 均不可见的安全断言。最终检查以再次发布工具结果为准。

| 编号 | 必须保留的验收标准 | 自动化证据及待办 |
|---|---|---|
| C01 | UI 完成配置、测试、发布与真实对话 | 正式 IPC/Pi 夹具通过；桌面硬测试已添加；**真实模型 UI 闭环仍待验收** |
| C02 | 修改草稿不能沿用旧测试成功结果 | 候选快照、哈希、并发编辑、失败回滚、精确发布及重试断言 |
| C03 | 双应用列表、搜索、消息、运行不串用 | 服务归属/搜索测试，既有 Run scope 验证；双应用人工检查待补 |
| C04 | 重启历史可读，下一轮 sessionFile/版本正确 | 实际 Service Host 重启、Pi 精确 sessionFile 和回忆夹具测试 |
| C05 | 双击、超时重试不产生重复执行 | 相同 requestId 正式 IPC 并发提交、UI 双击硬测试；超时不重放沿用调度器测试 |
| C06 | 排队、审批、取消、失败与服务一致 | 既有 Run/Policy 集成测试；UI 状态、显式审批、停止和手动重试；人工交互检查待补 |
| C07 | 恶意 HTML、链接和脚本不执行 | URL/事件单元断言，生产 Electron 恶意输出和 DOM 断言；无远程图片元素 |
| C08 | 删除前终止，保留未选的记忆/产物 | 实际 Pi 删除终止、禁止新提交、记忆保留、UI 活动删除硬测试 |
| C09 | 刷新无重发、无累积监听 | generation 退订/晚到响应处理、Run 订阅集成测试、UI reload 请求计数 |
| C10 | 中文输入法不误发、历史分页不乱序重复 | IME unit + UI composition、205 条同时间戳分页排序/去重 |

## 真实模型门禁与最终关闭条件

2026-10-08 执行 `npm.cmd run engine:live` 返回 `MISSING_EXPLICIT_TEST_APP`。未取得明确测试数据目录与已发布测试 appId，不发现或挪用其他目录中的真实凭据。该结果只阻挡真实验收，未阻止实现、自动化或草稿 PR。

需要使用已配置凭据、明确授权的测试数据目录执行：

```powershell
npm.cmd run engine:live -- --data-root=C:\explicit-test-data --app=<published-test-app-id>
```

脚本现检查 E01 流式成功、E05 双独立会话标记不混入、E06 原 sessionFile 精确恢复/回忆、E09 流式中途取消。脱敏报告不含凭据、prompt、marker 或绝对 sessionFile。缺少任一条件不能 PASS。

最终还须补齐 **真实 E01/E05/E06/E09、C01 真实 UI 闭环、C01–C10 人工检查**，更新本文件及引擎/调度器证据；在此之前 PR 保持草稿、使用 `Refs #14`，不得以 fixture 或前置 Issue 已关闭替代验收。
