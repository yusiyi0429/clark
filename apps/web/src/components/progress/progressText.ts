import type { TProgressArtifact } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";

/** 进度条的三段（百分比）：capacity 是预计 / 剩下的天数，demand 是已用 / 还需的天数；超出的部分单独一段。 */
export function meterParts(capacity: number, demand: number): { fill: number; over: number; mark: number | null } {
  const max = Math.max(capacity, demand, 1);
  const pct = (value: number) => Math.round((value / max) * 1000) / 10;
  return { fill: pct(Math.min(capacity, demand)), over: pct(Math.max(0, demand - capacity)), mark: demand > capacity ? pct(capacity) : null };
}

/** 「10/12–10/14」。 */
export function dayRangeText(start: string, end: string): string {
  const short = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
  return start === end ? short(start) : `${short(start)}–${short(end)}`;
}

/** 信息截至：没有采集来源的写「无采集」。 */
export const coverageText = (iso: string | null) => iso ? `信息截至 ${monthDayTime(iso)}` : "无采集";

/** 链接上显示的字：有标题用标题，没有用域名加路径的最后一段。 */
export function artifactLabel(artifact: TProgressArtifact): string {
  if (artifact.title) return artifact.title;
  try {
    const url = new URL(artifact.url);
    const last = url.pathname.split("/").filter(Boolean).at(-1);
    return last ? `${url.hostname.replace(/^www\./, "")} · ${decodeURIComponent(last)}` : url.hostname.replace(/^www\./, "");
  } catch { return artifact.url; }
}
