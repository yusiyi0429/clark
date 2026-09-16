import { AccessScreen } from "./AccessScreen";

function safeNextPath(candidate: string | undefined): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return "/";
  return candidate;
}

export default async function AccessPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <AccessScreen nextPath={safeNextPath(next)} />;
}
