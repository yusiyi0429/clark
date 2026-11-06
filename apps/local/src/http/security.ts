import type { IncomingMessage } from "node:http";
import type { TLocalRunnerErrorCode } from "@warmap/contracts";

export type Rejection = { status: number; code: TLocalRunnerErrorCode; message: string };

/** 防 DNS 重绑定：Host 只能是 127.0.0.1 或 localhost 加本端口。 */
export function checkHost(req: IncomingMessage, port: number): Rejection | null {
  const host = (req.headers.host ?? "").toLowerCase();
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return null;
  return { status: 421, code: "bad_host", message: "Host 不对" };
}

/** 浏览器请求一律带 Origin；不带的（curl、别的程序）和 Origin: null 都拒。 */
export function checkOrigin(req: IncomingMessage, allowed: readonly string[]): { origin: string } | Rejection {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "null" && allowed.includes(origin)) return { origin };
  return { status: 403, code: "bad_origin", message: "这个来源不能连本机程序" };
}

/** 带请求体的请求只收 JSON：HTML 表单发不出 application/json，也就绕不过预检。 */
export function checkJson(req: IncomingMessage): Rejection | null {
  if (req.method === "GET" || req.method === "DELETE" || req.method === "OPTIONS") return null;
  const ct = (req.headers["content-type"] ?? "").toLowerCase();
  if (ct.startsWith("application/json")) return null;
  return { status: 415, code: "unsupported_media_type", message: "只收 application/json" };
}

export function corsHeaders(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

export function preflightHeaders(origin: string, req: IncomingMessage): Record<string, string> {
  const h: Record<string, string> = {
    ...corsHeaders(origin),
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
    "access-control-allow-headers": "content-type, x-tianshu-local-token, last-event-id",
    "access-control-max-age": "600",
  };
  // 旧版 Chrome 的私有网络访问预检；Chrome 156 已改由权限弹窗管，回这个头无害。
  if (req.headers["access-control-request-private-network"]) h["access-control-allow-private-network"] = "true";
  return h;
}
