import { useId } from "react";
import styles from "./tianshu-mark.module.css";

/**
 * 天枢的六向枢纽标记 —— v7 改版。
 *
 * **它是那份标志文件本身，不是照着画的近似。** 单枚光梭的路径 `d="M305 247C339 239
 * 371 222 404 204"`、六向排布的旋转角、渐变的两个端点坐标，逐笔来自
 * [`public/brand/tkos-tianshu-fluid-hub-mark-v7.svg`](../../../public/brand/tkos-tianshu-fluid-hub-mark-v7.svg)
 * —— 那份文件也签在仓库里，改标志改它，然后把这里同步过来。
 *
 * ## 这一版和上一版（hub-spike-mark-v6）画法完全不同
 *
 * v6 是六枚**实心三角形**，每枚都是 `fill` 加一道同色 `stroke` 画的，中心另叠两个同心圆
 * 撑出枢纽。v7 只画**一条描边曲线**（`fill="none"`，只有 `stroke`），旋转复制六次；六枚
 * 光梭自己的内端天然围出一圈六边形负形，中心不再需要单独的圆盘 —— 这也是源文件那句
 * 注释「不需要描边、折面或遮罩」的意思：负形是排布排出来的，不是拿另一层遮出来的。
 *
 * 这次只动了两处，两处都是**为了能在产品里用**，跟 v6 当年的取舍是同一件事：
 *
 *   `viewBox`  `0 0 512 512` 收成 `72 72 368 368`。源文件四周留了一圈空白：六条光梭绕
 *              (256,256) 转一圈，最外端点到圆心的半径约 157，描边线宽 48（半宽 24）、
 *              外端还带一个圆头端帽，量出来的实际外接半径约 180 —— 收到 368×368 之后
 *              标记在 22px 那种小尺寸下才不会大半格子是空的。这个数字不是拍的，是拿六条
 *              光梭的端点坐标逐个绕中心转六次、取各方向最大半径，再加端帽半径量出来的
 *              （见下方「量法」）；也在真实页面里用 `getBBox()` 核对过。
 *   颜色       源文件的渐变是三个定死的十六进制颜色（`#075CCB → #1684FF → #5BD8F6`）。
 *              这里收成两个端点，换回旧文件就有的两个变量 `--brand-bright` / `--brand-deep`
 *              —— 调用处已经在用这两个变量要灰版、白版或者压淡的水印（`debrief-column.tsx`
 *              的空态水印就是这么覆盖的），换皮肤不能把这个口子焊死。渐变因此只在两点间
 *              插值，损失的是源文件三段渐变里最亮的那一小截尾巴；用两个变量而不是加第三个
 *              是有意的：调用处只知道覆盖这两个名字，如果第三个端点是一个游离在外、没人
 *              覆盖得到的写死颜色，灰版水印就会在光梭最外沿露一小截蓝——正是这次改造最容易
 *              悄悄踩上的坑。两个变量给了 `var(--brand-deep, #075CCB)` /
 *              `var(--brand-bright, #5BD8F6)` 的回退值：项目里 `globals.css` 已经定义了
 *              这两个变量（浅色主题下是 `#075ccb` / `#1684ff`，和源文件前两段渐变几乎重合），
 *              回退值只在组件被摘出项目单独渲染、完全没有外层变量时才会生效，用来保证「不
 *              覆盖就长得像原图」这句话在任何语境下都成立。
 *
 * ## 渐变必须按实例生成不重名的 id —— 这是 v7 画法带来的新坑，v6 没有
 *
 * v6 每条光路直接把颜色写在 `fill`/`stroke` 属性上，没有 `<defs>`，天然不会重名。v7 把
 * 颜色收进一枚 `<linearGradient>`，六条 `<use>` 共享同一个 `url(#id)` 引用。**如果这个
 * id 是写死的字符串，同一页面上第二枚 `TianshuMark`（比如导航栏那枚常驻蓝色标记和
 * `debrief-column.tsx` 里压灰的水印同屏出现）会撞上同一个 DOM id** —— 浏览器对
 * `url(#id)` 只认第一个匹配到的元素，后出现的实例可能画出前一个实例的颜色，蓝的和灰的
 * 就会互相串色，而且只在同屏渲染多枚标记时才会犯，孤立测试根本看不出来。所以这里用
 * `useId()` 给每个组件实例生成专属前缀，`<defs>` 里的路径 id 和渐变 id 都带上它，
 * 保证同屏多枚标记互不干扰。
 *
 * ## 透明度依旧只加在整枚 `<svg>` 上，原因跟 v6 一样但触发条件变了
 *
 * v6 的教训是：半透明色下，`fill` 和同色 `stroke` 在同一块面积上各自算一次不透明度，
 * 叠出一圈更深的描边。v7 每条光梭 `fill="none"`，不存在 fill/stroke 叠加；六条光梭之间
 * 也按设计彼此不接触（源文件注释里的「六枚自然围出中央负形」正是说这六块面积互不重叠）。
 * 也就是说这一版的几何本身已经没有「两块面积互相压加深」的漏洞——但仍然不在渐变 `<stop>`
 * 上写半透明色：调用处要的是一枚**纯色**水印，渐变端点写成半透明只会在两个端点之间插出
 * 一条深浅不一的灰阶带，读起来像「没调好」，不像「刻意压淡的署名」。淡化统一交给调用处
 * 盖在整枚 `<svg>` 上的 `opacity`（`debrief-column.tsx` 那枚水印的 `opacity-[0.07]`），
 * 这样不管两个变量覆盖成同一个灰还是保留默认蓝，出来的都是同一次合成、同一个通透度。
 *
 * 这是一枚纯呈现组件：旁边始终有可见的「天枢」字标，所以 SVG 对读屏隐藏，
 * 避免同一个品牌名被念两遍。
 */
