// 第 4 步（中）：只给入选文章抓取正文 / Step 4b: fetch full text for the selected articles only
// 规则 / Rules:
//  - 每天只访问入选的约 10 个网页 / Only ~10 pages a day, the ones that made the digest
//  - 正文只交给 LLM 做总结，不保存、不发布 / Text goes to the LLM only; never stored or published
//  - 付费墙或抓取失败 → 退回 RSS 摘要，并标注来源 / Paywall or failure → fall back to the RSS snippet, and say so
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { TriagedArticle } from "./triage.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_TEXT_CHARS = 3000;  // 新闻的关键信息通常在开头；也控制 token / news leads carry the key facts; also caps tokens
const MIN_TEXT_CHARS = 400;   // 太短说明多半是付费墙或提取失败 / shorter usually means a paywall or failed extraction

export interface EnrichedArticle extends TriagedArticle {
  text: string;                       // 交给 LLM 的文本 / text handed to the LLM
  textSource: "article" | "snippet";  // 正文还是 RSS 摘要 / full article or RSS snippet
}

/** 下载网页并用 Readability 提取正文（和 Firefox 阅读模式同一个库）/ Download a page and extract the main text with Readability (same library as Firefox Reader View) */
async function extractText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "irish-news-digest/0.1 (personal RSS reader)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.headers.get("content-type")?.includes("text/html")) throw new Error("not an HTML page");

  // 静音 jsdom：网页里的 CSS/脚本解析警告与我们无关
  // Silence jsdom: CSS/script parse warnings from the page aren't our concern
  const dom = new JSDOM(await res.text(), { url, virtualConsole: new VirtualConsole() });
  const article = new Readability(dom.window.document).parse();
  const text = (article?.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text.length < MIN_TEXT_CHARS) throw new Error(`only ${text.length} chars (paywall?)`);
  return text.slice(0, MAX_TEXT_CHARS);
}

/** 并行抓取（10 个不同网站，不会给同一个网站造成压力）/ Fetch in parallel (10 different sites, so no single site gets hammered) */
export async function enrich(articles: TriagedArticle[]): Promise<EnrichedArticle[]> {
  const results = await Promise.allSettled(articles.map((a) => extractText(a.url)));

  return articles.map((article, i) => {
    const r = results[i];
    if (r.status === "fulfilled") {
      console.log(`  ✓ ${article.sourceId.padEnd(16)} ${r.value.length} chars  ${article.title.slice(0, 50)}`);
      return { ...article, text: r.value, textSource: "article" };
    }
    const reason = String(r.reason?.message ?? r.reason);
    console.log(`  ↩ ${article.sourceId.padEnd(16)} snippet only (${reason})  ${article.title.slice(0, 50)}`);
    return { ...article, text: article.snippet, textSource: "snippet" };
  });
}
