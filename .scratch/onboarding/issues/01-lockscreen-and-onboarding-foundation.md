# 01 锁屏与引导底座

Type: feature
Status: resolved
Blocked by: —
Spec: `../spec.md` v2 的 §2、§3（先读 `../inventory.md`、`../why.md`、`../spec.md`，再读本单）

## 目标

1. 锁屏换上和引导同一套"晨光"画面，去掉花哨的丝带壁纸。
2. 首次登录的人，以及已登录但没看过引导的人，先进全屏引导 `/welcome`。Co-Agent 胶囊是主角：先带他看与自己有关的工作，再做可选设置，最后直接把他带到下一件事。
3. 做出以后几张工单都要复用的视觉底座：画布、厚白玻璃、实心蓝控件、Co-Agent 胶囊、进度与北斗。

本单只实现引导的第 1、2、4、5 步：你好 → 公司目标与分工／你这个月的工作 → 声纹 → 可以开始了。第 3 步雷达归工单 02。步骤表要能在第 2 步之后插入雷达，插入时不用改动画和进度的实现。

## 质量标准（最优先）

- 交互效果和美学质量最优先。用户原话：「我很需要圆角矩形、毛玻璃这种极简的，干净然后充满新时代的力量与活力的那种感觉」「美学上要统一」。
- 气质参照 iOS 首次开机设置：一屏一件事、字大、留白足、按钮沉稳、动效克制但有生命感。
- 天枢里的"力量与活力"是：内容稳定、动作明确、状态可信；少量饱和的蓝承担行动与品牌，轻微动效回应真实操作。
- 做完要真的打开页面看：桌面 1440×900、平板 834×1194、手机 375×812。CEO 主要用手机，手机尺寸必验。能截图就截图自查，图存到 `.scratch/onboarding/evidence/01/`。
- 只要对某处"可能不够好"有疑虑，就按质量优先处理，并把理由写进报告。

## 一、视觉底座（后续工单共用）

1. **设计 token 只有一个来源**
   - 放进全局样式（`apps/web/src/app/globals.css` 的 `:root`，前缀自定），从现有的文字色、语义色、圆角、动效和厚玻璃参数映射过来，不另起一套近似值。
   - 至少包括：
     - 画布：底色、两团光的颜色
     - 厚白玻璃：填充、模糊、饱和、发丝边、内高光、阴影
     - 实心天枢蓝及按下态；墨色三档
     - 圆角三级：24／16／12，外加全圆
     - 动效：420ms `cubic-bezier(.32,.72,0,1)`；ease-brand `(.22,1,.36,1)`；150–240ms 反馈；240–320ms 换页；60ms 错开
     - 间距：4/8 倍数
   - 数值见 spec §3。
2. **`MorningCanvas` 画布组件**
   - 偏冷的白底（#F7F9FC → #FBFCFE），两团极大极淡的光：#3A83F7 约 8% 在左上，#5BD8F6 约 6% 在右下。
   - 光缓慢漂移，四五十秒一圈。
   - 接受一个"前进量"：引导每前进一步，光顺着方向漂 3–5%；后退时反向。
   - `html`／`body` 背景与画布底色一致，换页、刷新都不闪白。服务端首屏渲染出同样的画面。
   - 减少动效时静止。
3. **厚白玻璃**：一组共享的 class 或小组件，覆盖卡片、输入框、选项、开关轨道。
   - 做法：白 88–94% + `blur(40px) saturate(140%)`；发丝边；顶上 1px 白色内高光；阴影几乎看不见。
   - 只用在入口、设置容器、浮层和页头；阅读正文接近不透明；不叠多层玻璃。
   - 减少透明度时换实心 #F7F9FC；高对比时边换实线。
