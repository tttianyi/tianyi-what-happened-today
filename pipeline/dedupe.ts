// 第 2 步（下）：清洗 + 去重 / Step 2b: Normalize & Deduplicate
import type { Article } from "./ingest.js";

/**
 * 规范化 URL，让"同一篇文章的不同写法"变成同一个字符串
 * Normalize a URL so different spellings of the same article compare equal.
 *
 * 例 / e.g.  https://www.site.ie/story/?utm_source=rss#top
 *        →  https://site.ie/story
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = ""; // 去掉 #锚点 / drop #fragment
    // 去掉追踪参数（先复制 key 列表，边遍历边删除会出问题）
    // Remove tracking params (copy keys first — deleting while iterating skips items)
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "ref") u.searchParams.delete(key);
    }
    u.hostname = u.hostname.replace(/^www\./, "");
    return u.toString().replace(/\/$/, ""); // 去掉末尾斜杠 / trailing slash
  } catch {
    return raw.trim(); // 不是合法 URL 就原样返回 / not a valid URL: keep as-is
  }
}

/** 标题 → 词集合（小写、去标点、去掉短词） / Title → set of words (lowercase, no punctuation, no short words) */
function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ") // \p{L} = 任何语言的字母，包括 é / letters in any language
      .split(/\s+/)
      .filter((w) => w.length > 2), // 去掉 "a", "of", "to" 这类词 / skip tiny words
  );
}

/**
 * Jaccard 相似度 = 交集大小 / 并集大小，结果在 0~1 之间
 * Jaccard similarity = |A ∩ B| / |A ∪ B|, ranges 0..1
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

export interface RemovedDuplicate {
  article: Article;
  duplicateOf: Article;
  reason: "same-url" | "similar-title";
}

/**
 * 去重：先比 URL（精确），再比标题（模糊）。保留先出现的那条。
 * Dedupe: exact match on URL first, then fuzzy match on title. First seen wins.
 *
 * 返回被删掉的条目和原因，方便在日志里检查去重是否合理（可观测性）。
 * Also returns what was removed and why, so we can check the logic in logs (observability).
 */
export function dedupe(articles: Article[], titleThreshold = 0.6, minWords = 4) {
  const kept: Article[] = [];
  const removed: RemovedDuplicate[] = [];
  const seenUrls = new Map<string, Article>(); // 规范化 URL → 文章 / normalized URL → article
  const keptWords: Set<string>[] = []; // 与 kept 一一对应 / parallel to `kept`

  for (const article of articles) {
    const url = normalizeUrl(article.url);

    // 1) URL 完全相同 → 重复（例如 HN 链接到 TechCrunch 的同一篇文章）
    //    Same URL → duplicate (e.g. HN links to the same TechCrunch article)
    const sameUrl = seenUrls.get(url);
    if (sameUrl) {
      removed.push({ article, duplicateOf: sameUrl, reason: "same-url" });
      continue;
    }

    // 2) 标题高度相似 → 重复。O(n²)，但每天只有几百条，完全够用
    //    Very similar title → duplicate. O(n²) is fine for a few hundred items/day
    //    标题词太少时跳过模糊匹配：词少的话一两个词相同就会误判
    //    （如 "The 9 at 9: Tuesday" 只剩 {the, tuesday}，会和 "The 5 at 5: Tuesday" 撞车）
    //    Skip fuzzy matching for short titles: with few words, one or two shared words cause false matches
    const words = titleWords(article.title);
    const similarIndex =
      words.size < minWords ? -1 : keptWords.findIndex((w) => jaccard(w, words) >= titleThreshold);
    if (similarIndex !== -1) {
      removed.push({ article, duplicateOf: kept[similarIndex], reason: "similar-title" });
      continue;
    }

    kept.push(article);
    keptWords.push(words);
    seenUrls.set(url, article);
  }

  return { kept, removed };
}
