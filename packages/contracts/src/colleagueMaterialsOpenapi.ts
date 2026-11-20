import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import { ColleagueFile, ColleagueMaterials, SaveColleagueNoteRequest, SecretFinding, SecretInMaterialResponse, SetRoleSharingRequest } from "./colleagueMaterials.js";

export const colleagueMaterialSchemas: Record<string, JsonSchema> = {
  ColleagueFile, ColleagueMaterials, SaveColleagueNoteRequest, SecretFinding, SecretInMaterialResponse, SetRoleSharingRequest,
};
const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const path = (...names: string[]) => names.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
const response = (name: string) => ({ description: "结果", content: { "application/json": { schema: ref(name) } } });
const errors = (...codes: number[]) => Object.fromEntries(codes.map((code) => [String(code), response("ApiError")]));
const secrets = { "422": { description: "有像密钥的值", content: { "application/json": { schema: ref("SecretInMaterialResponse") } } } };
/** 文件的 422：有像密钥的值（SECRET_IN_MATERIAL），或抽不出文字（ApiError）。 */
const fileUnprocessable = { "422": { description: "有像密钥的值，或抽不出文字", content: { "application/json": { schema: {
  oneOf: [ref("SecretInMaterialResponse"), ref("ApiError")] } } } } };

export const colleagueMaterialPaths: OpenAPIV3.Document["paths"] = {
  "/api/me/colleague-materials": {
    get: { operationId: "readColleagueMaterials", summary: "本人放给同事的伙伴读的资料：说明和文件",
      responses: { "200": response("ColleagueMaterials"), ...errors(401) } },
  },
  "/api/me/colleague-materials/note": {
    put: { operationId: "saveColleagueNote", summary: "存说明；去掉首尾空白后为空就清空。有像密钥的值 422，不存",
      requestBody: { required: true, content: { "application/json": { schema: ref("SaveColleagueNoteRequest") } } },
      responses: { "200": response("ColleagueMaterials"), ...errors(400, 401), ...secrets } },
  },
  "/api/me/colleague-materials/files": {
    post: { operationId: "addColleagueFile", summary: "传一份文件（.md、.pdf、.docx），只存抽出的文字；最多 20 份。有像密钥的值 422，不存",
      requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: {
        file: { type: "string", format: "binary" } } } } } },
      responses: { "200": response("ColleagueMaterials"), ...errors(400, 401, 409, 413), ...fileUnprocessable } },
  },
  "/api/me/colleague-materials/files/{id}": {
    delete: { operationId: "removeColleagueFile", summary: "删掉本人的一份文件", parameters: path("id"),
      responses: { "204": { description: "已删" }, ...errors(401, 404) } },
  },
};
