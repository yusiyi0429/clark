import s from "./WorkspaceSchematic.module.css";

type Props = {
  role: "ceo" | "member";
  focus: "notifications" | "board";
  mobile?: boolean;
};

const notices = ["需要你确认", "战略决策更新", "战略会议安排", "战略问题研究"];

/** 无真实数据的工作台缩影；mobile 可覆盖默认的响应式布局。 */
export function WorkspaceSchematic({ role, focus, mobile }: Props) {
  const noticeCards = notices.map((label, index) => <div className={s.noticeCard} key={label}>
    <span className={`${s.noticeDot} ${index === 0 ? s.urgentDot : ""}`} />
    <span>{label}</span>
    <i className={s.noticeLine} />
  </div>);

  return <div className={s.root} data-role={role} data-focus={focus} data-mobile={mobile === undefined ? "auto" : String(mobile)} aria-label={`${role === "ceo" ? "一号位" : "成员"}工作台示意图`}>
    <div className={s.desktop}>
      <span className={s.focusMarker} />
      <div className={s.rail} data-region="notifications">
        <div className={s.clock}><span className={s.clockMark}>✦</span><span>今天</span><span>09:41</span></div>
        <div className={s.noticeList}>{noticeCards}</div>
        <span className={s.railFoot}>天枢</span>
      </div>
      <div className={s.board} data-region="board">
        <div className={s.topRow}>
          <div className={s.strategy}><strong>{role === "ceo" ? "公司战略议题" : "我的工作"}</strong><span className={s.rule} /><span className={s.ruleShort} /></div>
          <div className={s.radar}><strong>雷达信号</strong><span className={s.radarScope}><i /></span></div>
        </div>
        <div className={s.battlefieldTitle}>战场</div>
        <div className={s.battlefields}>{[1, 2, 3].map((item) => <div className={s.battlefield} key={item}><strong>战场 {item}</strong><span className={s.rule} /><span className={s.ruleShort} /></div>)}</div>
        <div className={s.agent}><span className={s.agentSpark}>✦</span><span>我的 Agent</span><span className={s.agentSend}>↑</span></div>
      </div>
    </div>
    <div className={s.phone}>
      <div className={s.phoneHome} data-region="notifications">
        <div className={s.phoneClock}><span className={s.clockMark}>✦</span><span>今天</span><span>09:41</span></div>
        <div className={s.phoneNotices}>{noticeCards}</div>
      </div>
      <div className={s.phoneDetail} data-region="board">
        <div className={s.phoneBack}>‹ <span>返回</span></div>
        <div className={s.phoneDetailCard}><strong>需要你确认</strong><span className={s.rule} /><span className={s.ruleShort} /><span className={s.rule} /></div>
        <div className={s.phoneAgent}><span className={s.agentSpark}>✦</span><span>我的 Agent</span><span className={s.agentSend}>↑</span></div>
      </div>
    </div>
  </div>;
}
