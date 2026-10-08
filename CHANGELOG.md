# Changelog

本项目所有值得注意的变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-08

支撑 WorkBuddy 5.6.2 起的加密凭据，并补齐跨平台定位。

### 修复

- **支持加密凭据**。WorkBuddy 自 5.6.2 起把 `accessToken`/`refreshToken` 加密封存为 `{$wbEncrypted:1, envelope:"…"}`，此前插件只会明文解析，在较新的 App 上直接失败。现在会先分类文档形态，再对封套解密：通过 `ELECTRON_RUN_AS_NODE=1` 启动 App 可执行文件取得 at-rest 密钥，以 `sha256(secret)` 派生保护密钥，用 AES-256-GCM 打开封套（AAD 为 App 自身的 `WB-AAD` 认证上下文）。
- **不再依赖命名管道取密钥**。受限沙箱可能拒绝打开 `pipe` stdio 所需的命名管道，导致 `execFile` 在子进程启动前就以 EPERM 失败。改为让子进程自行写临时文件、所有 stdio 通道设为 `ignore`；管道方式保留为兜底。失败信息也从整段 Node 堆栈收敛为一行原因。

### 新增

- **macOS 可执行文件候选**。此前只探测 Windows，macOS 上凭据一旦加密便无路径可取密钥。现在按 `/Applications/WorkBuddy.app/Contents/MacOS/Electron`、其次 `~/Applications/…` 的顺序探测。Linux 明确无默认值——桌面版在该平台没有已验证的安装布局。
- `WORKBUDDY_ELECTRON_BIN` 环境变量，用于在自动定位失败时指定 App 可执行文件。
- `check.mjs` 会打印每个凭据候选的**磁盘形态**（`plaintext` / `encrypted` / `absent` / `unrecognized`），这是排查加密相关问题的第一手信息。

### 变更

- POSIX 路径改用 `path.posix` 拼接，其形状不再取决于代码运行在哪个平台。
- 可执行性检查改用 `accessSync(X_OK)`：POSIX 上计入有效权限，Windows 上退化为存在性检查。存在但不可执行的候选现在报「未找到」，而不是变成一个 spawn 错误。
- 无法解读的凭据文档会**如实报告**而不是静默跳过——桌面凭据文件是身份权威，跳过它会把别的账号当成当前账号。

## [0.1.0] - 2026-10-04

首个版本。

### 新增

- `workbuddy_search` 工具：搜索经 WorkBuddy 账号与积分计费，不消耗 DeepSeek 账号额度。
- 与内置 `web_search` 并存，互不影响。
- 凭据发现：Windows 依次探测 Local 与 Roaming AppData，macOS 探测 Application Support，Linux 先 config home 再 data home；可用 `WORKBUDDY_AUTH_FILE` 覆盖。
- 接受两种凭据文档布局：嵌套的 `{auth, account}` 形式与扁平形式。
- token 过期时快速失败并给出可操作提示，不做自动刷新。
- 插件自带 `cordis.patch.yml`，注册自动化，无需手写 profile patch 条目。

[0.2.0]: https://github.com/du460138504/dsh-workbuddy-search/releases/tag/v0.2.0
[0.1.0]: https://github.com/du460138504/dsh-workbuddy-search/releases/tag/v0.1.0
