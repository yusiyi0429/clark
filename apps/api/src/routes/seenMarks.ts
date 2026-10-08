import { Type } from "@sinclair/typebox";
import { SeenMarkKey, SeenMarksResponse } from "@warmap/contracts";
import { clearSeenMark, listSeenMarks, markSeen } from "../seenMarks.js";
import type { AppInstance, RouteContext } from "./shared.js";

const keyParams = Type.Object({ key: SeenMarkKey }, { additionalProperties: false });

export function registerSeenMarkRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, now, requirePerson } = ctx;
  app.get(
    "/api/me/seen-marks",
    { preHandler: requirePerson, schema: { response: { 200: SeenMarksResponse } } },
    async (req) => ({ keys: await listSeenMarks(q, req.person!.personId) }),
  );
  app.post(
    "/api/me/seen-marks/:key",
    { preHandler: requirePerson, schema: { params: keyParams, response: { 200: SeenMarksResponse } } },
    async (req) => {
      const { personId } = req.person!;
      await markSeen(q, personId, req.params.key, now());
      return { keys: await listSeenMarks(q, personId) };
    },
  );
  app.delete(
    "/api/me/seen-marks/:key",
    { preHandler: requirePerson, schema: { params: keyParams } },
    async (req, reply) => {
      await clearSeenMark(q, req.person!.personId, req.params.key);
      return reply.code(204).send();
    },
  );
}
