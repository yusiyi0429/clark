"use client";

/**
 * 调研专题页（/me/topics/[id]，第 9 节，原型 v8.4 专题子会话）：左边和本机的 Claude Code 对话，右边当前一版（Markdown），可切到以前的版本，
 * 「存进飞书」「放进下一版」。先出提纲：提纲那一版下面有「按这个提纲写」。
 * 有了正文以后能开「评审会」（第 19.1、19.6 节）：选 2–3 个挑刺的岗位，本机并行挑刺、合成一份，存成「评审」那一版，按「分歧和建议」排版。
 * 版本由本机经同步报到云端；对话全文只在本机。手机和别的电脑上只能看版本。
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import { ChevronLeft } from "lucide-react";
import type { TTopicDetailResponse, TTopicVersionView } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { useHandheld } from "@/components/ui/useHandheld";
import { StartDialog } from "@/components/local/StartDialog";
import { SessionComposer, SessionTranscript } from "@/components/cards/SessionTranscript";
import { latestSessionFor, useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { useSessionEvents } from "@/lib/local/useSessionEvents";
import { localWait } from "@/lib/local/sessionView";
import { startTopic } from "@/lib/local/start";
import { WAIT_LABEL, canCommand, waitTone } from "@/lib/board/cards";
import { addTopicVersionToPending, patchTopic, readTopic, readTopicVersion } from "@/lib/board/cloud";
import { REMARK_PLUGINS } from "@/lib/markdown";
import { ReviewDialog, ReviewDoc, isReview, reviewText } from "./Review";
import { showWorkspaceToast } from "@/lib/toast";
import s from "@/styles/v2-session.module.css";

export function TopicSession({ topicId }: { topicId: string }) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  const [detail, setDetail] = useState<TTopicDetailResponse | null>(null);
  const [missing, setMissing] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [version, setVersion] = useState<TTopicVersionView | null>(null);
  const [starting, setStarting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const load = useCallback(async () => {
    try {
      const data = await readTopic(topicId);
      if (data) setDetail(data); else setMissing(true);
    } catch { /* 留着上次的 */ }
  }, [topicId]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 8000);
    return () => window.clearInterval(timer);
  }, [load]);
  // 切到以前的版本：按号取正文；最新一版就用详情里带的。
  useEffect(() => {
    if (picked === null || !detail || picked === detail.current?.number) { setVersion(null); return; }
    let alive = true;
    void readTopicVersion(topicId, picked).then((value) => { if (alive) setVersion(value); }).catch(() => undefined);
    return () => { alive = false; };
  }, [picked, detail, topicId]);

  const ready = local.phase === "ready";
  const session = ready ? latestSessionFor(local.sessions, { topicId }) : null;
  // 刚建的专题（?start=1）：本机连着、还没开过，就直接弹出「开始」。
  const [autoStart, setAutoStart] = useState(false);
  useEffect(() => { setAutoStart(new URLSearchParams(window.location.search).get("start") === "1"); }, []);
  useEffect(() => {
    if (!autoStart || !ready || !detail || session) return;
    setAutoStart(false);
    setStarting(true);
    window.history.replaceState(null, "", window.location.pathname);
  }, [autoStart, ready, detail, session]);
  const { view } = useSessionEvents(local.runner, session?.id ?? null);
  const canAct = canCommand({ ready, handheld, hasSession: !!session });

  if (missing) return <div className={s.gone}><p>没有这个专题</p><Link href="/me/chat">回到对话</Link></div>;
  if (!detail) return <div className={s.page} aria-busy />;

  const { topic } = detail;
  const shown = version ?? detail.current;
  const hasDraft = detail.versions.some((entry) => entry.kind === "draft");
  const wait = session ? localWait(view) : null;
  const say = async (text: string) => {
    if (!session) return false;
    try { await local.runner.sendMessage(session.id, text); return true; }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没发出去，请重试" }); return false; }
  };
  const decide = async (requestId: string, decision: "allow" | "deny", forSession: boolean) => {
    if (!session) return;
    try { await local.runner.decidePermission(session.id, requestId, { decision, allowForSession: forSession }); }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); }
  };
  const toPending = async () => {
    if (!shown || !topic.planTaskId) return;
    try { await addTopicVersionToPending(topic.planTaskId, shown.id); showWorkspaceToast({ text: "已放进下一版" }); void load(); }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没放进去，请重试" }); }
  };
  const archive = async () => {
    try { await patchTopic(topic.id, { status: topic.status === "archived" ? "active" : "archived" }); showWorkspaceToast({ text: topic.status === "archived" ? "已取消归档" : "已归档" }); void load(); }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); }
  };

  const doc = (
    <aside className={s.pane} data-reading aria-label="当前版本">
      <div className={s.docHead}>
        <b>{topic.title}</b>
        {shown ? <small>{shown.label}</small> : null}
        <span className={s.grow} />
        {hasDraft && canAct ? <HeroButton variant="secondary" size="sm" onPress={() => setReviewing(true)}>评审会</HeroButton> : null}
        {shown?.feishuUrl ? <a href={shown.feishuUrl} target="_blank" rel="noopener noreferrer" className={s.tag} data-tone="done">已存进飞书</a>
          : shown && canAct ? <HeroButton variant="secondary" size="sm" onPress={() => void say(`把「${shown.label}」存进飞书，存好把地址交回来。`)}>存进飞书</HeroButton> : null}
        {shown && topic.planTaskId && !handheld ? (shown.deliverable ? <span className={s.tag} data-tone="ver">{shown.deliverable.state === "included" ? `已纳入 v${shown.deliverable.versionNumber}` : `v${shown.deliverable.versionNumber} 准备中`}</span>
          : <HeroButton variant="ghost" size="sm" onPress={() => void toPending()}>放进下一版</HeroButton>) : null}
      </div>
      {detail.versions.length > 1 ? (
        <div className={s.versions} role="tablist" aria-label="版本">
          {detail.versions.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={(shown?.number ?? null) === entry.number} onClick={() => setPicked(entry.number)}>{entry.label}</button>
          ))}
        </div>
      ) : null}
      {shown ? (
        <>
          {shown.note ? <p className={s.note}>{shown.note}</p> : null}
          {isReview(shown) ? <ReviewDoc body={shown.body} /> : <article className={s.doc} data-outline={shown.kind === "outline" || undefined}><Markdown remarkPlugins={REMARK_PLUGINS}>{shown.body}</Markdown></article>}
          {shown.kind === "outline" && shown.number === detail.current?.number && canAct ? <div className={s.actions}><HeroButton variant="primary" size="sm" onPress={() => void say("按这个提纲写。")}>按这个提纲写</HeroButton></div> : null}
        </>
      ) : <p className={s.faint}>还没有版本</p>}
    </aside>
  );

  return (
    <div className={s.page} data-testid="topic-session">
      <header className={s.head}>
        <Link href="/me/chat" className={s.back}><ChevronLeft size={14} aria-hidden />{handheld ? null : "对话"}</Link>
        <div className={s.title}>
          <span className={s.kind} data-kind="topic">专题</span>
          <b>{topic.title}</b>
          {wait ? <span className={s.tag} data-tone={waitTone(wait)}>{WAIT_LABEL[wait]}</span> : <span className={s.tag} data-tone={topic.status === "archived" ? undefined : "ver"}>{topic.status === "archived" ? "已归档" : "进行中"}</span>}
        </div>
        <div className={s.exec}>
          {detail.task ? <Link href={`/me/month/tasks/${encodeURIComponent(detail.task.taskId)}`} className={s.link}>{detail.task.name}</Link> : null}
          {!handheld ? <HeroButton variant="ghost" size="sm" onPress={() => void archive()}>{topic.status === "archived" ? "取消归档" : "归档"}</HeroButton> : null}
        </div>
      </header>
      {handheld ? <div className={s.body} data-solo>{doc}</div> : (
        <div className={s.body}>
          <div className={s.chat}>
            <div className={s.scroll}>
              {session ? <SessionTranscript entries={view.entries} agentName="Claude Code" canAct={canAct} onDecide={(request, decision, forSession) => decide(request.requestId, decision, forSession)} />
                : <div className={s.feed}><span className={s.evt}>{topic.title}</span>
                    {ready && topic.status === "active" ? <div className={s.actions}><HeroButton variant="primary" size="sm" onPress={() => setStarting(true)}>开始</HeroButton></div> : null}
                  </div>}
            </div>
            <SessionComposer placeholder="发给 Claude Code…" disabled={!canAct} onSend={say} />
          </div>
          {doc}
        </div>
      )}
      {reviewing ? <ReviewDialog onClose={() => setReviewing(false)} onStart={async (critics) => {
        if (!session) return;
        try { await local.runner.sendMessage(session.id, reviewText(critics), "review"); setReviewing(false); showWorkspaceToast({ text: "评审会开始了" }); }
        catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没开起来，请重试" }); }
      }} /> : null}
      {starting ? <StartDialog title={topic.title} needsFolder={false} onClose={() => setStarting(false)} onStart={async (model) => {
        await startTopic(local.runner, topic, model);
        setStarting(false);
        await local.refresh();
      }} /> : null}
    </div>
  );
}
