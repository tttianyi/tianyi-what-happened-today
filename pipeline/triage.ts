// 第 3 步：LLM 打分和分类（两段式的第一段） / Step 3: LLM triage (stage 1 of 2)
// 给每篇文章打重要度和话题，下一步只给高分文章写总结。
// Score importance and tag a topic for every article; the next step summarizes only the top ones.
import Groq from "groq-sdk";
import { z } from "zod";
import type { Article } from "./ingest.js";
import type { LLMClient } from "./llm.js";

export const TOPICS = [
  "politics", "economy", "housing", "health", "crime", "immigration", "education",
  "environment", "transport", "sport", "culture", "world", "tech", "ai", "business", "science", "other",
] as const;
export type Topic = (typeof TOPICS)[number];

const BATCH_SIZE = 30;           // 每次调用打包的文章数 / articles per LLM call
const TRIAGE_SNIPPET_CHARS = 200; // 打分只需要摘要开头，省 token / scoring needs only the start of the snippet

// zod schema：既是 TypeScript 类型，也是运行时校验，还会转换成 JSON Schema 发给 Groq
// One zod schema = TS type + runtime validation + the JSON Schema we send to Groq
const TriageSchema = z.object({
  results: z.array(
    z.object({
      n: z.int().min(1),                     // 文章在本批中的编号 / article number within the batch
      importance: z.int().min(1).max(5),     // 1~5 分 / score 1..5
      topic: z.enum(TOPICS),
    }),
  ),
});
type TriageResult = z.infer<typeof TriageSchema>["results"][number];

export interface TriagedArticle extends Article {
  importance: number | null; // null = 打分失败 / scoring failed
  topic: Topic | null;
}

// 评分标准写在 prompt 里，想调整排序就改这里 / The scoring rubric lives here — edit it to tune the ranking
const SYSTEM_PROMPT = `You are a news editor preparing a daily digest for a reader who lives in Ireland and follows both Irish news and technology news.

For each numbered article, assign:
- importance (1-5): how much this matters to that reader.
  5 = major national news in Ireland, or a major global tech/AI development
  4 = significant, worth reading today
  3 = moderately interesting
  2 = minor or niche
  1 = trivial, routine, or promotional
- topic: the single best-fitting topic from the allowed list.

Return exactly one result for every article, using its number as n. Judge only from the title and snippet.`;

/**
 * 用编号 [1] [2] 代替 12 位文章 id：更省 token，也更容易校验 LLM 有没有乱编。
 * Number articles [1], [2]… instead of sending 12-char ids: fewer tokens, and easy to check for made-up numbers.
 */
function formatBatch(batch: Article[]): string {
  return batch
    .map((a, i) => `[${i + 1}] (${a.sourceName}) ${a.title}\n${a.snippet.slice(0, TRIAGE_SNIPPET_CHARS)}`)
    .join("\n\n");
}

/**
 * 给一批文章打分。失败重试一次；还失败就返回空结果，不让整个 pipeline 崩溃。
 * Score one batch. Retry once on failure; if it still fails, return nothing rather than crash the pipeline.
 */
async function scoreBatch(batch: Article[], llm: LLMClient, label: string) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try {
      const { data, tokens } = await llm.generateJson({
        system: SYSTEM_PROMPT,
        user: formatBatch(batch),
        schema: TriageSchema,
        schemaName: "triage",
      });

      // 只接受本批范围内的编号 / Accept only numbers that exist in this batch
      const byNumber = new Map<number, TriageResult>();
      for (const r of data.results) if (r.n <= batch.length) byNumber.set(r.n, r);

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`  ✓ ${label}: ${byNumber.size}/${batch.length} scored, ${tokens} tokens, ${secs}s`);
      return byNumber;
    } catch (err) {
      // key 错误重试也没用，直接停止（fail fast）/ A bad API key won't fix itself — stop now (fail fast)
      if (err instanceof Groq.AuthenticationError) throw err;
      // 其他错误：SDK 已经重试过 429/5xx，这里多数是 JSON 或 schema 校验失败
      // Other errors: the SDK already retried 429/5xx, so this is mostly bad JSON / schema mismatch
      console.log(`  ✗ ${label} attempt ${attempt}: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  return new Map<number, TriageResult>(); // 降级：这批文章没有分数 / degrade: this batch stays unscored
}

/**
 * 按批次依次打分（串行而不是并行：免费版每分钟 token 有上限，并行只会更快撞上限）。
 * Score batch by batch, sequentially — the free tier caps tokens per minute, so parallel calls just hit it sooner.
 */
export async function triage(articles: Article[], llm: LLMClient): Promise<TriagedArticle[]> {
  const result: TriagedArticle[] = [];
  const totalBatches = Math.ceil(articles.length / BATCH_SIZE);

  for (let start = 0; start < articles.length; start += BATCH_SIZE) {
    const batch = articles.slice(start, start + BATCH_SIZE);
    const label = `batch ${start / BATCH_SIZE + 1}/${totalBatches}`;
    const scores = await scoreBatch(batch, llm, label);

    batch.forEach((article, i) => {
      const s = scores.get(i + 1);
      result.push({ ...article, importance: s?.importance ?? null, topic: s?.topic ?? null });
    });
  }
  return result;
}
