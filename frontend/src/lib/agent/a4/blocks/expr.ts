/**
 * `param_model` 里那些算式的求值器。**不执行模型给的代码。**
 *
 * 参照样张里的计算器是一段模型手写的 JS。那条路有两个结局：要么它间歇性地坏掉
 * （改一次参数名就少一个变量），要么它是一个注入面。所以模型只交算式字符串，
 * 由这里算 —— 认得的东西只有：数字、参数 id、`+ - * /`、括号、一元负号。
 * 别的一律拒，拒的时候说清是哪一个字符。
 *
 * ## 除零给不出数，就说给不出
 *
 * 屏幕上出现 `NaN` 或 `Infinity` 的时候读的人不知道是算式错了还是参数拖到了边界。
 * 所以除数为 0 时返回 `null`，由渲染层写成「这组参数下算不出」。
 */

const NUM = /^\d+(?:\.\d+)?/;
const ID = /^[A-Za-z_][A-Za-z0-9_]*/;

type Node =
  | { k: "num"; v: number }
  | { k: "ref"; id: string }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Node; b: Node };

export interface Expr {
  /** 这条算式引到的参数 id，去重、按出现顺序。校验器拿它比对 `params`。 */
  ids: string[];
  /** 算一次。参数缺值或者除零都返回 `null`。 */
  run: (vars: Record<string, number>) => number | null;
}

export type ExprResult = { ok: true; expr: Expr } | { ok: false; why: string };

/**
 * 编译一条算式。
 *
 * 递归下降，两层优先级（先乘除后加减）。整条算式必须被吃干净 —— 尾巴上剩东西
 * （`a + b )` 这种）算失败，不算「前半截能用」。
 */
export function compileExpr(src: string): ExprResult {
  let rest = (src ?? "").trim();
  if (!rest) return { ok: false, why: "算式是空的" };

  const ids: string[] = [];
  let failure = "";

  const eat = (n: number) => {
    rest = rest.slice(n).trimStart();
  };
  /*
   * 下一个字符。写成函数是必须的：`rest[0]` 会被编译器按上一次比较的结果收窄成一个
   * 字面量类型，而 `eat()` 之后 `rest` 已经不是那一截了 —— 收窄下来的类型是过期的事实。
   */
  const peek = (): string => rest[0] ?? "";

  const primary = (): Node | null => {
    if (!rest) {
      failure = failure || "算式在这里就断了";
      return null;
    }
    if (peek() === "(") {
      eat(1);
      const inner = additive();
      if (!inner) return null;
      if (peek() !== ")") {
        failure = failure || "少一个右括号";
        return null;
      }
      eat(1);
      return inner;
    }
    if (peek() === "-") {
      eat(1);
      const a = primary();
      return a ? { k: "neg", a } : null;
    }
    const n = NUM.exec(rest);
    if (n) {
      eat(n[0].length);
      return { k: "num", v: Number(n[0]) };
    }
    const id = ID.exec(rest);
    if (id) {
      eat(id[0].length);
      if (!ids.includes(id[0])) ids.push(id[0]);
      return { k: "ref", id: id[0] };
    }
    failure = failure || `不认识的写法「${rest.slice(0, 12)}」—— 只能用数字、参数 id、+ - * / 和括号`;
    return null;
  };

  const multiplicative = (): Node | null => {
    let a = primary();
    if (!a) return null;
    while (peek() === "*" || peek() === "/") {
      const op = peek() as "*" | "/";
      eat(1);
      const b = primary();
      if (!b) return null;
      a = { k: "bin", op, a, b };
    }
    return a;
  };

  const additive = (): Node | null => {
    let a = multiplicative();
    if (!a) return null;
    while (peek() === "+" || peek() === "-") {
      const op = peek() as "+" | "-";
      eat(1);
      const b = multiplicative();
      if (!b) return null;
      a = { k: "bin", op, a, b };
    }
    return a;
  };

  const root = additive();
  if (!root) return { ok: false, why: failure || "算式读不通" };
  if (rest) return { ok: false, why: `算式末尾多出「${rest.slice(0, 12)}」` };

  return {
    ok: true,
    expr: {
      ids,
      run: (vars) => walk(root, vars),
    },
  };
}

function walk(n: Node, vars: Record<string, number>): number | null {
  switch (n.k) {
    case "num":
      return n.v;
    case "ref": {
      const v = vars[n.id];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    case "neg": {
      const a = walk(n.a, vars);
      return a === null ? null : -a;
    }
    case "bin": {
      const a = walk(n.a, vars);
      const b = walk(n.b, vars);
      if (a === null || b === null) return null;
      switch (n.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          // 除零不给 Infinity：屏幕上那个词分不出是算式错了还是参数拖到了边界。
          return b === 0 ? null : a / b;
      }
    }
  }
}
