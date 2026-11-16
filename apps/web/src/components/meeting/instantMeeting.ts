/** 现在开的一场（现场录音、远程会议都走它）：开始就是提交那一刻，开一小时；挂点只带 kind 和 id，没有参会人不带这一项。 */
import type { TMeetingBookingRequest, TPickedWorldAnchor, TWorldAnchor } from "@warmap/contracts";
import { SLOT_MS } from "@/lib/home/meeting";

export function instantMeetingPayload({ title, at, participants, anchors, draftId, leadDriId }: {
  title: string; at: number; participants: string[]; anchors: TWorldAnchor[]; draftId: string; leadDriId?: string;
}): TMeetingBookingRequest {
  return {
    draftId, title, scheduledAt: new Date(at).toISOString(), endsAt: new Date(at + SLOT_MS).toISOString(),
    ...(leadDriId ? { leadDriId } : {}),
    ...(participants.length ? { participants } : {}),
    anchors: anchors.map(({ kind, id }) => ({ kind: kind as TPickedWorldAnchor["kind"], id })),
  };
}
