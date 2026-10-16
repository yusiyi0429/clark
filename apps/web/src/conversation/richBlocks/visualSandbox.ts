/**
 * 自由图示块 ```visual（docs/superpowers/specs/2026-10-10-discussion-desk-design.md「对话里的富内容块」）：
 * 模型自己写 SVG，或只带内联样式的 HTML；宿主清洗后放进沙箱 iframe 渲染，并注入一套设计规范（CSS 变量、明暗两套、现成 class）。
 *
 * 三层隔离，任何一层单独失效，另外两层仍然挡住：
 * 1. 清洗（sanitizeVisual）：自己逐个读标签、再按白名单重新写出来，输出永远是规整的标记——
 *    去掉脚本、事件属性、链接（只留 #id 引用）、图片与嵌入、表单、meta / base / link，CSS 里去掉 @import、外部 url()、expression；
 * 2. CSP（visualDocument 写进 <meta http-equiv>）：default-src 'none'，不能联网、不能加载任何外部资源、不能提交表单；
 *    脚本只放行带本次随机 nonce 的那一段（宿主自己的量高脚本），模型写的脚本、事件属性、javascript: 一律不执行；
 * 3. 沙箱：sandbox="allow-scripts"，不给 allow-same-origin——文档是不透明源，读不到父页面的 DOM、cookie、存储，也不能以父页面身份请求接口；
 *    不给 allow-forms / allow-popups / allow-top-navigation / allow-modals。
 *
 * 为什么要 allow-scripts：iframe 是不透明源，父页面量不到里面的内容高度，只能由 iframe 里自己量、再 postMessage 回报。
 * 这段脚本是宿主写的（不是模型写的），由 CSP nonce 放行；模型的脚本仍然一律不执行。风险见 .superpowers/sdd/roadmap-and-visual.md。
 * 父页面收高度时校验三样：消息来自这个 iframe 的 contentWindow、origin 是 "null"（不透明源）、带本次的随机 token；高度再做范围检查。
 *
 * 这里只放纯函数（不依赖 DOM，服务端渲染、测试、浏览器里结果一致）。
 */

/** 图示源码上限（字符）：再长多半不是图示，退回原文。 */
export const VISUAL_SOURCE_MAX = 60_000;
/** iframe 回报的高度超出这个范围算尺寸异常（退回「图示无法显示」）。 */
export const VISUAL_MIN_HEIGHT = 8;
export const VISUAL_MAX_HEIGHT = 2_400;
/** SVG 按正文栏宽度缩放，最多缩到 viewBox 宽度的这么多倍（文字 13 → 约 10.4）；再窄就在框里横向滚动。手机底部 sheet 放宽到 0.7。 */
export const VISUAL_MIN_SCALE = 0.8;
export const VISUAL_SHEET_MIN_SCALE = 0.7;
/** 最多放大到 viewBox 宽度的这么多倍（放大视图里居中）。 */
export const VISUAL_MAX_SCALE = 1.25;
/** SVG viewBox 的合理范围与长宽比。 */
const VIEWBOX_MAX_W = 4_000, VIEWBOX_MAX_H = 8_000, ASPECT_MAX = 8;
/** 回报的高度超出范围后，等这么久（期间没有回到范围内）才算尺寸异常：刚排版时会先报 0 或几千。 */
export const VISUAL_SETTLE_MS = 1_200;
/** iframe 加载完后这么久还没回报高度，算无法显示。 */
export const VISUAL_REPORT_TIMEOUT_MS = 3_000;
/** iframe 回报高度的消息类型。 */
export const VISUAL_MESSAGE = "tkos-visual-size";

export type VisualFormat = "svg" | "html";
export type VisualBlock = {
  kind: "visual";
  title?: string;
  format: VisualFormat;
  /** 清洗后的标记（只含白名单内的元素与属性）。 */
  markup: string;
  /** SVG 的 viewBox 宽高（HTML 没有）。 */
  viewBox?: { width: number; height: number };
  /** 原文（退回时可展开看）。 */
  source: string;
};

/* ── 清洗 ── */

