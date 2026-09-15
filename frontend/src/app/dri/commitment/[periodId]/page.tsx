import type { Metadata } from "next";
import { DriCommitmentView } from "@/app/_views/dri-commitment-view";

export const metadata: Metadata = {
  title: "本期承诺 · TKOS",
  robots: { index: false, follow: false },
};

export default async function DriCommitmentPage({
  params,
}: PageProps<"/dri/commitment/[periodId]">) {
  const { periodId } = await params;
  return <DriCommitmentView periodId={periodId} />;
}
