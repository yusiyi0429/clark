/** Explicit disposable browser fixture. No production database or real model calls. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createTestApp, TEST_CEO, TEST_MEMBER } from "../../apps/api/test/helpers.js";
import type { MissionCardAnnotationAgent } from "../../apps/api/src/missionCardAnnotationAgent.js";

const START = new Date("2026-10-01T02:00:00.000Z");
const port = 4592, web = "http://localhost:3512";
const dir = new URL("./run/", import.meta.url);
await mkdir(dir, { recursive: true });
const agent: MissionCardAnnotationAgent = { async generate(input) {
  if (input.body.includes("失败")) throw new Error("隔离验收：模拟生成失败");
  if (input.body.includes("澄清") && !input.answer) return { candidate: {
    action: "clarify", proposed: null, reason: "需要明确走查范围", question: "本月优先核对哪种身份？",
    options: ["CEO 与 DRI 两种身份", "先完成 DRI 身份"],
  } };
  return { candidate: { action: "apply", proposed: input.source + "\n\n" + (input.answer ?? "核对 CEO 与 DRI 双视角的界面和权限证据。"),
    reason: "按已明确的批注意图修改并保留原文", question: null, options: [], } };
} };
const t = await createTestApp({ extraOrigins: [web, "http://127.0.0.1:3512"] }, undefined,
  { monthlyNow: () => START, missionCardAnnotationAgent: agent });
try {
  const plan = randomUUID(), round = randomUUID();
  await t.sql("UPDATE battlefield_config SET name='隔离验收战场',owner_id=$1,six_month_outcome='验证 CEO 与 DRI 共用身份时的产品工作闭环，形成可复核的界面与权限证据。' WHERE id='growth'", [TEST_CEO.personId]);
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','形成可复核的工作闭环','[{"battlefieldId":"growth","outcome":"完成 CEO 与 DRI 双视角走查，按人核对任务卡与讨论意见。"}]','[]',
      '{"edits":[],"checkedItemIds":[],"feedback":[],"note":""}',
      '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":null}',$2)`, [plan, START]);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
    VALUES ($1,1,'growth','2026-10',$2,'draft','agent','{}',$3,$3)`, [round, plan, START]);
  const cards: { id: string; ownerId: string; missionId: string }[] = [];
  for (const [index, who] of [TEST_CEO, TEST_MEMBER].entries()) {
    const card = randomUUID(), mission = randomUUID();
    await t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [card, round, who.personId, index, JSON.stringify([TEST_CEO.personId, TEST_MEMBER.personId]), START]);
    await t.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,success_evidence,
      source_ref,source_document_id,source_revision,source_title,placeholder,personal_mission_card_id,
      why,time_boundary,tradeoffs,boundaries,key_path,dependencies)
      VALUES ($1,1,$2,'2026-10','CEO 与 DRI 工作闭环走查',$3,'method','["growth"]',
      $5,'["双视角走查记录可复核","关键权限路径有证据"]',
      'https://example.test/browser-fixture','browser-fixture',1,'隔离浏览器验收',false,$4,
      '用真实业务闭环验证界面与权限的统一性。','10月31日前完成本月走查与交接。','优先权限闭环，延后非关键视觉扩展。',
      '负责产品体验与权限证据；不替业务负责人确认目标。','阅读任务 → 双视角走查 → 核对证据 → 完成审核。','与任务卡负责人核对意见和依赖。')`,
      [mission, `verify-review-${index}`, who.personId, card, "先做 **核对**，再完成走查。\n\n- 阅读两种身份的任务卡\n- 记录界面与权限证据"]);
    await t.sql("INSERT INTO person_onboarding (person_id,completed_at) VALUES ($1,$2)", [who.personId, START]);
    await t.sql("INSERT INTO person_seen_marks (person_id,key,seen_at) VALUES ($1,'release:2026-10',$2)", [who.personId, START]);
    cards.push({ id: card, ownerId: who.personId, missionId: mission });
  }
  await t.app.listen({ port, host: "127.0.0.1" });
  const [{ database }] = await t.sql("SELECT current_database() AS database");
  await writeFile(new URL("fixture.json", dir), JSON.stringify({ ready: true, database, api: `http://127.0.0.1:${port}`, web, round, cards }, null, 2));
  console.log(JSON.stringify({ ready: true, port, database, round, cards }));
  let closing = false;
  const stopTimer = setInterval(() => { void readFile(new URL("stop", dir), "utf8").then((command) => {
    if (command.trim() === "stop") void close();
  }).catch(() => undefined); }, 500);
  async function close() { if (closing) return; closing = true; clearInterval(stopTimer); await t.close();
    await writeFile(new URL("fixture.json", dir), JSON.stringify({ ready: false, closed: true, database })); process.exit(0); }
  process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
} catch (error) { await t.close(); throw error; }
