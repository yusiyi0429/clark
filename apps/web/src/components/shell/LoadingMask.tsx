import s from "@/styles/loading-mask.module.css";

/** 二级页等服务端时盖住通知窄条以外的右侧区域：磨砂玻璃 + 居中流光「加载中」。一直挂着，靠 data-active 淡入淡出；
 *  淡入带一点延迟，很快就回来的页面不会闪一下蒙版。 */
export function LoadingMask({ active }: { active: boolean }) {
  return (
    <div className={s.mask} data-active={active} data-testid="loading-mask" aria-hidden={!active}>
      <span className={s.text}>加载中</span>
      <span className={s.status} role="status">{active ? "加载中" : ""}</span>
    </div>
  );
}
