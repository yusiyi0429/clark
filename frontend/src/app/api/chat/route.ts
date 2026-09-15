import { logObservation } from "@/lib/agent/a6/observe";
import { AgentRunFailed, Harness } from "@/lib/agent/harness";
import { SYSTEM_INSTRUCTIONS, wrapContext } from "@/lib/agent/instructions";
import { ORAL_INSTRUCTIONS, wrapOralContext } from "@/lib/agent/instructions-oral";
import { assertSlotSanity, resolveModel } from "@/lib/agent/models";
import { agentRunOpen, agentRunSettle, api } from "@/lib/data/store";
import { companyContextForChat, ontologyLookupForChat } from "@/lib/agent/company-context";
import { encodeSse } from "@/lib/agent/sse";
import { costTapPath, tapModelCall } from "@/lib/models/cost-tap";
import { STAGE_TOOLS, toStageEvent, toolAck } from "@/lib/agent/stage-tools";
import { asHistory, packHistory } from "@/lib/agent/talk/history";
import { lookupEvidence, mergeEntries } from "@/lib/agent/talk/lookup";
import { runMicroResearch, type MicroResult } from "@/lib/agent/talk/micro";
import { buildTalkSystem } from "@/lib/agent/talk/system";
import { runTalkTurn, type TurnRound } from "@/lib/agent/talk/turn";
import { calculate, catalogText } from "@/lib/agent/talk/calc";
import { describe as describeSearch, providers } from "@/lib/research/search";
import type { ResearchDoc } from "@/lib/data/types";
import type { StageEvent } from "@/lib/stage/events";

/**
 * 对话栏和舞台背后的那次真实模型调用。
 *
 * 这是整个前端里**唯一**一处真的出网请求。三件事只在这里做，不在浏览器里做：
 *
 * 1. **密钥。** `DEEPSEEK_API_KEY` 没有 `NEXT_PUBLIC_` 前缀，所以它进不了浏览器包。
 *    对话栏发给这条路由，这条路由再带着密钥去上游。
 * 2. **上游协议。** 上游是 OpenAI 兼容的 SSE；这条路由把它翻成**自己的** SSE：
 *    `event: text` / `event: ui_event` / `event: error`。浏览器那一侧因此不需要认识
 *    `data:` 里的 `choices[0].delta`、`[DONE]`、`tool_calls` 分片，也不需要认识
 *    `reasoning_content` —— 换模型或换供应商只动这个文件。
 * 3. **关掉思维链。** 这一档型号默认是会先想的：实测一句话的回答里思维链吃掉 80 秒，
 *    而一号位面前的对话栏在第三秒之前必须开始出字。想清楚再答是好事，但这一栏的产品
 *    含义是「随口问一句」，不是「提交一个任务」。
 *
 * 上游现在是 **DeepSeek 官方接口**（`api.deepseek.com/v1`）上的 v4-flash。之前因为
 * 这个账号 403 欠费临时切去过火山方舟；账号充上之后切回来了。如果再要切回方舟：
 * base 换 `ark.cn-beijing.volces.com/api/v3`，型号 id 必须带日期后缀
 * （`deepseek-v4-pro-260425`）—— 不带后缀的名字在方舟上是 404，不是密钥问题。
 *
 * 两种模式走同一条路由、同一个 POST、同一条流。分叉只有三处：系统提示、要不要带工具、
 * 上下文的额度。这是「不另建通道」的落点 —— 口述模式没有自己的后端。
 *
 * 关于工具轮：探针（`scripts/probe-tools.mjs`，方舟上重测过）测出来**流式**下工具轮
 * 只给 `tool_calls`、不给正文。所以口述模式天然是「工具轮（屏幕亮）→ 文本轮（开口说）」
 * 两轮，而这正好就是屏随话走要的顺序，不是将就。非流式会把正文和 `tool_calls` 一起给，
 * 所以下面那段还是把 `round0.text` 塞回历史 —— 两种都接得住，不押在探针那一次的结果上。
 *
 * 失败就说失败。上游 4xx/5xx 原样报出状态码，中途断了在正文尾巴上写明被中断 ——
 * 一段被悄悄截断的答案，比一条报错危险得多：他会拿着半句话去开会。
 */

/*
 * 模型不再在这里写死。槽位定义在 lib/agent/models.ts —— 按角色配（pro/flash/alt），
 * 不按厂商配。这一栏是 A6 的回复路径，用 pro：它要给出可证伪的判断，
 * 是质量敏感而非速度敏感的任务。Flash 留给关系标注那类三选一的分类活。
 */

