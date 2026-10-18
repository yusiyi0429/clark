import { RequestScreen } from "@/components/requests/RequestScreen";
import { requireCeo } from "@/lib/api/server";

export default async function NewRequestPage() {
  await requireCeo("/requests/new");
  return <RequestScreen initialRequest={null} base="/requests" />;
}