const HTML_ELEMENTS = new Set([
  "div", "span", "p", "b", "strong", "i", "em", "small", "s", "u", "mark", "sub", "sup", "br", "hr", "wbr", "code", "abbr",
  "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "section", "article", "header", "footer", "aside", "figure", "figcaption", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6",
  "details", "summary", "style",
]);
/** SVG 元素：小写 → 原样大小写（HTML 解析器按这个大小写放进 SVG 命名空间）。 */
const SVG_ELEMENTS = new Map([
  "svg", "g", "defs", "symbol", "use", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath",
  "marker", "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask", "title", "desc", "foreignObject", "style",
].map((name) => [name.toLowerCase(), name]));
const VOID_ELEMENTS = new Set(["br", "hr", "wbr", "col"]);
/** 连同内容一起去掉的元素（嵌入、脚本、表单控件、媒体）。 */
const DROP_WITH_CONTENT = new Set([
  "script", "iframe", "frame", "frameset", "object", "applet", "noscript", "noembed", "noframes", "template", "textarea", "select",
  "option", "optgroup", "datalist", "audio", "video", "canvas", "math", "portal", "xmp", "plaintext", "head", "title",
  "image", "feimage", "animate", "animatemotion", "animatetransform", "set", "discard", "handler", "listener",
]);
/** 内容按原文读到闭合标签为止的元素。 */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "noembed", "noframes", "iframe", "plaintext"]);
/** 不认识的空元素：直接去掉（不进栈）。 */
const DROP_VOID = new Set(["img", "input", "link", "meta", "base", "source", "track", "param", "area", "keygen", "embed", "basefont", "bgsound", "picture"]);
/** 一律去掉的属性。 */
const DROP_ATTRIBUTES = new Set([
  "src", "srcset", "srcdoc", "action", "formaction", "background", "poster", "data", "codebase", "classid", "ping", "target", "download",
  "http-equiv", "content", "is", "autofocus", "form", "formtarget", "manifest", "lowsrc", "dynsrc", "xmlns:xlink", "xml:base", "attributename",
  "contenteditable", "nonce", "integrity", "crossorigin", "referrerpolicy", "slot",
]);

export type SanitizeReport = {
  markup: string;
  /** 读完时还有没闭合的元素、注释或标签（流式中没收全，或写坏了）。 */
  incomplete: boolean;
  /** 顶层元素（不含 style）：小写名与它的属性。 */
  roots: { name: string; attributes: Map<string, string> }[];
  /** 去掉了多少处（元素、属性、CSS 片段）：测试与日志用。 */
  removed: number;
  /** 可见文字与图形元素的数量：都没有就是空图。 */
  visibleText: number;
  shapes: number;
};

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", rarr: "→", larr: "←", uarr: "↑", darr: "↓", times: "×", mdash: "—", ndash: "–", hellip: "…" };

/** 解开 HTML 字符引用（属性值、文字）：判断「是不是外部地址、是不是脚本」前先解开，免得 &#106;avascript: 混过去。 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, "&quot;");

/** 解开 CSS 转义（\75 rl( → url(），再判断；输出用解开后的文字。 */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\([0-9a-f]{1,6})\s?/gi, (_m, hex: string) => {
    const code = parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  }).replace(/\\(.)/g, "$1").replace(/\\/g, "");
}

/**
 * CSS 清洗（<style> 内容与 style 属性）：去掉 @import / @font-face / @namespace / @charset，外部 url()、image-set()、
 * expression()、behavior、-moz-binding、javascript:；url(#id)（渐变、箭头、裁剪的文档内引用）保留。
 */
