import type { ChatMessage } from "@/lib/data/types";

/** 递给模型的一轮。OpenAI 兼容那套的最小形状。 */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/**
 * 屏幕上那段对话 → 模型能读的几轮。
 *
 * 只带正文。回执、判断片、等您定的卡、装配清单都不带 —— 那些块是**给他看的物件**，
 * 把它们摊成文字塞回给模型，模型会以为那是它自己上一轮说过的话，然后在下一轮里模仿
 * 着编一张回执出来。物件由这一侧根据真实对象库生成，不进对话历史。
 *
 * 空的轮次直接扔掉：一条只有一枚判断片的消息在这里就是空的，而空的 assistant 轮会让
 * 上游把它当成一次没说完的生成。
 */
export const turnsFrom = (messages: ChatMessage[]): Turn[] =>
  messages
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.blocks
        .flatMap((b) => (b.type === "text" ? b.statements.map((s) => s.text) : []))
        .join("\n\n")
        .trim(),
    }))
    .filter((t) => t.content.length > 0);
