# 本机程序 × 云端接收端联调（11/06）

- 代码：临时分支 `claude/local-runner-sync-e2e` = 本机程序分支 99fec84e + `claude/v2-board-api`（含 04c7befb 接收端、ea1cd926）+ 时间机器种子修复 e1305146；只在本机，没推送。
- 环境：时间机器（一次性测试库 warmap_test_8d7f573737ff，API 4590，已删库），本机程序用 release 编出的 exe（无托盘模式），真 Claude Code 2.1.318（订阅 haiku），本机程序和 API 之间加一个可开关的代理模拟断网。脚本：同目录 `I_cloud-e2e.mjs`（`node I_cloud-e2e.mjs <exe> <api 地址> <网页来源> <输出目录>`）。
- 结果：**通过**，用时 44 秒，模型花费 $0.0043。

## 过程（秒数从脚本开始算）

| 时刻 | 步骤 | 结果 |
|-|-|-|
| 5.8 s | 本机程序配对（无托盘模式自动通过）、加文件夹 | deviceId d8da13ca…，Claude Code 2.1.318 已登录 |
| 6.3 s | 天枢：browsermember 登录 → 建执行事项「verify-e2e 本机交回」→ `POST /api/me/local-devices` 建设备令牌 | 201 |
| 8.0 s | 本机 `PUT /v1/cloud`（地址指向代理） | linked |
| 11.6 s | 开一张卡（cardId = 事项 id），让 Claude 写 note.md、`add_artifact`、`submit_handback` | 批准 1 次写文件，`outsidePaths` 为空 |
| 27.3 s | 第一轮结束，有产出物和交回 | — |
| 27.9 s | 发件箱发空 | pending 0，lastError 无 |
| 28.1 s | **关掉代理（断网）**，插话让它再写 note2.md 并交产出物 | — |
| 36.5 s | 断网时发件箱 | pending 6，lastError「Unable to connect…」 |
| 36.6 s | **打开代理（恢复）** | — |
| 44.3 s | 自动补发完成 | pending 0 |
| 44.3 s | 把断网时留在发件箱的 6 条（status×4、artifact、cost）原样再发一次 | 6 条都回 accepted，0 条拒收 |

## 云端核对（测试库）

- local_sync_items：本会话 13 条、13 个不同的幂等键（status 8、artifact 2、cost 2、handback 1）；local_runs.last_seq = 13，模型「订阅 haiku」、花费 $0.0043 对上。
- local_outputs：note.md、note2.md 两份，文件已存（note2.md 是断网后补发上来的）。
- card_handbacks：一条交回，完成标准「有 note.md」= met，证据 note.md，排队等 Agent 验收。
- tasks：事项从未开始变成进行中；local_devices.last_sync_at 有值、app_version = 0.1.0。
- 去重：原样重发的 6 条之后，表里条数不变（还是 13 条、2 份产出）。

## 顺带发现

- 设备令牌连 /mcp/me 现在是 401（接收端提交说明里写了，等改成只读），会话里的天枢 MCP 连不上，不影响开工和交回。
- 测试结尾强停后马上关掉本机程序，最后一条「已停」状态留在发件箱（下次启动会补发），是测试收尾方式造成的。
