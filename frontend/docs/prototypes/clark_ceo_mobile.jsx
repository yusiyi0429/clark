import { useState } from "react";
import {
  ChevronDown, ChevronRight, ExternalLink, MessageSquare, Eye, X,
  ArrowRight, Check, Shield, AlertTriangle, Star, Info, Smartphone, CornerDownRight,
} from "lucide-react";

/* ============================================================
   Clark v1 · 一号位端交互原型
   服务验收：MC-2 ③④⑤ / MC-3 ②③④ / MC-5 ①②
   变体开关见顶部控制条；打开「标注」看待决点
   ============================================================ */

/* ---------- 溯源徽章：全局 signature 元素（规格 P2 / 9.1） ---------- */
const TRACE = {
  ext:   { label: "外部事实", bar: "border-sky-600",   text: "text-sky-800",   bg: "bg-sky-50" },
  int:   { label: "内部事实", bar: "border-teal-700",  text: "text-teal-800",  bg: "bg-teal-50" },
  human: { label: "人的判断", bar: "border-slate-700", text: "text-slate-800", bg: "bg-slate-100" },
  agent: { label: "Agent 推演", bar: "border-amber-600", text: "text-amber-800", bg: "bg-amber-50" },
};

function Trace({ kind, src }) {
  const t = TRACE[kind];
  return (
    <span className={`inline-flex items-center gap-1 border-l-2 ${t.bar} ${t.bg} ${t.text} pl-1 pr-1 ml-1 align-middle font-mono text-xs`}>
      {t.label}
      {src ? <span className="opacity-60">· {src}</span> : null}
      <ExternalLink className="w-3 h-3 opacity-50" />
    </span>
  );
}

/* ---------- 分歧三分类：颜色即语义（规格 6.1） ---------- */
const DIS = {
  fact:  { label: "事实", cls: "bg-sky-50 text-sky-900 border-sky-300",       note: "可查证" },
  hypo:  { label: "假设", cls: "bg-amber-50 text-amber-900 border-amber-400", note: "需验证" },
  value: { label: "价值", cls: "bg-slate-800 text-white border-slate-800",    note: "只能拍板" },
};

/* ---------- 标注 pin ---------- */
function Pin({ n, on }) {
  if (!on) return null;
  return (
    <span className="inline-flex items-center justify-center w-4 h-4 ml-1 align-super bg-rose-600 text-white font-mono text-xs rounded-full">
      {n}
    </span>
  );
}

const NOTES = [
  { n: 1, q: "A-2", t: "IM 载体未定", d: "飞书卡片可承载完整四段式；企微模板卡片只能压成主标题+副文本(≤160字)+按钮。两版都实现了，切换顶部「载体」看差异。默认按飞书设计能力上界。" },
  { n: 2, q: "B-1", t: "卡片密度", d: "默认折叠：只露①发生了什么 + ③影响哪条判断，展开是主动动作。理由是保 5 分钟预算。切「密度」看全展开版——信息更全但三张卡就滑不完。" },
  { n: 3, q: "B-4", t: "Dismiss 原因不强制", d: "四个预设标签一键选，可跳过。强制填会让 Dismiss 变成比 Discuss 更贵的动作，人就会乱点 Watch。" },
  { n: 4, q: "B-2", t: "装配清单位置", d: "默认放在 Clark 首条消息里折叠——它是开场白不是设置项。这是 MC-2 证据⑤「装配清单可查」唯一的举证界面，验收时要演示。切「装配清单」比较三种位置。" },
  { n: 5, q: "规格 5.3", t: "不暴露模式切换器", d: "Explore/Research/Challenge/Frame 是后台 Worker 分工，前台只体现为对谈能力。基线「后台 Worker 不暴露」。唯一例外是 Frame 出口的 Decision Question 卡。" },
  { n: 6, q: "规格 5.4", t: "披露倾向开关默认关", d: "交接包默认脱敏，呈现「CEO 关注的问题」而非「CEO 的倾向」——防组织层面锚定（评审张力 3）。但开关要可见：藏起来等于产品替 CEO 做了判断。" },
  { n: 7, q: "规格 6.1", t: "最强反证独立成块", d: "视觉权重不低于 DRI 推荐。缩成脚注就等于没有防迎合。" },
  { n: 8, q: "B-3", t: "Closure 确认方式", d: "默认「整体审阅+局部改」，不改的话 1 次点击。逐字段版要 7 次——治理要求的是「CEO 确认过」，不是「CEO 点了七次」。切「Closure」对比。" },
  { n: 9, q: "B-6", t: "评分时机", d: "关键输出后非阻塞浮层，可跳过且跳过不追。它是 MC-5 证据②「以使用行为与两项评分为证」的举证来源，但不能变成打扰。" },
  { n: 10, q: "规格 P6", t: "预算不外显", d: "第 4 张卡自动顺延次日，界面上不出现「还有 N 条未显示」。任何形式的补充推送都违背注意力契约。" },
];

