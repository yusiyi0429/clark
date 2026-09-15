/**
 * 本地跑一次，吐出几条进入链接。
 *
 *   TKOS_ACCESS_SECRET=<线上那把> TKOS_BASE_URL=https://… node scripts/dri-link.mjs
 *   node scripts/dri-link.mjs PSN-06 PSN-10      # 只要这两个人的
 *
 * HMAC 那一行**故意和 `src/lib/identity.ts` 重复**：这个脚本不进 Next 的编译，
 * import 一个 TS 模块要么加构建步骤要么加 loader。重复的是四行常量与一次
 * createHmac，而口径（`tkos-who-v1:` 这个前缀）一改就必须两处一起改 ——
 * 所以两边都写着对方的路径。
 */
import { createHmac } from "node:crypto";

const secret = process.env.TKOS_ACCESS_SECRET?.trim();
if (!secret) {
  console.error("没有 TKOS_ACCESS_SECRET —— 签不出来。它就是线上那把访问密钥。");
  process.exit(1);
}

const base = (process.env.TKOS_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

// 名册的真身在 src/lib/data/seed-tokenking.ts（people 里 role: "dri" 那些）。
// 这里只列要发链接的那几个人，不做第二份名册（spec §2）。**这份清单不是安全边界** ——
// 授权在 store.ts 的 resolveDriActor 里查真名册，解不出 role: "dri" 就进不来。
// 这里最坏的后果是少给某人发链接，或发出去的链接进不来，不可能把权限发给非 DRI。
const ROSTER = [
  ["PSN-02", "白田田"],
  ["PSN-03", "孙铭泽"],
  ["PSN-06", "产品负责人（Domain 04 Agents）"],
  ["PSN-09", "人力负责人（Domain 07）"],
  ["PSN-08", "财务负责人（Domain 08）"],
  ["PSN-10", "刘人豪"],
];

const wanted = process.argv.slice(2);
const rows = wanted.length ? ROSTER.filter(([id]) => wanted.includes(id)) : ROSTER;

for (const [id, who] of rows) {
  const mac = createHmac("sha256", secret).update(`tkos-who-v1:${id}`).digest("base64url");
  console.log(`${who}\t${base}/dri/enter?t=${id}.${mac}`);
}
