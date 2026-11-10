"use client";

/**
 * 对话页（/me/chat）：居中一列和伙伴的主对话；左上「对话」打开列表：主对话、专题、已归档，「新专题」。
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { List, PencilLine } from "lucide-react";
import { Popover } from "ts-design/primitives";
import { TianshuPortalTheme } from "ts-design";
import { HeroButton } from "@/components/HeroButton";
import { BuddyMark } from "@/components/buddy/BuddyMark";
import { useBuddy } from "@/components/buddy/useBuddy";
import { useHomePlan } from "@/components/member/home/useHomePlan";
import type { TResearchTopicView } from "@warmap/contracts";
import { createTopic, listTopics } from "@/lib/board/cloud";
import { showWorkspaceToast } from "@/lib/toast";
import { ChatPane } from "./ChatPane";
import s from "@/styles/v2-chat.module.css";
import m from "@/styles/account-menu.module.css";

export function ChatPage() {
  const { buddy } = useBuddy();
  return (
    <ChatPane buddy={buddy} head={
      <div className={s.pageHead}>
        <ChatList current="main" buddyName={buddy?.name?.trim() || "伙伴"} />
        <div className={s.figure}><BuddyMark buddy={buddy} place="sheet" active={false} /></div>
        <span />
      </div>
    } />
  );
}

export function ChatList({ current, buddyName }: { current: "main" | string; buddyName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [topics, setTopics] = useState<TResearchTopicView[] | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void Promise.all([listTopics("active"), listTopics("archived")]).then(([live, old]) => { if (alive) setTopics([...live, ...old]); }).catch(() => { if (alive) setTopics([]); });
    return () => { alive = false; };
  }, [open]);
  const live = (topics ?? []).filter((topic) => topic.status === "active");
  const archived = (topics ?? []).filter((topic) => topic.status === "archived");
  const go = (href: string) => { setOpen(false); setAdding(false); router.push(href); };
  const row = (topic: TResearchTopicView) => (
    <button key={topic.id} type="button" className={s.row} aria-current={current === topic.id ? "page" : undefined} onClick={() => go(`/me/topics/${encodeURIComponent(topic.id)}`)}>
      <i className={s.topicDot} aria-hidden />
      <span><b>{topic.title}</b><small>{topic.latestVersion?.label ?? "刚开始"}</small></span>
    </button>
  );
  return (
    <Popover isOpen={open} onOpenChange={(next) => { setOpen(next); if (!next) setAdding(false); }}>
      <button type="button" className={s.listButton} aria-label="对话列表"><List size={15} aria-hidden /><span>对话</span></button>
      <Popover.Content placement="bottom start" offset={8} className={m.popover}>
        <TianshuPortalTheme>
          <Popover.Dialog className={s.list} aria-label="对话列表">
            <div className={s.listHead}>
              <b>对话</b>
              <HeroButton variant="ghost" size="sm" onPress={() => setAdding(true)}><PencilLine size={13} aria-hidden />新专题</HeroButton>
            </div>
            <button type="button" className={s.row} aria-current={current === "main" ? "page" : undefined} onClick={() => go("/me/chat")}>
              <i className={s.topicDot} aria-hidden />
              <span><b>{buddyName}</b><small>主对话</small></span>
            </button>
            <p className={s.groupLabel}>专题</p>
            {topics === null ? null : live.length ? live.map(row) : <p className={s.none}>还没有专题</p>}
            {archived.length ? <><p className={s.groupLabel}>已归档</p>{archived.map(row)}</> : null}
            {adding ? <NewTopicForm onCancel={() => setAdding(false)} onCreated={(topic) => go(`/me/topics/${encodeURIComponent(topic.id)}?start=1`)} /> : null}
          </Popover.Dialog>
        </TianshuPortalTheme>
      </Popover.Content>
    </Popover>
  );
}

/** 新专题：写标题，可选挂哪个 Task。建出来就进专题页，在那里对本机「开始」。 */
function NewTopicForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (topic: TResearchTopicView) => void }) {
  const { plan } = useHomePlan();
  const [title, setTitle] = useState("");
  const [taskId, setTaskId] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = async () => {
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      onCreated(await createTopic({ title: text.slice(0, 60), ...(taskId ? { planTaskId: taskId } : {}) }));
    } catch {
      showWorkspaceToast({ text: "专题没建成，请重试" });
      setBusy(false);
    }
  };
  return (
    <form className={s.newForm} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <input ref={input} value={title} maxLength={60} placeholder="专题标题" aria-label="专题标题" onChange={(event) => setTitle(event.target.value)} />
      <select value={taskId} aria-label="挂到哪个 Task" onChange={(event) => setTaskId(event.target.value)}>
        <option value="">不挂 Task</option>
        {(plan?.tasks ?? []).map((task) => <option key={task.taskId} value={task.taskId}>{task.name}</option>)}
      </select>
      <div className={s.newActions}>
        <HeroButton variant="ghost" size="sm" onPress={onCancel}>取消</HeroButton>
        <HeroButton variant="primary" size="sm" type="submit" isDisabled={!title.trim() || busy}>建专题</HeroButton>
      </div>
    </form>
  );
}
