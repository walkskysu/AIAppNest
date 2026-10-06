# 应用管理与不可变配置版本

对应 #9，需求固定于 d002eac 的 v1.0 文档。应用首页、基础编辑、配置发布、复制、归档已接入同一 AppService；创建向导和会话工作空间应复用此服务。当前没有聊天执行、Skill 导入、试运行编排或彻底删除入口。

## 服务与数据来源

- `packages/domain/src/app-config.ts` 是草稿和新发布配置的唯一 schema（`schemaVersion: 2`）。原 Storage 的 schemaVersion=1 历史版本仍可读取，不原地迁移或重写。旧版尚无完整快照的应用显示缺少依赖，需显式编辑并重新发布。
- 迁移 3 新增 `app_drafts` 和 `revision_snapshots`，保留原 App/AppRevision/Conversation/Run 归属外键、不可变触发器和迁移校验和。基本资料用原 apps 表；分类、收藏、最近打开时间与草稿放 app_drafts。
- `apps.version` 是整个应用编辑的乐观锁；编辑、发布、归档均检查期望版本并递增。复制也验证来源期望版本。打开只更新最近使用时间，不使正在编辑的草稿过期。
- 列表在 SQLite 中筛选、排序和分页，支持名称/简介/分类字面子串搜索、最近使用、收藏优先、名称排序；默认隐藏归档，归档列表可恢复。内置四种图标，不接收远程 URL。
- Preload `desktop.apps` → Main `apps:request` → Service Host `apps` 是严格判别联合白名单：list/create/get/update/publish/copy/archive/open/revision/activeRuns。每层校验请求，Main 验证窗口和主 frame，响应也校验形状和 operation。没有文件读写、任意路径、命令执行或通用配置覆盖入口。

## 配置与状态

配置覆盖角色、输出要求、开场白、模型关联及温度/输出上限、确定版本的 Skill 引用、权限和工具白名单、记忆预算与候选策略、执行轮数/超时。未知字段在每一层 strictObject 校验中拒绝；权限仅对话时不可要求文件或 shell，受控文件模式不可要求 shell。API key、secretRef、外部目录、环境变量、启动参数及扩展入口不属于配置结构。

模型必须引用存在且修订相符的 ProviderProfile，使用既有 providerConfigSchema 校验并检查受控凭据可读取性；检查不发出网络请求。准备分支基于 #7，尚无 DeepSeek 类型，本实现沿现有 Provider 路径补充 `deepseek`、官方 `https://api.deepseek.com`（或 `/v1`）、api-key 校验和模型设置选项，模型 ID 保持手动输入。没有另建 Provider 存储或凭据来源。

SkillRegistry 的导入和文件/依赖验证未接入，因此所有非空绑定均视为无法解析并阻止发布；无 Skill 可发布。以后仅在资源编译器能固定并验证包和依赖后放行。

| 首页状态 | 判定 |
|---|---|
| 配置未完成 | 无发布版本，或缺角色/模型、模型无效、权限冲突等；返回具体原因 |
| 缺少依赖 | Provider 不存在、凭据不可读取、Skill 未解析、当前快照缺失/损坏 |
| 可使用（配置就绪） | 当前发布版本完整且其依赖校验通过；并不表示能执行聊天或通过试运行 |
| 已归档 | 优先显示归档状态，保留依赖原因与历史 |

有当前版本时，首页状态针对当前发布版本，`draftIssues` 单独描述未发布的修改。所有应用的 `trialStatus` 都是 `not-tested`；界面明确显示聊天/试运行未接入。打开只进入应用空间和更新最近使用，不启动 Worker、创建会话或调用模型。

## 不可变快照与凭据

目录始终是 `apps/<appId>/revisions/<revisionId>/`，改名不改变目录或身份。每版包含：

- `config.json`：配置、冻结的非敏感 Provider 参数、固定协议与 Pi 0.73.1 运行时版本。
- `role.md`：角色与输出要求编译后的文本。
- `manifest.json`：完整快照、两个资源 SHA-256、受控凭据绑定（Provider ID）、预留验证关联 `validation: null`。

