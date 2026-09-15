/**
 * 跑一次 A4 Deep Research。
 *
 * ## 这个文件里的四链路已经不是默认那一支
 *
 * `runDeepResearch` 第一句就按 `v2On()` 转给 `pipeline.ts` 的七步链，**默认转**。下面这一整套
 * 只在 `TKOS_DR_V2=0` 时跑，留着的用处是拿同一个议题两边各跑一遍作对比 —— 不是「随时会被
 * 选中的旧路」，也不是回滚开关（回滚要连着 `dims.ts` / `draft.ts` / `audit.ts` 那一套一起回）。
 * 入口只读一次开关：同一轮里不许一半走新的一半走旧的。
 *
 * 外面四步：装配上下文 → **各条链路各自研究** → 压成四节（校验 + 带违规重修）→ 反证复核。
 * 链路里各四步：编译命题 → 取证 → 写正式报告 → 出口对账（过不去重写一轮）。
 *
 * 区块那一支（`TKOS_DR_BLOCKS=1`）在链路和压缩之间多一步：**对齐各条的分歧**，折出
 * `divergence_view` 插进主源那一份（任务书 §4.3，实现在 `blocks/divergence.ts`）。
 *
 * ## 三条链路，各跑一整套
 *
 * 一轮深研是**三次互不相干的研究**同时在跑：DeepSeek（`pro`）、Claude（`alt`，Bedrock 上的
 * Opus 5）、ChatGPT（`synth`，Bedrock 上的 GPT-5.6）。2026-08-27 之前还有第四条（豆包，
 * `seed` 槽位），撤掉了 —— 依据见 `models/registry.ts` 文件头。几条走的是同一套框架 ——
 * 同一份编命题的指令、同一批检索家、同一份写报告的指令、同一道出口对账 —— 但**各自编自己的
 * 命题、各自发自己的检索式、各自抓页抽取入账、各自写报告**。每条各有一份台账，谁也看不到谁的。
 *
 * 上一版不是这样：那一版一套证据、两个模型各写一份，第三个模型读那两份再合一份。区别不在
 * 省几次调用，在于**分歧的含义**。共用一套证据时，两份结论不一致只可能是「同一批材料被读
 * 出了两种意思」；各自取证之后，不一致还可能是**取回的材料本身不同** —— 而那一种分歧指得出
 * 「有一条链路漏掉了某个来源」，是这几条里最值钱的一条信息。代价照实说：检索、抓取、抽取、
 * 写报告这几笔开销**按链路条数乘**，四条链路就是四倍。多接一条链路多买一份这种信息，也多
 * 付一份这个价 —— 那是加链路时唯一要先算清的事。
 *
 * 几条同时跑、同时显示、各自计时：每条链路自己走到第几步、自己起跑于什么时刻、自己跑了
 * 多久，都往任务表上报（`DraftReport`），报告区那一排页签从那里长出来。一条写完就能读，
 * 不等别的几条。
 *
 * ## 判断板和四节只从 ChatGPT 那一条压出来
 *
 * 主源是 `PRIMARY_SLOT` 那一条，**跑之前就定了**（所以页签的 key 从第一次上报起就是终值）。
 * 四节、判断板、`violations`、`degraded`、立案写回的锚点，全部只看它。
 *
 * 几份都压的话就得先回答「板上这条判断是哪一份压出来的」，而那个问题一旦出现在屏幕上，
 * 一号位每读一条判断都要先分辨它的来处 —— 屏幕上只有一块判断板，这是产品事实，不是省事。
 *
 * 主源那一条自己挂了：顺位落到还写成了的第一条上（`LANES` 的顺序），trace 和完成事件里
 * 都写明换了谁。那一下整排页签的 key 会重排一次 —— 这是唯一会发生这件事的情形。
 *
 * ## 一条挂了不拖垮这一轮
 *
 * 任何一条链路挂了（限流、401、超时、正文回来是空的）只影响它自己那一栏：它保留页签、
 * 带着失败原话，别的几条照跑照落库。**全挂了这一轮才算挂** —— 那时抛
 * `AgentRunFailed`，运营台上留一条带每条原话的失败记录，不自动重试。
 *
 * ## 分母
 *
 * 外面那个进度条是 4 步（区块那一支 5 步，多的是对齐分歧那一步），链路里那个是 4 步
 * （不联网时 2 步）。两个分母都在起跑之前算出来 —— total 一旦报出去就不该再变。**外面那个
 * 分母不随链路条数变**：几条链路是同时跑的一步，不是几步，所以接第四条链路时这两个数
 * 一个都不用改。所以对齐分歧那一格跟着开关走，不跟着「这一轮折不折得出分歧」走：折不出来
 * 的那一轮它照样报一次，小字里写明为什么跳过。
 *
 * 没配检索 key 的机器上，每条链路的前两步整段跳过，走 `a4ReportSystem(false)` 那一支：
 * 报告照实写明本轮未联网核验。一次深研不该因为没配 key 就失败（HP-5）。
 *
 * ## 取证在写作之前，而且分得开
 *
 * 检索、抓取、抽取、入账、独立性折叠、覆盖判定这六段在 `evidence.ts` 和
 * `src/lib/research/` 里，写作只看**证据包**。中间这层台账不是记账癖 —— 它是「这句话
 * 凭什么这么说」唯一能答得出来的地方。少了它，报告里的每个数字都只能靠模型自己保证，
 * 而模型对一个记错的数和一个查到的数一样自信。
 *
 * ## 出口对账为什么在压缩之前
 *
 * 引用绑不上、反证被漏掉、算术对不上 —— 这些都是**报告**的问题。等压成四节之后再发现，
 * 能改的只有四节，而报告一个字没动，那份可署名分发的原件就带着错发出去了。所以这道闸
 * 卡在报告和压缩之间，它的 p0 直接触发一轮报告重写。**每条链路各自对账、各自重写一轮**：
 * 几份是几个模型按各自的证据包写的，一份的引用绑不上不说明另一份也绑不上。
 *
 * ## 为什么报告和四节是两次调用
 *
 * 交付是两层：`sourceText` 是那份可署名分发的正式报告（S03 §6），四节是屏幕上按条
 * 读的压缩面。理由和不能倒过来写的原因都在 `prompt.ts` 头部。
 *
 * ## 反证那一遍走 pro，而主源现在是 ChatGPT
 *
 * 反证复核用 `pro`（deepseek-v4-pro）。主源换成 ChatGPT 那一条之后，这一遍**确实**是另一个
 * 家族在冲主源的结论 —— 但别把它读成交叉校验：同一个模型刚刚才写完几份原件里的 DeepSeek
 * 那一份，它对这个议题的看法不是白纸。它剩下的价值是上下文干净（只拿到结论和公司上下文，
 * 看不到论证过程，所以不会顺着原来的思路往下滑）。屏幕上仍然只写「反证复核」，不写
 * 「独立第二源」。
 */
import { parseJson, str, toStatements, type Msg } from "@/lib/agent/json";
import { AgentRunFailed, Harness } from "@/lib/agent/harness";
import { cognitiveFor } from "@/lib/agent/prompts";
import { blocking, fmt, summarize, type Violation } from "@/lib/agent/rules";
import { modelMockOn } from "@/lib/models/mock";
import { MODELS } from "@/lib/models/registry";
import { resolveModel, SLOT_ALIAS, type Slot } from "@/lib/models/slots";
import type {
  AgentRunRecord,
  AltReport,
  DraftReport,
  ManifestItem,
  ResearchDoc,
  Statement,
} from "@/lib/data/types";
import type { Calculation } from "@/lib/research/calc";
import { Ledger } from "@/lib/research/ledger";
import {
  describe,
  providerCode,
  providerLabel,
  providers,
  type SearchAccount,
} from "@/lib/research/search";

import {
  insertDivergences,
  readDivergences,
  stanceMaterial,
  stancesOf,
} from "./blocks/divergence";
import { blocksOn } from "./blocks/flag";
import { lintAssembled, lintStored, mustRewrite, rejectedFrom } from "./blocks/lint";
import { parseBlocks } from "./blocks/parse";
import { assembleReport, blocksToText, spliceRepair } from "./blocks/report";
import type { Block, ReportBlocks } from "./blocks/schema";
import {
  assembleStaged,
  crossSectionRepeats,
  keyPointsOf,
  mergeUsage,
  readOutline,
  usageMaterial,
} from "./blocks/stages";
import { bindCitations, evidenceManifest, gateReport } from "./gate";
import { gatherEvidence, type Round } from "./evidence";
import { noExternalEvidence } from "./no-evidence";
import { runDeepResearchV2, v2On } from "./pipeline";
import { baseManifest, DEFAULT_AGENT_LABEL, outsideLedgerIds, retrievalItem, rollUp } from "./shared";
import {
  A4_CHALLENGE_SYSTEM,
  A4_DIGEST_SYSTEM,
  A4_DIVERGENCE_SYSTEM,
  A4_PROPS_SYSTEM,
  a4ClosingSystem,
  a4OutlineSystem,
  a4ReportBlocksSystem,
  a4ReportSystem,
  a4SectionSystem,
  buildA4BlockRepair,
  buildA4ChallengeUser,
  buildA4ClosingUser,
  buildA4DigestUser,
  buildA4DivergenceUser,
  buildA4GateRepair,
  buildA4OutlineUser,
  buildA4PropsUser,
  buildA4Repair,
  buildA4ReportBlocksUser,
  buildA4ReportUser,
  buildA4SectionUser,
  buildEvidencePack,
  buildUnresolved,
  type A4Input,
} from "./prompt";
import { compile, type Proposition, type Verdict } from "./props";
import { validateReport, validateResearch } from "./validate";

const MAX_REPAIR = 2;

