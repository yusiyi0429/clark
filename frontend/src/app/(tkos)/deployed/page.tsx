import { DeployedView } from "@/app/_views/deployed-view";

/**
 * 已部署 —— 方向定了、任务交出去了，现在压在 DRI 身上的那些。
 *
 * 从右边缘那两颗点进来。它和战略议题那一屏共用同一个壳（左边那一列一个像素都不动），
 * 只有右边那一大块换成这一栏 —— 理由写在 `DeployedView` 上。
 */
export default function DeployedPage() {
  return <DeployedView />;
}