/** 历史带多少轮过去。再往前的轮次对当下这句话的帮助已经小于它占的额度。 */
const HISTORY_TURNS = 12;
const MAX_CHARS_PER_TURN = 4000;
const MAX_CONTEXT_CHARS = 24000;
/**
 * 口述模式的额度大得多：语料全文是整批塞进去的（五份文档正文 + 八个域的判断 + 议程）。
 * 不建索引是故意的 —— 索引会引入「检索没命中」这种在会上没法解释的失败。
 */
const MAX_ORAL_CONTEXT_CHARS = 80000;

/**
 * 工具轮最多转几圈。
 *
 * 会上一件事的正常节奏是：present_item → show_evidence → 说话，两圈工具一圈文本。四圈
 * 是留给他连着追问的余量，也是一道闸：模型如果卡在「再打一张证据」的循环里，屏幕会
 * 一直闪卡而它一句话不说，那比它答错更难看。转满就强制进文本轮。
 */
const MAX_TOOL_ROUNDS = 4;

/**
 * 对谈那一路给「静态前缀 + 对话历史」的总额度。
 *
 * 前缀那一份已经被 `MAX_CONTEXT_CHARS` 卡住，历史逼近这个总额时 `packHistory` 会把最老
 * 一半压成一行一轮（见 `talk/history.ts`）。这一档型号的窗口装得下更多，但再往上加，
 * 第一个字出现的时间会被读上下文吃掉 —— 而那是这一栏唯一的性能指标。
 */
const TALK_WINDOW_CHARS = 64000;

interface Turn {
  role: "user" | "assistant";
  content: string;
}

type Mode = "manual" | "oral";

