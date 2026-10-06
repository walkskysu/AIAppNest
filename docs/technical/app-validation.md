# 应用管理 A01–A10 验证记录

日期：2026-10-06。环境：Windows、Node 24.19.0、锁文件依赖。使用独立临时数据目录、真实 node:sqlite、真实文件系统和生产 Service Host；受控 Provider 凭据只验证配置、归属和轮换逻辑，没有真实模型调用。

核心命令：`node --test --test-concurrency=1 tests/integration/apps.test.mjs`，11/11 通过。类型检查与生产构建通过。

受限 shell 执行 apps/providers/storage/service 共 54 项：53 PASS、1 FAIL。失败为既有 P09 CurrentUser DPAPI `CREDENTIAL_UNAVAILABLE`；App 11 项、Storage 18 项和 Service 7 项全部通过。单独真实 Electron 用例在 `electron.launch` 20 秒超时，日志含 Windows `os_crypt` 无法加密（0x2），未到达 UI 断言，不能记为桌面通过。完整 `npm.cmd test` 为 85 项：77 PASS、7 FAIL、1 SKIP；失败为 6 项桌面启动和 P09，跳过为既有 Spike DPAPI 环境门禁。桌面日志另有 Electron sandbox 目录 ACL 缺少 ALL APPLICATION PACKAGES 的致命启动错误。没有关闭 sandbox、改 ACL 或跳过这些测试。最终必须由宿主 `github_publish_pull_request` 在托管 Windows 环境运行完整配置检查；其返回结果和 PR 检查记录是发布验收依据，不能用上述 53 PASS 替代。

| 编号 | 证据 | 核心结果 |
|---|---|---|
| A01 | apps.test 元数据/字面搜索/分页/收藏/最近使用、关闭重开数据库、生产 sidecar 重启；desktop.test 表单创建/编辑/搜索/收藏、sidecar 重启恢复 | 核心通过；桌面需宿主完整检查 |
| A02 | 无模型、丢失 Provider/凭据、未解析 Skill、权限与工具冲突拒绝发布；已发布应用凭据失效后变为缺少依赖 | 通过 |
| A03 | 发布两版，读取第一版内容、manifest 字节和哈希不变；SQLite UPDATE 被 immutable 拒绝；Provider 模型变化不改旧版模型；凭据轮换不改快照，端点变化拒绝解析 | 通过 |
| A04 | 真实仓储创建旧会话，发布第二版，再创建新会话；旧会话绑定第一版，新会话第二版 | 通过 |
| A05 | 两个独立 SQLite 连接编辑同一草稿；旧保存/发布/复制/归档均返回 VERSION_CONFLICT，最新数据保留 | 通过 |
| A06 | 文件写入、rename 后、事务阶段注入故障；真实 SQLite trigger 中止写入；旧版本仍可读；暂存与未提交目录可收集；文件篡改使状态缺少依赖 | 通过 |
| A07 | 新 ID、无模型关联（含无认证 Provider）、无凭据/授权/会话/记忆/版本/产物复制；未重新绑定不得发布；桌面提示重新配置 | 核心通过；桌面需宿主完整检查 |
| A08 | 排队运行阻止归档；终止后归档默认隐藏；拒绝新会话/Run、历史仍可读且可恢复；打开不调用模型 | 核心通过；桌面需宿主完整检查 |
| A09 | 跨应用 revisionId、currentRevisionId 注入、任意 env/args/path/credential/validation、远程图标及未知 operation 拒绝；生产 IPC 重验 | 通过 |
| A10 | 改名后 appId、currentRevisionId、目录及已发布字节/哈希不变 | 通过 |

CI 的 `npm test` 自动收集 `tests/integration/*.test.mjs`，新增用例无需模型密钥，继续沿用 Windows 工作流。

用户在 Issue 中确认的 DeepSeek 官方端点和 deepseek-flash 本机测试，是用户实测反馈；本记录不补造报告。本任务不运行 provider:live，本地推理模型和云端+本地完整验收仍未完成。应用试运行和正式会话执行亦未完成。本任务遵照 2026-10-06 前置条件调整推进，不把上述未完成项作为应用管理开发的阻塞。
