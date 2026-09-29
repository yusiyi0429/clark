// 验收用：模拟对话 agent 调用 propose_review_edit（走同一个仓储函数）。
const { Pool } = require("pg");
const [,, db, itemId, ownerId, field, text] = process.argv;
(async () => {
  const pool = new Pool({ connectionString: `postgres://postgres:postgres@localhost:55432/${db}` });
  const { proposeMonthlyReviewSuggestion } = await import("../../../apps/api/src/monthlyReviews.ts");
  const result = await proposeMonthlyReviewSuggestion(pool, itemId, { personId: ownerId, role: "ceo" }, { field, text, rationale: "按你上传的手写复盘补上了延期原因" }, new Date());
  console.log(JSON.stringify(result));
  await pool.end();
})();