/** 发给上游的一条消息。工具轮之后要塞 assistant 的 tool_calls 和 tool 的回执。 */
interface UpMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export async function POST(req: Request): Promise<Response> {
  assertSlotSanity();
  const cfg = resolveModel("pro");
  if (!cfg) {
    return fail(
      503,
      "服务端没有配可用的模型（ARK_API_KEY + ARK_MODEL_PRO，或 DEEPSEEK_API_KEY），这一栏现在接不上模型。"
    );
  }
  const key = cfg.apiKey;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "请求体不是 JSON。");
  }

  const parsed = readBody(body);
  if ("error" in parsed) return fail(400, parsed.error);

  const base = cfg.baseUrl;
  const model = cfg.model;
  /** 算账那一口要的两样：注册表别名和真正发出去的 model 字段。见 `cost-tap.ts`。 */
  const billing = { alias: cfg.alias, model: cfg.model };
  const oral = parsed.mode === "oral";

  /*
   * 公司上下文是**追加**的，不替换浏览器算好的那份。
   *
   * 两者来源不同：浏览器那份是 TKOS 自己对象库里的议题、报告和链路图；这一份
   * 是图谱里的公司经营状态与判断链。合并不是重复 —— 前者是「这次讨论到哪了」，
   * 后者是「公司现在是什么状况」。
   *
   * 任何失败都只记日志、不影响回复。让一号位因为后台某个服务不在而对不了话，
   * 比少一段上下文糟得多（这条与 A3/A4 的「就地失败」是有意分歧，理由写在
   * company-context.ts 上）。
   */
  let companyBlock: string | null = null;
  /** 开局预取载入的图谱编号。对谈那一路拿它当「他能引的短码」的底。 */
  let loadedCodes: string[] = [];
  if (!oral && parsed.issueId) {
    /*
     * 标题与判断号都在服务端查，前端不用多存一份会漂移的副本。
     *
     * 判断号是锚点：图谱里没有前端这些议题对象，按标题检索 `ISS-*` 一次都命中不了
     * （见 company-context.ts）。标题照旧要 —— 它是装配时的语义召回问题。
     */
    const issue = await api.getIssue(parsed.issueId).catch(() => null);
    if (issue?.title) {
      const r = await companyContextForChat(issue.title, issue.judgmentRefs ?? []);
      companyBlock = r.block;
      // 这一轮他能引的短码从这里起头，轮内 `ontology_lookup` 取回来的会接着往上加。
      loadedCodes = r.members;
      console.log(`[tkos:graphknowledge] ${r.block ? "注入" : "未注入"} —— ${r.note}`);
    }
  }

  /*
   * 议事对话层 v2 的四个把关条件。
   *
   * 默认开（`!== "0"`，与 `TKOS_DR_V2` 同一个约定），旧路留在开关后面只做对照。
   *
   * 三个是硬的：**口述那一路不进**（它的说话规矩、工具集、额度都是另一套），
   * **没有议题不进** —— 四个工具全都是按议题取的：现查证据读的是这条议题的报告台账，
   * 转异步与改判断状态的 payload 里 `issueId` 必填（空串过不了校验）。缺议题时照旧那段
   * 直连走，**不许造一个占位 id 顶上**：那会让升级落到一条不存在的议题上，而屏幕上看起来
   * 像是正常转了异步。第三个硬条件是**这条议题手上得真有一份深研报告**（下面那一段判）。
   *
   * 第四个把关条件是 `readOnly`，只有一个调用方会带它上来：动态面板
   * （`dynamic-panel.tsx`）。那里的对话框长在一号位首页右栏那块锁屏式玻璃面板上，
   * 摸得到的动作只有「看」，规格把这条写死了（`panel-card.tsx`/`panel.module.css`
   * 那句「一颗按下去会改数据的键不该先长出来」）——但这一路的四个工具里，
   * `propose_point_update` 写判断状态、`micro_research` 会落一次真检索并把结果写进
   * 证据台账，两个都是「按下去会改数据」。`escalate` 记的也是一次转手，同样是写。
   * 面板这个入口如果直连 `talk`，一号位在锁屏卡片上打一句「这条什么时候要」就可能
   * 悄悄写议题台账、花一次检索的钱——而这一路本该只读。
   *
   * 挡在这里、不是挡在四个工具各自的实现里，是因为**公司上下文的注入在这道闸之前**
   * （上面 `companyContextForChat` 那一段，只看 `!oral && parsed.issueId`，不看
   * `talkGate`）——面板要保留的正是这一段，`readOnly` 收起来的只是 `talk` 这一整条
   * 更深的对话层（现查证据、写判断、转异步）。收起 `talkGate` 之后这次请求会落进
   * 下面那个旧路的直连分支，manual 模式下 `tools` 恒为 `null`（`oral && !last` 在
   * `oral === false` 时永远是假），所以面板的每一句话都是一次不带工具的纯问答，
   * 不会触发任何一次写、任何一次外部检索。 */
  const talkGate = !oral && process.env.TKOS_TALK_V2 !== "0" && parsed.issueId !== null && !parsed.readOnly;

  /*
   * v2 那一路要的那几样，一次请求各取一次 —— 别在每次工具调用里重新读库。
   *
   * `system` 里的 `{user}` 在这里就换掉：漏了替换的后果不是渲染难看，是模型会把那个占位
   * 当成人名跟他说话。`history` 是到这一刻说过的话，`ask` 是他刚说的这一句。报告不在这里
   * 取 —— 它是第一次真被问到证据时才读的一份（见下面 `readDoc`）。
   */
  let talk: {
    issueId: string;
    system: string;
    prefix: string;
    history: string;
    ask: string;
  } | null = null;
  if (talkGate && parsed.issueId) {
    const issueId = parsed.issueId;
    /*
     * 第四个条件：**有报告才进这一路**。
     *
     * 对谈那份 system prompt 通篇假定手上有一份报告可引（挑战、按编号取证、改判断状态全建在它上面），
     * 而分诊那一栏正好是「有议题、还没有报告」——那一栏进来会让模型对着一份空台账挑战他。
     * 用 `deepResearchStatus` 判而不是 `getResearchDoc`：后者不是纯读（它会 settle 一轮、
     * 必要时起一轮深研），摆在这里等于他每发一句话都可能触发一轮两三分钟的深研。
     *
     * 这两次取数是**串行**的，不是并发：门在前、钱在后。`deepResearchStatus` 是纯读，
     * `getViewer` 在假库里睡 80–180ms —— 并发的话每一句话都白付一次那个假延时，而这一栏
     * 唯一的性能指标就是第一个字什么时候出现。门不开就不必付慢的那一笔。
     */
    const report = await api.deepResearchStatus(issueId).catch(() => null);
    if (report?.status === "done") {
      const viewer = await api.getViewer();
      /*
       * 报告里可复算的算式目录（2026-09-05）：只有标题、引用、参数名与单位，没有数值 ——
       * 数值要模型调 `report_calculate` 算了才有。放在前缀末尾，紧挨着他这一句之前。
       */
      const calcDoc = await api.getResearchDoc(issueId).catch(() => null);
      const prefix = [companyBlock, wrapContext(parsed.context), catalogText(calcDoc)].filter(Boolean).join("\n\n");
      talk = {
        issueId,
        system: buildTalkSystem(viewer.name),
        prefix,
        /*
         * `TALK_WINDOW_CHARS` 在这一路上**永远不会成为约束**，这是刻意的：`readBody` 已经把
         * 请求体压到「每轮 ≤4000 字、最后 12 轮」，历史里最多 11 轮（最后一句由 `ask` 带走），
         * 11×4000 = 44000 达不到那个数。与旧路同口径 —— 真正卡住长度的是那道入口的闸，
         * 打包那一层的压缩只是兜底。
         */
        history: packHistory(asHistory(parsed.messages), {
          windowChars: TALK_WINDOW_CHARS,
          prefixChars: prefix.length,
        }).text,
        ask: parsed.messages[parsed.messages.length - 1].content,
      };
    }
  }

  const history: UpMessage[] = [
    { role: "system", content: oral ? ORAL_INSTRUCTIONS : SYSTEM_INSTRUCTIONS },
    ...(companyBlock ? [{ role: "system" as const, content: companyBlock }] : []),
    {
      role: "system",
      content: oral ? wrapOralContext(parsed.agenda, parsed.context) : wrapContext(parsed.context),
    },
    ...parsed.messages,
  ];

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      // 已经吐过字了没有。决定后面出的错该怎么报（见 `bail`）。
      let said = false;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        if (event === "text") said = true;
        controller.enqueue(encoder.encode(encodeSse(event, data)));
      };

      /*
       * 出错怎么报，看它出在哪儿。
       *
       * 一个字都还没说 → `event: error`，对话栏在输入框上面留一行报错，什么都不落地。
       * 已经说了一半 → 当成正文的一部分说清楚它断了。这时候不能报 `error`：那会让
       * `send()` 走进 catch，他已经看到的那半段话就不会被记下来 —— 而一段说了一半、
       * 记录里却没有的答案，是最糟的一种失败。
       */
      const bail = (why: string) => {
        if (said) send("text", `\n\n（后半段没接上：${why}）`);
        else send("error", why);
      };

      try {
        if (talk) {
          /*
           * 议事对话层 v2：一次调用 + 按需工具。
           *
           * `deps.round` 就是「`callUpstream` 一次 + `pump` 一次」——**流式那一段一个字不改**：
           * 正文照旧一到就往下吐，工具调用照旧由 `pump` 攒。轮内的循环、预算、三个出口全在
           * `runTalkTurn` 里，这里只负责连上游和落库。
           */
          const spoken: string[] = [];

          /*
           * 这一轮此刻在做什么。屏幕上「正在想」那行扫光小字读的就是它。
           *
           * **只报真的要等的那几步。** `escalate` 和 `propose` 也是这一轮里发生的事，但它们
           * 是 fire-and-forget 的记录动作（下面那两个 dep 里就是一句 `void api.…`），耗时以
           * 微秒计 —— 给它们各报一步，屏幕上是一行闪一下就没的字，而那说的是一句假话：
           * 它会让人以为这一轮的时间花在了转手上，实际全花在上游和检索上。
           *
           * 措辞用这一栏已经在用的词（台账、取证、本体），不另起一套名字：同一件事在运营
           * 台账上叫「轮内取证」，在这里就不该叫别的。
           */
          const step = (label: string) => send("step", label);

          let rounds = 0;
          const round: TurnRound = async (messages, tools) => {
            rounds += 1;
            /*
             * 第一次往返不报 —— 屏幕上本来就是「正在想」，再发一次同样的话等于没发。
             * 第二次起就是「工具跑完了，回去让它说话」，那是他真正在等的那一步。
             */
            if (rounds > 1) step("正在组织回答");
            const res = await callUpstream({ base, key, model, messages, signal: req.signal, tools });
            if ("error" in res) throw new Error(res.error);
            const one = await pump(res.body, send, billing);
            spoken.push(one.text);
            return one;
          };

          const { list: search, skipped } = providers();
          const { issueId } = talk;

          /*
           * 报告是**第一次真被问到证据时才读**的那一份，读到就记住。
           *
           * `getResearchDoc` 不是一次纯读：它里面会 settle 一轮、必要时起一轮深研，还带一段
           * 假延时。摆在这一轮的开头等于他每发一句话都先等一次读，而这一栏唯一的性能指标是
           * 第一个字什么时候出现 —— 这一轮里一次证据都不查的时候（多数时候），那次读白等。
           * 记住那个 promise 是为了一轮里查两次证据也只读一次库。
           */
          let docOnce: Promise<ResearchDoc | null> | null = null;
          const readDoc = (): Promise<ResearchDoc | null> => {
            docOnce ??= api.getResearchDoc(issueId).catch(() => null);
            return docOnce;
          };

          const r = await runTalkTurn(
            {
              round,
              lookup: async (q) => {
                step("正在翻这份报告的台账");
                const doc = await readDoc();
                return lookupEvidence(mergeEntries(doc?.ledger, doc?.blocks?.evidence), q);
              },
              /*
               * 轮内取证：查完落台账，并且这一次真实的外部检索要进运营台账。
               *
               * 两件事都不能省。**落台账**：不落的话这一轮查到的东西出了这一轮就没法指认 ——
               * 他下一轮问「刚才那条」，按编号取证查不到。喂回模型的必须是落库回来那几条，
               * 因为编号是落库那一步重排过的（`landTalkEvidence`）。**记账**：这一栏和深研那一栏
               * 花的是同一份检索额度，只有深研记账的话，运营台账上的用量对不上真实账单。
               * 记账口径照 `recordEscalation` 那一路，没有另起一套。
               *
               * **记账单位是这一次取证** —— harness 在这里现开一份，与 `store.ts` 那条异步取证路
               * 同口径。摆在这一轮外面开的后果是耗时那一半失真：`finish()` 算的是「这份 harness
               * 活了多久」，而它之前还有几轮上游往返，于是台账上一次检索显示成十几秒。对谈主模型
               * 那几轮本来就不走 harness（这条路由有自己的 SSE 路），所以 token 那一半原本就只含
               * 取证这一次的调用、原本就是对的。
               *
               * **这一段的记账配方与 `store.ts` 里 `recordEscalation` 转异步那一路是逐字两份**
               * （开一条运行、记检索配置、`h.finish` 的形状、catch 里 `AgentRunFailed ? err.run
               * : { error }`）。没合并的理由写在那一侧：两条路的骨架不一样，硬合出来的函数要收
               * 五个注入参数。落台账那一半确实只有一份（两边都走 `api.landTalkEvidence`）。
               * **谁改这一段，隔壁那一段要一起改。**
               */
              micro: async (q) => {
                // 这一栏里最慢的一步（真出网检索、抓取、抽取），也是最值得写出来的一步。
                step("正在去外面查证");
                const input = `轮内取证：${q.question}`;
                const openId = agentRunOpen({ agent: "A4", input });
                const h = new Harness({ agent: "A4", slot: "pro" });
                try {
                  // 三家里只有一家在跑时，产出的东西和只配了一家长得一模一样 —— 配置要留痕
                  h.note("检索配置", describeSearch(search, skipped), "local");
                  const res = await runMicroResearch(h, { search }, { question: q.question, issueId });

                  let out: MicroResult = res;
                  if (res.kind === "found" && res.entries.length > 0) {
                    /*
                     * 落不下去（这条议题没有报告、或者库出错）就照原样喂回去：少几个能指认的
                     * 编号，比把一段已经生成好的回应变成一次 500 好得多。
                     */
                    const landed = await api
                      .landTalkEvidence(issueId, res.entries)
                      .catch((e) => {
                        console.warn("[talk] 这次取证的结果没落进台账", e);
                        return [];
                      });
                    if (landed.length === res.entries.length) out = { ...res, entries: landed };
                  }

                  agentRunSettle(
                    openId,
                    h.finish({
                      status: out.kind === "found" ? "ok" : "ignored",
                      input,
                      output:
                        out.kind === "found"
                          ? { found: out.entries.length, groups: out.independentGroups }
                          : { tried: out.tried, why: out.why },
                    }),
                  );
                  return out;
                } catch (err) {
                  agentRunSettle(
                    openId,
                    err instanceof AgentRunFailed
                      ? err.run
                      : { error: err instanceof Error ? err.message : String(err) },
                  );
                  throw err;
                }
              },
              /*
               * 轮内取本体。**这一路不落 Run 记录**，与上面取证那一路有意分歧：取证是一次真花钱
               * 的外部检索（token + 检索额度），运营台上要数得到；取本体是一到两次内网 GET，
               * 记一条运行记录只会在台账里堆出一批 0 token 的空运行，把真花钱的那些淹掉。
               * 留痕走下面这行日志 —— 和 `companyContextForChat` 那一次同一个前缀，两次取本体
               * （开局预取、轮内再取）在日志里就摆在一起。
               */
              /*
               * 程序复算（2026-09-05，`talk/calc.ts`）：读的是**这一版**报告的 `param_model`，
               * 引用带着 `doc.at`，报告重跑后旧引用会被拒。同步只读，不占检索预算。
               */
              calculate: async (ask) => {
                step("正在按报告的算式复算");
                const doc = await readDoc();
                return calculate(doc, ask);
              },
              ontology: async (q) => {
                step("正在问公司记过什么");
                const r = await ontologyLookupForChat(q.query);
                console.log(`[tkos:graphknowledge] 轮内取本体 ${r.kind} —— ${r.note}`);
                return r;
              },
              /*
               * 两个都是记录动作，签名是同步无返回值（`TurnDeps`），而库那两条是 async。
               * 所以这里 fire-and-forget，并且**把失败咽在这一层**：记录失败不该把已经生成好的
               * 这一轮回应变成 500。咽掉不等于不说 —— catch 里 `console.warn` 留痕，
               * 收敛检查下一轮读库时会看到判断状态没跟上，那一路才是纠正它的地方。
               */
              propose: (p) => {
                void api.proposeTalkPoint(issueId, p).catch((e) => console.warn("[talk] 提议没落库", e));
              },
              escalate: (e) => {
                /*
                 * 转深研这一支要**在屏幕上留下一个能点的东西**。
                 *
                 * 别的两支不发：转异步查证落的是台账里几条证据（他下一轮按编号就指得到），
                 * 转待办眼下还没有落点。只有深研这一支的产物是一份要坐下来读的报告 ——
                 * 而一份报告塞不进对话流里，它得有自己的一扇门。
                 *
                 * 发的是**这件事发生了**，不是它的进度：进度归任务表，浏览器那一侧拿着
                 * `issueId` 自己去问（`deepResearchStatus`）。发进度就等于要在这条已经
                 * 结束的流上再挂一条几分钟的连接，而深研比这一轮对话活得久。
                 */
                if (e.type === "deep_research_handoff") {
                  send("research", { issueId: e.payload.issueId, why: e.payload.why });
                }
                void api.recordEscalation(e).catch((err) => console.warn("[talk] 升级没落库", err));
              },
            },
            {
              system: talk.system,
              prefix: talk.prefix,
              history: talk.history,
              ask: talk.ask,
              issueId,
              /*
               * 写死 `true`：进得到这一路就说明这条议题已经有报告了（上面那道闸只放
               * `status === "done"` 进来）。交接深研那一支的告知读它 —— 已有报告时要如实说
               * 「我不会替你把现有报告作废」，而不是许诺一句它做不到的「我回深研重新梳理」。
               */
              hasReport: true,
              loadedCodes,
              nowMs: () => Date.now(),
            },
          );

          /*
           * 正文已经由 `pump` 吐出去了，`reply` 后面那几句当面告知还没上屏。
           *
           * `runTalkTurn` 是把各轮正文按 `\n\n` 接起来、再接上告知的，所以这里照同一个接法
           * 拼出「已经吐过的那一段」，掐掉它只补差量。对不上就一句都不补 —— 同一句话上两遍
           * 比少一句更难看，而这里对不上说明拼法变了，那是代码的事，不该由他在屏幕上承担。
           */
          const head = spoken.filter(Boolean).join("\n\n");
          const tail = r.reply.startsWith(head) ? r.reply.slice(head.length) : "";
          if (tail) send("text", tail);

          console.log(
            `[talk] 轮内工具 ${r.trace.toolCalls.map((c) => c.name).join("、") || "没用"}；` +
              `转手 ${r.trace.escalated.length} 条；轮首 ${r.trace.timing.firstTokenMs}ms、整轮 ${r.trace.timing.totalMs}ms`,
          );
          /*
           * 引了这一轮没载入过的图谱短码 —— **这一版只报不拦**（口径见 `TurnTrace.unknownCodes`）。
           * 单独一行而不是并进上面那句：它不是常态，混在一行统计里会被读过去；而这条一旦
           * 常亮，说明模型在编内部编号，那是要立刻知道的事。
           */
          if (r.trace.unknownCodes.length) {
            console.warn(
              `[talk] 回应里引了这一轮没载入过的编号：${r.trace.unknownCodes.join("、")}` +
                `（本轮载入 ${loadedCodes.length} 个）`,
            );
          }
          if (r.reply) logObservation(issueId, r.reply);
          return;
        }

        for (let round = 0; ; round++) {
          const last = round >= MAX_TOOL_ROUNDS;
          const res = await callUpstream({
            base,
            key,
            model,
            messages: history,
            signal: req.signal,
            // 转满之后收掉工具，逼它开口说话。
            tools: oral && !last ? STAGE_TOOLS : null,
          });

          if ("error" in res) {
            bail(res.error);
            return;
          }

          const round0 = await pump(res.body, send, billing);

          // 有工具调用：把屏幕点亮，回执塞回历史，再转一圈让它说话。
          if (round0.calls.length > 0 && !last) {
            history.push({
              role: "assistant",
              content: round0.text || null,
              tool_calls: round0.calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: c.args },
              })),
            });
            for (const c of round0.calls) {
              let event: StageEvent | null = null;
              try {
                event = toStageEvent(c.name, JSON.parse(c.args || "{}"));
              } catch {
                event = null; // `arguments` 拼不成 JSON。少一张卡，不掐流。
              }
              if (event) send("ui_event", event);
              history.push({ role: "tool", tool_call_id: c.id, content: toolAck(Boolean(event)) });
            }
            continue;
          }

          /*
           * 这一轮说完了。事后观测一次质量 —— 只记日志，不拦、不重写。
           *
           * 流式没有「打回重生成」这个选项：一号位第三秒就看见字了，等说完再
           * 抹掉重来，比说错一句更伤。所以 A6 的质量保证落在 prompt 事前和
           * 日志事后，中间那一层拦不住。口述模式不观测 —— 它的说话规矩是另一套。
           */
          if (!oral && round0.text) logObservation(parsed.issueId, round0.text);
          return;
        }
      } catch (e) {
        // 中途断了。已经吐出去的字保留，但必须说清楚它没说完。
        bail(e instanceof Error ? e.message : "连接中断");
      } finally {
        if (oral) {
          // 这一轮说完了，那盏灯回到聆听。模型不报状态 —— 它报的会晚半秒。
          controller.enqueue(
            encoder.encode(encodeSse("ui_event", { type: "SET_STATE", state: "listening" })),
          );
        }
        open = false;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      // 本地 dev 不需要，但一旦前面挡了 nginx，缓冲会把流式变成一次性。
      "X-Accel-Buffering": "no",
    },
  });
}

