# Claude Code 走 TokenHub 时 WebSearch / WebFetch 能不能用：实验结论

日期 2026-11-06 · Claude Code 2.1.318 · 网关 `https://tokenhub.corp.tokenkingos.com/api/anthropic`（115.191.26.230）

## 一句话结论

- **WebFetch：能用，和模型无关。** 抓网页在本机做，总结用 `ANTHROPIC_SMALL_FAST_MODEL` 指定的模型发给网关。唯一连 Anthropic 的地方是抓取前的域名安全检查（`api.anthropic.com/api/web/domain_info`），用 `skipWebFetchPreflight: true` 可以关掉。
- **WebSearch：要看具体模型，不由 Claude Code 决定。** 它会向网关发一个带 Anthropic 服务端工具 `web_search_20250305` 的请求，要靠网关背后的厂商真的去搜。TokenHub 只是原样转发。实测结果：
  - `wangsu/deepseek-v4.1-flash`：**能用**，真搜了，返回 10 条链接。
  - `wangsu/claude-opus-5-5`：**能用**，真搜了，返回 9 条链接。
  - `aliyun/qwen3.8-flash`：**不能用，而且不报错**。厂商没管这个工具，模型直接编了一段「搜索结果」，Claude Code 照样当搜索结果用，最后的回答还附上了编出来的来源。**这是最大的风险。**
  - `webeye/gemini-4-argon`：没测成。TokenHub 返回 500 `Cannot find ok endpoint for model webeye/gemini-4-argon`，Claude Code 重试 10 次，约 3 分钟后放弃。
  - GLM、MiniMax：这把钥匙下面没有，没测。

所以「调研专题」可以用 TokenHub 的钥匙跑，但**只能配已经验证过能真搜的模型**（目前是 DeepSeek v4.1 flash 和 Claude Opus 5.5，都走网宿）。其他模型要么关掉 WebSearch，改接搜索 MCP，要么等 TokenHub 那边补上搜索。

## 证据

### 1. 假网关看到的请求形态（127.0.0.1:47701，不用真钥匙）

日志在 `logs/fakegw.jsonl`，请求体在 `logs/bodies/*.json`。

**WebSearch 和 WebFetch 都是延迟加载的工具。** 主请求的 `tools` 里没有这两个，只有 `ToolSearch` 和一个 `DeferredToolPlaceholder`（带 `defer_loading:true`）。模型要先调 `ToolSearch select:WebSearch`，拿到 `tool_reference` 后才能调用。真实测试里 DeepSeek、Qwen、Claude 都自己完成了这一步，经过 TokenHub 没出问题。

**WebSearch 的处理（ws2）：**

1. 主模型发出 `tool_use WebSearch {query}`，Claude Code 在本地接住这次调用。
2. Claude Code 向同一个网关**另发一个请求**（#4），内容如下：
   - `model` = 主模型（`ANTHROPIC_MODEL`），设了 `ANTHROPIC_SMALL_FAST_MODEL` 也不变（ws3 验证过）
   - `tools = [{"type":"web_search_20250305","name":"web_search","max_uses":8}]`
   - system：「You run a web search for another Claude model … Search once, then reply with a brief summary」
   - user：`Perform a web search for the query: Singapore weather today`
3. 网关回来的内容会被 Claude Code 拼成 tool_result：`Web search results for query: "…"\n\nLinks: [...]\n\n<摘要>\n\nREMINDER: You MUST include the sources…`。
   - `Links:` 来自响应里的 `web_search_tool_result` 块。只有厂商真的执行了服务端搜索才会有。
   - 假网关只回了纯文本，Claude Code **没有报错**，直接把这段文本当成搜索结果。真实测试里 Qwen 也是这样。
4. stream-json 里这次调用的 `tool_use_result` 带 `searchCount` 字段：真搜了是 1，没搜是 0。**本机程序可以用它判断有没有真搜。**

**WebFetch 的处理（wf1–wf5）：**

1. 先做域名安全检查：`GET https://api.anthropic.com/api/web/domain_info?domain=…`（源码字符串可以印证；netstat 抓到 160.79.104.10:443，就是 api.anthropic.com，也是 claude.ai）。
   - 设了 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 这一步**照样会做**（wf2）。
   - 在 `--settings` 里加 `"skipWebFetchPreflight": true` 后**不再连 Anthropic**（wf3：连接里只剩网关和 example.com）。
   - 源码显示检查失败（连不上、超时、非 200）时会抛 `DomainCheckFailedError`，WebFetch 直接失败，报错文案是「Unable to verify if domain … is safe to fetch … blocking claude.ai」。**国内连不上 Anthropic 的机器，不加这个设置 WebFetch 就会失败。**
2. 抓取在本机做：netstat 抓到 104.20.23.154 和 172.66.147.243，都是 example.com。
3. 再向网关发一个**不带工具**的总结请求，内容是 `Web page content: --- … ---` 加上提问。这个请求用哪个模型：
   - 三个都不设：用主模型（wf1、wf2）
   - 只设 `ANTHROPIC_DEFAULT_HAIKU_MODEL=fake-haiku`：用 fake-haiku（wf5）
   - 两个都设：用 `ANTHROPIC_SMALL_FAST_MODEL`（wf4）