/**
 * 那两次交 JSON 的调用（编译命题、反证复核）给多少输出额度。
 *
 * **8000 不是随手放宽的**。它们都可能落在推理模型的槽位上，而推理模型的**思考 token 和
 * 正文算在同一个额度里**，思考那部分事前不可估。
 *
 * 2026-08-25 实测（编译命题这一步，真 key 真模型，题目是一号位当天在跑的那件）：正文
 * 1881 个字符，可是这一次的 `reasoningTokens` 是 2269，`outputTokens` 合计 3150 ——
 * 原来写的 2500 在这里被截断，`callModelJson` 就地抛出「模型输出被 max_tokens(2500)
 * 截断」。按正文长度算这个数是算不对的：那次正文只占了额度的四分之一。
 *
 * A5 在 2026-08-19 撞的是同一件事（4000 → 8000，见须知第 15 条）。这类失败不会自愈：
 * `failed` 是故意不自动重开的，重试也只是让它再想一遍。
 *
 * 编译命题这一步截断的后果现在**只落在自己那一条链路上**（那一条整条挂掉，别的几条照跑），
 * 而不再是整轮深研失败。这不等于可以把额度调回去 —— 挂掉一条链路仍然意味着屏幕上少一份
 * 报告，而少的那一份很可能正是主源。
 */
const JSON_MAX_TOKENS = 8000;

/**
 * 分节出稿里**一节**（以及收口那一次）的输出额度。
 *
 * 单次出稿那一支写的是整份，额度是 12000；分节之后每一次只写一节，所以按节给而不是按份给
 * —— 一节 16000 不是「放宽」，是把整份的上限从「一次 completion 写得下多少」换成「证据有
 * 多少条」（补遗 §0）。五节的一份因此可以是单次出稿的四五倍长，而每一次调用都还离自己的
 * 上限很远。
 *
 * 真发到的数会被模型自己的输出上限压一次（`complete.ts` 里那道 clamp）：这个数是需求，
 * 不是承诺。压到之后仍然不够的那一次由 `jsonlContinue` 接着写。
 */
const SECTION_MAX_TOKENS = 16000;

/**
 * 四节压缩（`a4.digest`，含重修那几轮）的输出额度。
 *
 * 原来写死 6000，是整个文件里最小的一档 —— 而这一次要一口气写出判断、关键证据、反面、
 * 未知四节的 JSON，跑在一个会先想一大段的模型上。2026-08-26 ISS-111 就死在这里：四条
 * 链路的报告全跑出来了（18 分钟、真钱），最后一步 `模型输出被 max_tokens(6000) 截断`，
 * 整轮作废，四份报告一起丢。
 *
 * 按正文长度算这个数算不对（同 `JSON_MAX_TOKENS` 那段）：`reasoningTokens` 和正文抢的是
 * 同一份额度。给 12000 不多花钱 —— 这是上限不是用量，超出的部分从来不计费；而少给的代价是
 * 整轮重跑。
 */
const DIGEST_MAX_TOKENS = 12000;

/**
 * 排结构（`a4.report.outline`）那一次的输出额度。
 *
 * 这一次原来和编译命题共用 8000，而它是全文件里**最经不起 8000 的一次**：跑在 `high` 档上
 * （证据的去处在这里定），要一口气交出全份的节标题、论点稿、每一节分到哪几条证据 ——
 * 交出来的 JSON 本身就长，而思考那段和它抢同一份额度。
 *
 * 2026-08-26 ISS-110 那一轮（`RUN-A4-mt9l9xli-1`，真 key 真模型）：ChatGPT、Claude 两条都是
 * 「模型输出被 max_tokens(8000) 截断」，DeepSeek 是「模型返回里没有正文」（额度全花在推理
 * 上了），豆包那条 180 秒超时 —— 四条链路的大纲**全军覆没**。上一轮 ISS-109 也只有 DeepSeek
 * 那一条排出了结构（正文 4351、推理 3393，离 8000 只剩一点）。
 *
 * 后果不是报错而是**静悄悄地变短**：`readOutline` 会自己降级成一节，于是那一份报告只剩一节，
 * 二十条证据挤在同一次 completion 里 —— 分节出稿（补遗 §1）等于没有发生。屏幕上看不出哪里
 * 坏了，只看得出「这家模型写得短」。
 *
 * 给到和写一节同一档（`SECTION_MAX_TOKENS`）：这是上限不是用量，超出的部分从来不计费；而少
 * 给的代价是整轮深研（十几分钟、真钱）跑出四份一节的报告。
 */
const OUTLINE_MAX_TOKENS = SECTION_MAX_TOKENS;

/**
 * 一条链路：屏幕上那一栏。**这张表就是那几条链路唯一的出处** —— 页签的顺序、页签上的字、
 * 哪一条是主源，都在这里定，视图层和事件文案不许自己编一套。
 */
type Lane = {
  slot: Slot;
  /**
   * 页签上的字，也是 trace 和事件明细里指认这条链路的字。
   *
   * 写模型家的名字而不是「V4 报告原文」这类拼法：几份摆在一排页签上时，一号位要先分清的
   * 是「这一份是谁跑的」。也不写别名（`deepseek-v4-pro`）—— 那是台账上的东西。
   */
  label: string;
  /**
   * 假模型的罐头键。每条要给**不同的**罐头 —— 同一个键的话离线跑出来的几份原件一字不差，
   * 而「屏幕上这几栏是几份不同的东西」这件事就一次都没被验过。
   */
  hint: string;
};

/**
 * 深研的几条链路，**这个顺序就是页签行上从左到右的顺序**（`tabOrder` 取的是这里的下标）。
 *
 * 主源排在第三栏，所以顺序推不出来、得存 —— 见 `ResearchDoc.sourceTabOrder`。
 *
 * **新链路只许接在最后**：已经落库的那些报告里存着 `agent:alt<tabOrder>` 这种页签 key 和
 * `sourceTabOrder`，在中间插一条会把它们全部错位 —— 表现是他昨天读的那一栏今天变成了另一
 * 条链路写的东西，而没有任何一处会报错。
 *
 * 2026-08-26 接了第四条（豆包）。同一天还接过第五条（OpenRouter 上的 Ox Alpha），当天又
 * 整条撤掉了 —— 撤的是最后一栏，所以已经落库的那几栏没有错位。要跟着长的还有
 * `blocks/divergence.ts` 那排代号（那边留着五个，多出来的是空着的余量）。
 *
 * 2026-08-27 又撤掉豆包那一条，**同样是最后一栏**，所以那几栏仍然没有错位。已经落库的那些
 * 报告里还留着 `豆包` 那一栏的正文，读得出来 —— 页签是跟着每一份报告存的，不是从这张表现
 * 算的。这也是「只许接在最后」这条规矩在撤的时候的回报。
 */
const LANES: Lane[] = [
  { slot: "pro", label: "DeepSeek", hint: "a4.report" },
  { slot: "alt", label: "Claude", hint: "a4.report.claude" },
  { slot: "synth", label: "ChatGPT", hint: "a4.report.gpt" },
];

/** 判断板、四节、`violations` 只看这一条。见文件头。 */
const PRIMARY_SLOT: Slot = "synth";

/**
 * 这一轮真能跑的那几条。
 *
 * 先问一句能不能解析出模型：那把 key 没配时第一次调用会当场抛，而抛在链路里只是让那一栏
 * 带着「401」摆在屏幕上 —— 一台从来没配过 Bedrock 的机器每一轮都多一栏红字，那不是信息。
 * 没配 = 没有这一栏。
 *
 * `pro` 不问：它是最后的兜底（还有 DeepSeek 直连那条回落），它也解析不出来的话这台机器
 * 一个模型都没有，那时候全挂本来就是对的结论。
 *
 * mock 那一档一律放行：罐头在解析槽位之前就返回了，所以离线机器上 `resolveModel("alt")`
 * 一律是 null，照这个判断就永远只剩一条链路，而那一排页签这件事就一次都没被验过。
 */
function team(): Lane[] {
  return LANES.filter((l) => l.slot === "pro" || modelMockOn() || resolveModel(l.slot) !== null);
}

/**
 * 屏幕上那几步的原话。**这里就是它们唯一的出处** —— 视图层不许自己编一套。
 *
 * 用词照抄这个文件头那两句：步骤名和代码里的分段必须是同一套词，否则改了代码分段却
 * 没改屏幕上的话，一号位读到的是一份过期的流程图，而没有任何一处会报错。
 */
const STEPS = {
  context: "装配上下文",
  divergence: "对齐各条链路的分歧",
  digest: "压成四节",
  challenge: "反证复核",
} as const;

/** 链路里那四步。每条链路各自报自己的（`DraftReport.step`）。 */
const LANE_STEPS = {
  props: "编译命题",
  evidence: "取证",
  report: "写正式报告",
  gate: "出口对账",
} as const;

/**
 * 外面那个分母。四步：装配上下文 → 各条链路各自研究 → 压成四节 → 反证复核。
 *
 * **它不随链路数变**：几条链路是同时跑的一步，不是几步。这一步里屏幕上那行小字写着此刻
 * 每条各自走到哪（见 `laneLine`），每条链路自己那块表在自己那一栏上。
 *
 * 也不随「联不联网」变了：不联网时省掉的是**链路里**的前两步，外面这四步照走。
 */
const STEP_TOTAL = 4;

/**
 * 区块那一支多一步：各条出稿之后对齐它们的分歧（`a4.divergence`，任务书 §4.3）。
 *
 * 分母跟着开关走，**不跟着「这一轮到底折不折得出分歧」走**：那件事要等每条都跑完才知道
 * （只有一条出稿的那一轮没有分歧可对），而 total 一旦报出去就不该再变。所以开关开着时
 * 这一步一定占一格 —— 折不出来的那一轮它照样报一次，小字里写明为什么跳过。
 */
const STEP_TOTAL_BLOCKS = 5;
const LANE_TOTAL_WITH_SEARCH = 4;
const LANE_TOTAL_NO_SEARCH = 2;

