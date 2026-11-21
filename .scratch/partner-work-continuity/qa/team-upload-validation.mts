import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { actors, createAcceptanceApp } from "./fixture.mts";

const f = await createAcceptanceApp();
const path = "/api/me/team-deliveries";
const bare = { clientId: randomUUID(), kind: "share", recipientIds: [actors[1]!.personId], text: "上传校验" };
const payload = Buffer.from(JSON.stringify(bare));
const boundary = "fixture-" + randomUUID();
type Part = { field: string, filename?: string, bytes: Buffer };
const body = (...parts: Part[]) => Buffer.concat([...parts.flatMap(({ field, filename, bytes }) => [
  Buffer.from("--" + boundary + '\r\nContent-Disposition: form-data; name="' + field + '"' +
    (filename === undefined ? "" : '; filename="' + filename + '"') + "\r\n\r\n"), bytes, Buffer.from("\r\n"),
]), Buffer.from("--" + boundary + "--\r\n")]);
const meta: Part = { field: "payload", bytes: payload };
const file: Part = { field: "files", filename: "source.txt", bytes: Buffer.from("要发送的原文") };
try {
  const cookie = await f.login(0);
  const send = async (bytes: Buffer, origin?: string) => f.call(cookie, "POST", path, bytes, {
    "content-type": "multipart/form-data; boundary=" + boundary, ...(origin ? { origin } : {}),
  });
  const check = async (label: string, response: any, expected: number) => {
    assert.equal(response.statusCode, expected, label + ": " + response.body.slice(0, 400));
    console.log(label + " " + response.statusCode + " " + response.json().code);
  };
  await check("origin", await send(body(meta, file), "https://untrusted.invalid"), 403);
  await check("missing metadata", await send(body(file)), 400);
  await check("repeated metadata", await send(body(meta, meta, file)), 400);
  await check("malformed", await send(body({ ...meta, bytes: Buffer.from("{unclosed") }, file)), 400);
  await check("truncated body", await send(body(meta, file).subarray(0, -(boundary.length + 6))), 400);
  await check("bad UUID", await send(body({ ...meta, bytes: Buffer.from(JSON.stringify({ ...bare, clientId: "not-a-uuid" })) }, file)), 400);
  await check("empty file", await send(body(meta, { ...file, bytes: Buffer.alloc(0) })), 400);
  await check("unknown format", await send(body(meta, { ...file, filename: "unknown.bin" })), 400);
  await check("oversized file", await send(body(meta, { ...file, bytes: Buffer.alloc(30 * 1024 * 1024 + 1) })), 413);
  await check("too many files", await send(body(meta, ...Array.from({ length: 21 }, () => file))), 413);
  const list = await f.call(cookie, "GET", path + "?box=sent");
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(list.json().items, []);
  const good = await send(body(meta, file));
  assert.equal(good.statusCode, 200, good.body);
  assert.equal(good.json().delivery.attachments.length, 1);
  console.log("All rejected inputs left the sent list empty and the same clientId later accepted the valid upload.");
} finally { await f.close(); }
