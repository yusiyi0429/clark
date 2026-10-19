import { notFound, redirect } from "next/navigation";
import type { TAdminOverviewResponse } from "@warmap/contracts";
import { serverApi } from "@/lib/api/client";

/** 服务端读管理员视图：不是管理员（接口 404）按页面不存在处理。 */
export async function loadAdminOverview(cookie: string): Promise<TAdminOverviewResponse> {
  const { data, response } = await serverApi.GET("/api/admin/overview", { headers: { cookie } });
  if (response.status === 401) redirect("/access");
  if (response.status === 404) notFound();
  if (!data) throw new Error(`Admin overview query failed with ${response.status}`);
  return data;
}
