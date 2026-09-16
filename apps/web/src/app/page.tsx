import { HomeShell } from "@/components/HomeShell";
import { loadHomeCards, requireCeo } from "@/lib/api/server";

export default async function HomePage() {
  const cookie = await requireCeo("/");
  const { cards } = await loadHomeCards(cookie);
  return <HomeShell initialCards={cards} />;
}
