"use client";

/**
 * 伙伴要转达给同事的一句话（17.4 send_message 先出的卡，buddy_message）：选项框写收件人和要转达的话，「发出（推荐）/ 不发」。
 * 发出由天枢机器人转达；答过的收成一行（已发出 / 不发），有人没收到写在后面。别处已经答过（409）就重读一次照它显示。
 */
import { useEffect, useState } from "react";
import type { TBuddyMessageDraft } from "@warmap/contracts";
import { DecisionBox } from "@/components/work/DecisionBox";
import { CloudError } from "@/lib/board/cloud";
import { cancelBuddyMessage, readBuddyMessage, sendBuddyMessage } from "@/lib/buddy/actions";

const names = (people: TBuddyMessageDraft["to"]) => people.map((person) => person.name).join("、");

export function buddyMessageResolved(draft: TBuddyMessageDraft): string | null {
  if (draft.status === "cancelled") return "不发";
  if (draft.status !== "sent") return null;
  return draft.failed.length ? `已发出 · ${names(draft.failed)} 没收到` : "已发出";
}

export function BuddyMessageCard({ draftId }: { draftId: string }) {
  const [draft, setDraft] = useState<TBuddyMessageDraft | null>(null);
  useEffect(() => {
    let alive = true;
    void readBuddyMessage(draftId).then((found) => { if (alive) setDraft(found); }, () => undefined);
    return () => { alive = false; };
  }, [draftId]);
  if (!draft) return null;
  return <BuddyMessageBox draft={draft} onDraft={setDraft} />;
}

export function BuddyMessageBox({ draft, onDraft }: { draft: TBuddyMessageDraft; onDraft: (next: TBuddyMessageDraft) => void }) {
  const title = `转达给 ${names(draft.to)}`;
  const body = <span style={{ whiteSpace: "pre-wrap" }}>{draft.text}</span>;
  const resolved = buddyMessageResolved(draft);
  if (resolved) return <DecisionBox kind="question" title={title} body={body} options={[]} onPick={() => undefined} resolved={resolved} />;
  const answer = async (send: boolean) => {
    try { onDraft(await (send ? sendBuddyMessage(draft.id) : cancelBuddyMessage(draft.id))); }
    catch (error) {
      if (error instanceof CloudError && error.status === 409) { onDraft(await readBuddyMessage(draft.id)); return; }
      throw error;
    }
  };
  return (
    <DecisionBox kind="question" testId="buddy-message" title={title} body={body}
      options={[{ label: "发出", recommended: true }, { label: "不发" }]} onPick={([index]) => answer(index === 0)} />
  );
}
