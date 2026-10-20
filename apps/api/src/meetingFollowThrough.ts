import type { Pool } from "pg";
import { agentModel, type AgentModelEnv } from "./agentModels.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import type { FeishuEnv } from "./feishu/config.js";
import { type FeishuEventHandlers } from "./feishu/events.js";
import { createFeishuMinutesApi, type FeishuMinutesApi } from "./feishu/minutes.js";
import { feishuNotifier } from "./feishu/notify.js";
import { createImpactAgent, type ImpactAgent } from "./impactAgent.js";
import type { JobHandler, RecurringJob } from "./jobs.js";
import { meetingInterpretationContext, type InterpretationContext } from "./meetingContext.js";
import { createDecisionLayeringAgent, type DecisionLayeringAgent } from "./meetingDecisionAgent.js";
import { createMeetingDecisionService, enqueueDecisionSync, meetingDecisionJobs, type MeetingDecisionService } from "./meetingDecisions.js";
import { createMeetingMinutesService, meetingMinutesJobs, type MeetingMinutesService } from "./meetingMinutes.js";
import { onOutcomeReviewed, setOutcomeContextProvider, type PostMeetingAgent } from "./outcome.js";
import { personDisplayNames } from "./people.js";
import { WorldClient, worldConfigured, type WorldEnv } from "./worldClient.js";
import { createMeetingEventWorld } from "./worldMeetingEvent.js";
import { WORLD_READ_TIMEOUT_MS, type WorldReader } from "./worldReader.js";

/**
 * 会后链路的装配（G 会议链路 + 分层确认 + H 影响卡）：
 * - 解读纪要时对照的公司地图（按池注册给会后抽取）；
 * - 纪要整理好、会议条目有人处理过 → 排 meeting.decisions_sync；
 * - 后台任务（server.ts 的 jobs worker 注册）：妙记轮询与「妙记生成」事件、分层同步、提醒与代判、往下推影响卡、整卡确认后写会议事件。
 */
export type MeetingFollowThroughEnv = WorldEnv & {
  publicOrigin: string;
  sessionSecret: string;
  piBaseUrl: string;
  piApiKey: string;
  heavyModel: string;
  lightModel: string;
  triageModel?: string;
  agentModels?: AgentModelEnv;
  feishu?: FeishuEnv;
  /** IMPACT_CARD_MODE：live（缺省，置信度低的卡仍只记影子）或 shadow（全部只记影子，不推送）。 */
  impactCardMode?: "live" | "shadow";
  /** FEISHU_WEB_ORIGIN（如 https://tokenking.feishu.cn）：会议事件的 artifacts、逐字稿来源地址拼妙记链接 <origin>/minutes/<minute_token>；不配时不带链接。 */
  feishuWebOrigin?: string;
};

export type MeetingFollowThrough = {
  decisions: MeetingDecisionService;
  minutes: MeetingMinutesService;
  impact: ImpactAgent;
  context: () => Promise<InterpretationContext>;
  jobs(): { handlers: Record<string, JobHandler>; recurring: RecurringJob[]; feishuEvents: FeishuEventHandlers };
  close(): void;
};

export function createMeetingFollowThrough({ pool, env, peopleDirectory, world, outcomeAgent, layering, impact, minutesApi, now = () => new Date() }: {
  pool: Pool;
  env: MeetingFollowThroughEnv;
  peopleDirectory: PeopleDirectory;
  world: WorldReader;
  outcomeAgent: PostMeetingAgent;
  /** 测试注入假实现；缺省用 heavy 模型（OUTCOME_MODEL / OUTCOME_THINKING 同一套配置）。 */
  layering?: DecisionLayeringAgent;
  impact?: ImpactAgent;
  minutesApi?: FeishuMinutesApi;
  now?: () => Date;
}): MeetingFollowThrough {
  const q = pool.query.bind(pool);
  const model = agentModel(env.agentModels, "outcome", { modelId: env.heavyModel });
  const agentOptions = { query: q, baseUrl: env.piBaseUrl, apiKey: env.piApiKey, ...model };
  const layeringAgent = layering ?? createDecisionLayeringAgent(agentOptions);
  const impactAgent = impact ?? createImpactAgent({ ...agentOptions, answerModelId: env.triageModel || env.lightModel });
  const context = async () => meetingInterpretationContext(q, now(), personDisplayNames(peopleDirectory),
    world.enabled ? await world.snapshot(2_000).catch(() => null) : null);
  setOutcomeContextProvider(pool, () => context());
  const notify = env.feishu ? feishuNotifier(q) : undefined;
  // 本体可写时：整卡确认后一场会写一条会议事件。
  const worldClient = worldConfigured(env) && world.status().writes ? new WorldClient(q, env) : undefined;
  const meetingWorld = worldClient ? createMeetingEventWorld({ q, client: worldClient, feishuWebOrigin: env.feishuWebOrigin }) : undefined;
  // 挂点选项里的 LTO、本月 PO：同一条件下只列对象，用读的超时（预约表单在等）。
  const anchorWorld = worldClient ? new WorldClient(q, env, undefined, { timeoutMs: WORLD_READ_TIMEOUT_MS }) : undefined;
  const decisions = createMeetingDecisionService({ pool, peopleDirectory, layering: layeringAgent, impact: impactAgent, context, notify,
    meetingWorld, anchorWorld, impactMode: env.impactCardMode ?? "live", now });
  const minutes = createMeetingMinutesService({ pool, peopleDirectory, outcomeAgent, secret: env.sessionSecret, now, feishuWebOrigin: env.feishuWebOrigin,
    ...(env.feishu ? { feishu: { env: env.feishu, api: minutesApi ?? createFeishuMinutesApi() } } : {}) });
  const unsubscribe = onOutcomeReviewed(pool, (meetingId) => {
    enqueueDecisionSync(q, meetingId).catch((error) => console.warn(`meeting decisions sync enqueue failed: ${(error as Error).message}`));
  });
  return {
    decisions, minutes, impact: impactAgent, context,
    jobs() {
      const decisionJobs = meetingDecisionJobs(decisions);
      const minuteJobs = meetingMinutesJobs(minutes);
      return { handlers: { ...decisionJobs.handlers, ...minuteJobs.handlers }, recurring: [...decisionJobs.recurring, ...minuteJobs.recurring], feishuEvents: minuteJobs.events };
    },
    close: unsubscribe,
  };
}
