import { CeoWorkspace } from "@/components/ceo-warmap/workspace";

/** CEO WarMap prototype. Historical screens remain available on their original routes. */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ _entry?: string }>;
}) {
  const { _entry } = await searchParams;
  return <CeoWorkspace arrivingFromLock={_entry === "unlock"} />;
}
