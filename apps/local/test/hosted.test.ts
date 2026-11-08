// 由天枢桌面版托管时：配对确认框、选文件夹、托盘状态、托盘菜单都经消息口交给壳（apps/desktop）。
import { describe, expect, it } from "vitest";
import { HostedDesktop, type HostPort } from "../src/desktop/hosted.js";
import { api, ORIGIN, raw, startTestRunner, tempDir } from "./helpers.js";

/** 假的壳：记下本机程序发来的消息，按给定的回答回 confirm、pickFolder。 */
function fakeShell(answers: { confirm?: boolean; folder?: string | null }) {
  const sent: any[] = [];
  let listener: ((e: { data: unknown }) => void) | null = null;
  const port: HostPort = {
    postMessage(m: any) {
      sent.push(m);
      if (m.type === "confirm") setTimeout(() => listener?.({ data: { type: "reply", id: m.id, value: answers.confirm ?? false } }), 5);
      if (m.type === "pickFolder") setTimeout(() => listener?.({ data: { type: "reply", id: m.id, value: answers.folder ?? null } }), 5);
    },
    on(_e, l) { listener = l; },
  };
  return { port, sent, menu: (action: string) => listener?.({ data: { type: "menu", action } }) };
}

describe("由桌面版托管", { timeout: 30_000 }, () => {
  it("配对在壳的确认框里点「是」、选文件夹用壳的选择框；托盘状态报给壳；托盘的暂停、恢复经消息口回来，打开天枢不经本机程序", async () => {
    const work = tempDir("tl-hosted-");
    const shell = fakeShell({ confirm: true, folder: work });
    const t = await startTestRunner({ desktop: new HostedDesktop(shell.port) });
    try {
      const start = await raw(t.port, { method: "POST", path: "/v1/pairings", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
      let token = "";
      for (let i = 0; i < 100 && !token; i++) {
        token = (await raw(t.port, { path: `/v1/pairings/${start.body.pairingId}`, headers: { origin: ORIGIN } })).body.token ?? "";
        if (!token) await new Promise((r) => setTimeout(r, 20));
      }
      expect(token).not.toBe("");
      const confirm = shell.sent.find((m) => m.type === "confirm");
      expect(confirm.title).toBe("天枢本机程序 · 配对");
      expect(confirm.text).toContain(start.body.code);
      const folder = (await api(t.port, token, "POST", "/v1/folders/pick", {})).body.folder;
      expect(folder.path.toLowerCase()).toBe(work.toLowerCase());
      shell.menu("pause");
      await new Promise((r) => setTimeout(r, 50));
      expect((await api(t.port, token, "GET", "/v1/settings")).body.paused).toBe(true);
      expect(shell.sent.filter((m) => m.type === "tray").at(-1).state).toMatchObject({ paired: true, paused: true });
      shell.menu("resume");
      shell.menu("open"); // 打开天枢由壳自己开窗口：本机程序不认
      await new Promise((r) => setTimeout(r, 50));
      expect((await api(t.port, token, "GET", "/v1/settings")).body.paused).toBe(false);
    } finally {
      await t.cleanup();
    }
  });

  it("壳点了「否」或取消选择：配对不成、选文件夹回空；收尾时没回的按拒绝算", async () => {
    const shell = fakeShell({ confirm: false, folder: null });
    const d = new HostedDesktop(shell.port);
    expect(await d.confirm("t", "x")).toBe(false);
    expect(await d.pickFolder()).toBeNull();
    const silent: HostPort = { postMessage() {}, on() {} };
    const d2 = new HostedDesktop(silent);
    const pending = d2.confirm("t", "x");
    d2.stop();
    expect(await pending).toBe(false);
  });
});
