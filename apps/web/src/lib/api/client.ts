import createClient, { type Middleware } from "openapi-fetch";
import { ceoTermsDeep } from "@/lib/displayText";
import type { components, paths } from "./schema";

export type Card = components["schemas"]["Card"];
export type CardCollection = components["schemas"]["CardCollection"];
export type CardAction = Card["actions"][number];
export type ApiError = components["schemas"]["ApiError"];

/**
 * 一号位看的对象数据（首页 / 议题 / 会议 / 战场 / 雷达 / 已处理）里的 LTO、PO 缩写在显示层换成中文（ceoTerms），数据库原文不改。
 * 月度计划、Mission 与配置页（编辑要用原文做 before 校验）不在白名单里。
 */
const CEO_TERM_PATHS = /^\/api\/(?:cards\/(?:home|issues|meetings|battlefields|radar|signals|notifications)(?:\/|$)|archive$|battlefields\/[^/]+\/missions$)/;

export const ceoTermsMiddleware: Middleware = {
  async onResponse({ response }) {
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return undefined;
    let path = "";
    try { path = new URL(response.url, "http://local").pathname; } catch { return undefined; }
    if (!CEO_TERM_PATHS.test(path)) return undefined;
    try {
      const data: unknown = await response.clone().json();
      const mapped = ceoTermsDeep(data);
      if (mapped === data) return undefined;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(JSON.stringify(mapped), { status: response.status, statusText: response.statusText, headers });
    } catch {
      return undefined;
    }
  },
};

// 浏览器端：同源相对路径，经 Caddy 边界访问 API
export const browserApi = createClient<paths>({ baseUrl: "/" });
browserApi.use(ceoTermsMiddleware);

// 服务端渲染：直连 API 内网地址（不经 Web 业务 handler）
const serverBase = process.env.API_SERVER_URL ?? "http://127.0.0.1:4321";
export const serverApi = createClient<paths>({ baseUrl: serverBase });
serverApi.use(ceoTermsMiddleware);
