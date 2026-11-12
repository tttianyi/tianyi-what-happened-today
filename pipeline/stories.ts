// 同一事件分组：找出"用不同标题报道同一件事"的文章
// Story grouping: find articles that report the same event under different headlines
//
// 为什么需要：标题去重只认得用词相近的标题；subject 规则只认得同一家公司。
// "公共部门加薪协议"和"罢工因协议暂停"是同一件事，但用词不同、subject 也被标成了工会/政府/部长。
// Why: title dedupe only catches similar wording, and the subject rule only catches the same company.
// "Public pay deal agreed" and "Strike suspended after deal" are one story, with different words and subjects.
//
// 做法：每个板块只看排名靠前的少量候选，一次性交给 LLM 分组。所有候选一起看，不会因为分在不同批次而漏掉。
// How: per section, send only the top few candidates to the LLM in one call. Seeing them all together
// means nothing is missed because two articles landed in different triage batches.
import Groq from "groq-sdk";
import { z } from "zod";
import type { LLMClient } from "./llm.js";
import type { TriagedArticle } from "./triage.js";

const SNIPPET_CHARS = 150; // 标题 + 一点摘要就够判断 / headline + a little snippet is enough

const StorySchema = z.object({
  // 每组是一串编号，表示这些文章报道同一件事 / each group is a list of numbers reporting the same story
  groups: z.array(z.array(z.int().min(1))),
});

const SYSTEM_PROMPT = `You find news articles that report the same story.

Two articles are the same story if they cover the same event or development, even with different headlines, angles or follow-ups (e.g. "Pay deal agreed" and "Strike called off after pay deal").
Articles that are merely on a similar topic are NOT the same story.

Return groups of article numbers that share a story. Only include groups with two or more articles; leave out articles that are unique.`;

/**
 * 返回 文章 id → 组号。不在任何组里的文章不出现在结果里（视为独立新闻）。
 * 失败时返回空结果：不分组只是可能有重复，不应该让整个流程失败。
 * Returns article id → group number. Articles in no group are absent (treated as unique).
 * On failure, returns nothing: no grouping just risks a duplicate, which shouldn't fail the run.
 */
export async function groupStories(candidates: TriagedArticle[], llm: LLMClient, label: string) {
  const storyOf = new Map<string, number>();
  if (candidates.length < 2) return { storyOf, tokens: 0 };

  const user = candidates
    .map((a, i) => `[${i + 1}] (${a.sourceName}) ${a.title}\n${a.snippet.slice(0, SNIPPET_CHARS)}`)
    .join("\n\n");

  try {
    const { data, tokens } = await llm.generateJson({
      system: SYSTEM_PROMPT,
      user,
      schema: StorySchema,
      schemaName: "stories",
    });
    data.groups.forEach((group, g) => {
      for (const n of group) {
        const article = candidates[n - 1]; // 超出范围的编号直接忽略 / out-of-range numbers are ignored
        if (article && !storyOf.has(article.id)) storyOf.set(article.id, g);
      }
    });
    const grouped = data.groups.filter((g) => g.length > 1).length;
    console.log(`  ✓ ${label}: ${candidates.length} candidates, ${grouped} shared stories, ${tokens} tokens`);
    return { storyOf, tokens };
  } catch (err) {
    if (err instanceof Groq.AuthenticationError) throw err; // fail fast
    console.log(`  ✗ ${label}: grouping failed, continuing without it / 分组失败，跳过 — ${(err as Error).message.slice(0, 120)}`);
    return { storyOf, tokens: 0 };
  }
}