export function TianshuMark({ className }: { className?: string }) {
  const uid = useId();
  return (
    <svg viewBox="72 72 368 368" aria-hidden focusable="false" className={className}>
      <MarkGeometry uid={uid} />
    </svg>
  );
}

/**
 * Agent 正在工作时的天枢标记。
 *
 * 六条光梭按源标志的三根轴成对（0°与180°、60°与240°、120°与300°各一对），每对各自用
 * 一枚 `animateTransform` 绕中心 (256,256) 旋转，转速和方向沿用 v6 定下的节奏：第一轴
 * 顺时针 2.4s、第二轴逆时针 3.2s、第三轴顺时针 1.7s——三轴转速刻意不同，才能看见它们
 * 各自从中心出发、又回到中心，而不是六条光梭一起打转看成一个转盘。
 *
 * 旋转轴明确钉在 `256 256`（标志自身的几何中心，不是 `viewBox` 收窄后的可视中心）。
 * 不能用 CSS 的 `transform-origin: center`：浏览器会把那个 center 算成每个分组自己的
 * 包围盒中心，光梭就会离开枢心公转。旁边的可见状态文案负责报读，所以这枚 SVG 和静态
 * 品牌标记一样对读屏隐藏。
 */
export function TianshuThinkingMark({ className }: { className?: string }) {
  const uid = useId();
  return (
    <svg viewBox="72 72 368 368" aria-hidden focusable="false" className={className}>
      <g className={styles.motionGeometry}>
        <MarkGeometry uid={`${uid}-motion`} animated />
      </g>
      <g className={styles.stillGeometry}>
        <MarkGeometry uid={`${uid}-still`} />
      </g>
    </svg>
  );
}

function MarkGeometry({ uid, animated = false }: { uid: string; animated?: boolean }) {
  const rayId = `${uid}-flow-ray`;
  const gradientId = `${uid}-ray-flow`;
  return (
    <>
      <defs>
        {/*
          只画一枚光梭，六条 `<use>` 绕枢心复用它、各转 60 的倍数。内端 (305,247) 近圆心，
          外端 (404,204) 顺势向外甩开，六枚自然围出中央负形，几何逐笔照抄源文件。
        */}
        <path id={rayId} d="M305 247C339 239 371 222 404 204" />
        <linearGradient
          id={gradientId}
          x1="305"
          y1="247"
          x2="404"
          y2="204"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--brand-deep, #075CCB)" />
          <stop offset="1" stopColor="var(--brand-bright, #5BD8F6)" />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#${gradientId})`} strokeLinecap="round" strokeWidth="48">
        <RayAxis animated={animated} from={0} to={360} dur="2.4s">
          <use href={`#${rayId}`} />
          <use href={`#${rayId}`} transform="rotate(180 256 256)" />
        </RayAxis>
        <RayAxis animated={animated} from={0} to={-360} dur="3.2s">
          <use href={`#${rayId}`} transform="rotate(60 256 256)" />
          <use href={`#${rayId}`} transform="rotate(240 256 256)" />
        </RayAxis>
        <RayAxis animated={animated} from={0} to={360} dur="1.7s">
          <use href={`#${rayId}`} transform="rotate(120 256 256)" />
          <use href={`#${rayId}`} transform="rotate(300 256 256)" />
        </RayAxis>
      </g>
    </>
  );
}

function RayAxis({
  animated,
  from,
  to,
  dur,
  children,
}: {
  animated: boolean;
  from: number;
  to: number;
  dur: string;
  children: React.ReactNode;
}) {
  return (
    <g>
      {animated ? (
        <animateTransform
          attributeName="transform"
          type="rotate"
          from={`${from} 256 256`}
          to={`${to} 256 256`}
          dur={dur}
          repeatCount="indefinite"
        />
      ) : null}
      {children}
    </g>
  );
}
