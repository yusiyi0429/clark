# 01 · 搜到 signal（抓取 / catching）

> 快照 2026-08-21。本文件对应五段流程里的第 ① 段。

## 结论先说：**这一段的 Prompt 不在本仓库里**

`clark` 这个前端仓库**没有任何联网抓取能力**，也没有一句抓取用的 Prompt。抓取跑在另一侧 ——
一台叫**实验台**（`tkos-lab`，Python 服务）的东西上。前端做的事只有两件：

1. 把「主动开始扫描」这一下发起权交给一号位：去实验台起一轮 `catching`、一步一步推完、把过线的信号收回来；
2. 把实验台此刻在用的那份靶点策略读出来摆到屏幕上（「监控策略」那一页）。

**参数（靶点策略、阈值、模型、深度）全部来自实验台，这边一个字都不写死、也不抄一份副本。**
理由：抓取参数只能有一个真源。这边存一份副本，屏幕上那六个观察域和实验台真正在用的那份就会各走各的，
而一号位问「你到底在盯什么」的时候，两份答案里没有一份能被指着说「就是它」。

常态其实也不是这条路 —— 常态是实验台自己定时跑 `scripts/catch.py` 把信号推过来。

## 抓取 Prompt 到哪里取

实验台把抓取那一段的认知正文叫「第 ③ 段」（和本仓库的五段装配是同一套编号，见 `00`）。取法两条：

| 情况 | 取哪一份 | 代码 |
| --- | --- | --- |
| 配了环境变量 `TKOS_LAB_FROM_RUN` | 那一次实验的 `prompt_body`（必须是 `channel === "catching"` 的运行，否则报错拒跑） | `src/lib/scan/run.ts` → `fromRun` |
| 没配 | 实验台 `GET /api/meta` 里的 `default_cognitive.catching` + `default_spec` | `src/lib/scan/run.ts` → `fromDefaults` |

所以**要拿到抓取 Prompt 的原文，去实验台读这两处之一**，或者直接看实验台仓库里
`prompts/cognitive/catching.md`（这一侧读到的就是它）。

用到的三个环境变量（**只列变量名，值不进文档**）：`TKOS_LAB_BASE_URL`、`TKOS_LAB_PASSWORD`、
`TKOS_LAB_FROM_RUN`。没配前两个，屏幕上照实说「这台机器还没配 …，主动扫描起不来」，不做假动作。

```ts
async function fromRun(client: LabClient, runId: string): Promise<Seed> {
  const src = await client.run(runId);
  if (src.channel !== "catching") {
    throw new LabError(
      `TKOS_LAB_FROM_RUN 指的 ${runId} 是 ${src.channel} 频道的运行，不能拿它跑抓取。`
    );
  }
  const cfg = asObj(src.config);
  const body = str(src.prompt_body);
  if (!body) throw new LabError(`实验台的 ${runId} 没有 Prompt 正文，这一轮起不来。`);
  return {
    promptBody: body,
    model: str(cfg.model),
    depth: str(cfg.depth),
    topic: str(asObj(src.inputs?.[0]).q),
    // replay_of 强制置空：回放是「固定证据只改研判」的实验手段，线上要的是新证据。
    spec: { ...asObj(cfg.spec), replay_of: null },
    ...(typeof cfg.temperature === "number" ? { temperature: cfg.temperature } : {}),
  };
}
```

