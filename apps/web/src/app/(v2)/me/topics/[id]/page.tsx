import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";
import { TopicSession } from "@/components/topics/TopicSession";

export const metadata: Metadata = { title: "专题 · 天枢" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMember(`/me/topics/${encodeURIComponent(id)}`);
  return <TopicSession topicId={id} />;
}
