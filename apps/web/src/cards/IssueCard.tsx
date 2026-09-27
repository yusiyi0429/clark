"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Tabs } from "@heroui/react";
import { CalendarDays, Check, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import type { CardRenderProps } from "./registry";
import { payloadOf, type IssuePayload, type MeetingPayload } from "./payloads";
import { issueScopeLabel } from "./scopeNames";
import { ContextMark } from "@/components/ContextMark";
import { SelectionToolbar, useSelectionQuote } from "@/components/SelectionQuote";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { COMPANY_TIMEZONE, calendarDate } from "@/lib/companyTime";
import { ActionFeedback, useCardAction } from "@/lib/useCardAction";
import { ThreadMembersMenu } from "@/conversation/ThreadMembersMenu";
import s from "@/styles/issue-workspace.module.css";

const RESEARCH_LABEL: Record<string, string> = {
  pending: "预研排队中",
  running: "预研进行中",
  ready: "预研已完成",
  failed: "预研失败",
};

const ORIGIN_LABEL: Record<IssuePayload["origin"], string> = { radar: "雷达升级", dri: "负责人提请", ceo: "你发起的议题" };

/** 旧预研文档里可能存在 file:// 或 urn: 这类模型自编的来源，只给真实 http(s) 渲染链接。 */
function isHttpUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//.test(url);
}

type PersonOption = { personId: string; displayName: string; roles: string[] };

/** 眉题里的阶段（clark TOPIC_LIFECYCLE_LABELS 的写法），只从议题与会议的真实状态推出。 */
function lifecycleLabel(payload: IssuePayload, hasMeeting: boolean): string {
  if (payload.status === "decided") return "已形成结论";
  if (payload.status === "dismissed") return "已移出决策面";
  if (hasMeeting) return "已安排会议";
  if (payload.research.status === "pending" || payload.research.status === "running") return "研究中";
  return "与你一起想";
}

const meetingDay = (iso: string) =>
  new Date(iso).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long", timeZone: COMPANY_TIMEZONE });
const meetingClock = (iso: string) =>
  new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: COMPANY_TIMEZONE });

/**
 * 议题工作区（clark `issue-workspace.tsx`）：玻璃页头 + 会议安排 + 「总结与判断 / 研究与依据」两个页签，
 * 对话在外壳右侧的对话列。决策路径、移出/恢复、会议结论撤回与重试预研是天枢独有，都只通过 Action 提交；
 * 决定只走 Meeting Outcome 链路，页面不提供直接决定。
 */
