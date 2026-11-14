import { Type } from "@sinclair/typebox";
import { PartnerMeetingRecordResponse, PartnerMeetingsResponse } from "@warmap/contracts";
import { listPartnerMeetings, readPartnerMeetingRecord, readPartnerMinute } from "../partnerMeetings.js";
import { idParams, type AppInstance, type RouteContext } from "./shared.js";

export function registerPartnerMeetingRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, requirePerson, fail } = ctx;
  const { minutes, calendarFeed } = app.meetingFollowThrough;
  app.get("/api/me/partner-meetings", { preHandler: requirePerson, schema: { response: { 200: PartnerMeetingsResponse } } },
    async (req) => ({ items: await listPartnerMeetings(q, minutes, calendarFeed, req.person!, ctx.now()) }));
  app.get("/api/me/partner-meetings/minutes/:token", { preHandler: requirePerson, schema: {
    params: Type.Object({ token: Type.String({ minLength: 1, maxLength: 200 }) }), response: { 200: PartnerMeetingRecordResponse },
  } }, async (req,reply) => {
    const result = await readPartnerMinute(q,minutes,req.person!,req.params.token);
    return "error" in result ? fail(reply,result.error.status,result.error.code,result.error.message) : result;
  });
  app.get("/api/me/partner-meetings/:id/record", { preHandler: requirePerson, schema: {
    params: idParams, querystring: Type.Object({ source: Type.Optional(Type.Union([Type.Literal("feishu"), Type.Literal("tianshu")])), recordingId: Type.Optional(Type.String({maxLength:36})) }),
    response: { 200: PartnerMeetingRecordResponse },
  } }, async (req,reply) => {
    const result = await readPartnerMeetingRecord(q,minutes,req.person!,req.params.id,req.query.source,req.query.recordingId);
    return "error" in result ? fail(reply,result.error.status,result.error.code,result.error.message) : result;
  });
}
