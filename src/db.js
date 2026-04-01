const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "db");
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    migrate();
  }
  return db;
}

// ── Migration system ──

const MIGRATIONS = [
  {
    version: 1,
    name: "baseline",
    up: `
      CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY, title TEXT, url TEXT, author TEXT,
        points INTEGER DEFAULT 0, num_comments INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL, story_text TEXT, type TEXT DEFAULT 'article'
      );

      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY, story_id INTEGER NOT NULL, parent_id INTEGER NOT NULL,
        author TEXT, text TEXT, points INTEGER DEFAULT 0, created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS point_snapshots (
        story_id INTEGER NOT NULL, points INTEGER NOT NULL,
        num_comments INTEGER NOT NULL, checked_at INTEGER NOT NULL,
        PRIMARY KEY (story_id, checked_at)
      );

      CREATE TABLE IF NOT EXISTS story_analysis (
        story_id INTEGER PRIMARY KEY, relevance TEXT, summary TEXT,
        tags TEXT, conversation_score REAL DEFAULT 0, analyzed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS comment_analysis (
        comment_id INTEGER PRIMARY KEY, story_id INTEGER NOT NULL,
        is_insight INTEGER DEFAULT 0, is_need INTEGER DEFAULT 0,
        is_opportunity INTEGER DEFAULT 0, extract TEXT, analyzed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS my_comments (
        id INTEGER PRIMARY KEY, story_id INTEGER NOT NULL,
        parent_id INTEGER NOT NULL, text TEXT, points INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS watched_threads (
        comment_id INTEGER PRIMARY KEY, story_id INTEGER NOT NULL,
        last_reply_seen INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS github_repos (
        id INTEGER PRIMARY KEY, full_name TEXT UNIQUE, name TEXT, owner TEXT,
        description TEXT, url TEXT, stars INTEGER DEFAULT 0, forks INTEGER DEFAULT 0,
        language TEXT, topics TEXT, created_at INTEGER, pushed_at INTEGER,
        first_seen INTEGER, license TEXT
      );

      CREATE TABLE IF NOT EXISTS github_repo_analysis (
        repo_id INTEGER PRIMARY KEY, relevance TEXT, summary TEXT,
        tags TEXT, analyzed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS github_star_snapshots (
        repo_id INTEGER NOT NULL, stars INTEGER NOT NULL, forks INTEGER NOT NULL,
        checked_at INTEGER NOT NULL, PRIMARY KEY (repo_id, checked_at)
      );

      CREATE TABLE IF NOT EXISTS github_releases (
        id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, tag_name TEXT,
        name TEXT, body TEXT, published_at INTEGER, notified INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS people (
        username TEXT PRIMARY KEY, total_comments INTEGER DEFAULT 0,
        relevant_comments INTEGER DEFAULT 0, avg_points REAL DEFAULT 0,
        top_tags TEXT, first_seen INTEGER, last_seen INTEGER
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, sent INTEGER DEFAULT 0,
        generated_at INTEGER, sent_at INTEGER, content TEXT
      );

      CREATE TABLE IF NOT EXISTS work_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL,
        target_id TEXT, params TEXT, status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0, last_error TEXT,
        created_at INTEGER NOT NULL, completed_at INTEGER,
        UNIQUE(task, target_id)
      );

      CREATE INDEX IF NOT EXISTS idx_comments_story ON comments(story_id);
      CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_story ON point_snapshots(story_id);
      CREATE INDEX IF NOT EXISTS idx_story_analysis_rel ON story_analysis(relevance);
      CREATE INDEX IF NOT EXISTS idx_comment_analysis_story ON comment_analysis(story_id);
      CREATE INDEX IF NOT EXISTS idx_work_queue_status ON work_queue(status, task);
      CREATE INDEX IF NOT EXISTS idx_stories_created ON stories(created_at);
      CREATE INDEX IF NOT EXISTS idx_stories_type ON stories(type);
      CREATE INDEX IF NOT EXISTS idx_my_comments_story ON my_comments(story_id);
      CREATE INDEX IF NOT EXISTS idx_watched_threads_story ON watched_threads(story_id);
    `,
  },
  // Future migrations go here:
  // { version: 2, name: "add_something", up: "ALTER TABLE ..." },
];

function migrate() {
  const d = getDb();

  // Create migrations tracking table
  d.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)");

  const applied = new Set(d.prepare("SELECT version FROM _migrations").all().map((r) => r.version));

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    try {
      d.exec(m.up);
      d.prepare("INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, Math.floor(Date.now() / 1000));
      console.log(`  Migration ${m.version} (${m.name}) applied.`);
    } catch (err) {
      console.error(`  Migration ${m.version} (${m.name}) failed: ${err.message}`);
      throw err;
    }
  }
}

