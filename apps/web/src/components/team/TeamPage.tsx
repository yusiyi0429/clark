"use client";

/**
 * 老地址的「岗位」（/me/team，V2 看板那一套的个人菜单）：老页面的框里放新首页的二级页 RolesPage，同一份实现，
 * 能做的事和新首页里一样；点卡走 router。
 */
import { useRouter } from "next/navigation";
import { RolesPage } from "@/components/home/pages/RolesPage";
import s from "@/styles/v2-team.module.css";

export function TeamPage() {
  const router = useRouter();
  return (
    <div className={s.page} data-testid="team-page">
      <div className={s.wrap} data-type-scale="doc">
        <div className={s.top}><h1>岗位</h1></div>
        <RolesPage go={(href) => router.push(href)} />
      </div>
    </div>
  );
}
