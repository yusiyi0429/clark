/**
 * 测试用：腾讯实时识别 16k_zh_en_2.0 的一段实测消息序列（调研 scratchpad run_20_wav.log，13.8 秒合成语音）。
 * 每项：[slice_type, index, end_time(ms), voice_text_str]。之后一条 final:1，再以 1006 关闭。
 */
export const RUN_20_SLICES: [0 | 1 | 2, number, number, string][] = [
  [0, 0, 680, "文"],
  [1, 0, 880, "文"],
  [1, 0, 1080, "那"],
  [1, 0, 1680, "嗯那个"],
  [1, 0, 2280, "嗯，那个我们今"],
  [1, 0, 2880, "嗯，那个我们今天下午"],
  [1, 0, 3480, "嗯，那个我们今天下午三点"],
  [1, 0, 4080, "嗯，那个我们今天下午三点开会"],
  [1, 0, 4680, "嗯，那个我们今天下午三点开会呃"],
  [1, 0, 5280, "嗯，那个我们今天下午三点开会，呃，就是"],
  [1, 0, 5880, "嗯，那个我们今天下午三点开会，呃，就是讨论"],
  [1, 0, 6480, "嗯，那个我们今天下午三点开会，呃，就是讨论一下"],
  [1, 0, 7080, "嗯，那个我们今天下午三点开会，呃，就是讨论一下，讨论"],
  [1, 0, 7680, "嗯，那个我们今天下午三点开会，呃，就是讨论一下，讨论一下"],
  [1, 0, 8280, "嗯，那个我们今天下午三点开会，呃，就是讨论一下，讨论一下第四季度"],
  [1, 0, 8880, "嗯，那个我们今天下午三点开会，呃，就是讨论一下，讨论一下第四季度的预算"],
  [2, 0, 9360, "嗯，那个我们今天下午3点开会，呃，就是讨论一下，讨论一下第四季度的预算。"],
  [0, 1, 10100, "然"],
  [1, 1, 10300, "然"],
  [1, 1, 10500, "然后呢"],
  [1, 1, 11300, "然后呢，请"],
  [1, 1, 11900, "然后呢，请大家提"],
  [1, 1, 12500, "然后呢，请大家提前准备"],
  [1, 1, 13100, "然后呢，请大家提前准备好材料"],
  [2, 1, 13620, "然后呢，请大家提前准备好材料。"],
];

/** 按腾讯的线格式拼成一条消息（老格式 result.slice_type）。 */
export function tencentMessage(slice: [number, number, number, string] | null, extra: Record<string, unknown> = {}): string {
  const body: Record<string, unknown> = { code: 0, message: "success", voice_id: "v-1", message_id: "v-1_1", final: 0, ...extra };
  if (slice) {
    const [type, index, end, text] = slice;
    body.result = { slice_type: type, index, start_time: index === 0 ? 0 : 9500, end_time: end, voice_text_str: text, word_size: 0, word_list: [] };
  }
  return JSON.stringify(body);
}
