import { redirect } from "next/navigation";

/**
 * 会前准备是这件议题那场会的前半程，地址归到 `/meetings?issue=`。
 *
 * 旧地址留着做重定向：屏幕上、时间线里、别人发出去的链接里都还有它。
 */
export default async function BriefRedirect({ params }: PageProps<"/issues/[id]/brief">) {
  const { id } = await params;
  redirect(`/meetings?issue=${id}`);
}
