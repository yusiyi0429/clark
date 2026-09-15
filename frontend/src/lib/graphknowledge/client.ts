/**
 * 对齐自 tkos-lab/src/tkos_lab/graphknowledge/client.py
 *
 * GraphKnowledge M7 只读 API 客户端：只暴露 P0/P1/P2/P3 与 /healthz，
 * **不包含任何写方法**。
 *
 * 用 `undici.request` 而不是全局 `fetch`：图服务是 IP + 自签证书，关校验只能
 * 靠自带 dispatcher（`fetch` 的选项里没有 `rejectUnauthorized`）。顺带绕开
 * Next.js 给全局 `fetch` 打的缓存补丁 —— 本体读的是「此刻的公司状态」，被缓存
 * 住的表现是快照冻结失效，而屏幕上看不出来。
 */
import { Agent, request } from "undici";

import {
  GraphKnowledgeNotFound,
  GraphKnowledgeRejected,
  GraphKnowledgeUnavailable,
} from "./errors";

const GK_TIMEOUT_MS = 30_000;

export type GkSettings = {
  baseUrl: string;
  auth: { user: string; password: string } | null;
  verifyTls: boolean;
  viewer: string;
  /** 环境变量的解析问题。**不抛** —— 一个解析失败会让模块导入失败，表现是每条路由都 500。 */
  warnings: string[];
};

export function gkSettings(): GkSettings {
  const warnings: string[] = [];

  const baseUrl = (process.env.TKOS_GRAPHKNOWLEDGE_BASE_URL ?? "").trim().replace(/\/+$/, "");

  const authRaw = (process.env.TKOS_GRAPHKNOWLEDGE_AUTH ?? "").trim();
  let auth: GkSettings["auth"] = null;
  if (authRaw) {
    // 只按第一个冒号切：密码里带冒号是常事，切在最后一个会把密码劈成两半，
    // 表现是 401——而变量明明配了，排查会从「服务不认这把凭据」开始猜。
    const i = authRaw.indexOf(":");
    if (i > 0) auth = { user: authRaw.slice(0, i), password: authRaw.slice(i + 1) };
    else warnings.push("TKOS_GRAPHKNOWLEDGE_AUTH 不是 user:password 形式，本次按未配置处理");
  }

  const verifyTls = (process.env.TKOS_GRAPHKNOWLEDGE_VERIFY_TLS ?? "1").trim() !== "0";
  if (!verifyTls) {
    warnings.push(
      "TKOS_GRAPHKNOWLEDGE_VERIFY_TLS=0：这条链路不校验证书，不防中间人。" +
        "图服务换成域名 + 正式证书之后要把它去掉。"
    );
  }

  if ((process.env.TKOS_GRAPHKNOWLEDGE_MOCK ?? "").trim() === "1") {
    warnings.push(
      "TKOS_GRAPHKNOWLEDGE_MOCK=1 本轮未实现（正式版不带图谱 mock），本次仍连真实服务"
    );
  }

  return {
    baseUrl,
    auth,
    verifyTls,
    viewer: (process.env.TKOS_GRAPHKNOWLEDGE_VIEWER ?? "").trim() || "PSN-01",
    warnings,
  };
}

export type GkVersion = {
  index?: number;
  status?: string;
  at?: string;
  statement?: string;
  meetingLabel?: string;
};

export type GkEntity = {
  code?: string;
  label?: string;
  properties?: Record<string, unknown>;
  relations?: Record<string, string[]>;
  versions?: GkVersion[];
};

export type GkSeed = { code?: string; type?: string; score?: number };

export type GkDynamic = {
  query?: string;
  seeds?: GkSeed[];
  text?: string;
  /** 服务端自己报的降级（`query_embedding_not_cached` / `_failed`）。不是错误。 */
  warning?: string;
};

/**
 * 两个 dispatcher（校验 / 不校验）各缓存一个。每次请求新建 `Agent` 会把连接池
 * 也一起丢掉，连接复用没了，而症状只是「本体这一步有点慢」。
 */
const agents = new Map<boolean, Agent>();

function agentFor(verifyTls: boolean): Agent {
  let a = agents.get(verifyTls);
  if (!a) {
    a = new Agent({
      connect: { rejectUnauthorized: verifyTls, timeout: GK_TIMEOUT_MS },
      headersTimeout: GK_TIMEOUT_MS,
      bodyTimeout: GK_TIMEOUT_MS,
    });
    agents.set(verifyTls, a);
  }
  return a;
}

export class GraphKnowledgeClient {
  readonly baseUrl: string;
  readonly viewer: string;
  readonly warnings: string[];
  private readonly auth: GkSettings["auth"];
  private readonly verifyTls: boolean;

  constructor(settings: GkSettings = gkSettings()) {
    this.baseUrl = settings.baseUrl;
    this.viewer = settings.viewer;
    this.warnings = settings.warnings;
    this.auth = settings.auth;
    this.verifyTls = settings.verifyTls;
  }

