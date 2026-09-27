# 03 · DRI 首页小组件验收报告

日期：2026-09-27。起点：`ec39f5a`（04d）。状态：resolved。

- 实现：Codex（gpt-6-astra，ultra）。它在浏览器演练中途额度用完（`You've hit your usage limit … try again at Oct 4th`）后退出，没写报告，也没清理 3500／4500、同层副本和专用浏览器。
- 接手：剩余演练、四处修正、清理和本报告由 Claude 完成。Codex 留下的红绿日志和夹具脚本原样保留。

## 交付行为

- **首页数据**：`GET /api/me/home` 增加 `work`，和引导共用 `readMemberWork`，不再各算一遍。
  - 参与的战场有三种来源：本月是负责人、本轮个人卡 Owner、在这个战场有 Mission。
  - 每个战场带本月目标的三态文案和原文。
  - 我的本月卡带状态句、截止时刻和 cardId。
- **成员战场详情接口**：新增 `GET /api/me/battlefields/:id`。
  - 内容：六个月目标、本月目标、本月个人卡名单（本人卡能打开，拍板人全部能打开）、「我在这里的 Mission」（带草稿／占位／已确定小标）、本轮状态块。
  - 没有 CEO 的待决策议题。
  - 看不到或不存在的战场一律 404。
- **首页**
  - 页头改为「姓名 · 我的工作台」。删掉了「发给你的信号、你推进和参与的执行事项，都会出现在这里」这句没兑现的承诺。
  - 战场小组件：
    - 只写本月目标，三态措辞与引导一致：「本月目标还没出来」「本月目标还在协商」、已签发写原文。
    - 原文最多 3 行，多了可以展开。
    - 战场 DRI 的卡头有皇冠。
    - 点卡进成员战场详情。
  - 「我的本月卡」常驻：
    - 写卡的版本行、个人任务数、占位小标，以及上海时间的截止时刻和分钟倒计时。
    - 确认后仍在。
    - 没有卡时写「这个月还没有你的卡」。
  - 雷达插槽：
    - 没有雷达时什么都不画。
    - 有雷达时，是同一卡片外形的整行宽组件，排在战场与本月卡那一行下面。02 接入时把组件放进插槽即可。
  - 手机上的成员首页：小组件和执行事项在前，通知放在同一滚动面的下面；顶部保留锁屏键和时钟浮条。CEO 的手机首页不变。
- **成员战场详情页**
  - 在成员外壳的展开区里打开。
  - 不出现对话右列：成员战场还没有独立的 Agent scope。
  - 返回后，焦点回到打开它的那张卡。
- **本轮状态句**：抽成共用的 `roundStatusText`，个人卡页头和战场详情说同一句话。

## Claude 验收中的修正

共五处。按 CLAUDE.md，每处都列出了备选方案和副作用。因为用户授权连夜推进，我先按方案 A 做了；要改选的话，改动都集中在下面列出的文件里。

1. **拍板人详情页的主按钮和状态句是同一句话**
   - 现象：草稿阶段按钮写「个人卡草稿已就绪，可以统一开放讨论」，拍板阶段写「意见已全部处理，待你确认」。按钮文字是陈述句，又和上方状态句重复。
   - A（采用）：按钮改用引导「下一件事」在同一状态下的按钮文案「查看 {M} 月个人卡」，待办句保留在上方状态行，读屏名称与可见文字一致。
     - 副作用：按钮上不再出现待处理条数；条数仍在状态句和「5 张卡 · 待处理 N」里。
   - B：拍板人有待办时隐藏状态句，只留按钮。
     - 副作用：按钮仍是一整句陈述，手机上要折行；拍板人和成员的状态块结构也不一样了。
   - C：改成通知栏那样的待办行（蓝点、文字、箭头）。
     - 副作用：失去唯一主操作，和个人卡页头的主按钮不一致。
2. **成员在拍板阶段看到「等林知行拍板 · 等拍板」**
   - 来源：这句是 04c 页头的原句，03 把它抽成了共用函数，所以个人卡页头原本就有同样的重复。
   - A（采用）：`roundStatusText` 里，卡行是「等拍板」时不再接后缀；有进度（如「已处理 1/3」）时照旧拼接。
     - 副作用：个人卡页头一起修正；判断依赖卡行文案的字面值，已写注释和测试。
   - B：服务端 `missionCardLine` 在成员没有进入 Review 的意见时返回空串。
     - 副作用：通知栏的成员行会变空，还得另改通知分组。
   - C：非拍板人一律只写「等某某拍板」。
     - 副作用：丢掉「已处理 1/3」这类有用的进度。
