"use client";

/**
 * 交付以后：伙伴写的这一版说明（达成了什么、这一版多做到的、为什么变了、经验），本人可以改一改，也可以不要这段；不点就算认可。
 * 下面一行「已交付 · 12 分钟」和「撤回」。左边是本人选的伙伴形象（BuddyMark 署名那一号），表示这段是伙伴写的；正在写时它在说。
 */
import { useEffect, useState } from "react";
import type { TDeliverableNotePatch, TDeliverableVersion } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { BuddyMark } from "@/components/buddy/BuddyMark";
import { useBuddy } from "@/components/buddy/useBuddy";
import { since } from "./deliverableFormat";
import d from "@/styles/task-deliverable.module.css";

type Draft = { achieved: string; gain: string; why: string; lesson: string };

function useMinuteNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function VersionNote({ version, canEdit, onPatch, onWithdraw }: {
  version: TDeliverableVersion;
  canEdit: boolean;
  onPatch: (patch: TDeliverableNotePatch) => Promise<string | null>;
  onWithdraw: () => Promise<string | null>;
}) {
  const now = useMinuteNow();
  const { buddy } = useBuddy();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const note = version.note;
  if (!version.deliveredAt) return null;

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const problem = await work();
    setBusy(false);
    setError(problem);
    return problem;
  };
  const save = async () => {
    if (!draft) return;
    const problem = await run(() => onPatch({ achieved: draft.achieved.trim(), gain: draft.gain.trim(), why: draft.why.trim(), lesson: draft.lesson.trim() || null }));
    if (!problem) setDraft(null);
  };

  return (
    <section className={d.section} aria-label="这一版的说明">
      {note && note.status === "writing" ? (
        <div className={d.note}>
          <BuddyMark buddy={buddy} place="note" active />
          <p className={d.noteWriting} role="status">正在写这一版的说明</p>
        </div>
      ) : null}
      {note && note.status === "done" && !note.dismissed ? (
        <div className={d.note}>
          <BuddyMark buddy={buddy} place="note" active={false} />
          {draft ? (
            <div className={d.noteEdit}>
              <label className={d.noteField}><span>达成了什么</span><input value={draft.achieved} maxLength={120} disabled={busy} onChange={(event) => setDraft({ ...draft, achieved: event.target.value })} /></label>
              <label className={d.noteField}><span>这一版多做到的</span><textarea value={draft.gain} maxLength={200} rows={2} disabled={busy} onChange={(event) => setDraft({ ...draft, gain: event.target.value })} /></label>
              <label className={d.noteField}><span>为什么变了</span><textarea value={draft.why} maxLength={300} rows={2} disabled={busy} onChange={(event) => setDraft({ ...draft, why: event.target.value })} /></label>
              <label className={d.noteField}><span>经验</span><textarea value={draft.lesson} maxLength={200} rows={2} disabled={busy} onChange={(event) => setDraft({ ...draft, lesson: event.target.value })} /></label>
              <div className={d.noteTools}>
                <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={() => setDraft(null)}>取消</HeroButton>
                <HeroButton variant="tertiary" size="sm" isDisabled={busy || !draft.achieved.trim()} onPress={() => void save()}>保存</HeroButton>
              </div>
            </div>
          ) : (
            <div className={d.noteText}>
              {note.achieved ? <p className={d.noteTitle}>{note.achieved}</p> : null}
              {note.gain ? <p>这一版多做到的：{note.gain}</p> : null}
              {note.why ? <p>为什么变了：{note.why}</p> : null}
              {note.lesson ? <p>经验：{note.lesson}</p> : null}
              {canEdit ? (
                <div className={d.noteTools}>
                  <HeroButton variant="ghost" size="sm" isDisabled={busy}
                    onPress={() => setDraft({ achieved: note.achieved ?? "", gain: note.gain ?? "", why: note.why ?? "", lesson: note.lesson ?? "" })}>改一改</HeroButton>
                  <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={() => void run(() => onPatch({ dismissed: true }))}>不要这段</HeroButton>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      <p className={d.delivered}>
        <span>已交付 · {since(version.deliveredAt, now)}</span>
        {canEdit ? <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={() => void run(onWithdraw)}>撤回</HeroButton> : null}
      </p>
      {error ? <p className={d.error} role="alert">{error}</p> : null}
    </section>
  );
}
