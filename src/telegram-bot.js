const db = require("./db");
const config = require("./config");
const intelligence = require("./intelligence");
const delivery = require("./delivery");

const TOKEN = config.telegram && config.telegram.botToken;
const CHAT_ID = config.telegram && config.telegram.chatId;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

let lastUpdateId = 0;
let polling = false;

const COMMANDS = [
  { command: "huginn_brief", description: "Generate a briefing now" },
  { command: "huginn_status", description: "Show what's in the database" },
  { command: "huginn_links", description: "Resend links from last briefing" },
  { command: "huginn_rising", description: "What's gaining traction right now" },
];

async function registerCommands() {
  if (!API) return;
  try {
    await fetch(`${API}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: COMMANDS }),
    });
  } catch {}
}

async function getUpdates() {
  if (!API) return [];
  try {
    const res = await fetch(`${API}/getUpdates?offset=${lastUpdateId + 1}&timeout=1`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.result || [];
  } catch {
    return [];
  }
}

async function reply(chatId, text) {
  if (!API) return;
  try {
    await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch {}
}

function escapeHtml(text) {
  return (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Command handlers ──

async function handleBrief(chatId) {
  const lastTs = parseInt(db.getCursor("last_briefing_ts") || "0", 10);
  const now = Math.floor(Date.now() / 1000);
  const from = lastTs || (now - 86400);

  const range = { from, to: now };
  const stories = db.getRelevantStoriesInRange(from, now);

  if (stories.length === 0) {
    await reply(chatId, "Nothing new since last briefing.");
    return;
  }

  await reply(chatId, `\u2709 Generating briefing (${stories.length} stories)...`);

  const result = await intelligence.generateBriefing(range);
  if (result) {
    await delivery.deliverBriefing(result.id, result.content, result.storyCount, result.stories, result.fromLabel, result.toLabel);
  } else {
    await reply(chatId, "Couldn't generate briefing. Is Ollama running?");
  }
}

async function handleStatus(chatId) {
  const s = db.getStats();
  const lastBriefing = db.getCursor("last_briefing_ts");
  const sinceDate = db.getCursor("since_date");
  const lastBriefLabel = lastBriefing
    ? new Date(parseInt(lastBriefing) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC"
    : "never";

  const text = `<b>Huginn Status</b>

<b>Collecting since:</b> ${sinceDate || "not started"}
<b>Last briefing:</b> ${lastBriefLabel}

<b>HN:</b> ${s.stories} stories, ${s.comments} comments
<b>Analysis:</b> ${s.analyzed} (${s.relevant} relevant, ${s.adjacent} adjacent)
<b>Comments analyzed:</b> ${s.commentAnalysis}
<b>People tracked:</b> ${s.people}
<b>GitHub repos:</b> ${s.githubRepos} (${s.githubRelevant} relevant)
<b>Queue:</b> ${s.pendingWork} pending
<b>Unsent:</b> ${s.unsentDeliveries}`;

  await reply(chatId, text);
}

async function handleLinks(chatId) {
  const lastDelivery = db.getDb().prepare(
    "SELECT * FROM deliveries WHERE type = 'briefing' AND sent = 1 ORDER BY generated_at DESC LIMIT 1"
  ).get();

  if (!lastDelivery) {
    await reply(chatId, "No briefing has been sent yet.");
    return;
  }

  // Get stories from the range encoded in the delivery ID
  const match = lastDelivery.id.match(/briefing-(\d+)-(\d+)/);
  if (!match) {
    await reply(chatId, "Can't parse last briefing range.");
    return;
  }

  const from = parseInt(match[1], 10);
  const to = parseInt(match[2], 10);
  const stories = db.getRelevantStoriesInRange(from, to);

  if (stories.length === 0) {
    await reply(chatId, "No stories found for last briefing range.");
    return;
  }

  // Send links in chunks
  const must = stories.slice(0, 5);
  const rest = stories.slice(5);

  let msg = "\ud83d\udccc <b>Links from last briefing</b>\n";
  for (const s of must) {
    const pts = s.points > 0 ? `${s.points}\u2191 ` : "";
    const link = s.type === "arxiv" ? s.url : s.type && s.type.startsWith("reddit_") ? s.url : `https://news.ycombinator.com/item?id=${s.id}`;
    msg += `\n${pts}${escapeHtml(s.title)}\n${link}\n`;
  }
  await reply(chatId, msg);

  if (rest.length > 0) {
    let chunk = "\ud83d\udd17 <b>Also relevant</b>\n";
    for (const s of rest) {
      const link = s.type === "arxiv" ? s.url : s.type && s.type.startsWith("reddit_") ? s.url : `https://news.ycombinator.com/item?id=${s.id}`;
      const line = `\n${escapeHtml(s.title)}\n${link}\n`;
      if (chunk.length + line.length > 3800) {
        await reply(chatId, chunk);
        chunk = "";
      }
      chunk += line;
    }
    if (chunk.trim()) await reply(chatId, chunk);
  }
}

async function handleRising(chatId) {
  const rising = db.getRisingStories(
    (config.intelligence && config.intelligence.rising && config.intelligence.rising.windowHours) || 6,
    (config.intelligence && config.intelligence.rising && config.intelligence.rising.minGrowth) || 20
  );

  if (rising.length === 0) {
    await reply(chatId, "Nothing rising right now.");
    return;
  }

  let msg = "\ud83d\udcc8 <b>Rising now</b>\n";
  for (const s of rising.slice(0, 10)) {
    msg += `\n<b>${escapeHtml(s.title)}</b>\n${s.prev_points} \u2192 ${s.points} pts (+${s.point_growth})\nhttps://news.ycombinator.com/item?id=${s.id}\n`;
  }
  await reply(chatId, msg);
}

// ── Poll loop ──

async function processUpdates() {
  const updates = await getUpdates();

  for (const update of updates) {
    lastUpdateId = update.update_id;

    const msg = update.message;
    if (!msg || !msg.text) continue;

    // Only respond to configured chat ID
    if (CHAT_ID && String(msg.chat.id) !== String(CHAT_ID)) continue;

    const text = msg.text.trim().toLowerCase();

    const cmd = text.split("@")[0]; // strip @botname suffix

    if (cmd === "/huginn_brief") {
      await handleBrief(msg.chat.id);
    } else if (cmd === "/huginn_status") {
      await handleStatus(msg.chat.id);
    } else if (cmd === "/huginn_links") {
      await handleLinks(msg.chat.id);
    } else if (cmd === "/huginn_rising") {
      await handleRising(msg.chat.id);
    } else if (cmd === "/start" || cmd === "/help") {
      await reply(msg.chat.id,
        `<b>Huginn</b> \u2014 your intelligence feed\n\n` +
        `/huginn_brief \u2014 Generate a briefing now\n` +
        `/huginn_status \u2014 Show what's in the database\n` +
        `/huginn_links \u2014 Resend links from last briefing\n` +
        `/huginn_rising \u2014 What's gaining traction right now`
      );
    }
  }
}

function startPolling() {
  if (!API || !CHAT_ID) return;
  if (polling) return;
  polling = true;
  registerCommands();
}

module.exports = { registerCommands, processUpdates, startPolling };
