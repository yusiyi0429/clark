# 02 · 个人雷达 · Web 侧报告

日期：2026-09-27。范围：只改 `apps/web/**`（生成文件未动）与本目录。API 侧由另一个代理并行实现，本单没有启动开发服务器或浏览器，联调和浏览器验收留给 Claude。

## 结果

- 类型检查：基线失败 3 处（引导夹具缺契约新增的 `radar`）→ 现在通过。日志：`web-baseline-typecheck.log`、`web-final-typecheck.log`。
- 测试：基线 **460/460（55 个文件）** → **503/503（60 个文件）**。日志：`web-baseline-test.log`、`web-final-test.log`。
- `signalReader.test.tsx` 原有 10 条一字未改，全部通过；在文件末尾另加 1 条成员版断言。
- 改动的 6 个 CSS module 用 lightningcss（CSS Modules 模式）解析，全部通过。
- `git diff --check` 通过。

## 改动文件

新增：

```text
apps/web/src/app/(member)/me/radar/page.tsx                  我的雷达（requireMember，服务端读 MyRadar 与信号列表）
apps/web/src/app/(member)/me/radar/signals/[id]/page.tsx     个人信号阅读（404 → notFound；列表读不到也照常打开文章）
apps/web/src/cards/SignalArticle.tsx                          从 SignalCard 抽出的阅读正文（含「继续浏览」的分批铺开）
apps/web/src/components/radar/RadarSettingsEditor.tsx         共享编辑器：自己取数、保存、扫描、fieldErrors、401
apps/web/src/components/radar/RadarSettingsForm.tsx           纯展示表单与草稿变换（不含 hook，便于测试）
apps/web/src/components/radar/MemberRadarScreen.tsx           /me/radar 页面
apps/web/src/components/radar/MemberSignalScreen.tsx          /me/radar/signals/[id] 页面
apps/web/src/components/radar/personalRadar.ts                类型、同一状态的文案、状态行、相对时间、排序、卡片映射
apps/web/src/components/radar/loadMyRadar.ts                  服务端读取（照 03 的 loadMemberBattlefield）
apps/web/src/components/member/MemberRadarWidget.tsx          首页雷达小组件
apps/web/src/styles/radar-settings.module.css                 编辑器样式
测试：components/radar/radarSettingsForm.test.tsx、components/radar/memberRadar.test.tsx、components/radar/memberRadarScan.test.tsx、
      components/member/memberRadarWidget.test.tsx、components/accountMenuRadar.test.tsx
```

修改：

```text
cards/SignalStory.tsx          拆出纯展示的 SignalStoryView；SignalStory 对外签名不变
cards/SignalCard.tsx           正文改用 SignalArticle；upNextSignals 改成泛型（重载，老的两参调用不变）
cards/RadarCard.tsx            名单读 names；页脚文案；「在雷达设置里修改」；设置变更后重读雷达卡
cards/payloads.ts              RadarPayload.sources 加 names?
cards/radarSources.test.ts     名单改从负载取
cards/signalReader.test.tsx    末尾加 1 条成员版断言
components/AccountMenu.tsx     Dialog 加 "radar"；导出 MenuDialog（加 wide）
components/shell/DetailHeader.tsx    useContext(WorkspaceContext)?.closing ?? false
components/shell/WorkspaceFrame.tsx  /me/radar/* 不挂对话右列
components/member/useMemberHome.ts、MemberWorkspace.tsx、member-home-widgets.module.css
components/onboarding/WelcomeFlow.tsx、welcome.module.css、foundation.module.css（补开关）
components/onboarding/welcome.test.tsx、useOnboardingData.test.ts（夹具加 radar）
components/member/useMemberHome.test.ts、memberWorkspace.test.tsx
lib/companyTime.ts             publishedDate 从 SignalStory 移来（见「与设计不同」第 9 条）
styles/account-menu.module.css、styles/radar-feed.module.css
```

## 各项怎么落地