// ── Cursors ──

function getCursor(key) {
  const row = getDb().prepare("SELECT value FROM cursors WHERE key = ?").get(key);
  return row ? row.value : null;
}

function getCursorInt(key) {
  const v = getCursor(key);
  return v ? parseInt(v, 10) : null;
}

function setCursor(key, value) {
  getDb().prepare("INSERT OR REPLACE INTO cursors (key, value) VALUES (?, ?)").run(key, String(value));
}

// ── Stories ──

function upsertStories(stories) {
  const stmt = getDb().prepare(
    `INSERT INTO stories (id, title, url, author, points, num_comments, created_at, story_text, type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, url=excluded.url, author=excluded.author,
       points=excluded.points, num_comments=excluded.num_comments,
       story_text=excluded.story_text, type=excluded.type`
  );
  const tx = getDb().transaction((items) => {
    for (const s of items) stmt.run(s.id, s.title, s.url, s.author, s.points, s.num_comments, s.created_at, s.story_text, s.type);
  });
  tx(stories);
}

function getStory(id) {
  return getDb().prepare("SELECT * FROM stories WHERE id = ?").get(id);
}

function getStoriesInRange(fromTs, toTs, minPoints) {
  return getDb().prepare(
    "SELECT * FROM stories WHERE created_at >= ? AND created_at < ? AND points >= ? ORDER BY points DESC"
  ).all(fromTs, toTs, minPoints || 0);
}

// ── Comments ──

