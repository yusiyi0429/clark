# Ticket 22 · 配置页卡片化重构 + 战场管理页

状态: planned
视觉基线: `UpgradeDesign.pen` — `页面 / 配置`（LlNbX，2×2 卡片阵）、`页面 / 战场管理`(T8oOAH)
前置决策（用户已拍板）:
- PPT 不支持，Material 仍仅 PDF/DOCX/Markdown（设计稿文案已改，fb00c17）
- 议题↔战场映射走方案 A：集合语义 + 确定性归一化到现有 `IssueLocation`，零迁移

## 归一化规则（方案 A，全部工作包共用）

`normalizeBattlefieldSet(ids)`：0 个 → `company + relatedBattlefieldIds: []`（显示"未归属"）；
1 个 → `battlefield + battlefieldId`；≥2 个 → `company + [排序去重]`。
边界：capability 级议题不参与（主归属是能力，选择器排除、Action 拒绝 400）；
仅 pending 议题可调整；`promotion_fingerprint` 是创建时去重指纹，不重算。

## W1 后端 · 议题关联集合 Action

- `apps/api/src/issues.ts`：纯函数 `battlefieldSetOf(location)`（capability→null）与 `normalizeBattlefieldSet(ids)`；
  `assignIssueBattlefield` / `unassignIssueBattlefield`（行锁事务、仅 pending、assign 校验战场已注册、version+1）。
- 路由（requireCEO，确定性配置语义，不走 opaque-action）：
  `POST /api/config/battlefields/:id/issues` body `{issueId}`；
  `DELETE /api/config/battlefields/:id/issues/:issueId`。
- 测试：2→1 自动降级 battlefield 级；1→0 变 company+[]；capability 议题 400；decided 议题 409。

## W2 后端 · 删除战场（级联解除关联）

- `deleteBattlefield(pool, id)` 单事务：锁全部受影响议题（battlefield 级 = id，或 company 集合含 id）
  逐个移出+归一化；删 `battlefield_config` 行；`radar_config.anchors` 过滤掉 location 引用该战场的 ontology anchors
  （参照 monthlyPlans.ts L491 重建逻辑，只删不建）。月度计划 JSONB 自包含快照，不动。
- 路由 `DELETE /api/config/battlefields/:id`；404 不存在。
- 允许删光战场；配置页新建议题表单空态提示"先注册战场"（提交本来就 400 INVALID_LOCATION）。
- 测试：company[A,B] 删 A → battlefield:B；battlefield:A 删 A → 未归属；anchors 同步。

## W3 后端 · 管理页投影

- `GET /api/config/battlefields`（requireCEO）一次返回整页数据：
  `battlefields: [{id,name,owner,pendingIssueCount}]`；
  `issues: [{id,title,urgencyLevel,decisionBy?,battlefieldIds:[]}]`（仅 pending、排除 capability 级；
  battlefieldIds 即归一化集合，未归属=[]）。
- contracts 新 schema + `pnpm --filter @warmap/web gen:client`。

## W4 后端 · 配置页建会带材料

- `POST /api/config/meetings` 改 multipart：字段 title/scheduledAt/leadDriId（+可选 issueIds）+ 可选 files[]。
  服务端顺序：创建 meeting → 落材料（复用既有校验/解析/存储函数，仅 PDF/DOCX/Markdown）→ 触发首次预审。
  有材料时预审 Context 自动只用材料+议题标题（3f5477e 已保证）。
- 既有 `POST /api/meetings/:id/materials` 的 scheduled/锁定语义不变。
- 测试：带材料建会 → 首次预审 agent 输入含材料文本且 research=null。

## W5 Web · 配置页重构（LlNbX 像素基线）

- `/config` 改 2×2 卡片阵（1212×460，Icon Chip、Card Footer 布局照设计）。
- 新建会议卡：内嵌拖拽上传区（multipart 提交）；成功后 `router.push(/meetings/:id)`（"创建并进入会前预审"）。
- 新建战场卡：负责人改人员下拉（people props 已有）；次按钮"管理战场"与主按钮"创建并进入战场管理"→ `/config/battlefields`。
- 新建议题/新建能力：字段不变，套新卡片布局。

## W6 Web · 战场管理页 `/config/battlefields`（T8oOAH）

- 左栏：战场列表（选中态浅蓝、负责人+议题计数、trash → 确认弹层 dialog"删除后解除关联，议题本身不删"）。
- 右上：选中战场关联议题（紧急度点、期限/待校准、chevron → `/issues/:id`）。
- 右下：添加议题选择器（未归属/所属战场标注，点击行加入 → POST，成功后刷新整页数据）。
- "完成"按钮返回 `/config`。数据源即 W3 单端点，全部展示态，无业务 localStorage。

## W7 验证

- typecheck ×3；contracts / web / api 全量测试（api `--maxForks=1`）。
- staging 重建：建战场→建议题→加入第二战场（company[A,B]）→删 A（降级 B）→删 B（未归属）全链路 curl 断言；
  配置页带材料建会 → meeting 预审 ready 且引用材料。
- 部署产物与设计稿逐项核对两页布局。