```ts
/**
 * 没指定实验时：实验台的默认策略。默认值的唯一真源在实验台，这边不抄。
 *
 * 只取两样 —— 抓取频道的默认认知正文（第③段）和默认 spec。**模型和深度一个字
 * 不挑**：`/api/meta` 的 `models` 是可选清单（`alias` + 报价 + 备注），里面没有
 * 「哪个是默认」这一位，起 run 的时候不给就是实验台自己的默认。
 * 曾经在这里按 `m.default` / `m.id` 猜过一次，结果是每一轮都起不来。
 *
 * 实验台的默认模型现在是 opus-5 —— 贵。要按更便宜的那套上线，就在实验台里把
 * 一次 catching 调好，然后把那个 run id 配到 `TKOS_LAB_FROM_RUN`。
 */
async function fromDefaults(client: LabClient): Promise<Seed> {
  const meta = await client.meta();
  const body = str(asObj(meta.default_cognitive).catching);
  if (!body) {
    throw new LabError("实验台没有给出抓取频道的默认认知正文，请配 TKOS_LAB_FROM_RUN 指一次实验。");
  }
  return {
    promptBody: body,
    topic: "",
    spec: { ...asObj(meta.default_spec), replay_of: null },
  };
}
```

## 这一侧的三条硬规矩（`src/lib/scan/run.ts` 文件头原文）

```ts
/**
 * 「主动开始扫描」按下去之后真正发生的事。
 *
 * 一号位在空屏上按一下 → 这里去实验台起一轮 `catching`、一步一步把它推完、
 * 把过线的信号按同一份跨仓库契约收进待挑列表。
 *
 * ## 三条不许破的规矩
 *
 * 1. **屏幕上那行进度必须是实验台给的原话。** `progress.label` 来自 harness 的
 *    `describe_step`，这边一个字都不编。产品原则那一条（`home-view.tsx`：绝不出现
 *    「正在分析全网资讯」）在这里的落法就是它 —— 编出来的步骤名没人核得动。
 * 2. **起不来就照实说起不来。** 没配地址/口令、实验台没起着、口令不对，都原样写在
 *    屏幕上，不做「看起来在扫」的假动作。
 * 3. **收下来的东西走同一个收件校验**（`parseInboxPayload` + `inboxSignalsPut`），
 *    和实验台自己定时推过来那条路一模一样。这边不另开一条宽松的入口 —— 那意味着
 *    两条路收进来的数据能不一样，而列表上分不出哪条是哪条。
 *
 * ## 它不是常态那条路
 *
 * 常态是实验台定时跑 `scripts/catch.py` 推过来。这条路只是把发起权交到他手上，
 * 参数（靶点策略、阈值、模型、深度）全部来自实验台，`TKOS_LAB_FROM_RUN` 配的那次
 * 实验就是「线上跑的是哪套参数」的答案。
 */
```

第 1 条是产品原则在这里的落法：屏幕上那行进度是实验台 harness 的 `describe_step` 原话，
这边一个字都不编 —— 「正在分析全网资讯」这种编出来的步骤名没人核得动。

## 一号位能改的只有「取向」，不能改阈值

「这一轮多盯着点什么」那句话（`monitorFocusText()`）会覆盖实验台那次实验里存的主题，
落在 `inputs[0].q` 上。这是抓取那一侧**为这一轮留的位置**，不是抢参数：他此刻的交代比几天前调参时
填的主题新，所以它说了算。阈值、时间窗、每源上限这些他碰不到。

## 屏幕上那份靶点策略是怎么读出来的

`src/lib/scan/strategy.ts` 每次去实验台现读同一份东西，内存缓存 10 分钟（**不落盘** ——
进程一重启就重新读，那比让一份看不出新旧的副本活过重启要好）。

三种返回都要能上屏：读到了 / 读不到 / **读不到但手上还有上一次那份**（附上「几点读到的」）。
第三种最常见 —— 实验台是本机上起着的服务，它不总在。

