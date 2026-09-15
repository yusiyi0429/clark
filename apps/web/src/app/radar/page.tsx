import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { renderCard } from "@/cards/registry";
import { serverApi } from "@/lib/api/client";

export default async function RadarPage() {
  const cookieStore = await cookies();
  if (!cookieStore.get("warmap_session")) redirect("/login");

  const { data, response } = await serverApi.GET("/api/cards/radar", {
    headers: { cookie: cookieStore.toString() },
  });
  if (response.status === 401) redirect("/login");
  const card = data?.cards[0];
  if (!card) redirect("/");

  return <main>{renderCard(card)}</main>;
}
