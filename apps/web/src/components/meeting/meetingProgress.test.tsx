import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingProgress, meetingProgress, progressClock } from "./MeetingProgress";

type Payload = Parameters<typeof meetingProgress>[0];
const START = "2026-10-22T05:00:00.000Z"; // 13:00
const BOOKED = { status: "booked" as const, joinUrl: "https://vc.feishu.cn/j/1", organizerId: "p1" };
const payload = (overrides: Partial<Payload> = {}): Payload => ({
  status: "scheduled", scheduledAt: START, startedAt: null, feishuEvent: BOOKED, minutesStatus: "none", minutesFailure: null,
  minutesWaitingSince: null, minutesManualImport: false, transcriptCandidate: null, outcome: null, ...overrides,
});
const at = (offsetMinutes: number) => Date.parse(START) + offsetMinutes * 60_000;
const model = (overrides: Partial<Payload>, options: Partial<Parameters<typeof meetingProgress>[1]> = {}) =>
  meetingProgress(payload(overrides), { live: "waiting", ended: false, now: at(-30), ...options })!;
/** 一行文字画出来：✓ 走过的、● 这一步、○ 没到的。 */
const line = (value: ReturnType<typeof meetingProgress>) =>
  value!.steps.map((step) => `${step.state === "done" ? "✓" : step.state === "current" ? "●" : "○"}${step.label}`).join(" ");
const outcome = (status: "pending" | "running" | "ready" | "failed") => ({ status, pendingSince: "2026-10-22T06:10:00.000Z", startedAt: status === "pending" ? null : "2026-10-22T06:10:05.000Z",
  runId: null, previousRunIds: [], error: null, summary: "", items: [], warnings: [], extractedAt: status === "ready" ? "2026-10-22T06:11:00.000Z" : null });
const candidate = { createdAt: "2026-10-22T06:05:00.000Z" } as Payload["transcriptCandidate"];

