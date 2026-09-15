import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { renderCard } from "@/cards/registry";
import { serverApi } from "@/lib/api/client";

export default async function SignalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  if (!cookieStore.get("warmap_session")) redirect("/login");

  const { data, response } = await serverApi.GET("/api/cards/signals/{id}", {
    params: { path: { id } },
    headers: { cookie: cookieStore.toString() },
  });
  if (response.status === 401) redirect("/login");
  if (response.status === 404 || !data?.cards[0]) notFound();

  return <main>{renderCard(data.cards[0])}</main>;
}
