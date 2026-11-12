// 第 4 步（上）：判断/路由，把文章分到各板块并选出前 N 条
// Step 4a: Classify & Route — sort articles into sections and pick the top N of each
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import type { TriagedArticle } from "./triage.js";
import type { LLMClient } from "./llm.js";
import { groupStories } from "./stories.js";

// 每个板块拿多少候选去做同一事件分组（板块篇数的倍数）/ how many candidates per section go to story grouping (× section count)
const STORY_POOL_FACTOR = 3;

// 这次直接用 zod 校验配置，不再手写 if 检查（对比 config.ts 的写法）
// This time the config is validated with zod instead of hand-written ifs (compare with config.ts)
const SectionSchema = z.object({
  id: z.string(),
  title_en: z.string(),
  title_zh: z.string(),
  categories: z.array(z.string()).min(1),
  count: z.int().min(1),
  rubric: z.string().min(1), // 本板块的评分标准，triage 会用到 / this section's scoring rubric, used by triage
});
const DigestConfigSchema = z.object({ sections: z.array(SectionSchema).min(1) }).refine(
  // 一个分类只能属于一个板块，否则同一篇文章会被打两次分、可能出现两次
  // A category may belong to only one section; otherwise an article is scored twice and may appear twice
  ({ sections }) => {
    const all = sections.flatMap((s) => s.categories);
    return new Set(all).size === all.length;
  },
  { message: "A category is listed in more than one section / 有分类被多个板块重复使用" },
);
export type Section = z.infer<typeof SectionSchema>;

export async function loadSections(): Promise<Section[]> {
  const raw = await readFile(new URL("./digest.yaml", import.meta.url), "utf8");
  return DigestConfigSchema.parse(parse(raw)).sections;
}

export interface SkippedArticle {
  article: TriagedArticle;
  reason: "same-story" | "same-subject"; // 同一事件 / 同一主体
}

export interface SelectedSection {
  section: Section;
  articles: TriagedArticle[];
  skipped: SkippedArticle[]; // 被规则跳过的文章，方便检查规则效果 / skipped by the rules, for checking they work
}

/**
 * 统一主体名的写法再比较："Anthropic " 和 "anthropic" 算同一个；"none" 表示没有单一主体，不参与限制。
 * Normalize subjects before comparing: "Anthropic " and "anthropic" match; "none" means no single subject and is never limited.
 */
function subjectKey(subject: string | null): string | null {
  const key = subject?.trim().toLowerCase() ?? "";
  return key === "" || key === "none" ? null : key;
}

/**
 * 板块候选：按源分类筛选 → 去掉未打分的 → 按分数排序；分数相同时，较新的文章排在前面。
 * Section candidates: filter by source category → drop unscored → sort by importance; ties go to the more recent article.
 */
function rankSection(articles: TriagedArticle[], section: Section): TriagedArticle[] {
  return articles
    .filter((a) => section.categories.includes(a.category) && a.importance !== null)
    .sort(
      (a, b) =>
        b.importance! - a.importance! || // 先比分数 / importance first
        b.publishedAt.localeCompare(a.publishedAt), // 再比时间（ISO 字符串可以直接比较）/ then recency (ISO strings sort correctly)
    );
}

/**
 * 按排名依次选取，同一事件、同一主体各最多 1 条，直到选够 N 条。
 * Pick in rank order, at most one article per story and per subject, until N are chosen.
 */
function pick(ranked: TriagedArticle[], count: number, storyOf: Map<string, number>) {
  const articles: TriagedArticle[] = [];
  const skipped: SkippedArticle[] = [];
  const usedStories = new Set<number>();
  const usedSubjects = new Set<string>();

  for (const a of ranked) {
    if (articles.length >= count) break;
    const story = storyOf.get(a.id);
    const subject = subjectKey(a.subject);
    if (story !== undefined && usedStories.has(story)) {
      skipped.push({ article: a, reason: "same-story" }); // 这件事已经有一篇了 / this story already has a slot
      continue;
    }
    if (subject && usedSubjects.has(subject)) {
      skipped.push({ article: a, reason: "same-subject" }); // 这家公司已经有一篇了 / this subject already has a slot
      continue;
    }
    if (story !== undefined) usedStories.add(story);
    if (subject) usedSubjects.add(subject);
    articles.push(a);
  }
  return { articles, skipped };
}

/**
 * 每个板块：排序 → （选多于 1 篇的板块）把前 N×3 篇候选交给 LLM 找同一事件 → 按规则选出 N 篇。
 * 只选 1 篇的板块不会有重复，所以不调用 LLM。
 * Per section: rank → (sections picking more than one) send the top N×3 candidates to the LLM to find shared stories → pick N.
 * Sections that pick only one can't have duplicates, so they skip the LLM call.
 */
export async function selectSections(articles: TriagedArticle[], sections: Section[], llm: LLMClient) {
  const selected: SelectedSection[] = [];
  let tokens = 0;

  for (const section of sections) {
    const ranked = rankSection(articles, section);
    let storyOf = new Map<string, number>();
    if (section.count > 1) {
      const pool = ranked.slice(0, section.count * STORY_POOL_FACTOR);
      const grouped = await groupStories(pool, llm, section.id);
      storyOf = grouped.storyOf;
      tokens += grouped.tokens;
    }
    selected.push({ section, ...pick(ranked, section.count, storyOf) });
  }
  return { selected, tokens };
}
