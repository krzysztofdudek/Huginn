const db = require("./db");
const { getConnector, isAvailable } = require("./connectors");
const config = require("./config");
const log = require("./logger");

function stripHtml(html) {
  return (html || "").replace(/<p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\s+href="([^"]*)"[^>]*>[^<]*<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ").trim();
}

function buildParentChain(parentId, storyId, maxDepth) {
  const chain = [];
  let currentId = parentId;

  for (let i = 0; i < (maxDepth || 3); i++) {
    if (currentId === storyId) break;
    const parent = db.getDb().prepare("SELECT * FROM comments WHERE id = ?").get(currentId);
    if (!parent) break;
    chain.unshift(parent);
    currentId = parent.parent_id;
  }

  return chain;
}

function formatThread(newComment, parentChain) {
  let thread = "";
  for (let i = 0; i < parentChain.length; i++) {
    const p = parentChain[i];
    const indent = "  ".repeat(i);
    const text = stripHtml(p.text).slice(0, 150);
    thread += `${indent}${p.author} (${p.points || 0}pts): ${text}\n`;
  }
  const indent = "  ".repeat(parentChain.length);
  const text = stripHtml(newComment.text).slice(0, 250);
  thread += `${indent}> ${newComment.author} (${newComment.points || 0}pts): ${text}`;
  return thread;
}

// ── Analyze delta: new comments from deep fetch ──

async function analyzeNewComments(newComments) {
  if (!newComments || newComments.length === 0) return [];
  if (!isAvailable()) return [];

  const interests = (config.interests || []).join("\n- ");

  // Group by story
  const byStory = {};
  for (const c of newComments) {
    const sid = String(c.story_id);
    if (!byStory[sid]) byStory[sid] = { title: c.storyTitle || "", points: c.storyPoints || 0, comments: [] };
    byStory[sid].comments.push(c);
  }

  const opportunities = [];

  for (const [storyId, group] of Object.entries(byStory)) {
    // Build threaded context for each new comment
    const threads = [];
    for (const c of group.comments) {
      const parentChain = buildParentChain(c.parent_id, parseInt(storyId), 3);
      threads.push({
        comment: c,
        formatted: formatThread(c, parentChain),
      });
    }

    // Skip if too many (batch max ~15 threads per call)
    const batch = threads.slice(0, 15);

    const threadsBlock = batch.map((t, i) =>
      `[${i}] Post: "${group.title}" (${group.points}pts)\n${t.formatted}`
    ).join("\n\n---\n\n");

    const result = await getConnector().chat(
      `You detect conversations worth joining for someone working in these areas:\n- ${interests}\n\nFor each new comment (marked with >), decide if the user could contribute something meaningful from their experience. Most should be false.\n\nOutput ONLY a JSON array: [{"index":N,"join":true|false,"reason":"one sentence"}]`,
      `These comments just appeared:\n\n${threadsBlock}\n\nJSON array:`,
      { temperature: 0, maxTokens: 600 }
    );

    if (!result) continue;

    try {
      const match = result.match(/\[[\s\S]*\]/);
      if (!match) continue;
      const parsed = JSON.parse(match[0]);

      for (const entry of parsed) {
        if (!entry.join || entry.index == null) continue;
        if (entry.index < 0 || entry.index >= batch.length) continue;

        const t = batch[entry.index];
        opportunities.push({
          comment_id: t.comment.id,
          story_id: parseInt(storyId),
          story_title: group.title,
          story_points: group.points,
          author: t.comment.author,
          text: t.comment.text,
          thread_context: t.formatted,
          reason: entry.reason || "",
          hn_url: `https://news.ycombinator.com/item?id=${t.comment.id}`,
        });
      }
    } catch (err) {
      log.warn(`Comment analysis JSON parse failed for story ${storyId}: ${err.message}`);
    }
  }

  return opportunities;
}

module.exports = { analyzeNewComments };
