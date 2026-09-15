import createClient from "openapi-fetch";
import type { components, paths } from "./schema";

export type Card = components["schemas"]["Card"];
export type CardCollection = components["schemas"]["CardCollection"];

// 浏览器端：同源相对路径，经 Caddy 边界访问 API
export const browserApi = createClient<paths>({ baseUrl: "/" });

// 服务端渲染：直连 API 内网地址（不经 Web 业务 handler）
const serverBase = process.env.API_SERVER_URL ?? "http://localhost:4000";
export const serverApi = createClient<paths>({ baseUrl: serverBase });
