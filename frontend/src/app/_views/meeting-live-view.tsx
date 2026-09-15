"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { ChatPane } from "@/components/advisor/chat-pane";
import { ReportPane } from "@/components/advisor/report-pane";
import { AsyncBoundary } from "@/components/async-boundary";
import { LiveRecorder } from "@/components/meeting/live-recorder";
import { PaneTab, PaneTabDock, PaneTabGroup } from "@/components/pane-tabs";
import { domainsOfSlot, slotLabel } from "@/lib/data/agenda";
import { api } from "@/lib/data/client";
import type {
  BoardJudgement,
  DomainSummary,
  IssueReport,
  IssueSummary,
  JudgementBoard,
  MeetingSlot,
} from "@/lib/data/types";
import { useInvalidate, useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 开会 —— 一场会开着的时候，屏幕上摆的那一页。
 *
 * ## 这一页为什么存在
 *
 * 首页那张会议卡上按下「开始会议」之后，人就从「安排事情」切换到「谈事情」了。这两件事
 * 要的屏幕完全不同：安排时他要看清有几场会、各排了什么；谈的时候他只要三样 ——
 * **这几件事我们之前判到哪儿了**、**参谋在旁边随时能问**、**开始/结束收音**。
 * 所以它是一整页，不是首页上的一个展开。
 *
 * ## 左边为什么是「已确认的判断」，不是深研报告
 *
 * 一场会的起点不是资料，是**上一次的结论**。已确认的那几条是公司口径 —— 会上要么在它
 * 之上往前走，要么明确地推翻它；两种都得先把它摆在眼前。深研报告是它背后的东西，起疑时
 * 才翻，所以它在同一排页签的后面几格（和议题研究那一页**同一枚滑块**，见 `PaneTabBar`）。
 *
 * ## 右边那栏对话锚在哪儿
 *
 * 锚在**当前选中的那件议题**上，读写的是那件议题在议题研究页上的同一支对话
 * （`api.listAdvisorMessages(issueId)`）。所以会上问出来的东西不是另起一摊 —— 它落回
 * 这件议题自己的对谈记忆里，会后翻议题时看得见「那天会上问过什么」。
 *
 * 一场会有两件议题时，切上面那排页签就换锚点：那一栏顶上写着此刻在问哪一件。合成一个
 * 「问这场会」的池子试过一版，不成立 —— 参谋要回答的每一句都得贴着某一件议题的证据，
 * 而「这场会」不是一个有证据的对象。
 *
 * ## 底下那一块
 *
 * 收音、上传、转写、提炼四段全在 `LiveRecorder` 里，它自己说每一段走到哪儿。散会那一下
 * 之后提炼落地，首页右栏长出待确认的纪要 —— 这一页的活到此为止。
 */
export function MeetingLiveView({ slotId }: { slotId: string }) {
  const slotsRes = useResource<MeetingSlot[]>("slots", () => api.listSlots());
  const issuesRes = useResource<IssueSummary[]>("issues", () => api.listIssues());
  const domainsRes = useResource<DomainSummary[]>("domains", () => api.listDomains());
  const invalidate = useInvalidate();

  /**
   * 选中的页签：`"judgments"` 是判断那一栏，其余取值是某件议题的 id（看它的深研报告）。
   * 它同时决定右栏对话锚在哪一件 —— 判断那一栏上锚第一件（见 `askIssueId`）。
   */
  const [tab, setTab] = useState<string>("judgments");
  /**
   * 右栏此刻问的是哪一件。
   *
   * 它**必须跟着左栏正在读的那一份走**：左边翻着 ISS-215 的报告、右边却锚在 ISS-214 上时，
   * 「就这句聊」会把 215 的原文送进 214 的对话里 —— 一次静默的串线，而两边看起来都正常。
   * 所以点报告页签的同时改这一格；判断那一栏上不属于任何一件，那时由右栏顶上那排小键选。
   */
  const [ask, setAsk] = useState<string | null>(null);
  /**
   * 报告那一栏此刻站在哪条链路上（`agent` / `agent:alt0` / `dri`…）。
   *
   * 提到这一层，是因为选它的那条长条和显示它的那块正文现在是**两个兄弟**：长条并排摆在
   * 顶上（`PaneTabDock`），正文在底下。放在正文里的话，长条就得反过来去问正文此刻选了谁。
   */
  const [lane, setLane] = useState<string>("agent");
  const openIssue = (id: string) => {
    setTab(id);
    setAsk(id);
    /* 换一件议题就回到主源那一份：上一件的链路 key 在这一件上多半不存在，
       而「选中的那一栏不在列表里」屏幕上是一片空白。 */
    setLane("agent");
  };

  /* 「就这条聊」把一段话递进对话。两栏是兄弟组件，引文状态在对话内部。 */
  const composerRef = useRef<{ quote: (text: string) => void } | null>(null);
  /**
   * 引一句**别的那件议题**的话时，右栏要先换锚点 —— 而换锚点会把那一栏整个重挂
   * （`key`），此刻用 ref 递进去的引文会跟着旧的那一栋一起没掉。所以这一句改走
   * `quote` 属性：它是新挂那一栋的初值，重挂完引文就在输入框里等着。
   */
  const [handedQuote, setHandedQuote] = useState<string | undefined>(undefined);

  const slot = slotsRes.data?.find((s) => s.id === slotId) ?? null;
  const byId = new Map((issuesRes.data ?? []).map((i) => [i.id, i] as const));
  /* 顺序就是议程顺序（日程板上拖出来的那个），所以按 `issueIds` 走，不按议题表走。 */
  const issues = (slot?.issueIds ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean) as IssueSummary[];

  const askIssueId =
    ask && issues.some((i) => i.id === ask) ? ask : (issues[0]?.id ?? null);

  /** 引某一件议题上的一句话。同一件就直接递进去，别的那件先换锚点。 */
  const quoteFor = (issueId: string) => (text: string) => {
    if (issueId === askIssueId) {
      composerRef.current?.quote(text);
      return;
    }
    setHandedQuote(text);
    setAsk(issueId);
  };

  const domainName = (id: string) =>
    domainsRes.data?.find((d) => d.id === id)?.name ?? id;
  const attending = slot
    ? domainsOfSlot(slot, (id) => byId.get(id)?.domainId).map(domainName)
    : [];

  return (
    <>
      {/* 整页的底就是纸，铺满视口 —— 同议题研究那一页（`advisor-view.tsx` 文件头）。 */}
      <div aria-hidden className="fixed inset-0 -z-10 bg-surface" />
      <div className="animate-panel mx-auto flex h-[calc(100vh-3rem)] w-full max-w-[1600px] flex-col overflow-hidden px-5 sm:px-6">
        <AsyncBoundary resource={slotsRes} skeleton={<LiveSkeleton />}>
          {() =>
            !slot ? (
              <Missing />
            ) : (
              <>
                <header className="flex h-12 flex-none items-baseline gap-3">
                  <h1 className="text-md font-medium text-ink">
                    {slotLabel(slot, api.today)}
                  </h1>
                  {attending.length > 0 ? (
                    <span className="meta min-w-0 truncate text-ink-muted">
                      {attending.join(" · ")}
                    </span>
                  ) : null}
                  <span className="meta flex-none text-ink-faint">
                    {issues.length} 件
                  </span>
                  <Link
                    href="/"
                    className="meta ml-auto flex-none rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink"
                  >
                    回首页
                  </Link>
                </header>

                <div className="grid min-h-0 flex-1 items-stretch lg:grid-cols-2">
                  <section
                    /*
                     * 正文第一行往下让出多少给那排悬浮的长条。**只有一行**：选哪件议题
                     * 和选哪条链路是两条并排的长条，不是摞起来的两行（见 `PaneTabDock`）。
                     */
                    style={{ "--pane-inset-top": "3.5rem" } as React.CSSProperties}
                    className="relative flex min-h-0 flex-col overflow-hidden border-b border-hairline lg:border-b-0 lg:border-r"
                  >
                    {/*
                     * 一行两条长条：左边选看哪件议题（或判断），右边选那件议题的哪条链路。
                     * 各有各的滑块 —— 一枚滑块只说得清一个单选。
                     */}
                    <PaneTabDock>
                      <PaneTabGroup signature={`${tab}|${issues.map((i) => i.id).join(",")}`}>
                        <PaneTab
                          active={tab === "judgments"}
                          onClick={() => setTab("judgments")}
                        >
                          判断
                        </PaneTab>
                        {issues.map((i) => (
                          <PaneTab
                            key={i.id}
                            active={tab === i.id}
                            onClick={() => openIssue(i.id)}
                            title={i.title}
                          >
                            {i.id} 深研
                          </PaneTab>
                        ))}
                      </PaneTabGroup>

                      {/* 链路那一条只在真站在某份报告上时才出现 —— 判断那一栏没有链路
                          可选，摆一条空的长条在旁边等于给一个按不动的选择。 */}
                      {tab === "judgments" ? null : (
                        <IssueReportLanes issueId={tab} lane={lane} onLane={setLane} />
                      )}
                    </PaneTabDock>

                    {tab === "judgments" ? (
                      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-5 pt-[var(--pane-inset-top)] pb-6">
                        {issues.length === 0 ? (
                          <p className="meta text-ink-faint">这场会上没有议题。</p>
                        ) : (
                          issues.map((i) => (
                            <IssueJudgments
                              key={i.id}
                              issue={i}
                              onQuote={quoteFor(i.id)}
                              onOpenReport={() => openIssue(i.id)}
                            />
                          ))
                        )}
                      </div>
                    ) : (
                      <IssueReportPane
                        issueId={tab}
                        lane={lane}
                        onQuote={quoteFor(tab)}
                      />
                    )}

                    {/* 这一页的正事。钉在左栏底边上，不跟着正文滚。 */}
                    <div className="flex-none">
                      <LiveRecorder
                        slotId={slot.id}
                        title={`${slotLabel(slot, api.today)}的会议`}
                        onDone={() => void invalidate("issues", "slots")}
                      />
                    </div>
                  </section>

                  {askIssueId ? (
                    <div className="flex min-h-0 flex-col">
                      {/*
                       * 此刻问的是哪一件 —— **这一行必须在**。
                       *
                       * 这一栏读写的是那件议题在议题研究页上的同一支对话，会上问出来的东西
                       * 落回它自己的记忆里。哪一支正开着，屏幕上不说的话就只能靠他记住刚才
                       * 点了哪个页签 —— 而一场会中间他会来回切。
                       *
                       * 只有一件议题时不摆：那时它答的是一个没人会问的问题。
                       */}
                      {issues.length > 1 ? (
                        <div className="flex h-12 flex-none items-center gap-1.5 px-6">
                          <span className="meta flex-none text-ink-faint">问</span>
                          {issues.map((i) => (
                            <button
                              key={i.id}
                              type="button"
                              onClick={() => setAsk(i.id)}
                              aria-pressed={i.id === askIssueId}
                              title={i.title}
                              className={cn(
                                "meta rounded-full px-2.5 py-1 font-medium transition-colors duration-fast ease-swift",
                                i.id === askIssueId
                                  ? "bg-neutral-wash text-ink"
                                  : "text-ink-faint hover:text-ink-muted",
                              )}
                            >
                              {i.id}
                            </button>
                          ))}
                          <span className="meta min-w-0 truncate text-ink-faint">
                            {byId.get(askIssueId)?.title}
                          </span>
                        </div>
                      ) : null}
                      {/*
                       * 这一层是 `grid` 而不是又一个 flex 子项：对话那一栏自己的根上没有
                       * `flex-1`（它原来是网格的直接子项，靠 `items-stretch` 撑满）。塞进
                       * 一个 flex 列里之后它会缩到内容高度 —— 屏幕上的样子是输入框跑到了
                       * 这一栏的顶上。单子项的 grid 天然把它拉满，不用去改那个组件。
                       */}
                      <div className="grid min-h-0 flex-1">
                        <ChatPane
                          /* 换议题就换一支对话 —— `key` 让它整个重挂，不留上一件的草稿。 */
                          key={askIssueId}
                          issueId={askIssueId}
                          quote={handedQuote}
                          bare
                          composerRef={composerRef}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            )
          }
        </AsyncBoundary>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 一件议题在会上要先摆出来的那几条判断。
 *
 * ## 已确认的优先，一条都没有时才退到待确认的
 *
 * 会上要往前走的起点是**公司口径** —— 已经过他点头的那几条。参谋刚提的、他还没点头的
 * 那一层平时不该和它们摆在同一屏上：分不清哪一条已经算数，会上引用时就会把一句猜测
 * 讲成一句定论。
 *
 * 但「一条都没有」时把这一栏空着更糟：那时屏幕上没有任何东西可谈，而库里明明有四条
 * 参谋写好的判断。所以退一档 —— **摆出来，同时把「还没经过您」写在标题上、字压淡一档**。
 * 边界在这里：不是把两层混在一起，是没有上层时才显示下层，而且说清它是下层。
 */
function IssueJudgments({
  issue,
  onQuote,
  onOpenReport,
}: {
  issue: IssueSummary;
  onQuote: (text: string) => void;
  onOpenReport: () => void;
}) {
  const boardRes = useResource<JudgementBoard>(`board:${issue.id}`, () =>
    api.getBoard(issue.id),
  );
  const confirmed = boardRes.data?.confirmed ?? [];
  const draft = boardRes.data?.draft ?? [];
  const showing = confirmed.length > 0 ? confirmed : draft;
  const unconfirmed = confirmed.length === 0 && draft.length > 0;

  return (
    <section className="mb-7 last:mb-0">
      <header className="mb-2.5 flex items-baseline gap-2">
        <span className="meta flex-none text-ink-faint">{issue.id}</span>
        <h2 className="min-w-0 text-md leading-relaxed font-medium text-ink">
          {issue.title}
        </h2>
      </header>

      {boardRes.data === undefined ? (
        <span className="skeleton block h-3.5 w-2/3" />
      ) : showing.length === 0 ? (
        <p className="meta text-ink-faint">
          这件事上还没有判断 ——{" "}
          <button
            type="button"
            onClick={onOpenReport}
            className="rounded-[3px] underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
          >
            看深研报告
          </button>
        </p>
      ) : (
        <>
          {unconfirmed ? (
            <p className="meta mb-2 text-ink-muted">
              这几条<span className="font-medium">还没经过您</span> ——
              参谋读完深研报告写的，会上引用前先说明这一点。
            </p>
          ) : null}
          <ul className="space-y-2">
            {showing.map((j) => (
              <JudgementRow key={j.id} j={j} onQuote={onQuote} dim={unconfirmed} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * 一条判断。**整句摊开，不截断。**
 *
 * 议题研究那一页上它是折叠的（一屏要装下十几条账）；会上不是 —— 他要照着念、要引用、
 * 要在它上面往前走一步。一条读到一半被 `truncate` 掐掉的判断，会上等于没有。
 */
function JudgementRow({
  j,
  onQuote,
  dim,
}: {
  j: BoardJudgement;
  onQuote: (t: string) => void;
  /** 这一条还没经过他 —— 整块压淡一档，理由见 `IssueJudgments`。 */
  dim?: boolean;
}) {
  const c = j.confirmed;
  return (
    <li
      className={cn(
        "group rounded-lg border border-hairline px-3.5 py-2.5",
        dim ? "bg-transparent" : "bg-neutral-wash",
      )}
    >
      <div className="flex items-baseline gap-2">
        {j.label ? (
          <span className="text-sm font-medium text-ink">{j.label}</span>
        ) : null}
        {j.meetingLabel ? (
          <span className="meta text-ink-faint">· {j.meetingLabel}</span>
        ) : null}
        <button
          type="button"
          onClick={() => onQuote(`「${j.statement}」`)}
          className="meta ml-auto flex-none rounded-[3px] text-ink-faint opacity-0 transition-opacity duration-fast group-hover:opacity-100 hover:text-ink-muted focus-visible:opacity-100"
        >
          就这条聊 →
        </button>
      </div>
      <p className={cn("mt-1 text-md leading-relaxed", dim ? "text-ink-muted" : "text-ink")}>
        {j.statement}
      </p>
      {/*
       * 边界跟着判断走，不折起来。一条没有边界的判断会在会上被当成比它实际管得更宽的
       * 东西用 —— 而会上正是它最容易被用宽的场合。
       */}
      {j.boundary ? (
        <p className="mt-1.5 border-l-2 border-hairline-strong pl-2.5 text-sm leading-relaxed text-ink-muted">
          边界：{j.boundary}
        </p>
      ) : null}
      {c?.support ? (
        <p className="meta mt-1.5 text-ink-faint">凭据：{c.support}</p>
      ) : null}
    </li>
  );
}

/**
 * 某一件议题的深研报告。**第二条长条是链路**（DeepSeek / Claude / ChatGPT / 豆包），
 * 和议题研究那一页是同一排页签、同一枚滑块。
 *
 * 「打回重研」在这一页上不给（`allowRework={false}`）：那一下丢掉现有报告、起一轮十几
 * 分钟、花一笔真钱，而此刻屋里坐着人。
 */
function IssueReportPane({
  issueId,
  lane,
  onQuote,
}: {
  issueId: string;
  lane: string;
  onQuote: (text: string) => void;
}) {
  const reportsRes = useResource<IssueReport[]>(`reports:${issueId}`, () =>
    api.listReports(issueId),
  );

  return (
    <ReportPane
      issueId={issueId}
      reportsRes={reportsRes}
      tab={shownLaneOf(lane, reportsRes.data)}
      nodes={[]}
      onOpenNode={() => {}}
      anchorFocus={null}
      onQuote={onQuote}
      allowRework={false}
    />
  );
}

/**
 * 选中的那条链路不在列表里了，就落回主源那一份。
 *
 * 会发生：他正读着「Claude」那一栏，这件议题又起了一轮深研而这一轮第二个模型没写成 ——
 * 那枚页签消失、`lane` 指着一个不存在的东西，屏幕上于是没有任何页签被选中。
 *
 * **列表还没到的那一瞬不许下结论**（`!list`）：那时候什么都不在列表里，会把他正在读的
 * 那一栏也顶掉。抽成函数是因为长条和正文两处都要按同一条规矩挑（同 `advisor-view`）。
 */
const shownLaneOf = (lane: string, list: IssueReport[] | undefined): string =>
  lane === "agent" || !list ? lane : list.some((r) => r.key === lane) ? lane : "agent";

/**
 * 链路那一条长条 —— 和左边那条并排（`PaneTabDock`），不是摞在它下面。
 *
 * 它和正文是两个兄弟，各自去问同一个 SWR key（`reports:<id>`）拿同一份缓存 ——
 * 不会多取一次。
 */
function IssueReportLanes({
  issueId,
  lane,
  onLane,
}: {
  issueId: string;
  lane: string;
  onLane: (key: string) => void;
}) {
  const reportsRes = useResource<IssueReport[]>(`reports:${issueId}`, () =>
    api.listReports(issueId),
  );
  const reports = reportsRes.data;
  const shown = shownLaneOf(lane, reports);

  return (
    <PaneTabGroup signature={`${shown}|${(reports ?? []).map((r) => r.key).join(",")}`}>
      {reports || reportsRes.error ? (
        <>
          {/* 深研还没装配好时列表里没有 `agent` 那一项，但页签得在 —— 否则
              「深度研究还在装配」这句话在屏幕上没有入口。 */}
          {!reports?.some((r) => r.key === "agent") ? (
            <PaneTab active={shown === "agent"} onClick={() => onLane("agent")}>
              深研报告
            </PaneTab>
          ) : null}
          {(reports ?? []).map((r) => (
            <PaneTab
              key={r.key}
              active={shown === r.key}
              {...(r.pending && !r.pending.step && !r.pending.error
                ? { disabled: true, title: r.pending.note }
                : { onClick: () => onLane(r.key) })}
            >
              {r.label}
            </PaneTab>
          ))}
        </>
      ) : (
        <span className="skeleton mx-1.5 block h-3 w-24" />
      )}
    </PaneTabGroup>
  );
}

/* -------------------------------------------------------------------------- */

function Missing() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="meta text-ink-faint">
        没有这一场会 —— 它可能已经撤掉了。
        <Link href="/" className="ml-2 underline decoration-hairline underline-offset-4">
          回首页
        </Link>
      </p>
    </div>
  );
}

function LiveSkeleton() {
  return (
    <div aria-live="polite" className="grid min-h-0 flex-1 lg:grid-cols-2">
      {[0, 1].map((n) => (
        <div
          key={n}
          className={cn("px-5 py-4", n === 0 && "border-b border-hairline lg:border-b-0 lg:border-r")}
        >
          <span className="skeleton block h-3 w-20" />
          <span className="skeleton mt-4 block h-3.5 w-full" />
          <span className="skeleton mt-1.5 block h-3.5 w-[70%]" />
        </div>
      ))}
    </div>
  );
}
