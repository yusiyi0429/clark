// 演示推进：以某人身份调接口。node act.mjs <步骤>
const ORIGIN = "http://localhost:3828", API = "http://127.0.0.1:4828";
// 这场会的 id 从演示服务的控制口取（每次启动重建库，id 会变）。
const M = (await (await fetch("http://127.0.0.1:4829/")).json()).meetingId;
const cookies = {};
async function as(login) {
  if (!cookies[login]) {
    const r = await fetch(`${API}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ loginId: login, passcode: "2580" }) });
    cookies[login] = (r.headers.get("set-cookie") ?? "").split(";")[0];
  }
  return async (method, path, body) => {
    const r = await fetch(`${API}${path}`, { method, headers: { cookie: cookies[login], origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (r.status >= 300) throw new Error(`${method} ${path} ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}
const hostRows = async () => (await (await as("lin"))("GET", `/api/me/cards/meetings/${M}`)).payload.decisions;
const step = process.argv[2];
if (step === "phase-b") {
  const lin = await as("lin");
  const rows = await hostRows();
  const host = rows.filter((d) => d.tier === "host");
  await lin("POST", `/api/meetings/${M}/decisions/${host[0].id}/review`, { verdict: "confirmed" });
  await fetch("http://127.0.0.1:4829/judge?ordinal=2");
  await lin("POST", `/api/meetings/${M}/decisions/${host[2].id}/review`, { verdict: "not_decided" });
  const zhou = await as("zhou");
  const card = (await zhou("GET", `/api/cards/meetings/${M}`)).cards[0];
  const item = card.payload.outcome.items.find((i) => i.kind === "strategic");
  const action = card.actions.find((a) => a.actionType === "meeting.confirm_item" && a.itemId === item.id);
  await zhou("POST", "/api/actions/execute", { actionId: action.actionId, input: {} });
  console.log("phase-b done");
}
if (step === "inbox") {
  for (const login of ["lin", "chen", "wu", "xu"]) {
    const items = (await (await as(login))("GET", "/api/me/requests?box=inbox")).items;
    console.log(login, items.map((i) => `${i.id} ${i.kind} ${i.title} ${i.myStatus}`));
  }
}
if (step === "ask") { // node act.mjs ask <login> <requestId> <question>
  const who = await as(process.argv[3]);
  const card = (await who("GET", `/api/requests/${process.argv[4]}/impact`)).card;
  console.log((await who("POST", `/api/impact-cards/${card.id}/ask`, { question: process.argv[5] })).card.questions);
}
if (step === "irrelevant") { // node act.mjs irrelevant <login> <requestId>
  const who = await as(process.argv[3]);
  const card = (await who("GET", `/api/requests/${process.argv[4]}/impact`)).card;
  console.log((await who("POST", `/api/impact-cards/${card.id}/irrelevant`, { reason: process.argv[5] })).card.status);
}
if (step === "edit") { // node act.mjs edit <ordinal> <statement>
  const lin = await as("lin");
  const host = (await hostRows()).filter((d) => d.tier === "host");
  console.log((await lin("POST", `/api/meetings/${M}/decisions/${host[Number(process.argv[3]) - 1].id}/review`, { verdict: "edited", statement: process.argv[4] })).decision);
}
