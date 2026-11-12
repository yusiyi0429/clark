"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Tabs } from "@heroui/react";
import { ArrowRight, CalendarDays, Check, RefreshCw, Trash2, Undo2 } from "lucide-react";
import type { TIssueDecisionHistory } from "@warmap/contracts";
import type { CardRenderProps } from "./registry";
import type { Card } from "@/lib/api/client";
import { payloadOf, type IssuePayload, type MeetingPayload } from "./payloads";
import { issueScopeLabel } from "./scopeNames";
import { buildHistoryIndex, emptySourceContext } from "./meetingSources";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { RadarOriginTag } from "@/components/OriginTag";
import { StructuredText } from "@/components/StructuredText";
import { SelectionToolbar, useSelectionQuote } from "@/components/SelectionQuote";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { COMPANY_TIMEZONE, calendarDate } from "@/lib/companyTime";
import { ActionFeedback, useCardAction } from "@/lib/useCardAction";
import { ThreadMembersMenu } from "@/conversation/ThreadMembersMenu";
import { IssueMoreMenu } from "./IssueMoreMenu";
import { ObjectMaterialArea } from "@/components/materials/ObjectMaterialArea";
import { SegmentedSwitch, type Segment } from "@/components/SegmentedSwitch";
import { DecisionHistoryLayers, hasHistoryContent } from "@/components/meeting/DecisionHistoryLayers";
import { saveReadingPosition, useRestoreReadingPosition } from "@/components/meeting/MeetingOutline";
import { SourceNavigatorProvider, useSourceNavigator, type SourceObject } from "@/components/meeting/SourceViewer";
import { useDecisionHistory } from "@/components/meeting/useDecisionHistory";
import s from "@/styles/issue-workspace.module.css";
import { cleanDisplayText, localizeTabScrollButtons, shortSourceName } from "@/lib/displayText";

const RESEARCH_LABEL: Record<string, string> = {
  pending: "预研排队中",
  running: "预研进行中",
  ready: "预研已完成",
  failed: "预研失败",
};
const URGENCY_LABEL = { red: "紧急", yellow: "需关注", gray: "常规" } as const;

const ORIGIN_LABEL: Record<IssuePayload["origin"], string> = { radar: "雷达升级", dri: "负责人提请", ceo: "一号位发起" };

/** 旧预研文档里可能存在 file:// 或 urn: 这类模型自编的来源，只给真实 http(s) 渲染链接。 */
function isHttpUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//.test(url);
}

/** 眉题里的阶段（clark TOPIC_LIFECYCLE_LABELS 的写法），只从议题与会议的真实状态推出。 */
function lifecycleLabel(payload: IssuePayload, hasMeeting: boolean): string {
  if (payload.status === "decided") return "已形成结论";
  if (payload.status === "dismissed") return "已移出决策面";
  if (hasMeeting) return "已安排会议";
  if (payload.research.status === "pending" || payload.research.status === "running") return "研究中";
  return "待决策";
}

/** 首页集合 + 本页集合里的会议：同一场会取版本新的那份；其余首页 Card 原样保留。 */
export function mergeMeetingCards(home: Card[], local: Card[]): Card[] {
  const newer = new Map(local.filter((item) => item.kind === "meeting").map((item) => [item.id, item]));
  if (!newer.size) return home;
  const merged = home.map((item) => {
    const candidate = newer.get(item.id);
    if (!candidate) return item;
    newer.delete(item.id);
    return candidate.version > item.version ? candidate : item;
  });
  return [...merged, ...newer.values()];
}

/** 结论块的标题：按决定的实际来源写（会后确认回传 / 直接拍板），不一律写「会议结论」（巡检 P1-10）。 */
export function receiptHeading(receipts: IssuePayload["receipts"]): { title: string } {
  const fromMeeting = receipts.filter((receipt) => receipt.source?.kind === "meeting-item").length;
  return { title: fromMeeting === receipts.length ? "会议结论" : "已形成的决定" };
}

const meetingDay = (iso: string) =>
  new Date(iso).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long", timeZone: COMPANY_TIMEZONE });
