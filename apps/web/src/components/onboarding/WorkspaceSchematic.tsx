import type { CSSProperties } from "react";
import s from "./WorkspaceSchematic.module.css";

type Props = {
  role: "ceo" | "member";
  focus: "notifications" | "board";
  mobile?: boolean;
};

const notices = ["需要你确认", "战略决策更新", "战略会议安排", "战略问题研究"];
const memberNotices = ["本月 Mission Card", "新的执行事项", "回复与结果", "雷达 · 值得注意"];
/** 手持首页通知下面那一段：CEO 是精简的公司全局（战场一行一个、雷达），成员是自己的工作（与真实首页同序：快捷、月历、Mission、详情里本周排最前）。 */
const phoneWork = { ceo: ["战场 1", "战场 2", "战场 3", "雷达信号"], member: ["约会议 · 等回复", "10 月", "Mission", "本周"] };
/**
 * 成员首页的缩影（第六版）：顶行月历 · Mission · 快捷三张小卡；下面 Mission 详情（左边 Task 小卡，右边三栏）；再下面最近进展。
 * 月历第 23 天是今天、那一行是本周；Mission 用色板前两色，选中第一个。
 */
const memberActions = ["约会议", "等回复", "战场进展", "雷达"];
const missionColors = ["#2f63b0", "#2f8a7a"];
const TODAY = 22;
/** 2026 年 10 月 1 日是周四：前面空 3 格，周六、周日算休息日。 */
const LEAD = 3;
const monthDays = Array.from({ length: 31 }, (_, index) => ({
  rest: [2, 3].includes(index % 7), past: index < TODAY, today: index === TODAY,
  week: Math.floor((index + LEAD) / 7) === Math.floor((TODAY + LEAD) / 7),
}));
const columns = [["已完成", 2], ["本周", 2], ["之后", 1]] as const;

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
          <div className={s.homeTop}>
            <div className={s.miniCalendar}>
              <strong>10 月</strong>
              <div className={s.calendarDays}>{monthDays.map((day, index) => <i key={index} style={index === 0 ? { gridColumnStart: LEAD + 1 } : undefined} data-rest={day.rest || undefined} data-past={day.past || undefined} data-today={day.today || undefined} data-week={day.week || undefined} />)}</div>
            </div>
            <div className={s.miniMissions}>
              <strong>Mission</strong>
              <span className={s.missionLine}><i className={s.missionDot} />全部</span>
              {missionColors.map((color, index) => <span className={s.missionLine} data-selected={index === 0 || undefined} key={color} style={{ "--c": color } as CSSProperties}><i className={s.missionDot} />Mission {index + 1}</span>)}
            </div>
            <div className={s.miniQuick}>{memberActions.map((label, index) => <span className={s.quickTile} data-primary={index === 0 || undefined} key={label}>{label}</span>)}</div>
          </div>
          <div className={s.missionCard} style={{ "--c": missionColors[0] } as CSSProperties}>
            <div className={s.detailHead}><i className={s.missionDot} /><span>Mission 1</span><span className={s.addButton}>+</span></div>
            <div className={s.detailBody}>
              <div className={s.taskColumn}>{[0, 1].map((index) => <span className={s.taskCard} data-selected={index === 0 || undefined} key={index}><i /><b /></span>)}</div>
              <div className={s.columns}>
                {columns.map(([label, count]) => <div className={s.column} data-week={label === "本周" || undefined} key={label}>
                  <strong>{label}</strong>
                  {Array.from({ length: count }, (_, index) => <span className={s.columnCard} key={index}><i /></span>)}
                </div>)}
              </div>
            </div>
          </div>
          <div className={s.progressCard}><strong>最近进展</strong><span className={s.rule} /></div>
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
          {phoneWork[role].map((label) => <div className={s.phoneWorkCard} key={label}><strong>{label}</strong>{role === "member" && label === "本周" ? <span className={s.addButton}>+</span> : null}<span className={s.phoneWorkRule} /></div>)}
        </div>
      </div>
    </div>
  </div>;
}
