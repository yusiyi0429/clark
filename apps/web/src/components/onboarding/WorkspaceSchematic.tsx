import s from "./WorkspaceSchematic.module.css";

type Props = {
  role: "ceo" | "member";
  focus: "notifications" | "board";
  mobile?: boolean;
};

const notices = ["需要你确认", "战略决策更新", "战略会议安排", "战略问题研究"];
const memberNotices = ["本月 Mission Card", "新的执行事项", "回复与结果", "雷达 · 值得注意"];
/** 手持首页通知下面那一段：CEO 是精简的公司全局（战场一行一个、雷达），成员是自己的工作（与真实首页同序）。 */
const phoneWork = { ceo: ["战场 1", "战场 2", "战场 3", "雷达信号"], member: ["执行事项", "我的本月卡", "参与的战场", "雷达信号"] };

/** 无真实数据的工作台缩影；mobile 可覆盖默认的响应式布局。 */
export function WorkspaceSchematic({ role, focus, mobile }: Props) {
  const noticeCards = (role === "ceo" ? notices : memberNotices).map((label, index) => <div className={s.noticeCard} key={label}>
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
        {role === "member" ? <>
          <div className={s.memberHeading}>我的工作台</div>
          <div className={s.memberTop}>
            <div className={s.memberTile}><strong>参与的战场</strong><span className={s.rule} /><span className={s.ruleShort} /></div>
            <div className={s.memberTile}><strong>我的本月卡</strong><span className={s.rule} /><span className={s.ruleShort} /></div>
            <div className={s.radar}><strong>雷达信号</strong><span className={s.radarScope}><i /></span></div>
          </div>
          <div className={s.memberTaskHeading}><strong>执行事项</strong><span className={s.addButton}>+</span></div>
          <div className={s.memberTasks}>
            <div className={s.memberTask}><span className={s.activeTaskDot} />第 1 步，共 3 步<span className={s.taskRule} /></div>
            <div className={`${s.memberTask} ${s.waitingTask}`}>第 2 步，共 3 步 · 等上一步<span className={s.taskRule} /></div>
            <div className={s.memberTask}>独立事项<span className={s.taskRule} /></div>
          </div>
          <div className={s.agent}><span className={s.agentSpark}>✦</span><span>我的 Agent</span><span className={s.agentSend}>↑</span></div>
        </> : <>
        <div className={s.topRow}>
          <div className={s.strategy}><strong>{role === "ceo" ? "公司战略议题" : "我的工作"}</strong><span className={s.rule} /><span className={s.ruleShort} /></div>
          <div className={s.radar}><strong>雷达信号</strong><span className={s.radarScope}><i /></span></div>
        </div>
        <div className={s.battlefieldTitle}>战场</div>
        <div className={s.battlefields}>{[1, 2, 3].map((item) => <div className={s.battlefield} key={item}><strong>战场 {item}</strong><span className={s.rule} /><span className={s.ruleShort} /></div>)}</div>
        <div className={s.agent}><span className={s.agentSpark}>✦</span><span>我的 Agent</span><span className={s.agentSend}>↑</span></div>
        </>}
      </div>
    </div>
    <div className={`${s.phone} ${s.memberPhone}`}>
      <div className={s.memberPhoneScroll}>
        <div className={s.memberPhoneNotice} data-region="notifications">
          <div className={s.phoneClock}><span className={s.clockMark}>✦</span><span>今天</span><span>09:41</span></div>
          <div className={s.phoneNotices}>{noticeCards.slice(0, 2)}</div>
        </div>
        <div className={s.memberPhoneWork} data-region="board">
          {phoneWork[role].map((label, index) => <div className={s.phoneWorkCard} key={label}><strong>{label}</strong>{role === "member" && index === 0 ? <span className={s.addButton}>+</span> : null}<span className={s.phoneWorkRule} /></div>)}
        </div>
      </div>
    </div>
  </div>;
}
