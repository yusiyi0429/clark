import { notFound, redirect } from "next/navigation";
import type { TRequestView } from "@warmap/contracts";
import { serverApi } from "@/lib/api/client";

/** 服务端读一条请求：看不到（不是发起人也不是接收人）按不存在处理。 */
export async function loadRequest(cookie: string, id: string): Promise<TRequestView> {
  const { data, response } = await serverApi.GET("/api/requests/{id}", { params: { path: { id } }, headers: { cookie } });
  if (response.status === 401) redirect("/access");
  if (response.status === 404) notFound();
  if (!data) throw new Error(`Request query failed with ${response.status}`);
  return data.request;
}
