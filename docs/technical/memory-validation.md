# Memory M01–M10 验证（Refs #16）

本项遵循维护者 2026-10-08 的执行条件调整：允许基于已合并实现开发、自动化测试和提交草稿 PR。最终真实模型与人工验收未完成，PR 必须保持 Draft，不自动关闭 Issue。

## 自动化与真实验收分开

`tests/integration/memories.test.mjs` 使用真实 SQLite FULL/WAL、实际 MemoryService/RunScheduler、Pi 0.73.1 和 Windows Worker；只有模型是确定性 HTTP SSE 夹具。`desktop.test.mjs` 增加实际 Electron/preload/Host 的确认保存、来源跳转、过滤、跨会话注入、版本展示、停用与删除流程。既有存储测试保留不可变触发器、外键和持久化验证。

| 编号 | 自动化验证 | 最终验收状态 |
|---|---|---|
| M01 | 来源消息手动确认，新会话实际 HTTP 请求含记忆与稳定 ID；UI 确认编辑流程 | 真实模型按偏好作答待验收，夹具回显不替代实际使用 |
| M02 | 同一数据库双应用，B 检索和实际 HTTP 请求均无 A 标记；外来 ID/来源/Run 拒绝 | 真实模型双应用复核待补 |
| M03 | 停用、删除、过期、candidate、conflict 均排除；禁用配置与试运行不注入 | 人工检查待补 |
| M04 | 编辑后历史 Run 返回旧版本/内容/hash；重开 SQLite 仍正确；UI 显示 v1 | 人工检查待补 |
| M05 | 确定排序、默认最多 8 条、1500/600/1 预算、整条跳过、零相关；实际 Pi 输入占满时预算为零，Skill 展开预留 | 真实模型预算复核待补 |
| M06 | SQLite user 消息保持原文；实际请求带单独记忆区块；UI 不把包装文本冒充手写内容 | 人工检查待补 |
| M07 | 记忆含“开启 shell”，实际 chat 请求没有 tools，现有权限系统仍独立验证 | 真实攻击文本与人工权限检查待补 |
| M08 | 多种明显测试秘密被拒绝，不回显，不新增/更新版本；数据库检查 | 人工敏感输入检查待补 |
| M09 | 旧 expectedVersion 拒绝；排队、Worker 启动后预算等待期删除不会发送；发送后删除保留审计；审计失败不调用 prompt | 人工竞态复核待补 |
| M10 | 专项服务流程串联应用/模型/Skill、隔离测试、附件、实际受控工具产物、确认保存和新会话载荷 | 创建应用→模型/Skill→测试→产物→保存记忆→新会话实际使用的完整真实流程仍待完成 |

首轮定向 `node --test --test-concurrency=1 tests/integration/memories.test.mjs tests/integration/storage.test.mjs` 为 23/23 PASS（随后补充预算与桌面用例）。最终完整结果见 PR 宿主 `npm.cmd test` Validation 和本项脱敏证据。

最终新增记忆专项 7/7 PASS，随后新增的正式 Host IPC/重启/并发测试 1/1 PASS；类型检查及生产构建通过。M10 的确定性模型串联流程真实执行了受控文件工具并验证产物内容。测试名称明确注明夹具，不计入真实模型 PASS。

2026-10-08 本地受限 shell 的首轮完整 `npm.cmd test`：190 项，176 PASS、13 FAIL、1 SKIP。11 项 Electron/开发桌面测试在启动时被 Windows sandbox ACL 阻止（包括新增 Memory UI），2 项产品 DPAPI 测试返回 CREDENTIAL_UNAVAILABLE，原生 DPAPI 前置探测跳过。记忆服务与实际 Pi 预算测试全部通过。没有关闭 sandbox 或删改失败检查；宿主发布工具会在托管环境重新执行同一完整检查。随后新增 M10 串联用例，最终总数以宿主记录为准。

宿主首次调用超时，重试的完整检查为 192 项：191 PASS、1 FAIL、无跳过。唯一失败为新增 UI 测试把页面下方应用卡片的“编辑”按钮也计入记忆筛选结果；已把断言与编辑点击限定到“应用记忆管理”区域，并在载入时禁用筛选避免请求被忙碌保护丢弃。最终修复后的完整结果以 PR Validation 为准。

## 保留的关闭前条件

- Engine E01/E05/E06/E09 真实模型；C01 真实模型 UI 闭环及 C01–C10 人工验收。
- File 真实模型读取附件生成产物流程及 F01–F10 最终验收。
- 本项 M01–M10 真实存储/模型验证及人工检查，尤其 M01 实际采纳和 M10 完整真实流程。
- 使用明确提供的已配置凭据测试数据目录、已发布测试 appId；当前任务未提供这组参数，不探测个人数据目录、不读取或输出明文密钥。现有 File 门禁证据为 MISSING_EXPLICIT_TEST_APP，按本项授权不阻碍开发及草稿提交。

真实验收需分别记录模型运行成功、实际请求中的记忆 ID/版本与跨应用载荷检查、原始用户消息、输出是否采纳记忆、旧版本及删除后新会话行为。只保留脱敏计数/布尔结果与哈希，不把完整秘密、端点、原始模型请求或个人文件路径发布到 Issue。未完成项不能因代码合并或夹具通过改标 PASS。

设计与竞态边界见 [记忆架构](memory-architecture.md)。前置验收记录见 [Engine](engine-validation.md)、[Chat](chat-validation.md)、[File](file-validation.md)。