1. **抽取复用**
   - `SignalStoryView` 只收 href、imageSrc、title、summary、meta、status、onOpen。配图加载失败就收起，这个 UI 状态留在 View 里。
   - `SignalArticle` 收 `reading{…relation{heading,text,tag}…}`、state、pending、error、onUpdate、onRetry、onHidden 和 upNext。CEO 版文案不变；隐藏成功后仍回 `/radar`。
   - 成员版由 `personalReading()` 映射：关系标题写「和你的方向」，正文用 reason，标签写「你的方向 · {text}」，unknowns 和 images 都为空。
   - `upNextSignals` 加了一个 `SignalOrder<T>`（id、time、visible），排序逻辑仍只有一份。
2. **共享编辑器**
   - 先方向、后来源；来源栏标「可不填」。两个占位文案逐字照抄 spec。
   - 回车或粘贴成胶囊。点字可以改，× 删掉。组词时的回车不处理（`isComposing` 或 keyCode 229）；普通回车只加胶囊，不提交。
   - 方向显示「n/40」，按 `Array.from` 计字符。满 5 条方向、满 10 个来源时输入框禁用，并写明原因。
   - 建议：方向建议带 `· from`，来源建议按读法（note）分组，已选中的不再出现。选中的胶囊是实心天枢蓝白字，建议是玻璃描边。
   - 开着但没有方向时，保存键禁用并写「开启雷达至少要写一条方向」。fieldErrors 按提交时的下标对回胶囊，胶囊标红、下一行写原因。
   - 保存后胶囊换成服务端返回的规范值，来源胶囊下一行写「名称 · 读法」。全部来源都是 unsupported 时当场提示「这些来源暂时都读不了，雷达不会有结果」；`webSearch=false` 时如实说明只能读订阅源。
   - 「✓ 设置已保存」和扫描状态分两行写。
   - person：PUT 成功后先 `onSaved`（引导立刻往下走），开着时再 POST /scan。202 写「已在后台扫描」；409、429 原样写 message，按普通提示显示；其他失败写明没能开始扫描。
   - company：顶部写「这里改的是公司雷达」；自动方向只读，超过 3 条收进 `<details>`；保存后 `router.refresh()`，不扫描。
   - 401 跳 `/access?next=当前路径`。
   - 外观：01 的 `.glass` 卡；主卡 24、输入 16、内嵌 12 的圆角；与引导快照卡同样的 24/28 内边距（手机 20）。
   - 动效：开关拨动时两栏用 grid-rows 展开；新加的胶囊轻弹一下。减少动效时都关掉；减少透明度时沿用 `.glass` 的回退。
   - 触控目标：胶囊的字和 × 都借 margin 到 44px；手机上建议 44px；开关整行 64px。
3. **成员雷达页**：在成员外壳的展开区里打开，不挂对话右列（`railAllowed` 排除 `/me/radar/*`），登记的是 global scope。
   - 沿用 radar-feed 的列表和阅读样式；工具条只留「全部／未读／收藏」，按时间排序。
   - 卡片的 href 形如 `/me/radar/signals/<id>`，没有 `<img>`，meta 写「来源 · 日期 · 方向」。
   - 页头「设置」打开同一个编辑器。「刷新」POST /scan，收到 202 后每 5 秒 GET /api/me/radar，最多 3 分钟，完成后 `router.refresh()`；409、429 原样写 message。
   - 页面打开时服务端就说在排队或扫描，也会自动接着看；点刷新时收到 409「正在扫描」也直接接着看进度，不写成提示。
   - 等满 3 分钟仍在扫的那一次不再自动续等，免得无限轮询；停下时当场清掉定时器，不再多发请求。
   - 状态文案照设计 §5.2，四种状态（关闭、第一次、零条、失败）各写各的。雷达关着但已有信号时，顶部一条提示加「打开」，列表照常显示。
   - 阅读页可以收藏、隐藏、标已读。隐藏后留在原地，按钮变「恢复到阅读列表」，并写一句说明。
