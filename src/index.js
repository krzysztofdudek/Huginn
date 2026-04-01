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
  const result = { reset: false, briefing: false, trend: false, once: false, help: false, test: false, status: false, backfill: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reset") result.reset = true;
    if (args[i] === "--briefing") result.briefing = true;
    if (args[i] === "--trend") result.trend = true;
    if (args[i] === "--once") result.once = true;
    if (args[i] === "--help" || args[i] === "-h") result.help = true;
    if (args[i] === "--test") result.test = true;
    if (args[i] === "--status") result.status = true;
    if (args[i] === "--backfill" && args[i + 1]) { result.backfill = args[i + 1]; i++; }
  }
  return result;
}

function resolveStartDate() {
  // If DB already has cursors, use those (resume)
  const existing = db.getCursorInt("story");
  if (existing) return null; // Already initialized

  // First run: use config.startDate or right now
  if (config.startDate) return config.startDate;

  // null startDate = start from now (not beginning of day)
  // This way new users don't wait hours for a day to finish before getting a briefing
  return "now";
}

function dateToTs(s) {
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime())) { console.error(`Bad date: ${s}`); process.exit(1); }
  return Math.floor(d.getTime() / 1000);
}

function showLogo() {
  const o = "\x1b[38;5;208m";
  const r = "\x1b[0m";
  const d = "\x1b[2m";

  console.log("");
  console.log(o + "  \u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2588\u2588\u2588\u2588\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2593\u2592\u2591" + r);
  console.log(o + "  \u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591" + r);
  console.log(o + "  \u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591      \u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591" + r);
  console.log(o + "  \u2591\u2592\u2593\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2592\u2593\u2588\u2588\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591" + r);
  console.log(o + "  \u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591" + r);
  console.log(o + "  \u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591" + r);
  console.log(o + "  \u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2588\u2588\u2588\u2588\u2588\u2593\u2592\u2591 \u2591\u2592\u2593\u2588\u2588\u2588\u2588\u2588\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2592\u2593\u2588\u2593\u2592\u2591\u2591\u2592\u2593\u2588\u2593\u2592\u2591" + r);
  console.log("");
  console.log("  " + d + "Odin's raven sees everything \u2022 HN \u2022 GitHub \u2022 Reddit \u2022 Arxiv" + r);
  console.log("");
}

function log(msg) { console.log(`  \x1b[2m${new Date().toLocaleTimeString()}\x1b[0m ${msg}`); }
function logPhase(name) { console.log(`\n  \x1b[1m${name}\x1b[0m`); }
function logDone(msg) { console.log(`  \x1b[32m\u2713\x1b[0m ${msg}`); }
function logWarn(msg) { console.log(`  \x1b[33m!\x1b[0m ${msg}`); }

const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
let spinnerFrame = 0;
let spinnerInterval = null;
let spinnerText = "";

function spinnerStart(text) {
  spinnerText = text;
  spinnerFrame = 0;
  if (spinnerInterval) clearInterval(spinnerInterval);
  process.stdout.write(`  ${SPINNER[0]} ${text}`);
  spinnerInterval = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
    process.stdout.write(`\r  ${SPINNER[spinnerFrame]} ${spinnerText}`);
  }, 80);
}

function spinnerUpdate(text) {
  spinnerText = text;
}

function spinnerStop(doneText) {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
  process.stdout.write(`\r  \x1b[32m\u2713\x1b[0m ${doneText}\x1b[K\n`);
}

// ── Phase 1: Collect ──

