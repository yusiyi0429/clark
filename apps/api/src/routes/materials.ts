import { Type } from "@sinclair/typebox";
import { AddMaterialLinkRequest, CreateMaterialAnnotationRequest, DecideMaterialAnnotationRequest, DecideMaterialEditProposalRequest, MaterialObjectType,
  RestoreMaterialRemovedRequest, ThreadObjectId } from "@warmap/contracts";
import { MAX_MATERIAL_FILE_BYTES, MaterialParseError, cleanupMaterialTemp, parseMaterialBatch, readStoredMaterial, type ObjectParsedMaterial } from "../materialParser.js";
import { renderMaterialPreview } from "../materialPreview.js";
import { personDisplayNames } from "../people.js";
import { ObjectMaterialError, addObjectMaterialLink, deleteObjectMaterial, getObjectMaterialDetail, listObjectMaterials, readObjectMaterial,
  uploadObjectMaterial, type MaterialViewer } from "../objectMaterials.js";
import type { AppInstance, RouteContext, SessionPerson } from "./shared.js";
import { createMaterialAnnotation, decideMaterialAnnotation, decideMaterialProposal, restoreMaterialRemoved } from "../materialFeedback.js";
import { createMaterialAnnotationAgent, type MaterialAnnotationAgent } from "../materialAnnotationAgent.js";
import { createMaterialAnnotationQueue } from "../materialAnnotationQueue.js";
import { injectMaterialSelection } from "../materialSelection.js";

const params = Type.Object({ objectType: MaterialObjectType, objectId: ThreadObjectId });
const itemParams = Type.Object({ objectType: MaterialObjectType, objectId: ThreadObjectId, materialId: Type.String({ format: "uuid" }) });
const versionQuery = Type.Object({ version: Type.Optional(Type.Integer({ minimum: 1 })) });

