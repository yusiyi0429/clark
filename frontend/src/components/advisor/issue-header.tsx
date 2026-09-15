"use client";

import { Mic } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DriRow } from "@/components/dri-list";
import { IssueTitle } from "@/components/issue-title";
import { StateBadge } from "@/components/state-badge";
import { api } from "@/lib/data/client";
import type { DriOption, Issue } from "@/lib/data/types";
import { useInvalidate, useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 议题研究页的议题身份 —— 长在顶栏里，不再是顶栏下面的第二条。
 *
 * 合并的理由是算出来的：两条 header（64 + 76）加上它们之间的间距，在一块 950px 高的屏幕
 * 上吃掉 168px，而这一页的正文是**两栏要连读的东西**。合完之后是 64px，这一版又矮到
 * 48px（那一行在这一页整体收了一档，理由见 `stage-nav.tsx` 里 `compact` 那段）——
 * 省下的 120px 全部给了报告与对话。
 *
 * 这一行上有：议题编号、标题、语音过一遍、指派负责人。定过了的议题多一枚状态徽标。
 * （报告到手后出现的那颗「定这件事」这一版撤掉了 —— 它掉了一条路，说明写在原处。）
 *
 * 一行放得下，靠的是砍掉三样重复：
 *
 * 1. **「议题研究 ·」这四个字**。屏幕上摆着链路图和对话，没人会以为自己在别处。
 * 2. **「未指派负责人」那句状态**。它和旁边的「指派负责人」按钮说的是同一件事 —— 现在
 *    合成一个控件：没人承接时写「指派负责人」，有人承接时写「负责人 · 某某」，点它改派。
 * 3. **「语音过一遍」的字**。收成一枚话筒图标（带 aria-label 与 title）。它是整行里唯一
 *    一个图标本身就说得清的动作，而且是开场用一次的东西，不该和「指派负责人」抢字宽。
 *
 * 数据走 `issue:${id}` —— 和议题研究页是同一个 SWR key，所以顶栏不会为了一个标题再取
 * 一遍。指派完 `mutate` 同一个 key，那一页跟着变。
 */
export function IssueHeader({ id }: { id: string }) {
  const issueRes = useResource<Issue>(`issue:${id}`, () => api.getIssue(id));
  const invalidate = useInvalidate();
  const issue = issueRes.data;

  if (!issue) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="skeleton block h-4 w-64" />
      </div>
    );
  }

  /*
   * 编号左边那条竖发丝线拿掉了。理由和顶栏当初拆掉自己那两条是同一条（见 `stage-nav.tsx`
   * 开头）：竖线是分隔**同一个容器里**相邻两组控件用的，而这一行没有容器 —— 一条 16px
   * 的短线悬在白纸上，分隔的是空气。两组之间那 12px 的间距本来就说得清。
   */
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <span className="meta flex-none text-ink-faint">{issue.id}</span>
      {/* 标题与那颗改题的键是一个共用组件（潜在议题页头部是同一个）—— 理由见
          `components/issue-title.tsx`：这两页写的是同一个字符串。 */}
      <IssueTitle
        issueId={issue.id}
        title={issue.title}
        className="flex-1"
        titleClassName="report truncate text-md text-ink"
        onRenamed={(next) => {
          void issueRes.mutate(next, { revalidate: false });
          /* 这行字在别处也摆着（清单、去向记录、卡面）—— 那几份缓存里还是旧题。 */
          invalidate(`issue:${id}`);
        }}
      />
      {/*
       * 定过了的议题必须在这一行上说出来。
       *
       * 这一页是议题研究：判断板上摆着「手动确认」、顶栏上摆着「指派负责人」，
       * 整屏读起来是一件还在办的事。而从去向记录点回来的那件事已经定完了 —— 屏幕上
       * 原先唯一的线索是那颗按钮从「定这件事」变成「这件事怎么定的」，一个字的差别。
       *
       * 只在定过之后出现，不是每种状态都挂一枚：还在办的时候，这一整页本身就是它的
       * 状态（研究在跑、动作能点）；定完之后同一页变成了历史，而它长得一模一样，
       * 那一刻才需要一句话把这件事说清。这一行只有 48px 高（见上面），常态那一档
       * 不多占一格。
       */}
      {issue.decidedAt ? <StateBadge state={issue.state} className="flex-none" /> : null}
      <IssueActions
        issue={issue}
        onIssueChange={(next) => void issueRes.mutate(next, { revalidate: false })}
      />
    </div>
  );
}

