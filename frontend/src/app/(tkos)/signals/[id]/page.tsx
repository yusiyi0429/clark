import { SignalView } from "@/app/_views/signal-view";

/** 潜在议题详情：左窄栏是分诊要用的东西与出口，右主栏是对话。 */
export default async function SignalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SignalView id={id} />;
}
