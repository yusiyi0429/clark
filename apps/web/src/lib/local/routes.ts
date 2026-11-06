/**
 * 本机 API 的路由表、端口和口令头。网页只从 @warmap/contracts 拿类型（运行时不打包契约包），
 * 这里照抄一份值，类型标成契约里那份：哪天契约改了，类型检查就过不去，两边不会悄悄对不上。
 */
type Contracts = typeof import("@warmap/contracts");

export const LOCAL_RUNNER_DEFAULT_PORT: Contracts["LOCAL_RUNNER_DEFAULT_PORT"] = 47610;
export const LOCAL_RUNNER_TOKEN_HEADER: Contracts["LOCAL_RUNNER_TOKEN_HEADER"] = "x-tianshu-local-token";

export const LOCAL_RUNNER_ROUTES: Contracts["LOCAL_RUNNER_ROUTES"] = {
  health: { method: "GET", path: "/v1/health", auth: false },
  startPairing: { method: "POST", path: "/v1/pairings", auth: false },
  pairingStatus: { method: "GET", path: "/v1/pairings/:pairingId", auth: false },
  unpair: { method: "DELETE", path: "/v1/pairing", auth: true },
  status: { method: "GET", path: "/v1/status", auth: true },
  installAgent: { method: "POST", path: "/v1/agents/:agent/install", auth: true },
  loginAgent: { method: "POST", path: "/v1/agents/:agent/login", auth: true },
  loginAgentCode: { method: "POST", path: "/v1/agents/:agent/login/code", auth: true },
  cancelAgentSetup: { method: "DELETE", path: "/v1/agents/:agent/setup", auth: true },
  getCloud: { method: "GET", path: "/v1/cloud", auth: true },
  linkCloud: { method: "PUT", path: "/v1/cloud", auth: true },
  unlinkCloud: { method: "DELETE", path: "/v1/cloud", auth: true },
  getSettings: { method: "GET", path: "/v1/settings", auth: true },
  patchSettings: { method: "PATCH", path: "/v1/settings", auth: true },
  listModels: { method: "GET", path: "/v1/models", auth: true },
  putModel: { method: "PUT", path: "/v1/models/:id", auth: true },
  deleteModel: { method: "DELETE", path: "/v1/models/:id", auth: true },
  listFolders: { method: "GET", path: "/v1/folders", auth: true },
  pickFolder: { method: "POST", path: "/v1/folders/pick", auth: true },
  deleteFolder: { method: "DELETE", path: "/v1/folders/:id", auth: true },
  listSessions: { method: "GET", path: "/v1/sessions", auth: true },
  createSession: { method: "POST", path: "/v1/sessions", auth: true },
  createSessionBatch: { method: "POST", path: "/v1/sessions/batch", auth: true },
  getSession: { method: "GET", path: "/v1/sessions/:id", auth: true },
  sessionEvents: { method: "GET", path: "/v1/sessions/:id/events", auth: true },
  sendMessage: { method: "POST", path: "/v1/sessions/:id/messages", auth: true },
  interrupt: { method: "POST", path: "/v1/sessions/:id/interrupt", auth: true },
  decidePermission: { method: "POST", path: "/v1/sessions/:id/permissions/:requestId", auth: true },
  kill: { method: "POST", path: "/v1/sessions/:id/kill", auth: true },
  mergeSession: { method: "POST", path: "/v1/sessions/:id/merge", auth: true },
};
