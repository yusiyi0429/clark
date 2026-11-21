import { randomUUID } from "node:crypto";
import { FeishuApiError } from "./client.js";

/**
 * 飞书多维表格的适配层（③ 信息收集：大家共填一张表）。天枢这边存一份镜像（collection_entries），
 * 后台同步时经这里建表、写行、读回飞书里的改动。
 * - live：以发起人本人的身份（user access token）调开放接口；要在飞书后台开通的用户身份权限（scope 名以后台为准，上线前核对）：
 *   base:app:create、base:table:read、base:table:create、base:record:create、base:record:update、base:record:retrieve、docs:permission.member:create。
 * - mock：进程内的假表，不调飞书（权限没开通前、测试里用）；没有可打开的链接。
 */
export type BitableApp = { appToken: string; url: string | null };
export type BitableTable = BitableApp & { tableId: string };
export type BitableColumn = { name: string; type: "text" | "number" | "checkbox" };
export type BitableCell = string | number | boolean;
export type BitableRecord = { recordId: string; fields: Record<string, unknown> };

export type BitableAdapter = {
  readonly mode: "live" | "mock";
  /** 新建一个多维表格。 */
  createApp(input: { accessToken: string; name: string }): Promise<BitableApp>;
  /** 在这个多维表格里找同名的数据表，返回 table_id；没有返回 null。 */
  findTable(input: { accessToken: string; appToken: string; name: string }): Promise<string | null>;
  /** 在这个多维表格里新建一张数据表，返回 table_id。 */
  createTable(input: { accessToken: string; appToken: string; name: string; columns: BitableColumn[] }): Promise<string>;
  /** 把一个人加成可编辑协作者。 */
  addEditor(input: { accessToken: string; appToken: string; openId: string }): Promise<void>;
  /** recordId 为空时新增一行，否则覆盖这一行给出的栏。返回这一行的 record_id。 */
  upsertRecord(input: { accessToken: string; table: BitableTable; recordId: string | null; fields: Record<string, BitableCell> }): Promise<string>;
  listRecords(input: { accessToken: string; table: BitableTable }): Promise<BitableRecord[]>;
};

const OPEN_API = "https://open.feishu.cn/open-apis";
const TIMEOUT_MS = 10_000;
const FIELD_TYPE: Record<BitableColumn["type"], number> = { text: 1, number: 2, checkbox: 7 };

