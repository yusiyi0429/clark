import { redirect } from "next/navigation";
import { MeetingsView } from "@/app/_views/meetings-view";

/**
 * 会议。两挡：会前准备 / 会后确认。
 *
 * **一件议题一场会**，所以这一页必须带着议题进来（`?issue=`）。没有议题的会议页
 * 只能猜他要开哪件事的会，那就不是入口 —— 直接回主页，从议题卡片上那颗按钮进来。
 */
export default async function MeetingsPage({ searchParams }: PageProps<"/meetings">) {
  const { stage, issue, id } = await searchParams;
  const issueId = typeof issue === "string" ? issue : typeof id === "string" ? id : null;
  if (!issueId) redirect("/");

  return <MeetingsView issueId={issueId} stage={stage === "post" ? "post" : "pre"} />;
}