3. **「参与的战场」空卡的标题没放进标题容器**
   - 现象：和右边「我的本月卡」相比，标题高 2px，正文高 4px。
   - 修正：放进同一个 `.heading`。纯对齐问题，只有这一种改法。
4. **有雷达时 1440／1280 下排成 3+1，雷达单独落在第二行左侧**
   - A（采用）：雷达作为整行宽组件（`grid-column: 1 / -1`），外形不变。
     - 副作用：雷达的内容排布由 02 按整行宽度来设计。在 3 个战场登记的成员（4 张卡）仍是 3+1，属罕见情况，没有处理。
   - B：按小组件数量算列数（4 张排成 2×2）。
     - 副作用：多一段按数量计算的逻辑；2×2 时，1280×800 下执行事项更靠下。
   - C：保持 auto-fit 网格。
     - 副作用：两个战场的成员一开雷达，必然是 3+1。

5. **旧测试把 `/api/me/home` 的整个返回值钉死**
   - 现象：Claude 分批重跑 API 时，`meetingFollowThrough.test.ts` 第 290 行断言 CEO 调首页接口的结果整体等于 `{ myTasks: [] }`，而 03 按设计加了 `work`，这条断言失败。
   - 为什么 Codex 没发现：它最后一次全量被运行器崩溃打断了。
   - 原因：
     - 直接原因是接口按设计扩展了字段。
     - 根本原因是这条断言把返回值的形状也写死了，而它的本意是「CEO 只看到自己的执行事项（空）」。
   - A（采用）：只断言 `myTasks` 为空，保留本意。`work` 在 `memberHome.test.ts` 里有专门覆盖。
     - 副作用：无。
   - B：改成 `toMatchObject`。
     - 副作用：断言变弱。
   - C：把 `work` 挪到一个新接口，旧接口不变。
     - 副作用：首页多发一次请求，改动更大。

## 改动文件清单

API 与契约（没有迁移）：

```text
apps/api/src/memberWork.ts                        新增：引导与首页共用的本月参与计算
apps/api/src/memberBattlefields.ts                新增：成员战场详情投影
apps/api/src/missionRounds.ts                     导出 missionCardLine
apps/api/src/onboarding.ts                        改用 readMemberWork
apps/api/src/routes/me.ts                         /api/me/home 带 work；/api/me/battlefields/:id
apps/api/test/memberHome.test.ts                  新增
apps/api/test/meetingFollowThrough.test.ts        见修正 5
packages/contracts/src/memberHome.ts              新增：MemberWork、MemberBattlefieldResponse
packages/contracts/src/tasks.ts                   MeHomeResponse 带 work
packages/contracts/src/index.ts / openapi.ts
packages/contracts/test/memberHome.test.ts        新增
apps/web/src/lib/api/openapi.json / schema.d.ts   gen:client 生成
```

Web：

```text
apps/web/src/app/(member)/me/battlefields/[id]/page.tsx          新增
apps/web/src/components/member/MemberHomeWidgets.tsx             新增
apps/web/src/components/member/member-home-widgets.module.css    新增
apps/web/src/components/member/memberHomeWidgets.test.tsx        新增
apps/web/src/components/member/MemberBattlefieldScreen.tsx       新增
apps/web/src/components/member/MemberBattlefieldScreen.module.css 新增
apps/web/src/components/member/MemberBattlefieldScreen.test.tsx  新增
apps/web/src/components/member/loadMemberBattlefield.ts / .test.ts 新增
apps/web/src/components/missionCards/roundStatusText.ts / .test.ts 新增
apps/web/src/components/missionCards/RoundLine.tsx               改用 roundStatusText
apps/web/src/components/member/MemberWorkspace.tsx               首页主体、手机布局挂钩
apps/web/src/components/member/useMemberHome.ts / .test.ts       读 work，区分加载失败与没有登记
apps/web/src/components/member/memberWorkspace.test.tsx
apps/web/src/components/shell/WorkspaceFrame.tsx                 成员战场不挂对话右列
apps/web/src/styles/app-shell.module.css / member-home.module.css 成员手机首页
apps/web/src/styles/responsive-layout.test.ts
```

文档：`CONTEXT.md` 的 Member 词条补上首页小组件、「参与」的判定和成员战场详情的边界。

## 测试

| 项目 | 04d 基线 | 03 完成后 |
|---|---|---|
| Contracts | 49 | 51，全通过 |
| Web | 425（51 文件） | 460（55 文件），全通过 |
| API | 540 通过／8 既有部署失败 | 545 通过／8 既有部署失败（553 项） |

