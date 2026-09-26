# 对照报告 05 · 外壳、设计基础、门禁页（clark-main → Tianshu）

C=`clark-main`，T=`Tianshu-MVP/apps/web`，TS=`clark/ts-design`（= tkos-ui）。

## 结论
- 推荐：采用与 clark 相同的 HeroUI 3.2.5 + Tailwind v4（+ ts-design 0.4.0 tgz），版本钉死；先做 5 项修正（见 §5）。
- 桌面栅格（≥1001）基本一致；画布色、圆角、≤1000 行为不同；天枢对象页是独立路由，丢了通知栏，无窄条/peek。
- 解锁后的进入动画 CSS 在天枢被复制但未使用（无 .entryCarry、未设 data-arriving、无 _entry 参数）。
- 门禁页：天枢是旧的深酒红配色 + v2 图；clark 是浅蓝 + v3 图 + 沿壁纸褶皱描线的等高线动画。
- 天枢两条规则会破坏 HeroUI：未分层的 `:where(.shell) button{color:inherit}`；月度工作区局部 `--accent: 69 91 142`。

## 1. 设计 token
### 1a. clark CEO 工作面实际使用
**第 1 层 C/src/app/globals.css :root**
- 中性（147–152）：`--paper #f1f1f3`，`--surface #fdfdfe`，`--ink #17171b`，`--ink-muted #535358`，`--ink-faint #6b6b70`，`--rule #e7e7ed`。
- 语义（155–158）：`--judgment #b45309`，`--confirmed #0f766e`，`--counter #be123c`，`--factual #0369a1`。
- 实色（163–164）：`--solid #17171b`，`--solid-fg #fafafb`。品牌（171–172）：`--brand-deep #075ccb`，`--brand-bright #1684ff`。
- 洗色（272–276）：judgment/confirmed/factual 7% 混入 surface，counter 6%，neutral 为 ink 4%；`--wash-hover` ink 5%（284）。
- 发丝线（361–362）：ink 9%/16%；`--hairline-w` 1px，2dppx 0.5px，3dppx 0.34px（638,1036–1045）。
- 圆角：`--radius .625rem`（433）；`--r-panel 20`，`--r-card 16`，`--r-inset 12`，`--r-control 10`，`--r-bar 4`，`--r-capsule 999`（451–456）。
- 动效（530–536）：`--dur-fast 90ms`，snap 140，base 220，slow 320；`--ease-swift cubic-bezier(.2,0,0,1)`，`--ease-brand (.22,1,.36,1)`，`--ease-snap (.4,0,.2,1)`；弹簧（516–518）smooth 450ms (.32,.72,.24,1)、snappy 400ms (.26,.9,.32,1.06)、bouncy 500ms (.22,1.2,.36,1.08)。
- 材质（597–605）：`--mat-blur 40px`，`--mat-sat 140%`，`--mat-regular` surface 86%，`--mat-thick` 94%，`--mat-edge 0 0 0 .5px` ink 11%。
- 阴影（613–621）：`--sh-1/2/3` ink 4/6/8%；`--elev-2 = 0 1px 1px sh1, 0 3px 6px -2px sh2, 0 8px 16px -6px sh2`；`--elev-3 = 0 1px 2px sh1, 0 4px 8px -2px sh2, 0 12px 24px -8px sh3, 0 24px 48px -16px sh3`。
- 字体（396–428）：`--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans SC", sans-serif`；`@theme inline`：`--font-wordmark: var(--font-douyin), var(--font-sans)`（771）。
- Tailwind @theme（831–875，影响 HeroUI 渲染）：`--text-sm .8125rem/1.7`（13px），`--text-base .875rem/1.75`，`--text-meta .75rem/1.55`，`--font-weight-medium: 600`（857），`--radius-sm/md/lg/xl/2xl` = ×0.6/0.8/1/1.4/1.8（815–819）。
- base（1047–1111）：html `scrollbar-gutter: stable; height:100%`；body `bg var(--paper); color var(--ink); text-rendering: optimizeLegibility; font-synthesis-weight: none; "kern","liga"`；**无** -webkit-font-smoothing；`::selection` judgment 22%；`:focus-visible{outline:2px solid var(--ink);outline-offset:2px}`；全局 Tailwind preflight。
- 暗色 token 存在但 CEO 页不启用。

