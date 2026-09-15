import { RecordingView } from "@/app/_views/recording-view";

export default async function RecordingPage({ params }: PageProps<"/recordings/[id]">) {
  const { id } = await params;
  return <RecordingView id={id} />;
}
