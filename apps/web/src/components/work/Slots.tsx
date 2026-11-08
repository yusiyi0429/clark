import w from "@/styles/v2-work.module.css";

/** 在跑的子会话不设上限（11/09 用户定）：超过这么多个时连接页提醒本人，右栏也不再画格子、只写数字。 */
export const MANY_SESSIONS = 10;

/** 本机 ▮▮▯：一格一个位置，在跑的涂满。 */
export function Slots({ used, cap, off }: { used: number; cap: number; off?: boolean }) {
  return <span className={w.slots} role="img" aria-label={`本机 ${used}/${cap}`}>{Array.from({ length: cap }, (_, i) => <span key={i} className={w.slot} data-on={!off && i < used ? true : undefined} />)}</span>;
}
