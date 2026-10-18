import { ProgressScreen } from "@/components/progress/ProgressScreen";
import { requireMember } from "@/lib/api/server";

export default async function MyProgressPage() {
  await requireMember("/me/progress");
  return <ProgressScreen scope="member" />;
}
