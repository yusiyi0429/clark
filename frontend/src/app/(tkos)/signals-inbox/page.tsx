import { redirect } from "next/navigation";

/**
 * 待挑的信号不再是一页 —— 它是潜在议题那一屏的下半段（`components/signals-inbox.tsx`
 * 开头写了为什么）。这个路径留着，是给旧书签和别处记下的链接一条路：落到那一段上。
 */
export default function SignalsInboxPage() {
  redirect("/signals#inbox");
}
