// 第 5 步：输出 —— 排版并推送到 Telegram / Step 5: Deliver — format the digest and send it to Telegram
import type { Section } from "./select.js";
import type { SummarizedArticle } from "./summarize.js";

const TELEGRAM_MAX_CHARS = 4096; // Telegram 单条消息上限 / Telegram's per-message limit
const SAFE_MAX_CHARS = 3900; // 留一点余量 / leave some headroom
// 重试前的等待秒数（逐渐加长）：一共尝试 4 次，大约能撑过 50 秒的网络中断
// Seconds to wait before each retry (growing): 4 attempts in total, riding out ~50s of network trouble
const RETRY_DELAYS_S = [5, 15, 30];

export interface TelegramConfig {
  token: string;
  chatId: string;
}

export interface DigestSection {
  section: Section;
  articles: SummarizedArticle[];
}

/**
 * 在流水线一开始就检查配置（fail fast）：
 * 不要等花掉 3.5 万 token 之后，才发现 Telegram 配置没填。
 * Check config at the very start (fail fast): don't spend 35K tokens and only then find Telegram isn't set up.
 */
export function loadTelegramConfig(): TelegramConfig {
  const token = process.env.TELEGRAM_NEWS_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_NEWS_CHAT_ID;
  const missing = [!token && "TELEGRAM_NEWS_BOT_TOKEN", !chatId && "TELEGRAM_NEWS_CHAT_ID"].filter(Boolean);
  if (missing.length) throw new Error(`Missing env / 缺少环境变量: ${missing.join(", ")}`);
  return { token: token!, chatId: chatId! };
}

// ── 排版 / Formatting ──────────────────────────────────────────────

/**
 * 用 HTML 模式而不是 MarkdownV2：HTML 只需转义 & < > 三个字符，
 * MarkdownV2 要转义 18 个（包括新闻里常见的 . - ( ) !），很容易出错。
 * HTML mode instead of MarkdownV2: HTML needs only & < > escaped;
 * MarkdownV2 needs 18 characters escaped (including . - ( ) ! common in news), which breaks easily.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 链接里的 " 也要转义，否则会提前结束 href / Quotes in URLs too, or they end the href early */
function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function formatArticle(a: SummarizedArticle, n: number): string {
  const link = `<a href="${escapeAttr(a.url)}">${escapeHtml(a.sourceName)}</a>`;
  const tag = a.textSource === "snippet" ? " · <i>仅基于摘要 / snippet only</i>" : "";

  // 总结失败：仍然给出标题和链接，读者不会漏掉这条新闻
  // Summary failed: still show title + link, so the story isn't lost
  if (!a.summary) return `<b>${n}. ${escapeHtml(a.title)}</b>\n${link}`;

  const s = a.summary;
  return [
    `<b>${n}. ${escapeHtml(s.headline_zh)}</b>`,
    `<i>${escapeHtml(a.title)}</i>`,
    escapeHtml(s.summary_zh),
    escapeHtml(s.summary_en),
    `${link}${tag}`,
  ].join("\n");
}

/**
 * 把若干"块"装进不超过上限的消息里，只在块之间拆分。
 * 现在每个板块一条消息，正常情况下一个板块远小于 4096 字，这里只是兜底。
 * Pack blocks into messages under the limit, splitting only between blocks.
 * Each section is one message now and is normally far below 4,096 chars; this is just a safety net.
 */
function pack(blocks: string[]): string[] {
  const messages: string[] = [];
  let current = "";
  for (const block of blocks) {
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length > SAFE_MAX_CHARS && current) {
      messages.push(current);
      current = block;
    } else {
      current = next;
    }
  }
  if (current) messages.push(current);

  // 单个块本身超长（理论上不会发生）→ 硬截断，保证 API 不报错
  // A single block over the limit (shouldn't happen) → hard cut so the API call never fails
  return messages.map((m) => (m.length > TELEGRAM_MAX_CHARS ? m.slice(0, TELEGRAM_MAX_CHARS - 1) + "…" : m));
}

/**
 * 每个板块一条消息：板块不会被切到两条消息里；日报标题放在第一条的开头。
 * One message per section, so a section is never split across messages; the digest header opens the first one.
 */
export function formatDigest(sections: DigestSection[], date = new Date()): string[] {
  const day = date.toLocaleDateString("en-IE", { timeZone: "Europe/Dublin", weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const header = `📰 <b>每日新闻 / Daily Digest</b>\n${day}`;

  const messages: string[] = [];
  for (const { section, articles } of sections) {
    if (articles.length === 0) continue; // 空板块不发 / skip empty sections
    const blocks = [
      `<b>▍${escapeHtml(section.title_zh)} / ${escapeHtml(section.title_en)}</b>`,
      ...articles.map((a, i) => formatArticle(a, i + 1)),
    ];
    if (messages.length === 0) blocks.unshift(header);
    messages.push(...pack(blocks));
  }
  return messages;
}

// ── 发送 / Sending ────────────────────────────────────────────────

interface TelegramResponse {
  ok: boolean;
  description?: string;
  parameters?: { retry_after?: number };
}

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));