SQLite 保存不可变 manifest 及其 SHA-256（configHash），同时保存 AppRevision。按 appId+revisionId 读取必须通过归属外键和仓储校验，再校验 manifest、文件内容哈希；不接受客户端路径或 currentRevisionId。数据库触发器拒绝修改/删除发布内容。这里的不可变指服务接口和数据库契约，不是对同一 Windows 用户的 OS 文件隔离；磁盘损坏/手改会使版本不可使用。

模型端点、协议、模型 ID、认证模式、超时以及行为参数固定到版本。`ProviderService.snapshotRuntime` 只从冻结配置构建模型，再从同一 ProviderProfile 解析最新受控凭据；必须匹配原端点、提供商类型和认证模式，防止把其他端点的新凭据发给旧版本。更换模型 ID/非敏感参数不改变旧版模型，凭据轮换不改写旧版文件或哈希。Renderer 不接收密钥或 secretRef。此方法供后续运行适配器使用，不是 IPC 接口；后续执行还需应用本版行为参数和权限策略。

## 提交顺序与补偿

发布在 SQLite `BEGIN IMMEDIATE` 写事务内同步执行，不在事务中 await：

1. 检查归档状态、期望版本、草稿、Provider 修订和凭据。
2. 在版本父目录新建 `.staging-<revisionId>`；逐个排他创建并 flush 三个文件。
3. 完整写入后，同目录 rename 到最终 UUID 目录，不覆盖已存在的目录。
4. 插入 AppRevision、不可变 snapshot/hash 并更新 currentRevisionId；重新读取校验完整文件后才 COMMIT（SQLite FULL + WAL）。
5. 写文件、rename、事务或校验失败时回滚数据库，旧 currentRevisionId 保持有效；尽力删除本次暂存/未提交目录。

崩溃、数据库 COMMIT 失败或删除失败可能留下暂存或未引用的 UUID 目录，但不会把半成品目录设为当前版本。服务启动时在同一 SQLite 写锁内收集 `.staging-UUID` 和没有 revision 行的 UUID 目录；保留所有已提交历史，不通过删旧数据“修复”坏快照。清理校验管理根目录与每个子项并拒绝 symlink/junction，避免跨出管理范围。并发发布期间的目录不会被另一个实例清理。此机制不宣称 SQLite 和文件系统拥有跨介质原子事务或可抵御存储硬件故障。

## 会话、复制与归档

`Storage.createConversation` 在事务内从本应用读取当前版本；不接受 renderer 指定的版本。已有 Conversation 的 appId/revisionId 绑定受不可变触发器保护，发布不更新它们。未来 ConversationService 应先用 AppService 按版本读取并校验快照，创建/执行时再完成实际会话编排。

复制创建新 appId、新草稿；保留角色和非敏感策略，只保留仓储内存在且 hash 相符的确定 Skill 引用。始终清空模型关联（包括无认证 Provider），不复制 ProviderProfile、凭据引用、外部目录 grants、版本、收藏、使用时间、会话、运行、记忆或产物。用户必须重新选择当前模型配置，且明确提示重新授权。

`apps.activeRuns` 返回 queued/starting/running/waiting_approval/cancelling 数量。归档在写事务内检查并拒绝活动任务；数据库触发器也拒绝有活动任务时归档，以及向归档应用插入新 Run/Conversation。调度器接入后复用此检查，不能绕过仓储。恢复保留当前版本、全部历史与原 ID；本任务没有停止任务或彻底删除接口。

## 后续试运行关联

发布接口没有 renderer 可写的验证结果字段；当前 manifest.validation 始终为 null。将来的可信试运行服务须保存 appId、草稿 version、编译配置 hash、Provider 修订和运行时/资源版本，再以相同 fingerprint 校验后关联结果。修改任何配置后，旧结果不能证明新草稿通过；不得将本阶段“配置发布”描述为端到端发布验收。
