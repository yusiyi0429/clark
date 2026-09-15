"use client";

import { useRef, useState } from "react";
import { ChatPane } from "@/components/advisor/chat-pane";
import {
  CommandBriefView,
  IntelligenceDrawer,
  pickCommandBrief,
  type CommandBriefEdits,
} from "@/components/advisor/command-brief";
import { JudgementBoardPane } from "@/components/advisor/judgement-board";
import { ReportPane } from "@/components/advisor/report-pane";
import type { AnchorFocus } from "@/components/advisor/anchored-doc";
import { AsyncBoundary } from "@/components/async-boundary";
import { PaneTab, PaneTabDock, PaneTabGroup } from "@/components/pane-tabs";
import { api } from "@/lib/data/client";
import type {
  CommandBriefEdits as StoreCommandBriefEdits,
  Issue,
  IssueReport,
  JudgementBoard,
  ProbeMap,
  ReportDelivery,
  ResearchDoc,
} from "@/lib/data/types";
import { dispatchBlockReason, readReportDelivery } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 议题研究。
 *
 * 版面是**两栏对半**，右边那栏固定是对话，不再是可收起的覆盖层：
 *
 * - 左：当前判断（默认）/ 行动整理（他自己走进去之后才有）/ 情报附件 / 知识关系。同一排页签。
 * - 右：与参谋的对话。常驻。
 *
 * ## 默认落点是判断，不是命令
 *
 * **研究完成 ≠ 已形成决议 ≠ 应该立即派发命令。** 上一版把决策题的默认页换成了「参谋决断」
 * （决断包 + 批准并下达），那一条被推翻了：深研跑完时一号位手上有的是一份研究结论，不是
 * 一份等着他签字的命令。`SubjectCard.decision === true` 说的是「这道题需要做选择」，
 * 不是「他现在授权派发」。
 *
 * 所以默认那一屏是**判断那一面**：当前判断、依据、成立条件、下一步要弄清的问题（判断板，
 * `judgement-board.tsx`，视觉一个像素没动）。决断包退成一个**显式入口** —— 板子底下那一行
 * 「整理成行动建议」，按下去才有「行动整理」那一格。
 *
 * 这不只是把按钮藏起来：按下去的那一下会落到服务端（`api.enterActionStaging`），而批准
 * 那一路读它（`store.approveCommandBrief`）。`/api/data` 是个直接 POST 就打得进来的口，
 * 只在浏览器里记这件事等于没记。
 *
 * **没有决断包的报告一样好用**（行业题、这一版之前跑出来的那些，还有这一轮参谋没写出
 * 行动建议的）：那时候底下那一行入口不长出来，这一页就是判断、情报附件、知识关系三格。
 *
 * ## 模型名不在这一屏上
 *
 * 「深研 v2」「DeepSeek」「Claude」是链路和模型口径，是我们做这套东西的人才关心的事。
 * 它们只在情报附件那一栏里出现（那一栏的第二条页签长条），因为核对「这两份看的是不是
 * 同一批材料」时署名是唯一的入口。这一条是上一批定的，保留。
 *
 * 报告那几枚页签是**按数据长出来的**（`reports.map`），顺序和名字都由产出那一轮给
 * （`a4/run.ts` 的链路表 → `store.listReports`），所以多一条链路不动这一层。报告列表
 * 由这一层持有：页签行按它排页签，`ReportPane` 按它取正文（同一个 SWR key，不多取一次）。
 *
 * 上一版右边是「把关区」，对话盖在它上面、可以收成右下角一枚胶囊。那个安排背后的假设
 * 是「一号位大部分时间在读和在审，对话是工具」。这一版推翻了它：**这一页的重心就是
 * 对话**。判断不是在读报告的时候产生的，是在追问的时候产生的 —— 报告只是这场追问的
 * 底座。所以对话不再需要被找出来，它一直在那儿；而左边那栏回答的是「我们刚才聊出了
 * 什么」。
 *
 * 左边默认不是报告：他进这一页时，报告参谋已经读过了 —— 决断包是参谋读完之后的
 * 那一次汇报（有它就看它），判断板是它的上一版形态（没有决断包时看它）。要核原文，
 * 页签换一下就是。
 *
 * 整页不滚。两块各自有滚动条，页面本身没有 —— 两个独立滚动区之外再来一层页面滚动，
 * 滚起来永远不知道动的是哪一层。
 *
 * ## 两栏之间只有一条线
 *
 * 这一页**没有卡片**。上一版是两块 `.card`（白面、一圈发丝线环、圆角）摆在桌面上、
 * 中间留 16px 的缝，四周再留 16-24px 的边。那个安排把这一页读成了「桌上摊着两份文件」，
 * 而它实际上是**一块屏幕两半用**：左边一份研报正文，右边一整场关于它的对话，眼睛要在
 * 两边来回走。两个框的八条边、两圈圆角、中间那道缝，全都在这条来回的路上。
 *
 * 所以：整页的底就是纸（`--surface`，铺满视口，连顶栏底下也是），两栏各自贴着这张纸，
 * 中间一条发丝线。**边界没有消失，它换成了那条线** —— 一条线只说「这儿是分界」，
 * 一个框说的是「这里面是另一份东西」，而左右两边不是两份东西。
 *
 * 「文字落在哪、在哪换行」一个像素都没动：外层的左右内边距、两栏各自的内边距、正文
 * 那几档字号行高全部照旧。变的只有它们外面那层壳。纵向反而多出 32px（原来上下各
 * 16px 的页边距去掉了，那条线因此从顶走到底）。
 *
 * 这一页**没有自己的 header**：议题编号、标题、语音过一遍、指派负责人、定这件事全部长在顶栏里
 * （`components/advisor/issue-header.tsx`）。
 */

