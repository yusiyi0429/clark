# 天枢本机程序 × Claude Code：检测 / 安装 / 登录 实验结论

- 日期：2026-11-06（UTC+8 凌晨）；本机 Windows 11，Claude Code 2.1.318（原生安装）
- 实验方式：用 Node 写的启动器拉起 `claude.exe`，启动前去掉父进程里所有 `ANTHROPIC_*`、`CLAUDE*`（含 `CLAUDECODE`）、`MCP_*`、`OTEL_*`，只按需设置 `CLAUDE_CONFIG_DIR`。输出里的 `code/state/code_challenge`、令牌一律换成 `present(len=N)`。
- 实验目录：`C:\Users\10021\AppData\Local\Temp\claude\5412242dd0cafb0c\1e1fde7b-dbb6-4c7b-a0b3-c7c1a8e61db3\scratchpad\exp-claude-login\`
  - 隔离配置目录：`cfg-empty`、`cfg-login`、`cfg-setuptoken`、`cfg-paste`、`cfg-unauth`、`cfg-badtoken`（都没有完成登录，里面没有凭据）
  - 原始输出：`help-main.txt`、`help-sub.txt`、`init-empty.txt`、`login-run1.txt`、`setuptoken-run1.txt`、`paste-run.txt`、`unauth-stream.txt`、`badtoken-stream.txt`、`doctor-real.txt`
  - 官方安装脚本原文（只下载阅读，未执行）：`dl-scripts\install.ps1 / install.sh / install.cmd`
  - 启动器脚本：`..\tools\run.mjs`、`login-probe.mjs`、`paste-probe.mjs`
- 全程没有发起真实模型调用，没有完成任何登录，起的进程都已结束（已核对 PID 和监听端口）。

---

## 1. 检测：装没装、版本、位置

### 结论
- **不要只靠 PATH。** 托盘程序开机自启时（尤其 Mac 上从 launchd/Finder 启动的 GUI 程序）拿不到用户 shell 里的 PATH。按下面顺序找到第一个能跑 `--version` 的就算装了：
  1. `CLAUDE_BIN` 之类的本机程序自身配置（用户手动指过的路径）
  2. 原生安装默认路径
     - Windows：`%USERPROFILE%\.local\bin\claude.exe`（实测：这是一个完整的 exe 副本，342 MB，不是快捷方式；各版本另存在 `%USERPROFILE%\.local\share\claude\versions\<版本>`）
     - Mac/Linux：`~/.local/bin/claude`（文档：是指向 `~/.local/share/claude/versions/<版本>` 的符号链接）
  3. 包管理器路径（未在本机实测，按常规布局）
     - Mac Homebrew cask：`/opt/homebrew/bin/claude`（Apple 芯片）、`/usr/local/bin/claude`（Intel）
     - Windows WinGet：`%LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe`（WinGet 便携包的常见链接位置，拿不准）
     - npm 全局：Windows `%APPDATA%\npm\claude.cmd`，Mac 为 `$(npm prefix -g)/bin/claude`
  4. 最后才用 `where.exe claude`（Windows）/ 登录 shell 里的 `command -v claude`（Mac：`/bin/zsh -lc 'command -v claude'`）
- **版本号**：`claude --version` 输出 `2.1.318 (Claude Code)`，0.2–0.3 s，退出码 0，不读写配置。正则 `^(\d+\.\d+\.\d+)` 即可。
- **安装方式与健康状况**：`claude doctor`（官方说明是只读诊断，不开会话）输出 `Running: native (2.1.318)`、`Path: ...`、`Config install method: native`、`Auto-updates: ...`。适合做「诊断」页面，不适合做机器判断（纯文本）。
- 可选：Windows 上 `Get-AuthenticodeSignature` 校验签名者为 `Anthropic, PBC`，Mac 上 `codesign --verify`（文档给出），防止 PATH 里被放了假 `claude`。

### 证据
- `where.exe claude` → `C:\Users\10021\.local\bin\claude.exe`；`Get-Command claude` 版本 `2.1.318.0`
- `C:\Users\10021\.local\share\claude\versions\` 下有 `2.1.307 / 2.1.314 / 2.1.318`
- 用户 PATH（注册表 HKCU）里有 `C:\Users\10021\.local\bin`（原生安装器加的）
- `Get-AuthenticodeSignature` → `Status: Valid`，签名者 `CN="Anthropic, PBC"`
- `claude doctor`（真实配置）见 `doctor-real.txt`
- 文档：https://code.claude.com/docs/en/setup （“the native installer manages the launcher at `~/.local/bin/claude` as a symlink into `~/.local/share/claude/versions/`”）

### 拿不准
- WinGet、Homebrew、npm 的具体落盘位置没在本机实测。
- Mac 未实测，只来自文档。

---

## 2. 官方安装方式

### 结论
| 平台 | 官方推荐（原生安装器） | 其他官方渠道 |
|---|---|---|
| Windows PowerShell | `irm https://claude.ai/install.ps1 \| iex` | `winget install Anthropic.ClaudeCode`（不自动更新） |
| Windows CMD | `curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd` | |
| Mac / Linux / WSL | `curl -fsSL https://claude.ai/install.sh \| bash` | `brew install --cask claude-code`（stable 渠道，不自动更新）/ `claude-code@latest` |
| 指定版本或渠道 | PowerShell：`& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) stable`（或 `2.1.89`）；bash：`... \| bash -s stable` | |

