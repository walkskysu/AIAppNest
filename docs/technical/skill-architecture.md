# Skill 导入、版本绑定与完整性

对应 #10；需求基线为 d002eac 的 v1.0 §4.2、§7.2、§8、§10、§13、§14。前置 #9 已完成并经 PR #23 合入。

## 入口与元信息

`desktop.selectSkillDirectory()` 只打开系统文件夹选择器。Main 校验所属窗口、主 frame 和 app origin，向继承的 Service IPC pipe 登记路径及 Main 生成的 document owner。Service 分配随机 UUID 令牌，范围固定为 `skill-import`，有效期五分钟、仅可使用一次。同 owner 再选择会撤销旧令牌；页面导航更换 owner；Service 重启清空令牌。Renderer 的 `skills.import` 只接收令牌，不能提交 owner、路径、命令或扩展入口。取消选择不产生令牌。

`SkillRegistry` 仅管理普通 Skill；脚本是包内文件清单，不执行、不安装、不注册 Pi 扩展。IPC 暴露 import/list/get/validate/delete，草稿绑定通过 `apps.bindSkills` 或完整草稿 update，发布和运行解析再次验证。list 分页；get 返回导入时报告，validate 返回当前完整性及依赖检测结果。无通用文件写入接口。

依据本地锁定包 `@mariozechner/pi-coding-agent@0.73.1/dist/core/skills.js`、`dist/utils/frontmatter.js`：Pi 读取 YAML 的 name、description、disable-model-invocation，使用 yaml 解析；allowed-tools 不提供权限执行边界。平台直接依赖锁定的 yaml 2.9.1，并采用更严格的 UTF-8、字段类型、重复键/别名和路径校验。name 必须为 1–64 位小写字母、数字、单连字符；description 必须是非空、最多 1024 字符的字符串。平台要求明确 name，不采用 Pi 的父目录兜底。中文和空格可用于导入目录及包内文件名。

平台附加信息放在 `metadata.aiappnest`，不伪称 Pi 原生支持这些字段：

```yaml
---
name: reference-helper
description: 阅读参考资料并整理摘要。
allowed-tools: read
metadata:
  aiappnest:
    skillId: 763ac5e7-3d46-48c7-9bd8-35469f67e403
    version: 1.0.0
    dependencies:
      - name: node
        constraint: '*'
    capabilities: [read]
    references: [reference.md]
---
阅读 [资料](reference.md)。
```

skillId 是 canonical UUID，独立于展示/调用名称。未声明时用规范化绝对来源路径的 SHA-256 派生稳定 UUID，标记 `identityOrigin: source`；目录迁移被视为新来源，不按同名猜测身份。显式声明 ID 的包可从不同路径导入新版本。已声明 version 必须符合三段数字版本；格式错误拒绝，未声明时分配 `0.0.<内容哈希前96位的十进制值>` 并标记 `versionOrigin: platform`。这是平台版本号，不能当成上游语义版本；截断碰撞依然通过完整 SHA-256 冲突检查拒绝。相同 ID/version/hash 幂等；不同内容拒绝覆盖。

## 静态校验边界

- 只支持文件夹。拒绝 UNC、symlink、junction（包括内部链接和祖先）、hardlink、特殊文件、Windows 保留设备名、ADS、无效字符、尾部空格/点以及规范化后大小写重名。
- 限制 1000 个文件、2000 个目录项、20 层目录、单文件 8 MiB、总大小 32 MiB、规范化相对路径 512 字符。文本资源必须是 UTF-8；二进制文件按原始字节保存。
- 校验 Markdown 链接、引用式链接、独立反引号路径，以及 `metadata.aiappnest.references`；对明显的脚本/命令片段绝对路径和 `..` 引用采取保守拒绝。远程 URL、变量、通配符、复合命令和脚本动态行为明确标为未验证。静态分析不是任意语言解析器，也不证明任意自然语言、编码字符串或动态脚本的行为安全。复杂引用可通过 references 声明包内资源，权限仍由后续工具服务强制执行。
- 校验报告包括相对文件位置、行号（0 表示文件/目录级）、错误代码、依赖状态、脚本和权限声明。文本按 Vue 文本节点展示，不作为 HTML 执行。

每次读取检查链接、普通文件身份、大小和时间戳，使用固定长度缓冲区，避免文件增长造成无限读取。复制到受管理暂存目录后重新解析元信息、计算哈希，并重新扫描来源对比最终副本。检测到变更即拒绝重试。哈希算法 v1：先加入 `AIAppNest.Skill.v1\0`，将相对路径转 `/`、Unicode NFC，按 JS 字符串序排序；每项依次加入 UTF-8 路径字节长度、冒号、路径、冒号、文件字节长度、冒号及原始字节。修改时间和枚举顺序不参与，文件名/内容参与。

