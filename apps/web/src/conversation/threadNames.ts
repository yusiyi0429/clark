/**
 * 伙伴话里的会话名（本人 11/18）：伙伴主线上，伙伴的话里出现某个它开的会话的名字，那几个字带下划线，点了和点那个会话的小条一样。
 * 名字由 BuddyView 从派活卡收（会话还开着、首页数据里找得到的，用会话现在的名字），只在伙伴主线给 ThreadNamesContext；
 * 不靠模型写链接。这里只管把正文里的名字认出来，包成 `<span role="button" tabindex="0" data-thread="<key>">`（行内文字，放不下在中间折行；
 * 按钮在浏览器里是 inline-block，会整块挪到下一行）；点击和 Enter、空格由 BuddyView 那一层统一接。
 */
import { createContext } from "react";
import type { Plugin } from "unified";
import h from "@/styles/home.module.css";

/** key 形如 "topic:<id>"（会话的 kind:id）。 */
export type ThreadName = { title: string; key: string };

const NONE: readonly ThreadName[] = [];
export const ThreadNamesContext = createContext<readonly ThreadName[]>(NONE);

/** 名字至少几个字才加（太短的容易撞上普通的话）。 */
const MIN_CHARS = 4;
/** 这些元素里面的字不加：已有链接、行内代码、代码块（公式在 rehype-katex 之前也是 code）。 */
const SKIP = new Set(["a", "code", "pre"]);

type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/** 一段字里按顺序认名字：每个名字只认第一处（认过的从 left 里拿掉）；同一处能认成几个名字时取长的。 */
function mark(value: string, left: ThreadName[]): HastNode[] {
  const out: HastNode[] = [];
  let rest = value;
  for (;;) {
    let hit: { at: number; name: ThreadName } | null = null;
    for (const name of left) {
      const at = rest.indexOf(name.title);
      if (at >= 0 && (!hit || at < hit.at)) hit = { at, name };
    }
    if (!hit) break;
    if (hit.at > 0) out.push({ type: "text", value: rest.slice(0, hit.at) });
    out.push({ type: "element", tagName: "span", properties: { role: "button", tabIndex: 0, dataThread: hit.name.key, className: [h.threadLink] }, children: [{ type: "text", value: hit.name.title }] });
    rest = rest.slice(hit.at + hit.name.title.length);
    left.splice(left.indexOf(hit.name), 1);
  }
  if (rest) out.push({ type: "text", value: rest });
  return out;
}

/** 把正文里第一次出现的会话名包成 <span role="button" tabindex="0" data-thread="<key>">。 */
export function rehypeThreadNames(names: readonly ThreadName[]): Plugin {
  const usable = names.filter((name) => Array.from(name.title).length >= MIN_CHARS).sort((a, b) => b.title.length - a.title.length);
  return () => (tree: HastNode) => {
    const left = [...usable];
    const walk = (node: HastNode) => {
      if (!node.children || !left.length) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && left.length) return mark(child.value ?? "", left);
        if (child.type === "element" && !SKIP.has(child.tagName ?? "")) walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}
