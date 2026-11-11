// 第 3 步：LLM 打分和分类（两段式的第一段） / Step 3: LLM triage (stage 1 of 2)
// 给每篇文章打重要度和话题，下一步只给高分文章写总结。
// Score importance and tag a topic for every article; the next step summarizes only the top ones.
import Groq from "groq-sdk";
import { z } from "zod";
import type { Article } from "./ingest.js";
import type { LLMClient } from "./llm.js";
import type { Section } from "./select.js";

export const TOPICS = [
  "politics", "economy", "housing", "health", "crime", "immigration", "education",
  "environment", "transport", "sport", "culture", "world", "tech", "ai", "business", "science",
  "film", "art", "design", "architecture", "other",
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
      // 用 string 而不是 enum：模型偶尔会写一个列表外的话题（如 "labour"），
      // enum 会让 Groq 拒绝整批 30 篇；改成在代码里把列表外的值归为 "other"。
      // string, not enum: the model occasionally writes an off-list topic (e.g. "labour"),
      // and an enum makes Groq reject the whole batch of 30; off-list values become "other" in code instead.
      topic: z.string(),
      // 文章的主要对象（公司/机构/人），用来避免同一板块被同一家公司占满
      // Main subject (company / organisation / person), used to stop one company filling a section
      subject: z.string(),
    }),
  ),
});
type TriageResult = z.infer<typeof TriageSchema>["results"][number];

export interface TriagedArticle extends Article {
  importance: number | null; // null = 打分失败 / scoring failed
  topic: Topic | null;
  subject: string | null;
}

/**
 * 通用规则 + 板块自己的评分标准（写在 digest.yaml 里）。
 * 关键是"只在本领域内比较"：电影新闻和电影新闻比，不和爱尔兰政治比。
 * Shared instructions + the section's own rubric (from digest.yaml).
 * The key is "compare within the field": film stories are ranked against film stories, not Irish politics.
 */
function buildSystemPrompt(section: Section): string {
  return `You are a news editor choosing stories for the "${section.title_en}" section of a daily digest. The reader lives in Ireland.

For each numbered article, assign:
- importance (1-5): how important the article is within this section's field. Compare it with other ${section.title_en} news, not with news in general.
${section.rubric.trim()}
  Be strict: most articles are 2 or 3. Give 5 to at most one or two articles per batch, and 4 only to clearly significant ones. If unsure between two scores, choose the lower one.
- topic: the single best-fitting topic, exactly one of: ${TOPICS.join(", ")}.
- subject: the main company, organisation or person the story is about, as a short common name (e.g. "Anthropic", "Nvidia", "HSE"). Use the parent company for products (Claude → "Anthropic", ChatGPT → "OpenAI", iPhone → "Apple"). Use "none" if there is no single main subject.

Return exactly one result for every article, using its number as n. Judge only from the title and snippet.`;
}

/** 列表外的话题归为 "other"：一个小错不应该让一整批文章没有分数 / Off-list topics become "other": one small slip shouldn't leave a whole batch unscored */
function toTopic(value: string): Topic {
  const t = value.trim().toLowerCase();
  return (TOPICS as readonly string[]).includes(t) ? (t as Topic) : "other";
}

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
async function scoreBatch(batch: Article[], system: string, llm: LLMClient, label: string) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try {
      const { data, tokens } = await llm.generateJson({
        system,
        user: formatBatch(batch),
        schema: TriageSchema,
        schemaName: "triage",
      });

      // 只接受本批范围内的编号 / Accept only numbers that exist in this batch
      const byNumber = new Map<number, TriageResult>();
      for (const r of data.results) if (r.n <= batch.length) byNumber.set(r.n, r);

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`  ✓ ${label}: ${byNumber.size}/${batch.length} scored, ${tokens} tokens, ${secs}s`);
      return { byNumber, tokens };
    } catch (err) {
      // key 错误重试也没用，直接停止（fail fast）/ A bad API key won't fix itself — stop now (fail fast)
      if (err instanceof Groq.AuthenticationError) throw err;
      // 其他错误：SDK 已经重试过 429/5xx，这里多数是 JSON 或 schema 校验失败
      // Other errors: the SDK already retried 429/5xx, so this is mostly bad JSON / schema mismatch
      console.log(`  ✗ ${label} attempt ${attempt}: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  // 降级：这批文章没有分数 / degrade: this batch stays unscored
  return { byNumber: new Map<number, TriageResult>(), tokens: 0 };
}

/**
 * 按板块打分：每个板块用自己的评分标准，各自分批。
 * 批次依次执行（不并行）：免费版每分钟 token 有上限，并行只会更快撞上限。
 * Score section by section, each with its own rubric and its own batches.
 * Batches run sequentially — the free tier caps tokens per minute, so parallel calls just hit it sooner.
 */
export async function triage(articles: Article[], sections: Section[], llm: LLMClient) {
  const result: TriagedArticle[] = [];
  let totalTokens = 0; // 记录用量，用来对照免费额度 / track usage against the free-tier quota

  for (const section of sections) {
    const inSection = articles.filter((a) => section.categories.includes(a.category));
    const system = buildSystemPrompt(section);
    const totalBatches = Math.ceil(inSection.length / BATCH_SIZE);

    for (let start = 0; start < inSection.length; start += BATCH_SIZE) {
      const batch = inSection.slice(start, start + BATCH_SIZE);
      const label = `${section.id} ${start / BATCH_SIZE + 1}/${totalBatches}`;
      const { byNumber, tokens } = await scoreBatch(batch, system, llm, label);
      totalTokens += tokens;

      batch.forEach((article, i) => {
        const s = byNumber.get(i + 1);
        result.push({ ...article, importance: s?.importance ?? null, topic: s ? toTopic(s.topic) : null, subject: s?.subject ?? null });
      });
    }
  }

  // 不属于任何板块的文章不打分，省 token / Articles in no section are never scored, saving tokens
  const skipped = articles.length - result.length;
  if (skipped > 0) console.log(`  Skipped / 跳过 ${skipped} articles not in any section / 不属于任何板块`);
  return { articles: result, tokens: totalTokens };
}
