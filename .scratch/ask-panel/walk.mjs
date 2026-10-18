/**
 * 浏览器走查：「Agent 提问 → 弹窗作答 → 继续回答」，真实网关（server.mts 起的 API 4600 + next dev 3600）。
 * node .scratch/ask-panel/walk.mjs home|review   截图放 .scratch/ask-panel/evidence/。
 * home：1440 宽，测试甲（CEO）首页主对话；review：390 宽，测试乙的个人复盘页「提交前核对」。
 */
import { mkdir } from "node:fs/promises";
const { chromium } = await import("file:///C:/Users/10021/Desktop/clark/ts-design/node_modules/playwright-core/index.mjs");

const BASE = "http://localhost:3600";
const OUT = new URL("./evidence/", import.meta.url);
await mkdir(OUT, { recursive: true });
const mode = process.argv[2] ?? "home";
const reviewId = process.argv[3];
const wide = mode === "home";
const size = wide ? { width: 1440, height: 900 } : { width: 390, height: 844 };
const tag = wide ? "1440" : "390";
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2, isMobile: !wide, hasTouch: !wide, locale: "zh-CN" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 300)); });
const shot = async (name) => { await page.screenshot({ path: new URL(`${name}-${tag}.png`, OUT).pathname.replace(/^\/([A-Z]:)/, "$1") }); console.log("shot", name); };

// 登录（一次性测试库里的测试身份，口令来自 apps/api/test/helpers.ts）。
const [loginId, passcode] = wide ? ["ceshij", "2468"] : ["ceshiy", "1357"];
await page.goto(`${BASE}/access`);
await page.getByLabel("你的 ID").fill(loginId);
await page.getByLabel("口令第 1 位").click();
for (const digit of passcode) await page.keyboard.press(digit);
await page.waitForURL((url) => !url.pathname.startsWith("/access"), { timeout: 60_000 });
await page.waitForTimeout(1500);
const dismiss = page.getByRole("button", { name: "知道了" });
if (await dismiss.isVisible().catch(() => false)) await dismiss.click();

if (wide) {
  await page.getByRole("button", { name: "切换键盘输入" }).click();
  const input = page.getByLabel("全局对话输入");
  await input.waitFor();
  await input.fill("帮我起草一份给渠道伙伴的 10 月合作提案。动笔前先问我几个关键取舍。");
  await page.keyboard.press("Enter");
} else {
  await page.goto(`${BASE}/me/reviews/personal/${reviewId}`);
  await page.waitForTimeout(2500);
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
  await shot("10-review");
  await page.getByRole("button", { name: "提交前核对" }).click();
}

const card = page.getByTestId("ask-card").last();
await page.waitForTimeout(2500);
await shot(wide ? "01-asking" : "11-asking");
await card.getByTestId("ask-start").waitFor({ timeout: 240_000 });
await page.waitForTimeout(800);
await card.scrollIntoViewIfNeeded();
await shot(wide ? "02-card" : "12-card");
const total = await card.locator("ol li").count();
console.log("questions", total, await card.locator("ol li").allInnerTexts());
await card.getByTestId("ask-start").click();
const dialog = page.getByTestId("ask-dialog");
await dialog.waitFor();
await page.waitForTimeout(400);
await shot(wide ? "03-q1" : "13-q1");
for (let index = 0; index < total; index++) {
  const last = index === total - 1;
  if (index === 0) {
    // 推荐的那个先有焦点：回车就是采纳（没有推荐时选第一个）。
    await page.keyboard.press("Enter");
  } else if (index === 1) {
    const options = await dialog.getByTestId("ask-option").count();
    await page.keyboard.press(String(options + 1));
    await page.waitForTimeout(150);
    await page.keyboard.type("先从华东的两家老伙伴试");
    await shot(wide ? "04-other" : "14-other");
    if (!last) await page.keyboard.press("Enter");
  } else {
    await page.keyboard.press("2");
  }
  await page.waitForTimeout(450);
  if (index === 0 && total > 1) {
    // ← 回到上一题看一眼已选的，再 → 回来。
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(300);
    await shot(wide ? "05-back" : "15-back");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
  }
}
await shot(wide ? "06-last" : "16-last");
await dialog.getByTestId("ask-next").click();
await dialog.waitFor({ state: "detached" });
await page.waitForTimeout(1200);
await shot(wide ? "07-answered" : "17-answered");
// 等 Agent 接着回答完。
await page.getByTestId("conversation-streaming-turn").waitFor({ state: "detached", timeout: 300_000 }).catch(() => undefined);
await page.waitForFunction(() => !document.querySelector("[data-testid=conversation-thinking]"), null, { timeout: 300_000 });
await page.waitForTimeout(1500);
await page.getByTestId("ask-record").last().scrollIntoViewIfNeeded();
await shot(wide ? "08-continued" : "18-continued");
const record = await page.getByTestId("ask-record").last().innerText();
const reply = await page.locator("[data-chat-role=assistant]").last().innerText();
console.log(JSON.stringify({ record, reply: reply.slice(0, 400), errors }));
await browser.close();
