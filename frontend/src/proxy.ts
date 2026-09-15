import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ACCESS_COOKIE_NAME, isAccessCookieValid } from "@/lib/access";
import { WHO_COOKIE_NAME, personIdFromToken } from "@/lib/identity";

/*
 * `/api/signals/inbox` 与 `/api/om/intake` 在这里，不是因为它们公开，而是因为
 * **推它们的是机器**：抓取作业和灌纲领的那条命令都没有访问 cookie，不加这两条
 * 它们连 route 都进不到，只会拿到 `{"error":"unauthorized"}` —— 而那句话读起来
 * 像 `OPERATOR_TOKEN` 配错了，能查很久。它们自己那道门是请求头里的
 * `x-operator-token`（见各自的 route）。
 *
 * `/dri/enter` 也在这里：DRI 没有那把共享口令，这是他进来的唯一入口，它自己的门
 * 是 URL 里那道签名（`src/lib/identity.ts`）。
 */
const PUBLIC_PATHS = new Set([
  "/access",
  "/api/access",
  "/api/health",
  "/api/signals/inbox",
  "/api/om/intake",
  "/dri/enter",
]);

/**
 * 签名身份能进的地方。**不含 `/`、不含任何 `(tkos)` 下的页面** —— DRI 侧看不到
 * 一号位的提请台、对谈记录、判断本体。
 *
 * `/api/data` 在里面，但那不等于放开：能调哪个方法由 `METHOD_SCOPE` 说了算
 * （`src/lib/data/scope.ts`），而那一层查的是解出来的真身份。
 */
const DRI_PATHS = ["/dri", "/api/data", "/api/health"];

const inDriZone = (pathname: string): boolean =>
  DRI_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  // 一号位那把口令开全站，照旧。两个 cookie 都带着的时候他说了算。
  if (isAccessCookieValid(request.cookies.get(ACCESS_COOKIE_NAME)?.value)) {
    return NextResponse.next();
  }

  /*
   * 签名身份只开 DRI 区。**这一层只验签，不认人** —— 「这个 personId 是不是 dri」
   * 要拿去对象库里解，而把 store.ts（连着整份种子）import 进 proxy 会把种子拖进
   * 这一层的 bundle。角色在 `/api/data` 与页面的服务端那一侧认（spec §4.4）。
   */
  const signed = personIdFromToken(request.cookies.get(WHO_COOKIE_NAME)?.value);
  if (signed && inDriZone(pathname)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  /*
   * 带着有效签名却敲了一号位的地址：**不要把他弹到 /access**。那一页要的是共享
   * 口令，他没有，于是他会以为自己的链接坏了，然后来问。照实说这一侧没有这一页。
   */
  if (signed) {
    return NextResponse.redirect(new URL("/dri", request.url));
  }

  const destination = new URL("/access", request.url);
  destination.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(destination);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|brand/).*)"],
};
