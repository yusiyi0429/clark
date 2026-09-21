# 19: Meeting Material（Meeting 内嵌值对象）

Type: implementation
Status: ready-for-agent
Blocked by: none — 解析实现与资源边界已于 2026-09-20 裁决；最小 `node:22.13-alpine` 非 root probe 已通过，证据见 `evidence/meeting-material/parser-alpine-probe-2026-09-20.md`

## What to build

为 Meeting 增加 CEO 专用的会前材料集。它是 `Meeting.materials[]`，不是第七实体，不改变 Transcript → Outcome 的唯一输入关系，也不扩张 Supplement Request。

## Acceptance criteria

- [ ] 只允许 CEO 为 `scheduled` Meeting 操作材料；`held`、`reviewed`、`cancelled` 一律只读。
- [ ] 仅接受有有效文字层的 PDF、DOCX、Markdown；单文件 ≤20 MiB、每批 ≤10 份、总计 ≤100 MiB。PDF ≤500 页；DOCX ≤1,000 ZIP entries、≤250 MiB 解压总量、≤50 MiB 单 entry、≤200:1 压缩比；扫描件、图片型 PDF、TXT、PPT/PPTX 和 OCR 不支持。
- [ ] 每批在独立临时目录完成格式、容量、安全及文字抽取校验；每份由无 shell 的 Node 子进程顺序解析（`--max-old-space-size=256`，15 秒 `SIGTERM` 后 2 秒 `SIGKILL`），整批最长 90 秒；任一失败整批拒绝，不保存文件、元数据或部分抽取结果。
- [ ] 原件仅写入 API-only `meeting_materials` named volume；PostgreSQL 仅保存 Meeting 内嵌元数据、相对 storage key、SHA-256、受限抽取文本和接收/提供人。Web、DRI service 与 Agent 没有文件系统访问路径。
- [ ] 仅把当前材料的受限文本与 `material:<id>` 引用交给 Preflight；每份文本 ≤100,000 字符、总输入 ≤300,000 字符。Outcome 只读取 `warmap-transcript.v1`。
- [ ] `ready` 时材料集只读。CEO 确认“返回编辑材料”后，当前 preflight Candidate Material 失效并保持 `pending`；此后才可替换、清空材料集或手动重新预审同一材料集。离开页面不恢复 `ready`。
- [ ] 整批替换可为空；成功替换删除旧材料的元数据、原件与抽取文本，不提供版本浏览器或回滚。失效 preflight 的旧引用降级为“材料已由 CEO 替换/移除，原件不再保留”。
- [ ] PDF 使用 `pdfjs-dist` 验证 `%PDF-` 与有效文字层并经鉴权 API 预览/下载；DOCX 用 ZIP 预检与 `mammoth.extractRawText`，拒绝图片、外部资源、路径穿越、嵌套压缩包和异常 ZIP；Markdown 仅接受严格 UTF-8 `.md` 并作为纯文本。不得引入 `pdf-parse`、native addon、Office iframe、Gotenberg、ONLYOFFICE 或 Collabora。
- [ ] Markdown 禁用 raw HTML/外部资源；DOCX HTML 仅按需生成，经服务端显式 allowlist sanitizer 后返回，不持久化 HTML，删除 style、事件属性、外部图片与危险 URL scheme，并可下载原件。
- [x] Supplement Request 仅保留外发补充信息及真实渠道回执；补充材料**文件**不挂在请求上，而是由 CEO 会外收件后上传至 `materials[]`（`kind: "supplement"`、`supplementFor` 指向已记录请求；scheduled-only、单文件受限解析、不重置/不触发预审；整批替换主材料时一并清空）。旧条款“不增加材料上传、接收、查看”的“接收”部分由本文件组承接（Q33）。
- [ ] 备份和恢复必须使用同一 UTC 批次的 PostgreSQL dump 与 `meeting_materials` volume tar；备份前停止材料写入，恢复后核对每个 storage key 与 SHA-256。
- [x] 已在实际 `node:22.13-alpine`、非 root `node` 用户完成最小依赖 probe：`pdfjs-dist@5.4.296` 有效/空文字层 PDF、`mammoth@1.12.3` DOCX 文本、`sanitize-html@2.17.0` 危险 HTML/URL 清洗、`jszip@3.10.1` 解压大小读取；证据见 `evidence/meeting-material/parser-alpine-probe-2026-09-20.md`。
- [ ] 集成验收仍须覆盖密码/损坏 PDF、真实恶意链接/外部关系/图片/ZIP bomb DOCX、raw HTML/危险 URL Markdown、所有资源与超时边界；记录拒绝原因、耗时、峰值内存、抽取字符数和失败后无 DB/volume 残留。
- [ ] 覆盖成功上传、任一文件失败、容量越界、scheduled-only、ready 只读、确认回退、空集替换、未变材料重跑、失效引用降级及联合备份恢复。

## Planned touchpoints

- `docs/adr/0017-store-meeting-materials-in-an-api-only-volume.md`
- `packages/contracts/src/meetings.ts`
- `apps/api/migrations/`
- `apps/api/src/meetings.ts`, `apps/api/src/app.ts`, `apps/api/src/preflightAgent.ts`
- `apps/api/Dockerfile`, `infra/docker-compose.yml`, `infra/backup/backup.sh`, `infra/backup/restore.sh`
- `apps/web/src/cards/MeetingCard.tsx`, `apps/web/src/app/meetings/[id]/page.tsx`

## Comments

- Q33（2026-09-20，补充材料文件组）：DRI 无 Web 入口，文件由 CEO 会外收件后经 `POST /api/meetings/{id}/materials/supplement`（CEO-only、scheduled-only）归档到对应请求（`supplementFor`）；不自动失效或重跑预审，仅显式「重新预审」时纳入输入；整批替换主材料时随 preflight 重置一并清空；Outcome 只读。
- 2026-09-20 预览切片：新增鉴权 preview endpoint（PDF inline / Markdown text/plain / DOCX 按需 sanitize HTML，不持久化），OpenAPI 补 materials 三条 path，测试见 `evidence/meeting-material/preview-slice-2026-09-20.md`。顺带修复未提交改动中 transcript 413 回归（multipart per-request limits）与三处测试 fixture 缺 `materials` 的问题。全量集成验收（恶意样本、超时/内存、备份恢复）仍未完成。
- Q30：会前预审与 Outcome 复核使用独立原始材料状态页。
- Q31：回退到编辑态而未更换材料即离开，Meeting 仍为 `pending`。
- Q32：Outcome 原始材料弹窗只读，已移除“返回编辑材料”。
- 已选定纯 JS 解析器路径；先通过实际 Alpine probe，再将该依赖写入 lockfile 并实施。不要把现有 Transcript multipart endpoint 复用为材料上传。
