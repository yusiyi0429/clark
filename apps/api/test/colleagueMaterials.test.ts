import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boardFixture, THIRD, type BoardFixture } from "./boardFixture.js";
import { TEST_MEMBER } from "./helpers.js";

const base = "/api/me/colleague-materials";
/** multipart 一个 file 字段。 */
function upload(f: BoardFixture, name: string, data: Buffer, cookie = f.member) {
  const boundary = randomUUID();
  const head = "--" + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + name + '"\r\nContent-Type: application/octet-stream\r\n\r\n';
  return f.t.app.inject({ method: "POST", url: base + "/files", headers: { cookie, origin: f.t.publicOrigin, "content-type": "multipart/form-data; boundary=" + boundary },
    payload: Buffer.concat([Buffer.from(head), data, Buffer.from("\r\n--" + boundary + "--\r\n")]) });
}
async function thirdCookie(f: BoardFixture) {
  const login = await f.call("POST", "/api/auth/login", { loginId: THIRD.loginId, passcode: THIRD.passcode });
  return String(login.headers["set-cookie"]).split(";")[0];
}
const newRole = async (f: BoardFixture, practiceMd = "先交提纲") => {
  const res = await f.call("POST", "/api/me/roles", { name: "调研员", family: "general", kind: "worker", dutiesMd: "查资料", practiceMd, acceptanceMd: "有出处" });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json() as { id: string; version: number; practiceMd: string; shared?: true };
};
const listedRole = async (f: BoardFixture, id: string) =>
  ((await f.call("GET", "/api/me/roles")).json().roles as { id: string; version: number; practiceMd: string; shared?: true }[]).find((role) => role.id === id)!;