export function registerMaterialRoutes(app: AppInstance, ctx: RouteContext, annotationAgent?: MaterialAnnotationAgent): void {
  const { q, pool, companyMemory, materialStorageDir, requirePerson, fail } = ctx;
  const names = personDisplayNames(companyMemory);
  const viewer = (person: SessionPerson): MaterialViewer => ({ personId: person.personId, role: person.role,
    displayName: names.get(person.personId) ?? person.personId });
  const queue = createMaterialAnnotationQueue({ pool,
    agent: annotationAgent ?? createMaterialAnnotationAgent({ baseUrl: ctx.env.piBaseUrl, apiKey: ctx.env.piApiKey, modelId: ctx.env.heavyModel }),
    viewer: (personId) => ({ personId, displayName: names.get(personId) ?? personId,
      role: companyMemory.searchPeople(undefined).find((person) => person.personId === personId)?.roles.includes("ceo") ? "ceo" : "member" }),
    onError: () => app.log.error("material annotation queue failed"),
  });
  let recovery: ReturnType<typeof setInterval> | undefined;
  app.addHook("onReady", async () => {
    await queue.recover().catch(() => app.log.error("material annotation recovery failed"));
    recovery = setInterval(() => { void queue.recover().catch(() => app.log.error("material annotation recovery failed")); }, 60_000);
    recovery.unref();
  });
  app.addHook("onClose", async () => { clearInterval(recovery); await queue.close(); });
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
    let parsed: { directory: string; materials: ObjectParsedMaterial[] } | undefined;
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
      parsed = await parseMaterialBatch(files, { allowHtml: true });
      const material = await uploadObjectMaterial(pool, req.params, viewer(req.person!), parsed.materials[0], materialStorageDir, names);
      return reply.status(201).send(material);
    } catch (cause) {
      if (cause instanceof MaterialParseError) return fail(reply, cause.code === "MATERIAL_FILE_TOO_LARGE" ? 413 : 400, cause.code, cause.message);
      const code = (cause as { code?: string }).code;
      if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") return fail(reply, 413, "MATERIAL_FILE_TOO_LARGE", "单份材料不能超过 20 MB");
      return error(reply, cause);
    } finally { if (parsed) await cleanupMaterialTemp(parsed.directory); }
  });
  app.post("/api/materials/:objectType/:objectId/links", { preHandler: requirePerson,
    schema: { params, body: AddMaterialLinkRequest } }, async (req, reply) => {
    try {
      const { material, created } = await addObjectMaterialLink(pool, req.params, viewer(req.person!), req.body, names);
      return reply.status(created ? 201 : 200).send(material);
    } catch (cause) { return error(reply, cause); }
  });
  app.get("/api/materials/:objectType/:objectId/:materialId", { preHandler: requirePerson,
    schema: { params: itemParams, querystring: versionQuery } }, async (req, reply) => {
    try { return await getObjectMaterialDetail(q, req.params, req.params.materialId, viewer(req.person!), names, req.query.version); }
    catch (cause) { return error(reply, cause); }
  });
  app.post("/api/materials/:objectType/:objectId/:materialId/annotations", { preHandler: requirePerson,
    schema: { params: itemParams, body: CreateMaterialAnnotationRequest } }, async (req, reply) => {
    try {
      const annotation = await createMaterialAnnotation(q, req.params, req.params.materialId, viewer(req.person!), req.body, names);
      if (annotation.status === "queued") void queue.enqueue(req.params.materialId);
      return { annotation };
    } catch (cause) { return error(reply, cause); }
  });
  app.post("/api/materials/:objectType/:objectId/:materialId/annotations/:annotationId/decide", { preHandler: requirePerson,
    schema: { params: Type.Composite([itemParams, Type.Object({ annotationId: Type.String({ format: "uuid" }) })]), body: DecideMaterialAnnotationRequest } }, async (req, reply) => {
    try {
      const annotation = await decideMaterialAnnotation(q, req.params, req.params.materialId, req.params.annotationId, viewer(req.person!), req.body, names);
      if (annotation.status === "queued") void queue.enqueue(req.params.materialId);
      return { annotation };
    } catch (cause) { return error(reply, cause); }
  });
  app.post("/api/materials/:objectType/:objectId/:materialId/restore", { preHandler: requirePerson,
    schema: { params: itemParams, body: RestoreMaterialRemovedRequest } }, async (req, reply) => {
    try {
      await restoreMaterialRemoved(pool, req.params, req.params.materialId, viewer(req.person!), req.body, names);
      return await getObjectMaterialDetail(q, req.params, req.params.materialId, viewer(req.person!), names);
    } catch (cause) { return error(reply, cause); }
  });
  app.post("/api/materials/:objectType/:objectId/:materialId/proposals/:proposalId", { preHandler: requirePerson,
    schema: { params: Type.Composite([itemParams, Type.Object({ proposalId: Type.String({ format: "uuid" }) })]), body: DecideMaterialEditProposalRequest } }, async (req, reply) => {
    try {
      await decideMaterialProposal(pool, req.params, req.params.materialId, req.params.proposalId, viewer(req.person!), req.body.decision);
      return await getObjectMaterialDetail(q, req.params, req.params.materialId, viewer(req.person!), names);
    } catch (cause) { return error(reply, cause); }
  });
  app.get("/api/materials/:objectType/:objectId/:materialId/file", {
    onRequest: async (_req, reply) => { reply.header("content-security-policy", "sandbox"); }, preHandler: requirePerson,
    schema: { params: itemParams } }, async (req, reply) => {
    try {
      const material = await readObjectMaterial(q, req.params, req.params.materialId, viewer(req.person!));
      if (material.format === "link") return fail(reply, 404, "MATERIAL_NO_FILE", "链接没有原件，请直接打开链接");
      let data: Buffer;
      try { data = material.format === "html" || !material.storageKey ? Buffer.from(material.body)
        : await readStoredMaterial(materialStorageDir, material.storageKey); }
      catch { return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料原件不存在"); }
      const mime = material.format === "pdf" ? "application/pdf" : material.format === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : material.format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8";
      const fileName = material.format === "html" ? material.fileName.replace(/\.htm$/i, ".html") : material.fileName;
      return reply.type(mime).header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
        .header("x-content-type-options", "nosniff").send(data);
    } catch (cause) { return error(reply, cause); }
  });
  app.get("/api/materials/:objectType/:objectId/:materialId/preview", {
    onRequest: async (_req, reply) => { reply.header("x-content-type-options", "nosniff").header("content-security-policy", "sandbox"); },
    preHandler: requirePerson,
    schema: { params: itemParams, querystring: versionQuery } }, async (req, reply) => {
    try {
      const material = await readObjectMaterial(q, req.params, req.params.materialId, viewer(req.person!), req.query.version);
      if (material.format === "link") return fail(reply, 404, "MATERIAL_NO_FILE", "链接没有原件，请直接打开链接");
      if (material.format === "html") return reply.type("text/html; charset=utf-8").header("content-disposition", "inline")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'")
        .send(injectMaterialSelection(material.body));
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
