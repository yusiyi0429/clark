/**
 * 两种模式。
 *
 * **手动模式**是他一个人用的工作台：三栏、可拖、可点、信息密度拉满。
 * **口述模式**是他带着别人一起看的那块屏：一次只有一件事，字大到最后一排能看清，
 * 屏幕跟着话走。
 *
 * 同一份数据、同一个 Agent、同一条流。模式只决定这些东西长什么样子 —— 所以模式不是
 * 路由：`/judgments/04-J1` 在两种模式下都是那条判断，切模式不该把他从这条判断上弹走。
 *
 * 唯一真值和 `desk.ts` 一样是 `documentElement` 上的一个属性（`data-mode`），并且在
 * React 之前就写好了（`MODE_PREPAINT`）。理由更硬一层：口述模式是深底大字，手动模式
 * 是纸白小字，如果等 React 挂载后再切，会议室的投影上会闪一下白 —— 那是他在客户面前
 * 打开这个产品的第一帧。
 */

export type Mode = "manual" | "oral";

export const MODE_KEY = "clark.mode";

/** 地址里带 `?mode=oral` 就进口述模式，并且记成这台设备的默认。 */
export const MODE_PARAM = "mode";

/**
 * 首屏之前跑一次。和 `DESK_PREPAINT` 一样：写得短、全程 try、不抛。
 *
 * 优先级是地址 > 这台设备记住的。地址高一级，是因为投影那台机器上他会直接贴一个
 * 带 `?mode=oral` 的链接；而记住这件事管的是他中途刷新不用重贴。
 */
export const MODE_PREPAINT = `(function(){try{
var d=document.documentElement,m=null;
var q=new URLSearchParams(location.search).get("${MODE_PARAM}");
if(q==="oral"||q==="manual")m=q;else m=localStorage.getItem("${MODE_KEY}");
if(m==="oral"){d.dataset.mode="oral";d.classList.add("dark");localStorage.setItem("${MODE_KEY}","oral");}
else{d.dataset.mode="manual";if(q==="manual")localStorage.setItem("${MODE_KEY}","manual");}
}catch(e){}})()`;

/** 服务端渲染那一帧一律当手动模式：投影那块屏是客户端接管之后才亮的。 */
export function readMode(): Mode {
  if (typeof document === "undefined") return "manual";
  return document.documentElement.dataset.mode === "oral" ? "oral" : "manual";
}

const EVENT = "clark:mode";

/**
 * 换模式。
 *
 * 不走 React state：属性一改，CSS 的 `oral:` 变体和深底 token 立刻生效；那个自定义
 * 事件只是让需要**换组件**的地方（舞台整体挂载/卸载）跟上来。
 */
export function setMode(next: Mode) {
  const root = document.documentElement;
  if (readMode() === next) return next;
  root.dataset.mode = next;
  /*
   * 深底那套 token 是 `globals.css` 里早就写全的 `.dark`，一直没人激活。口述模式就是
   * 激活它的那个场景：投影上纸白底会晃眼，而深底高对比正是它当初被写出来的样子。
   *
   * 加类而不是另写一套舞台配色，是为了让舞台组件继续只用 token —— 组件里出现一个
   * 写死的颜色，这一整套就白搭了。
   */
  root.classList.toggle("dark", next === "oral");
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    /* 记不住就记不住，下次回默认。 */
  }
  window.dispatchEvent(new Event(EVENT));
  return next;
}

export function toggleMode(): Mode {
  return setMode(readMode() === "oral" ? "manual" : "oral");
}

export function subscribeMode(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
