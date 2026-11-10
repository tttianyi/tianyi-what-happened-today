// 第 4 步（上）：判断/路由，把文章分到各板块并选出前 N 条
// Step 4a: Classify & Route — sort articles into sections and pick the top N of each
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import type { TriagedArticle } from "./triage.js";

// 这次直接用 zod 校验配置，不再手写 if 检查（对比 config.ts 的写法）
// This time the config is validated with zod instead of hand-written ifs (compare with config.ts)
const SectionSchema = z.object({
  id: z.string(),
  title_en: z.string(),
  title_zh: z.string(),
  categories: z.array(z.string()).min(1),
  count: z.int().min(1),
});
const DigestConfigSchema = z.object({ sections: z.array(SectionSchema).min(1) });
export type Section = z.infer<typeof SectionSchema>;

export async function loadSections(): Promise<Section[]> {
  const raw = await readFile(new URL("./digest.yaml", import.meta.url), "utf8");
  return DigestConfigSchema.parse(parse(raw)).sections;
}

export interface SelectedSection {
  section: Section;
  articles: TriagedArticle[];
}

/**
 * 每个板块：按源分类筛选 → 去掉未打分的 → 按分数排序 → 取前 N 条。
 * 分数相同时，较新的文章排在前面。
 * Per section: filter by source category → drop unscored → sort by importance → take top N.
 * Ties go to the more recent article.
 */
export function selectSections(articles: TriagedArticle[], sections: Section[]): SelectedSection[] {
  return sections.map((section) => {
    const candidates = articles
      .filter((a) => section.categories.includes(a.category) && a.importance !== null)
      .sort(
        (a, b) =>
          b.importance! - a.importance! || // 先比分数 / importance first
          b.publishedAt.localeCompare(a.publishedAt), // 再比时间（ISO 字符串可以直接比较）/ then recency (ISO strings sort correctly)
      );
    return { section, articles: candidates.slice(0, section.count) };
  });
}
