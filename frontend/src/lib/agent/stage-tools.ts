/**
 * Agent 手里的那几个开关。
 *
 * 口述模式下模型只有两种输出：**说的话**（纯文本，将来喂 TTS）和**屏幕上出现什么**
 * （只能通过调这些工具）。这条边界是硬的 —— 模型不许输出任何要在屏幕上排版的东西，
 * 因为一旦它开始生成结构，屏幕就得渲染它生成的结构，那就等于把版式交给了一个会即兴
 * 发挥的东西。会上出一次错，整套「有出处、可核对」的说法就塌了。
 *
 * 所以工具和舞台事件一对一，每个工具都只收编号或者受控字段，卡片全部由固定模板组件画。
 *
 * `SET_STATE` 不在这里：那盏灯由服务端按流的阶段自己点（要调工具了 → 取证中，开始出
 * 文本了 → 呈报中，这一轮说完了 → 聆听中）。让模型自己报状态会有半秒的谎。
 */

import { parseStageEvent, type StageEvent } from "@/lib/stage/events";

interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

const s = (description: string) => ({ type: "string", description });

export const STAGE_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "present_agenda",
      description: "打出今天的议程。进入会话第一件事就调它，一次。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "present_item",
      description:
        "开始呈报某一件事，屏幕上出现这件事的四个部分。每讲一件事之前必须先调它。",
      parameters: {
        type: "object",
        properties: { item_id: s("议程条目 id，例如 a1") },
        required: ["item_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_evidence",
      description:
        "打出一张证据卡：文档标题、原文引文、出处。讲到任何文档、数字、日期之前必须先调它 —— 屏幕上没有出处的话不许说出口。",
      parameters: {
        type: "object",
        properties: { evidence_id: s("证据 id，例如 e1") },
        required: ["evidence_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_document",
      description: "打开全文并滚到那一段。他说「给我看原文」「这句在哪儿」的时候调它。",
      parameters: {
        type: "object",
        properties: {
          doc_id: s("文档 id，例如 DOC-mp-07"),
          anchor: s("要滚到并高亮的那一段的原文片段，可省"),
        },
        required: ["doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_map",
      description:
        "打出目标与产出那棵树：公司总 Outcome → 八个业务域 → 各自的 Mission，带状态颜色。他问「全局什么样」「哪儿有风险」的时候调它。",
      parameters: {
        type: "object",
        properties: { view: s("聚焦到某个域，域编号如 04，可省") },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_exploration_card",
      description:
        "把一个现在答不了的问题落成一张探索卡。规矩：语料里没有依据的问题，先出声说「这个现在答不了」，然后立刻调它，再说「下次会前给您答案」。不许猜，不许绕过这一步。",
      parameters: {
        type: "object",
        properties: {
          question: s("答不了的那件事，一句话"),
          suggested_dri: s("建议责任人姓名，从在场的人或该域 DRI 里挑"),
          deadline: s("建议期限，例如 8/14"),
          related_ids: {
            type: "array",
            items: { type: "string" },
            description: "关联的判断/议题/域编号，照原样写，例如 04-J2、ISS-014",
          },
        },
        required: ["question", "suggested_dri", "deadline"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_card_status",
      description:
        "把屏幕上那张卡的状态翻过去。他说「就这么定」「让田田去办」之后调它：探索卡 proposed→committed，决策草案 draft→confirmed。",
      parameters: {
        type: "object",
        properties: {
          id: s("卡的 id"),
          status: {
            type: "string",
            enum: ["proposed", "committed", "draft", "confirmed"],
            description: "翻到哪个状态",
          },
        },
        required: ["id", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_decision_draft",
      description:
        "打出七要素决策草案。听出他在拍板的时候调它，然后把七要素复诵一遍请他确认。七个要素一个都不能空。",
      parameters: {
        type: "object",
        properties: {
          title: s("在定哪件事，一句话"),
          choose: s("选了什么"),
          not_choose: s("没选什么"),
          why: s("为什么"),
          key_hypothesis: s("押的假设"),
          risk_accepted: s("认了的风险"),
          commitment: s("承诺：谁在什么时候交出什么"),
          reopen_trigger: s("什么条件下重开"),
          judgment_id: s("会动到哪条判断，编号如 05-J1，可省"),
        },
        required: [
          "title",
          "choose",
          "not_choose",
          "why",
          "key_hypothesis",
          "risk_accepted",
          "commitment",
          "reopen_trigger",
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_summary",
      description: "收尾：今天呈报了几件、立项了几个问题、拍了几次板。最后调一次。",
      parameters: { type: "object", properties: {} },
    },
  },
];

/**
 * 工具调用 → 舞台事件。
 *
 * 名字对不上、参数缺了、`arguments` 拼不成 JSON —— 一律返回 `null`，让上面那层照常
 * 往下走。会上宁可少一张卡，不能因为一次坏调用把整条流掐断。
 */
export function toStageEvent(name: string, args: unknown): StageEvent | null {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "present_agenda":
      return { type: "SHOW_AGENDA" };
    case "present_item":
      return parseStageEvent({ type: "SHOW_CARD", item_id: a.item_id });
    case "show_evidence":
      return parseStageEvent({ type: "SHOW_EVIDENCE", evidence_id: a.evidence_id });
    case "open_document":
      return parseStageEvent({ type: "OPEN_DOC", doc_id: a.doc_id, anchor: a.anchor });
    case "show_map":
      return parseStageEvent({ type: "SHOW_MAP", view: a.view });
    case "create_exploration_card":
      return parseStageEvent({ type: "CREATE_EXPLORATION_CARD", card: a });
    case "update_card_status":
      return parseStageEvent({ type: "UPDATE_CARD_STATUS", id: a.id, status: a.status });
    case "show_decision_draft":
      return parseStageEvent({ type: "SHOW_DECISION_DRAFT", draft: a });
    case "show_summary":
      return parseStageEvent({ type: "SHOW_SUMMARY" });
    default:
      return null;
  }
}

/**
 * 回给模型的那句话。
 *
 * 工具轮之后必须给每个 `tool_call_id` 回一条 `role:"tool"`，否则下一轮请求非法。内容
 * 越短越好 —— 它不是给人看的，是让模型知道「屏幕已经亮了，现在说话」。
 */
export const toolAck = (ok: boolean): string => (ok ? "已呈现在屏幕上。" : "这个没打出来，别提它。");
