# Windows Pi Spike 测试记录与结论

测试日期：2026-10-02。需求基线：[固定 commit 的设计 v1](https://github.com/walkskysu/AIAppNest/blob/c6bdd1a6fdbb5b56486678d7169da8eb9b6f4dd7/docs/requirements/Windows_AI_App_Platform_Design_v1.md)。范围限于 Issue #1，不包含 UI、业务数据库、安装包或多 Agent。

**结论：BLOCKED，不能宣称阶段 0 验证通过，不能关闭 Issue 或推进依赖功能。** 已验证真实 Windows/Pi 进程的核心机制，但缺少真实模型测试凭据；DPAPI CurrentUser 在本次受限执行环境失败。交付为可审查的验证实现、已获得的证据、可执行的剩余验收入口。

## 实际运行结果

本次在 Windows 11 x64 / Node 24.19.0 / Pi 0.73.1 执行。详细机器配置、版本和依赖入口见 [兼容性清单](pi-runtime-compatibility.md)。机器身份、账户信息、环境值没有写入报告。

- `npm.cmd test`：24 项，23 通过，0 失败，1 项 DPAPI 明确 BLOCKED skip。
- `npm.cmd run spike:native`：DPAPI BLOCKED、SQLite PASS，程序退出码 2。
- `npm.cmd run spike:live`：MISSING_EXPLICIT_MODEL_CREDENTIAL，总门禁 BLOCKED，程序退出码 2；未发生真实模型调用。
- [复查后的回归证据](evidence/pi-windows-regression-recheck.json)：逐项 TAP 结论、lockfile 指纹、实际响应/事件先后、运行状态；不含消息内容或密钥。保留[初次 21 项记录](evidence/pi-windows-regression.json)用于对照。

复查增加了命令超时联动拒绝全部请求、abort 已接受但未结束时强制终止、最终流式消息与 get_messages 不一致的测试。仅在最终 assistant 的 stopReason 为 stop、会话末条消息与之完全一致且无模型/工具错误时才记 succeeded；length 截断和悬空 toolUse 记 failed。公共诊断入口不能绕过 run 的单任务锁提交 prompt。

第一次未对 DPAPI 环境错误分类时，回归是 16/17 通过、DPAPI 失败。保留该失败事实；后续拆开 SQLite/DPAPI 并增加锁定文件与正常关闭测试，只有明确的环境错误允许在回归里标记 skip，独立原生验收仍失败。不存在替代加密后伪报通过的处理。

测试使用真实 Pi RPC 子进程，确定性 provider 仅代替模型流。权限检查、工具执行、Skill 展开、会话序列化/恢复、Windows 进程清理都由实际引擎/系统执行；这不足以代表真实提供商推理、认证和流协议已通过。

## V01–V13 验证表

“部分通过”表示已取得机制证据但不满足该行完整验收，不能折算为 PASS。

| 编号 | 结果 | 本次证据与剩余工作 |
|---|---|---|
| V01 基础调用 | BLOCKED | 真实 CLI/RPC 与 fixture 回复通过；无真实模型凭据，尚未完成真实模型调用 |
| V02 特殊路径 | 部分通过 | 中文、空格、中文+空格分别启动、保存、按引擎返回路径恢复通过；真实模型路径场景待 live 重测 |
| V03 双应用并发 | 部分通过 | 两个 Worker 并行，角色/env/会话不同；互不含另一应用标记；跨会话恢复拒绝；真实模型待验 |
| V04 资源白名单 | PASS（限定配置） | cwd/workspace 植入 AGENTS、CLAUDE、.pi Skill/扩展、SYSTEM/APPEND 标记未加载；cwd 项目 settings 启动前拒绝。只能使用宿主私有 cwd |
| V05 JSONL 解析 | PASS | 遍历每个字节分块边界、逐字节 Unicode、多行/CRLF、响应乱序与事件交错；坏 JSON、坏 UTF-8、超长/截断拒绝 |
| V06 生命周期 | 部分通过 | 接受不完成、并发运行拒绝、handled 不启动、模型/工具失败、退出中断均有测试；无原生 agent_settled，限定配置采用 barrier+状态+消息。真实提供商错误待验 |
| V07 精确恢复 | 部分通过 | 实际 sessionFile 落盘，恢复前后消息完全一致、恢复无 agent/tool 事件、不重放已完成读工具，继续可读取唯一标记；真实模型回忆待验 |
| V08 异常恢复输入 | PASS（原型） | 缺文件、相对路径、目录、空/坏 header、跨会话、Windows 独占锁不可读均在启动前失败；未另做 Windows ACL 拒读场景 |
| V09 停止与回收 | 部分通过 | 实际长工具子进程 cooperative abort/超时 force 后消失；正常关闭与宿主 crash 清理进程树；无关进程仍存活。真实模型发起长工具待验 |
| V10 权限拒绝 | 部分通过 | 工具入口拒绝 denied_write，副作用文件不存在；越界/junction 拒读；所有内置文件/shell 名称及仅对话模式均无旁路；真实模型调用待验 |
| V11 同名 Skill | 部分通过 | 两 Worker 的 `/skill:identity` 分别展开 SKILL_A/B；真实模型按绑定内容回复待验 |
| V12 凭据隔离 | 部分通过 | 非敏感 key 标记只注入指定 Worker，环境白名单不继承其他 key/NODE_OPTIONS，全局 env 不变；公共日志只记录元数据。真实 key 调用及文件扫描待验 |
| V13 本地依赖 | BLOCKED | node:sqlite 基础读写通过；DPAPI CurrentUser Protect 返回 CryptographicException 0x80131430，保存/读取未完成 |

对应测试名都带 V 编号，可在 `test/protocol.test.mjs`、`test/windows.test.mjs` 和证据 JSON 中定位。真实模型流程在 `src/live.mjs`，本次只实测其缺配置失败分支；不得将尚未执行的成功分支描述成实测通过。

## 关键观察及调整

1. Pi 0.73.1 的 prompt 成功响应可以表示立即处理；没有可直接区分 handled 的数据字段，也没有原生 agent_settled。测试扩展通过专有通知确认自己的 handled 分支。未知“不启动”的成功响应会超时并退休 Worker，不被判为成功。
2. 禁用发现不等于禁用项目 settings。改用宿主私有 cwd，并禁止其中存在项目 settings；用户目录放在受控工具工作区。需要使用真实项目 cwd 的后续需求必须重新评估 SDK 自定义 resource/settings loader。
3. 不用 agent_end 单独判定成功。关闭重试/压缩/队列/异步跟进，随后执行 waitForIdle 扩展 barrier、查空闲状态及消息，结合模型/工具错误和取消。未来开启这些能力需新验收，不能沿用当前证明。
4. 精确恢复需要平台预检。只接收本会话目录中可读且 header 匹配的文件，再校验引擎实际路径。空文件、缺失文件不交给引擎猜测，不自行改写 Pi JSONL。
5. Job Object 在创建阶段接管 Worker，处理工具子进程；宿主异常退出无需依赖宿主运行清理代码。当前测试没有出现残留或无关进程被杀。
6. 权限接口足以阻止本次工具调用的副作用；但 read 工具仍有 realpath 检查和打开之间的 TOCTOU 窗口，测试用长工具不应进入正式应用。当前结论不含任意不可信扩展/脚本的 OS 沙箱。

## 失败复现与后续门禁

在 README 指定环境执行 `npm.cmd run spike:native`。本环境输出 `{"dpapi":"BLOCKED","sqlite":"PASS"}`；单独调用 helper Protect 的非敏感标记探测得到 `native-host-failed:CryptographicException:80131430`。当前只能确认受限令牌下失败，不能据此认定所有 Windows 用户环境失败。请在正常用户令牌、已加载用户 profile 的 Windows 11 上重测，记录 Protect→密文文件→Unprotect 的结果；失败时继续调查令牌/profile/DPAPI 条件。

真实模型验收需提供 provider、精确 model ID 和测试 key 的环境变量名；密钥通过本机凭据工具提供，绝不贴入 GitHub 或报告。按 [README](../../spikes/pi-windows/README.md) 执行 `spike:live`，核对 `.runs/live-*/report.json` 全部 V 条目和总门禁。保留失败报告，修正后创建新 run，不手改旧证据。

后续 Issue 02 及依赖能力的业务实现继续阻塞，直到：真实模型路径/双应用/Skill/恢复/权限/取消通过；DPAPI 正常用户令牌读写通过且实际注入调用成功；无残留子进程、恢复重放、通用工具旁路。正式打包另行补齐 .NET/helper 签名、Node 与 npm 组件许可证附件及实际产物核验。草稿 PR 仅用于审查验证实现，不代表 Spike 完成。
