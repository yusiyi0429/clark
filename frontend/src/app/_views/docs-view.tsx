"use client";

import { Bot, ChevronRight, FileText, Folder, Link2, Sheet } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelHead, PanelSection } from "@/components/panel";
import { api } from "@/lib/data/client";
import { formatDay } from "@/lib/format";
import type { Doc } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";

type Listed = Omit<Doc, "body">;

/**
 * 文档库 (`/docs`)。
 *
 * 一号位框架里的第二格。这里**一份文档都不是在 TKOS 里写的** —— 全部镜像自飞书云文档和
 * 云盘，所以每一行都能查到它原本在哪儿。这一点必须写在屏幕上：一个能在里面写文档的
 * 产品是知识库，而 TKOS 不是知识库，它是判断的运行时。文档在这里的唯一身份是**依据**：
 * 一条判断说「依据是纲领 v2.1 第三节」，那一节得点得开。
 *
 * 所以表里那一列是「被几条判断引用过」，不是文件大小。一份从来没被任何判断引用过的
 * 文档在这个产品里没有位置，它只是躺在飞书里的一份文件 —— 表里照实留一个破折号。
 *
 * 它长得像飞书云盘，是因为它就是飞书云盘的镜像。一号位每天开的是飞书，两个地方看同一
 * 批文件却要用两套找法，多出来的那套就是他每天要额外记住的东西。所以照搬三样：
 *
 * - **两层。** 先是文件夹，点进去是文件。上一版把六个文件夹的十五份文件一次全摊在一
 *   屏里，那是一份清单，不是一个能翻的地方。
 * - **一行一份文件，四列。** 名称、判断引用、所有者、修改时间 —— 除了第二列，都是飞
 *   书那张表上的列。第二列是这个产品替换掉「大小」的那一列。
 * - **面包屑。** 「文档库 › 数据与台账」，跟飞书那行「云盘 › TKOS」一个位置。
 *
 * 当前在哪个文件夹是组件自己的 state，不是路由的一段。文档库是右栏的一页，`/docs/[id]`
 * 才是一份文档；为了记住「他刚才翻到哪个文件夹」再多一层路由，代价是每次点文件夹都
 * 走一次换页淡入 —— 翻文件夹要像翻文件夹，不该像换一页。
 */
export function DocsView() {
  const resource = useResource("docs", () => api.listDocs());
  // state 在 AsyncBoundary 外面：后台重新取一次数据不该把他弹回根目录。
  const [folder, setFolder] = useState<string | null>(null);

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<DocsSkeleton />}>
        {(docs) => (
          <DocsScreen docs={docs} folder={folder} onFolder={setFolder} />
        )}
      </AsyncBoundary>
    </Panel>
  );
}

function DocsScreen({
  docs,
  folder,
  onFolder,
}: {
  docs: Listed[];
  folder: string | null;
  onFolder: (folder: string | null) => void;
}) {
  // 文件夹顺序跟着里面最近动过的那份文件走，不按拼音排：他找的是「上周改过的那份」。
  const folders = useMemo(() => {
    const map = new Map<string, Listed[]>();
    for (const d of docs) {
      const list = map.get(d.folder);
      if (list) list.push(d);
      else map.set(d.folder, [d]);
    }
    return [...map.entries()];
  }, [docs]);

  const inside = folders.find(([name]) => name === folder);

  // 文件夹没了（数据换过一轮）就当他在根目录，不给他一间空房间。
  if (!inside) return <Root docs={docs} folders={folders} onFolder={onFolder} />;

  const [name, list] = inside;
  const cited = list.filter((d) => d.citedBy.length > 0).length;

  return (
    <>
      <PanelHead
        eyebrow={
          /*
            面包屑的最后一段就是下面那个标题，所以这里只写到上一级为止 —— 「文档库 ›
            数据与台账」再跟一个大字「数据与台账」，是同一个词在相邻两行里出现两次。
            那个箭头把眼睛带到标题上，路径仍然是完整的。
          */
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onFolder(null)}
              className="rounded-[3px] transition-colors duration-fast hover:text-ink"
            >
              文档库
            </button>
            <ChevronRight className="size-3 flex-none" />
          </span>
        }
        title={name}
        sub={`${list.length} 份 · ${citedLine(list.length, cited)}`}
      />
      <FileTable docs={list} />
    </>
  );
}

/* -------------------------------------------------------------------------- */

/** 根目录：六个文件夹，加一小截最近改过的文件 —— 省掉一次「先猜它在哪个夹子里」。 */
function Root({
  docs,
  folders,
  onFolder,
}: {
  docs: Listed[];
  folders: [string, Listed[]][];
  onFolder: (folder: string) => void;
}) {
  const cited = docs.filter((d) => d.citedBy.length > 0).length;
  // `docs` 已经按 `updatedAt` 倒排过了（数据层排的），前几份就是最近改过的几份。
  const recent = docs.slice(0, RECENT);

  return (
    <>
      <PanelHead
        eyebrow={`${docs.length} 份 · 镜像自飞书云文档与云盘`}
        title="文档库"
        sub={citedLine(docs.length, cited)}
      />

      <PanelSection title="文件夹" count={folders.length}>
        <div className="stagger grid grid-cols-[repeat(auto-fill,minmax(158px,1fr))] gap-2.5">
          {folders.map(([name, list], i) => (
            <button
              key={name}
              type="button"
              onClick={() => onFolder(name)}
              style={{ "--i": i } as React.CSSProperties}
              className="group flex items-center gap-2.5 rounded-lg border border-hairline px-3.5 py-3 text-left transition-[border-color,background-color] duration-base ease-swift hover:border-ink-faint hover:bg-neutral-wash"
            >
              <Folder className="size-4 flex-none text-ink-faint transition-colors duration-fast group-hover:text-ink-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base text-ink">{name}</span>
                <span className="meta mt-0.5 block text-ink-faint">
                  {list.length} 份 · {formatDay(list[0].updatedAt)} 更新
                </span>
              </span>
            </button>
          ))}
        </div>
      </PanelSection>

      <PanelSection title="最近改过的" count={`${recent.length} 份`}>
        <FileTable docs={recent} showFolder />
      </PanelSection>
    </>
  );
}