- **npm**：文档还写着 `npm install -g @anthropic-ai/claude-code`（要 Node 22+，装的也是同一个原生二进制），但放在「Advanced installation options」里，主推是原生安装。不再推荐，但没说废弃。
- **管理员**：不需要。文档原话 “You do not need to run as Administrator”；`install.sh` 甚至拒绝在 sudo 下运行。全部装到用户目录。
- **前置条件**：
  - Windows 10 1809+ / macOS 13+，64 位，4 GB+ 内存，联网，且在 Anthropic 支持的国家/地区（脚本里有“不在支持地区会拿到 HTML 错误页”的提示——中国大陆网络可能直接失败，需要代理）。
  - **Git for Windows 已不是必需**：没有 Git Bash 时 Claude Code 用 PowerShell 工具代替 Bash 工具；装了 Git for Windows 才有 Bash 工具和 Monitor 工具。
- **安装脚本做了什么**（读了 `install.ps1` / `install.sh` 原文）：
  1. GET `https://downloads.claude.ai/claude-code-releases/latest` 拿版本号
  2. GET `.../<版本>/manifest.json` 取对应平台 SHA256
  3. 下载 `.../<版本>/<平台>/claude.exe`（Mac 为 `claude`，有 zstd 时下 `.zst`）到 **`%USERPROFILE%\.claude\downloads\`**（注意：固定在 `~/.claude` 下，不跟 `CLAUDE_CONFIG_DIR`）
  4. 校验 SHA256 后执行 `<下载的二进制> install [stable|latest|版本]`，由它放置启动器、加 PATH，然后删除临时文件
- **自定义安装目录**：脚本不支持（参数只有 `stable|latest|版本号`），`claude install --help` 也只有 `--force` 和目标版本。文档只提到「自定义启动器」：可以自己把二进制放到任意位置/自己写启动器，此时 Claude Code 不再管理启动器、保留所有版本。对我们来说：**不需要自定义目录**，按默认 `~/.local/bin` 装即可；本机程序记住绝对路径直接 spawn，不依赖 PATH。
- **本机程序免终端安装的两种做法**：
  - A（最省事）：后台跑官方脚本，不弹窗：Windows `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"`；Mac `/bin/bash -c "curl -fsSL https://claude.ai/install.sh | bash"`。成功标志：输出 `Installation complete!` 且默认路径 `--version` 能跑。
  - B（更可控）：本机程序自己实现脚本那四步（取版本 → manifest → 下载 → SHA256 → `<bin> install stable`），可以显示下载进度（官方脚本“下载时没有任何进度”）。

### 证据
- 文档：https://code.claude.com/docs/en/setup （安装命令、Windows 不需要管理员、Git for Windows 可选、Homebrew/WinGet 不自动更新、npm 段落）
- 下载结果：`install.ps1` 3189 B、`install.sh` 9704 B、`install.cmd` 8335 B，都 302 到 `downloads.claude.ai/claude-code-releases/bootstrap.*`
- `claude install --help`：`Usage: claude install [options] [target]`，只有 `--force`

