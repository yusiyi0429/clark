import { RequestListScreen } from "@/components/requests/RequestListScreen";
import { requireMember } from "@/lib/api/server";

export default async function MyRequestsPage() {
  await requireMember("/me/requests");
  return <RequestListScreen base="/me/requests" />;
}
