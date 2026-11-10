// 流水线入口：按顺序调用每一步 / Pipeline entry point: runs each step in order
// 每做完一步就在这里加一段 / Each new step adds a block here
import { loadSources } from "./config.js";
import { ingestAll } from "./ingest.js";
import { dedupe } from "./dedupe.js";
import { GroqClient } from "./llm.js";
import { triage } from "./triage.js";

// 本地开发从 .env 读取 key；GitHub Actions 里没有 .env，key 来自 Secrets
// Locally, keys come from .env; in GitHub Actions there's no .env and keys come from Secrets
try {
  process.loadEnvFile(".env");
} catch {
  /* 没有 .env 文件也没关系 / no .env file is fine */
}

const TRIAGE_MODEL = "openai/gpt-oss-120b";

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
const triaged = await triage(kept, llm);

// 汇总：话题分布、未打分数量、Top 10 / Summary: topic counts, unscored count, top 10
const unscored = triaged.filter((a) => a.importance === null).length;
const topicCounts: Record<string, number> = {};
for (const a of triaged) if (a.topic) topicCounts[a.topic] = (topicCounts[a.topic] ?? 0) + 1;

console.log(`\n  Unscored / 未打分: ${unscored}`);
console.log("  Topics / 话题分布:", topicCounts);
console.log("\n  Top 10:");
[...triaged]
  .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
  .slice(0, 10)
  .forEach((a) => console.log(`  ${a.importance} [${a.topic}] ${a.title} (${a.sourceId})`));
