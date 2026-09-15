import { NextResponse } from "next/server";
import {
  ACCESS_COOKIE_MAX_AGE,
  ACCESS_COOKIE_NAME,
  accessCookieValue,
  isAccessConfigured,
  isPasswordAccepted,
} from "@/lib/access";
import { SEAT_COOKIE_MAX_AGE, SEAT_COOKIE_NAME, seatFrom } from "@/lib/seat";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAccessConfigured()) {
    /*
     * 没配就说没配，而且**要在服务端日志里喊出来**。
     *
     * 上一版这里只回一个 503，前端把它显示成「暂时无法验证，请稍后再试」——
     * 那句话把「配置缺失」说成了「临时故障」，于是唯一的排查动作变成了「再试一次」，
     * 而再试一万次也不会好。配置类失败和瞬时失败在屏幕上必须长得不一样。
     */
    console.error(
      "[tkos:access] TKOS_ACCESS_PASSWORD / TKOS_ACCESS_SECRET 没配全 —— " +
        "任何密码都进不去。本地在 .env.local 里补上这两项（见 .env.example）。",
    );
    return NextResponse.json({ error: "access_not_configured" }, { status: 503 });
  }

  let password: unknown;
  let seat: unknown;
  try {
    const body = (await request.json()) as { password?: unknown; seat?: unknown };
    password = body.password;
    seat = body.seat;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (!isPasswordAccepted(password)) {
    return NextResponse.json({ error: "invalid_password" }, { status: 401 });
  }

  const token = accessCookieValue();
  if (!token) {
    return NextResponse.json({ error: "access_not_configured" }, { status: 503 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: ACCESS_COOKIE_NAME,
    value: token,
    httpOnly: true,
    // 本地是 http，带上 secure 的话浏览器根本不会存这个 cookie —— 于是登录「成功」
    // 之后一刷新又被弹回来。反代给的 x-forwarded-proto 才是真实协议。
    secure: request.headers.get("x-forwarded-proto") === "https",
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_COOKIE_MAX_AGE,
    priority: "high",
  });

  /*
   * 座位跟着口令一起写。**它不是第二把钥匙** —— 见 `lib/seat.ts` 开头那一节：
   * 这一版一把口令开两个空间，这个 cookie 只决定验完之后落到哪一页。
   *
   * 不跟 access cookie 共用一次 set：那一个是 12 小时的凭据，这一个是一个月的偏好，
   * 两者同寿的话，口令一过期他重新输完还得再选一次座位 —— 而他上次选过了。
   */
  response.cookies.set({
    name: SEAT_COOKIE_NAME,
    value: seatFrom(seat),
    httpOnly: true,
    secure: request.headers.get("x-forwarded-proto") === "https",
    sameSite: "lax",
    path: "/",
    maxAge: SEAT_COOKIE_MAX_AGE,
  });
  return response;
}
