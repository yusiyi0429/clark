# 成员工作台与信号发送 · 设计

- 日期：2026-09-24
- 状态：设计已逐节确认，待用户审阅本文件
- 决策人：孙铭泽（产品）；本文件记录与 Claude 的逐项讨论结论

## 0. 背景与目标

天枢 MVP 目前只有 CEO 一个角色。登录用一个共用的 CEO 密码，会话 cookie 里不记录是谁。人员名单是一个 9 人的 seed 文件。通知不落库，由 CEO 首页卡片即时算出来。DRI 只能通过机器令牌接口（`/api/dri/*`）对接，而且没有任何调用方。

本次要做到：

1. CEO 在信号阅读页把一条信号**发送给**某个人、某个战场或某个业务域。
2. 收件人在自己的**通知栏**里收到。
3. 收件人可以把它**转为自己的执行事项**，内容由自己定义。
4. 信号的收件人与 CEO 自动进入这条信号的**事项群组**（群聊）。执行事项也有自己的事项群组，推进人可以直接把同事拉进来。
5. 成员（DRI、战场参与者）和 CEO 都在这一个仓库、这一个应用里，**每个人用自己的身份登录**。
6. 部署到线上，供内部测试。

## 1. 已确认的决定

| 议题 | 结论 |
|---|---|
| 登录方式 | 不接飞书等 OA，用**登录 ID + 自己设定的 4 位数字口令** |
| 登录 ID 规则 | 姓全拼 + 名的首字母，如 `sunm`、`liur`、`bait` |
| 首次登录 | 管理员给每人发随机 4 位**初始码**；首次登录后必须改成自己的 4 位口令 |
| CEO 登录 | 同样用 ID + 4 位口令（`lium`），取消原来的 CEO 长密码 |
| 部署 | 概念版所在的 ECS `tokenhub-prod-app-01`；真实站点 `mvp.tokenkingos.com`（已备案域名的子域名）；`mvp.tkos.ai` 做 301 跳转（.ai 无法备案，不能直接解析到大陆服务器） |
| 发给战场或业务域时谁收到 | 范围内相关的人各收一份（规则见 §3.2） |
| 群聊 | 一条信号一个事项群组，成员为 CEO 加所有收件人；每个执行事项各有一个事项群组 |
| 拉人进执行事项 | 像微信小群一样，被拉进来就直接加入，不需要「接受邀请」；可以自己退出 |
| 架构 | 一个 Next 应用 + 一个 API，按身份区分能看什么、能做什么；成员页面在 `/me/...` |
| 更新方式 | 定时刷新，不做推送 |

## 2. 身份、登录与部署

### 2.1 登录 ID

登录 ID 由 seed 里的 `personId`（`姓-名`）推出：姓全拼 + 名的首字母。当前 9 人没有重名：

| 姓名 | ID | 姓名 | ID | 姓名 | ID |
|---|---|---|---|---|---|
| 刘明华（CEO） | lium | 孙铭泽 | sunm | 秦梦怡 | qinm |
| 白田田 | bait | 陈溪南 | chenx | 唐巨杰 | tangj |
| 刘人豪 | liur | 王创峰 | wangc | 于斯一 | yus |

以后新增的人如果推出来重名，由发码脚本报错，改为手工指定 ID，不自动加数字。

### 2.2 凭据存储与发码脚本

- 新表 `member_access` 保存每人的凭据：
  - `person_id`（主键）
  - `login_id`（唯一）
  - `passcode_hash`：scrypt 加盐散列
  - `must_change`：是否仍是初始码
  - `failed_count`、`locked_until`
  - `session_version`：重置后旧会话立即失效
  - `updated_at`
- 发码脚本 `pnpm --filter @warmap/api access:issue [personId...]`：
  - 不带参数时，给 seed 里所有还没有凭据的人发码。
  - 带参数时，给指定的人重置。
  - 每次都生成随机 4 位初始码（排除 `0000`、`1234` 这类弱码），置 `must_change=true`，并让 `session_version` 加 1。
  - 在终端打印「姓名 / ID / 初始码」表格，由管理员分发。初始码只出现在这次输出里，不写入仓库和日志。
- `person_id` 必须存在于 company-people seed 中；seed 里的人被删掉后，他的凭据随之失效（登录时校验）。

### 2.3 登录流程与接口

