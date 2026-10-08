# 交接：Co-Agent 胶囊（会议录音 + 入群讲来龙去脉）与三种形象

日期：2026-09-28 · 分支：`feat/mvp-member-workspace` · 状态：**代码已写、未提交**；只在浏览器里验证了“个人菜单 → Co-Agent 形象”弹窗。

参考图（用户给的，**熊猫必须严格照图**）：
- `.scratch/coagent-skins/ref/1.webp`：生命感（蓝色胶囊 + 发光眼睛），四个状态：待命 / 倾听 / 思考 / 回应
- `.scratch/coagent-skins/ref/2.webp`：熊猫，四个状态同上

---

## 1. 用户要的是什么（已定，不要再改）

1. **会议胶囊跟着一起做**：会议页按「开始会议」开始**录音**时，Co-Agent 胶囊出现在右列顶部居中（照搬 clark 概念版 C-07：`clark-main/src/components/coagent/panel.tsx` + `panel.module.css`，位置规则在 `clark-main/src/components/conversation/column.module.css` 的 `.jelly` 相关段落）。停止录音就消失。天枢还没有会中实时对话，所以只有“在听”这一种常驻姿势，**不长大、不写字**。
2. **新人第一次进群**：Co-Agent 在群里发的来龙去脉那段话出现时，胶囊**短暂出现**（约 4.2 秒，姿势是“在说/回应”），同时那段消息亮一下，强调“这段话是它说的”，然后胶囊凝回去。
3. **三种形象**，用户在个人菜单里选：默认（现在的 Siri 色光）/ 生命感 / 熊猫。**只换外观，出现逻辑和状态都不变。**
4. 美学方向（用户已同意）：
   - 生命感沿用现在的蓝色液态玻璃，只把色光换成眼睛；
   - 在听时眼睛随麦克风音量微微伸缩（替代 Siri 光）；
   - 不做待命时的随机眨眼，只在状态切换那一刻眨一下（“动”只表示有事在发生）；
   - 熊猫是白色身子 + 底下一圈蓝光（和旁边浅色页头胶囊区分开），耳朵探出胶囊上沿，身子本体和页头胶囊保持 48px 齐平；
   - 形象偏好只存本机 `localStorage`（不是业务数据，换设备回到默认）。

## 2. 已经做了什么（全部未提交）

新文件：
- `apps/web/src/components/coagent/skin.ts`：`CoAgentSkin = "classic" | "alive" | "panda"`，`useCoAgentSkin()`（localStorage 键 `tianshu.coagent-skin`，同页用自定义事件同步）
- `apps/web/src/components/coagent/presence.ts`：会议页和右列之间的小共享状态。`announceListening(scope | null)`、`announceLevel(0–1)`、`useListening(scope)`、`useListeningLevel()`
- `apps/web/src/components/coagent/PresenceCapsule.tsx`：胶囊本体，props `skin`、`pose: "listening" | "speaking"`、`level?`（只有预览传；不传就读录音的实时音量）、`leaving`（退场动画）。换姿势时用 `key={pose}` 重挂眼睛，播一次“眨眼”
- `apps/web/src/components/coagent/SkinPicker.tsx`：个人菜单弹窗里的选择器，有“在听 / 在说”预览开关，预览声音是模拟的
- `apps/web/src/styles/coagent-capsule.module.css`：三种形象的全部样式
- `apps/web/src/styles/coagent-skin-picker.module.css`

