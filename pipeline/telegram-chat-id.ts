// 一次性小工具：找出你和 bot 的 chat id / One-off helper: find the chat id between you and your bot
// 用法 / Usage: 先在 Telegram 里给 bot 发一条消息，然后运行 `npm run chat-id`
//               First send your bot any message in Telegram, then run `npm run chat-id`
//
// 原理 / How it works:
// getUpdates 返回 bot 最近收到的消息，每条消息里都带着发送者所在的 chat id。
// getUpdates returns the bot's recent incoming messages; each one carries the chat id it came from.

try {
  process.loadEnvFile(".env");
} catch {
  /* 没有 .env 文件也没关系 / no .env file is fine */
}

const token = process.env.TELEGRAM_NEWS_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_NEWS_BOT_TOKEN is missing in .env / .env 里没有 TELEGRAM_NEWS_BOT_TOKEN");
  process.exit(1);
}

// token 是 URL 的一部分，所以出错时绝不打印 URL / The token is part of the URL, so never print the URL on errors
const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const body = (await res.json()) as {
  ok: boolean;
  description?: string;
  result?: { message?: { chat: { id: number; type: string; first_name?: string; username?: string }; text?: string } }[];
};

if (!body.ok) {
  // 401 = token 写错了 / 401 = wrong token
  console.error(`Telegram error / 出错: ${body.description}`);
  process.exit(1);
}

// 同一个 chat 可能发了好几条，去重后再显示 / The same chat may appear several times; show each once
const chats = new Map<number, string>();
for (const update of body.result ?? []) {
  const chat = update.message?.chat;
  if (chat) chats.set(chat.id, `${chat.type}  ${chat.first_name ?? ""} @${chat.username ?? "-"}  "${update.message?.text ?? ""}"`);
}

if (chats.size === 0) {
  console.log("No messages yet. Send your bot a message in Telegram, then run this again.");
  console.log("还没有消息。先在 Telegram 里给 bot 发一句话，再运行一次。");
} else {
  console.log("Chats found / 找到的 chat:");
  for (const [id, info] of chats) console.log(`  ${id}   ${info}`);
  console.log("\nAdd yours to .env / 把你的 id 加到 .env:  TELEGRAM_NEWS_CHAT_ID=<id>");
}