/**
 * 屏幕上改了什么 → 库那一侧的 `CommandBriefEdits`。
 *
 * 两个形状**故意不一样**，所以这里要有一次翻译，不能把库的类型直接搬到组件上：
 *
 * · 屏幕按**下标**认命令（包里没有别的 id，位置就是身份），库那侧要的是显式的 `index`；
 *   没改的那几条在屏幕上是数组里的空洞，翻过来就该整条不出现，而不是一条 `{}`。
 * · 屏幕上那格叫「负责人」，写的是一行自由文本；库里那栏叫 `driId`。名字不同不是笔误 ——
 *   这个产品此刻没有一份可信名册，他写的字原样带过去，落到谁头上由接的那一侧解析。
 *
 * 翻译只带**改过的**那几格：库那侧按 `undefined` 判「这一格没动」，全量覆盖会把他没碰过
 * 的期限和验收条件一起写一遍。
 */
function toStoreEdits(edits: CommandBriefEdits): StoreCommandBriefEdits {
  const out: StoreCommandBriefEdits = {};
  if (edits.action !== undefined) out.recommendation = { action: edits.action };
  const orders = (edits.orders ?? []).flatMap((o, index) => {
    if (!o) return [];
    const one: NonNullable<StoreCommandBriefEdits["orders"]>[number] = { index };
    if (o.role !== undefined) one.role = o.role;
    if (o.dueOn !== undefined) one.dueOn = o.dueOn;
    if (o.acceptance !== undefined) one.acceptance = o.acceptance;
    if (o.dri !== undefined) one.driId = o.dri;
    return [one];
  });
  if (orders.length) out.orders = orders;
  return out;
}

/**
 * 左栏此刻显示哪一格。
 *
 * 抽成一个纯函数是因为这两句里藏着这一版最要紧的那条产品语义，而它坏了**屏幕上不会
 * 报错** —— 只是深研跑完之后一号位第一眼看到的东西从判断变回了一份等他签字的命令。
 *
 * · **默认恒为判断**（`tab === null` 那一档）。不再按「这一轮有没有交出决断包」挑：
 *   研究完成不等于已形成决议，更不等于该立即派发命令；`SubjectCard.decision === true`
 *   说的是这道题要做选择，不是他现在授权派发。报告列表还没回来的那一瞬也是判断，
 *   于是这一页从第一帧起就停在同一格上，不会当着他的面跳一次。
 * · **行动整理那一格没了就落回判断**。两种会发生：他站在那一屏上按了「退回参谋重拟」，
 *   这一轮的报告连同包一起被清掉；或者重取回来发现服务端并没有记下这一步（换了一轮
 *   报告）。不落回的话，`tab` 指着一格不存在的页签，屏幕上没有任何一格被选中、正文一片
 *   空白。
 */
export function shownTabOf(o: { tab: string | null; hasBrief: boolean; staged: boolean }): string {
  const picked = o.tab ?? "probe";
  return picked === "command" && !(o.hasBrief && o.staged) ? "probe" : picked;
}

