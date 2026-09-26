import { notFound, redirect } from "next/navigation";
import { serverApi } from "@/lib/api/client";

export async function loadPersonalMissionCard(cookie: string, cardId: string) {
  const { data, response } = await serverApi.GET("/api/mission-cards/{cardId}", { params: { path: { cardId } }, headers: { cookie } });
  if (response.status === 401) redirect("/access");
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error(`Personal Mission Card query failed with ${response.status}`);
  const card = data?.cards[0];
  if (!card) notFound();
  return card;
}
