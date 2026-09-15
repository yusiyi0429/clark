import type { Metadata } from "next";
import { DriWorkspace } from "@/components/dri-workspace/workspace";

export const metadata: Metadata = {
  title: "本月工作面 · 天枢",
  robots: { index: false, follow: false },
};

/** 访问控制由 proxy 负责；进入明确的 `/dri` 路由后直接呈现 DRI 工作面。 */
export default function DriHomePage() {
  return <DriWorkspace />;
}
