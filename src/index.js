const log = require("./logger");
log.init();

const db = require("./db");
const { getConnector, check: connectorCheck, isAvailable, listConnectors } = require("./connectors");
const collector = require("./collector");
const githubCollector = require("./github-collector");
const redditCollector = require("./reddit-collector");
const arxivCollector = require("./arxiv-collector");
const analyzer = require("./analyzer");
const githubAnalyzer = require("./github-analyzer");
const comments = require("./comments");
const people = require("./people");
const intelligence = require("./intelligence");
const telegramBot = require("./telegram-bot");
const hnDeep = require("./hn-deep-fetch");
const delivery = require("./delivery");
const insights = require("./insights");
const config = require("./config");

const POLL_MS = (config.collector.pollSeconds || 60) * 1000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { reset: false, briefing: false, trend: false, once: false, help: false, test: false, status: false, backfill: null, testInsights: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reset") result.reset = true;
    if (args[i] === "--briefing") result.briefing = true;
    if (args[i] === "--trend") result.trend = true;
    if (args[i] === "--once") result.once = true;
    if (args[i] === "--help" || args[i] === "-h") result.help = true;
    if (args[i] === "--test") result.test = true;
    if (args[i] === "--status") result.status = true;
    if (args[i] === "--backfill" && args[i + 1]) { result.backfill = args[i + 1]; i++; }
    if (args[i] === "--test-insights") result.testInsights = true;
  }
  return result;
}

function resolveStartDate() {
  const existing = db.getCursorInt("story");
  if (existing) return null;
  if (config.startDate) return config.startDate;
  return "now";
}

function dateToTs(s) {
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime())) { log.error(`Bad date: ${s}`); process.exit(1); }
  return Math.floor(d.getTime() / 1000);
}