const meetingClock = (iso: string) =>
  new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: COMPANY_TIMEZONE });

/** 议题页页头的类型切换：总结与判断 / 研究与依据；材料下拉单只列材料。 */
const ISSUE_SEGMENTS: Segment<"summary" | "research">[] = [{ id: "summary", label: "总结与判断" }, { id: "research", label: "研究与依据" }];

/**
 * 议题工作区（clark `issue-workspace.tsx`）：玻璃页头 + 会议安排 + 「总结与判断 / 研究与依据」两个页签，
 * 对话在外壳右侧的对话列。加入已有会议 / 移出议题收在页头「更多 ⋯」里，恢复、会议结论撤回与重试预研是天枢独有，都只通过 Action 提交；
 * 决定只走 Meeting Outcome 链路，页面不提供直接决定。
 */
export function IssueCard({ card, collection = [], onCard, onNavigate, readOnly = false }: CardRenderProps & { readOnly?: boolean }) {
  const payload = payloadOf<IssuePayload>(card);
  const { homeCards: shellCards, quote, viewerId } = useWorkspace();
  // 会议安排读首页集合；刚在本页加入 / 新建的会议先从本页集合里拿（动作返回的新会议 Card），不等首页刷新（巡检 P1-5）。
  const homeCards = useMemo(() => mergeMeetingCards(shellCards, collection), [shellCards, collection]);
  const { state, run, retry, pending } = useCardAction(onCard);
  const [tab, setTab] = useState<string>("summary");
  const reading = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const { selected, clear, onMouseUp } = useSelectionQuote(reading);
  // 历史（feedback 9）：仍有效的历史决定 / 此后实际变化（议题页不列「本次待判断」）；议题版本变了或对话里改了业务就重读。成员只读视图不读。
  const issueId = card.objectRef.id;
  const history = useDecisionHistory<TIssueDecisionHistory>(readOnly ? null : `/api/issues/${issueId}/history`, String(card.version));
  const sourceContext = useMemo(() => emptySourceContext({
    issueIds: [issueId],
    issueTitle: (id: string) => (id === issueId ? card.title : undefined),
    history: buildHistoryIndex(history.data ? [history.data] : []),
    meetings: new Map((history.data?.relatedMeetings ?? []).map((meeting) => [meeting.id, meeting.title] as [string, string])),
  }), [issueId, card.title, history.data]);
  const sourceObjects = useMemo<SourceObject[]>(() => [
    { objectType: "issue", objectId: issueId },
    ...(history.data?.relatedMeetings ?? []).map((meeting) => ({ objectType: "meeting" as const, objectId: meeting.id })),
  ], [issueId, history.data]);
  const readingKey = `issue:${issueId}|${tab}`;
  const leaveReading = useCallback(() => saveReadingPosition(readingKey, reading.current), [readingKey]);
  const { api: sourceApi, overlay: sourceOverlay } = useSourceNavigator({ context: sourceContext, rootRef: workspaceRef, onNavigate,
    objects: sourceObjects, beforeLeave: leaveReading });
  useRestoreReadingPosition(readingKey, reading, !readOnly);
  useEffect(() => localizeTabScrollButtons(workspaceRef.current));

  const actions = card.actions;
  const actionOf = (type: string) => actions.find((action) => action.actionType === type);
  const doc = payload.research.doc;
  const whyNow = (payload.originRef as { whyNow?: string | null } | null)?.whyNow;
  // 可加入的会议：议题页自己的集合里只有议题本身，所以读外壳已载入的首页集合；已含本议题的会议不再列出。
  const scheduledMeetings = useMemo(
    () =>
      homeCards.filter((candidate) => {
        if (candidate.kind !== "meeting") return false;
        const meeting = payloadOf<MeetingPayload>(candidate);
        return meeting.status === "scheduled" && !meeting.issueIds.includes(card.objectRef.id);
      }),
    [homeCards, card.objectRef.id],
  );
  // 本议题已排的会议：只读首页集合里的 Meeting Card，取最早一场。
  const meeting = useMemo(() => {
    const own = homeCards
      .filter((candidate) => candidate.kind === "meeting")
      .map((candidate) => ({ card: candidate, payload: payloadOf<MeetingPayload>(candidate) }))
      .filter((item) => item.payload.status === "scheduled" && item.payload.issueIds.includes(card.objectRef.id))
      .sort((a, b) => a.payload.scheduledAt.localeCompare(b.payload.scheduledAt));
    return own[0] ?? null;
  }, [homeCards, card.objectRef.id]);
  const meetingLead = meeting?.payload.participants.find((person) => person.personId === meeting.payload.leadDriId)?.displayName;
  const activeReceipts = payload.receipts.filter((receipt) => !receipt.revokedAt);
  // 指派默认战场负责人：议题所在战场的负责人（集团层 / 能力层没有）。
  const eyebrowScope = payload.locationName ?? issueScopeLabel(payload.location, homeCards);
  const deadline = payload.status === "pending" ? calendarDate(payload.urgency.decisionBy) : "";
  const eyebrow = [lifecycleLabel(payload, Boolean(meeting)), eyebrowScope, deadline ? `决定期限 ${deadline}` : ""]
    .filter(Boolean)
    .join(" · ");

  const discussion = (
    <section className={s.discussion} aria-labelledby="issue-discussion-title">
      <header>
        <div>
          <h2 id="issue-discussion-title">{activeReceipts.length ? receiptHeading(activeReceipts).title : meeting ? "提交会议讨论" : "备选方案"}</h2>
        </div>
        <span>{activeReceipts.length ? "已记录" : meeting ? `${meetingClock(meeting.payload.scheduledAt)} 上会` : "AI 预研"}</span>
      </header>
      {activeReceipts.length ? (
        activeReceipts.map((receipt) => {
          const revoke = actions.find((candidate) => candidate.actionType === "issue.revoke_receipt" && candidate.itemId === receipt.id);
          return (
            <div key={receipt.id} className={s.receipt}>
              <Check size={16} aria-hidden="true" />
              <div>
                <p>{receipt.decisionText}</p>
                <small>
                  {receipt.researchStatusAtDecision ? `决定时预研：${RESEARCH_LABEL[receipt.researchStatusAtDecision] ?? receipt.researchStatusAtDecision} · ` : ""}
                  {receipt.override ? "预研未完成时决定 · " : ""}{calendarDate(receipt.createdAt)}
                </small>
              </div>
              {revoke ? (
                <Button size="sm" variant="tertiary" isDisabled={pending} onPress={() => void run(revoke, {})}>
                  撤回决定
                </Button>
              ) : null}
            </div>
          );
        })
      ) : doc?.options.length ? (
        <ol className={s.options}>
          {doc.options.map((option, index) => (
            <li key={option.id}>
              <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <p>{option.label}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className={s.empty}>{RESEARCH_LABEL[payload.research.status] ?? "预研尚未产出"}</p>
      )}
    </section>
  );

  return (
    // data-type-scale="doc"：页头、阅读列、三层历史、依据抽屉都按材料排印（globals.css 的 --doc-*）排。
    <section ref={workspaceRef} className={s.workspace} data-testid="issue-workspace" data-type-scale="doc" data-status={payload.status} aria-labelledby="issue-title">
      <SourceNavigatorProvider value={sourceApi}>
      <DetailFrame title={card.title} titleTag={<RadarOriginTag issue={payload} />} subtitle={eyebrow} headingId="issue-title" onBack={() => onNavigate("/")}
        actions={<>
          <SegmentedSwitch data-header-switch="" label="议题内容" segments={ISSUE_SEGMENTS}
            selected={tab === "summary" || tab === "research" ? tab : null} onSelect={(next) => { clear(); setTab(next); }} />
          {/* 页头 actions 只有一格：邀请成员和「更多 ⋯」放在同一个容器里并排。低频动作收在「更多」：加入已有会议、移出议题（安排会议不在这里）。 */}
          {readOnly ? null : <div className={s.headerActions}>
            <ThreadMembersMenu objectType="issue" objectId={card.objectRef.id} viewerId={viewerId ?? ""} members={[]} inviteOnly onChanged={() => undefined} />
            <IssueMoreMenu card={card} onCard={onCard} pendingIssue={payload.status === "pending"} scheduledMeetings={scheduledMeetings} />
          </div>}
        </>}>

      {/* 这一页是议题：会议只是它的一条「去处」。做成页头下一条细的引用条（像文档里链接到另一份文档），
          整条可点进会议页；不再用大号时间占住页头，免得分不清自己在议题页还是会议页。 */}
      {meeting ? (
        <section className={s.meetingLink} aria-label="议题会议安排">
          <button
            type="button"
            className={s.meetingCard}
            data-origin={`${readOnly ? "/me/work" : ""}/meetings/${meeting.card.objectRef.id}`}
            onClick={(event) => onNavigate(`${readOnly ? "/me/work" : ""}/meetings/${meeting.card.objectRef.id}`, event.currentTarget)}
          >
            <CalendarDays className={s.meetingIcon} size={15} aria-hidden="true" />
            <span className={s.meetingKicker}>本议题已安排上会</span>
            <span className={s.meetingTitle}>{meeting.card.title}</span>
            <span className={s.meetingWhen}>
              <time dateTime={meeting.payload.scheduledAt}>
                {meetingDay(meeting.payload.scheduledAt)} {meetingClock(meeting.payload.scheduledAt)}
                {meeting.payload.endsAt ? `–${meetingClock(meeting.payload.endsAt)}` : ""}
              </time>
              {" · "}主持 · {meetingLead ?? "待确认"}
            </span>
            <span className={s.meetingGo}>
              进入会议
              <ArrowRight size={14} aria-hidden="true" />
            </span>
          </button>
        </section>
      ) : null}

      <div className={s.columns}>
        <ObjectMaterialArea objectType="issue" objectId={card.objectRef.id}
          baseTabs={[]} homeTab="summary"
          selected={tab} onSelect={(next) => { clear(); setTab(next); }}>
        <Tabs
          className={s.materials}
          variant="secondary"
          selectedKey={tab === "research" ? "research" : "summary"}
          onSelectionChange={(key) => {
            clear();
            setTab(String(key));
          }}
        >
          <Tabs.ListContainer className={s.tabs}>
            <Tabs.List aria-label="研究内容">
              <Tabs.Tab id="summary">
                总结与判断
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="research">
                研究与依据
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <div className={s.reading} data-material-scroll data-material-column ref={reading} onMouseUp={onMouseUp}>
            <p className={s.note}>
              {payload.nature === "ai_suggested" ? null : <>{readOnly && payload.origin === "ceo" ? "CEO 发起的议题" : ORIGIN_LABEL[payload.origin]} · </>}{RESEARCH_LABEL[payload.research.status] ?? "预研中"}
              {readOnly ? ` · 紧急程度：${URGENCY_LABEL[payload.urgency.level]}` : ""}
            </p>
            {payload.research.error ? (
              <div className={s.error} role="alert" title={payload.research.error.code}>
                <p>
                  {payload.research.error.message}
                </p>
                {actionOf("issue.retry_research") ? (
                  <Button size="sm" variant="secondary" isDisabled={pending} onPress={() => void run(actionOf("issue.retry_research")!, {})}>
                    <RefreshCw size={14} aria-hidden="true" />
                    {pending ? "提交中…" : "重试预研"}
                  </Button>
                ) : null}
              </div>
            ) : null}

            <Tabs.Panel id="summary">
              {payload.status === "dismissed" ? (
                <section className={s.dismissed} aria-label="已移出决策面">
                  <Trash2 size={16} aria-hidden="true" />
                  <div>
                    <p>已移出决策面{payload.dismissReason ? `：${payload.dismissReason}` : ""}</p>
                    {payload.dismissedAt ? <small>移出于 {calendarDate(payload.dismissedAt)}</small> : null}
                  </div>
                  {actionOf("issue.restore") ? (
                    <Button size="sm" variant="secondary" isDisabled={pending} onPress={() => void run(actionOf("issue.restore")!, {})}>
                      <Undo2 size={14} aria-hidden="true" />
                      {pending ? "提交中…" : "恢复到待处理"}
                    </Button>
                  ) : null}
                </section>
              ) : null}
              {readOnly && whyNow ? <section className={s.judgment}><h2>决策时机</h2><StructuredText text={whyNow} /></section> : null}
              <section className={s.judgment}>
                <h2>当前判断</h2>
                {doc?.summary ? <StructuredText text={doc.summary} /> : <p>预研尚未产出判断。</p>}
                {doc?.summary ? (
                  <Button size="sm" variant="secondary" onPress={() => quote(doc.summary)}>
                    追问这条判断
                  </Button>
                ) : null}
              </section>
              {discussion}
              {!readOnly ? (
                /* 决定区旁边的历史：仍有效的决定、此后实际变化，只列有内容的；撤回或被替代的收起，写明不再约束。
                   「本次待判断」就是这一页本身，不再重复。什么都没有时整节收成一行小字，不出大标题。 */
                hasHistoryContent(history.data) ? (
                  <section className={s.history} data-outline="history" aria-labelledby="issue-history-title">
                    <h2 id="issue-history-title">历史与变化</h2>
                    <DecisionHistoryLayers issueId={issueId} view={history} compact />
                  </section>
                ) : (
                  <section className={s.history} data-outline="history" data-history-collapsed="" aria-label="历史与变化">
                    <DecisionHistoryLayers issueId={issueId} view={history} compact />
                  </section>
                )
              ) : null}
              {doc?.unknowns.length ? (
                <section className={s.unknown}>
                  <h2>待澄清事项</h2>
                  {doc.unknowns.map((unknown) => (
                    <p key={unknown}>{unknown}</p>
                  ))}
                </section>
              ) : null}

              <ActionFeedback state={state} onRetry={retry} />
              {/* 判断的依据放在整页最后，在其它所有内容之后。 */}
              {doc?.evidence.length ? (
                <section className={s.section}>
                  <h2>判断的依据</h2>
                  <ol>
                    {doc.evidence.map((item, index) => (
                      <li key={item.quote}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <p>{cleanDisplayText(item.quote)}</p>
                          <small title={item.sourceTitle !== shortSourceName(item.sourceTitle) ? item.sourceTitle : undefined}>
                            {isHttpUrl(item.sourceUrl) ? (
                              <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">
                                {shortSourceName(item.sourceTitle)}
                              </a>
                            ) : (
                              shortSourceName(item.sourceTitle)
                            )}
                          </small>
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
            </Tabs.Panel>

            <Tabs.Panel id="research">
              {doc?.options.length ? (
                <div className={s.prose}>
                  <h3>选择与后果</h3>
                  {doc.options.map((option, index) => (
                    <div key={option.id} className={s.option}>
                      <h4>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        {option.label}
                      </h4>
                      <ul>
                        {option.consequences.map((consequence) => (
                          <li key={consequence}>{consequence}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : (
                <p className={s.empty}>{RESEARCH_LABEL[payload.research.status] ?? "预研尚未产出文档"}。</p>
              )}
              {doc?.sources.length || doc?.evidence.length ? (
                <section className={s.section}>
                  <h2>材料来源</h2>
                  {doc.sources.map((source) => (
                    <p key={source.url}>
                      {isHttpUrl(source.url) ? (
                        <a href={source.url} target="_blank" rel="noreferrer noopener">
                          {source.title}
                        </a>
                      ) : (
                        source.title
                      )}
                    </p>
                  ))}
                  {doc.evidence.map((item) => (
                    <p key={item.quote} className={s.sourceQuote}>
                      {item.quote}
                    </p>
                  ))}
                </section>
              ) : null}
              {discussion}
            </Tabs.Panel>
            <SelectionToolbar
              selected={selected}
              onQuote={() => {
                if (!selected) return;
                quote(selected.text);
                clear();
              }}
            />
          </div>
        </Tabs>
        </ObjectMaterialArea>
      </div>
      </DetailFrame>
      {sourceOverlay}
      </SourceNavigatorProvider>
    </section>
  );
}