/** 根目录上露几份。够他认出「就是这个」，又不至于把整个库摊平。 */
const RECENT = 5;

/**
 * 标题下面那句话。
 *
 * 「其中 15 份被判断引用过」而总共就是 15 份 —— 那个「其中」读起来像漏写了一个数。
 * 三种情况分开说，一句话里不留一个要他自己去核对的数字。
 */
function citedLine(total: number, cited: number): string {
  if (cited === 0) return "还没有判断引用过它们。";
  if (cited < total) return `其中 ${cited} 份被判断引用过。`;
  return total === 1 ? "它被判断引用过。" : "每一份都被判断引用过。";
}

/* -------------------------------------------------------------------------- */

/**
 * 文件表。
 *
 * 四列，跟飞书那张表对齐，只有第二列不一样：飞书那儿是大小，这儿是「几条判断引用过
 * 它」。这是同一份文件在两个产品里的区别 —— 在飞书它是一份文件，在这儿它是几条判断
 * 的依据。
 *
 * 名称那一列会截断，这是有意的：一栏最窄能拖到 380px，四列都想要全宽就只能换行，而
 * 一行一份文件正是这张表能被扫的原因。截掉的部分在 `title` 里，也在点进去那一页上。
 */
function FileTable({ docs, showFolder }: { docs: Listed[]; showFolder?: boolean }) {
  if (docs.length === 0) {
    return <p className="text-sm text-ink-muted">这个文件夹是空的。</p>;
  }

  return (
    <div>
      <div className="meta flex items-center gap-2.5 border-b border-hairline pb-1.5 text-ink-faint">
        <span className="w-4 flex-none" />
        <span className="min-w-0 flex-1">名称</span>
        <span className="w-14 flex-none text-right">判断引用</span>
        <span className="w-11 flex-none">所有者</span>
        <span className="w-12 flex-none text-right">修改时间</span>
      </div>

      <ul className="stagger">
        {docs.map((doc, i) => {
          const Icon = iconOf(doc.mirrorOf);
          return (
            <li
              key={doc.id}
              className="border-b border-hairline"
              style={{ "--i": i } as React.CSSProperties}
            >
              <Link
                href={`/docs/${doc.id}`}
                className="group -mx-2 flex items-center gap-2.5 rounded-md px-2 py-2 transition-colors duration-fast ease-swift hover:bg-neutral-wash"
              >
                {/*
                  图标说的是它原本是什么，悬停说的是它原本在哪儿。`title` 挂在这层
                  `span` 上而不是图标上：`<svg title="…">` 在浏览器里不弹提示，那是
                  个哑属性。
                */}
                <span className="flex-none" title={doc.mirrorOf}>
                  <Icon className="size-3.5 text-ink-faint transition-colors duration-fast group-hover:text-ink-muted" />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-sm text-ink underline decoration-transparent underline-offset-[3px] transition-colors duration-fast group-hover:decoration-hairline"
                    title={doc.title}
                  >
                    {doc.title}
                  </span>
                  {showFolder ? (
                    <span className="meta mt-0.5 block truncate text-ink-faint">
                      {doc.folder}
                    </span>
                  ) : null}
                </span>
                <span className="meta w-14 flex-none text-right text-ink-muted">
                  {doc.citedBy.length > 0 ? doc.citedBy.length : DASH}
                </span>
                <span className="meta w-11 flex-none truncate text-ink-faint">
                  {doc.ownerName ?? DASH}
                </span>
                <span className="meta w-12 flex-none text-right text-ink-faint">
                  {formatDay(doc.updatedAt)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 没有就是没有。空着会读成「还没加载出来」。 */
const DASH = "—";

/**
 * 行首那枚图标。
 *
 * 按 `mirrorOf` 开头那个词认，不按 `source` 认 —— `drive` 里既有三份飞书表格，也有一
 * 份外部网页剪存，给剪存画一个表格图标就是在屏幕上说了一句假话。认不出来的算文档。
 */
const KIND = [
  ["表格", Sheet],
  ["剪存", Link2],
  ["Agent", Bot],
  ["TKOS", Bot],
] as const;

const iconOf = (mirrorOf: string) =>
  KIND.find(([word]) => mirrorOf.includes(word))?.[1] ?? FileText;

function DocsSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-40" />
      <span className="skeleton mt-3 block h-4 w-24" />
      <span className="skeleton mt-2.5 block h-2.5 w-64" />

      <span className="skeleton mt-7 block h-3 w-14" />
      <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(158px,1fr))] gap-2.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-hairline px-3.5 py-3">
            <span className="skeleton block h-3 w-3/4" />
            <span className="skeleton mt-2 block h-2.5 w-1/2" />
          </div>
        ))}
      </div>

      <span className="skeleton mt-7 block h-3 w-20" />
      <ul className="mt-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <li key={i} className="border-b border-hairline py-2.5">
            <span
              className="skeleton block h-3"
              style={{ width: `${52 + ((i * 17) % 30)}%` }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
