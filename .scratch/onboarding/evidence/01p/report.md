# 01p 实现与打磨报告

基于已提交的 01（`0d50e10`），完成 1 处跳转 bug 与 6 处视觉打磨，待 Claude 验收、提交。先写复现测试并保留 red，再修 bug；随后才修改视觉。未执行 commit、push、stash、reset、checkout、clean。

## 改动文件

本单修改 9 个 Web 源码／测试文件，无新增生产文件、无删除生产文件：

| 文件 | 内容 |
|---|---|
| `apps/web/src/lib/access-paths.ts` | 引导专用原链接判断，排除角色默认首页 |
| `apps/web/src/components/onboarding/WelcomeFlow.tsx` | 收尾文案、禁用原因与 aria-describedby、桌面换步滚动复位 |
| `apps/web/src/components/onboarding/welcome.test.tsx` | 8 项按钮实际点击／完成请求／跳转回归 |
| `apps/web/src/app/globals.css` | 晨光 14%／10%／6% token、共享禁用状态 |
| `apps/web/src/components/onboarding/MorningCanvas.tsx` | 中部淡蓝环境光 |
| `apps/web/src/components/onboarding/foundation.module.css` | 胶囊弧形高光、细边、柔光与录音材质；移除弃用北斗样式 |
| `apps/web/src/components/onboarding/welcome.module.css` | html/body 同底色、桌面组内居中与长内容滚动、提示排版 |
| `apps/web/src/components/onboarding/OnboardingProgress.tsx` | 最终统一圆点进度，移除北斗分支 |
| `apps/web/src/components/onboarding/SiriWave.tsx` | 去掉额外绘制的白色硬直线，保留随真实录音能量变化的彩色曲线 |

文档修改：`.scratch/onboarding/issues/01p-onboarding-polish.md`、`.scratch/onboarding/map.md`。新增本目录报告、脚本、日志、图册及 80 张 PNG（含 20 张并排对照）。脚本：`browser-server.ts`、`browser-check.cjs`、`browser-verify.cjs`、`mobile-check.cjs`、`make-comparisons.cjs`、`cleanup-preview.ps1`；`north-trial.tsx` 仅为试作记录，未接入生产。

`apps/api`、依赖清单、lockfile、contracts 与生成客户端均无本单修改。过程中另有会话改动 `design-02-personal-radar.md` 与 `04a-mission-rounds-data-and-drafts.md`，本单未编辑或回退它们。

## 七项结果与取舍

