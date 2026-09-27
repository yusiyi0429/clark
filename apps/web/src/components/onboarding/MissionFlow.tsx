import type { CSSProperties } from "react";
import s from "./MissionFlow.module.css";

const stages = [
  { title: "本月目标", description: "Co-Agent 起草各战场的本月目标，一号位签发。", short: "Co-Agent 起草目标，一号位签发。" },
  { title: "个人卡草稿", description: "Co-Agent 照着目标，给每个人起草本月个人卡，列好个人任务。", short: "Co-Agent 起草个人卡和任务。" },
  { title: "48 小时讨论", description: "统一开放讨论，你和 Co-Agent、拍板人一起改同一张卡。", short: "大家在同一张卡上讨论和修改。" },
  { title: "集中处理", description: "倒计时结束，拍板人逐条处理大家的意见。", short: "拍板人逐条处理意见。" },
  { title: "确定", description: "拍板人确认，本月个人卡定下来。", short: "拍板人确认，个人卡定下来。" },
] as const;

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
        <span className={s.description}>{stage.description}</span>
        <span className={s.shortDescription}>{stage.short}</span>
      </li>)}
      <li className={s.finalStage}>
        <span className={s.afterLabel}>之后 · 你来推进</span>
        <div className={s.panel}>
          <span className={s.panelLight} aria-hidden="true" />
          <span className={s.panelNode} aria-hidden="true">✦</span>
          <strong>拆成执行事项</strong>
          <p>个人卡确定后，在「本月计划」里，把个人任务按日期拆成几步，每一步就是一件执行事项；执行事项里可以拉同事一起做。</p>
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
