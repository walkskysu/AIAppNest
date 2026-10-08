# 应用级手动记忆（Refs #16）

依据固定需求 v1.0 §2.3、§4.4、§9、§10、§11、§14。默认仅手动确认，不提取聊天、摘要、工具结果或知识文档。自动候选配置不触发任何写入。应用配置中的 enabled 控制检索，发布后仅新会话采用新配置；旧会话保持绑定版本。

## 写入和来源

`MemoryService` 是产品入口，`memories.list/save/update/disable/delete/used` 经 renderer、preload、Main、ServiceManager、Host 的类型化白名单传递。服务端每次验证应用存在、记忆归属及来源关系。消息保存仅接收 sourceMessageId，由服务端解析 conversationId/runId，拒绝不完整或非 user/assistant 消息。手工新增使用独立稳定 memoryId，来源字段为空；编辑不伪造来源消息。UI 必须确认内容，可在保存前修正。

长度 1–4000 字符；类型为 preference/fact/convention/term；优先级 0–100；有效期为可空 UTC 毫秒。明显 sk- Key、密码/API Key/secret/token 赋值、Bearer、私钥头、AWS/GitHub Key 模式会被拒绝，错误不回显内容，也不写入存储或日志。规则不是完整秘密检测器，界面明确提醒不要保存秘密。

迁移 9 追加 priority 和 run_memory_links.position，不修改已发布迁移。修改、停用、删除均追加不可变版本，BEGIN IMMEDIATE 内检查 expectedVersion；并发旧版本返回 VERSION_CONFLICT。删除产生 tombstone，不能通过 update 恢复。旧内容和来源保留供审计，UI 列表隐藏删除项，历史 Run 继续展示原 memoryId/version/content/hash，而非最新内容。

## 检索和预算

SQLite 查询首先限定服务端 Run 的 appId、最新版本、active 状态和有效期，再交给排序。不存在跨应用全库召回或独立异步索引；停用、删除、到期立即退出查询。未确认 candidate/conflict 不可检索。

关键词算法 v1：NFKC + 小写；拉丁字母/数字/下划线连续词；中文连续片段拆相邻双字，单字片段保留。按查询与内容关键词集合交集大小降序，随后 priority 降序、updatedAt 降序、ID 字典序升序。零交集不注入；固定优先级不会让无关记忆绕过相关性过滤。匹配是可复现的基础字面检索，不等同语义理解。

默认 maxItems=8、tokenBudget=1500，可在应用配置中调整。估算 `utf8-bytes-v1` 按每 UTF-8 字节一个 token，保守估算并可能少用实际可用预算；包括完整 JSON 来源标签、ID、版本、分隔符和说明。按排序逐条选择，整条放不下则跳过，不截断内容，继续考虑后续短条。

Worker 就绪后，受控 Pi 扩展的内部命令读取实际注册模型 contextWindow、maxTokens、当前系统提示和启用工具 schema，仅回传数值。扣除系统/工具 UTF-8 字节、4096 framing 安全余量、Pi 完整历史 JSON 字节、本轮用户与附件文本字节，以及显式 Skill 的保守展开余量。当前 ProviderRuntime 注册窗口沿用 8192；不假定远端模型拥有更大容量。最终预算取剩余空间与应用 tokenBudget 的较小值；剩余为零时不注入。预算探针失败使 Run 明确失败，不静默当作成功使用记忆。

## 发送边界和审计

排队只保存用户原文、附件关联及配置摘要，不选取或冻结记忆。调度器刷新执行配置，等待 Worker/预算探针完成后，在同步 SQLite 事务里再次解析 Run、筛选/复核最新有效记忆并保存 run_memory_links。事务完成后同一 JS 调用栈直接调用 Worker.prompt，中间没有 await。产品 Host 是单写入入口：删除若在此步骤前完成，不会发送；已交给 Worker 的请求无法撤回，之后删除仅影响未来检索。直接外部写 SQLite 不属于支持的产品并发入口。

注入为用户请求后的参考数据区块，每条包含稳定 ID、版本和 sourceMessageId，明确可被用户更正且不授予工具权限。不改系统角色，不把文本传成工具参数。已有 PolicyService 仍单独验证工具权限。平台 messages.content 只存用户原文；Pi 会话会保存包装后的上下文。

run_memory_links 保存顺序及单条精确注入文本 SHA-256；memory.prepared 保存总区块 hash、条数、估算消耗、实际预算及算法版本。原文通过同一 runId 的 user 消息关联；旧版本可重建原条目。UI 明确区分“发送前登记的参考版本”和模型实际使用：网络/模型失败时，有链接不代表模型已收到或采纳。检索、预算、审计落盘异常返回 MEMORY_PREPARATION_FAILED 并阻止本轮 prompt；事务失败不留下部分链接。

## 遗忘交互

管理页提供类型过滤、分页、确认新增/编辑、停用、删除及来源消息跳转。会话右侧可选择任意已加载 Run 查看其原版本。删除提示并提供“从新会话开始”；关联历史清理由后续数据管理提供。继续旧会话时，Pi 历史可能仍带入已删除内容；聊天、文件、旧版本和备份不会因删除一条记忆自动清除，不承诺全介质遗忘。
