import { notFound, redirect } from "next/navigation";
import { serverApi } from "@/lib/api/client";

/** 成员专用投影；不可见与不存在都走同一个 404。 */
export async function loadMemberBattlefield(cookie: string, id: string) {
  const { data, response } = await serverApi.GET("/api/me/battlefields/{id}", { params: { path: { id } }, headers: { cookie } });
  if (response.status === 401) redirect(`/access?next=${encodeURIComponent(`/me/battlefields/${id}`)}`);
  if (response.status === 403 || response.status === 404) notFound();
  if (!response.ok) throw new Error(`Member battlefield query failed with ${response.status}`);
  if (!data) throw new Error("Member battlefield response is missing");
  return data;
}