async function collect() {
  const storyCursor = db.getCursorInt("story") || 0;
  const commentCursor = db.getCursorInt("comment") || 0;

  try {
    // HN Stories
    // HN Stories
    spinnerStart("HN: fetching stories...");
    const stories = await collector.collectStories(storyCursor, (_t, cur, tot, count) => {
      spinnerUpdate(`HN: ${count} stories (day ${cur}/${tot})`);
    });
    if (stories > 0) { spinnerStop(`HN: ${stories} stories`); }
    else { spinnerStop("HN: stories up to date"); }

    // HN Comments
    spinnerStart("HN: fetching comments...");
    const cmts = await collector.collectComments(commentCursor, (_t, cur, tot, count) => {
      spinnerUpdate(`HN: ${count} comments (day ${cur}/${tot})`);
    });
    if (cmts > 0) { spinnerStop(`HN: ${cmts} comments`); }
    else { spinnerStop("HN: comments up to date"); }

    // HN extras
    const myComments = await collector.collectMyComments();
    if (myComments > 0) logDone(`HN: ${myComments} of your comments found`);

    spinnerStart("HN: updating points on tracked stories...");
    const refresh = await collector.refreshRecentPoints();
    spinnerStop(`HN: ${refresh.matched} stories updated` + (refresh.newlyQualified > 0 ? `, ${refresh.newlyQualified} new qualifying` : ""));

    // GitHub
    const lastGhDiscovery = db.getCursorInt("github_discovery") || 0;
    const ghInterval = (config.github && config.github.pollMinutes || 60) * 60;
    if (Math.floor(Date.now() / 1000) - lastGhDiscovery >= ghInterval) {
      spinnerStart("GitHub: searching repos...");
      const github = await githubCollector.collect();
      const ghParts = [];
      if (github.discovered > 0) ghParts.push(`${github.discovered} discovered`);
      if (github.trending > 0) ghParts.push(`${github.trending} trending`);
      if (github.watched.updated > 0) ghParts.push(`${github.watched.updated} watched`);
      if (github.watched.releases > 0) ghParts.push(`${github.watched.releases} releases`);
      spinnerStop(`GitHub: ${ghParts.length > 0 ? ghParts.join(", ") : "up to date"}`);
    }

    // Reddit
    try {
      spinnerStart("Reddit: fetching posts...");
      const reddit = await redditCollector.collect();
      spinnerStop(`Reddit: ${reddit.posts > 0 ? reddit.posts + " posts" : "up to date"}`);
    } catch (err) { spinnerStop("Reddit: error"); logWarn(`Reddit: ${err.message}`); }

    // Arxiv
    try {
      spinnerStart("Arxiv: fetching papers...");
      const arxiv = await arxivCollector.collect();
      spinnerStop(`Arxiv: ${arxiv.papers > 0 ? arxiv.papers + " papers" : "up to date"}`);
    } catch (err) { spinnerStop("Arxiv: error"); logWarn(`Arxiv: ${err.message}`); }

  } catch (err) {
    logWarn(`Collect error: ${err.message}`);
  }
}

// ── Phase 2: Analyze ──

