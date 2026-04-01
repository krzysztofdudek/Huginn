const db = require("./db");
const config = require("./config");

const SUBREDDITS = (config.reddit && config.reddit.subreddits) || [
  "ClaudeAI", "cursor", "ChatGPTCoding", "LocalLLaMA", "ExperiencedDevs",
  "programming", "softwarearchitecture",
];

async function fetchRss(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "HNAssistant/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return res.text();
  } catch (err) {
    console.error(`  Reddit RSS error: ${err.message}`);
    return null;
  }
}

function parseAtomFeed(xml, subreddit) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];

    const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const link = (entry.match(/<link[^>]*href="([^"]*)"/) || [])[1] || "";
    const author = (entry.match(/<name>([^<]*)<\/name>/) || [])[1] || "[deleted]";
    const updated = (entry.match(/<updated>([^<]*)<\/updated>/) || [])[1] || "";
    const id = (entry.match(/<id>([^<]*)<\/id>/) || [])[1] || "";

    // Extract reddit post ID from link
    const postIdMatch = link.match(/\/comments\/([a-z0-9]+)\//);
    const postId = postIdMatch ? postIdMatch[1] : "";

    if (!postId || !title) continue;

    entries.push({
      redditId: postId,
      title: decodeHtmlEntities(title),
      url: link,
      author: author.replace("/u/", ""),
      created_at: updated ? Math.floor(new Date(updated).getTime() / 1000) : Math.floor(Date.now() / 1000),
      subreddit,
    });
  }

  return entries;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

function hashStringToInt(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 2147483647;
}

async function collectSubreddit(subreddit) {
  let total = 0;

  for (const sort of ["hot", "new"]) {
    const url = `https://www.reddit.com/r/${subreddit}/${sort}.rss?limit=25`;
    const xml = await fetchRss(url);
    if (!xml) continue;

    const entries = parseAtomFeed(xml, subreddit);

    for (const entry of entries) {
      const numericId = hashStringToInt("reddit_" + entry.redditId);

      // Check if already in DB
      const existing = db.getStory(numericId);
      if (existing) continue;

      db.upsertStories([{
        id: numericId,
        title: `[r/${subreddit}] ${entry.title}`,
        url: entry.url,
        author: entry.author,
        points: 0, // RSS doesn't provide scores
        num_comments: 0,
        created_at: entry.created_at,
        story_text: "",
        type: "reddit_" + subreddit.toLowerCase(),
      }]);

      db.enqueue("classify", numericId);
      total++;
    }

    await new Promise((r) => setTimeout(r, 2000)); // Rate limit
  }

  return total;
}

async function collect() {
  const lastCollect = db.getCursorInt("reddit_last_collect") || 0;
  const interval = (config.reddit && config.reddit.pollMinutes || 10) * 60;

  if (Math.floor(Date.now() / 1000) - lastCollect < interval) {
    return { posts: 0 };
  }

  let totalPosts = 0;

  for (const sub of SUBREDDITS) {
    try {
      const count = await collectSubreddit(sub);
      totalPosts += count;
    } catch (err) {
      console.error(`  Reddit r/${sub} error: ${err.message}`);
    }
  }

  db.setCursor("reddit_last_collect", Math.floor(Date.now() / 1000));
  return { posts: totalPosts };
}

module.exports = { collect };
