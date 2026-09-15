/**
 * 纲领 payload 的形状校验与蛇形转驼峰。
 *
 * **这是跨仓库契约的这一半。** 另一半是灌纲领的那条命令。改它要同时改两处，所以
 * 它得是一个能被单测钉住的纯函数，而不是埋在 HTTP 处理里的十几行。
 *
 * 蛇形转驼峰只在这个文件里发生一次（同 `inbox.ts`）。这里不 import store，也不
 * 认识 HTTP。
 */
import type { Period } from "./types";

export interface OmIntake {
  period: Omit<Period, "projectId">;
  companyOutcome: { statement: string; dueOn: string };
  domains: {
    domainId: string;
    northStar: string;
    items: { proposed: string; tier: "acceptance" | "required" }[];
  }[];
}

export type OmIntakeParse = { ok: true; payload: OmIntake } | { ok: false; error: string };

const bad = (error: string): OmIntakeParse => ({ ok: false, error });

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** 只用来显示的字段：给什么算什么，没给算空串。 */
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * 解析纲领 payload。**一个字段不合规就整批拒收。**
 *
 * 严格与宽松的分界：**周期与域结构的字段缺了就拒**（id / startsOn / endsOn /
 * domainId / northStar / items），**只用来显示的字段缺了填空串**（label / statement）——
 * 但这份契约里几乎没有「只显示」的字段，都是要参与计算的。
 */
export function parseOmIntake(body: unknown): OmIntakeParse {
  const root = obj(body);
  if (!root) return bad("请求体不是一个对象。");

  // 解析 period
  const periodRaw = obj(root.period);
  if (!periodRaw) return bad("period 不是一个对象。");

  const periodId = str(periodRaw.id);
  if (!periodId) return bad("period.id 是空的 —— 周期必须有 id。");
  const periodLabel = str(periodRaw.label);
  const startsOn = str(periodRaw.starts_on);
  if (!startsOn) return bad("period.starts_on 是空的。");
  const endsOn = str(periodRaw.ends_on);
  if (!endsOn) return bad("period.ends_on 是空的。");

  // 校验周期的起止日期
  if (startsOn > endsOn) {
    return bad(`周期的起始日期（${startsOn}）晚于结束日期（${endsOn}）—— 这个错会一路错到「还剩几天」。`);
  }

  const period: Omit<Period, "projectId"> = {
    id: periodId,
    label: periodLabel,
    startsOn,
    endsOn,
  };

  // 解析 company_outcome
  const coRaw = obj(root.company_outcome);
  if (!coRaw) return bad("company_outcome 不是一个对象。");

  const companyOutcome = {
    statement: str(coRaw.statement),
    dueOn: str(coRaw.due_on),
  };

  // 解析 domains
  if (!Array.isArray(root.domains)) return bad("domains 不是数组。");
  if (root.domains.length === 0) return bad("一个域都没有 —— 纲领必须有至少一个域。");

  const domains: OmIntake["domains"] = [];
  for (let i = 0; i < root.domains.length; i += 1) {
    const at = `domains[${i}]`;
    const raw = obj(root.domains[i]);
    if (!raw) return bad(`${at} 不是一个对象。`);

    const domainId = str(raw.domain_id);
    if (!domainId) return bad(`${at}.domain_id 是空的。`);

    const northStar = str(raw.north_star);
    if (!northStar) {
      return bad(`${at}.north_star 是空的 —— 卡的第一节不能是空的（复盘 A1）。`);
    }

    if (!Array.isArray(raw.items)) return bad(`${at}.items 不是数组。`);
    if (raw.items.length === 0) {
      return bad(`${at}（${domainId}）一条 Mission 都没有 —— 那不是纲领，是漏了。`);
    }

    const items: OmIntake["domains"][number]["items"] = [];
    for (let j = 0; j < raw.items.length; j += 1) {
      const itemAt = `${at}.items[${j}]`;
      const itemRaw = obj(raw.items[j]);
      if (!itemRaw) return bad(`${itemAt} 不是一个对象。`);

      const proposed = str(itemRaw.proposed);
      if (!proposed) return bad(`${itemAt}.proposed 是空的。`);

      const tierRaw = itemRaw.tier;
      let tier: "acceptance" | "required";
      if (tierRaw === undefined || tierRaw === null || tierRaw === "") {
        // 默认 acceptance —— 复盘 A2 说被裁时才补分层已经晚了，所以默认是「要验收的」
        tier = "acceptance";
      } else if (tierRaw === "acceptance" || tierRaw === "required") {
        tier = tierRaw;
      } else {
        return bad(`${itemAt}.tier 只能是 "acceptance" 或 "required"，收到 ${JSON.stringify(tierRaw)}。`);
      }

      items.push({ proposed, tier });
    }

    domains.push({ domainId, northStar, items });
  }

  return { ok: true, payload: { period, companyOutcome, domains } };
}