- `POST /api/auth/login {loginId, passcode}`
  - 口令正确且已改过：签发会话，返回 `{role, mustChangePasscode:false}`。
  - 口令正确但仍是初始码：**不签发会话**，返回 `{mustChangePasscode:true}`。
  - 口令错误：`401 INVALID_CREDENTIALS`，`failed_count` 加 1。连续 5 次后锁 15 分钟，锁定期间返回 `423 ACCOUNT_LOCKED {retryAfterSeconds}`，即使口令正确也不放行。成功登录后清零。
  - ID 不存在时同样返回 `401 INVALID_CREDENTIALS`，不暴露 ID 是否存在。
- `POST /api/auth/passcode {loginId, passcode, newPasscode}`
  - 先校验当前口令（初始码或已设的口令），再要求新口令是 4 位数字且不等于当前口令。
  - 保存新口令，置 `must_change=false`，`session_version` 加 1，然后签发会话。
  - 锁定规则与 login 相同。
- `POST /api/auth/logout`：任何已登录的人都可调用，清除 cookie。
- `GET /api/auth/session` → `{authenticated, personId?, displayName?, role?}`。
- 两个写接口都保留 Origin 校验。每个 IP 的频率上限从 5 次/分钟调到 20 次/分钟，避免办公室共用出口 IP 时误伤；防暴力破解以按 ID 锁定为主。

### 2.4 会话

- 继续使用签名 cookie `warmap_session`（HttpOnly; Secure; SameSite=Strict）。payload 改为 `{exp, pid, role, v}`。
- 身份（`role`）按 seed 判断：roles 含 `ceo` 的是 `ceo`，其余是 `member`。
- 旧格式 cookie 一律视为未登录。
- 有效期统一为 30 天：`SESSION_MAX_AGE_SECONDS` 默认值改为 2592000。
- API 校验时比对 `v` 与数据库里的 `session_version`，不一致就是 401。这是会话唯一一次查库，一条主键查询。

### 2.5 权限检查

- API：
  - `requireCEO`：会话有效且 `role=ceo`。所有现有 CEO 接口都换成它，行为对 CEO 不变。
  - `requirePerson`：任何有效会话，并把 `{personId, role}` 交给接口。成员接口用它，接口内部再检查这个人是否与该对象相关。
  - DRI 服务令牌和 MCP 令牌的检查保持不动。
- 网页：
  - `(ceo)` 路由组读取会话：没登录去 `/access`；是成员就去 `/me`。
  - 新的 `(member)` 路由组：没登录去 `/access`；是 CEO 就回 `/`。
  - 登录成功后按身份去 `/` 或 `/me`；带 `next` 参数时回到原页面，前提是身份匹配。

### 2.6 部署

- **位置**：ECS `tokenhub-prod-app-01`（115.191.26.230），与概念版同机。
- **Compose**：
  - `edge`（Caddy）不再申请证书、不再占用 80/443。改为只监听 HTTP，端口映射 `127.0.0.1:3130:80`，继续负责 `/api/*`（含 SSE flush）、`/mcp/*` 与页面的分流。
  - 其余服务不变：postgres、storage-init、wechat、api、web。
- **主机 Nginx**：新增站点 `mvp.tokenkingos.com`。
  - 80 端口 301 跳到 https。
  - 443 端口用 Let's Encrypt 证书（certbot 或 acme.sh，自动续期），`proxy_pass http://127.0.0.1:3130`。
  - `proxy_buffering off`（SSE），`proxy_read_timeout 600s`（Radar 扫描、会议材料处理），`client_max_body_size 101m`（与 API 材料上传的 `bodyLimit` 101 MiB 一致）。
- **环境变量**：
  - `PUBLIC_ORIGIN=https://mvp.tokenkingos.com`。
  - 删除 `CEO_ACCESS_PASSWORD_HASH`（`.env.example`、compose、`server.ts`、`scripts/hash-password.mjs`）。
- **目录与密钥**：参照概念版，发布目录 `/srv/tokenhub/apps/tianshu/`，运行密钥 `/etc/tokenhub/tianshu.env`（root，600）。
- **部署脚本** `infra/ecs/deploy-tianshu.ps1`：打包当前代码（不含密钥和本地数据），传到服务器后校验 SHA-256，再执行 `docker compose up -d --build`。首次上线后运行发码脚本。
- **需要有权限的人完成**：
  - DNS 解析 `mvp.tokenkingos.com → 115.191.26.230`；
  - 阿里云安全组放行 443；
  - `mvp.tkos.ai` 在 DNS 服务商处设置 301 跳转到 `https://mvp.tokenkingos.com`。
