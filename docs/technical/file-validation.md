# File #15 验证记录

2026-10-08，Windows x64 / Node 24.19.0 / Pi 0.73.1。Refs #15。

维护者已明确允许基于合并的 Chat/PiAdapter/RunScheduler 开发、运行自动化并提交草稿；此前等待前置验收的阻塞结论不再适用。下面的夹具结果不能替代真实模型或人工验收，PR 必须保持草稿，不自动关闭本项。

## 自动化证据

`tests/integration/files.test.mjs`：10/10 PASS，实际 Windows 文件系统、SQLite、PolicyService、RunScheduler 和 Pi；模型使用确定性 HTTP SSE。文件/调度器/存储定向回归共 49/49 PASS。类型检查与生产构建通过。

首次完整 `npm.cmd test`：182 项，170 PASS、11 FAIL、1 SKIP。9 个既有 Electron 测试在启动阶段因工作区 ACL / sandbox 受限令牌失败；2 个既有产品 DPAPI 测试为 `CREDENTIAL_UNAVAILABLE`；Spike DPAPI 环境门禁跳过。此处保留非零结果，没有弱化测试、修改 ACL、关闭 sandbox 或把未执行断言记为通过。

随后补充生产 Electron 文件闭环测试（同一测试命令自动发现）：Main 原生选择结果夹具 → 正式 preload/IPC → 导入/移除引用/重新导入 → 修改原文件 → 实际 Pi 受控生成 → 文件面板 → 惰性文本预览 → 归属/任意路径拒绝和导入失败提示。模型仍为 SSE 夹具，只有系统 picker 返回值被模拟。宿主发布工具将运行最终完整测试；以该工具成功结果为交付门槛，本记录的受限 shell 结果不改写为 PASS。

| 用例 | 自动化覆盖 | 验收状态 |
|---|---|---|
| F01 输入输出闭环 | 实际 Pi 读托管附件文本并调用 platform_output；按正确 Run 列出并预览精确内容；旧文件排除 | 夹具 PASS；真实模型待补 |
| F02 源文件变化 | 导入后覆盖原文件，模型输入与输出保持原副本；复制中改变源拒绝提交 | PASS |
| F03 归属伪造 | token owner/会话/到期/重用，跨 app/conversation 的 ID、外来 run、额外 path 字段拒绝 | PASS |
| F04 路径替换 | 登记后替换为硬链接和父目录 junction，list/preview/open 拒绝；中文空格路径成功，ADS/DOS/尾随点拒绝 | PASS |
| F05 同名与配额 | 同名不同 ID，单文件/会话/总配额、并发预留、UTF-8/类型限制 | PASS |
| F06 登记准确 | 同 run/source/hash 幂等；源内容改变保留旧版本；不扫描旧文件；实际可信 Pi 显式声明、用户确认、外部路径拒绝 | PASS |
| F07 安全预览 | HTML/SVG/EXE/CMD/LNK/URL 不执行且外部打开拒绝；带脚本/远程图片的 Markdown 仅文本；PNG/JPEG策略、伪 PNG、预览限额 | 服务 PASS；Electron DOM 断言由宿主执行 |
| F08 故障补偿 | 复制/发布/提交边界注入 ENOSPC/数据库故障、取消、源变化；无可用半成品，重试成功；登记失败使受控工具报错 | PASS；未填满物理磁盘，故障明确为注入 |
| F09 文件变化 | 托管文件哈希变化、删除、类型不符；不返回陈旧哈希/内容，打开拒绝 | PASS |
| F10 删除边界 | 输入引用与副本分离；软删除附件不可用而保留产物；库存包含归档记录及崩溃残留；原始附件、外部结果保留 | PASS；回收站 UI/物理删除范围外 |

## 真实模型与人工验收

`npm.cmd run file:live` 返回 `MISSING_EXPLICIT_TEST_APP`，脱敏记录见 [file-live-validation.json](evidence/file-live-validation.json)。本次未得到明确测试数据目录与已发布测试 appId，没有搜索或挪用其他目录的凭据。

后续提供已配置凭据、权限为 controlled-files 且允许 write 的已发布测试应用，关闭其桌面后运行：

```powershell
npm.cmd run file:live -- --data-root=C:\explicit-test-data --app=<published-test-app-id>
```

入口在独立新会话导入随机文本 → 改变原文件 → 真实模型使用托管文本 → 调用受控输出工具 → 检查所属 Run、产物内容和哈希。只给该会话输出目录写权限，无外部目录权限；不重放旧运行，不接受命令行 Key。报告不含凭据、端点、完整 prompt、标记文本或绝对路径。

最终仍须完成：

- 前置真实模型 E01 流式成功、E05 双会话隔离、E06 精确恢复/回忆、E09 流式取消（沿用 `engine:live`）。
- C01 真实模型 UI 闭环及 C01–C10 人工验收；参考 [Chat 验收记录](chat-validation.md)，既有待办没有被夹具结果勾销。
- 本项至少一个真实模型文件流程，F01–F10 人工复核，尤其原生选择/取消、超配额、打开目录、显式外部应用及恶意预览。

所有条件满足并补充脱敏证据后才可最终验收/关闭。草稿交付、代码合并与验收通过是不同状态。
