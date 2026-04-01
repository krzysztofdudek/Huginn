const db = require("./db");
const config = require("./config");

const FIREBASE = "https://hacker-news.firebaseio.com/v0";
const DELAY = 50;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchItem(id) {
  try {
    const res = await fetch(`${FIREBASE}/item/${id}.json`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchCommentTree(commentId, storyId, depth) {
  if (depth > 10) return [];
  const item = await fetchItem(commentId);
  if (!item || item.deleted || item.dead) return [];
  await sleep(DELAY);

  const comment = {
    id: item.id,
    story_id: storyId,
    parent_id: item.parent || storyId,
    author: item.by || "[deleted]",
    text: item.text || "",
    points: item.score || 0,
    created_at: item.time || 0,
  };

  const results = [comment];
  if (item.kids && item.kids.length > 0) {
    for (const kidId of item.kids) {
      results.push(...await fetchCommentTree(kidId, storyId, depth + 1));
    }
  }
  return results;
}

async function deepFetchStory(storyId) {
  const storyItem = await fetchItem(storyId);
  if (!storyItem) return { allComments: [], newComments: [], updated: false };
  await sleep(DELAY);

  // Update story points and comment count
  const existing = db.getStory(storyId);
  if (existing) {
    db.upsertStories([{
      id: storyItem.id,
      title: storyItem.title || existing.title,
      url: storyItem.url || existing.url,
      author: storyItem.by || existing.author,
      points: storyItem.score || 0,
      num_comments: storyItem.descendants || 0,
      created_at: storyItem.time || existing.created_at,
      story_text: storyItem.text || existing.story_text || "",
      type: existing.type,
    }]);
    db.snapshotPoints([{ id: storyItem.id, points: storyItem.score || 0, num_comments: storyItem.descendants || 0 }]);
  }

  if (!storyItem.kids || storyItem.kids.length === 0) {
    return { allComments: [], newComments: [], updated: true };
  }

  // Get existing comment IDs for delta detection
  const existingIds = new Set(
    db.getDb().prepare("SELECT id FROM comments WHERE story_id = ?").all(storyId).map((r) => r.id)
  );

  // Fetch full tree
  let allComments = [];
  for (const kidId of storyItem.kids) {
    allComments.push(...await fetchCommentTree(kidId, storyId, 0));
  }

  // Find new comments (delta)
  const newComments = allComments.filter((c) => !existingIds.has(c.id));

  // Save all to DB
  if (allComments.length > 0) {
    db.upsertComments(allComments);
  }

  return { allComments, newComments, updated: true };
}

async function deepFetchRelevantStories(onProgress) {
  const now = Math.floor(Date.now() / 1000);
  const allNewComments = [];

  const stories = db.getDb().prepare(`
    SELECT s.id, s.title, s.num_comments, s.created_at, s.points,
      (SELECT COUNT(*) FROM comments c WHERE c.story_id = s.id) as actual_comments
    FROM stories s
    JOIN story_analysis sa ON sa.story_id = s.id
    WHERE sa.relevance IN ('relevant', 'adjacent')
      AND s.type NOT LIKE 'reddit_%' AND s.type != 'arxiv'
      AND s.num_comments >= 3
    ORDER BY s.created_at DESC
  `).all();

  let totalComments = 0;
  let totalNew = 0;
  let fetched = 0;
  let checked = 0;

  for (const story of stories) {
    const age = now - story.created_at;
    const lastFetch = db.getCursorInt("deep_" + story.id) || 0;
    const sinceFetch = now - lastFetch;

    let interval;
    if (age < 86400) {
      interval = 300; // < 24h: every 5 min
    } else if (age < 3 * 86400) {
      interval = 6 * 3600; // 1-3 days: every 6h
    } else {
      if (story.actual_comments >= story.num_comments * 0.9) continue;
      interval = 24 * 3600;
    }

    if (sinceFetch < interval) { checked++; continue; }

    if (onProgress) onProgress({ phase: "fetching", story: story.title, fetched, total: stories.length, comments: totalComments, newComments: totalNew });

    const result = await deepFetchStory(story.id);
    checked++;
    if (result.updated) {
      db.setCursor("deep_" + story.id, now);
      totalComments += result.allComments.length;
      totalNew += result.newComments.length;
      if (result.allComments.length > 0) fetched++;

      for (const c of result.newComments) {
        allNewComments.push({ ...c, storyTitle: story.title, storyPoints: story.points });
      }
    }
  }

  return { fetched, comments: totalComments, newComments: allNewComments };
}

module.exports = { deepFetchStory, deepFetchRelevantStories };
