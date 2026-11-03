import type { FastifyReply } from "fastify";
import { CollectorStatusResponse } from "@warmap/contracts";
import { readCollectorStatus } from "../collector.js";
import type { AppInstance, RouteContext } from "./shared.js";

/**
 * 本机采集器已整体下线（新阶段 spec §5.1）：还装着旧脚本的机器再来上报、心跳，一律 410，不鉴权、不校验请求体、什么都不记。
 * 本人的采集器状态还留着：设置页据此判断要不要给卸载命令。
 */
export function registerCollectorRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, fail } = ctx;
  const retired = async (_req: unknown, reply: FastifyReply) =>
    fail(reply, 410, "COLLECTOR_RETIRED", "本机采集器已停用，请在天枢 设置 › 卸载本机采集器 里复制命令卸载");
  app.post("/api/collector/heartbeat", retired);
  app.post("/api/collector/reports", retired);

  app.get("/api/me/collector/status", { preHandler: ctx.requirePerson, schema: { response: { 200: CollectorStatusResponse } } },
    async (req) => readCollectorStatus(q, req.person!.personId));
}
