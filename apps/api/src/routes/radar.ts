import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { RadarScanResponse, SignalStateRequest, type TCardCollection } from "@warmap/contracts";
import { getSignalCard, getSignalImageSource, listSignalCards, projectRadarCard, setSignalState } from "../signals.js";
import { idParams, type AppInstance, type RouteContext } from "./shared.js";

export function registerRadarRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, env, fail, requireCEO, radar } = ctx;

  const signalImageParams = Type.Object({
    id: Type.String({ minLength: 1 }),
    index: Type.String({ pattern: "^[0-9]+$" }),
  }, { additionalProperties: false });
  app.get("/api/cards/radar", { preHandler: requireCEO }, async (): Promise<TCardCollection> => ({
    cards: [await projectRadarCard(q, radar.providerStatus)],
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
      let source: Response;
      try {
        source = await fetch(image.url, {
          headers: { "user-agent": "Mozilla/5.0 (compatible; WarMapRadar/1.0)", referer: image.referer },
        });
      } catch {
        return fail(reply, 502, "SIGNAL_IMAGE_FETCH_FAILED", "原文图片抓取失败");
      }
      const type = source.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
      if (!source.ok || !type || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)) {
        return fail(reply, 502, "SIGNAL_IMAGE_FETCH_FAILED", "原文图片不可用");
      }
      const limit = 10 * 1024 * 1024;
      const declared = Number(source.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limit) return fail(reply, 413, "SIGNAL_IMAGE_TOO_LARGE", "原文图片超过 10MiB");
      const reader = source.body?.getReader();
      if (!reader) return fail(reply, 502, "SIGNAL_IMAGE_FETCH_FAILED", "原文图片读取失败");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return fail(reply, 413, "SIGNAL_IMAGE_TOO_LARGE", "原文图片超过 10MiB");
        }
        chunks.push(next.value);
      }
      return reply.header("content-type", type).header("cache-control", "private, max-age=3600").send(Buffer.concat(chunks));
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
