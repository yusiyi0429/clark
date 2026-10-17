import type { CSSProperties, ReactNode } from "react";
import { Check, ChevronDown, MessageCircle, MessageSquareQuote, PencilLine } from "lucide-react";
import type { TourStep } from "./PagedTour";
import x from "./execution-tour.module.css";
import m from "./mission-card-tour.module.css";

const at = (ms: number, extra?: Record<string, string>) => ({ "--t": `${ms}ms`, ...extra }) as CSSProperties;

function Typed({ text, start, speed = 65 }: { text: string; start: number; speed?: number }) {
  return <>{[...text].map((char, index) => <span key={index} className={x.char} style={at(start + index * speed)}>{char}</span>)}</>;
}

function Tap({ start }: { start: number }) {
  return <span className={x.tap} style={at(start)} aria-hidden />;
}

function Document({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`${x.panel} ${m.document} ${className}`}>
    <p className={m.eyebrow}>流程示例 · 任务细节</p>
    <h4 className={x.heading}>完成 CEO 与 DRI 双视角走查</h4>
    <p className={m.documentIntro}>从两个身份出发，逐页核对同一份任务的内容与权限。</p>
    {children}
    <ul><li>按人核对四张任务卡</li><li>逐条审阅五条讨论意见</li></ul>
  </section>;
}

function SelectionMenu({ start, tap, quote = false }: { start: number; tap?: number; quote?: boolean }) {
  return <span className={`${m.selectionTools} ${x.in}`} style={at(start)}>
    <span className={quote ? undefined : m.chosen}><PencilLine size={13} />直接批注{tap !== undefined && !quote ? <Tap start={tap} /> : null}</span>
    <i />
    <span className={quote ? m.chosen : undefined}><MessageSquareQuote size={13} />引用并对话{tap !== undefined && quote ? <Tap start={tap} /> : null}</span>
  </span>;
}

function Annotation({ children, start = 0 }: { children: ReactNode; start?: number }) {
  return <span className={`${m.annotated} ${x.show}`} style={at(start)}>{children}<span className={m.annotationBubble}><MessageCircle size={10} /></span></span>;
}

function SceneGoals() {
  return <div className={`${x.scene} ${x.center}`}>
    <section className={`${x.panel} ${m.goalPage}`}>
      <p className={m.caseLabel}>流程示例</p>
      <header className={m.pageHeader}>
        <p className={x.meta}>孙铭泽 · 10月任务</p>
        <span className={m.pendingStatus}>待本人确认</span><div className={m.viewChooser}>
          <span className={m.viewButton}>任务细节<ChevronDown size={12} /><Tap start={800} /></span>
          <div className={`${m.viewMenu} ${x.window}`} style={at(1100, { "--len": "1160ms" })}>
            <span className={m.viewChoice} data-selected="true"><Check size={12} /><span>任务细节</span></span>
            <span className={m.viewChoice} data-disabled="true"><span aria-hidden /><span>执行拆分</span><small>下一版</small></span>
          </div>
        </div>
      </header>
      <div className={`${m.goals} ${x.in}`} style={at(400)}>
        <div><span>长期目标</span><p>形成可复核的界面与权限证据。</p></div>
        <div><span>本月目标</span><p>完成 CEO 与 DRI 双视角走查。</p></div>
      </div>
      <div className={`${m.pageBody} ${x.in}`} style={at(1800)}>
        <h4 className={x.heading}>完成 CEO 与 DRI 双视角走查</h4>
        <p>按人核对四张任务卡，逐条审阅五条讨论意见。</p>
        <p className={m.soft}>把要做成什么、如何验证，写成一份清晰的任务文档。</p>
      </div>
    </section>
  </div>;
}

function SceneSelect() {
  return <div className={`${x.scene} ${x.center}`}>
    <Document>
      <p className={m.selectedLine}>交付 <mark className={x.mark} style={at(700)}>界面与权限证据</mark>，每条修改都可追溯。
        <SelectionMenu start={1600} tap={2500} />
      </p>
    </Document>
  </div>;
}

function SceneComment() {
  return <div className={`${x.scene} ${x.center}`}>
    <Document className={m.commentDocument}>
      <p className={m.selectedLine}>交付 <Annotation start={3500}>界面与权限证据</Annotation>，每条修改都可追溯。</p>
      <div className={`${m.inlineEditor} ${x.window}`} style={at(400, { "--len": "2900ms" })}>
        <div className={m.editorText}><span className={`${m.editorPlaceholder} ${x.window}`} style={at(400, { "--len": "450ms" })}>写下修改意见</span><Typed text="这里补上每个身份的页面截图。" start={850} speed={60} /></div>
        <div className={m.editorActions}><span className={m.saveAction}>保存<Tap start={2600} /></span><span>立即修改</span></div>
      </div>
      <div className={`${m.savedNote} ${x.in}`} style={at(3700)}><Check size={14} /><span>备注已保存 · 正文保持原样</span></div>
      <p className={`${m.revisionNote} ${x.in}`} style={at(4400)}>备注可以随任务提交，供 Co-Agent 统一核对。</p>
    </Document>
  </div>;
}

