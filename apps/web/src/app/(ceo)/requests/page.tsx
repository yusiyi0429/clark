import { RequestListScreen } from "@/components/requests/RequestListScreen";
import { requireCeo } from "@/lib/api/server";

export default async function RequestsPage() {
  await requireCeo("/requests");
  return <RequestListScreen base="/requests" />;
}
