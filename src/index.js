const logger = require("./logger");
logger.init();

const db = require("./db");
const ollama = require("./ollama");
const collector = require("./collector");
const githubCollector = require("./github-collector");
const redditCollector = require("./reddit-collector");
const arxivCollector = require("./arxiv-collector");
const analyzer = require("./analyzer");
const githubAnalyzer = require("./github-analyzer");
const comments = require("./comments");
const people = require("./people");
const intelligence = require("./intelligence");
const delivery = require("./delivery");
const config = require("./config");

const POLL_MS = (config.collector.pollSeconds || 60) * 1000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { reset: false, briefing: false, trend: false, once: false, help: false, test: false, status: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reset") result.reset = true;
    if (args[i] === "--briefing") result.briefing = true;
    if (args[i] === "--trend") result.trend = true;
    if (args[i] === "--once") result.once = true;
    if (args[i] === "--help" || args[i] === "-h") result.help = true;
    if (args[i] === "--test") result.test = true;
    if (args[i] === "--status") result.status = true;
  }
  return result;
}

function resolveStartDate() {
  // If DB already has cursors, use those (resume)
  const existing = db.getCursorInt("story");
  if (existing) return null; // Already initialized

  // First run: use config.startDate or today
  const startDate = config.startDate || new Date().toISOString().slice(0, 10);
  return startDate;
}

function dateToTs(s) {
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime())) { console.error(`Bad date: ${s}`); process.exit(1); }
  return Math.floor(d.getTime() / 1000);
}

const LOGO = `
  \x1b[38;5;208m _  _                \x1b[38;5;214m_   _ _     _
 \x1b[38;5;208m| \\| |_____ __ ___  \x1b[38;5;214m| | | (_)___(_) ___ _ _
 \x1b[38;5;208m| .\` / -_) V  V (_-< \x1b[38;5;214m\\ V /| (_-<| |/ _ \\ ' \\
 \x1b[38;5;208m|_|\\_\\___|\_/\_//__/  \x1b[38;5;214m \\_/ |_/__/|_|\\___/_||_|\x1b[0m
`;

function showLogo() {
  console.log(LOGO);
  console.log("  \x1b[2mAI-powered intelligence feed \u2022 HN \u2022 GitHub \u2022 Reddit \u2022 Arxiv\x1b[0m\n");
}

function log(msg) { console.log(`  \x1b[2m${new Date().toLocaleTimeString()}\x1b[0m ${msg}`); }
function logPhase(name) { console.log(`\n  \x1b[1m${name}\x1b[0m`); }
function logDone(msg) { console.log(`  \x1b[32m\u2713\x1b[0m ${msg}`); }
function logWarn(msg) { console.log(`  \x1b[33m!\x1b[0m ${msg}`); }

// ── Phase 1: Collect ──

async function collect() {
  const storyCursor = db.getCursorInt("story") || 0;
  const commentCursor = db.getCursorInt("comment") || 0;

  try {
    const stories = await collector.collectStories(storyCursor, (type, cur, tot, count) => {
      process.stdout.write(`\r  ${type}: ${count} (day ${cur}/${tot})`);
    });
    if (stories > 0) process.stdout.write("\n");

    const cmts = await collector.collectComments(commentCursor, (type, cur, tot, count) => {
      process.stdout.write(`\r  ${type}: ${count} (day ${cur}/${tot})`);
    });
    if (cmts > 0) process.stdout.write("\n");

    const myComments = await collector.collectMyComments();

    const refreshed = await collector.refreshRecentPoints();

    // GitHub
    let github = { discovered: 0, trending: 0, watched: { updated: 0, releases: 0 } };
    const lastGhDiscovery = db.getCursorInt("github_discovery") || 0;
    const ghInterval = (config.github && config.github.pollMinutes || 60) * 60;
    if (Math.floor(Date.now() / 1000) - lastGhDiscovery >= ghInterval) {
      log("  GitHub collecting...");
      github = await githubCollector.collect();
      if (github.discovered > 0 || github.trending > 0) {
        log(`    +${github.discovered} discovered, +${github.trending} trending, ${github.watched.updated} watched, ${github.watched.releases} releases`);
      }
    }

    // Reddit
    let reddit = { posts: 0, comments: 0 };
    try {
      log("  Reddit collecting...");
      reddit = await redditCollector.collect();
      if (reddit.posts > 0) log(`    +${reddit.posts} posts, +${reddit.comments} comments`);
    } catch (err) {
      console.error(`  Reddit error: ${err.message}`);
    }

    // Arxiv
    let arxiv = { papers: 0 };
    try {
      log("  Arxiv collecting...");
      arxiv = await arxivCollector.collect();
      if (arxiv.papers > 0) log(`    +${arxiv.papers} papers`);
    } catch (err) {
      console.error(`  Arxiv error: ${err.message}`);
    }

    return { stories, comments: cmts, myComments, refreshed, github, reddit, arxiv };
  } catch (err) {
    console.error(`  Collect error: ${err.message}`);
    return { stories: 0, comments: 0, myComments: 0, refreshed: 0, github: {}, reddit: {}, arxiv: {} };
  }
}

