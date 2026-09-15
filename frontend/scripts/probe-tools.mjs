/**
 * 一次性探针：这个型号支不支持**流式** tool call。
 *
 * 口述模式整套屏幕呈现都压在 tool call 上（present_agenda / show_evidence / …）。
 * 如果它只在非流式下给 tool_calls，或者根本不给，那舞台事件就得换一条路走 —— 这件事
 * 必须在写代码之前知道，不能在王总面前知道。
 *
 * 跑法：node --env-file=.env.local scripts/probe-tools.mjs
 */

const base = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1").replace(
  /\/+$/,
  "",
);
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const key = process.env.DEEPSEEK_API_KEY;
if (!key) {
  console.error("没有 DEEPSEEK_API_KEY。用 node --env-file=.env.local 跑。");
  process.exit(1);
}

const tools = [
  {
    type: "function",
    function: {
      name: "show_evidence",
      description: "在舞台上打出一张证据卡。讲到任何文档或数字时必须调用它。",
      parameters: {
        type: "object",
        properties: {
          evidence_id: { type: "string", description: "证据 id，例如 e1" },
          quote: { type: "string", description: "要高亮的原文引文" },
        },
        required: ["evidence_id", "quote"],
      },
    },
  },
];

const messages = [
  {
    role: "system",
    content:
      "你是一位参谋。规矩：讲到任何文档或数字，必须调用 show_evidence 把出处打到屏幕上。纯文本输出就是你要说的话。",
  },
  {
    role: "user",
    content: "呈报第一件事：灯塔客户续约的那件事。证据是 e1，引文「续约意向已口头确认」。",
  },
];

async function probe(stream) {
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      stream,
      thinking: { type: "disabled" },
      temperature: 0.3,
      max_tokens: 400,
      tools,
      tool_choice: "auto",
      messages,
    }),
  });

  console.log(`\n=== stream=${stream} · HTTP ${res.status} ===`);
  if (!res.ok) {
    console.log((await res.text()).slice(0, 600));
    return;
  }

  if (!stream) {
    const json = await res.json();
    const m = json.choices?.[0]?.message;
    console.log("finish_reason:", json.choices?.[0]?.finish_reason);
    console.log("content:", JSON.stringify(m?.content));
    console.log("tool_calls:", JSON.stringify(m?.tool_calls, null, 2));
    return;
  }

  // 流式：把 delta.tool_calls 的分片按 index 拼回来，看它到底怎么发。
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let firstToolAt = null;
  const calls = new Map();
  let finish = null;
  let frames = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const frame of parts) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        frames++;
        const chunk = JSON.parse(raw);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const d = choice.delta ?? {};
        if (d.content) text += d.content;
        if (d.tool_calls) {
          if (firstToolAt === null) {
            firstToolAt = Date.now() - t0;
            console.log("第一个 tool_calls 分片，原样:", JSON.stringify(d.tool_calls));
          }
          for (const tc of d.tool_calls) {
            const at = tc.index ?? 0;
            const cur = calls.get(at) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            calls.set(at, cur);
          }
        }
      }
    }
  }

  console.log("SSE 帧数:", frames, "· finish_reason:", finish);
  console.log("首个 tool_calls 分片耗时:", firstToolAt === null ? "从未出现" : `${firstToolAt}ms`);
  console.log("正文:", JSON.stringify(text));
  console.log("拼回来的 tool call:", JSON.stringify([...calls.values()], null, 2));
  for (const c of calls.values()) {
    try {
      JSON.parse(c.args);
      console.log(`  ${c.name} 的 arguments 是合法 JSON ✓`);
    } catch (e) {
      console.log(`  ${c.name} 的 arguments 拼不成 JSON ✗ ${e.message}`);
    }
  }
}

await probe(false);
await probe(true);
