import { ProgressScreen } from "@/components/progress/ProgressScreen";
import { requireCeo } from "@/lib/api/server";

export default async function ProgressPage() {
  await requireCeo("/progress");
  return <ProgressScreen scope="ceo" />;
}
