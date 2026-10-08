"use client";

import { createContext, useContext, useLayoutEffect } from "react";
import type { Card } from "@/lib/api/client";
import type { ContextMarkKind } from "@/components/ContextMark";
import type { DetailGroup } from "@/conversation/missionCardGroup";
import type { QuoteSource } from "@/conversation/quotes";

/** 当前详情对象向外壳登记的信息：对话范围、窄条上的工作区标记。 */
export type DetailInfo = {
  scope: string;
  label: string;
  /** 窄条「当前工作区」标记；只有会议与月度材料显示（clark 同）。 */
  mark: ContextMarkKind | null;
  cards: Card[];
  group?: DetailGroup;
};

export type WorkspaceApi = {
  /** 打开对象、在对象间切换或回首页（"/"）。origin 是触发的来源元素，用于卡片 ⇄ 工作区转场。 */
  navigate: (href: string, origin?: Element | null) => void;
  /** 关闭当前详情：回到打开它的工作面（C-01），没有则回首页。 */
  close: () => void;
  detailOpen: boolean;
  closing: boolean;
  registerDetail: (info: DetailInfo | null) => void;
  showToast: (text: string) => void;
  /** 首页已载入的 Card 集合（战场/能力名称、会议安排等只读展示用，不另发请求）。 */
  homeCards: Card[];
  /** 引用正文追问：进入当前对象私聊，以独立引用块保留选文和来源，不改用户输入。 */
  quote: (text: string, source?: QuoteSource) => void;
  /** 打开当前对象的私聊，在输入条里预填一句并聚焦（执行事项的「起草文档」）；输入条里已有草稿就不覆盖。 */
  compose: (draft: string) => void;
  /** 当前登录 CEO 的 personId（战场卡据此判断「CEO 本人负责」）；测试桩默认 null。 */
  viewerId: string | null;
};

export const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function useWorkspace(): WorkspaceApi {
  const api = useContext(WorkspaceContext);
  if (!api) throw new Error("useWorkspace must be used inside CeoWorkspace");
  return api;
}

/** 详情页挂载时登记自己，卸载时撤销。 */
export function useRegisterDetail(info: DetailInfo) {
  const { registerDetail } = useWorkspace();
  const { scope, label, mark, cards, group } = info;
  useLayoutEffect(() => {
    registerDetail({ scope, label, mark, cards, group });
  }, [registerDetail, scope, label, mark, cards, group]);
  useLayoutEffect(() => () => registerDetail(null), [registerDetail]);
}
