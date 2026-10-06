# Skill K01–K10 验证记录

日期：2026-10-06。Windows、Node 24.19.0、Pi 0.73.1、锁定依赖。前置 #9 为 closed/completed，PR #23 已合入；这里的验证不宣称正式聊天或真实模型试运行完成。

`npm.cmd run typecheck`、生产构建通过。`node --test --test-concurrency=1 tests/integration/skills.test.mjs tests/integration/apps.test.mjs tests/integration/storage.test.mjs tests/integration/service.test.mjs`：49/49 通过，其中 Skill 13 项、App 11 项、Storage 18 项、Service 7 项。均使用真实文件系统、SQLite 与生产服务 IPC；依赖缺失用例注入受控检测结果，不伪称机器安装状态。

| 编号 | 覆盖与结果 |
|---|---|
| K01 | 系统选择令牌的归属、用途、有效期、单次使用；中文/空格来源路径；导入字节和 SHA-256 可核对；独立哈希公式/顺序不变性；生产 Service Host 导入后重启仍可读取。通过。 |
| K02 | 缺 SKILL.md、无 frontmatter、非法 UTF-8、重复 YAML key、错误字段类型，报告相对文件/行号且无登记半成品。通过。 |
| K03 | 同版本同内容不重复登记、不同内容拒绝覆盖；平台分配身份/版本有明确来源标识、相同内容重试稳定。通过。 |
| K04 | 两应用同名包按各自 ID/version/hash 解析，内容独立；跨应用 revisionId 被拒绝；自动/显式/禁用分别物化。通过。 |
| K05 | Bash/Python 缺失、未知 CLI 未验证、受管理 Node 已满足；未知版本范围未验证；缺失依赖阻止发布；无安装行为。通过。 |
| K06 | Markdown 绝对路径、路径穿越、百分号编码穿越、UNC、缺失引用、命令片段越界；真实 Windows junction 和 hardlink；单文件/数量限制；动态和远程引用标注未验证。通过。 |
| K07 | 新源包版本和新调用模式生成新 AppRevision，旧快照字节/哈希、旧会话 revision 保持；历史引用阻止删除（含禁用绑定）。通过。 |
| K08 | 在复制后、rename 后、数据库登记阶段注入 I/O 错误；真实 SQLite trigger 中止插入；清理暂存/无登记目录、保留可重试性；导入过程中改变源 SKILL.md 被拒绝。通过。 |
| K09 | 全局源包或已物化快照篡改分别产生 SKILL_INTEGRITY，阻止解析，不静默使用更新文件。通过。 |
| K10 | 带执行标记的 CJS 脚本经 import/get/validate 后标记始终不存在；权限只保留声明；后续引擎只返回明确路径、discovery=false、extensions=[]。通过。 |

实际目录 rename 曾出现 Windows 短暂 EPERM；改为只针对 Windows 的 EPERM/EACCES/EBUSY 最多四次短暂重试（合计最多 375ms），每次校验管理路径和目的不存在。修复后 K04/K07 连续 10/10 通过；故障注入仍验证持久失败的回滚，没有自动重放发布事务。

`tests/integration/desktop.test.mjs` 新增 K01/K04：只在可信 Main 测试环境替代 OS 文件选择结果，保留真实 preload/IPC/Service/SQLite 链路，检查技能库展示、导入报告、精确版本绑定、调用模式、禁用状态、刷新后持久化、前端不能直接传路径以及 allowed-tools 不修改权限。新增公开 API 同步加入既有 sandbox/隔离表面断言。真实 OS 对话框手动操作不属于自动化断言。

受限 shell 的完整 `npm.cmd test` 已运行；Electron 启动及 CurrentUser DPAPI 受到本地执行环境限制，桌面用例未到达 UI 断言，不能记为通过。全量回归另发现既有合并遗留测试仍把 DeepSeek `/v1` 当作允许端点，已将该用例对齐当前产品的官方根端点约束，并独立验证通过；未修改 Provider 产品逻辑。最终发布必须由宿主 `github_publish_pull_request` 执行配置的完整检查，其返回结果和 PR 检查记录为托管环境的验收依据。没有关闭 Electron sandbox、改变目录 ACL 或跳过新增桌面用例。

示例包：`tests/fixtures/skills/reference-helper`，含声明元信息、参考资料与不应执行的测试脚本；可通过技能库目录选择导入。完整性算法、检测范围及源包清理策略见 [skill-architecture.md](skill-architecture.md)。