- **上线前检查**：ECS 的内存和磁盘余量，要同时跑概念版和天枢整套；备份脚本 `infra/backup` 的 crontab。
- **发布本身**要等用户明确说「上」才执行。

## 3. 数据与权限

### 3.1 新增的数据（每一步各自一个迁移，从 `023_member_access.sql` 开始）

| 表 | 字段要点 |
|---|---|
| `member_access` | 见 §2.2 |
| `signal_shares`（发送记录） | `id`、`signal_id`、`sender_id`、`target_type`（person／battlefield／capability）、`target_id`、`target_label`（发送时的名称快照）、`note`（附言，≤500 字，可空）、`request_id`（唯一，防重复提交）、`created_at` |
| `signal_recipients`（信号群成员，不含 CEO） | `signal_id`、`person_id`、`first_share_id`、`added_at`，主键 `(signal_id, person_id)` |
| `tasks`（执行事项） | `id`、`version`、`title`（≤120 字）、`done_definition`（完成时留下什么）、`judgment`（这件事的判断）、`due_date`（可空）、`status`（not_started／in_progress／done）、`owner_id`（推进人，即创建者）、`origin_signal_id`（可空）、`created_at`、`updated_at`；`(owner_id, origin_signal_id)` 在来源非空时唯一 |
| `task_members` | `task_id`、`person_id`、`role`（owner／collaborator）、`added_by`、`added_at`、`left_at`（可空），主键 `(task_id, person_id)` |
| `thread_messages`（群消息） | `id`（自增）、`thread_type`（signal／task）、`thread_id`、`author_id`、`body`（≤2000 字）、`client_id`、`created_at`；`(author_id, client_id)` 唯一，防重复发送 |
| `thread_reads` | `person_id`、`thread_type`、`thread_id`、`last_read_id`，用于计算未读数 |
| `notifications` | `id`、`person_id`、`kind`、`object_type`、`object_id`、`actor_id`、`created_at`、`read_at` |

- **一条信号只有一个群**：同一条信号多次发送，收件人都并入 `signal_recipients`，共用一个事项群组。群成员 = CEO + `signal_recipients`。
- **执行事项的群成员** = 推进人 + 未退出的协作者。

### 3.2 收件人规则

发送前后都由服务端按同一套规则计算：

- **人**：就是这个人。
- **战场**：战场 DRI（`battlefield_config.owner_id`），加上本月所有 `battlefield_ids` 含该战场的 Mission 的 DRI（`missions.owner_id`）。
- **业务域**：本月所有 `capability_id` 为该业务域的 Mission 的 DRI。
- 「本月」按 `companyPeriod(now)`，与首页口径一致。
- 去掉发送人本人、空的「待指派」，以及已经不在 seed 里的人；最后去重。
- 结果为空时拒绝发送（`422 NO_RECIPIENTS`），并说明原因：「这个战场本月还没有 Mission DRI」「这个业务域本月还没有 Mission」等。
- 已经在群里的人再次被发到：不重复入群，但会再收到一条「发给你」的通知，内容带上这次的附言。
- 按当前数据：发给「灯塔项目」→ 白田田、刘人豪、孙铭泽、陈溪南；发给「Agents」→ 刘人豪、孙铭泽、陈溪南。

### 3.3 通知

| kind | 收件人 | 文案 | 性质 |
|---|---|---|---|
| `signal_shared` | 每个收件人 | 「刘明华 发给你一条信号 · 灯塔项目」 | 待你看，打开信号页即已读 |
| `task_added` | 被拉进来的协作者 | 「刘人豪 把你拉进了执行事项「…」」 | 仅知悉 |
| `signal_converted` | 信号发送人（CEO） | 「孙铭泽 把你发的信号转成了执行事项「…」」 | 回复与结果 |

- 群里的新消息**不**逐条生成通知。按群计算未读数（`thread_messages.id > thread_reads.last_read_id`），在通知栏显示为「N 条新消息」。
- 通知只存「指向哪个对象」，不复制对象内容；显示时读取对象的当前状态（SSOT C-05）。对象已不可见时（例如已退出执行事项），点开显示对应空态。

### 3.4 权限

