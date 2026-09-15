import { ClosureView } from "@/app/_views/closure-view";

/** 页面4 的一份：某个议题的 Closure 七要素 + 四选一分流 + 写回回执。 */
export default async function ClosurePage({ params }: PageProps<"/decisions/[id]">) {
  const { id } = await params;
  return <ClosureView id={id} />;
}
