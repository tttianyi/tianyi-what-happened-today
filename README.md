# Irish News Digest 🇮🇪

A self-running AI workflow that collects news every morning and writes a bilingual (English / 中文) digest: Ireland (3), Tech (4), China (1), Film (1), Design & Art (1).

每天早上自动抓取新闻、生成中英双语摘要的 AI 自动化工作流：爱尔兰 3 条、科技 4 条、中国 1 条、电影 1 条、设计与艺术 1 条。

> 🚧 Work in progress — built step by step. 正在一步一步搭建中。

## Pipeline / 流程

```
Trigger → Ingest → Normalize & Dedupe → LLM Processing (Structured Output) → Classify & Route → Deliver → Schedule, Monitor & Retry
触发   →  获取数据  →     清洗/去重       →        LLM 处理（结构化输出）       →     判断/路由     →  输出/通知 →  定时运行 + 监控 + 出错重试
```

| Step | Status | Code |
|---|---|---|
| Source config / 源配置 | ✅ | [`pipeline/sources.yaml`](pipeline/sources.yaml), [`pipeline/config.ts`](pipeline/config.ts) |
| Ingest / 获取数据 | ✅ | [`pipeline/ingest.ts`](pipeline/ingest.ts) |
| Normalize & Dedupe / 清洗去重 | ✅ | [`pipeline/dedupe.ts`](pipeline/dedupe.ts) |
| LLM Triage / LLM 打分分类 | ✅ | [`pipeline/llm.ts`](pipeline/llm.ts), [`pipeline/triage.ts`](pipeline/triage.ts) |
| Classify & Route / 判断路由 | ✅ | [`pipeline/digest.yaml`](pipeline/digest.yaml), [`pipeline/select.ts`](pipeline/select.ts) |
| Fetch selected articles / 抓取入选正文 | ✅ | [`pipeline/enrich.ts`](pipeline/enrich.ts) |
| Bilingual Summary / 双语总结 | ✅ | [`pipeline/summarize.ts`](pipeline/summarize.ts) |
| Deliver to Telegram / 推送到 Telegram | ✅ | [`pipeline/deliver.ts`](pipeline/deliver.ts) |
| Schedule & Monitor / 定时与监控 | ⏳ | |

## Run locally / 本地运行

```bash
npm install
npm run sources        # list configured feeds / 列出新闻源
cp .env.example .env   # then fill in your keys / 然后填入你的 key
npm run chat-id        # find your Telegram chat id / 查找 Telegram chat id
npm run pipeline:dry   # run without sending / 运行但不发送（只打印）
npm run pipeline       # run and send to Telegram / 运行并推送到 Telegram
```

## Design decisions / 设计决策

**RSS for discovery; full text only for the ~10 selected articles. / 用 RSS 发现新闻，只为入选的约 10 篇抓取正文。**
Feed snippets turned out too thin to summarize: often one sentence, Hacker News items contain only links, and half of Irish Independent items are empty. So after selection, the pipeline fetches each chosen article once and extracts the main text with Mozilla Readability (first 3,000 chars). Rules: the text is passed to the LLM only and never stored or published; output is a summary plus a link to the original; blocked or paywalled pages (e.g. HTTP 403) are respected, not worked around, and fall back to the RSS snippet, labelled "snippet only".
RSS 摘要太少，不够写总结：通常只有一句话，HN 只有链接，Independent 有一半是空的。所以选出文章后，只对这约 10 篇各访问一次，用 Mozilla Readability 提取正文（前 3000 字）。规则：正文只交给 LLM，不保存、不发布；输出只有总结和原文链接；被拒绝访问或有付费墙的页面（如 HTTP 403）不绕过，改用 RSS 摘要并标注"仅基于摘要"。

**Config separate from code. / 配置与代码分离。**
Adding a source is one entry in `sources.yaml`. The config is validated at startup so a bad entry fails fast with a clear error, instead of crashing halfway through a run.
加一个新闻源只需在 `sources.yaml` 加一项。启动时校验配置，写错会立即报出清楚的错误，而不是跑到一半才崩。

**One failing feed never sinks the run. / 单个源失败不影响整体。**
Feeds are fetched in parallel with `Promise.allSettled` and a 15s timeout each. Failures are logged and reported; the other sources continue.
用 `Promise.allSettled` 并行抓取，每个源超时 15 秒。失败会被记录，其他源照常处理。

**Feed snippets capped at 500 chars. / 摘要限制 500 字。**
This text goes to the LLM later, so the cap directly controls cost.
这段文字之后会发给 LLM，限制长度就是控制成本。

**Stable article IDs. / 稳定的文章 ID。**
Each article's ID is a hash of its normalized URL, so the same article gets the same ID on every run. This allows skipping already-processed items later (idempotency).
文章 ID 是规范化 URL 的哈希，每次运行都一样，方便以后跳过已处理的文章（幂等性）。

