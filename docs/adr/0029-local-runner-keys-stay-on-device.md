# 模型钥匙和同步令牌只存在本人电脑上

2026-11-06 决定。适用于 `apps/local`。

## 背景

本机程序拉起 Claude Code 时，每张卡可以用本人的 Claude 订阅（本人自己的登录），也可以用公司 TokenHub 的钥匙（Anthropic 格式的网关地址）。本机程序还要拿一个个人令牌把结果单向报给天枢云端。11 月已定：钥匙只存在本机，不传给天枢。

## 决定

- **存哪**：Windows 用 DPAPI（CurrentUser 作用域）加密后存进数据目录的 `secrets.json`，只有本人登录这台 Windows 时能解开；macOS 存登录钥匙串（服务名 `tianshu-local`）。其他平台和测试才用 0600 的明文文件。
  - Windows 没选凭据管理器：要 P/Invoke `CredRead/CredWrite`，DPAPI 同样绑在本人账户上，实现更简单。
- **明文不过命令行**：加解密都经子进程的 stdin/stdout（PowerShell 的 `ProtectedData`、`security -i`），不放 argv。
- **接口只写不读**：网页 `PUT /v1/models/:id` 可以写钥匙；任何接口只回 `hasKey`，不回钥匙；云端令牌同理。
- **拉起 Claude Code 时**：网关地址和模型名放 `--settings` 的 env（盖过本人全局配置，11/05 实测）；钥匙放进程环境变量 `ANTHROPIC_AUTH_TOKEN`，不进命令行（macOS 上同机其他用户用 `ps` 看得到 argv）。只有打开「带上个人配置」时，因为本人全局 settings 里的同名变量会盖过进程环境，才把钥匙也放进 `--settings`。
- **MCP 里的密钥**：会话挂的 MCP 要带本会话密钥和云端令牌，`mcp.json` 里只写 `${TIANSHU_SESSION_SECRET}`、`${TIANSHU_CLOUD_TOKEN}`，值经子进程环境变量传，Claude Code 启动时展开（11/06 实测），文件里没有明文。
- **订阅登录**：本机程序不读、不存、不转发本人的 Claude 登录凭据，只是在本人环境里拉起官方 `claude`，用它自己的登录。
- 子进程环境变量走白名单，不继承桌面应用注入的 `ANTHROPIC_*`、`CLAUDE_*`：否则会被冒充成别的登录（`auth status` 只认有没有凭据，假 key 也显示已登录），或按 API 计费。

## 代价

- 钥匙仍会出现在 Claude Code 子进程的环境变量里，本人账户下的其他进程能读到；这和本人自己在终端里设环境变量一样。
- 换电脑或重装系统要重新填钥匙（DPAPI 解不开别的机器上的文件）。