describe("对外资料", { timeout: 45_000 }, () => {
  it("说明：存、读、清空；文件：传 .md 抽出文字、列出来、删掉", async () => {
    const f = await boardFixture();
    try {
      expect((await f.call("GET", base, undefined, "")).statusCode).toBe(401);
      expect((await f.call("GET", base)).json()).toEqual({ note: "", noteUpdatedAt: null, files: [] });

      const saved = await f.call("PUT", base + "/note", { note: "部署先看拆分手册" });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({ note: "部署先看拆分手册", noteUpdatedAt: expect.any(String) });
      expect((await f.call("GET", base)).json().note).toBe("部署先看拆分手册");
      expect((await f.call("PUT", base + "/note", { note: "  " })).json()).toEqual({ note: "", noteUpdatedAt: null, files: [] });
      expect(await f.t.sql("SELECT * FROM colleague_notes")).toEqual([]);

      const text = "# 拆分手册\n先做盘点表";
      const added = await upload(f, "手册.md", Buffer.from(text, "utf8"));
      expect(added.statusCode, added.body).toBe(200);
      const files = added.json().files;
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ id: expect.any(String), fileName: "手册.md", size: Buffer.byteLength(text), chars: text.length, createdAt: expect.any(String) });
      expect((await f.call("GET", base)).json().files).toEqual(files);
      const [row] = await f.t.sql("SELECT owner_id, extracted_text FROM colleague_files WHERE id=$1", [files[0].id]);
      expect(row).toMatchObject({ owner_id: TEST_MEMBER.personId });
      expect(row.extracted_text).toContain("先做盘点表");

      expect((await f.call("DELETE", base + "/files/" + files[0].id)).statusCode).toBe(204);
      expect((await f.call("GET", base)).json().files).toEqual([]);
      expect((await f.call("DELETE", base + "/files/" + files[0].id)).statusCode).toBe(404);
    } finally { await f.close(); }
  });

  it("文件：不认的格式 400；第 21 份 409；别人的文件 id 删不了 404", async () => {
    const f = await boardFixture();
    try {
      const xlsx = await upload(f, "表.xlsx", Buffer.from("PK fake", "utf8"));
      expect([xlsx.statusCode, xlsx.json().code]).toEqual([400, "UNSUPPORTED_MATERIAL_TYPE"]);

      const mine = (await upload(f, "手册.md", Buffer.from("先做盘点表", "utf8"))).json().files[0].id as string;
      const third = await thirdCookie(f);
      expect((await f.call("DELETE", base + "/files/" + mine, undefined, third)).statusCode).toBe(404);
      expect((await f.call("DELETE", base + "/files/not-a-uuid")).statusCode).toBe(404);
      expect((await f.call("GET", base)).json().files).toHaveLength(1);

      for (let index = 0; index < 19; index++) {
        await f.t.sql(`INSERT INTO colleague_files(id,owner_id,file_name,size,sha256,extracted_text,created_at) VALUES($1,$2,$3,1,$4,'字',now())`,
          [randomUUID(), TEST_MEMBER.personId, `f${index}.md`, "a".repeat(64)]);
      }
      const full = await upload(f, "第二十一份.md", Buffer.from("多一份", "utf8"));
      expect([full.statusCode, full.json().code]).toEqual([409, "TOO_MANY_FILES"]);
      expect((await f.call("GET", base)).json().files).toHaveLength(20);
    } finally { await f.close(); }
  });

  it("说明、文件、同事可用的技能里有像密钥的值：422，不存", async () => {
    const f = await boardFixture();
    try {
      const res = await f.call("PUT", base + "/note", { note: "第一行\n钥匙是 sk-abcdefghijklmnop1234" });
      expect([res.statusCode, res.json()]).toEqual([422, { code: "SECRET_IN_MATERIAL", message: expect.any(String), findings: [{ where: "说明", line: 2, sample: "sk-abc••••" }] }]);
      expect((await f.call("GET", base)).json().note).toBe("");

      const file = await upload(f, "钥匙.md", Buffer.from("# 配置\n令牌 ghp_" + "a1B2c3D4e5F6g7H8i9J0k1", "utf8"));
      expect(file.statusCode).toBe(422);
      expect(file.json()).toMatchObject({ code: "SECRET_IN_MATERIAL", findings: [{ where: "钥匙.md", line: 2, sample: "ghp_a1••••" }] });
      expect((await f.call("GET", base)).json().files).toEqual([]);

      const role = await newRole(f, "部署用 AKIA" + "ABCDEFGHIJKLMNOP");
      const shared = await f.call("PUT", `/api/me/roles/${role.id}/sharing`, { shared: true });
      expect(shared.statusCode).toBe(422);
      expect(shared.json()).toMatchObject({ code: "SECRET_IN_MATERIAL", findings: [{ where: "技能 · 做法", line: 1 }] });
      expect((await listedRole(f, role.id)).shared).toBeUndefined();
    } finally { await f.close(); }
  });

  it("同事可用：开、关；别人开不了我的技能；已标同事可用的技能再改进密钥：422，技能不变", async () => {
    const f = await boardFixture();
    try {
      const role = await newRole(f);
      const on = await f.call("PUT", `/api/me/roles/${role.id}/sharing`, { shared: true });
      expect(on.statusCode, on.body).toBe(200);
      expect(on.json()).toMatchObject({ id: role.id, shared: true });
      expect((await listedRole(f, role.id)).shared).toBe(true);
      const off = await f.call("PUT", `/api/me/roles/${role.id}/sharing`, { shared: false });
      expect(off.statusCode).toBe(200);
      expect("shared" in off.json()).toBe(false);
      expect("shared" in (await listedRole(f, role.id))).toBe(false);

      const third = await thirdCookie(f);
      const stranger = await f.call("PUT", `/api/me/roles/${role.id}/sharing`, { shared: true }, third);
      expect([stranger.statusCode, stranger.json().code]).toEqual([404, "ROLE_NOT_FOUND"]);
      expect((await listedRole(f, role.id)).shared).toBeUndefined();

      await f.call("PUT", `/api/me/roles/${role.id}/sharing`, { shared: true });
      const before = await listedRole(f, role.id);
      const patch = { version: before.version, practiceMd: "用 sk-abcdefghijklmnop1234" };
      const rejected = await f.call("PATCH", `/api/me/roles/${role.id}`, patch);
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json()).toMatchObject({ code: "SECRET_IN_MATERIAL", findings: [{ where: "技能 · 做法", line: 1, sample: "sk-abc••••" }] });
      expect(await listedRole(f, role.id)).toMatchObject({ version: before.version, practiceMd: "先交提纲", shared: true });

      await f.call("PUT", `/api/me/roles/${role.id}/sharing`, { shared: false });
      const allowed = await f.call("PATCH", `/api/me/roles/${role.id}`, patch);
      expect(allowed.statusCode, allowed.body).toBe(200);
    } finally { await f.close(); }
  });
});
