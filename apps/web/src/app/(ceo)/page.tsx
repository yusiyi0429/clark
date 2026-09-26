import { requireCeo } from "@/lib/api/server";

/** 首页看板与通知栏由 (ceo)/layout 常驻渲染；这里只负责登录守卫。 */
export default async function HomePage() {
  await requireCeo("/");
  return null;
}