describe("会议页进度线：在飞书约上的会", () => {
  it("还没到预约时间：等开会是这一步，不呼吸、不走用时", () => {
    const value = model({}, { now: at(-30) });
    expect(line(value)).toBe("✓已约好 ●等开会 ○进行中 ○等妙记 ○生成会议卡 ○待你确认");
    expect(value).toMatchObject({ current: "waiting", tone: "still", since: null, upload: false });
  });

  it("到了预约时间飞书会议还没开：等开会开始呼吸，从预约开始走用时", () => {
    expect(model({}, { now: at(2) })).toMatchObject({ current: "waiting", tone: "breathe", since: START });
  });

  it("飞书会议开着：进行中（红点），从真实开始走用时", () => {
    const value = model({ startedAt: "2026-10-22T05:03:00.000Z" }, { live: "live", now: at(10) });
    expect(line(value)).toBe("✓已约好 ✓等开会 ●进行中 ○等妙记 ○生成会议卡 ○待你确认");
    expect(value).toMatchObject({ tone: "live", since: "2026-10-22T05:03:00.000Z" });
  });

  it("开完了等妙记：从开始等的时刻走用时，约 3 分钟；没有上传入口（原文还没好也一样）", () => {
    const waiting = model({ minutesStatus: "waiting", minutesWaitingSince: "2026-10-22T06:00:00.000Z" }, { live: "ended", ended: true });
    expect(line(waiting)).toBe("✓已约好 ✓等开会 ✓进行中 ●等妙记 ○生成会议卡 ○待你确认");
    expect(waiting).toMatchObject({ tone: "breathe", since: "2026-10-22T06:00:00.000Z", expectedMs: 3 * 60_000, upload: false });
    expect(model({ minutesStatus: "failed", minutesFailure: "not_ready" }, { live: "ended", ended: true })).toMatchObject({ upload: false });
    // 刚收到会议结束、后台还没记等妙记：也是等妙记，不给上传。
    expect(line(model({}, { live: "ended", ended: true }))).toContain("●等妙记");
  });

  it("说话人待确认：那一格写待确认说话人", () => {
    const value = model({ minutesStatus: "ready", transcriptCandidate: candidate }, { live: "ended", ended: true });
    expect(line(value)).toBe("✓已约好 ✓等开会 ✓进行中 ●待确认说话人 ○生成会议卡 ○待你确认");
    expect(value).toMatchObject({ since: candidate!.createdAt, expectedMs: null, upload: false });
  });

  it("自动取妙记失败或超时：那一格写待交记录，后面给上传入口", () => {
    for (const failed of [{ minutesStatus: "manual" as const }, { minutesStatus: "failed" as const, minutesFailure: "fetch_failed" as const }, { minutesManualImport: true }]) {
      const value = model(failed, { live: "ended", ended: true });
      expect(line(value)).toBe("✓已约好 ✓等开会 ✓进行中 ●待交记录 ○生成会议卡 ○待你确认");
      expect(value.upload).toBe(true);
    }
  });

  it("生成会议卡：约 1 分钟，从开跑（排队的从排上）走用时；失败了不呼吸、标红", () => {
    const running = meetingProgress(payload({ status: "held", outcome: outcome("running") }), { live: null, ended: true, now: at(80) });
    expect(line(running)).toBe("✓已约好 ✓等开会 ✓进行中 ✓等妙记 ●生成会议卡 ○待你确认");
    expect(running).toMatchObject({ tone: "breathe", since: "2026-10-22T06:10:05.000Z", expectedMs: 60_000 });
    expect(meetingProgress(payload({ status: "held", outcome: outcome("pending") }), { live: null, ended: true, now: at(80) })).toMatchObject({ since: "2026-10-22T06:10:00.000Z" });
    expect(meetingProgress(payload({ status: "held", outcome: outcome("failed") }), { live: null, ended: true, now: at(80) })).toMatchObject({ current: "card", tone: "fail", since: null });
  });

  it("会议卡好了：待你确认；整卡确认后最后一步是已确认，全部走完", () => {
    const ready = meetingProgress(payload({ status: "held", outcome: outcome("ready") }), { live: null, ended: true, now: at(90) });
    expect(line(ready)).toBe("✓已约好 ✓等开会 ✓进行中 ✓等妙记 ✓生成会议卡 ●待你确认");
    expect(ready).toMatchObject({ since: "2026-10-22T06:11:00.000Z" });
    const confirmed = meetingProgress(payload({ status: "reviewed", outcome: outcome("ready") }), { live: null, ended: true, now: at(90) });
    expect(line(confirmed)).toBe("✓已约好 ✓等开会 ✓进行中 ✓等妙记 ✓生成会议卡 ✓已确认");
    expect(confirmed!.current).toBeNull();
  });

  it("不是确认会议卡的人（参会人、CEO）看到的是待确认；没参会的成员看不到生成到哪，有会后结果就当已生成", () => {
    const ready = meetingProgress(payload({ status: "held", outcome: outcome("ready") }), { live: null, ended: true, now: at(90), mine: false });
    expect(line(ready)).toBe("✓已约好 ✓等开会 ✓进行中 ✓等妙记 ✓生成会议卡 ●待确认");
    const member = meetingProgress(payload({ status: "held", outcome: { items: [] } as unknown as Payload["outcome"] }), { live: null, ended: true, now: at(90), mine: false });
    expect(line(member)).toBe("✓已约好 ✓等开会 ✓进行中 ✓等妙记 ✓生成会议卡 ●待确认");
    expect(member!.since).toBeNull();
  });

  it("没开成：等开会那一格写没开成，不呼吸、标红", () => {
    const value = model({}, { live: "missed", now: at(120) });
    expect(line(value)).toBe("✓已约好 ●没开成 ○进行中 ○等妙记 ○生成会议卡 ○待你确认");
    expect(value).toMatchObject({ tone: "fail", since: null });
  });

  it("已取消的会不画进度线", () => {
    expect(meetingProgress(payload({ status: "cancelled" }), { live: null, ended: true, now: at(0) })).toBeNull();
  });
});