**Two-layer dedupe. / 两层去重。**
1. **Exact URL match** after normalizing (strip `www.`, `utm_*` params, `#fragment`, trailing slash). Catches e.g. Hacker News linking to the same TechCrunch article.
   **URL 精确匹配**：先规范化再比较，例如识别 HN 链接到同一篇 TechCrunch 文章。
2. **Fuzzy title match** with Jaccard similarity (shared words ÷ all words) ≥ 0.6.
   **标题模糊匹配**：Jaccard 相似度（共有词 ÷ 全部词）≥ 0.6。

Lessons from real data / 从真实数据中学到的：
- **Short titles cause false matches.** `"The 9 at 9: Tuesday"` and `"The 5 at 5: Tuesday"` both reduce to `{the, tuesday}` → 100% similar. Titles with fewer than 4 words now skip fuzzy matching (URL matching still applies).
  **短标题会误判。** 两个不同栏目被判为重复。现在少于 4 个词的标题跳过模糊匹配（仍做 URL 匹配）。
- **The threshold needs tuning on real data.** A true duplicate pair scored only 0.64, because `blood-stained` vs `bloodstained` tokenize differently.
  **阈值需要用真实数据调。** 一对真正的重复只得了 0.64 分，因为 `blood-stained` 和 `bloodstained` 被拆成了不同的词。
- **Word overlap can't catch the same story under different headlines.** That needs semantic understanding, planned for the LLM step.
  **不同标题报道同一件事，词重合法识别不了**，需要语义理解，计划在 LLM 步骤中解决。

**Two-stage LLM processing. / 两段式 LLM 处理。**
Stage 1 (triage) scores every article 1–5 and tags a topic, from the title plus the first 200 characters of the snippet only. Stage 2 writes bilingual summaries for the top articles alone. ~260 articles are triaged in 11 calls using ~29K tokens.
第一段只看标题和摘要前 200 字，给每篇文章打分（1～5）和分类；第二段只给高分文章写双语总结。约 260 篇文章，11 次调用，约 2.9 万 token。

**One scoring rubric per section. / 每个板块一套评分标准。**
With a single rubric ("matters to a reader in Ireland"), film and art stories almost always scored 1–2 next to Irish politics, so picking the top one in those sections was close to random. Now each section in `digest.yaml` has its own rubric, and its articles are batched together, so the model compares film with film, not film with the budget. This costs almost nothing extra: tokens are dominated by the articles, not the prompt, and articles that belong to no section are never scored. Adding a new area is config only: sources plus one section with its rubric. Config validation also rejects a category listed in two sections, which would score an article twice.
只用一套标准（"对住在爱尔兰的读者有多重要"）时，电影和艺术类文章和爱尔兰政治放在一起比，几乎总是 1～2 分，这些板块选出哪篇基本靠运气。现在 `digest.yaml` 里每个板块有自己的评分标准，同板块的文章放在同一批里打分，模型拿电影和电影比，而不是和预算比。额外成本几乎为零：token 主要花在文章上而不是 prompt 上，不属于任何板块的文章也不会被打分。加新领域只需改配置：加源，再加一个带评分标准的板块。配置校验还会拒绝同一分类出现在两个板块中（否则一篇文章会被打两次分）。

**Strict scoring, and one article per company. / 严格打分，同一公司只选一条。**
- The first per-section run gave 8 of 10 picks a 5, so ties were decided by recency, not importance. The prompt now says most articles are 2–3 and at most one or two per batch get a 5. One test batch went from mostly 5s to 1–3 with two 4s.
  第一次按板块打分时，10 篇入选文章里有 8 篇是 5 分，并列时只能按时间排，打分失去了意义。现在 prompt 要求多数文章 2～3 分、每批最多一两篇 5 分。一批测试结果从几乎全是 5 分变成了 1～3 分加两篇 4 分。
- The tech section was 3 of 4 about Anthropic. Triage now also returns a `subject` (main company, organisation or person; products map to the parent company, e.g. Claude → Anthropic), and selection allows one article per subject per section. Cost: a few tokens per article, about 3% more per day. Keyword matching would have been free but can't tell that "Claude" means Anthropic.
  科技板块 4 条里有 3 条是 Anthropic。现在打分时还会输出 `subject`（主要公司、机构或人物；产品归到母公司，如 Claude → Anthropic），选文章时每个板块里同一主体最多一条。成本是每篇多几个 token，每天约多 3%。用关键词匹配不花 token，但认不出 "Claude" 就是 Anthropic。

