import type { Pool } from "pg";
import { agentModel, type AgentModelEnv } from "./agentModels.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import type { FeishuEnv } from "./feishu/config.js";
import { type FeishuEventHandlers } from "./feishu/events.js";
import { createFeishuCalendarApi, type FeishuCalendarApi } from "./feishu/calendar.js";
import { createFeishuMinutesApi, type FeishuMinutesApi } from "./feishu/minutes.js";
import { createImpactAgent, type ImpactAgent } from "./impactAgent.js";
import type { JobHandler, RecurringJob } from "./jobs.js";
import { meetingInterpretationContext, type InterpretationContext } from "./meetingContext.js";
import { createMeetingDecisionService, type MeetingDecisionService } from "./meetingDecisions.js";
import { createMeetingCardService, registerMeetingCardDeps, type MeetingCardService } from "./meetingCard.js";
import { createMeetingCardConfirmService, meetingCardConfirmJobs, type MeetingCardConfirmService } from "./meetingCardConfirm.js";
import { createMeetingFeishuEventService, meetingFeishuEventJobs, type MeetingFeishuEventService } from "./meetingFeishuEvent.js";
import { createMeetingObjectSync } from "./meetingObjectSync.js";
import { createMeetingMinutesService, FEISHU_MINUTES_EVENT, meetingMinutesJobs, type MeetingMinutesService } from "./meetingMinutes.js";
import { createFeishuCalendarFeedService, type FeishuCalendarFeedService } from "./feishuCalendarFeed.js";
import { createFeishuMinuteInboxService, feishuMinuteInboxJobs, type FeishuMinuteInboxService } from "./feishuMinuteInbox.js";
import { setOutcomeContextProvider, type PostMeetingAgent } from "./outcome.js";
import { personDisplayNames } from "./people.js";
import { WorldClient, worldConfigured, type WorldEnv } from "./worldClient.js";
import { createMeetingEventWorld } from "./worldMeetingEvent.js";
import { WORLD_READ_TIMEOUT_MS, type WorldReader } from "./worldReader.js";

/**
 * 会后链路的装配（G 会议链路 + 会议卡）：
 * - 解读纪要时对照的公司地图（按池注册给会后整理）；
 * - 会后只有会议卡一个入口：决策和行动项逐条交责任人确认（meetingCard.ts），凑齐或 48 小时后冻结、写会议事件；不再逐条分层、提醒代判或推影响卡；
 * - 后台任务（server.ts 的 jobs worker 注册）：妙记轮询与「妙记生成」事件、整卡确认后写会议事件（meeting.world_sync）、在飞书约会（meeting.feishu_event）、
 *   飞书里直接开的会待整理的扫描（「妙记生成」事件先照原样对天枢的会，再排一次扫描）。
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
  /** FEISHU_WEB_ORIGIN（如 https://tokenking.feishu.cn）：逐字稿来源地址拼妙记链接 <origin>/minutes/<minute_token>；不配时用天枢会议页。 */
  feishuWebOrigin?: string;
  /** MEETING_WORLD_RECORD_TEXT：记录正文能不能写进本体（缺省不能）。 */
  meetingRecordText?: boolean;
  /** MEETING_WORLD_WRITES_OFF：只关会议写本体（会后链切到 Nexus 以后设 1；缺省不关）。 */
  meetingWorldWritesOff?: boolean;
};

export type MeetingFollowThrough = {
  decisions: MeetingDecisionService;
  cards: MeetingCardService;
  /** 整卡确认、重试、写会议事件。 */
  cardConfirm: MeetingCardConfirmService;
  minutes: MeetingMinutesService;
  /** 飞书里直接开的会待整理（只给妙记所有者本人）。 */
  minuteInbox: FeishuMinuteInboxService;
  /** 建会后在飞书约上、改时间、取消。 */
  feishuEvents: MeetingFeishuEventService;
  /** 本人飞书日历里的日程，只读显示在「会议安排」里。 */
  calendarFeed: FeishuCalendarFeedService;
  /** 已推影响卡（旧会议、文档变更）上的追问。 */
  impact: ImpactAgent;
  context: () => Promise<InterpretationContext>;
  jobs(): { handlers: Record<string, JobHandler>; recurring: RecurringJob[]; feishuEvents: FeishuEventHandlers };
};

