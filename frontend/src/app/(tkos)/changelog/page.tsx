import type { Metadata } from "next";

import { Panel, PanelHead } from "@/components/panel";
import { CHANGELOG } from "@/lib/changelog";

export const metadata: Metadata = { title: "更新日志" };

/**
 * 更新日志。
 *
 * **服务端组件，不取数**：这一页的内容是编译进去的常量（`lib/changelog.ts`），
 * 没有 loading、没有空态、没有骨架 —— 那三样是给「要去问后端」的页面准备的。
 *
 * 版式照 tkos-lab 那份日志：左边一列版本号与日期，右边是那一版改了什么。
 * 两列而不是「小标题 + 列表」，是因为读的人多半在找**某一版**（演示前对版本、
 * 出了问题回溯是哪一版引入的），版本号得排成一条能扫的竖线。
 */
export default function ChangelogPage() {
  return (
    <Panel>
      <PanelHead
        eyebrow={`更新日志 · ${CHANGELOG.length} 个版本`}
        title="这个产品改过什么，逐版记在这儿。"
      />

      {/*
       * 一块面装一份账，行贴着行 —— 两行之间那条发丝线是 `.row + .row` 画的，
       * 留了缝那条线就没有中缝可贴（同「去向记录」那一页）。
       */}
      <ul className="card stagger overflow-hidden">
        {CHANGELOG.map((release, i) => (
          <li
            key={release.version}
            /*
             * 窄屏上竖着摞（版本号一行、正文在下面），从 sm 起才是两列。
             * 手机上强行分两列的话，正文那一栏只剩 163px —— 一行装不下十个汉字，
             * 每一条都被切成五六行，读起来是一条一条的碎片。
             */
            className="row concentric flex flex-col gap-1.5 px-3.5 py-3.5 sm:flex-row sm:gap-6"
            style={{ "--i": i } as React.CSSProperties}
          >
            {/*
             * 两列时这一栏宽度写死：版本号是一条要竖着扫的线（在找某一版），
             * 跟着字数变宽就扫不成线。窄屏上它是一行，版本号和日期并排。
             */}
            <div className="flex flex-none items-baseline gap-2 sm:block sm:w-[5.5rem]">
              <p className="meta font-medium text-ink">{release.version}</p>
              <p className="meta text-ink-faint sm:mt-0.5">{release.date}</p>
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              {release.changes.map((line, j) => (
                /*
                 * 圆点用 `::before` 会跟不上换行后的缩进，所以是一个 flex 行：
                 * 点在左边不参与折行，第二行的字跟第一行对齐。
                 */
                <p key={j} className="flex gap-2 text-base leading-relaxed text-ink">
                  <span aria-hidden className="flex-none text-ink-faint select-none">
                    ·
                  </span>
                  <span className="min-w-0">{line}</span>
                </p>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
