/**
 * 对外资料（同事的伙伴能读的）：本人一份说明、若干上传的文件（.md、.pdf、.docx，云端只存抽出的文字）。
 * 存之前云端查疑似凭据，命中 422 SECRET_IN_MATERIAL，这里换成 MaterialSecrets，带逐条在哪、第几行。
 */
import type { TColleagueMaterials, TSecretFinding, TSecretInMaterialResponse } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { CloudError, unwrap } from "@/lib/board/cloud";
import { fileNameOf } from "@/lib/home/attachments";

export type Materials = TColleagueMaterials;

export class MaterialSecrets extends Error {
  constructor(readonly findings: TSecretFinding[]) { super("有像密钥的值"); }
}

/** 422 SECRET_IN_MATERIAL 换成 MaterialSecrets，别的原样抛（技能的「同事可用」开关也用）。 */
export function secretsOr(error: unknown): never {
  if (error instanceof CloudError && error.code === "SECRET_IN_MATERIAL") throw new MaterialSecrets((error.body as TSecretInMaterialResponse).findings);
  throw error;
}

export const readMaterials = () => unwrap(browserApi.GET("/api/me/colleague-materials"));
export const saveNote = (note: string) => unwrap(browserApi.PUT("/api/me/colleague-materials/note", { body: { note } })).catch(secretsOr);

/** multipart，字段名 file。 */
export function uploadMaterial(file: File): Promise<Materials> {
  const body = new FormData();
  body.append("file", file, fileNameOf(file));
  return unwrap<Materials>(fetch("/api/me/colleague-materials/files", { method: "POST", body }).then(async (response) => {
    const json = await response.json().catch(() => undefined);
    return response.ok ? { data: json as Materials, response } : { error: json, response };
  })).catch(secretsOr);
}

/** 删掉一份（204）。 */
export const removeMaterial = (id: string) => unwrap(browserApi.DELETE("/api/me/colleague-materials/files/{id}", { params: { path: { id } } }))
  .then(() => undefined, (error: unknown) => { if (!(error instanceof CloudError && error.status === 204)) throw error; });
