import {
  ListMyRadarSignalsQuery,
  MyRadar,
  MyRadarScanAccepted,
  PersonalSignal,
  PersonalSignalList,
  PutMyRadarRequest,
  SignalStateRequest,
} from "@warmap/contracts";
import { requestManualScan } from "../personalRadar.js";
import { getPersonalSignal, listPersonalSignals, setPersonalSignalState } from "../personalSignals.js";
import { readMyRadar, saveMyRadar } from "../radarSettings.js";
import { idParams, type AppInstance, type Guard, type RouteContext, type SessionPerson } from "./shared.js";

/** 个人雷达（ADR-0021）：只服务本人；CEO 的雷达就是公司雷达，走 /api/config/radar。 */
export function registerMyRadarRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, env, fail, requirePerson, companyMemory, personalRadar, now } = ctx;

  /** 仅成员：先过登录与写请求的 Origin，再挡 CEO。 */
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role === "ceo") return fail(reply, 403, "FORBIDDEN", "CEO 的雷达就是公司雷达，在「雷达设置」里修改");
  };

  const myRadar = (person: SessionPerson) => readMyRadar({
    q, people: companyMemory.searchPeople(undefined), secret: env.sessionSecret, person, now: now(), webSearch: personalRadar.providerStatus.webSearch,
  });

  app.get("/api/me/radar", { preHandler: requireMember, schema: { response: { 200: MyRadar } } }, async (req) => myRadar(req.person!));

  // 只写设置，不触发扫描（编辑器保存成功且开着时再调 /scan）
  app.put(
    "/api/me/radar",
    { preHandler: requireMember, schema: { body: PutMyRadarRequest, response: { 200: MyRadar } } },
    async (req, reply) => {
      const saved = await saveMyRadar(q, req.person!.personId, req.body, personalRadar.providerStatus.webSearch, now());
      if (!saved.ok) return fail(reply, 400, saved.code, saved.message, saved.fieldErrors ? { fieldErrors: saved.fieldErrors } : undefined);
      return myRadar(req.person!);
    },
  );

  app.get(
    "/api/me/radar/signals",
    { preHandler: requireMember, schema: { querystring: ListMyRadarSignalsQuery, response: { 200: PersonalSignalList } } },
    async (req) => ({ signals: await listPersonalSignals(q, req.person!.personId, req.query.limit ?? 50) }),
  );

  app.get(
    "/api/me/radar/signals/:id",
    { preHandler: requireMember, schema: { params: idParams, response: { 200: PersonalSignal } } },
    async (req, reply) => (await getPersonalSignal(q, req.person!.personId, req.params.id)) ?? fail(reply, 404, "SIGNAL_NOT_FOUND", "信号不存在"),
  );

  app.patch(
    "/api/me/radar/signals/:id/state",
    { preHandler: requireMember, schema: { params: idParams, body: SignalStateRequest, response: { 200: PersonalSignal } } },
    async (req, reply) => (await setPersonalSignalState(q, req.person!.personId, req.params.id, req.body)) ?? fail(reply, 404, "SIGNAL_NOT_FOUND", "信号不存在"),
  );

  app.post(
    "/api/me/radar/scan",
    { preHandler: requireMember, schema: { response: { 202: MyRadarScanAccepted } } },
    async (req, reply) => {
      const result = await requestManualScan(q, req.person!.personId, now());
      if ("rejected" in result) {
        const { status, code, message, retryAfterSeconds } = result.rejected;
        if (retryAfterSeconds) reply.header("retry-after", String(retryAfterSeconds));
        return fail(reply, status, code, message);
      }
      personalRadar.enqueue(req.person!.personId, "manual");
      return reply.status(202).send({ queued: true });
    },
  );
}
