"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Upload } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import { TianshuMark } from "@/components/TianshuMark";
import c from "@/styles/config.module.css";

type Person = { personId: string; displayName: string; roles: string[] };
type Battlefield = { id: string; name: string };
type Status = { kind: "ok" | "error"; message: string } | null;

/**
 * 配置页只做确定性表单写入 Organization Fact：注册战场/能力、直接新建 Issue 与 Meeting。
 * 会前材料不在本页二段上传，Meeting 建好后跳转会议页上传。
 */
export function ConfigScreen({ people, battlefields }: { people: Person[]; battlefields: Battlefield[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [battlefield, setBattlefield] = useState({ name: "", owner: "", goal: "" });
  const [capability, setCapability] = useState({ name: "", group: "", description: "" });
  const [issue, setIssue] = useState({ title: "", battlefieldId: battlefields[0]?.id ?? "", decisionBy: "" });
  const [meeting, setMeeting] = useState({ title: "", scheduledAt: "", leadDriId: "" });
  const [status, setStatus] = useState<Record<string, Status>>({});

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
    const { data, error, response } = await browserApi.POST("/api/config/battlefields", { body: battlefield });
    if (await finish("battlefield", response, data, error)) setBattlefield({ name: "", owner: "", goal: "" });
    setBusy(null);
  }

  async function createCapability(event: React.FormEvent) {
    event.preventDefault();
    setBusy("capability");
    const { data, error, response } = await browserApi.POST("/api/config/capabilities", { body: capability });
    if (await finish("capability", response, data, error)) setCapability({ name: "", group: "", description: "" });
    setBusy(null);
  }

  async function createIssue(event: React.FormEvent) {
    event.preventDefault();
    setBusy("issue");
    const body = { title: issue.title, battlefieldId: issue.battlefieldId, ...(issue.decisionBy ? { decisionBy: issue.decisionBy } : {}) };
    const { data, error, response } = await browserApi.POST("/api/config/issues", { body });
    const id = await finish("issue", response, data, error);
    if (id) {
      setIssue({ title: "", battlefieldId: battlefields[0]?.id ?? "", decisionBy: "" });
      router.push(`/issues/${id}`);
    }
    setBusy(null);
  }

  async function createMeeting(event: React.FormEvent) {
    event.preventDefault();
    setBusy("meeting");
    const { data, error, response } = await browserApi.POST("/api/config/meetings", { body: meeting });
    const id = await finish("meeting", response, data, error);
    if (id) router.push(`/meetings/${id}`);
    setBusy(null);
  }

  const dri = people.filter((person) => person.roles.includes("dri"));

  return (
    <main className={c.shell}>
      <nav className={c.topbar} aria-label="配置页导航">
        <button type="button" className={c.back} onClick={() => router.push("/")}>
          <ArrowLeft aria-hidden="true" /> 返回首页
        </button>
        <span className={c.mark}>
          <TianshuMark /> 天枢
        </span>
      </nav>

      <header className={c.header}>
        <h1>SETTINGS</h1>
        <p>把公司级事实一次性登记清楚：战场、能力、议题与会议。这里写入的是唯一事实源，首页与会议页读取同一份投影。</p>
      </header>

      <div className={c.grid}>
        <form className={c.card} onSubmit={createBattlefield}>
          <h2>新建战场</h2>
          <p className={c.hint}>战场是战略议题的归属容器，注册后才能把 Issue 放进去。</p>
          <label className={c.field}>
            <span>战场名称</span>
            <input value={battlefield.name} onChange={(e) => setBattlefield({ ...battlefield, name: e.target.value })} required />
          </label>
          <label className={c.field}>
            <span>负责人</span>
            <input value={battlefield.owner} onChange={(e) => setBattlefield({ ...battlefield, owner: e.target.value })} required />
          </label>
          <label className={c.field}>
            <span>目标</span>
            <textarea value={battlefield.goal} onChange={(e) => setBattlefield({ ...battlefield, goal: e.target.value })} required />
          </label>
          <Footer status={status.battlefield} busy={busy === "battlefield"} label="注册战场" />
        </form>

        <form className={c.card} onSubmit={createCapability}>
          <h2>新建能力</h2>
          <p className={c.hint}>注册的能力分组会直接出现在首页公司能力面板，不必等有 Issue 才可见。</p>
          <label className={c.field}>
            <span>能力名称</span>
            <input value={capability.name} onChange={(e) => setCapability({ ...capability, name: e.target.value })} required />
          </label>
          <label className={c.field}>
            <span>所属分组</span>
            <input value={capability.group} onChange={(e) => setCapability({ ...capability, group: e.target.value })} required />
          </label>
          <label className={c.field}>
            <span>说明</span>
            <textarea value={capability.description} onChange={(e) => setCapability({ ...capability, description: e.target.value })} required />
          </label>
          <Footer status={status.capability} busy={busy === "capability"} label="注册能力" />
        </form>

        <form className={c.card} onSubmit={createIssue}>
          <h2>新建议题</h2>
          <p className={c.hint}>一号位直接建 Issue，创建后照常进入预研，与其他来源的议题走同一条决策链路。</p>
          <label className={c.field}>
            <span>标题（不超过 25 字）</span>
            <input maxLength={25} value={issue.title} onChange={(e) => setIssue({ ...issue, title: e.target.value })} required />
          </label>
          <label className={c.field}>
            <span>所属战场</span>
            <select value={issue.battlefieldId} onChange={(e) => setIssue({ ...issue, battlefieldId: e.target.value })} required>
              <option value="" disabled>
                选择已注册战场
              </option>
              {battlefields.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className={c.field}>
            <span>决策期限（可选）</span>
            <input type="date" value={issue.decisionBy} onChange={(e) => setIssue({ ...issue, decisionBy: e.target.value })} />
          </label>
          <Footer status={status.issue} busy={busy === "issue"} label="新建议题" />
        </form>

        <form className={c.card} onSubmit={createMeeting}>
          <h2>新建会议</h2>
          <p className={c.hint}>先建会议，再在会议页挂议题、传会前材料。创建成功后直接进入会议页。</p>
          <label className={c.field}>
            <span>会议主题</span>
            <input value={meeting.title} onChange={(e) => setMeeting({ ...meeting, title: e.target.value })} required />
          </label>
          <label className={c.field}>
            <span>会议时间</span>
            <input type="datetime-local" value={meeting.scheduledAt} onChange={(e) => setMeeting({ ...meeting, scheduledAt: e.target.value })} required />
          </label>
          <label className={c.field}>
            <span>一号位负责人</span>
            <select value={meeting.leadDriId} onChange={(e) => setMeeting({ ...meeting, leadDriId: e.target.value })} required>
              <option value="" disabled>
                选择 lead DRI
              </option>
              {dri.map((person) => (
                <option key={person.personId} value={person.personId}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={c.dropzone} disabled={busy === "meeting"}>
            <Upload aria-hidden="true" />
            创建 Meeting 并前往上传会前材料
          </button>
          <StatusLine status={status.meeting} />
        </form>
      </div>
    </main>
  );
}

function Footer({ status, busy, label }: { status: Status; busy: boolean; label: string }) {
  return (
    <>
      <button type="submit" className={c.submit} disabled={busy}>
        {label}
      </button>
      <StatusLine status={status} />
    </>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (!status) return null;
  return (
    <p className={c.status} data-kind={status.kind} role="status">
      {status.message}
    </p>
  );
}
