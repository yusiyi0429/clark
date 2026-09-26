# 工单 01 实现与验证报告

已实现锁屏、引导底座、角色快照、可选声纹与首页入场，并完成三尺寸浏览器自查。没有执行 commit、push、stash、reset、checkout 或 clean。工单由 Claude 验收后提交。

## 实现范围

锁屏、全屏引导与首页入场共用晨光画布、厚白玻璃、实心主题蓝和胶囊视觉。登录会话带出 onboarding 状态，未完成者进入独立 `/welcome`；引导读取真实 API 的角色数据，完成后优先恢复有效深链，再进入服务端提供的下一件事。

新增 `person_onboarding` 迁移和接口；CEO 与成员快照在 API 按角色投影。声纹录入逻辑抽为 Web 共享 hook，原有 VoiceprintCard 复用；没有修改 API 的 `voiceprints.ts`、`tencentVoiceprint.ts` 或 `routes/me.ts` 声纹部分。没有新增依赖。

## 文件清单

以下为本单代码和配置清单，不把此前存在的未跟踪设计资料或 `seed/placeholders/` 计作本单新增。

### 新增：21 个代码／测试文件

- `apps/api/migrations/030_person_onboarding.sql`
- `apps/api/src/onboarding.ts`
- `apps/api/src/routes/onboarding.ts`
- `apps/api/test/onboarding.test.ts`
- `apps/web/src/app/welcome/page.tsx`
- `apps/web/src/app/access/PinField.test.tsx`
- `apps/web/src/components/member/useVoiceprintEnrollment.ts`
- `apps/web/src/components/member/useVoiceprintEnrollment.test.ts`
- `apps/web/src/components/onboarding/CoAgentCapsule.tsx`
- `apps/web/src/components/onboarding/MorningCanvas.tsx`
- `apps/web/src/components/onboarding/OnboardingProgress.tsx`
- `apps/web/src/components/onboarding/SiriWave.tsx`
- `apps/web/src/components/onboarding/WelcomeFlow.tsx`
- `apps/web/src/components/onboarding/foundation.module.css`
- `apps/web/src/components/onboarding/useHomeArrival.ts`
- `apps/web/src/components/onboarding/welcome.module.css`
- `apps/web/src/components/onboarding/welcome.test.tsx`
- `apps/web/src/lib/access-paths.ts`
- `apps/web/src/lib/api/server.test.ts`
- `packages/contracts/src/onboarding.ts`
- `packages/contracts/test/onboarding.test.ts`

### 修改：30 个代码／配置／生成文件

- `.env.example`：可空的公司名称说明。
- `apps/api/src/app.ts`：注册 onboarding 路由与环境类型。
- `apps/api/src/routes/auth.ts`：登录、首次改码和会话返回 onboarding 状态。
- `apps/api/src/server.ts`：读取公司名称配置。
- `apps/api/test/auth.test.ts`：更新会话与改码响应断言。
- `apps/api/test/helpers.ts`：允许测试覆盖公司名称。
- `apps/api/test/journey.test.ts`：更新会话响应断言。
- `apps/api/test/migrate.test.ts`：验证第 030 号迁移和新增表。
- `apps/web/src/app/(ceo)/layout.tsx`：未引导 CEO 由页面守卫接手。
- `apps/web/src/app/access/AccessScreen.tsx`：晨光锁屏、错误状态与引导去向。
- `apps/web/src/app/access/LockscreenVisual.tsx`：移除旧丝带背景，保留时钟。
- `apps/web/src/app/access/PinField.tsx`：本组焦点先移动，再调用完成回调，避免抢回确认口令的焦点。
- `apps/web/src/app/access/access.test.tsx`：更新视觉标记、角色落地与新分支。
- `apps/web/src/app/access/page.tsx`：传递可选深链。
- `apps/web/src/app/globals.css`：单一来源的共享 token 与首屏背景。
- `apps/web/src/components/member/MemberWorkspace.tsx`：成员首页入场。
- `apps/web/src/components/member/VoiceprintCard.tsx`：复用共享录音 hook。
- `apps/web/src/components/shell/CeoWorkspace.tsx`：CEO 首页晨光入场。
- `apps/web/src/lib/api/openapi.json`：契约生成物。
- `apps/web/src/lib/api/schema.d.ts`：契约生成物。
- `apps/web/src/lib/api/server.ts`：会话兼容与引导守卫。
- `apps/web/src/styles/access.module.css`：厚玻璃锁屏、蓝色聚焦、错误轻晃及无障碍回退。
- `apps/web/src/styles/app-shell.module.css`：替换旧壁纸入场。
- `apps/web/src/styles/account-menu.module.css`：修复手机浅底姓名胶囊的白字，保留桌面与深色窄条样式。
- `apps/web/src/styles/member-home.module.css`：修复手机通知空态的白字。
- `apps/web/src/styles/responsive-layout.test.ts`：更新入场样式契约。
- `infra/docker-compose.yml`：透传可空公司名称。
- `packages/contracts/src/auth.ts`：可选 onboarded 字段。
- `packages/contracts/src/index.ts`：导出新契约。
- `packages/contracts/src/openapi.ts`：注册 onboarding 契约与接口。