/**
 * 一条这一轮的账。每条各一条，进 `A4Evidencing.lanes`。
 *
 * **「一条」有两种意思，看 `A4Evidencing.lanesAreDimensions`：**
 *
 * - 没那一栏（四链路那一支）：一条 = 一个模型独立跑的一整套研究，自己写报告、自己过出口对账。
 *   下面 `attempts`/`blocked`/`primary` 说的都是这一条自己的事。
 * - 那一栏是 true（默认那条七步链）：一条 = 一批维度的取证方向。`propositions`/`rounds`/
 *   `recorded`/`rejected`/`unresolved` 照旧是这一条自己的；但**报告只有一份，出口对账只跑一遍**
 *   —— `attempts` 在几条上是同一个数，`blocked` 只挂在第一栏上，`primary` 只剩「排第一栏」的
 *   意思，别把它读成「判断板从这一条压出来的」。
 *
 * 一条也不许省：某一条挂了那次，产出里少一栏页签，而**别处任何一个数都不变** ——
 * 不写出来，「Claude 那一条今天没跑成」就只表现成屏幕上少一栏，没人分得出是没配 key 还是挂了。
 */
export type LaneAccount = {
  /** 页签上的字，和产出里那份一模一样 —— 事件明细里说的是屏幕上看得见的那一栏。 */
  label: string;
  modelAlias: string;
  /** 判断板和四节是不是从这一条压出来的。写成了的链路里恰好一条是 true。 */
  primary: boolean;
  /** 这一条自己编了几条待查命题。 */
  propositions: number;
  /** 这一条自己跑了几轮取证。 */
  rounds: number;
  /** 这一条自己入账几条证据。**这是唯一能说「这条链路真的取到证据了」的数。** */
  recorded: number;
  /** 被三道入账闸拒掉的条数。0 入账 + 大量拒绝 ≠ 0 入账 + 0 拒绝。 */
  rejected: number;
  /** 这一条自己没闭合的命题号。 */
  unresolved: string[];
  /** 报告写了几遍（出口对账打回算第二遍）。没跑成时是 0。 */
  attempts: number;
  /** 重写之后仍然没过出口对账的条数。0 = 这份过了。 */
  blocked: number;
  /** 这一条自己跑了多久。挂了的那条也有 —— 那是它撑到挂掉用的时间。 */
  durationMs?: number;
  /** 这一条为什么没跑成。有它就是这一条挂了。原话来自那次失败。 */
  error?: string;
};

/**
 * 这一轮取证的账。原样进 `A4Result`，调用方拿它写事件明细。
 *
 * **除了 `hitsByProvider` 和 `lanes`，其余每个数说的都是主源那一条链路。** 各条链路各跑
 * 一套取证，「这一轮入账了几条证据」已经不是一个数了 —— 而屏幕上那块判断板只从主源压出来，
 * 所以「这一轮」问的是它。别的几条各自的数在 `lanes` 里，一条一条摆着。
 */
export type A4Evidencing = {
  /** 实际用的检索家代号，多家接成 `bocha+doubao`。统计用，不上屏。 */
  provider: string;
  /**
   * 同一批家的中文说法（「博查」「博查 + 豆包搜索」「未启用」）。**上屏的一律用这个。**
   *
   * 两个字段不是重复：调用方要在事件明细里写一句人话，而它自己去维护一张
   * `doubao → 豆包搜索` 的对照表就意味着改了检索家却没人改那张表，屏幕上会一直
   * 写着一个已经不存在的名字。这里由检索家自己报出来。
   */
  providerLabel: string;
  /**
   * 每家各出了几条，**各条链路全部轮次累计**（键是代号，中文说法在 `label` 里跟着走）。
   *
   * 这一个字段不按主源算，因为它问的是这台机器的检索配置值不值 —— 那是账号维度的事，
   * 跟哪条链路无关。一家都没搜时是空对象。`unique` 低的那一家，换掉它比再加一家有用。
   */
  hitsByProvider: Record<string, SearchAccount>;
  /** 主源那一条编了几条命题。0 = 这一轮没联网。 */
  propositions: number;
  /** 主源那一条的每轮取证账。 */
  rounds: Round[];
  /** 主源那一条入账几条。 */
  recorded: number;
  /** 主源那一条被拒几条。 */
  rejected: number;
  /** 主源那一条没闭合的命题号。报告的「未能核实」一节写的就是它们。 */
  unresolved: string[];
  /** 主源那一份报告里复算不通过的那几条。空数组 = 三条规则都没话说。 */
  calculations: Calculation[];
  /** 四节里绑上溯源的引用数。 */
  citationsBound: number;
  /** 主源那份报告写了几遍（出口对账打回算第二遍）。 */
  reportAttempts: number;
  /**
   * 各条链路各自的账，**按页签顺序**。挂掉的那条也在里面。
   *
   * **这一栏有两种读法，靠下面 `lanesAreDimensions` 分**：
   *
   * - 没有那一栏（四链路那一支）：一条 = 一个模型各跑一整套研究，各自编命题、各自取证、
   *   **各自写一份报告、各自过一遍出口对账**，报告区一栏一份。
   * - 那一栏是 true（默认那条七步链）：一条 = 一批维度的取证方向。编命题和联网取证按方向分，
   *   但**报告只有一份**，出口对账也只跑一遍 —— 所以 `attempts`/`blocked` 那两栏在几条上是
   *   同一个数的副本，不是几次独立确认。
   *
   * 两种读法混着读的代价是屏幕上那句话：把维度方向读成「四份报告」，运营台会以为这一轮做了
   * 四次交叉验证。
   */
  lanes: LaneAccount[];
  /**
   * `lanes` 装的是取证方向（一条 = 一批维度），报告只有一份。默认那条七步链置 true；
   * 四链路那一支不置（那边一条链真的各写一份）。
   *
   * 加这一栏是因为屏幕上那句话不是数字而是话：调用方要判「这一轮到底跑了几份报告」，而
   * `lanes.length` 在两种编排下都是 4。缺这一栏时按老读法读 —— 老运行落库的记录里没有它。
   */
  lanesAreDimensions?: boolean;
};

export type A4Result = {
  doc: ResearchDoc;
  violations: Violation[];
  attempts: number;
  degraded: boolean;
  /** 反证复核那一遍出了几条反证。0 且 `challenged` 为 true 表示它找过但没找到。 */
  challengeCount: number;
  challenged: boolean;
  /** 取证那几段的账。 */
  evidencing: A4Evidencing;
  /** 这次运行的可复现记录。由调用方落库（`agentRunPut`）。 */
  run: AgentRunRecord;
};

type Raw = {
  judgment?: unknown;
  keyEvidence?: unknown;
  counters?: unknown;
  unknowns?: unknown;
  routeSuggestion?: unknown;
};

type Gate = ReturnType<typeof gateReport>;

/** 一条链路跑到此刻的样子。屏幕上那一栏、trace 上那几条 note，读的都是它。 */
type LaneRun = {
  lane: Lane;
  /** 注册表别名（`claude-opus-5`）。台账上认这个，屏幕上不显示。 */
  modelAlias: string;
  /** 页签行上排第几 —— `LANES` 的下标。页签的 key 也是按它拼的。 */
  tabOrder: number;
  /**
   * 页签的 key。**必须和这一轮落库之后那个一模一样**（见 `DraftReport.key`）：主源 `agent`，
   * 其余 `agent:alt<tabOrder>`。
   *
   * 按 `tabOrder` 拼而不是按「写成了的第几份」：中间那条挂掉时，后面那条的位置不该跟着挪
   * —— 他正读着的那一栏会在报告落库那一瞬换 key，屏幕把他弹回主源。
   */
  key: string;
  /** 这一条是不是主源。主源挂掉、顺位落到别人身上时这里会改一次。 */
  primary: boolean;
  /** 这一条什么时候起跑的（各条几乎同时，但各记各的）。 */
  startedAt: string;
  t0: number;
  /** 走到第几步。0 = 还没起跑，那时屏幕上那一栏点不动。 */
  no: number;
  total: number;
  /** 这一步的原话（`LANE_STEPS` 里那几个）。外面那行汇总小字读它。 */
  base: string;
  /** 屏幕上那一栏此刻显示的话 —— `base`，或者 `base · 第 2 轮抓正文（5 页）`。 */
  shown: string;
  /** 上一次上报的时刻。屏幕上那块表从这里往后自己走。 */
  at: string;
  props: Proposition[];
  ledger: Ledger;
  rounds: Round[];
  verdicts: Verdict[];
  /** 写了几遍。还没写成时是 0。 */
  attempts: number;
  text?: string;
  /**
   * 区块那一支写出来的那一份。**只有 `TKOS_DR_BLOCKS=1` 时才有** —— 旧路那一支这里是
   * undefined，屏幕上照旧读 `text`。
   */
  blocks?: ReportBlocks;
  /**
   * 区块出口校验的账（`blocks/lint.ts`）。旧路那一支永远是 undefined：那一支的结构违规
   * 由 `validateReport` 记，两套规则各自成立，混在一栏里会分不出是哪套报的。
   */
  lint?: Violation[];
  gate?: Gate;
  durationMs?: number;
  error?: string;
  /** 这一条自己那份装配清单（自己抓回来的那些页）。收尾时才封 —— 见 `ReportSource`。 */
  assembled: ManifestItem[];
};