export function createMeetingFollowThrough({ pool, env, peopleDirectory, world, outcomeAgent, impact, minutesApi, calendarApi, now = () => new Date() }: {
  pool: Pool;
  env: MeetingFollowThroughEnv;
  peopleDirectory: PeopleDirectory;
  world: WorldReader;
  outcomeAgent: PostMeetingAgent;
  /** 测试注入假实现；缺省用 heavy 模型（OUTCOME_MODEL / OUTCOME_THINKING 同一套配置）。 */
  impact?: ImpactAgent;
  minutesApi?: FeishuMinutesApi;
  calendarApi?: FeishuCalendarApi;
  now?: () => Date;
}): MeetingFollowThrough {
  const q = pool.query.bind(pool);
  const model = agentModel(env.agentModels, "outcome", { modelId: env.heavyModel });
  const agentOptions = { query: q, baseUrl: env.piBaseUrl, apiKey: env.piApiKey, ...model };
  const impactAgent = impact ?? createImpactAgent({ ...agentOptions, answerModelId: env.triageModel || env.lightModel });
  const context = async () => meetingInterpretationContext(q, now(), personDisplayNames(peopleDirectory),
    world.enabled ? await world.snapshot(2_000).catch(() => null) : null);
  setOutcomeContextProvider(pool, () => context());
  // 本体可写时：整卡确认后一场会写一条会议事件。
  const worldClient = worldConfigured(env) && world.status().writes ? new WorldClient(q, env) : undefined;
  // 只关会议写本体（MEETING_WORLD_WRITES_OFF，会后链切到 Nexus 以后）：会议事件和对象修改都不装，读挂点照旧；周复盘、周期目标等别的写入不受影响。
  const writesOff = Boolean(env.meetingWorldWritesOff);
  const meetingWorld = worldClient && !writesOff ? createMeetingEventWorld({ client: worldClient }) : undefined;
  // 挂点选项里的 LTO、本月 PO：同一条件下只列对象，用读的超时（预约表单在等）。
  const anchorWorld = worldClient ? new WorldClient(q, env, undefined, { timeoutMs: WORLD_READ_TIMEOUT_MS }) : undefined;
  // 会议卡草稿：生成（会后整理按池取）和读写共用同一套依赖；挂点对象、修改目标读本体（同一条件下用读的超时）。
  const recordText = Boolean(env.meetingRecordText);
  const cardDeps = { world: anchorWorld, publicOrigin: env.publicOrigin, names: () => personDisplayNames(peopleDirectory), people: () => peopleDirectory.searchPeople(undefined), recordText, writesOff };
  registerMeetingCardDeps(pool, cardDeps);
  const cards = createMeetingCardService(pool, cardDeps);
  const objectSync = worldClient && !writesOff ? createMeetingObjectSync({ q, world: worldClient, refreshDraft: cards.refreshDraft }) : undefined;
  const cardConfirm = createMeetingCardConfirmService({ pool, world: anchorWorld, meetingWorld, objectSync, names: cardDeps.names, view: cards.view, recordText, writesOff, now });
  const decisions = createMeetingDecisionService({ pool, peopleDirectory, anchorWorld, onAnchorsChanged: cards.anchorsChanged });
  const feishuMinutes = env.feishu ? { feishu: { env: env.feishu, api: minutesApi ?? createFeishuMinutesApi() } } : {};
  const minutes = createMeetingMinutesService({ pool, peopleDirectory, outcomeAgent, secret: env.sessionSecret, now, feishuWebOrigin: env.feishuWebOrigin, ...feishuMinutes });
  const minuteInbox = createFeishuMinuteInboxService({ pool, peopleDirectory, minutes, anchorChoicesFor: decisions.anchorChoicesFor, now, ...feishuMinutes });
  const feishuCalendar = env.feishu ? { feishu: { env: env.feishu, api: calendarApi ?? createFeishuCalendarApi() } } : {};
  const feishuEvents = createMeetingFeishuEventService({ pool, now, ...feishuCalendar });
  const calendarFeed = createFeishuCalendarFeedService({ pool, now, ...feishuCalendar });
  return {
    decisions, cards, cardConfirm, minutes, minuteInbox, feishuEvents, calendarFeed, impact: impactAgent, context,
    jobs() {
      const minuteJobs = meetingMinutesJobs(minutes);
      const inboxJobs = feishuMinuteInboxJobs(minuteInbox);
      const onMinuteGenerated = minuteJobs.events[FEISHU_MINUTES_EVENT];
      return {
        handlers: { ...minuteJobs.handlers, ...inboxJobs.handlers, ...meetingCardConfirmJobs(cardConfirm), ...meetingFeishuEventJobs(feishuEvents) },
        recurring: [...minuteJobs.recurring, ...inboxJobs.recurring],
        feishuEvents: { ...minuteJobs.events, [FEISHU_MINUTES_EVENT]: async (payload) => { await onMinuteGenerated(payload); await minuteInbox.afterMinuteEvent(payload); } },
      };
    },
  };
}
