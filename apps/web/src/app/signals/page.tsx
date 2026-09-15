import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { renderCard } from "@/cards/registry";
import { serverApi } from "@/lib/api/client";

export default async function SignalsPage() {
  const cookieStore = await cookies();
  if (!cookieStore.get("warmap_session")) redirect("/login");

  const { data, response } = await serverApi.GET("/api/cards/signals", {
    headers: { cookie: cookieStore.toString() },
  });
  if (response.status === 401) redirect("/login");

  return (
    <main>
      <p><a href="/">← 返回首页</a> <a href="/radar">Radar</a></p>
      <h1>Signal</h1>
      {(data?.cards ?? []).length === 0 ? <p>尚无已保存的 Signal。</p> : null}
      {(data?.cards ?? []).map((card) => (
        <div key={card.id}>
          <h2><a href={`/signals/${card.objectRef.id}`}>{card.title}</a></h2>
          <p><span>{card.badge}</span></p>
        </div>
      ))}
    </main>
  );
}
