# Meeting Material 预览切片验证（2026-09-20）

## 范围

Ticket 19 最小后端纵向切片：鉴权 PDF inline 预览 + DOCX/Markdown 安全非持久化预览 endpoint、OpenAPI 契约、聚焦测试；并修复未提交改动中的三处既有回归。

## 实现

- `apps/api/src/materialPreview.ts`：按 mimeType 生成预览体。PDF/Markdown 返回原始字节（text/markdown → `text/plain; charset=utf-8`，raw HTML 天然失效）；DOCX 经 `mammoth.convertToHtml` + `sanitize-html` 显式 allowlist（仅 p/标题/列表/强调/表格/受限 https 链接；删除 style、事件属性、图片、`javascript:`/`data:`/`file:`），按需生成，不持久化。
- `apps/api/src/app.ts`：`GET /api/meetings/:id/materials/:materialId/preview`（requireCEO），响应带 `content-disposition: inline`、`x-content-type-options: nosniff`、`content-security-policy: default-src 'none'; sandbox`。
- `packages/contracts/src/openapi.ts`：补 `/api/meetings/{id}/materials`（POST，此前缺失）、`.../preview`、`.../download` 三条 path；`gen:client` 重新生成 web 的 openapi.json 与 schema.d.ts（未手改生成文件）。

## 修复的既有回归（均属未提交的 Ticket 19 工作，非本次引入）

1. **Transcript 413 边界失效**（根因）：materials 上传把全局 `@fastify/multipart` limits 从 1 MiB/1 file 放宽为 20 MiB/10 files，使 transcript web 路径的 `FST_REQ_FILE_TOO_LARGE`→413 变成 schema 校验 400，破坏"web 与 service 同一大小上限"。修复：transcript 与 materials 路由各自传 per-request `limits`（`req.file({limits})` / `req.files({limits})`），全局恢复 1 MiB/1 file 默认。
2. `packages/contracts/test/contract.test.ts`：MeetingCardPayload fixture 缺新增必填 `materials`。
3. `apps/api/test/migrate.test.ts`：未列入 `014_meeting_materials.sql`（及 count 13→14）；`apps/web/src/cards/meetingWorkspace.test.tsx` fixture 缺 `materials: []`。

## 测试

- 新增 `apps/api/test/materialPreview.test.ts`（4 用例，真实 DB + 真实解析 worker）：PDF inline 原字节；未登录 401 + Markdown 以 text/plain 返回 raw `<script>` 文本；DOCX 预览为清洗后 HTML（含 `<p>` 正文、无 script/img/style/on*、404 路径、volume 中无 HTML 残留仅 3 份原件）；恶意 DOCX（script/img/javascript: 链接）经 allowlist 清洗。
- 结果：API 21 文件 255 用例全绿（连续 3 次；期间一次 19 例失败为并行全量跑重叠导致的环境性 flake，重跑即绿）；contracts 28 绿；web 38 绿；`pnpm -r typecheck` 通过。

## 未覆盖（后续验收仍需）

密码/损坏 PDF、ZIP bomb、扫描件等恶意样本的全量集成验收、超时与内存峰值记录、联合备份恢复演练、Web 预览 UI 接线。
