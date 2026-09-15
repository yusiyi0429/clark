/**
 * 链接换 cookie。**这是 DRI 进来的唯一入口。**
 *
 * 是一个 GET route 而不是一个页面：cookie 只能在 Route Handler 或 Server Action
 * 里写（页面渲染期写不了），而这条链接是在群里被点开的，本来就是一次 GET。
 * 落 cookie 之后立刻 302 到 `/dri`，于是那条带签名的 URL 不会留在地址栏里，也不会
 * 被顺手转发出去。
 *
 * 与 `api/access/route.ts` 同一套 cookie 参数，包括 `secure` 靠
 * `x-forwarded-proto` 现判 —— 本地是 http，硬带 secure 的话浏览器根本不存，
 * 于是「进去了」之后一刷新又被弹回来。
 */
import { NextResponse } from "next/server";

import { WHO_COOKIE_MAX_AGE, WHO_COOKIE_NAME, personIdFromToken } from "@/lib/identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const plain = (text: string, status: number) =>
  new NextResponse(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t") ?? undefined;
  const personId = personIdFromToken(token);

  if (!personId) {
    /*
     * 不重定向到任何地方 —— 他没有第二道门，弹到 /access 只会让他去猜一个口令。
     * 照实说链接不对，并说清楚下一步找谁。
     */
    return plain("这条链接无效或已过期。找刘明华重发一条。", 401);
  }

  const response = NextResponse.redirect(new URL("/dri", request.url));
  response.cookies.set({
    name: WHO_COOKIE_NAME,
    value: token!,
    httpOnly: true,
    secure: request.headers.get("x-forwarded-proto") === "https",
    sameSite: "lax",
    path: "/",
    maxAge: WHO_COOKIE_MAX_AGE,
    priority: "high",
  });
  return response;
}
