import { RequestScreen } from "@/components/requests/RequestScreen";
import { requireMember } from "@/lib/api/server";

export default async function MyNewRequestPage() {
  await requireMember("/me/requests/new");
  return <RequestScreen initialRequest={null} base="/me/requests" />;
}