**其他观察：**

- 指向第三方地址时，`system:init` 的 tools 里**照样有 WebSearch 和 WebFetch**，没有被隐藏。源码里的说明是，只有 `CLAUDE_CODE_USE_GATEWAY`（网关模式）才「may hide its WebSearch tool」，所以本机程序**不要设它**。
- 不设 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 时，进程会先请求网关的 `/api/hello`，跑得久一点还会连 api.anthropic.com（真实测试 r1 抓到 160.79.104.10）。设了以后真实测试只连 TokenHub（r3/r4/r5）和要抓的网站（r2）。
- 每个请求都带着 `anthropic-beta`，里面有 `advanced-tool-use-2025-11-20` 等值。TokenHub 只转发 `x-` 开头的请求头（`context_builder.py:78`），所以 beta 头不会到厂商那里，但请求体里的 `defer_loading` 和 `tool_reference` 原样转发。这次测试没出问题。

### 2. TokenHub 的地址和钥匙

- 钥匙：在 `C:\Users\10021\Desktop\clark\tkos-secrets\tianshu\chat-exp-tokenhub.env` 的 `TOKENHUB_API_KEY` 里，长度 77。文件注释写的是孙铭泽 10/31 给的「产品测试 / prod-test」key。全程由脚本读出后直接放进 spawn 参数数组（`shell:false`），没有打印过。
  - 跑完后对 `logs/` 和 `ccconfig/` 做了全文比对，没有任何文件含钥匙。
- 地址：`https://tokenhub.corp.tokenkingos.com/api/anthropic`，来自 `Chat_Service-lab/docs/direct-integration.md` 和 `infra/chat-service.preview.env.example`。
- TokenHub 源码（`tokavi-tokenhub/tokavi/service/anthropic_messages_service.py`）显示：
  - 请求体字段原样转给厂商的 Anthropic 接口，只把 `model` 从 `厂商/模型` 换成厂商自己的模型名，**没有自己实现任何服务端工具**。
  - 计费 `update_cost` 还是 todo。
  - 钥匙既可以放 `x-api-key`，也可以放 `Authorization: Bearer`。
- 模型目录：Anthropic 入口下没有 `/v1/models`，但 `GET /api/openai/v1/models` 可以查。这把钥匙能用 4 个模型：
  - `wangsu/claude-opus-5-5`
  - `aliyun/qwen3.8-flash`
  - `wangsu/deepseek-v4.1-flash`
  - `webeye/gemini-4-argon`

### 3. 真实调用（共 5 次 claude 运行，另加 1 次 GET 模型目录）

所有运行都用：`--strict-mcp-config --setting-sources project,local --allowedTools WebSearch,WebFetch --max-turns 6 --output-format stream-json --verbose -p`，再加一个空的 `CLAUDE_CONFIG_DIR`。

| # | 模型 | 工具 | 结果 | 连接（netstat） |
|---|---|---|---|---|
| r1 | wangsu/deepseek-v4.1-flash | WebSearch | ✅ `searchCount 1`，10 条真实链接（中国天气网、ventusky、联合早报…），回答带来源；29 s | TokenHub + 160.79.104.10（这次没关非必要流量） |
| r2 | wangsu/deepseek-v4.1-flash | WebFetch（`skipWebFetchPreflight`，非必要流量关闭） | ✅ 回答「Example Domain」；9 s | 只有 TokenHub 和 example.com |
| r3 | aliyun/qwen3.8-flash | WebSearch | ❌ 两次都是 `searchCount 0`，没有任何链接，只有模型自己编的「summary of the results」。最终回答附上 weather.gov.sg、AccuWeather 当来源，也是编的。**没有任何报错** | 只有 TokenHub |
| r4 | webeye/gemini-4-argon | WebSearch | ⚠️ 500 `Cannot find ok endpoint for model webeye/gemini-4-argon`，重试 10 次，180 s 后失败 | 只有 TokenHub |
| r5 | wangsu/claude-opus-5-5 | WebSearch | ✅ `searchCount 1`，9 条链接（weather.com、wunderground…）；79 s | 只有 TokenHub |

r3 编出来的工具结果节选（Claude Code 原样当成搜索结果交给主模型）：

> Web search results for query: "Singapore weather today November 6 2026"
>
> I searched for the Singapore weather today … here is a brief summary: Temperature: 26-28 °C …

## 建议

### 本机程序（天枢 Runner）的配置

每个调研进程的 `--settings` 加上：

```json
{ "skipWebFetchPreflight": true,
  "env": { "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
           "ANTHROPIC_SMALL_FAST_MODEL": "<便宜的模型，WebFetch 总结用>" } }
```

效果是全程只连 TokenHub 和要抓的网站。不要设 `CLAUDE_CODE_USE_GATEWAY`。

