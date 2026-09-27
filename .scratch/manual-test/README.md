# 时间机器测试环境

用来手动测试那些要等真实时间的流程：
- 本月 Mission Card 的 48 小时讨论、截止快照、集中 Review、确认、确认后更正、跨月只读；
- 反复重看首次登录引导。

每次启动都是一套全新的一次性测试库（54329 上的 `warmap_test_*`）和合成身份，关掉就删，不碰开发库 5432。

## 启动与关闭

在仓库根目录用 PowerShell 7：

```powershell
pwsh -NoProfile -File .scratch/manual-test/start.ps1   # 启动：API 4500 + 网页 3500
pwsh -NoProfile -File .scratch/manual-test/stop.ps1    # 关闭：删库、停网页、删副本
```

- **电脑**：打开 `http://localhost:3500`。
- **手机**（和电脑同一个 Wi‑Fi）：打开 start.ps1 最后打印的地址，例如 `http://192.168.124.44:3500`。
- **第一次打开要编译**，等 10–30 秒。
- **网页是启动那一刻的代码副本**。改了代码要先 stop 再 start。
- **环境运行期间不要跑 pnpm 的全仓库命令**：副本 `apps/web-manual-preview` 会被当成第二个 `@warmap/web`。

## 合成身份

口令都是 `8742`，只存在于一次性测试库，已完成首次改码和引导。

| 登录 ID | 人 | 场景 |
|---|---|---|
| `browserceo` | 验收 CEO | CEO；月度计划已签发 |
| `browserdri` | 林知行 | 灯塔项目的 DRI（拍板人）；没有本人卡，1 个执行事项 |
| `browsermember` | 孙铭泽 | 灯塔与团队协作两个战场；整理后有本人卡；3 个执行事项 |
| `browsernocard` | 何望舒 | 团队协作的 Mission 负责人，没有个人卡；1 个执行事项 |
| `browserempty` | 顾清和 | 本月没有任何战场、Mission 或个人卡 |

## 拨钟与推进

在仓库根目录执行 `node .scratch/manual-test/control.cjs <命令>`：

| 命令 | 作用 |
|---|---|
| `inspect` | 打印当前应用时间、轮次、卡、意见、Review、更正与执行事项 |
| `draft` | 用 CEO 身份整理灯塔项目 10 月个人卡草稿（也可以在界面上点） |
| `open` | 统一开放 48 小时讨论（也可以在界面上点） |
| `near` | 把时钟拨到截止前 65 秒 |
| `advance` | 把时钟拨到截止，生成截止快照，进入集中 Review |
| `reopen` | 重新开启 48 小时 |
| `confirm` | 确认（要求所有意见都已处理） |
| `confirm-all` | 一步完成：整理 → 开放 → 截止 → 确认（没有意见时） |
| `next-month` | 把时钟拨到上海 11 月 1 日 10:00，10 月的卡变只读 |
| `welcome-member` | 重置孙铭泽的首次登录引导，下次登录会再走一遍 |
| `welcome-dri` | 重置林知行的首次登录引导 |
| `welcome-ceo` | 重置验收 CEO 的首次登录引导 |
| `target-none` / `target-negotiating` / `target-issued` | 本月目标的三种状态；只能在整理草稿之前用 |

时钟只往前拨，不能倒回。想从头来，stop 再 start。

- 声纹：合成环境里没有接，引导里不会出现声纹那一步。
- 雷达扫描：没有接外部检索，雷达只能看设置。
- 声纹和雷达请在开发环境（3200）测。
