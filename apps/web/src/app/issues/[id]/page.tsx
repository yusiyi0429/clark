import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { renderCard } from "@/cards/registry";
import { ConversationDock } from "@/conversation/ConversationDock";
import { serverApi } from "@/lib/api/client";

export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  if (!cookieStore.get("warmap_session")) redirect("/login");

  const { data, response } = await serverApi.GET("/api/cards/issues/{id}", {
    params: { path: { id } },
    headers: { cookie: cookieStore.toString() },
  });
  if (response.status === 401) redirect("/login");
  if (response.status === 404 || !data?.cards[0]) notFound();
  const card = data.cards[0];

  return (
    <main>
      {renderCard(card)}
      <ConversationDock scope={card.conversation?.scope ?? `issue:${id}`} availableCards={[card]} />
    </main>
  );
}
