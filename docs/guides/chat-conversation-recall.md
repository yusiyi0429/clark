# 首页对话的会话目录与回看（给 Chat 接）

天枢把对话按天分段：上一次发言距现在满 12 小时，或在北京时间今天凌晨 4 点之前，就换一段。首页由天枢在 Chat 里新开一段（`CHAT_SESSION_ROTATION=1` 才开）；天枢页面（议题、会议、执行事项、任务卡、复盘等）由天枢自己的运行时换段（`CONVERSATION_SEGMENTS`，缺省开）。界面上仍是一条连续的对话，段之间一行日期。

每段有一份会话纪要：后台轻模型写，这段最后一次发言过 15 分钟后增量更新。纪要不进个人记忆，按需回看。Chat 要做的只有两件事：

1. 每轮读一次会话目录，放进本轮资料（建议放在最后一条用户消息里，不放 system）。
2. 注册两个工具，转调下面两个回看接口。提示词加一句：「用户提到以前聊过的事，或你判断需要以前的讨论时，先看会话目录、用这两个工具查，不要说不记得。」

## 鉴权

和现有 `/internal/*` 一样：`Authorization: Bearer <INTERNAL_CHAT_TOKEN>`、`X-Owner-Id: <personId>`、`X-Viewer-Role: ceo | member`。

| 情况 | 返回 |
| --- | --- |
| 凭据不对 | 401 |
| 没带视角，或视角不是 ceo / member | 400 `VIEW_REQUIRED` |
| 本人用不了这个视角 | 403 `VIEW_NOT_ALLOWED` |
| X-Owner-Id 不在人员目录 | 404 `OWNER_NOT_FOUND` |

只返回本人的段。首页的段按视角隔离（CEO 视角看不到成员视角的首页段，反之亦然）；天枢页面的段属于本人，两种视角都能看到。原对话被隐藏的段不出现。时间都是北京时间的文字。

## `GET /internal/conversation-catalog`

查询参数 `conversationId`（可选）是本轮所在的 Chat 段。带上时排除这段，「上一段」是比它早开的最近一段首页段；不带时按最新开的那段算。

```json
{
  "viewerRole": "ceo",
  "previous": {
    "segmentId": "uuid",
    "date": "10月27日",
    "page": "首页",
    "title": "渠道下沉的打法",
    "digest": "截至 10月27日 18:20\n- 本人确认：先做县城样板……",
    "note": "这一段最后几轮还没整理进纪要，需要时用 read_past_conversation 读原文。"
  },
  "recent": [
    { "segmentId": "uuid", "date": "10月26日", "page": "议题：是否调整渠道投入", "title": "渠道投入的取舍" }
  ]
}
```

- `previous`：首页上一段的完整纪要（≤1,500 字），也就是换段时的交接。没有上一段时为 `null`。纪要还没写好时只有 `segmentId`、`date`、`page` 和 `note`，没有 `title`、`digest`；纪要没覆盖到最后几轮时带 `note`。
- `recent`：近 14 天其他段（首页和各个天枢页面）的一行目录，按最后发言时间倒序，最多 10 条，只列有纪要的段。
- 新用户没有任何旧段时，`previous` 为 `null`，`recent` 为 `[]`。

## `GET /internal/conversation-recall/search`

对应工具 `search_past_conversations({ query?, from?, to?, page? })`。

| 参数 | 说明 |
| --- | --- |
| `query` | 关键词（≤200 字），在纪要的标题、关键词和正文里查 |
| `from`、`to` | 北京时间的日期 `YYYY-MM-DD`（`to` 含当天），也接受 ISO 时间；写错返回 400 `INVALID_INPUT` |
| `page` | 第几页，从 1 开始，每页 5 段 |

纪要里查到：

```json
{ "viewerRole": "ceo", "segments": [{ "segmentId": "uuid", "date": "10月27日", "page": "首页", "title": "…", "when": "10月27日 09:10 至 10月27日 18:20", "excerpt": "纪要前 300 字" }], "page": 1, "nextPage": 2 }
```

`nextPage` 只在还有下一页时出现。纪要里查不到时，退回按原话查天枢页面的对话（Chat 段只查纪要，不逐段翻 Chat）：

```json
{ "viewerRole": "ceo", "segments": [], "note": "纪要里没有找到，下面是按原话查到的片段。",
  "hits": [{ "segmentId": "uuid", "page": "议题：…", "at": "10月26日 15:02", "who": "本人", "snippet": "…", "cite": "cite:chat:<会话 id>#<序号>" }] }
```

`hits` 里还没切进段的原话没有 `segmentId`。都没有时返回 `{ "segments": [], "message": "本人以前的对话里没有找到相关内容。" }`，模型应如实说没找到。

## `GET /internal/conversation-recall/:segmentId`

对应工具 `read_past_conversation({ segmentId, cursor? })`。

不带 `cursor` 时返回这段的完整纪要：

```json
{ "viewerRole": "ceo", "segmentId": "uuid", "page": "首页", "when": "…至…", "title": "…", "digest": "截至 …", "rawCursor": "0", "howToReadRaw": "要原话时带 cursor 再调一次，分页读原文。" }
```

纪要还没写好时没有 `digest`，带 `note`。带 `cursor` 时分页读原文，第一次用 `rawCursor`，每页 ≤8,000 字：

```json
{ "viewerRole": "ceo", "segmentId": "uuid", "page": "首页", "when": "…", "messages": [{ "who": "本人", "at": "10月27日 09:10", "text": "…" }, { "who": "天枢", "text": "…" }], "nextCursor": "12" }
```

`nextCursor` 为 `null` 时这段读完了。首页段的 `at` 只在 Chat 的消息带 `turnAt` 时出现。段不存在、不是本人的或已隐藏：404 `SEGMENT_NOT_FOUND`；`cursor` 不是数字：400 `INVALID_INPUT`。

## 天枢这边怎么用同一套

天枢页面的运行时每轮把同样结构的目录（`previous` 是本页面的上一段）放进本轮上下文包的 `conversationCatalog`，只放在发给模型的那条用户消息里，不进历史。工具名和参数与上面相同，代替原来的 `search_conversation_history`。实现在 `apps/api/src/conversationRecall.ts`（目录与两个工具）和 `apps/api/src/conversationDigests.ts`（切段与纪要）。
