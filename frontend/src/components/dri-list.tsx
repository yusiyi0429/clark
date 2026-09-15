"use client";

import type { DriOption } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * 指派名单里的一行：**名字是主角，域是背景**。
 *
 * ## 为什么域要压下去，而不是并排
 *
 * 这份名单在屏幕上是被**扫**的，不是被读的 —— 一号位此刻要办的事是「把这件议题交给
 * 某个人」，而人是靠名字认的。名字和域同一档字重时，眼睛得在每一行里先分辨哪半边是
 * 名字；压下去之后，名字自己排成一条能一眼扫到底的竖线，域退到边上作背景。
 *
 * 但域不能不给：他决定交给谁，用的正是「谁管哪一摊」。上一版这份名单只有一串名字，
 * 于是这个判断得先去别处对一遍分工 —— 而那份分工就在同一个对象上（见 `DriOption`）。
 *
 * ## 一个域都不管的人，右边什么都不写
 *
 * 不写「未指派」「无」之类的字。这一栏答的是「他管哪一摊」，而「他不管任何一摊」是
 * 一个正常状态，不是缺失 —— 给它一句话等于在每一行里都提醒一次一件不重要的事。
 * （域自己那一侧相反：一个没有负责人的域必须写出「未指派」，见 `domainDriLabel`。）
 */
export function DriRow({ person, selected = false }: { person: DriOption; selected?: boolean }) {
  return (
    <span className="flex w-full items-baseline gap-3">
      <span className={cn("flex-none text-sm", selected ? "font-medium text-ink" : "text-ink")}>
        {person.name}
      </span>
      {person.domains.length > 0 && (
        /*
         * 域名靠右、压淡、必要时截断。截断的是**域名**不是人名：一行放不下的时候，
         * 该让步的是背景那一半 —— 名字被截掉一个字，这一行就认不出是谁了。
         */
        <span className="meta ml-auto min-w-0 truncate text-ink-faint">
          {person.domains.map((d) => d.name).join(" · ")}
        </span>
      )}
    </span>
  );
}
