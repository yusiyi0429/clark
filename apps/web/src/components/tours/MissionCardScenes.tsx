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
    <p className={m.eyebrow}>任务细节</p>
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
      <header className={m.pageHeader}>
        <p className={x.meta}>孙铭泽 · 10月任务</p>
        <div className={m.viewChooser}>
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
      <p className={m.selectedLine}>交付 <Annotation start={3500}>界面与权限证据</Annotation><ins className={x.insert}><Typed text="，附每个身份的页面截图" start={3700} speed={40} /></ins>。</p>
      <div className={`${m.inlineEditor} ${x.window}`} style={at(400, { "--len": "2900ms" })}>
        <p className={m.editorLabel}>批注<span>同卡成员可见</span></p>
        <div className={m.editorText}><Typed text="这里补上每个身份的页面截图。" start={850} speed={60} /></div>
        <div className={m.editorActions}><span>取消</span><span>保存批注<Tap start={2600} /></span></div>
      </div>
      <div className={`${m.savedNote} ${x.in}`} style={at(4400)}><Check size={14} /><span>已按批注修改，原文与记录保留</span></div>
    </Document>
  </div>;
}

function SceneReview() {
  return <div className={`${x.scene} ${x.docSplit}`}>
    <Document>
      <p>交付界面与权限证据，每条修改都可追溯。</p>
      <p>核验 <del className={x.strike} style={at(3700)}>四张任务卡与五条意见</del><ins className={x.insert}><Typed text="四张任务卡的每个字段，列出五条意见的处理结论" start={4100} speed={45} /></ins>。</p>
      <p className={`${m.revisionNote} ${x.in}`} style={at(5500)}>原文 · 修改后 · 批注均保留，供最终审核</p>
    </Document>
    <aside className={m.clarificationStage}>
      <section className={`${x.panel} ${m.questionPanel} ${x.window}`} style={at(600, { "--len": "2800ms" })}>
        <p className={x.label}>Co-Agent 想确认一下</p>
        <h5>「核对四张任务卡」具体到什么程度？</h5>
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
      <p className={`${m.revisionNote} ${x.in}`} style={at(5000)}>完成本人审核 → 全员完成后自动汇总 → 拍板确认</p>
    </Document>
    <aside className={`${x.panel} ${x.chat} ${m.privateChat}`}>
      <p className={x.label}>与 Co-Agent 对话<span className={m.privateLabel}>仅自己可见</span></p>
      <div className={x.log}>
        <p className={`${x.bubbleAgent} ${x.in}`} style={at(4800)}>可以按身份列出页面截图，再核对每一项权限。</p>
      </div>
      <div className={`${m.quotePreview} ${x.in}`} style={at(2400)}><MessageSquareQuote size={12} /><span>界面与权限证据</span></div>
      <div className={x.composer}><span><Typed text="帮我理一下核验清单" start={2900} speed={65} /></span><span className={x.send}>↑<Tap start={4200} /></span></div>
    </aside>
  </div>;
}

export const MISSION_CARD_TOUR_STEPS = [
  { title: "从目标读到任务", body: "先看目标，再读任务。执行拆分由 Co-Agent 基于任务生成，下一版开放。", duration: 2700, Scene: SceneGoals },
  { title: "在文字上提出意见", body: "划选任务中的一段文字，选择「直接批注」或「引用并对话」。", duration: 3300, Scene: SceneSelect },
  { title: "批注就写在选中文字旁", body: "写好后保存。同卡成员可以看到批注；虚线下划线与小气泡标出位置，不写入私聊。", duration: 5200, Scene: SceneComment },
  { title: "清楚就改，不确定先问", body: "审核中且未完成审核时，Co-Agent 理解后立即修改；有疑问时在段落旁给出选项，也可自己输入。暂不修改时保留备注并写明原因。", duration: 6300, Scene: SceneReview },
  { title: "引用对话，完成本人审核", body: "引用进入仅自己可见的私聊。处理完批注后完成审核，全员完成自动汇总，再由拍板人确认；完成后取消确认可继续改，汇总后需重新开放审核。", duration: 5700, Scene: ScenePrivateChat },
] as const satisfies readonly TourStep[];
