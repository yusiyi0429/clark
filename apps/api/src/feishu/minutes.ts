import type { Query } from "../meetingStore.js";
import { FeishuApiError } from "./client.js";
import type { FeishuEnv } from "./config.js";
import { decryptTokenSecret } from "./crypto.js";

/**
 * 飞书妙记与会议的适配层（会议链路 G）。都用主持人本人的 user_access_token（用户身份）：
 * - 妙记详情：GET /minutes/v1/minutes/{minute_token}（minutes:minutes:readonly）
 * - 逐字稿全文：GET /minutes/v1/minutes/{minute_token}/artifacts 的 data.transcript（与 lark-cli minutes +detail --transcript 写出的逐字相同，Chat 侧按它核对摘要值）
 * - 逐字稿导出（产物接口没权限时退回）：GET /minutes/v1/minutes/{minute_token}/transcript?need_speaker=true&need_timestamp=true&file_format=txt（minutes:minutes.transcript:export）
 * - 轮询兜底：POST /minutes/v1/minutes/search，按本人名下、时间段列妙记
 * - 实际参会名单：GET /vc/v1/meetings/{meeting_id}?with_participants=true（用户身份 vc:meeting）
 * search 10/21 对过真飞书：条件放在 filter 里（owner_ids、create_time 的起止），每页最多 30；结果只有 token 和展示文字，
 * 开始时刻、所有者、来源会议要再逐条查详情。参会名单的字段名还没对过（标了「待联调」）。
 */
const OPEN_API = "https://open.feishu.cn/open-apis";
const TIMEOUT_MS = 15_000;

export type FeishuMinuteInfo = {
  token: string;
  title: string;
  ownerOpenId: string | null;
  /** 妙记记下的开始时刻（会议妙记约等于开会时刻）。 */
  createdAt: Date | null;
  durationSeconds: number | null;
  url: string | null;
  /** 来源会议（详情里的 generated_source.source_entity_id）。 */
  meetingId: string | null;
  /** 来源类型（详情里的 generated_source.source_type；10/23 真飞书只见过 meeting）。 */
  sourceType: string | null;
};

/** 飞书视频会议生成的妙记：有来源会议号，来源类型为空或是 meeting（手机妙记、上传音视频的不算）。 */
export function isMeetingMinute(minute: Pick<FeishuMinuteInfo, "meetingId" | "sourceType">): boolean {
  return Boolean(minute.meetingId) && (minute.sourceType === null || minute.sourceType === "meeting");
}

/** 妙记还没转写完（待联调：按开放平台妙记错误码）。 */
export const MINUTES_NOT_READY_CODE = 2091003;

export type FeishuMinutesApi = {
  getMinute(userAccessToken: string, minuteToken: string): Promise<FeishuMinuteInfo>;
  /** 妙记产物里的逐字稿全文（/artifacts 的 data.transcript）。 */
  artifactTranscript(userAccessToken: string, minuteToken: string): Promise<string>;
  /** 逐字稿 txt 原文（导出接口；产物接口没权限时退回用）。 */
  exportTranscript(userAccessToken: string, minuteToken: string): Promise<string>;
  /** 本人名下、时间段内的妙记（轮询兜底）；skip 里的 token 不查详情、不返回。 */
  listMinutes(userAccessToken: string, owner: { openId: string }, range: { start: Date; end: Date }, skip?: ReadonlySet<string>): Promise<FeishuMinuteInfo[]>;
  /** 会议实际参会人的 open_id（中途加入的也算）。 */
  meetingParticipants(userAccessToken: string, meetingId: string): Promise<string[]>;
};

type Fetch = typeof fetch;
const msDate = (value: unknown): Date | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 飞书有的字段是秒、有的是毫秒：小于 1e12 按秒算。
  return new Date(n < 1e12 ? n * 1000 : n);
};
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function minuteOf(raw: Record<string, unknown>): FeishuMinuteInfo {
  const duration = Number(raw.duration);
  const source = (raw.generated_source ?? raw.minute_source) as { source_entity_id?: unknown; source_type?: unknown } | undefined;
  return {
    token: String(raw.token ?? raw.minute_token ?? ""),
    title: String(raw.title ?? raw.topic ?? ""),
    ownerOpenId: str(raw.owner_id),
    createdAt: msDate(raw.create_time ?? raw.start_time),
    durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration > 100_000 ? duration / 1000 : duration) : null,
    url: str(raw.url),
    meetingId: str(source?.source_entity_id),
    sourceType: str(source?.source_type),
  };
}

