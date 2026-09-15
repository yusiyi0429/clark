import type { Metadata } from "next";
import { SecDebriefsView } from "@/app/_views/sec-debriefs-view";

export const metadata: Metadata = {
  title: "纪要审阅 · TKOS",
  robots: { index: false, follow: false },
};

/** 纪要审阅：刚散的那几场提炼出来的东西，一件一件过。 */
export default function SecDebriefsPage() {
  return <SecDebriefsView />;
}