```ts
/**
 * 「监控策略」那一屏读的东西 —— **雷达此刻按的是哪一份靶点策略。**
 *
 * ## 为什么是现读，不是这边存一份
 *
 * 抓取参数的唯一真源在实验台（`run.ts` 顶上那条规矩）。这一页要是存一份副本，屏幕上
 * 那六个观察域和实验台真正在用的那份就会各走各的，而一号位问「你到底在盯什么」时，
 * 两份答案里没有一份能被指着说「就是它」。所以这里每次去实验台读同一份东西：
 * 配了 `TKOS_LAB_FROM_RUN` 就读那一次实验的策略正文与 spec（**和起一轮扫描时用的
 * 是同一份**，见 `run.ts` 的 `fromRun`），没配就读实验台的默认策略。
 *
 * 代价是这一页依赖实验台起着。读不到就照实说读不到，并且**把上一次读到的那份摆出来
 * 附上读到的时间** —— 一个字都不编，也不因为读不到就让整页变空。
 *
 * ## 解析是尽力而为的，这一点必须在屏幕上兜住
 *
 * 策略正文是给模型读的 markdown（四节：主体画像 / 观察域与 KIQ / 源类型指引 /
 * 准入标准）。这里把「战略假设」和「观察域 + KIQ」认出来摊成条目，是为了让他扫一眼
 * 就知道在盯什么。**格式一改，认不出来的那部分就是空的** —— 所以详情页同时照登正文
 * 原文（`body`）：认出来的那几条是方便，正文才是凭据。
 */
```

### 策略正文的格式（这是抓取 Prompt 的一部分，解析是尽力而为的）

策略正文是给模型读的 markdown，四节：主体画像 / 观察域与 KIQ / 源类型指引 / 准入标准。
这边只把「战略假设」和「观察域 + KIQ」认出来摊成条目，**认不出来就是空的，不猜**：

```text
H1 「AI 转型必须从一号位开始」是有效的市场切入；
**D1 竞争与替代**（对应 H1、H2）
- KIQ1.1 Palantir / Aera 类平台有无面向中国市场或
  一号位场景的新动作？
```

所以详情页同时照登正文原文（`body`）：**认出来的那几条是方便，正文才是凭据。**

```ts
/**
 * 从策略正文里认出战略假设和观察域。**认不出来就是空的，不猜。**
 *
 * 正文里这两样长这样（`\n` 是原文的换行，续行缩进）：
 *
 *     H1 「AI 转型必须从一号位开始」是有效的市场切入；
 *     **D1 竞争与替代**（对应 H1、H2）
 *     - KIQ1.1 Palantir / Aera 类平台有无面向中国市场或
 *       一号位场景的新动作？
 *
 * 所以要做的就两件事：认出每一条的开头，把缩进的续行接回去。接回去的时候中文之间
 * 不补空格、拉丁词之间补一个 —— 原文是排版换行，`Gartner\n  DIP` 接成 `GartnerDIP`
 * 是错的，`或\n  一号位场景` 接成 `或 一号位场景` 也是错的。
 */
export function parseStrategyBody(body: string): {
  hypotheses: string[];
  domains: MonitorDomain[];
} {
  const hypotheses: string[] = [];
  const domains: MonitorDomain[] = [];

  /** 当前正在攒的那一条：它攒完之后进哪个筐。 */
  let bucket: "hypothesis" | "kiq" | null = null;
  let buf = "";

  const flush = () => {
    const text = buf.trim();
    buf = "";
    const where = bucket;
    bucket = null;
    if (!text || !where) return;
    if (where === "hypothesis") hypotheses.push(text);
    // KIQ 只挂在已经开了的那个域下面。域还没开就出现的 KIQ 一律丢 —— 那说明格式变了，
    // 而把它挂到「上一个域」上是在编一条对应关系。
    else if (domains.length > 0) domains[domains.length - 1].kiqs.push(text);
  };

  for (const raw of body.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      continue;
    }

    // `**D1 竞争与替代**（对应 H1、H2）` —— 标题带上后面那个括号：那一句写的是
    // 这个域对着哪几条假设，是这一行里最有用的半句。
    const domain = /^\*\*(D\d+)\s+([^*]+?)\*\*(.*)$/.exec(trimmed);
    if (domain) {
      flush();
      domains.push({
        code: domain[1],
        title: `${domain[2].trim()}${domain[3].trim()}`,
        kiqs: [],
      });
      continue;
    }

    const kiq = /^[-*]\s+(KIQ\S*\s+.+)$/.exec(trimmed);
    if (kiq) {
      flush();
      bucket = "kiq";
      buf = kiq[1];
      continue;
    }

    const hypothesis = /^(H\d+)\s+(.+)$/.exec(trimmed);
    if (hypothesis) {
      flush();
      bucket = "hypothesis";
      buf = `${hypothesis[1]} ${hypothesis[2]}`;
      continue;
    }

    // 小节标题、别的条目 —— 都不是我们要的，但它们终结上一条。
    if (/^#{1,6}\s/.test(trimmed) || /^[-*]\s/.test(trimmed)) {
      flush();
      continue;
    }

    // 缩进的续行。只在正攒着某一条的时候才算续行。
    if (bucket && /^\s/.test(line)) buf = join(buf, trimmed);
    else flush();
  }
  flush();

  // 句末那个分号是原文断句用的，摊成条目之后它只是一个多余的符号。
  return { hypotheses: hypotheses.map((h) => h.replace(/[；;]$/, "")), domains };
}
```

