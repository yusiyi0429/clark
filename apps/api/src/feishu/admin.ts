import type { Query } from "../meetingStore.js";

export type FeishuAdminSummary = {
  /** 全部后台任务：failing＝失败过、正在等退避重试；dead＝第 5 次仍失败、不再自动重跑。 */
  jobs: { failing: number; dead: number };
  /** 用户令牌按状态计数；reauthReminders＝授权满 330 天、该提醒重新授权的 active 令牌。 */
  tokens: { active: number; reauthRequired: number; reauthReminders: number };
  /** 最近一次收到长连接事件的时间；没收到过为 null。 */
  lastEventAt: Date | null;
};

/** 管理员视图要的飞书与后台任务数据（页面后续再做）。 */
export async function feishuAdminSummary(q: Query): Promise<FeishuAdminSummary> {
  const [jobs, tokens, events] = await Promise.all([
    q(`SELECT count(*) FILTER (WHERE status = 'pending' AND last_error IS NOT NULL)::int AS failing,
              count(*) FILTER (WHERE status = 'dead')::int AS dead
       FROM jobs`),
    q(`SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status = 'reauth_required')::int AS reauth_required,
              count(*) FILTER (WHERE status = 'active' AND reauth_reminder_at IS NOT NULL)::int AS reminders
       FROM feishu_user_tokens`),
    q("SELECT max(received_at) AS last_event_at FROM feishu_events"),
  ]);
  return {
    jobs: { failing: jobs.rows[0].failing, dead: jobs.rows[0].dead },
    tokens: { active: tokens.rows[0].active, reauthRequired: tokens.rows[0].reauth_required, reauthReminders: tokens.rows[0].reminders },
    lastEventAt: events.rows[0].last_event_at ?? null,
  };
}
