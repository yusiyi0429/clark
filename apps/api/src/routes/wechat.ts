import { WechatConnection } from "@warmap/contracts";
import { logEvent } from "../observability.js";
import type { WechatService } from "../wechat/service.js";
import type { AppInstance, RouteContext } from "./shared.js";

/** 本人的微信 ClawBot：看状态（等扫码时带二维码内容）、开始连接、断开。没接微信时这三个接口不注册。 */
export function registerWechatRoutes(app: AppInstance, ctx: RouteContext, wechat: WechatService): void {
  const { requirePerson, fail } = ctx;

  app.get("/api/me/wechat", { preHandler: requirePerson, schema: { response: { 200: WechatConnection } } }, async (req) =>
    wechat.status(req.person!.personId));

  app.post("/api/me/wechat/connect", { preHandler: requirePerson, schema: { response: { 200: WechatConnection } } }, async (req, reply) => {
    try {
      return await wechat.connect(req.person!.personId);
    } catch (error) {
      logEvent({ event: "wechat.qrcode_failed", personId: req.person!.personId, error: (error as Error).message });
      return fail(reply, 503, "WECHAT_UNAVAILABLE", "暂时连不上微信，请稍后再试");
    }
  });

  app.delete("/api/me/wechat", { preHandler: requirePerson }, async (req, reply) => {
    await wechat.disconnect(req.person!.personId);
    return reply.status(204).send();
  });
}
