import { notFound, redirect } from "next/navigation";
import { MemberGroupCard } from "@/components/member/MemberGroupCard";
import { serverApi } from "@/lib/api/client";
import { requireMember } from "@/lib/api/server";

export default async function MemberIssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { cookie } = await requireMember(`/me/issues/${id}`);
  const { data, response } = await serverApi.GET("/api/me/cards/issues/{id}", { params: { path: { id } }, headers: { cookie } });
  if (response.status === 401) redirect("/access");
  if (response.status === 404) notFound();
  if (!data) throw new Error(`Issue query failed with ${response.status}`);
  return <MemberGroupCard card={data} />;
}
