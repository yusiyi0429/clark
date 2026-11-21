import { ContinueMeetingWork, MeetingWorkHandoffParams, MeetingWorkHandoffs, MeetingWorkResult, MeetingWorkTargetList } from "@warmap/contracts";
import { continueMeetingWork, listMeetingWorkHandoffs, meetingWorkTargets } from "../meetingWorkHandoffs.js";
import { CardError, planTaskOpener } from "../taskCards.js";
import type { Query } from "../meetingStore.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

export function registerMeetingWorkHandoffRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, pool, now, fail } = ctx;
  const open = (query: Query) => planTaskOpener(query, ctx.planTasks, ctx.peopleDirectory, now);
  const member: Guard = async (req, reply) => {
    await ctx.requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person!.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };
  app.get("/api/me/meeting-work-handoffs", { preHandler: member, schema: { response: { 200: MeetingWorkHandoffs } } },
    async req => listMeetingWorkHandoffs(q, req.person!.personId));
  app.get("/api/me/meeting-work-handoff-targets", { preHandler: member, schema: { response: { 200: MeetingWorkTargetList } } },
    async req => ({ targets: await meetingWorkTargets(q, req.person!.personId, open(q)) }));
  app.post("/api/me/meeting-work-handoffs/:confirmationRef", { preHandler: member, schema: { params: MeetingWorkHandoffParams, body: ContinueMeetingWork, response: { 200: MeetingWorkResult } } },
    async (req, reply) => {
      try { return { receipts: await continueMeetingWork({ pool, open, now }, req.person!.personId, req.params.confirmationRef, req.body) }; }
      catch (e) { if (e instanceof CardError) { fail(reply, e.status, e.code, e.message); return; } throw e; }
    });
}
