import { notFound, redirect } from "next/navigation";
import { serverApi } from "@/lib/api/client";

export async function loadWeeklyReview(cookie: string, weeklyReviewId: string) {
  const { data, response } = await serverApi.GET("/api/weekly-reviews/{weeklyReviewId}", { params: { path: { weeklyReviewId } }, headers: { cookie } });
  if (response.status === 401) redirect("/access");
  if (response.status === 404) notFound();
  if (!response.ok || !data) throw new Error(`Weekly review query failed with ${response.status}`);
  return data.review;
}
