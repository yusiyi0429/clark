import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { TMeetingRecording, TStartMeetingRecordingResponse } from "@warmap/contracts";
import { MAX_RECORDING_CHUNK_BYTES, type RecordingFailure } from "../meetingRecordings.js";
import { getMeetingRow } from "../meetingStore.js";
import { idParams, type AppInstance, type Guard, type RouteContext } from "./shared.js";

const recordingParams = Type.Object(
  { id: Type.String({ minLength: 1 }), recordingId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const chunkParams = Type.Object(
  { id: Type.String({ minLength: 1 }), recordingId: Type.String({ minLength: 1 }), seq: Type.Integer({ minimum: 0, maximum: 99999 }) },
  { additionalProperties: false },
);

/**
 * 会议录音由 CEO 或本场主持人操作。分片是原始字节（audio/webm 或 application/octet-stream），
 * 这两个 content-type 的解析器只在本插件作用域内生效，不影响其他路由。
 */
export function registerRecordingRoutes(app: AppInstance, ctx: RouteContext): void {
  const { recordings, fail, requirePerson, q } = ctx;
  const failWith = (reply: FastifyReply, result: RecordingFailure) => fail(reply, result.status, result.code, result.message);
  const requireMeetingHost: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent || req.person!.role === "ceo") return;
    const meeting = await getMeetingRow(q, (req.params as { id: string }).id);
    if (!meeting || meeting.lead_dri_id !== req.person!.personId)
      return fail(reply, 404, "MEETING_NOT_FOUND", "Meeting 不存在");
  };

  void app.register(async (plugin) => {
    plugin.addContentTypeParser(["audio/webm", "application/octet-stream"], { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    const scope = plugin.withTypeProvider<TypeBoxTypeProvider>();

    scope.post(
      "/api/meetings/:id/recordings",
      { preHandler: requireMeetingHost, schema: { params: idParams } },
      async (req, reply): Promise<TStartMeetingRecordingResponse | FastifyReply> => {
        const result = await recordings.start(req.params.id, req.person!.personId);
        if (!result.ok) return failWith(reply, result);
        return reply.status(result.value.created ? 201 : 200).send({ recordingId: result.value.recordingId });
      },
    );

    scope.put(
      "/api/meetings/:id/recordings/:recordingId/chunks/:seq",
      { preHandler: requireMeetingHost, schema: { params: chunkParams }, bodyLimit: MAX_RECORDING_CHUNK_BYTES },
      async (req, reply): Promise<TMeetingRecording | FastifyReply> => {
        if (!Buffer.isBuffer(req.body)) {
          return fail(reply, 400, "INVALID_RECORDING_CHUNK", "录音分片必须是 audio/webm 或 application/octet-stream 的原始字节");
        }
        const result = await recordings.putChunk(req.params.id, req.params.recordingId, req.params.seq, req.body);
        return result.ok ? result.value : failWith(reply, result);
      },
    );

    scope.post(
      "/api/meetings/:id/recordings/:recordingId/finish",
      { preHandler: requireMeetingHost, schema: { params: recordingParams } },
      async (req, reply): Promise<TMeetingRecording | FastifyReply> => {
        const result = await recordings.finish(req.params.id, req.params.recordingId);
        if (!result.ok) return failWith(reply, result);
        return reply.status(202).send(result.value);
      },
    );

    scope.get(
      "/api/meetings/:id/recordings/:recordingId",
      { preHandler: requireMeetingHost, schema: { params: recordingParams } },
      async (req, reply): Promise<TMeetingRecording | FastifyReply> => {
        const recording = await recordings.get(req.params.id, req.params.recordingId);
        return recording ?? fail(reply, 404, "RECORDING_NOT_FOUND", "录音不存在");
      },
    );
  });
}