| 能力 | CEO | 信号收件人 | 执行事项推进人 | 执行事项协作者 |
|---|---|---|---|---|
| 发送信号、预览收件人 | ✓ | ✗ | — | — |
| 看信号正文、在信号群里说话 | ✓ | ✓（只能看发给自己的） | — | — |
| 看每个收件人的回音 | ✓ | ✗ | — | — |
| 把信号转成执行事项 | ✗ | ✓（转成自己的，每条信号限一次） | — | — |
| 新建执行事项（不从信号来） | ✗ | 所有成员都可以 | — | — |
| 看执行事项、在它的群里说话 | ✗ | — | ✓ | ✓ |
| 改标题、完成定义、判断、截止、状态 | ✗ | — | ✓ | ✗ |
| 拉人 | ✗ | — | ✓ | ✗ |
| 退出 | — | — | ✗ | ✓ |

- 成员看不到雷达列表、议题、会议、月度计划、Mission 等 CEO 内容。
- CEO 不自动进入执行事项的群，只在信号回音里看到「标题 · 状态」。
- 拉人的候选范围是 seed 里所有人（CEO 除外），不能拉自己。

### 3.5 接口

成员与 CEO 共用（`requirePerson`）：

- `GET /api/me/notifications` → 通知列表（未读在前，最近 50 条）和各群未读数。
- `POST /api/me/seen {objectType, objectId, lastMessageId?}` → 该对象的通知标为已读，并推进群的已读位置。页面打开时、看到新消息时调用。
- `GET /api/people/directory` → `{personId, displayName}[]`，供拉人使用。现有的 `/api/people` 仍然只给 CEO。
- `GET /api/threads/:type/:id/messages?after=<id>`、`POST /api/threads/:type/:id/messages {body, clientId}` → 只有群成员能读写，否则返回 `403 NOT_IN_SCOPE`。

只给成员（`requirePerson` 且 `role=member`）：

- `GET /api/me/home` → `{myTasks, joinedTasks, receivedSignals}`。
- `GET /api/me/signals/:signalId` → 阅读所需的信号内容、发给我的那些发送记录（发送人、对象名称、附言、时间）、群成员、我从它转出的执行事项（如有）。不是收件人时返回 `403 NOT_IN_SCOPE`。
- `POST /api/me/tasks {title, doneDefinition?, dueDate?, collaboratorIds?, fromSignalId?}`：`fromSignalId` 要求本人是收件人，且同一条信号没有转过。
- `GET /api/me/tasks/:id`
- `PATCH /api/me/tasks/:id {version, title?, doneDefinition?, judgment?, dueDate?, status?}`：只有推进人能改，版本不一致时返回 `409`。
- `POST /api/me/tasks/:id/members {personIds}`：只有推进人能拉人，被拉的人收到 `task_added`。
- `DELETE /api/me/tasks/:id/members/me`：协作者退出。

只给 CEO（`requireCEO`）：

- `GET /api/signals/:id/share-preview?targetType=&targetId=` → `{recipients:[{personId, displayName}], emptyReason?}`。
- `POST /api/signals/:id/shares {targetType, targetId, note?, requestId}` → 发送记录与收件人。同一个 `requestId` 重复提交返回同一结果。
- `GET /api/signals/:id/shares` → 发送记录，以及每个收件人的回音：未读／已读／已转为执行事项（标题、状态）。
- CEO 在信号群里说话复用上面的 threads 接口。

成员相关数据用普通的 TypeBox 视图对象返回，不走 CEO 的 Card/Action 签名。Card 模式服务的是 CEO 决策面（ADR-0002），这里没有需要签名的卡片动作。契约先写进 `packages/contracts` 与手写的 `openapi.ts`，再运行 `gen:client`。

## 4. 页面

视觉沿用概念版 DRI 工作台（clark-main `src/components/dri/*`）的样式和 ts-design，不另起风格。二级页页头、左内容右对话的结构遵循 SSOT C-02 与 C-08。

### 4.1 锁屏 `/access`

- 外观不变。输入框改为「ID」和「4 位口令」两个，口令框只接受数字、最多 4 位。
- 返回 `mustChangePasscode` 时，输入区原地换成「设置你的 4 位口令」，输入两遍，一致才提交。
- 错误文案：
  - ID 或口令不对：「ID 或口令不对」；
  - 锁定：「已连续输错 5 次，请 N 分钟后再试」；
  - 其余沿用现有的失败文案。
- 不做「修改口令」页面，忘记口令由管理员用脚本重置。

### 4.2 成员工作台 `/me`

