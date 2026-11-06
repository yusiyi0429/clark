# 天枢本机程序：代码签名与系统拦截调研（2026-11-06）

适用对象：`tianshu-local-windows-x64.exe`（Bun 单文件，约 112 MB）、`tianshu-local-darwin-arm64/-x64`；Windows 用 `irm … | iex` 安装，macOS 用 `curl … | sh` 安装。
标记说明：**[已证实]** = 官方页面或本机实测；**[二手]** = 经销商、博客、论坛；**[未证实]** = 本次没找到可靠来源，需要再核实。

---

## 0. 结论先看

| 问题 | 结论 |
|---|---|
| 按现在的一行命令安装，Windows 会不会弹 SmartScreen？ | **不会**。本机实测：Windows PowerShell 5.1 和 PowerShell 7.6.9 的 `Invoke-WebRequest -OutFile` 都**不写** Zone.Identifier（即不打“网络下载”标记，Mark-of-the-Web），所以不会触发 SmartScreen。只有用户用浏览器下载 exe 时才会弹。 |
| 那 Windows 上有什么会拦？ | **Smart App Control（智能应用控制，下称 SAC）开启“强制”时**，无论有没有网络下载标记，它都会拦截没签名、云端也不认识的程序。我们的主 exe 和首次运行时用 csc 编出来的托盘小程序**都会被拦**，而且没有按程序放行的办法。 |
| macOS 用 curl 下载、再由 LaunchAgent 拉起，需要公证吗？ | **不需要就能跑**：curl 不加 `com.apple.quarantine`，Gatekeeper 的首次运行检查不会介入。但 **Apple Silicon 至少要有有效的 ad-hoc 签名**；Bun 编出来的二进制签名可能是坏的，要重新签一次 ad-hoc。 |
| Singapore 公司能用 Azure Artifact Signing 吗？ | **按微软 2026-10-08 更新的 Quickstart 可以**（组织）；新加坡**个人不行**（个人只限美国、加拿大）；**中国大陆主体不行**。另有论坛报告称公司要有 3 年以上可查经营记录（官方文档里没写）。 |
| 证书最长有效期 | CA/B Forum Ballot CSC-31：**2026-03-01 起签发的代码签名证书最长 460 天**（以前是 39 个月）。DigiCert、Certum 实际按 459 天执行。 |
| EV 还值得买吗？ | 不值得。微软说明 EV“秒过” SmartScreen 的待遇在 **2024 年取消**，现在和 OV 一样要靠下载量慢慢积累信誉。 |

---

## 1. Windows 代码签名选项

### 1.1 总表

| 方案 | 价格 | 谁能申请 | 验证 | 出证时间 | 私钥存放 |
|---|---|---|---|---|---|
| **Azure Artifact Signing**（原名 Trusted Signing，2026-01 正式商用后改名） | Basic **$9.99/月**（每月 5,000 次签名）；Premium **$99.99/月**（每月 100,000 次）；超出部分 **$0.005/次** | 组织：美国、加拿大、欧盟、英国、澳大利亚、新西兰、日本、韩国、**新加坡**、瑞士、挪威、以色列；**个人只限美国、加拿大**；**中国大陆不在列表里** | 组织要提供：法定名称、公司网站、公司域名邮箱（主、备两个）、商业登记号（新加坡的 UEN）、地址；再由一名代表完成个人身份验证（AU10TIX：政府证件、人脸比对、Microsoft Authenticator 里的 Verified ID）。补充文件须是 12 个月内签发的。**必须是付费 Azure 订阅**（免费、试用、赞助订阅都不行） | 官方写 **1–20 个工作日**，补材料会更久，不能加急 | 微软托管 HSM（FIPS 140-3 Level 3），证书由服务自动轮换，用户拿不到私钥；不用 USB 令牌，可接 GitHub Actions、signtool |
| **OV 证书**（Sectigo、SSL.com、DigiCert、GlobalSign、Certum） | 约 $129–$700/年（下面有明细） | 全球都能申请（受制裁地区除外）；新加坡、中国大陆的公司都可以 **[二手 / 常识，未逐家核实]**；个人：SSL.com 有 IV（个人验证），Sectigo 接受个体户 | 商业登记文件（新加坡是 ACRA BizFile，中国大陆是营业执照），加第三方数据库核验（有 D-U-N-S 会快很多），再打第三方目录里登记的公司电话回访确认 | SSL.com 写 3–5 个工作日（加急 +$599 可缩到 2 天）；Sectigo 经销商写 OV 1–3 个工作日；寄 USB 令牌到新加坡、中国还要另加物流时间 | **2023-06 起强制**放在 FIPS 140-2 Level 2 / CC EAL4+ 硬件里：USB 令牌、CA 的云 HSM，或自己的云 HSM（需要证明文件）。不再发 .pfx 文件 |
| **EV 证书** | 约 $329–$1,116/年 | 只发给组织 | 比 OV 更严格。EV 指南要求核实“实际运营存续”，成立不足 3 年的公司通常要额外提供银行或律师证明 **[未证实：本次没有直接打开 EV Guidelines 原文]** | 3–7 个工作日（经销商口径） | 同 OV |
| 不签名 | 0 | — | — | — | — |

