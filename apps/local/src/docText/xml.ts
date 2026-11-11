// 够用的 XML 读取：逐个标签回调（大表格用），或建成一棵树（Word 用）。
// 元素名、属性名都去掉命名空间前缀（w:p → p）。不处理 DOCTYPE 里定义的实体，不联网取任何东西。
import { DocTextError } from "./limits.js";
import type { ZipReader } from "./zip.js";

export interface XmlHandler {
  open(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  close(name: string): void;
  text(text: string): void;
}

export function scanXml(xml: string, h: XmlHandler): void {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) h.text(decode(xml.slice(i, textEnd)));
    if (lt < 0) break;
    if (xml.startsWith("<!--", lt)) {
      i = after(xml, "-->", lt + 4);
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw bad();
      h.text(xml.slice(lt + 9, end));
      i = end + 3;
    } else if (xml.startsWith("<?", lt)) {
      i = after(xml, "?>", lt + 2);
    } else if (xml.startsWith("<!", lt)) {
      // DOCTYPE：整段跳过，带内部子集的跳到 "]>"
      const gt = xml.indexOf(">", lt);
      const br = xml.indexOf("[", lt);
      i = br >= 0 && (gt < 0 || br < gt) ? after(xml, "]>", br) : after(xml, ">", lt);
    } else if (xml[lt + 1] === "/") {
      const gt = xml.indexOf(">", lt);
      if (gt < 0) throw bad();
      h.close(local(xml.slice(lt + 2, gt).trim()));
      i = gt + 1;
    } else {
      // 开标签：找到不在引号里的 ">"
      let j = lt + 1;
      let quote = "";
      for (; j < n; j++) {
        const c = xml[j];
        if (quote) { if (c === quote) quote = ""; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      if (j >= n) throw bad();
      let body = xml.slice(lt + 1, j);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const m = /^[^\s]+/.exec(body);
      if (!m) throw bad();
      const attrs: Record<string, string> = {};
      const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      re.lastIndex = m[0].length;
      for (let a = re.exec(body); a; a = re.exec(body)) {
        if (a[1].startsWith("xmlns")) continue;
        attrs[local(a[1])] = decode(a[2] ?? a[3] ?? "");
      }
      const name = local(m[0]);
      h.open(name, attrs, selfClosing);
      if (selfClosing) h.close(name);
      i = j + 1;
    }
  }
}

export interface XNode { name: string; attrs: Record<string, string>; children: Array<XNode | string> }

export function parseTree(xml: string): XNode {
  const root: XNode = { name: "", attrs: {}, children: [] };
  const stack: XNode[] = [root];
  scanXml(xml, {
    open(name, attrs) {
      const node: XNode = { name, attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    },
    close() {
      if (stack.length <= 1) throw bad();
      stack.pop();
    },
    text(t) {
      stack[stack.length - 1].children.push(t);
    },
  });
  const top = root.children.find((c): c is XNode => typeof c !== "string");
  if (!top || stack.length !== 1) throw bad();
  return top;
}

export function kids(node: XNode, name?: string): XNode[] {
  return node.children.filter((c): c is XNode => typeof c !== "string" && (name === undefined || c.name === name));
}

export function kid(node: XNode | undefined, name: string): XNode | undefined {
  return node?.children.find((c): c is XNode => typeof c !== "string" && c.name === name);
}

/** 第一个叫这个名字的后代（深度优先）。 */
export function find(node: XNode, name: string): XNode | undefined {
  for (const c of node.children) {
    if (typeof c === "string") continue;
    if (c.name === name) return c;
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

export function ownText(node: XNode): string {
  return node.children.filter((c): c is string => typeof c === "string").join("");
}

// ---------- 部件关系（.rels） ----------

export interface Rel { id: string; type: string; target: string }

/** 读某个部件的关系表；目标解析成包内的绝对部件名（不带开头斜杠）。外部链接不要。 */
export function readRels(zip: ZipReader, part: string): Rel[] {
  const slash = part.lastIndexOf("/");
  const dir = slash >= 0 ? part.slice(0, slash) : "";
  const file = part.slice(slash + 1);
  const xml = zip.readText(`${dir ? dir + "/" : ""}_rels/${file}.rels`);
  if (xml === null) return [];
  const out: Rel[] = [];
  for (const r of kids(parseTree(xml), "Relationship")) {
    if (r.attrs.TargetMode === "External" || !r.attrs.Target) continue;
    out.push({ id: r.attrs.Id ?? "", type: r.attrs.Type ?? "", target: resolvePart(dir, r.attrs.Target) });
  }
  return out;
}

export function relOfType(rels: Rel[], suffix: string): Rel | undefined {
  return rels.find((r) => r.type.endsWith(`/${suffix}`));
}

function resolvePart(dir: string, target: string): string {
  const parts = target.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

// ---------- 小工具 ----------

function local(qname: string): string {
  const c = qname.indexOf(":");
  return c >= 0 ? qname.slice(c + 1) : qname;
}

function decode(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    switch (e) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return '"';
      case "apos": return "'";
    }
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function after(xml: string, token: string, from: number): number {
  const at = xml.indexOf(token, from);
  if (at < 0) throw bad();
  return at + token.length;
}

function bad(): DocTextError {
  return new DocTextError("corrupt", "转不了：文件坏了，或者不是 Word / Excel 文件");
}
