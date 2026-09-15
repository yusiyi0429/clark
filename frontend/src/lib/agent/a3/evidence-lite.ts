import type { Evidence, Ledger } from "@/lib/research/ledger";
import type { EvidenceLite, Provenance } from "./stages";

/**
 * `Evidence` → `EvidenceLite`。
 *
 * 入参只接**已经进了台账**的 `Evidence`（`Ledger.record` 返回非 null 的那些）——
 * 三道准入在那里已经跑过了，这里不再复查，只投影。唯一的一道自查是共源键：
 * `fold` 没跑过的条目 `independenceGroup` 是空串，那样投出去的 lite 会让
 * 「几组独立源」这个数变成谎话。
 */
export function toEvidenceLite(e: Evidence, prov: Provenance): EvidenceLite {
  if (!e.independenceGroup) {
    throw new Error(`toEvidenceLite：${e.id} 还没做过独立性折叠，共源键是空的`);
  }
  return {
    id: e.id,
    claim: e.claim,
    sourceRef: e.url,
    /*
     * 抓不到站点名就不放这一格（`Evidence.siteName` 本身可选）—— 不在这里用域名
     * 冒充站点名。上屏那一行的退法在 `buildLiteIndex` 里，一处退、一处口径。
     */
    ...(e.siteName ? { sourceName: e.siteName } : {}),
    date: e.retrievedAt,
    tier: e.sourceTier,
    cosourceKey: e.independenceGroup,
    provenance: prov,
  };
}

/** 整本台账的投影。被台账拒掉的（`ledger.rejections`）本来就不在 `entries` 里。 */
export function liteFromLedger(ledger: Ledger, prov: Provenance): EvidenceLite[] {
  return ledger.entries.map((e) => toEvidenceLite(e, prov));
}

/** 有几组独立源。判「证据够不够」的那个数就是它，不是条数。 */
export function independentGroupCount(list: readonly EvidenceLite[]): number {
  return new Set(list.map((e) => e.cosourceKey)).size;
}

/**
 * 证据台账的上屏索引。
 *
 * 行格式与深研那一侧的 `buildLedgerIndex`（`talk/prefix.ts`）**逐列对齐**：
 * 编号｜说法｜站点名｜档位。同一个人在两条链路上读到的台账长得一样、编号是同一套，
 * 所以从卡进对话不必重编号、也不必重取。**编号直接取 `EvidenceLite.id`，这一层
 * 不许按下标另生成一套** —— 报告正文里写着 `[E12]`，他在对谈里追问那一句时参谋
 * 读到的 `E12` 必须是同一条；重排一次编号，屏幕上的引用就指向了别的东西，而这件事
 * 在屏幕上看起来一切正常。
 *
 * 站点名取不到时退成域名：域名总是有的（证据的 `sourceRef` 是必填），而第三列空着
 * 等于这一行答不出「谁说的」。**退在这里，不在 `toEvidenceLite` 里** ——
 * 那一层不该把域名写进一个叫「站点名」的格子。
 *
 * 空表回**空串**，不回一句话：同深研那一侧（`if (ledgerIndex)`）。「这一轮没有证据」
 * 在屏幕上怎么说是调用方的事 —— 有的地方要说一句，有的地方是整段不出现。
 */
export function buildLiteIndex(list: readonly EvidenceLite[]): string {
  return list
    .map((e) => {
      let host = e.sourceRef;
      try {
        host = new URL(e.sourceRef).hostname;
      } catch {
        // 不是合法 URL 就原样印出来 —— 印错的出处也比印不出出处好查
      }
      return `${e.id}｜${e.claim}｜${e.sourceName || host}｜${e.tier} 档`;
    })
    .join("\n");
}