### 1.2 具体厂商价格（标价，购买前以下单页为准）

| 厂商 / 产品 | 价格 | 备注 | 来源 |
|---|---|---|---|
| SSL.com OV | 1 年 **$129**；5 年合同摊到每年 $96.75 | 令牌 YubiKey **+$379**，或用 eSigner 云签名（Tier 1 约 **$15/月，240 次**，最高 Tier 4 约 $187.50/月，12,000 次，按年付约 75 折）；标准验证 3–5 个工作日 | ssl.com 购买页（2026 年版本，页面未标价格生效日）；eSigner 价格引自 codenote 2026-06 |
| SSL.com IV（个人）/ EV | IV 价格未查到；EV **$349/年** | 个人不能买 OV，要买 IV | 同上 |
| Sectigo OV（经销商） | 约 **$219–$226/年**，含 USB 令牌 | Sectigo 官网多年期折算约 $536/年 | sslinsights、TheSSLStore 等 **[二手]**；codenote 2026-06 |
| DigiCert OV | 官网 **$696/年**（自备 HSM）或 **$840/年**（含 USB 令牌）；经销商约 $380–$445 | KeyLocker 云签名每张证书每年 1,000 次，约加 $300 | codenote 2026-06 **[二手]** |
| GlobalSign（美国）OV | **$434/年** | 只有 1 年期 | codenote 2026-06 |
| Certum Standard（标准 OV） | 电子码 **€139**（需自备 Certum 卡和读卡器）、全套 **€169**、云端 SimplySign **€209** | 2026-02-27 起单张证书最长 459 天，多年期产品中途免费重签 | shop.certum.eu（2026-11-06 查看） |
| Certum Open Source（开源） | €25 / €49（云端）/ €69 | **只能签开源软件**，天枢本机程序是闭源的，**不适用** | 同上 |
| Certum EV | €329–€379 | | 同上 |

### 1.3 有效期（CA/B Forum）
- **Ballot CSC-31**：2025-10-06 至 10-13 投票，**2025-11-17 生效（adopted）**；“maximum certificate validity, from 39 months to 460 days, effective March 1st, 2026”。
- DigiCert：**2026-02-24** 起最长 459 天，取消 2 年、3 年期选项。Certum：**2026-02-27** 起 459 天。
- 实际影响：**每年都要重签一次**，用 USB 令牌的话每年还要重新走一遍密钥证明。

### 1.4 Azure Artifact Signing 要注意的坑
- **各页面写的国家不一致**：《Code signing options》（2026-08-29）写组织只限“美国、加拿大、欧盟、英国”；《Quickstart》（2026-10-08 更新）已经列出新加坡、日本等国。codenote 2026-06 的文章还写着日本不在范围内，说明**扩到亚太是 2026 年 6–10 月之间的事**。以 Quickstart 为准，但建议在 Azure 门户的国家下拉列表里实际确认一下。
- **“公司须有 3 年以上可查历史”**：只出现在 Microsoft Q&A 的帖子里（称 2025-04-09 起执行，有因公司成立不满 3 年被拒的案例），**官方文档没写** → **[未证实，但风险高]**。如果新加坡主体成立不满 3 年，很可能过不了。
- **开账户当天就开始计费、不按天折算**；验证失败也照样收费，失败后建议删除账户。
- 不发 EV，也不能自定义证书上显示的名称（CN、O 就是验证过的法定名称）。
- 签发的证书有效期很短（FAQ 在 ELAM 场景下写的是“valid for three days”），所以**签名时一定要加时间戳**（`http://timestamp.acs.microsoft.com`）。