- **左侧通知栏**：概念版的玻璃通知栏，分组顺序沿用 DRI-05。
  - 「任务指派与邀请」：`signal_shared`、`task_added`。
  - 「回复与结果」：各群的新消息。
  - 某组为空时不显示；「今日会议」「本月 Mission Card」本次没有数据，不显示。
- **主区**：
  - 「我的执行事项」：我推进的，右上角「开启 执行事项」。
  - 「我参与的执行事项」：我是协作者的。
  - 「发给我的信号」：历史。
  - 每行写标题、来源（来自信号／自己开启）、协作者和状态。
- **左上角锁图标**：退出登录。
- **不做**：战场卡、本月任务、底部「与天枢」输入条。
- **手机**：沿用概念版 DRI 工作台的手机布局。

### 4.3 成员看信号 `/me/signals/[id]`

- **页头胶囊**：返回工作台，眉题「刘明华 发给你 · 灯塔项目」（多次发送时列最近一次，其余在附言区列出），关闭。
- **左侧**：
  - 附言在最上面。
  - 下面是与 CEO 相同的阅读排版：总结、对我们的影响（含战略锚点）、原文（摘录、配图、展开、出处、阅读原文）。与 CEO 共用同一套阅读组件，去掉收藏、隐藏、已读切换和「继续浏览」。
  - 「转为我的执行事项」：弹窗填写标题（空着，自己写）、完成时留下什么（可选）、截止（可选）、拉谁一起（可选）；创建后打开执行事项页。转过之后，按钮位置改为「已转为执行事项「…」」，可以点开。
- **右侧**：事项群组，含成员浮层和消息列表；输入框发送。

### 4.4 执行事项页 `/me/tasks/[id]`

照概念版 `TaskPane` 的结构：

- **页头**：返回，眉题「执行事项 · 某某在推进」（本人是推进人时写「你在推进」），标题。
- **左侧**：
  - 来源：「来自信号「…」」（收件人可点开）或「自己开启」。
  - 状态：未启动／进行中／完成，推进人用切换按钮，其他人只读。
  - 截止、参与人员；推进人有「拉人」。
  - 「完成时留下什么」「这件事的判断」：推进人可编辑保存，其他人只读。
  - 协作者有「退出这件事」，确认弹窗用现有的 `ConfirmDialog`。
- **右侧**：这件事的事项群组。

### 4.5 CEO 侧改动

- **信号阅读页**：
  - 页头加「发送给」按钮（纸飞机图标）。
  - 点开是 HeroUI Modal：先选人／战场／业务域（切换按钮），再选具体对象（下拉），然后自动预览收件人；可写附言，点发送。收件人为空时发送按钮禁用，并显示原因。
- **发过的信号**：
  - 文章 meta 下多一行「已发给 N 人」，展开后逐人显示回音：未读／已读／已转为执行事项「标题 · 状态」。
  - 右侧对话栏顶部出现「与天枢 | 事项群组 · N」切换，样式照概念版 `ToggleButtonGroup`。没发过的信号只有「与天枢」，与现在一样。
- **信号列表卡片**：发过的，状态处标「已发送」。
- **CEO 通知栏**：在现有分组之后新增「回复与结果」，放 `signal_converted` 与信号群的新消息。数据来自 `/api/me/notifications`，现有分组的计算方式不变。

## 5. 刷新与出错处理

- **通知**：每 20 秒刷新一次，窗口重新获得焦点时立刻刷新。
- **群聊**：打开时每 3 秒请求一次 `after=<最后一条 id>`。自己发的消息先显示，失败标红可重发；用 `clientId` 防止重复。
- **页面在后台时**（`document.visibilityState=hidden`）停止刷新。
- **发送信号**：
  - 失败时弹窗不关，在弹窗内显示错误，可以重试。
  - `requestId` 让连点只发一次。
- **转为执行事项**：重复转换返回 `409 ALREADY_CONVERTED`，页面改为显示已有的执行事项。
- **无权访问**：显示「这件事不在你的范围内」加返回工作台，不返回任何内容。对象不存在：「找不到这件事」加返回。
- **退出执行事项后**：再打开显示「你已退出这件事」。
- **会话过期**：接口返回 401，带当前页面作为 `next` 回到锁屏。
- **编辑冲突**：推进人在两个窗口同时改时返回 `409`，提示「这件事刚被改过，已刷新到最新」。

## 6. 测试

