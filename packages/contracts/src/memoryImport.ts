import { Type, type Static } from '@sinclair/typebox';

/**
 * 记忆导入（7a-3、D-06）：从 ChatGPT、Claude（粘贴、上传导出包）和 Claude Code、Codex（本机采集器上报）带进个人记忆。
 * 五步：读取 → 拆分 → 分类 → 去重和冲突 → 等你确认。确认页只列两组：有冲突的、没把握的。
 */
export const MemoryImportSource = Type.Union([Type.Literal('chatgpt'), Type.Literal('claude'), Type.Literal('claude_code'), Type.Literal('codex')]);
export const MemoryImportCategory = Type.Union([Type.Literal('personal_preference'), Type.Literal('company_fact'), Type.Literal('project_instruction'), Type.Literal('drop')],
  { description: '个人偏好（进个人记忆）、公司事实（不进个人记忆）、只对某个项目有效（不导入）、不导入' });
export const MemoryImportDropReason = Type.Union([Type.Literal('stale_state'), Type.Literal('one_off'), Type.Literal('private_life'), Type.Literal('secret'),
  Type.Literal('other_person'), Type.Literal('injection')]);
export const MemoryImportGroup = Type.Union([Type.Literal('conflict'), Type.Literal('uncertain'), Type.Literal('import'), Type.Literal('company'), Type.Literal('project'),
  Type.Literal('duplicate'), Type.Literal('dropped'), Type.Literal('skipped'), Type.Literal('partner')],
  { description: 'conflict / uncertain 是要本人看的两组；import 默认勾选；partner 是同批冲突里较早的那条，跟着冲突那条一起定' });
export const MemoryImportStep = Type.Object({
  id: Type.String(),
  label: Type.String(),
  status: Type.Union([Type.Literal('done'), Type.Literal('active'), Type.Literal('pending'), Type.Literal('stopped')]),
  result: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const MemoryImportFile = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1000, description: '本机路径或上传的文件名；粘贴的用 paste-<n>.txt' }),
  content: Type.String({ description: '文本原文；encoding=base64 时是文件字节的 base64（zip 导出包）' }),
  sha256: Type.String({ pattern: '^[0-9a-fA-F]{64}$', description: '原文字节（base64 解码后）的 sha256' }),
  mtime: Type.String({ format: 'date-time' }),
  encoding: Type.Optional(Type.Literal('base64')),
}, { additionalProperties: false });
export const CreateMemoryImportRequest = Type.Object({
  source: MemoryImportSource,
  files: Type.Array(MemoryImportFile, { minItems: 1, maxItems: 200 }),
}, { additionalProperties: false });

export const MemoryImportCounts = Type.Object({
  files: Type.Integer(), items: Type.Integer(), truncated: Type.Boolean(),
  personal: Type.Integer(), company: Type.Integer(), project: Type.Integer(), dropped: Type.Integer(),
  duplicates: Type.Integer(), conflicts: Type.Integer(), review: Type.Integer(), checked: Type.Integer(),
  imported: Type.Optional(Type.Integer()),
}, { additionalProperties: false });
export const MemoryImportStatus = Type.Union([Type.Literal('processing'), Type.Literal('awaiting_review'), Type.Literal('confirmed'), Type.Literal('failed')]);
export const MemoryImport = Type.Object({
  id: Type.String(),
  source: MemoryImportSource,
  status: MemoryImportStatus,
  steps: Type.Array(MemoryImportStep),
  counts: MemoryImportCounts,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false });
export const MemoryImportCandidate = Type.Object({
  id: Type.String(),
  title: Type.String(),
  text: Type.String(),
  source: MemoryImportSource,
  path: Type.String(),
  category: Type.Union([MemoryImportCategory, Type.Null()]),
  kind: Type.Union([Type.Literal('preference'), Type.Literal('practice'), Type.Null()]),
  dropReason: Type.Union([MemoryImportDropReason, Type.Null()]),
  confidence: Type.Union([Type.Number(), Type.Null()]),
  group: Type.Union([MemoryImportGroup, Type.Null()]),
  checked: Type.Boolean(),
  /** 密钥、注入：不能勾回。 */
  locked: Type.Boolean(),
  /** 有冲突的：对方（已有记忆或同批更早的一条）。 */
  conflict: Type.Union([Type.Object({
    memoryId: Type.Optional(Type.String()),
    candidateId: Type.Optional(Type.String()),
    title: Type.String(),
    text: Type.String(),
    at: Type.String({ format: 'date-time' }),
  }, { additionalProperties: false }), Type.Null()]),
  resolution: Type.Union([Type.Literal('keep_old'), Type.Literal('use_new'), Type.Literal('neither'), Type.Null()]),
  memoryItemId: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export const MemoryImportDetail = Type.Composite([MemoryImport, Type.Object({ candidates: Type.Array(MemoryImportCandidate) })], { additionalProperties: false });
export const MemoryImportList = Type.Object({ items: Type.Array(MemoryImport) }, { additionalProperties: false });
export const ConfirmMemoryImportRequest = Type.Object({
  /** 要导入成个人记忆的条目（冲突组和 partner 不看这里）。 */
  checked: Type.Array(Type.String(), { maxItems: 1000 }),
  /** 冲突怎么定；没给的按 keep_old（只增不改）。 */
  resolutions: Type.Array(Type.Object({ id: Type.String(), choice: Type.Union([Type.Literal('keep_old'), Type.Literal('use_new'), Type.Literal('neither')]) },
    { additionalProperties: false }), { maxItems: 200 }),
}, { additionalProperties: false });

export type TMemoryImport = Static<typeof MemoryImport>;
export type TMemoryImportDetail = Static<typeof MemoryImportDetail>;
export type TMemoryImportCandidate = Static<typeof MemoryImportCandidate>;
export type TCreateMemoryImportRequest = Static<typeof CreateMemoryImportRequest>;
export type TConfirmMemoryImportRequest = Static<typeof ConfirmMemoryImportRequest>;
