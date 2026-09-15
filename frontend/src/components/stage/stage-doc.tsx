"use client";

import { useEffect, useMemo, useRef } from "react";

import { api } from "@/lib/data/client";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

import { Missing } from "./stage-cards";

/**
 * 打开全文，滚到那一段，把那一段点亮。
 *
 * 「打开全文」是这场 demo 里最硬的一下：客户听见一句引文，问「原文怎么说的」，屏幕上
 * 出现的必须是**那份文档本身**，而且光标落在**那一段**上。如果打开了全文却停在第一行，
 * 他要自己去找 —— 那一刻这个产品从「参谋」退回成「一个搜索框」。
 *
 * 正文走的是 `api.getDoc`，和手动模式点开文档时同一条路、同一份正文，段落也照同一个规矩
 * 切（空行分段、`## ` 是小标题）。字号是另一把尺：手动模式 15px 给一臂之外的一个人，
 * 这里 28px 给五米外的一屋子人。
 */

export function StageDoc({ docId, anchor }: { docId: string; anchor?: string }) {
  const resource = useResource(`doc:${docId}`, () => api.getDoc(docId));
  const doc = resource.data?.doc;

  const paras = useMemo(() => doc?.body.split(/\n{2,}/) ?? [], [doc?.body]);
  /*
   * 命中哪一段。
   *
   * 先按整段包含找，找不到就退成「取 anchor 前 12 个字再找一次」—— 模型给的 anchor 常常
   * 是它自己转述的一整句，末尾多一个标点、中间少一个字，整句匹配就废了。前 12 个字够
   * 定位到唯一一段，又短到不容易被改动。
   */
  const hit = useMemo(() => {
    const needle = anchor?.trim();
    if (!needle) return -1;
    const exact = paras.findIndex((p) => p.includes(needle));
    if (exact >= 0) return exact;
    const head = needle.slice(0, 12);
    return head.length >= 4 ? paras.findIndex((p) => p.includes(head)) : -1;
  }, [paras, anchor]);

  const target = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    /*
     * 滚动等到正文真的挂上来之后。`hit` 变了才滚 —— 他在同一份文档里换看另一段时，屏幕
     * 要再滚一次；而只是重新渲染一次不该把他滚回去。
     */
    if (hit < 0) return;
    target.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [hit, docId]);

  if (resource.error) return <Missing what={`文档 ${docId}`} />;

  if (!doc) {
    return (
      <div className="mx-auto w-full max-w-[68ch] space-y-5" aria-live="polite">
        <span className="skeleton block h-7 w-[60%]" />
        {[100, 96, 90, 100, 84].map((w, i) => (
          <span key={i} className="skeleton block h-6" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }

  return (
    <article className="animate-fade mx-auto flex w-full max-w-[68ch] flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="meta-stage text-ink-faint">{doc.mirrorOf ?? doc.id}</p>
        <h2 className="text-stage-title font-medium tracking-[-0.01em] text-ink">{doc.title}</h2>
      </header>

      <div className="report flex flex-col gap-6">
        {paras.map((para, i) =>
          para.startsWith("## ") ? (
            <h3
              key={i}
              className="text-stage-lead font-medium text-ink"
              style={{ fontFamily: "var(--font-sans)" }}
            >
              {para.slice(3)}
            </h3>
          ) : (
            <p
              key={i}
              ref={i === hit ? target : undefined}
              className={cn(
                "text-stage transition-colors duration-slow ease-swift",
                /*
                 * 高亮用判断色的浅底，不用黄色荧光笔那种效果：这一段是**被引用过的原话**，
                 * 而判断色在这个产品里的意思就是「公司的赌注压在这儿」。左边那条竖线让他
                 * 一眼看出边界在哪 —— 中文段落只靠底色，起止是模糊的。
                 */
                i === hit
                  ? "-mx-7 border-l-4 border-judgment bg-judgment-wash py-3 pr-7 pl-6 text-ink"
                  : "text-ink-muted",
              )}
            >
              {para}
            </p>
          ),
        )}
      </div>

      {anchor && hit < 0 && (
        /*
         * 定位失败要说出来。
         *
         * 全文在屏幕上，但那一段没找到 —— 这时候假装没事是最坏的：他会以为屏幕上高亮的
         * 就是原话。写一行小字，他和秘书都看得见，秘书可以改推一张证据卡。
         */
        <p className="meta-stage text-ink-faint">
          全文在这儿，但那一段没定位到。
        </p>
      )}
    </article>
  );
}
