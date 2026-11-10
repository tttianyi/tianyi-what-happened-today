# Irish News Digest 🇮🇪

A self-running AI workflow that collects Irish and tech news every morning and writes a bilingual (English / 中文) digest.

每天早上自动抓取爱尔兰本地新闻和科技新闻，生成中英双语摘要的 AI 自动化工作流。

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
| Bilingual Summary / 双语总结 | 🚧 | |
| Classify & Route / 判断路由 | ⏳ | |
| Deliver / 输出 | ⏳ | |
| Schedule & Monitor / 定时与监控 | ⏳ | |

## Run locally / 本地运行

```bash
npm install
npm run sources    # list configured feeds / 列出新闻源
npm run pipeline   # run the pipeline / 运行流水线
```

## Design decisions / 设计决策

**Public RSS only, no scraping. / 只用公开 RSS，不抓全文。**
Feeds are stable, legal to consume, and already include a short summary. Paywalled sources (e.g. The Irish Times) contribute only their headline and feed snippet.
RSS 稳定、合规，而且自带摘要。付费墙媒体只使用标题和 RSS 摘要。

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
Stage 1 (triage) scores every article 1–5 and tags a topic, from the title plus the first 200 characters of the snippet only. Stage 2 writes bilingual summaries for the top articles alone. ~210 articles are triaged in 8 calls using ~23K tokens.
第一段只看标题和摘要前 200 字，给每篇文章打分（1～5）和分类；第二段只给高分文章写双语总结。约 210 篇文章，8 次调用，约 2.3 万 token。

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

## Tech stack / 技术栈

TypeScript · Node.js · rss-parser · zod · Groq (gpt-oss-120b) · Next.js (planned) · GitHub Actions (planned)