export function sanitizeCss(css: string): { css: string; removed: number } {
  let removed = 0;
  const count = (pattern: RegExp, replacement: string) => (text: string) => text.replace(pattern, () => { removed += 1; return replacement; });
  let text = decodeCssEscapes(css).replace(/\/\*[\s\S]*?(\*\/|$)/g, "");
  text = count(/@import[^;]*;?/gi, "")(text);
  text = count(/@(font-face|namespace|charset|property|document|-moz-document)[^{;]*(\{[^}]*\}|;)?/gi, "")(text);
  text = count(/url\(\s*(?!['"]?\s*#)[^)]*\)?/gi, "none")(text);
  text = count(/(-webkit-)?(image-set|cross-fade|image|element|src)\s*\((?:[^()]|\([^()]*\))*\)?/gi, "none")(text);
  text = count(/expression\s*\(|behavior\s*:|-moz-binding|javascript\s*:|vbscript\s*:/gi, "")(text);
  // 不让 </style> 之类从样式里断出去。
  text = text.replace(/</g, "\\3c ");
  return { css: text.trim(), removed };
}

/** 属性值里有没有指向外部的东西：url() 只认 #id，javascript: / data: / 带协议的地址都不要。 */
function externalReference(value: string): boolean {
  const compact = decodeEntities(value).replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
  if (/(javascript|vbscript|data|livescript|mocha):/.test(compact)) return true;
  if (/url\((?!['"]?#)/.test(compact)) return true;
  return false;
}

type ParsedAttribute = { name: string; value: string };

function parseAttributes(text: string): ParsedAttribute[] {
  const list: ParsedAttribute[] = [];
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of text.matchAll(pattern)) {
    list.push({ name: match[1], value: decodeEntities(match[2] ?? match[3] ?? match[4] ?? "") });
  }
  return list;
}

/** 一个属性留不留、留下来写成什么；返回 null 去掉。 */
function cleanAttribute(element: string, attribute: ParsedAttribute, count: () => void): string | null {
  const name = attribute.name;
  const lower = name.toLowerCase();
  if (!/^[a-zA-Z_][-a-zA-Z0-9_:.]*$/.test(name)) { count(); return null; }
  if (lower.startsWith("on") || DROP_ATTRIBUTES.has(lower)) { count(); return null; }
  if (lower === "href" || lower === "xlink:href") {
    const value = attribute.value.trim();
    // 只认文档内引用（<use href="#node">、<textPath href="#arc">）。
    if (!/^#[A-Za-z_][-\w.:]*$/.test(value)) { count(); return null; }
    return `${name}="${escapeAttribute(value)}"`;
  }
  if (lower === "style") {
    const cleaned = sanitizeCss(attribute.value);
    if (cleaned.removed) count();
    return cleaned.css ? `style="${escapeAttribute(cleaned.css)}"` : null;
  }
  if (externalReference(attribute.value)) { count(); return null; }
  if (element === "svg" && lower === "xmlns") return null;
  return attribute.value === "" && !/^(aria-|data-)/.test(lower) && lower !== "alt" ? `${name}` : `${name}="${escapeAttribute(attribute.value)}"`;
}

type StackEntry = { name: string; emit: boolean; svg: boolean; html: boolean; drop: boolean };

/**
 * 清洗模型写的图示：逐个读标签，只按白名单重新写出（读的方式与浏览器不一样也没关系：写出来的是规整标记，浏览器怎么读都等于我们读到的）。
 * 不合法的标签、注释、处理指令一律不写出；没闭合的元素在结尾补上闭合，并把 incomplete 置真。
 */
export function sanitizeVisual(source: string): SanitizeReport {
  let out = "";
  let removed = 0;
  let incomplete = false;
  let visibleText = 0, shapes = 0;
  const count = () => { removed += 1; };
  const stack: StackEntry[] = [];
  const roots: SanitizeReport["roots"] = [];
  const inSvg = () => { for (let index = stack.length - 1; index >= 0; index--) { if (stack[index].html) return false; if (stack[index].svg) return true; } return false; };
  const dropping = () => stack.some((entry) => entry.drop);
  const close = (entry: StackEntry) => { if (entry.emit) out += `</${entry.name}>`; };
  let index = 0;
  const length = source.length;
  while (index < length) {
    const lt = source.indexOf("<", index);
    const textEnd = lt < 0 ? length : lt;
    if (textEnd > index) {
      const text = source.slice(index, textEnd);
      if (!dropping()) {
        const decoded = decodeEntities(text);
        if (stack.length) {
          out += escapeText(decoded);
          visibleText += decoded.trim().length;
        } else if (decoded.trim()) count(); // 顶层的散字不要
      }
      index = textEnd;
      if (lt < 0) break;
    }
    // index 指向 "<"
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end < 0) { incomplete = true; break; }
      index = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index + 9);
      if (end < 0) { incomplete = true; break; }
      const text = source.slice(index + 9, end);
      if (!dropping() && stack.length) { out += escapeText(text); visibleText += text.trim().length; }
      index = end + 3;
      continue;
    }
    if (source[index + 1] === "!" || source[index + 1] === "?") {
      const end = source.indexOf(">", index);
      if (end < 0) { incomplete = true; break; }
      index = end + 1;
      continue;
    }
    const closing = source[index + 1] === "/";
    const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(source.slice(index + (closing ? 2 : 1), index + (closing ? 2 : 1) + 64));
    if (!nameMatch) {
      // 不是标签的「<」（如「A < B」）：当文字写出。
      if (!dropping() && stack.length) out += "&lt;";
      index += 1;
      continue;
    }
    // 读到这个标签的「>」（跳过引号里的）。
    let cursor = index + (closing ? 2 : 1) + nameMatch[0].length;
    let quote: string | null = null;
    for (; cursor < length; cursor++) {
      const char = source[cursor];
      if (quote) { if (char === quote) quote = null; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === ">") break;
    }
    if (cursor >= length) { incomplete = true; break; }
    const rawName = nameMatch[0];
    const lower = rawName.toLowerCase();
    const inner = source.slice(index + (closing ? 2 : 1) + rawName.length, cursor);
    index = cursor + 1;

    if (closing) {
      const at = stack.map((entry) => entry.name.toLowerCase()).lastIndexOf(lower);
      if (at < 0) { count(); continue; }
      while (stack.length > at) close(stack.pop()!);
      continue;
    }

    const selfClosing = /\/\s*$/.test(inner);
    const svgContext = inSvg();
    const parentDrop = dropping();

    // 原文元素（script、style…）：内容读到闭合标签为止。
    if (RAW_TEXT.has(lower) && !(svgContext && lower === "title") && !selfClosing) {
      const closeAt = source.toLowerCase().indexOf(`</${lower}`, index);
      if (closeAt < 0) { incomplete = true; break; }
      const content = source.slice(index, closeAt);
      const closeEnd = source.indexOf(">", closeAt);
      index = closeEnd < 0 ? length : closeEnd + 1;
      if (closeEnd < 0) incomplete = true;
      if (lower === "style" && !parentDrop) {
        const cleaned = sanitizeCss(content);
        removed += cleaned.removed;
        if (cleaned.css) out += `<style>${cleaned.css}</style>`;
      } else count();
      continue;
    }

    if (parentDrop) {
      if (!selfClosing && !VOID_ELEMENTS.has(lower) && !DROP_VOID.has(lower)) stack.push({ name: rawName, emit: false, svg: false, html: false, drop: true });
      continue;
    }
    if (DROP_VOID.has(lower)) { count(); continue; }
    if (DROP_WITH_CONTENT.has(lower) && !(svgContext && lower === "title")) {
      count();
      if (!selfClosing) stack.push({ name: rawName, emit: false, svg: false, html: false, drop: true });
      continue;
    }

    const svgName = svgContext || lower === "svg" ? SVG_ELEMENTS.get(lower) : undefined;
    const htmlAllowed = !svgContext && HTML_ELEMENTS.has(lower) && lower !== "style";
    if (!svgName && !htmlAllowed) {
      // 不认识的元素、链接 <a>、表单外壳：去掉标签、留下里面的内容。
      count();
      if (!selfClosing && !VOID_ELEMENTS.has(lower)) stack.push({ name: rawName, emit: false, svg: false, html: false, drop: false });
      continue;
    }
    const name = svgName ?? lower;
    const attributes = parseAttributes(selfClosing ? inner.replace(/\/\s*$/, "") : inner)
      .map((attribute) => cleanAttribute(lower, attribute, count)).filter((value): value is string => value !== null);
    if (stack.length === 0) {
      roots.push({ name: lower, attributes: new Map(parseAttributes(inner.replace(/\/\s*$/, "")).map((attribute) => [attribute.name.toLowerCase(), attribute.value])) });
    }
    if (svgName && !["svg", "g", "defs", "symbol", "marker", "title", "desc", "style", "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask", "text", "tspan", "textPath", "foreignObject"].includes(svgName)) shapes += 1;
    if (svgName === "svg" && stack.length === 0) attributes.unshift('xmlns="http://www.w3.org/2000/svg"');
    const open = `<${name}${attributes.length ? ` ${attributes.join(" ")}` : ""}`;
    if (svgName && selfClosing) { out += `${open}/>`; continue; }
    if (!svgName && VOID_ELEMENTS.has(lower)) { out += `${open}>`; continue; }
    out += `${open}>`;
    if (!svgName && selfClosing) { out += `</${name}>`; continue; }
    stack.push({ name, emit: true, svg: Boolean(svgName) && name === "svg", html: name === "foreignObject" ? true : !svgName, drop: false });
  }
  if (stack.length) incomplete = true;
  while (stack.length) close(stack.pop()!);
  return { markup: out, incomplete, roots, removed, visibleText, shapes };
}

/** viewBox="0 0 560 320" → 宽高；不合法为 null。 */
export function readViewBox(value: string | undefined): { width: number; height: number } | null {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [, , width, height] = parts;
  if (width <= 0 || height <= 0 || width > VIEWBOX_MAX_W || height > VIEWBOX_MAX_H) return null;
  return { width, height };
}

const TITLE_MAX = 24;

/**
 * 解析一个 ```visual 块：清洗、判断收全没有、读标题与 viewBox。没收全、空图、尺寸异常一律 null（界面画骨架或退回「图示无法显示」）。
 * - 顶层可以先有一个 <style>，然后是一个或几个元素；只有一个 <svg> 时按 SVG 排（按正文栏宽度缩放），其余按 HTML 排（自适应宽度）；
 * - SVG 必须有 viewBox，或者有数字的 width / height（换成 viewBox）；长宽比超过 8 倍算尺寸异常；
 * - 标题取根元素的 aria-label，没有就取 SVG 里的 <title>。
 */
export function parseVisual(source: string): VisualBlock | null {
  const text = source.trim();
  if (!text || text.length > VISUAL_SOURCE_MAX || !text.startsWith("<")) return null;
  const report = sanitizeVisual(text);
  if (report.incomplete || report.roots.length === 0) return null;
  if (report.visibleText === 0 && report.shapes === 0) return null;
  const single = report.roots.length === 1 ? report.roots[0] : null;
  let markup = report.markup;
  let viewBox: VisualBlock["viewBox"];
  let format: VisualFormat = "html";
  if (single?.name === "svg") {
    format = "svg";
    const read = readViewBox(single.attributes.get("viewbox"));
    if (read) viewBox = read;
    else {
      const width = Number.parseFloat(single.attributes.get("width") ?? ""), height = Number.parseFloat(single.attributes.get("height") ?? "");
      const fallback = Number.isFinite(width) && Number.isFinite(height) ? readViewBox(`0 0 ${width} ${height}`) : null;
      if (!fallback) return null;
      viewBox = fallback;
      markup = markup.replace(/<svg\b/, `<svg viewBox="0 0 ${fallback.width} ${fallback.height}"`);
    }
    const ratio = viewBox.width / viewBox.height;
    if (ratio > ASPECT_MAX || ratio < 1 / ASPECT_MAX) return null;
    // 宽高交给宿主的样式（按栏宽缩放）：去掉根上写死的 width / height（清洗后样式里的「<」已转义，第一个 <svg 就是根）。
    markup = markup.replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(width|height)="[^"]*"/g, ""));
  }
  const label = single?.attributes.get("aria-label")?.trim()
    || (format === "svg" ? /<title>([^<]{1,80})<\/title>/.exec(markup)?.[1]?.trim() : undefined);
  const title = label ? [...decodeEntities(label)].slice(0, TITLE_MAX).join("") : undefined;
  return { kind: "visual", ...(title ? { title } : {}), format, markup, ...(viewBox ? { viewBox } : {}), source: text };
}

/** 流式中还没收全：从已到的根元素上先读出 aria-label 当骨架标题。 */
export function partialVisualTitle(source: string): string | null {
  const match = /^\s*(?:<style[\s\S]*?<\/style>\s*)?<[a-zA-Z][^>]*?\saria-label\s*=\s*"([^"]{1,80})"/.exec(source);
  const title = match?.[1]?.trim();
  return title ? [...decodeEntities(title)].slice(0, TITLE_MAX).join("") : null;
}

/* ── 沙箱文档 ── */

export type VisualTheme = "light" | "dark";

/**
 * 设计规范（注入 iframe 的 CSS 变量；颜色取自对话浅色阅读面与首页战况面，深色一套取自对话深色面）：
 * 字号 16 数值 / 13 名称正文 / 12 标签，标题 14；间距 4 / 8 / 12 / 16 / 24；圆角 6 / 10 / 14。
 */
export const VISUAL_TOKENS: Record<VisualTheme, Record<string, string>> = {
  light: {
    "--ink": "#1d1d1f", "--text": "#25282e", "--text-2": "#666d76", "--text-3": "#7a7f89", "--line": "#e6e9ee", "--line-strong": "#b4b9c1",
    "--surface": "#ffffff", "--surface-2": "#f3f4f6", "--accent": "#3b6fc9", "--good": "#178a6b", "--warn": "#bf7a10", "--muted": "#8e959e",
    "--accent-soft": "#3b6fc91f", "--good-soft": "#178a6b1f", "--warn-soft": "#bf7a101f",
  },
  dark: {
    "--ink": "#f4f4f6", "--text": "#e4e4e8", "--text-2": "#aaaab5", "--text-3": "#85858f", "--line": "#ffffff1a", "--line-strong": "#ffffff40",
    "--surface": "#1f2025", "--surface-2": "#2a2b31", "--accent": "#a9caff", "--good": "#5cc4a0", "--warn": "#e0a94a", "--muted": "#85858f",
    "--accent-soft": "#a9caff26", "--good-soft": "#5cc4a026", "--warn-soft": "#e0a94a26",
  },
};

const SHARED_TOKENS = [
  "--font:-apple-system,BlinkMacSystemFont,\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",\"Noto Sans CJK SC\",\"Segoe UI\",sans-serif",
  "--fs-value:16px", "--fs-title:14px", "--fs-body:13px", "--fs-label:12px",
  "--space-1:4px", "--space-2:8px", "--space-3:12px", "--space-4:16px", "--space-5:24px",
  "--radius-sm:6px", "--radius:10px", "--radius-lg:14px",
].join(";");

const tokenBlock = (theme: VisualTheme) => Object.entries(VISUAL_TOKENS[theme]).map(([name, value]) => `${name}:${value}`).join(";");

/** 注入的基础样式与现成 class（与 RICH_BLOCK_RULES 里给模型的说明同一套）。 */
export const VISUAL_BASE_CSS = [
  `:root{${SHARED_TOKENS};${tokenBlock("light")};color-scheme:light}`,
  `:root[data-theme=dark]{${tokenBlock("dark")};color-scheme:dark}`,
  "*,*::before,*::after{box-sizing:border-box}",
  "html,body{margin:0;padding:0;background:transparent}",
  "body{font:13px/1.55 var(--font);color:var(--text);overflow:hidden;-webkit-text-size-adjust:100%;overflow-wrap:anywhere}",
  "#root{overflow-x:auto;overflow-y:hidden;padding:1px 0 2px;overscroll-behavior-x:contain;scrollbar-width:thin}",
  "#root>svg{display:block;width:100%;height:auto;margin:0 auto;max-width:calc(var(--vbw) * var(--max-scale) * 1px);min-width:calc(var(--vbw) * var(--min-scale) * 1px)}",
  "svg{max-width:100%;overflow:visible}",
  "svg text{font-family:var(--font);font-size:13px;fill:var(--text)}",
  "h1,h2,h3,h4,h5,h6{margin:0 0 var(--space-2);font-size:14px;font-weight:600;line-height:1.5;color:var(--ink)}",
  "p{margin:0 0 var(--space-2)}p:last-child{margin-bottom:0}",
  "ul,ol{margin:0 0 var(--space-2);padding-left:1.2em}",
  "table{width:100%;border-collapse:collapse;font-size:13px}",
  "th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}",
  "th{font-size:12px;font-weight:500;color:var(--text-3)}",
  ".t-title{font-size:14px;font-weight:600;color:var(--ink);fill:var(--ink)}",
  ".t-value{font-size:16px;font-weight:600;color:var(--ink);fill:var(--ink);font-variant-numeric:tabular-nums}",
  ".t-body{font-size:13px;color:var(--text);fill:var(--text)}",
  ".t-label{font-size:12px;color:var(--text-3);fill:var(--text-3)}",
  ".t-muted{color:var(--text-2);fill:var(--text-2)}",
  ".t-accent{color:var(--accent);fill:var(--accent)}.t-good{color:var(--good);fill:var(--good)}.t-warn{color:var(--warn);fill:var(--warn)}",
  ".box{fill:var(--surface);stroke:var(--line-strong);stroke-width:1}",
  ".box-soft{fill:var(--surface-2);stroke:var(--line);stroke-width:1}",
  ".box-accent{fill:var(--accent-soft);stroke:var(--accent);stroke-width:1}",
  ".box-good{fill:var(--good-soft);stroke:var(--good);stroke-width:1}",
  ".box-warn{fill:var(--warn-soft);stroke:var(--warn);stroke-width:1}",
  ".edge{fill:none;stroke:var(--line-strong);stroke-width:1.25}",
  ".edge-accent{fill:none;stroke:var(--accent);stroke-width:1.5}",
  ".edge-warn{fill:none;stroke:var(--warn);stroke-width:1.5}",
  ".arrow{marker-end:url(#tk-arrow)}.edge-accent.arrow{marker-end:url(#tk-arrow-accent)}.edge-warn.arrow{marker-end:url(#tk-arrow-warn)}",
  ".inferred{stroke-dasharray:4 3}",
  ".card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-3)}",
  ".card.accent{border-color:var(--accent);background:var(--accent-soft)}.card.good{border-color:var(--good);background:var(--good-soft)}.card.warn{border-color:var(--warn);background:var(--warn-soft)}",
  ".card.inferred{border-style:dashed;background:transparent}",
  ".tag{display:inline-block;padding:0 6px;border-radius:var(--radius-sm);background:var(--surface-2);font-size:12px;line-height:20px;color:var(--text-2)}",
  ".tag.accent{background:var(--accent-soft);color:var(--accent)}.tag.good{background:var(--good-soft);color:var(--good)}.tag.warn{background:var(--warn-soft);color:var(--warn)}",
  ".muted{color:var(--text-3)}",
  ".grid{display:grid;gap:var(--space-3);grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}",
  ".row{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center}",
  ".stack{display:flex;flex-direction:column;gap:var(--space-2)}",
  ".hr{height:1px;background:var(--line);border:0;margin:var(--space-3) 0}",
].join("\n");

/** 箭头（文档内引用，SVG 里 marker-end:url(#tk-arrow) 或 class="edge arrow"）。 */
const MARKERS = [["tk-arrow", "--line-strong"], ["tk-arrow-accent", "--accent"], ["tk-arrow-warn", "--warn"]]
  .map(([id, color]) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill:var(${color})"/></marker>`).join("");

/** 沙箱里的 CSP：不能联网、不能加载任何外部资源、不能提交表单；脚本只放行带 nonce 的那一段。 */
export function visualCsp(nonce: string): string {
  return [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, "style-src 'unsafe-inline'", "img-src 'none'", "font-src 'none'", "connect-src 'none'",
    "media-src 'none'", "object-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "manifest-src 'none'",
    "form-action 'none'", "base-uri 'none'",
  ].join("; ");
}

/** 沙箱 iframe 的 sandbox 属性：只给脚本（宿主的量高脚本），不给同源、表单、弹窗、顶层导航、模态框。 */
export const VISUAL_SANDBOX = "allow-scripts";

const NONCE_PATTERN = /^[A-Za-z0-9]{16,64}$/;

/**
 * 沙箱文档（iframe srcdoc）：CSP、设计规范、清洗后的图示、宿主的量高脚本。
 * 量高脚本量 #root 的高度（含横向滚动条）与有没有横向溢出，变化时 postMessage 给父页面，带本次的 token。
 */
export function visualDocument(input: { block: Pick<VisualBlock, "markup" | "format" | "viewBox">; theme: VisualTheme; nonce: string; token: string; minScale?: number }): string {
  const { block, theme, nonce, token } = input;
  if (!NONCE_PATTERN.test(nonce) || !NONCE_PATTERN.test(token)) throw new Error("visual nonce/token must be 16–64 alphanumerics");
  const minScale = input.minScale ?? VISUAL_MIN_SCALE;
  const vars = block.viewBox ? ` style="--vbw:${block.viewBox.width};--min-scale:${minScale};--max-scale:${VISUAL_MAX_SCALE}"` : "";
  const script = `(function(){var r=document.getElementById("root"),t=${JSON.stringify(token)},l="";function s(){var h=Math.ceil(r.getBoundingClientRect().height),o=r.scrollWidth>r.clientWidth+1,k=h+":"+o;if(k===l)return;l=k;parent.postMessage({type:${JSON.stringify(VISUAL_MESSAGE)},token:t,height:h,overflow:o},"*")}if(typeof ResizeObserver!=="undefined")new ResizeObserver(s).observe(r);addEventListener("load",s);s()})();`;
  return [
    "<!doctype html>",
    `<html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${visualCsp(nonce)}">`,
    `<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<style>${VISUAL_BASE_CSS}</style></head><body>`,
    `<svg aria-hidden="true" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden"><defs>${MARKERS}</defs></svg>`,
    `<div id="root" data-format="${block.format}"${vars}>${block.markup}</div>`,
    `<script nonce="${nonce}">${script}</script>`,
    "</body></html>",
  ].join("");
}

/** 本次渲染用的随机串（nonce、token）：crypto 可用就用 crypto。 */
export function randomToken(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type VisualSize = { height: number; overflow: boolean };

/**
 * 父页面收 iframe 的高度回报：消息必须来自这个 iframe 的 contentWindow、origin 是 "null"（沙箱不透明源；
 * 同源或别的源发来的都不收）、type 与本次 token 对得上、高度是有限数字。其余一律 null（不改高度）。
 */
export function readVisualMessage(event: { origin: string; source: unknown; data: unknown }, frameWindow: unknown, token: string): VisualSize | null {
  if (!frameWindow || event.source !== frameWindow) return null;
  if (event.origin !== "null") return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.type !== VISUAL_MESSAGE || typeof record.token !== "string" || record.token !== token) return null;
  if (typeof record.height !== "number" || !Number.isFinite(record.height)) return null;
  return { height: Math.round(record.height), overflow: record.overflow === true };
}

/** 回报的高度在不在合理范围：太矮是空图，太高是尺寸异常。 */
export const visualSizeOk = (height: number) => height >= VISUAL_MIN_HEIGHT && height <= VISUAL_MAX_HEIGHT;

/** SVG 在给定栏宽下的显示宽度（缩放夹在 minScale–VISUAL_MAX_SCALE 之间）与是否需要横向滚动。 */
export function svgFit(viewBox: { width: number; height: number }, available: number, minScale = VISUAL_MIN_SCALE) {
  const min = viewBox.width * minScale, max = viewBox.width * VISUAL_MAX_SCALE;
  const width = Math.min(max, Math.max(min, available));
  return { width, height: Math.ceil((width / viewBox.width) * viewBox.height), scroll: available > 0 && min > available + 1 };
}