/* ---------- 议题数据（轨 A 场景：词元云集自身真实类型议题） ---------- */
const CARDS = [
  {
    id: "ISS-014",
    what: [
      { txt: "竞品「智策」8/3 发布私有化部署版本，公开定价为标准版 2.4 倍。", k: "ext", s: "厂商官网" },
      { txt: "AIDC 线客户在 8/4 交付会上明确提出数据不出内网。", k: "int", s: "8/4 客户会纪要" },
    ],
    why: "两条信号在 48 小时内同时出现，且指向同一个交付形态问题。AIDC 线 9 月合同续签窗口在 8 月底前需要给出答复。",
    strat: { id: "S-02", txt: "产品化优先于项目化：单客户定制不超过交付量的 30%" },
    hypo: { id: "H-05", txt: "中大型客户接受 VPC 部署，不要求完全离网" },
    sug: "建议 Discuss —— 这条同时挑战了 S-02 的边界和 H-05 的成立条件。",
    sugKind: "agent",
  },
  {
    id: "ISS-015",
    what: [
      { txt: "房懂懂线 7 月毛利率环比下降 4.2 个百分点，主因是交付人力占比上升。", k: "int", s: "7 月经营数据" },
    ],
    why: "连续第二个月下降，已越过年初设定的观察阈值。",
    strat: { id: "S-04", txt: "房懂懂线在 Q3 前实现交付标准化" },
    hypo: null,
    sug: "建议 Watch —— 趋势成立但尚不需要本月决策。",
    sugKind: "agent",
  },
];

const ASSEMBLY = [
  { g: "原 Signal", items: ["竞品私有化发布（外部）", "AIDC 客户会纪要（内部）", "刘总 7/29 周会发言（主观）"] },
  { g: "相关 Strategy / Hypothesis", items: ["S-02 产品化优先于项目化", "H-05 客户接受 VPC 部署"] },
  { g: "历史 Decision", items: ["D-2026-06-03 否决 X 客户源码交付诉求（含否决理由）"] },
  { g: "Decision Memory", items: ["原则「不为单一客户改变产品形态，除非该形态可复用」（您 6/3 确认）"] },
  { g: "过往对谈", items: ["无——本议题首次进入对谈"] },
];

const CHALLENGES = [
  {
    c: "把私有化做成标准形态，会让 S-02 的 30% 定制红线失去意义。",
    src: "与 S-02 陈述冲突",
    alt: "除非把「标准化私有化」本身算作产品能力而非定制——但那需要先证明它能复用到第二个客户。",
  },
  {
    c: "H-05 可能已经失效，而不是这一个客户例外。",
    src: "与 D-2026-06-03 的假设前提冲突",
    alt: "6 月否决 X 客户时的依据就是 H-05。如果 H-05 塌了，那次否决也需要重看。",
  },
];

const DIVERGE = [
  { k: "fact",  t: "完全离网条件下，ASR 与模型推理如何承载？成本增量未测算。", who: "可查证 · 需 2 天" },
  { k: "hypo",  t: "H-05「客户接受 VPC」是否仍成立，还是仅此客户例外？", who: "需验证 · 建议抽访 3 个在谈客户" },
  { k: "value", t: "本季 AIDC 收入确定性 vs 产品通用化路线的完整性。", who: "只能您拍板" },
];

const CLOSURE = [
  { k: "Choose", v: "为私有化建立一套标准交付形态，限定在「VPC + 本地模型网关」这一种拓扑，不做完全离网。" },
  { k: "Not Choose", v: "不做完全离网版本；不为单一客户改产品主干代码。" },
  { k: "Why", v: "私有化需求已出现第二次（X 客户 6 月、AIDC 客户 8 月），具备复用前提；但完全离网的成本结构尚未验证，不在本次承诺内。" },
  { k: "Key Hypothesis", v: "H-05 修订为：中大型客户接受 VPC 部署，其中约三成会额外要求本地模型网关。" },
  { k: "Risk Accepted", v: "接受 Q3 交付人力占比上升 5 个百分点以内。超出即触发重开。" },
  { k: "Commitment", v: "AIDC 线 DRI 在 8/20 前给出 VPC 拓扑的成本测算与两个客户的适配评估。" },
  { k: "Re-open Trigger", v: "① 出现第三个完全离网诉求；② 交付人力占比超 35%；③ H-05 抽访结果与修订版不符。" },
];

