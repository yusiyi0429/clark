"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

/**
 * 参谋说的话里的 Markdown。
 *
 * ## 为什么这一份存在
 *
 * 模型交回来的一直是 Markdown —— `**`、`##`、`1.`、`|` 表格、`` ` `` 都在正文里。上一版
 * 屏幕上按纯文本渲染，于是那些记号**原样印在脸上**：一段本该是「三层机制」的分点论证，
 * 读起来是一行行带着星号的字。加重和层级是这段话自己的结构，不是装饰 —— 印成星号等于
 * 把它的结构擦掉，再让读的人自己在脑子里补一遍。
 *
 * ## 不自己写解析器
 *
 * 用 `react-markdown` + `remark-gfm`（GFM 是表格和删除线那一套）。手写一个「够用的」
 * Markdown 解析器在这条路上是个陷阱：模型交回来的东西里有嵌套列表、围栏代码块、
 * 表格、以及**半截的**记号（流式期间 `**` 只出来一半是常态）。这几样正是手写解析器
 * 逐个翻车的地方，而翻车的样子不是报错，是版面悄悄错位。
 *
 * 原始 HTML **不渲染**（`react-markdown` 默认就不，这里也不装 `rehype-raw`）：这段字
 * 是模型生成的，允许它往页面里写标签等于把这一栏交给它。
 *
 * ## 版面跟着这一栏的既有排版走，不引 typography 插件
 *
 * 每一种元素的类都写在下面 `COMPONENTS` 里，用的是全站那几档（`.talk` / `.meta` /
 * `text-md` / `text-ink-*`）。引一个排版插件会带进另一套字号和间距，而这一栏的字号是
 * 「同一句话的四个时刻」里的一档（见 `chat-pane.tsx` 的 `AgentText`）—— 那一档不能由
 * 一个插件的默认值来定。
 */

/**
 * 段落。**外层不套 `<p>` 之外的东西** —— `space-y` 由容器给，这里只管字。
 *
 * `.talk text-md` 和 `Bubble`、输入框、等待那行小字是同一档，四处一起改。
 */
const P = ({ children }: { children?: React.ReactNode }) => (
  <p className="talk text-md text-ink">{children}</p>
);

/**
 * 标题三档就够。模型偶尔会交出 `####` 甚至 `#####`，那时一律按最小那一档渲染 ——
 * 一段聊天回复里出现五级层级是模型的习惯，不是这段话真有五层结构。
 */
const heading = (level: 1 | 2 | 3) =>
  function Heading({ children }: { children?: React.ReactNode }) {
    const Tag = (["h3", "h4", "h5"] as const)[level - 1];
    return (
      <Tag
        className={cn(
          "talk font-medium text-ink",
          level === 1 && "mt-4 text-lg first:mt-0",
          level === 2 && "mt-3.5 text-md first:mt-0",
          level === 3 && "mt-3 text-md text-ink-muted first:mt-0",
        )}
      >
        {children}
      </Tag>
    );
  };

/**
 * 列表。缩进用 `pl-*` 而不是 `list-inside`：`list-inside` 的第二行会缩回到记号底下，
 * 一条两行的要点于是读起来像两条。
 */
const list = (ordered: boolean) =>
  function List({ children, start }: { children?: React.ReactNode; start?: number }) {
    const cls = "talk my-1.5 space-y-1 pl-5 text-md text-ink marker:text-ink-faint";
    return ordered ? (
      <ol className={cn(cls, "list-decimal")} {...(start === undefined ? {} : { start })}>
        {children}
      </ol>
    ) : (
      <ul className={cn(cls, "list-disc")}>{children}</ul>
    );
  };

/**
 * 表格。**自己带横向滚动** —— 模型交出来的表宽度不可控，而这一栏是右侧一条窄栏；
 * 不兜住的话整页会被撑出一条横向滚动条，那时动的是整屏，不是这张表。
 */
const Table = ({ children }: { children?: React.ReactNode }) => (
  <div className="scroll-slim scroll-x-only my-2 rounded-lg border border-hairline">
    <table className="w-full border-collapse text-left">{children}</table>
  </div>
);

const COMPONENTS: Components = {
  p: P,
  h1: heading(1),
  h2: heading(1),
  h3: heading(2),
  h4: heading(3),
  h5: heading(3),
  h6: heading(3),
  ul: list(false),
  ol: list(true),
  li: ({ children }) => <li className="talk text-md text-ink">{children}</li>,
  strong: ({ children }) => <strong className="font-medium text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-ink-faint line-through">{children}</del>,
  hr: () => <hr className="my-3 border-0 border-t border-hairline" />,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-hairline-strong pl-3 text-ink-muted">
      {children}
    </blockquote>
  ),
  /*
   * 行内代码和代码块是同一个 `code` 节点，靠有没有裹在 `pre` 里分 —— `react-markdown`
   * 把围栏块渲染成 `pre > code`，行内的没有那层 `pre`。这里认的是这件事本身
   * （`className` 上有没有 `language-`），不认 `inline` 那个属性：那个属性在 v9 之后
   * 不再传，照它判会让每一段行内代码都渲染成一整块。
   */
  code: ({ className, children }) => {
    const fenced = /language-/.test(className ?? "");
    if (!fenced) {
      return (
        <code className="rounded bg-neutral-wash px-1 py-0.5 font-mono text-[0.9em] text-ink">
          {children}
        </code>
      );
    }
    return <code className="font-mono text-sm text-ink">{children}</code>;
  },
  pre: ({ children }) => (
    <pre className="scroll-slim scroll-x-only my-2 rounded-lg border border-hairline bg-neutral-wash px-3 py-2.5">
      {children}
    </pre>
  ),
  table: Table,
  thead: ({ children }) => <thead className="border-b border-hairline">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-hairline last:border-0">{children}</tr>,
  th: ({ children }) => (
    <th className="meta px-3 py-1.5 font-medium whitespace-nowrap text-ink-muted">{children}</th>
  ),
  td: ({ children }) => <td className="talk px-3 py-1.5 text-sm text-ink">{children}</td>,
  /*
   * 链接一律新开一页并且切断 opener。这段字是模型写的，站内路由不该由它决定 ——
   * 让它在当前标签里跳走，等于把「他此刻在哪一页」交给一段生成出来的文字。
   */
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-ink underline decoration-hairline-strong underline-offset-2 transition-colors duration-fast hover:decoration-ink"
    >
      {children}
    </a>
  ),
};

/**
 * 渲染一段 Markdown。
 *
 * `flowing` 打开时，最后一个块的字被一道流动的光扫过去（`.streaming-flow-tail`，
 * globals.css）—— 走 CSS 选择器而不是往 React 树里塞一个节点：这段字的最后一个元素
 * 可能是段落、列表项、也可能是表格的最后一格，往树里塞就得先认出「最后那个是谁」，
 * 而那件事每加一种元素就要重认一次。
 */
export function Markdown({
  text,
  flowing = false,
  className,
}: {
  text: string;
  flowing?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2.5", flowing && "streaming-flow-tail", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