### 拿不准
- 没有真的执行安装（按要求），所以：`claude install` 在没有终端（stdin/stdout 都是管道）时是否会卡在交互界面、写不写 `~/.claude.json` 的 `installMethod`、改 PATH 后要不要重新登录 Windows 才生效，都没实测。建议在一台干净的虚拟机或测试账号上补测一次。
- 没测 Windows ARM64 和 Mac。

---

## 3. 登录状态检测（不耗模型调用）

### 结论
- **首选 `claude auth status --json`**：纯本地读，不联网（把代理指到空端口照样 1 s 返回），**不写任何文件**（运行前后 `.claude.json` / `.credentials.json` 修改时间没变）。
  - 已登录：退出码 **0**，`{"loggedIn": true, "authMethod": "claude.ai", "loginExpiresAt": "...", "email", "orgId", "orgName", "subscriptionType": "max"}`
  - 未登录：退出码 **1**，`{"loggedIn": false, "authMethod": "none", "loginExpiresAt": null}`；`--text` 输出 `Not logged in. Run claude auth login to authenticate.`
  - 注意它只说明「有凭据」，**不验证凭据有效**：塞一个假的 `ANTHROPIC_API_KEY` 返回 `loggedIn: true, authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY"`；塞一个假的 `CLAUDE_CODE_OAUTH_TOKEN` 返回 `loggedIn: true, authMethod: "oauth_token"`。所以本机程序 spawn 时一定要去掉这些变量，否则状态会被冒充。
  - `loginExpiresAt` 可用来提前提示（官方在到期前 3 天会提醒 `/login` 续期）。
- **备选：stream-json 的 initialize 控制请求**：发 `{"type":"control_request","request_id":"x1","request":{"subtype":"initialize"}}` 后立刻关 stdin，1.3 s 拿到 `control_response` 后进程自己以 0 退出（首次冷启动约 7.6 s）。返回里有 `account` 字段：
  - 空配置：`"account": {"tokenSource": "none", "apiProvider": "firstParty"}`
  - 真实配置：`"account": {"email": "...", "organization": "...", "subscriptionType": "Claude Ultra", "apiProvider": "firstParty"}`
  - 这条路比 `auth status` 慢、还会跑用户配置的 SessionStart 钩子和插件（真实配置下实测触发了 6 个 SessionStart 钩子），**只适合在已经要跑任务的会话里顺便读**，不适合单独做状态探测。
- **想知道凭据是否真的有效（不耗模型）**：`claude doctor` 会做非模型的网络请求，无效凭据时输出 `Managed settings (remote): fetch failed — no policy applied (authentication rejected (401))`、`api.anthropic.com rejected this session's credentials (HTTP 401)`。但是纯文本，格式会变，只建议做诊断兜底。实际做法：以 `auth status` 为准，任务运行时遇到 `authentication_failed` 再提示重新登录（见第 5 条）。

### 证据
- `claude auth --help` 子命令：`login [--claudeai|--console|--email|--sso]`、`logout`、`status [--json|--text]`；另有顶层 `setup-token`、`doctor`、`install`、`update`
- 真实配置 / 空配置对比、假 key / 假 token 对比：见本条结论里的原样输出
- 断网测试：`HTTPS_PROXY=http://127.0.0.1:9` 下真实配置仍返回 `loggedIn: true`、退出码 0，约 1 s
- initialize 输出：`init-empty.txt`、`init-real.txt`（后者邮箱已替换为 `<email>`）

### 拿不准 / 需要知道的副作用
- **真实配置下跑 `claude -p` 不是严格只读**：我在真实配置下做 initialize 那次（01:46:50–01:47:06），`C:\Users\10021\.claude.json` 和 `.credentials.json` 的修改时间都变成了 01:47:04。可能是这次启动刷新了 access token / 写了缓存，也可能是同时在跑的桌面应用写的，分不清。事后 `auth status` 仍是 `loggedIn: true`、`loginExpiresAt` 不变，登录没受影响。结论：除了 `--version`、`auth status`、`doctor`，任何真正启动会话的命令都会正常地写配置和刷新令牌——这和用户自己用 Claude Code 时一样，本机程序 spawn 时也会如此。
- 令牌过期但 refresh 还有效时 `auth status` 的表现、真正过期后的 JSON 长什么样，没有条件实测。