function SceneReview() {
  return <div className={`${x.scene} ${x.docSplit}`}>
    <Document>
      <p>交付界面与权限证据，每条修改都可追溯。</p>
      <div className={m.rewrite}>
        <p className={x.window} style={at(0, { "--len": "3600ms" })}>核验四张任务卡与五条意见。</p>
        <p className={x.show} style={at(3700)}>核验 <Annotation start={3700}>四张任务卡的每个字段，列出五条意见的处理结论</Annotation>。</p>
      </div>
      <p className={`${m.revisionNote} ${x.in}`} style={at(4900)}>正文显示最新内容；悬浮小图标查看原文与依据。</p>
      <div className={`${m.recordPreview} ${x.window}`} style={at(5200, { "--len": "1600ms" })}><small>原文</small><p>核验四张任务卡与五条意见。</p><small>修改依据</small><p>本人选择：逐项核对每个字段</p></div>
    </Document>
    <aside className={m.clarificationStage}>
      <section className={`${x.panel} ${m.questionPanel} ${x.window}`} style={at(600, { "--len": "2800ms" })}>
        <p className={x.label}>Co-Agent 想确认一下</p>
        <h5>「立即修改」后，核对具体到什么程度？</h5>
        <span className={m.questionOption} data-selected="true">逐项核对每个字段<Tap start={2500} /></span>
        <span className={m.questionOption}>只核对每张卡的目标</span>
        <span className={m.ownAnswer}>自己输入…</span>
      </section>
      <section className={`${x.panel} ${m.revisionReceipt} ${x.arrive}`} style={at(3800)}>
        <span className={m.receiptCheck}><Check size={18} /></span>
        <h5>已按你的回答修改</h5>
        <p>批注、澄清回答与修改记录一起留在任务里。</p>
      </section>
    </aside>
  </div>;
}

function ScenePrivateChat() {
  return <div className={`${x.scene} ${x.docSplit}`}>
    <Document>
      <p className={m.selectedLine}>交付 <mark className={x.mark} style={at(400)}>界面与权限证据</mark>，每条修改都可追溯。
        <SelectionMenu start={1100} tap={1900} quote />
      </p>
      <div className={`${m.confirmTask} ${x.window}`} style={at(4600, { "--len": "1100ms" })}><span>待本人确认</span><span className={m.confirmAction}>确认我的任务<Tap start={5000} /></span></div>
      <div className={m.reviewFlow}>
        <p className={x.in} style={at(5300)}><Check size={12} />本人已确认</p>
        <p className={x.in} style={at(5800)}>Co-Agent 统一核对任务与记录</p>
        <p className={x.in} style={at(6300)}>战场 DRI 确认任务组合</p>
      </div>
    </Document>
    <aside className={`${x.panel} ${x.chat} ${m.privateChat}`}>
      <p className={x.label}>与 Co-Agent 对话<span className={m.privateLabel}>仅自己可见</span></p>
      <div className={x.log}>
        <p className={`${x.bubbleAgent} ${x.in}`} style={at(4800)}>可以按身份列出页面截图，再核对每一项权限。</p>
      </div>
      <div className={`${m.quotePreview} ${x.in}`} style={at(2400)}><MessageSquareQuote size={12} /><span>引用</span></div>
      <div className={`${m.quoteTooltip} ${x.window}`} style={at(2600, { "--len": "1100ms" })}>界面与权限证据</div>
      <div className={x.composer}><span><Typed text="帮我理一下核验清单" start={2900} speed={65} /></span><span className={x.send}>↑<Tap start={4200} /></span></div>
    </aside>
  </div>;
}

export const MISSION_CARD_TOUR_STEPS = [
  { title: "从目标读到任务", body: "Co-Agent 起草后，先由本人核对。这是一个流程示例；执行拆分下一版开放。", duration: 2700, Scene: SceneGoals },
  { title: "在自己的任务上提出意见", body: "拖选、双击选词或三击选段，选择「直接批注」或「引用并对话」。本人确认前，只有本人能提出修改。", duration: 3300, Scene: SceneSelect },
  { title: "保存备注，或立即修改", body: "「保存」只留备注，正文保持原样，也可以确认任务；「立即修改」交给 Agent 处理。直接批注不写入私聊。", duration: 5200, Scene: SceneComment },
  { title: "清楚就改，不确定先问", body: "请求修改后，Agent 明确意图便立即改，有疑问先给选项，最后可自己输入。小图标保留原文、意见和修改记录；处理中需先处理或明确暂不修改。", duration: 6900, Scene: SceneReview },
  { title: "引用对话，确认自己的任务", body: "引用显示为小标记，私聊仅自己可见。本人确认后 Co-Agent 统一核对，战场 DRI 确认任务组合；CEO 签核本月目标。再次改正文须退回相关本人重新确认。", duration: 6800, Scene: ScenePrivateChat },
] as const satisfies readonly TourStep[];
