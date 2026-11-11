"use client";

/**
 * 预览里的「改动」（设计第 72 条第一步）：照排好版的样子画，删掉的字划线淡红底，加的字淡绿底；没改的收起来，每处上下各留两块。
 * 位置由本机给（lib/local/fileChanges），这里只照位置画。一段标不准时整块标（改前那块划掉、改后那块标绿）。
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { HeroButton } from "@/components/HeroButton";
import { REMARK_PLUGINS } from "@/lib/markdown";
import { DEL_CLOSE, DEL_OPEN, ID_BASE, INS_CLOSE, INS_OPEN, foldSame, markedSource, sideText, type DiffMode, type Section } from "@/lib/local/fileChanges";
import c from "@/styles/change-view.module.css";

/** 上一处、下一处走的一站：能只标那几个字的每处一站；整块标的一段算一站。 */
export type NavStop = { key: string; ids: string[] };
export function navStops(sections: readonly Section[]): NavStop[] {
  return sections.flatMap((section) => section.kind !== "change" ? []
    : section.inline ? section.ids.map((id) => ({ key: id, ids: [id] }))
    : [{ key: section.ids[0]!, ids: section.ids }]);
}

type HNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HNode[] };
const BLOCK_PARENTS = new Set(["ul", "ol", "table", "thead", "tbody", "tr", "blockquote"]);
const BLOCK_CHILD = /^(p|ul|ol|pre|blockquote|table|h[1-6])$/;

/**
 * 把源文里的记号换成标记（rehype 插件）：记号可以跨几个文字节点（比如一处改动从加粗里跨出来），按文档顺序一路记着在哪一处里。
 * 块和块之间的空白不包（不然在两块之间多一个小色块）。buttons：每处后面放「恢复这处」（表格、一段里几处时用）。
 */
export function rehypeChangeMarks({ ids, hasIns, buttons }: { ids: readonly string[]; hasIns: readonly boolean[]; buttons: boolean }) {
  return () => (tree: HNode) => {
    let mode: "del" | "ins" | null = null;
    let index = -1;
    let expectId = false;
    const anchored = new Set<number>();
    const visit = (parent: HNode) => {
      const out: HNode[] = [];
      const blocky = parent.type === "root" || BLOCK_PARENTS.has(parent.tagName ?? "")
        || (parent.tagName === "li" && !!parent.children?.some((child) => child.type === "element" && BLOCK_CHILD.test(child.tagName ?? "")));
      const revert = (): HNode => ({ type: "element", tagName: "button", properties: { dataRevert: ids[index] }, children: [] });
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
          if (ch === DEL_CLOSE || ch === INS_CLOSE) {
            flush();
            mode = null;
            // 每处的最后一截后面放按钮：有加上的放在加上的后面，只删掉的放在删掉的后面。
            if (buttons && (ch === INS_CLOSE || !hasIns[index])) out.push(revert());
            continue;
          }
          buffer += ch;
        }
        flush();
      }
      parent.children = out;
    };
    visit(tree);
  };
}

type Revert = { disabled: boolean; run: (ids: string[]) => void } | null;
const RevertContext = createContext<Revert>(null);

function RevertButton({ ids, className }: { ids: string[]; className?: string }) {
  const revert = useContext(RevertContext);
  if (!revert) return null;
  return <HeroButton variant="ghost" size="sm" className={className} isDisabled={revert.disabled} onPress={() => revert.run(ids)} data-testid="revert-change">恢复这处</HeroButton>;
}

const MARK_COMPONENTS = {
  button: ({ "data-revert": id }: { "data-revert"?: string }) => (id ? <RevertButton ids={[id]} className={c.inlineRevert} /> : null),
};

function Chunk({ text, mode }: { text: string; mode: DiffMode }) {
  if (!text) return null;
  if (mode === "text") return <pre className={c.code}>{text.replace(/\n$/, "")}</pre>;
  return <Markdown remarkPlugins={REMARK_PLUGINS}>{text}</Markdown>;
}

