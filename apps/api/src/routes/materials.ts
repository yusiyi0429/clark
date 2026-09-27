import { Type } from "@sinclair/typebox";
import { MaterialObjectType, ThreadObjectId } from "@warmap/contracts";
import { MAX_MATERIAL_FILE_BYTES, MaterialParseError, cleanupMaterialTemp, parseMaterialBatch, readStoredMaterial } from "../materialParser.js";
import { renderMaterialPreview } from "../materialPreview.js";
import { personDisplayNames } from "../people.js";
import { ObjectMaterialError, deleteObjectMaterial, getObjectMaterialDetail, listObjectMaterials, readObjectMaterial,
  uploadObjectMaterial, type MaterialViewer } from "../objectMaterials.js";
import type { AppInstance, RouteContext, SessionPerson } from "./shared.js";

const params = Type.Object({ objectType: MaterialObjectType, objectId: ThreadObjectId });
const itemParams = Type.Object({ objectType: MaterialObjectType, objectId: ThreadObjectId, materialId: Type.String({ format: "uuid" }) });
const versionQuery = Type.Object({ version: Type.Optional(Type.Integer({ minimum: 1 })) });

export function registerMaterialRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, pool, companyMemory, materialStorageDir, requirePerson, fail } = ctx;
  const names = personDisplayNames(companyMemory);
  const viewer = (person: SessionPerson): MaterialViewer => ({ personId: person.personId, role: person.role,
    displayName: names.get(person.personId) ?? person.personId });
  const error = (reply: Parameters<RouteContext["fail"]>[0], cause: unknown) => {
    if (cause instanceof ObjectMaterialError) return fail(reply, cause.status, cause.code, cause.message);
    throw cause;
  };

  app.get("/api/materials/:objectType/:objectId", { preHandler: requirePerson, schema: { params } }, async (req, reply) => {
    try { return await listObjectMaterials(q, req.params, viewer(req.person!), names); }
    catch (cause) { return error(reply, cause); }
  });
  app.post("/api/materials/:objectType/:objectId", { preHandler: requirePerson,
    schema: { params }, bodyLimit: MAX_MATERIAL_FILE_BYTES + 1024 * 1024 }, async (req, reply) => {
    let parsed: Awaited<ReturnType<typeof parseMaterialBatch>> | undefined;
    try {
      // Check access before parsing an untrusted file.
      await listObjectMaterials(q, req.params, viewer(req.person!), names);
      const files: { filename: string; mimetype: string; buffer: Buffer }[] = [];
      for await (const part of req.files({ limits: { fileSize: MAX_MATERIAL_FILE_BYTES, files: 2 } })) {
        if (part.type !== "file" || part.fieldname !== "file" || files.length)
          return fail(reply, 400, "INVALID_MATERIAL", "一次只能上传一份材料");
        files.push({ filename: part.filename, mimetype: part.mimetype, buffer: await part.toBuffer() });
      }
      if (!files.length) return fail(reply, 400, "INVALID_MATERIAL", "请选择一份材料");
      parsed = await parseMaterialBatch(files);
      const material = await uploadObjectMaterial(pool, req.params, viewer(req.person!), parsed.materials[0], materialStorageDir, names);
      return reply.status(201).send(material);
    } catch (cause) {
      if (cause instanceof MaterialParseError) return fail(reply, cause.code === "MATERIAL_FILE_TOO_LARGE" ? 413 : 400, cause.code, cause.message);
      const code = (cause as { code?: string }).code;
      if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") return fail(reply, 413, "MATERIAL_FILE_TOO_LARGE", "单份材料不能超过 20 MB");
      return error(reply, cause);
    } finally { if (parsed) await cleanupMaterialTemp(parsed.directory); }
  });
  app.get("/api/materials/:objectType/:objectId/:materialId", { preHandler: requirePerson,
    schema: { params: itemParams, querystring: versionQuery } }, async (req, reply) => {
    try { return await getObjectMaterialDetail(q, req.params, req.params.materialId, viewer(req.person!), names, req.query.version); }
    catch (cause) { return error(reply, cause); }
  });
  app.get("/api/materials/:objectType/:objectId/:materialId/file", { preHandler: requirePerson,
    schema: { params: itemParams } }, async (req, reply) => {
    try {
      const material = await readObjectMaterial(q, req.params, req.params.materialId, viewer(req.person!));
      let data: Buffer;
      try { data = material.storageKey ? await readStoredMaterial(materialStorageDir, material.storageKey) : Buffer.from(material.body); }
      catch { return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料原件不存在"); }
      const mime = material.format === "pdf" ? "application/pdf" : material.format === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/markdown; charset=utf-8";
      return reply.type(mime).header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(material.fileName)}`)
        .header("x-content-type-options", "nosniff").send(data);
    } catch (cause) { return error(reply, cause); }
  });
  app.get("/api/materials/:objectType/:objectId/:materialId/preview", { preHandler: requirePerson,
    schema: { params: itemParams } }, async (req, reply) => {
    try {
      const material = await readObjectMaterial(q, req.params, req.params.materialId, viewer(req.person!));
      if (!material.storageKey || material.format === "markdown") return fail(reply, 400, "MATERIAL_PREVIEW_UNAVAILABLE", "Markdown 请在详情中阅读");
      let buffer: Buffer;
      try { buffer = await readStoredMaterial(materialStorageDir, material.storageKey); }
      catch { return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料原件不存在"); }
      const preview = await renderMaterialPreview(buffer, material.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      return reply.type(preview.contentType).header("content-disposition", "inline")
        .header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; sandbox").send(preview.body);
    } catch (cause) { return error(reply, cause); }
  });
  app.delete("/api/materials/:objectType/:objectId/:materialId", { preHandler: requirePerson,
    schema: { params: itemParams } }, async (req, reply) => {
    try { await deleteObjectMaterial(q, req.params, req.params.materialId, viewer(req.person!)); return reply.status(204).send(); }
    catch (cause) { return error(reply, cause); }
  });
}
