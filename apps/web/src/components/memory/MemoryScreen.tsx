"use client";

/**
 * 老地址的「我的记忆」：成员的 /me/memory、CEO 的 /memory。老外壳（DetailFrame）里放新首页的二级页 MemoryPage，同一份实现，
 * 能做的事和新首页里一样；跳去别处走老工作台的 navigate。
 */
import { useMemo } from "react";
import type { Card } from "@/lib/api/client";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { MemoryPage } from "@/components/home/pages/MemoryPage";
import s from "./memory.module.css";

const NO_CARDS: Card[] = [];

export function MemoryScreen({ role }: { role: "ceo" | "member" }) {
  const workspace = useWorkspace();
  useRegisterDetail(useMemo(() => ({ scope: "global", label: "我的记忆", mark: null, cards: NO_CARDS }), []));
  return (
    <div className={s.screen}>
      <DetailFrame title="我的记忆" onBack={() => workspace.close()}>
        <div className={s.content} data-type-scale="doc">
          <div className={s.stack}><MemoryPage role={role} go={(href) => workspace.navigate(href)} /></div>
        </div>
      </DetailFrame>
    </div>
  );
}
