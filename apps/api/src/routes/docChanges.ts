import { Type } from "@sinclair/typebox";
import { ConfirmDocChangeRequest, DocChangeResponse, DocOwnerAnswerRequest, ImpactBasisChoiceRequest, ImpactCardResponse } from "@warmap/contracts";
import type { DocChangeService } from "../docChanges.js";
import type { AppInstance, RouteContext } from "./shared.js";

const idParams = Type.Object({ id: Type.String() });
const NOT_FOUND = ["DOC_CHANGE_NOT_FOUND", "文档变更不存在或不可见"] as const;

/** ⑧ 文档变更：作者确认修订 / 取代哪份、改问负责人、负责人回答；依据旧版的人在影响卡上选切换或继续用旧版。 */
export function registerDocChangeRoutes(app: AppInstance, ctx: RouteContext, docChanges: DocChangeService): void {
  app.get("/api/requests/:id/doc-change", { preHandler: ctx.requirePerson, schema: { params: idParams, response: { 200: DocChangeResponse } } }, async (req, reply) => {
    const docChange = await docChanges.viewByRequest(req.params.id, req.person!.personId);
    return docChange ? { docChange } : ctx.fail(reply, 404, ...NOT_FOUND);
  });

  app.post("/api/doc-changes/:id/confirm", { preHandler: ctx.requirePerson, schema: { params: idParams, body: ConfirmDocChangeRequest, response: { 200: DocChangeResponse } } }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "doc_change.confirm", objectRef: `doc_change:${req.params.id}` });
    const result = await docChanges.confirm(req.params.id, req.person!.personId, req.body);
    if (!result) return ctx.fail(reply, 404, ...NOT_FOUND);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : { docChange: result };
  });

  app.post("/api/doc-changes/:id/ask-owners", { preHandler: ctx.requirePerson, schema: { params: idParams, response: { 200: DocChangeResponse } } }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "doc_change.ask_owners", objectRef: `doc_change:${req.params.id}` });
    const result = await docChanges.askOwners(req.params.id, req.person!.personId);
    if (!result) return ctx.fail(reply, 404, ...NOT_FOUND);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : { docChange: result };
  });

  app.post("/api/doc-changes/:id/owner-answer", { preHandler: ctx.requirePerson, schema: { params: idParams, body: DocOwnerAnswerRequest, response: { 200: DocChangeResponse } } }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "doc_change.owner_answer", objectRef: `doc_change:${req.params.id}` });
    const result = await docChanges.ownerAnswer(req.params.id, req.person!.personId, req.body);
    if (!result) return ctx.fail(reply, 404, ...NOT_FOUND);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : { docChange: result };
  });

  app.post("/api/impact-cards/:id/basis", { preHandler: ctx.requirePerson, schema: { params: idParams, body: ImpactBasisChoiceRequest, response: { 200: ImpactCardResponse } } }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "impact_card.basis", objectRef: `impact_card:${req.params.id}` });
    const result = await docChanges.chooseBasis(req.params.id, req.person!.personId, req.body);
    if (!result) return ctx.fail(reply, 404, "IMPACT_CARD_NOT_FOUND", "影响卡不存在或不可见");
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : { card: result };
  });
}
