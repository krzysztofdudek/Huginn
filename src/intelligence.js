const db = require("./db");
const ollama = require("./ollama");
const config = require("./config");

const DAY = 86400;

function stripHtml(html) {
  return (html || "").replace(/<p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}

function dayId(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function dayRange(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return { from: Math.floor(d.getTime() / 1000), to: Math.floor(d.getTime() / 1000) + DAY };
}

function weekId(ts) {
  const d = new Date(ts * 1000);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ── Briefing trigger: range-based ──

function shouldGenerateBriefing() {
  const lastBriefingTs = parseInt(db.getCursor("last_briefing_ts") || "0", 10);
  const now = Math.floor(Date.now() / 1000);

  if (lastBriefingTs === 0) {
    // First briefing ever — generate if we have data
    const sinceDate = db.getCursor("since_date");
    if (!sinceDate) return null;
    const sinceTs = Math.floor(new Date(sinceDate + "T00:00:00Z").getTime() / 1000);
    // Only if at least one briefing hour has passed since start
    const briefingHours = (config.intelligence && config.intelligence.briefingHoursUTC) || [8, 20];
    const hour = new Date().getUTCHours();
    if (!briefingHours.some((h) => hour >= h)) return null;
    return { from: sinceTs, to: now };
  }

  // Check if any briefing hour boundary was crossed since last briefing
  const briefingHours = (config.intelligence && config.intelligence.briefingHoursUTC) || [8, 20];
  const lastDate = new Date(lastBriefingTs * 1000);
  const nowDate = new Date();

  // Walk from last briefing time to now, check if we crossed any trigger hour
  let checkTs = lastBriefingTs;
  while (checkTs < now) {
    const d = new Date(checkTs * 1000);
    for (const h of briefingHours) {
      // Build timestamp for this hour on this day
      const triggerTs = Math.floor(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h)).getTime() / 1000);
      if (triggerTs > lastBriefingTs && triggerTs <= now) {
        return { from: lastBriefingTs, to: now };
      }
    }
    checkTs += DAY;
  }

  return null;
}

function getMissingWeeklyReports() {
  const sinceDate = db.getCursor("since_date");
  if (!sinceDate) return [];

  const delivered = new Set(db.getDeliveredDays("weekly").map((id) => id.replace("weekly-", "")));

  const startTs = Math.floor(new Date(sinceDate + "T00:00:00Z").getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  const currentWeek = weekId(now);

  const missing = [];
  const seen = new Set();
  let ts = startTs;
  while (ts < now) {
    const w = weekId(ts);
    if (w !== currentWeek && !delivered.has(w) && !seen.has(w)) {
      missing.push(w);
      seen.add(w);
    }
    ts += DAY;
  }

  return missing;
}

// ── Briefing ──

async function generateBriefing(range) {
  const { from, to } = range;
  const now = Math.floor(Date.now() / 1000);
  const id = "briefing-" + from + "-" + to;

  const fromLabel = new Date(from * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const toLabel = new Date(to * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const allStories = db.getRelevantStoriesInRange(from, to);

  // Prioritize: relevant first, then adjacent. Within each, by points.
  const relevant = allStories.filter((s) => s.relevance === "relevant");
  const adjacent = allStories.filter((s) => s.relevance === "adjacent");
  const stories = [...relevant, ...adjacent];

  if (stories.length === 0) {
    db.setCursor("last_briefing_ts", to);
    return null;
  }

  const storiesBlock = stories.slice(0, 25).map((s) =>
    `[${s.points} pts, ${s.relevance}] ${s.title}\n  ${s.summary || "(no summary)"}`
  ).join("\n\n");

  const opportunities = db.getOpportunitiesInRange(from, to);
  const oppBlock = opportunities.slice(0, 5).map((o) =>
    `In "${o.title}": ${o.author} (${o.comment_points} pts): ${stripHtml(o.text).slice(0, 200)}`
  ).join("\n\n");

  const rising = db.getRisingStories(
    config.intelligence.rising.windowHours || 6,
    config.intelligence.rising.minGrowth || 20
  ).filter((s) => s.created_at >= from && s.created_at < to);

  const risingBlock = rising.slice(0, 3).map((s) =>
    `[${s.prev_points}\u2192${s.points} pts] ${s.title}`
  ).join("\n");

  const content = await ollama.chat(
    "You write intelligence briefings based on stories from multiple sources (Hacker News, Reddit, Arxiv, GitHub). Be thorough but clear. No bullet markers. Clear sections. Mention the source when referencing a story.",
    `Generate briefing covering ${fromLabel} to ${toLabel}.

Relevant stories (${stories.length}):
${storiesBlock}

${risingBlock ? "Rising:\n" + risingBlock : "No rising stories."}

${oppBlock ? "Engagement opportunities:\n" + oppBlock : "No engagement opportunities found."}

Sections:
**What happened** (5-8 most important stories, ranked by relevance not points, one sentence each. Deduplicate similar stories. Mention source: HN/Reddit/arxiv.)
**Rising** (1-3 gaining momentum, skip if none)
**Worth joining** (0-3 discussions with a specific comment to respond to, skip if none)
**One-liner** (mood/theme in one sentence)`,
    { temperature: 0.3, maxTokens: 2000 }
  );

  if (!content) return null;

  db.saveDelivery(id, "briefing", content);
  db.setCursor("last_briefing_ts", to);
  return { id, content, storyCount: stories.length, stories, fromLabel, toLabel };
}

// ── Weekly Trend ──

async function generateWeeklyTrend(week) {
  const id = "weekly-" + week;
  if (db.getDelivery(id)) return null;

  // Parse week to date range
  const [year, wNum] = week.split("-W").map(Number);
  const jan1 = new Date(year, 0, 1);
  const weekStart = new Date(jan1.getTime() + ((wNum - 1) * 7 - jan1.getDay() + 1) * DAY * 1000);
  const from = Math.floor(weekStart.getTime() / 1000);
  const to = from + 7 * DAY;

  const stories = db.getRelevantStoriesInRange(from, to);
  if (stories.length < 3) {
    db.saveDelivery(id, "weekly", `Too few relevant stories in ${week} (${stories.length}).`);
    return { id, content: `Too few relevant stories in ${week}.`, storyCount: stories.length };
  }

  const storiesBlock = stories.map((s) =>
    `[${s.points} pts, ${dayId(s.created_at)}, tags: ${s.tags}] ${s.title}`
  ).join("\n");

  // People
  const people = db.getTopPeople(10);
  const peopleBlock = people.length > 0
    ? people.slice(0, 5).map((p) => `${p.username}: ${p.relevant_comments} relevant comments, avg ${Math.round(p.avg_points)} pts`).join("\n")
    : "";

  // Show HN competitors
  const showHn = stories.filter((s) => s.type === "show_hn" || (s.tags && s.tags.includes("show-hn-competitor")));
  const showBlock = showHn.map((s) => `[${s.points} pts] ${s.title}`).join("\n");

  const content = await ollama.chat(
    "You write concise weekly trend reports about the AI coding tools ecosystem. Under 250 words. Analytical, specific.",
    `Weekly trend report for ${week}. ${stories.length} relevant stories.

Stories:
${storiesBlock}

${showBlock ? "New tools (Show HN):\n" + showBlock : "No Show HN launches."}
${peopleBlock ? "Active voices:\n" + peopleBlock : ""}

Write:
1. 3-4 themes with post counts and direction (growing/stable/fading vs last week)
2. New tools section if any Show HN
3. One sentence: what to watch next week`,
    { temperature: 0.3, maxTokens: 1000 }
  );

  if (!content) return null;

  db.saveDelivery(id, "weekly", content);
  return { id, content, storyCount: stories.length };
}

// ── Rising Detection ──

function detectRising() {
  const rising = db.getRisingStories(
    config.intelligence.rising.windowHours || 6,
    config.intelligence.rising.minGrowth || 20
  );

  const notified = new Set(
    (db.getCursor("rising_notified") || "").split(",").filter(Boolean).map(Number)
  );

  const fresh = rising.filter((s) => !notified.has(s.id));

  if (fresh.length > 0) {
    const all = [...notified, ...fresh.map((s) => s.id)].slice(-100);
    db.setCursor("rising_notified", all.join(","));
  }

  return fresh;
}

// ── Fresh Opportunity Alerts ──

function detectFreshOpportunities() {
  const opps = db.getFreshOpportunities(6); // last 6 hours

  // Deduplicate: max 1 opportunity per story
  const seenStories = new Set();
  const deduped = opps.filter((o) => {
    if (seenStories.has(o.story_id)) return false;
    seenStories.add(o.story_id);
    return true;
  });

  if (opps.length > 0) {
    db.markOpportunityNotified(opps.map((o) => o.comment_id));
  }
  return deduped;
}

// ── My Thread Replies ──

function checkMyThreadReplies() {
  const threads = db.getWatchedThreads();
  const newReplies = [];

  for (const thread of threads) {
    const replies = db.getNewReplies(thread.comment_id, thread.last_reply_seen);
    if (replies.length > 0) {
      const maxTs = Math.max(...replies.map((r) => r.created_at));
      db.setLastReplySeen(thread.comment_id, maxTs);
      newReplies.push({
        myComment: thread,
        replies,
        storyTitle: thread.story_title,
        hnUrl: `https://news.ycombinator.com/item?id=${thread.comment_id}`,
      });
    }
  }

  return newReplies;
}

// ── GitHub Watch Alerts ──

function checkWatchedRepoChanges() {
  const config = require("./config");
  const watchRepos = (config.github && config.github.watchRepos) || [];
  if (watchRepos.length === 0) return { starChanges: [], newReleases: [] };

  const starChanges = [];
  const rising = db.getGithubRising(24, 5); // 5+ stars in 24h
  for (const r of rising) {
    if (watchRepos.includes(r.full_name)) {
      starChanges.push(r);
    }
  }

  const newReleases = db.getUnnotifiedReleases();
  for (const rel of newReleases) {
    if (watchRepos.includes(rel.full_name)) {
      db.markReleaseNotified(rel.id);
    }
  }

  return {
    starChanges,
    newReleases: newReleases.filter((r) => watchRepos.includes(r.full_name)),
  };
}

// ── Show HN Competitive Check ──

async function checkShowHnCompetitors() {
  const items = db.dequeueBatch("competitive_check", 5);
  const results = [];

  for (const item of items) {
    const story = db.getStory(parseInt(item.target_id, 10));
    if (!story || !story.url) { db.completeWork(item.id); continue; }

    let githubInfo = "";
    if (story.url.includes("github.com")) {
      try {
        // Extract owner/repo from URL
        const match = story.url.match(/github\.com\/([^/]+\/[^/]+)/);
        if (match) {
          const res = await fetch(`https://api.github.com/repos/${match[1]}`, {
            signal: AbortSignal.timeout(5000),
            headers: { "User-Agent": "HNAssistant" },
          });
          if (res.ok) {
            const data = await res.json();
            githubInfo = `Stars: ${data.stargazers_count}, Language: ${data.language}, Last push: ${data.pushed_at}, Forks: ${data.forks_count}`;
          }
        }
      } catch {}
    }

    const analysis = db.getAnalysis(story.id);
    const result = await ollama.chat(
      "You assess whether a new tool is relevant to the user's interests. Be brief. 2-3 sentences. Say whether it's a competitor, potential partner, complementary tool, or irrelevant.",
      `New tool: "${story.title}"\nURL: ${story.url}\nPoints: ${story.points}\n${githubInfo ? "GitHub: " + githubInfo : ""}\n${analysis && analysis.summary ? "Summary: " + analysis.summary : ""}\n\nUser's areas: ${(config.interests || []).slice(0, 3).join("; ")}\n\nIs this relevant? What does it do?`,
      { temperature: 0.3, maxTokens: 200 }
    );

    if (result) {
      const content = `🔍 ${story.title}\n${story.url}\n${story.points} pts${githubInfo ? "\n" + githubInfo : ""}\n\n${result}`;
      db.saveDelivery(`competitive-${story.id}`, "competitive", content);
      results.push({ story, assessment: result, githubInfo });
    }

    db.completeWork(item.id);
  }

  return results;
}

module.exports = {
  shouldGenerateBriefing, generateBriefing,
  getMissingWeeklyReports, generateWeeklyTrend,
  detectRising, detectFreshOpportunities, checkMyThreadReplies, checkWatchedRepoChanges, checkShowHnCompetitors,
};
