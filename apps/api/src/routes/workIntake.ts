import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { CreateWorkIntake, PartnerWorkEvents, WorkIntakeChange, WorkIntakeEntry, WorkIntakeList, WorkIntakeScope } from "@warmap/contracts";
import { partnerWorkEvents } from "../taskFeed.js";
import { registerIntake, changeIntake, listIntake, wakeIntake } from "../workIntake.js";
import { CardError } from "../taskCards.js";
import type { AppInstance, RouteContext } from "./shared.js";

export function registerWorkIntakeRoutes(app: AppInstance, ctx: RouteContext) {
  const deps = { app, pool: ctx.pool, env: ctx.env };
  app.get("/api/me/partner-work-events",{preHandler:ctx.requirePerson,schema:{response:{200:PartnerWorkEvents}}},req=>partnerWorkEvents(ctx.q,req.person!.personId));
  const handle = async <T>(reply: FastifyReply, fn: () => Promise<T>) => {
    try { return await fn(); }
    catch (err) { if (err instanceof CardError) return ctx.fail(reply, err.status, err.code, err.message); throw err; }
  };
  app.get("/api/me/work-intake", { preHandler: ctx.requirePerson, schema: { querystring: Type.Object({ scope: WorkIntakeScope }), response: { 200: WorkIntakeList } } },
    (req,reply) => handle(reply, async () => ({ items: await listIntake(ctx.q, req.person!.personId, req.query.scope) })));
  app.post("/api/me/work-intake", { preHandler: ctx.requirePerson, schema: { body: CreateWorkIntake, response: { 200: WorkIntakeEntry } } },
    (req,reply) => handle(reply, async () => {
      const item = await registerIntake(ctx.q, req.person!.personId, req.body);
      if (item.state === "queued") wakeIntake(deps, req.person!.personId, item.scope);
      return item;
    }));
  app.patch("/api/me/work-intake/:id", { preHandler: ctx.requirePerson, schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }),
    body: WorkIntakeChange, response: { 200: WorkIntakeEntry } } }, (req,reply) => handle(reply, async () => {
      const item = await changeIntake(ctx.q, req.person!.personId, req.params.id, req.body.action);
      if (item.state === "queued") wakeIntake(deps, req.person!.personId, item.scope);
      return item;
    }));
}