---

## 4. 帮用户登录能不能全程不碰终端

### 结论：**能。** `claude auth login` 不需要终端（stdin/stdout 都是管道也能跑），走的是标准 OAuth PKCE + 本机回环回调。
- 流程（隔离的 `CLAUDE_CONFIG_DIR` 实测到「给出浏览器地址」为止）：
  1. 启动后约 1 s，claude 在 **`127.0.0.1:<随机端口>` 上监听**（netstat 实测 `TCP 127.0.0.1:61211 LISTENING`）。
  2. 它调用浏览器打开 `https://claude.com/cai/oauth/authorize?...&redirect_uri=http%3A%2F%2Flocalhost%3A61211%2Fcallback&...`——**回调是本机回环端口**，用户在浏览器点「授权」后浏览器直接跳回 `localhost`，claude 自己收下授权码，不需要粘贴。
  3. 同时在 stdout 打印兜底地址：`If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?...&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback...`，然后打印 `Paste code here if prompted > ` 等待 stdin。这个兜底地址走「网页上显示一段代码 → 粘贴回来」的方式。
  4. 实测 **stdin 粘贴是生效的**：往管道写一个假的 `xxx#yyy`，claude 回 `Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.` 并以 1 退出。所以本机程序可以在网页上放一个输入框，把用户贴的代码写进 claude 的 stdin——即便自动回调失败也不用碰终端。
  5. 成功后官方文档说终端显示 `Login successful`（未实测，因为不能完成登录）。
- **`BROWSER` 环境变量在 Windows 上有效**：设 `BROWSER=<我们的 capture.cmd>` 后，claude 没有打开本人默认浏览器，而是以「完整 URL 作为一个带引号的参数」调用了这个脚本（两次实测都被捕获到）。所以本机程序可以：
  - 设 `BROWSER` 指向自己（比如 `tianshu-local.exe open-url`），拿到 URL 后：本机打开默认浏览器 + 同时推给天枢网页显示「如果没跳转请点这里」；或者
  - 不设 `BROWSER`，让 claude 自己开默认浏览器，本机程序从 stdout 抓 `visit:` 那行做兜底。
- `scope`：`auth login` 申请 `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins`（全功能）。`auth login --console` 走 Console（API 计费）；`--email` 预填邮箱；`--sso` 强制 SSO。
- **`claude setup-token`**：同样的浏览器流程（回环端口、`BROWSER` 同样生效），但 scope 只有 `user:inference`，产出一年期令牌，**只打印、不保存**，要自己设成 `CLAUDE_CODE_OAUTH_TOKEN`。管道模式下 stdout 什么都没打印（像是终端界面没渲染），拿到令牌需要从输出里抠——不适合我们：令牌落到我们手里要自己保管，而且没法用 Remote Control、claude.ai 连接器。**不推荐。**
- **Mac 钥匙串与 `CLAUDE_CONFIG_DIR`**：文档明确写着：设了 `CLAUDE_CONFIG_DIR` 时，`.credentials.json` 放在该目录下，**且 macOS 钥匙串条目也按这个目录区分**，不同目录读不同条目 → 可以隔离。钥匙串写入失败（如 SSH 会话锁住）时回退到 `<配置目录>/.credentials.json`（0600）。Windows 上凭据就是 `%USERPROFILE%\.claude\.credentials.json`（或 `<CLAUDE_CONFIG_DIR>\.credentials.json`）。

