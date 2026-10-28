import type { CSSProperties, ReactNode } from "react";
import x from "./execution-tour.module.css";

/**
 * 执行事项演示的六幕。每幕是一段按时间轴排好的 CSS 动画（`--t` 是出场时刻）：
 * 元素的静止样式就是这一幕的终态，动画只负责「从哪来」，所以减少动态效果时直接看到终态。
 */
const at = (ms: number, extra?: Record<string, string>) => ({ "--t": `${ms}ms`, ...extra }) as CSSProperties;

/** 逐字打出：每个字按顺序出现，中英文混排也准。 */
function Typed({ text, start, speed = 70, caret }: { text: string; start: number; speed?: number; caret?: boolean }) {
  return <>{[...text].map((char, index) => <span key={index} className={x.char} style={at(start + index * speed)}>{char}</span>)}{caret ? <span className={x.caret} aria-hidden /> : null}</>;
}

/** 点按的波纹：演示「这里被点了一下」，桌面和手机同一种表达。 */
function Tap({ start }: { start: number }) {
  return <span className={x.tap} style={at(start)} aria-hidden />;
}

function Avatar({ name, tone, className = "", start }: { name: string; tone: 0 | 1 | 2; className?: string; start?: number }) {
  return <span className={`${x.avatar} ${className}`} data-tone={tone} style={start === undefined ? undefined : at(start)}>{name}</span>;
}

function MissionCard({ checkAt }: { checkAt?: number }) {
  return <section className={x.panel}>
    <p className={x.meta}>10 月任务卡 · 林舟</p>
    <h4 className={x.heading}>客户续约率提到 90%</h4>
    <ol className={x.steps}>
      <li data-done="true"><span className={x.box}>✓</span>梳理 Q3 流失原因</li>
      <li className={checkAt === undefined ? x.focusRow : undefined} style={at(700)}>
        <span className={x.box} style={checkAt === undefined ? undefined : at(checkAt)}>{checkAt === undefined ? null : <span className={x.pop}>✓</span>}</span>
        整理 Q3 流失客户名单
        {checkAt === undefined ? <span className={`${x.hint} ${x.in}`} style={at(1300)}>可以开启成执行事项</span> : null}
      </li>
      <li><span className={x.box} />回访高风险客户</li>
    </ol>
    {checkAt === undefined ? null : <div className={x.meter}><span className={x.meterFill} style={at(checkAt + 200)} /><span className={x.meterText}>2 / 3 步完成</span></div>}
  </section>;
}

function SceneStart() {
  return <div className={`${x.scene} ${x.split}`}>
    <MissionCard />
    <section className={x.panel}>
      <div className={x.toolbar}><span>本周 10/5–10/11</span><span className={x.ghostButton}>+ 开启执行事项<Tap start={2300} /></span></div>
      <p className={x.empty}>—</p>
    </section>
  </div>;
}

function SceneCreate() {
  return <div className={`${x.scene} ${x.center}`}>
    <section className={`${x.panel} ${x.form} ${x.leave}`} style={at(4100)}>
      <h4 className={x.heading}>开启执行事项</h4>
      <div className={x.field}><span className={x.label}>执行事项标题</span><span className={x.input}><Typed text="整理 Q3 流失客户名单" start={400} caret /></span></div>
      <div className={x.field}><span className={x.label}>所属个人任务</span><span className={x.input}><span className={x.show} style={at(2100)}>客户续约率提到 90%</span><Tap start={1900} /></span></div>
      <div className={x.twoFields}>
        <div className={x.field}><span className={x.label}>计划开始</span><span className={x.input}><span className={x.show} style={at(2700)}>10 月 8 日</span></span></div>
        <div className={x.field}><span className={x.label}>截止日期</span><span className={x.input}><span className={x.show} style={at(3000)}>10 月 15 日</span></span></div>
      </div>
      <span className={x.primaryButton}>开启执行事项<Tap start={3600} /></span>
    </section>
    <div className={`${x.landing} ${x.arrive}`} style={at(4300)}>
      <p className={x.meta}>本周 10/5–10/11</p>
      <article className={`${x.panel} ${x.taskCard}`}>
      <div className={x.taskTop}><span className={x.status}><i />未启动</span><span>10 月 15 日前</span></div>
      <h4 className={x.heading}>整理 Q3 流失客户名单</h4>
      <p className={x.link}>客户续约率提到 90% ↗</p>
      </article>
    </div>
  </div>;
}

function SceneInvite() {
  return <div className={`${x.scene} ${x.center}`}>
    <section className={`${x.panel} ${x.detail}`}>
      <p className={x.meta}>执行事项</p>
      <h4 className={x.heading}>整理 Q3 流失客户名单</h4>
      <div className={x.people}>
        <span className={x.avatars}><Avatar name="林" tone={0} /><Avatar name="陈" tone={1} className={x.join} start={3000} /><Avatar name="许" tone={2} className={x.join} start={3150} /></span>
        <span className={x.meta}>参与：林舟<span className={x.show} style={at(3000)}>、陈默、许晴</span></span>
        <span className={x.secondaryButton}>邀请协作<Tap start={700} /></span>
      </div>
      <span className={x.skeleton} /><span className={x.skeleton} data-short="true" />
    </section>
    <div className={`${x.panel} ${x.popover} ${x.window}`} style={at(1000, { "--len": "1900ms" })}>
      <p className={x.label}>邀请同事协作</p>
      {([["陈", "陈默 · 产品", 1400], ["许", "许晴 · 销售", 1800], ["周", "周航 · 交付", null]] as const).map(([short, name, pick], index) => <div key={name} className={x.personRow}>
        <Avatar name={short} tone={(index % 3) as 0 | 1 | 2} />{name}
        <span className={x.pick}>{pick === null ? null : <><span className={x.pop} style={at(pick + 100)}>✓</span><Tap start={pick} /></>}</span>
      </div>)}
      <span className={x.primaryButton}>邀请 2 人<Tap start={2500} /></span>
    </div>
    <div className={`${x.toast} ${x.in}`} style={at(3600)}><Avatar name="陈" tone={1} />陈默 接下了协作</div>
  </div>;
}