/* -------------------------------------------------------------------------- */

/**
 * 上游一次调用。
 *
 * `tools` 收的是**工具集本身**，不是一个开关：会话那边的卡片工具（`STAGE_TOOLS`）和对谈
 * 那边的四个工具（`TALK_TOOLS`）由调用方各自决定，两套不在这里掺。`null` = 这一轮不带工具。
 */
async function callUpstream(o: {
  base: string;
  key: string;
  model: string;
  messages: UpMessage[];
  signal: AbortSignal;
  tools: readonly unknown[] | null;
}): Promise<{ body: ReadableStream<Uint8Array> } | { error: string }> {
  let upstream: Response;
  try {
    upstream = await fetch(`${o.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.key}` },
      // 他一按停止，上游那一次生成也该停 —— 否则额度还在烧。
      signal: o.signal,
      body: JSON.stringify({
        model: o.model,
        stream: true,
        /*
         * **只在量钱的口开着时才要用量。** 关着的时候请求体和从前一字不差。
         *
         * 这条线原来一个 token 都没记账：请求里没要用量，路由里也没有任何地方累加，
         * 而它绕开了 `models/complete.ts` 那个出口。于是「对谈花了多少钱」这个问题
         * 在这台机器上答不出来 —— 而它是一号位用得最频繁的一条。唯一的护栏是下面
         * 那个 `max_tokens`：输出封得住，输入（系统提示 + 公司上下文 + 历史）不封。
         */
        ...(costTapPath() ? { stream_options: { include_usage: true } } : {}),
        // 见文件头第 3 条。
        thinking: { type: "disabled" },
        temperature: 0.3,
        max_tokens: 900,
        ...(o.tools ? { tools: o.tools, tool_choice: "auto" } : {}),
        messages: o.messages,
      }),
    });
  } catch (e) {
    return { error: `没连上模型：${e instanceof Error ? e.message : "网络错误"}。` };
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return { error: `模型拒了这次请求（HTTP ${upstream.status}）。${summarise(detail)}` };
  }
  return { body: upstream.body };
}

