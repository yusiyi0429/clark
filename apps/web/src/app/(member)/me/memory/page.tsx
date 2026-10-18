import { MemoryScreen } from "@/components/memory/MemoryScreen";
import { requireMember } from "@/lib/api/server";

export default async function MyMemoryPage() {
  await requireMember("/me/memory");
  return <MemoryScreen role="member" />;
}