  /** P0：公司经营状态。返回的是 Markdown 正文，不是 JSON。 */
  async staticContext(opts: { viewer: string; asOf: string }): Promise<string> {
    const { body } = await this.get("/api/v1/context/static", {
      viewer: opts.viewer,
      as_of: opts.asOf,
    });
    return body;
  }

  /** P1：实体当前版。 */
  async entity(code: string): Promise<GkEntity> {
    const r = await this.get(`/api/v1/entities/${encodeURIComponent(code)}`, { view: "latest" });
    return asObject(r.body, code) as GkEntity;
  }

  /** P2：实体版本链。 */
  async chain(code: string): Promise<GkEntity> {
    const r = await this.get(`/api/v1/entities/${encodeURIComponent(code)}`, { view: "chain" });
    return asObject(r.body, code) as GkEntity;
  }

  /** P3：语义召回。`query` 必须已经过 `clip()` —— 超 100 字服务端直接 422。 */
  async dynamic(query: string, opts: { k: number; budget: number }): Promise<GkDynamic> {
    const r = await this.get("/api/v1/context/dynamic", {
      q: query,
      k: opts.k,
      budget: opts.budget,
    });
    return asObject(r.body, "dynamic") as GkDynamic;
  }

  async health(): Promise<Record<string, unknown>> {
    const r = await this.get("/healthz", {});
    return asObject(r.body, "healthz");
  }

  private async get(
    path: string,
    params: Record<string, string | number>
  ): Promise<{ status: number; body: string }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { accept: "application/json, text/plain, */*" };
    if (this.auth) {
      const raw = `${this.auth.user}:${this.auth.password}`;
      headers.authorization = `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
    }
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString();

    let status: number;
    let body: string;
    try {
      const res = await request(qs ? `${url}?${qs}` : url, {
        method: "GET",
        headers,
        dispatcher: agentFor(this.verifyTls),
      });
      status = res.statusCode;
      body = await res.body.text();
    } catch (e) {
      /*
       * 一定要带上目标 URL：只报底层 errno 的话，连是地址没配、服务没起还是
       * 网络不通都分不出来，排查得从头猜起。
       *
       * 判空要判 `this.baseUrl` 本身，不能判拼完的 url —— 没配地址时拼出来是
       * "/api/v1/context/dynamic"，非空，于是这句提示永远走不到，现场只剩一个
       * 相对路径加一句 Invalid URL，看着像服务掉了。这两件事要做的完全不同。
       */
      const target = this.baseUrl
        ? url
        : `${path}（没配 TKOS_GRAPHKNOWLEDGE_BASE_URL，地址是空的，这个请求压根没发出去）`;
      throw new GraphKnowledgeUnavailable(
        `GraphKnowledge 不可达（${errName(e)}）：${errMsg(e)}　目标 ${target}`,
        {
          url,
          baseUrl: this.baseUrl,
          errorType: errName(e),
          error: errMsg(e),
          hint:
            "确认 TKOS_GRAPHKNOWLEDGE_BASE_URL 指向真实服务；" +
            "自签证书报 SSL 错时设 TKOS_GRAPHKNOWLEDGE_VERIFY_TLS=0",
        }
      );
    }

    const detail = parseDetail(body);
    if (status === 401 || status === 403) {
      // 认证问题跟「服务挂了」完全是两条排查路径，不能都报成不可达。
      throw new GraphKnowledgeUnavailable(
        `GraphKnowledge 拒绝认证（${status}）：TKOS_GRAPHKNOWLEDGE_AUTH ` +
          `${this.auth ? "不被接受" : "没配"}`,
        { ...detail, authConfigured: this.auth !== null }
      );
    }
    if (status === 404) {
      const tail = path.split("/").pop() ?? path;
      throw new GraphKnowledgeNotFound(
        `GraphKnowledge 锚点不存在: ${decodeURIComponent(tail)}`,
        detail
      );
    }
    if (status === 400 || status === 422) {
      throw new GraphKnowledgeRejected(`GraphKnowledge 拒绝请求（${status}）`, detail);
    }
    if (status >= 400) {
      throw new GraphKnowledgeUnavailable(`GraphKnowledge 返回 ${status}`, detail);
    }
    return { status, body };
  }
}

const errName = (e: unknown): string =>
  e instanceof Error ? e.constructor.name : typeof e;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function asObject(body: string, code: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new GraphKnowledgeUnavailable("GraphKnowledge 返回的不是合法 JSON", {
      code,
      body: body.slice(0, 500),
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GraphKnowledgeUnavailable("GraphKnowledge 返回结构不是对象", { code });
  }
  return value as Record<string, unknown>;
}

/** 错误现场：服务端的应答正文常常是唯一说得清原因的地方，能解析就带结构，不能就带前 500 字。 */
function parseDetail(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return { body: value };
  } catch {
    return { body: body.slice(0, 500) };
  }
}
