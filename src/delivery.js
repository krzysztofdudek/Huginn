const db = require("./db");
const config = require("./config");
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "output");
const API = config.telegram && config.telegram.botToken
  ? `https://api.telegram.org/bot${config.telegram.botToken}`
  : null;

function escape(text) {
  return (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isQuietHours() {
  const hours = config.quietHoursUTC;
  if (!hours || !Array.isArray(hours) || hours.length !== 2) return false;
  const [start, end] = hours;
  const now = new Date().getUTCHours();
  if (start < end) {
    return now >= start && now < end; // e.g. [23, 7] doesn't apply here
  }
  // Wraps midnight: [23, 7] means 23,0,1,2,3,4,5,6
  return now >= start || now < end;
}

function markdownToTelegramHtml(text) {
  // Convert **bold** to <b>bold</b>, then escape the rest
  return escape(text).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Telegram ──

async function sendTelegram(text) {
  // During quiet hours, queue to DB instead of sending
  if (isQuietHours()) {
    db.enqueueQuiet(text);
    return true;
  }
  try {
    const res = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`  Telegram ${res.status}: ${body.slice(0, 100)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`  Telegram unavailable: ${err.message}`);
    return false;
  }
}

// ── Send and track ──

async function sendAndTrack(deliveryId, messages) {
  db.saveDeliveryMessages(deliveryId, messages);
  return await flushDeliveryMessages(deliveryId);
}

async function flushDeliveryMessages(deliveryId) {
  const rows = deliveryId
    ? db.getDeliveryMessages(deliveryId).filter((r) => !r.sent)
    : db.getUnsentMessages();

  for (const row of rows) {
    if (isQuietHours()) {
      db.enqueueQuiet(row.message);
      db.markMessageSent(row.id);
      continue;
    }
    const ok = await sendTelegram(row.message);
    if (!ok) return false; // stop on first failure, retry next cycle
    db.markMessageSent(row.id);
    if (db.isDeliveryFullySent(row.delivery_id)) {
      db.markDeliverySent(row.delivery_id);
    }
    await sleep(200);
  }
  return true;
}

// ── File output ──

function writeToFile(filename, content) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), content, "utf-8");
}

// ── Story formatting ──

function storyLink(story) {
  if (story.type === "arxiv") return story.url;
  if (story.type && story.type.startsWith("reddit_")) return story.url;
  return `https://news.ycombinator.com/item?id=${story.id}`;
}

function sourceLabel(story) {
  if (story.type && story.type.startsWith("reddit_")) return "reddit";
  if (story.type === "arxiv") return "arxiv";
  if (story.type === "show_hn") return "Show HN";
  if (story.type === "ask_hn") return "Ask HN";
  return "HN";
}

function cleanTitle(story) {
  return (story.title || "").replace(/^\[(r\/\w+|arxiv)\] /, "");
}

function formatStoryLine(story) {
  const pts = story.points > 0 ? `${story.points}pts ` : "";
  return `${pts}[${sourceLabel(story)}] ${cleanTitle(story)}`;
}

// ── Briefing ──

async function deliverBriefing(id, content, storyCount, stories, fromLabel, toLabel) {
  const label = fromLabel && toLabel ? `${fromLabel} → ${toLabel}` : id;
  stories = stories || [];

  const mustRead = stories.slice(0, 5);
  const alsoRelevant = stories.slice(5);

  // Build markdown file (always, regardless of delivery mode)
  let md = `# Briefing — ${label}\n${storyCount} relevant stories\n\n${content}`;
  if (mustRead.length > 0) {
    md += "\n\n## Must read\n";
    for (const s of mustRead) md += `- ${formatStoryLine(s)}\n  ${storyLink(s)}\n`;
  }
  if (alsoRelevant.length > 0) {
    md += "\n\n## Also relevant\n";
    for (const s of alsoRelevant) md += `- ${formatStoryLine(s)}\n  ${storyLink(s)}\n`;
  }
  writeToFile(`${id}.md`, md);

  const mode = config.delivery || "both";
  if (mode === "file") {
    db.markDeliverySent(id);
    return true;
  }

  // Build Telegram messages
  const messages = [];

  // Message 1+: Briefing text (chunked if needed)
  const header = `📋 <b>Briefing</b> — ${escape(label)}\n${storyCount} relevant stories\n\n`;
  const body = markdownToTelegramHtml(content);
  const fullMsg = header + body;

  if (fullMsg.length <= 4096) {
    messages.push(fullMsg);
  } else {
    const paragraphs = body.split("\n\n");
    let chunk = header;
    for (const p of paragraphs) {
      if (chunk.length + p.length + 2 > 3800) {
        messages.push(chunk);
        chunk = "";
      }
      chunk += (chunk ? "\n\n" : "") + p;
    }
    if (chunk.trim()) messages.push(chunk);
  }

  // Must read links
  if (mustRead.length > 0) {
    let linksMsg = `📌 <b>Must read</b> — ${escape(label)}`;
    for (const s of mustRead) {
      linksMsg += `\n\n${escape(formatStoryLine(s))}\n${storyLink(s)}`;
    }
    messages.push(linksMsg);
  }

  // Also relevant (chunked)
  if (alsoRelevant.length > 0) {
    let chunk = `🔗 <b>Also relevant</b> — ${escape(label)}`;
    for (const s of alsoRelevant) {
      const line = `\n\n${escape(formatStoryLine(s))}\n${storyLink(s)}`;
      if (chunk.length + line.length > 3500) {
        messages.push(chunk);
        chunk = `🔗 <b>Also relevant</b> (cont.)`;
      }
      chunk += line;
    }
    if (chunk.length > 40) messages.push(chunk);
  }

  return sendAndTrack(id, messages);
}

// ── Weekly Trend ──

async function deliverWeekly(id, content, storyCount) {
  const week = id.replace("weekly-", "");
  writeToFile(`${id}.md`, `# Weekly Trend — ${week}\n${storyCount} stories analyzed\n\n${content}`);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `📊 <b>Weekly Trend</b> — ${week}\n${storyCount} stories analyzed\n\n${markdownToTelegramHtml(content)}`;
  return sendAndTrack(id, [text]);
}

// ── Rising Alert ──

async function deliverRising(story) {
  const id = `rising-${story.id}`;
  const link = storyLink(story);
  const growth = `${story.prev_points} → ${story.points} pts (+${story.point_growth})`;
  const sum = story.summary ? `\n${story.summary}` : "";

  const content = `Rising: ${story.title}\n${growth}${sum}\n${link}`;
  writeToFile(`${id}.md`, content);
  db.saveDelivery(id, "rising", content);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `📈 <b>Rising</b>\n\n<b>${escape(story.title)}</b>\n${growth}${sum ? "\n" + escape(sum) : ""}\n\n${link}`;
  return sendAndTrack(id, [text]);
}

// ── Opportunity Alert ──

async function deliverOpportunity(opp) {
  const id = `opportunity-${opp.comment_id}`;
  const story = db.getStory(opp.story_id) || {};
  const link = storyLink(story);
  const commentText = (opp.text || "")
    .replace(/<p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\s+href="([^"]*)"[^>]*>[^<]*<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ").trim()
    .slice(0, 400);
  const extract = opp.extract || "";

  const content = `Opportunity in: ${opp.title}\n\n${opp.author}: "${commentText}"\n\nWhy: ${extract}\n\n${link}`;
  writeToFile(`${id}.md`, content);
  db.saveDelivery(id, "opportunity", content);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `💡 <b>Join this conversation</b>\n\n<b>${escape(opp.title)}</b> (${opp.story_points || 0} pts)\n\n${escape(opp.author)}: "${escape(commentText)}"\n\n${escape(extract)}\n\n${link}`;
  return sendAndTrack(id, [text]);
}

// ── Thread Reply ──

async function deliverThreadReply(thread) {
  const id = `reply-${thread.myComment.comment_id}-${Math.floor(Date.now() / 1000)}`;
  const hn = thread.hnUrl;
  const title = thread.storyTitle || "(unknown)";
  const replies = thread.replies.slice(0, 3);
  const replyText = replies.map((r) => {
    const t = (r.text || "").replace(/<[^>]+>/g, "").slice(0, 200);
    return `${r.author}: ${t}`;
  }).join("\n\n");

  const content = `Reply in: ${title}\n\n${replyText}\n\n${hn}`;
  writeToFile(`${id}.md`, content);
  db.saveDelivery(id, "reply", content);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `💬 <b>Reply to your comment</b>\n\nIn: <b>${escape(title)}</b>\n\n${escape(replyText)}\n\n${hn}`;
  return sendAndTrack(id, [text]);
}

// ── GitHub Watch ──

async function deliverStarChange(repo) {
  const id = `stars-${repo.full_name.replace("/", "-")}-${Math.floor(Date.now() / 1000)}`;
  const content = `Your repo gained stars: ${repo.full_name}\n${repo.prev_stars} → ${repo.stars} (+${repo.star_growth})\nhttps://github.com/${repo.full_name}`;
  writeToFile(`${id}.md`, content);
  db.saveDelivery(id, "stars", content);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `⭐ <b>Stars on your repo</b>\n\n<b>${escape(repo.full_name)}</b>\n${repo.prev_stars} → ${repo.stars} (+${repo.star_growth})\n\nhttps://github.com/${repo.full_name}`;
  return sendAndTrack(id, [text]);
}

async function deliverRelease(release) {
  const id = `release-${release.full_name.replace("/", "-")}-${release.tag_name}`;
  const body = (release.body || "").slice(0, 300);
  const content = `New release: ${release.full_name} ${release.tag_name}\n${release.name}\n\n${body}\nhttps://github.com/${release.full_name}/releases/tag/${release.tag_name}`;
  writeToFile(`${id}.md`, content);
  db.saveDelivery(id, "release", content);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `📦 <b>New release</b>\n\n<b>${escape(release.full_name)}</b> ${escape(release.tag_name)}\n${escape(release.name)}\n\n${escape(body)}\n\nhttps://github.com/${release.full_name}/releases/tag/${release.tag_name}`;
  return sendAndTrack(id, [text]);
}

// ── Competitive ──

async function deliverCompetitive(content, storyId) {
  const id = `competitive-${storyId}`;
  writeToFile(`${id}.md`, `# Competitor\n\n${content}`);
  // competitive deliveries are already saved by intelligence.js

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `🔍 <b>Competitor</b>\n\n${markdownToTelegramHtml(content)}`;
  return sendAndTrack(id, [text]);
}

// ── Flush quiet queue (called when quiet hours end) ──

async function flushQuietQueue() {
  if (isQuietHours()) return 0;
  const queued = db.getQuietQueue();
  if (queued.length === 0) return 0;

  let sent = 0;

  if (queued.length <= 3) {
    for (const item of queued) {
      const ok = await sendTelegram(item.message);
      if (ok) sent++;
      await sleep(200);
    }
  } else {
    const header = `🌙 <b>While you slept</b> (${queued.length} notifications)\n`;
    let chunk = header;
    for (const item of queued) {
      const plain = item.message.replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
      if (chunk.length + plain.length + 4 > 3800) {
        const ok = await sendTelegram(chunk);
        if (ok) sent++;
        await sleep(200);
        chunk = "";
      }
      chunk += (chunk ? "\n\n---\n\n" : "") + plain;
    }
    if (chunk.trim()) {
      const ok = await sendTelegram(chunk);
      if (ok) sent++;
    }
  }

  db.clearQuietQueue();
  return sent;
}

// ── Flush unsent deliveries ──

async function flushUnsent() {
  // First: rebuild messages for deliveries that were saved but never got messages
  // (e.g., app crashed between generateBriefing and deliverBriefing)
  const orphaned = db.getUnsentDeliveriesWithoutMessages();
  for (const d of orphaned) {
    rebuildDeliveryMessages(d);
  }

  // Then: send all unsent messages in order
  const ok = await flushDeliveryMessages(null);
  return ok;
}

function rebuildDeliveryMessages(delivery) {
  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(delivery.id); return; }

  if (delivery.type === "briefing") {
    const stories = delivery.stories_json ? JSON.parse(delivery.stories_json) : [];
    const storyCount = stories.length;
    const label = delivery.id.replace("briefing-", "");

    const messages = [];
    const header = `📋 <b>Briefing</b> — ${escape(label)}\n${storyCount} relevant stories\n\n`;
    const body = markdownToTelegramHtml(delivery.content);
    const fullMsg = header + body;

    if (fullMsg.length <= 4096) {
      messages.push(fullMsg);
    } else {
      const paragraphs = body.split("\n\n");
      let chunk = header;
      for (const p of paragraphs) {
        if (chunk.length + p.length + 2 > 3800) {
          messages.push(chunk);
          chunk = "";
        }
        chunk += (chunk ? "\n\n" : "") + p;
      }
      if (chunk.trim()) messages.push(chunk);
    }

    const mustRead = stories.slice(0, 5);
    const alsoRelevant = stories.slice(5);

    if (mustRead.length > 0) {
      let linksMsg = `📌 <b>Must read</b> — ${escape(label)}`;
      for (const s of mustRead) {
        linksMsg += `\n\n${escape(formatStoryLine(s))}\n${storyLink(s)}`;
      }
      messages.push(linksMsg);
    }

    if (alsoRelevant.length > 0) {
      let chunk = `🔗 <b>Also relevant</b> — ${escape(label)}`;
      for (const s of alsoRelevant) {
        const line = `\n\n${escape(formatStoryLine(s))}\n${storyLink(s)}`;
        if (chunk.length + line.length > 3500) {
          messages.push(chunk);
          chunk = `🔗 <b>Also relevant</b> (cont.)`;
        }
        chunk += line;
      }
      if (chunk.length > 40) messages.push(chunk);
    }

    db.saveDeliveryMessages(delivery.id, messages);
  } else {
    // For all other types, content was already formatted as Telegram HTML
    db.saveDeliveryMessages(delivery.id, [delivery.content]);
  }
}

module.exports = {
  deliverBriefing, deliverWeekly, deliverRising, deliverOpportunity, deliverThreadReply, deliverStarChange, deliverRelease, deliverCompetitive,
  flushUnsent, flushQuietQueue, isQuietHours, writeToFile,
};
