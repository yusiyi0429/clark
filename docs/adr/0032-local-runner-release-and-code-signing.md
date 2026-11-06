# 本机程序的发布：内部试用先不签名，签名和公证列成选项由本人定

2026-11-06 提出。适用于 `apps/local` 的下载源和安装包。**签名、公证要花钱、要以公司名义申请，等本人拍板**；本文的「决定」是在拍板前的默认做法。

## 背景

- 装法：Windows `irm https://tk.tokenkingos.com/downloads/local/install.ps1 | iex`，Mac `curl -fsSL …/install.sh | sh`。下载源放 4 个脚本、3 个程序（Windows x64 约 112 MB、Mac arm64 约 61 MB、x64 约 66 MB）、`SHA256SUMS`。
- 本机实测（11/06，Windows 11 26300）：PowerShell 5.1 和 7 的 `Invoke-WebRequest` 下载的文件**没有**「来自网络」标记（Zone.Identifier），所以照这个装法**不会弹 SmartScreen**；只有本人用浏览器直接下载 exe 才会弹。
- 会拦的是 Windows 11 的**智能应用控制**（Smart App Control）：开着「强制」时，它检查所有程序，不管有没有网络标记；没签名、云端又不认识的一律拦，没有单个放行的办法。我们的主程序和首次启动时用 csc 编出的托盘助手都会被拦。微软没公布开着的比例：只有全新安装的 Win11 默认进「评估」，系统判断不合适（开发者、企业托管机）会自动关掉；本机是关的。
- Mac：curl 下载不带隔离标记，Gatekeeper 不检查，**不公证也能跑**；Apple 芯片要求至少有效的临时签名（ad-hoc），Bun 交叉编译会带上，但有报告说 Bun 的签名可能失效，要在 Mac 上验一次。
- PowerShell 5.1 的 `irm` 在响应头没有 `charset` 时按 ISO-8859-1 解码，脚本里的中文全乱（11/06 实测：有 charset 时中文完好，没有时乱）。

## 决定（拍板前的默认）

- 11/30 Windows 内部试用**先不签名**。`install.ps1` 一开始读智能应用控制的状态（`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState`，1 = 强制），开着就直接停下，说明原因和关法，不装半截。
- 发布用 `pnpm --filter @warmap/local release` 准备文件（编三个平台、拷脚本、写 `SHA256SUMS`、自查 BOM/换行/文件格式），上传后用 `release.mjs --verify <下载源>` 核对哈希和 `charset=utf-8`。步骤见 runbook「打包和发布」。
- 下载源的 `.ps1`、`.sh`、`SHA256SUMS` 必须回 `Content-Type: text/plain; charset=utf-8`。

## 给本人的选项

### Windows

| | A. 先不签名（默认） | B. Azure Artifact Signing | C. 买 OV 代码签名证书 |
|-|-|-|-|
| 前提 | 无 | 以**新加坡公司**名义（微软 2026-10-08 的文档里新加坡组织可申请；新加坡个人、中国大陆主体都不行）；有付费 Azure 订阅；论坛说公司要有 3 年以上记录（官方没写，风险高） | 新加坡或中国大陆的公司都可以；个人可买 SSL.com 的 IV |
| 费用 | 0 | $9.99/月（每月 5,000 次签名），开户当天起计费，验证失败也收 | SSL.com OV $129/年 + 云签名 eSigner 约 $15/月起（或 YubiKey $379）；Sectigo 经销商约 $220/年含令牌；DigiCert $696–840/年 |
| 多久办下来 | 0 | 官方写 1–20 个工作日，不能加急 | SSL.com 写 3–5 个工作日；加电话回访、令牌寄送（用云签名可省掉寄送） |
| 本人看到什么 | 照常装没有提示；开着智能应用控制的电脑装不了；杀毒软件可能误报（未证实） | 照常装没有提示；智能应用控制放行；浏览器下载时提示里显示公司名 | 同 B |
| 要改的工程 | 无（已加智能应用控制检测） | 构建加 signtool + 时间戳；**托盘助手改成在我们这边预先编好、签名后随包发**（用户电脑上现编的签不了名，会被拦） | 同 B |

补充：2026-03-01 起签发的代码签名证书最长 460 天（CA/B Forum CSC-31），每年要续签一次。EV 证书不值得买：它「秒过 SmartScreen」的待遇 2024 年已取消。Bun 编的 Windows 单文件能签名（本机的 Claude Code 就是 Bun 编的并带有效签名），我们签完仍要实测一次。

### Mac（12 月）

| | 最低要求（默认） | Apple Developer Program |
|-|-|-|
| 费用 | 0 | $99/年（中国大陆 ¥688） |
| 多久办下来 | 0 | 公司名义要先办 D-U-N-S（免费，最多 5 个工作日 + 苹果同步最多 2 个工作日），再等苹果审核（官方没给时长，经验 1–2 周）；建议 11 月内就开始 |
| 做什么 | 在 Mac 上 `codesign -v` 确认两个程序的临时签名有效，坏了就重签临时签名 | Developer ID 签名 + Hardened Runtime（Bun 要加几项 entitlements）+ 打 zip 公证（通常 5 分钟内）；裸程序不能 staple，curl 装法不受影响 |
| 本人看到什么 | curl 装法照常能跑；每次升级，系统隐私授权（如果有）要重新点；浏览器下载走不通 | 升级不丢授权；登录项通知里显示公司名 |

### 建议

Windows 按 A 上 11/30 内部试用；**现在就开始办 C**（主体是成立满 3 年的新加坡公司的话，同时申请 B，哪个先下来用哪个），争取 12 月换成签名版，同时把托盘助手改成预编译并签名。Mac 同时开始办 Apple 组织账号（先办 D-U-N-S）。要本人定：用哪个主体申请、预算。

## 来源（都是 2026-11-06 查看）

- 微软：[Code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)（2026-08-29）、[Artifact Signing Quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)（更新于 2026-10-08）、[SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)（2026-05-04）、[Smart App Control 开发者说明](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)（2026-09-30）
- [CA/B Forum Ballot CSC-31](https://cabforum.org/2025/11/17/ballot-csc-31-maximum-validity-reduction/)（2025-11-17）
- 价格：[SSL.com](https://www.ssl.com/certificates/code-signing/buy/)、[Certum](https://shop.certum.eu/code-signing.html)；Sectigo、DigiCert 经销商价为二手资料
- Apple：[Enroll](https://developer.apple.com/programs/enroll/)、[D-U-N-S](https://developer.apple.com/help/account/membership/D-U-N-S/)、[Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)；curl 不加隔离标记见 [Apple 开发者论坛](https://developer.apple.com/forums/thread/666452)
- 完整调研和逐条来源：`.scratch/local-runner/实验/H_签名与公证调研.md`