function Doc({ children }: { children: ReactNode }) {
  return <section className={`${x.panel} ${x.doc}`}>
    <p className={x.meta}>协作文档</p>
    <h4 className={x.heading}>Q3 流失客户分析</h4>
    <p>Q3 共流失客户 58 家，其中年费 10 万以上的 12 家。</p>
    {children}
  </section>;
}

function SceneAnnotate() {
  return <div className={`${x.scene} ${x.docSplit}`}>
    <Doc>
      <p>主要原因：交付周期长，<mark className={x.mark} style={at(2700)}>续约提醒发得太晚</mark>。</p>
      <p><mark className={x.mark} style={at(700)}>华北区流失 21 家，华南区流失 14 家。</mark></p>
    </Doc>
    <aside className={x.notes}>
      <div className={`${x.note} ${x.in}`} style={at(1500)}><Avatar name="陈" tone={1} /><div><strong>陈默</strong><p><Typed text="这里缺华东区的数据" start={1800} /></p></div></div>
      <div className={`${x.note} ${x.in}`} style={at(3200)}><Avatar name="许" tone={2} /><div><strong>许晴</strong><p><Typed text="提醒改成提前 60 天" start={3500} /></p></div></div>
    </aside>
  </div>;
}

function SceneAgent() {
  return <div className={`${x.scene} ${x.docSplit}`}>
    <Doc>
      <p>主要原因：交付周期长，<del className={x.strike} style={at(3900)}>续约提醒发得太晚</del><ins className={x.insert}><Typed text="续约提醒提前到 60 天" start={4300} speed={55} /></ins>。</p>
      <p>华北区流失 21 家，华南区流失 14 家，<ins className={x.insert}><Typed text="华东区流失 23 家，集中在制造业客户。" start={2700} speed={45} /></ins></p>
      <p className={`${x.resolved} ${x.in}`} style={at(5100)}>✓ 陈默、许晴的 2 条批注已处理</p>
    </Doc>
    <aside className={`${x.panel} ${x.chat}`}>
      <p className={x.label}>和 Agent 对话</p>
      <div className={x.log}>
        <p className={`${x.bubbleMe} ${x.in}`} style={at(1700)}>按两条批注改一下文档</p>
        <p className={`${x.bubbleAgent} ${x.in}`} style={at(2200)}>
          <span className={`${x.thinking} ${x.gone}`} style={at(5200)}>正在改文档…</span>
          <span className={x.show} style={at(5200)}>改好了，改动已标出。</span>
        </p>
      </div>
      <div className={x.composer}>
        <span className={x.gone} style={at(1650)}><Typed text="按两条批注改一下文档" start={200} speed={65} /></span>
        <span className={x.send}>↑<Tap start={1450} /></span>
      </div>
    </aside>
  </div>;
}

/** 验收：Agent 已对照完成标准逐条打勾，人写一句结论、点「验收完成」，任务卡上这一步随之打勾。 */
function SceneAccept() {
  return <div className={`${x.scene} ${x.split}`}>
    <section className={`${x.panel} ${x.form}`}>
      <h4 className={x.heading}>验收「整理 Q3 流失客户名单」</h4>
      <ol className={x.steps}>
        {([["58 家流失客户的名单", 600], ["补齐华东区数据", 900]] as const).map(([text, check]) => <li key={text}><span className={x.box} style={at(check)}><span className={x.pop}>✓</span></span>{text}</li>)}
      </ol>
      <div className={x.field}><span className={x.label}>一句结论</span><span className={x.input}><Typed text="名单已整理，华东区数据已补齐。" start={1400} speed={55} /></span></div>
      <span className={x.primaryButton}>验收完成<Tap start={2800} /></span>
    </section>
    <MissionCard checkAt={3300} />
  </div>;
}

export const TOUR_STEPS = [
  { title: "从你的任务出发", body: "任务卡上的每一步，都可以开启成一件执行事项。", duration: 3200, Scene: SceneStart },
  { title: "开启一件执行事项", body: "写清要做成什么，选好所属任务，定好日期。", duration: 5200, Scene: SceneCreate },
  { title: "拉同事一起做", body: "邀请协作后，同事能看到这件事，和你一起推进。", duration: 4400, Scene: SceneInvite },
  { title: "在文档上写批注", body: "协作的人划出一段，直接写下自己的意见。", duration: 4800, Scene: SceneAnnotate },
  { title: "让 Agent 动手改", body: "在对话里说一句，Agent 按批注改好文档，改了哪里一眼能看到。", duration: 6200, Scene: SceneAgent },
  { title: "验收完成", body: "对照完成标准逐条确认，点「验收完成」这件事才算完成，任务卡上的这一步随之打勾。", duration: 4300, Scene: SceneAccept },
] as const;
