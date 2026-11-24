# Paseo 个人 Fork 维护与发布指南

本仓库 (`Laokashouji/paseo`) 通过 **Jujutsu (`jj`) + Mergiraf + 独立 GitHub Actions 发布流水线** 在跟随上游 `getpaseo/paseo` 演进的同时，独立维护个人增强能力，并支持 macOS Apple Silicon 正式签名、公证与应用内自动更新。

## 1. 设计原则与分支拓扑

- **零侵入上游文件**：所有 fork 基础设施文件全部放在新增路径（`.github/workflows/fork-release.yml`、`scripts/fork/*`、`FORK.md`），不修改任何上游已有文件，确保 `fork-infra` 永远零冲突 rebase。
- **双工具减冲突**：
  - `jj`（Jujutsu）采用 colocated 模式管理 patch stack / Mega-Merge，支持冲突一等公民存储、`jj undo` 一键回滚、自动维护 `trunk()`（固定指向 `main@upstream`）。
  - `mergiraf` 作为语法感知三方合并驱动，已配置在本地 `.git/info/attributes`（不污染 tracked `.gitattributes`）且被 `jj resolve --tool mergiraf` 原生调用，大幅减少 import/JSON/TS 结构性冲突。
- **推荐分支 / Bookmark 结构（Mega-Merge 模式）**：

```text
main@upstream (trunk)
  ├── fork-infra     # fork 发布与同步脚手架（纯新增文件，永不冲突）
  ├── feat/feature-a # 个人功能 A（直接基于 upstream，随时可单独向上游提 PR）
  └── feat/feature-b # 个人功能 B
        \  |  /
         fork        # 合并分支（实际发布与日常使用的集成点）
```

- `origin/main` 保持为干净的上游镜像，不提交个人改动；所有 fork 发布均通过 `fork` 分支与 `fork-v*` 标签触发。
- **版本号编码**：采用 `X.Y.(501..999)`（每个上游 `X.Y` 小版本内从 `501` 起单调递增，例如上游 `0.17.0-beta.1` 第 1 次发布为 `0.17.501`，第 2 次为 `0.17.502`）：
  - 满足上游 `packages/app/native-release-version.js` 对 `minor <= 999 && patch <= 999` 的限制，确保 monorepo 所有包（含 Expo web bundle、Desktop、内置 Daemon）使用完全一致的版本号；
  - 属于合法的稳定 SemVer（无 prerelease 后缀），直接兼容 Paseo Desktop 默认 `stable` (`latest`) 自动更新通道与插件版本校验；
  - 跨 fork 重建与跨上游小/中/大版本更新严格单调递增；
  - Git 标签使用 `fork-v0.17.501`（不以 `v` 开头），避免误触发上游 `v*` 工作流，且已验证兼容 `electron-updater@6.8.3` 的 `GitHubProvider`。

## 2. 一次性初始化（Apple Developer 签名与公证）

### 步骤 A：在 Mac 上准备 Developer ID 证书与公证凭据

