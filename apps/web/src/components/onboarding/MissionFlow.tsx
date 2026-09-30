import type { CSSProperties } from "react";
import s from "./MissionFlow.module.css";

// 每一步只留一句用户在意的话（用户 2026-09-28：字太多太小，要更简洁、仍然读得懂）。按短语分段，窄时只在短语之间换行。
const stages = [
  { title: "本月目标", line: ["Co-Agent 起草，", "一号位签发"] },
  { title: "任务卡草稿", line: ["Co-Agent\u00a0", "为每个人起草"] },
  { title: "下发审核", line: ["每个人审阅自己的任务卡"] },
  { title: "集中处理", line: ["全员完成后汇总，", "拍板人处理意见"] },
  { title: "确定", line: ["本月任务卡定稿"] },
] as const;
const phrases = (parts: readonly string[]) => parts.map((part) => <span key={part} className={s.phrase}>{part}</span>);

/** 只讲轮次中真实存在的六步；图形与时间线均为装饰，文字一直留在布局里。 */
export function MissionFlow() {
  return <section className={s.root} aria-label="每月 Mission 的制定与执行">
    <div className={s.timelineWrap}>
      <span className={s.phaseLabel}>月初 · 一起定</span>
      <div className={s.lane} aria-hidden="true"><span className={s.line} /><span className={s.runner} /></div>
      <ol className={s.timeline}>
      {stages.map((stage, index) => <li className={s.stage} key={stage.title} style={{ "--stage-index": index } as CSSProperties}>
        <span className={`${s.node} ${index === 2 ? s.countdown : ""} ${index === 4 ? s.confirm : ""}`} aria-hidden="true">{index === 4 ? "✓" : <i />}</span>
        <strong>{stage.title}</strong>
        <span className={s.description}>{phrases(stage.line)}</span>
      </li>)}
      <li className={s.finalStage}>
        <span className={s.afterLabel}>之后 · 你来推进</span>
        <div className={s.panel}>
          <span className={s.panelLight} aria-hidden="true" />
          <span className={s.panelNode} aria-hidden="true">✦</span>
          <strong>拆成执行事项</strong>
          <p>{phrases(["在「本月计划」里按日期拆解任务，", "每一步就是一件执行事项，", "支持团队协作。"])}</p>
          <div className={s.gantt} aria-hidden="true">
            <div className={s.dateMarks}><span>01</span><span>08</span><span>15</span><span>22</span></div>
            <span className={s.bar} /><span className={s.bar} /><span className={s.bar} />
            <div className={s.collaborators}><span>你</span><span>同</span></div>
          </div>
        </div>
      </li>
      </ol>
    </div>
  </section>;
}
