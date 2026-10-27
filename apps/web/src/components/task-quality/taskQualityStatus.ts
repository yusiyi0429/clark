import { browserApi } from "@/lib/api/client";

let enabled: Promise<boolean> | null = null;

/** 没接数据质量服务时不显示入口；开关跟部署走，一个页面里只读一次。 */
export function readTaskQualityEnabled(): Promise<boolean> {
  enabled ??= browserApi.GET("/api/task-quality/status")
    .then(({ data, response }) => Boolean(response.ok && data?.enabled))
    .catch(() => { enabled = null; return false; });
  return enabled;
}