export async function runDeepResearch(
  input: A4Input,
  /** `progress` —— 往任务表报进度。见 `HarnessInit.progress`，不给就不报。 */
  opts?: { agentLabel?: string; progress?: { kind: string; id: string } }
): Promise<A4Result> {
  /*
   * 深研 v2（知识先行 + 覆盖门控）。**默认走它** —— 下面这一整套四链路留在 `TKOS_DR_V2=0`
   * 后面，是为了拿同一个议题两边各跑一遍做对比，不是为了保留一条随时会被选中的旧路。
   *
   * 开关在**入口读一次**：这一轮从头到尾只走一支。别处一行都不用改，两支同签名同返回。
   */
  if (v2On()) return runDeepResearchV2(input, opts);

  /*
   * 检索家在最前面选出来，因为链路里那个分母要它。可以是几家
   * （`TKOS_SEARCH_PROVIDER=bocha,doubao`），各条链路共用同一批家 —— 那是这台机器的配置。
   *
   * 选不出来**不抛异常**：`providers()` 返回一支带 `reason` 的空检索器，原话由
   * `describe()` 带进 trace。真发生过的坑是 `.env` 里填了个没实现的家名，一声不响
   * 退回空检索，照样出一份格式漂亮的报告 —— 那份报告读起来和联网跑出来的一样。
   *
   * `skipped` 是配了却用不上的那几家（家名不认、少配一把 key）。它**不影响这一轮跑不跑**，
   * 但一定要进 trace：三家里只有一家在跑，产出的报告和只配了一家长得一模一样。
   */
  const { list: search, skipped } = providers();
  const retrieving = search.some((p) => p.name !== "none");
  const laneTotal = retrieving ? LANE_TOTAL_WITH_SEARCH : LANE_TOTAL_NO_SEARCH;

  /*
   * 区块化那一支（任务书 §0①：模型直接产出区块 JSONL）。**开关在起跑之前读一次，
   * 这一轮从头到尾用这一个值** —— 各条链路共用它，外面那个分母也从它算出来。
   *
   * 各条各读一次的坏处不是多读一次环境变量：一条走区块一条走旧路的那一轮，对账那一步
   * 会去比较两种形态的结论，而它只读得懂块。
   */
  const useBlocks = blocksOn();

  const roster = team();
  /*
   * 屏幕上那一步叫什么。**条数是数出来的，不写死**：只配了一把 key 的机器上写「5 条链路
   * 各自研究」是假的 —— 而假的分母比少一栏更难查：他会去找另外那几栏跑哪儿去了。
   */
  const laneStepLabel =
    roster.length > 1
      ? `${roster.length} 条链路各自研究`
      : `${roster[0].label} 那一条链路研究`;

  // ---- 第 1 步：装配 ------------------------------------------------------
  /*
   * S03 配方：core question 一路 `k=10 / budget=6000`，Issue 标题一路
   * `k=5 / budget=3000`。深研的材料本来就该比预研厚一档 —— 它要在四节里做取舍，
   * 材料薄了取舍就无从谈起。这两组参数由配方固定，**不随思考深度变**。
   *
   * 装配只做一次，各条链路共用：公司上下文、内部文档、在版判断、预研结论、认知段对每条
   * 一字不差 —— 几条之间唯一该有的差别是它们自己取回来的东西。
   *
   * 锚点走判断号这条路，同 A3 预研：图谱里没有前端这些议题对象，按 `input.title` 检索
   * `ISS-*` 一次都命中不了，深研整条只能靠语义检索碰运气（实测 ISS-225 那一轮候选池
   * 拉不开，闸落下转纯外部）；而这些判断号在图里是真实存在的。为空照旧走检索。
   */
  const h = new Harness({
    agent: "A4",
    slot: "pro",
    ...(opts?.progress
      ? { progress: { ...opts.progress, total: useBlocks ? STEP_TOTAL_BLOCKS : STEP_TOTAL } }
      : {}),
  });
  h.note("检索配置", describe(search, skipped), "local");
  h.step(STEPS.context);
  await h.openContext("S03", input.title, { judgmentCodes: input.judgments.map((j) => j.id) });
  // 直接取 getter：它自己判了 externalOnly，两支都回落到 NO_COMPANY_CONTEXT。外面再
  // 判一次的坏处不是多一行，是它暗示 getter 不可信 —— 于是这个三元会被抄到第四、第五处。
  const companyContext = h.contextBlock;

  /**
   * 各条链路共用的那一段装配清单。每条链路的自己那份是它加上自己取回来的页。
   *
   * 这一段和七步链那一支逐字相同，所以住在 `shared.ts`（那两句「没有公司上下文」的屏幕
   * 文字抄成两份的代价写在那个文件头部）。
   */
  const base = baseManifest(h, input);

  /*
   * 第 ③ 段认知指令。A4 的 user 段是手写的一整份，不走 `assemble()`，但取值要和
   * A1a / A3 同一条路径 —— 所以直接用 `cognitiveFor`，运行时给了就用运行时的。
   * `cognitiveSource` 跟着每次模型调用记进 trace：事后要能查出「这一轮到底带没带
   * S03 的标准」，否则一份没带标准跑出来的深研和带了的在结果页上长得一模一样。
   */
  const cog = await cognitiveFor("a4.research", h.cognitive["a4.research"]);
  /*
   * 认知段只进写报告那几次调用。
   *
   * 压缩那一层的输入是**已经写成的报告**，再把 S03 整份标准塞一遍，等于给它一次
   * 重新研究的机会 —— 而两面结论对不上就是从这儿来的。所以 `cognitiveSource` 也只
   * 记在报告那几条 trace 上：写到压缩那一条上，台账会显示它带了标准，而它没带。
   */
  const digestDetail = { promptKey: "a4.digest" };

  // ---- 第 2 步：各条链路各自研究 -------------------------------------------
  const now = () => new Date().toISOString();
  const states: LaneRun[] = roster.map((lane) => {
    const spec = MODELS[SLOT_ALIAS[lane.slot]];
    const tabOrder = LANES.findIndex((l) => l.slot === lane.slot);
    const primary = lane.slot === PRIMARY_SLOT;
    return {
      lane,
      modelAlias: spec.alias,
      tabOrder,
      key: primary ? "agent" : `agent:alt${tabOrder}`,
      primary,
      startedAt: now(),
      t0: Date.now(),
      no: 0,
      total: laneTotal,
      base: "",
      shown: "",
      at: now(),
      props: [],
      ledger: new Ledger(),
      rounds: [],
      verdicts: [],
      attempts: 0,
      assembled: [],
    };
  });
  /*
   * 主源没配出来的机器上（没有 Bedrock key），顺位落到第一条 —— 页签的 key 跟着定，
   * 而这一切都在起跑之前，所以那台机器上 key 从头到尾也是稳的。
   */
  if (!states.some((s) => s.primary)) {
    states[0].primary = true;
    states[0].key = "agent";
    h.note(
      "主源顺位",
      { 原定: MODELS[SLOT_ALIAS[PRIMARY_SLOT]].short, 实际: states[0].lane.label, 原因: "那把 key 没配，这一轮没有这条链路" },
      "local"
    );
  }

  const draftOf = (st: LaneRun): DraftReport => ({
    key: st.key,
    label: st.lane.label,
    modelAlias: st.modelAlias,
    byAgentLabel: opts?.agentLabel ?? DEFAULT_AGENT_LABEL,
    kind: "writer",
    ...(st.text
      ? {
          text: st.text,
          ...(st.durationMs === undefined ? {} : { durationMs: st.durationMs }),
          // 区块原件跟着这一栏一起上屏：落库之前那几十秒里，他读的是这一份。
          ...(st.blocks ? { blocks: st.blocks } : {}),
        }
      : {
          startedAt: st.startedAt,
          ...(st.error ? { error: st.error, note: "这一条没跑成" } : {}),
          // `no === 0` 那一档不报 step：它是「压根还没起跑」，而屏幕上那一栏在这一档
          // 是点不动的（见 `IssueReport.pending`）。报一个「第 0 步」进去，页面会去
          // 显示一块从起跑时刻往后走的表，而这一条还没起跑。
          ...(st.no ? { step: { label: st.shown, no: st.no, total: st.total, at: st.at } } : {}),
          ...(st.no || st.error ? {} : { note: "还在排队起跑" }),
        }),
  });
  /**
   * 把此刻各条各自的样子摆到屏幕上（`store.listReports` 在还没落库时读它）。
   *
   * 两条纪律：
   *
   * · **页签的 key 必须和落库之后那个一模一样**。对不上的后果不是多一栏，是他正读着的那一栏
   *   在报告落库那一瞬消失，屏幕把他弹回主源。
   * · 正文在**出口对账之后**才上报。递一份没过对账的稿子上去，他读到的引用可能绑不上任何
   *   来源，而几十秒后那份稿子会被重写稿悄悄换掉 —— 屏幕上同一栏里的话变了，而没有任何一处
   *   说过它会变。
   */
  const report = (): void => h.reports(states.map(draftOf));
  /** 外面那行汇总小字：此刻各条各自在干什么。 */
  const laneLine = (): string =>
    states
      .map((s) => `${s.lane.label} ${s.text ? "已出稿" : s.error ? "没跑成" : s.base || "起跑"}`)
      .join("、");
  /** 这条链路进了下一步。序号只在这里加。 */
  const advance = (st: LaneRun, step: string): void => {
    st.no += 1;
    st.base = step;
    st.shown = step;
    st.at = now();
    report();
    h.substep(laneLine());
  };
  /** 同一步里的细节（取证那六段、重写那一轮）。序号不动，外面那行汇总也不动。 */
  const detail = (st: LaneRun, suffix: string): void => {
    st.shown = `${st.base} · ${suffix}`;
    st.at = now();
    report();
  };

  h.step(laneStepLabel);
  h.note(
    "链路阵容",
    {
      条数: roster.length,
      各自: states.map((s) => `${s.lane.label} · ${s.modelAlias}${s.primary ? "（主源）" : ""}`),
      每条几步: `${laneTotal}（${retrieving ? "联网" : "不联网，省掉编命题和取证"}）`,
    },
    "local"
  );
  // 几栏先摆上去，不等任何一条跑出东西来：页签在他眼前一枚一枚地凭空多出来是最难读的一种
  // 变化，而「这一轮会有几份」这件事此刻已经是确定的。
  report();

  /** 跑完一条链路。它自己那四步，自己的台账，自己的表。 */
  const runLane = async (st: LaneRun): Promise<void> => {
    const laneLabel = st.lane.label;

    if (retrieving) {
      /*
       * 先定研究什么，再检索。顺序反了的话，问题框架就被第一页搜索结果锚住 —— 那一页
       * 碰巧讲什么，这次研究就变成讲什么。理由展开在 `props.ts` 头部。
       *
       * 各条链路各编一份命题：同一份指令、同一份材料，不同的模型会挑出不同的实质命题，
       * 而那就是各条链路会取回不同材料的起点。共用一份命题的话，几条会去搜同一批检索式，
       * 那时「几次独立研究」只剩写作那一层是独立的。
       */
      advance(st, LANE_STEPS.props);
      const rawProps = (
        await h.callMessages(
          `模型调用 · a4.props（${laneLabel}）`,
          [
            { role: "system", content: A4_PROPS_SYSTEM },
            { role: "user", content: buildA4PropsUser({ ...input, companyContext }, h.budget.maxProps) },
          ],
          { slot: st.lane.slot, maxTokens: JSON_MAX_TOKENS },
          { promptKey: "a4.props", lane: laneLabel },
          "a4.props"
        )
      ).text;
      st.props = compile(parseJson<{ propositions?: unknown }>(rawProps), h.budget.maxProps);
      h.note(
        `${laneLabel} · 命题编译`,
        {
          条数: st.props.length,
          命题: st.props.map((p) => `${p.id}${p.material ? "（实质）" : ""} ${p.statement}`),
          检索式: st.props.reduce((n, p) => n + p.queries.length + p.counterQueries.length, 0),
        },
        "local"
      );

      advance(st, LANE_STEPS.evidence);
      const ev = await gatherEvidence(h, search, st.props, h.budget, {
        slot: st.lane.slot,
        label: laneLabel,
        substep: (suffix) => detail(st, suffix),
      });
      st.ledger = ev.ledger;
      st.rounds = ev.rounds;
      st.verdicts = ev.verdicts;
      h.note(
        `${laneLabel} · 取证汇总`,
        {
          轮数: st.rounds.length,
          入账: st.ledger.entries.length,
          被拒: st.rounds.reduce((n, r) => n + r.rejected, 0),
          未闭合: st.verdicts.filter((v) => !v.ok).length,
        },
        "local"
      );
    }

    /*
     * 写作那一层分支看的是**这条链路的入账条数**，不是「配没配 key」。
     *
     * 配了 key 但一页都没抓到（全站超时、全是 PDF、全被拒）的链路，和没配 key 的链路在
     * 写作要求上是同一件事：手上没有可引的外部证据。按 key 分支的话，前一种会拿到一份
     * 要求「每个数字绑编号」的指令而台账是空的 —— 那时模型只有两条路，编一个编号或者
     * 不写数字，而它通常选前一条。
     */
    const hasEvidence = st.ledger.entries.length > 0;
    // 区块那一支走哪条路在起跑之前就定了（`useBlocks`），几条共用同一个值。
    const material = {
      ...input,
      companyContext,
      cognitive: cog.text,
      evidencePack: buildEvidencePack(st.ledger.entries),
      unresolved: buildUnresolved(st.props, st.verdicts),
    };
    const reportSystem = useBlocks ? a4ReportBlocksSystem(hasEvidence) : a4ReportSystem(hasEvidence);
    const reportUser = useBlocks ? buildA4ReportBlocksUser(material) : buildA4ReportUser(material);
    /**
     * 写一份原件。`extra` 是重写那一轮往后接的两句（上一稿 + 对账结果）。
     *
     * `json:false` —— 这一次要的是报告正文，不是 JSON。套上 `response_format: json_object`
     * 的话，模型只能把整篇报告塞进一个 JSON 字符串字段里；两千多字的中文正文在字符串里
     * 转义一次，裸引号和换行随便一处出错整份就 parse 不出来，而报错说的是「模型没有返回
     * JSON」。报告这一层没有下游按字段取值的需求（它整篇就是 `sourceText`）。
     *
     * 12000 是给这一次留的额度。它对纯文本那一份够用（一份三四千字的中文报告，一字约一
     * token 出头）；区块那一份的正稿走的不是这里，是 `writeStaged` —— 那边一节一节报额度
     * （`SECTION_MAX_TOKENS`），因为一份写足了二十条证据的报告不可能塞进任何一次 completion。
     * 这里剩下的用处是重写那一轮（`extra` 不为空的那一支）。
     *
     * `promptKey` 每条一样（同一份指令），认人靠 `lane` 和 `writer` —— 只靠 `slot` 分辨的话，
     * 回落到 DeepSeek 直连那种情形下会分不出来。
     */
    const write = async (extra: Msg[] = [], repairOf?: string): Promise<string> =>
      (
        await h.callMessages(
          `模型调用 · a4.report（${laneLabel}）${repairOf ? " 出口对账重写" : ""}`,
          [
            { role: "system", content: reportSystem },
            { role: "user", content: reportUser },
            ...extra,
          ],
          { slot: st.lane.slot, maxTokens: 12000, json: false },
          {
            promptKey: "a4.report",
            cognitiveSource: cog.source,
            lane: laneLabel,
            writer: st.modelAlias,
            ...(repairOf ? { repairOf } : {}),
          },
          st.lane.hint
        )
      ).text.trim();

    /**
     * 分节出稿（补遗 §1）：**大纲一次 → 每节各一次 → 收口一次**，只有区块那一支走这条。
     *
     * 为什么不是一次调用写完：一次 completion 有一个软收敛点，而那个点和递进去的证据有
     * 多少条无关 —— 二十条证据递进去，它照样在同一个长度上收，于是十几条证据只在正文里
     * 露了个编号。分节之后每一节是一次独立的 completion，它自己那几条证据在它眼里就是
     * 全部（理由写在 `prompt.ts` 的分节那一段）。
     *
     * 这一条链路里的三段是**顺序**的（要点清单要往后滚），几条链路之间照旧并发。
     *
     * 三段里任何一段挂掉都不整条放弃：大纲挂了折成一节（`readOutline` 自己降级），某一节
     * 挂了少那一节，收口挂了少横幅和最终判断 —— 每一种都记进 trace，然后交给出口校验去判
     * 这一份还能不能上屏。整条抛掉的代价是屏幕上少一栏，而少的那一栏很可能正是主源。
     */
    const writeStaged = async (): Promise<string> => {
      const packIds = st.ledger.entries.map((e) => e.id);
      const notes: string[] = [];
      const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

      // ---- 大纲 ----
      detail(st, "排结构");
      let raw: unknown = null;
      try {
        raw = parseJson<unknown>(
          (
            await h.callMessages(
              `模型调用 · a4.report.outline（${laneLabel}）`,
              [
                { role: "system", content: a4OutlineSystem(hasEvidence) },
                { role: "user", content: buildA4OutlineUser(material) },
              ],
              // 高档：这一次决定的是每条证据的去处，而那个取舍错了之后每一节都跟着错。
              // 额度按 `OUTLINE_MAX_TOKENS`：`high` 档的思考和这份 JSON 抢同一份额度。
              { slot: st.lane.slot, maxTokens: OUTLINE_MAX_TOKENS, effort: "high" },
              { promptKey: "a4.report.outline", lane: laneLabel, writer: st.modelAlias },
              `${st.lane.hint}.outline`
            )
          ).text
        );
      } catch (e) {
        notes.push(`排结构那一次没成，折成一节往下走：${why(e)}`);
      }
      const outlineRead = readOutline(raw, packIds);
      const outline = outlineRead.outline;
      notes.push(...outlineRead.notes);

      // ---- 逐节 ----
      const sections: { id: string; text: string }[] = [];
      const parsed: { id: string; title: string; blocks: Block[] }[] = [];
      const declared: { id: string; reason: string }[] = [...outline.unassigned];
      const judgmentLines: string[] = [];
      let written = "";
      for (const [i, s] of outline.sections.entries()) {
        detail(st, `写第 ${i + 1}/${outline.sections.length} 节 · ${s.title}`);
        const ids = new Set(s.evidenceIds);
        let body = "";
        try {
          body = (
            await h.callMessages(
              `模型调用 · a4.report.section（${laneLabel} · ${s.id}）`,
              [
                { role: "system", content: a4SectionSystem({ hasEvidence }) },
                {
                  role: "user",
                  content: buildA4SectionUser({
                    ...material,
                    // **这一栏是这一次调用的边界**：递进去的只有分给这一节的那几条证据。
                    // 递全包的话它会顺手引别节的编号，而那几条在另一节里正被展开。
                    evidencePack: buildEvidencePack(st.ledger.entries.filter((e) => ids.has(e.id))),
                    section: s,
                    thesisDraft: outline.thesisDraft,
                    written,
                  }),
                },
              ],
              {
                slot: st.lane.slot,
                maxTokens: SECTION_MAX_TOKENS,
                json: false,
                // 中档：这一次手上只有自己那几条证据，取舍已经在大纲那一次做完了。
                effort: "medium",
                // 出稿这一次要它把手上那几条证据说透。只有认这个字段的模型收得到。
                verbosity: "high",
                jsonlContinue: 1,
              },
              { promptKey: "a4.report.section", lane: laneLabel, writer: st.modelAlias, section: s.id },
              `${st.lane.hint}.section`
            )
          ).text.trim();
        } catch (e) {
          notes.push(`${s.id}「${s.title}」那一节没写成：${why(e)}`);
          continue;
        }
        if (!body) {
          notes.push(`${s.id}「${s.title}」那一节回来是空的（额度可能全花在推理上了）。`);
          continue;
        }
        sections.push({ id: s.id, text: body });
        const p = parseBlocks(body, { complete: true });
        parsed.push({ id: s.id, title: s.title, blocks: p.blocks });
        p.blocks.forEach((b, at) => {
          if (b.type === "judgment") judgmentLines.push(p.sources[at]);
          if (b.type === "evidence_usage") declared.push(...b.discarded);
        });
        // 要点往后滚。递的是要点不是正文 —— 理由在 `stages.keyPointsOf`。
        written = [written, keyPointsOf(s, p.blocks)].filter(Boolean).join("\n\n");
      }

      // ---- 收口 ----
      detail(st, "收口");
      const account = mergeUsage({
        packIds,
        blocks: parsed.flatMap((x) => x.blocks),
        declared,
      });
      let closing = "";
      try {
        closing = (
          await h.callMessages(
            `模型调用 · a4.report.closing（${laneLabel}）`,
            [
              { role: "system", content: a4ClosingSystem(hasEvidence) },
              {
                role: "user",
                content: buildA4ClosingUser({
                  ...material,
                  thesisDraft: outline.thesisDraft,
                  written,
                  sectionJudgments: judgmentLines.join("\n"),
                  usage: usageMaterial(account),
                }),
              },
            ],
            // 高档：这一次要把各节串成一句话，还要把几节之间对不上的地方说出来。
            {
              slot: st.lane.slot,
              maxTokens: SECTION_MAX_TOKENS,
              json: false,
              effort: "high",
              verbosity: "high",
              jsonlContinue: 1,
            },
            { promptKey: "a4.report.closing", lane: laneLabel, writer: st.modelAlias },
            `${st.lane.hint}.closing`
          )
        ).text.trim();
      } catch (e) {
        notes.push(`收口那一次没跑成，这一份少了横幅和最终判断：${why(e)}`);
      }

      const asm = assembleStaged({ outline, sections, closing, packIds });
      notes.push(...asm.notes, ...crossSectionRepeats(parsed));
      h.note(
        `${laneLabel} · 分节出稿`,
        {
          节数: `${sections.length}/${outline.sections.length}`,
          各节: parsed.map((x) => `${x.id} ${x.title}（${x.blocks.length} 块）`),
          证据利用率: `取回 ${packIds.length} 条 · 用上 ${asm.usage.block.used.length} 条 · 弃用 ${asm.usage.block.discarded.length} 条 · 没交代 ${asm.usage.uncovered.length} 条`,
          收口: closing ? "交了" : "没跑成",
          对不上的: notes,
        },
        "local"
      );
      return asm.text;
    };

    advance(st, LANE_STEPS.report);
    let text = useBlocks ? await writeStaged() : await write();
    st.attempts = 1;
    /*
     * 空正文当没跑成。推理型模型最像的失败长相就是它 —— 额度全花在 reasoning 上，
     * `content` 回一个空串而 HTTP 是 200。留着它的话屏幕上多一栏点开什么都没有的页签，
     * 而那一栏答不出是还在跑还是跑完了是空的。
     */
    if (!text) throw new Error("报告正文回来是空的（额度可能全花在推理上了）");

    /*
     * 出口对账：确定性的，不调模型（`gate.ts`）。它的 p0 触发**一轮**报告重写 —— 只给
     * 一轮：第二轮改不对的多半是这条链路的台账本身有缺口，再让它改一遍只会让它把话说得
     * 更含糊。
     */
    advance(st, LANE_STEPS.gate);

    if (useBlocks) {
      /*
       * 区块那一支的闸是 `blocks/lint.ts`，不是 `validateReport` —— 结构规则是认格式的：
       * 「每节几句」在一份由卡片和表格组成的报告上没有对应物。
       *
       * 但 `gateReport` 照旧跑，跑在转写出来的那一面文字上：它那四条规则在区块侧没有
       * 对应物（裸地址、反证有没有被应答、有没有「未能核实」那一节、算术复算），而那
       * 四条问的都是内容，和形态无关。
       */
      const laneMark = (): ReportBlocks["lane"] => ({
        model: st.modelAlias,
        short: st.lane.label,
        durationS: Math.round((Date.now() - st.t0) / 1000),
      });
      let asm = assembleReport({ text, entries: st.ledger.entries, lane: laneMark(), complete: true });
      let violations = lintAssembled(asm);
      const firstRound = blocking(violations).length;

      if (mustRewrite(violations)) {
        const { rejected, general, needsMeta } = rejectedFrom(violations, asm.blocks, asm.sources);
        // 一条 p0 都指不到具体块、也不是元数据缺失时没有可返修的对象（比如「引了证据表里
        // 没有的编号」这类报告级的）。那时不发返修：让模型对着一份说不清改哪里的要求重写，
        // 回来的是一份全新的报告。
        if (rejected.length || needsMeta) {
          detail(st, `按出口校验重写 ${rejected.length} 块`);
          try {
            const reply = await write(
              [
                { role: "assistant", content: text },
                { role: "user", content: buildA4BlockRepair(rejected, general || undefined, needsMeta) },
              ],
              summarize(blocking(violations))
            );
            if (reply) {
              const spliced = spliceRepair({ previous: asm, rejected, needsMeta, reply });
              text = spliced.text;
              asm = assembleReport({ text, entries: st.ledger.entries, lane: laneMark(), complete: true });
              violations = lintAssembled(asm);
              st.attempts = 2;
              if (spliced.notes.length) {
                h.note(`${laneLabel} · 返修对齐`, { 对不上的: spliced.notes }, "local");
              }
            }
          } catch (e) {
            console.warn(
              `[tkos:a4] ${laneLabel} 那一条区块返修没成，留第一稿：${e instanceof Error ? e.message : e}`
            );
          }
        }
      }

      st.blocks = asm.report;
      st.lint = violations;
      // 文字面在**写入时**转写一次就冻住。理由（哪四处只认文本、为什么不在渲染时拼）
      // 写在 `blocks/report.ts` 头部。
      st.text = blocksToText(asm.report);
      /*
       * 递上模型既有知识那几条的编号：它们按契约就该出现在正文里（单列、标成没核实过），
       * 但台账里没有它们 —— 不递的话 A4-G02 会把每一份合规的报告都判成「引了台账里没有的
       * 编号」，而这条 p0 在这一支带不动重写。
       */
      st.gate = gateReport(st.text, st.ledger, st.verdicts, outsideLedgerIds(asm.report));
      st.durationMs = Date.now() - st.t0;
      h.note(
        `${laneLabel} · 出口校验（区块）`,
        {
          写了几遍: st.attempts,
          块数: asm.blocks.length,
          证据: `${asm.report.evidence.length} 条 · ${asm.report.evidencePackId}`,
          重写前p0: firstRound,
          仍未过: blocking(violations).map(fmt),
          文本面: blocking(st.gate.violations).map(fmt),
        },
        "local"
      );
      return;
    }

    let gate = gateReport(text, st.ledger, st.verdicts);
    if (blocking(gate.violations).length) {
      const repair = summarize(blocking(gate.violations));
      detail(st, "按对账结果重写一轮");
      try {
        const again = await write(
          [
            { role: "assistant", content: text },
            { role: "user", content: buildA4GateRepair(repair) },
          ],
          repair
        );
        if (again) {
          text = again;
          gate = gateReport(again, st.ledger, st.verdicts);
          st.attempts = 2;
        }
      } catch (e) {
        // 重写那一次挂了就留着第一稿：它没过对账，但那件事记在 `lanes[].blocked` 上，
        // 屏幕上那一栏照实是它写出来的东西。丢掉它换成一栏空白不是更诚实，是更少信息。
        console.warn(
          `[tkos:a4] ${laneLabel} 那一条重写没成，留第一稿：${e instanceof Error ? e.message : e}`
        );
      }
    }

    st.text = text;
    st.gate = gate;
    st.durationMs = Date.now() - st.t0;
    h.note(
      `${laneLabel} · 出口对账`,
      { 写了几遍: st.attempts, 仍未过: blocking(gate.violations).map(fmt) },
      "local"
    );
  };

  /*
   * 几条同时发。它们之间没有任何数据往来 —— 而 `Harness` 的 token 累计在并发下是安全的
   * （读改写之间没有 await），唯一按顺序的字段是 `run.modelAlias`，它在下面 digest / 反证
   * 那两次调用里本来就会被覆盖。
   *
   * 一条也不 rethrow：挂了就是那一栏带着原话摆在屏幕上，别的几条照跑。全挂那件事在
   * 下面单独判 —— 在这里判不了，`Promise.all` 里第一个抛出来的会把别的几条的原话吃掉。
   */
  await Promise.all(
    states.map(async (st) => {
      try {
        await runLane(st);
      } catch (e) {
        st.error = e instanceof Error ? e.message : String(e);
        st.durationMs = Date.now() - st.t0;
        console.warn(`[tkos:a4] ${st.lane.label} 那一条链路没跑成：${st.error}`);
      }
      report();
      h.substep(laneLine());
    })
  );

  const done = states.filter((s): s is LaneRun & { text: string; gate: Gate } => Boolean(s.text));
  if (!done.length) {
    /*
     * 全挂了 —— 这一轮就是挂了，没有报告可读，判断板上一条也不该有。
     *
     * 抛 `AgentRunFailed` 而不是裸 Error：各条各自的原话只在这个进程的 `console.warn` 里，
     * 而排查这件事的人手上只有运营台。挂一条带 trace 的失败记录上去，那三句话才有地方读。
     * 调用方 `agentRunPut(e.run)` 之后原样再抛（`store.ensureDeepResearch`），任务落
     * `failed`，**不自动重试**。
     */
    const why = states
      .map((s) => `${s.lane.label}（${s.error ?? "没有正文"}）`)
      .join("；");
    const msg = `${states.length} 条链路都没跑成：${why}`;
    throw new AgentRunFailed(
      h.finish({ status: "failed", input: input.title, error: msg }),
      new Error(msg)
    );
  }

  /*
   * 主源。原定那一条挂了就顺位落到写成了的第一条（`LANES` 的顺序），**并且重排整排页签的
   * key** —— 这是唯一会发生这件事的情形，`DraftReport.key` 的注释里写着。
   */
  let primary = done.find((s) => s.primary);
  if (!primary) {
    const planned = states.find((s) => s.primary)!;
    primary = done[0];
    for (const st of states) st.primary = st === primary;
    primary.key = "agent";
    for (const st of states) if (st !== primary) st.key = `agent:alt${st.tabOrder}`;
    h.note(
      "主源顺位",
      {
        原定: planned.lane.label,
        实际: primary.lane.label,
        原因: planned.error ?? "那一条没写出正文",
      },
      "local"
    );
    report();
  }

  // 台账进溯源：带 href 的条目屏幕上能点开，这才是「这句话凭什么这么说」答得出来的形式。
  // 每条链路一份自己的 —— 抄主源的清单过去，屏幕上会把 ChatGPT 取回的页说成是 Claude 取回的。
  for (const st of states) {
    st.assembled = [...base];
    if (retrieving) {
      st.assembled.push(retrievalItem(providerLabel(search), st.rounds.length, st.ledger.entries.length));
    }
    st.assembled.push(...evidenceManifest(st.ledger));
  }

  // ---- 第 3 步：对齐各条链路的分歧（只有区块那一支有这一步）-----------------
  /*
   * 任务书 §4.3。各条各自出稿之后对齐它们对同一命题的裁决，折出 `divergence_view`，
   * 插进主源那一份 —— 判断板从 `judgment` + `divergence_view` 两种块直接取（A5）。
   *
   * 插进去之后主源那一份要重做三件事：文字面重新转写一遍（那四处只认文本的地方
   * 才读得到分歧）、出口闸重新跑一遍、区块校验重新跑一遍（新插的块也归 A4-B09 管，
   * 而链路里那一遍时它们还不存在）。
   *
   * 这一步整段包在 try 里：它挂了不该拖垮这一轮 —— 几份报告已经写成了，少的只是分歧那
   * 几块。挂了的原话进 trace，屏幕上那块判断板照旧从 `judgment` 长出来。
   */
  if (useBlocks) {
    h.step(STEPS.divergence);
    const withBlocks = done.filter((s): s is typeof s & { blocks: ReportBlocks } => Boolean(s.blocks));
    // 少于两条出稿就没有分歧可对（一方没有分歧）。这一步照样报一格，小字里写明原因 ——
    // 分母是起跑前定的，跳过不等于这一格消失。
    if (withBlocks.length < 2) {
      h.note(
        "跨链路对账 · 跳过",
        { 出稿的链路: withBlocks.map((s) => s.lane.label), 原因: "少于两条，一方没有分歧" },
        "local"
      );
    } else {
      const stances = stancesOf(withBlocks.map((s) => ({ label: s.lane.label, report: s.blocks })));
      try {
        const raw = (
          await h.callMessages(
            "模型调用 · a4.divergence",
            [
              { role: "system", content: A4_DIVERGENCE_SYSTEM },
              {
                role: "user",
                content: buildA4DivergenceUser({
                  issueId: input.issueId,
                  title: input.title,
                  stances: stanceMaterial(stances),
                }),
              },
            ],
            // 走 `pro`：它是唯一一定解析得出来的槽位。别把它读成「独立裁决」—— 写了
            // DeepSeek 那一份的就是它，所以链路名在提示词里是代号（见 `divergence.ts`）。
            // 额度和那两次交 JSON 的一样，理由同 `JSON_MAX_TOKENS`：这一次也落在推理槽位上。
            { slot: "pro", maxTokens: JSON_MAX_TOKENS, json: false },
            { promptKey: "a4.divergence", lane: stances.map((s) => `${s.alias}=${s.label}`).join("・") },
            "a4.divergence"
          )
        ).text;
        const { views, notes } = readDivergences(raw, stances);
        if (views.length && primary.blocks) {
          primary.blocks = insertDivergences(primary.blocks, views);
          primary.text = blocksToText(primary.blocks);
          primary.gate = gateReport(
            primary.text,
            primary.ledger,
            primary.verdicts,
            outsideLedgerIds(primary.blocks)
          );
          primary.lint = lintStored(primary.blocks);
          // 主源那一栏此刻正摆在屏幕上，正文换了就得重报一次。
          report();
        }
        h.note(
          "跨链路对账",
          {
            对了几条: stances.length,
            折出分歧: views.length,
            各处: views.map(
              (v) => `${v.topic}｜${v.adjudication.status}・${v.adjudication.method}`
            ),
            对不上的: notes,
          },
          "local"
        );
      } catch (e) {
        console.warn(
          `[tkos:a4] 跨链路对账没成，这一轮不折分歧：${e instanceof Error ? e.message : e}`
        );
        h.note("跨链路对账 · 没成", { 原话: e instanceof Error ? e.message : String(e) }, "local");
      }
    }
  }

  const report0 = primary.text;
  const gate = primary.gate;
  /*
   * 文体那一层的检查**不进重修循环**。
   *
   * 重修循环喂的是压缩那一层的 messages，把报告的违规递进去，模型只会去改四节 ——
   * 于是台账上违规消失了，报告一个字没动。所以这几条只记不修，全是 p1。出口对账那几条
   * 是另一回事：它们在链路里有自己的重写轮，所以是 p0。
   */
  const reportViolations = [
    // 区块那一支的结构账已经在链路里记完了（`blocks/lint.ts`），这里不再跑
    // `validateReport` —— 它查的是「每节几句、有没有这几个小标题」，那几条问的是一篇
    // 文章的形状，一份由卡片和表格组成的报告在它眼里每一条都不合格。
    ...(primary.lint ?? validateReport(report0, primary.ledger.entries.length > 0)),
    ...gate.violations,
  ];
  /** 别人跑出来的那几份。没写成的那条不在里面 —— 它在屏幕上没有正文可读。 */
  const alts: AltReport[] = states
    .filter((s) => s !== primary && s.text)
    .map((s) => ({
      modelAlias: s.modelAlias,
      label: s.lane.label,
      text: s.text!,
      tabOrder: s.tabOrder,
      ...(s.durationMs === undefined ? {} : { durationMs: s.durationMs }),
      ...(s.blocks ? { blocks: s.blocks } : {}),
      assembledFrom: [...s.assembled],
      kind: "writer" as const,
    }));

  // ---- 压成四节（旧路那一支是第 3 步，区块那一支第 4 步）--------------------
  h.step(STEPS.digest);
  const messages = [
    { role: "system", content: A4_DIGEST_SYSTEM },
    {
      role: "user",
      content: buildA4DigestUser({
        issueId: input.issueId,
        title: input.title,
        report: report0,
        judgments: input.judgments,
      }),
    },
  ];

  /*
   * 这一段里的裸错要换成 `AgentRunFailed` 再往上抛。
   *
   * 不是为了好看：`ensureDeepResearch` 只在 `e instanceof AgentRunFailed` 时落运营台记录，
   * 所以四节这一步（模型调用截断、回来的不是 JSON）挂掉时，运营台上**一条都没有** ——
   * 而屏幕上那句话照旧写着「已记在运营台」。2026-08-26 ISS-111 的失败原因当时只活在进程
   * 内存的任务表里，dev server 一重启就没了。
   *
   * 到这一步 `h` 手上已经有整轮的 trace（各条链路各自那几次调用、用时、token），所以
   * `h.finish` 出来的那条记录能直接看出「跑到四节压缩才死的」，不是一句「深研失败」。
   */
  const recorded = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AgentRunFailed) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new AgentRunFailed(
        h.finish({ status: "failed", input: input.title, error: msg }),
        e instanceof Error ? e : new Error(msg)
      );
    }
  };

  let citationsBound = 0;
  /*
   * 造四节 + 绑引用，一起做。
   *
   * 绑定必须在校验之前：`validateResearch` 的 A7-01 查的是「每条 Evidence 有没有
   * 溯源」，而带 `[E3]` 的句子的溯源是由代码按编号补上的。顺序反了，每次都会报一堆
   * 假违规，然后重修那一轮会让模型自己手写来源 —— 正是不许它做的那件事。
   *
   * 绑的是**主源那一条自己的台账**：`[E3]` 这个编号在各条链路里各指一页，用别人的台账去绑
   * 会把一个真编号绑到一个这份报告根本没读过的来源上 —— 而那种错在屏幕上点得开、看起来
   * 完全正常。
   */
  const build = (rawText: string): ResearchDoc => {
    const d = shape(rawText, input, primary!.assembled, opts?.agentLabel, {
      text: report0,
      label: primary!.lane.label,
      tabOrder: primary!.tabOrder,
      durationMs: primary!.durationMs,
      ...(primary!.blocks ? { blocks: primary!.blocks } : {}),
      alts,
    });
    citationsBound = bindCitations(d, primary!.ledger);
    return d;
  };

  let raw = (
    await recorded(() =>
      h.callMessages(
        "模型调用 · a4.digest",
        messages,
        { maxTokens: DIGEST_MAX_TOKENS },
        digestDetail,
        "a4.digest"
      )
    )
  ).text;
  let doc = await recorded(() => build(raw));
  let violations = [...reportViolations, ...validateResearch(doc)];
  let attempts = 1;

  /*
   * 第一轮的违规在这里就留下来，因为下面那个 while（还有反证合并之后那次重跑）
   * 会把 `violations` 覆盖掉。只落最后一轮的话，台账上就只剩「重修都没救回来」
   * 那几条 —— 而绝大多数违规是第一轮犯、第二轮改对的，那部分全没了。
   */
  const firstRoundViolations = violations.map(fmt);

  while (blocking(violations).length && attempts <= MAX_REPAIR) {
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: buildA4Repair(summarize(blocking(violations))) });
    // 序号不动，只在原话后面接一句轮次 —— 重修是这一步内部再跑一遍，不是下一步。
    h.substep(`重修第 ${attempts} 轮`);
    raw = (
      await recorded(() =>
        h.callMessages(
          `模型调用 · a4.digest 重修第 ${attempts} 轮`,
          messages,
          { maxTokens: DIGEST_MAX_TOKENS },
          { ...digestDetail, repairOf: summarize(blocking(violations)) },
          "a4.digest"
        )
      )
    ).text;
    doc = await recorded(() => build(raw));
    // 报告那几条照旧带着：重修改的是四节，报告一个字没动，把它们丢掉等于让这几条
    // 违规在第二轮凭空消失。
    violations = [...reportViolations, ...validateResearch(doc)];
    attempts += 1;
  }

  // ---- 反证复核（干净的上下文）。收尾那一步，旧路第 4、区块第 5 -------------
  let challengeCount = 0;
  let challenged = false;
  const pro = resolveModel("pro");
  if (pro) {
    challenged = true;
    /*
     * 报在 `if` 里面。pro 槽位没配出来时这一步**根本不发生**，在外面报等于屏幕上写着
     * 「正在反证复核」而没有任何请求发出去。代价是那种机器上这一轮少走一步就结算了 ——
     * 那是真的，分母说的是这条链路计划几步，不是保证跑满几步。
     */
    h.step(STEPS.challenge);
    try {
      const cText = (
        await h.callMessages(
          `模型调用 · a4.challenge（反证复核 ${pro.model}）`,
          [
            { role: "system", content: A4_CHALLENGE_SYSTEM },
            {
              role: "user",
              content: buildA4ChallengeUser({
                title: input.title,
                judgment: doc.judgment.map((s) => s.text),
                keyEvidence: doc.keyEvidence.map((s) => s.text),
                context: companyContext,
              }),
            },
          ],
          { slot: "pro", maxTokens: JSON_MAX_TOKENS },
          // 不带 `cognitiveSource`：那是报告那一段的来源，这一遍用的是自己的 system，
          // 没有认知段。抄一个过来会让台账显示它带了 S03 的标准，而它没有。
          { promptKey: "a4.challenge" },
          "a4.challenge"
        )
      ).text;
      const extra = toStatements(parseJson<{ counters?: unknown }>(cText).counters);
      const fresh = dedupe(doc.counters, extra).map((s) => tagChallenge(s, pro.model));
      challengeCount = fresh.length;
      doc.counters = [...doc.counters, ...fresh];
      /*
       * 条数写进标签里。「复核跑过、一条都没找到」和「复核没跑」是两件事：前者是这份
       * 判断在干净上下文下再冲一遍也没冲动，那是**信息**；后者只是没做。标签上只写
       * 「反证复核 · deepseek-v4-pro」会把这两件事说成一件。
       */
      const recheck: ManifestItem = {
        label: `反证复核 · ${pro.model}（另找到 ${challengeCount} 条反证）`,
        kind: "agent",
      };
      primary.assembled.push(recheck);
      /*
       * 显式写进 doc，**不靠数组别名**。`shape()` 拿到的是副本，所以这一行不写，这条溯源
       * 就进不了产出 —— 而它的全部意义就是让人看得出这一遍跑过。
       */
      doc.assembledFrom = [...primary.assembled];
      console.log(
        `[tkos:a4] 反证复核 ${pro.model} 返回 ${extra.length} 条，去重后新增 ${challengeCount} 条`
      );
      // 合并之后重跑一遍：新加的反证也要满足「写清推翻门槛」。只记，不再重修 ——
      // 重修这一遍等于让它把自己的话改回主源的口径，那这一遍就白跑了。
      violations = [...reportViolations, ...validateResearch(doc)];
    } catch (e) {
      console.warn(`[tkos:a4] 反证复核失败，只用主源：${e instanceof Error ? e.message : e}`);
      challenged = false;
    }
  } else {
    console.warn("[tkos:a4] pro 槽位没配出来 —— 这份深研没有做反证复核。");
  }

  const degraded = blocking(violations).length > 0;
  /*
   * 这一份手上到底有没有外部证据。
   *
   * 摆在这里而不是留给下游算：`recorded === 0` 这个条件下游到处都能算，答不出的是**空在哪
   * 一格** —— 检索全线报错、检索通了但搜不到、搜到了抓不下来、抓下来了没过入账闸，四种的
   * 下一步动作完全不同，而分辨它们要的 `searchErrors` 原话只在这里手上有（`Round` 不落库）。
   *
   * 不进 `violations`、不动 `degraded`：空手不是违规（HP-5：查不到是合法结果），而 `degraded`
   * 一路上的意思是「有阻断级违规」。真把它标成违规，重修那一遍会去救一个欠费的账号 —— 救
   * 不回来，只多烧两遍模型钱。
   */
  const noEvidence = noExternalEvidence({
    providerLabel: providerLabel(search),
    propositions: primary.props.length,
    recorded: primary.ledger.entries.length,
    rounds: primary.rounds,
  });
  // 显式写进 doc，理由同上面 `doc.assembledFrom` 那一行：`shape()` 拿到的是副本。
  if (noEvidence) doc.noExternalEvidence = noEvidence;
  return {
    doc,
    violations,
    attempts,
    degraded,
    challengeCount,
    challenged,
    evidencing: {
      provider: providerCode(search),
      providerLabel: providerLabel(search),
      hitsByProvider: rollUp(states.flatMap((s) => s.rounds)),
      propositions: primary.props.length,
      rounds: primary.rounds,
      recorded: primary.ledger.entries.length,
      rejected: primary.rounds.reduce((n, r) => n + r.rejected, 0),
      unresolved: primary.verdicts.filter((v) => !v.ok).map((v) => v.propositionId),
      calculations: gate.calculations,
      citationsBound,
      reportAttempts: primary.attempts,
      lanes: states.map((s) => ({
        label: s.lane.label,
        modelAlias: s.modelAlias,
        primary: s.primary,
        propositions: s.props.length,
        rounds: s.rounds.length,
        recorded: s.ledger.entries.length,
        rejected: s.rounds.reduce((n, r) => n + r.rejected, 0),
        unresolved: s.verdicts.filter((v) => !v.ok).map((v) => v.propositionId),
        attempts: s.attempts,
        blocked: s.gate ? blocking(s.gate.violations).length : 0,
        ...(s.durationMs === undefined ? {} : { durationMs: s.durationMs }),
        ...(s.error ? { error: s.error } : {}),
      })),
    },
    run: h.finish({
      status: "ok",
      input: input.title,
      output: doc as unknown as Record<string, unknown>,
      violations: violations.map(fmt),
      // 一轮就过时不落这个字段：全过的运行留一个空数组，和「没记」在统计时分不开。
      ...(attempts > 1 ? { firstRoundViolations } : {}),
      degraded,
      ...(noEvidence ? { noExternalEvidence: noEvidence.headline } : {}),
    }),
  };
}

