import { useState } from "react";
import {
  ChevronDown, ChevronRight, ExternalLink, AlertTriangle, Check, X,
  Clock, Play, RotateCcw, Pencil, Info,
} from "lucide-react";

/* ============================================================
   Clark v1 · 运营端交互原型（桌面）
   FE-1 Issue 时间线 / FE-4 影子评审台 / FE-5 会议校对工位
   服务验收：MC-5 ① · MC-2 ② · MC-3 ③
   ============================================================ */

const TRACE = {
  ext:   { label: "外部事实", bar: "border-sky-600",   text: "text-sky-800",   bg: "bg-sky-50" },
  int:   { label: "内部事实", bar: "border-teal-700",  text: "text-teal-800",  bg: "bg-teal-50" },
  human: { label: "人的判断", bar: "border-slate-700", text: "text-slate-800", bg: "bg-slate-100" },
  agent: { label: "Agent 推演", bar: "border-amber-600", text: "text-amber-800", bg: "bg-amber-50" },
};
function Trace({ kind, src }) {
  const t = TRACE[kind];
  return (
    <span className={`inline-flex items-center gap-1 border-l-2 ${t.bar} ${t.bg} ${t.text} px-1 ml-1 font-mono text-xs align-middle`}>
      {t.label}{src ? <span className="opacity-60">· {src}</span> : null}
      <ExternalLink className="w-3 h-3 opacity-50" />
    </span>
  );
}

