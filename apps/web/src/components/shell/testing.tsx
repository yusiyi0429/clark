import type { ReactNode } from "react";
import { WorkspaceContext, type WorkspaceApi } from "./WorkspaceContext";

/** 单元测试里渲染对象页用：一个不做导航的工作区外壳桩。 */
export function WorkspaceTestProvider({ children, api }: { children: ReactNode; api?: Partial<WorkspaceApi> }) {
  const value: WorkspaceApi = {
    navigate: () => {},
    close: () => {},
    detailOpen: true,
    closing: false,
    registerDetail: () => {},
    showToast: () => {},
    homeCards: [],
    quote: () => {},
    viewerId: null,
    ...api,
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
