# 03 浏览器夹具运行说明

此目录只准备脚本，没有运行记录。真实 Web/API + 54329 公开测试 PostgreSQL 的一次性数据库；初始应用时间为上海 2026-10-01 10:00，随后按真实时间推进。只读 `seed/placeholders/2026-10-mission-cards.battlefield-01.json`。

## 启动

在仓库根目录分别执行：

```powershell
powershell -NoProfile -File .scratch/onboarding/evidence/03/start-api-fixture.ps1
Get-Content .scratch/onboarding/evidence/03/api-server.log
powershell -NoProfile -File .scratch/onboarding/evidence/03/start-web-preview.ps1
```

API 就绪以 `browser-fixture.json` 中 `ready: true` 为准。只绑定 4500；Web 绑定 3500，副本 `apps/web-03-preview` 和 `apps/web` 同层，src/public 真复制，node_modules 为 junction。已有端口占用会报错，不会关闭任何服务。启动记录先保存受保护端口 PID。

在副本存在期间不要经 pnpm 运行整个 workspace 命令（会发现额外 workspace package）；使用现有 node 工具入口，或结束并清理副本后再做最终全量 pnpm 验证。

## 合成身份

所有身份仅存在于一次性库，固定测试口令 `8742`，已完成首次改码与引导。

| 身份 | 登录 ID | 场景 |
|---|---|---|
| 孙铭泽 | `browsermember` | 灯塔与团队协作两个战场；整理后有本人占位卡；3 个执行事项 |
| 林知行 | `browserdri` | 灯塔当前 DRI，无本人卡但有全部卡读取及拍板权；1 个执行事项 |
| 何望舒 | `browsernocard` | 团队协作的 Mission 负责人，无个人卡；1 个执行事项 |
| 顾清和 | `browserempty` | 无本月战场、Mission 或个人卡登记 |
| 验收 CEO | `browserceo` | 用于夹具真实签发／整理动作 |

`growth` 是灯塔（长本月目标）；`supporting` 是团队协作（短目标）；所有成员访问 `private-field` 都应 404。孙铭泽未整理卡时已有独立 Mission 登记，可先检查本月目标三态。三态由整个月计划状态决定，不能在同一月份伪造各战场不同阶段。

## 控制与建议演练顺序

```powershell
node .scratch/onboarding/evidence/03/browser-control.cjs inspect
node .scratch/onboarding/evidence/03/browser-control.cjs target-none
node .scratch/onboarding/evidence/03/browser-control.cjs target-negotiating
node .scratch/onboarding/evidence/03/browser-control.cjs target-issued
node .scratch/onboarding/evidence/03/browser-control.cjs draft
node .scratch/onboarding/evidence/03/browser-control.cjs open
node .scratch/onboarding/evidence/03/browser-control.cjs advance
node .scratch/onboarding/evidence/03/browser-control.cjs confirm
```

请在各步间拍摄／操作。`target-*` 仅在无轮次时可用；`target-issued` 通过正式签发端点签发。`draft/open/reopen/confirm` 通过正式 Card 中的允许动作执行，不直接修改轮次状态。`near` 将应用时钟推进到截止前 65 秒；`advance` 推进到截止并调用既有快照函数。`confirm` 不跳过待处理意见，存在未处理意见时会报错，需通过 UI 处理。若要验证 DRI 的实际拍板权，请用 `browserdri` 的 UI 执行开放／确认；夹具动作本身使用合成 CEO。

每次 `inspect` 提供实时 `now`、最近拨钟 `clockBase`、卡 id／Owner、Mission、Review 与执行事项数据库事实。它不包含口令、Cookie、密钥或生成 actionId。

## 截图辅助

使用 agent-browser 创建专用浏览器，在其已启动 CDP 端点上运行（建议不同身份使用不同 session）：

```powershell
node .scratch/onboarding/evidence/03/browser-capture.cjs '<CDP URL>' member member-issued
node .scratch/onboarding/evidence/03/browser-capture.cjs '<CDP URL>' dri dri-draft /me/battlefields/growth
node .scratch/onboarding/evidence/03/browser-capture.cjs '<CDP URL>' nocard nocard-home
node .scratch/onboarding/evidence/03/browser-capture.cjs '<CDP URL>' empty empty-home
```

捕获 1440×900、1280×800、834×1194、390×844。保存 PNG 和指标 JSON，检查横向溢出、错误遮罩及桌面首屏执行事项可见性，并读取真实首页与通知状态、核对不可见战场 404。脚本仅截图，不能代替点卡、返回焦点、长目标展开、读卡权限、确认后常驻入口及执行事项改状态的实际 UI 操作。

## 清理

产品源码有最终变更时，先把本次源文件真实同步到副本、重新验证，然后运行：

```powershell
node .scratch/onboarding/evidence/03/browser-control.cjs close
powershell -NoProfile -File .scratch/onboarding/evidence/03/cleanup-preview.ps1
```

`close` 删除本次临时库及合成人员目录。清理脚本对照 src/public 哈希，核查 Next 进程树和受保护端口，解除 junction 后在已核实绝对路径内删除副本；不会触碰 `apps/web/node_modules`。专用 agent-browser 会话由运行方另行关闭。保留 `browser-cleanup.json`、`cleanup-result.json` 与 `browser-source-hashes.json` 作为最终证据。