1. **主按钮到达承诺的页面。** 调用链是登录／页面守卫把角色首页带入 `next` → 原 `validNextPath` 认为首页有效 → `onboardingDestination` 优先首页，而按钮仍显示 API 的下一件事。新增引导专用 `onboardingReturnPath`，复用已有安全／角色校验，并排除该角色首页；去处和按钮共用这个判断。没有全局禁止首页（会改变正常登录），也没有只在登录入口删除 next（页面守卫仍会产生同样情况）。真实深链时按钮为「继续刚才的页面」，下一件事降到按钮上方说明。API 未变。
2. **禁用状态明确。** 原 `enter ... both` 动画终帧的 `opacity:1` 优先于普通 `.primary:disabled`，导致视觉仍像可用。共享禁用规则以状态优先级固定为透明度 .55、饱和度 .25、无阴影、not-allowed；按钮 hover 不再改变引导禁用主按钮。`aria-describedby` 关联随同意／录音阶段变化的原因，仍可选「稍后」。全站既有原生、HeroUI 和 ghost 外观主按钮，因此统一在 button 禁用语义层处理，次按钮的禁用外观也随之统一；未改变是否允许点击的业务条件。没有为十余入口增加 data 属性或分散复制规则。
3. **液态玻璃。** 顶部贴边的弧形细高光两端淡出，32% 细边与 45% 上沿亮度区分层次，底部收深；内部使用两团模糊冷白／天青光替换横向硬光带。三段实心群青不变，无外发光，阴影接近不可见。录音继续使用原 SiriWave 的音量和减少动效逻辑，去掉额外白直线，保留彩色软曲线与同一层外壳。低音量截图中彩光较细属于实际能量状态，不是恢复硬白带。
4. **看得出的浅蓝。** 共享 token 为左上蓝 14%、右下天青 10%、上方中部蓝 6%；锁屏与引导同步。仍保留冷白大面积与白玻璃正文，文字颜色不变。
5. **桌面纵向构图。** ≥760px 在确定的视口高度中居中整组；正文与按钮间采用 8px 倍数间距。长内容仅 stage 内滚，胶囊与 footer 不收缩；换步同时重置 stage 和 window，标题重新获得焦点。1440×900 的你好按钮底边由 808px 到约 668px，收尾由 808px 到约 640px。1280×650 与 760×650 的长页主按钮仍可见。手机保持固定底栏、主按钮底边 748px，并为原因文字增加正文滚动余量。
6. **最终选圆点。** 试作北斗为 144×60、5px 星点、1px／墨色 14% 连线，从天枢沿斗身再到斗柄以 90ms 间隔亮起，并移到收尾正文中部。斗口和斗柄已能读出，问题不再是辨识度；但它在正文与设置摘要之间增加了第二个蓝色图形中心，手机尤其明显。圆点延续前几步同一套进度语言，让胶囊仍是主角，文字和动作更紧凑。主负责人和独立看图复核均选圆点。最终删除北斗数据、分支和专用 CSS，没有保留试验开关。
7. **底色一致。** `/welcome` 的 `body.bg-paper` 原本覆盖 base layer 的晨光背景；用与锁屏相同的页面作用域规则让 html/body 都为 `#F7F9FC`，首屏即生效。真实锁屏登录到 welcome 的 133 次渲染期采样全部为 `rgb(247,249,252)`。

## 测试对比

| 检查 | 改前／red | 最终 | 证据 |
|---|---|---|---|
| Web 全量 | 原源码副本 36 文件、281/281 通过 | 36 文件、289/289 通过 | [baseline-web.log](baseline-web.log)、[final-web.log](final-web.log) |
| Bug 新回归 | 13 项中 4 失败、9 通过 | 引导＋锁屏 20/20 通过 | [red](bug-regression-red.log)、[green](bug-regression-green.log) |
| Web 类型 | 测试 harness 初稿曾有 useState 重载类型错误，已修 | 通过 | [最终类型检查](final-web-typecheck.log)，初稿日志 `bug-typecheck.log` 保留 |
| 浏览器七项核心验证 | 真实复现「核对 9 月目标」去了 `/`、禁用 opacity=1、welcome body 为灰底 | 预期落点、禁用状态、居中／长页布局、底色均通过 | [browser-checks.log](browser-checks.log)、[verification.log](verification.log) |
| 减少透明度额外回归 | 对应源规则与 0d50e10 相同 | **未通过关闭模糊断言**；实心底色与高对比边框通过 | [transparency-fallback.log](transparency-fallback.log)，见下方额外发现 |

完整测试在最终滚动复位改动后重跑。registry 的 `Unsupported Card kind: mystery` 是原有预期 stderr，测试通过。`git diff --check` 通过。未改 API 生产代码，所以未重复跑 API 全量；浏览器使用真实测试 API 与 PostgreSQL。没有运行 gen:client，生成文件未改。

浏览器覆盖：1440×900、375×812、834×1194，以及 1280×650、760×650、759×812；无横向溢出，长页 CTA 均可见。CEO 和成员各自验证默认首页／真实链接／无效链接；CEO 默认链接正确到 `/plans/2026-09`，深链正确到 `/radar?tab=all`；成员保留 `/me#tasks`。检查动画结束和 hover 后仍为禁用样式；开启减少动效后禁用仍正确、SiriWave 连续两帧不变，正常情况下连续两帧变化。录音 15 秒后可停、30 秒自动停、上传保存与已录摘要通过。公司页内部滚到底后进入声纹页，stage 回到 0、焦点在 H1。