- API／Web 类型检查通过；`gen:client` 重新生成，与现有生成文件逐字节一致；`git diff --check` 通过。
- API 分批：第 1 批 136／8 既有部署失败，第 2 批 110／1（修正 5 后复跑该文件 12/12），其余 58、126、114 全通过；五批都没有 IPC 中断。
- Codex 的红绿日志在本目录：`*-red*.log`、`*-green*.log`、`home-final.log`、`web-baseline.log`。它的最后一次 API 全量被测试运行器 `ERR_IPC_CHANNEL_CLOSED` 中断（`final-api.log`），不计通过。上表是 Claude 在清理副本后分 5 批串行重跑的结果。

## 浏览器演练与证据

- **Codex 部分（第一套夹具）**：孙铭泽在目标还没出／协商中／已签发三种状态下，四档宽度（1440、1280、834、390）共 12 张截图（`member-*.png`，指标见 `browser-member-*-metrics.json`）。
- **Claude 部分**
  - 工具：`claude-verify.cjs`。它用 Playwright 起自有的无头 Chrome，每次都是全新的临时配置，只访问 `localhost:3500`。
  - 为什么不用内置浏览器：夹具只认 `localhost` 来源，而内置浏览器的 cookie 不分端口，会顶掉用户本地 3100 的登录态。
  - 林知行（战场 DRI）：已签发、草稿、截止待拍板三个阶段，首页和详情，四档宽度。卡头有皇冠，详情页有「你是这个战场的 DRI」。
  - 孙铭泽：
    - 草稿：「我的本月卡」写「草稿 · 01-3 战役 DRI」，与引导一致。
    - 开放：通知分组、首页小组件、详情本轮三处同为「47 小时 59 分」。
    - 截止待拍板。
    - 确认：通知整组退出，「我的本月卡」保留「已确定 · 验收 CEO 10/3 10:13」。
  - 何望舒（只有 Mission，没有卡）：看到团队协作战场，本月卡写「这个月还没有你的卡」。
  - 顾清和（什么都没登记）：写「还没有登记你参与的战场」和「这个月还没有你的卡」。
  - 交互：
    - 长目标展开：`aria-expanded=true`，行数限制解除。
    - 首页 → 战场详情 → 返回，焦点回到「查看战场：灯塔项目」。
    - 首页 → 我的本月卡 → 返回，焦点回到「打开我的本月卡：灯塔项目」。
    - 越权战场：接口返回 404，页面走 404。
  - 雷达布局：在页面里临时插入一个与本月卡同形的雷达组件（不改源码），四档宽度检查。修正后是整行宽组件；1280×800 下执行事项从 472px 开始，仍在首屏。
  - 结果：所有采集都没有横向溢出和错误遮罩；1440×900、1280×800 下执行事项都在首屏。
  - 复核：修正后重建一套夹具，复核拍板人按钮「查看 10 月个人卡」和成员的「等林知行拍板」。
  - 留证：共 89 张 `claude-*.png` 和对应的 `claude-*.json` 指标。按 `.gitignore`，PNG 和日志不入库。

## 遗留与边界

- **本月目标三态文案有两份实现**：首页用 API 的 `monthTargetText`，引导用 Web 的 `monthTargetCopy`，现在逐字一致。要合成一份，得改工单 01 的引导契约，本单没做。
- **「我的本月卡」写的是卡的版本行**，和引导「你这个月的工作」一样。它和通知行（如「无意见」）、本轮句（如「讨论中 · 这张卡 0 条意见」）是三个层级，沿用 04d 的分工。
- **手机成员首页的通知挪到了小组件和执行事项之后**，本轮状态由前面的「我的本月卡」承担。CEO 的手机首页不变。
- **全局 404 页写着「该对象尚未进入 WarMap」**：这是旧产品名，属于原有页面，不在本单范围。
- **ADR-0021 仍缺失**：属于工单 02。
- **待人工验收**：真机 Safari，以及真实公司数据下长名单的阅读节奏。

## 清理

- **夹具**
  - 两套夹具（`warmap_test_ff5881d8f72b`、`warmap_test_9dcda57d2511`）都已关闭，并查证已从 54329 上删除。
  - 临时人员目录已删除。
- **同层副本 `apps/web-03-preview`**
  - 清理前，237 个 src／public 文件的哈希与源码一致。
  - 结束 Next 进程树，先解除 junction，再删除副本；`apps/web/node_modules` 保留。
  - Windows PowerShell 5.1 缺 `GetRelativePath`，改用 pwsh 7 执行 `cleanup-preview.ps1`。
- **Codex 的专用浏览器**：agent-browser 守护进程和无头 Chrome（都在 08:49:29 启动）已结束。临时配置目录留给系统清理。
- **端口**
  - 3500／4500 已释放。
  - 受保护端口的进程号不变：3100／4000 是 22856，3200 是 58088，4100 是 63752。
- **约束**：没有新增依赖和迁移。提交由 Claude 在验收后执行。
