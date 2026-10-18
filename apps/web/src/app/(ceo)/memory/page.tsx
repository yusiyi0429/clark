import { MemoryScreen } from "@/components/memory/MemoryScreen";
import { requireCeo } from "@/lib/api/server";

export default async function MemoryPage() {
  await requireCeo("/memory");
  return <MemoryScreen role="ceo" />;
}
