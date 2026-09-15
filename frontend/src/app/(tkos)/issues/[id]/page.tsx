import { AdvisorView } from "@/app/_views/advisor-view";

/**
 * 页面3 议题研究：首轮调研文档 + 对谈 + 反问 + 定题。
 *
 * `?quote=` 是从会后确认「就这一条再聊」过来的那段引文。在这里读、往下传，而不是让
 * 这一页自己去摸 `useSearchParams()` / `window.location`：前者会把这棵客户端树推到
 * Suspense 边界外去客户端渲染，后者在服务端渲染那一帧读不到，只能靠挂载后 setState 补，
 * 于是输入框先空一帧再跳出内容。搜索参数本来就是这一页的入参，从入参进来最省事。
 */
export default async function AdvisorPage({
  params,
  searchParams,
}: PageProps<"/issues/[id]">) {
  const { id } = await params;
  const { quote } = await searchParams;
  return <AdvisorView id={id} quote={typeof quote === "string" ? quote : undefined} />;
}
