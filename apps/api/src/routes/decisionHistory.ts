import type { FastifyReply } from "fastify";
import type { TIssueDecisionHistory, TMeetingDecisionHistoryResponse } from "@warmap/contracts";
import { issueDecisionHistory, meetingDecisionHistory, type DecisionHistoryOptions } from "../issueDecisionHistory.js";
import type { MaterialViewer } from "../objectMaterials.js";
import { personDisplayNames } from "../people.js";
import { idParams, type AppInstance, type RouteContext } from "./shared.js";

/**
 * 议题有效历史的只读接口（H05）：仍有效的历史决定 / 此后实际发生的变化 / 本次待判断，以及已失效决定。
 * 只读、无副作用；CEO 视角，群讨论与材料按原生成员与材料权限过滤。
 */
export function registerDecisionHistoryRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, fail, requireCEO, companyMemory } = ctx;
  const context = (personId: string): { viewer: MaterialViewer; options: DecisionHistoryOptions } => {
    const names = personDisplayNames(companyMemory);
    const ceo = companyMemory.searchPeople(undefined).find((person) => person.roles.includes("ceo"));
    return {
      viewer: { personId, role: "ceo", displayName: names.get(personId) ?? personId },
      options: { names, ceo: ceo ? { personId: ceo.personId, displayName: ceo.displayName } : null },
    };
  };

  app.get(
    "/api/issues/:id/history",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<TIssueDecisionHistory | FastifyReply> => {
      const { viewer, options } = context(req.person!.personId);
      const history = await issueDecisionHistory(q, req.params.id, viewer, options);
      return history ?? fail(reply, 404, "ISSUE_NOT_FOUND", "Issue 不存在");
    },
  );

  app.get(
    "/api/meetings/:id/history",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<TMeetingDecisionHistoryResponse | FastifyReply> => {
      const { viewer, options } = context(req.person!.personId);
      const history = await meetingDecisionHistory(q, req.params.id, viewer, options);
      return history ?? fail(reply, 404, "MEETING_NOT_FOUND", "Meeting 不存在");
    },
  );
}