### 1.5 Bun 编出来的 exe 能不能做 Authenticode 签名
- Bun 官方文档只讲了 macOS 的签名，**没提 Windows**。
- 本机旁证 **[已证实]**：本机的 `claude.exe`（Claude Code，PE 节表里有 `.bun`、`.bunaot` 等节，也就是 Bun 编出来的单文件）带有**有效**的 Authenticode 签名（DigiCert G4 签发，签名者 Anthropic, PBC）。所以 Bun 的 Windows 单文件**可以**签名后正常运行。不过对方可能用的是定制版 Bun，我们自己签完仍要跑一次 `signtool verify /pa` 并实际启动验证。

---

## 2. Windows 用户实际会看到什么

### 2.1 SmartScreen
| 签名情况 | 浏览器下载后首次运行 | 来源 |
|---|---|---|
| 不签名 | “Windows 已保护你的电脑”，要点“更多信息 → 仍要运行”；企业策略可以禁止继续 | MS Learn《SmartScreen reputation》2026-05-04 |
| OV、Artifact Signing、EV | 新文件照样提示“无法识别的应用”，但**会显示已验证的发布者名称**；同一个发布者身份持续签名，信誉会累积（官方说可能要几周、几百次正常安装），新版本可以继承 | 同上；MS Learn《Code signing options》2026-08-29 |
| EV 的特殊待遇 | **2024 年取消**，现在和 OV 一样 | 同上（“That behavior was removed in 2024.”） |

**我们的安装方式不会触发 SmartScreen [已证实，本机 2026-11-06 实测]**：
- `powershell.exe` 5.1.26100 和 `pwsh` 7.6.9 用 `Invoke-WebRequest -OutFile` 下载后，文件**都没有** `Zone.Identifier` 流。
- SmartScreen 应用信誉检查靠这个标记触发；Cisco 官方排错文档也建议改用 curl 或 PowerShell 下载来绕开 SmartScreen；7-Zip 解压不带标记时 SmartScreen 也不检查（安全研究报告）。
- 所以 `irm | iex` 安装、HKCU Run 开机自启、本机 csc 编译出来的托盘程序，都**不会**出现 SmartScreen 提示。
- 例外：用户如果从网页直接点链接下载 exe，就会带上标记，会弹提示。

### 2.2 Smart App Control（关键风险）
- **不管有没有网络下载标记都会检查** [已证实]：MS Learn《SmartScreen reputation》原文是“Smart App Control signature checks apply to all executable files, not just those downloaded from the Internet.”
- 判断顺序：先看云端能不能确定它安全；不能确定的话，只要有受信 CA（Trusted Root Program）签发的有效签名就放行；**没签名或签名无效就拦**。“There is currently no way to bypass Smart App Control protection for individual apps.”（SAC FAQ）
- 对我们的影响：
  - 主 exe 不签名 → SAC 开“强制”的机器上**被拦**；新版本 hash 每次都变，云端基本不会认识。
  - **本机 csc 编译出来的托盘 exe 一定会被拦**（每台机器编出来的都是新 hash，又没签名，也没法在用户机器上用我们的证书签）。微软 Q&A 也证实：本机新编译、没签名的程序会被 SAC 拦。
  - csc.exe 本身是微软签名的，应该能运行；本次没找到 SAC 把 csc.exe 列入封锁名单的资料 **[未证实]**。
  - **如果买了证书**：托盘小程序要改成**在我们的构建流程里预先编好并签名**，随安装包一起分发，不能再在用户机器上现编。
- **开启比例**：微软没有公布 **[未证实]**。已知事实：
  - SAC 只在 Windows 11 22H2 以后**全新安装**时默认进入“评估”模式。系统判断用户不合适（开发者、企业用户等）就自动关掉；企业托管设备 48 小时内自动关闭。
  - 2026 年 4 月的累积更新（第三方报道是 KB5074105，24H2/25H2）起，**已安装的系统也可以手动打开** [二手]。
  - 进入强制模式时，系统会弹通知告诉用户。
  - 本机（Windows 11 家庭中文版 26300）的 `VerifiedAndReputablePolicyState = 0`，也就是关闭状态。
- 判断方法：安装脚本可以读 `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState`（0 = 关，1 = 强制，2 = 评估）；值为 1 时提示用户“需要签名版本或关闭智能应用控制”。被拦的记录在 CodeIntegrity 事件 3077（评估模式下“本会拦”是 3076）。
- 另外：一个约 112 MB、没签名、新出现的 exe，可能被 Defender 或其他杀毒软件按启发式规则误报 **[未证实，只是常见风险]**。

---

## 3. macOS

