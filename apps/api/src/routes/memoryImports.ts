import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConfirmMemoryImportRequest, CreateMemoryImportRequest, MemoryImport, MemoryImportDetail, MemoryImportList } from '@warmap/contracts';
import { collectorConsentGranted } from '../collectorDistill.js';
import type { MemoryImports } from '../memoryImports.js';
import { authenticatePersonalToken } from '../personalTokens.js';
import type { AppInstance, RouteContext } from './shared.js';

/** 一次导入的请求体上限：Claude 导出包（base64）可能带着聊天记录，服务端只解记忆相关的文件。 */
const IMPORT_BODY_LIMIT = 48 * 1024 * 1024;

/**
 * 记忆导入（7a-3）：POST 收文件（登录态：粘贴、上传；采集器令牌：本机 Claude Code、Codex 的记忆文件），后台分类，
 * GET 看步骤和候选，POST confirm 本人确认，POST retry 从停住的那一步接着做，DELETE 丢弃（确认前）。只操作本人的导入，别人的一律 404。
 */
export function registerMemoryImportRoutes(app: AppInstance, ctx: RouteContext, imports: MemoryImports): void {
    const { q, fail, requirePerson, peopleDirectory } = ctx;
    const owners = new WeakMap<FastifyRequest, { personId: string; via: 'session' | 'collector' }>();
    const params = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false });
    async function respond<T>(reply: FastifyReply, action: () => Promise<T>) {
        reply.header('cache-control', 'no-store');
        try {
            return await action();
        } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === 'MEMORY_IMPORT_NOT_FOUND') return fail(reply, 404, code, '这次导入不存在');
            if (code === 'MEMORY_IMPORT_NOT_READY') return fail(reply, 409, code, '这次导入还没整理完，或已经确认过');
            if (code === 'MEMORY_IMPORT_NOT_FAILED') return fail(reply, 409, code, '这次导入没有停住，不用重试');
            if (code === 'MEMORY_IMPORT_CONFIRMED') return fail(reply, 409, code, '已经确认过的导入不能丢弃');
            if (code === 'IMPORT_HASH_MISMATCH') return fail(reply, 400, code, '文件内容和 sha256 对不上');
            if (code === 'IMPORT_UNREADABLE') return fail(reply, 400, code, '文件读不出来');
            if (code === 'IMPORT_TOO_LARGE') return fail(reply, 413, code, '文件太大或太多');
            app.log.error({ code }, 'memory import unavailable');
            return fail(reply, 503, 'MEMORY_IMPORT_UNAVAILABLE', '记忆导入暂时不可用，请重试');
        }
    }
    /** 带 Bearer 的是采集器令牌（只认 client=collector，且本人已同意采集，D-18）；否则按登录态（写请求还要同源）。 */
    const requireOwner = async (req: FastifyRequest, reply: FastifyReply) => {
        if (/^Bearer\s/i.test(req.headers.authorization ?? '')) {
            const identity = await authenticatePersonalToken(q, req.headers.authorization, ctx.env.sessionSecret, ctx.now(),
                (personId) => peopleDirectory.searchPeople(undefined).some((person) => person.personId === personId));
            if (!identity || identity.client !== 'collector') return fail(reply, 401, 'UNAUTHORIZED', '采集器令牌无效，请在天枢重新生成采集器令牌');
            if (!await collectorConsentGranted(q, identity.personId)) return fail(reply, 403, 'COLLECTOR_CONSENT_REQUIRED', '还没有同意采集，请在天枢的上手流程里打开采集');
            owners.set(req, { personId: identity.personId, via: 'collector' });
            return;
        }
        await requirePerson(req, reply);
        if (reply.sent) return reply;
        owners.set(req, { personId: req.person!.personId, via: 'session' });
    };

    app.post('/api/me/memory/imports', { preValidation: requireOwner, bodyLimit: IMPORT_BODY_LIMIT, schema: { body: CreateMemoryImportRequest, response: { 202: MemoryImport } } },
        async (req, reply) => respond(reply, async () => {
            const owner = owners.get(req)!;
            const created = await imports.create(owner.personId, owner.via, req.body);
            return reply.status(202).send(created);
        }));
    app.get('/api/me/memory/imports', { preHandler: requirePerson, schema: { response: { 200: MemoryImportList } } },
        async (req, reply) => respond(reply, async () => ({ items: await imports.list(req.person!.personId) })));
    app.get('/api/me/memory/imports/:id', { preHandler: requirePerson, schema: { params, response: { 200: MemoryImportDetail } } },
        async (req, reply) => respond(reply, () => imports.detail(req.person!.personId, req.params.id)));
    app.post('/api/me/memory/imports/:id/confirm', { preHandler: requirePerson, schema: { params, body: ConfirmMemoryImportRequest, response: { 200: MemoryImport } } },
        async (req, reply) => respond(reply, () => imports.confirm(req.person!.personId, req.params.id, req.body)));
    app.post('/api/me/memory/imports/:id/retry', { preHandler: requirePerson, schema: { params, response: { 200: MemoryImport } } },
        async (req, reply) => respond(reply, () => imports.retry(req.person!.personId, req.params.id)));
    app.delete('/api/me/memory/imports/:id', { preHandler: requirePerson, schema: { params, response: { 204: Type.Null() } } },
        async (req, reply) => respond(reply, async () => {
            await imports.discard(req.person!.personId, req.params.id);
            return reply.status(204).send(null);
        }));
}
