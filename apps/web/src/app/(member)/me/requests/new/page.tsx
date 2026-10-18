import { RequestScreen } from "@/components/requests/RequestScreen";
import { requireMember } from "@/lib/api/server";

export default async function MyNewRequestPage({ searchParams }: { searchParams: Promise<{ prompt?: string }> }) {
  await requireMember("/me/requests/new");
  const { prompt } = await searchParams;
  return <RequestScreen initialRequest={null} base="/me/requests" initialPrompt={prompt?.slice(0, 2000)} />;
}
