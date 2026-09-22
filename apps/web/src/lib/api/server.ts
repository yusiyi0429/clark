import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import type { TBattlefieldManagementResponse, TCapabilityManagementResponse } from "@warmap/contracts";
import type { Card } from "./client";
import { serverApi } from "./client";

export const SESSION_COOKIE = "warmap_session";

/** 登录守卫：未登录直接回 /access?next=<目标>，不渲染任何 Card。 */
export async function requireCeo(targetPath: string): Promise<string> {
  const jar = await cookies();
  const cookie = jar.toString();
  if (!jar.get(SESSION_COOKIE)) redirect(`/access?next=${encodeURIComponent(targetPath)}`);
  return cookie;
}

type CardResult = { cards: Card[] };

/**
 * 页面只读取 Card；真实对象不存在（404）与后端整体不可用（5xx）分开处理。
 * 401 视为会话过期，回到登录入口。
 */
async function load(path: string, cookie: string, params?: Record<string, string>): Promise<CardResult> {
  const { data, response } = await serverApi.GET(path as never, {
    params: params ? { path: params } : undefined,
    headers: { cookie },
  } as never);
  if (response.status === 401) redirect("/access");
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error(`Card query ${path} failed with ${response.status}`);
  return (data as CardResult | undefined) ?? { cards: [] };
}

export const loadHomeCards = (cookie: string) => load("/api/cards/home", cookie);
export const loadIssueCard = (cookie: string, id: string) => load("/api/cards/issues/{id}", cookie, { id });
export const loadMeetingCard = (cookie: string, id: string) => load("/api/cards/meetings/{id}", cookie, { id });
export const loadRadarCard = (cookie: string) => load("/api/cards/radar", cookie);
export const loadRadarCards = async (cookie: string) => ({
  radar: (await loadRadarCard(cookie)).cards[0],
  signals: (await load("/api/cards/signals", cookie)).cards,
});
export const loadSignalCard = (cookie: string, id: string) => load("/api/cards/signals/{id}", cookie, { id });
export const loadMonthlyPlanCards = (cookie: string) => load("/api/cards/monthly-plans", cookie);
export const loadMeetingCards = (cookie: string) => load("/api/cards/meetings", cookie);

export type PersonOption = { personId: string; displayName: string; roles: string[] };

/** 配置页新建 Meeting 选 lead DRI：只读 CompanyMemory 人员投影。 */
export async function loadPeople(cookie: string): Promise<PersonOption[]> {
  const { data, response } = await serverApi.GET("/api/people", { headers: { cookie } });
  if (response.status === 401) redirect("/access");
  if (!response.ok) throw new Error(`people query failed with ${response.status}`);
  return ((data as { people?: PersonOption[] } | undefined)?.people) ?? [];
}

/** 配置页新建议题只能归属已注册战场。 */
export async function loadBattlefieldOptions(cookie: string): Promise<{ id: string; name: string }[]> {
  const { cards } = await load("/api/cards/battlefields", cookie);
  return cards.map((card) => ({ id: card.objectRef.id, name: card.title }));
}

/** 战场管理页一次读全部战场与待决策议题，避免在 Web 侧拼第二份事实。 */
export async function loadBattlefieldManagement(cookie: string): Promise<TBattlefieldManagementResponse> {
  const { data, response } = await serverApi.GET("/api/config/battlefields", { headers: { cookie } });
  if (response.status === 401) redirect("/access");
  if (!response.ok) throw new Error(`battlefield management query failed with ${response.status}`);
  return (data as TBattlefieldManagementResponse | undefined) ?? { battlefields: [], issues: [] };
}

/** 能力管理页一次读全部已登记能力，编辑写回 PATCH /api/config/capabilities/{id}。 */
export async function loadCapabilityManagement(cookie: string): Promise<TCapabilityManagementResponse> {
  const { data, response } = await serverApi.GET("/api/config/capabilities", { headers: { cookie } });
  if (response.status === 401) redirect("/access");
  if (!response.ok) throw new Error(`capability management query failed with ${response.status}`);
  return (data as TCapabilityManagementResponse | undefined) ?? { capabilities: [] };
}

/** 关联 Issue 标题需要逐条读取：已经离开待决策区域的 Issue 仍应显示自己的标题。 */
export async function tryLoadIssueCards(cookie: string, ids: string[]): Promise<Card[]> {
  const results = await Promise.all(
    ids.map(async (id) => {
      const { data, response } = await serverApi.GET("/api/cards/issues/{id}", {
        params: { path: { id } },
        headers: { cookie },
      });
      return response.ok ? ((data as CardResult | undefined)?.cards ?? []) : [];
    }),
  );
  return results.flat();
}
