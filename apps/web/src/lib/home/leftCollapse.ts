/**
 * 左栏收起（设计 4.1）刷新不闪：根布局 <head> 里、渲染前跑的一段脚本（接在外观那段后面）。
 * 读这台电脑记的收没收起，收着就给 <html> 写上 data-home-left="closed"，外壳在挂载前就按它收起（home.module.css），不先展开再收。
 * 开合时 components/home/LeftResize 的 useLeftCollapsed 跟着改这个属性。
 */
export const LEFT_COLLAPSED_KEY = "tianshu-home-left-collapsed-v1";
export const LEFT_COLLAPSED_ATTR = "data-home-left";

export const LEFT_COLLAPSED_SCRIPT = `(function(){try{if(localStorage.getItem("${LEFT_COLLAPSED_KEY}")==="1")`
  + `document.documentElement.setAttribute("${LEFT_COLLAPSED_ATTR}","closed")}catch(e){}})();`;