4. **个人菜单**：「我的声纹」后面加一项，成员写「我的雷达」，CEO 写「雷达设置」，图标是 lucide `Radar`，装在 `MenuDialog wide` 里。成员底部有「看我的雷达信号」链到 `/me/radar`，走 onNavigate。
5. **引导第 3 步**：步骤表插入 `"radar"`，标题、CEO 正文和第 1 步正文按 spec 改（声纹没开通时只说「雷达」）。
   - 编辑器通过 `actionsTarget` 把「保存并继续」和「稍后」portal 进引导底栏，位置、宽度和入场动画与其他步骤的主按钮、次按钮一致；手机上主按钮通栏贴底。引导这一步不再渲染自己的主按钮。
   - 在这一步按回车，点的是编辑器的主按钮。
   - 结束页摘要加雷达一行（`radarSummaryLine`）：数据来自 `data.radar`，本步保存后改用 onSaved 的结果。
6. **首页小组件**：`useMemberHome` 读 `radar`，MemberWorkspace 只在非 null 时把 `MemberRadarWidget` 放进 03 的插槽。
   - 标题「雷达」，右边「全部 ›」；下一行写「最近扫描 · 12 分钟前 · 2 条未读」这类相对时间。
   - 最多 3 条，每条写来源 · 时间、标题（2 行）和理由（2 行），未读的有蓝点。
   - 用 container query：小组件宽度 ≥ 620px 时三条并排，否则上下叠。
   - 失败（写原因加重试）、第一次还没扫完、零结果三种状态分开写。
7. **CEO 雷达页**：「监测范围」弹窗加「在雷达设置里修改」，打开同一个编辑器（company）。
   - `OUTLET_NAMES` 删掉，改读 `sources.outlets.names`；负载没带名单时回退为 API 的 message，不编造。
   - 页脚文案按要求改写。
8. **夹具**：引导夹具加 `radar`（CEO 的 enabled 为 true）；首页夹具加 `radar: null`。没有删除有效断言。
   - welcome.test 的「走到结束页」改为在雷达步调用编辑器的 onLater；步骤顺序的期望值同步改为含雷达（原测试标题「不包含未交付的雷达」一并改掉）。

## 与设计不同之处及原因

1. **开关没用 HeroUI Switch**。在 01 底座补了 `.switch`（轨道 52×32、实心蓝），整行是一个 `role="switch"` 按钮。
   - HeroUI v3 的 Switch 轨道只有 40×20，控件和标签的排法也要覆盖多个 slot 的样式。
   - 整行做开关，触控面积足够，token 也与引导按钮同源。
2. **编辑器多两个可选 prop**。
   - `enable`：从我的雷达页「打开」进来时，开关先拨到开，光标落到方向框。不加的话，点了「打开」看到的仍是关着的开关。
   - `actionsTarget`：只有引导传，用来 portal 主按钮和「稍后」。不这样做，就做不到「与引导主按钮不打架、手机主按钮贴底、位置与其他步骤一致」。
3. **CEO 引导正文去掉了最后一句「这里改的是公司雷达。」**，由编辑器顶部那一行说，免得同一屏说两遍。依据是 spec §2.2「为排版可以微调字句，不改意思」。要逐字照抄的话，改 WelcomeFlow 一行即可。
4. **胶囊竖排、建议按读法分组**。
   - 方向和来源都是「一行一枚胶囊」：来源要在胶囊下一行写读法，横向排的胶囊没有地方写。
   - 来源建议按 note 分组，每组写一次读法（订阅源、全网检索后按域名筛），每个都如实，也不重复。