export function AdvisorView({ id, quote }: { id: string; quote?: string }) {
  const issueRes = useResource<Issue>(`issue:${id}`, () => api.getIssue(id));
  const probeRes = useResource<ProbeMap>(`probe:${id}`, () => api.listProbe(id));
  /*
   * 判断板。和首页右栏是同一个 key 前缀、同一个组件 —— 他在首页看到的三条待确认，
   * 点进来还是那三条。两边各画一版的话，「我刚才在首页看到的那条呢」会成为一个
   * 真实的问题。
   */
  const boardRes = useResource<JudgementBoard>(`board:${id}`, () => api.getBoard(id));
  /*
   * 这件议题现在有哪几份报告。摊平成一排之后页签行要先知道有几份，所以这份数据在
   * 进页面时就取 —— 不是等他点到报告那一栏才取。
   *
   * 这不会提前烧 token：真正起那一轮深研的是「采信」那一下（`disposeCard`），而
   * `ensureDeepResearch` 自己挡 demo、自己认已经有报告的、自己认跑挂过的，同一件议题
   * 也不会起两轮。
   */
  const reportsRes = useResource<IssueReport[]>(`reports:${id}`, () => api.listReports(id));

  /*
   * 划线句与链路之间的两条线：点报告里的划线句 → 对应节点亮起（focusNodeId）；
   * 点节点上的「来源」→ 报告滚回那一句（anchorFocus）。nonce 让连点同一句也生效。
   */
  /*
   * 报告里的定位。判断板换上来之后没有「跳到报告第几句」的入口了 —— 板上的判断
   * 是从对谈和研报综合出来的，指不回原文的某一句。保留这个 state 是因为 ReportPane
   * 还读它；它现在恒为 null，报告打开就是从头读。
   */
  const [anchorFocus] = useState<AnchorFocus | null>(null);
  /*
   * 选中的页签，四选一：
   *
   *   probe      当前判断 —— 那块判断板。**默认就是它**，与这一轮有没有决断包无关。
   *   command    行动整理 —— 决断包那一屏。**他自己走进去过才有这一格。**
   *   intel      情报附件 —— 二十一节论证与取证记录，几条链路各自的原件都在这一栏里
   *   knowledge  知识关系
   *
   * `null` = 他还没自己点过，那就是默认那一格。上一版这里存 `null` 是因为默认页要等报告
   * 列表回来才知道（有决断包就落在决断包上）；现在默认页恒为判断，这个 `null` 只剩「他
   * 点没点过」这一层意思 —— 而这一层仍然要存：走进行动整理之后那一格才出现，出现的
   * 那一下要跟着选中它。
   */
  const [tab, setTab] = useState<string | null>(null);
  /*
   * 「他刚按下了整理成行动建议」。
   *
   * 真相在服务端（`ResearchDoc.actionStagingAt`），这里只是**等重取回来之前的那半秒**：
   * 按下去 → 库里落了时刻 → `reports` 重取 → `delivery.staged` 变 true。中间这一段如果
   * 只认服务端那一份，「行动整理」那一格会在他按完之后消失半秒又回来。
   *
   * 只往一个方向兜（false → true）：退回参谋重拟之后这一轮的报告连同包一起没了，那时
   * 该由服务端那一份说话。
   */
  const [entered, setEntered] = useState(false);
  /*
   * 情报附件里此刻在看哪一份原件（报告的 `key`：`agent`、`agent:alt0`、`dri`…）。后面
   * 这几个是运行时才知道的（配了几把钥匙、有没有派出去过），所以是 string，不是闭合的
   * 联合类型。
   *
   * 和 `tab` 分开存：他在附件里翻到别人写的那一份、切回决断包看一眼再切回来，看到的应该
   * 还是那一份。合成一个 state 的话，那一下等于把附件重置回主源。
   */
  const [lane, setLane] = useState<string>("agent");

  /*
   * 「就这句聊」「引用提问」从左栏把一段话递进对话。两栏是兄弟组件，引文状态在对话
   * 内部 —— 用一个 ref 递函数，不把整个输入状态提上来。
   */
  const composerRef = useRef<{ quote: (text: string) => void } | null>(null);
  const sendQuote = (text: string) => composerRef.current?.quote(text);

  const map = probeRes.data ?? { rootLabel: "深研报告", initial: null, nodes: [], edges: [] };
  // 页签上只写**已确认**的条数。待确认的数量每轮对话都在变，写上去它就成了一个
  // 一直在跳的数字；而已确认那一层是账，账的条数才值得挂在页签上。
  const confirmedCount = boardRes.data?.confirmed.length ?? 0;
  const reports = reportsRes.data;

  /*
   * 这一轮有没有交出可批准的行动建议（连着产出它那条链路自己的证据表，见 `pickCommandBrief`）。
   *
   * 行业题、这一版之前跑出来的报告、以及这一轮参谋没写出行动建议的，都没有 —— 那时板子
   * 底下那一行入口不长出来，这一页照常好用。**没有命令包是合法的。**
   */
  const brief = pickCommandBrief(reports);
  /*
   * 主源那一份报告 —— 交付完整性和「进没进过行动整理」记在它上面。
   *
   * 读主源而不是读产出决断包的那一栏：`actionStagingAt` 落在 `store.researchDocs[issueId]`
   * 上，那是一件议题只有一份的东西；而决断包可能挂在别的链路上（主源挂了的那种情形，见
   * `pickCommandBrief`）。
   */
  const agentDoc: ResearchDoc | undefined = reports?.find((r) => r.key === "agent")?.doc;
  const delivery = readReportDelivery(agentDoc);
  /** 他明确走进过行动整理没有。服务端那一份为准，`entered` 只兜重取回来之前那半秒。 */
  const staged = delivery.staged || entered;
  const shownTab = shownTabOf({ tab, hasBrief: Boolean(brief), staged });
  /*
   * 选中的那份原件不在列表里了，就落回主源那一份。
   *
   * 会发生：他正读着别人写的那一栏，又起了一轮深研，而这一轮那个模型没写成 —— 那枚页签
   * 消失，`lane` 指向一个不存在的东西，正文说的是「深度研究还在装配」，而报告就在旁边
   * 那一栏里。
   *
   * 算出来的，不是效应体里改状态：`reports` 还没到的那一瞬（缓存被清、正在重问）不许下
   * 结论 —— 那时候什么都不在列表里，会把他正在读的那一栏也顶掉。
   */
  const shownLane =
    lane === "agent" || !reports ? lane : reports.some((r) => r.key === lane) ? lane : "agent";

  /*
   * 「退回参谋重拟」—— 四个主操作里这一轮真接上的那一个。
   *
   * 它就是「打回重研」那条路：`api.requestRework` → `store.requestRework` →
   * `reopenDeepResearch`（清 `researchDocs`、清没跑完的原件、`clearTask("deep")` 和
   * `clearTask("judge")` 两道闩一起解、再起一轮）。留言原样带过去。不另开一条新路：
   * 那条路顺手做的两件事（留言发给承接人、时间线上按真实状态留一条记录）绕过去就丢了。
   *
   * 起完之后把报告列表和判断板都重取 —— 这一轮的包和报告刚被清掉，屏幕上那一格要跟着走。
   */
  const rework = async (note: string) => {
    await api.requestRework(id, note);
    setEntered(false);
    void reportsRes.mutate();
    void boardRes.mutate();
  };

  /*
   * 「整理成行动建议」—— 从研究那一面走到行动那一面的那一下。
   *
   * 它**先落服务端**再换页签：这一下正是批准那道闸读的东西（`store.enterActionStaging`
   * → `ResearchDoc.actionStagingAt` → `store.approveCommandBrief`）。只在浏览器里换个
   * 页签的话，那道闸等于只把按钮藏了起来，而 `/api/data` 是直接 POST 就打得进来的。
   *
   * 落完顺手把报告列表重取一次：`actionStagingAt` 挂在报告上，屏幕上那一格靠它长出来。
   * `entered` 兜住重取回来之前的那半秒。
   */
  const enterStaging = async () => {
    await api.enterActionStaging(id);
    setEntered(true);
    setTab("command");
    void reportsRes.mutate();
  };

  /*
   * 批准并下达 / 修改后批准 / 暂缓。
   *
   * 三个动作走**同一个口**（`api.approveCommandBrief`）：批准是不带 `edits`，修改后批准是
   * 带 `edits`，暂缓是带 `hold`。那一侧在一段不 await 的同步代码里做完五件事（记一条正式
   * 决策、固化改过的决心、命令逐条落库、指挥边界写进重开条件、议题状态推进），所以这里
   * 不需要也不应该分三条路 —— 分开写的话，「批准之后议题状态没推进」这类错会只在其中
   * 一条上出现。
   *
   * **命令只落在本地账上。** 不发通知、不写回本体（memory-api 现在只读）。这句话在
   * `store.approveCommandBrief` 的头注释里也写着 —— 屏幕上说「已下达」，实际到达的只有
   * 这个库，别处一个字都没收到。
   */
  const approve = async (edits: CommandBriefEdits | null) => {
    await api.approveCommandBrief(id, edits ? { edits: toStoreEdits(edits) } : undefined);
    void boardRes.mutate();
    void issueRes.mutate();
    /* 批准会把他改过的那一版**固化回报告**，所以报告列表也要重取 —— 不取的话屏幕上
       摆的还是参谋原来那一版，而库里已经是他点头的那一版。 */
    void reportsRes.mutate();
  };
  const defer = async (note: string) => {
    await api.approveCommandBrief(id, { hold: { why: note } });
    void boardRes.mutate();
    void issueRes.mutate();
  };

  return (
    <>
      {/*
       * 这一页的底是整片纸。
       *
       * 铺满视口（`fixed inset-0`）而不是只铺内容区：桌面色（`--paper`）留在下面任何
       * 一条边上，就还是「一块白板摆在灰桌上」—— 那正是这一版要拆的读法。连顶栏底下
       * 也是这张纸，所以那一行和正文之间没有材质的接缝。
       *
       * 它是 `.animate-panel` 那个元素的**兄弟**，不是后代：`animate-panel` 带 transform，
       * 而 transform 会把 `fixed` 的基准从视口换成那个盒子。
       */}
      <div aria-hidden className="fixed inset-0 -z-10 bg-surface" />
      <div className="animate-panel mx-auto flex h-[calc(100vh-3rem)] w-full max-w-[1600px] flex-col overflow-hidden px-5 sm:px-6">
        <AsyncBoundary resource={issueRes} skeleton={<AdvisorSkeleton />}>
          {() => (
            <div className="grid min-h-0 flex-1 items-stretch lg:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]">
              {/* 左栏：当前判断、行动整理、情报附件、知识关系共用一栏，一排页签切换。
                  两栏之间那条线画在它的右边沿（`lg:border-r`）——「一条线」只能是一条，
                  两边各画半条就成了两条紧挨着的线。窄屏上两栏是上下叠的，那时候这条线
                  横过来（`border-b`）。 */}
              <section
                /*
                 * `--pane-inset-top`：正文第一行往下让出多少给那条悬浮的页签长条。
                 * 长条压在正文上（`absolute`），不占流里的高度，所以这个数只能由这一层
                 * 给 —— 首页右栏也用同一块判断板，那里没有长条，取各自的默认值。
                 *
                 * 56px = 8（离顶）+ 34.6（长条自己：12px 的字 × 1.55 行高 + 按钮
                 * 上下 4 + 长条上下 4）+ 13.4（长条下沿到第一行的呼吸）。
                 */
                style={{ "--pane-inset-top": "3.5rem" } as React.CSSProperties}
                className="relative flex min-h-0 flex-col overflow-hidden border-b border-hairline lg:border-b-0 lg:border-r"
              >
                {/*
                  两条长条并排（`PaneTabDock` 头上那段说的就是这种情形）：左边一条是这一栏
                  在答哪个问题，右边一条只在情报附件里出现，答的是「在看谁写的那一份」。

                  摞成两行的代价是正文第一行往下让 6.25rem；并排只要 3.5rem，而省下来的
                  正好是一条判断的高度。
                */}
                <PaneTabDock>
                  <PaneTabGroup
                    signature={`${shownTab}|${brief && staged ? "staged" : "none"}|${confirmedCount}`}
                  >
                    {/*
                      默认那一格，也是这一页的第一格。名字从「判断依据」改回「当前判断」——
                      它现在就是这一页的结论面，不再是别人结论背后的一层。
                    */}
                    <PaneTab active={shownTab === "probe"} onClick={() => setTab("probe")}>
                      当前判断
                      {/*
                       * 计数是**版本数**，不是节点数。节点数把追问和旁支也算进去，
                       * 而一号位看这个数字时问的是「这条判断改过几次」。
                       */}
                      {confirmedCount > 0 && (
                        <span className="meta ml-1.5 text-ink-faint">已确认 {confirmedCount}</span>
                      )}
                    </PaneTab>

                    {/*
                      行动整理。**他自己走进去过才有这一格** —— 这一轮交了决断包只说明参谋
                      把话整理成了可批准的形状，不说明他要现在派活。入口在判断那一屏的
                      底下（`enterStaging`）。
                    */}
                    {brief && staged ? (
                      <PaneTab active={shownTab === "command"} onClick={() => setTab("command")}>
                        行动整理
                      </PaneTab>
                    ) : null}

                    <PaneTab active={shownTab === "intel"} onClick={() => setTab("intel")}>
                      情报附件
                    </PaneTab>

                    <PaneTab active={shownTab === "knowledge"} onClick={() => setTab("knowledge")}>
                      知识关系
                    </PaneTab>
                  </PaneTabGroup>

                  {/*
                    几条链路各自的原件。**只在情报附件那一栏出现** —— 页签上署的是写它的那个
                    模型的名字，而那是链路口径，不该在一号位读决断的那一屏上。

                    取数失败时也把那枚占位的页签摆上：页签行里塞不下一整个报错框（那会把这
                    一排撑成三行），而点进去正文那一层会把原因和「重试」一起说清楚。一直转着
                    的骨架反而是句假话。
                  */}
                  {shownTab === "intel" ? (
                    <PaneTabGroup
                      signature={`${shownLane}|${(reports ?? []).map((r) => r.key).join(",")}`}
                    >
                      {reports || reportsRes.error ? (
                        <>
                          {/*
                            深研还没装配好时列表里没有 `agent` 那一项，但页签得在 —— 否则
                            「深度研究还在装配」这句话在屏幕上没有入口。这一枚上写的是
                            「深研报告」，不是某个模型名：那一刻还不知道会是谁写的。
                          */}
                          {!reports?.some((r) => r.key === "agent") ? (
                            <PaneTab active={shownLane === "agent"} onClick={() => setLane("agent")}>
                              深研报告
                            </PaneTab>
                          ) : null}
                          {(reports ?? []).map((r) => (
                            /*
                             * `pending` 那一栏**点得动** —— 各条链路各自计时，那块表和那句「走到
                             * 第几步」得有地方显示，而页签点不动的话它就没有地方显示。点进去看到的
                             * 不是空白：是这条链路此刻在干什么、跑了多久，或者它为什么没跑成
                             * （`ReportPane` 的 `PendingLane`）。
                             *
                             * 只有一种还是点不动：**压根还没起跑**那一档（`pending` 里连 `step` 和
                             * `error` 都没有）。那时候点进去确实只有一句「还在排队」，而它已经写在
                             * title 上了。
                             */
                            <PaneTab
                              key={r.key}
                              active={shownLane === r.key}
                              {...(r.pending && !r.pending.step && !r.pending.error
                                ? { disabled: true, title: r.pending.note }
                                : { onClick: () => setLane(r.key) })}
                            >
                              {r.label}
                            </PaneTab>
                          ))}
                        </>
                      ) : (
                        <span className="skeleton mx-1.5 block h-3 w-24" />
                      )}
                    </PaneTabGroup>
                  ) : null}
                </PaneTabDock>

                {shownTab === "command" && brief ? (
                  /* 滚动容器在这一层，档次跟报告那一栏一样（`px-7`、同一档 inset）：
                     两栏切来切去时正文的左边沿不许跳。 */
                  <div className="scroll-slim relative min-h-0 flex-1 overflow-y-auto px-7 pt-[var(--pane-inset-top,1.5rem)] pb-6">
                    <CommandBriefView
                      brief={brief.brief}
                      evidence={brief.evidence}
                      onApprove={approve}
                      onDefer={defer}
                      onRework={rework}
                      /*
                       * 这一份现在能不能下达。**同一个判据**（`dispatchBlockReason`）：服务端
                       * 拿它拒，这里拿它把「批准并下达」置灰并把原因写在按钮底下。屏幕自己
                       * 再判一次的话，说得通的那一下会在服务端被拒，而他看不出为什么。
                       *
                       * 这里传的 `delivery` 已经带上了 `staged` —— 走到这一屏的前提就是他
                       * 按过那个入口，所以这一条恒过，剩下的是完整性和「只够讨论」那两条。
                       */
                      blocked={dispatchBlockReason({ ...delivery, staged })}
                      /* 「去看完整论证」跳的是**产出这份包的那条链路**，不是主源那一栏 ——
                         包里的 `[E3]` 只有在那一份的证据表里才解析得对。 */
                      onOpenIntel={() => {
                        setLane(brief.laneKey);
                        setTab("intel");
                      }}
                    />
                  </div>
                ) : shownTab === "probe" ? (
                  <JudgementBoardPane
                    board={boardRes.data ?? null}
                    onChanged={() => void boardRes.mutate()}
                    onQuote={sendQuote}
                    /* 这一轮交付到什么程度，摆在判断前面。报告还没回来时不说 —— 那时
                       「未知」说的是「还没取到」，不是「这一轮没记」。 */
                    notice={reports ? <DeliveryNotice delivery={delivery} /> : null}
                    footer={
                      brief ? (
                        <ActionStagingEntry
                          delivery={delivery}
                          staged={staged}
                          onEnter={enterStaging}
                          onOpen={() => setTab("command")}
                        />
                      ) : null
                    }
                  />
                ) : shownTab === "intel" ? (
                  <IntelligenceDrawer
                    issueId={id}
                    reportsRes={reportsRes}
                    lane={shownLane}
                    nodes={map.nodes}
                    /*
                     * 从报告跳回当前判断。不再高亮某个节点 —— 版本链上每一条都是从对话
                     * 长出来的，和报告里的句子没有一一对应关系，硬指一个会指错。
                     */
                    onOpenBoard={() => setTab("probe")}
                    anchorFocus={anchorFocus}
                    onQuote={sendQuote}
                    /* 行动整理那一屏在的时候这一栏不给「打回重研」：同一件事在那边叫
                       「退回参谋重拟」，是四个主操作之一（理由在 `IntelligenceDrawer`）。
                       他还没走进行动整理时那一屏够不着，这一颗就得留着 —— 否则一份读着
                       不对的报告没有任何一处能打回。 */
                    allowRework={!(brief && staged)}
                  />
                ) : (
                  <ReportPane
                    issueId={id}
                    reportsRes={reportsRes}
                    tab="knowledge"
                    nodes={map.nodes}
                    onOpenNode={() => setTab("probe")}
                    anchorFocus={anchorFocus}
                    onQuote={sendQuote}
                  />
                )}
              </section>

              <ChatPane
                issueId={id}
                quote={quote}
                /* 这一栏不套框 —— 页面自己就是那张纸（见文件开头）。 */
                bare
                composerRef={composerRef}
                /*
                 * 参谋每答完一轮，去看一眼板。
                 *
                 * **板一定要刷**：这一轮聊出来的判断落在板上（`settleTurn`），只刷链路的话
                 * 他刚聊出来的那一条要等到下次进页面才出现 —— 那等于告诉他对谈跟左栏没关系。
                 *
                 * 后面两下是补的。萃取是回复落地之后才起的后台任务（不 await，理由在
                 * `settleTurn` 里），几秒钟才有结果，所以第一下刷必定比它快。写死两下、
                 * 不做轮询：这件事绝大多数轮次的正确结果是「板不动」，挂一个轮询等于
                 * 让每一轮对话之后都有一串必定空手而归的请求；而两下之外还没落下来的，
                 * 下一轮的刷新会带出来。
                 */
                onRound={() => {
                  void probeRes.mutate();
                  void boardRes.mutate();
                  for (const ms of [4000, 9000]) setTimeout(() => void boardRes.mutate(), ms);
                }}
                /*
                 * 没有 `note`。这一栏原来右上角有一句「聊出判断会落到左边那块板上，确认
                 * 由您按下」—— 它是一句**说明书**，而这件事屏幕自己会演示：聊完一轮，
                 * 左边那块板上多一条待确认。第一次看见那一下比读一句话有用得多，而看过
                 * 一次之后这句话就成了永久占位的噪音。它连带那条 header 一起走了。
                 */
              />
            </div>
          )}
        </AsyncBoundary>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 这一轮**交付到什么程度** —— 判断那一屏最上面那一句。
 *
 * 三件事分开说（HANDOVER §3.E）：这次调用结没结束、交付完不完整、够不够拿来做决定。
 * 第一件在运营台，这里只说后两件。
 *
 * ## 什么都好的时候一个字都不说
 *
 * `complete` 且没标「只够讨论」时这一块整个不出现。一行「本轮交付完整」是一句**没有
 * 读者的话** —— 它出现在最该安静的时候，而真出事那两行会因此被读成同一类装饰。
 *
 * ## 「未知」要说，而且不许说成「完整」
 *
 * 这两栏是这一版才有的，这一版之前落库的报告一份都没有。写「完整」是给它们发一张没考过
 * 的合格证；不说话则是默认它完整。所以照实说一句「这一轮没有记录交付完整性」，由他自己
 * 判 —— 而下达那道闸对未知放行（理由写在 `dispatchBlockReason` 上）。
 */
function DeliveryNotice({ delivery }: { delivery: ReportDelivery }) {
  const lines: { text: string; tone: string }[] = [];
  if (delivery.completeness === "failed") {
    lines.push({
      text: "这一轮深研没有交付出可读的正文。底下这几条判断（如果有）来自更早的对谈或会议，不是这一轮研究的结论。",
      tone: "text-counter",
    });
  } else if (delivery.completeness === "partial") {
    lines.push({
      text: "这一轮深研只交付了部分章节 —— 有章节没写完，收口补的摘要不等于补齐了核心论证。",
      tone: "text-counter",
    });
  } else if (delivery.completeness === "unknown") {
    lines.push({
      text: "这一轮没有记录交付完整性。未知不等于完整，读的时候请自己核一遍关键论证有没有写到。",
      tone: "text-ink-muted",
    });
  }
  if (delivery.decisionReady === false) {
    lines.push({
      text: "结果标的是「可供讨论」，不是「具备决策条件」—— 可以据此追问和继续研究，不能据此下达。",
      tone: "text-counter",
    });
  }
  if (lines.length === 0) return null;
  return (
    <div className="mb-3 border-l-2 border-hairline-strong pl-2.5">
      {lines.map((l) => (
        <p key={l.text} className={cn("meta leading-relaxed", l.tone)}>
          {l.text}
        </p>
      ))}
    </div>
  );
}

/**
 * 「整理成行动建议」—— 判断那一屏底下那个**显式入口**。
 *
 * 这是研究这一面和行动那一面之间唯一的那道门。它做成一行字而不是一颗实心按钮：这一页
 * 的重心是判断和追问，而绝大多数轮次的正确结局是接着问，不是派活。
 *
 * 底下那一句写的是**这一份此刻能不能下达**（同一个判据，见 `dispatchBlockReason`）。
 * 不拦着他进去 —— 缺论证的结果可以读、可以聊、也可以走进去看看参谋把话整理成了什么样；
 * 拦的是从那一屏按出去的那一下。所以这句话是提前告知，不是一道闸。
 */
function ActionStagingEntry({
  delivery,
  staged,
  onEnter,
  onOpen,
}: {
  delivery: ReportDelivery;
  staged: boolean;
  onEnter: () => Promise<void>;
  onOpen: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /* 进没进去，都按「已经进去了」算一次 —— 这句话答的是那一屏上能不能按出去。 */
  const blocked = dispatchBlockReason({ ...delivery, staged: true });

  const press = () => {
    if (staged) {
      onOpen();
      return;
    }
    setBusy(true);
    setFailed(null);
    void onEnter()
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-8 border-t border-hairline pt-4">
      <button
        type="button"
        disabled={busy}
        onClick={press}
        className="meta rounded-[3px] font-medium text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink hover:decoration-ink-faint disabled:opacity-50"
      >
        {busy ? "正在打开…" : staged ? "打开行动整理 →" : "整理成行动建议 →"}
      </button>
      <p className="meta mt-1.5 leading-relaxed text-ink-faint">
        {blocked ?? "参谋已经把这一轮的建议整理成了可批准的形状。进去之后才谈得上批准与下达。"}
      </p>
      {failed ? <p className="meta mt-1.5 text-counter">{failed}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function AdvisorSkeleton() {
  return (
    <div aria-live="polite" className="flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]">
        {[0, 1].map((n) => (
          /* 骨架跟着真版走同一条线、同一档内边距，否则数据落下来的一瞬间布局会跳。 */
          <div
            key={n}
            className={cn(
              "px-5 py-4",
              n === 0 && "border-b border-hairline lg:border-b-0 lg:border-r",
            )}
          >
            <span className="skeleton block h-3 w-20" />
            <span className="skeleton mt-4 block h-3.5 w-full" />
            <span className="skeleton mt-1.5 block h-3.5 w-[70%]" />
          </div>
        ))}
      </div>
    </div>
  );
}
