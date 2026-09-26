import s from "./foundation.module.css";

export function OnboardingProgress({ current, total }: { current: number; total: number }) {
  return <div className={s.progress} role="status" aria-live="polite">
    <span className={s.srOnly}>{`第 ${current} 步，共 ${total} 步`}</span>
    <div className={s.dots} aria-hidden="true">{Array.from({ length: total }, (_, index) =>
      <span key={index} data-current={current === index + 1} data-past={current > index + 1} />)}</div>
  </div>;
}
