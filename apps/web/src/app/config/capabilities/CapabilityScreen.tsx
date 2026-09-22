"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronLeft, Pencil } from "lucide-react";
import type { TCapabilityManagementResponse } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import g from "@/styles/capability-management.module.css";
// 顶栏与页头复用配置页同一套设计常量（UpgradeDesign.pen 三页共享 Top Navigation 与 Page Header）。
import c from "@/styles/config.module.css";

type Capability = TCapabilityManagementResponse["capabilities"][number];
type Status = { kind: "ok" | "error"; message: string } | null;

/**
 * 能力管理页只消费 GET /api/config/capabilities 一次投影：点行内铅笔编辑注册表字段，
 * 写完用 router.refresh 重读投影；能力删除不在本期范围。
 */
export function CapabilityScreen({ capabilities }: TCapabilityManagementResponse) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", group: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  function openEdit(item: Capability) {
    setDraft({ name: item.name, group: item.group, description: item.description });
    setEditingId(item.id);
    setStatus(null);
  }

  /** 401 回登录入口；成功重读服务端投影并收起弹层，失败把后端 message 原样落到页脚。 */
  async function saveCapability() {
    if (!editingId || busy) return;
    setBusy(true);
    const { response, error } = await browserApi.PATCH("/api/config/capabilities/{id}", {
      params: { path: { id: editingId } },
      body: draft,
    });
    setBusy(false);
    if (response.status === 401) {
      router.push("/access?next=/config/capabilities");
      return;
    }
    if (response.ok) {
      setStatus({ kind: "ok", message: "已保存" });
      setEditingId(null);
      router.refresh();
      return;
    }
    setStatus({ kind: "error", message: (error as { message?: string } | undefined)?.message ?? `保存失败（${response.status}）` });
  }

  return (
    <main className={c.shell}>
      <nav className={c.topbar} aria-label="能力管理页导航">
        <button type="button" className={c.back} onClick={() => router.push("/config")}>
          <ChevronLeft aria-hidden="true" /> 返回配置
        </button>
        <span className={c.draft}>配置变更写入业务库并同步 Radar 监测范围</span>
      </nav>

      <header className={c.header}>
        <p className={c.eyebrow}>CAPABILITY</p>
        <h1 className={c.title}>能力管理</h1>
        <p className={c.subtitle}>编辑已登记的组织能力：名称、分组与说明。修改后首页能力面板立即更新。</p>
      </header>

      <section className={g.card}>
        <div className={c.cardHead}>
          <h2>能力</h2>
          <p>{capabilities.length} 项已登记能力 · 点击编辑</p>
        </div>
        <div className={g.list}>
          {capabilities.map((item) => (
            <div key={item.id} className={g.row} data-editing={item.id === editingId || undefined}>
              <span className={g.dot} />
              <span className={g.rowText}>
                <span className={g.rowTitle}>{item.name}</span>
                <span className={g.rowMeta}>{item.group} · {item.description}</span>
              </span>
              <button type="button" className={g.edit} aria-label={`编辑${item.name}`} onClick={() => openEdit(item)}>
                <Pencil aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        {editingId ? (
          <div className={g.popover} role="dialog" aria-label="编辑能力">
            <p className={g.popoverTitle}>编辑能力</p>
            <label className={g.field}>
              <span>能力名称</span>
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label className={g.field}>
              <span>所属分组</span>
              <input value={draft.group} onChange={(event) => setDraft({ ...draft, group: event.target.value })} />
            </label>
            <label className={g.field}>
              <span>能力说明</span>
              <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </label>
            <span className={g.actions}>
              <button type="button" className={g.cancel} onClick={() => setEditingId(null)}>
                取消
              </button>
              <button type="button" className={g.save} onClick={saveCapability} disabled={busy || !draft.name.trim()}>
                保存
              </button>
            </span>
          </div>
        ) : null}
        <div className={g.footer}>
          <span className={g.footerHint} data-kind={status?.kind} role="status">
            {status?.message ?? "修改后立即生效，影响首页分组与议题归属显示"}
          </span>
          <button type="button" className={c.primary} onClick={() => router.push("/config")}>
            完成
            <ArrowRight aria-hidden="true" />
          </button>
        </div>
      </section>
    </main>
  );
}
