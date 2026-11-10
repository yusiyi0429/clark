/**
 * 外观（设计 17.2）首屏防闪：根布局 <head> 里、渲染前跑的一段脚本。读这台电脑上存的那份（跟随系统 / 浅色 / 深色），
 * 算出深浅写到 <html data-color-scheme>，深色变量按它挂（app/scheme-dark.css）；跟随系统时系统一变跟着变。
 * 服务端那份由 lib/appearance.ts 读回来，不一样时改本地这份再算一次（applyStoredAppearance，同一套算法）。
 */
export const APPEARANCE_KEY = "tianshu-appearance-v1";
export const SCHEME_ATTR = "data-color-scheme";

export const APPEARANCE_SCRIPT = `(function(){try{var d=document.documentElement,q=window.matchMedia("(prefers-color-scheme: dark)");`
  + `function a(){var v=null;try{v=localStorage.getItem("${APPEARANCE_KEY}")}catch(e){}`
  + `d.setAttribute("${SCHEME_ATTR}",v==="dark"||(v!=="light"&&q.matches)?"dark":"light")}`
  + `a();q.addEventListener("change",a)}catch(e){}})();`;
