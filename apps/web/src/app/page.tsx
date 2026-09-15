import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { serverApi } from "@/lib/api/client";
import { renderCard } from "@/cards/registry";
import { ConversationDock } from "@/conversation/ConversationDock";

export default async function HomePage() {
  const cookieStore = await cookies();
  if (!cookieStore.get("warmap_session")) redirect("/login");

  const { data, response } = await serverApi.GET("/api/cards/home", {
    headers: { cookie: cookieStore.toString() },
  });
  if (response.status === 401) redirect("/login");

  async function logout() {
    "use server";
    const jar = await cookies();
    const res = await fetch(`${process.env.API_SERVER_URL ?? "http://localhost:4000"}/api/auth/logout`, {
      method: "POST",
      headers: {
        cookie: jar.toString(),
        origin: process.env.PUBLIC_ORIGIN ?? "https://warmap.local",
      },
    });
    if (res.ok) {
      jar.delete("warmap_session");
      redirect("/login");
    }
  }

  return (
    <main>
      <nav>
        <form action={logout}>
          <button type="submit">退出登录</button>
        </form>
      </nav>
      {(data?.cards ?? []).map((card) => (
        <div key={card.id}>{renderCard(card)}</div>
      ))}
      <ConversationDock scope="global" availableCards={data?.cards ?? []} />
    </main>
  );
}
