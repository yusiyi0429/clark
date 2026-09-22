# Ticket 25 · 注册表对象编辑（战场 / 能力 / 会议基本字段）

状态: planned
来源: assessment-2026-09-22.md 缺口 #1（对象只能建不能改）
视觉基线（已提交）:
- `页面 / 战场管理`（T8oOAH）：战场行 pencil 图标（Edit Icon）+ `Edit Battlefield Popover`（wYsAI，
  战场名称/负责人/目标一句话 + 取消/保存）
- 新页 `页面 / 能力管理`（TjL2X，x=23970）：返回配置 + 能力列表卡（行 = 点/名称/分组·说明/pencil）
  + `Edit Capability Popover`（WUR01）+ 完成按钮
- `页面 / 配置` 新建能力卡 footer：新增 `管理能力` 次按钮（c5Nvq，对称"管理战场"）
- `页面 / Meeting 会前预审`（nszdy）Header Right 新增 `编辑会议 Button`（Q9AKBh）+
  `Edit Meeting Popover`（XLsny，会议标题/时间/主持 DRI 下拉 + 取消/保存）

## 语义决策（已定，不再讨论）

- **id 不变**：战场/能力改名只改显示名，slug id 保持稳定（issues location、月计划、anchors
  全部引用 id，不迁移）。
- **改名去重**：新名字的 slugId 与其他行冲突时 409（避免显示重名），与自身相同不算冲突。
- **战场/能力编辑走 PATCH config 路由**（注册表模式，确定性表单，version+1）；
  **会议编辑走既有 opaque-action 机制**（meeting 有 Card + version 锚）。
- 会议仅 `scheduled` 可编辑；leadDriId 必须在人员目录；scheduledAt 必须可解析。
  更换主持 DRI 时同步 participants 里的 lead 结构（先读现有 createConfigMeeting 的
  participants 构造方式，保持一致）。

## W1 API · 战场/能力 PATCH

- `PATCH /api/config/battlefields/:id` body 部分字段 {name?, owner?, goal?}（goal 写 positioning），
  requireCEO；404 不存在；名称 slug 冲突 409；version+1，updated_at。
- `PATCH /api/config/capabilities/:id` body {name?, "group"?, description?} 同模式
  （capability_config 无 updated_at 列则不加列，只 version+1）。
- contracts 新增两个 Patch request schema + gen:client。
- 测试：改名后 id 不变、投影即时反映；冲突 409；空 body 400 或幂等 200（选一并测死）。

## W2 API · meeting.edit_details Action

- 新 actionType `meeting.edit_details`，输入 {title?, scheduledAt?, leadDriId?}（至少一项）。
- 照既有 meeting action 模式：签名 actionId、version 锚定、fingerprint 幂等、行锁事务；
  仅 scheduled（否则 409 MEETING_NOT_SCHEDULED）。
- Card actions 数组在 scheduled 状态暴露该 action。
- 测试：编辑生效 version+1、重放幂等、completed 409、非法 leadDriId 400。

## W3 Web · 三处编辑 UI

- 战场管理页：行 pencil 图标 → 行内弹层（设计 wYsAI），保存调 PATCH，成功刷新整页投影。
- 新页 `/config/capabilities`（设计 TjL2X）：能力列表 + 编辑弹层；配置页新建能力卡加
  "管理能力"次按钮入口。数据源：新增 `GET /api/config/capabilities`（列表投影）或复用
  capability cards——用现有 `/api/cards/home` 拉太重，加轻量 GET。
- 会议页（MeetingCard header）：scheduled 时显示"编辑会议"按钮 → 弹层（设计 XLsny），
  主持 DRI 下拉用既有人员目录接口；提交走 useCardAction 的 meeting.edit_details。
- 弹层统一 dialog/popover 语义（参照战场删除确认的既有实现模式）。

## W4 验证

- typecheck ×3；API 全量（--maxWorkers=1，测试库 localhost:54329）；contracts、web 测试。
- staging 重建 api+web；curl + 浏览器各验一条链路：改战场名（首页战场卡同步）、
  改能力分组（首页能力面板同步）、改会议时间与主持 DRI（会议页与通知同步）。
- 验证数据用完即删（本 ticket 授权删除自己创建的验证对象）。
- 每 W 一个 commit，不 push。

## 边界

- 不做删除能力、不做会议参与人编辑（lead 之外）、不做议题编辑（另议）。
- 不改 CompanyMemory 人员目录。
