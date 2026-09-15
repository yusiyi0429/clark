// 容器存活/就绪探针。无鉴权、无副作用、不碰上游。
// 编排层（火山云 VKE / ECS healthcheck / CLB）用它判断实例是否可接流量。
import { modelMockOn } from "@/lib/models/mock";
/*
 * 复用 `gkSettings()`，不在这里就地再读一遍 env。两处各自解析同一个开关的话，哪天
 * 一处开始认 `"false"`，健康检查就会报出与实际**相反**的 TLS 状态 —— 而这个开关恰好
 * 是「不报出来就没人记得」的那一个。（这里 import 的是配置解析，不是那扇门。）
 */
import { gkSettings } from "@/lib/graphknowledge/client";
/*
 * 同一个理由：`narrativeSettings()` / `ontologySource()` 只解析环境变量，不发请求。
 *
 * 「这台机器的本体是从哪儿取的」必须从外面问得出来。两个源产出的东西差着一整类
 * （有没有可引编号、有没有锚点自检），而屏幕上两份报告长得一样 —— 换源换错了的样子是
 * 「最近的报告怎么都不带内部编号了」，没有这一格，那个问题会被查到 prompt 上去。
 */
import { narrativeSettings } from "@/lib/ontology/narrative";
import { ontologySource } from "@/lib/ontology/source";
/*
 * 只取两个 getter，**不碰 store** —— 这个口是无副作用的存活探针，不该顺手把整个
 * 对象库初始化起来。代价是 `seedDrift` 可能还是 null（这个进程还没读过快照），
 * 那正是它设计成三态的原因。
 */
import { seedDrift, seedFrozen } from "@/lib/data/persist";
// 同一个理由：`runMode()` 只读一个环境变量，不碰 store。
import { runMode } from "@/lib/data/mode";
/*
 * 同一个理由：只读一个进程内的计数，不碰 store。
 *
 * 「有变动自动显示」这条线通没通，从外面必须问得出来。它坏掉的样子是**没有报错的**：
 * 页面照旧能看、能点，只是服务端自己做完的那些事不再出现在屏幕上 —— 而那正好长得像
 * 「今天没什么进展」。所以要有一个数字。
 */
import { revisionListenerCount } from "@/lib/data/revision";
/*
 * 同一个理由：`providers()` 只读环境变量，不发一个请求。
 *
 * 深研有没有在联网取证，从外面必须问得出来。它没配的时候**不报错也不降级成假数据**
 * （HP-5：查不到是合法结果），产出的是一份照实写着「本轮未联网核验」的报告 —— 那份
 * 报告和联网跑出来的那份在目录里长得一样，只有正文里那一句不同。
 */
import { providerCode, providers } from "@/lib/research/search";
/*
 * 同一个理由：`blocksOn()` 只读一个环境变量。
 *
 * 深研这一轮交的是有版式的区块还是一长条散文，从外面必须问得出来。这个开关坏掉（漏配）
 * 的样子**不报错也不降级**：报告照旧出得来、照旧能看，只是版式一处都没有 —— 而那看起来
 * 像「区块那套没做好」，排查会往组件和提示词上去，实际只是这一行没写。
 */
import { blocksOn } from "@/lib/agent/a4/blocks/flag";
/*
 * 同一个理由：这两个只读环境变量、跑一次 `ffmpeg -version`，不碰 store。
 *
 * 会议录音那条链路缺一样就整条不通，而**缺的样子是没有报错的**：屏幕上照旧能上传、
 * 照旧显示「排队中」，然后在后台那一步倒掉 —— 而他要点进那一份才看得见原因。所以
 * 「这台机器到底能不能转会议录音」必须从外面一句话问得出来。
 */
