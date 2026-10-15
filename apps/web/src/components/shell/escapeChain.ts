/**
 * Esc 的顺序（C-06，讨论台插在浮层之后、对话层之前）：
 * 模态对话框自己处理 → 输入框失焦 → 通知 peek → 窄屏对话浮层 → 讨论台 → 对话层 → 页内上一层（如会议页正在看的材料）→ 视图内上一级 → 关掉二级页。
 * 已被浮层 preventDefault 的 Esc、组词中的 Esc 由调用方在这之前挡掉。
 */
/** 页内上一层：二级页根节点上带这个属性（值 "true"）时，Esc 先派 ESCAPE_BACK_EVENT，由页面自己退一层。 */
export const ESCAPE_BACK_ATTR = "data-escape-back";
export const ESCAPE_BACK_EVENT = "workspace-escape-back";

export type EscapeContext = {
  modalOpen: boolean;
  editableFocused: boolean;
  peek: boolean;
  railMobileOpen: boolean;
  deskOpen: boolean;
  /** 全局对话层开着（或首页打字面开着）。 */
  conversationLayer: boolean;
  detailOpen: boolean;
  /** 二级页里还有一层可退（会议页正在看某份材料）：先回到这一页的主视图。 */
  innerBack?: boolean;
  parent: string | null;
};

export type EscapeStep =
  | { kind: "ignore" } | { kind: "blur" } | { kind: "peek" } | { kind: "railMobile" } | { kind: "desk" }
  | { kind: "conversation" } | { kind: "inner" } | { kind: "parent"; href: string } | { kind: "close" };

export function escapeStep(context: EscapeContext): EscapeStep {
  if (context.modalOpen) return { kind: "ignore" };
  if (context.editableFocused) return { kind: "blur" };
  if (context.peek) return { kind: "peek" };
  if (context.railMobileOpen) return { kind: "railMobile" };
  if (context.deskOpen) return { kind: "desk" };
  if (context.conversationLayer) return { kind: "conversation" };
  if (!context.detailOpen) return { kind: "ignore" };
  if (context.innerBack) return { kind: "inner" };
  return context.parent ? { kind: "parent", href: context.parent } : { kind: "close" };
}