### 3.1 Apple Developer Program
| 项目 | 内容 | 来源 |
|---|---|---|
| 年费 | **99 美元/年**，按当地货币收；**中国大陆 ¥688/年**；会员到期自动续费；Apple 账户余额（礼品卡）不能付 | developer.apple.com/programs/enroll、/cn/support/app-account |
| 个人 | 法定姓名、开启双重认证；用 Apple Developer App 时拍政府证件（多数地区收护照）；中国大陆填**身份证号并拍自拍**。证书和 App Store 上显示**个人名字** | 同上 |
| 组织 | 必须是能签合同的法人（不收 DBA、商号、分公司）、**必须有 D-U-N-S**、网站要公开且域名属于本组织、邮箱用公司域名、注册人要有签约权（不是所有者的话要有人担保）；可能要求提供公证过的商业文件。中国大陆组织要在 iPhone 或 iPad 上用 Apple Developer App 注册 | 同上 |
| D-U-N-S | 免费；**最多 5 个工作日**拿到编号，加急也不能更快；拿到后**再等最多 2 个工作日**苹果那边才能查到；超过两周没下来可以发邮件给 D&B | developer.apple.com/help/account/membership/D-U-N-S |
| 审核时长 | 官方没给具体时长；组织要等苹果审核后发邮件才能付款 → **[未证实]**，经验上个人 1–2 天，组织 1–2 周（含 D-U-N-S） | |
| 新加坡、中国大陆 | 都没有查到地区限制（只有受制裁地区不支持）；中国大陆有专门的 App 注册流程和 ¥688 价格 | 同上 |
| Developer ID Application 证书 | 对外分发（不经 App Store）必须用它；组织账号只有 Account Holder 能创建；有效期 5 年 **[常识，本次未核实]** | |

### 3.2 公证（notarytool）
- 要求 [已证实，Apple 文档]：用 Developer ID 签名、开启 **Hardened Runtime**、带安全时间戳、不能带 `get-task-allow`。
- 耗时：“Notarization completes for most software within **5 minutes**, and for **98 percent** of software within **15 minutes**”。
- **裸命令行二进制**：只收 zip、dmg、pkg，所以要用 `ditto -c -k` 打成 zip 再提交 `xcrun notarytool submit x.zip --wait`。**不能把公证票据钉进（staple）zip 或单独的二进制文件**（原文：“Although tickets are created for standalone binaries, it's not currently possible to staple tickets to them.”）→ Gatekeeper 联网查询公证结果。
- Bun 要加的 entitlements：`allow-jit`、`allow-unsigned-executable-memory`、`disable-executable-page-protection`、`allow-dyld-environment-variables`、`disable-library-validation`（Bun 文档示例；要求 Bun v1.2.4 及以上）。

### 3.3 关键问题：curl 下载、LaunchAgent 拉起，需要公证吗？
- **不需要就能运行** [已证实，多个来源互相印证]：
  - Apple 开发者论坛上苹果 DTS 工程师 Quinn：“Most Unix-y tools don't quarantine their downloads, including curl and scp”；“In general, Gatekeeper only runs on things that are quarantined.”（thread 666452 等）
  - Eclectic Light（2024-08，Sequoia）：新规则“only enforced on apps that have been quarantined”。没有隔离标记的照样会查公证，但“allowed to run without any additional action by the user”。
  - Apple 社区 2025 年帖子：curl 下载的程序在“只允许 App Store”设置下也能运行。
  - 关于 macOS 26 Tahoe / macOS 27：本次**没找到**改变这条规则的说明 **[未证实]**。
- **Apple Silicon 必须有签名，ad-hoc 就够** [二手，来源是 Apple 2020 年 Universal Apps 发布说明，经 Eclectic Light、Michael Tsai 转述]：arm64 原生代码没有有效签名，内核直接杀掉（`Killed: 9`）；Intel 机和 Rosetta 下的 x86 代码不受这条限制。
- **Bun 的坑**：社区报告 Bun 在 macOS arm64 上是先链接签名、再把 JS 包写进去，导致 ad-hoc 签名失效，程序一启动就被杀。另有 Bun 1.2.14 的 darwin-x64 签名长度越界、到 1.3 才修好的报告。稳妥做法是打包后执行 `codesign --remove-signature` → `codesign --force --sign -` → `codesign --verify`。
- 例外：用户用浏览器下载（会带隔离标记），没公证的程序在 macOS 15 以后会被拦，而且**右键“打开”已经绕不过去了**，只能去“系统设置 → 隐私与安全性 → 仍要打开”。

