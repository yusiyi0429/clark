"use client";

/**
 * 预览里「改动」开着时的正文（设计第 72 条第一步）：全文照现有预览的排版，不折叠；改过的地方只有一种标法——
 * 改前的字淡色划线、没有底色，改后的字垫一种底色（--mark）。整段新加的整段垫底色，整段删掉的整段淡色划线。
 * 位置由本机给（lib/local/fileChanges），这里只照位置画；一段标不准时整块标。
 * 每处的元素带 data-change（这一处的 id，整块标的一段是几个 id 用空格连起来），第一个元素再带 data-anchor：预览拿它们点开「恢复」、画左边的小横线。
 */
import Markdown from "react-markdown";
import { REMARK_PLUGINS } from "@/lib/markdown";
import { DEL_CLOSE, DEL_OPEN, ID_BASE, INS_CLOSE, INS_OPEN, markedSource, sideText, type DiffMode, type Section } from "@/lib/local/fileChanges";
import c from "@/styles/change-view.module.css";

type HNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HNode[] };
const BLOCK_PARENTS = new Set(["ul", "ol", "table", "thead", "tbody", "tr", "blockquote"]);
const BLOCK_CHILD = /^(p|ul|ol|pre|blockquote|table|h[1-6])$/;

/**
 * 把源文里的记号换成标记（rehype 插件）：记号可以跨几个文字节点（比如一处改动从加粗里跨出来），按文档顺序一路记着在哪一处里。
 * 块和块之间的空白不包（不然两块之间多一个小色块）。
 */
export function rehypeChangeMarks({ ids }: { ids: readonly string[] }) {
  return () => (tree: HNode) => {
    let mode: "del" | "ins" | null = null;
    let index = -1;
    let expectId = false;
    const anchored = new Set<number>();
    const visit = (parent: HNode) => {
      const out: HNode[] = [];
      const blocky = parent.type === "root" || BLOCK_PARENTS.has(parent.tagName ?? "")
        || (parent.tagName === "li" && !!parent.children?.some((child) => child.type === "element" && BLOCK_CHILD.test(child.tagName ?? "")));
      for (const child of parent.children ?? []) {
        if (child.type !== "text") { if (child.children) visit(child); out.push(child); continue; }
        let buffer = "";
        const flush = () => {
          if (!buffer) return;
          if (!mode || (blocky && !buffer.trim())) out.push({ type: "text", value: buffer });
          else {
            const first = !anchored.has(index);
            anchored.add(index);
            out.push({ type: "element", tagName: mode, properties: { className: [mode === "del" ? c.del : c.ins], dataChange: ids[index], ...(first ? { dataAnchor: ids[index] } : {}) }, children: [{ type: "text", value: buffer }] });
          }
          buffer = "";
        };
        for (const ch of child.value ?? "") {
          if (expectId) { index = ch.charCodeAt(0) - ID_BASE; expectId = false; continue; }
          if (ch === DEL_OPEN || ch === INS_OPEN) { flush(); mode = ch === DEL_OPEN ? "del" : "ins"; expectId = true; continue; }
          if (ch === DEL_CLOSE || ch === INS_CLOSE) { flush(); mode = null; continue; }
          buffer += ch;
        }
        flush();
      }
      parent.children = out;
    };
    visit(tree);
  };
}

/** 一段源文照现有预览的样子画：Markdown 排版，别的等宽。 */
export function DocChunk({ text, mode }: { text: string; mode: DiffMode }) {
  if (!text) return null;
  if (mode === "text") return <pre className={c.code}>{text.replace(/\n$/, "")}</pre>;
  return <Markdown remarkPlugins={REMARK_PLUGINS}>{text}</Markdown>;
}

function ChangeSection({ section, mode }: { section: Extract<Section, { kind: "change" }>; mode: DiffMode }) {
  if (!section.inline) {
    const ids = section.ids.join(" ");
    const before = sideText(section.parts, "before");
    const after = sideText(section.parts, "after");
    return (
      <>
        {before ? <div className={c.blockDel} data-change={ids} data-anchor={ids} data-block="del"><DocChunk text={before} mode={mode} /></div> : null}
        {after ? <div className={c.blockIns} data-change={ids} data-anchor={before ? undefined : ids} data-block="ins"><DocChunk text={after} mode={mode} /></div> : null}
      </>
    );
  }
  if (mode === "text") {
    const last = section.parts.length - 1;
    return (
      <pre className={c.code}>
        {section.parts.map((part, index) => part.kind === "same" ? (index === last ? part.text.replace(/\n$/, "") : part.text) : (
          <span key={index}>
            {part.del ? <del className={c.del} data-change={part.id} data-anchor={part.id}>{part.del}</del> : null}
            {part.ins ? <ins className={c.ins} data-change={part.id} data-anchor={part.del ? undefined : part.id}>{part.ins}</ins> : null}
          </span>
        ))}
      </pre>
    );
  }
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={[rehypeChangeMarks({ ids: section.ids })]}>
      {markedSource(section.parts)}
    </Markdown>
  );
}

/** sections：diffLayout 摆好的全文（没改的照原文，改了的标出来）。 */
export function ChangeView({ sections, mode }: { sections: readonly Section[]; mode: DiffMode }) {
  return (
    <>
      {sections.map((section, index) => section.kind === "same"
        ? <DocChunk key={`s${index}`} text={section.text} mode={mode} />
        : <ChangeSection key={section.ids.join(" ")} section={section} mode={mode} />)}
    </>
  );
}