function showLogo() {
  const o = log.c.orange;
  const r = log.c.reset;
  const d = log.c.dim;

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

// ── Phase 1: Collect ──

async function collect() {
  const storyCursor = db.getCursorInt("story") || 0;

  try {
    // HN Stories (Algolia)
    const hnSpin = log.spinner("HN: fetching stories...");
    const stories = await collector.collectStories(storyCursor, (_t, cur, tot, count) => {
      hnSpin.update(`HN: ${log.formatNumber(count)} stories (day ${cur}/${tot})`);
    });
    if (stories > 0) { hnSpin.done(`HN: ${log.formatNumber(stories)} stories fetched`); }
    else { hnSpin.done("HN: stories up to date"); }

    // HN extras
    const myComments = await collector.collectMyComments();
    if (myComments > 0) log.success(`HN: ${myComments} of your comments found`);

    const pointSpin = log.spinner("HN: updating points on tracked stories...");
    const refresh = await collector.refreshRecentPoints();
    const refreshParts = [`${log.formatNumber(refresh.matched)} stories updated`];
    if (refresh.newlyQualified > 0) refreshParts.push(`${refresh.newlyQualified} new qualifying`);
    if (refresh.snapshotted > 0) refreshParts.push(`${refresh.snapshotted} snapshots`);
    pointSpin.done(`HN: ${refreshParts.join(", ")}`);

    // GitHub
    const lastGhDiscovery = db.getCursorInt("github_discovery") || 0;
    const ghInterval = (config.github && config.github.pollMinutes || 60) * 60;
    if (Math.floor(Date.now() / 1000) - lastGhDiscovery >= ghInterval) {
      const ghSpin = log.spinner("GitHub: searching repos...");
      const github = await githubCollector.collect();
      const ghParts = [];
      if (github.discovered > 0) ghParts.push(`${github.discovered} discovered`);
      if (github.trending > 0) ghParts.push(`${github.trending} trending`);
      if (github.watched.updated > 0) ghParts.push(`${github.watched.updated} watched`);
      if (github.watched.releases > 0) ghParts.push(`${github.watched.releases} releases`);
      ghSpin.done(`GitHub: ${ghParts.length > 0 ? ghParts.join(", ") : "up to date"}`);
    }

    // Reddit
    try {
      const redditSpin = log.spinner("Reddit: fetching posts...");
      const reddit = await redditCollector.collect();
      redditSpin.done(`Reddit: ${reddit.posts > 0 ? reddit.posts + " posts" : "up to date"}`);
    } catch (err) {
      log.error(`Reddit: ${err.message}`);
    }

    // Arxiv
    try {
      const arxivSpin = log.spinner("Arxiv: fetching papers...");
      const arxiv = await arxivCollector.collect();
      arxivSpin.done(`Arxiv: ${arxiv.papers > 0 ? arxiv.papers + " papers" : "up to date"}`);
    } catch (err) {
      log.error(`Arxiv: ${err.message}`);
    }

  } catch (err) {
    log.error(`Collect failed: ${err.message}`);
  }
}

// ── Phase 2: Analyze ──

async function analyze() {
  if (!isAvailable()) {
    const ok = await connectorCheck();
    if (!ok) { log.warn("Ollama unavailable \u2014 analysis queued for later"); return; }
  }

  try {
    let batch;

    // Classify stories
    let classifyTotal = db.pendingCount("classify");
    let classified = 0;
    const classifySpin = log.spinner(classifyTotal > 0 ? `Classifying stories... 0/${classifyTotal}` : "Classification up to date");
    while ((batch = await analyzer.processClassifyQueue(10)) > 0) {
      classified += batch;
      classifySpin.update(`Classifying stories... ${classified}/${classifyTotal}`);
    }
    classifySpin.done(classified > 0 ? `${classified} stories classified` : "Classification up to date");

    // Summarize
    let summarizeTotal = db.pendingCount("summarize");
    let summarized = 0;
    const sumSpin = log.spinner(summarizeTotal > 0 ? `Summarizing articles... 0/${summarizeTotal}` : "Summaries up to date");
    while ((batch = await analyzer.processSummarizeQueue(5)) > 0) {
      summarized += batch;
      sumSpin.update(`Summarizing articles... ${summarized}/${summarizeTotal}`);
    }
    sumSpin.done(summarized > 0 ? `${summarized} articles summarized` : "Summaries up to date");

    // Deep fetch: HN comments
    if (config.liveComments !== false) {
      const deepSpin = log.spinner("HN comments: checking relevant stories...");
      const deep = await hnDeep.deepFetchRelevantStories((p) => {
        deepSpin.update(`HN comments: ${p.story.slice(0, 35)}... (${p.fetched} fetched, ${p.comments} comments, ${p.newComments} new)`);
      });

      if (deep.fetched > 0) {
        deepSpin.done(`HN comments: ${deep.fetched} stories, ${log.formatNumber(deep.comments)} comments, ${deep.newComments.length} new`);
      } else {
        deepSpin.done("HN comments: up to date");
      }

      // Analyze new comments
      if (deep.newComments && deep.newComments.length > 0) {
        const convSpin = log.spinner(`Analyzing ${deep.newComments.length} new comments for conversations...`);
        const opportunities = await comments.analyzeNewComments(deep.newComments);

        if (opportunities.length > 0) {
          convSpin.done(`${opportunities.length} conversation(s) worth joining`);
          for (const opp of opportunities) {
            log.info(`  \ud83d\udca1 ${opp.story_title.slice(0, 40)} \u2014 ${opp.author}: ${opp.reason.slice(0, 60)}`);
            await delivery.deliverOpportunity(opp);
            await sleep(200);
          }
        } else {
          convSpin.done("No new conversations to join");
        }
      }
    }

    // GitHub repos
    let reposTotal = db.pendingCount("classify_repo");
    let reposClassified = 0;
    const repoSpin = log.spinner(reposTotal > 0 ? `Classifying GitHub repos... 0/${reposTotal}` : "Repos up to date");
    while ((batch = await githubAnalyzer.processClassifyRepoQueue(10)) > 0) {
      reposClassified += batch;
      repoSpin.update(`Classifying GitHub repos... ${reposClassified}/${reposTotal}`);
    }
    repoSpin.done(reposClassified > 0 ? `${reposClassified} repos classified` : "Repos up to date");

    people.rebuild();

  } catch (err) {
    log.error(`Analyze failed: ${err.message}`);
  }
}

// ── Phase 3: Intelligence ──

async function runIntelligence() {
  const actions = [];

  try {
    // Rising alerts
    const rising = intelligence.detectRising();
    for (const story of rising) {
      log.info(`\ud83d\udcc8 Rising: ${story.title.slice(0, 50)} (+${story.point_growth} pts)`);
      await delivery.deliverRising(story);
      actions.push("rising");
      await sleep(200);
    }

    // Thread replies
    const replies = intelligence.checkMyThreadReplies();
    for (const thread of replies) {
      log.info(`\ud83d\udcac Reply in: ${thread.storyTitle || "?"}`);
      await delivery.deliverThreadReply(thread);
      actions.push("reply");
      await sleep(200);
    }

    // GitHub watch alerts
    const watchChanges = intelligence.checkWatchedRepoChanges();
    for (const repo of watchChanges.starChanges) {
      log.info(`\u2b50 Stars: ${repo.full_name} +${repo.star_growth}`);
      await delivery.deliverStarChange(repo);
      actions.push("stars");
      await sleep(200);
    }
    for (const rel of watchChanges.newReleases) {
      log.info(`\ud83d\udce6 Release: ${rel.full_name} ${rel.tag_name}`);
      await delivery.deliverRelease(rel);
      actions.push("release");
      await sleep(200);
    }

    // Show HN competitors
    const competitors = await intelligence.checkShowHnCompetitors();
    for (const comp of competitors) {
      log.info(`\ud83d\udd0d Competitor: ${comp.story.title.slice(0, 50)}`);
      await delivery.deliverCompetitive(comp.assessment, comp.story.id);
      actions.push("competitive");
      await sleep(200);
    }

    // Briefing
    if (isAvailable()) {
      const briefingRanges = intelligence.getMissingBriefings();
      for (const range of briefingRanges) {
        const from = new Date(range.from * 1000).toISOString().slice(0, 16);
        const to = new Date(range.to * 1000).toISOString().slice(0, 16);
        const briefSpin = log.spinner(`Generating briefing ${from} \u2192 ${to}...`);
        const result = await intelligence.generateBriefing(range);
        if (result) {
          briefSpin.done(`Briefing ready \u2014 ${result.storyCount} stories`);
          await delivery.deliverBriefing(result.id, result.content, result.storyCount, result.stories, result.fromLabel, result.toLabel);
          actions.push("briefing");
          await sleep(200);
        } else {
          briefSpin.warn("Briefing generation returned empty");
        }
      }

      // Weekly trends
      const missingWeeks = intelligence.getMissingWeeklyReports();
      for (const week of missingWeeks) {
        const trendSpin = log.spinner(`Generating trend for ${week}...`);
        const result = await intelligence.generateWeeklyTrend(week);
        if (result) {
          trendSpin.done(`Trend ${week} ready \u2014 ${result.storyCount} stories`);
          await delivery.deliverWeekly(result.id, result.content, result.storyCount);
          actions.push(`weekly:${week}`);
          await sleep(200);
        } else {
          trendSpin.warn(`Trend ${week} \u2014 skipped (already exists or no data)`);
        }
      }
    }

    // Flush unsent
    const flushResult = await delivery.flushUnsent();
    if (flushResult.sent > 0) log.info(`\ud83d\udce8 Flushed ${flushResult.sent} queued message(s) to Telegram`);
    if (flushResult.held > 0) log.dim(`  \ud83c\udf19 ${flushResult.held} message(s) held \u2014 quiet hours active`);
    if (flushResult.failed > 0) log.warn(`${flushResult.failed} message(s) failed to send`);

  } catch (err) {
    log.error(`Intelligence failed: ${err.message}`);
  }

  return actions;
}

// ── Connectivity test ──

async function runTest() {
  showLogo();
  log.heading("Connectivity test");
  console.log("");
  let ok = true;

  // Ollama
  const conn = getConnector();
  const ollamaProbe = log.probe(`Ollama (${conn.name} / ${conn.ollamaModel})`);
  const ollamaOk = await connectorCheck();
  if (ollamaOk) {
    const testResult = await conn.chat("Say OK", "test", { maxTokens: 50, timeout: 30000 });
    if (testResult) { ollamaProbe.ok("model responding"); }
    else { ollamaProbe.fail("reachable but model not responding"); ok = false; }
  } else {
    ollamaProbe.fail("is Ollama running? (ollama serve)");
    ok = false;
  }

  // HN
  const hnProbe = log.probe("Hacker News (Algolia)");
  try {
    const res = await fetch("https://hn.algolia.com/api/v1/search?query=test&hitsPerPage=1", { signal: AbortSignal.timeout(10000) });
    if (res.ok) { hnProbe.ok(); } else { hnProbe.fail(`HTTP ${res.status}`); ok = false; }
  } catch (e) { hnProbe.fail(e.message); ok = false; }

  // GitHub
  const ghToken = config.github && config.github.token;
  const ghProbe = log.probe("GitHub API");
  try {
    const headers = { "User-Agent": "Huginn/1.0" };
    if (ghToken) headers["Authorization"] = "Bearer " + ghToken;
    const res = await fetch("https://api.github.com/rate_limit", { headers, signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      const remaining = data.resources.search.remaining;
      ghProbe.ok(`${remaining} search requests, ${ghToken ? "authenticated" : "unauthenticated"}`);
    } else { ghProbe.fail(`HTTP ${res.status}`); ok = false; }
  } catch (e) { ghProbe.fail(e.message); ok = false; }

  // Reddit
  const redditProbe = log.probe("Reddit (RSS)");
  try {
    const res = await fetch("https://www.reddit.com/r/programming/hot.rss?limit=1", { headers: { "User-Agent": "Huginn/1.0" }, signal: AbortSignal.timeout(10000) });
    if (res.ok) { redditProbe.ok(); } else { redditProbe.fail(`HTTP ${res.status}`); ok = false; }
  } catch (e) { redditProbe.fail(e.message); ok = false; }

  // Arxiv
  const arxivProbe = log.probe("Arxiv API");
  try {
    const res = await fetch("http://export.arxiv.org/api/query?search_query=test&max_results=1", { signal: AbortSignal.timeout(10000) });
    if (res.ok) { arxivProbe.ok(); } else { arxivProbe.fail(`HTTP ${res.status}`); ok = false; }
  } catch (e) { arxivProbe.fail(e.message); ok = false; }

  // Telegram
  const tgProbe = log.probe("Telegram");
  if (config.telegram && config.telegram.botToken) {
    try {
      const res = await fetch("https://api.telegram.org/bot" + config.telegram.botToken + "/getMe", { signal: AbortSignal.timeout(10000) });
      if (res.ok) { const data = await res.json(); tgProbe.ok(`bot: @${data.result.username}`); }
      else { tgProbe.fail("bad token?"); ok = false; }
    } catch (e) { tgProbe.fail(e.message); ok = false; }
  } else {
    tgProbe.skip("no token in secrets.json \u2014 file-only delivery");
  }

  // Config
  log.heading("Config");
  log.kvLine("Interests", config.interests.length || 0);
  log.kvLine("Tags", config.tags.length || 0);
  log.kvLine("HN username", config.hnUsername || "(not set)");
  log.kvLine("GitHub topics", (config.github.topics || []).length || 0);
  log.kvLine("GitHub watch", (config.github.watchRepos || []).length || 0);
  log.kvLine("Reddit subs", (config.reddit.subreddits || []).length || 0);
  log.kvLine("Delivery", config.delivery);
  log.kvLine("Start date", config.startDate || "(today)");
  log.kvLine("Connector", getConnector().name);

  console.log("\n  " + (ok
    ? `${log.c.green}All systems go.${log.c.reset}`
    : `${log.c.red}Some checks failed. Fix issues above.${log.c.reset}`));
  return ok;
}

// ── Status ──

function showStatus() {
  showLogo();
  const s = db.getStats();
  const storyCursor = db.getCursorInt("story");
  const sinceDate = db.getCursor("since_date");
  const lastBriefing = db.getCursor("last_briefing_ts");

  log.heading("Database");
  log.kvLine("Since", sinceDate || "(not started)");
  log.kvLine("Last fetch", storyCursor ? new Date(storyCursor * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "(never)");
  log.kvLine("Last briefing", lastBriefing ? new Date(parseInt(lastBriefing) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "(never)");

  log.heading("Hacker News");
  log.kvLine("Stories", `${log.formatNumber(s.stories)} | Comments: ${log.formatNumber(s.comments)}`);
  log.kvLine("Analyzed", `${log.formatNumber(s.analyzed)} (${s.relevant} relevant, ${s.adjacent} adjacent)`);
  log.kvLine("Insights", `${s.commentAnalysis} | People: ${s.people}`);

  log.heading("GitHub");
  log.kvLine("Repos", `${s.githubRepos} (${s.githubRelevant} relevant+adjacent)`);

  log.heading("Queue");
  log.kvLine("Pending", `${s.pendingWork} | Unsent deliveries: ${s.unsentDeliveries}`);

  const insightsConfig = config.insights || {};
  if (insightsConfig.enabled) {
    log.heading("Insights");
    const d = db.getDb();
    const runStats = d.prepare("SELECT status, COUNT(*) as c FROM analysis_runs GROUP BY status").all();
    const statMap = {};
    for (const row of runStats) statMap[row.status] = row.c;
    log.kvLine("Runs", `${statMap.done || 0} done, ${statMap.failed || 0} failed, ${statMap.running || 0} running`);
    const enabledPlugins = insights.getEnabledPlugins();
    for (const plugin of enabledPlugins) {
      const last = db.getLastAnalysisRun(plugin.id);
      const lastStr = last && last.completed_at
        ? new Date(last.completed_at * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC"
        : "(never)";
      log.kvLine(plugin.name, lastStr);
    }
  }
}

// ── Main cycles ──

async function fullCycle() {
  log.phase("Collecting");
  await collect();

  log.phase("Analyzing");
  await analyze();

  log.phase("Intelligence");
  const actions = await runIntelligence();
  if (actions.length === 0) log.dim("Nothing to deliver.");

  log.phase("Insights");
  await insights.runDue();
}

async function liveLoop() {
  telegramBot.startPolling();
  log.info(`\ud83d\udd04 Live mode \u2014 polling every ${config.collector.pollSeconds}s. Bot commands active. Ctrl+C to stop.\n`);
  while (true) {
    try {
      await telegramBot.processUpdates();
      await fullCycle();
    } catch (err) {
      log.error(`Cycle error: ${err.message}`);
    }
    const pollEnd = Date.now() + POLL_MS;
    while (Date.now() < pollEnd) {
      await sleep(3000);
      try { await telegramBot.processUpdates(); } catch {}
    }
  }
}

function printStats() {
  const s = db.getStats();
  console.log("");
  log.dim(`HN: ${log.formatNumber(s.stories)} stories, ${log.formatNumber(s.comments)} comments | Analysis: ${log.formatNumber(s.analyzed)} (${s.relevant} relevant, ${s.adjacent} adjacent)`);
  log.dim(`GitHub: ${s.githubRepos} repos (${s.githubRelevant} relevant) | People: ${s.people} | Comments: ${s.commentAnalysis}`);
  log.dim(`Queue: ${s.pendingWork} pending | Deliveries: ${s.unsentDeliveries} unsent`);
}

function showHelp() {
  const b = log.c.bold;
  const r = log.c.reset;
  console.log(`
  ${b}Huginn${r}

  Monitors Hacker News, GitHub, Reddit, and Arxiv for topics you care about.
  Sends you a daily summary on Telegram with links to everything relevant.
  Alerts you in real-time when something important happens.

  ${b}Commands:${r}

    node src/index.js                        Start collecting and analyzing. Runs continuously.
    node src/index.js --once                 Do one full round of work, then stop.
    node src/index.js --test                 Check if Ollama, Telegram, and all sources are reachable.
    node src/index.js --status               Show what's in the database without doing any work.
    node src/index.js --briefing             Make today's daily summary right now.
    node src/index.js --trend                Make this week's trend report right now.
    node src/index.js --backfill 2026-03-20  Go back in time and collect older posts you missed.
    node src/index.js --reset                Start analysis over. Keeps all downloaded data.
    node src/index.js --test-insights        Run all insight analyses, show results, don't send.
    node src/index.js --help                 Show this message.

  ${b}Getting started:${r}

    1. Copy config.example.json to config.json and edit your interests
    2. Copy secrets.example.json to secrets.json and add your Telegram token
    3. Run --test to make sure everything connects
    4. Run the app

  ${b}Files:${r}

    config.json        What topics to follow, which sources to use, how to deliver
    secrets.json       Your Telegram and GitHub tokens (private, not shared)
    data/db            Everything the app has collected and analyzed
    data/huginn.log    What the app did and when
    output/            Daily summaries and alerts saved as readable files
`);
}

async function main() {
  const args = parseArgs();

  if (args.help) { showHelp(); return; }

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

  if (args.testInsights) {
    await insights.testAll();
    db.close();
    return;
  }

  showLogo();

  // Register bot commands on every start
  await telegramBot.registerCommands();

  if (args.reset) {
    log.warn("Resetting all analysis (raw data kept)...");
    db.getDb().exec("DELETE FROM story_analysis; DELETE FROM comment_analysis; DELETE FROM work_queue; DELETE FROM deliveries; DELETE FROM delivery_messages; DELETE FROM people; DELETE FROM github_repo_analysis; DELETE FROM analysis_runs; DELETE FROM comment_signals;");
    log.success("Reset complete. Run again without --reset.");
    db.close();
    return;
  }

  // Backfill
  if (args.backfill) {
    const ts = dateToTs(args.backfill);
    const currentStory = db.getCursorInt("story");
    if (currentStory && ts >= currentStory) {
      log.warn(`Cursor is already at or before ${args.backfill}. Nothing to backfill.`);
    } else {
      db.setCursor("story", ts);
      if (!db.getCursor("since_date") || ts < dateToTs(db.getCursor("since_date"))) {
        db.setCursor("since_date", args.backfill);
      }
      log.success(`Cursor moved back to ${args.backfill}. Will collect from there on next cycle.`);
    }
  }

  // Initialize start date
  const startDate = resolveStartDate();
  if (startDate) {
    const ts = startDate === "now" ? Math.floor(Date.now() / 1000) : dateToTs(startDate);
    const label = startDate === "now" ? "now" : startDate;
    db.setCursor("story", ts);
    db.setCursor("since_date", label);
    db.setCursor("last_briefing_ts", ts);
    log.success(`First run. Collecting from ${label}.`);
  }

  const storyCursor = db.getCursorInt("story");
  if (!storyCursor) {
    log.error("No start date resolved. Check config.json.");
    db.close();
    return;
  }

  if (args.briefing) {
    const lastTs = parseInt(db.getCursor("last_briefing_ts") || "0", 10);
    const now = Math.floor(Date.now() / 1000);
    const from = lastTs || (now - 86400);
    const briefSpin = log.spinner("Generating briefing...");
    const result = await intelligence.generateBriefing({ from, to: now });
    if (result) {
      briefSpin.done(`Briefing ready \u2014 ${result.storyCount} stories`);
      await delivery.deliverBriefing(result.id, result.content, result.storyCount, result.stories, result.fromLabel, result.toLabel);
    } else {
      briefSpin.warn("No briefing generated");
    }
    printStats();
    db.close();
    return;
  }

  if (args.trend) {
    const week = intelligence.getMissingWeeklyReports()[0];
    if (week) {
      const trendSpin = log.spinner(`Generating trend for ${week}...`);
      const result = await intelligence.generateWeeklyTrend(week);
      if (result) {
        trendSpin.done(`Trend ${week} ready \u2014 ${result.storyCount} stories`);
        await delivery.deliverWeekly(result.id, result.content, result.storyCount);
      } else {
        trendSpin.warn("No trend generated");
      }
    } else {
      log.warn("No missing weekly reports to generate.");
    }
    printStats();
    db.close();
    return;
  }

  // Normal run
  const sinceDate = new Date(storyCursor * 1000).toISOString().slice(0, 10);
  log.info(`Resuming from ${sinceDate}`);

  log.phase("Cycle");
  await fullCycle();
  printStats();

  if (args.once) {
    log.success("Single cycle complete.");
    db.close();
    return;
  }

  await liveLoop();
}

process.on("SIGINT", () => {
  console.log("");
  log.dim("Shutting down...");
  printStats();
  db.close();
  log.close();
  process.exit(0);
});

main().catch((err) => {
  log.error(err.message || String(err));
  db.close();
  log.close();
  process.exit(1);
});
