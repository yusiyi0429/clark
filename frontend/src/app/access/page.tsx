import type { Metadata } from "next";
import { cookies } from "next/headers";
import { isAccessConfigured } from "@/lib/access";
import { SEAT_COOKIE_NAME, seatFrom } from "@/lib/seat";
import { AccessScreen } from "./access-screen";

export const metadata: Metadata = {
  title: "进入天枢 · TKOS",
  robots: { index: false, follow: false },
};

function safeNextPath(candidate: string | undefined): string | null {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
    return null;
  }

  const path = candidate.split(/[?#]/, 1)[0] ?? candidate;
  return path === "/" ? null : candidate;
}

export default async function AccessPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const jar = await cookies();
  const initialSeat = seatFrom(jar.get(SEAT_COOKIE_NAME)?.value);
  const configured = isAccessConfigured();

  return (
    <AccessScreen
      configured={configured}
      initialSeat={initialSeat}
      nextPath={safeNextPath(next)}
    />
  );
}