**第 2 层 C/src/app/heroui-tianshu.css:17–120**（`html[data-theme="tianshu"]`，heroui-theme.tsx:17–39 客户端设置）
- `--tianshu-blue #3A83F7`，`--tianshu-blue-secondary #3C66BF`，品牌渐变 135deg。
- 画布：`--tianshu-canvas #f1f4f8`，`--tianshu-canvas-top #f7f9fc`，`--tianshu-canvas-glow rgb(58 131 247/4%)`。
- `--accent` 蓝 / 前景 #fff / hover 蓝86%+黑 / soft 蓝9%混入 surface / soft-foreground #3C66BF。
- `--default` = neutral-wash，`--default-hover` ink 9%；`--focus` = #075ccb；`--link #3C66BF`。
- 字段：`--field-radius calc(--radius*1.1)`=11px，`--field-border` rule，1px，focus #075ccb。
- `--surface-shadow` elev-2，`--overlay-shadow` elev-3，`--disabled-opacity .45`，`--tooltip-delay 500ms`，`--backdrop` ink 22%。

**第 3 层 C/src/components/ceo-warmap/workspace.module.css .shell**
- 旧色（1）：`--apple-label #1d1d1f`，`--apple-secondary #6e6e73`，`--apple-accent #007aff`，`--map-ink #1d1d1f`，`--map-muted #6e6e73`，`--map-line #d8d8da`，`--map-tile #f4f4f4`，`--map-grey #e8e8e8`。
- 字号（23）：title 20，body 14，meta 12，note 11，page 24，reading 16；≥1800（50）：22/16/13/12/26/17；≤1000（51）：title 18。
- 布局（54,84,229）：`--chat-inset clamp(16px,1.6vw,36px)`；`--notice-width`/`--peek-width` = `clamp(290px,calc((100vw - 70px)*.28),430px)`；`--strip-width 56px`；`--inspector-width 340px`；`--shell-edge 14px`；`--layout-gap 14px`；`--main-start calc(edge+notice+gap)`；`--topic-rail-width 360px`（≥1600 400，760–1000 310）；`--topic-rail-gap 12px`。
- 引用未定义 token 走默认值：`--ts-color-text-secondary`、`--ts-color-surface-canvas`、`--tianshu-reading-surface`。

reduced motion 六处：globals.css:2146–2154（.01ms）、3303–3309（VT 120ms）、workspace.module.css:20、:131,175,190；JS view-transition.ts:6–11 关 VT、workspace.tsx:58 WAAPI 0；heroui-theme.tsx:28–31 同步 `html[data-reduce-motion]`。另有 prefers-reduced-transparency（workspace.module.css:75,176）、prefers-contrast（:76）、forced-colors（globals.css:2250）。

### 1b. 天枢
- T/src/app/globals.css 130 行：`--brand-bright #5bd8f6`（clark #1684ff），`--brand-deep #075ccb`；html/body bg #f5f5f7 色 #1d1d1f 短字体栈，**有** `-webkit-font-smoothing: antialiased`；缺上述全部 token、preflight、::selection、全局 focus-visible。
- app-shell.module.css：保留 apple/map 变量；`--radius-surface: 20px`；`--type-reading` **14px**（clark 16）；无 ≥1800、≤1000 字号档。
- access.module.css:110 用了未定义的 `var(--font-wordmark)`。

