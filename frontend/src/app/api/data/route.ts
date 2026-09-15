/**
 * 数据层的唯一入口。前端 `lib/data/client.ts` 的方法全部打到这里。
 *
 * 为什么是一个 RPC 端点而不是几十条 REST 路由：这不是公开 API，只被我们自己的
 * 前端调用。1:1 映射能让 client.ts 的调用点真正做到一个字不改 —— 那正是
 * client.ts 文件头承诺的「只改方法体」。铺几十条路由只是把同一件事写几十遍。
 *
 * 安全边界三层，缺一不可：
 *
 * 1. 方法名必须命中白名单（白名单就是 `api` 自己的键）。不接受任意属性路径，不 eval。
 * 2. **身份**：一号位那把共享口令 → 一号位；`tkos_who` 签名 cookie → 解出来的那个
 *    DRI。两个都没有 → 401。（`src/proxy.ts` 已经挡过一次，这里不靠它 ——
 *    proxy 只验签，认不认人是数据层的事。）
 * 3. **可见性**：`METHOD_SCOPE` 查一下这个身份能不能调这个方法。少了这一层，
 *    一条 DRI cookie 就能调 `signClosure`。
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { ACCESS_COOKIE_NAME, isAccessCookieValid } from "@/lib/access";
import { WHO_COOKIE_NAME, personIdFromToken } from "@/lib/identity";
import type { Actor } from "@/lib/data/actor";
import { runAsActor } from "@/lib/data/actor";
import { scopeOf } from "@/lib/data/scope";
import { CEO_ACTOR, api, persistOnly, resolveDriActor } from "@/lib/data/store";
import { ApiError } from "@/lib/data/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { method?: unknown; args?: unknown };

const METHODS = new Set(
  Object.entries(api)
    .filter(([, v]) => typeof v === "function")
    .map(([k]) => k)
);

/** 一号位优先：两个 cookie 都带着的时候，他那把口令说了算（spec §4.2）。 */
async function actorOf(): Promise<Actor | null> {
  const jar = await cookies();
  if (isAccessCookieValid(jar.get(ACCESS_COOKIE_NAME)?.value)) return CEO_ACTOR;

  const personId = personIdFromToken(jar.get(WHO_COOKIE_NAME)?.value);
  return personId ? resolveDriActor(personId) : null;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const { method, args } = body;
  if (typeof method !== "string" || !METHODS.has(method)) {
    return NextResponse.json({ ok: false, error: `未知方法：${String(method)}` }, { status: 400 });
  }
  if (args !== undefined && !Array.isArray(args)) {
    return NextResponse.json({ ok: false, error: "args 必须是数组。" }, { status: 400 });
  }

  const actor = await actorOf();
  if (!actor) {
    return NextResponse.json({ ok: false, error: "没有身份。" }, { status: 401 });
  }

  const scope = scopeOf(method);
  if (!scope) {
    // 白名单过了但表里没有 —— 只可能是有人加了方法没进表（scope.test.ts 会红）。
    console.error(`[api/data] ${method} 不在 METHOD_SCOPE 里，按拒绝处理。`);
    return NextResponse.json({ ok: false, error: "这个方法还没有分类。" }, { status: 500 });
  }
  if (scope !== "both" && scope !== actor.role) {
    console.warn(`[api/data] ${actor.personId}（${actor.role}）想调 ${method}（${scope}）—— 拒了。`);
    return NextResponse.json(
      { ok: false, error: "这个动作不在你这一侧。", kind: "forbidden" },
      { status: 403 }
    );
  }

  const fn = (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];

  try {
    // 身份塞进请求作用域：`viewer()` 从这里读，于是每一处署名都是真的。
    const data = await runAsActor(actor, () => fn(...((args ?? []) as unknown[])));
    /*
     * 读操作也可能改 store（settleResearch 会把到点的研究装上），所以每次都排队落盘。
     * persist.ts 里做了防抖，连续操作合并成一次写。
     *
     * **走 `persistOnly` 而不是 `persistSoon`**：后者还会报一声「库改过了」，而这一处
     * 每次调用都跑，纯读也跑。纯读报改动的话，屏幕收到通知去重问，重问又是一次纯读、
     * 又报一次改动 —— 无限重问。真的写了东西的那些方法在函数体里自己叫过
     * `persistSoon()`，通知从那里出去（见 `lib/data/revision.ts`）。
     */
    persistOnly();
    return NextResponse.json({ ok: true, data: data ?? null });
  } catch (err) {
    if (err instanceof ApiError) {
      // 业务性失败：把原文带回给前端，它会原样显示。409 这个状态码就是「这是业务性
      // 失败」，不另外挂一个 kind —— 前端不按 kind 分这一档（见 client.ts）。
      return NextResponse.json({ ok: false, error: err.message }, { status: 409 });
    }
    // 服务端意外出错：console.error 记录真实原因（排查用的），但不把原文带给前端 ——
    // 英文 JS 报错对读的人没有信息，对排查的人不在这里。
    console.error(`[api/data] ${method} 抛出：`, err);
    return NextResponse.json(
      { ok: false, error: "这一步在服务端出错了。原因已经写进服务端日志，不在这句话里。" },
      { status: 500 }
    );
  }
}
