"use client";

/**
 * 右边的 thread 视图（设计 6.6）：一个子会话放在右边面板位里看，宽度用文件预览那一档。页头是子会话名，右上「放大」（去中间开这个子会话，面板关掉）和关闭。
 * 里面是卡、专题子会话页的窄面板模式（pane）：它们自己的详情、文件就地开（外面的面板位对它们不可见，不会把自己换掉），不画外壳的返回、会话按钮和上一级。
 * 打开、开着时又有新的停下，都记一次「看过」（同左栏、会话面板点行）。
 * from：伙伴主线上、从主线开的会话，会话名下面一行淡字「项目名 · 从主线开的」；「随手」的会话给空，只写「从主线开的」（本人 11/19）。ask：会话等着项目绑文件夹时钉在专题输入框上方的「在哪个文件夹开工？」。
 */
import { useContext, useEffect, type ReactNode } from "react";
import { Maximize2, X } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { CardSession } from "@/components/cards/CardSession";
import { TopicSession } from "@/components/topics/TopicSession";
import { subQueueText } from "@/lib/home/derive";
import type { SubSession } from "@/lib/home/types";
import { SideDetailContext } from "./SideDetail";
import { ICON } from "./StateIcon";
import { SeenContext, subHref } from "./SubRows";
import { ViewChrome } from "./view";
import h from "@/styles/home.module.css";

const NO_CHROME = { lead: null, trail: null, parent: null };

export function ThreadPane({ sub, go, onClose, from = null, ask = null }: { sub: SubSession; go: (href: string) => void; onClose: () => void; from?: string | null; ask?: ReactNode }) {
  const { onOpen } = useContext(SeenContext);
  useEffect(() => { onOpen?.("sub", sub.id, sub.updatedAt); }, [onOpen, sub.id, sub.updatedAt]);
  const queued = subQueueText(sub, true);
  return (
    <div className={h.side} data-testid="side-thread">
      <div className={h.sideHead}>
        <div className={h.threadHead}>
          <span className={h.threadTitle}>{sub.title}</span>
          {from !== null ? <span className={h.threadFrom} data-testid="thread-from">{from ? `${from} · 从主线开的` : "从主线开的"}</span> : null}
        </div>
        <HeroButton variant="ghost" size="sm" isIconOnly title="放大" aria-label="放大" onPress={() => { onClose(); go(subHref(sub)); }} data-testid="thread-wide"><Maximize2 {...ICON} /></HeroButton>
        <HeroButton variant="ghost" size="sm" isIconOnly title="关闭" aria-label="关闭" onPress={onClose} data-testid="thread-close"><X {...ICON} /></HeroButton>
      </div>
      <div className={h.threadBody}>
        <SideDetailContext.Provider value={null}>
          <ViewChrome.Provider value={NO_CHROME}>
            {sub.kind === "card"
              ? <CardSession key={sub.id} cardId={sub.id} embedded pane waiting={sub.waiting} queued={queued} />
              : <TopicSession key={sub.id} topicId={sub.id} embedded pane waiting={sub.waiting} queued={queued} ask={ask} />}
          </ViewChrome.Provider>
        </SideDetailContext.Provider>
      </div>
    </div>
  );
}
