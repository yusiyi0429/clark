import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";
import { CardSession } from "@/components/cards/CardSession";

export const metadata: Metadata = { title: "执行事项 · 天枢" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMember(`/me/cards/${encodeURIComponent(id)}`);
  return <CardSession cardId={id} />;
}
