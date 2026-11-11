# Irish News Digest 🇮🇪

A self-running AI workflow that collects news every morning and writes a bilingual (English / 中文) digest: Ireland (3), Tech (4), China (1), Film (1), Design & Art (1).

每天早上自动抓取新闻、生成中英双语摘要的 AI 自动化工作流：爱尔兰 3 条、科技 4 条、中国 1 条、电影 1 条、设计与艺术 1 条。

Every day, GitHub Actions pulls ~260 articles from 15 RSS feeds. An LLM scores them section by section, the top 10 get a bilingual summary, and the digest is sent to Telegram.
每天由 GitHub Actions 从 15 个 RSS 源抓取约 260 篇文章，LLM 按板块打分，选出 10 篇写双语总结，再推送到 Telegram。

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
| Schedule & Monitor / 定时与监控 | ✅ | [`.github/workflows/daily.yml`](.github/workflows/daily.yml) |

## Run locally / 本地运行

```bash
npm install
npm run sources        # list configured feeds / 列出新闻源
cp .env.example .env   # then fill in your keys / 然后填入你的 key
npm run chat-id        # find your Telegram chat id / 查找 Telegram chat id
npm run pipeline:dry   # run without sending / 运行但不发送（只打印）
npm run pipeline       # run and send to Telegram / 运行并推送到 Telegram
```

## Tech stack / 技术栈

TypeScript · Node.js · rss-parser · Mozilla Readability · zod · Groq (gpt-oss-120b) · Telegram Bot API · GitHub Actions
