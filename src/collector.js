const db = require("./db");
const config = require("./config");

const ALGOLIA = "https://hn.algolia.com/api/v1";
const DELAY = 150;
const DAY = 86400;

const HOUR = 3600;
const MIN = 60;
const TRACKING_DAYS = config.collector.trackingDays || 30;

function shouldSnapshot(storyAge, timeSinceLastSnapshot) {
  if (storyAge < 6 * HOUR) return timeSinceLastSnapshot >= 60;
  if (storyAge < 48 * HOUR) return timeSinceLastSnapshot >= 15 * MIN;
  if (storyAge < 7 * 86400) return timeSinceLastSnapshot >= HOUR;
  if (storyAge < TRACKING_DAYS * 86400) return timeSinceLastSnapshot >= 6 * HOUR;
  return false;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchPage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    if (res.status === 429) { await sleep(30000); return fetchPage(url); }
    throw new Error(`Algolia ${res.status}`);
  }
  return res.json();
}

async function fetchAllPages(baseUrl, onBatch) {
  let page = 0, total = 0;
  while (true) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const data = await fetchPage(`${baseUrl}${sep}hitsPerPage=1000&page=${page}`);
    if (!data.hits || data.hits.length === 0) break;
    total += data.hits.length;
    await onBatch(data.hits);
    if (page >= data.nbPages - 1) break;
    page++;
    await sleep(DELAY);
  }
  return total;
}

function dayWindows(from, to) {
  const wins = [];
  let s = from;
  while (s < to) { const e = Math.min(s + DAY, to); wins.push({ s, e }); s = e; }
  return wins;
}

function classifyType(title) {
  const t = (title || "").toLowerCase();
  if (t.startsWith("show hn")) return "show_hn";
  if (t.startsWith("ask hn")) return "ask_hn";
  if (t.startsWith("tell hn")) return "tell_hn";
  return "article";
}

function normalizeStory(hit) {
  return {
    id: parseInt(hit.objectID, 10),
    title: hit.title || "", url: hit.url || "",
    author: hit.author || "[deleted]",
    points: hit.points || 0,
    num_comments: hit.num_comments || 0,
    created_at: hit.created_at_i,
    story_text: hit.story_text || "",
    type: classifyType(hit.title),
  };
}

function normalizeComment(hit) {
  return {
    id: parseInt(hit.objectID, 10),
    story_id: hit.story_id,
    parent_id: hit.parent_id,
    author: hit.author || "[deleted]",
    text: hit.comment_text || "",
    points: hit.points || 0,
    created_at: hit.created_at_i,
  };
}

async function collectStories(sinceTs, onProgress) {
  const now = Math.floor(Date.now() / 1000);
  const windows = dayWindows(sinceTs, now);
  let total = 0;

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    if (onProgress) onProgress("stories", i + 1, windows.length, total);
    const url = `${ALGOLIA}/search_by_date?tags=story&numericFilters=created_at_i>${w.s},created_at_i<=${w.e}`;
    await fetchAllPages(url, (hits) => {
      const stories = hits.map(normalizeStory);
      db.upsertStories(stories);
      db.snapshotPoints(stories);
      total += stories.length;
      // Enqueue for analysis
      for (const s of stories) {
        if (s.points >= (config.collector.minPoints || 5)) {
          db.enqueue("classify", s.id);
        }
      }
    });
  }

  db.setCursor("story", now);
  return total;
}

// Comments are now fetched per-story via Firebase deep fetch (hn-deep-fetch.js)
// Algolia comment bulk fetch removed — incomplete coverage, no scores, redundant.

async function collectMyComments() {
  const username = config.hnUsername;
  if (!username) return 0;

  const cursor = db.getCursorInt("my_comments") || 0;
  let total = 0;

  const url = `${ALGOLIA}/search_by_date?tags=comment,author_${username}&numericFilters=created_at_i>${cursor}`;
  await fetchAllPages(url, (hits) => {
    const comments = hits.map(normalizeComment);
    db.upsertMyComments(comments);
    for (const c of comments) {
      db.upsertWatchedThread(c.id, c.story_id);
    }
    total += comments.length;
  });

  if (total > 0) db.setCursor("my_comments", Math.floor(Date.now() / 1000));
  return total;
}

async function refreshRecentPoints() {
  const now = Math.floor(Date.now() / 1000);
  const sinceTs = now - TRACKING_DAYS * 86400;
  let fetched = 0;
  let matched = 0;
  let newlyQualified = 0;
  let snapshotted = 0;
  const url = `${ALGOLIA}/search_by_date?tags=story&numericFilters=created_at_i>${sinceTs}`;
  await fetchAllPages(url, (hits) => {
    const stories = hits.map(normalizeStory);
    for (const s of stories) {
      const existing = db.getStory(s.id);
      if (existing) {
        db.upsertStories([s]);
        const storyAge = now - s.created_at;
        const lastSnapshot = db.getLastSnapshotTime(s.id);
        const sinceLast = lastSnapshot ? now - lastSnapshot : Infinity;
        if (shouldSnapshot(storyAge, sinceLast)) {
          db.snapshotPoints([s]);
          snapshotted++;
        }
        matched++;
      }
    }
    fetched += stories.length;
    for (const s of stories) {
      if (s.points >= (config.collector.minPoints || 5) && !db.getAnalysis(s.id)) {
        db.upsertStories([s]);
        db.enqueue("classify", s.id);
        newlyQualified++;
      }
    }
  });
  return { fetched, matched, newlyQualified, snapshotted };
}

module.exports = { collectStories, collectMyComments, refreshRecentPoints };