### 证据
- `login-run1.txt`：`Opening browser to sign in…` / `If the browser didn't open, visit: ...` / `Paste code here if prompted >`；netstat 显示该 PID 监听 `127.0.0.1:61211` 并有两条到 `160.79.104.10:443` 的连接；`browser\captured.txt` 里是 `redirect_uri=http://localhost:61211/callback` 的地址（已脱敏）
- `setuptoken-run1.txt` + `captured.txt`：监听 `127.0.0.1:55568`，`scope=user:inference`
- `paste-run.txt`：假代码被读取并拒绝
- 文档：https://code.claude.com/docs/en/authentication （“If your browser shows a login code instead of redirecting back after you sign in, paste it into the terminal”；`CLAUDE_CONFIG_DIR` 对钥匙串条目的说明；`setup-token` 一年期、只能做模型请求）
- 文档 env-vars：`CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES` 可让 `claude auth login` 不开浏览器直接换令牌（用于自动化预置，我们用不上）

### 拿不准
- `BROWSER` 不在官方文档的环境变量表里（是 Node 生态的惯例），属于未文档化行为，版本升级可能变；Mac 上没测。
- 回环端口等多久超时、浏览器回调成功后 claude 是否立刻退出（预期打印 `Login successful` 后以 0 退出），没实测。
- 本机已登录时再跑 `auth login` 会覆盖原登录（文档对 Console 免密钥登录写了“会登出 claude.ai 登录”），所以要先查状态再决定要不要拉起登录。
- 用 Claude 桌面应用的用户，桌面应用里的 Claude Code 会话用的是应用自己注入的 OAuth（我们现在的环境里就有 `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` 等变量），**不一定在 `~/.claude/.credentials.json` 里留有 CLI 登录**。这类用户在本机程序里大概率仍显示「未登录」，需要走一次 `auth login`。

---

## 5. 对本机程序的建议

### 推荐流程（网页 ↔ 本机程序）
1. **检测**（本机程序启动时 + 网页打开时调 `/claude/status`）
   - 按第 1 条的路径顺序找二进制 → `--version` → `auth status --json`（spawn 前清掉 `ANTHROPIC_*`、`CLAUDE_*`、`CLAUDECODE`、`MCP_*`、`OTEL_*`，不要清用户自己需要的代理变量）。
   - 返回给网页：`{installed, version, path, loggedIn, authMethod, subscriptionType, loginExpiresAt}`。`authMethod` 不是 `claude.ai` 时（比如用户环境里配了 API key）在网页上标出来。
2. **安装**（网页按钮「安装 Claude Code」）
   - 本机程序后台跑官方脚本或自己按脚本四步下载校验，网页显示阶段和已用时间；完成后用绝对路径 `--version` 复核。不需要管理员，不需要 Git for Windows。
   - 失败时最常见是网络/地区（拿到 HTML 而不是版本号），网页给出「网络无法访问 downloads.claude.ai」的提示。
3. **登录**（网页按钮「登录 Claude」）
   - 本机程序 spawn `claude auth login`（默认 claude.ai 订阅），`BROWSER` 设为本机程序自己的小命令：收到 URL 后用系统默认浏览器打开，并把兜底 URL 推给网页。
   - 网页显示「正在浏览器里等你授权…」，本机程序每 2 s 跑一次 `auth status --json`，或者等 `auth login` 进程以 0 退出。
   - 兜底：网页上放「浏览器显示了一串代码？贴到这里」输入框，本机程序写入 `auth login` 的 stdin。
   - 超时（比如 5 分钟）或网页点取消就结束 `auth login` 进程（Windows 用 `taskkill /T /F`，会连同监听端口一起释放）。
4. **配置目录选择**：建议**用用户默认的 `~/.claude`**（不设 `CLAUDE_CONFIG_DIR`），这样本人在终端里用 Claude Code 和本机程序共用一个登录。若想与本人的个人配置隔离（不跑他的钩子、插件、CLAUDE.md），可以用专属目录如 `%LOCALAPPDATA%\Tianshu\claude-config`，代价是要单独登录一次、`doctor` 会提示 `Config install method: unknown`。隔离在 Windows 和 Mac 都成立（Mac 钥匙串条目按目录区分）。