function IssueActions({
  issue,
  onIssueChange,
}: {
  issue: Issue;
  onIssueChange: (issue: Issue) => void;
}) {
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [personId, setPersonId] = useState("");
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const drisRes = useResource<DriOption[]>(assignOpen ? "dris" : null, () => api.listDris());
  const invalidate = useInvalidate();

  // 点到别处、按 Esc，都关掉。指派是一次组织动作，不该因为一次误点就悬在屏幕上。
  useEffect(() => {
    if (!assignOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setAssignOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAssignOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [assignOpen]);

  const assign = async () => {
    if (!personId || busy) return;
    setBusy(true);
    try {
      const next = await api.assignIssue(issue.id, personId);
      onIssueChange(next);
      invalidate(`issue:${issue.id}`);
      setAssignOpen(false);
      setPersonId("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-none items-center gap-2">
      <button
        type="button"
        onClick={() => setVoiceOpen(true)}
        aria-label="语音过一遍"
        title="语音过一遍"
        /*
         * 悬停底用半透明的 `wash-hover`（见 globals.css 那段）：这一行坐在页底那张纸上，
         * 算死的 `neutral-wash` 只在白面上对。
         *
         * **没有边了。** 这一行上原来三个控件各带一圈 `hairline-strong`，加上一颗带底色的
         * 「指派负责人」，一共四个框排在议题标题右边 —— 而这一页的正文是两栏要连读的东西。
         * 一枚话筒图标不需要一个框来说明自己能点：手放上去有底，那就是能点。这一版连
         * 「指派负责人」的框也去了（理由在那一颗上），整行现在只有字和图标。
         */
        className="inline-flex size-8 items-center justify-center rounded-md text-ink-muted transition-colors duration-fast ease-swift hover:bg-wash-hover hover:text-ink"
      >
        <Mic className="size-4" aria-hidden />
      </button>

      <div ref={wrap} className="relative">
        <button
          type="button"
          aria-expanded={assignOpen}
          onClick={() => setAssignOpen((v) => !v)}
          /*
           * 这一颗也去了框和底。
           *
           * 上一版它是整行里唯一带底色的控件（judgment 色的边 + 淡红底），理由是「这是
           * 这一行上唯一一件还没做的事」。那条理由在**这一页**上不成立：进这一页的人是
           * 来读研究、来追问的，指派负责人是顺手办的一件事，不是这一屏要他先解决的问题。
           * 一块带色的实底摆在议题标题右边，眼睛每次扫过标题都会被它拽一下。
           *
           * 信号没丢，只是降了一档：没人承接时字是 judgment 色，承接了是常规的次级灰。
           * 颜色说得清「这件事还悬着」，不需要再给它一个框和一块底。
           */
          className={cn(
            "meta inline-flex h-8 max-w-[12rem] items-center rounded-md px-2.5 font-medium transition-colors duration-fast ease-swift hover:bg-wash-hover",
            issue.assigneeName ? "text-ink-muted hover:text-ink" : "text-judgment/80 hover:text-judgment",
          )}
        >
          <span className="truncate">
            {issue.assigneeName ? `负责人 · ${issue.assigneeName}` : "指派负责人"}
          </span>
        </button>

        {assignOpen ? (
          /* `.floating-thick` 是这一档的那个类（见 globals.css）：不透明兜底 + 材质 +
             `--elev-3` + 半像素暗边，四道护栏（少用半透明 / 高对比 / Windows 高对比 /
             舞台）一起管着它。这里原来是手搓的 `border + bg-surface + shadow-e2` ——
             长得像，但护栏一条都管不到它，深色下也拿不到那 90% 的加厚。

             ## 一条只在顶栏还是胶囊时才存在的折扣
             这颗弹层是顶栏那颗 `.floating` 胶囊的 DOM 后代，而带 `backdrop-filter`
             的元素本身就是一个 **backdrop root**：后代的 `backdrop-filter` 只能取到
             这个 root 内部画过的东西。弹层整个挂在胶囊下沿以外（`top-full mt-2`），
             那片区域在 root 里是空的 —— 于是模糊取不到东西，透出来的 14% 是**没糊过**
             的正文。对比度不受影响（86% 实底压着，最坏底上仍然远超 AAA），丢的只是磨砂。

             不为它单独 portal：胶囊正在被拿掉（顶栏改造那一支），胶囊一走这颗弹层的
             父链上就没有 backdrop root 了，材质自己就成立。留这段话是免得将来有人
             看见「弹层不糊」以为是 CSS 写错了 —— 它是嵌套的代价，不是漏。 */
          <div className="floating-thick animate-panel absolute top-full right-0 z-40 mt-2 w-72 rounded-xl p-3.5">
            <p className="meta text-ink-faint">
              {issue.assigneeName ? "改派给谁承接" : "交给谁承接这件议题"}
            </p>
            {/*
             * 一份名单，不是一个原生下拉。
             *
             * 换掉它是因为 `<option>` 里没有版面 —— 里面只能是一串纯文本，没法让名字是
             * 主角、域退成背景（那正是这份名单要说的两层，见 `DriRow`）。把域拼进那串
             * 文本（「陈溪南 · Agents」）能塞下字，但两半同样重，扫的时候还是得逐行分辨
             * 哪半边是名字。
             *
             * 代价是原生下拉自带的键盘行为要自己给：这里是一组 radio，方向键在浏览器里
             * 就能在同组之间走，Enter 由外面那颗「确定」收 —— 和上一版的两步（先选，
             * 再确认）是同一套手感。
             */}
            <ul
              role="radiogroup"
              aria-label="选择负责人"
              className="scroll-slim mt-2 max-h-56 overflow-y-auto"
            >
              {(drisRes.data ?? []).map((p, i) => (
                <li key={p.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={personId === p.id}
                    autoFocus={i === 0}
                    disabled={busy}
                    onClick={() => setPersonId(p.id)}
                    className={cn(
                      "block w-full rounded-md px-2.5 py-1.5 text-left transition-colors duration-fast",
                      "hover:bg-neutral-wash disabled:opacity-40",
                      personId === p.id && "bg-neutral-wash",
                    )}
                  >
                    <DriRow person={p} selected={personId === p.id} />
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-2.5">
              <button
                type="button"
                disabled={!personId || busy}
                onClick={() => void assign()}
                className="meta inline-flex h-8 items-center rounded-md bg-solid px-3 font-medium text-solid-fg transition-opacity duration-fast hover:opacity-90 disabled:opacity-40"
              >
                {busy ? "正在指派…" : "确定"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setAssignOpen(false)}
                className="meta rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
              >
                算了
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/*
       * 这里原来有一颗「定这件事 / 这件事怎么定的」（`/decisions/${issue.id}`），
       * 2026-08-26 按要求撤掉了 —— 这一行只留议题身份和一件顺手能办的事。
       *
       * **撤掉它掉了一条路，这件事得写在这儿。** 会后确认那一页是惰性起草的
       * （`getClosureDraft` → A10），而 `/decisions` 的列表只列**已经有草案**的议题
       * （`listDecisions` 读 `store.closureDrafts`）。于是没上过会的议题现在没有任何
       * 入口进得去：没人点进 `/decisions/[id]`，草案就不会起草；草案不起草，它就不会
       * 出现在列表里。「认知修订、布控靶点这类，读完研究就该定」是 `/decisions` 那一页
       * 自己写着的第二条路，那条路现在只有直接改地址栏走得通。
       *
       * 要接回来，合适的位置是判断板上「都确认完了」之后的那一格，不是顶栏 —— 顶栏是
       * 身份，不是流程。等哪一版做这件事时把这段注释一起挪走。
       */}

      {voiceOpen ? <VoiceModal issue={issue} onClose={() => setVoiceOpen(false)} /> : null}
    </div>
  );
}

/**
 * 语音过一遍 —— 界面预览，功能下一版接。
 *
 * 场景：会前十分钟，一号位不想再读屏，让参谋把这个议题讲给他听，边听边打断提问，
 * 过完即会前就绪。这一版先把这件事在屏幕上立住。
 */
function VoiceModal({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  /* 盖住全屏的东西一律 portal 到 body：祖先一旦有 transform，fixed 的基准就不是视口了。 */
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="语音过一遍"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* 同上，走 `.floating-thick`。这块板底下压着那层 `bg-ink/40` 遮罩，材质模糊的
          就是它 —— 于是透上来的 14% 是「被压暗过的正文」而不是正文本身，比顶栏那一档
          还安全。它原来连阴影都没有：一块对话框靠一条发丝线浮在半屏暗底上，
          图底关系全靠那层遮罩撑，遮罩一淡它就贴回纸面。 */}
      <div className="floating-thick animate-panel w-full max-w-md rounded-2xl p-6">
        <p className="meta text-ink-faint">语音过一遍 · {issue.id}</p>
        <h2 className="report mt-1 text-lg text-ink">{issue.title}</h2>

        <div className="mt-6 flex flex-col items-center">
          <button
            type="button"
            onClick={() => setListening((v) => !v)}
            aria-pressed={listening}
            className={cn(
              "relative flex size-20 items-center justify-center rounded-full transition-colors duration-base",
              listening
                ? "bg-judgment text-solid-fg"
                : "bg-solid text-solid-fg hover:opacity-90",
            )}
          >
            {listening && (
              <span
                aria-hidden
                className="absolute inline-flex size-full animate-ping rounded-full bg-judgment opacity-40"
              />
            )}
            <Mic className="size-8" aria-hidden />
          </button>
          {listening ? (
            <p className="meta mt-3 text-ink-muted">语音服务下一版接入 · 此为界面预览</p>
          ) : null}
        </div>

        <div className="mt-6 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="meta rounded-md border border-hairline-strong px-3 py-1.5 font-medium text-ink transition-colors duration-fast hover:bg-neutral-wash"
          >
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