export function IssueCard({ card, onCard, onNavigate }: CardRenderProps) {
  const payload = payloadOf<IssuePayload>(card);
  const { homeCards, quote, viewerId } = useWorkspace();
  const { state, run, retry, pending } = useCardAction(onCard);
  const [tab, setTab] = useState<"summary" | "research">("summary");
  const [dismissReason, setDismissReason] = useState("");
  const [joinMeetingId, setJoinMeetingId] = useState("");
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [peopleError, setPeopleError] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [leadDriId, setLeadDriId] = useState("");
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const reading = useRef<HTMLDivElement>(null);
  const { selected, clear, onMouseUp } = useSelectionQuote(reading);

  const actions = card.actions;
  const actionOf = (type: string) => actions.find((action) => action.actionType === type);
  const doc = payload.research.doc;
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
  const canCreateMeeting = payload.status === "pending" && Boolean(actionOf("issue.create_meeting"));
  const ceoPerson = people.find((person) => person.roles.includes("ceo"));
  const driPeople = people.filter((person) => person.roles.includes("dri"));
  const deadline = payload.status === "pending" ? calendarDate(payload.urgency.decisionBy) : "";
  const eyebrow = [lifecycleLabel(payload, Boolean(meeting)), issueScopeLabel(payload.location, homeCards), deadline ? `决定期限 ${deadline}` : ""]
    .filter(Boolean)
    .join(" · ");

  // 决策路径需要人员目录选择 personId；只在可创建 Meeting 时拉取一次。
  useEffect(() => {
    if (!canCreateMeeting) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/people", { headers: { accept: "application/json" } });
        if (cancelled) return;
        if (!response.ok) return setPeopleError(true);
        const body = (await response.json()) as { people: PersonOption[] };
        if (!cancelled) setPeople(body.people);
      } catch {
        if (!cancelled) setPeopleError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canCreateMeeting]);

  const discussion = (
    <section className={s.discussion} aria-labelledby="issue-discussion-title">
      <header>
        <div>
          <h2 id="issue-discussion-title">{activeReceipts.length ? "会议结论" : meeting ? "带到会议讨论" : "值得一起推敲的方向"}</h2>
          <p>
            {activeReceipts.length
              ? "这是会议中形成并回传的结论。"
              : meeting
                ? "这些是理解取舍的备选路径，不需要在本页点选。"
                : "先把信息与分歧弄清楚，再决定下一步。"}
          </p>
        </div>
        <span>{activeReceipts.length ? "已记录" : meeting ? `${meetingClock(meeting.payload.scheduledAt)} 讨论` : "与你一起想"}</span>
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
                  决定时预研：{RESEARCH_LABEL[receipt.researchStatusAtDecision] ?? receipt.researchStatusAtDecision}
                  {receipt.override ? " · Research Override" : ""} · {calendarDate(receipt.createdAt)}
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
        <p className={s.empty}>{RESEARCH_LABEL[payload.research.status] ?? "预研尚未产出"}，备选路径稍后出现。</p>
      )}
      <small>
        {meeting ? "由主责 DRI 开启会议。材料和讨论继续留在这个议题里。" : "可以先与天枢讨论，也可以在下方安排一场会议。"}
      </small>
    </section>
  );

  return (
    <section className={s.workspace} data-testid="issue-workspace" data-status={payload.status} aria-labelledby="issue-title">
      <header className={s.header}>
        <div className={s.identity}>
          <ContextMark kind={meeting ? "meeting" : "issue"} />
          <div>
            <span>{eyebrow}</span>
            <h1 id="issue-title">{card.title}</h1>
          </div>
        </div>
        <ThreadMembersMenu objectType="issue" objectId={card.objectRef.id} viewerId={viewerId ?? ""} members={[]} inviteOnly onChanged={() => undefined} />
        <Button isIconOnly variant="tertiary" data-close-view onPress={() => onNavigate("/")} aria-label="关闭议题，返回原位置">
          <X size={19} aria-hidden="true" />
        </Button>
      </header>

      {meeting ? (
        <section className={s.meetingHeader} aria-label="议题会议安排">
          <div className={s.meetingDate}>
            <CalendarDays size={15} aria-hidden="true" />
            <span>{meetingDay(meeting.payload.scheduledAt)}</span>
            <span className={s.meetingState}>已安排会议</span>
          </div>
          <time className={s.meetingTime} dateTime={meeting.payload.scheduledAt}>
            {meetingClock(meeting.payload.scheduledAt)}
          </time>
          <div className={s.meetingMeta}>
            <span>主责 DRI · {meetingLead ?? "待确认"}</span>
            <button
              type="button"
              className={s.meetingOpen}
              data-origin={`/meetings/${meeting.card.objectRef.id}`}
              onClick={(event) => onNavigate(`/meetings/${meeting.card.objectRef.id}`, event.currentTarget)}
            >
              {meeting.card.title} · 打开会议空间
            </button>
          </div>
        </section>
      ) : null}

      <div className={s.columns}>
        <Tabs
          className={s.materials}
          variant="secondary"
          selectedKey={tab}
          onSelectionChange={(key) => {
            clear();
            setTab(key as "summary" | "research");
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
          <div className={s.reading} ref={reading} onMouseUp={onMouseUp}>
            <p className={s.note}>
              {ORIGIN_LABEL[payload.origin]} · {RESEARCH_LABEL[payload.research.status] ?? payload.research.status}
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
                    <p>已移出决策面：{payload.dismissReason ?? "未填写原因"}</p>
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
              <section className={s.judgment}>
                <h2>当前判断</h2>
                <p>{doc?.summary ?? "预研尚未产出判断。"}</p>
                {doc?.summary ? (
                  <Button size="sm" variant="secondary" onPress={() => quote(doc.summary)}>
                    追问这条判断
                  </Button>
                ) : null}
              </section>
              {discussion}
              {doc?.evidence.length ? (
                <section className={s.section}>
                  <h2>判断的依据</h2>
                  <ol>
                    {doc.evidence.map((item, index) => (
                      <li key={item.quote}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <p>{item.quote}</p>
                          <small>
                            {isHttpUrl(item.sourceUrl) ? (
                              <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">
                                {item.sourceTitle}
                              </a>
                            ) : (
                              item.sourceTitle
                            )}
                          </small>
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
              {doc?.unknowns.length ? (
                <section className={s.unknown}>
                  <h2>还没弄清的</h2>
                  {doc.unknowns.map((unknown) => (
                    <p key={unknown}>{unknown}</p>
                  ))}
                </section>
              ) : null}

              {payload.status === "pending" ? (
                <>
                  <section className={s.preflightActions} data-issue-side="path" aria-label="决策路径">
                    <div>
                      <h2>决策路径</h2>
                      <p>会议是待决策议题的可选路径；决定由会后结论确认生效。</p>
                    </div>
                    <div className={s.actionRow}>
                      {canCreateMeeting ? (
                        <Button size="sm" variant={planning ? "tertiary" : "secondary"} onPress={() => setPlanning((open) => !open)} aria-expanded={planning}>
                          {planning ? "收起会议安排" : "安排一场会议"}
                        </Button>
                      ) : null}
                    </div>
                    {canCreateMeeting && planning ? (
                      <div className={s.meetingForm}>
                        {peopleError ? <p className={s.formNote} role="alert">人员目录暂时读取失败，暂时无法选择主持 DRI。刷新页面后再试。</p> : null}
                        <label className={s.field}>
                          <span>会议标题</span>
                          <input value={meetingTitle} onChange={(event) => setMeetingTitle(event.target.value)} placeholder={card.title} />
                        </label>
                        <label className={s.field}>
                          <span>时间</span>
                          <input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />
                        </label>
                        <label className={s.field}>
                          <span>主持 DRI</span>
                          <select value={leadDriId} onChange={(event) => setLeadDriId(event.target.value)}>
                            <option value="">选择 DRI</option>
                            {driPeople.map((person) => (
                              <option key={person.personId} value={person.personId}>
                                {person.displayName}
                              </option>
                            ))}
                          </select>
                        </label>
                        <fieldset className={s.field}>
                          <legend>参与人（CEO 与主持 DRI 始终参加）</legend>
                          <div className={s.participants}>
                            {people.map((person) => (
                              <label key={person.personId}>
                                <input
                                  type="checkbox"
                                  checked={participantIds.includes(person.personId)}
                                  onChange={(event) =>
                                    setParticipantIds((current) =>
                                      event.target.checked ? [...current, person.personId] : current.filter((id) => id !== person.personId),
                                    )
                                  }
                                />
                                {person.displayName}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        <div className={s.actionRow}>
                          <Button
                            size="sm"
                            variant="primary"
                            isDisabled={pending || !scheduledAt || !leadDriId || !ceoPerson}
                            onPress={async () => {
                              const created = await run(actionOf("issue.create_meeting")!, {
                                title: meetingTitle.trim() || card.title,
                                scheduledAt: new Date(scheduledAt).toISOString(),
                                leadDriId,
                                ceoParticipantId: ceoPerson!.personId,
                                participants: [leadDriId, ...participantIds],
                                issueIds: [card.objectRef.id],
                              });
                              if (created?.kind === "meeting") onNavigate(`/meetings/${created.objectRef.id}`);
                            }}
                          >
                            {pending ? "提交中…" : "新建 Meeting"}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {actionOf("issue.join_meeting") ? (
                      <div className={s.joinRow}>
                        <label className={s.field}>
                          <span>加入已有 Meeting</span>
                          <select value={joinMeetingId} onChange={(event) => setJoinMeetingId(event.target.value)}>
                            <option value="">选择 scheduled Meeting</option>
                            {scheduledMeetings.map((option) => (
                              <option key={option.objectRef.id} value={option.objectRef.id}>
                                {option.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled={pending || !joinMeetingId}
                          onPress={() => void run(actionOf("issue.join_meeting")!, { meetingId: joinMeetingId })}
                        >
                          {pending ? "提交中…" : "加入 Meeting"}
                        </Button>
                      </div>
                    ) : null}
                  </section>

                  {actionOf("issue.dismiss") ? (
                    <section className={s.preflightActions} data-issue-side="dismiss" aria-label="移出决策面">
                      <div>
                        <h2>移出决策面</h2>
                        <p>不再需要你判断的议题可以移出；移出后仍可恢复。</p>
                      </div>
                      <div className={s.joinRow}>
                        <label className={s.field}>
                          <span>原因</span>
                          <input value={dismissReason} onChange={(event) => setDismissReason(event.target.value)} placeholder="例如：误升级" />
                        </label>
                        <Button
                          size="sm"
                          variant="tertiary"
                          isDisabled={pending || !dismissReason.trim()}
                          onPress={() => void run(actionOf("issue.dismiss")!, { reason: dismissReason.trim() })}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          {pending ? "提交中…" : "移出议题"}
                        </Button>
                      </div>
                    </section>
                  ) : null}
                </>
              ) : null}
              <ActionFeedback state={state} onRetry={retry} />
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
      </div>
    </section>
  );
}