interface ToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * 上游一轮 SSE → 我们的 SSE。
 *
 * 正文一到就往下吐，不等这一轮读完 —— 第一个字出现的时间是这一栏唯一的性能指标。
 * `tool_calls` 只能攒：`function.arguments` 是一个字符一个字符来的，拼不完整就没法
 * `JSON.parse`。所以工具事件在这一轮结束时才发，正文是实时的。
 *
 * `reasoning_content` 即使出现也丢掉：思维链已经关了，万一上游又给回来，它也不是
 * 一号位该看该听的东西。
 */
async function pump(
  upstream: ReadableStream<Uint8Array>,
  send: (event: string, data: unknown) => void,
  /** 这一轮用的是哪个模型。只给算账那一口用（`cost-tap.ts`），不影响这一段任何行为。 */
  billing?: { alias: string; model: string },
): Promise<{ text: string; calls: ToolCall[] }> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  // SSE 帧会跨 chunk 断开，甚至能在一个多字节汉字中间断开 —— 所以解码要
  // `stream: true`，切帧要留住残尾。
  let buffer = "";
  let text = "";
  const calls = new Map<number, ToolCall>();
  let saidRetrieving = false;
  let saidPresenting = false;
  /*
   * 上游最后那一帧的用量（只有量钱的口开着时才会有，见 `callUpstream`）。
   *
   * 装在一个盒子里而不是一个 `let`：赋值发生在下面那个闭包里，TS 会把外面那个 `let`
   * 收窄成 `never`。
   */
  const tapBox: { u: { prompt_tokens?: number; completion_tokens?: number } | null } = {
    u: null,
  };

  const flush = (final = false) => {
    const frames = buffer.split("\n\n");
    buffer = final ? "" : (frames.pop() ?? "");
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue; // `: keep-alive` 之类的注释帧
        const raw = line.slice(5).trim();
        if (raw === "" || raw === "[DONE]") continue;
        let delta: UpDelta | undefined;
        try {
          const chunk = JSON.parse(raw) as UpChunk & {
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          // 用量在最后一帧，那一帧的 `choices` 是空的 —— 先接住它再往下走。
          if (chunk.usage) tapBox.u = chunk.usage;
          delta = chunk.choices?.[0]?.delta;
        } catch {
          continue; // 帧坏了就跳过这一帧，不要把整段答案连坐掉
        }
        if (!delta) continue;

        if (delta.content) {
          if (!saidPresenting) {
            saidPresenting = true;
            send("ui_event", { type: "SET_STATE", state: "presenting" });
          }
          text += delta.content;
          send("text", delta.content);
        }

        for (const tc of delta.tool_calls ?? []) {
          if (!saidRetrieving) {
            saidRetrieving = true;
            send("ui_event", { type: "SET_STATE", state: "retrieving" });
          }
          const at = tc.index ?? 0;
          const cur = calls.get(at) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(at, cur);
        }
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      flush();
    }
    flush(true);
  } finally {
    reader.releaseLock();
  }

  const u = tapBox.u;
  if (u) {
    tapModelCall({
      hint: "chat.stream",
      slot: "pro",
      alias: billing?.alias ?? "",
      model: billing?.model ?? "",
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      ms: 0,
      ok: true,
    });
  }

  return {
    text,
    // 没有 id 的调用回不去（`tool_call_id` 是下一轮请求的必填项），丢掉。
    calls: [...calls.values()].filter((c) => c.id && c.name),
  };
}

