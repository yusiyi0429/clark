import { LiveData } from "@/components/live-data";
import { StageNav } from "@/components/stage-nav";
import { APP_VERSION } from "@/lib/changelog";

/**
 * 所有页面共用的外壳：顶上一条导航，下面是那一页。
 *
 * 只有这一层 chrome。导航只认两个大类 —— 议题（主页 = 战略议题）与会议；上下游从对象
 * 本身走进去，不在顶栏里排成一条流水线（见 `stage-nav.tsx` 开头）。
 *
 * 版本号在**这里**读、当字符串传下去：`StageNav` 是客户端组件，让它自己 import
 * `lib/changelog` 会把整份日志正文（几十条中文）塞进每一页的 JS 包，而那些字
 * 只有 `/changelog` 那一页要用。真源仍然只有一个。
 *
 * `LiveData` 不画东西，它是那条「库改过了」的连接。放在外壳里是因为换页时 `layout`
 * 不重挂 —— 一条连接活过整个会话，而不是每开一页开一条（见 `components/live-data.tsx`）。
 */
export default function TkosLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-full flex-col">
      <LiveData />
      <StageNav version={APP_VERSION} />
      <main className="flex-1">{children}</main>
    </div>
  );
}
