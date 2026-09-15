import { LiveData } from "@/components/live-data";

/**
 * DRI 与 CEO 侧共用同一套沉浸式工作台语言：页面自身承载导航与身份语境，
 * 这里不再额外叠加一层全局页头。
 */
export default function DriLayout({ children }: LayoutProps<"/dri">) {
  return (
    <div className="min-h-full">
      <LiveData />
      <main>{children}</main>
    </div>
  );
}