1. **Developer ID Application 代码签名证书**（必须由 Account Holder 在 [developer.apple.com/account](https://developer.apple.com/account) 创建）：
   - 创建或下载 **Developer ID Application** 证书，配对对应私钥打包为 `.p12`（或在钥匙串访问的「我的证书」中右键导出为 `.p12` 并设置导出密码）。
2. **公证凭据（二选一，推荐方式 1）**：
   - **方式 1（App Store Connect API Key，推荐）**：在 App Store Connect → 用户和访问 → 集成 → App Store Connect API 生成密钥（`App Manager` / `Developer` / `Admin` 均可），保存 `.p8` 文件、Key ID 与 Issuer ID。
   - **方式 2（Apple ID + App 专用密码）**：记录 10 位 Team ID，并在 [account.apple.com](https://account.apple.com) → 登录与安全 → App 专用密码生成专用密码。

### 步骤 B：上传 GitHub Secrets

```bash
# 推荐：Developer ID .p12 + App Store Connect API Key (.p8)
./scripts/fork/setup-apple-secrets.sh \
  --p12 /path/to/DeveloperIDApplication.p12 \
  --p8 /path/to/AuthKey_XXXXXXXXXX.p8 \
  --key-id XXXXXXXXXX \
  --issuer xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

或在 GitHub 网页端 `Settings -> Secrets and variables -> Actions` 手动添加以下 Secret：

| 类别                 | Secret 名称                                     | 内容                                                                              |
| -------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| 签名（必填）         | `APPLE_CERTIFICATE`                             | Developer ID Application `.p12` 单行 base64（`base64 -i cert.p12 \| tr -d '\n'`） |
| 签名（必填）         | `APPLE_CERTIFICATE_PASSWORD`                    | `.p12` 导出密码                                                                   |
| 公证（方式 1，推荐） | `APPLE_API_KEY`                                 | App Store Connect `.p8` 私钥（支持单行 base64 或原始 PEM）                        |
| 公证（方式 1，推荐） | `APPLE_API_KEY_ID`                              | API Key ID（10 位字符）                                                           |
| 公证（方式 1，推荐） | `APPLE_API_ISSUER`                              | API Issuer ID（UUID）                                                             |
| 公证（方式 2，备选） | `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Apple ID 邮箱、App 专用密码与 10 位 Team ID                                       |

检查配置状态：

```bash
./scripts/fork/setup-apple-secrets.sh --check
```

### 步骤 C：启用 Fork Actions 并关闭上游无关工作流

1. 如果尚未在 fork 仓库启用 Actions，打开 `https://github.com/Laokashouji/paseo/actions` 点击启用。
2. 推送 `fork` 分支后，可执行以下命令关闭继承自上游、但在 fork 中无需运行的工作流（无需改动任何上游 YAML 文件）：

```bash
./scripts/fork/setup-apple-secrets.sh --disable-upstream-workflows
```

## 3. 日常开发与同步流程

### 新增个人功能分支并合入 `fork`

```bash
# 1. 直接基于上游主干开发新特性（干净独立，随时可向上游提 PR）
jj new trunk() -m "feat(fork): 你的功能描述"
jj bookmark create feat/my-feature -r @
# ... 编写代码并测试 ...

# 2. 把新特性合入 fork（首次添加功能时创建 Mega-Merge，之后用 jj rebase 追加父提交）
jj new fork-infra feat/my-feature -m "merge(fork): 集成个人增强特性"
jj bookmark set fork -r @
```

当上游已合入某个特性、你想从 fork 移除它时：

```bash
jj rebase -s fork -d fork-infra -d feat/other-feature
jj bookmark delete feat/my-feature
```

### 同步上游最新代码

```bash
# 同步到最新 upstream/main，并用 mergiraf 自动尝试解决语法冲突
./scripts/fork/sync.sh --auto-resolve

# 或固定对齐某个上游稳定 tag（例如 v0.16.2）
./scripts/fork/sync.sh --base v0.16.2 --auto-resolve

# 若对结果不满意，随时一键撤销整个 rebase
jj undo
```

如果存在无法自动合并的语义冲突：

```bash
jj edit <change_id>
jj resolve --tool mergiraf   # 或手工编辑冲突文件
jj st                        # 确认冲突清空后继续
```

## 4. 发布 macOS Desktop 与自动更新

```bash
# 1. 先做 dry-run，核对目标 commit、自动计算的版本号与 Apple Secrets 状态
./scripts/fork/release.sh

# 2. 确认无误后推送 fork 分支与 fork-v* 标签，触发 GitHub Actions 自动签名、公证并发布
./scripts/fork/release.sh --push

# 3. 观察构建进度
gh run watch --repo Laokashouji/paseo
```

- **首次切换安装（仅需一次）**：因为你的 Apple Developer Team ID 与官方不同，官方签名包无法直接热更新到你的 fork。首次请从 `https://github.com/Laokashouji/paseo/releases/latest` 下载 `Paseo-<version>-arm64.dmg`，直接覆盖安装为 `/Applications/Paseo.app`（`~/.paseo/` 与 `~/Library/Application Support/Paseo/` 下的会话和配置全部保留）。**请勿在 `/Applications/` 下通过改名（如 `Paseo Fork.app`）与官方版双存**：两者共用同一个 `CFBundleIdentifier`（`sh.paseo.desktop`）与单实例锁，并存时 macOS 通知中心会按版本号高者拉起另一份应用并触发 `second-instance` 莫名弹新窗口；如需临时切回官方版，直接下载官方 DMG 覆盖回来即可。
- **应用图标区分**：构建流水线会在打包前通过 `scripts/fork/apply-icon.sh` 临时将 `packages/desktop/assets/icon.icns` 与 `icon.png` 替换为仓库内置的蓝图蓝版 `icon-dev.png`（不改动上游跟踪文件），每次自动更新都会保持蓝色图标，便于与官方黑色图标直观区分。
- **更新公告与 Release 联动**：仓库根目录的 `FORK_CHANGELOG.md` 独立记录 Fork 变更（不修改上游 `CHANGELOG.md`，零合并冲突）。桌面端在打包时自动注入 `EXPO_PUBLIC_FORK_CHANGELOG_URL` 与 `EXPO_PUBLIC_CHANGELOG_WEB_URL`，应用内「新功能 / 更新内容」弹窗会并发拉取 `FORK_CHANGELOG.md` 与上游 `CHANGELOG.md` 按发布日期倒序混排展示（同天 Fork 置顶并带 `Fork` 徽章）；`release.sh` 会在发版前校验并预览对应版本条目，CI 也会将同一份内容同步写入 GitHub Release 说明。
- **后续所有更新**：`Paseo.app` 内的 `app-update.yml` 已自动指向 `Laokashouji/paseo`，且 `rolloutHours` 为 `0`（即时生效）。每次发版完成后，MacBook / Mac mini 上的 Paseo Desktop 都会直接检测到新版本并在应用内一键自动更新（原地替换 `/Applications/Paseo.app`）。

## 5. 更新 Linux DevBox CLI / Daemon

如果本次改动仅涉及前端 UI（`packages/app`、`packages/desktop`），DevBox 无需更新；如果涉及服务端、插件或协议（`packages/server`、`packages/cli`、`packages/protocol`）：

```bash
# 仅构建并安装并存命令 ~/.local/bin/paseo-fork（不影响线上官方 paseo）
./scripts/fork/install-local-cli.sh

# 切换默认 ~/.local/bin/paseo 指向 fork 构建（自动备份原官方路径）
./scripts/fork/install-local-cli.sh --switch-default
paseo daemon restart

# 随时一键切回官方 npm 安装版
./scripts/fork/install-local-cli.sh --restore-official
paseo daemon restart
```

## 6. 飞书工程文档与同步维护规范

面向人阅读的工程全貌、能力对比、架构图与实机界面说明沉淀在飞书个人知识库（`my_library`，空间 ID `7643648852146343133`）→ `AI / 工具 / Paseo`（父节点 `VMKSwgYGFiqAgNkmjLscW2JQnMc`）下。仓库内文档（`FORK.md`、`CLAUDE.local.md`、`FORK_CHANGELOG.md`）负责面向开发与 AI 的硬规则、精确命令与发版公告；飞书文档负责动机、能力体验、架构图与演进脉络，两者不互相大段拷贝。

### 文档与分支映射表（SSOT）

| 类别 | 飞书文档 | 绑定分支 / 目录 | Wiki `node_token` | `doc_id` |
| --- | --- | --- | --- | --- |
| 主文档 | [Paseo Fork — 工程总览](https://bytedance.larkoffice.com/wiki/Nq50wJhwkiRz2gkpNbDcwrjunnb) | 全局（`fork`） | `Nq50wJhwkiRz2gkpNbDcwrjunnb` | `Y5wsdWF18olzKzxEonVcv1qsnXg` |
| 速览 A0 | [【速览】Paseo Fork 新增与修改能力汇总（实机红框图解）](https://bytedance.larkoffice.com/wiki/RDt9wdTcEiAFuZk6jCfc6VRhnNg) | 新人速览（全量 `fork` 能力） | `RDt9wdTcEiAFuZk6jCfc6VRhnNg` | `U3FidWxwFoIK5Rxim9pcUTaVndd` |
| 能力 A2 | [【能力】原生无损分叉与分支管理](https://bytedance.larkoffice.com/wiki/BOsFwD4vFiRThrkqDJfcI7WPnib) | `feat/native-fork-and-branches` | `BOsFwD4vFiRThrkqDJfcI7WPnib` | `Ah7Kdn8tQobNzLxxXXmcMDuFnUc` |
| 能力 A3 | [【能力】原生 `/btw` 旁路提问](https://bytedance.larkoffice.com/wiki/H2TBwgRevixWU0kN1O4ckgERnpd) | `feat/native-btw-side-question` | `H2TBwgRevixWU0kN1O4ckgERnpd` | `Symyd2lpDo0Z1Hx2n6xcoC85nAb` |
| 能力 A4 | [【能力】插件扩展底座增强](https://bytedance.larkoffice.com/wiki/AfVfwyvXbi9YTakQlijcuZ8anbd) | `closeAgentTab`、`buildForkContext` | `AfVfwyvXbi9YTakQlijcuZ8anbd` | `MkT8dxyLxoLbuzxiivXcLOSMnIc` |
| 能力 A5 | [【能力】一键对话归档（Session Archive）](https://bytedance.larkoffice.com/wiki/MGm8wtnd5is5SqkAt7bcci5Jntd) | `feat/session-archive` | `MGm8wtnd5is5SqkAt7bcci5Jntd` | `LQd3dhXgvoqdQIxGEVZcc40tnxh` |
| 能力 A6 | [【能力】输入框 Markdown 实时语法样式与用户消息渲染](https://bytedance.larkoffice.com/wiki/XTqSwA5vXiswJ3kMTwTcsq3qnIe) | `feat/composer-markdown` | `XTqSwA5vXiswJ3kMTwTcsq3qnIe` | `D7NvdEldbolDPCxn3h2cZ15anPf` |
| 能力 A7 | [【能力】双源更新公告（Fork + 上游混排）与发版联动](https://bytedance.larkoffice.com/wiki/EpHzwpv9EiI29tkVjmOcTYiAn4g) | `feat/fork-changelog`、`FORK_CHANGELOG.md` | `EpHzwpv9EiI29tkVjmOcTYiAn4g` | `XAm3dHuHhoDJKZx3HMGcTW29n3b` |
| 能力 A8 | [【能力】原生主对话（Main Chat）](https://bytedance.larkoffice.com/wiki/CKnOwMZ4Ai9cGOkAFH0cOoIXnnh) | `feat/main-chat` | `CKnOwMZ4Ai9cGOkAFH0cOoIXnnh` | `OSZTdPGEDo8bLBx1xS3cUjZNnsf` |
| 能力 A9 | [【能力】侧边栏导航区高度调节与溢出二级菜单](https://bytedance.larkoffice.com/wiki/VD1Nw6iMoiehUUkC316cZzyDnYc) | `feat/sidebar-nav-overflow` | `VD1Nw6iMoiehUUkC316cZzyDnYc` | `XtTRdcdoXoY4JPxw8xIcYlN0nyb` |
| 工程 B1 | [【工程】Fork 架构与上游同步机制](https://bytedance.larkoffice.com/wiki/DlKSwCe61iiBtGkI2ygcdpg9nJg) | `fork-infra`、`FORK.md` | `DlKSwCe61iiBtGkI2ygcdpg9nJg` | `O6IIdIOBEoDCwzxE1cvceaXZnuy` |
| 指南 B2 | [【指南】多端安装、使用与自动更新](https://bytedance.larkoffice.com/wiki/PCvMwImbPiyni9k5cWkc1I1Lnre) | `scripts/fork/*`、`.github/workflows/fork-release.yml` | `PCvMwImbPiyni9k5cWkc1I1Lnre` | `GBnAduH1lonWvVxZYDhcBdUknTg` |
| 演进 B3 | [【演进】版本记录、路线图与文档维护规范](https://bytedance.larkoffice.com/wiki/SnOUwoR0miYuYVkt5ENcPU3Ynnd) | `fork-v*` 标签、`FORK_CHANGELOG.md`、路线图 | `SnOUwoR0miYuYVkt5ENcPU3Ynnd` | `VL42dzHpAor2OyxY4rdcd2cInwx` |

### AI 同步维护规范（新增 / 修改 / 删除）

> **执行时机**：仅在未合入的 `feat/*` 分支开发调试时，不提前建正式能力子文档（可按需记入 B3 路线图）。一旦将新特性合入 `fork`、修改已合入能力/工程脚本、发布 `fork-v*` 或从 `fork` 移除/摘除特性，除非用户明确限定“仅改代码不动文档”，否则应作为收尾动作同步维护对应飞书文档，并在答复中写明同步结果。

1. **什么时候需要新增文档**
   - 当新的独立 `feat/*` 特性分支合入 `fork`（且不属于已有能力子文档的小增量）时，在主文档节点 `Nq50wJhwkiRz2gkpNbDcwrjunnb` 下通过 `lark-cli docs +create --as user --doc-format xml --parent-token Nq50wJhwkiRz2gkpNbDcwrjunnb --content @<draft.xml>` 新建 `【能力】...` 子文档。
   - 同步在 **主文档差异全景表**、**B3 文档映射表** 以及本节 **映射表** 补齐新文档链接、`node_token` 与 `doc_id`（若同时合入 `fork-infra`，一并推进 `fork`）。
2. **什么时候需要修改文档**
   - 改动已有能力的交互界面、状态机、Provider 支持范围、配置项或 Fork 工程脚本时，按映射表找到对应 `doc_id`，局部更新受影响章节；界面交互或核心架构有可见变化时，同步重截脱敏 2× 实机图或更新画板。
   - 发布 `fork-v*` 新版或执行 `sync.sh` 升级上游基线版本时，在 B3「已发布版本演进」追加版本行，并更新主文档与受影响子文档顶部的同步基线和日期。
   - **增量编辑红线**：更新已有飞书文档必须先 `lark-cli docs +fetch --as user --doc <doc_id> --detail with-ids` 定位目标 block，再执行局部 `block_replace` / `block_insert_after` / `block_delete`；**禁止全文 `overwrite`**，以免丢失评论上下文、内嵌图或画板排版。
3. **什么时候需要删除或归档文档**
   - 当某个特性从 `fork` 彻底移除，或已被上游 `getpaseo/paseo` 吸收并从 `fork` 父集摘除时，先向用户确认删除还是保留归档（删除属于不可逆 `high-risk-write`，未经确认不得执行）：
     - 确认删除：执行 `lark-cli wiki +node-delete --node-token <node_token> --obj-type wiki --as user --yes` 删除对应子文档；
     - 确认保留归档：将子文档顶部状态改为「已回馈上游并从 fork 摘除」并注明对应上游版本/PR。
   - 同步清理或更新 **主文档差异全景表**、**B3 映射表与演进记录** 以及本节 **映射表**（若整体架构图或分支拓扑图受影响，同步更新对应画板）。
4. **内容风格与验收底线**
   - **视觉优先、精炼克制**：优先用结构清晰、重点明确的飞书原生可编辑画板（`<whiteboard type="svg">`）和脱敏实机界面截图配少数说明文字，避免大段纯文字堆砌或粘贴大段源码。
   - **写后必验**：所有飞书写操作显式使用 `--as user`；写完必须用 `lark-cli docs +fetch --as user --doc <doc_id>` 回读确认内容和链接未降级；新增或改动画板必须执行 `lark-cli whiteboard +export --whiteboard-token <token> --output-type preview` 导出预览图并肉眼核验无文字截断或重叠。

