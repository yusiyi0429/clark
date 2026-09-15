import { DocView } from "@/app/_views/doc-view";

export default async function DocPage({ params }: PageProps<"/docs/[id]">) {
  const { id } = await params;
  return <DocView id={id} />;
}
