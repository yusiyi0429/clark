"use client";

import { ChevronDown, EyeOff, ExternalLink, Search, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useEffect, useMemo, useRef } from "react";
import { AgentText, ChatPane } from "@/components/advisor/chat-pane";
import { AsyncBoundary } from "@/components/async-boundary";
import { IssueTitle } from "@/components/issue-title";
import { DriRow } from "@/components/dri-list";
import { CodeBadge } from "@/components/provenance/code-ref";
import { ResearchStepLine, researchTookText } from "@/components/research-step-line";
import { SectionDots, type Section } from "@/components/section-dots";
import { StatementList } from "@/components/statement-line";
import { framingBlocks } from "@/lib/agent/a1a/framing";
import { asSentence } from "@/lib/agent/plain-text";

// 类型 only：`tasks.ts` 是服务端那张任务表，编译后这一行不进客户端包
// （同 `signals-inbox-view.tsx`）。
import type { TaskState } from "@/lib/agent/tasks";
import { api, cardSourceLabel } from "@/lib/data/client";
import { formatStamp } from "@/lib/format";
import type { Card, DriOption, PreResearchDoc, SignalDetail } from "@/lib/data/types";
import { useInvalidate, useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 潜在议题详情。
 *
 * ## 这一页**没有**判断链路图
 *
 * 议题研究那一页有。两页共用一套图看起来更整齐，但那是错的，有两条理由：
 *
 * 1. **链路图的价值随对话长度增长，而分诊对话很短。** 这一页他要回答的是一个二元
 *    问题：这值不值得我投入。三五轮就该有答案。三个节点两条边的图比对话本身还短 ——
 *    那不是提炼，是把刚说过的话誊了一遍。图在议题研究里成立，是因为那条路径长到他
 *    记不住、而且他要为路径负责；分诊不产生需要负责的路径，只产生一个是或否。
 * 2. **两页长得一样，他就会用同一种方式对待。** 而它们要求的注意力差一个量级。版面
 *    必须替他说出「这一页只花你三分钟」和「这一页你要坐下来」。
 *
 * 同一条理由往下推一步：**这一页的对话不进判断演进萃取**（`ChatPane ephemeral`）——
 * 那几轮将来会被当成「这件事讨论过了」的证据，而他当时只是在决定要不要开始。
 *
 * 但它是**存下来的**（2026-08-31 起）。萃取读的是裸 `issueId` 那一支，这一页写的是
 * `${issueId}:signal`，两支分家，所以「不当证据」这条不必靠「不存」来实现。上一版靠的
 * 就是不存，代价是他再点进同一张卡，上一次问过什么、参谋答过什么全是空白。
 *
 * ## 左栏放什么
 *
 * 四样，按他做这个决定的顺序 —— 也正好是认知链的顺序（先问对，再判值不值得）：
 *
 * 0. **这条议题是怎么被问出来的**（`card.framing`，方法域 S01 那四块）—— 发生了什么、
 *    证据到哪儿为止、它意味着什么、来源。它在参谋的判断**上面**：反过来摆的话他会
 *    先读到结论，再去找依据。卡面上不出这几块（卡面仍然是三拍）。
 * 1. **参谋读完预研之后的判断**（`pre.take`）—— 这一页的主体，最大的字。他点进来
 *    要的就是这一段：不是材料，是有人读完材料之后说的话。
 * 2. **支持这个判断的信息**（`pre.finding`）—— 只有正文，**不挂溯源徽章**。判断和它的
 *    依据必须挨着，中间不隔任何东西；徽章就是那道东西。出处全在下面折叠的原文里。
 * 3. **预研报告原文** —— 折叠，默认关。它是依据的依据；点开是一个主动动作，
 *    而绝大多数时候他不需要。
 *
 * 再往下是做决定要用的两样：它动摇哪条判断（分诊的实质就是拿信号去比对在版判断）、
 * 预研还答不上来的（这同时是「升级深研会去查什么」的清单 —— 他决定要不要升级，
 * 看的正是这个，不是看已经查到了什么）。
 *
 * 最后是处置键，常驻在底部。聊完还要往回找出口的页面，等于把决定推到了下一次。
 *
 * ## 左栏宽度
 *
 * 21rem → 30rem → 26rem。上一版左栏只放元数据，窄是对的；现在参谋的判断在左边，那是
 * 这一页最该被读进去的一段，21rem 一行放不下十二个字。收回 26rem 是因为整页跟着首页
 * 收到了 1180px —— 在那条宽度里，30rem 会把右边的对话挤到读不下去。
 */

export function SignalView({ id }: { id: string }) {
  const res = useResource<SignalDetail>(`signal:${id}`, () => api.getSignal(id));

  /*
   * 预研还没跑完时轮询。
   *
   * 预研是自动触发的异步任务（一到两分钟：模型 60s 起，质量门打回还要再跑一轮），
   * 没有轮询的话他会盯着一块空白，然后以为是坏了。
   *
   * 这一轮在议题被建出来的时候就起了（`ensurePreResearch`），所以这里打的那一下是
   * 兜底 —— 进程重启会丢掉在跑的任务。
   *
   * **不在跑就停下来。** 服务端返回 failed（跑挂了，而且不自动重试）或 idle（demo 那一
   * 档不叫模型）时，继续每五秒轮一次是在等一件不会发生的事，屏幕上那句「正在跑」也就
   * 成了一个不会兑现的承诺。停下来，然后照实说是哪一种。
   */
  /*
   * 任务表**每一轮都读**，不是只读一次。
   *
   * 原来这里只在开头打一下，拿到 failed/idle 就记下来，此外这个值再不更新 —— 因为
   * 当时屏幕上只有「在跑 / 等不到」两档，跑着的那一档说的话不随时间变。现在那一行
   * 要写出「正在写这一轮预研 · 第 2/2 步」，而那句话每一步都不一样：不跟着轮询就是
   * 一句会卡在第 1 步的假话。
   *
   * 记的时候连议题号一起记：同一个组件被复用去渲染另一张卡时，上一张卡的状态不能
   * 跟着留在屏幕上。
   */
  const [taskFor, setTask] = useState<{ id: string; task: TaskState } | null>(null);
  /*
   * 「就这条追问」把预研没答上来的那一条带进右栏的输入框（2026-09-05）。预研存在的目的是让他
   * 尽快判断值不值得投入，深入在对话里做 —— 所以未答问题就是对话的入口，不是一段只读的清单。
   * 走 `ChatPane.composerRef.quote`，和报告页「就这条追问」同一条路；发不发仍由他定。
   */
  const composer = useRef<{ quote: (text: string) => void } | null>(null);
  const preTask = taskFor?.id === id ? taskFor.task : null;
  // 这两档是「等不到」：failed 不自动重试，idle 是这一档根本不叫模型。
  const stalled =
    preTask && (preTask.status === "failed" || preTask.status === "idle") ? preTask : null;
  const pending = Boolean(res.data && !res.data.pre) && !stalled;
  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const read = (p: Promise<TaskState>) => {
      void p.then((st) => alive && setTask({ id, task: st })).catch(() => {});
    };
    // 第一下走 `startPreResearch`（兜底进程重启丢掉的那一轮），往后每五秒只**读**状态。
    // 两头读的是同一张任务表，但 start 那一头带副作用 —— 不该每五秒敲一次。
    read(api.startPreResearch(id));
    const t = setInterval(() => {
      if (!alive) return;
      void res.mutate();
      read(api.preResearchStatus(id));
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pending, id, res]);

  return (
    /*
     * 与首页同一条阅读宽度（1180px）并居中。
     *
     * 这一页原来铺满 1600px，而首页收在 1180px 里 —— 从首页点进一张卡，整块内容会
     * 往两边弹开一截，读的人以为进了另一个产品。两页的容器必须是同一条。
     */
    <div className="animate-panel mx-auto flex h-[calc(100vh-4rem)] w-full max-w-[1180px] flex-col overflow-hidden px-5 pt-4 pb-4 sm:px-6">
      <AsyncBoundary resource={res} skeleton={<SignalSkeleton />}>
        {(d) => (
          <div className="grid min-h-0 flex-1 items-stretch gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
            <SidePanel
              detail={d}
              preTask={preTask}
              onChanged={() => res.mutate()}
              onAsk={(text) => composer.current?.quote(text)}
            />
            <ChatPane
              issueId={id}
              ephemeral
              composerRef={composer}
              /*
               * 这一栏是**上次聊到哪**，不是一排等着点的预设问题。
               *
               * 一号位再点进这张卡，他要接着上次往下问；给他六颗按钮，等于让他把
               * 已经问过的话再问一遍，而屏幕上还看不出上一轮谈出了什么。
               */
              transcriptKey={id}
              note="分诊对谈记录"
            />
          </div>
        )}
      </AsyncBoundary>
    </div>
  );
}

/**
 * 参谋读完预研之后的那一段 —— 这一页的主体。
 *
 * 三层，一层压一层：
 *
 *   判断        `pre.take`         最大的字。他点进来要的就是这一段。
 *   支持信息    `pre.finding`      只有正文。判断和依据之间不隔任何东西。
 *   报告原文    折叠，默认关         依据的依据。点开是主动动作。
 *
 * 上一版这一块钉在**对话栏顶上**。挪到左栏是因为它不是「对话的开场白」——
 * 它是这一页的内容，而对话是他拿它去追问的地方。钉在对话上的后果是：他一开始追问，
 * 它就被顶上去看不见了，而他追问的正是它。
 */
/**
 * 参谋这一轮的定性结论 —— 只在它**不是**「成立」的时候出现。
 *
 * 成立时不加这一条：一份预研默认就是在讲一个成立的议题，给它挂一枚「有效」徽章，
 * 等于让屏幕上每一页都多一个不改变任何决定的色块。
 *
 * `status` 是 null 的（跑在这个字段之前的旧预研，或者模型没给、重试也没补上）
 * 同样什么都不显示 —— 不知道就是不知道，不许显示成「成立」。那次运行带着 p0
 * 落在运营台上，该在那里被发现。
 */
/**
 * 批判与裁决的结果（2026-09-05）。**固定显示，不参与篇幅取舍**：批判打回过、批判没跑成，
 * 都是他读结论时要先知道的事 —— v2 把它藏在卡片末段、超预算就丢，ISS-224 那次打回没有一个人看见。
 * `ok` 不显示：过了就是过了，不用每页多一个绿条。
 */
function QualityStrip({ pre }: { pre: PreResearchDoc }) {
  const q = pre.quality;
  if (!q || q.state === "ok") return null;
  const label =
    q.state === "corrected"
      ? "批判打回过一次，已按意见重写"
      : q.state === "needsCorrection"
        ? "这一轮的结论没有通过批判 —— 读的时候打折"
        : "批判那一步没跑成 —— 这一轮的结论没有人复核过";
  return (
    <div className={cn("animate-fade mt-2 border-l-2 pl-3", q.state === "corrected" ? "border-l-confirmed" : "border-l-counter")}>
      <p className="meta text-ink">{label}</p>
      {q.notes.slice(0, 2).map((n, i) => (
        <p key={i} className="mt-1 text-sm leading-relaxed text-ink-muted">
          {n}
        </p>
      ))}
    </div>
  );
}

/**
 * 一号位给定的前提（2026-09-05）。一行，说清「这几条是按您说的算的」——
 * 它既是诚实（本体没记录，我们没去查），也是防线（模型不许用本体缺失否定它）。
 */
function PremiseLine({ pre }: { pre: PreResearchDoc }) {
  const list = pre.premises ?? [];
  if (!list.length) return null;
  return (
    <p className="meta mt-2 text-ink-faint">
      按您给定的事实作为前提（未另行核验）：{list.map((p) => p.text).join("；")}
    </p>
  );
}

function StatusStrip({ pre }: { pre: PreResearchDoc }) {
  if (pre.status !== "invalid" && pre.status !== "reframing_needed") return null;
  const invalid = pre.status === "invalid";
  const reason = pre.statusReason.trim();

  return (
    <div
      className={cn(
        "animate-fade mt-2 border-l-2 pl-3",
        invalid ? "border-l-counter" : "border-l-judgment"
      )}
    >
      <p className="meta text-ink">
        {invalid ? "参谋判这条不值得继续投入" : "参谋认为这条议题的说法要先改"}
      </p>
      {reason && <p className="mt-1 text-sm leading-relaxed text-ink-muted">{reason}</p>}
    </div>
  );
}

function Verdict({ pre }: { pre: PreResearchDoc }) {
  const [open, setOpen] = useState(false);
  const took = researchTookText(pre.durationMs);

  return (
    <section>
      {/*
       * 用时接在时刻后面。这一行答的是「这段判断有多新」，用时答的是「它是花了多少
       * 力气得来的」—— 一分钟出来的和三分钟出来的不是同一种东西（三分钟通常意味着
       * 质量门打回重修过）。老预研没有这个字段，那时整段不出现（`researchTookText`）。
       */}
      <p className="meta text-ink-faint">
        参谋 · 对研究的解读 · {formatStamp(pre.at)}
        {took ? ` · ${took}` : ""}
      </p>

      <StatusStrip pre={pre} />
      <QualityStrip pre={pre} />
      {/*
       * 一针见血的那一句（2026-09-05）：这一页最大的字。他只读这一句就能决定要不要往下看；
       * `take` 是它的展开。老预研没有这个字段，那时整段不出现。
       */}
      {pre.verdict?.trim() && (
        <p className="report mt-3 text-lg leading-snug text-ink">{pre.verdict.trim()}</p>
      )}
      <PremiseLine pre={pre} />

      {/* 判断。AgentText 按空行分段渲染纯文本，「反问：」那段会渲染成挑战块。
          字号字族都由 AgentText 自己的段落给（`.talk` + `text-md`）—— 这里原来那档
          `report text-lg` 一直被内层的段落盖掉，留着只会让人以为改它有用。
          也就是说这一段的字号跟着右栏对话走：改 `AgentText`，这里一起变。 */}
      <div className="mt-2">
        <AgentText text={pre.take} />
      </div>

      {/*
       * 支持这个判断的信息。**这里不挂溯源徽章。**
       *
       * 这一页只花他三分钟，要的是内容：参谋读完之后说了什么、凭哪几件事这么说。
       * 每条后面跟两三枚徽章之后，三段话变成三段话加八个色块，眼睛先扫到的是色块 ——
       * 而色块在这个决定里一点忙都帮不上：他此刻要判断的是「值不值得投入」，不是
       * 「这句话可不可信」。
       *
       * 出处一条没丢，全在下面那个折叠的预研报告原文里（`StatementList` 带徽章）。
       * 核对是一个主动动作，就该藏在一次点击后面。
       */}
      {pre.finding.length > 0 && (
        <ul className="mt-4 space-y-2.5 border-t border-hairline pt-3">
          {pre.finding.map((f, i) => (
            <li key={i} className="text-sm leading-relaxed text-ink-muted">
              {/*
               * 判断式短标题加粗，正文接在后面 —— 方法域 S02 的产出案例里每条依据都是
               * 这个形状：先一句判断，再是支撑它的事实。
               *
               * **加粗是这里做的。** 模型只给 `label` 和 `text` 两个字段，星号一个都
               * 不写（写了会原样显示，而 `FE-md` 是 p0）。同一件事在
               * `StatementLine` 里也做了一遍 —— 那是折叠的报告原文，这里是不挂徽章的
               * 摘要版，两处的版面本来就不一样，共用一个组件反而要往里塞开关。
               */}
              {f.label?.trim() && (
                <strong className="font-medium text-ink">{asSentence(f.label.trim())} </strong>
              )}
              {f.text}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="meta mt-3 inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-ink-muted transition-colors duration-fast ease-swift hover:border-hairline-strong hover:text-ink"
      >
        {open ? "收起预研报告原文" : "查看预研报告原文"}
        <ChevronDown
          className={cn("size-3.5 transition-transform duration-base ease-swift", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open && (
        <article className="animate-fade mt-3 space-y-4 rounded-xl border border-hairline bg-paper px-4 py-4">
          <div>
            <h3 className="meta mb-1.5 text-ink-faint">这轮预研要回答的</h3>
            <p className="report text-base text-ink">{pre.question}</p>
          </div>
          <div>
            <h3 className="meta mb-1.5 text-ink-faint">查到了什么</h3>
            <StatementList statements={pre.finding} />
          </div>
          <div>
            <h3 className="meta mb-1.5 text-ink-faint">这一轮还答不上来的</h3>
            <StatementList statements={pre.openQuestion} />
          </div>
          <div>
            <h3 className="meta mb-1.5 text-ink-faint">所以呢</h3>
            <p className="report text-base text-ink">{pre.soWhat}</p>
          </div>
          <p className="meta border-t border-hairline pt-2.5 text-ink-faint">
            {pre.byAgentLabel} · 装配自 {pre.assembledFrom.map((m) => m.label).join(" / ")}
          </p>
        </article>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 这条议题是怎么被问出来的 —— S01 那四块，**详情页摊开，卡面不动**。
 *
 * 位置在标题之下、参谋的解读之上，因为认知链就是这个顺序：先把问题问对（S01），
 * 再判它值不值得投入（S02 预研）。反过来摆的话，一号位读到的是「参谋说这条值得深研」，
 * 而「这条到底在问什么、证据到哪儿为止」还在下面 —— 他会先信结论，再去找依据。
 *
 * 小标题只有这一页有（卡面一个都没有，见 `Card`）。差别在于卡面那三拍本来是一句话，
 * 这四块本来是四件事：一件事一个小标题，是替他省下「这一段在回答什么」这一次辨认。
 * 标题那一块不配小标题 —— 它已经是这一页最大的那行字。
 *
 * 顺序、小标题、「证据边界：」那个前缀，全在 `framingBlocks()` 里，这里只渲染。
 */
function Framing({ card }: { card: Card }) {
  const blocks = framingBlocks(card.framing);
  if (blocks.length === 0) return null;

  return (
    <section id="sec-framing" className="border-t border-hairline pt-3">
      <div className="space-y-3">
        {blocks.map((b) => (
          <div key={b.id}>
            {b.label && <h3 className="meta mb-1 text-ink-faint">{b.label}</h3>}
            {b.paragraphs.map((p, i) => (
              <p
                key={i}
                className={cn(
                  "report text-sm leading-relaxed text-ink-muted",
                  i > 0 && "mt-1.5",
                  /* 第一块（议题正文）是这一页的第二重点，比其余几块重一档。 */
                  b.id === "statement" && "text-base text-ink",
                )}
              >
                {p}
              </p>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

/** 长到这个数就默认折叠。以下原样摊开 —— 三行字藏在一次点击后面是白让他点一下。 */
const FOLD_OVER = 400;

/**
 * 这段原文是谁的话 —— 四种来路四句不同的措辞。
 *
 * 不写「原始材料」这种统一说法：一号位读这一段时最要紧的一件事是**这几个字是谁写的**。
 * 他自己贴进来的那一篇，和雷达从公开网页上抓回来的那一篇，可信度的来源完全不同，而屏幕
 * 上如果只写「原文」，那道区别就只能靠他自己记得。
 */
function materialLabel(card: Card): string {
  switch (card.source.kind) {
    case "ceo":
      return "您贴进来的原文";
    case "dri":
      return `${card.source.by} 递上来的原文`;
    case "radar":
      return "抓回来的原文";
    case "probe":
      return "从研讨里带出来的那一段";
  }
}

/**
 * 原文。**这一段以前在这一页上根本不存在** —— `card.what` 只在提请台那一屏渲染，点进来
 * 之后它就没了。以前不明显，因为那时 `what` 是雷达写的两三句话；现在他可以往里贴一整篇
 * 文章，那一整篇必须在这一页读得到，否则「查看预研报告」就成了唯一的入口，而报告是参谋
 * 读完之后写的东西，不是他贴的那份东西。
 *
 * 长的默认折叠：这一页的顺序是**标题 → 参谋的解读 → 报告 → 原文**，因为他点进来要的是
 * 「有人读完之后说了什么」。原文摊在解读上面会把那一段挤下去；摊在下面也不行 —— 六千字
 * 顶在「它动摇哪条判断」前面，那两段就再也读不到了。
 */
function Material({ card }: { card: Card }) {
  const [open, setOpen] = useState(false);
  const text = card.what
    .map((w) => w.text)
    .join("\n\n")
    .trim();
  if (!text) return null;

  const label = materialLabel(card);
  /*
   * 摊开就整段摊开，**不在这里再套一个自己的滚动条**。
   *
   * 这一段原来是 `max-h-[32rem] overflow-y-auto`。看着更收敛，实际上两个毛病：滚轮
   * 落在哪个盒子上决定了滚的是哪一层（他要往下读整页，指针恰好在原文上就只滚了原文
   * 里的六百字）；而左栏被这一档封住之后总高涨不上去，那几颗跳转点就永远不出现 ——
   * 等于用两套机制解同一个问题，还都解不好。长度这件事交给折叠按钮和跳转点。
   */
  const body = (
    <div className="report mt-3 rounded-xl border border-hairline bg-paper px-4 py-3 text-sm leading-relaxed whitespace-pre-line text-ink-muted">
      {text}
    </div>
  );

  // 短的原样摊开，不给按钮。
  if (text.length <= FOLD_OVER) {
    return (
      <section id="sec-material" className="border-t border-hairline pt-3">
        <h2 className="meta text-ink-faint">{label}</h2>
        {body}
      </section>
    );
  }

  return (
    <section id="sec-material" className="border-t border-hairline pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="meta inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-ink-muted transition-colors duration-fast ease-swift hover:border-hairline-strong hover:text-ink"
      >
        {/* 字数写在按钮上：他要先知道点开的是三屏还是三十屏，再决定现在读不读。 */}
        {open ? `收起${label}` : `查看${label} · 约 ${text.length} 字`}
        <ChevronDown
          className={cn("size-3.5 transition-transform duration-base ease-swift", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open && <div className="animate-fade">{body}</div>}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function SidePanel({
  detail,
  preTask,
  onChanged,
  onAsk,
}: {
  detail: SignalDetail;
  /** 把一句话带进右栏输入框。见 `SignalView` 里 `composer` 那段。 */
  onAsk?: (text: string) => void;
  /**
   * 预研这一轮此刻的状态，每五秒读一次（见 `SignalView` 里的轮询）。
   *
   * 四档都要用到：`failed`/`idle` 是「等不到」，`running` 带着走到第几步和什么时候
   * 起的，还没读到时是 null —— 那一档只说在跑。
   */
  preTask: TaskState | null;
  onChanged: () => void;
}) {
  const { card, pre, judgments } = detail;
  const router = useRouter();
  const invalidate = useInvalidate();
  const assigneesRes = useResource<DriOption[]>("dris", () => api.listDris());
  const [busy, setBusy] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const hasMaterial = card.what.some((w) => w.text.trim().length > 0);
  const hasFraming = framingBlocks(card.framing).length > 0;
  const hasVerdict = Boolean(pre);
  const hasOpen = Boolean(pre && pre.openQuestion.length > 0);
  const materialTitle = materialLabel(card);
  /*
   * 圆点认哪几段。**按屏幕上真的渲染了什么算**，不是按「这一页有哪几段」列一份固定清单：
   * 预研没跑成的时候没有解读那一段，指过去的那颗点会滚到一个不存在的锚上，而屏幕上看
   * 起来只是「点了没反应」。
   *
   * 记住这份清单，而且只认上面那几个布尔值 —— 预研在跑的时候这一页每两秒重问一次，
   * `pre` 每一轮都是一个新对象。不记的话每一轮都换出一份新数组，`SectionDots` 里那两个
   * observer 就跟着拆一次装一次；重装本身不出错，但那是白拆的。
   */
  const sections: Section[] = useMemo(
    () => [
      { id: "sec-head", label: "标题" },
      ...(hasFraming ? [{ id: "sec-framing", label: "这条议题在问什么" }] : []),
      ...(hasVerdict ? [{ id: "sec-verdict", label: "参谋的解读" }] : []),
      ...(hasMaterial ? [{ id: "sec-material", label: materialTitle }] : []),
      { id: "sec-judgments", label: "它动摇哪条判断" },
      ...(hasOpen ? [{ id: "sec-open", label: "升级深研会去查这些" }] : []),
    ],
    [hasFraming, hasVerdict, hasMaterial, hasOpen, materialTitle],
  );

  // 出处。**这一页以前一条都不显示** —— `card.refs` 只存着，没人渲染。他贴的那个链接
  // 抓不到正文时，这一行是屏幕上唯一还能点开那篇东西的地方。
  const links = card.refs.filter((r) => r.href);

  /*
   * 三个出口，全部在这一页 —— 卡片上一个按钮都没有了。
   *
   * 这不是把按钮换个地方摆：处置发生在他**读过参谋的判断、看过支持信息、
   * 可以随时展开预研原文、也可以先问几句**之后。摆在清单上的处置键，要求他在
   * 没有这些东西的情况下拍板，而那正是 Sensor 出卡门槛想避免的事。
   */
  const dispose = async (action: "discuss" | "dismiss", assignee?: string) => {
    setBusy(action);
    try {
      // H2 —— 服务端说了算。它答应之前，屏幕上什么都不动。
      const issue = await api.disposeCard(card.id, action, undefined, assignee);
      setDone(
        action === "dismiss"
          ? "已忽略 · 记在处置记录里"
          : issue.researchReady
            // 报告已经在手上就别说「已启动」——「启动了」和「已经好了」是两句
            // 完全不同的话，而他下一步的动作（现在就进去读 / 等通知）取决于哪一句。
            ? `已升级为议题 ${issue.id} · 深研报告已就绪`
            : `已升级为议题 ${issue.id} · 深度研究已启动`,
      );
      onChanged();

      /*
       * 升级完就回首页 —— 那件事已经不在这一页了，它现在是「进行中」清单上的一条。
       *
       * 走之前先把首页那几份清单作废：不作废的话 SWR 会拿缓存渲染，一号位回到首页
       * 看不见刚升上来的那件议题，只能自己按刷新 —— 而他会以为是没升成功。
       */
      if (action === "discuss") {
        invalidate();
        router.push("/");
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    /*
     * 两层：上面是会滚的内容，下面是**钉住的三键**。
     *
     * 处置键原来跟着内容一起滚 —— 读到预研原文中间，出口就滑出屏幕了，他得先滚回底部
     * 才能决定。这一页的全部意义就是那一下决定，决定的入口不该需要先找。
     */
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-hairline bg-surface">
      {/*
       * 圆点导航挂在滚动区**内侧**，所以要一层 `relative` 包住它 —— 挂在 `aside` 上的话
       * 那一列点会盖到下面钉住的三键上。左边 `pl-7` 就是给它腾的那条槽。
       */}
      <div className="relative flex min-h-0 flex-1">
        <SectionDots scroller={scroller} sections={sections} />
        <div
          ref={scroller}
          className="scroll-slim flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-4 pr-4 pl-7"
        >
        <div id="sec-head">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="meta text-ink-faint">{card.issueId}</span>
            <span className="meta rounded-[3px] bg-neutral-wash px-1.5 py-[1px] text-ink-muted">
              {cardSourceLabel(card.source)}
            </span>
            <span className="meta text-ink-faint">· {formatStamp(card.createdAt)}</span>
          </p>
          {/* 标题与那颗改题的键是一个共用组件（议题研究页顶栏是同一个）—— 理由见
              `components/issue-title.tsx`：卡面这一行和议题标题是同一个字符串。 */}
          <IssueTitle
            issueId={card.issueId}
            title={card.headline}
            className="mt-2 items-start"
            titleClassName="report text-lg leading-relaxed font-medium text-ink"
            onRenamed={() => {
              onChanged();
              /* 这行字在别处也摆着（清单、去向记录、议题研究页顶栏）。 */
              invalidate(`signal:${card.issueId}`);
            }}
          />
          {/*
           * 这行标题是参谋起的。
           *
           * 只有他贴了一整篇或一个链接时才出现 —— 那一大段东西自己当不了标题，参谋读一遍
           * 起了一行。这句话必须说出来，因为他接着要读的正是他自己贴的那段原文：不说的话，
           * 他会以为最上面那行大字是他自己写的，而它不是。
           *
           * 卡面上不说（见 `Card.titleByModel`）。
           */}
          {card.titleByModel && (
            <p className="meta mt-1.5 text-ink-faint">标题是参谋起的</p>
          )}
          {/*
           * 关于原文要照实交代的那一句：截了多少字、链接没抓到（连原因）、正文是粗抽的。
           *
           * 摆在这里而不是摆在原文那一段里，因为**最要紧的那一种恰好是没有原文的那一种**：
           * 链接抓不到时下面根本没有原文那一段，那句「参谋没读过它」就跟着不见了 ——
           * 而它是这一页此刻最重要的一句话。
           */}
          {card.materialNote && (
            <p className="meta mt-1.5 leading-relaxed text-ink-muted">{card.materialNote}</p>
          )}
          {links.length > 0 && (
            <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              {links.map((r, i) => (
                <a
                  key={i}
                  href={r.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="meta inline-flex items-center gap-1 rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
                >
                  {r.source}
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              ))}
            </p>
          )}
        </div>

        {/*
         * 这条议题是怎么被问出来的（S01 那四块）。没经过 issue framing 的卡上没有这一
         * 段 —— 他自己贴进来的那一条，和种子数据里的卡。
         */}
        <Framing card={card} />

        {/*
         * 参谋的判断。预研还在跑时照实说在跑 —— 空着会被读成「没什么可说的」。
         *
         * 空还有另外两种原因，它们和「在跑」的区别是**要不要继续等**：跑挂了不会自动
         * 重试，等下去等不到；这一档不跑模型的话，这张卡上永远不会有这一段。三种情况
         * 共用一句「正在跑」，他就会一直等一件不会发生的事。
         */}
        {pre ? (
          <div id="sec-verdict" className="border-t border-hairline pt-3">
            <Verdict pre={pre} />
          </div>
        ) : preTask?.status === "failed" ? (
          <p className="meta border-t border-hairline pt-3 text-counter">
            预研没跑成，不会自动重试 —— 这张卡上没有参谋的判断。
          </p>
        ) : preTask?.status === "idle" ? (
          <p className="meta border-t border-hairline pt-3 text-ink-faint">
            这张卡没有预研，也没有一轮在跑。
          </p>
        ) : (
          /*
           * 在跑。屏幕上只有**会变的事实** —— 走到第几步、已经跑了多久，每五秒往前挪
           * 一格。它会呼吸，因为它是活的。
           */
          <div className="border-t border-hairline pt-3">
            <ResearchStepLine
              className="meta"
              step={preTask?.status === "running" ? preTask.step : undefined}
              startedAt={preTask?.status === "running" ? preTask.startedAt : undefined}
              fallback="预研正在跑"
            />
          </div>
        )}

        {/* 他贴进来 / 递上来的那份东西本身。长的默认折叠（见 `Material`）。 */}
        <Material card={card} />

        {/*
         * 它动摇哪条判断。分诊的实质就是拿这条信号去比对在版判断 —— 原文不在屏幕上，
         * 他就得靠记忆比对，而记忆里的判断永远是他希望它是的样子。
         */}
        <section id="sec-judgments" className="border-t border-hairline pt-3">
          <h2 className="meta mb-2 text-ink-faint">它动摇哪条判断</h2>
          <ul className="space-y-2">
            {judgments.map((j) => (
              <li key={j.id} className="flex items-baseline gap-2">
                <CodeBadge
                  code={j.id}
                  className={cn(
                    "meta shrink-0 rounded-[3px] px-1.5 py-[1px] font-medium",
                    j.standing === "shaking" ? "bg-judgment text-surface" : "bg-solid text-solid-fg",
                  )}
                />
                <span className="text-sm leading-relaxed text-ink-muted">{j.statement}</span>
              </li>
            ))}
          </ul>
        </section>

        {/*
         * 预研还答不上来的 —— 这一页最有用的一段。他决定要不要升级，看的不是已经查到了
         * 什么，是**还能查到什么**。
         */}
        {pre && pre.openQuestion.length > 0 && (
          <section id="sec-open" className="border-t border-hairline pt-3">
            <h2 className="meta mb-2 text-ink-faint">
              升级深研会去查这些 · 预研没答上来 {pre.openQuestion.length} 条
            </h2>
            <ul className="space-y-1.5">
              {pre.openQuestion.map((q, i) => (
                <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-ink-muted">
                  <span className="min-w-0 flex-1">· {q.text}</span>
                  {onAsk && (
                    <button
                      type="button"
                      className="meta shrink-0 text-judgment hover:underline"
                      onClick={() => onAsk(`关于预研没答上来的这一条：「${q.text}」\n你现在能说到哪一步？还差什么材料？`)}
                    >
                      就这条追问
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        </div>
      </div>

      {/* 这一页的终点。聊完还要往回找出口的页面，等于把决定推到了下一次。 */}
      <section className="shrink-0 border-t border-hairline px-4 py-3">
        {done ? (
          <p className="meta text-confirmed">{done}</p>
        ) : (
          /*
           * 两键，不是三键。
           *
           * ## 为什么「指派并开始」不再是一颗独立的键
           *
           * 它和主键做的是**同一件事**（升级 + 自动开始深研），只是多带一个参数，却占了
           * 三分之一的版面宽度，还要把整个底栏换成另一副样子（下拉 + 确认 + 取消）。
           * 一个次要出口长得和主出口一样重、做的又是同一件事，读的人得先分辨这两颗有
           * 什么不同 —— 而答案是「几乎没有」。
           *
           * **指派不是升级的前提**：深研自动开始，跟有没有承接人无关。把它做成升级前的
           * 一道关，等于逼每个人都处理一个多数时候会跳过的决定。
           *
           * ## 为什么是这颗键右边一个箭头，不是升级完再补
           *
           * 因为**升级成功之后这一页就跳回首页了**（见 `dispose`）。回执只存在一瞬间，
           * 挂在回执上的下拉根本来不及点。所以指派只能在升级**之前**这一下里给出去。
           *
           * 分成键体和箭头两半之后，两条路都是**一次点击**：不指派的人点键体，一下升完；
           * 要指派的人点箭头挑一个名字，那一下同时完成升级和指派。谁都不用多按一次确认。
           *
           * 议题页顶栏本来就有指派，所以这个箭头是顺手，不是唯一入口 —— 跳过了不会丢。
           */
          <div className="relative grid grid-cols-[1fr_auto] gap-1.5">
            {assigning && (
              <>
                {/*
                 * 点别处关掉。用一层透明底板，不挂 document 监听 —— 监听要自己管
                 * 装卸和「这一下算不算点在弹层里」，底板天然只吃外面那一下。
                 */}
                <div className="fixed inset-0 z-10" onClick={() => setAssigning(false)} />
                {/*
                 * 往**上**弹：这一栏钉在底部，往下没有地方。
                 */}
                <div className="absolute bottom-full left-0 z-20 mb-1.5 w-full overflow-hidden rounded-lg border border-hairline bg-surface shadow-lg">
                  <p className="meta border-b border-hairline px-3 py-2 text-ink-faint">
                    升级并指派给
                  </p>
                  <ul className="max-h-56 overflow-y-auto py-1">
                    {(assigneesRes.data ?? []).map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => {
                            setAssigning(false);
                            void dispose("discuss", p.id);
                          }}
                          className="block w-full px-3 py-1.5 text-left transition-colors duration-fast hover:bg-neutral-wash disabled:opacity-40"
                        >
                          <DriRow person={p} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            {/*
             * 键体与箭头是**两颗按钮共用一副外观**：中间那道竖线是分界，圆角只在两头。
             * 做成一颗按钮套一个图标的话，点箭头会连带触发升级 —— 那正是这个控件要防的。
             */}
            <div className="flex">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void dispose("discuss")}
                className="meta inline-flex h-9 flex-1 items-center justify-center gap-1 rounded-l-lg bg-solid px-2 font-medium whitespace-nowrap text-solid-fg transition-opacity duration-fast ease-swift hover:opacity-90 disabled:opacity-40"
              >
                <Search className="size-3.5" aria-hidden />
                {busy === "discuss" ? "正在启动…" : "升级为战略议题"}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                aria-label="升级并指派承接人"
                aria-haspopup="menu"
                aria-expanded={assigning}
                onClick={() => setAssigning((x) => !x)}
                className="meta inline-flex h-9 items-center rounded-r-lg border-l border-solid-fg/25 bg-solid px-2 text-solid-fg transition-opacity duration-fast ease-swift hover:opacity-90 disabled:opacity-40"
              >
                <UserRound className="size-3.5" aria-hidden />
                <ChevronDown className="size-3" aria-hidden />
              </button>
            </div>

            <Act
              icon={<EyeOff className="size-3.5" aria-hidden />}
              label={busy === "dismiss" ? "正在收起…" : "忽略"}
              tone="bare"
              disabled={busy !== null}
              onClick={() => void dispose("dismiss")}
            />
          </div>
        )}
      </section>
    </aside>
  );
}

/** 动作按重量分三档：实心=主出口，描边=次要出口，无框=降级。 */
function Act({
  icon,
  label,
  tone,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "solid" | "outline" | "bare";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "meta inline-flex h-9 w-full items-center justify-center gap-1 rounded-lg px-1 font-medium whitespace-nowrap transition-colors duration-fast ease-swift disabled:opacity-40",
        tone === "solid" && "bg-solid text-solid-fg hover:opacity-90",
        tone === "outline" && "border border-hairline-strong text-ink hover:bg-neutral-wash",
        tone === "bare" && "text-ink-faint hover:text-ink-muted",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function SignalSkeleton() {
  return (
    <div aria-live="polite" className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      {[0, 1].map((n) => (
        <div key={n} className="rounded-xl border border-hairline p-4">
          <span className="skeleton block h-3 w-24" />
          <span className="skeleton mt-4 block h-3.5 w-full" />
          <span className="skeleton mt-1.5 block h-3.5 w-[70%]" />
        </div>
      ))}
    </div>
  );
}
