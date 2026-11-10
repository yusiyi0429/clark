import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
import { ConversationHistorySheet } from "./ConversationHistorySheet";
import { createVoiceChannel } from "./voiceChannel";
import type { ConversationData } from "./useConversation";

/**
 * 对话层页头的伙伴和输入条的小麦克风是同一次听写（用户 11/03 定）：点哪个都一样，两边状态同步。
 * 没有 jsdom：通道直接调，页头静态渲染看状态。
 */
const noop = () => undefined;
const data = { scope: "global", messages: [], status: "idle", streaming: false, partial: "", stage: "thinking", startedAt: 0, error: null, lastReply: null,
  historyStatus: "ready", historyError: null, retryHistory: noop, attachments: [], uploading: false, attachmentError: null,
  uploadFiles: async () => undefined, removeAttachment: noop, send: async () => true, stop: noop } as unknown as ConversationData;
const miles = { name: "miles", form: "miles" as const, personality: "steady" as const };

describe("页头的伙伴和小麦克风共用一次听写", () => {
  it("点伙伴交给输入条登记的那一下（开始或停下由输入条按听写的阶段定）；输入条换了一版就用新的，撤销后再点什么也不做", () => {
    const voice = createVoiceChannel();
    const first = vi.fn();
    const undo = voice.handle(first);
    voice.toggle();
    expect(first).toHaveBeenCalledTimes(1);
    const second = vi.fn();
    voice.handle(second);
    undo();
    voice.toggle();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("输入条报上来的在听和响度，订阅的伙伴马上知道；没变就不吵它", () => {
    const voice = createVoiceChannel();
    const notify = vi.fn();
    voice.subscribe(notify);
    voice.publish(true, 0.4);
    expect([voice.listening(), voice.level()]).toEqual([true, 0.4]);
    voice.publish(true, 0.4);
    expect(notify).toHaveBeenCalledTimes(1);
    voice.publish(false, 0);
    expect(voice.listening()).toBe(false);
  });

  it("页头的伙伴是一颗键：平时是「语音输入」、待机姿势；在听时是「停止听写」，变大、换成在听的姿势", () => {
    const voice = createVoiceChannel();
    const idle = renderToStaticMarkup(<ConversationHistorySheet data={data} label="天枢" global onClose={noop} buddy={miles} voice={voice} />);
    expect(idle).toMatch(/<button[^>]*data-testid="conversation-sheet-buddy"[^>]*aria-label="语音输入"[^>]*aria-pressed="false"/);
    expect(idle).toMatch(/data-place="sheet" data-skin="miles"(?![^>]*data-listening)/);
    expect(idle).toContain('data-pose="idle"');

    voice.publish(true, 0.5);
    const listening = renderToStaticMarkup(<ConversationHistorySheet data={data} label="天枢" global onClose={noop} buddy={miles} voice={voice} />);
    expect(listening).toMatch(/aria-label="停止听写，文字留在输入框"[^>]*aria-pressed="true"/);
    expect(listening).toMatch(/data-place="sheet" data-skin="miles" data-listening="true"/);
    expect(listening).toContain('data-pose="listening"');
  });

  it("在听压过在说：回答进行中开始听写，伙伴也是在听的样子", () => {
    const voice = createVoiceChannel();
    voice.publish(true, 0.2);
    const html = renderToStaticMarkup(<ConversationHistorySheet data={{ ...data, streaming: true }} label="天枢" global onClose={noop} buddy={miles} voice={voice} />);
    expect(html).toContain('data-pose="listening"');
    expect(html).not.toContain('data-pose="speaking"');
  });
});