// ── Phase 2: Analyze ──

async function analyze() {
  if (!ollama.isAvailable()) {
    const ok = await ollama.check();
    if (!ok) { log("Ollama unavailable, skipping analysis"); return {}; }
  }

  try {
    // Drain ALL queues before intelligence runs
    let classified = 0, summarized = 0, commentsDone = 0;
    let batch;

    // Classify all pending
    while ((batch = await analyzer.processClassifyQueue(100)) > 0) {
      classified += batch;
      process.stdout.write(`\r  Classified: ${classified}`);
    }
    if (classified > 0) process.stdout.write("\n");

    // Summarize all pending
    while ((batch = await analyzer.processSummarizeQueue(50)) > 0) {
      summarized += batch;
      process.stdout.write(`\r  Summarized: ${summarized}`);
    }
    if (summarized > 0) process.stdout.write("\n");

    // Analyze comments all pending
    while ((batch = await comments.processCommentQueue(20)) > 0) {
      commentsDone += batch;
    }

    // GitHub repos
    let reposClassified = 0;
    while ((batch = await githubAnalyzer.processClassifyRepoQueue(50)) > 0) {
      reposClassified += batch;
      process.stdout.write(`\r  GitHub repos classified: ${reposClassified}`);
    }
    if (reposClassified > 0) process.stdout.write("\n");

    people.rebuild();
    return { classified, summarized, commentsDone, reposClassified };
  } catch (err) {
    console.error(`  Analyze error: ${err.message}`);
    return {};
  }
}

// ── Phase 3: Intelligence ──

async function runIntelligence() {
  const actions = [];

  try {
    // Rising alerts (realtime)
    const rising = intelligence.detectRising();
    for (const story of rising) {
      log(`📈 Rising: ${story.title.slice(0, 50)} (+${story.point_growth})`);
      await delivery.deliverRising(story);
      actions.push("rising");
      await sleep(200);
    }

    // Opportunity alerts (realtime — fresh comments worth engaging with)
    const opportunities = intelligence.detectFreshOpportunities();
    for (const opp of opportunities.slice(0, 3)) { // Max 3 per cycle
      log(`\ud83d\udca1 Opportunity: ${opp.title.slice(0, 40)} — ${opp.author}`);
      await delivery.deliverOpportunity(opp);
      actions.push("opportunity");
      await sleep(200);
    }

    // Thread replies (realtime)
    const replies = intelligence.checkMyThreadReplies();
    for (const thread of replies) {
      log(`💬 Reply in: ${thread.storyTitle || "?"}`);
      await delivery.deliverThreadReply(thread);
      actions.push("reply");
      await sleep(200);
    }

    // GitHub watch alerts
    const watchChanges = intelligence.checkWatchedRepoChanges();
    for (const repo of watchChanges.starChanges) {
      log(`\u2b50 Stars: ${repo.full_name} +${repo.star_growth}`);
      await delivery.deliverStarChange(repo);
      actions.push("stars");
      await sleep(200);
    }
    for (const rel of watchChanges.newReleases) {
      log(`\ud83d\udce6 Release: ${rel.full_name} ${rel.tag_name}`);
      await delivery.deliverRelease(rel);
      actions.push("release");
      await sleep(200);
    }

    // Show HN competitors
    const competitors = await intelligence.checkShowHnCompetitors();
    for (const c of competitors) {
      log(`🔍 Competitor: ${c.story.title.slice(0, 50)}`);
      await delivery.deliverCompetitive(c.assessment, c.story.id);
      actions.push("competitive");
      await sleep(200);
    }

    // Retrospective daily briefings
    if (ollama.isAvailable()) {
      const missingDays = intelligence.getMissingBriefingDays();
      for (const date of missingDays) {
        log(`📋 Generating briefing for ${date}...`);
        const result = await intelligence.generateDailyBriefing(date);
        if (result) {
          await delivery.deliverDaily(result.id, result.content, result.storyCount, result.stories);
          actions.push(`daily:${date}`);
          await sleep(200);
        }
      }

      // Retrospective weekly trends
      const missingWeeks = intelligence.getMissingWeeklyReports();
      for (const week of missingWeeks) {
        log(`📊 Generating trend for ${week}...`);
        const result = await intelligence.generateWeeklyTrend(week);
        if (result) {
          await delivery.deliverWeekly(result.id, result.content, result.storyCount);
          actions.push(`weekly:${week}`);
          await sleep(200);
        }
      }
    }

    // Flush any unsent deliveries (Telegram was down earlier)
    const flushed = await delivery.flushUnsent();
    if (flushed > 0) actions.push(`flushed:${flushed}`);

  } catch (err) {
    console.error(`  Intelligence error: ${err.message}`);
  }

  return actions;
}

