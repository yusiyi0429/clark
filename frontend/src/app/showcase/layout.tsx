/**
 * showcase 的外壳:不套任何生产导航——这是独立于产品之外的一次性演示页
 * (取舍全写在 showcase-view.tsx 顶部)。三栏骨架要一个确定的视口高度才不溢出,
 * 所以这里给 `h-screen`,不是别处默认的 `min-h-full`。
 */
export default function ShowcaseLayout({ children }: LayoutProps<"/showcase">) {
  return <div className="h-screen bg-paper">{children}</div>;
}