interface UpDelta {
  content?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface UpChunk {
  choices?: { delta?: UpDelta }[];
}

function readBody(
  body: unknown,
):
  | {
      mode: Mode;
      context: string;
      agenda: string;
      issueId: string | null;
      /** 见 `talkGate` 那段注释：这个调用方要不要保留读写工具。 */
      readOnly: boolean;
      messages: Turn[];
    }
  | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "请求体不是对象。" };
  const { context, messages, mode, agenda, issueId, readOnly } = body as {
    context?: unknown;
    messages?: unknown;
    mode?: unknown;
    agenda?: unknown;
    issueId?: unknown;
    readOnly?: unknown;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: "没有要发的话。" };
  }

  const turns: Turn[] = [];
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || content.trim() === "") continue;
    turns.push({ role, content: content.slice(0, MAX_CHARS_PER_TURN) });
  }

  const tail = turns.slice(-HISTORY_TURNS);
  if (tail.length === 0 || tail[tail.length - 1].role !== "user") {
    return { error: "最后一条必须是他说的话。" };
  }

  const oral = mode === "oral";
  const cap = oral ? MAX_ORAL_CONTEXT_CHARS : MAX_CONTEXT_CHARS;

  return {
    mode: oral ? "oral" : "manual",
    context: typeof context === "string" ? context.slice(0, cap) : "（没有拿到上下文。）",
    agenda: typeof agenda === "string" ? agenda.slice(0, MAX_CONTEXT_CHARS) : "（没有拿到议程。）",
    issueId: typeof issueId === "string" && issueId.trim() ? issueId.trim().slice(0, 120) : null,
    // 没带这个字段的老调用方（对话栏 `chat-pane.tsx`、口述模式）一律当 `false`——
    // 默认值必须是「保留全部工具」，不能是「收起来」：新加一个字段就悄悄改变了
    // 所有既有调用方的行为，是这里最不该发生的事。
    readOnly: readOnly === true,
    messages: tail,
  };
}

/** 上游的错误正文可能是 JSON 也可能是 HTML，只取里面那句人话。 */
function summarise(detail: string): string {
  if (!detail) return "";
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } | string };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (message) return message.slice(0, 200);
  } catch {
    /* 不是 JSON，往下走。 */
  }
  return detail.replace(/\s+/g, " ").slice(0, 200);
}

function fail(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
