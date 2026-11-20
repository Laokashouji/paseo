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

| 类别 | Secret 名称 | 内容 |
| --- | --- | --- |
| 签名（必填） | `APPLE_CERTIFICATE` | Developer ID Application `.p12` 单行 base64（`base64 -i cert.p12 \| tr -d '\n'`） |
| 签名（必填） | `APPLE_CERTIFICATE_PASSWORD` | `.p12` 导出密码 |
| 公证（方式 1，推荐） | `APPLE_API_KEY` | App Store Connect `.p8` 私钥（支持单行 base64 或原始 PEM） |
| 公证（方式 1，推荐） | `APPLE_API_KEY_ID` | API Key ID（10 位字符） |
| 公证（方式 1，推荐） | `APPLE_API_ISSUER` | API Issuer ID（UUID） |
| 公证（方式 2，备选） | `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Apple ID 邮箱、App 专用密码与 10 位 Team ID |

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

- **首次切换安装（仅需一次）**：因为你的 Apple Developer Team ID 与官方不同，官方签名包无法直接热更新到你的 fork。首次请从 `https://github.com/Laokashouji/paseo/releases/latest` 下载 `Paseo-<version>-arm64.dmg`，拖入 `/Applications` 替换原有 `Paseo.app`。本地 `~/.paseo/` 与 `~/Library/Application Support/Paseo/` 数据完全保留。
- **后续所有更新**：`Paseo.app` 内的 `app-update.yml` 已自动指向 `Laokashouji/paseo`，且 `rolloutHours` 为 `0`（即时生效）。每次发版完成后，MacBook / Mac mini 上的 Paseo Desktop 都会直接检测到新版本并在应用内一键自动更新。

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