### 删除：1 个文件

- `apps/web/public/brand/tianshu-flow-lock-v3.webp`：新画布不再使用丝带壁纸。

### 本单证据与文档

- `.scratch/onboarding/evidence/01/browser-server.ts`：浏览器集成测试专用 API、一次性数据库及模拟声纹供应商。
- `.scratch/onboarding/evidence/01/capture.ps1`：多尺寸截图与页面检查。
- `.scratch/onboarding/evidence/01/browser-check.cjs`：浏览器流程、媒体查询、录音与跳转检查。
- `.scratch/onboarding/evidence/01/drop-fixture.cjs`：只允许删除显式命名的 54329 临时测试库。
- `.scratch/onboarding/evidence/01/cleanup-preview.ps1`：先断开 junction，再删除本次两个预览副本。
- `.scratch/onboarding/evidence/01/report.md`：本报告。
- 同目录的基线／最终测试日志、浏览器检查日志和 PNG 截图。
- `.scratch/onboarding/issues/01-lockscreen-and-onboarding-foundation.md`、`.scratch/onboarding/map.md`：状态与结果摘要。

## 测试与类型检查前后对比

| 检查 | 实现前 | 当前最终日志 | 结论 |
|---|---|---|---|
| Web 测试 | 32 文件、253 测试通过 | 36 文件、281 测试通过 | 新增 28 项测试，全部通过 |
| API 测试（`--maxWorkers=1`） | 40 文件通过、1 文件失败；470 通过、8 失败 | 41 文件通过、1 文件失败；477 通过、8 失败 | 新增 7 项测试通过，保留同样 8 个既有部署测试失败 |
| API 类型检查 | 通过（终端记录，未单独保存日志） | 通过 | 前后均无类型错误 |
| Web 类型检查 | 通过（终端记录，未单独保存日志） | 通过 | 前后均无类型错误 |
| Contracts build / test | 原有 39 项测试 | build 通过；42/42 测试通过 | 新增 3 项通过 |
| Web gen:client | 不适用 | 正式命令运行成功 | 未手改生成物 |

证据：`baseline-web.log`、`baseline-api-serial.log`、`final-web.log`、`final-api.log`、`final-api-typecheck.log`、`final-web-typecheck.log`。

最初按默认并发执行 API 基线得到 147 通过、331 失败，并有 1 个 suite 的退出 hook 超时；日志中大量失败为 5000ms 测试超时。改用单 worker 后收敛到上述 470 通过／8 失败，因此以相同串行条件比较前后。此环境限制另留 `baseline-api.log`，没有通过删除断言或屏蔽测试使结果变绿。

`final-web.log` 保留了 registry 未知 Card 的预期 stderr（`Unsupported Card kind: mystery`）；对应测试通过，不是新的页面运行错误。最后的手机文字和录后滚动修复之后，已再次运行完整 Web 测试和类型检查。`git diff --check` 退出 0。

### 原本就有的 8 个 deployment.test.ts 失败

