import { Value } from '@sinclair/typebox/value';
import { PersonalMemoryDocument, ReplacePersonalMemoryRequest, ForgetPersonalMemoryRequest } from '@warmap/contracts';
import type { PersonalDocument } from '../personalMemory.js';
import type { AppInstance, RouteContext } from './shared.js';
export function registerPersonalMemoryRoutes(app: AppInstance, ctx: RouteContext): void {
    const { personalMemory, requirePerson, fail } = ctx;
    async function respond(reply: import('fastify').FastifyReply, action: () => Promise<PersonalDocument>) {
        reply.header('cache-control', 'no-store');
        try {
            return await action();
        }
        catch (error) {
            const code = (error as {
                code?: string;
            }).code;
            if (code === 'MEMORY_VERSION_CONFLICT')
                return fail(reply, 409, code, '记忆已被修改，请读取最新版本后重试');
            if (code === 'PERSONAL_SECTION_NOT_FOUND')
                return fail(reply, 404, code, '记忆条目不存在');
            if (code === 'PERSONAL_MEMORY_TOO_LARGE')
                return fail(reply, 413, code, '个人记忆超过16 KiB，请整理后重试');
            app.log.error({ code }, 'personal memory unavailable');
            return fail(reply, 503, 'PERSONAL_MEMORY_UNAVAILABLE', '个人记忆暂时不可用，请重试');
        }
    }
    app.get('/api/me/memory/personal', { preHandler: requirePerson, schema: { response: { 200: PersonalMemoryDocument } } }, async (req, reply) => respond(reply, () => personalMemory.readOwn(req.person!.personId)));
    app.put('/api/me/memory/personal', { preValidation: async (req, reply) => { if (!Value.Check(ReplacePersonalMemoryRequest, req.body))
            return ctx.invalidInput(reply, ReplacePersonalMemoryRequest, req.body); }, preHandler: requirePerson, schema: { body: ReplacePersonalMemoryRequest, response: { 200: PersonalMemoryDocument } } }, async (req, reply) => respond(reply, () => personalMemory.replaceOwn(req.person!.personId, req.body)));
    app.post('/api/me/memory/personal/forget', { preValidation: async (req, reply) => { if (!Value.Check(ForgetPersonalMemoryRequest, req.body))
            return ctx.invalidInput(reply, ForgetPersonalMemoryRequest, req.body); }, preHandler: requirePerson, schema: { body: ForgetPersonalMemoryRequest, response: { 200: PersonalMemoryDocument } } }, async (req, reply) => respond(reply, () => personalMemory.forgetOwn(req.person!.personId, req.body)));
}
