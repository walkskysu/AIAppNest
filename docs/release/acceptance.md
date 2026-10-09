# 发布验收记录 — Refs #20

状态：内部候选开发；finalAcceptance=PENDING；draftRequired=true；publicRelease=false。未授权正式发布，未记录任何正式发行版本、时间或下载位置。

## 构建与验证

固定 Windows x64 / Node 24.19.0 / npm 11.17.0 / Electron 44.5.1 / Pi 0.73.1 / engine-v1 / policy-v1 / session 3 / schema 11。准确 SQLite 与 ABI、依赖完整性和包哈希由 `release-manifest.json`、`dependency-inventory.json`、`files.sha256.json`、`SHA256SUMS.txt` 输出。

`npm ci` → `node node_modules/electron/install.js` → `npm test`。完整测试包含候选包构建及包内门槛；独立重建可运行 `npm run release:candidate`。从已安装的锁定依赖构建，不拉取 latest，不遍历开发数据。Electron、Node、Pi/扩展与原生辅助程序使用普通可执行目录，不使用 asar。Node LICENSE 固定来自 [Node v24.19.0 源码标签](https://github.com/nodejs/node/blob/v24.19.0/LICENSE) 并随源码保留；Electron LICENSE/LICENSES.chromium.html 与依赖声明同包提供。ZIP 用锁定 Node 的 zlib 流式生成；实际安装器的 `--verify-payload` 只读校验内嵌 ZIP 哈希并逐文件解压读取，不安装、不写注册表。包内门槛失败时只保留暂存目录和 `package-gate.txt`，不会生成可安装候选包。

CI 在 PR/分支测试及 workflow_dispatch 中生成内部 artifact，不创建 GitHub Release。候选下载入口为对应 Actions run 的 `windows-internal-candidate` artifact（30 天保留期限），以实际成功的 run 为准。公开发布需独立受控操作，审批、证书主体、签名验证、时间与下载位置单独记录。

## 验收矩阵

2026-10-09 本地受限执行环境的完整测试初次结果为 249 项：231 通过、16 失败、2 跳过；其中 source map 清除缺陷已修复，随后 build + release 专项 13/13 通过，安装器 ZIP/损坏哈希检查 1/1 通过，服务基准 1/1 通过。其余桌面/DPAPI 失败分别记录为 Electron AppContainer ACL 启动限制和 CurrentUser DPAPI 不可用，未降低 sandbox 或修改环境权限。初次包内门槛为 Engine 20/20 通过、实际 Electron 包启动 1 项失败，因此该次暂存输出不构成候选安装包。提交时由宿主再次运行完整 `npm.cmd test`（包括实际包内测试和候选安装器构建）；最终结果应以 PR 的宿主检查和 CI artifact 中 `package-gate.txt` 为准，不用上述局部通过替代它。

[服务基准原始样本](evidence/service-benchmark.json)：100 应用，10 次预热后各 100 样本；列表 P95 11.96ms、提交受理 6.06ms、排队取消受理 3.96ms。测量包括同步服务和 SQLite 提交，不包括 IPC/渲染，也不代表运行中停止耗时。机器、数据与方法在 JSON 中；物理盘型号未核实，故最终 L09 仍 PENDING。1 万条记忆沿用并在全量测试中复核 [H10 原始基准](../technical/evidence/memory-candidates-benchmark.json)。热启动、真实 UI 反馈、默认并发 2 的进程/内存及空闲回收性能记录仍待验收机补齐；不能用模型首字或网络时延替代平台测量。

[保留的依赖审计证据](evidence/dependency-audit.json) 有 8 项 high（包含传递影响），正式发行前须处理；当前没有负责人风险接受结论。每次候选输出 `signing-report.json` 记录实际 exe/dll/node 与安装器 Authenticode 状态，上游二进制的签名不代表本产品已签名。当前组织签名验收始终 PENDING。

|编号|自动化证据/方法|最终状态与待补|
|---|---|---|
|L01|包内 Electron/sidecar/Pi 确定性夹具；PATH 无 Node/npm/Pi|PENDING：无开发依赖的干净 Windows 11 实际安装和真实 MVP|
|L02|包内 SQLite FTS5、DPAPI、Worker、Pi 加载|PENDING：干净机真实模型和原生依赖确认|
|L03|中文空格 fixture 数据目录|PENDING：中文/空格 Windows 用户名，中文安装目录，约定长路径范围实测；暂不承诺 >260 字符|
|L04|HKCU/LocalAppData 安装器，无提权代码|PENDING：标准账户双击安装、运行、升级|
|L05|版本目录不覆盖；数据根独立|PENDING：实际卸载保留、重装重新连接数据|
|L06|复制/迁移失败，事务各断点，Pi 不兼容，独占锁，匹配快照回退|PENDING：真实安装中断、物理文件占用、低空间卷与两版本回退演练|
|L07|npm test 全量既有回归|PENDING：前置真实模型/环境/人工验收全部补齐|
|L08|包路径禁用敏感文件，文件哈希，锁定依赖，UNSIGNED_INTERNAL_ONLY|PENDING：组织签名策略与证书，所有 exe/dll/安装器签名验证，安全审计告警处理，安全提示实测|
|L09|已有记忆基准与本次原始本地基准（见 evidence）|PENDING：约定硬件规模下热启动/提交/停止 UI、并发内存/进程与空闲回收，负责人接受结论|
|L10|安装器/ZIP/哈希/版本及许可证/安装恢复说明|PENDING：下载后复验、材料人工签收；不标正式发布|

每次实测记录日期、机器 CPU/RAM/存储、Windows build、账户类型、数据规模、命令、样本、模型类型、哈希、截图/日志（脱敏）、通过/失败/未执行。模拟测试用 AUTOMATED 或 INJECTED_FAULT 标识，实机用 REAL_ENVIRONMENT，人工用 MANUAL。

性能 P95 采用排序后索引 ceil(N*0.95)-1，报告原始样本与预热数量。初始目标：热启动约 2 秒，100 应用本地列表 P95<200ms，提交/停止接收反馈<200ms，1 万记忆检索 P95<300ms，流式合并 30–100ms。模型首字与网络时间单独记录。默认并发 2，记录 Electron/Service Host/Worker 进程数量与内存和空闲回收；未达标须修复或负责人明确接受，隔离、丢数据和重复执行缺陷不能说明放行。

## 继承的真实验收待补

- #19 B01–B11、新 Windows 账户、真实模型原始会话/产物恢复、凭据和授权重绑；[已有记录](../technical/data-validation.md)、[原始证据](../technical/evidence/data-windows-validation.json)。
- #17 实际睡眠/唤醒、受限物理磁盘卷、人工验收；[原始证据](../technical/evidence/recovery-windows-validation.json)。
- #18 真实模型、H01–H11 人工验收；[原始证据](../technical/evidence/memory-candidates-validation.json)。
- Engine/Chat/File/Memory 此前所有真实模型与人工项；参见 `docs/technical/*-validation.md`。PENDING、NEW_WINDOWS_ACCOUNT_PENDING、MISSING_EXPLICIT_TEST_APP 不阻挡本次开发和内部候选构建，但阻挡最终验收及正式发行。

## 签名与公开发行操作（未执行）

组织须选定受控 Windows 发布环境中的 Authenticode 证书（硬件/云签名优先）及 RFC3161 时间戳服务；秘密不进入仓库、包或日志。在签名环境使用 SignTool SHA256 签署平台 exe、所需 DLL 及最终安装器；先签负载、打包，再签安装器，重新生成哈希。逐个 `signtool verify /pa /all /v` 并用 `Get-AuthenticodeSignature` 保存主体、指纹、时间戳和验证结果。未提供身份与证书，当前流程不会尝试伪造或自动签名。正式通道构建/上传须另行实现并授权，当前 workflow 无正式发布步骤。

PR 保持草稿，统一 Refs #20；不自动关闭 Issue。全部门槛满足后才进行独立公开发布和最终关闭。