| 测试 | 基线与最终表现 | 已定位原因 |
|---|---|---|
| defaults to compose mode: dumps inside the postgres container without DATABASE_URL or password | 预期 docker 调用日志为空 | Windows 临时路径未经 bash 转义插进桩脚本重定向，反斜杠被吞，写到了另一文件 |
| compose mode freezes only a running api before pg_dump and restarts it last (trap) | 找不到预期 stop／dump／start 序列 | 同上，读取了空的预期日志文件 |
| defaults to dry-run and refuses to touch a non-empty target database | 预期拒绝覆盖，实际提前 checksum 不匹配 | GNU sha256sum 对反斜杠路径输出转义前缀，脚本把前缀纳入 hash |
| passes only when the target is empty, and --execute is required to write | 预期成功，实际退出 1 | 同上，未进入目标库检查 |
| refuses a non-empty target volume before any write (even in dry-run) | 预期非空卷错误，实际 checksum 不匹配 | 同上 |
| fails closed when a restored volume file SHA does not match the restored DB rows | 预期存储校验失败，实际 checksum 不匹配 | 同上 |
| passes with explicit empty volumes and verifies every DB storageKey/SHA against the volumes | 预期进入卷文件校验，实际 checksum 不匹配 | 同上 |
| database-only restore is allowed but explicitly declares volumes unsupported | 预期成功，实际退出 1 | 同上 |

只读诊断已对非敏感仓库文件的 Windows 绝对路径复现 sha256sum 前缀行为。这些不是本单引入的业务失败；本单未扩大范围修改部署脚本。

## 浏览器证据

截图目录：`.scratch/onboarding/evidence/01/`。

完成并实际查看的截图组包括：

- `lock-{desktop,tablet,phone,reduced-motion}.png`
- `lock-error-{desktop,tablet,phone,reduced-motion}.png`
- `lock-set-{desktop,tablet,phone,reduced-motion}.png`
- `ceo-hello-{desktop,tablet,phone,reduced-motion}.png`
- `ceo-company-{desktop,tablet,phone,reduced-motion}.png`
- `ceo-voiceprint-{desktop,tablet,phone,reduced-motion}.png`
- `voice-recording-desktop.png`
- `ceo-start-*`、`member-hello-*`、`member-work-*`、`member-voiceprint-*`、`member-start-*`
- `member-work-confirmed-*`、`member-work-no-plan-*`、`member-work-empty-*`、`ceo-company-empty-*`
- `voice-recorded-*`、`voice-enrolled-*`、`voice-permission-denied-phone.png`、`complete-retry-phone.png`
- `ceo-home-*`、`member-home-*`、`ceo-company-reduced-transparency.png`、`voice-listening-reduced-motion.png`
- `voice-unconfigured-hello-*`、`voice-unconfigured-start-*`、`ceo-company-phone-scrolled.png`

命名中的 desktop 为 1440×900，tablet 为 834×1194，phone 为 375×812；`*-reduced-motion` 为手机减少动效。`browser-integration.log` 记录了页面标题、横向溢出与手机主按钮位置；所有最终检查都没有横向溢出，手机主按钮底边为 748px。早期 `browser-checks.log` 有热更新回到 hello 的旧记录，相关截图已用最终流程重新拍摄，以后者为准。

浏览器已验证：两个角色各步、提前进入、完整结束、守卫保留深链、已完成者跳过引导、未签发计划不泄露目标、已签发目标原文、缺计划／缺资料空态、Enter 与标题焦点、快速前后切换、缺 ID 聚焦、首次改码清空与确认校验、完成失败留页且不写库、重试成功。首页 SSR 带 `data-arriving=true`，客户端消费 `_entry`；两角色均验证。录音使用真实 MediaRecorder 路径，验证授权前禁用、15 秒可停、30 秒自动停、重录、保存、已录日期和拒绝权限后跳过。监听画布正常变化；开启减少动效后连续两帧一致。CDP 实际模拟减少透明度，计算样式为 `rgb(247, 249, 252)`、`backdrop-filter:none`，高对比边框为实线。

声纹配置关闭后另起独立测试库，两个角色均直接从快照进入最后一步，共 3 步；不显示声纹摘要，也不预告可录音。最终共保存 90 张截图。长公司快照滚动到底后，人员行和说明均在固定底栏上方，已补拍确认。

保留的浏览器日志有早期自动化失败：Next 路由播报器使宽泛 alert 定位器匹配两项、URL glob 未匹配含斜杠的查询参数、快速导航脚本等待下一步按钮超时、一次 CDP 重连超时。已收窄定位器、采用实际状态等待、重启本次专用浏览器并完成后续验证；这些失败记录没有计入通过结果。快速前后切换在最终独立流程中再次通过，标题焦点正确且旧内容节点清理完毕。

