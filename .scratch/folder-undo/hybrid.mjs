// 混合：快版本做完第一份后，用 git read-tree 把那份装进暂存区，再让 git add 补上文件状态（只读、算哈希，对象已在包里不重写）；之后每轮用 git add。
import { Shadow } from "./shadow.mjs";
import { scan } from "./fastsnap.mjs";
const [, , folder, gitDir, sid, ref] = process.argv;
const s = new Shadow(gitDir, folder, sid);
await s.init();
const t = async (label, fn) => { const a = performance.now(); await fn(); console.log(label, Math.round(performance.now() - a), "ms"); };
const base = (await s.git(["rev-parse", ref])).out.trim();
await t("scan again", async () => scan(folder));
await t("read-tree base", () => s.git(["read-tree", base]));
await t("first git add -A (rehash)", () => s.git(["add", "-A", "--ignore-errors", "--", "."], { allowFail: true }));
await t("write-tree", () => s.git(["write-tree"]));
await t("second git add -A", () => s.git(["add", "-A", "--", "."], { allowFail: true }));
await t("snapshot (add+write-tree+commit-tree+update-ref)", () => s.snapshot("h1", base));
await t("snapshot again", () => s.snapshot("h2", base));
