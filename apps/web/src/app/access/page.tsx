import type { Metadata } from "next";
import { AccessScreen } from "./AccessScreen";

export const metadata: Metadata = {
  title: "进入天枢 · TKOS",
  robots: { index: false, follow: false },
};

function safeNextPath(candidate: string | undefined): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return "/";
  return candidate;
}

export default async function AccessPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <AccessScreen nextPath={safeNextPath(next)} />;
}