### 1c. ts-design 规则（README、AGENT_GUIDE、docs、dist/tokens.css）
- v0.4.0 = React 19 / HeroUI 3.2.5 / Tailwind 4，vendored tgz；`import 'ts-design/styles.css'` 一次（含 tailwind、@heroui/styles、tokens、theme、组件，含全局 preflight）；Next 用 `@tailwindcss/postcss`；`TianshuTheme` 包裹、portal 用 `TianshuPortalTheme`；主题变量限定 `[data-ts-theme]`。
- 明确面向 MVP：「为天枢概念版和 MVP 提供相同的主题、基础控件和交互契约」；「MVP 锁定已验证版本 … 禁止复制 src 后各改各的」。
- 品牌 #3A83F7 白字（≈3.6:1，文档化例外）；渐变 135deg #3A83F7→#3C66BF；链接 #3C66BF；品牌蓝不作页面背景。
- 表面：阅读面 `--ts-reading-surface #FCFDFE`；工作区背景 #F1F4F8 + `rgb(58 131 247/.04)` 光晕（= clark canvas）；玻璃只用于功能层；通知栏深蓝材质（#44546D / #60728B）；不要紫色流线、霓虹、花哨背景、整卡状态染色；健康（红/琥珀/绿/未知灰）、紧急、确认分开。
- 控件：经 `ts-design/primitives` 用原生 HeroUI；页面只做布局；**禁止 `.shell button { color: inherit }` 这类全局覆盖**；允许有文档的具名作用域例外。
- 字号：正文常 16，次要 12–14，移动端输入 ≥16；间距 4/8/12/16/24/32/48；触控 ≥44；Lucide 20px stroke 1.75。
- 响应式：≤690 通知即首页；691–1000 双页阅读桌面；≥1001 通知栏 + 全局战场；详情保留窄条 48（≤690）/56（≥1001）；peek 为覆盖抽屉，Ctrl/Cmd+\ 或左边缘滑动。
- 转场：共享来源元素的 View Transitions，WAAPI FLIP 兜底；新转场跳过进行中的；reduced motion 即时；动画不代表确认。
- token：radius control .5rem / card 1rem / overlay 1.5rem；时长 fast 140 / panel 240；`--ts-ease (.2,.8,.2,1)`；focus #3C66BF；HeroUI radius .5rem。
- **ts-design 与 clark 控件值不一致**：clark 控件用 heroui-tianshu.css：focus #075ccb vs #3C66BF；radius .625rem→30px 药丸按钮 vs .5rem→24px。ts-design token 只在 TianshuTheme 子树内生效（battlefield-dashboard.tsx:66、Mission Card 工作区 import ts-design/styles.css，C/src/components/mission-cards/workspace.tsx:2）。→ **CEO 界面以 clark heroui-tianshu.css 为准。**

## 2. 布局外壳（clark workspace.module.css vs 天枢 app-shell.module.css）
| 规则 | clark | 天枢 | 一致 |
|---|---|---|---|
| .shell | fixed inset0 grid padding14 gap14 overflow hidden isolate | 同 | ✔ |
| 画布 | bg #f1f4f8 + `radial-gradient(ellipse at 85% 0%, rgb(58 131 247/4%) 0%, transparent 55%)` + `linear-gradient(180deg,#f7f9fc,#f1f4f8)`，位置 `center,center,center 54%` | bg #f5f5f7 + `linear-gradient(180deg,#f9f8fa 0%,#f7f6f9 52%,#f4f3f7 100%)` | ✘ |
| 列 | `var(--notice-width) minmax(0,1fr)` + `transition: grid-template-columns .32s cubic-bezier(.22,1,.36,1)`，`html[data-notice-transition]` 时暂停 | 无过渡 | ✘ |
| 字体 | `-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei'` 14px | 同 | ✔ |
| 按钮重置 | `.shell button:not([data-slot])` color inherit / 左对齐 / disabled .55；focus `3px #007aff88` offset 4，排除 HeroUI | 所有按钮 | ✘ |
| .mainArea | radius **24** | **20** | ✘ |
| .expanded | absolute inset0 z20 radius **22** #f5f5f7 transform-origin 0 0 will-change transform | radius 20 | ✘ |
| .expandedHeader | min-height 100，padding 25/27，`linear-gradient(145deg,#ffffffa8,#edf1f6a1)`，底边 #ffffffbf，`blur(30px) saturate(1.28)`，`inset 0 1px #fff`；h1 24/1.4/600；≤690 88px padding 18 | 无 | ✘ |
| .closeRound | 42 圆 #e7e7eb/#6e6e73，hover #dcdce1，active scale(.95) | 无 | ✘ |
| .expandedScroll | margin 0 22，padding 8/18/128，scroll-padding-bottom 128；带 rail ≥760：margin 0 padding 18/24/44 | 基本同 | ~ |
| data-detail-open | `--notice-width: var(--strip-width)`，通知栏隐藏，显示窄条 | 从未设置；对象页单列无通知栏无窄条 | ✘ |
| data-notices-peek | 见 02 报告 | 无 | ✘ |
| ≥1800 | padding/gap/edge 16 | 14 | ✘ |
| ≤1250 | 10/10/edge 10/notice 280/peek 280 | 同（无 peek） | ✔ |
| 691–1000 首页 | 「fold」：homeSurface 与 notificationArea 隐藏，只显示 foldMaterialSurface（一颗按钮；FoldMaterialDesk 自 edc2694 起未使用）——clark bug | 双栏 `minmax(250px,30%) minmax(0,1fr)`（被 responsive-layout.test.ts:9 锁定） | ✘ |
| 691–1000 详情 | 窄条 56 + 主区，peek ≤320 radius 24 | 不适用 | ✘ |
| ≤690 首页 | fixed block 100dvh padding 8；主区隐藏；通知栏全高（通知即首页） | 上下堆叠：看板在上、通知栏在下 42dvh | ✘ |
| ≤690 详情 | strip/notice 48，main-start 62；主区 fixed `inset 8px 8px 8px 62px` radius 21；peek left62 max320；.expanded radius 23 | 对象页全屏无窄条 | ✘ |
| clark 独有 | .noticeToast、.historyBackdrop、.sheet、.backToList、.demoReset、topic-rail（229–248）、`[data-ts-layout="true"]` HeroUI 内容面重置（201–203） | 无 | ✘ |
| 历史层 | 见 03 报告 | 居中原生 dialog | ✘ |