// ── Connectivity test ──

async function runTest() {
  showLogo();
  console.log("  \x1b[1mConnectivity test\x1b[0m\n");
  let ok = true;

  // Ollama
  process.stdout.write("  Ollama (" + config.ollama.model + ")... ");
  const ollamaOk = await ollama.check();
  if (ollamaOk) {
    const testResult = await ollama.chat("Say OK", "test", { maxTokens: 5, timeout: 10000 });
    if (testResult) { console.log("\x1b[32mOK\x1b[0m"); }
    else { console.log("\x1b[33mreachable but model not responding\x1b[0m"); ok = false; }
  } else {
    console.log("\x1b[31mFAILED\x1b[0m — is Ollama running? (ollama serve)");
    ok = false;
  }

  // HN (Algolia)
  process.stdout.write("  Hacker News (Algolia)... ");
  try {
    const res = await fetch("https://hn.algolia.com/api/v1/search?query=test&hitsPerPage=1", { signal: AbortSignal.timeout(10000) });
    if (res.ok) { console.log("\x1b[32mOK\x1b[0m"); }
    else { console.log("\x1b[31mFAILED\x1b[0m (" + res.status + ")"); ok = false; }
  } catch (e) { console.log("\x1b[31mFAILED\x1b[0m — " + e.message); ok = false; }

  // GitHub
  process.stdout.write("  GitHub API... ");
  const ghToken = config.github && config.github.token;
  try {
    const headers = { "User-Agent": "NewsVision/1.0" };
    if (ghToken) headers["Authorization"] = "Bearer " + ghToken;
    const res = await fetch("https://api.github.com/rate_limit", { headers, signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      const remaining = data.resources.search.remaining;
      console.log("\x1b[32mOK\x1b[0m (" + remaining + " search requests remaining" + (ghToken ? ", authenticated" : ", unauthenticated") + ")");
    } else { console.log("\x1b[31mFAILED\x1b[0m (" + res.status + ")"); ok = false; }
  } catch (e) { console.log("\x1b[31mFAILED\x1b[0m — " + e.message); ok = false; }

  // Reddit RSS
  process.stdout.write("  Reddit (RSS)... ");
  try {
    const res = await fetch("https://www.reddit.com/r/programming/hot.rss?limit=1", { headers: { "User-Agent": "NewsVision/1.0" }, signal: AbortSignal.timeout(10000) });
    if (res.ok) { console.log("\x1b[32mOK\x1b[0m"); }
    else { console.log("\x1b[31mFAILED\x1b[0m (" + res.status + ")"); ok = false; }
  } catch (e) { console.log("\x1b[31mFAILED\x1b[0m — " + e.message); ok = false; }

  // Arxiv
  process.stdout.write("  Arxiv API... ");
  try {
    const res = await fetch("http://export.arxiv.org/api/query?search_query=test&max_results=1", { signal: AbortSignal.timeout(10000) });
    if (res.ok) { console.log("\x1b[32mOK\x1b[0m"); }
    else { console.log("\x1b[31mFAILED\x1b[0m (" + res.status + ")"); ok = false; }
  } catch (e) { console.log("\x1b[31mFAILED\x1b[0m — " + e.message); ok = false; }

  // Telegram
  process.stdout.write("  Telegram... ");
  if (config.telegram && config.telegram.botToken) {
    try {
      const res = await fetch("https://api.telegram.org/bot" + config.telegram.botToken + "/getMe", { signal: AbortSignal.timeout(10000) });
      if (res.ok) { const data = await res.json(); console.log("\x1b[32mOK\x1b[0m (bot: @" + data.result.username + ")"); }
      else { console.log("\x1b[31mFAILED\x1b[0m — bad token?"); ok = false; }
    } catch (e) { console.log("\x1b[31mFAILED\x1b[0m — " + e.message); ok = false; }
  } else {
    console.log("\x1b[33mSKIPPED\x1b[0m — no token in secrets.json (file-only delivery)");
  }

  // Config check
  console.log("\n  \x1b[1mConfig\x1b[0m");
  console.log("  Interests: " + (config.interests.length || 0));
  console.log("  Tags: " + (config.tags.length || 0));
  console.log("  HN username: " + (config.hnUsername || "(not set)"));
  console.log("  GitHub topics: " + ((config.github.topics || []).length || 0));
  console.log("  GitHub watch repos: " + ((config.github.watchRepos || []).length || 0));
  console.log("  Reddit subreddits: " + ((config.reddit.subreddits || []).length || 0));
  console.log("  Delivery: " + config.delivery);
  console.log("  Start date: " + (config.startDate || "(today)"));

  console.log("\n  " + (ok ? "\x1b[32mAll systems go.\x1b[0m" : "\x1b[31mSome checks failed. Fix issues above.\x1b[0m"));
  return ok;
}

// ── Status ──

function showStatus() {
  showLogo();
  const s = db.getStats();
  const storyCursor = db.getCursorInt("story");
  const sinceDate = db.getCursor("since_date");
  const lastDaily = db.getCursor("last_daily_digest") || "(none)";

  console.log("  \x1b[1mDatabase\x1b[0m");
  console.log("  Since: " + (sinceDate || "(not started)"));
  console.log("  Last fetch: " + (storyCursor ? new Date(storyCursor * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "(never)"));
  console.log("");
  console.log("  \x1b[1mHacker News\x1b[0m");
  console.log("  Stories: " + s.stories + " | Comments: " + s.comments);
  console.log("  Analyzed: " + s.analyzed + " (" + s.relevant + " relevant, " + s.adjacent + " adjacent)");
  console.log("  Comment insights: " + s.commentAnalysis + " | People: " + s.people);
  console.log("");
  console.log("  \x1b[1mGitHub\x1b[0m");
  console.log("  Repos: " + s.githubRepos + " (" + s.githubRelevant + " relevant+adjacent)");
  console.log("");
  console.log("  \x1b[1mQueue\x1b[0m");
  console.log("  Pending: " + s.pendingWork + " | Unsent deliveries: " + s.unsentDeliveries);
}

// ── Main cycles ──

async function fullCycle() {
  log("Collecting...");
  const collected = await collect();
  if (collected.stories > 0 || collected.comments > 0) {
    log(`  +${collected.stories} stories, +${collected.comments} comments, +${collected.myComments} my comments, ${collected.refreshed} refreshed`);
  }

  log("Analyzing...");
  const analyzed = await analyze();
  if (analyzed.classified || analyzed.summarized || analyzed.reposClassified) {
    log(`  HN: ${analyzed.classified || 0} classified, ${analyzed.summarized || 0} summarized, ${analyzed.commentsDone || 0} comment batches | GitHub: ${analyzed.reposClassified || 0} repos`);
  }

  log("Intelligence...");
  const actions = await runIntelligence();
  if (actions.length > 0) {
    log(`  Actions: ${actions.join(", ")}`);
  }
}

async function liveLoop() {
  log(`Live mode. Poll every ${config.collector.pollSeconds}s. Ctrl+C to stop.\n`);
  while (true) {
    try {
      await fullCycle();
    } catch (err) {
      console.error(`Cycle error: ${err.message}`);
    }
    await sleep(POLL_MS);
  }
}

function printStats() {
  const s = db.getStats();
  console.log(`\nHN: ${s.stories} stories, ${s.comments} comments | Analysis: ${s.analyzed} (${s.relevant} relevant, ${s.adjacent} adjacent)`);
  console.log(`GitHub: ${s.githubRepos} repos (${s.githubRelevant} relevant) | People: ${s.people} | Comments: ${s.commentAnalysis}`);
  console.log(`Queue: ${s.pendingWork} pending | Deliveries: ${s.unsentDeliveries} unsent`);
}

function showHelp() {
  console.log(`
  \x1b[1mNewsVision\x1b[0m — AI-powered intelligence feed

  \x1b[1mUsage:\x1b[0m
    node src/index.js              Start or resume. Collects, analyzes, delivers, then live polls.
    node src/index.js --once       Single cycle: collect, analyze, deliver, then exit.
    node src/index.js --briefing   Force generate today's daily briefing.
    node src/index.js --trend      Force generate this week's trend report.
    node src/index.js --test        Check connectivity to all services.
    node src/index.js --status      Show database stats without running a cycle.
    node src/index.js --reset       Wipe all analysis. Raw data (stories, comments) is kept.
    node src/index.js --help        Show this help.

  \x1b[1mFirst run:\x1b[0m
    Set "startDate" in config.json (e.g. "2026-03-20") to load history.
    If null, starts from today.

  \x1b[1mConfig:\x1b[0m
    config.json        Interests, sources, thresholds, tags (committed to repo)
    secrets.json       Telegram token, GitHub PAT (gitignored, see secrets.example.json)

  \x1b[1mDelivery modes:\x1b[0m (config.json "delivery")
    "both"             Telegram + markdown files in output/
    "telegram"         Telegram only
    "file"             Markdown files only (for testing)

  \x1b[1mData:\x1b[0m
    data/db         SQLite database (all collected data + analysis)
    output/            Generated briefings, alerts, reports as markdown
`);
}

async function main() {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    return;
  }

  if (args.test) {
    await runTest();
    db.close();
    return;
  }

  if (args.status) {
    showStatus();
    db.close();
    return;
  }

  showLogo();

  if (args.reset) {
    logWarn("Resetting all analysis (raw data kept)...");
    db.getDb().exec("DELETE FROM story_analysis; DELETE FROM comment_analysis; DELETE FROM work_queue; DELETE FROM deliveries; DELETE FROM people; DELETE FROM github_repo_analysis;");
    logDone("Reset complete. Run again without --reset.");
    db.close();
    return;
  }

  // Initialize start date if first run
  const startDate = resolveStartDate();
  if (startDate) {
    const ts = dateToTs(startDate);
    db.setCursor("story", ts);
    db.setCursor("comment", ts);
    db.setCursor("since_date", startDate);
    logDone(`First run. Collecting from ${startDate}.`);
  }

  const storyCursor = db.getCursorInt("story");
  if (!storyCursor) {
    logWarn("No start date resolved. Check config.json.");
    db.close();
    return;
  }

  if (args.briefing) {
    const today = new Date().toISOString().slice(0, 10);
    log(`Generating briefing for ${today}...`);
    const result = await intelligence.generateDailyBriefing(today);
    if (result) await delivery.deliverDaily(result.id, result.content, result.storyCount, result.stories);
    printStats();
    db.close();
    return;
  }

  if (args.trend) {
    const week = intelligence.getMissingWeeklyReports()[0];
    if (week) {
      log(`Generating trend for ${week}...`);
      const result = await intelligence.generateWeeklyTrend(week);
      if (result) await delivery.deliverWeekly(result.id, result.content, result.storyCount);
    } else {
      logWarn("No missing weekly reports to generate.");
    }
    printStats();
    db.close();
    return;
  }

  // Normal run
  const sinceDate = new Date(storyCursor * 1000).toISOString().slice(0, 10);
  log(`Resuming from ${sinceDate}`);

  logPhase("Cycle");
  await fullCycle();
  printStats();

  if (args.once) {
    logDone("Single cycle complete.");
    db.close();
    return;
  }

  await liveLoop();
}

process.on("SIGINT", () => {
  console.log("\n  Shutting down...");
  printStats();
  db.close();
  logger.close();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  db.close();
  logger.close();
  process.exit(1);
});
