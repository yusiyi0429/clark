import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadMeetingRecord } from "./meetingRecordUpload";

afterEach(() => vi.unstubAllGlobals());

describe("会议记录上传", () => {
  it("txt、md、pdf、docx、html 交给服务端认；.json 走直导；没传上去带服务端原因", async () => {
    const fetchMock = vi.fn(async () => Response.json({ cards: [{ id: "meeting:m1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    for (const name of ["纪要.md", "妙记.txt", "会议.pdf", "记录.docx", "页面.html"]) {
      expect(await uploadMeetingRecord("m1", new File(["x"], name))).toEqual({ ok: true, card: { id: "meeting:m1" } });
    }
    expect(fetchMock.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual(Array(5).fill("/api/meetings/m1/transcript-candidate"));
    await uploadMeetingRecord("m1", new File(["{}"], "transcript.json"));
    expect((fetchMock.mock.calls.at(-1) as unknown as [string])[0]).toBe("/api/meetings/m1/transcript");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "DOC_NOT_SUPPORTED", message: "请另存为 docx 再上传" }, { status: 400 })));
    expect(await uploadMeetingRecord("m1", new File(["x"], "老文件.doc"))).toEqual({ ok: false, status: 400, message: "请另存为 docx 再上传" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await uploadMeetingRecord("m1", new File(["x"], "a.md"))).toEqual({ ok: false, status: 0, message: "网络不通，没传上去" });
  });
});