/**
 * 发送一条消息。三类错误分开处理：
 *  - 网络错误 / 超时 / Telegram 5xx：临时问题，等一会儿重试（GitHub 服务器偶尔连不上 Telegram，实际遇到过）
 *  - 429 限流：按 Telegram 给的 retry_after 等待后重试
 *  - 其他 4xx（格式错误、token 错误、bot 被屏蔽）：重试也没用，直接报错
 * Send one message. Three kinds of error, handled differently:
 *  - network error / timeout / Telegram 5xx: temporary, wait and retry (GitHub's runner really did fail to reach Telegram once)
 *  - 429 rate limit: wait for Telegram's retry_after, then retry
 *  - other 4xx (bad format, bad token, bot blocked): retrying won't help, fail now
 */
async function sendMessage(cfg: TelegramConfig, text: string, silent: boolean): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const delay = RETRY_DELAYS_S[attempt - 1]; // undefined = 没有重试机会了 / no retries left
    let res: Response;
    let body: TelegramResponse;
    try {
      // 注意：token 在 URL 里，所以错误信息里绝不包含 URL
      // Note: the token is in the URL, so error messages never include it
      res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          chat_id: cfg.chatId,
          text,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true }, // 10 个链接预览会把消息撑得很长 / 10 previews would flood the chat
          disable_notification: silent, // 只有第一条响铃，其余静默 / only the first message rings; the rest are silent
        }),
      });
      body = (await res.json()) as TelegramResponse;
    } catch (err) {
      // 网络层失败（连不上、超时、返回的不是 JSON）/ network-level failure (can't connect, timeout, non-JSON reply)
      const e = err as Error & { cause?: { code?: string } };
      const reason = e.cause?.code ?? e.name; // 如 ETIMEDOUT / TimeoutError，不含 URL / e.g. ETIMEDOUT, never the URL
      if (delay === undefined) throw new Error(`network error after ${attempt} attempts / 网络错误: ${reason}`);
      console.log(`  … network error (${reason}), retrying in ${delay}s / 网络错误，${delay} 秒后重试`);
      await sleep(delay);
      continue;
    }

    if (body.ok) return;

    // 429 限流：Telegram 会告诉我们等几秒 / 429 rate limit: Telegram tells us how long to wait
    const retryAfter = body.parameters?.retry_after;
    if (res.status === 429 && retryAfter && delay !== undefined) {
      console.log(`  … rate limited, waiting ${retryAfter}s / 被限流，等待 ${retryAfter} 秒`);
      await sleep(retryAfter);
      continue;
    }
    // 5xx：Telegram 服务器临时出错 / 5xx: temporary error on Telegram's side
    if (res.status >= 500 && delay !== undefined) {
      console.log(`  … Telegram ${res.status}, retrying in ${delay}s / ${delay} 秒后重试`);
      await sleep(delay);
      continue;
    }
    // 其他错误（400 格式错误、401 token 错误、403 用户屏蔽了 bot）重试也没用，直接报错
    // Other errors (400 bad format, 401 bad token, 403 bot blocked) won't fix themselves: fail
    throw new Error(`Telegram ${res.status}: ${body.description}`);
  }
}

/**
 * 按顺序发送（不并行），保证消息在聊天里的顺序正确。只有第一条会发出提醒。
 * 一条失败不影响其他板块：全部尝试完后，如果有失败再抛错，让这次运行标红、GitHub 发邮件通知。
 * Sent in order (not in parallel) so the chat shows them in sequence. Only the first one notifies.
 * One failure doesn't block the other sections: after trying them all, any failure throws,
 * so the run is marked red and GitHub emails you.
 */
export async function deliver(sections: DigestSection[], cfg: TelegramConfig): Promise<number> {
  const messages = formatDigest(sections);
  const failed: string[] = [];
  for (const [i, text] of messages.entries()) {
    try {
      await sendMessage(cfg, text, i > 0);
      console.log(`  ✓ message ${i + 1}/${messages.length} sent (${text.length} chars)`);
    } catch (err) {
      console.log(`  ✗ message ${i + 1}/${messages.length} failed / 发送失败: ${(err as Error).message}`);
      failed.push(`${i + 1}`);
    }
  }
  if (failed.length) throw new Error(`Telegram: message(s) ${failed.join(", ")} of ${messages.length} not sent / 未发送`);
  return messages.length;
}
