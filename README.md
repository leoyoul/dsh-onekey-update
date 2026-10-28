# dsh-onekey-update 一键更新

DeepSeek Harness（`dsh`）插件：每次启动后检查**已下载且已启用**的插件有没有新版本，在界面右下角列出来，点一次「全部更新」就逐个升级到最新版，完成后提示重启。

界面是原生风格通知条：左侧 3px 状态竖条 + 徽标，配色全部取自 DSH 主题 token（`--dsw-alias-*`、`--dsw-radius-*`、`--dsw-shadow-*`），随主题明暗与品牌色变化，不写死颜色。四态（有更新 / 全最新 / 更新中 / 失败）共用一套结构，更新中用分段进度条，失败行标 ✗ 并给出 pnpm 关键错误。

更新执行是跨平台的：不依赖 `DeepSeek Harness.exe`，macOS / Windows / Linux 都用同一套官方 CLI 通道。

## 交互

- 启动约 8 秒后后台检查，不阻塞界面。
- 检查完一定给结论：有新版本时列出 `插件  当前版本 → 最新版本`，按钮 **全部更新 / 稍后提醒**；全部最新时也弹卡片，标题 **全部插件都是最新版**，说明检查了多少个、跳过了多少个，按钮 **重新检查 / 知道了**。
- 点「全部更新」：显示 `3/7  dsh-context  0.75.1 → 0.77.0` 的实时进度，逐条执行。
- 结束：标题给出 `成功 N、失败 M`，每行标 ✓ / ✗，失败行给出 pnpm 输出的关键一行；提示重启 DSH 生效。
- 部分失败不影响其余插件继续升级。

## 检查范围

profile `package.json` 的 `dependencies` ∩ 已启用（`dsh.profile.bundles` 或 `cordis.patch.yml`），并排除：

- 插件自身；
- 非 registry 依赖（`file:` / `link:` / `git:` / 本地路径）；
- 已在插件页停用的包（`.dsh-market/state.json`）；
- `node_modules` 里找不到、无法确定当前版本的包。

版本比较使用完整 semver（含预发布段），只列前向升级，不会降级。查询 `dist-tags.latest`，先问 `https://registry.npmjs.org`，失败再问 `https://registry.npmmirror.com`。

## 更新通道

逐条执行官方通道：

```sh
dsh plugin --profile <profile> add <name>@<version> --config.minimum-release-age=0
```

`dsh` 可执行文件按下列顺序解析，不依赖 `PATH`、不判断 `.exe` 后缀：

1. `<resources>/runtime/cli/bin/dsh`（应用自带的 CLI，macOS 已实测）；
2. `<resources>/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`，用 Electron 以 `ELECTRON_RUN_AS_NODE=1 --expose-internals` 方式调用；
3. `<resources>/app/dsh/...`（解包运行时的同位置）。

都不存在时报「找不到 DSH CLI」，卡片进入失败态，不会静默跳过。

`--config.minimum-release-age=0` 用于绕过 pnpm 的最小发布时长限制，否则刚发布的版本会被供应链策略拒绝。

## 安装

从 GitHub（推荐，任何平台）：

```sh
dsh plugin --profile desktop add git+https://github.com/leoyoul/dsh-onekey-update.git
```

本机开发时用链接安装：

```sh
dsh plugin --profile desktop add link:/Users/leoy/Documents/dsh-onekey-update
```

装完**完全退出并重开 DSH**，插件页会出现「一键更新」，右下角按检查结果出现卡片。

## 在 DSH「发现」页里安装

本仓库同时是一个 format-1 插件市场索引，任选一个地址，在 **插件 → 发现 → 添加索引源** 里粘贴：

- `https://leoyoul.github.io/dsh-onekey-update/market/index.json`（更新即时生效）
- `https://cdn.jsdelivr.net/gh/leoyoul/dsh-onekey-update@main/market/index.json`（CDN 兜底，缓存约 12 小时）

索引里的版本钉在具体 commit 上，安装走 `git+https://github.com/leoyoul/dsh-onekey-update.git#<commit>`。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_ONEKEY_UPDATE_DELAY_MS` | 启动后延时多久检查（默认 `8000`） |
| `DSH_ONEKEY_UPDATE_DISABLE=1` | 本次启动不检查、不显示卡片 |
| `DSH_PROFILE` | 覆盖 profile 名（默认 `desktop`） |
| `DSH_HOME` | 覆盖 `~/.dsh` |

## 状态与日志

- `~/.dsh/onekey-update/state.json`：最近一次检查与更新的结构化结果；
- `~/.dsh/onekey-update/onekey-update.log`：检查、逐条更新、错误记录。

宿主路由（同源）：`GET /onekey-update/status`、`POST /onekey-update/check|apply|dismiss`。

## 开发

```sh
npm run check   # node --check 三个源文件
npm test        # 版本比较、profile 扫描、registry 回退、汇总逻辑
```

检查逻辑 `lib/check.mjs` 是纯函数 + 只读 IO，可脱离 Electron 直接在 node 里跑：

```sh
node -e "import('./lib/check.mjs').then(async m => console.log(await m.checkAll(m.profileDirFor('desktop'))))"
```

## 已知边界

- 更新的是宿主正在运行的 `node_modules`，新版本要重启 DSH 才生效。
- 卡片不列 registry 的所有历史版本，只升到 `dist-tags.latest`。
- 安装在 `link:` 目录时没有构建步骤，改完源码重启 DSH 即生效。