页面结构：clark 单客户端树，首页 DOM 保持挂载但 inert（满足 C-01「保留背景 DOM、原滚动位置」）；天枢路由式，HomeShell 卸载。

## 3. 转场
### 3a. clark
- view-transition.ts：`supportsViewTransition()` 无 API 或 reduced motion 时 false（9–11）；`runViewTransition(update, dir)` 设 `html[data-notice-transition=open|close]`，`startViewTransition(() => flushSync(update))`，吞掉 ready rejection，结束清属性（32–49）；`useMountedDuringViewTransition` 防止形变进来的元素再播自身入场（21–24）。
- CSS（globals.css:3265–3309）：见 02 报告 §2.13。
- 流程：开战场/雷达 view（269–285）来源 `[data-origin]` 命名 notice-card，homeSurface=home-board，通知栏=notice-rail（窄条接管 notice-rail，notice-strip.tsx:34）；展开面板命名 notice-card（议题转场时 notice-panel，590）；关闭镜像（296–301）。议题（313–338,353–374）`[data-home-issue]` 行命名 notice-card。重通知（403–430）月度覆盖层 fixed z150 命名 notice-card（644）。
- WAAPI 兜底：
| 情况 | 关键帧 | 时长/缓动 |
|---|---|---|
| 开 view（292） | 从 `[data-origin]` 相对 .mainArea 的 `translate(dx,dy) scale(sx,sy)`，opacity .6，radius 25px → identity；无来源 `translateY(18px) scale(.97)`（287） | 380ms cubic-bezier(.2,.8,.2,1) |
| 关 view（303） | 反向，终 opacity .1，fill forwards | 260ms cubic-bezier(.4,0,.2,1) |
| 开议题 sheet（344–348） | clip-path 从来源行 `inset(… round 12px)` opacity .28 → `inset(0 round 22px)` 1 | 300ms (.2,.8,.2,1) |
| 开战役 sheet | translateY(16px) opacity .2 → 0 | 260ms (.2,.8,.2,1) |
| 关 sheet（378–382） | 回到来源 clip / 16px，opacity 0 | 220ms (.4,0,.2,1) |
| 输入条 FLIP（241–256） | translate + scaleX，origin 100% 100% | 360ms / 关 250ms |
- 其他：栅格折叠 .32s；peekIn .26s；stripIn .32s cubic-bezier(.22,1,.36,1) -8px；historyRise 240ms。
### 3b. 天枢 objectTransition.ts
- 来源矩形取自 document.activeElement（16–18），1500ms 过期（9）；CardPage.tsx:48–54 在 .expanded 上 playObjectEnter，关键帧同 clark 开 view（380ms），**但缺 borderRadius 25px**。
- 差异：无 VT（无卡→面板形变、无通知栏→窄条折叠，对象页不渲染通知栏）；**无关闭动画**（Escape 直接 router.push('/')，无焦点还原）；无 sheet clip-path；只有 layout="workspace" 页有动画；来源只取 activeElement 无 `[data-origin]` 兜底（macOS Safari 点击不聚焦 → 来源变 body）。Next 16.3 App Router 支持 React `<ViewTransition name=…>`，路由导航算 transition（T/node_modules/next/dist/docs/01-app/02-guides/view-transitions.md）；通知栏/窄条需在共享 layout 里才能形变。
### 3c. 解锁后进入动画
- clark：200 OK → access-form.tsx:94–98 onUnlock → data-unlocking：品牌/时钟/表单/页脚 `unlockInterfaceOut 360ms cubic-bezier(.4,0,.6,1)`（-7px）；渲染舞台 opacity .96 `translate3d(0,-.25%,0) scale(1.012)` 520/620ms (.32,.72,.22,1)；`.unlockWash #f3f1f4` 淡到 .12（access.module.css:392–421）。520ms（reduced 40ms）后 `location.replace('/?_entry=unlock')`。首页 arrivingFromLock，replaceState 去掉 _entry，1300ms（reduced 0）后清除（workspace.tsx:70–80）。`.entryCarry`（workspace.module.css:169–176）fixed z4000 inset -2% `url(/brand/tianshu-flow-lock-v3.webp) center 54%/cover`，`entryCarryOut 1180ms cubic-bezier(.32,.72,.22,1)`（停到 18% 再淡出放大到 1.026）；`::after #f7f6f8` entryWashIn（.08→.94）。mainArea/通知栏/输入条 `entryContentIn 900ms` 延迟 180ms，从 opacity .08 + blur(5px)。reduced motion 不显示 carry 层。
- 天枢：keyframes 与 `.shell[data-arriving=true]` 已复制（app-shell.module.css:111–116）但无元素、无 data-arriving；AccessScreen.tsx:38 立即 `location.assign(nextPath)`（留下 /access 历史，Back 回到锁屏；clark 用 replace）；缺 lock-v3 图（只有 lock-v2 与 notification-wallpaper-v1；clark 用 lock v3 + wallpaper v2）。

