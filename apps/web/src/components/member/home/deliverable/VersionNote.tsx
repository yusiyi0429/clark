"use client";

/**
 * 交付以后：伙伴写的这一版说明（达成了什么、这一版多做到的、为什么变了、经验），本人可以改一改，也可以不要这段；不点就算认可。
 * 下面一行「已交付 · 12 分钟」和「撤回」。左边一颗小胶囊表示这段是伙伴写的。
 */
import { useEffect, useState } from "react";
import type { TDeliverableNotePatch, TDeliverableVersion } from "@warmap/contracts";
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
        <div className={d.note} data-writing>
          <span className={d.capsule} aria-hidden="true" />
          <p className={d.noteWriting} role="status">正在写这一版的说明</p>
        </div>
      ) : null}
      {note && note.status === "done" && !note.dismissed ? (
        <div className={d.note}>
          <span className={d.capsule} aria-hidden="true" />
          {draft ? (
            <div className={d.noteEdit}>
              <input value={draft.achieved} maxLength={120} aria-label="达成了什么" disabled={busy} onChange={(event) => setDraft({ ...draft, achieved: event.target.value })} />
              <textarea value={draft.gain} maxLength={200} rows={2} aria-label="这一版多做到的" disabled={busy} onChange={(event) => setDraft({ ...draft, gain: event.target.value })} />
              <textarea value={draft.why} maxLength={300} rows={2} aria-label="为什么变了" disabled={busy} onChange={(event) => setDraft({ ...draft, why: event.target.value })} />
              <textarea value={draft.lesson} maxLength={200} rows={2} aria-label="经验" disabled={busy} onChange={(event) => setDraft({ ...draft, lesson: event.target.value })} />
              <div className={d.noteTools}>
                <button type="button" className={d.quiet} disabled={busy} onClick={() => setDraft(null)}>取消</button>
                <button type="button" className={d.plain} disabled={busy || !draft.achieved.trim()} onClick={() => void save()}>保存</button>
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
                  <button type="button" className={d.quiet} disabled={busy}
                    onClick={() => setDraft({ achieved: note.achieved ?? "", gain: note.gain ?? "", why: note.why ?? "", lesson: note.lesson ?? "" })}>改一改</button>
                  <button type="button" className={d.quiet} disabled={busy} onClick={() => void run(() => onPatch({ dismissed: true }))}>不要这段</button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      <p className={d.delivered}>
        <span>已交付 · {since(version.deliveredAt, now)}</span>
        {canEdit ? <button type="button" className={d.quiet} disabled={busy} onClick={() => void run(onWithdraw)}>撤回</button> : null}
      </p>
      {error ? <p className={d.error} role="alert">{error}</p> : null}
    </section>
  );
}
