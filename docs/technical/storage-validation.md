# Storage S01–S18 验证记录

日期：2026-10-03。环境：Windows x64、Node 24.19.0、npm 11.17.0；真实 `node:sqlite` 文件数据库，使用工作区中文/空格临时目录。没有模型 API Key、个人 profile、内存数据库或 mock SQLite。测试文件：`tests/integration/storage.test.mjs`；类型契约：`tests/types/storage.ts`。

Issue 正文要求 S01–S18，但未提供编号的详细场景定义，下表将要求映射为可执行场景。

| 编号 | 验证内容 | 本地结果 |
|---|---|---|
| S01 | 空目录初始化、实际连接 PRAGMA、核心对象读写与重开持久化 | 通过 |
| S02 | 从 v1 升级、迁移顺序、记录、重复执行无变化 | 通过 |
| S03 | DDL 中途失败回滚、checksum 漂移、未来 schema、损坏文件保留 | 通过 |
| S04 | App 当前版本、Conversation 和 Run 复合外键归属 | 通过 |
| S05 | 已发布配置/Skill 绑定不可修改，新版本不改旧会话，发布失败回滚 | 通过 |
| S06 | 可空 run/session，跨会话消息拒绝，首次引擎 session 绑定 | 通过 |
| S07 | Artifact 三层归属、托管 ID 路径、非法大小/穿越拒绝 | 通过 |
| S08 | 所有非空记忆来源存在性、同应用/同会话/同执行约束 | 通过 |
| S09 | 记忆版本追加、冲突拒绝、历史注入保留、删除/过期与 app 检索隔离 | 通过 |
| S10 | 同会话 requestId 去重、跨会话可复用请求 ID、数据库唯一键 | 通过 |
| S11 | 事件连续递增、重复/跳号拒绝、稳定排序和分页 | 通过 |
| S12 | 每条合法运行状态边、非法转换、阶段、乐观版本、单会话活动执行约束 | 通过 |
| S13 | 完成态/消息/事件原子写入、归属失败回滚、嵌套 savepoint、拒绝 async | 通过 |
| S14 | 两条真实连接 WAL 读写隔离、3 秒 busy timeout、竞争失败不覆盖 | 通过 |
| S15 | Windows 中文/空格路径、UUID、UTC 精度、穿越/UNC/保留名/已有 junction 拒绝 | 通过 |
| S16 | 凭据引用及严格配置 schema、endpoint 凭据拒绝、参数化 SQL | 通过 |
| S17 | 真实 Host 初始化后 ready、正常关闭/重启、损坏/不可用目录公共错误 | 通过 |
| S18 | 产品 bundle 中数据库仅在 Host、删除无级联、历史保留 | 通过 |

执行命令：

```powershell
npm.cmd run typecheck
npm.cmd run build
node --test --test-concurrency=1 tests/integration/storage.test.mjs
npm.cmd test
```

独立存储测试 **18/18 通过**，类型检查通过。存储与真实 Service Host 联合测试 **25/25 通过**。

受限 shell 的完整复核 `npm.cmd test`：**54 项，49 PASS、4 FAIL、1 SKIP，退出码 1**。四项失败均为已有 Electron 测试在创建窗口前遇到运行时目录 ACL 检查：`Sandboxed processes cannot read ... electron/dist ... AppContainer package SID but none for ALL APPLICATION PACKAGES`。DPAPI 回归按已有规则报告当前受限 Windows token 前置条件不满足。没有关闭 sandbox、跳过桌面断言或修改工作区 ACL。

首次完整运行还遇到 Electron 下载/默认缓存目录不可写；已使用 `NODE_USE_ENV_PROXY=1` 和工作区 `.cache/electron` 安装固定 Electron，随后得到上述可复现 ACL 结果。此环境问题与 [Foundation 原始验证记录](foundation-validation.md) 一致。

提交前由宿主 `github_publish_pull_request` 再次执行配置的完整 `npm.cmd test`；宿主检查和发布结果以工具回执/PR 为准。本文件保留受限 shell 的原始结果，不把它改写为完整通过。

Windows CI 延用 `.github/workflows/windows.yml` 的固定 Node/npm 和 `npm test`，会自动包含全部 S 测试；远端 CI 状态以 GitHub Actions 实际结果为准。

不宣称已验证真实模型凭据、自动投影重建、跨介质原子提交、完整文件权限沙箱、磁盘满注入、安装包升级或备份恢复。本次将存储失败统一报告且不重建数据，测试直接验证锁竞争、迁移和损坏数据库错误路径。
