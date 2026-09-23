"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Calendar, ChevronDown, ChevronLeft, FileUp, Flag, Layers, Target } from "lucide-react";
import type { TStrategyConfigResponse } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import c from "@/styles/config.module.css";

type Person = { personId: string; displayName: string; roles: string[] };
type Battlefield = { id: string; name: string };
type Status = { kind: "ok" | "error"; message: string } | null;

/** 会前材料只接受与后端同一份白名单：PDF、DOCX、Markdown。 */
const MATERIAL_ACCEPT = ".pdf,.docx,.md";
const MAX_MATERIALS = 10;

/**
 * 配置页只做确定性表单写入 Organization Fact：登记长期目标、战场/能力、直接新建 Issue 与 Meeting。
 * 会议卡内嵌会前材料拖拽区，一次 multipart 建会；成功后进入对应决策流程页面。
 */
export function ConfigScreen({ people, battlefields, strategy }: { people: Person[]; battlefields: Battlefield[]; strategy: TStrategyConfigResponse }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [ltco, setLtco] = useState(strategy.ltco);
  const [battlefield, setBattlefield] = useState({ code: "", sortOrder: "10", name: "", ownerId: "", sixMonthOutcome: "" });
  const [capability, setCapability] = useState({ code: "", sortOrder: "20", name: "", group: "", sixMonthOutcome: "" });
  const [issue, setIssue] = useState({ title: "", battlefieldId: battlefields[0]?.id ?? "", decisionBy: "" });
  const [meeting, setMeeting] = useState({ title: "", scheduledAt: "", leadDriId: "" });
  const [materials, setMaterials] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (key: string) => (value: Status) => setStatus((prev) => ({ ...prev, [key]: value }));

  /** 统一处理 401 回登录页、成功/失败提示；成功后返回新建对象 id。 */
  async function finish(
    key: string,
    response: { status: number; ok: boolean },
    data: { cards?: { objectRef: { id: string } }[] } | undefined,
    error: unknown,
  ): Promise<string | null> {
    if (response.status === 401) {
      router.push("/access?next=/config");
      return null;
    }
    if (response.ok) {
      set(key)({ kind: "ok", message: "已创建" });
      return data?.cards?.[0]?.objectRef.id ?? null;
    }
    const message = (error as { message?: string } | undefined)?.message ?? `创建失败（${response.status}）`;
    set(key)({ kind: "error", message });
    return null;
  }

  async function createBattlefield(event: React.FormEvent) {
    event.preventDefault();
    setBusy("battlefield");
    const body = {
      code: battlefield.code,
      sortOrder: Number(battlefield.sortOrder),
      name: battlefield.name,
      ...(battlefield.ownerId ? { ownerId: battlefield.ownerId } : {}),
      sixMonthOutcome: battlefield.sixMonthOutcome,
    };
    const { data, error, response } = await browserApi.POST("/api/config/battlefields", { body });
    const id = await finish("battlefield", response, data, error);
    setBusy(null);
    if (id) {
      setBattlefield({ code: "", sortOrder: "10", name: "", ownerId: "", sixMonthOutcome: "" });
      router.push("/config/battlefields");
    }
  }

  async function createCapability(event: React.FormEvent) {
    event.preventDefault();
    setBusy("capability");
    const body = {
      code: capability.code,
      sortOrder: Number(capability.sortOrder),
      name: capability.name,
      group: capability.group,
      sixMonthOutcome: capability.sixMonthOutcome,
    };
    const { data, error, response } = await browserApi.POST("/api/config/capabilities", { body });
    if (await finish("capability", response, data, error)) setCapability({ code: "", sortOrder: "20", name: "", group: "", sixMonthOutcome: "" });
    setBusy(null);
  }

  /** LTCO 没有对象 id，只 version+1：写作后下一次月度草案即可读到新版本。 */
  async function saveStrategy(event: React.FormEvent) {
    event.preventDefault();
    setBusy("strategy");
    const { response, error } = await browserApi.PATCH("/api/config/strategy", { body: { ltco } });
    setBusy(null);
    if (response.status === 401) {
      router.push("/access?next=/config");
      return;
    }
    if (response.ok) {
      set("strategy")({ kind: "ok", message: "已保存" });
      return;
    }
    set("strategy")({ kind: "error", message: (error as { message?: string } | undefined)?.message ?? `保存失败（${response.status}）` });
  }

  async function createIssue(event: React.FormEvent) {
    event.preventDefault();
    setBusy("issue");
    const body = { title: issue.title, battlefieldId: issue.battlefieldId, ...(issue.decisionBy ? { decisionBy: issue.decisionBy } : {}) };
    const { data, error, response } = await browserApi.POST("/api/config/issues", { body });
    const id = await finish("issue", response, data, error);
    setBusy(null);
    if (id) {
      setIssue({ title: "", battlefieldId: battlefields[0]?.id ?? "", decisionBy: "" });
      router.push(`/issues/${id}`);
    }
  }

  /** 建会与材料一次提交：multipart 由浏览器设置 boundary，客户端类型生成不覆盖该场景。 */
  async function createMeeting(event: React.FormEvent) {
    event.preventDefault();
    setBusy("meeting");
    const form = new FormData();
    form.append("title", meeting.title);
    form.append("scheduledAt", meeting.scheduledAt);
    form.append("leadDriId", meeting.leadDriId);
    for (const file of materials) form.append("files", file);
    const response = await fetch("/api/config/meetings", { method: "POST", body: form });
    const body = (await response.json().catch(() => ({}))) as { message?: string; cards?: { objectRef: { id: string } }[] };
    setBusy(null);
    if (response.status === 401) {
      router.push("/access?next=/config");
      return;
    }
    if (response.ok && body.cards?.[0]) {
      router.push(`/meetings/${body.cards[0].objectRef.id}`);
      return;
    }
    set("meeting")({ kind: "error", message: body.message ?? `创建失败（${response.status}）` });
  }

  function addMaterials(list: FileList | null) {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    setMaterials((prev) => [...prev, ...picked].slice(0, MAX_MATERIALS));
  }

  const dri = people.filter((person) => person.roles.includes("dri"));
  const primary = (key: string, label: string) => (
    <button type="submit" className={c.primary} disabled={busy === key}>
      {label}
      <ArrowRight aria-hidden="true" />
    </button>
  );

  return (
    <main className={c.shell}>
      <nav className={c.topbar} aria-label="配置页导航">
        <button type="button" className={c.back} onClick={() => router.push("/")}>
          <ChevronLeft aria-hidden="true" /> 返回首页
        </button>
        <div className={c.topActions}>
          <button type="button" className={c.secondary} onClick={() => router.push("/config/missions")}>
            <Flag aria-hidden="true" /> 管理 Mission
          </button>
          <span className={c.draft}>配置变更写入业务库并同步 Radar 监测范围</span>
        </div>
      </nav>

      <header className={c.header}>
        <p className={c.eyebrow}>SETTINGS</p>
        <h1 className={c.title}>配置</h1>
        <p className={c.subtitle}>创建与管理组织级对象：会议、议题、战场与能力。新建后立刻进入对应的决策流程。</p>
      </header>

      <div className={c.grid}>
        <form className={`${c.card} ${c.ltco}`} onSubmit={saveStrategy}>
          <CardHead title="公司长期目标（LTCO）" desc="定义跨月稳定的公司结果方向，月度计划据此生成当月 PCO。" />
          <textarea
            className={c.ltcoInput}
            aria-label="公司长期目标"
            placeholder="例如：春节前，完成从战略与产品定义到核心业务第一次被真实证明的跨越。"
            value={ltco}
            onChange={(event) => setLtco(event.target.value)}
          />
          <CardFooter hint="长期目标更新后，下一次月度草案使用新版本" status={status.strategy}>
            {primary("strategy", "保存长期目标")}
          </CardFooter>
        </form>

        <form className={c.card} onSubmit={createMeeting}>
          <CardHead title="新建会议" desc="拉起一场有准备的会：上传材料 → 会前预审 → 会后复盘。" icon={<Calendar aria-hidden="true" />} />
          <Fields>
            <Field label="会议名称">
              <input value={meeting.title} placeholder="例如：Q4 定价策略评审会" onChange={(e) => setMeeting({ ...meeting, title: e.target.value })} required />
            </Field>
            <Field label="时间">
              <input type="datetime-local" value={meeting.scheduledAt} onChange={(e) => setMeeting({ ...meeting, scheduledAt: e.target.value })} required />
            </Field>
            <Field label="主持 DRI">
              <Select value={meeting.leadDriId} onChange={(value) => setMeeting({ ...meeting, leadDriId: value })} placeholder="选择 lead DRI">
                {dri.map((person) => (
                  <option key={person.personId} value={person.personId}>
                    {person.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          </Fields>
          <div
            className={c.upload}
            data-dragging={dragging || undefined}
            role="button"
            tabIndex={0}
            aria-label="上传会前材料"
            onClick={() => fileRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                fileRef.current?.click();
              }
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              addMaterials(event.dataTransfer.files);
            }}
          >
            <FileUp aria-hidden="true" className={c.uploadIcon} />
            <span className={c.uploadTitle}>上传会前材料</span>
            <span className={c.uploadHint}>
              {materials.length ? `已选择 ${materials.length} 份：${materials.map((file) => file.name).join("、")}` : "PDF、DOCX、Markdown · 可拖拽多个文件至此"}
            </span>
            <input ref={fileRef} className={c.fileInput} type="file" multiple accept={MATERIAL_ACCEPT} onChange={(event) => addMaterials(event.target.files)} />
          </div>
          <CardFooter hint="创建后进入会前预审" status={status.meeting}>
            {primary("meeting", "创建并进入会前预审")}
          </CardFooter>
        </form>

        <form className={c.card} onSubmit={createIssue}>
          <CardHead title="新建议题" desc="把一件事升格为需要拍板的议题，进入待决策队列。" icon={<Target aria-hidden="true" />} />
          <Fields>
            <Field label="议题标题">
              <input maxLength={25} value={issue.title} placeholder="例如：是否追加东南亚渠道预算 40%" onChange={(e) => setIssue({ ...issue, title: e.target.value })} required />
            </Field>
            <Field label="所属战场">
              <Select value={issue.battlefieldId} onChange={(value) => setIssue({ ...issue, battlefieldId: value })} placeholder="选择已注册战场">
                {battlefields.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="决定期限">
              <input type="date" value={issue.decisionBy} onChange={(e) => setIssue({ ...issue, decisionBy: e.target.value })} />
            </Field>
          </Fields>
          <CardFooter hint="议题进入待决策队列" status={status.issue}>
            {primary("issue", "新建议题")}
          </CardFooter>
        </form>

        <form className={`${c.card} ${c.tall}`} onSubmit={createBattlefield}>
          <CardHead title="新建战场" desc="定义一块要打赢的战场：目标、负责人与推进节奏。" icon={<Flag aria-hidden="true" />} />
          <Fields>
            <Field label="显示编号 / 顺序">
              <span className={c.pair}>
                <input value={battlefield.code} placeholder="例如：01" maxLength={40} onChange={(e) => setBattlefield({ ...battlefield, code: e.target.value })} required />
                <input
                  type="number"
                  min={0}
                  max={9999}
                  value={battlefield.sortOrder}
                  aria-label="排序"
                  onChange={(e) => setBattlefield({ ...battlefield, sortOrder: e.target.value })}
                  required
                />
              </span>
            </Field>
            <Field label="战场名称">
              <input value={battlefield.name} placeholder="例如：东南亚交付战场" onChange={(e) => setBattlefield({ ...battlefield, name: e.target.value })} required />
            </Field>
            <Field label="负责人">
              <Select value={battlefield.ownerId} onChange={(value) => setBattlefield({ ...battlefield, ownerId: value })} placeholder="待指派" required={false}>
                <option value="">待指派</option>
                {people.map((person) => (
                  <option key={person.personId} value={person.personId}>
                    {person.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="六个月目标">
              <textarea
                className={c.textarea}
                placeholder="描述春节前需要形成的真实经营结果"
                value={battlefield.sixMonthOutcome}
                onChange={(e) => setBattlefield({ ...battlefield, sixMonthOutcome: e.target.value })}
                required
              />
            </Field>
          </Fields>
          <CardFooter hint="创建后进入战场管理" status={status.battlefield}>
            <span className={c.footerActions}>
              <button type="button" className={c.secondary} onClick={() => router.push("/config/battlefields")}>
                管理战场
              </button>
              {primary("battlefield", "创建并进入战场管理")}
            </span>
          </CardFooter>
        </form>

        <form className={`${c.card} ${c.tall}`} onSubmit={createCapability}>
          <CardHead title="新建能力" desc="登记一项可复用的组织能力，供议题与计划引用。" icon={<Layers aria-hidden="true" />} />
          <Fields>
            <Field label="显示编号 / 顺序">
              <span className={c.pair}>
                <input value={capability.code} placeholder="例如：02" maxLength={40} onChange={(e) => setCapability({ ...capability, code: e.target.value })} required />
                <input
                  type="number"
                  min={0}
                  max={9999}
                  value={capability.sortOrder}
                  aria-label="排序"
                  onChange={(e) => setCapability({ ...capability, sortOrder: e.target.value })}
                  required
                />
              </span>
            </Field>
            <Field label="能力名称">
              <input value={capability.name} placeholder="例如：区域仓配服务" onChange={(e) => setCapability({ ...capability, name: e.target.value })} required />
            </Field>
            <Field label="所属分组（可选）">
              <input value={capability.group} placeholder="例如：供应链能力" onChange={(e) => setCapability({ ...capability, group: e.target.value })} />
            </Field>
            <Field label="六个月目标">
              <textarea
                className={c.textarea}
                placeholder="描述该能力在真实经营中的成熟结果"
                value={capability.sixMonthOutcome}
                onChange={(e) => setCapability({ ...capability, sixMonthOutcome: e.target.value })}
                required
              />
            </Field>
          </Fields>
          <CardFooter hint="出现在首页公司能力面板" status={status.capability}>
            <span className={c.footerActions}>
              <button type="button" className={c.secondary} onClick={() => router.push("/config/capabilities")}>
                管理能力
              </button>
              {primary("capability", "新建能力")}
            </span>
          </CardFooter>
        </form>
      </div>
    </main>
  );
}

function CardHead({ title, desc, icon }: { title: string; desc: string; icon?: ReactNode }) {
  return (
    <>
      <div className={c.cardHead}>
        <h2>{title}</h2>
        <p>{desc}</p>
      </div>
      {icon ? <span className={c.iconChip}>{icon}</span> : null}
    </>
  );
}

function Fields({ children }: { children: ReactNode }) {
  return <div className={c.fields}>{children}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={c.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Select({ value, onChange, placeholder, required = true, children }: { value: string; onChange: (value: string) => void; placeholder: string; required?: boolean; children: ReactNode }) {
  return (
    <span className={c.selectWrap}>
      <select value={value} onChange={(event) => onChange(event.target.value)} required={required}>
        <option value="" disabled={required}>
          {placeholder}
        </option>
        {children}
      </select>
      <ChevronDown aria-hidden="true" className={c.chevron} />
    </span>
  );
}

function CardFooter({ hint, status, children }: { hint: string; status: Status; children: ReactNode }) {
  return (
    <div className={c.cardFooter}>
      <span className={c.footerHint} data-kind={status?.kind} role="status">
        {status?.message ?? hint}
      </span>
      {children}
    </div>
  );
}
