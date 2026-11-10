// 第 4 步（下）：中英双语总结（两段式的第二段）/ Step 4c: bilingual summaries (stage 2 of 2)
import { z } from "zod";
import Groq from "groq-sdk";
import type { LLMClient } from "./llm.js";
import type { EnrichedArticle } from "./enrich.js";

const SummarySchema = z.object({
  headline_zh: z.string(), // 中文标题 / Chinese headline
  summary_en: z.string(),
  summary_zh: z.string(),
});
export type Summary = z.infer<typeof SummarySchema>;

export interface SummarizedArticle extends EnrichedArticle {
  summary: Summary | null; // null = 总结失败，输出时只显示标题和链接 / failed: deliver shows title + link only
}

// 防编造是这一步最重要的规则 / Not making things up is the most important rule in this step
const SYSTEM_PROMPT = `You summarize news articles for a bilingual (English / Simplified Chinese) daily digest.

Rules:
- Use ONLY information stated in the provided text. Do not add background, context, predictions, or opinions that are not in the text.
- If the text is short, keep the summary short. One accurate sentence is better than three padded ones.
- summary_en: 2-3 sentences in English.
- summary_zh: the same content in natural Simplified Chinese (not word-for-word translation). Keep names of people, companies and products in their original form.
- headline_zh: the headline translated into natural Simplified Chinese.`;

function formatArticle(a: EnrichedArticle): string {
  const kind = a.textSource === "article" ? "Article text (may be truncated)" : "Feed summary only";
  return `Headline: ${a.title}\nSource: ${a.sourceName}\n${kind}:\n${a.text || "(none — use the headline only)"}`;
}

/**
 * 每篇文章单独调用：一篇失败不影响其他篇；而且 10 篇正文合在一起会超过免费版每分钟 8K token 的上限。
 * One call per article: a failure stays isolated, and all 10 texts in one request would exceed the free tier's 8K tokens/minute.
 */
export async function summarize(articles: EnrichedArticle[], llm: LLMClient) {
  const result: SummarizedArticle[] = [];
  let totalTokens = 0;

  for (const article of articles) {
    let summary: Summary | null = null;
    for (let attempt = 1; attempt <= 2 && !summary; attempt++) {
      try {
        const { data, tokens } = await llm.generateJson({
          system: SYSTEM_PROMPT,
          user: formatArticle(article),
          schema: SummarySchema,
          schemaName: "summary",
        });
        summary = data;
        totalTokens += tokens;
        console.log(`  ✓ ${article.title.slice(0, 60)} (${tokens} tokens)`);
      } catch (err) {
        if (err instanceof Groq.AuthenticationError) throw err; // fail fast
        console.log(`  ✗ attempt ${attempt}: ${article.title.slice(0, 40)} — ${(err as Error).message.slice(0, 120)}`);
      }
    }
    result.push({ ...article, summary });
  }
  return { articles: result, tokens: totalTokens };
}