**按模型维护「能不能真搜」的白名单。** 目前只有 `wangsu/deepseek-v4.1-flash` 和 `wangsu/claude-opus-5-5` 在名单上。不在名单上的模型：

- 用 `--disallowedTools WebSearch` 关掉 WebSearch，免得它编出假的搜索结果；
- 改接搜索 MCP（见下一节），WebFetch 照常用。

**运行时兜底：** 读 stream-json 里 WebSearch 的 `tool_use_result.searchCount`。如果是 0，或者结果里没有 `Links:`，就把这次运行标成「搜索没生效」，并提示用户。

### 不支持服务端搜索的模型怎么办（替代方案）

下面几个都是常见做法，**这次没有实测**：

| 方案 | 要不要钥匙 | 说明 |
|---|---|---|
| 博查 Bocha AI Search MCP | 要（国内，按次计费） | 国内能直连，中文结果好，适合国内同事 |
| 智谱 web-search MCP | 要智谱 key | 如果以后 TokenHub 接 GLM，可以和智谱账号放一起 |
| 阿里云 IQS（通义晓搜）/ DashScope 联网搜索 | 要阿里云 key | 和 aliyun 这条线是同一个账号体系 |
| Tavily / Brave Search / Exa MCP | 要（有免费额度） | 海外服务，国内网络不一定稳 |
| SearXNG（自建）+ MCP | 不要 | 要自己运维一个实例 |
| DuckDuckGo MCP | 不要 | 靠抓网页，不稳定，容易被限流，只适合做兜底 |

搭配方式：搜索 MCP 负责给出链接，WebFetch 负责读正文（WebFetch 已经验证可用）。

### 需要创峰在 TokenHub 那边确认或支持的事

1. **各模型对 `web_search_20250305` 服务端工具的支持情况**，尤其是 aliyun/qwen 线，以及以后接入的 GLM、MiniMax。对不支持的模型，希望 TokenHub **直接返回 400**（例如 `server tool web_search not supported for model X`），不要悄悄丢掉。悄悄丢掉会让模型编出搜索结果。
   - 更进一步的做法：由 TokenHub 自己接住 `web_search` 服务端工具，调一个搜索 API，再按 Anthropic 格式回 `server_tool_use` 和 `web_search_tool_result` 块。这样所有模型都能搜，本机程序也不用区分。
2. `webeye/gemini-4-argon` 现在没有可用的上游（`Cannot find ok endpoint`）。要么修好，要么从这把钥匙的模型列表里拿掉。
3. **搜索怎么计费**：响应 usage 里的 `server_tool_use.web_search_requests` 是厂商另外收的钱，而 TokenHub 的 `update_cost` 还是 todo。
4. 能不能在 `/api/anthropic` 下也提供 `/v1/models`。现在只有 OpenAI 入口能查模型目录。
5. 这把「prod-test」钥匙下面没有 GLM 和 MiniMax。要验证它们，需要一把带这两个模型的测试钥匙。

## 拿不准的点

- 网宿 DeepSeek 线的搜索到底是 DeepSeek 自己的 Anthropic 兼容接口在执行，还是网宿在执行，不清楚。tool_use id 是 `call_00_…` 这种 DeepSeek 风格，所以**推测**是 DeepSeek 执行的。无论哪种，都可能在上游改版后变化，白名单要定期复测。
- 每个模型只测了一次，网络波动或上游临时故障都可能影响结论。Qwen 两次搜索都是 `searchCount 0`，结论比较可靠。
- 没测在国内网络下 WebFetch 不加 `skipWebFetchPreflight` 的实际表现。结论来自源码字符串：检查失败就抛 `DomainCheckFailedError`。我们这台机器在新加坡，能连上 Anthropic。
- Claude Code 自己算的 `total_cost_usd`（r1 $0.11、r5 $0.33 等）是按 Anthropic 价格估的，对第三方模型没有参考价值。
- 第 3 节的搜索 MCP 方案凭的是已有知识，没有实测，价格和额度要以各家官网为准。

## 文件

都在 `C:\Users\10021\AppData\Local\Temp\claude\5412242dd0cafb0c\1e1fde7b-dbb6-4c7b-a0b3-c7c1a8e61db3\scratchpad\exp-thirdparty\` 下。

- 脚本：
  - `fakegw.mjs`：假网关
  - `runfake.mjs`：对假网关跑
  - `runreal.mjs`：对 TokenHub 跑
  - `keyload.mjs`：读钥匙，不打印
  - `models.mjs`：查模型目录
  - `cleanenv.mjs`、`show.mjs`
- 日志：
  - `logs/fakegw.jsonl`、`logs/bodies/`
  - `logs/ws*.stdout.jsonl`、`logs/wf*.stdout.jsonl`
  - `logs/r1–r5.stdout.jsonl`，其中 r3–r5 另有 `logs/r*.summary.json`
- 已清理：假网关已停，47701 不再监听，没有残留的 claude 进程。没有改动全局配置，没有提交或推送。