/* ============================ 主组件 ============================ */
export default function ClarkCeoMobile() {
  const [screen, setScreen] = useState("digest");
  const [annotate, setAnnotate] = useState(true);
  const [carrier, setCarrier] = useState("feishu");   // A-2
  const [density, setDensity] = useState("fold");     // B-1
  const [asmPos, setAsmPos] = useState("inline");     // B-2
  const [closureMode, setClosureMode] = useState("whole"); // B-3
  const [empty, setEmpty] = useState(false);

  const [openCard, setOpenCard] = useState(null);
  const [disposed, setDisposed] = useState({});
  const [dismissing, setDismissing] = useState(null);
  const [asmOpen, setAsmOpen] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [fieldOk, setFieldOk] = useState({});
  const [written, setWritten] = useState(false);
  const [rating, setRating] = useState(null);

  const steps = [
    ["digest", "晨报"], ["talk", "对谈"], ["brief", "会前 Brief"], ["closure", "会后 Closure"],
  ];

  return (
    <div className="min-h-screen bg-stone-100 text-slate-900">
      {/* ===== 控制条 ===== */}
      <div className="bg-slate-900 text-stone-100 px-4 py-3">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <div>
              <span className="font-serif text-lg">Clark v1 · 一号位端原型</span>
              <span className="font-mono text-xs text-stone-400 ml-3">MC-2 ③④⑤ · MC-3 ②③④ · MC-5 ①②</span>
            </div>
            <button
              onClick={() => setAnnotate(!annotate)}
              className={`font-mono text-xs px-3 py-1 border ${annotate ? "bg-rose-600 border-rose-600 text-white" : "border-stone-500 text-stone-300"}`}>
              {annotate ? "标注：开" : "标注：关"}
            </button>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3 font-mono text-xs">
            <Sw label="载体 A-2" v={carrier} set={setCarrier} opts={[["feishu", "飞书"], ["wecom", "企微"]]} />
            <Sw label="密度 B-1" v={density} set={setDensity} opts={[["fold", "折叠"], ["full", "全展开"]]} />
            <Sw label="装配清单 B-2" v={asmPos} set={setAsmPos} opts={[["inline", "内联"], ["top", "顶栏"], ["drawer", "抽屉"]]} />
            <Sw label="Closure B-3" v={closureMode} set={setClosureMode} opts={[["whole", "整体审阅"], ["field", "逐字段"]]} />
            <Sw label="空报 B-5" v={empty ? "y" : "n"} set={(x) => setEmpty(x === "y")} opts={[["n", "有卡"], ["y", "空报"]]} />
          </div>

          <div className="flex gap-1 mt-3">
            {steps.map(([k, l], i) => (
              <button key={k} onClick={() => setScreen(k)}
                className={`font-mono text-xs px-3 py-1 border ${screen === k ? "bg-stone-100 text-slate-900 border-stone-100" : "border-slate-700 text-stone-400"}`}>
                {i + 1} {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 flex flex-wrap gap-6 items-start justify-center">
        {/* ===== 手机 ===== */}
        <div className="w-96 bg-stone-50 border border-slate-300 shadow-lg">
          <div className="bg-slate-800 text-stone-300 px-3 py-1 font-mono text-xs flex justify-between">
            <span>{carrier === "feishu" ? "飞书" : "企业微信"}</span>
            <span className="flex items-center gap-1"><Smartphone className="w-3 h-3" />08:15</span>
          </div>

          <div className="p-3">
            {screen === "digest" && <Digest {...{ carrier, density, empty, annotate, openCard, setOpenCard, disposed, setDisposed, dismissing, setDismissing, setScreen }} />}
            {screen === "talk" && <Talk {...{ asmPos, annotate, asmOpen, setAsmOpen, reveal, setReveal, setScreen }} />}
            {screen === "brief" && <Brief {...{ annotate, setScreen }} />}
            {screen === "closure" && <Closure {...{ closureMode, annotate, editing, setEditing, fieldOk, setFieldOk, written, setWritten, rating, setRating }} />}
          </div>
        </div>

        {/* ===== 标注面板 ===== */}
        {annotate && (
          <div className="w-80 bg-white border border-slate-300 p-4">
            <div className="font-serif text-base border-b border-slate-300 pb-2 mb-3">待决点</div>
            <div className="space-y-3">
              {NOTES.map((n) => (
                <div key={n.n} className="flex gap-2">
                  <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 bg-rose-600 text-white font-mono text-xs rounded-full">{n.n}</span>
                  <div>
                    <div className="text-sm font-medium">
                      {n.t} <span className="font-mono text-xs text-slate-500">{n.q}</span>
                    </div>
                    <div className="text-xs text-slate-600 leading-relaxed mt-1">{n.d}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-3 border-t border-slate-200 text-xs text-slate-500 leading-relaxed">
              全部按推荐路径实现。切顶部开关看备选。A 组（载体、栈、H5 形态、轨 A 操作员、靶点范围）见《00_待确认清单》。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Sw({ label, v, set, opts }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-stone-500">{label}</span>
      {opts.map(([k, l]) => (
        <button key={k} onClick={() => set(k)}
          className={`px-2 py-0.5 border ${v === k ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-600 text-stone-400"}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

/* ============================ 1 · 晨报 ============================ */
function Digest({ carrier, density, empty, annotate, openCard, setOpenCard, disposed, setDisposed, dismissing, setDismissing, setScreen }) {
  if (empty) {
    return (
      <div>
        <Bot />
        <div className="bg-white border border-slate-200 p-4">
          <div className="font-serif text-base">今天没有需要您看的变化。</div>
          <button className="mt-3 text-sm text-teal-800 flex items-center gap-1">
            有事随时找我 <ArrowRight className="w-3 h-3" />
          </button>
        </div>
        <div className="mt-3 font-mono text-xs text-slate-400 flex items-start gap-1">
          <Info className="w-3 h-3 mt-0.5 shrink-0" />
          <span>空报是合格输出（规格 P4）。不发插图、不发"系统正常"、不发本周统计。</span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Bot />
      <div className="text-sm mb-3 leading-relaxed">
        早上好。今天有 <span className="font-mono">2</span> 条变化值得您花几分钟。
        <Pin n={10} on={annotate} />
      </div>

      <div className="space-y-3">
        {CARDS.map((c, i) => {
          const d = disposed[c.id];
          if (d) return <Done key={c.id} c={c} d={d} onTalk={() => setScreen("talk")} />;
          const open = openCard === c.id;
          const showAll = density === "full" || open;

          if (carrier === "wecom") {
            return (
              <div key={c.id} className="bg-white border border-slate-200">
                <div className="px-3 py-2 border-b border-slate-100 font-mono text-xs text-slate-400 flex justify-between">
                  <span>Clark · 战略感知</span>
                  {i === 0 && <span className="text-amber-700">模板卡片 · 字段受限<Pin n={1} on={annotate} /></span>}
                </div>
                <div className="p-3">
                  <div className="font-serif text-base leading-snug">{c.what[0].txt}</div>
                  <div className="text-sm text-slate-600 mt-2 leading-relaxed">
                    {c.why.slice(0, 78)}…
                  </div>
                  <div className="mt-2 font-mono text-xs text-slate-400">
                    四段式压缩为两段 · ③影响判断与④建议动作移入 H5
                  </div>
                  <button onClick={() => setOpenCard(open ? null : c.id)}
                    className="mt-2 text-sm text-teal-800 flex items-center gap-1">
                    看详情 <ExternalLink className="w-3 h-3" />
                  </button>
                  {open && <Detail c={c} />}
                </div>
                <Acts c={c} setDisposed={setDisposed} setDismissing={setDismissing} dismissing={dismissing} annotate={annotate} setScreen={setScreen} />
              </div>
            );
          }

          return (
            <div key={c.id} className="bg-white border border-slate-200">
              <div className="px-3 py-2 border-b border-slate-100 font-mono text-xs text-slate-400 flex justify-between">
                <span>Clark · 战略感知</span><span>{c.id}</span>
              </div>

              <div className="p-3 space-y-3">
                <Seg label="发生了什么">
                  {c.what.map((w, j) => (
                    <p key={j} className="text-sm leading-relaxed mb-1">
                      {w.txt}<Trace kind={w.k} src={w.s} />
                    </p>
                  ))}
                </Seg>

                <Seg label="影响哪条判断" strong>
                  <div className="text-sm leading-relaxed">
                    <span className="font-mono text-xs bg-slate-800 text-white px-1">{c.strat.id}</span> {c.strat.txt}
                  </div>
                  {c.hypo && (
                    <div className="text-sm leading-relaxed mt-1">
                      <span className="font-mono text-xs bg-amber-600 text-white px-1">{c.hypo.id}</span> {c.hypo.txt}
                    </div>
                  )}
                </Seg>

                {!showAll && (
                  <button onClick={() => setOpenCard(c.id)}
                    className="text-sm text-teal-800 flex items-center gap-1">
                    <ChevronRight className="w-3 h-3" /> 为何现在重要 · 建议动作
                    <Pin n={2} on={annotate && i === 0} />
                  </button>
                )}

                {showAll && (
                  <>
                    <Seg label="为何现在重要">
                      <p className="text-sm leading-relaxed">{c.why}</p>
                    </Seg>
                    <Seg label="建议动作">
                      <p className="text-sm leading-relaxed">{c.sug}<Trace kind={c.sugKind} /></p>
                    </Seg>
                    {density !== "full" && (
                      <button onClick={() => setOpenCard(null)} className="text-xs text-slate-400 font-mono flex items-center gap-1">
                        <ChevronDown className="w-3 h-3" /> 收起
                      </button>
                    )}
                  </>
                )}
              </div>

              <Acts c={c} setDisposed={setDisposed} setDismissing={setDismissing} dismissing={dismissing} annotate={annotate} setScreen={setScreen} />
            </div>
          );
        })}
      </div>

      <div className="mt-4 font-mono text-xs text-slate-400 leading-relaxed flex items-start gap-1">
        <Info className="w-3 h-3 mt-0.5 shrink-0" />
        <span>今日预算 2/3 张。第 4 条已自动顺延次日——界面不显示"还有 N 条未读"（规格 P6）。</span>
      </div>
    </div>
  );
}

function Bot() {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="w-7 h-7 bg-slate-900 text-stone-100 font-serif text-sm flex items-center justify-center">C</div>
      <div className="font-mono text-xs text-slate-500">Clark</div>
    </div>
  );
}

function Seg({ label, children, strong }) {
  return (
    <div>
      <div className={`font-mono text-xs mb-1 ${strong ? "text-slate-900" : "text-slate-400"}`}>
        {label}{strong && <span className="ml-1 text-amber-700">· 出卡门槛</span>}
      </div>
      {children}
    </div>
  );
}

function Detail({ c }) {
  return (
    <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
      <div className="font-mono text-xs text-slate-400">影响哪条判断</div>
      <div className="text-sm"><span className="font-mono text-xs bg-slate-800 text-white px-1">{c.strat.id}</span> {c.strat.txt}</div>
      <div className="font-mono text-xs text-slate-400 pt-1">建议动作</div>
      <div className="text-sm">{c.sug}</div>
    </div>
  );
}

function Acts({ c, setDisposed, setDismissing, dismissing, annotate, setScreen }) {
  const reasons = ["不相关", "已知道了", "时机不对", "判断错了"];
  if (dismissing === c.id) {
    return (
      <div className="border-t border-slate-200 p-3 bg-stone-50">
        <div className="font-mono text-xs text-slate-500 mb-2">
          为什么不看？（可跳过）<Pin n={3} on={annotate} />
        </div>
        <div className="flex flex-wrap gap-1">
          {reasons.map((r) => (
            <button key={r} onClick={() => { setDisposed((p) => ({ ...p, [c.id]: "Dismiss · " + r })); setDismissing(null); }}
              className="text-xs border border-slate-300 px-2 py-1 bg-white">{r}</button>
          ))}
          <button onClick={() => { setDisposed((p) => ({ ...p, [c.id]: "Dismiss" })); setDismissing(null); }}
            className="text-xs px-2 py-1 text-slate-400 font-mono">跳过</button>
        </div>
      </div>
    );
  }
  return (
    <div className="border-t border-slate-200 grid grid-cols-3 divide-x divide-slate-200">
      <button onClick={() => { setDisposed((p) => ({ ...p, [c.id]: "Discuss" })); setScreen("talk"); }}
        className="py-2 flex items-center justify-center gap-1 text-sm bg-slate-900 text-stone-100">
        <MessageSquare className="w-4 h-4" />聊聊
      </button>
      <button onClick={() => setDisposed((p) => ({ ...p, [c.id]: "Watch" }))}
        className="py-2 flex items-center justify-center gap-1 text-sm">
        <Eye className="w-4 h-4" />先看着
      </button>
      <button onClick={() => setDismissing(c.id)}
        className="py-2 flex items-center justify-center gap-1 text-sm text-slate-500">
        <X className="w-4 h-4" />不看
      </button>
    </div>
  );
}

function Done({ c, d, onTalk }) {
  return (
    <div className="bg-white border border-slate-200 p-3 flex items-center justify-between">
      <div className="text-sm text-slate-500 truncate pr-2">{c.what[0].txt.slice(0, 22)}…</div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="font-mono text-xs bg-teal-50 text-teal-800 border-l-2 border-teal-700 px-1">{d}</span>
        {d === "Discuss" && <button onClick={onTalk} className="text-xs text-teal-800 font-mono">进入 →</button>}
      </div>
    </div>
  );
}

/* ============================ 2 · 对谈 ============================ */
function Talk({ asmPos, annotate, asmOpen, setAsmOpen, reveal, setReveal, setScreen }) {
  const Asm = (
    <div className="bg-stone-100 border border-slate-200 p-3 space-y-2">
      <div className="font-mono text-xs text-slate-500">本次对谈装配的 Context（12 项）</div>
      {ASSEMBLY.map((g) => (
        <div key={g.g}>
          <div className="font-mono text-xs text-slate-400">{g.g}</div>
          {g.items.map((it) => (
            <div key={it} className="text-xs text-slate-700 flex gap-1 leading-relaxed">
              <CornerDownRight className="w-3 h-3 mt-0.5 shrink-0 text-slate-400" />{it}
            </div>
          ))}
        </div>
      ))}
      <div className="font-mono text-xs text-slate-400 pt-1 border-t border-slate-200">
        M03 assembly manifest · 可在 Issue 时间线回查
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-200 pb-2">
        <div className="font-mono text-xs text-slate-500">ISS-014 · Exploring</div>
        {asmPos === "drawer" && (
          <button onClick={() => setAsmOpen(!asmOpen)} className="font-mono text-xs text-teal-800 flex items-center gap-1">
            <Shield className="w-3 h-3" />Context 12<Pin n={4} on={annotate} />
          </button>
        )}
      </div>

      {asmPos === "top" && (
        <div className="bg-slate-900 text-stone-200 px-3 py-2 font-mono text-xs flex items-center justify-between">
          <span>本次对谈基于 12 项 Context<Pin n={4} on={annotate} /></span>
          <button onClick={() => setAsmOpen(!asmOpen)} className="underline">{asmOpen ? "收起" : "查看"}</button>
        </div>
      )}
      {asmPos === "top" && asmOpen && Asm}
      {asmPos === "drawer" && asmOpen && Asm}

      <Bot />
      <div className="bg-white border border-slate-200 p-3 space-y-3">
        <p className="text-sm leading-relaxed">
          关于 AIDC 的私有化诉求——我把相关的都带上了，您不用重新介绍背景。
        </p>
        {asmPos === "inline" ? (
          <div>
            <button onClick={() => setAsmOpen(!asmOpen)}
              className="font-mono text-xs text-teal-800 flex items-center gap-1">
              {asmOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              带了 12 项 Context<Pin n={4} on={annotate} />
            </button>
            {asmOpen && <div className="mt-2">{Asm}</div>}
          </div>
        ) : null}
        <p className="text-sm leading-relaxed">
          先说一句可能不中听的：这件事您 6 月已经否决过一次，当时的依据是 H-05。
          <Trace kind="human" src="D-2026-06-03" />
          现在它第二次出现，问题可能不在客户，在假设。
        </p>
      </div>

      {/* CEO */}
      <div className="flex justify-end">
        <div className="bg-slate-900 text-stone-100 p-3 max-w-xs text-sm leading-relaxed">
          那如果我们做，成本多少？
        </div>
      </div>

      {/* 挑战 */}
      <div className="bg-white border-l-4 border-rose-600 border-t border-r border-b border-slate-200 p-3 space-y-3">
        <div className="font-mono text-xs text-rose-700 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />在回答之前，两条反向挑战<Pin n={5} on={annotate} />
        </div>
        {CHALLENGES.map((ch, i) => (
          <div key={i} className="space-y-1">
            <p className="text-sm leading-relaxed">{ch.c}</p>
            <div className="font-mono text-xs text-slate-500">依据：{ch.src}</div>
            <div className="text-xs text-slate-600 leading-relaxed bg-stone-100 p-2">替代解释：{ch.alt}</div>
          </div>
        ))}
        <div className="font-mono text-xs text-slate-400 pt-1 border-t border-slate-100">
          每条挑战必须带来源 · 无来源的挑战进评估集扣分
        </div>
      </div>

      {/* Frame 出口 */}
      <div className="bg-amber-50 border border-amber-400 p-3 space-y-2">
        <div className="font-mono text-xs text-amber-800">问题已经收敛 · Decision Question</div>
        <p className="text-sm leading-relaxed font-serif">
          是否为 AIDC 线的私有化需求建立标准化交付形态，还是按单客户定制处理并接受毛利下降？
        </p>
        <div className="font-mono text-xs text-slate-600">建议承接：AIDC 线 DRI · 时限 半天</div>

        <div className="pt-2 border-t border-amber-200">
          <label className="flex items-start gap-2 text-xs leading-relaxed cursor-pointer">
            <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} className="mt-0.5" />
            <span>
              同时告诉 DRI 我的倾向<Pin n={6} on={annotate} />
              <span className="block text-slate-500 font-mono mt-0.5">
                默认关。交接包只呈现「您关注的问题」，不呈现「您的倾向」——防止 DRI 的研究结论向您收敛。
              </span>
            </span>
          </label>
        </div>

        <button onClick={() => setScreen("brief")}
          className="w-full bg-slate-900 text-stone-100 py-2 text-sm flex items-center justify-center gap-1">
          升级并交给 DRI <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      <div className="bg-white border border-slate-200 p-2 text-sm text-slate-400">说点什么…</div>
    </div>
  );
}

/* ============================ 3 · Brief ============================ */
function Brief({ annotate, setScreen }) {
  return (
    <div className="space-y-3">
      <div className="font-mono text-xs text-slate-500 border-b border-slate-200 pb-2">
        ISS-014 · ReadyForDecision · 会前 30 分钟
      </div>

      <div className="bg-white border border-slate-200 p-3 space-y-3">
        <B t="当前问题">
          <p className="text-sm font-serif leading-relaxed">
            是否为 AIDC 线的私有化需求建立标准化交付形态？
          </p>
        </B>

        <B t="DRI 推荐">
          <p className="text-sm leading-relaxed">
            建立标准形态，但限定拓扑为 VPC + 本地模型网关，不承诺完全离网。
            <Trace kind="human" src="AIDC 线 DRI" />
          </p>
        </B>

        <B t="关键 Evidence">
          <p className="text-sm leading-relaxed">
            近 6 个月 11 个在谈客户中，4 个提出过部署位置要求，其中 1 个要求完全离网。
            <Trace kind="int" src="CRM 导出 8/5" />
          </p>
        </B>
      </div>

      {/* 最强反证：独立成块，权重不低于推荐 */}
      <div className="bg-white border-2 border-rose-600 p-3">
        <div className="font-mono text-xs text-rose-700 mb-2 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />最强反证<Pin n={7} on={annotate} />
        </div>
        <p className="text-sm leading-relaxed">
          4/11 的样本量不足以判定这是趋势。若实为两个偶发个案，标准化投入将成为沉没成本，且 S-02 的红线一旦破例就难以恢复。
          <Trace kind="agent" />
        </p>
      </div>

      {/* 分歧三分类 */}
      <div className="bg-white border border-slate-200 p-3">
        <div className="font-mono text-xs text-slate-400 mb-2">开放分歧 · 3 条</div>
        <div className="space-y-2">
          {DIVERGE.map((d, i) => (
            <div key={i} className={`border-l-4 p-2 ${DIS[d.k].cls}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-xs">{DIS[d.k].label}</span>
                <span className="font-mono text-xs opacity-70">{DIS[d.k].note}</span>
              </div>
              <p className="text-sm leading-relaxed">{d.t}</p>
              <div className="font-mono text-xs opacity-70 mt-1">{d.who}</div>
            </div>
          ))}
        </div>
        <div className="font-mono text-xs text-slate-400 mt-2">
          颜色即语义 · 深色块 = 只有您能定
        </div>
      </div>

      <div className="bg-white border border-slate-200 p-3">
        <div className="font-mono text-xs text-slate-400 mb-1">建议追问</div>
        <p className="text-sm leading-relaxed">
          "另外三个提部署要求的客户，是否也会要求本地模型网关？"
        </p>
        <p className="text-xs text-slate-600 leading-relaxed mt-1 bg-stone-100 p-2">
          若是 → 这是形态问题，标准化成立；若否 → 这是个案，按定制处理。
        </p>
      </div>

      <button onClick={() => setScreen("closure")}
        className="w-full bg-slate-900 text-stone-100 py-2 text-sm flex items-center justify-center gap-1">
        会已开完 · 看 Closure 草案 <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

function B({ t, children }) {
  return (
    <div>
      <div className="font-mono text-xs text-slate-400 mb-1">{t}</div>
      {children}
    </div>
  );
}

/* ============================ 4 · Closure ============================ */
function Closure({ closureMode, annotate, editing, setEditing, fieldOk, setFieldOk, written, setWritten, rating, setRating }) {
  const allOk = CLOSURE.every((f) => fieldOk[f.k]);

  if (written) {
    return (
      <div className="space-y-3">
        <div className="bg-white border border-teal-700 border-l-4 p-3">
          <div className="flex items-center gap-2 font-serif text-base mb-2">
            <Check className="w-4 h-4 text-teal-700" />已固化并写回
          </div>
          <div className="space-y-1 font-mono text-xs text-slate-600">
            <div>Decision D-2026-08-06 · v1</div>
            <div>Hypothesis H-05 → v2（已标注修订）</div>
            <div>Evidence Action ×1 · 到期 8/20 · AIDC 线 DRI</div>
            <div>Re-open Trigger ×3 · 已布控回 Sensor 靶点</div>
            <div>ISS-014 → Monitoring</div>
          </div>
        </div>

        {rating === null ? (
          <div className="bg-stone-100 border border-slate-200 p-3">
            <div className="text-sm mb-2">这次的结果怎么样？<Pin n={9} on={annotate} /></div>
            <Stars label="结果质量" />
            <Stars label="使用体验" />
            <div className="flex gap-2 mt-2">
              <button onClick={() => setRating("done")} className="text-xs bg-slate-900 text-stone-100 px-3 py-1">提交</button>
              <button onClick={() => setRating("skip")} className="text-xs text-slate-400 font-mono px-2">跳过</button>
            </div>
          </div>
        ) : (
          <div className="font-mono text-xs text-slate-400">
            {rating === "skip" ? "已跳过 · 不再追问（规格 9.3）" : "已记录 · 进 MC-5 证据②"}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="font-mono text-xs text-slate-500 border-b border-slate-200 pb-2 flex justify-between">
        <span>ISS-014 · Closure 草案</span>
        <span className="text-teal-800">会后 26 分钟</span>
      </div>

      <div className="bg-white border border-slate-200 p-3 space-y-3">
        {CLOSURE.map((f) => (
          <div key={f.k} className="group">
            <div className="flex items-center justify-between">
              <div className="font-mono text-xs text-slate-400">{f.k}</div>
              {closureMode === "field" ? (
                <button onClick={() => setFieldOk((p) => ({ ...p, [f.k]: !p[f.k] }))}
                  className={`font-mono text-xs px-2 border ${fieldOk[f.k] ? "bg-teal-700 border-teal-700 text-white" : "border-slate-300 text-slate-500"}`}>
                  {fieldOk[f.k] ? "已确认" : "确认"}
                </button>
              ) : (
                <button onClick={() => setEditing(editing === f.k ? null : f.k)}
                  className="font-mono text-xs text-slate-400">改</button>
              )}
            </div>
            {editing === f.k ? (
              <textarea defaultValue={f.v} rows={3}
                className="w-full text-sm border border-amber-400 p-2 mt-1 leading-relaxed" />
            ) : (
              <p className="text-sm leading-relaxed mt-1">{f.v}</p>
            )}
          </div>
        ))}
      </div>

      {closureMode === "field" ? (
        <div>
          <div className="font-mono text-xs text-slate-500 mb-1">
            已确认 {CLOSURE.filter((f) => fieldOk[f.k]).length}/7<Pin n={8} on={annotate} />
          </div>
          <button disabled={!allOk} onClick={() => setWritten(true)}
            className={`w-full py-2 text-sm ${allOk ? "bg-slate-900 text-stone-100" : "bg-slate-200 text-slate-400"}`}>
            {allOk ? "写回" : "逐条确认后可写回（7 次点击）"}
          </button>
        </div>
      ) : (
        <div>
          <button onClick={() => setWritten(true)}
            className="w-full bg-slate-900 text-stone-100 py-2 text-sm flex items-center justify-center gap-1">
            <Check className="w-4 h-4" />确认并写回<Pin n={8} on={annotate} />
          </button>
          <div className="font-mono text-xs text-slate-400 mt-1 text-center">
            不改的话 1 次点击 · 任一字段点「改」即可局部修订
          </div>
        </div>
      )}
    </div>
  );
}

function Stars({ label }) {
  const [v, setV] = useState(0);
  return (
    <div className="flex items-center gap-2 mb-1">
      <span className="font-mono text-xs text-slate-500 w-16">{label}</span>
      {[1, 2, 3, 4, 5].map((i) => (
        <button key={i} onClick={() => setV(i)}>
          <Star className={`w-4 h-4 ${i <= v ? "text-amber-500" : "text-slate-300"}`} />
        </button>
      ))}
    </div>
  );
}