改动的已有文件（只动了下面这些，**其他 M 状态的文件是别的会话的改动，不要碰**，尤其是 `account-menu.module.css`、`app-shell.module.css`）：
- `components/meeting/useMeetingRecorder.ts`：录音时用同一条麦克风流接 AnalyserNode，每 60ms `announceLevel`；`status === "recording"` 期间 `announceListening("meeting:<id>")`
- `conversation/ConversationColumn.tsx`：新 props `coagent?: ReactNode`、`coagentBrief?: boolean`；根节点 `data-coagent="lasting" | "brief"`；胶囊放在 `.jelly` 里
- `styles/conversation-column.module.css`：`.jelly` 定位（右列展开宽度的中线、`--capsule-top`）；`lasting` 时右列页头下移到胶囊下面；`brief` 时页头内容淡出几秒；≤959 浮层里的位置
- `conversation/ConversationHost.tsx`（`RailConversation`）：`useListening(target.scope)` 决定常驻胶囊；`thread.catchUp` + 群聊可见时触发短暂出现（`CATCH_UP_MS = 4200`，退场 `320ms`），每条消息只触发一次
- `conversation/useTaskGroup.ts`：新导出 `catchUpMessage(messages, firstVisit)`；`firstVisit` = 这次打开时第一次读到的 `lastReadId === 0`（新人从没读过这个群）。只对议题/任务/会议群（thread 群）生效，Mission 群没接
- `conversation/TaskGroupTranscript.tsx`：`highlightId` → 该消息 `data-coagent-said`，滚到可见
- `styles/mission-group.module.css`：`data-coagent-said` 的蓝色高亮动画（末尾追加）
- `components/AccountMenu.tsx`：菜单里加「Co-Agent 形象」一项，打开 `MenuDialog` 放 `CoAgentSkinPicker`
- `conversation/useTaskGroup.test.ts`：加了 `catchUpMessage` 的单测

已跑过：`tsc --noEmit` 通过；`vitest run src/conversation src/cards/meetingWorkspace.test.tsx src/components/meeting` 全过（107 + 新增 1）。项目里没有 ESLint。

## 3. 还要做的（按优先级）

### 3.1 熊猫黑眼圈必须严格照 `ref/2.webp` 重画（用户明确要求）

现在的实现（`coagent-capsule.module.css` 里 `[data-skin='panda']` 那一段）黑眼圈太小、形状不对。下面是从参考图大图量出来的几何，已经按胶囊身子高 48px 换算好（比例系数 48/237 ≈ 0.2025）：

| 部位 | 参考图（px，身子高 237） | 换算到身子高 48px |
|---|---|---|
| 身子 | 855 × 237 | 用现有 184 × 48，不改 |
| 黑眼圈（每只） | 约 145 × 145，近似等宽等高 | **约 29 × 29** |
| 两只黑眼圈之间的空隙 | 约 39 | **约 8** |
| 黑眼圈整体 | 左右、上下都在身子正中 | 同 |
| 眼珠（白色竖条） | 约 33 × 85，圆头 | **约 7 × 17** |
| 左眼珠在左眼圈里的位置 | 中心在横向 69%、纵向 53% 处（**偏内侧**，也就是偏右） | 同比例 |
| 右眼珠在右眼圈里的位置 | 中心在横向 29%、纵向 52% 处（**偏内侧**，也就是偏左） | 同比例 |
| 耳朵 | 直径约 112，探出身子上沿约 50；外沿离身子左右端各约 90 | **直径约 23，探出约 10；离两端约 18** |

黑眼圈的**形状**：不是正圆，也不是现在那种小豆子。像一颗圆润的蛋或豆子，两只朝内侧上方收、朝外侧下方鼓。左眼圈顶部偏右、左下方鼓出（整体像“/”方向），右眼圈镜像（“\”方向）；内侧上角略平。颜色是近黑的深灰（`#1b1e25` 左右），带很淡的立体高光。建议用 SVG path 画黑眼圈，比 border-radius 更容易贴图。**做完要把截图和 `ref/2.webp` 并排对比**，大小和形状都对上才算完成。

四个状态在参考图下排小图里（天枢只用得到其中两个）：
- **倾听**（= `pose="listening"`）：眼珠竖着、偏高，高度随音量微微伸缩（现有 `--level` 机制保留）
- **回应**（= `pose="speaking"`，入群讲来龙去脉时）：眼珠变成**短的横条**（参考图里是小胶囊形横条，约眼圈宽的 30%、高约 12%），在眼圈正中
- 待命、思考：天枢目前没有对应状态，不用做

白色身子也按参考图：乳白、上亮下略灰蓝，边缘一圈半透明的冷色亮边，底下一团柔和的蓝色投影。