function ChangeSection({ section, mode, on }: { section: Extract<Section, { kind: "change" }>; mode: DiffMode; on: boolean }) {
  const single = section.ids.length === 1;
  // 能只标那几个字、只有一处、不是表格：「恢复这处」放在这一块下面（示意）；一段里几处、表格里的放在每处后面。
  const bar = !section.inline || (single && !section.table);
  let body: ReactNode;
  if (!section.inline) {
    const before = sideText(section.parts, "before");
    const after = sideText(section.parts, "after");
    body = (
      <>
        {before ? <div className={c.blockDel} data-block="del"><Chunk text={before} mode={mode} /></div> : null}
        {after ? <div className={c.blockIns} data-block="ins"><Chunk text={after} mode={mode} /></div> : null}
      </>
    );
  } else if (mode === "text") {
    const seen = new Set<string>();
    body = (
      <pre className={c.code}>
        {section.parts.map((part, index) => {
          if (part.kind === "same") return index === section.parts.length - 1 ? part.text.replace(/\n$/, "") : part.text;
          const anchor = seen.has(part.id) ? undefined : part.id;
          seen.add(part.id);
          return (
            <span key={index}>
              {part.del ? <del className={c.del} data-change={part.id} data-anchor={anchor}>{part.del}</del> : null}
              {part.ins ? <ins className={c.ins} data-change={part.id} data-anchor={part.del ? undefined : anchor}>{part.ins}</ins> : null}
              {bar ? null : <RevertButton ids={[part.id]} className={c.inlineRevert} />}
            </span>
          );
        })}
      </pre>
    );
  } else {
    body = (
      <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={[rehypeChangeMarks({ ids: section.ids, hasIns: section.parts.flatMap((part) => part.kind === "change" ? [!!part.ins] : []), buttons: !bar })]} components={MARK_COMPONENTS as never}>
        {markedSource(section.parts)}
      </Markdown>
    );
  }
  return (
    <div className={c.hunk} data-on={on ? "" : undefined} data-region={section.ids.join(" ")} data-inline={section.inline ? "" : undefined} data-testid="change-hunk">
      {body}
      {bar ? <div className={c.hunkBar}><RevertButton ids={section.ids} /></div> : null}
    </div>
  );
}

function SameSection({ blocks, mode, first, last }: { blocks: string[]; mode: DiffMode; first: boolean; last: boolean }) {
  const [open, setOpen] = useState(false);
  const fold = foldSame(blocks, { first, last });
  if (open || !fold.hidden) return <Chunk text={blocks.join("")} mode={mode} />;
  return (
    <>
      <Chunk text={fold.head} mode={mode} />
      <button type="button" className={c.fold} onClick={() => setOpen(true)} data-testid="fold">没改的 {fold.hiddenLines} 行</button>
      <Chunk text={fold.tail} mode={mode} />
    </>
  );
}

/**
 * sections：diffLayout 摆好的；current：现在走到的那一站（navStops 的 key），那一段淡底。
 * revert：给了才有「恢复这处」（新建、删掉的文件只有文件名旁边的「恢复」）；disabled 是一轮正在跑、正在恢复。
 */
export function ChangeView({ sections, mode, current, revert, className }: {
  sections: readonly Section[]; mode: DiffMode; current: string | null; revert: Revert; className?: string;
}) {
  return (
    <RevertContext.Provider value={revert}>
      <div className={className} data-testid="change-view">
        {sections.map((section, index) => section.kind === "same"
          ? <SameSection key={`s${index}:${section.blocks.length}`} blocks={section.blocks} mode={mode} first={index === 0} last={index === sections.length - 1} />
          : <ChangeSection key={section.ids.join(" ")} section={section} mode={mode} on={current !== null && section.ids.includes(current)} />)}
      </div>
    </RevertContext.Provider>
  );
}
