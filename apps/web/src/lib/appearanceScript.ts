/**
 * 外观（设计 17.2）首屏防闪：根布局 <head> 里、渲染前跑的一段脚本。读这台电脑上存的那份（跟随系统 / 浅色 / 深色），
 * 算出深浅写到 <html data-color-scheme>，深色变量按它挂（app/scheme-dark.css）；跟随系统时系统一变跟着变。
 * 服务端那份由 lib/appearance.ts 读回来，不一样时改本地这份再算一次（applyStoredAppearance，同一套算法）。
 * 同一下把 <meta name="theme-color"> 也写好（17.2 第 44 条）；之后换外观、换页面由 components/ThemeColorSync 跟着改。
 */
export const APPEARANCE_KEY = "tianshu-appearance-v1";
export const SCHEME_ATTR = "data-color-scheme";
/**
 * 浏览器顶栏、装成应用后的窗口标题栏的颜色：和界面最上面那一块同一个底色（--surface 实际画出来的色号，
 * 在跑着的新首页和登录页上量的，深浅各一个）。old 是老页面的：它们不跟外观，沿用原来的深蓝（手持老外壳顶上那一块）。
 */
export const THEME_COLOR = { dark: "#171919", light: "#fdfdfe", old: "#1b2543" } as const;

export const APPEARANCE_SCRIPT = `(function(){try{var d=document.documentElement,q=window.matchMedia("(prefers-color-scheme: dark)");`
  + `function a(){var v=null;try{v=localStorage.getItem("${APPEARANCE_KEY}")}catch(e){}`
  + `var s=v==="dark"||(v!=="light"&&q.matches)?"dark":"light";d.setAttribute("${SCHEME_ATTR}",s);return s}`
  + `var m=document.createElement("meta");m.name="theme-color";m.content=a()==="dark"?"${THEME_COLOR.dark}":"${THEME_COLOR.light}";document.head.appendChild(m);`
  + `q.addEventListener("change",a)}catch(e){}})();`;
