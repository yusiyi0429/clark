"use client";

import { UserPlus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { api } from "@/lib/data/client";
import type { DriOption } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 把一件任务派给谁 —— 会后那张卡上，每条任务右边那颗下拉。
 *
 * ## 为什么不是原生 `<select>`
 *
 * 这颗键站在一块**深色的会议面**上（`.meet-face`）。原生 select 的弹层由系统画，
 * Windows 上是一块白底 —— 一张深蓝卡片上弹出一块系统白，读起来不是这张卡的一部分，
 * 而是「浏览器插了一脚」。这一栏别处（`native-select.tsx`）用原生是对的，那几处站在纸上。
 *
 * ## 为什么不是 Base UI 的 listbox
 *
 * 这个 React 19.2 / Base UI 1.7 的组合上它**打不开**（记在 DECISIONS.md 上）。
 *
 * ## 为什么要 portal
 *
 * 这张卡自己 `overflow-hidden`（要裁圆角和那层流动的底），外面那一栏还是个滚动容器 ——
 * 一个绝对定位的弹层在这两层里都会被裁掉，弹出来只剩上面一条。所以它挂到 `body` 上，
 * 用固定定位对着这颗键的实际位置画。
 *
 * portal 出去之后 `--meet` 那几个变量就断了（它们挂在卡片那一层上），弹层会退成一块
 * 没有颜色的灰。所以开的那一刻把这颗键上算出来的颜色**读下来**，抄到弹层根上 ——
 * 于是弹层和它属于的那张卡是同一档颜色，一场会换一档色它自己跟着换。
 */
export function AssignMenu({
  value,
  disabled,
  onPick,
  label,
}: {
  /** 已经派给谁了。没派就是 `null`。 */
  value: { id: string; name: string } | null;
  disabled?: boolean;
  /** 选了谁。传 `null` 是撤掉这次指派。 */
  onPick: (driId: string | null) => void;
  /** 这条任务的原话，给读屏用（「派给谁 · 把 X 的口径定下来」）。 */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`派给谁 · ${label}`}
        /*
         * 没派的时候这句话要说清**不派是什么意思**：不是「还没来得及派」，是这一条
         * 他自己留着（名单里因此也没有「CEO」那一项，理由整段写在 `listDris` 上）。
         */
        title={value ? `已派给 ${value.name}` : "派给谁 · 不派就是自己留着"}
        onClick={() => setOpen((v) => !v)}
        /* 摁下去不冒泡：外面那一层可能是一张能甩的卡片（同这一列另外两颗键）。 */
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(
          "meet-btn-quiet mt-[3px] flex max-w-[7.5rem] flex-none items-center gap-1 rounded-[4px] px-1 py-0.5 transition-colors duration-fast disabled:opacity-40",
          open && "[color:var(--meet-fg)]",
        )}
      >
        {value ? (
          <span className="meta truncate">{value.name}</span>
        ) : (
          <UserPlus aria-hidden className="size-3" />
        )}
      </button>

      {open ? (
        <Sheet anchorRef={anchor} onClose={() => setOpen(false)}>
          <Options
            value={value}
            onPick={(id) => {
              onPick(id);
              setOpen(false);
            }}
          />
        </Sheet>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */

/** 弹层宽度。13rem —— 装得下最长的那个岗位名（「业务负责人」）加上域编号。 */
const WIDTH = 208;
/**
 * 弹层最高多少。名单是十三个人，这个高度露得出八个 —— 剩下的滚。
 *
 * **它同时是「往下装不下就往上翻」的判据**，所以只能有一个数：写成 CSS 一份、判翻转
 * 一份的话，改高度时漏掉一处的表现是弹层在屏幕底下被截掉一截，而那时它并没有翻上去。
 */
const MAX_H = 288;

/**
 * 弹层本身：位置、颜色、关掉的三条路（点别处、Esc、滚动）。
 *
 * **滚动就关掉**，不跟着重新定位。这颗键长在一栏会滚的清单上，跟着滚要么每帧重算
 * （一次滚动几十次布局），要么它会飘在原地和那一行分家。关掉是唯一不会说谎的做法：
 * 那一行已经滚走了，对着它的菜单本来就不该还在。
 */
function Sheet({
  anchorRef,
  onClose,
  children,
}: {
  /**
   * 收的是 **ref 本身**，不是 `ref.current`。渲染期间读 `current` 是读一个不参与渲染的
   * 值 —— 它此刻可能还是 null（第一帧 ref 还没挂上），而组件不会因为它变了再画一遍。
   * 这一层只在布局效应里读它，那时它一定已经挂好了。
   */
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [box, setBox] = useState<CSSProperties | null>(null);
  const sheet = useRef<HTMLDivElement>(null);

  /*
   * 量位置要在**画出来之前**（`useLayoutEffect`）：用 `useEffect` 的话中间会有一帧
   * 弹层已经在屏幕上、但还在左上角 (0,0) —— 那一帧眼睛看得见，是一下闪跳。
   */
  useLayoutEffect(() => {
    const measure = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      /* 右对齐这颗键，但不许探出视口 —— 探出去的那半截在窄屏上够不着。 */
      const left = Math.max(8, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - 8));
      /* 下面装不下就翻到上面去。 */
      const below = window.innerHeight - r.bottom;
      const up = below < MAX_H && r.top > below;
      setBox({
        position: "fixed",
        left,
        width: WIDTH,
        maxHeight: MAX_H,
        ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
        /* 这张卡的颜色抄过来 —— portal 出去之后这几个变量的原主已经不在祖先链上了。 */
        ["--meet" as string]: style.getPropertyValue("--meet"),
        ["--meet-fg" as string]: style.getPropertyValue("--meet-fg"),
        ["--meet-fg-dim" as string]: style.getPropertyValue("--meet-fg-dim"),
      });
    };
    measure();
  }, [anchorRef]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (sheet.current?.contains(e.target as Node)) return;
      if (anchorRef.current?.contains(e.target as Node)) return; // 那一下是「再按一次关掉」
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    /*
     * 滚动就关掉 —— **但「这份名单自己在滚」不算**。
     *
     * 这一条在捕获阶段挂在 window 上，为的是收到那些不冒泡的 `scroll`（元素自己的滚动
     * 事件不冒泡，只有捕获这一路收得到）。代价是它把**菜单自己**的滚动也收了：名单
     * 十三个人、框子只装得下六个，于是他一往下滚，菜单就关了 —— 拖右边那条滚动条也一样。
     * 屏幕上的样子是「这份名单翻不动」，而看起来像点歪了。
     *
     * 所以按事件的 target 分：滚的是这块弹层里面的东西就放过，别处在滚才关（那时这颗键
     * 已经跟着页面走了，对着它的菜单本来就不该还在）。
     */
    const scrolled = (e: Event) => {
      if (sheet.current?.contains(e.target as Node)) return;
      onClose();
    };
    /* 捕获阶段收：清单里那几行自己也接点击（勾/改），不拦在前面的话会先勾掉一条。 */
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchorRef, onClose]);

  if (!box) return null;

  return createPortal(
    <div
      ref={sheet}
      role="menu"
      style={box}
      /*
       * 底是这张卡那档颜色**再压深两档**：弹层要压在卡片上面，而深色面上「更靠前」
       * 只有两种画法 —— 更亮，或者更深加一圈亮边。这里用后者：更亮会和卡上那颗白色
       * 主键抢，而这块弹层不是这张卡上最要紧的东西。
       */
      className="animate-panel z-50 overflow-y-auto rounded-xl p-1 shadow-lg ring-1 ring-white/15 [background:color-mix(in_oklab,var(--meet)_78%,black)] scroll-slim"
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * 名单。**在这里才去取**（弹层挂上之后），不是每张卡一进屏幕就先问一遍 ——
 * 首页上摞着几张卡，各问一次而九成的会他一颗都不会点。
 */
function Options({
  value,
  onPick,
}: {
  value: { id: string; name: string } | null;
  onPick: (driId: string | null) => void;
}) {
  const dris = useResource<DriOption[]>("dris", () => api.listDris());

  if (dris.error)
    return <p className="meta px-2 py-2 [color:var(--meet-fg-dim)]">名单没取到。</p>;
  if (!dris.data)
    return (
      <div className="space-y-1 p-1">
        {[0, 1, 2].map((n) => (
          <span key={n} className="skeleton block h-5 w-full" />
        ))}
      </div>
    );

  return (
    <>
      {/*
       * 撤掉这次指派。写「自己留着」不写「不指派」：后者说的是一个状态没了，而这里
       * 真正发生的事是**这一条归他自己**（同上）。
       */}
      {value ? (
        <Row onClick={() => onPick(null)}>
          <span className="[color:var(--meet-fg-dim)]">自己留着</span>
        </Row>
      ) : null}
      {dris.data.map((d) => (
        <Row key={d.id} active={d.id === value?.id} onClick={() => onPick(d.id)}>
          <span className="truncate [color:var(--meet-fg)]">{d.name}</span>
          {/*
           * 域编号压淡跟在后面。**它是用来分人的**：这份名单里有六个是岗位占位
           * （「业务负责人」「产品负责人」…），光看名字分不出谁管哪一块。
           */}
          {d.domains.length > 0 ? (
            <span className="meta ml-auto flex-none [color:var(--meet-fg-dim)]">
              {d.domains.map((x) => x.code).join(" ")}
            </span>
          ) : null}
        </Row>
      ))}
    </>
  );
}

function Row({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-fast",
        "hover:[background:color-mix(in_oklab,white_10%,transparent)]",
        active && "[background:color-mix(in_oklab,white_14%,transparent)]",
      )}
    >
      {children}
    </button>
  );
}