手机滚动后，录音控制组底边约 588px，固定 footer 顶边约 620px；录音按钮、计时和提示均完整可见，停止后「保存并继续」变为可用。手机页首长稿截图不是“所有内容必须一屏”的宣称。

自动化历史错误如实保留：最初的转场采样存在旧 window 内，整页 replace 后数组丢失；已改为跨文档上报 Node 并通过。减少透明度检查的真实失败没有删除断言或伪装通过，`mobile-check.cjs` 在继续收集手机截图后仍以退出码 1 表示该额外失败。

## 七处截图索引

所有图片都在本目录。`before` 来自动手前真实复制的原 Web，`after` 来自最终源码；两者连接同一隔离测试数据。桌面 1440×900，手机 375×812。整体打磨同时体现在实图中，同一张完整页面图可作为多个项目的证据，并非声称只改一个 CSS 属性的隔离实验。

直接浏览：[完整对照图册](comparison-index.html)。下表给出每处原图和并排图：

| 项目 | 桌面原图：改前 → 改后 | 手机原图：改前 → 改后 | 并排对照 |
|---|---|---|---|
| 1 按钮实际落点 | [前](before-bug-destination-desktop.png) → [后](after-bug-destination-desktop.png) | [前](before-bug-destination-phone.png) → [后](after-bug-destination-phone.png) | [桌面](compare-01-destination-desktop.png) · [手机](compare-01-destination-phone.png) |
| 2 禁用态 | [前](before-voice-disabled-desktop.png) → [后](after-voice-disabled-desktop.png) | [前](before-voice-disabled-phone.png) → [后](after-voice-disabled-phone.png) | [桌面](compare-02-disabled-desktop.png) · [手机](compare-02-disabled-phone.png) |
| 3 胶囊材质 | [前](before-hello-desktop.png) → [后](after-hello-desktop.png) | [前](before-hello-phone.png) → [后](after-hello-phone.png) | [桌面](compare-03-capsule-desktop.png) · [手机](compare-03-capsule-phone.png) |
| 4 晨光蓝色 | [前](before-lock-desktop.png) → [后](after-lock-desktop.png) | [前](before-lock-phone.png) → [后](after-lock-phone.png) | [桌面](compare-04-blue-desktop.png) · [手机](compare-04-blue-phone.png) |
| 5 纵向构图 | [前](before-hello-desktop.png) → [后](after-hello-desktop.png) | [前](before-hello-phone.png) → [后](after-hello-phone.png) | [桌面](compare-05-composition-desktop.png) · [手机](compare-05-composition-phone.png) |
| 6 收尾进度 | [前](before-finish-desktop.png) → [后](after-finish-desktop.png) | [前](before-finish-phone.png) → [后](after-finish-phone.png) | [桌面](compare-06-completion-desktop.png) · [手机](compare-06-completion-phone.png) |
| 7 html/body 底色 | [前](before-substrate-desktop.png) → [后](after-substrate-desktop.png) | [前](before-substrate-phone.png) → [后](after-substrate-phone.png) | [桌面](compare-07-substrate-desktop.png) · [手机](compare-07-substrate-phone.png) |

第 1 项图为点击后实际到达的工作页面；对应点击前 CTA 在第 6 项图中。第 7 项为明确的底层诊断图：只在取证时临时隐藏固定画布，显示真实 html/body 底色，没有修改 CSS 底色或伪造过渡。正常页面与转场采样见其余截图及日志。

北斗两个新版本的直接对比：

- 桌面：[144×60 北斗试作](trial-finish-desktop.png) / [圆点最终版](after-finish-desktop.png) / [并排](compare-north-choice-desktop.png)。
- 手机：[144×60 北斗试作](trial-finish-phone.png) / [圆点最终版](after-finish-phone.png) / [并排](compare-north-choice-phone.png)。

补充页面与状态：