5. **没有改动时点保存**：不 PUT，也不 POST /scan，直接回调。这样引导里做过这一步的人「一下就能过」，也不会平白触发一次手动扫描（10 分钟冷却、博查计费）。有测试覆盖。
6. **写了但没回车的一句方向或来源，保存时一并提交**（照「写一句方向就能开」）。超过 40 字，或方向已满 5 条时，不提交并写明原因，不悄悄丢掉。
7. **保存后派发 `radar-settings-changed` 事件**，与 `mission-round-changed` 同一种写法。三个地方在听：
   - 首页：马上重读，开了雷达小组件立刻出现，关了立刻消失。
   - 我的雷达页：`router.refresh()`。
   - CEO 雷达页：重读 `/api/cards/radar` 后交给 `onCard`。原因是 DetailPanel 用 `useState(initialCards)`，不会随 `router.refresh()` 更新（原有行为，本单不改 DetailPanel）。不重读的话，「在雷达设置里改完，回到监测范围仍是旧名单」。
8. **成员阅读页隐藏后留在原地**，可以当场恢复（工单要求「隐藏后恢复」）。CEO 版仍回列表。隐藏后的那句说明写在共用的 SignalArticle 里，两边都能看到。
9. **`publishedDate` 移到 `lib/companyTime.ts`**。`useMemberHome.test` mock 了整个 react，personalRadar 不能经 SignalStory 引入 HeroUI 组件。
10. **服务端读取放在 `components/radar/loadMyRadar.ts`**（照 03），没有动 `lib/api/server.ts`。
11. **零结果文案统一用设计 §5.2 的「这段时间没有和你方向相关的新内容」**，首页与我的雷达页同一句，没用 spec §4.2 的「暂未找到相关内容」。
12. **「第一次扫描还没完成，稍等片刻」**：接口没有「是否完成过」的字段，所以在 lastRun 为 null 或正在排队、扫描，并且没有信号时显示。
13. **我的雷达页一条信号都没有时，不显示筛选条**，只留状态行和空态。
14. **对比度**：选中的胶囊是 #3A83F7 配白字、15px/500，约 3.6:1，与 01 主按钮是同一个已定取舍。要达 AA，可换成 `--onboarding-pressed`（#246DDF，约 4.8:1），改一行 CSS。

## 测试（新增、改动的都验证用户关心的结果）

- `radarSettingsForm.test.tsx`（18 条）
  - 表单：占位文案逐字对上；先方向后来源、可不填；person 有开关、company 没有且写明公司雷达、列出自动方向。
  - 禁用：保存键的各种禁用状态、n/40、满 5 条和满 10 个时禁用。
  - 输入：组词回车和 keyCode 229 都不处理；普通回车只加方向、不提交；点建议不动正在写的那句；网址才变成胶囊，粘贴多个网址变成多个胶囊。
  - 显示：fieldErrors 标到胶囊上；全部不支持时的提示；webSearch=false 的说明；保存与扫描状态分两行。
  - 容器：先回调、后扫描（202）；409、429 按普通提示显示；关着保存不扫描；没有改动不重复保存和扫描；fieldErrors 按下标映射；company 刷新页面、不扫描；`enable` 生效；401 回锁屏。
- `memberRadarScan.test.tsx`（3 条）：202 后每 5 秒看一次，扫完才 `router.refresh()`；满 3 分钟停下、不再轮询；429 原样写成普通提示，409「正在扫描」直接接着看。
- `memberRadar.test.tsx`（8 条）：页头与工具条；href 形如 `/me/radar/signals/<id>`、没有 img、meta 带方向、按时间排、隐藏的不出现；三种空态与关闭；成员阅读页（和你的方向、返回我的雷达、继续浏览）；隐藏后可以恢复；服务端读取的 404、401 深链、5xx 直接抛错。
- `memberRadarWidget.test.tsx`（3 条）：相对时间、3 条、「全部」导航；失败、第一次、零结果三态；首页 radar 为 null 时不出现、非 null 时进插槽。
- `accountMenuRadar.test.tsx`（2 条）：成员「我的雷达」紧跟「我的声纹」，编辑器为 person，链接到 `/me/radar`；CEO「雷达设置」，编辑器为 company，没有个人链接。
- welcome.test（新增 4 条）：第 1 步正文、成员第 3 步、CEO 第 3 步、结束摘要。memberWorkspace.test 新增 2 条（`/me/radar*` 没有右列）；useMemberHome.test 新增 1 条；radarSources.test 改写 1 条、新增 1 条；signalReader.test 新增 1 条。
- **突变检查**：下面 8 处逐一临时改坏，都有测试失败，随后原样恢复。
  - 去掉组词判断
  - 去掉 `/me/radar/` 的右列排除
  - 首页不传雷达组件
  - 保存后不扫描
  - 小组件把「第一次」写成「零结果」
  - 轮询间隔改成 60 秒
  - 停下后不清定时器
  - 不认 409「正在扫描」

