// 流水线入口：按顺序调用每一步 / Pipeline entry point: runs each step in order
// 每做完一步就在这里加一段 / Each new step adds a block here
import { loadSources } from "./config.js";
import { ingestAll } from "./ingest.js";
import { dedupe } from "./dedupe.js";
import { GroqClient } from "./llm.js";
import { triage } from "./triage.js";
import { loadSections, selectSections } from "./select.js";
import { enrich } from "./enrich.js";
import { summarize } from "./summarize.js";

// 本地开发从 .env 读取 key；GitHub Actions 里没有 .env，key 来自 Secrets
// Locally, keys come from .env; in GitHub Actions there's no .env and keys come from Secrets
try {
  process.loadEnvFile(".env");
} catch {
  /* 没有 .env 文件也没关系 / no .env file is fine */
}

const TRIAGE_MODEL = "openai/gpt-oss-120b"; // 打分：英文判断 / triage: English judgement
// 总结：原计划用 Qwen（中文强），但它在 Groq 的 strict JSON 模式下经常生成无效 JSON（实测 10 篇失败 5 篇），
// gpt-oss-120b 3/3 成功且中文自然，所以改用它。
// Summaries: Qwen was the plan (strong Chinese), but under Groq's strict JSON mode it often produced
// invalid JSON (5 of 10 failed in testing). gpt-oss-120b went 3/3 with natural Chinese, so we use it.
const SUMMARY_MODEL = "openai/gpt-oss-120b";

console.log("① Load sources / 读取配置");
const sources = await loadSources();

console.log(`\n② Ingest last 24h / 抓取过去 24 小时 (${sources.length} sources)`);
const { articles, failures } = await ingestAll(sources);

console.log("\n③ Dedupe / 去重");
const { kept, removed } = dedupe(articles);
for (const r of removed) {
  console.log(`  − [${r.reason}] "${r.article.title}" (${r.article.sourceId})`);
  console.log(`      ≈ "${r.duplicateOf.title}" (${r.duplicateOf.sourceId})`);
}
console.log(`  ${articles.length} fetched → ${removed.length} duplicates → ${kept.length} kept, ${failures.length} sources failed`);

const llm = new GroqClient(TRIAGE_MODEL);
console.log(`\n④ Triage / 打分分类 (${llm.name})`);
const { articles: triaged, tokens: triageTokens } = await triage(kept, llm);
const unscored = triaged.filter((a) => a.importance === null).length;
console.log(`  Unscored / 未打分: ${unscored}, tokens used / 用量: ${triageTokens}`);

console.log("\n⑤ Select by section / 按板块选文章");
const selected = selectSections(triaged, await loadSections());
for (const { section, articles: picked } of selected) {
  console.log(`\n  ${section.title_en} / ${section.title_zh} (${picked.length}/${section.count})`);
  for (const a of picked) console.log(`    ${a.importance} [${a.topic}] ${a.title} (${a.sourceId})`);
}

console.log("\n⑥ Fetch article text / 抓取入选文章正文");
const enriched = await enrich(selected.flatMap((s) => s.articles));

const summaryLlm = new GroqClient(SUMMARY_MODEL, "medium"); // 写作比打分难，多想一点 / writing is harder than scoring
console.log(`\n⑦ Bilingual summaries / 双语总结 (${summaryLlm.name})`);
const { articles: summarized, tokens: summaryTokens } = await summarize(enriched, summaryLlm);

console.log(`\nTokens / 本次用量: triage ${triageTokens} + summary ${summaryTokens} = ${triageTokens + summaryTokens}`);
console.log("\nPreview / 预览:");
for (const a of summarized) {
  const tag = a.textSource === "snippet" ? " [仅基于摘要 / snippet only]" : "";
  console.log(`\n■ ${a.title}${tag}\n  ${a.summary?.headline_zh ?? "(summary failed)"}`);
  if (a.summary) console.log(`  EN: ${a.summary.summary_en}\n  中: ${a.summary.summary_zh}`);
}
