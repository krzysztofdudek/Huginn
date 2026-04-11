const db = require("./db");
const { getConnector } = require("./connectors");
const config = require("./config");
const log = require("./logger");

const INTERESTS = (config.interests || []).join("\n- ");
const TAGS = (config.tags || []).join(", ");

// ── Article extraction ──

async function extractContent(story) {
  // Story text (Ask HN, Show HN)
  if (story.story_text && story.story_text.length > 50) {
    return stripHtml(story.story_text).slice(0, 3000);
  }
  // URL extraction
  if (story.url) {
    const content = await extractFromUrl(story.url);
    if (content) return content;
  }
  return null;
}

async function extractFromUrl(url) {
  // Try article-extractor
  try {
    const { extract } = await import("@extractus/article-extractor");
    const article = await extract(url);
    if (article && article.content) {
      const text = article.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (text.length > 100) return text.slice(0, 3000);
    }
  } catch {}

  // Try raw fetch
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000), redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return null;
    const html = await res.text();
    const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    let text = article ? article[1] : html;
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/\s+/g, " ").trim();
    const words = text.split(" ");
    const avgLen = words.reduce((s, w) => s + w.length, 0) / (words.length || 1);
    if (avgLen > 12 || text.length < 100) return null;
    return text.slice(0, 3000);
  } catch {}

  // Try archive.org
  try {
    const res = await fetch("https://web.archive.org/web/2/" + url, {
      headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000), redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const cleaned = html.replace(/<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    const article = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i) || cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    let text = article ? article[1] : cleaned;
    text = text.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    if (text.length < 100) return null;
    return text.slice(0, 3000);
  } catch {}

  return null;
}

function stripHtml(html) {
  return (html || "").replace(/<p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\s+href="([^"]*)"[^>]*>[^<]*<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}

// ── Classification ──

async function classify(story) {
  const isReddit = story.type && story.type.startsWith("reddit_");

  const strictness = isReddit
    ? `Be EXTRA strict for Reddit posts. Most Reddit posts are personal questions, support requests, or casual discussion — classify those as "irrelevant". Only mark as "relevant" or "adjacent" if the post shares a tool, technique, data, insight, or experience that would be useful to someone building in these areas. "How do I use X?" is irrelevant. "I built X and here's what I learned" might be adjacent. "Here's a tool that enforces X" is relevant.`
    : `Be strict: "relevant" = directly about AI coding agents, verification, enforcement, knowledge graphs, formal verification, supply chain security. "adjacent" = related to AI impact on software engineering, code review, Copilot/Cursor behavior, developer workflows with AI. "irrelevant" = everything else. NOT relevant: career advice, general AI news, model releases, politics, hardware, writing advice.`;

  const connector = getConnector();
  const hint = connector.classifyHint ? "\n" + connector.classifyHint : "";

  const result = await connector.chat(
    "You classify posts from tech news sources. Output ONLY valid JSON, nothing else.",
    `Classify this post. ${strictness}${hint}

Tags must be from this list ONLY: ${TAGS}
Pick 1-4 tags that apply. Empty array if irrelevant.

Areas of interest:
- ${INTERESTS}

Post: ${story.title}
Type: ${story.type}
${story.url ? "URL: " + story.url : ""}

Respond with JSON: {"relevance":"relevant|adjacent|irrelevant","tags":["tag1","tag2"]}`,
    { temperature: 0, topP: 1.0, topK: 1, maxTokens: 100 }
  );

  if (!result) return null;

  try {
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!parsed.relevance) return null;
    // Validate tags
    const validTags = new Set(config.tags || []);
    parsed.tags = (parsed.tags || []).filter((t) => validTags.has(t));
    return parsed;
  } catch (err) {
    log.warn(`Classify JSON parse failed for "${story.title.slice(0, 40)}": ${err.message}`);
    return null;
  }
}

async function summarize(story, content) {
  const text = content || story.title;
  const result = await getConnector().chat(
    "You summarize articles in 2-3 sentences. Output ONLY the summary. No labels, no bullets, no meta-commentary.",
    `Summarize this:\n\nTitle: ${story.title}\n\n${text}`,
    { temperature: 0.3, maxTokens: 300 }
  );
  if (!result || result.length < 20) return null;
  // Clean
  return result.replace(/^[\s]*[-*•]\s*/gm, "").replace(/\*+/g, "")
    .replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
}

// ── Process work queue ──

async function processClassifyQueue(limit) {
  const items = db.dequeueBatch("classify", limit || 50);
  if (items.length === 0) return 0;

  let done = 0;
  for (const item of items) {
    const story = db.getStory(parseInt(item.target_id, 10));
    if (!story) { db.completeWork(item.id); continue; }

    // Already analyzed?
    if (db.getAnalysis(story.id)) { db.completeWork(item.id); continue; }

    const result = await classify(story);
    if (!result) {
      db.failWork(item.id, "classify returned null");
      continue;
    }

    const convScore = story.num_comments > 0 ? story.num_comments / Math.max(story.points, 1) : 0;

    db.setAnalysis(story.id, {
      relevance: result.relevance,
      tags: result.tags,
      conversation_score: convScore,
    });

    // Enqueue summarize if relevant/adjacent
    if (result.relevance !== "irrelevant") {
      db.enqueue("summarize", story.id);
    }

    // Enqueue comment analysis for all relevant/adjacent stories with comments
    if (result.relevance !== "irrelevant" && story.num_comments >= 5) {
      db.enqueue("analyze_comments", story.id);
    }

    db.completeWork(item.id);
    done++;
  }
  return done;
}

async function processSummarizeQueue(limit) {
  const items = db.dequeueBatch("summarize", limit || 30);
  if (items.length === 0) return 0;

  let done = 0;
  for (const item of items) {
    const story = db.getStory(parseInt(item.target_id, 10));
    if (!story) { db.completeWork(item.id); continue; }

    const analysis = db.getAnalysis(story.id);
    if (analysis && analysis.summary) { db.completeWork(item.id); continue; }

    const content = await extractContent(story);
    const summary = await summarize(story, content);

    if (summary) {
      db.setAnalysis(story.id, { ...(analysis || {}), summary });
      db.completeWork(item.id);
      done++;
    } else {
      // Try once more, then accept no summary
      if (item.attempts >= 1) {
        db.setAnalysis(story.id, { ...(analysis || {}), summary: "" });
        db.completeWork(item.id);
      } else {
        db.failWork(item.id, "summarize returned null");
      }
    }
  }
  return done;
}

module.exports = { processClassifyQueue, processSummarizeQueue, classify, summarize, extractContent };
