"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE_NAME } from "@/lib/access";
import { WHO_COOKIE_NAME } from "@/lib/identity";

/** 清掉浏览器里两种身份凭据，再回到同一扇登录门。 */
export async function logOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE_NAME);
  jar.delete(WHO_COOKIE_NAME);
  redirect("/access");
}