### 3.4 osascript / JXA 弹窗与 TCC（系统隐私授权）
- 只用 `display dialog`（不 `tell` 其他程序）：一般**不会**弹“自动化”授权 **[未证实，没找到官方说法]**。
- `tell application "System Events"` 或控制其他 App：会弹“自动化”（AppleEvents）授权，授权记在**我们这个二进制名下**。
- **ad-hoc 签名的二进制**：TCC 按 cdhash 认程序，**每次更新都会丢掉之前的授权**，用户要重新点允许，而且系统设置里可能留下一条失效的记录。用 Developer ID 签名后身份稳定，升级不丢授权 [二手：社区文章与 Claude Code 的 issue]。
- macOS 13 起，新增 LaunchAgent 会弹“已添加登录项”通知；没签名的显示可执行文件名，签了名的显示开发者名 **[常识，本次未核实]**。

---

## 4. 给产品负责人的选项

| | A. 内部试用先不签名 | B. Azure Artifact Signing（新加坡公司） | C. 买 OV 证书 |
|---|---|---|---|
| 前提 | 无 | 签约主体是**新加坡公司**（中国大陆主体、新加坡个人都不行）；最好成立满 3 年（未证实，但风险高）；有付费 Azure 订阅 | 新加坡或中国大陆的公司（个人可以买 SSL.com IV） |
| 费用 | 0 | 约 $120/年（$9.99/月），开账户当天就开始收费 | SSL.com OV $129/年，加 eSigner 云签名（约 $15/月起）或 YubiKey $379；Sectigo 约 $220/年（含令牌）；DigiCert 约 $400–$840/年 |
| 准备时间 | 0 | 1–20 个工作日（11/30 上线：今天开始办理，大约一半把握） | 3–5 个工作日，加 D-U-N-S、电话回访、令牌物流；用云签名（eSigner 等）能省掉物流 |
| 用户看到什么（`irm \| iex` 安装） | 平时**没有提示**（没有网络下载标记）；**SAC 开强制的机器上主程序和托盘都会被拦**，无法单独放行；杀毒软件可能误报 | 平时没有提示；SAC 机器上放行（签名有效）；用户浏览器下载时提示“无法识别”，但会显示公司名 | 同 B |
| 要改的工程 | install.ps1 读 SAC 状态，开着就给明确提示 | 构建流程加 signtool + 时间戳；**托盘程序改成预编译并签名后随包分发**（不再在用户机器上用 csc 现编） | 同 B |

**macOS（12 月）**：
- **最低要求（等同 A）**：继续用 curl 安装，**确保 arm64、x64 都有有效的 ad-hoc 签名**，费用 0。代价是每次升级 TCC 授权都会丢；浏览器下载走不通。
- **正式做法**：Apple Developer Program 99 美元/年（¥688）。以新加坡公司名义注册要先办 D-U-N-S（最多 5 + 2 个工作日），再等苹果审核（约 1–2 周，未证实）。建议 **11 月内就开始申请**。签 Developer ID、开启 Hardened Runtime + Bun 的 entitlements，打 zip 公证（通常 5 分钟内完成）。裸二进制不能 staple，没关系，因为 curl 下载的文件本来就不经过 Gatekeeper。

**建议**：11/30 的 Windows 内部试用按 **A** 上线，同时在安装脚本里加 SAC 检测和提示；**今天就开始办 C**（如果主体是新加坡公司且成立满 3 年，就并行申请 B，哪个先下来用哪个），争取 12 月前换成签名版。拿到证书后把托盘程序改成预编译并签名。macOS 同步启动 Apple 组织注册（D-U-N-S 先行）。

---

## 5. 来源（访问日期都是 2026-11-06）

