import type { Metadata } from "next";
import { DriHandoffView } from "@/app/_views/dri-handoff-view";

export const metadata: Metadata = {
  title: "承接研究 · TKOS",
  robots: { index: false, follow: false },
};

export default async function DriHandoffPage({ params }: PageProps<"/dri/handoff/[issueId]">) {
  const { issueId } = await params;
  return <DriHandoffView issueId={issueId} />;
}
