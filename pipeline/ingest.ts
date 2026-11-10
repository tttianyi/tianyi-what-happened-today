// 第 2 步（上）：获取数据 / Step 2a: Ingest
import Parser from "rss-parser";
import { createHash } from "node:crypto";
import type { Source } from "./config.js";
import { normalizeUrl } from "./dedupe.js";

/**
 * 统一的文章格式。不管来源是 RSS 还是 Atom，都转换成这个结构，后续步骤只认这一种。
 * One common article shape. RSS and Atom feeds both map into this,
 * so later steps only deal with one format.
 */
export interface Article {
  id: string;          // 规范化 URL 的哈希，稳定且唯一 / hash of normalized URL: stable & unique
  sourceId: string;
  sourceName: string;
  category: string;
  title: string;
  url: string;
  publishedAt: string; // ISO 8601 时间 / ISO 8601 timestamp
  snippet: string;     // RSS 自带的摘要，不是全文 / feed-provided summary, not full text
}

const parser = new Parser();
const FETCH_TIMEOUT_MS = 15_000; // 单个源最多等 15 秒 / give each feed at most 15s
const SNIPPET_MAX_CHARS = 500;   // 控制后面喂给 LLM 的长度（= 控制成本）/ caps LLM input size (= cost)

/** 抓取一个源，只保留 `since` 之后发布的文章 / Fetch one feed, keep items published after `since` */
async function fetchSource(source: Source, since: Date): Promise<Article[]> {
  // 自己用 fetch 下载，这样可以设置超时和 User-Agent
  // Download with fetch ourselves so we control the timeout and User-Agent
  const res = await fetch(source.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "irish-news-digest/0.1 (personal RSS reader)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const feed = await parser.parseString(await res.text());

  const articles: Article[] = [];
  for (const item of feed.items) {
    // 没有链接、标题或日期的条目直接跳过：没有日期就无法判断是不是"今天的新闻"
    // Skip items missing link/title/date — without a date we can't tell if it's today's news
    if (!item.link || !item.title || !item.isoDate) continue;
    if (new Date(item.isoDate) < since) continue;

    articles.push({
      id: createHash("sha1").update(normalizeUrl(item.link)).digest("hex").slice(0, 12),
      sourceId: source.id,
      sourceName: source.name,
      category: source.category,
      title: item.title.trim(),
      url: item.link,
      publishedAt: item.isoDate,
      snippet: (item.contentSnippet ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX_CHARS),
    });
  }
  return articles;
}

/**
 * 并行抓取所有源。一个源失败不影响其他源（Promise.allSettled 而不是 Promise.all）。
 * Fetch all feeds in parallel. One failing feed doesn't sink the rest
 * (Promise.allSettled, not Promise.all).
 */
export async function ingestAll(sources: Source[], hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const results = await Promise.allSettled(sources.map((s) => fetchSource(s, since)));

  const articles: Article[] = [];
  const failures: { sourceId: string; error: string }[] = [];

  results.forEach((result, i) => {
    const source = sources[i];
    if (result.status === "fulfilled") {
      console.log(`  ✓ ${source.id.padEnd(16)} ${result.value.length} articles`);
      articles.push(...result.value);
    } else {
      const error = String(result.reason?.message ?? result.reason);
      console.log(`  ✗ ${source.id.padEnd(16)} FAILED: ${error}`);
      failures.push({ sourceId: source.id, error });
    }
  });

  return { articles, failures };
}
