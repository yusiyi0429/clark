import type { Metadata } from "next";
import { CommitmentRulingView } from "@/app/_views/commitment-ruling-view";

export const metadata: Metadata = { title: "逐条裁决 · TKOS" };

export default async function CommitmentRulingPage({
  params,
}: PageProps<"/outcomes/commitment/[id]">) {
  const { id } = await params;
  return <CommitmentRulingView id={decodeURIComponent(id)} />;
}
