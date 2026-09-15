import { OperatorConsole } from "@/components/stage/operator-console";

/**
 * 秘书控制台。
 *
 * 在第二台设备上打开（手机或者平板），和投影那块屏连的是同一个 `demo` 会话。它推出去的
 * 每一条都走 `/api/stage`，落到屏幕上和模型调工具是同一条 reducer 分支 —— 所以热键推的
 * 证据卡和模型自己打出来的长得一模一样，客户看不出区别。
 *
 * 它不在 `(workbench)` 那个组里：控制台不需要三栏桌子，也不该跟着桌面的模式走。
 */
export const metadata = { title: "控制台 · TKOS" };

export default function OperatorPage() {
  return <OperatorConsole />;
}
