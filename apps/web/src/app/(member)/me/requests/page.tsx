import { RequestListScreen } from "@/components/requests/RequestListScreen";
import { requireMember } from "@/lib/api/server";

/** ?box=sent：先打开「发出的」（成员首页「等回复」进来）；其他值都按「收到的」。 */
export default async function MyRequestsPage({ searchParams }: { searchParams: Promise<{ box?: string | string[] }> }) {
  await requireMember("/me/requests");
  const { box } = await searchParams;
  return <RequestListScreen base="/me/requests" initialBox={box === "sent" ? "sent" : "inbox"} />;
}
