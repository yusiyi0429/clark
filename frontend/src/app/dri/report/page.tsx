import type { Metadata } from "next";
import { DriReportView } from "@/app/_views/dri-report-view";

export const metadata: Metadata = {
  title: "上报信号 · TKOS",
  robots: { index: false, follow: false },
};

export default function DriReportPage() {
  return <DriReportView />;
}
