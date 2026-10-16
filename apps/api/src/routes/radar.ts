import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { RadarScanResponse, SignalStateRequest, type TCardCollection } from "@warmap/contracts";
import { getSignalCard, getSignalImageSource, listSignalCards, projectRadarCard, setSignalState } from "../signals.js";
import { fetchProxiedImage } from "../signalCover.js";
import { idParams, type AppInstance, type RouteContext } from "./shared.js";

export function registerRadarRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, env, fail, requireCEO, radar } = ctx;

  const signalImageParams = Type.Object({
    id: Type.String({ minLength: 1 }),
    index: Type.String({ pattern: "^[0-9]+$" }),
  }, { additionalProperties: false });
  app.get("/api/cards/radar", { preHandler: requireCEO }, async (): Promise<TCardCollection> => ({
    cards: [await projectRadarCard(q, radar.providerStatus, ctx.now())],
  }));

  app.get("/api/cards/signals", { preHandler: requireCEO }, async (): Promise<TCardCollection> => ({
    cards: await listSignalCards(q),
  }));

  app.get(
    "/api/cards/signals/:id",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const card = await getSignalCard(q, req.params.id);
      return card ? { cards: [card] } : fail(reply, 404, "CARD_NOT_FOUND", "Card 不存在");
    },
  );

  app.get(
    "/api/signals/:id/images/:index",
    { preHandler: requireCEO, schema: { params: signalImageParams } },
    async (req, reply): Promise<FastifyReply> => {
      const image = await getSignalImageSource(q, req.params.id, Number(req.params.index));
      if (!image) return fail(reply, 404, "SIGNAL_IMAGE_NOT_FOUND", "原文图片不存在");
      // 国内站多有 Referer 防盗链：由服务端带原文页做 Referer 去取（被拒再不带 Referer 重试），浏览器只访问同源地址。
      const proxied = await fetchProxiedImage(image.url, image.referer);
      if (!proxied.ok) {
        const code = proxied.status === 413 ? "SIGNAL_IMAGE_TOO_LARGE" : proxied.status === 404 ? "SIGNAL_IMAGE_NOT_FOUND" : "SIGNAL_IMAGE_FETCH_FAILED";
        return fail(reply.header("cache-control", "private, max-age=300"), proxied.status, code, proxied.message);
      }
      // 登记过的原文图地址不会变：浏览器缓存一天，演示时来回切换不重复抓
      return reply
        .header("content-type", proxied.type)
        .header("cache-control", "private, max-age=86400, immutable")
        .header("x-content-type-options", "nosniff")
        .send(proxied.body);
    },
  );

  app.patch(
    "/api/signals/:id/state",
    { preHandler: requireCEO, schema: { params: idParams, body: SignalStateRequest } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const card = await setSignalState(q, req.params.id, req.body);
      return card ? { cards: [card] } : fail(reply, 404, "CARD_NOT_FOUND", "Signal 不存在");
    },
  );

  app.post(
    "/api/radar/scans/manual",
    { preHandler: requireCEO, schema: { response: { 200: RadarScanResponse } } },
    async (_req, reply) => {
      const result = await radar.runManual();
      if (result.status === "busy") return fail(reply, 409, "RADAR_SCAN_IN_PROGRESS", "Radar 正在运行");
      return result;
    },
  );
}