describe("会议页进度线：没在飞书约上的会", () => {
  const plain = (overrides: Partial<Payload>, options: Partial<Parameters<typeof meetingProgress>[1]> = {}) =>
    meetingProgress(payload({ feishuEvent: null, ...overrides }), { live: null, ended: false, now: at(-30), ...options })!;

  it("没有已约好；到点就是进行中，从预约开始走用时", () => {
    expect(line(plain({}))).toBe("●等开会 ○进行中 ○待交记录 ○生成会议卡 ○待你确认");
    expect(plain({}, { now: at(5) })).toMatchObject({ current: "live", tone: "live", since: START });
  });

  it("开完了：待交记录，后面给上传入口；后台在等妙记时写等妙记、不给上传", () => {
    const handIn = plain({}, { ended: true, now: at(70) });
    expect(line(handIn)).toBe("✓等开会 ✓进行中 ●待交记录 ○生成会议卡 ○待你确认");
    expect(handIn.upload).toBe(true);
    const waiting = plain({ minutesStatus: "waiting", minutesWaitingSince: "2026-10-22T06:00:00.000Z" }, { ended: true, now: at(70) });
    expect(line(waiting)).toBe("✓等开会 ✓进行中 ●等妙记 ○生成会议卡 ○待你确认");
    expect(waiting.upload).toBe(false);
  });

  it("飞书没约上、等授权的会也按没在飞书约上算", () => {
    expect(line(plain({ feishuEvent: { ...BOOKED, status: "failed" } }))).toBe("●等开会 ○进行中 ○待交记录 ○生成会议卡 ○待你确认");
  });
});

describe("会议页进度线：用时与样子", () => {
  it("一小时以内 mm:ss，再长写几小时几分钟；没超过预计时跟「· 约 N 分钟」；不出负数", () => {
    const since = "2026-10-22T06:00:00.000Z";
    const after = (seconds: number) => Date.parse(since) + seconds * 1000;
    expect(progressClock(since, after(133), 3 * 60_000)).toBe("02:13 · 约 3 分钟");
    expect(progressClock(since, after(240), 3 * 60_000)).toBe("04:00");
    expect(progressClock(since, after(-5), 60_000)).toBe("00:00 · 约 1 分钟");
    expect(progressClock(since, after(95 * 60), null)).toBe("1 小时 35 分钟");
    expect(progressClock(since, after(2 * 3600), null)).toBe("2 小时");
  });

  it("只画这一步（本人 11/16：不画整条链）：标 aria-current、带用时和入口，走过的和没到的都不画", () => {
    const value = model({ minutesStatus: "manual" }, { live: "ended", ended: true });
    const html = renderToStaticMarkup(<MeetingProgress model={value} actions={<button type="button">上传会议记录</button>} />);
    expect(html.startsWith('<ol class="')).toBe(true);
    expect(html.match(/<li /g)).toHaveLength(1);
    expect(html).toMatch(/data-step="record" data-state="current" data-tone="breathe" aria-current="step">.*待交记录.*上传会议记录<\/button><\/span><\/li><\/ol>$/);
    expect(html).not.toContain("<svg");
    for (const label of ["等开会", "进行中", "生成会议卡", "待你确认"]) expect(html).not.toContain(label);
    // 全部走完（已确认）：画最后一步。
    const settled = { ...value, current: null, steps: value.steps.map((step) => ({ ...step, state: "done" as const })) };
    expect(renderToStaticMarkup(<MeetingProgress model={settled} />)).toMatch(/<li [^>]*data-step="confirm" data-state="done"[^>]*>.*<\/li><\/ol>$/);
    const timed = renderToStaticMarkup(<MeetingProgress model={model({ minutesStatus: "waiting", minutesWaitingSince: new Date(Date.now() - 65_000).toISOString() }, { live: "ended", ended: true })} />);
    expect(timed).toMatch(/等妙记<\/span><time [^>]*role="timer"[^>]*>01:0\d · 约 3 分钟<\/time>/);
  });

  it("减少动效时点不呼吸；走过的实心、没到的空心", () => {
    const css = readFileSync(new URL("../../styles/meeting-progress.module.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.step\[data-tone\] \.dot \{ animation: none; \}/);
    expect(css).toContain(":global([data-reduce-motion='true']) .step[data-tone] .dot { animation: none; }");
    expect(css).toContain(".step[data-state='done'] .dot { border-color: #9aa1ac; background: #9aa1ac; }");
    expect(css).toMatch(/\.dot \{[^}]*border: 1px solid #c3c8d0;/);
    expect(css).toContain(".step[data-tone='breathe'] .dot { animation: progressBreathe");
  });
});
