// 读取并校验 sources.yaml / Load and validate sources.yaml
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

// 一个新闻源的类型定义 / Shape of one news source
export interface Source {
  id: string;       // 唯一标识，用于去重和日志 / Unique key, used for dedupe & logs
  name: string;     // 显示名称 / Display name
  url: string;      // RSS 地址 / RSS feed URL
  category: string; // 分类：ireland | ireland-tech | tech
}

export async function loadSources(): Promise<Source[]> {
  // 相对于当前文件定位 yaml，不依赖从哪个目录运行
  // Resolve relative to this file, so it works from any working directory
  const path = new URL("./sources.yaml", import.meta.url);
  const raw = await readFile(path, "utf8");
  const data = parse(raw) as { sources: Source[] };

  // 简单校验：配置写错时尽早报错，而不是跑到一半才崩
  // Fail fast on a bad config instead of crashing halfway through the run
  for (const s of data.sources) {
    if (!s.id || !s.url || !s.category) {
      throw new Error(`Invalid source in sources.yaml: ${JSON.stringify(s)}`);
    }
  }
  return data.sources;
}

// 直接运行此文件时打印源列表 / Print the list when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const sources = await loadSources();
  console.table(sources.map(({ id, category }) => ({ id, category })));
}
