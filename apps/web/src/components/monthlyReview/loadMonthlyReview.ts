import { notFound, redirect } from "next/navigation";
import { serverApi } from "@/lib/api/client";

export async function loadMonthlyReviewItem(cookie: string, itemId: string) {
  const { data, response } = await serverApi.GET("/api/monthly-review-items/{itemId}", { params: { path: { itemId } }, headers: { cookie } });
  if (response.status === 401) redirect("/access");
  if (response.status === 404) notFound();
  if (!response.ok || !data) throw new Error(`Monthly review item query failed with ${response.status}`);
  return data.item;
}

export async function loadMonthlyReview(cookie: string, period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) notFound();
  const { data, response } = await serverApi.GET("/api/monthly-reviews/{period}", { params: { path: { period } }, headers: { cookie } });
  if (response.status === 401) redirect("/access");
  if (response.status === 403 || response.status === 404) notFound();
  if (!response.ok || !data) throw new Error(`Monthly review query failed with ${response.status}`);
  return data;
}

export async function loadPersonalReview(cookie: string, personalReviewId: string) {
  const { data, response } = await serverApi.GET("/api/personal-reviews/{personalReviewId}", { params: { path: { personalReviewId } }, headers: { cookie } });
  if (response.status === 401) redirect("/access");
  if (response.status === 404) notFound();
  if (!response.ok || !data) throw new Error(`Personal review query failed with ${response.status}`);
  return data.review;
}