## 美学与交互取舍

- 保留偏冷白底与两团极淡的晨光；白玻璃的边线和填充负责层次，饱和蓝只承担胶囊、进度与主动作。相比旧丝带画面，新入口更安静，时钟、姓名和下一步动作成为清晰的阅读顺序。
- 手机主 CTA 固定在底部、左右保留 16px，并预留安全区与正文滚动空间。公司快照和朗读稿较长时仍能看到下一步或稍后；录完音会把时长和重录入口滚到操作区上方。桌面内容较多时适度收紧纵向间距，保留清晰层次。
- 桌面 hello 页留白较大，刻意保持一屏一件事；内容最宽 560px，胶囊不做按钮，减少误触和无效探索。
- 末页北斗保留为 96×36 的紧凑标记，七星按 90ms 错开亮起，其余步骤用圆点。主负责人和独立复查都认为最终手机图上足够安静协调，因此不退回圆点。
- 主题蓝 `#3A83F7` 与白字约 3.6:1，这是 spec 已明确接受的产品色彩取舍。主按钮保持 17px、600 字重；本报告不将其表述为满足普通正文 4.5:1 的对比度要求。
- 减少动效时画布和胶囊静止，步骤以 150ms 淡入淡出衔接；减少透明度改用实心底色，已通过真实媒体查询模拟检查。
- 欢迎文案不预告工单 02 尚未交付的雷达；声纹未配置时也不承诺可以录音。CEO 尚无当期计划对象时进入首页，避免把第一次登录的人带到不存在的计划页；已有但未签发的计划仍是最高优先级。
- 首次改码实测发现旧 PIN 复用、异步焦点抢回，以及修改新口令后确认值过期的边界；均作最小修复并补入 5 项事件回归测试。

独立截图复查覆盖公司三尺寸、成员工作、完成页、手机首页与录后状态；发现的问题已修复、补拍。开发服务的 Next.js 左下角指示器属于开发工具。为避开其他服务占用的 `.next/dev/lock`，自查 Web 使用独立临时副本；最终非测试 `src` 文件逐一 hash 比对，无差异。没有修改原开发服务的构建目录。

## 环境边界与人工确认

- 浏览器测试 API 使用 54329 上单独创建的 `warmap_test_*` 数据库、公开测试人员常量和示例业务数据，不接触共享 5432 开发库或真人口令。
- 浏览器录音集成使用模拟麦克风、模拟转码和模拟腾讯供应商；UI、MediaRecorder、上传、API 同意校验和 PostgreSQL 状态写入可分别验证，但这不证明真实腾讯声纹接口、真实麦克风音质或真人识别效果。真实供应商联调由正在处理声纹接口的会话／人工验收确认。
- 真实 iOS Safari 的麦克风授权、系统键盘、安全区和动态工具栏不能完全由 Chromium 的 viewport 模拟代替，建议用 CEO 常用手机做一次短验收。
- 北斗是否保留、主题蓝白字的既定对比度取舍，以及长公司名称／长工作清单的实际观感仍需要产品验收。
- 本单 API 为 4300、Web 为 3300；进程和临时库的最终清理结果见下方记录。不停止 3100／3200／4000／4100 服务，不操作 Docker 容器，不修改共享 5432 数据库或真人口令。

## 最终清理

- 本次专用浏览器 `onboarding01`／`onboarding01off` 已关闭。
- Web 3300、API 4300 的自查进程已停止，最终监听检查为 0。
- 54329 上 `warmap_test_db385743162e` 和 `warmap_test_5967e6da4566` 已删除，各自数据库存在性检查为 0；未清理任何其他测试库。
- `.scratch/onboarding/preview-web`、`runtime-web` 已清理。先非递归删除它们的 node_modules／src／public junction，再确认不存在其他 reparse point 后删除副本；原始源目录和依赖目录保持完整。
- API 声纹文件、依赖清单与 lockfile 均无 diff；工单状态和 map 已更新为 resolved。保留全部源码、测试、截图与日志供 Claude 验收，不提交。