function Note({ children }) {
  return (
    <div className="font-mono text-xs text-slate-500 flex items-start gap-1 leading-relaxed">
      <Info className="w-3 h-3 mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/* ---------- FE-1 时间线数据：8 类事件（B-7 待与 05 冻结） ---------- */
const EV_KIND = {
  state:   { label: "状态迁移",     dot: "bg-slate-900",  open: true },
  signal:  { label: "Signal 进入",  dot: "bg-sky-600",    open: false },
  talk:    { label: "对谈",         dot: "bg-slate-400",  open: false },
  deep:    { label: "深研完成",     dot: "bg-amber-600",  open: false },
  handoff: { label: "DRI 交接发出", dot: "bg-slate-900",  open: true },
  judg:    { label: "Judgment 回传", dot: "bg-slate-900", open: true },
  decision:{ label: "Decision 固化", dot: "bg-teal-700",  open: true },
  trigger: { label: "Trigger 命中", dot: "bg-rose-600",   open: true },
};

const TIMELINE = [
  { k: "decision", t: "8/6 15:42", h: "Decision D-2026-08-06 v1 已固化", by: "刘明华 确认",
    d: "Choose：建立标准化私有化形态，限定 VPC + 本地模型网关。写回 Hypothesis H-05→v2，布控 3 条 Re-open Trigger，登记 1 条 Evidence Action（到期 8/20）。" },
  { k: "state", t: "8/6 15:42", h: "ReadyForDecision → Decided", by: "系统" },
  { k: "judg", t: "8/6 11:20", h: "AIDC 线 DRI 回传 Judgment", by: "DRI",
    d: "当前判断：建立标准形态但限定拓扑。关键 Evidence：11 个在谈客户中 4 个提出部署位置要求。反证：4/11 样本量不足。不确定性：完全离网的成本结构未测算。" },
  { k: "state", t: "8/6 09:05", h: "Exploring → Researching", by: "系统" },
  { k: "handoff", t: "8/6 09:05", h: "交接包已发出 · 六要素 · 默认脱敏", by: "刘明华 确认升级",
    d: "呈现「CEO 关注的问题」，未披露倾向（披露开关为关）。时限：半天。" },
  { k: "talk", t: "8/6 08:31", h: "对谈 3 轮 · Explore → Challenge → Frame", by: "刘明华 × Clark",
    d: "装配 12 项 Context（含 D-2026-06-03 否决先例与 Decision Memory 1 条）。产出 Decision Question。" },
  { k: "state", t: "8/6 08:22", h: "Candidate → Exploring（Discuss）", by: "刘明华" },
  { k: "signal", t: "8/5 22:10", h: "候选卡片生成 · 经影子评审放行", by: "Clark → 陪跑评审",
    d: "聚簇 3 条信号：竞品私有化发布（外部）、AIDC 客户会纪要（内部）、7/29 周会发言（主观）。关联判定：S-02 强 / H-05 强。评审精度分：该发。" },
];

/* ---------- FE-4 影子评审队列 ---------- */
const QUEUE = [
  { id: "C-0412", h: "竞品「智策」发布私有化部署版，定价为标准版 2.4 倍", s: "S-02 强 / H-05 强", st: "pending" },
  { id: "C-0413", h: "某券商研报提及 AI Agent 赛道融资节奏放缓", s: "无关联", st: "pending" },
  { id: "C-0414", h: "房懂懂线 7 月毛利率环比下降 4.2 个百分点", s: "S-04 强", st: "pending" },
  { id: "C-0411", h: "行业大会将于 9 月召开", s: "无关联", st: "rejected" },
  { id: "C-0410", h: "AIDC 客户会提出数据不出内网", s: "S-02 强", st: "passed" },
];
const REASONS = ["靶点问题", "关联判定错", "事实有误", "重复信号", "时机不对", "表述差"];

/* ---------- FE-5 转写分段 ---------- */
const SEGS = [
  { t: "00:00:12", sp: "刘明华", x: "我们先把问题定清楚。今天不是讨论要不要接这个客户，是讨论私有化这件事本身是不是产品形态。" },
  { t: "00:01:44", sp: "未识别", x: "从交付角度看，VPC 那套我们其实跑过一次，主要成本在模型网关的适配上。" },
  { t: "00:03:02", sp: "AIDC DRI", x: "但完全离网是另一回事。ASR 和推理都要落地，那个成本结构我们还没测过。" },
  { t: "00:04:30", sp: "未识别", x: "十一个在谈客户里有四个提过部署位置，其中只有一个要完全离网。" },
  { t: "00:06:15", sp: "刘明华", x: "四比十一说明不了趋势。这个数字我要打个问号。" },
];
const SPEAKERS = ["刘明华", "AIDC DRI", "财务 DRI", "产品 DRI", "未识别"];

/* ============================ 主组件 ============================ */
export default function ClarkOpsDesktop() {
  const [tab, setTab] = useState("timeline");
  return (
    <div className="min-h-screen bg-stone-100 text-slate-900">
      <div className="bg-slate-900 text-stone-100 px-6 py-3">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <span className="font-serif text-lg">Clark v1 · 运营端原型</span>
            <span className="font-mono text-xs text-stone-400 ml-3">桌面 · 内部工具：功能不能缺，视觉可以粗糙</span>
          </div>
          <div className="flex gap-1">
            {[["timeline", "FE-1 Issue 时间线"], ["shadow", "FE-4 影子评审台"], ["proof", "FE-5 校对工位"]].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`font-mono text-xs px-3 py-1 border ${tab === k ? "bg-stone-100 text-slate-900 border-stone-100" : "border-slate-700 text-stone-400"}`}>
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6">
        {tab === "timeline" && <Timeline />}
        {tab === "shadow" && <Shadow />}
        {tab === "proof" && <Proof />}
      </div>
    </div>
  );
}

/* ============================ FE-1 ============================ */
function Timeline() {
  const [open, setOpen] = useState({});
  return (
    <div className="grid grid-cols-3 gap-6">
      {/* 列表：按"需要你判断的"排前，不按时间 */}
      <div className="col-span-1 space-y-4">
        <div>
          <div className="font-mono text-xs text-amber-700 mb-2">需要判断 · 1</div>
          <div className="bg-white border-l-4 border-amber-500 border-t border-r border-b border-slate-200 p-3">
            <div className="font-mono text-xs text-slate-400 mb-1">ISS-016 · ReadyForDecision</div>
            <div className="text-sm leading-snug">词元云集 9 月是否承接第二家灯塔级客户</div>
          </div>
        </div>
        <div>
          <div className="font-mono text-xs text-slate-500 mb-2">进行中 · 2</div>
          <div className="space-y-2">
            <div className="bg-white border border-slate-900 border-l-4 p-3">
              <div className="font-mono text-xs text-slate-400 mb-1">ISS-014 · Monitoring</div>
              <div className="text-sm leading-snug">AIDC 私有化诉求与产品通用化路线的冲突</div>
              <div className="font-mono text-xs text-teal-800 mt-1">当前查看</div>
            </div>
            <div className="bg-white border border-slate-200 p-3">
              <div className="font-mono text-xs text-slate-400 mb-1">ISS-015 · Watching</div>
              <div className="text-sm leading-snug">房懂懂线交付人力占比上升</div>
            </div>
          </div>
        </div>
        <Note>不做看板、不做筛选器矩阵、不做标签体系。v1 的 Issue 是个位数，任何筛选 UI 都是过度设计（规格 4.4）。</Note>
      </div>

      {/* 时间线 */}
      <div className="col-span-2">
        <div className="bg-slate-900 text-stone-100 p-4 mb-4">
          <div className="font-mono text-xs text-stone-400">ISS-014 · Monitoring</div>
          <div className="font-serif text-xl mt-1">AIDC 私有化诉求与产品通用化路线的冲突</div>
          <div className="font-mono text-xs text-teal-300 mt-2">目前不需要您做什么 · 已布控 3 条 Re-open Trigger</div>
        </div>

        <div className="bg-white border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="font-serif text-base">Context 时间线</div>
            <div className="font-mono text-xs text-slate-400">9 个事件 · 倒序 · 全程可回放（MC-5 证据①）</div>
          </div>

          <div className="space-y-0">
            {TIMELINE.map((e, i) => {
              const kind = EV_KIND[e.k];
              const isOpen = open[i] ?? kind.open;
              return (
                <div key={i} className="flex gap-3">
                  <div className="flex flex-col items-center shrink-0 pt-1">
                    <div className={`w-2 h-2 ${kind.dot} rounded-full`} />
                    {i < TIMELINE.length - 1 && <div className="w-px flex-1 bg-slate-200" />}
                  </div>
                  <div className="pb-5 flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-mono text-xs text-slate-400">{e.t}</span>
                      <span className="font-mono text-xs text-slate-500">{kind.label}</span>
                    </div>
                    <div className="flex items-start justify-between gap-2 mt-1">
                      <div className="text-sm leading-snug">{e.h}</div>
                      {e.d && (
                        <button onClick={() => setOpen((p) => ({ ...p, [i]: !isOpen }))}
                          className="shrink-0 text-slate-400">
                          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                    {e.by && <div className="font-mono text-xs text-slate-400 mt-0.5">{e.by}</div>}
                    {e.d && isOpen && (
                      <div className="text-sm text-slate-700 leading-relaxed bg-stone-50 border border-slate-100 p-2 mt-2">
                        {e.d}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="border-t border-slate-200 pt-3">
            <Note>
              折叠规则依据 P1：组织动作与状态迁移导向判断（默认展开），过程性内容不导向判断（默认折叠）。
              事件类型全集 8 类为 B-7 待决点，需与 05 的对象模型对齐后冻结。
            </Note>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================ FE-4 ============================ */
function Shadow() {
  const [sel, setSel] = useState("C-0412");
  const [verdict, setVerdict] = useState({});
  const [why, setWhy] = useState({});
  const card = QUEUE.find((q) => q.id === sel);
  const v = verdict[sel];

  return (
    <div>
      {/* 门槛条 */}
      <div className="bg-white border border-slate-200 p-4 mb-4 flex flex-wrap items-center gap-8">
        <Stat k="本周精度" v="64%" sub="该发 / 总评审" tone="amber" />
        <Stat k="放闸门槛" v="≥70%" sub="A8 待定标" tone="slate" />
        <Stat k="距门槛" v="-6pt" sub="不达标不放闸" tone="rose" />
        <Stat k="影子第几天" v="D3 / 14" sub="⚠8/11 启动" tone="slate" />
        <div className="ml-auto font-mono text-xs text-slate-500 max-w-xs leading-relaxed">
          未过精度门不见 CEO——第一印象只有一次（MC-2 关键路径）
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* 队列 */}
        <div className="col-span-1 space-y-2">
          <div className="font-mono text-xs text-slate-500">候选队列 · 8/6</div>
          {QUEUE.map((q) => (
            <button key={q.id} onClick={() => setSel(q.id)}
              className={`w-full text-left bg-white border p-3 ${sel === q.id ? "border-slate-900 border-l-4" : "border-slate-200"}`}>
              <div className="flex justify-between items-center mb-1">
                <span className="font-mono text-xs text-slate-400">{q.id}</span>
                {q.st === "passed" && <span className="font-mono text-xs text-teal-800">已放行</span>}
                {q.st === "rejected" && <span className="font-mono text-xs text-rose-700">已退回</span>}
              </div>
              <div className="text-sm leading-snug">{q.h}</div>
              <div className={`font-mono text-xs mt-1 ${q.s === "无关联" ? "text-rose-700" : "text-slate-500"}`}>{q.s}</div>
            </button>
          ))}
        </div>

        {/* 评审面板 */}
        <div className="col-span-2 bg-white border border-slate-200 p-4 space-y-4">
          <div>
            <div className="font-mono text-xs text-slate-400 mb-1">{card.id}</div>
            <div className="font-serif text-lg leading-snug">{card.h}</div>
          </div>

          <div className="bg-stone-50 border border-slate-100 p-3 space-y-2">
            <div>
              <div className="font-mono text-xs text-slate-400">发生了什么</div>
              <p className="text-sm leading-relaxed">
                竞品「智策」8/3 发布私有化部署版本，公开定价为标准版 2.4 倍。
                <Trace kind="ext" src="厂商官网" />
              </p>
            </div>
            <div>
              <div className="font-mono text-xs text-slate-400">影响哪条判断 <span className="text-amber-700">· 出卡门槛</span></div>
              <p className="text-sm leading-relaxed">
                <span className="font-mono text-xs bg-slate-800 text-white px-1">S-02</span> 产品化优先于项目化
                <span className="font-mono text-xs bg-amber-600 text-white px-1 ml-2">H-05</span> 客户接受 VPC 部署
              </p>
            </div>
          </div>

          {/* 精度评分 */}
          <div>
            <div className="font-mono text-xs text-slate-500 mb-2">这张卡该不该发给 CEO？</div>
            <div className="flex gap-2">
              {[["yes", "该发", "bg-teal-700"], ["edge", "边缘", "bg-amber-600"], ["no", "不该发", "bg-rose-700"]].map(([k, l, c]) => (
                <button key={k} onClick={() => setVerdict((p) => ({ ...p, [sel]: k }))}
                  className={`px-4 py-2 text-sm border ${v === k ? `${c} text-white border-transparent` : "border-slate-300"}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          {/* 归因：不该发时必填 */}
          {(v === "no" || v === "edge") && (
            <div className="border-l-4 border-rose-600 bg-rose-50 p-3">
              <div className="font-mono text-xs text-rose-800 mb-2 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />归因（必填）
              </div>
              <div className="flex flex-wrap gap-1">
                {REASONS.map((r) => (
                  <button key={r} onClick={() => setWhy((p) => ({ ...p, [sel]: r }))}
                    className={`text-xs px-2 py-1 border ${why[sel] === r ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-300"}`}>
                    {r}
                  </button>
                ))}
              </div>
              <div className="font-mono text-xs text-slate-600 mt-2 leading-relaxed">
                归因是这一页最重要的字段。MC-2 风险栏写着「精度不达标 → 复盘归因（靶点质量 vs 管道质量）」——
                没有这个字段，那条风险处理就是空话。
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-2 border-t border-slate-200">
            <button className="px-4 py-2 text-sm bg-slate-900 text-stone-100 flex items-center gap-1">
              <Check className="w-4 h-4" />放行
            </button>
            <button className="px-4 py-2 text-sm border border-slate-300 flex items-center gap-1">
              <RotateCcw className="w-4 h-4" />退回
            </button>
            <button className="px-4 py-2 text-sm border border-slate-300 flex items-center gap-1">
              <Pencil className="w-4 h-4" />改写后放行
            </button>
            <span className="ml-auto font-mono text-xs text-slate-400 self-center">改写内容入训练数据</span>
          </div>

          <Note>
            8/11 就要用的界面，也是 MC-2 证据②的数据产生现场。8 月完全可以先用表格兜底——
            但归因字段和放闸门槛必须在，否则 8/22 的放闸评估无法归因。
          </Note>
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v, sub, tone }) {
  const c = { amber: "text-amber-700", rose: "text-rose-700", slate: "text-slate-900" }[tone];
  return (
    <div>
      <div className="font-mono text-xs text-slate-400">{k}</div>
      <div className={`font-serif text-2xl ${c}`}>{v}</div>
      <div className="font-mono text-xs text-slate-400">{sub}</div>
    </div>
  );
}

/* ============================ FE-5 ============================ */
function Proof() {
  const [segs, setSegs] = useState(SEGS);
  const [submitted, setSubmitted] = useState(false);
  const unknown = segs.filter((s) => s.sp === "未识别").length;

  const setSp = (i, sp) => setSegs((p) => p.map((s, j) => (j === i ? { ...s, sp } : s)));

  return (
    <div className="grid grid-cols-3 gap-6">
      <div className="col-span-2 bg-white border border-slate-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div>
            <div className="font-serif text-base">8/6 EXCO · 私有化交付形态</div>
            <div className="font-mono text-xs text-slate-400">92 分钟 · 已转写 · 待校对</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-xs text-slate-400 flex items-center gap-1 justify-end">
              <Clock className="w-3 h-3" />SLA 倒计时
            </div>
            <div className="font-serif text-2xl text-amber-700">18:24</div>
          </div>
        </div>

        <div className="divide-y divide-slate-100">
          {segs.map((s, i) => (
            <div key={i} className="p-3 flex gap-3">
              <button className="shrink-0 font-mono text-xs text-teal-800 flex items-start gap-1 pt-0.5">
                <Play className="w-3 h-3" />{s.t}
              </button>
              <select value={s.sp} onChange={(e) => setSp(i, e.target.value)}
                className={`shrink-0 text-xs border px-1 py-0.5 h-6 ${s.sp === "未识别" ? "border-rose-500 text-rose-700 bg-rose-50" : "border-slate-300"}`}>
                {SPEAKERS.map((sp) => <option key={sp}>{sp}</option>)}
              </select>
              <textarea defaultValue={s.x} rows={2}
                className="flex-1 text-sm leading-relaxed border border-transparent hover:border-slate-200 focus:border-amber-400 p-1 resize-none" />
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-slate-200 flex items-center gap-3">
          <button onClick={() => setSubmitted(true)}
            disabled={unknown > 0}
            className={`px-4 py-2 text-sm ${unknown > 0 ? "bg-slate-200 text-slate-400" : "bg-slate-900 text-stone-100"}`}>
            {unknown > 0 ? `还有 ${unknown} 段未标说话人` : "提交校对 · 触发结构化抽取"}
          </button>
          {submitted && (
            <span className="font-mono text-xs text-teal-800 flex items-center gap-1">
              <Check className="w-3 h-3" />抽取中 · 预计 4 分钟后产出 Decision State
            </span>
          )}
        </div>
      </div>

      <div className="col-span-1 space-y-4">
        <div className="bg-white border border-slate-200 p-4">
          <div className="font-serif text-base mb-2">为什么这一页是 P0</div>
          <p className="text-sm text-slate-700 leading-relaxed">
            MC-1 把秘书卡降为辅助，但明确说「降的是验收地位，不是工作本身」。
            MC-3 关键路径原文：会后批处理管道 = 采购 ASR + <span className="bg-amber-100">秘书校对工位</span> + 结构化抽取。
            没有这个界面，30 分钟 SLA 不成立。
          </p>
        </div>

        <div className="bg-white border border-slate-200 p-4 space-y-2">
          <div className="font-mono text-xs text-slate-500">设计要点</div>
          <p className="text-sm leading-relaxed">
            说话人是<span className="font-medium">下拉选择</span>不是输入框——与会者是已知的封闭集合。
            v1 说话人分离可全人工（M08 FR3）。
          </p>
          <p className="text-sm leading-relaxed">
            SLA 倒计时是给操作员的压力表，不是装饰。
          </p>
          <p className="text-sm leading-relaxed">
            未标说话人时提交按钮禁用——分歧归属错会直接污染 Decision State 的四分类。
          </p>
        </div>

        <div className="bg-amber-50 border-l-4 border-amber-500 p-4">
          <div className="font-mono text-xs text-amber-800 mb-1">A-4 待定</div>
          <p className="text-sm leading-relaxed">
            轨 A 是词元云集内部，没有灯塔董办。<span className="font-medium">谁坐在这个工位上？</span>
            默认路径：陪跑团队指定 1 人兼任，与影子评审同一人。8/7 需确认。
          </p>
        </div>
      </div>
    </div>
  );
}
