import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { PersonalMemoryItem, PersonalMemoryList, PersonalMemoryListQuery, UpdatePersonalMemoryItemRequest } from '@warmap/contracts';
import type { FastifyReply } from 'fastify';
import type { AppInstance, RouteContext } from './shared.js';

/** 本人看、改、忘掉自己的个人记忆（R7，这次只要接口）。只操作登录人自己的；别人的条目一律 404。 */
export function registerPersonalMemoryRoutes(app: AppInstance, ctx: RouteContext): void {
    const { personalMemory, requirePerson, fail } = ctx;
    const itemParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false });
    async function respond<T>(reply: FastifyReply, action: () => Promise<T>) {
        reply.header('cache-control', 'no-store');
        try {
            return await action();
        } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === 'PERSONAL_ITEM_NOT_FOUND') return fail(reply, 404, code, '记忆条目不存在');
            if (code === 'PERSONAL_ITEM_NOT_ACTIVE') return fail(reply, 409, code, '这条记忆已被替代或忘掉，不能再改');
            if (code === 'INVALID_PERSONAL_ITEM') return fail(reply, 400, code, '标题或正文为空或过长');
            app.log.error({ code }, 'personal memory unavailable');
            return fail(reply, 503, 'PERSONAL_MEMORY_UNAVAILABLE', '个人记忆暂时不可用，请重试');
        }
    }
    app.get('/api/me/memory/personal', { preHandler: requirePerson, schema: { querystring: PersonalMemoryListQuery, response: { 200: PersonalMemoryList } } },
        async (req, reply) => respond(reply, async () => ({ items: await personalMemory.list(req.person!.personId, { status: req.query.status ?? 'active' }) })));
    // 多余字段（如 owner）直接 400，不静默丢掉。
    app.patch('/api/me/memory/personal/items/:id', { preValidation: async (req, reply) => {
        if (!Value.Check(UpdatePersonalMemoryItemRequest, req.body)) return ctx.invalidInput(reply, UpdatePersonalMemoryItemRequest, req.body);
    }, preHandler: requirePerson, schema: { params: itemParams, body: UpdatePersonalMemoryItemRequest, response: { 200: PersonalMemoryItem } } },
        async (req, reply) => respond(reply, () => personalMemory.edit(req.person!.personId, req.params.id, req.body)));
    // 删除 = 忘掉：不再装进对话；正文留着，后台提炼据此不再把它学回来。
    app.delete('/api/me/memory/personal/items/:id', { preHandler: requirePerson, schema: { params: itemParams, response: { 200: PersonalMemoryItem } } },
        async (req, reply) => respond(reply, () => personalMemory.forget(req.person!.personId, req.params.id)));
}