这是可信本地 Skill 的一致性及越界检查，不是对同一 Windows 用户持续恶意竞态的 OS 沙箱；没有声明文件系统跨介质原子事务或系统权限隔离。

## 依赖检测与权限

依赖状态仅有 satisfied / missing / unverified。声明本身不是安装证明。

- `node`：验证当前受管理 Node 版本；`*` 或精确相等为已满足，其他版本约束未验证。不会把未知 semver 范围猜成通过。
- Windows `python`、`bash`：只检查标准安装位置，不搜索 PATH 或包目录。Python 3.11–3.14 的 Program Files/LocalAppData 安装目录、Git for Windows 的 `Program Files/Git/bin/bash.exe` 有候选时仍为未验证（未执行版本探针）；未找到标记缺失，并说明仅限标准位置。自定义安装位置、虚拟环境、WSL、完整环境管理留待独立依赖流程。
- 外部 CLI 和其他环境：未验证。检测不会执行未知命令、脚本、安装器或联网。
- `.py`、`.sh/.bash`、`.js/.mjs/.cjs` 额外推导对应运行时需求。未知依赖仍可被审查/绑定；启用 Skill 的已知缺失依赖阻止发布和运行解析。禁用 Skill 不要求依赖满足，但仍固定并校验其身份、版本和内容。

能力需求和 allowed-tools 只展示；不会改写应用 permissions、grants 或工具白名单。导入成功不等于脚本已通过运行验证。

## 注册、失败补偿与删除

迁移 4 新增 `skill_registry` 保存结构化详情，与已有 skills 的 ID/version 外键关联，保留 sourcePath 为生成的相对管理路径。源包记录不可 UPDATE；无级联删除。

导入在 SQLite `BEGIN IMMEDIATE` 内执行：读取来源 → `.staging-UUID` 复制/flush → 最终副本/来源校验 → rename 至 `skills/<id>/<version>` → 插入 skills + skill_registry → 再验完整性 → COMMIT。失败回滚数据库并清理本次文件；清理失败或进程崩溃留下的暂存/无记录版本不具备绑定资格。启动时同一 writer lock 内收集暂存及未登记版本，不碰已登记历史版本；拒绝链接清理，不跟随 junction 删除用户文件。

Windows 刚写入目录偶发被扫描器短暂占用。源包与 AppRevision 的 rename 对 EPERM/EACCES/EBUSY 最多重试四次、合计等待不超过 375ms，每次重验路径及目标不存在；其他错误直接补偿。不重放数据库提交或用户请求。

删除首先在事务内检查所有已发布版本（含旧 config 中的引用），返回 SKILL_IN_USE 时保留历史会话依赖；禁用绑定也保留引用。可删源包先显式删除详情和源包行、提交，再在 writer lock 内收集未登记目录，避免新导入与清理竞态。磁盘清理失败仅留下不可绑定孤儿，启动重试。仅存在于未发布草稿中的引用不阻止删除；之后草稿显示缺少依赖并禁止发布。

## AppRevision 与后续引擎

绑定包含 id/version/hash/enabled/invocationMode；旧草稿绑定缺少新增字段时默认为启用、自动调用，不改写旧版本磁盘文件。同一应用不允许启用同 Pi 名称的多个 Skill，避免 `/skill:name` 歧义；不同应用可绑定同名不同 ID。保存草稿保留编辑状态，发布时校验全部绑定和已启用依赖。

发布在现有暂存快照事务内复制到 `apps/<appId>/revisions/<revisionId>/skills/<skillId>/<version>/<name>/`。只在该副本生成 `disable-model-invocation`：explicit=true、automatic=false。全局源包不变；manifest 同时固定 sourceHash 和生成快照 hash。app_skills 提供外键及历史引用，invocationMode 和 hash 固定在不可变 AppRevision config/manifest。更改绑定须发布新版本；旧会话保持原 revision。

`AppService.resolveSkills(appId, revisionId)` 是服务内引擎入口：校验版本归属、manifest、源包和快照哈希及依赖，返回 `{ discovery:false, extensions:[], paths:[绝对 SKILL.md 路径] }`。源包或快照篡改返回 SKILL_INTEGRITY，禁止静默换用新内容。未来 Pi 适配器只能将这些明确路径与 `--no-skills` 一起使用，并关闭自动扩展发现；不从用户源目录、PATH、cwd 或全局库自动发现。正式任务调度/会话执行不在本次实现内。