- **API**（现有真实 Postgres 测试方式，`TEST_PG_URL`）：
  - 登录：初始码不签发会话、改口令后签发、5 次锁定与 15 分钟解锁、ID 不存在与口令错误的响应一致、重置后旧会话失效。
  - 身份：成员调用任一 CEO 接口得到 401／403；CEO 调用成员专用接口被拒绝。
  - 收件人：人、战场、业务域；本月口径；去掉发送人与待指派；去重；为空时 422。
  - 发送：`requestId` 幂等；重复收件人不重复入群，但收到新通知。
  - 执行事项：从信号转化（非收件人被拒、每条信号一次）；只有推进人能编辑；版本冲突；拉人会发通知；协作者退出后不能再读写群。
  - 群消息：非成员 403；`after` 分页；`clientId` 幂等；未读数计算。
- **网页**：沿用 `renderToStaticMarkup` 的组件测试，覆盖锁屏两个阶段、成员工作台分组、信号页已转化与未转化两种状态、执行事项页推进人与协作者两种视角、CEO 发送弹窗的空收件人状态。
- **浏览器实测**：`127.0.0.1:3100` 与 `localhost:3100` 的 cookie 互相隔离，一边登录 CEO、一边登录成员，走完完整链路：
  1. CEO 发送；
  2. 成员收到通知并打开；
  3. 双方在群里对话；
  4. 成员转为执行事项并拉人；
  5. 被拉的人收到通知；
  6. CEO 看到回音。

  再在 390px 宽度下走一遍。
- **部署后**：按上线手册跑一遍 smoke，覆盖登录、首页、一个成员账号和 SSE。

## 7. 分步

每步独立验收，前一步通过才开始下一步：

1. **身份与登录**：
   - 内容：迁移（`member_access`）、发码脚本、登录与改口令接口、新会话、`requireCEO`／`requirePerson`、两个路由组的身份跳转、锁屏两阶段、`/me` 空工作台与退出、删除 CEO 长密码配置。
   - 验收：9 人都能用自己的 ID 进入各自的地方；成员进不去 CEO 页面和接口；CEO 的现有功能不受影响。
2. **发送与收件**：
   - 内容：`signal_shares`／`signal_recipients`／`notifications`、预览与发送接口、CEO 发送弹窗与回音行、成员信号页、两边通知栏。
3. **事项群组**：`thread_messages`／`thread_reads`、群消息接口、CEO 右栏切换、成员信号页群组、未读数。
4. **执行事项**：`tasks`／`task_members`、新建与转化、执行事项页、拉人与退出、`task_added`／`signal_converted` 通知、CEO 回音显示执行事项状态。
5. **部署**：Compose 的 edge 调整、Nginx 站点与证书、部署脚本、上线手册；等用户确认后发布。

## 8. 需要同步更新的文档

- 新增 `docs/adr/0020-members-sign-in-and-own-execution-items.md`：
  - 推翻 ADR-0001「WarMap 只承担 CEO 决策，不承担任务执行」中「不承担任务执行、单 CEO」的部分。
  - 推翻目标设计 v0.3 的非目标「项目管理和任务执行」「DRI 工作台或多人协作」，以及「单 CEO 登录」「单 CEO MVP 不保存已读」两处。
  - 说明范围仍然很窄：只有执行事项与事项群组，不做项目管理和看板。
- `CONTEXT.md`：
  - 新增词条：成员（Member）、登录 ID、执行事项（Task）、事项群组、发送（信号）。
  - 修订「DRI」（MVP 中可以登录成员工作台）与「CEO WarMap」（不再只是单 CEO）的描述。
  - 「DRI Handoff」保持不变：它仍然走机器令牌的导出边界，与本次的「发送」是两回事。
- 与 SSOT 的差异：DRI-05a 要求先「接受邀请」，本设计改为被拉即加入。SSOT 在 clark-main 仓库，由用户决定是否同步修订。
- `.env.example`、`infra/staging/runbook.md`：登录变量和部署方式的变化。

## 9. 不做与已知缺口

- 执行事项不挂到 Mission 或个人任务上。天枢还没有个人 Mission Card；SSOT DRI-04 要求「所属个人任务」，本设计暂时用「来源信号／自己开启」代替，列为已知缺口。
- 成员没有「与天枢」智能体对话，右栏只有事项群组。
- 没有飞书、微信、邮件等外部提醒，成员要打开网站才能看到通知。
- 没有「修改口令」页面，没有推送，CEO 不能打开执行事项页。
- 不迁移概念版 `/dri` 的其余内容：个人 Mission Card、月初 48 小时制定、会议、交接包等。这些留给后续子项目。