### 3.2 生命感的眼睛对一下 `ref/1.webp`
参考图大图里眼睛约 33 × 85（身子高 237）→ 换算 **约 7 × 17**，两眼中心距约 90 → **约 18**。现在是 7 × 16、间距 14，基本对，按图微调即可。“回应”是两颗短横条（约 11 × 5）。

### 3.3 「Co-Agent 形象」弹窗在矮屏上滚不动
视口高 500 时第三行（熊猫）被截掉、没法滚动。现在用的是 `MenuDialog` 的普通尺寸（没有 `max-height`/`overflow`）。改法二选一：`AccountMenu.tsx` 里给这个弹窗传 `wide`（已有 `max-height: calc(100dvh - 48px); overflow-y: auto`）；或在 `coagent-skin-picker.module.css` 里让 `.options` 自己滚。**不要改 `account-menu.module.css`**（别的会话有未提交改动）。

### 3.4 右列收起时，页头要给常驻胶囊让位（还没做）
clark 的规则在 `clark-main/src/components/conversation/column.module.css` 约 352–367 行：右列收起（strip）且会议在录音时，胶囊原地浮在阅读页上方，左边的页头胶囊（含“开始会议/计时”那颗）要往左让到“胶囊左沿 − 12px”。天枢的阅读页结构和 clark 不完全一样（`--conversation-lane`、滚动条宽度 `--reading-scrollbar` 都没移植），需要在浏览器里量了再写。clark 用 `ResizeObserver` 量滚动条宽度的代码在 `clark-main/src/components/conversation/column.tsx` 约 133–151 行。

### 3.5 浏览器验证（都还没验）
在 1440×900 和 390×844 两个尺寸下，三种形象各验一遍：
1. 会议页按「开始会议」→ 允许麦克风 → 胶囊出现在右列顶部居中，右列页头挪到胶囊下面；说话时色光/眼睛跟着动；「这场会开完了」→ 胶囊消失、页头回位
2. 录音中收起右列 → 胶囊不动、页头让位（3.4 做完后）
3. 新人第一次进群：用 CEO 在议题页「拉人进群」拉孙铭泽，再用孙铭泽登录打开该议题的群聊 → 胶囊出现约 4 秒（回应姿势），Co-Agent 那段消息同时亮蓝，然后一起淡出；刷新后再进不会再出现
4. 录音中又碰上入群介绍 → 胶囊切到回应姿势再回到在听，不闪退
5. `prefers-reduced-motion` 下没有动画，眼睛静止
6. 控制台无报错

## 4. 测试环境怎么起

**不要跑 `pnpm exec`/`pnpm --filter`**：另一个会话的“时间机器”正在运行，生成的 `apps/web-manual-preview` 会让 pnpm 的依赖检查失败。直接用本地二进制。

- 我复制了一份时间机器 API：`.scratch/manual-test/server-coagent.ts`（端口 4600，运行文件写到 `run-coagent/`，放行来源 `localhost:3100`），不影响正在运行的 3500/4500 那套。测试库在 55432。
- `.claude/launch.json` 里加了两项：`coagent-api`（4600）和 `coagent-web`（3100，`API_SERVER_URL=http://127.0.0.1:4600`），用 preview 工具按名字启动即可。
- 账号见 `.scratch/manual-test/README.md`（合成身份，一次性测试库）：`wangluyao` 主持明天 10:00 的会议；`browserceo` 可以在议题页拉 `browsermember`（孙铭泽）进群，用来测入群介绍。时间机器的 Agent 不连模型，进群介绍走降级文案（`threadIntro.ts` 的 catch 分支），同样是 Co-Agent 消息，足够测。
- 做完后删除 `server-coagent.ts`、`run-coagent/` 和 launch.json 里那两项（都只是验证用的临时东西）。

## 5. 约束提醒

- 项目规则见根目录 `CLAUDE.md`：MVP、最小改动；`apps/web` 不存业务数据（形象偏好是本机偏好，可以放 localStorage）。
- 引导页那颗 `components/onboarding/CoAgentCapsule.tsx` **不接形象**（用户选形象时已经看完引导了）。
- 提交前 `git remote -v` 确认 origin，只提交本文件第 2 节列出的文件。
