import { RequestScreen } from "@/components/requests/RequestScreen";
import { loadRequest } from "@/components/requests/loadRequest";
import { requireMember } from "@/lib/api/server";

export default async function MyRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { cookie } = await requireMember(`/me/requests/${id}`);
  const request = await loadRequest(cookie, id);
  return <RequestScreen key={request.id} initialRequest={request} base="/me/requests" />;
}
