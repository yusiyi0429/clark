import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import { ColleagueMaterials, SaveColleagueNoteRequest, SecretInMaterialResponse } from "@warmap/contracts";
import { addFile, listReads, MaterialError, readMaterials, removeFile, saveNote } from "../colleagueMaterials.js";
import { dbScopeSource, scopeReader } from "../colleagueScope.js";
import { MAX_MATERIAL_FILE_BYTES } from "../materialParser.js";
import { personDisplayNames } from "../people.js";
import type { AppInstance, RouteContext } from "./shared.js";

const idParams = Type.Object({ id: Type.String({ minLength: 1 }) });

/** 对外资料（契约 colleagueMaterials.ts）：本人的说明和文件，只动本人自己的。 */
export function registerColleagueMaterialRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, fail, requirePerson, peopleDirectory } = ctx;
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (cause) {
      if (cause instanceof MaterialError) {
        if (cause.findings) return reply.status(422).send({ code: cause.code, message: cause.message, findings: cause.findings });
        return fail(reply, cause.status, cause.code, cause.message);
      }
      throw cause;
    }
  };

  /** 只有读这条带 reads：标题取本人现在的范围目录，不在范围里的不列。 */
  app.get("/api/me/colleague-materials", { preHandler: requirePerson, schema: { response: { 200: ColleagueMaterials } } }, async (req) => {
    const ownerId = req.person!.personId;
    const names = personDisplayNames(peopleDirectory);
    const { entries } = await scopeReader(dbScopeSource({ q, planTasks: ctx.planTasks, names, now: ctx.now() }, ownerId)).catalog();
    const titles = new Map(entries.map((entry) => [entry.itemId, entry.title]));
    return { ...(await readMaterials(q, ownerId)), reads: await listReads(q, ownerId, names, titles) };
  });

  app.put("/api/me/colleague-materials/note", { preHandler: requirePerson, schema: { body: SaveColleagueNoteRequest,
    response: { 200: ColleagueMaterials, 422: SecretInMaterialResponse } } }, async (req, reply) =>
    handle(reply, () => saveNote(q, req.person!.personId, req.body.note, ctx.now())));

  app.post("/api/me/colleague-materials/files", { preHandler: requirePerson, bodyLimit: MAX_MATERIAL_FILE_BYTES + 1024 * 1024,
    schema: { response: { 200: ColleagueMaterials } } }, async (req, reply) => {
    const files: { filename: string; mimetype: string; buffer: Buffer }[] = [];
    try {
      for await (const part of req.files({ limits: { fileSize: MAX_MATERIAL_FILE_BYTES, files: 2 } })) {
        if (part.fieldname !== "file" || files.length) return fail(reply, 400, "INVALID_MATERIAL", "一次只能上传一份文件");
        files.push({ filename: part.filename, mimetype: part.mimetype, buffer: await part.toBuffer() });
      }
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (code === "FST_REQ_FILE_TOO_LARGE") return fail(reply, 413, "MATERIAL_FILE_TOO_LARGE", "单份文件不能超过 20 MB");
      if (code === "FST_FILES_LIMIT") return fail(reply, 400, "INVALID_MATERIAL", "一次只能上传一份文件");
      throw cause;
    }
    if (!files.length) return fail(reply, 400, "INVALID_MATERIAL", "请选择一份文件");
    return handle(reply, () => addFile(q, req.person!.personId, files[0], ctx.now()));
  });

  app.delete("/api/me/colleague-materials/files/:id", { preHandler: requirePerson, schema: { params: idParams } }, async (req, reply) => handle(reply, async () => {
    await removeFile(q, req.person!.personId, req.params.id);
    return reply.status(204).send();
  }));
}
