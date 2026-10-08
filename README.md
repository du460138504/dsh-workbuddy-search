# DSH WorkBuddy Search

给 DeepSeek Harness 加一个 **`workbuddy_search`** 工具：搜索走 WorkBuddy 的账号和积分，**不消耗 DeepSeek 账号的任何额度**。

配合 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) 使用：模型切到 WorkBuddy 之后，搜索也一并走 WorkBuddy，不再需要 `DEEPSEEK_API_KEY`。

## 它解决什么问题

DSH 内置的 `web_search` 走 `web-search-deepseek`，需要 DeepSeek 的 API key 或账号登录态。当你把模型换成 WorkBuddy（`provider: workbuddy`）时，内置搜索会因为找不到 DeepSeek 凭据而直接报错：

```
DeepSeek search has no API key for "DEEPSEEK_API_KEY"
```

本插件复用 WorkBuddy 桌面 App 已经登录的凭据，直接调用 WorkBuddy 的搜索接口，绕开这个问题。

## 与内置 `web_search` 并存

**两者互不影响。** 内置的仍然走 DSH 的 `ctx.web` seam；本插件固定走 WorkBuddy 上游。模型可以按调用选择，也可以两个都用。

## 安装

**前置条件（缺一不可）**：

1. **DSH `0.2.0-rc.2` 内核**。本插件锁定了该版本的内核 API——见下方「版本要求」。
2. **WorkBuddy 桌面 App 已安装并登录**。插件复用它的登录态，不启动独立的 OAuth。

```sh
# Desktop 版
dsh plugin --profile desktop add github:du460138504/dsh-workbuddy-search
dsh --profile desktop

# Web 版
dsh plugin --profile web add github:du460138504/dsh-workbuddy-search
dsh web
```

插件自带 `cordis.patch.yml`，`dsh.bundle.patch` 指向它，注册是自动的——**不需要手写 profile 的 patch 条目**。

安装后**重启 DSH**，工具列表里出现 `workbuddy_search` 即成功。

### 版本要求

`package.json` 声明了 `"@deepseek-ai/dsh-tools": "0.2.0-rc.2"`。DSH 在安装时会做兼容性校验：**内核版本不匹配会被直接拒绝**，并给出类似提示：

```
Plugin dsh-workbuddy-search@0.1.0 is incompatible with dsh <version>:
peerDependencies {"@deepseek-ai/dsh-tools":"0.2.0-rc.2"}.
```

这是**刻意**的：DSH 内核 API 在 rc 阶段仍可能变动，放宽范围会导致装上后崩溃。若你确认风险并要强制安装：

```sh
dsh plugin allow-version dsh-workbuddy-search@0.1.0
```

内核 `0.3.x` 及以上需要本插件相应更新，不要用豁免硬装。

### 从源码安装

```sh
git clone https://github.com/du460138504/dsh-workbuddy-search
dsh plugin --profile desktop add link:/path/to/dsh-workbuddy-search
```

`link:` 方式下改动源码即时可见（仍需重启 DSH 重新加载）。

### 验证是否装好

不经过 DSH 的独立自检：

```sh
node check.mjs
```

它会打印凭据路径、账号、token 是否过期、API 基址，并发起一次真实搜索。**如果这一步就失败，插件在 DSH 里也不会工作**——这是排错的第一站。

## 前置条件

**必须安装并登录 WorkBuddy 桌面 App。** 插件读取它的凭据文件：

| 平台 | 路径 |
|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |
| Windows（旧版） | `%APPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |
| Linux | `$XDG_CONFIG_HOME/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |

Windows 下先探 `Local` 再探 `Roaming`；Linux 下先探 config home 再探 data home（UOS/deepin 写在后者）。

可以用环境变量 `WORKBUDDY_AUTH_FILE` 指定其它位置。插件**只读**该文件，不写入、不改动 App 的登录状态。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 装不上，提示 incompatible | 内核版本不是 `0.2.0-rc.2` | 升级/降级 DSH，或用 `dsh plugin allow-version` 显式豁免 |
| 工具列表里没有 `workbuddy_search` | 插件没加载成功 | 看 DSH 的插件面板是否有「异常」标记；重启 DSH |
| 调用报「No WorkBuddy credential found」 | 没装或没登录 WorkBuddy App | 打开 App 登录；或用 `WORKBUDDY_AUTH_FILE` 指定凭据路径 |
| 调用报「access token has expired」 | 登录态过期 | 在 WorkBuddy App 里重新登录 |
| 调用报 401/403 | 凭据被服务端拒绝 | 同上，重新登录 |
| 插件卡片显示「异常」 | `apply()` 抛错 | 多为内核 API 不匹配，检查版本要求 |

若插件面板出现异常，可直接跑 `node check.mjs` 区分是「凭据/网络问题」还是「插件加载问题」。

## 用法

模型会自己调用，你也可以显式要求。参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `queries` | `string[]` | 1–4 个搜索词，结果合并 |

返回一个 markdown 列表，每条含标题、URL 和摘要。

## 计费

搜索请求走 WorkBuddy 的 agent-tool 接口，用你的 WorkBuddy access token 鉴权，**扣 WorkBuddy 积分**。DeepSeek 账号完全不参与。

## Token 过期怎么办

插件的策略是**快速失败**：token 过期时工具会返回一条明确错误，提示你打开 WorkBuddy 桌面 App 重新登录。它不会尝试自动 refresh。

如果服务器返回 401/403，也会给出同样的提示。

## 已知限制

- 依赖 WorkBuddy 客户端接口（非官方开放 API），WorkBuddy 更新后插件可能需要随之调整。
- 只支持**国内版 WorkBuddy**。国际版（WorkBuddy AI）的接口未验证。
- 不做自动 token 刷新，过期后需重新登录桌面 App。
- 上游支持的 `blocked_domains` / `freshness` 等参数暂未暴露。
- 仅在 Windows 的 DSH Desktop 上实测通过；其它平台按同样的凭据路径约定实现，欢迎反馈实测结果。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与腾讯、WorkBuddy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）— 凭据发现与 DSH provider 注册的参照实现。
- [du460138504/dsh-dual-balance](https://github.com/du460138504/dsh-dual-balance)（MIT）— DSH 插件包结构参照。

## 许可证

[MIT](./LICENSE)

## 开发

```sh
git clone https://github.com/du460138504/dsh-workbuddy-search
cd dsh-workbuddy-search

# 独立自检：不经过 DSH，直接读凭据并对真实端点发一次请求
node check.mjs
```

`check.mjs` 会打印凭据路径、账号、token 是否过期、API 基址，并发起一次真实搜索。用来快速确认 token 和网络都正常。

改动源码后，profile 里的 `link:` 依赖会让 DSH 直接读到新代码，但**需要重启 DSH** 才会重新加载插件。

## 许可证

[MIT](./LICENSE)
