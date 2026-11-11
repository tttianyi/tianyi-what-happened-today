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

export interface SelectedSection {
  section: Section;
  articles: TriagedArticle[];
  sameSubjectSkipped: TriagedArticle[]; // 因同一主体被跳过的文章，方便检查规则效果 / skipped for repeating a subject, for checking the rule
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
 * 每个板块：按源分类筛选 → 去掉未打分的 → 按分数排序 → 依次选取，同一主体最多 1 条，直到选够 N 条。
 * 分数相同时，较新的文章排在前面。
 * Per section: filter by source category → drop unscored → sort by importance → pick in order,
 * at most one article per subject, until N are chosen. Ties go to the more recent article.
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

    const picked: TriagedArticle[] = [];
    const sameSubjectSkipped: TriagedArticle[] = [];
    const usedSubjects = new Set<string>();
    for (const a of candidates) {
      if (picked.length >= section.count) break;
      const key = subjectKey(a.subject);
      if (key && usedSubjects.has(key)) {
        sameSubjectSkipped.push(a); // 这家公司已经有一条了 / this subject already has a slot
        continue;
      }
      if (key) usedSubjects.add(key);
      picked.push(a);
    }
    return { section, articles: picked, sameSubjectSkipped };
  });
}