**Be liberal in what you accept from the LLM. / 对 LLM 的输出要宽容接收。**
`topic` used to be an enum in the JSON schema. When the model wrote one off-list value, Groq rejected the whole batch and 30 articles went unscored. Now `topic` is a string, the allowed list is in the prompt, and off-list values become `other` in code: one small slip no longer costs a whole batch.
`topic` 原来是 JSON schema 里的枚举。模型只要写错一个值，Groq 就拒绝整批结果，30 篇文章都没有分数。现在 `topic` 是字符串，允许的值写在 prompt 里，列表外的值在代码里归为 `other`：一个小错不再影响整批。

**Provider-agnostic LLM layer. / 不绑定某个 LLM 厂商。**
The pipeline depends only on an `LLMClient` interface. Groq (free tier) is the current implementation; switching provider means adding one class.
pipeline 只依赖 `LLMClient` 接口。目前使用 Groq 免费版，换厂商只需新增一个实现类。

**Structured output, validated twice. / 结构化输出，双重校验。**
One zod schema produces the TypeScript type, the JSON Schema sent to the model (strict mode), and the runtime check on the response. LLM output is treated as untrusted input.
一个 zod schema 同时生成 TS 类型、发给模型的 JSON Schema（strict 模式）和对返回结果的运行时校验。LLM 的输出按不可信输入处理。

**Numbered articles instead of IDs in prompts. / prompt 里用编号代替 ID。**
Articles are sent as `[1]`, `[2]`… rather than 12-character IDs: fewer tokens, and any number outside the batch is easy to reject.
文章用 `[1]`、`[2]` 编号而不是 12 位 ID：更省 token，超出范围的编号也很容易识别和丢弃。

**Built for a rate-limited free tier. / 针对免费版限流设计。**
Batches run sequentially, not in parallel (the limit is tokens per minute). 429s are retried by the SDK using `retry-after`. A batch that still fails is retried once, then left unscored, so the run always finishes. An invalid API key stops the run immediately.
批次串行执行（限制的是每分钟 token 数）。429 由 SDK 按 `retry-after` 自动重试。仍然失败的批次重试一次，再失败就标记为未打分，保证整个流程能跑完。API key 错误则立即停止。

**Model choice was tested, not assumed. / 模型选择经过实测，而不是凭印象。**
The plan was Qwen for Chinese summaries. Under Groq's strict JSON mode it failed on 5 of 10 articles (malformed output), and with low reasoning it added a claim not in the source. gpt-oss-120b succeeded 10/10 with natural Chinese, so both stages use it (low reasoning for triage, medium for summaries).
原计划用 Qwen 写中文总结，但在 Groq 的 strict JSON 模式下 10 篇失败了 5 篇（输出格式错乱），低推理强度时还会多编一句原文没有的话。gpt-oss-120b 10/10 成功，中文自然，所以两段都用它（打分用 low，总结用 medium）。

**One LLM call per summary. / 每篇总结单独调用。**
Ten article texts in one request would exceed the free tier's 8K tokens per minute, and per-article calls keep failures isolated. A failed summary still appears in the digest as headline + link.
10 篇正文放在一个请求里会超过免费版每分钟 8K token 的上限；分开调用也能让失败互不影响。总结失败的文章仍会以标题 + 链接出现在日报里。

**Daily usage. / 每日用量。** One full run ≈ 46K tokens (triage ~29K + summaries ~17K), about a quarter of the free tier's daily token limit.
完整运行一次约 4.6 万 token（打分约 2.9 万 + 总结约 1.7 万），约为免费版每日上限的四分之一。

**Telegram delivery: HTML, split safely, fail loudly. / Telegram 推送：HTML 格式、安全拆分、失败要报错。**
- HTML parse mode instead of MarkdownV2: only `& < >` need escaping, vs 18 characters in MarkdownV2 (including `. - ( ) !`, which are everywhere in news).
  用 HTML 而不是 MarkdownV2：只需转义 `& < >`，MarkdownV2 要转义 18 个字符（包括新闻里到处都是的 `. - ( ) !`）。
- One message per section (5 messages a day). A section is never split across messages, and only the first message notifies; the rest are sent silently. (The first version packed everything up to Telegram's 4,096-character limit, which cut sections in half.)
  每个板块一条消息（每天 5 条），板块不会被拆开；只有第一条发出提醒，其余静默发送。（第一版把内容塞满 4096 字上限再拆分，结果板块被从中间切断。）
- Telegram config is checked before any LLM call, so a missing setting costs zero tokens. A send failure makes the run exit as failed instead of passing silently.
  在调用 LLM 之前先检查 Telegram 配置，缺配置不浪费 token。发送失败时整个运行以失败退出，而不是悄悄"成功"。
- The bot token is part of the API URL, so URLs are never logged.
  bot token 是 API URL 的一部分，所以日志里从不打印 URL。

## Tech stack / 技术栈

TypeScript · Node.js · rss-parser · Mozilla Readability · zod · Groq (gpt-oss-120b) · Next.js (planned) · GitHub Actions (planned)