| 来源 | 页面日期 |
|---|---|
| MS Learn《Code signing options for Windows app developers》https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options | ms.date 2026-08-29 |
| MS Learn《Quickstart: Set up Artifact Signing》https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart | ms.date 2026-05-21，更新于 2026-10-08 |
| MS Learn《Artifact Signing FAQ》https://learn.microsoft.com/en-us/azure/artifact-signing/faq | ms.date 2026-05-14，更新于 2026-10-27 |
| Azure 价格页 https://azure.microsoft.com/en-us/pricing/details/artifact-signing/ （价格是动态加载的，抓不到具体数字；$9.99 出自 MS Learn，$99.99 和 $0.005 出自 codenote） | 无日期 |
| Microsoft Tech Community：Artifact Signing 正式商用 https://techcommunity.microsoft.com/blog/microsoft-security-blog/-/4482789 | 2026-01-12 |
| Microsoft Q&A：3 年历史要求（论坛，非官方）https://learn.microsoft.com/en-us/answers/questions/5532414/trusted-signing-identity-verification-failed-provi | 2025 |
| MS Learn《SmartScreen reputation for Windows app developers》https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation | ms.date 2026-05-04，更新于 2026-08-17 |
| MS Learn《Smart App Control》（开发者）https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview | ms.date 2026-09-30 |
| Microsoft Support《Smart App Control FAQ》https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions | 2026（页面没写具体日期） |
| MS Learn《Application Control for Windows》（注册表值、48 小时自动关闭）https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol | ms.date 2026-08-18 |
| Microsoft Q&A：本机编译的程序被 SAC 拦 https://learn.microsoft.com/en-us/answers/questions/6039272/supported-way-to-run-a-locally-built-application-w | 2026 |
| CIAOPS：2026 年 4 月起已安装系统也能开 SAC https://blog.ciaops.com/2026/04/16/existing-systems-can-now-enable-windows-smart-app-control-and-you-should/ | 2026-04-16 [二手] |
| Cisco 排错文档（用 curl/PowerShell 下载绕开 SmartScreen）https://www.cisco.com/c/en/us/support/docs/security/secure-client-5/225949-troubleshoot-secure-client-installer.pdf | 未标 |
| CA/B Forum Ballot CSC-31 https://cabforum.org/2025/11/17/ballot-csc-31-maximum-validity-reduction/ | 2025-11-17 |
| CA/B Forum Code Signing BR 页面 https://cabforum.org/working-groups/code-signing/requirements/ | 当前版本 |
| DigiCert 459 天公告 https://knowledge.digicert.com/alerts/code-signing-certificates-459-day-validity | 最后修改 2026-03-04 |
| Certum 商店 https://shop.certum.eu/code-signing.html | 2026-11-06 查看 |
| SSL.com OV 购买页 https://www.ssl.com/certificates/code-signing/buy/ | 2026 |
| codenote：日本 OV/EV 价格对比 https://codenote.net/en/posts/ov-ev-code-signing-certificate-pricing-japan-2026/ | 2026-06-30 [二手] |
| sslinsights：Sectigo 价格 https://sslinsights.com/sectigo-code-signing-certificate-guide/ | 2026 [二手] |
| Apple《Enroll》https://developer.apple.com/programs/enroll/ ；《Enrollment support》https://developer.apple.com/support/enrollment/ ；中国大陆 App 注册 https://developer.apple.com/cn/support/app-account/ | 2026 查看 |
| Apple《D-U-N-S》https://developer.apple.com/help/account/membership/D-U-N-S/ | 2026 查看 |
| Apple《Notarizing macOS software before distribution》https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution | 当前版本 |
| Apple《Customizing the notarization workflow》https://developer.apple.com/documentation/security/customizing-the-notarization-workflow | 当前版本 |
| Apple 论坛 Quinn：curl 不加隔离标记 https://developer.apple.com/forums/thread/666452 ；《Testing a Notarised Product》https://developer.apple.com/forums/thread/130560 | 2020 起，最后修订 2024-12-05 |
| Eclectic Light《Gatekeeper and notarization in Sequoia》https://eclecticlight.co/2024/08/10/gatekeeper-and-notarization-in-sequoia/ | 2024-08-10 |
| Eclectic Light《Apple Silicon Macs will require signed code》https://eclecticlight.co/2020/08/22/apple-silicon-macs-will-require-signed-code/ | 2020-08-22 |
| Bun 单文件可执行文件文档（macOS codesign、entitlements）https://bun.com/docs/compiler/executables.md | 当前版本 |
| Bun 在 macOS 上签名失效的报告 https://github.com/rodaddy/mcp2cli/issues/67 、https://github.com/oven-sh/bun/issues/7208 | 2023–2026 [二手] |
| TCC 与 cdhash https://nickboy-github-io.pages.dev/posts/tcc-cdhash-trap/ | 2026 [二手] |
| **本机实测**（2026-11-06，Windows 11 家庭中文版 10.0.26300）：PS 5.1 / 7.6.9 的 `Invoke-WebRequest` 不写 Zone.Identifier；SAC 状态 = 0；`claude.exe`（Bun 编译，带 `.bun` 节）Authenticode 签名 = Valid | — |
