# FileService：附件、产物与安全预览

Refs #15。实现基于固定需求 v1.0 §4.3–4.5、§6.1、§10、§11、§13。

## 托管输入

Main 原生文件选择器是外部路径的唯一入口。Renderer 仅收到 token、显示名和过期时间；令牌绑定 Main 文档 generation、appId、conversationId，5 分钟有效，一次消费，最多 64 个。刷新后旧 owner 无法消费。选择器取消不创建文件；导入期间可取消。

首版允许 UTF-8（可带 BOM）`.txt/.md/.csv/.json/.log/.yaml/.yml`，拒绝无效 UTF-8/NUL 和其他附件类型。单附件 256 KiB；输入区最多 3 个，完整 prompt 仍受调度器 1 MiB 限制。图片、Office、二进制附件的模型输入不在此版本支持范围；不会把图片伪装为文本发送。

源文件须为本地常规文件，禁止 UNC、设备路径、ADS、DOS 别名、尾随点/空格、父级穿越、symlink/junction、硬链接。读取前后核对文件句柄与路径的 dev/ino/size/mtime/ctime。复制至随机 ID 的 `.partial`，校验 UTF-8、计算 SHA-256、flush 后发布，再在事务中登记 `attachments`。普通异常、取消、源变化、磁盘/数据库故障清除暂存及已发布但未登记副本。不会删除或改写用户源文件。同名文件使用不同 ID，不覆盖。

Migration 8 新建 `attachments`、`run_attachments`，保留既有 artifacts 归属外键，附加显示名与登记来源哈希。附件、产物和运行附件关联行不可变；显示名不参与内部路径构造。调度器从附件表重新检查归属、存在性与内容完整性，将**托管副本的文本**纳入入队 prompt 快照，事务内关联 attachmentId；不再把 artifactId 当作附件。输入引用移除只修改当前输入区，已提交快照不受影响。任务执行前再次检查权限和附件完整性，异常时取消排队任务。

附件与产物共享会话 64 MiB、总计 512 MiB、单会话 1000 条上限；单产物 16 MiB。配额包含已归档记录，异步导入有预留额度，避免并发超卖。删除引用不释放配额。当前不提供物理删除或可配置放宽限额。

## 可信产物来源

- `platform_write/platform_output` 实际写入和 flush 成功、复核授权及路径后，调用内部 `FileService.registerOutput`。服务生成属于 app/conversation/run 的独立托管副本并记录 MIME、大小、哈希、时间和显示名，追加 `artifact.registered` 事件。登记失败作为工具错误返回，调度器不会把有工具错误的任务判为成功；已发生的外部写入不声称回滚。
- 外部授权目录和工作区中的结果统一**复制入产物目录**，不登记原文件路径，不移动源文件。原文件之后变化不会修改历史产物。
- 同一 run + 真实源路径的 SHA-256 + 内容 SHA-256 重复登记幂等，先复核已有副本；内容改变生成新 ID，旧版本保留。不同 Run 分别归属。
- 可信自动化采用**显式声明**，工具名 `platform_register_output`，参数仅为相对工作区路径。服务绑定当前 Run、固定版本与显式可信授权；每次声明展示路径并要求用户确认，确认后再次检查真实路径并复制。只允许该会话 workspace 内的普通文件。Shell/脚本/原生 write/edit 未声明的结果不会自动成为产物；可信模式在工作区之外的文件需先由可信代码复制进工作区再声明。本实现不做目录扫尾差异识别、不推测“本轮生成”、不证明模型对声明文件的原创性。
- UI 提供产物目录写入授权，调度器向模型传递服务校验过的 grantId/resource/access，模型无需依赖用户手填内部 ID。模型提供的路径仍必须通过 PolicyService，能力提示不替代授权。

## 预览与显式打开

`window.desktop.files` 仅暴露 `attachments.import/cancel` 和 `artifacts.list/preview/open`；Main 私有 `select` 不在 Renderer schema。没有任意 readFile。读取、预览、打开均重新核对 app/conversation/run 归属、生成路径、每级链接、句柄身份、存在性、大小和 SHA-256。缺失/改变/越界/内容类型不符分别反馈，无法验证时不返回旧哈希或旧内容。列表按会话或 Run 分页；软删除会话的附件不可再读取/导入/提交，产物按既有“保留产物”语义仍允许 ID 归属范围内访问，后续回收区 UI 可复用该接口。

文本预览最多 256 KiB，Vue `pre` 文本节点渲染；Markdown 不解析 HTML、链接或图片。PNG/JPEG 最多 2 MiB，校验栅格签名和最多 1600 万像素的尺寸后返回固定 MIME 的 base64 数据。CSP 仅为图片增加 `data:`，没有网络、iframe、object、HTML 或 SVG 文档加载。格式解析仍交给 Chromium 图像解码器，损坏图片可显示解码失败，不执行脚本。

HTML、SVG、脚本、快捷方式和可执行文件可登记为元数据，但没有内嵌执行或外部打开权限。外部打开只允许显式用户动作，当前白名单为纯文本/CSV（统一 `.txt`）、PNG、JPEG；打开前复核内容，复制至 `cache/file-open/<id>-<hash>.<固定扩展名>`。重复打开复用且验证缓存，缓存篡改拒绝打开。Renderer 永远收不到 OS 打开路径。哈希只表明内容一致，不代表文件可信。打开所在目录调用 Main 的 `showItemInFolder`，不启动文件。

## 生命周期与限制

`Storage.managedFiles()` 枚举附件/产物与归档状态，`fileContainers()` 和内部 `FileService.inventory()` 同时枚举受管目录中未登记输出、`.partial` 崩溃残留及外部打开缓存，供后续备份/回收实现使用；不沿链接遍历，不删除任何文件。软删除只更新元数据。缓存是可重建副本；备份可以排除缓存及未提交暂存。崩溃在文件发布与 SQLite 提交之间可能留下孤立副本，当前只枚举、不自动清理或当作成功产物。

操作入口和打开句柄都校验路径，但这里不提供针对同一 Windows 账户恶意并发替换的内核隔离/完全 TOCTOU 保证。`shell.openPath` 到外部应用再次读取路径之间仍有 OS 边界；可信自动化也不是 Windows 安全沙箱。所有边界与现有 PolicyService 保持一致，不修改系统权限或关闭 Electron sandbox。
