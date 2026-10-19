import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  CollectionResponse, CollectionSaveInput, CollectionSendInput, DraftCollectionRequest, DraftCollectionResponse, ExecuteCollectionActionRequest,
  ScheduleListResponse, type TRequestPerson,
} from "@warmap/contracts";
import { verifyActionId } from "../actionToken.js";
import { draftCollection, executeCollectionAction, listSchedules, readCollection, readCollectionRound, syncCollection, type CollectionError } from "../collections.js";
import { canUseMemberView } from "../memberAccess.js";
import { isRealPerson, personDisplayNames } from "../people.js";
import type { AppInstance, RouteContext } from "./shared.js";

const NoInput = Type.Object({}, { additionalProperties: false });
const ACTION_INPUTS = { "collection.send": CollectionSendInput, "collection.save": CollectionSaveInput, "collection.confirm": NoInput, "collection.stop": NoInput } as const;
const OBJECT_TYPES = new Set(["collection", "collection-round"]);

/** ③ 信息收集：CEO 和成员都能发起、接收；看得到的范围在 collections.ts 里按发起人与这一轮的接收人判断。 */
export function registerCollectionRoutes(app: AppInstance, ctx: RouteContext): void {
  const secret = ctx.env.sessionSecret;
  const { agent, deps } = ctx.collections;
  const people = (): TRequestPerson[] => ctx.peopleDirectory.searchPeople(undefined).filter(isRealPerson)
    .map((person) => ({ personId: person.personId, displayName: person.displayName }));
  const viewDeps = (viewerId: string) => ({ viewerId, names: personDisplayNames(ctx.peopleDirectory), people: people(), secret });
  const failed = (reply: Parameters<RouteContext["fail"]>[0], result: CollectionError) => ctx.fail(reply, result.error.status, result.error.code, result.error.message);
  const notFound = (reply: Parameters<RouteContext["fail"]>[0]) => ctx.fail(reply, 404, "COLLECTION_NOT_FOUND", "收集任务不存在或不可见");

  app.post("/api/collections/draft", { preHandler: ctx.requirePerson, schema: { body: DraftCollectionRequest, response: { 200: DraftCollectionResponse } } }, async (req, reply) => {
    const result = await draftCollection(ctx.pool, agent, req.body, { ...viewDeps(req.person!.personId), now: ctx.now() });
    if ("error" in result) return failed(reply, result);
    return { collection: result.collection, steps: result.steps };
  });

  app.get("/api/collections/:id", { preHandler: ctx.requirePerson, schema: { params: Type.Object({ id: Type.String() }), response: { 200: CollectionResponse } } }, async (req, reply) => {
    const collection = await readCollection(ctx.q, req.params.id, viewDeps(req.person!.personId));
    return collection ? { collection } : notFound(reply);
  });

  app.get("/api/requests/:id/collection", { preHandler: ctx.requirePerson, schema: { params: Type.Object({ id: Type.String() }), response: { 200: CollectionResponse } } }, async (req, reply) => {
    const collection = await readCollectionRound(ctx.q, req.params.id, viewDeps(req.person!.personId));
    return collection ? { collection } : notFound(reply);
  });

  app.post("/api/collections/actions/execute", { preHandler: ctx.requirePerson, schema: { body: ExecuteCollectionActionRequest, response: { 200: CollectionResponse } } }, async (req, reply) => {
    const scope = verifyActionId(secret, req.body.actionId);
    if (!scope || !OBJECT_TYPES.has(scope.objectType) || !(scope.actionType in ACTION_INPUTS)) return ctx.fail(reply, 404, "UNKNOWN_ACTION", "无效 actionId");
    const input = req.body.input ?? {};
    const schema = ACTION_INPUTS[scope.actionType as keyof typeof ACTION_INPUTS];
    if (!Value.Check(schema, input)) return ctx.invalidInput(reply, schema, input);
    ctx.requestContext.set(req, { actionType: scope.actionType, objectRef: `${scope.objectType}:${scope.objectId}` });
    const viewerId = req.person!.personId;
    const result = await executeCollectionAction(deps, viewerId, scope, input, new Set(people().map((person) => person.personId)));
    if ("error" in result) return failed(reply, result);
    // 改动当场推到飞书表格（失败只记 sync_error，后台每分钟再试），不让人等下一轮。
    if (scope.actionType !== "collection.stop") await syncCollection(deps, result.collectionId);
    const view = scope.actionType !== "collection.stop" && result.requestId
      ? await readCollectionRound(ctx.q, result.requestId, viewDeps(viewerId))
      : await readCollection(ctx.q, result.collectionId, viewDeps(viewerId));
    return view ? { collection: view } : notFound(reply);
  });

  app.get("/api/me/schedules", { preHandler: ctx.requirePerson, schema: { response: { 200: ScheduleListResponse } } }, async (req) => {
    const person = ctx.peopleDirectory.searchPeople(undefined).find((item) => item.personId === req.person!.personId);
    return { items: await listSchedules(ctx.q, { personId: req.person!.personId, isCeo: req.person!.role === "ceo", weeklyReviews: person ? canUseMemberView(person) : false },
      secret, ctx.now()) };
  });
}
