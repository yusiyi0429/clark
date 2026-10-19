import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  DraftRequestAnswerResponse, DraftRequestRequest, DraftRequestResponse, ExecuteRequestActionRequest, PrepareRequestQuestionRequest,
  PrepareRequestQuestionResponse, RequestAnswerInput, RequestAskInput, RequestListQuery, RequestListResponse, RequestResponse, RequestSendInput,
  type TRequestPerson,
} from "@warmap/contracts";
import { actionFingerprint, verifyActionId } from "../actionToken.js";
import { draftAnswer, draftRequest, executeRequestAction, listRequests, prepareQuestion, readRequest, type RequestError } from "../delivery/requests.js";
import type { RequestAgent } from "../delivery/requestAgent.js";
import { isRealPerson, personDisplayNames } from "../people.js";
import type { AppInstance, RouteContext } from "./shared.js";

const NoInput = Type.Object({}, { additionalProperties: false });
const ACTION_INPUTS = { "request.send": RequestSendInput, "request.ask": RequestAskInput, "request.answer": RequestAnswerInput, "request.mark_done": NoInput } as const;

/** 送达通道（⑨ 传话）：CEO 和成员都能发起、接收；看得到的范围在 delivery/requests.ts 里按发起人与接收人判断。 */
export function registerRequestRoutes(app: AppInstance, ctx: RouteContext, agent: RequestAgent): void {
  const secret = ctx.env.sessionSecret;
  const names = () => personDisplayNames(ctx.peopleDirectory);
  const people = (): TRequestPerson[] => ctx.peopleDirectory.searchPeople(undefined).filter(isRealPerson)
    .map((person) => ({ personId: person.personId, displayName: person.displayName }));
  const failed = (reply: Parameters<RouteContext["fail"]>[0], result: RequestError) => ctx.fail(reply, result.error.status, result.error.code, result.error.message);

  app.post("/api/requests/draft", { preHandler: ctx.requirePerson, schema: { body: DraftRequestRequest, response: { 200: DraftRequestResponse } } }, async (req, reply) => {
    const result = await draftRequest(ctx.pool, agent, req.body, req.person!.personId, names(), people(), secret);
    return "error" in result ? failed(reply, result) : result;
  });

  app.get("/api/me/requests", { preHandler: ctx.requirePerson, schema: { querystring: RequestListQuery, response: { 200: RequestListResponse } } },
    async (req) => ({ items: await listRequests(ctx.q, req.person!.personId, req.query.box, names()) }));

  app.get("/api/requests/:id", { preHandler: ctx.requirePerson, schema: { params: Type.Object({ id: Type.String() }), response: { 200: RequestResponse } } }, async (req, reply) => {
    const request = await readRequest(ctx.q, req.params.id, req.person!.personId, names(), people(), secret);
    return request ? { request } : ctx.fail(reply, 404, "REQUEST_NOT_FOUND", "请求不存在或不可见");
  });

  app.post("/api/requests/:id/questions/prepare", {
    preHandler: ctx.requirePerson, schema: { params: Type.Object({ id: Type.String() }), body: PrepareRequestQuestionRequest, response: { 200: PrepareRequestQuestionResponse } },
  }, async (req, reply) => {
    const result = await prepareQuestion(ctx.q, agent, req.params.id, req.person!.personId, req.body.question.trim(), names());
    return "error" in result ? failed(reply, result) : result;
  });

  app.post("/api/requests/:id/questions/:questionId/answer-draft", {
    preHandler: ctx.requirePerson, schema: { params: Type.Object({ id: Type.String(), questionId: Type.String() }), response: { 200: DraftRequestAnswerResponse } },
  }, async (req, reply) => {
    const result = await draftAnswer(ctx.q, agent, req.params.id, req.params.questionId, req.person!.personId, names());
    return "error" in result ? failed(reply, result) : result;
  });

  app.post("/api/requests/actions/execute", { preHandler: ctx.requirePerson, schema: { body: ExecuteRequestActionRequest, response: { 200: RequestResponse } } }, async (req, reply) => {
    const scope = verifyActionId(secret, req.body.actionId);
    if (!scope || scope.objectType !== "request" || !(scope.actionType in ACTION_INPUTS)) return ctx.fail(reply, 404, "UNKNOWN_ACTION", "无效 actionId");
    const input = req.body.input ?? {};
    const schema = ACTION_INPUTS[scope.actionType as keyof typeof ACTION_INPUTS];
    if (!Value.Check(schema, input)) return ctx.invalidInput(reply, schema, input);
    ctx.requestContext.set(req, { actionType: scope.actionType, objectRef: `request:${scope.objectId}` });
    const viewerId = req.person!.personId;
    const result = await executeRequestAction(ctx.pool, viewerId, scope, input, actionFingerprint(secret, req.body.actionId, input),
      new Set(people().map((person) => person.personId)));
    if ("error" in result) return failed(reply, result);
    return { request: (await readRequest(ctx.q, scope.objectId, viewerId, names(), people(), secret))! };
  });
}