async function analyze() {
  if (!ollama.isAvailable()) {
    const ok = await ollama.check();
    if (!ok) { logWarn("Ollama unavailable. Analysis queued for later."); return; }
  }

  try {
    let batch;

    // Classify stories (batch of 10 for frequent spinner updates)
    let classifyTotal = db.pendingCount("classify");
    let classified = 0;
    spinnerStart(classifyTotal > 0 ? `Classifying stories... 0/${classifyTotal}` : "Classification up to date");
    while ((batch = await analyzer.processClassifyQueue(10)) > 0) {
      classified += batch;
      spinnerUpdate(`Classifying stories... ${classified}/${classifyTotal}`);
    }
    spinnerStop(classified > 0 ? `${classified} stories classified` : "Classification up to date");

    // Summarize (batch of 5 — each takes ~5s)
    let summarizeTotal = db.pendingCount("summarize");
    let summarized = 0;
    spinnerStart(summarizeTotal > 0 ? `Summarizing articles... 0/${summarizeTotal}` : "Summaries up to date");
    while ((batch = await analyzer.processSummarizeQueue(5)) > 0) {
      summarized += batch;
      spinnerUpdate(`Summarizing articles... ${summarized}/${summarizeTotal}`);
    }
    spinnerStop(summarized > 0 ? `${summarized} articles summarized` : "Summaries up to date");

    // Comments (batch of 3 — each takes ~3s)
    let commentsTotal = db.pendingCount("analyze_comments");
    let commentsDone = 0;
    spinnerStart(commentsTotal > 0 ? `Analyzing comments... 0/${commentsTotal} stories` : "Comments up to date");
    while ((batch = await comments.processCommentQueue(3)) > 0) {
      commentsDone += batch;
      spinnerUpdate(`Analyzing comments... ${commentsDone}/${commentsTotal} stories`);
    }
    spinnerStop(commentsDone > 0 ? `${commentsDone} story comment batches analyzed` : "Comments up to date");

    // GitHub repos (batch of 10)
    let reposTotal = db.pendingCount("classify_repo");
    let reposClassified = 0;
    spinnerStart(reposTotal > 0 ? `Classifying GitHub repos... 0/${reposTotal}` : "Repos up to date");
    while ((batch = await githubAnalyzer.processClassifyRepoQueue(10)) > 0) {
      reposClassified += batch;
      spinnerUpdate(`Classifying GitHub repos... ${reposClassified}/${reposTotal}`);
    }
    spinnerStop(reposClassified > 0 ? `${reposClassified} repos classified` : "Repos up to date");

    people.rebuild();

  } catch (err) {
    logWarn(`Analyze error: ${err.message}`);
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

    // Briefing (range-based, triggered by configured hours)
    if (ollama.isAvailable()) {
      const range = intelligence.shouldGenerateBriefing();
      if (range) {
        log(`\ud83d\udccb Generating briefing for ${new Date(range.from * 1000).toISOString().slice(0, 16)} \u2192 ${new Date(range.to * 1000).toISOString().slice(0, 16)}...`);
        const result = await intelligence.generateBriefing(range);
        if (result) {
          await delivery.deliverBriefing(result.id, result.content, result.storyCount, result.stories, result.fromLabel, result.toLabel);
          actions.push("briefing");
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
    const headers = { "User-Agent": "Huginn/1.0" };
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
    const res = await fetch("https://www.reddit.com/r/programming/hot.rss?limit=1", { headers: { "User-Agent": "Huginn/1.0" }, signal: AbortSignal.timeout(10000) });
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
  const lastBriefing = db.getCursor("last_briefing_ts");

  console.log("  \x1b[1mDatabase\x1b[0m");
  console.log("  Since: " + (sinceDate || "(not started)"));
  console.log("  Last fetch: " + (storyCursor ? new Date(storyCursor * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "(never)"));
  console.log("  Last briefing: " + (lastBriefing ? new Date(parseInt(lastBriefing) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "(never)"));
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
  logPhase("Collecting");
  await collect();

  logPhase("Analyzing");
  await analyze();

  logPhase("Intelligence");
  const actions = await runIntelligence();
  if (actions.length === 0) log("Nothing to deliver.");
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
  \x1b[1mHuginn\x1b[0m

  Monitors Hacker News, GitHub, Reddit, and Arxiv for topics you care about.
  Sends you a daily summary on Telegram with links to everything relevant.
  Alerts you in real-time when something important happens.

  \x1b[1mCommands:\x1b[0m

    node src/index.js                        Start collecting and analyzing. Runs continuously.
    node src/index.js --once                 Do one full round of work, then stop.
    node src/index.js --test                 Check if Ollama, Telegram, and all sources are reachable.
    node src/index.js --status               Show what's in the database without doing any work.
    node src/index.js --briefing             Make today's daily summary right now.
    node src/index.js --trend                Make this week's trend report right now.
    node src/index.js --backfill 2026-03-20  Go back in time and collect older posts you missed.
    node src/index.js --reset                Start analysis over. Keeps all downloaded data.
    node src/index.js --help                 Show this message.

  \x1b[1mGetting started:\x1b[0m

    1. Copy config.example.json to config.json and edit your interests
    2. Copy secrets.example.json to secrets.json and add your Telegram token
    3. Run --test to make sure everything connects
    4. Run the app

  \x1b[1mFiles:\x1b[0m

    config.json        What topics to follow, which sources to use, how to deliver
    secrets.json       Your Telegram and GitHub tokens (private, not shared)
    data/db            Everything the app has collected and analyzed
    data/huginn.log  What the app did and when
    output/            Daily summaries and alerts saved as readable files
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

  // Backfill: move cursor back to a specific date
  if (args.backfill) {
    const ts = dateToTs(args.backfill);
    const currentStory = db.getCursorInt("story");
    if (currentStory && ts >= currentStory) {
      logWarn(`Cursor is already at or before ${args.backfill}. Nothing to backfill.`);
    } else {
      db.setCursor("story", ts);
      db.setCursor("comment", ts);
      if (!db.getCursor("since_date") || ts < dateToTs(db.getCursor("since_date"))) {
        db.setCursor("since_date", args.backfill);
      }
      logDone(`Cursor moved back to ${args.backfill}. Will collect from there on next cycle.`);
    }
  }

  // Initialize start date if first run
  const startDate = resolveStartDate();
  if (startDate) {
    const ts = startDate === "now" ? Math.floor(Date.now() / 1000) : dateToTs(startDate);
    const label = startDate === "now" ? "now" : startDate;
    db.setCursor("story", ts);
    db.setCursor("comment", ts);
    db.setCursor("since_date", label);
    db.setCursor("last_briefing_ts", ts);
    logDone(`First run. Collecting from ${label}.`);
  }

  const storyCursor = db.getCursorInt("story");
  if (!storyCursor) {
    logWarn("No start date resolved. Check config.json.");
    db.close();
    return;
  }

  if (args.briefing) {
    const lastTs = parseInt(db.getCursor("last_briefing_ts") || "0", 10);
    const now = Math.floor(Date.now() / 1000);
    const from = lastTs || (now - 86400); // Default: last 24h
    log(`Generating briefing...`);
    const result = await intelligence.generateBriefing({ from, to: now });
    if (result) await delivery.deliverBriefing(result.id, result.content, result.storyCount, result.stories, result.fromLabel, result.toLabel);
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
