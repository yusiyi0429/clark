import { RequestScreen } from "@/components/requests/RequestScreen";
import { loadRequest } from "@/components/requests/loadRequest";
import { requireCeo } from "@/lib/api/server";

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await requireCeo(`/requests/${id}`);
  const request = await loadRequest(cookie, id);
  return <RequestScreen key={request.id} initialRequest={request} base="/requests" />;
}