/**
 * 复核那一遍找出来的反证要看得出是后补的。
 *
 * 不加这个标记的话，一号位看到的就是一堆看起来同源的反证 —— 而「这一条是拿着结论
 * 再冲一遍才冒出来的」本身就是信息，藏起来是浪费。
 *
 * 标签写「反证复核」而不是「独立第二源」：它只是上下文干净，而且它刚刚才写完几份原件里的
 * 一份，写成「独立」会让人以为这条经住了一个对这个议题一无所知的模型。
 */
function tagChallenge(s: Statement, model: string): Statement {
  return {
    text: s.text,
    traces: [
      ...(s.traces ?? []),
      { kind: "agent" as const, source: `反证复核 · ${model}` },
    ],
  };
}

/** 粗去重：正文前 24 字相同就算同一条。两个模型说同一件事的措辞不会完全一样。 */
function dedupe(existing: Statement[], incoming: Statement[]): Statement[] {
  const seen = new Set(existing.map((s) => s.text.replace(/\s/g, "").slice(0, 24)));
  const out: Statement[] = [];
  for (const s of incoming) {
    const k = s.text.replace(/\s/g, "").slice(0, 24);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function shape(
  raw: string,
  input: A4Input,
  assembled: ManifestItem[],
  agentLabel?: string,
  /**
   * 这一轮各条链路跑出来的报告。`text`/`label`/`tabOrder`/`durationMs` 是**主源**那一条
   * （进 `sourceText` 那几个字段，报告页签默认给的就是它，四节也是从它压出来的）；
   * `alts` 是另外那几条各自跑出来的，各带自己的装配清单和自己的用时。
   */
  reports?: {
    text: string;
    label: string;
    tabOrder: number;
    durationMs?: number;
    /** 主源那一条的区块原件（`TKOS_DR_BLOCKS=1` 时才有）。 */
    blocks?: ReportBlocks;
    alts: AltReport[];
  }
): ResearchDoc {
  const j = parseJson<Raw>(raw);
  return {
    issueId: input.issueId,
    judgment: toStatements(j.judgment),
    keyEvidence: toStatements(j.keyEvidence),
    counters: toStatements(j.counters),
    unknowns: toStatements(j.unknowns),
    routeSuggestion: str(j.routeSuggestion),
    byAgentLabel: agentLabel ?? DEFAULT_AGENT_LABEL,
    // 空串不落这几个字段：报告页签按「有没有 sourceText」决定默认给哪一面，落一个空串
    // 进去，它会默认打开一个空白的原文页。页签名和它排第几跟着正文一起落 —— 有正文没名字
    // 的话，屏幕上那一栏会回落成「深研报告」，而这一轮明明知道是哪条链路跑的。
    ...(reports && reports.text.trim()
      ? {
          sourceText: reports.text,
          sourceLabel: reports.label,
          sourceTabOrder: reports.tabOrder,
          ...(reports.durationMs === undefined ? {} : { sourceDurationMs: reports.durationMs }),
          // 区块原件跟着正文一起落，不单独落：`sourceText` 就是它转写出来的那一面，
          // 落了块而没落文本的那一档在屏幕上是「有结构没原文」，没有一处代码读得懂。
          ...(reports.blocks ? { blocks: reports.blocks } : {}),
        }
      : {}),
    // 空数组也不落：只有一条链路的机器上，`altReports: []` 和「这一版还没有这个字段」
    // 在统计时分不开。
    ...(reports?.alts.length ? { altReports: reports.alts } : {}),
    // 拷一份：产出不该跟着调用方那个还在被 push 的数组一起变。往里加东西的人要显式
    // 写回 `doc.assembledFrom`（反证复核那处就是），这样「谁往溯源里加了什么」是看得见的。
    assembledFrom: [...assembled],
  };
}
