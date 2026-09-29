// 验收用：以各负责人身份提交复盘，再以 CEO 身份确认（留 keep 列表里的项在界面上操作）。
const api = "http://127.0.0.1:4700", origin = "http://localhost:3700";
async function login(loginId) {
  const r = await fetch(`${api}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ loginId, passcode: "8742" }) });
  if (!r.ok) throw new Error(`login ${loginId} ${r.status}`);
  return r.headers.get("set-cookie").split(";")[0];
}
const get = async (cookie, path) => (await fetch(`${api}${path}`, { headers: { cookie, origin } })).json();
async function act(cookie, action, input) {
  const r = await fetch(`${api}/api/monthly-reviews/actions/execute`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ actionId: action.actionId, ...(input ? { input } : {}) }) });
  return [r.status, await r.json()];
}
const [mode, ...keep] = process.argv.slice(2);
const ceo = await login("browserceo");
const { review } = await get(ceo, "/api/monthly-reviews/2026-10");
const owners = { "browser-dri": "browserdri", "luyao": "wangluyao" };
for (const row of review.items) {
  if (keep.includes(row.subjectCode + " " + row.subjectName) || keep.includes(row.subjectName)) continue;
  if (mode === "submit" && (row.status === "draft" || row.status === "returned")) {
    let cookie = ceo;
    let item = (await get(ceo, `/api/monthly-review-items/${row.itemId}`)).item;
    if (!item.viewer.isOwner) {
      const loginId = item.ownerName === "林知行" ? "browserdri" : item.ownerName === "王路遥" ? "wangluyao" : item.ownerName === "孙铭泽" ? "browsermember" : null;
      if (!loginId) { console.log("skip", row.subjectName, item.ownerName); continue; }
      cookie = await login(loginId);
      item = (await get(cookie, `/api/monthly-review-items/${row.itemId}`)).item;
    }
    const submit = item.actions.find((a) => a.actionType === "monthly-review-item.submit");
    console.log("submit", row.subjectName, (await act(cookie, submit))[0]);
  }
  if (mode === "confirm" && row.status === "submitted") {
    console.log("confirm", row.subjectName, (await act(ceo, row.actions.find((a) => a.actionType === "monthly-review-item.confirm")))[0]);
  }
}
