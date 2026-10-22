/**
 * 会议记录上传（会议页、首页会议安排、通知栏共用）：txt、md、pdf、docx、html 都交给服务端认（妙记逐字稿、带说话人的文字、认不出说话人的当会议纪要）；
 * .json 是 warmap-transcript 直导，走原来的接口。
 */
export const MEETING_RECORD_ACCEPT = ".md,.markdown,.txt,.pdf,.docx,.html,.htm,.json,text/markdown,text/plain,text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/json";

export type MeetingRecordUpload<Card> = { ok: true; card: Card | null } | { ok: false; status: number; message: string };

export async function uploadMeetingRecord<Card = unknown>(meetingId: string, file: File): Promise<MeetingRecordUpload<Card>> {
  const form = new FormData();
  form.append("file", file);
  const path = /\.json$/i.test(file.name) ? "transcript" : "transcript-candidate";
  let response: Response;
  try {
    response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/${path}`, { method: "POST", body: form });
  } catch {
    return { ok: false, status: 0, message: "网络不通，没传上去" };
  }
  const body = (await response.json().catch(() => ({}))) as { message?: string; cards?: Card[]; card?: Card };
  if (response.ok) return { ok: true, card: body.cards?.[0] ?? body.card ?? null };
  return { ok: false, status: response.status, message: body.message ?? "没传上去，请重试" };
}
