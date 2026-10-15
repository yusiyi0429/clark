/**
 * 跨视图打开的返回栈（例如从已处理打开议题，关闭回到已处理）。
 * 浏览器后退 / 前进不经过 navigate，栈会和地址栏脱节：回到了栈里的某一页，就把那一页和它之后的记录丢掉；
 * 关闭时也跳过就是当前页的记录——否则 router.push 到当前地址不会提交新路由，加载蒙版永远不消失。
 */
export function trimReturns(stack: string[], pathname: string): string[] {
  const index = stack.lastIndexOf(pathname);
  return index >= 0 ? stack.slice(0, index) : stack;
}

/** 关闭时要回到的上一页（已跳过当前页）；没有就是回首页。 */
export function popReturn(stack: string[], pathname: string): { back: string | null; rest: string[] } {
  const rest = [...stack];
  while (rest.length) {
    const back = rest.pop()!;
    if (back.split("?")[0] !== pathname) return { back, rest };
  }
  return { back: null, rest };
}