- 公司快照：[桌面](after-company-desktop.png)、[手机](after-company-phone.png)、[手机滚到底](after-company-phone-scrolled.png)、[平板](after-company-tablet.png)、[矮桌面滚动](after-company-short-desktop-scrolled.png)。
- 录音中：[桌面](after-recording-desktop.png)、[手机页首](after-recording-phone.png)、[手机完整控制组](after-recording-phone-scrolled.png)；录后：[手机保存态](after-recorded-phone-scrolled.png)。
- 录音材质前后并排：[桌面](compare-03-listening-desktop.png)、[手机](compare-03-listening-phone.png)。
- 引导蓝色前后并排：[桌面](compare-04-welcome-blue-desktop.png)、[手机](compare-04-welcome-blue-phone.png)。
- 真实深链文案：[桌面](after-deeplink-desktop.png)、[手机](after-deeplink-phone.png)。成员：[我的工作](after-member-work-phone.png)。
- 回退：[减少动效](after-voice-reduced-motion.png)、[减少透明度／高对比](after-company-reduced-transparency-phone.png)。后者不代表 backdrop-filter 断言通过。

## 自评、消融与人工确认

美学自评 **8.5/10**：达到可交付的干净和统一。浅蓝光可感知但保持冷白画布，白玻璃卡承担阅读，群青胶囊承担形象，亮蓝按钮承担行动；桌面短页已形成完整的阅读和操作组。最终北斗删除使这套视觉语言更一致。独立看图复查未提出需要返工的视觉问题。

消融：移除北斗试作后，完成语义仍由标题、设置摘要、当前圆点和下一件事完整表达，所以删掉对应数据、分支、动画和样式。没有增加依赖、框架、实验开关或 API；没有为状态样式引入新组件。保留中央 6% 光、胶囊柔光和原因说明，因为它们分别直接服务本单明确要求。保留共享禁用规则的优先级，避免动画再次把不可用动作呈现成可用。

待人工确认：CEO 常用手机上的 Safari 安全区、动态工具栏和真实麦克风授权；真实声音驱动的观感、真实转码和腾讯声纹结果。本次浏览器 MediaRecorder／上传／API 同意校验／数据库是真的，麦克风输入、转换与供应商为测试替身，不能据此证明声纹识别质量。主题蓝白字仍按 spec 的既定约 3.6:1 取舍，未宣称达到普通正文 4.5:1。北斗与圆点的产品审美最终由 Claude／用户验收。

## 额外发现（记录，不顺手修改）

当前 Chromium 的“减少透明度”下，卡片背景确实成为实心 `rgb(247,249,252)`、边框也为 solid，但 `backdrop-filter` 仍是 `blur(40px) saturate(1.4)`。源规则写了标准和 WebKit 两项关闭声明，当前编译输出仅剩最后一项 `-webkit-backdrop-filter:none`，浏览器没有用它覆盖标准属性。已将 0d50e10 的相同源规则、当前源规则、编译片段保存到 [transparency-fallback.log](transparency-fallback.log)。此规则本单未动，最终样式 diff 也未涉及该规则；本次没有重跑旧运行环境，不能将 01 报告中“通过”的环境结论直接套到当前结果。按工单“其他发现写报告、不顺手改”，留给后续处理；本单七项和 Web 测试通过不包含这条额外断言。

## 自查环境与清理

- Web 3500、API 4500；`.scratch/preview-web-01p` 与 apps/web 同为仓库下二级目录，src/public 真实复制，只将 node_modules 设为 junction。最终全部 src 文件 hash 一致：[source-verification.log](source-verification.log)。未读取 .env 或密钥。
- 使用 54329 上专门创建的 `warmap_test_45fa14969e6e` 和公开测试常量。未使用共享 5432、真人口令或真实供应商。
- 专用 `onboarding01p` 浏览器已关闭。停止本次 Web/API 及子进程，3500/4500 无监听；临时库删除后存在数量为 0；先非递归断开依赖 junction、检查绝对路径和其他链接，再清理副本。原 src/public/node_modules 保留。
- 3100/4000 的 PID 22856、3200 的 PID 58088、4100 的 PID 63752 前后相同；3400/4400 本次检查时未监听，也没有对其执行停止操作。没有停 Docker 或其他服务。完整结果：[cleanup.log](cleanup.log)。