## 消融检查

- **DetailHeader 改用 `useContext`**：临时换回 `useWorkspace()`，相关 181 条测试照样通过。现在的路由都在工作区外壳里，它没有被真正用到；工单明确要求这样改，所以保留，行为不变。
- **`enable`**：移除后验收条件仍满足，但「打开」会变成打开一个关着的开关，交互质量下降。保留，并加了测试。
- **`actionsTarget`**：移除后在引导里做不到「不打架、贴底、同位置」。保留。
- **没有改动时跳过保存**：临时移除后原有测试全部通过，说明缺覆盖。保留（防止重复扫描和计费），并补了测试。
- **`radar-settings-changed`**：CEO 雷达页的正确性依赖它（见「与设计不同」第 7 条）。保留。
- **删掉的**
  - `.editor button { font: inherit }`：它会压掉卡内 `.primary` 的 17px/600。
  - `.submit:disabled`：全局已有 `!important` 的禁用样式。
  - 只在文件内使用的 `addDirection`、`addSources`、`looksLikeSource`、`MAX_SOURCES`、`runTime` 改为不导出。
  - 状态行函数改名 `personalStatusLine`，避免与 RadarCard 的 `radarStatusLine` 同名。

## 请 Claude 在浏览器里重点看（1440 与 390）

1. **引导第 3 步**
   - 成员：开关拨开时两栏展开、光标落到方向框；「保存并继续」和「上一步 · 稍后」与声纹步同一个位置，手机上贴底。
   - CEO：正文加卡片顶部那一行；自动方向超过 3 条时的折叠。
   - 桌面 900 高时 stage 滚动后，底栏始终可见。
2. **编辑器交互**
   - 中文输入法组词回车；粘贴多行方向或多个网址；点胶囊修改后回车或失焦，Escape 只取消修改、不关弹窗。
   - 保存后胶囊换成规范值（如 `HTTPS://WWW.FT.COM/world` → `ft.com`，下一行「金融时报 · 订阅源」）；fieldErrors 标红；GitHub Trending 的「暂不支持」提示。
3. **个人菜单弹窗**（560 宽、内容长时滚动）：成员底部「看我的雷达信号」能进展开区；CEO 保存后回到雷达页，「监测范围」立刻是新的方向和媒体名单。
4. **/me/radar**
   - 没有右列。页头「设置／刷新」在 390 宽只剩图标。
   - 刷新后状态从排队、扫描到完成，并自动刷新列表。
   - 三种空态、关着时的「打开」（开关已拨开）。
   - 阅读页收藏、隐藏后恢复、标已读；Escape 回列表。
5. **首页小组件**：开关雷达后立刻出现或消失；1440 下三条并排，834 与 390 下上下叠；失败时的重试；返回时焦点回到来源（「全部」或那一条）。
6. **视觉**：选中胶囊的对比度（第 14 条）是否接受；减少动效、减少透明度下的样子。

## 限制与未做

- 没有联调真实 API（按要求不起服务）。接口形状以已冻结的契约和生成客户端为准，失败和 409/429 的文案直接显示服务端的 message。
- 公司雷达卡的 `names` 由 API 代理新增。在它落地前，「监测范围」回退显示 API 原来的 message，不会编造名单。
- 没有写 CONTEXT、ADR 和 map.md（不在 Web 范围）。没有执行任何 git 写命令，没有读密钥文件，没有新增依赖。
