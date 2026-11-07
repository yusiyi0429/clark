import w from "@/styles/v2-work.module.css";

/** 本机 ▮▮▯：一格一个位置，在跑的涂满。 */
export function Slots({ used, cap, off }: { used: number; cap: number; off?: boolean }) {
  return <span className={w.slots} role="img" aria-label={`本机 ${used}/${cap}`}>{Array.from({ length: cap }, (_, i) => <span key={i} className={w.slot} data-on={!off && i < used ? true : undefined} />)}</span>;
}