## 4. 门禁页
### clark（C/src/app/access/*）
- 标题「进入天枢 · TKOS」noindex；服务端读 tkos_seat 预设滑块；next 为 "/" 时忽略；proxy.ts 门禁跳 `/access?next=`。
- 结构：`<main class=shell data-unlocking>`、LockscreenBackdrop、品牌（TianshuMark +「天枢」）、`<h1 sr-only>进入天枢</h1>`、LockscreenClock、AccessForm（或「访问控制尚未启用」/「服务端缺少访问口令或签名密钥。」）、页脚「京ICP备2026051441号」→ https://beian.miit.gov.cn/、.unlockWash。
- 背景（lockscreen-visual.tsx:59–116，CSS 47–132）：浅蓝 `radial rgba(198,212,252,.44)` + `linear #87aef4 → #8fa5f0 58% → #adb6ec`，兜底渐变 1.15s 淡出；next/image `tianshu-flow-lock-v3.webp`（preload unoptimized fill）1.1s 淡入并从 `translate3d(0,1.2%,0) scale(1.045)` 3s cubic-bezier(.16,.76,.2,1) 落定；SVG 光层：两条贴合壁纸褶皱的等高线（contourDraw 1.85s，延迟 .5/.64s）、一道闪光（glintTravel 2.6s，延迟 .82s），靛蓝渐变 `#5470d0 → #33489f → #22307c → #5d78d6`；白色纵深遮罩。
- 品牌：色 `rgba(23,33,88,.86)`，top `clamp(24px,4vw,48px)`，left `clamp(24px,4vw,56px)`，gap 10；mark 24，名 18px .06em `var(--font-wordmark)`（抖音字体子集）；interfaceWake 1.1s。
- 时钟：自绘实心锁 16×18 `rgba(28,38,94,.62)`；时间 Asia/Shanghai h23 每 15s；海军蓝渐变字 `rgba(23,33,88,.92) → rgba(44,56,118,.78)` 描边 .35px；"Segoe UI Variable Display", Bahnschrift，620，`clamp(72px,7.8vw,108px)`，`scaleX(1.08) scaleY(0.84)`，tabular；日期 `"{month}月{day}日 · {weekday}"` 14px .12em `rgba(28,38,94,.88)`。
- 角色页签（radiogroup「你现在坐在哪个位置上」，一号位/秘书/DRI）——**天枢后端无角色概念，NOT-BACKED**。轨道 36 高 3 padding radius 12 `rgba(5,4,13,.3)` blur(12px)；滑块紫渐变 260ms (.2,.8,.2,1)；12px/500 "Microsoft YaHei UI"。
- 6 位 PIN：标签「输入密码」（600，9px，.18em，大写）；六格 gap 10（≤560 为 6）aspect .93 radius 10 深色玻璃 Bahnschrift 18；numeric、one-time-code、自动聚焦、粘贴、方向键/退格导航、第 6 位自动提交、隐藏提交钮「确认访问码」。
- 消息：「正在确认」；错误 401「CODE 无效」/503「访问控制尚未启用」/其他「暂时无法验证」/网络「网络连接失败」；清空并聚焦第一格。
- reduced motion 隐藏光层与入场；reduced transparency、forced colors 已处理（642–666）。
### 天枢（AccessScreen.tsx + access.module.css）
- 深酒红背景 `radial rgba(145,86,119,.44)` + `linear #08060d → #25162f → #07050a`（47–54），lock-v2 内联背景，无淡入/落定/兜底/等高线/闪光，深色遮罩（80–84）。
- 颜色反转：品牌字 `rgba(244,240,246,.82)`，时钟浅灰渐变，日期带黑阴影。
- 品牌 ≥561：mark 40，名 20/500，gap 14，left `clamp(24px,4vw,72px)`；wordmark 字体未定义。
- lucide Lock 描边图标；日期 Intl 默认格式无「·」；空占位 "" 导致跳动（clark 用 ` `）。
- 表单：标签「访问口令」、单个 password 输入（16px radius 12）、按钮「进入 WarMap」/「验证中…」紫渐变；错误「口令不正确」/服务端消息/「登录失败」#e34b43 12px。
- 无 ICP 链接；页脚「CEO WarMap · 单公司单 CEO 决策驾驶舱」；h1「进入 CEO WarMap」；无页面 metadata。
- **bug**：fetch 未 try/catch（:32–36），网络错误后按钮卡在「验证中…」。
### 天枢后端（auth.ts）
- 只有 `POST /api/auth/login`，body `{password: string minLength 1}`，**additionalProperties:false**（发 seat 会 400）；单一 scrypt hash；Origin 必须等于 publicOrigin（403「Origin 不符」）；5 次/分钟限流；/api/auth/session、/api/auth/logout 存在。
- 角色页签：无后端 → 不做（或仅固定一号位的纯视觉，需确认）。6 位 PIN：只有把 CEO 口令设为 6 位数字才可行（运营约定，后端不强制）；自动提交会更快触发限流。401 映射「CODE 无效」；需补 429、403 文案。