function upsertComments(comments) {
  const stmt = getDb().prepare(
    `INSERT OR REPLACE INTO comments (id, story_id, parent_id, author, text, points, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = getDb().transaction((items) => {
    for (const c of items) stmt.run(c.id, c.story_id, c.parent_id, c.author, c.text, c.points, c.created_at);
  });
  tx(comments);
}

function getTopComments(storyId, limit) {
  return getDb().prepare(
    "SELECT * FROM comments WHERE story_id = ? ORDER BY points DESC, created_at ASC LIMIT ?"
  ).all(storyId, limit || 15);
}

// ── Point snapshots ──

function snapshotPoints(stories) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = getDb().prepare(
    "INSERT OR IGNORE INTO point_snapshots (story_id, points, num_comments, checked_at) VALUES (?, ?, ?, ?)"
  );
  const tx = getDb().transaction((items) => {
    for (const s of items) stmt.run(s.id, s.points, s.num_comments, now);
  });
  tx(stories);
}

function getRisingStories(windowHours, minGrowth) {
  const since = Math.floor(Date.now() / 1000) - windowHours * 3600;
  return getDb().prepare(`
    SELECT s.*, sa.relevance, sa.summary, sa.tags,
      s.points - ps_min.min_pts as point_growth,
      ps_min.min_pts as prev_points
    FROM stories s
    JOIN story_analysis sa ON sa.story_id = s.id AND sa.relevance IN ('relevant', 'adjacent')
    JOIN (
      SELECT story_id, MIN(points) as min_pts
      FROM point_snapshots WHERE checked_at >= ?
      GROUP BY story_id
    ) ps_min ON ps_min.story_id = s.id
    WHERE s.points - ps_min.min_pts >= ?
    ORDER BY point_growth DESC
  `).all(since, minGrowth);
}

// ── Story analysis ──

function getAnalysis(storyId) {
  return getDb().prepare("SELECT * FROM story_analysis WHERE story_id = ?").get(storyId);
}

function setAnalysis(storyId, data) {
  getDb().prepare(`
    INSERT OR REPLACE INTO story_analysis (story_id, relevance, summary, tags, conversation_score, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(storyId, data.relevance, data.summary || null, JSON.stringify(data.tags || []), data.conversation_score || 0, Math.floor(Date.now() / 1000));
}

function getRelevantStoriesInRange(fromTs, toTs) {
  return getDb().prepare(`
    SELECT s.*, sa.relevance, sa.summary, sa.tags, sa.conversation_score
    FROM stories s
    JOIN story_analysis sa ON sa.story_id = s.id
    WHERE sa.relevance IN ('relevant', 'adjacent')
      AND s.created_at >= ? AND s.created_at < ?
    ORDER BY s.points DESC
  `).all(fromTs, toTs);
}

function getRelevantStoriesSince(sinceTs) {
  return getDb().prepare(`
    SELECT s.*, sa.relevance, sa.summary, sa.tags, sa.conversation_score
    FROM stories s
    JOIN story_analysis sa ON sa.story_id = s.id
    WHERE sa.relevance IN ('relevant', 'adjacent') AND s.created_at >= ?
    ORDER BY s.points DESC
  `).all(sinceTs);
}

// ── Comment analysis ──

function getCommentAnalysis(storyId) {
  return getDb().prepare("SELECT * FROM comment_analysis WHERE story_id = ?").all(storyId);
}

function setCommentAnalysisBatch(rows) {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO comment_analysis (comment_id, story_id, is_insight, is_need, is_opportunity, extract, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Math.floor(Date.now() / 1000);
  const tx = getDb().transaction((items) => {
    for (const r of items) stmt.run(r.comment_id, r.story_id, r.is_insight, r.is_need, r.is_opportunity, r.extract, now);
  });
  tx(rows);
}

function getOpportunitiesInRange(fromTs, toTs) {
  return getDb().prepare(`
    SELECT ca.*, c.author, c.text, c.points as comment_points, s.title, s.id as sid
    FROM comment_analysis ca
    JOIN comments c ON c.id = ca.comment_id
    JOIN stories s ON s.id = ca.story_id
    WHERE ca.is_opportunity = 1 AND s.created_at >= ? AND s.created_at < ?
    ORDER BY c.points DESC
  `).all(fromTs, toTs);
}

function getFreshOpportunities(hoursBack) {
  const since = Math.floor(Date.now() / 1000) - (hoursBack || 6) * 3600;
  const notifiedIds = (getCursor("opportunity_notified") || "").split(",").filter(Boolean).map(Number);
  const notifiedSet = new Set(notifiedIds);

  const opps = getDb().prepare(`
    SELECT ca.comment_id, ca.extract, ca.story_id,
      c.author, c.text, c.points as comment_points, c.created_at as comment_created,
      s.title, s.id as story_id, s.points as story_points
    FROM comment_analysis ca
    JOIN comments c ON c.id = ca.comment_id
    JOIN stories s ON s.id = ca.story_id
    WHERE ca.is_opportunity = 1 AND c.created_at >= ?
    ORDER BY c.created_at DESC
  `).all(since);

  return opps.filter((o) => !notifiedSet.has(o.comment_id));
}

function markOpportunityNotified(commentIds) {
  const existing = (getCursor("opportunity_notified") || "").split(",").filter(Boolean).map(Number);
  const all = [...existing, ...commentIds].slice(-200); // Keep last 200
  setCursor("opportunity_notified", all.join(","));
}

// ── People ──

function rebuildPeople() {
  getDb().exec(`
    DELETE FROM people;
    INSERT INTO people (username, total_comments, relevant_comments, avg_points, first_seen, last_seen)
    SELECT
      c.author,
      COUNT(*) as total_comments,
      COUNT(CASE WHEN sa.relevance IN ('relevant','adjacent') THEN 1 END) as relevant_comments,
      AVG(c.points) as avg_points,
      MIN(c.created_at) as first_seen,
      MAX(c.created_at) as last_seen
    FROM comments c
    LEFT JOIN story_analysis sa ON sa.story_id = c.story_id
    WHERE c.author != '[deleted]'
    GROUP BY c.author
    HAVING relevant_comments >= 2
  `);
}

function getTopPeople(limit) {
  return getDb().prepare(
    "SELECT * FROM people ORDER BY relevant_comments DESC, avg_points DESC LIMIT ?"
  ).all(limit || 20);
}

// ── Work queue ──

function enqueue(task, targetId, params) {
  getDb().prepare(`
    INSERT OR IGNORE INTO work_queue (task, target_id, params, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(task, String(targetId), params ? JSON.stringify(params) : null, Math.floor(Date.now() / 1000));
}

function dequeueBatch(task, limit) {
  return getDb().prepare(`
    SELECT * FROM work_queue WHERE task = ? AND status = 'pending'
    ORDER BY created_at ASC LIMIT ?
  `).all(task, limit || 100);
}

function completeWork(id) {
  getDb().prepare("UPDATE work_queue SET status = 'done', completed_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), id);
}

function failWork(id, error) {
  getDb().prepare("UPDATE work_queue SET status = 'pending', attempts = attempts + 1, last_error = ? WHERE id = ?")
    .run(error, id);
}

function failWorkPermanent(id, error) {
  getDb().prepare("UPDATE work_queue SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?")
    .run(error, id);
}

// ── Deliveries ──

function getDelivery(id) {
  return getDb().prepare("SELECT * FROM deliveries WHERE id = ?").get(id);
}

function saveDelivery(id, type, content) {
  getDb().prepare(`
    INSERT OR REPLACE INTO deliveries (id, type, sent, generated_at, content)
    VALUES (?, ?, 0, ?, ?)
  `).run(id, type, Math.floor(Date.now() / 1000), content);
}

function markDeliverySent(id) {
  getDb().prepare("UPDATE deliveries SET sent = 1, sent_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), id);
}

function getUnsentDeliveries() {
  return getDb().prepare("SELECT * FROM deliveries WHERE sent = 0 ORDER BY generated_at ASC").all();
}

function getDeliveredDays(type) {
  return getDb().prepare("SELECT id FROM deliveries WHERE type = ? AND sent = 1 ORDER BY id ASC")
    .all(type).map((r) => r.id);
}

// ── My threads ──

function upsertMyComments(comments) {
  const stmt = getDb().prepare(
    `INSERT OR REPLACE INTO my_comments (id, story_id, parent_id, text, points, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const tx = getDb().transaction((items) => {
    for (const c of items) stmt.run(c.id, c.story_id, c.parent_id, c.text, c.points, c.created_at);
  });
  tx(comments);
}

function getMyCommentIds() {
  return new Set(getDb().prepare("SELECT id FROM my_comments").all().map((r) => r.id));
}

function getWatchedThreads() {
  return getDb().prepare(`
    SELECT wt.*, mc.text as my_text, s.title as story_title
    FROM watched_threads wt
    JOIN my_comments mc ON mc.id = wt.comment_id
    LEFT JOIN stories s ON s.id = wt.story_id
  `).all();
}

function upsertWatchedThread(commentId, storyId) {
  getDb().prepare(
    "INSERT OR IGNORE INTO watched_threads (comment_id, story_id, last_reply_seen) VALUES (?, ?, 0)"
  ).run(commentId, storyId);
}

function getNewReplies(myCommentId, lastSeen) {
  // Direct replies to my comment
  const direct = getDb().prepare(
    "SELECT * FROM comments WHERE parent_id = ? AND created_at > ? ORDER BY created_at ASC"
  ).all(myCommentId, lastSeen);
  return direct;
}

function setLastReplySeen(commentId, ts) {
  getDb().prepare("UPDATE watched_threads SET last_reply_seen = ? WHERE comment_id = ?").run(ts, commentId);
}

// ── GitHub ──

function upsertGithubRepo(repo) {
  getDb().prepare(`
    INSERT INTO github_repos (id, full_name, name, owner, description, url, stars, forks, language, topics, created_at, pushed_at, first_seen, license)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      description=excluded.description, stars=excluded.stars, forks=excluded.forks,
      language=excluded.language, topics=excluded.topics, pushed_at=excluded.pushed_at
  `).run(
    repo.id, repo.full_name, repo.name, repo.owner, repo.description, repo.url,
    repo.stars, repo.forks, repo.language, JSON.stringify(repo.topics || []),
    repo.created_at, repo.pushed_at, Math.floor(Date.now() / 1000), repo.license
  );
}

function upsertGithubRepos(repos) {
  const tx = getDb().transaction((items) => { for (const r of items) upsertGithubRepo(r); });
  tx(repos);
}

function getGithubRepo(id) {
  return getDb().prepare("SELECT * FROM github_repos WHERE id = ?").get(id);
}

function getGithubRepoByName(fullName) {
  return getDb().prepare("SELECT * FROM github_repos WHERE full_name = ?").get(fullName);
}

function getGithubRepoAnalysis(repoId) {
  return getDb().prepare("SELECT * FROM github_repo_analysis WHERE repo_id = ?").get(repoId);
}

function setGithubRepoAnalysis(repoId, data) {
  getDb().prepare(`
    INSERT OR REPLACE INTO github_repo_analysis (repo_id, relevance, summary, tags, analyzed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(repoId, data.relevance, data.summary || null, JSON.stringify(data.tags || []), Math.floor(Date.now() / 1000));
}

function snapshotGithubStars(repos) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = getDb().prepare(
    "INSERT OR IGNORE INTO github_star_snapshots (repo_id, stars, forks, checked_at) VALUES (?, ?, ?, ?)"
  );
  const tx = getDb().transaction((items) => {
    for (const r of items) stmt.run(r.id, r.stars, r.forks, now);
  });
  tx(repos);
}

function getGithubRising(windowHours, minGrowth) {
  const since = Math.floor(Date.now() / 1000) - windowHours * 3600;
  return getDb().prepare(`
    SELECT r.*, ra.relevance, ra.summary, ra.tags,
      r.stars - gs.min_stars as star_growth,
      gs.min_stars as prev_stars
    FROM github_repos r
    JOIN github_repo_analysis ra ON ra.repo_id = r.id AND ra.relevance IN ('relevant', 'adjacent')
    JOIN (
      SELECT repo_id, MIN(stars) as min_stars
      FROM github_star_snapshots WHERE checked_at >= ?
      GROUP BY repo_id
    ) gs ON gs.repo_id = r.id
    WHERE r.stars - gs.min_stars >= ?
    ORDER BY star_growth DESC
  `).all(since, minGrowth);
}

function upsertGithubRelease(release) {
  getDb().prepare(`
    INSERT OR IGNORE INTO github_releases (id, repo_id, tag_name, name, body, published_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(release.id, release.repo_id, release.tag_name, release.name, release.body, release.published_at);
}

function getUnnotifiedReleases() {
  return getDb().prepare(`
    SELECT gr.*, r.full_name, r.name as repo_name
    FROM github_releases gr
    JOIN github_repos r ON r.id = gr.repo_id
    WHERE gr.notified = 0
    ORDER BY gr.published_at DESC
  `).all();
}

function markReleaseNotified(id) {
  getDb().prepare("UPDATE github_releases SET notified = 1 WHERE id = ?").run(id);
}

function getRelevantGithubReposSince(sinceTs) {
  return getDb().prepare(`
    SELECT r.*, ra.relevance, ra.summary, ra.tags
    FROM github_repos r
    JOIN github_repo_analysis ra ON ra.repo_id = r.id
    WHERE ra.relevance IN ('relevant', 'adjacent') AND r.first_seen >= ?
    ORDER BY r.stars DESC
  `).all(sinceTs);
}

function getAllGithubRepos() {
  return getDb().prepare("SELECT * FROM github_repos ORDER BY stars DESC").all();
}

// ── Stats ──

function getStats() {
  const d = getDb();
  return {
    stories: d.prepare("SELECT COUNT(*) as c FROM stories").get().c,
    comments: d.prepare("SELECT COUNT(*) as c FROM comments").get().c,
    analyzed: d.prepare("SELECT COUNT(*) as c FROM story_analysis").get().c,
    relevant: d.prepare("SELECT COUNT(*) as c FROM story_analysis WHERE relevance = 'relevant'").get().c,
    adjacent: d.prepare("SELECT COUNT(*) as c FROM story_analysis WHERE relevance = 'adjacent'").get().c,
    commentAnalysis: d.prepare("SELECT COUNT(*) as c FROM comment_analysis").get().c,
    people: d.prepare("SELECT COUNT(*) as c FROM people").get().c,
    pendingWork: d.prepare("SELECT COUNT(*) as c FROM work_queue WHERE status = 'pending'").get().c,
    unsentDeliveries: d.prepare("SELECT COUNT(*) as c FROM deliveries WHERE sent = 0").get().c,
    githubRepos: d.prepare("SELECT COUNT(*) as c FROM github_repos").get().c,
    githubRelevant: d.prepare("SELECT COUNT(*) as c FROM github_repo_analysis WHERE relevance IN ('relevant','adjacent')").get().c,
  };
}

function close() {
  if (db) { db.close(); db = null; }
}

module.exports = {
  getDb, getCursor, getCursorInt, setCursor,
  upsertStories, getStory, getStoriesInRange,
  upsertComments, getTopComments,
  snapshotPoints, getRisingStories,
  getAnalysis, setAnalysis, getRelevantStoriesInRange, getRelevantStoriesSince,
  getCommentAnalysis, setCommentAnalysisBatch, getOpportunitiesInRange, getFreshOpportunities, markOpportunityNotified,
  rebuildPeople, getTopPeople,
  enqueue, dequeueBatch, completeWork, failWork, failWorkPermanent,
  getDelivery, saveDelivery, markDeliverySent, getUnsentDeliveries, getDeliveredDays,
  upsertMyComments, getMyCommentIds, getWatchedThreads, upsertWatchedThread, getNewReplies, setLastReplySeen,
  upsertGithubRepo, upsertGithubRepos, getGithubRepo, getGithubRepoByName,
  getGithubRepoAnalysis, setGithubRepoAnalysis,
  snapshotGithubStars, getGithubRising,
  upsertGithubRelease, getUnnotifiedReleases, markReleaseNotified,
  getRelevantGithubReposSince, getAllGithubRepos,
  getStats, close,
};