### 自动更新对 spawn 的影响
- 原生安装默认**后台自动更新**：启动时和运行中检查，下载新版本到 `versions\`，**下次启动生效**。Windows 上 `~/.local/bin/claude.exe` 是一份副本，更新时会被替换；正在跑的会话不受影响（文档：会保留正在运行的版本）。
- 对我们的影响：版本可能在两次 spawn 之间变化（`initialize` 返回里有 `claude_code_version`，可每次记录）；新版偶尔改 CLI 行为（比如 stream-json 字段）。
- 选项：
  - `DISABLE_AUTOUPDATER=1`：只停后台检查，`claude update` 仍可手动更新。
  - `DISABLE_UPDATES=1`：连 `claude update` / `claude install` 都禁掉，适合「由我们分发和控制版本」。
  - 也可以 `autoUpdatesChannel: "stable"`（约晚一周、跳过有严重回归的版本）+ `minimumVersion`。
  - 建议：本机程序 spawn 时**不禁更新**（用户本人的 Claude Code 也要靠它拿安全修复），但在 spawn 的环境里加 `DISABLE_AUTOUPDATER=1`，避免每个任务进程都去检查更新；由本机程序在空闲时统一跑 `claude update`。注意：`DISABLE_AUTOUPDATER` 只影响带这个变量的进程，不改用户的设置。
  - 观察：本机的桌面应用环境里本来就带着 `DISABLE_AUTOUPDATER`（`doctor` 显示 `Auto-updates: disabled (set by env: DISABLE_AUTOUPDATER)`）——这是我从桌面应用继承来的，不是用户设置。

### 未登录 / 凭据无效时 stream-json 吐什么（网页据此提示「请先登录」）
- **未登录**（空配置，发一条用户消息）：不发网络请求，约 5 s 内结束，退出码 1：
  ```json
  {"type":"system","subtype":"init", "apiKeySource":"none", ...}
  {"type":"assistant","error":"authentication_failed","is_api_error_message":true,
   "message":{"model":"<synthetic>","content":[{"type":"text","text":"Not logged in · Please run /login"}], ...}}
  {"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login",
   "terminal_reason":"api_error","api_error_status":null,"duration_api_ms":0,"total_cost_usd":0, ...}
  ```
- **凭据无效 / 过期 / 被吊销**（用假的 `CLAUDE_CODE_OAUTH_TOKEN` 模拟）：先有两条重试事件，再报错，约 3 s，退出码 1：
  ```json
  {"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"error_status":401,"error":"authentication_failed"}
  {"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"error_status":401,"error":"authentication_failed"}
  {"type":"assistant","error":"authentication_failed","message":{"content":[{"type":"text","text":"Failed to authenticate. API Error: 401 OAuth access token is invalid."}]}}
  {"type":"result","subtype":"success","is_error":true,"api_error_status":401,"terminal_reason":"api_error","result":"Failed to authenticate. API Error: 401 OAuth access token is invalid."}
  ```
- **判定规则建议**：看到 `assistant.error == "authentication_failed"`，或 `system/api_retry` 的 `error == "authentication_failed"`（第一次就可以提前中止，不必等重试），或 `result.is_error && api_error_status == 401` → 结束进程，网页提示「Claude 登录已失效，点这里重新登录」。注意 `result.subtype` 在这些情况下仍是 `"success"`，**必须看 `is_error`**。
- 文档里还有 `Login expired · Please run /login` 这种文案（凭据过期且刷新失败），没实测，同样走 `authentication_failed` 判定更稳。

### 其他注意
- `--bare` 模式不读 OAuth 和 `CLAUDE_CODE_OAUTH_TOKEN`，只认 `ANTHROPIC_API_KEY` / `apiKeyHelper`——**我们用订阅登录，就不能加 `--bare`**。
- 在用户默认配置下 spawn 会跑他的 SessionStart 钩子和插件（本机实测 6 个），启动更慢、行为受用户个人配置影响；需要干净行为时考虑专属配置目录。
- `-p` 模式下只要环境里有 `ANTHROPIC_API_KEY` 就一定用它（不问用户），会绕过订阅、按 API 计费——spawn 前清掉是必须的。

---

## 没做 / 没法做的检查
- 没有执行任何安装、没有完成登录（按要求）；`Login successful` 之后的输出、退出码、写入位置未实测。
- 没测 Mac、WinGet、Homebrew、npm 安装形态。
- 没测「令牌快过期 / 已过期但能刷新」的真实账号状态。
