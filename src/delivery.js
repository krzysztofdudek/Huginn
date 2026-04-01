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

function markdownToTelegramHtml(text) {
  // Convert **bold** to <b>bold</b>, then escape the rest
  return escape(text).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Telegram ──

async function sendTelegram(text) {
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
  const label = fromLabel && toLabel ? `${fromLabel} \u2192 ${toLabel}` : id;
  stories = stories || [];

  const mustRead = stories.slice(0, 5);
  const alsoRelevant = stories.slice(5);

  // Build markdown file (full)
  let md = `# Briefing \u2014 ${label}\n${storyCount} relevant stories\n\n${content}`;
  if (mustRead.length > 0) {
    md += "\n\n## Must read\n";
    for (const s of mustRead) md += `- ${formatStoryLine(s)}\n  ${storyLink(s)}\n`;
  }
  if (alsoRelevant.length > 0) {
    md += "\n\n## Also relevant\n";
    for (const s of alsoRelevant) md += `- ${formatStoryLine(s)}\n  ${storyLink(s)}\n`;
  }
  writeToFile(`${id}.md`, md);

  // Build Telegram messages
  const mode = config.delivery || "both";
  if (mode === "file") {
    db.markDeliverySent(id);
    return true;
  }

  // Message 1: Briefing text (chunked if too long)
  const header = `\ud83d\udccb <b>Briefing</b> \u2014 ${escape(label)}\n${storyCount} relevant stories\n\n`;
  const body = markdownToTelegramHtml(content);
  const fullMsg = header + body;

  if (fullMsg.length <= 4096) {
    const sent1 = await sendTelegram(fullMsg);
    if (!sent1) return false;
  } else {
    // Split body into paragraphs and send in chunks
    const paragraphs = body.split("\n\n");
    let chunk = header;
    for (const p of paragraphs) {
      if (chunk.length + p.length + 2 > 3800) {
        const sent = await sendTelegram(chunk);
        if (!sent) return false;
        await sleep(200);
        chunk = "";
      }
      chunk += (chunk ? "\n\n" : "") + p;
    }
    if (chunk.trim()) {
      const sent = await sendTelegram(chunk);
      if (!sent) return false;
    }
  }

  // Message 2: Must read links
  if (mustRead.length > 0) {
    await sleep(200);
    let linksMsg = `\ud83d\udccc <b>Must read</b> \u2014 ${escape(label)}`;
    for (const s of mustRead) {
      linksMsg += `\n\n${escape(formatStoryLine(s))}\n${storyLink(s)}`;
    }
    await sendTelegram(linksMsg);
  }

  // Message 3+: Also relevant (chunked if needed)
  if (alsoRelevant.length > 0) {
    await sleep(200);
    let chunk = `\ud83d\udd17 <b>Also relevant</b> \u2014 ${escape(label)}`;
    for (const s of alsoRelevant) {
      const line = `\n\n${escape(formatStoryLine(s))}\n${storyLink(s)}`;
      if (chunk.length + line.length > 3500) {
        await sendTelegram(chunk);
        await sleep(200);
        chunk = `\ud83d\udd17 <b>Also relevant</b> (cont.)`;
      }
      chunk += line;
    }
    if (chunk.length > 40) await sendTelegram(chunk);
  }

  db.markDeliverySent(id);
  return true;
}

// ── Weekly Trend ──

async function deliverWeekly(id, content, storyCount) {
  const week = id.replace("weekly-", "");
  const text = `\ud83d\udcca <b>Weekly Trend</b> \u2014 ${week}\n${storyCount} stories analyzed\n\n${markdownToTelegramHtml(content)}`;

  writeToFile(`${id}.md`, `# Weekly Trend \u2014 ${week}\n${storyCount} stories analyzed\n\n${content}`);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const sent = await sendTelegram(text);
  if (sent) db.markDeliverySent(id);
  return sent;
}

// ── Rising Alert ──

async function deliverRising(story) {
  const link = storyLink(story);
  const growth = `${story.prev_points} \u2192 ${story.points} pts (+${story.point_growth})`;
  const sum = story.summary ? `\n${story.summary}` : "";

  const content = `Rising: ${story.title}\n${growth}${sum}\n${link}`;
  writeToFile(`rising-${story.id}.md`, content);

  const mode = config.delivery || "both";
  if (mode === "file") return true;

  const text = `\ud83d\udcc8 <b>Rising</b>\n\n<b>${escape(story.title)}</b>\n${growth}${sum ? "\n" + escape(sum) : ""}\n\n${link}`;
  return sendTelegram(text);
}

// ── Thread Reply ──

async function deliverThreadReply(thread) {
  const hn = thread.hnUrl;
  const title = thread.storyTitle || "(unknown)";
  const replies = thread.replies.slice(0, 3);
  const replyText = replies.map((r) => {
    const t = (r.text || "").replace(/<[^>]+>/g, "").slice(0, 200);
    return `${r.author}: ${t}`;
  }).join("\n\n");

  writeToFile(`reply-${thread.myComment.comment_id}-${Date.now()}.md`,
    `Reply in: ${title}\n\n${replyText}\n\n${hn}`);

  const mode = config.delivery || "both";
  if (mode === "file") return true;

  return sendTelegram(`\ud83d\udcac <b>Reply to your comment</b>\n\nIn: <b>${escape(title)}</b>\n\n${escape(replyText)}\n\n${hn}`);
}

// ── Opportunity Alert ──

async function deliverOpportunity(opp) {
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
  writeToFile(`opportunity-${opp.comment_id}.md`, content);

  const mode = config.delivery || "both";
  if (mode === "file") return true;

  const text = `\ud83d\udca1 <b>Join this conversation</b>\n\n<b>${escape(opp.title)}</b> (${opp.story_points || 0} pts)\n\n${escape(opp.author)}: "${escape(commentText)}"\n\n${escape(extract)}\n\n${link}`;
  return sendTelegram(text);
}

// ── GitHub Watch ──

async function deliverStarChange(repo) {
  const content = `Your repo gained stars: ${repo.full_name}\n${repo.prev_stars} \u2192 ${repo.stars} (+${repo.star_growth})\nhttps://github.com/${repo.full_name}`;
  writeToFile(`stars-${repo.full_name.replace("/", "-")}-${Date.now()}.md`, content);

  const mode = config.delivery || "both";
  if (mode === "file") return true;

  return sendTelegram(`\u2b50 <b>Stars on your repo</b>\n\n<b>${escape(repo.full_name)}</b>\n${repo.prev_stars} \u2192 ${repo.stars} (+${repo.star_growth})\n\nhttps://github.com/${repo.full_name}`);
}

async function deliverRelease(release) {
  const body = (release.body || "").slice(0, 300);
  const content = `New release: ${release.full_name} ${release.tag_name}\n${release.name}\n\n${body}\nhttps://github.com/${release.full_name}/releases/tag/${release.tag_name}`;
  writeToFile(`release-${release.full_name.replace("/", "-")}-${release.tag_name}.md`, content);

  const mode = config.delivery || "both";
  if (mode === "file") return true;

  return sendTelegram(`\ud83d\udce6 <b>New release</b>\n\n<b>${escape(release.full_name)}</b> ${escape(release.tag_name)}\n${escape(release.name)}\n\n${escape(body)}\n\nhttps://github.com/${release.full_name}/releases/tag/${release.tag_name}`);
}

// ── Competitive ──

async function deliverCompetitive(content, storyId) {
  writeToFile(`competitive-${storyId}.md`, `# Competitor\n\n${content}`);

  const mode = config.delivery || "both";
  if (mode === "file") return true;

  return sendTelegram(`\ud83d\udd0d <b>Competitor</b>\n\n${markdownToTelegramHtml(content)}`);
}

// ── Flush unsent ──

async function flushUnsent() {
  const unsent = db.getUnsentDeliveries();
  let sent = 0;
  for (const d of unsent) {
    let ok = false;
    if (d.type === "briefing" || d.type === "daily") ok = await deliverBriefing(d.id, d.content, 0, []);
    else if (d.type === "weekly") ok = await deliverWeekly(d.id, d.content, 0);
    else if (d.type === "competitive") ok = await deliverCompetitive(d.content, 0);
    if (ok) sent++;
    else break;
  }
  return sent;
}

module.exports = {
  deliverBriefing, deliverWeekly, deliverRising, deliverOpportunity, deliverThreadReply, deliverStarChange, deliverRelease, deliverCompetitive,
  flushUnsent, writeToFile,
};