export function createFeishuMinutesApi({ fetch: fetchImpl = fetch }: { fetch?: Fetch } = {}): FeishuMinutesApi {
  async function call(userAccessToken: string, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await fetchImpl(`${OPEN_API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${userAccessToken}`, "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let body: Record<string, unknown>;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { throw new FeishuApiError(0, `飞书接口返回了非 JSON 响应（HTTP ${response.status}）`, response.status); }
    const code = Number(body.code ?? -1);
    if (code !== 0) throw new FeishuApiError(code, String(body.msg ?? "飞书接口失败"), response.status);
    return (body.data ?? {}) as Record<string, unknown>;
  }
  async function getMinute(userAccessToken: string, minuteToken: string): Promise<FeishuMinuteInfo> {
    const data = await call(userAccessToken, `/minutes/v1/minutes/${encodeURIComponent(minuteToken)}?user_id_type=open_id`);
    return minuteOf({ ...((data.minute ?? data) as Record<string, unknown>), token: minuteToken });
  }
  return {
    getMinute,
    async artifactTranscript(userAccessToken, minuteToken) {
      const data = await call(userAccessToken, `/minutes/v1/minutes/${encodeURIComponent(minuteToken)}/artifacts`);
      if (typeof data.transcript !== "string" || !data.transcript) throw new FeishuApiError(MINUTES_NOT_READY_CODE, "妙记产物里还没有逐字稿");
      return data.transcript;
    },
    async exportTranscript(userAccessToken, minuteToken) {
      const response = await fetchImpl(`${OPEN_API}/minutes/v1/minutes/${encodeURIComponent(minuteToken)}/transcript?need_speaker=true&need_timestamp=true&file_format=txt`, {
        headers: { authorization: `Bearer ${userAccessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      // 成功时是文件流；失败时是 JSON 错误体。
      if ((response.headers.get("content-type") ?? "").includes("application/json") || !response.ok) {
        let code = 0, msg = `HTTP ${response.status}`;
        try { const body = JSON.parse(text) as { code?: number; msg?: string }; code = Number(body.code ?? 0); msg = body.msg ?? msg; } catch { /* 非 JSON */ }
        // 2091003 一类：妙记还没转写完。
        throw new FeishuApiError(code, `导出妙记逐字稿失败：${msg}`, response.status);
      }
      return text;
    },
    async listMinutes(userAccessToken, owner, range, skip) {
      const tokens: string[] = [];
      let pageToken: string | undefined;
      // 一场会前后几小时的窗口，本人名下通常就几份；最多翻 3 页。
      for (let page = 0; page < 3; page += 1) {
        const data = await call(userAccessToken, `/minutes/v1/minutes/search?page_size=30&user_id_type=open_id${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`, {
          method: "POST",
          body: JSON.stringify({ filter: { owner_ids: [owner.openId], create_time: { start_time: range.start.toISOString(), end_time: range.end.toISOString() } } }),
        });
        for (const item of (data.items ?? []) as Record<string, unknown>[]) if (str(item.token) && !skip?.has(item.token as string)) tokens.push(item.token as string);
        pageToken = data.has_more === true ? str(data.page_token) ?? undefined : undefined;
        if (!pageToken) break;
      }
      return Promise.all(tokens.map((token) => getMinute(userAccessToken, token)));
    },
    async meetingParticipants(userAccessToken, meetingId) {
      const data = await call(userAccessToken, `/vc/v1/meetings/${encodeURIComponent(meetingId)}?with_participants=true&user_id_type=open_id`);
      const participants = ((data.meeting as { participants?: unknown } | undefined)?.participants ?? []) as Record<string, unknown>[];
      // 待联调：参会人 id 字段（open_id 时为 id）；外部访客没有 open_id，换算时自然丢掉。
      return [...new Set(participants.map((item) => str(item.id) ?? str(item.user_id) ?? str(item.open_id)).filter((id): id is string => Boolean(id)))];
    },
  };
}

/** 本人当前可用的 user_access_token：授权有效且还没到期；否则 null（调用方退回手动上传）。 */
export async function activeUserAccessToken(q: Query, env: Pick<FeishuEnv, "tokenKey" | "tokenKeyVersion">, personId: string, now: Date): Promise<string | null> {
  const row = (await q(
    "SELECT key_version, ciphertext, access_expires_at, status FROM feishu_user_tokens WHERE person_id = $1",
    [personId],
  )).rows[0] as { key_version: number; ciphertext: string; access_expires_at: Date; status: string } | undefined;
  if (!row || row.status !== "active" || row.key_version !== env.tokenKeyVersion || row.access_expires_at.getTime() <= now.getTime()) return null;
  try {
    return decryptTokenSecret(env.tokenKey, personId, row.ciphertext).accessToken;
  } catch {
    return null;
  }
}
