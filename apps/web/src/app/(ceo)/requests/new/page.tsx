import { RequestScreen } from "@/components/requests/RequestScreen";
import { requireCeo } from "@/lib/api/server";

export default async function NewRequestPage({ searchParams }: { searchParams: Promise<{ prompt?: string }> }) {
  await requireCeo("/requests/new");
  const { prompt } = await searchParams;
  return <RequestScreen initialRequest={null} base="/requests" initialPrompt={prompt?.slice(0, 2000)} />;
}
