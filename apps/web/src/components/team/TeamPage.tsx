"use client";

/**
 * 老地址 /me/team（V2 看板那一套）：老页面的框里放新首页的「连接和技能」，落在「技能」标签，同一份实现；点卡走 router。
 */
import { useRouter } from "next/navigation";
import { CustomizePage } from "@/components/home/pages/CustomizePage";
import s from "@/styles/v2-team.module.css";

export function TeamPage() {
  const router = useRouter();
  return (
    <div className={s.page} data-testid="team-page">
      <div className={s.wrap} data-type-scale="doc">
        <div className={s.top}><h1>连接和技能</h1></div>
        <CustomizePage initial="skills" go={(href) => router.push(href)} />
      </div>
    </div>
  );
}