## 5. HeroUI
- CEO 工作面用到（16 个文件）：Button（直用约 83 处 + HeroButton 63 处，concept-control.tsx:8–11 把 title 变 Tooltip）、ToggleButton/ToggleButtonGroup（战场视角 workspace.tsx:591、home-board、radar-feed、monthly）、TextArea（输入条、通知、rail、月度）、Tooltip、Toast（Provider 存在但从未触发）、Card、Chip、Tabs、Modal、TextField、Input、Label；ts-design：TianshuTheme、TextArea、Mission Card WorkspaceShell。
- 主题：globals.css 依次 import tailwindcss、tw-animate-css、@heroui/styles、heroui-tianshu.css；data-theme 客户端设置（首帧闪默认主题）；CSS module 未分层所以压过 HeroUI 的 @layer components；`[data-ts-layout="true"]` 重置内容面按钮。
- 计算值（旧构建）：Button md 高 40（≥768 为 36）padding-inline 16 gap 8 **radius 30px** 13/1.7/**600** nowrap；过渡 transform .25s ease、背景/阴影 .1s；按下 scale(.97)；禁用 .45；focus `0 0 0 2px var(--background), 0 0 0 4px #075ccb`；sm 36/32 padding 12 按下 .98；primary #3A83F7/#fff；ghost 透明 hover --default；secondary --default 背景 #3C66BF 字。ToggleButton 同基底，选中 accent-soft + #3C66BF；组内内角 0。TextArea radius 11 背景 #fdfdfe border 1px #e7e7ed padding 8/12，小屏 14/1.75，≥640 13/1.7，placeholder #6b6b70，min-height 38。Tooltip max 20rem padding 8 12px radius 14 elev-3 入场 .15s scale .9。
- **方案 (a) 采用同栈**：天枢 Next 16.3.5 / React 19.3 / Node 24 / Docker node:22-alpine，peer 均满足；@tailwindcss/oxide、lightningcss 无 install 脚本且有 linux-x64-musl 预编译包 → allowBuilds 应无需新增（首次安装确认）；无 CSP；需新建 apps/web/postcss.config.mjs；HeroUI CSS 用 @apply 必须经 Tailwind 编译。
  必做修正：1) globals.css 引入 tailwindcss / @heroui/styles / heroui-tianshu.css，移植 clark :root token 与 @theme 覆盖、VT CSS；2) layout.tsx 服务端在 html 上写 data-theme="tianshu"，客户端同步 data-reduce-motion；3) app-shell.module.css:2 按钮重置改 `:not([data-slot])`；4) 重命名 monthly-workspace.module.css:3,17 的 `--accent`；5) preflight 全局生效，需审查 config/*、missions/*（或按组件单独 import 避免 preflight）；6) 若用 ts-design tgz，Dockerfile 在 install 前 COPY vendor；7) 更新 responsive-layout.test.ts；8) 体积：全量 @heroui/styles 较大。
- 方案 (b) 手写 CSS：无依赖，但约 12 类控件全部状态与行为（按压、切换组键盘、tooltip、模态焦点）都要重做，必然漂移，且违背 ts-design「不复制 src」。
- 方案 (c) react-aria-components（无样式）+ 手写计算值。
- 推荐 (a)，版本：`@heroui/react@3.2.5`、`@heroui/styles@3.2.5`、`tailwindcss@4.3.3`、`@tailwindcss/postcss@4.3.3`、`react-aria@^3.52.1`、`react-aria-components@^1.21.1`、`@react-aria/i18n|ssr|utils`、ts-design 0.4.0 tgz。外壳、门禁页、VT/进入动画 CSS 在 clark 是无框架 CSS module，可原样移植。

## 6. 元信息
| | clark | 天枢 |
|---|---|---|
| 标题 | "TKOS" / "把公司的判断变成持久对象。"；门禁「进入天枢 · TKOS」noindex | "CEO WarMap" / "CEO 决策驾驶舱" |
| 图标 | C/src/app/icon.svg（v7 六芒标，渐变 #075CCB → #1684FF → #5BD8F6，viewBox 72 72 368 368） | 无（404） |
| 字体 | next/font/local douyin-brand.woff2（仅「天枢」二字）`--font-douyin` 700 swap | 无 |
| mark 渐变终点 | #1684ff | #5bd8f6 |
| html | lang zh-CN，class `h-full ${douyin.variable}`，data-theme / data-reduce-motion | lang zh-CN |
| body | `min-h-full bg-paper` | 无 |
其他：clark 窄条有锁/登出按钮（天枢有 POST /api/auth/logout）；clark 用 proxy.ts 门禁，天枢每页 requireCeo()。
