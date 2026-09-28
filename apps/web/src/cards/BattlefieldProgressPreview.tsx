import s from "@/styles/battlefield-progress-preview.module.css";

/** 三环（概念版 goal-track：watchOS 式活动圆环，同色淡轨道）由外到内：六个月里程碑、本月验收、执行事项。
 *  MVP 还不计算进展：数字是示意，整块盖磨砂蒙版并写明「建设中」；以后由 Co-Agent 按每个 Mission 的执行事项和每周进展汇总。 */
const RINGS = [
  { key: "long", r: 86, value: 40, stroke: "#3a83f7", end: "#6aa6ff", ink: "#1f66d9", label: "六个月", display: "2/5", goal: "里程碑" },
  { key: "month", r: 62, value: 45, stroke: "#16b3c8", end: "#4fd3e3", ink: "#0b7f8f", label: "本月", display: "45", unit: "%", goal: "验收" },
  { key: "task", r: 38, value: 58, stroke: "#8bc34a", end: "#b2dc6e", ink: "#3f7d16", label: "执行事项", display: "7/12", goal: "已完成" },
] as const;
const STROKE = 20;

export function BattlefieldProgressPreview({ id }: { id: string }) {
  const gradient = (key: string) => `progress-preview-${id}-${key}`;
  return (
    <div className={s.preview}>
      <div className={s.track} aria-hidden="true">
        <svg className={s.ring} viewBox="0 0 200 200">
          <defs>
            {RINGS.map((ring) => (
              <linearGradient key={ring.key} id={gradient(ring.key)} x1="100" y1="0" x2="100" y2="200" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor={ring.end} />
                <stop offset="1" stopColor={ring.stroke} />
              </linearGradient>
            ))}
          </defs>
          {RINGS.map((ring) => (
            <g key={ring.key}>
              <circle cx="100" cy="100" r={ring.r} fill="none" stroke={ring.stroke} strokeOpacity=".16" strokeWidth={STROKE} />
              <circle cx="100" cy="100" r={ring.r} fill="none" stroke={`url(#${gradient(ring.key)})`} strokeWidth={STROKE} strokeLinecap="round"
                pathLength={100} strokeDasharray={`${ring.value} 100`} transform="rotate(-90 100 100)" />
            </g>
          ))}
        </svg>
        <ul className={s.stats}>
          {RINGS.map((ring) => (
            <li key={ring.key} style={{ ["--ink" as string]: ring.ink, ["--dot" as string]: ring.stroke }}>
              <span className={s.label}><i />{ring.label}</span>
              <strong className={s.value}>{ring.display}{"unit" in ring ? <small>{ring.unit}</small> : null}</strong>
              <span className={s.goal}>{ring.goal}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className={s.mask} role="note">
        <strong>进展统计</strong>
        <span>建设中 · 之后由 Co-Agent 按每个 Mission 的执行事项和每周进展汇总</span>
      </div>
    </div>
  );
}