4. **`CoAgentCapsule` 胶囊组件**
   - 从 `C:\Users\10021\Desktop\clark\clark-main\src\components\coagent\` 移植 `panel.tsx`、`panel.module.css`、`siri-wave.tsx` 里要用的部分：胶囊外形、液态玻璃质感、SiriWave。会议相关的不搬。
   - 外形：
     - 实心深群青渐变 #0011FD → #0600A6 → #07058E，不透明。
     - 一圈细亮边，顶上弧形高光，底部略深。
     - 桌面约 224×64，手机约 184×52，两头全圆。
   - 状态：
     - `idle`：高光亮度 4 秒一周期，极轻地呼吸；里面一缕冷白到浅天青的光缓慢流动。
     - `acknowledge`：每次前进触发一次。宽度先长约 6% 再回原宽，420ms，无回弹；同时高光从左到右滑过一次。和换页并行，不挡输入。
     - `listening(level)`：只在录声纹时出现。换成 SiriWave 三色光（洋红、天青、紫），能量随麦克风音量起伏。音量用 Web Audio 的 `AnalyserNode` 从录音同一条 `MediaStream` 取。
   - 出现时从略小、略模糊凝出来，约 460ms。
   - 不可点，没有按钮，`aria-hidden`。
   - 减少动效时，光停在一帧，不做形变。
5. **进度组件**
   - 逐步用圆点：当前那颗拉成短胶囊，实心蓝；读屏播报「第 N 步，共 M 步」。
   - 最后一步显示北斗：七颗小星（天枢、天璇、天玑、天权、玉衡、开阳、摇光）从天枢开始依次亮起，间隔 90ms，组成北斗。
     - 整体约 96×36，按真实星位比例、略加规整。
     - 未亮的星：墨色 18%；亮起：实心天枢蓝。
     - 星间一根极淡的连线（墨色 8%、1px）。
     - 减少动效时直接亮。
   - 用户说过北斗"太散了，要做就做得优雅简洁；一旦不简洁、怪异或不协调，就放弃"。自查觉得不够好就去掉北斗，只留圆点，并写明判断和理由，附截图更好。

## 二、锁屏换装（`apps/web/src/app/access/*`、`styles/access.module.css`）

- 背景换成 `MorningCanvas`。删掉 `LockscreenBackdrop` 的壁纸和沿丝带的描光。`public/brand/tianshu-flow-lock-v3.webp` 在全仓库都不再被引用时一并删掉。
- 布局不变：左上角标志和「天枢」字标；中轴依次是锁形、时钟、日期、表单；页脚「天枢 · TKOS」。
- 时钟：墨色实心大字，不用渐变；保持原有字重和 tabular-nums。日期用 #535358。
- 「你的 ID」输入框和 4 格口令改成厚白玻璃：
  - 输入后格子里是实心墨点。
  - 聚焦 2px 实心天枢蓝，不用任何紫色。
  - 出错时整组左右轻晃一下，配红字 #BE123C；减少动效时不晃。
- 首次登录的"设置你自己的 4 位口令"用同一套样子。
- 登录流程和接口调用不变：输满自动提交、两遍口令、错误文案、锁定提示都照旧。
- 解锁：
  - 输入区向上淡出，画布不动。
  - 服务端返回 `onboarded === false` 时去 `/welcome?next=<原落地路径>`，否则按原来的 `landingPath`。
  - 保持 `replace`，不留锁屏历史。
- 现有的 `access.test.tsx` 要更新，并补上新分支。

## 三、引导 `/welcome`

### 3.1 路由与守卫

- `apps/web/src/app/welcome/page.tsx`（服务端组件），不放进 `(ceo)` 或 `(member)` 路由组：
  - 没登录：去 `/access?next=/welcome`。
  - 已看过：去有效的 `next`（按 `landingPath` 同一套规则校验），否则去该角色的首页。
  - 否则读 `GET /api/me/onboarding`，渲染客户端的引导流程。
- `lib/api/server.ts`：
  - `readSession` 带出 `onboarded`。接口没返回这个字段时按 `true` 处理，免得前后端部署不同步时把人关在引导里。
  - `requireCeo`、`requireMember` 发现 `onboarded === false` 时，重定向到 `/welcome?next=<目标路径>`。
- `(ceo)/layout.tsx`：是 CEO 但没看过时，直接 `return children`，由页面守卫跳转，不先拉首页卡片。

### 3.2 步骤与文案

文案见 spec §2.2，逐字使用；为排版可以微调字句，不改意思。

| 次序 | id | CEO | DRI | 出现条件 |
|---|---|---|---|---|
| 1 | `hello` | ✓ | ✓ | 总是 |
| 2 | `company` / `work` | 公司目标与分工 | 你这个月的工作 | 总是（缺数据写空态） |
| （3） | `radar` | 工单 02 插入 | 工单 02 插入 | — |
| 4 | `voiceprint` | ✓ | ✓ | 只在声纹已开通（`configured`）时 |
| 5 | `start` | ✓ | ✓ | 总是 |

**页面结构**
- 从上到下：
  - 左上角小标志；右上角安静的文字按钮「先进入工作台」（`start` 页不需要）。
  - 胶囊居中，距顶约 12vh。
  - 标题（胶囊说的话）；副标题或正文。
  - 内容区（厚白玻璃卡）。
  - 进度；按钮区：主按钮实心蓝、全圆；「稍后」「上一步」是文字按钮。
- 尺寸：内容栏最宽 560px；标题桌面 30–32px、手机 24–26px，600 字重；正文 16–17px，行高 1.6；主按钮文字 17px、600。
- 手机：两边 16px 边距，主按钮通栏、贴底，不横向滚动。

**换页**
- 旧内容 200ms 淡出，同时上移 8px、模糊 4px；新内容 320ms 从下方 12px、模糊 6px 淡入到清晰；标题、正文、内容、按钮依次错开 60ms。
- 同时胶囊 `acknowledge`，画布前进一步。
- 「上一步」反向。
- 动效不挡输入，快速连按不会乱。
- 减少动效时：150ms 交叉淡入淡出。

**焦点与键盘**：换页后焦点落到新标题；Enter 等于主按钮（输入控件里除外）；「上一步」可达；Tab 顺序合理。

**「先进入工作台」**：调 `POST /api/me/onboarding/complete`，然后按"结束"的去处规则走。

**第 2 步**
- 用 `GET /api/me/onboarding` 的真实数据。
- 缺数据时写 spec 的空态文案，不编；"没有登记"不写成"没有工作"。
- DRI 的"我的本月卡"那一行由工单 04 补。本单只写本月目标的三种状态和"我的 Mission"：
  - 按战场列出本月我名下 Mission 的标题，最多 3 条，其余写"另 N 条"。
  - 没有时写「这个月还没有登记你的 Mission」。

**第 4 步 声纹**
- 把 `apps/web/src/components/member/VoiceprintCard.tsx` 里的录音与录入逻辑抽成一个共享 hook（如 `useVoiceprintEnrollment`），VoiceprintCard 改用它。VoiceprintCard 的行为、文案、结构保持不变，它的测试要继续通过。
- 引导这一步用新的呈现：
  - 单独勾选同意，文字和 VoiceprintCard 一致。
  - 朗读稿（`VOICEPRINT_SCRIPT`）放在厚玻璃卡里。
  - 大圆形录音钮：实心蓝，麦克风图标，带计时和进度环；15 秒后可停，30 秒自动停。
  - 录音时胶囊进入 `listening`，随音量起伏。
  - 录完可以「保存」或「重录」。
  - 已录好：写日期，可重录。
- 拒绝麦克风、录失败，都给一句原因和「稍后」，不挡进入。
- 不改 `apps/api` 里任何声纹相关文件。

**第 5 步 可以开始了**
- 北斗七颗星依次亮起。
- 标题「可以开始了」；正文一句话写下一件事。
- 主按钮文字、链接都来自接口的 `next`。
- 设置摘要：本单只有声纹一行，雷达那一行由工单 02 加：
  - 声纹未开通：不写这一行
  - 已录好：「声纹 · 已录好」
  - 跳过了：「声纹 · 稍后在个人菜单里录」
- 结束的去处按先后：
  1. URL 上有效的 `next`：带着深链来办事的，回到原处
  2. 接口给的下一件事
  3. 该角色首页
- 按下后先调 `complete`，再带入场动效离开。失败时留在本页，写原因、给重试。

### 3.3 进入首页的入场

- CEO 现有的 `_entry=unlock` 入场（`CeoWorkspace.tsx`、`app-shell.module.css` 里的 `data-arriving`）改为基于新画布淡出、正文去模糊，不再引用丝带壁纸。
- 成员 `/me` 也加同样的入场：从锁屏或引导进来时触发。

## 四、接口与数据（`apps/api`、`packages/contracts`）

- **迁移**：用下一个空号（预期 `030`，写之前确认没被占用）建表 `person_onboarding(person_id TEXT PRIMARY KEY, completed_at TIMESTAMPTZ NOT NULL)`。同步更新 `apps/api/test/migrate.test.ts` 的迁移计数。
- **契约**：
  - `SessionResponse` 增加可选的 `onboarded: boolean`。
  - `LoginResponse` 在签发会话时增加可选的 `onboarded`。
  - 新增 `OnboardingResponse` 和 `CompleteOnboardingResponse`。
  - 改完 schema 后运行 `pnpm --filter @warmap/web gen:client` 重新生成客户端，不手改生成文件。
- **会话与登录**：`GET /api/auth/session` 返回 `onboarded`；`POST /api/auth/login`、`POST /api/auth/passcode` 签发会话时带上 `onboarded`。
- **新文件 `apps/api/src/routes/onboarding.ts`**，在 `app.ts` 注册：
  - `GET /api/me/onboarding`（`requirePerson`）
    - 两个角色都有：
      - `role`、`displayName`
      - `companyName`：环境变量 `COMPANY_NAME`，可空
      - `next{ text, action, href }`：`text` 是一句话，`action` 是按钮文字
      - `voiceprint{ configured, enrolled, updatedAt }`：调用现有的声纹状态读取，不改声纹文件
    - CEO：`company{ sixMonthGoal, battlefields[{id, code, name, ownerName?}], capabilities[{id, code, name}], people[{personId, displayName}] }`
    - 成员：`work{ period, planStatus: 'none'|'draft'|'negotiating'|'confirmed', battlefields[{id, name, monthTarget|null}], missions[{id, code, title, battlefieldIds}] }`
      - "参与的战场"：本月是这个战场的负责人，或本月在这个战场有 Mission。工单 04 会加上"本轮个人卡的 Owner"。
      - `monthTarget` 只在当期月度计划已签发时给原文，否则为 null。
  - `POST /api/me/onboarding/complete`（`requirePerson`，同站校验和其他写接口一样）：幂等写入 `completed_at`，返回 `{ onboarded: true }`。
- **下一件事**：服务端算，业务逻辑不放前端。
  - CEO，按先后取第一个成立的：
    1. 当期月度计划未签发："{M} 月的目标等你核对和签发"，按钮「核对 {M} 月目标」→ `/plans/{period}`
    2. 有红色议题："有 N 个红色议题等你判断"，按钮「去看看」→ `/`
    3. 今天有会："今天有 N 场会"，按钮「进入工作台」→ `/`
    4. 以上都没有："首页上暂时没有要你马上处理的事"，按钮「进入工作台」→ `/`
  - 成员：
    - 有未启动或进行中的执行事项："你有 N 件执行事项在推进"，按钮「看看我的执行事项」→ `/me`
    - 否则："会后分给你的事，会出现在首页和通知栏"，按钮「进入工作台」→ `/me`
  - 工单 04 会在最前面插入个人卡本轮的状态。
- **`COMPANY_NAME`**：写进 `.env.example`（注明可空）。如果 `infra/` 下的 compose 是逐个传环境变量的，一并加上。
- **测试**：
  - 会话 `onboarded` 的真、假两态
  - `complete` 幂等
  - 两个角色的 onboarding 数据：有数据、缺数据
  - `next` 的每个分支
  - 未登录返回 401；写接口的 Origin 校验
  - 成员拿不到 CEO 的公司快照

## 五、约束

- 遵守 `CLAUDE.md`：web 只做展示和 API 客户端；业务逻辑、数据和状态都在 api；契约先改 schema，再生成客户端。
- 不新增依赖。动效用 CSS、WAAPI 或少量 JS；不引 framer-motion、three.js 之类的库。
- **不提交、不推送**，也不执行 `git stash`、`reset`、`checkout`、`clean` 这类改动 git 状态的命令。提交由 Claude 在验收之后做，只提交本单的文件。另一个会话的改动已经提交，但它可能还在同一个文件夹里测试声纹接口。
- 共享文件只做最小的增量修改，动手前重新读一遍，别人可能刚改过。这类文件包括 `auth.ts`、`contracts/auth.ts`、`server.ts`、`app.ts`、`AccountMenu.tsx`、`MemberWorkspace.tsx`、`CeoWorkspace.tsx` 等。
- 不改 `apps/api` 的声纹文件（`voiceprints.ts`、`tencentVoiceprint.ts`，以及 `routes/me.ts` 的声纹部分）：另一个会话还在测试。
- 不读、不打印任何密钥或凭据（`.env`、`*.pem` 等）。可以用 `--env-file` 启动服务，但不要输出其中的值。
- 只删除本单产生的无用代码；不顺手重构、不格式化无关代码。

## 六、验证

1. 开工前先跑一遍基线，记下已有的失败：`pnpm --filter @warmap/api test`、`pnpm --filter @warmap/web test`。API 测试要用本机 `localhost:54329` 的测试库。
2. 完成后按顺序运行：
   - `pnpm --filter @warmap/contracts build && pnpm --filter @warmap/contracts test`
   - `pnpm --filter @warmap/web gen:client`
   - `pnpm --filter @warmap/api typecheck && pnpm --filter @warmap/api test`
   - `pnpm --filter @warmap/web typecheck && pnpm --filter @warmap/web test`
3. 失败分三类写清楚：本单引入的（必须修）、原本就有的（列出来）、环境限制（写明原因）。
4. 页面实看：
   - 锁屏：登录的两种状态、出错
   - 引导：CEO 和成员的每一步，以及「先进入工作台」
   - 每个页面看三种尺寸，再开"减少动效"看一遍

## 七、验收

- [x] 锁屏是新画布：没有丝带、描光和紫色；输入框和口令格是厚白玻璃；聚焦是蓝色；出错会轻晃；首次设口令是同一套样子；375 宽不横向滚动。
- [x] 没看过引导的人登录后进 `/welcome`；看过的人照旧进首页。
- [x] 会话有效但没看过引导的人，打开任何 CEO 或成员页面，都先进 `/welcome?next=…`。
- [x] 引导按角色显示第 1、2、4、5 步，数据是真实的；缺数据时写空态；声纹没开通时第 4 步不出现。
- [x] 每次前进：胶囊有克制的回应；内容按规定节奏换页；画布前进一步。「上一步」反向；Enter 可用；焦点落到新标题；快速连按不乱。
- [x] 圆点进度和读屏播报正确；最后一步北斗依次亮起（或按判断去掉，并写明理由）。
- [x] 声纹步：不勾同意不能录；录音时胶囊出彩色光，随音量起伏；保存成功；已录好的状态正确；拒绝麦克风不挡进入；「稍后」能跳过。VoiceprintCard 原有功能和测试不变。
- [x] 「先进入工作台」和最后一步都会写入完成记录。去处按"有效 `next` → 下一件事 → 首页"的先后；进首页有入场动效；之后再开 `/welcome` 直接回去。
- [x] 减少动效、减少透明度两套回退都有效。
- [x] 契约、类型检查、测试都通过（原本就有的失败除外）；生成文件是重新生成的；没有新依赖；没有无关改动。

## 八、完成后

- 把本单 `Status` 改为 `resolved`，在 `../map.md` 追加结果摘要：改了什么、验证结果、已知限制、需要人看的地方。
- 最终回复里列出：
  - 改动文件清单（新增／修改／删除）
  - 测试前后对比
  - 自查截图路径
  - 美学与交互的自评和关键取舍
  - 仍需人工确认的点