/** 读回来的单元格换成文字：文本栏是 [{text}] 片段数组，数字、勾选直接是值。 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text ?? "") : cellText(part))).join("");
  if (typeof value === "object" && "link" in value) return String((value as { link: unknown }).link ?? "");
  return "";
}

export function createMockBitable(): BitableAdapter & { tables: Map<string, { name: string; columns: BitableColumn[]; rows: Map<string, Record<string, BitableCell>> }> } {
  const tables = new Map<string, { name: string; columns: BitableColumn[]; rows: Map<string, Record<string, BitableCell>> }>();
  // 假表只在进程里：重启后按原来的 token 重新挂一张空表，天枢的镜像再推一遍。
  const table = (ref: BitableTable) => {
    const key = `${ref.appToken}/${ref.tableId}`;
    if (!tables.has(key)) tables.set(key, { name: "", columns: [], rows: new Map() });
    return tables.get(key)!;
  };
  return {
    mode: "mock",
    tables,
    async createApp() {
      return { appToken: `mock_app_${randomUUID().slice(0, 8)}`, url: null };
    },
    async findTable({ appToken, name }) {
      const found = [...tables].find(([key, item]) => key.startsWith(`${appToken}/`) && item.name === name);
      return found ? found[0].slice(appToken.length + 1) : null;
    },
    async createTable({ appToken, name, columns }) {
      const tableId = `mock_tbl_${randomUUID().slice(0, 8)}`;
      tables.set(`${appToken}/${tableId}`, { name, columns, rows: new Map() });
      return tableId;
    },
    async addEditor() {},
    async upsertRecord({ table: ref, recordId, fields }) {
      const rows = table(ref).rows;
      const id = recordId ?? `rec_${randomUUID().slice(0, 10)}`;
      rows.set(id, { ...(rows.get(id) ?? {}), ...fields });
      return id;
    },
    async listRecords({ table: ref }) {
      return [...table(ref).rows].map(([recordId, fields]) => ({ recordId, fields: { ...fields } }));
    },
  };
}

type Fetch = typeof fetch;

export function createFeishuBitable({ fetch: fetchImpl = fetch }: { fetch?: Fetch } = {}): BitableAdapter {
  async function call(accessToken: string, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetchImpl(`${OPEN_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=utf-8" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { throw new FeishuApiError(0, `飞书多维表格接口返回了非 JSON 响应（HTTP ${response.status}）`); }
    const code = Number(parsed.code ?? -1);
    if (code !== 0) throw new FeishuApiError(code, `飞书多维表格接口失败：${String(parsed.msg ?? "未知错误")}`);
    return (parsed.data ?? {}) as Record<string, unknown>;
  }

  return {
    mode: "live",
    async createApp({ accessToken, name }) {
      const app = (await call(accessToken, "POST", "/bitable/v1/apps", { name })).app as { app_token?: string; url?: string } | undefined;
      if (!app?.app_token) throw new FeishuApiError(0, "新建多维表格没有返回 app_token");
      return { appToken: app.app_token, url: app.url ?? null };
    },
    async findTable({ accessToken, appToken, name }) {
      // 天枢自己新建的多维表格，里面只有默认表和这一张，一页就够。
      const listed = await call(accessToken, "GET", `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables?page_size=100`);
      const found = ((Array.isArray(listed.items) ? listed.items : []) as { table_id?: string; name?: string }[]).find((item) => item.name === name);
      return found?.table_id ?? null;
    },
    async createTable({ accessToken, appToken, name, columns }) {
      const created = await call(accessToken, "POST", `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, {
        table: { name, default_view_name: "全部", fields: columns.map((column) => ({ field_name: column.name, type: FIELD_TYPE[column.type] })) },
      });
      const tableId = String(created.table_id ?? "");
      if (!tableId) throw new FeishuApiError(0, "新建数据表没有返回 table_id");
      return tableId;
    },
    async addEditor({ accessToken, appToken, openId }) {
      await call(accessToken, "POST", `/drive/v1/permissions/${encodeURIComponent(appToken)}/members?type=bitable&need_notification=false`,
        { member_type: "openid", member_id: openId, perm: "edit" });
    },
    async upsertRecord({ accessToken, table, recordId, fields }) {
      const base = `/bitable/v1/apps/${encodeURIComponent(table.appToken)}/tables/${encodeURIComponent(table.tableId)}/records`;
      const data = recordId
        ? await call(accessToken, "PUT", `${base}/${encodeURIComponent(recordId)}`, { fields })
        : await call(accessToken, "POST", base, { fields });
      const id = (data.record as { record_id?: string } | undefined)?.record_id ?? recordId;
      if (!id) throw new FeishuApiError(0, "写入多维表格没有返回 record_id");
      return id;
    },
    async listRecords({ accessToken, table }) {
      const records: BitableRecord[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const query = new URLSearchParams({ page_size: "500", ...(pageToken ? { page_token: pageToken } : {}) });
        const data = await call(accessToken, "GET", `/bitable/v1/apps/${encodeURIComponent(table.appToken)}/tables/${encodeURIComponent(table.tableId)}/records?${query}`);
        for (const item of (Array.isArray(data.items) ? data.items : []) as { record_id?: string; fields?: Record<string, unknown> }[])
          if (item.record_id) records.push({ recordId: item.record_id, fields: item.fields ?? {} });
        if (!data.has_more || typeof data.page_token !== "string") break;
        pageToken = data.page_token;
      }
      return records;
    },
  };
}