### spec 里那几个数在屏幕上怎么说

`limitsOf(spec)` **只写 spec 里真有的那几项**，缺哪一项就少一句，不补默认值 —— 这一页说的是
「实验台此刻按什么扫」，补一个默认值等于替它答。

```ts
/**
 * spec 里那几个数摊成人话。**只写 spec 里真有的那几项** —— 缺哪一项就少一句，
 * 不补默认值：这一页说的是「实验台此刻按什么扫」，补一个默认值等于替它答。
 */
function limitsOf(spec: Record<string, unknown>): string[] {
  const out: string[] = [];
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

  const hours = num(spec.time_window_hours);
  if (hours !== undefined) {
    out.push(`只看最近 ${hours} 小时内发布的（约 ${Math.round(hours / 24)} 天），更旧的直接落掉`);
  }
  const threshold = num(spec.threshold);
  if (threshold !== undefined) {
    out.push(`研判打分低于 ${threshold} 的不端到您面前`);
  }
  const triage = num(spec.max_signals_to_triage);
  if (triage !== undefined) out.push(`每轮最多逐条研判 ${triage} 条`);
  const perSource = num(spec.per_source_limit);
  if (perSource !== undefined) out.push(`每个源每轮最多取 ${perSource} 篇`);

  const discovery = asObj(spec.discovery);
  if (discovery.enabled === true) {
    const max = num(discovery.max_new_sources);
    out.push(max === undefined ? "允许自己提名新源" : `允许自己提名新源，每轮最多 ${max} 个`);
  } else if (discovery.enabled === false) {
    out.push("只看钉住的源，不自己找新源");
  }

  const pinned = Array.isArray(spec.pinned_sources) ? spec.pinned_sources.length : undefined;
  if (pinned !== undefined) {
    out.push(pinned === 0 ? "没有钉住的源，每轮都从搜索里找" : `钉住的源 ${pinned} 个`);
  }

  /*
   * 只译实验台真的实现了的那几家（`evidence/search.py` 的 `REGISTRY`）。没见过的
   * 原样写出来 —— 编一个译名比写原名更难查：屏幕上写着一个搜不到的中文词，就没人
   * 对得回实验台那边的 provider 名。
   */
  const provider = str(spec.search_provider);
  const zh: Record<string, string> = { bocha: "博查", doubao: "豆包搜索" };
  if (provider) out.push(`搜索走${zh[provider] ?? ` ${provider}`}`);

  return out;
}
```

## 收下来之后

过线的信号走**同一个收件校验**（`parseInboxPayload` + `inboxSignalsPut`），和实验台定时推过来那条路
一模一样。这边不另开一条宽松入口 —— 那意味着两条路收进来的数据能不一样，而列表上分不出哪条是哪条。

收进来的每一条信号，接着走的就是下一份文件：`02_signal转潜在议题.md`（A1a）。
