# Policy Q01–Q10 验证记录

2026-10-07；Windows、Node 24.19.0、Pi 0.73.1。前置 #10 closed/completed，PR #24 合入当前基线。

`npm.cmd run typecheck` 通过；生产构建通过。`node --test --test-concurrency=1 tests/integration/policy.test.mjs`：19/19 通过，无跳过。使用真实 SQLite、Windows 文件系统、生产 Service Host IPC，以及锁定 Pi 的实际 SDK 扩展/工具循环。模型流使用确定性测试 provider，未进行收费模型调用，不声明真实模型推理验收已完成。

扩大验证 `node --test --test-concurrency=1 tests/integration/policy.test.mjs tests/integration/storage.test.mjs tests/integration/service.test.mjs tests/integration/apps.test.mjs tests/integration/skills.test.mjs`：68/68 通过，无跳过；包含迁移历史、真实 WAL/外键、应用版本冻结、Skill 完整性与 Service Host 重启回归。

| 编号 | 证据 |
|---|---|
| Q01 | chat 注册空工具集合；直接文件入口和授权创建拒绝；真实 Pi 请求所有内置工具均报错 |
| Q02 | 授权内读取、列表、覆盖写入、独占创建输出；写授权不隐含读；实际 Pi 平台读写成功；workspace 扩展/settings/AGENTS/SYSTEM 投毒不生效；保护平台权限数据库和运行目录 |
| Q03 | 两种分隔符 `..`、绝对路径、前缀碰撞、Windows 大小写、真实 junction、硬链接；确认期间替换父目录为 junction 后实际写入被拒绝 |
| Q04 | UNC、设备路径、扩展路径、盘符相对路径、ADS、DOS 设备名、尾空格/点、短名均拒绝 |
| Q05 | 只读 grant 写入/覆盖拒绝；无删除、重命名、shell 或任意 exec IPC；跨 grant 及伪造归属参数拒绝 |
| Q06 | 系统令牌 owner/会话/用途/有效期/一次性消费；确认调用 ID、参数摘要、归属、有效期与重复消费；等待期间改变调用方参数对象不改变实际已绑定内容；UI approved 字段拒绝 |
| Q07 | 撤销、取消、AbortSignal、超时、服务关闭均解除等待并拒绝操作；允许后、恢复前取消/撤销/过期仍拒绝；生产 IPC 重启取消旧 allowed 并保留授权撤销版本 |
| Q08 | 旧会话保持已发布上限；新授权不扩大已绑定运行；快照损坏阻止绑定；真实 Pi 扩展工厂和 session_start 故障均没有可用会话 |
| Q09 | 缺明确 Main 同意时绑定可信运行失败；私有 trust 不在 renderer schema；每次通用调用都需确认；真实 Pi write 拒绝时无文件、允许后才产生文件；UI 展示账户文件/凭据与非沙箱边界 |
| Q10 | 对拒绝的已有文件比较实际字节；对新文件检查不存在；真实 Pi 拒绝前后目标保持 original；不是仅断言 UI 文案 |

真实 Pi 拒绝记录由测试输出，摘录（只含测试工具与原因）：

```json
{"pi":"0.73.1","mode":"controlled-files","tool":"platform_write","isError":true,"content":[{"type":"text","text":"{\"code\":\"POLICY_DENIED\",\"reason\":\"ACCESS_DENIED\"}"}],"targetUnchanged":true}
```

完整 `npm.cmd test` 已在受限 shell 启动：类型检查、生产构建及 Pi Windows 回归通过（原有 CurrentUser DPAPI 环境门禁仍明确 skip）；Electron 桌面启动发生环境失败，不能计为完整通过。新增桌面表面/来源验证仍保留原有 sandbox、contextIsolation 和 webSecurity 设置，没有为通过测试放宽沙箱。最终完整结果以 `github_publish_pull_request` 托管检查为准。

路径策略、确认/审计协议、测试宿主入口与 OS 层 TOCTOU、可信代码、取消不回滚等剩余限制见 [权限架构](policy-architecture.md)。
