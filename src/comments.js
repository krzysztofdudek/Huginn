const db = require("./db");
const ollama = require("./ollama");

const BATCH_SIZE = 15;

function stripHtml(html) {
  return (html || "").replace(/<p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\s+href="([^"]*)"[^>]*>[^<]*<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}

async function analyzeBatch(story, comments) {
  const commentBlock = comments.map((c, i) =>
    `[${i}] ${c.author} (${c.points || 0} pts): ${stripHtml(c.text).slice(0, 250)}`
  ).join("\n\n");

  const result = await ollama.chat(
    `You are a STRICT comment filter. You analyze discussion comments for a software engineer interested in the topics described below. Output ONLY a valid JSON array.

RULES:
- insight=1 if the comment shares a non-obvious technical finding, real-world data, or experience that adds knowledge beyond the article itself.
- need=1 if someone describes a problem they face or asks for a tool/solution. Not just complaining — specifically identifying a gap.
- opportunity=1 if you could respond with concrete experience from building enforcement tools, knowledge graphs, or verification systems. The comment must be about a topic you have direct expertise in.
- Most comments will be all zeros. Flag only the genuinely notable ones.

Output: [{"index":N,"insight":0|1,"need":0|1,"opportunity":0|1,"extract":"one sentence summary"}]`,
    `Post: "${story.title}"\n\nComments:\n${commentBlock}\n\nJSON array:`,
    { temperature: 0, maxTokens: 1500 }
  );

  if (!result) return null;

  try {
    const match = result.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    const rows = [];
    for (const entry of parsed) {
      const idx = entry.index;
      if (idx == null || idx < 0 || idx >= comments.length) continue;
      const c = comments[idx];
      rows.push({
        comment_id: c.id,
        story_id: story.id,
        is_insight: entry.insight ? 1 : 0,
        is_need: entry.need ? 1 : 0,
        is_opportunity: entry.opportunity ? 1 : 0,
        extract: entry.extract || "",
      });
    }
    return rows;
  } catch {
    return null;
  }
}

async function processCommentQueue(limit) {
  const items = db.dequeueBatch("analyze_comments", limit || 20);
  if (items.length === 0) return 0;

  let done = 0;
  for (const item of items) {
    const storyId = parseInt(item.target_id, 10);
    const story = db.getStory(storyId);
    if (!story) { db.completeWork(item.id); continue; }

    // Get ALL comments for this story, not just top 15
    const allComments = db.getDb().prepare(
      "SELECT * FROM comments WHERE story_id = ? ORDER BY points DESC, created_at ASC"
    ).all(storyId);

    if (allComments.length === 0) { db.completeWork(item.id); continue; }

    // Skip already-analyzed comments
    const analyzedIds = new Set(
      db.getCommentAnalysis(storyId).map((ca) => ca.comment_id)
    );
    const toAnalyze = allComments.filter((c) => !analyzedIds.has(c.id));

    if (toAnalyze.length === 0) { db.completeWork(item.id); continue; }

    // Process in batches of BATCH_SIZE
    let totalRows = 0;
    for (let i = 0; i < toAnalyze.length; i += BATCH_SIZE) {
      const batch = toAnalyze.slice(i, i + BATCH_SIZE);
      const rows = await analyzeBatch(story, batch);
      if (rows && rows.length > 0) {
        db.setCommentAnalysisBatch(rows);
        totalRows += rows.length;
      }
    }

    db.completeWork(item.id);
    done++;
    process.stdout.write(`\r  Comments: ${story.title.slice(0, 40)}... (${toAnalyze.length} comments, ${totalRows} flagged)`);
  }

  if (done > 0) process.stdout.write("\n");
  return done;
}

module.exports = { processCommentQueue };