import { mediaToolsAvailable } from "@/lib/recording/media";
import { recordingConfigured } from "@/lib/recording/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const gk = gkSettings();
  const memory = narrativeSettings();
  const source = ontologySource();
  const search = providers();
  /*
   * 这一句会 spawn 一次 `ffmpeg -version`（几十毫秒）。存活探针里做一次 spawn 值不值：
   * 值 —— 「ffmpeg 装没装」在容器里是个会变的事实（换了基础镜像、忘了那一行 apt），
   * 而它坏掉的表现是每一份录音都在第一步倒掉。`mediaToolsAvailable` 永不抛。
   */
  const media = await mediaToolsAvailable();
  return Response.json({
    status: "ok",
    service: "tkos-frontend",
    // 构建时注入，用于确认线上跑的是哪一版
    commit: process.env.TKOS_CODE_SHA ?? "dev",
    // 下游配置是否就位——不暴露值，只报是否配置
    upstream: {
      /*
       * 「对话与研究接不接得上模型」= `pro` 那个槽位有没有出口，所以这里只看方舟那把
       * 和 DeepSeek 直连那把。**不把 `WANGSU_API_KEY` 加进来**：它撑的是深研另外两条
       * 链路，配了它而这两把都缺时，一号位一句话也说不出来 —— 而这个布尔量报 true
       * 会让排查从「模型没接上」这条路上被引开。
       */
      model: Boolean(process.env.ARK_API_KEY || process.env.DEEPSEEK_API_KEY),
      /*
       * 假模型开着的话必须报出来。一台跑罐头答案的机器从外面看和真机一模一样：
       * 「怎么不花 token」「产出怎么每次一个字都不差」会被查到别的地方去。
       */
      modelMock: modelMockOn(),
      /*
       * verifyTls:false 要在这里露出来。图服务现在是 IP + 自签证书，关校验的代价
       * 是这条链路不防中间人 —— 不报出来它就会变成一个没人记得的开关。
       */
      graphknowledge: {
        configured: Boolean(gk.baseUrl),
        verifyTls: gk.verifyTls,
      },
      /*
       * 本体这一轮从哪儿取，以及那个源配没配齐。
       *
       * `source` 和 `configured` 要**分开报**：`source:"narrative"` 而
       * `configured:false` 是最坏的那台机器 —— 每一条链路开局都会就地失败，而
       * `graphknowledge.configured` 还是 true，看起来像本体是好的。合成一个布尔量的话
       * 这台机器和一台配齐了的长得一模一样。
       *
       * **只报是否就位，不报值**（这个口无鉴权），key 的长度也不报 —— 长度足够把一把
       * 线上的 key 从日志里认出来。
       */
      ontology: {
        source,
        configured:
          source === "graph"
            ? Boolean(gk.baseUrl)
            : Boolean(memory.baseUrl && memory.apiKey),
      },
      /*
       * 深研这一轮真能用上的几家检索源（`none` = 这台机器上深研不联网）。
       *
       * `unusable` 是配了却用不上的家数（家名不认、少配一把 key）。**只报个数，不报
       * 原话** —— 原话在这次运行的 trace 里（那扇门后面），而这个口是无鉴权的。
       * 但这个数必须有：`["bocha"] + unusable:2` 和 `["bocha"] + unusable:0` 是两台
       * 完全不同的机器，而它们产出的报告长得一模一样。
       *
       * 报的是代号不是中文台名：这是给编排层和排查用的，不上屏。
       */
      search: {
        providers: providerCode(search.list).split("+"),
        unusable: search.skipped.length,
      },
    },
    /*
     * 深研下一轮会按哪种形态交。放在 upstream 外面：它不是「下游配置就位没有」，是这台
     * 机器交出来的东西长什么样，和 `mode` 是同一类。
     *
     * 只答下一轮。已经落库的那几份报告是什么形态由它们自己带着，关掉开关不会让它们的
     * 区块消失 —— 所以这个布尔量回答不了「我手上这一份为什么没版式」，它回答的是
     * 「我再跑一轮会不会还是这样」。
     */
    deepResearch: { blocks: blocksOn() },
    /*
     * 会议录音那条链路的三件前提。**分开报** —— 少了哪一件要走的路完全不同：
     * `ffmpeg:false` 是装个东西（本机 `winget install Gyan.FFmpeg`，容器里改 Dockerfile），
     * `tos:false` / `asr:false` 是去火山控制台配凭据。合成一个布尔量的话，那三条路
     * 在屏幕外面长得一模一样。
     *
     * **只报是否就位，不报值。** 这个口是无鉴权的。
     */
    recording: { ffmpeg: media.ffmpeg, ffprobe: media.ffprobe, ...recordingConfigured() },
    /*
     * 「屏幕上那些议题是真的吗」—— 这个问题从外面必须答得出来。
     *
     * `demo` 档下整套内容来自演示包（别家公司的编造议题），而屏幕上没有一处说它是
     * 示例。所以它要在这里露出来，和 `modelMock` 是同一条理由：一台跑示例内容的机器
     * 从外面看跟真机一模一样。
     */
    mode: runMode(),
    /*
     * 种子会不会被重建。**这一对回答的不是真假，是「会不会被抹掉」** ——
     * `frozen:false` = 种子一改就重建（开发期正确，上线之后等于会抹掉真实数据）；
     * `drift:true` = 种子文件跟快照里那份对不上，冻结着所以没重建，但那次改动没生效；
     * `drift:null` = 这个进程还没读过快照。
     */
    seed: { frozen: seedFrozen(), drift: seedDrift() },
    // 现在有几块屏挂在「库改过了」那条线上（`/api/data/changes`）。
    changes: { listeners: revisionListenerCount() },
    at: new Date().toISOString(),
  });
}
