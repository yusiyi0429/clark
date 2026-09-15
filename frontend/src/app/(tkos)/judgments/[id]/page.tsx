import { JudgmentView } from "@/app/_views/judgment-view";

/**
 * 一条判断。不是第六个页面 —— 它是溯源的落点：卡片上的 `01-J2`、写回回执里的
 * 「判断 01-J2 → v3」都点到这里来。本体真的动了，在这一页看得见。
 */
export default async function JudgmentPage({ params }: PageProps<"/judgments/[id]">) {
  const { id } = await params;
  return <JudgmentView id={id} />;
}
