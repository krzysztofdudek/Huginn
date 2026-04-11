// test/insights/fixtures.js
const Database = require("better-sqlite3");

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE stories (
      id INTEGER PRIMARY KEY, title TEXT, url TEXT, author TEXT,
      points INTEGER DEFAULT 0, num_comments INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, story_text TEXT, type TEXT DEFAULT 'article'
    );
    CREATE TABLE story_analysis (
      story_id INTEGER PRIMARY KEY, relevance TEXT, summary TEXT,
      tags TEXT, conversation_score REAL DEFAULT 0, analyzed_at INTEGER,
      growth_pattern TEXT
    );
    CREATE TABLE point_snapshots (
      story_id INTEGER NOT NULL, points INTEGER NOT NULL,
      num_comments INTEGER NOT NULL, checked_at INTEGER NOT NULL,
      PRIMARY KEY (story_id, checked_at)
    );
    CREATE TABLE github_repos (
      id INTEGER PRIMARY KEY, full_name TEXT UNIQUE, name TEXT, owner TEXT,
      description TEXT, url TEXT, stars INTEGER DEFAULT 0, forks INTEGER DEFAULT 0,
      language TEXT, topics TEXT, created_at INTEGER, pushed_at INTEGER,
      first_seen INTEGER, license TEXT
    );
    CREATE TABLE github_star_snapshots (
      repo_id INTEGER NOT NULL, stars INTEGER NOT NULL, forks INTEGER NOT NULL,
      checked_at INTEGER NOT NULL, PRIMARY KEY (repo_id, checked_at)
    );
    CREATE TABLE people (
      username TEXT PRIMARY KEY, total_comments INTEGER DEFAULT 0,
      relevant_comments INTEGER DEFAULT 0, avg_points REAL DEFAULT 0,
      top_tags TEXT, first_seen INTEGER, last_seen INTEGER
    );
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY, story_id INTEGER NOT NULL, parent_id INTEGER NOT NULL,
      author TEXT, text TEXT, points INTEGER DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE analysis_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_type TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      period_from INTEGER, period_to INTEGER,
      result_summary TEXT, error TEXT,
      created_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE TABLE comment_signals (
      comment_id INTEGER PRIMARY KEY,
      analysis_run_id INTEGER NOT NULL,
      extract TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  return db;
}

const DAY = 86400;
const HOUR = 3600;

function now() { return Math.floor(Date.now() / 1000); }

function seedStory(db, id, opts = {}) {
  const defaults = {
    title: `Story ${id}`, url: `https://example.com/${id}`, author: "user",
    points: opts.points || 10, num_comments: opts.num_comments || 0,
    created_at: opts.created_at || now(), type: opts.type || "article",
  };
  const s = { ...defaults, ...opts, id };
  db.prepare(
    "INSERT OR REPLACE INTO stories (id, title, url, author, points, num_comments, created_at, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(s.id, s.title, s.url, s.author, s.points, s.num_comments, s.created_at, s.type);
  return s;
}

function seedAnalysis(db, storyId, opts = {}) {
  const defaults = { relevance: "relevant", summary: "", tags: "", analyzed_at: now() };
  const a = { ...defaults, ...opts };
  db.prepare(
    "INSERT OR REPLACE INTO story_analysis (story_id, relevance, summary, tags, analyzed_at) VALUES (?, ?, ?, ?, ?)"
  ).run(storyId, a.relevance, a.summary, a.tags, a.analyzed_at);
}

function seedSnapshot(db, storyId, points, checkedAt) {
  db.prepare(
    "INSERT OR IGNORE INTO point_snapshots (story_id, points, num_comments, checked_at) VALUES (?, ?, 0, ?)"
  ).run(storyId, points, checkedAt);
}

function seedRepo(db, id, opts = {}) {
  const defaults = {
    full_name: `owner/repo-${id}`, name: `repo-${id}`, owner: "owner",
    stars: opts.stars || 100, forks: 0, language: "JavaScript",
    created_at: opts.created_at || now(), first_seen: now(),
  };
  const r = { ...defaults, ...opts, id };
  db.prepare(
    "INSERT OR REPLACE INTO github_repos (id, full_name, name, owner, stars, forks, language, created_at, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(r.id, r.full_name, r.name, r.owner, r.stars, r.forks, r.language, r.created_at, r.first_seen);
  return r;
}

function seedStarSnapshot(db, repoId, stars, checkedAt) {
  db.prepare(
    "INSERT OR IGNORE INTO github_star_snapshots (repo_id, stars, forks, checked_at) VALUES (?, ?, 0, ?)"
  ).run(repoId, stars, checkedAt);
}

function seedPerson(db, username, opts = {}) {
  const defaults = {
    total_comments: 5, relevant_comments: opts.relevant_comments || 3,
    avg_points: opts.avg_points || 5, top_tags: "", first_seen: now() - 30 * DAY,
    last_seen: opts.last_seen || now(),
  };
  const p = { ...defaults, ...opts };
  db.prepare(
    "INSERT OR REPLACE INTO people (username, total_comments, relevant_comments, avg_points, top_tags, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(username, p.total_comments, p.relevant_comments, p.avg_points, p.top_tags, p.first_seen, p.last_seen);
}

function seedComment(db, id, storyId, opts = {}) {
  const defaults = {
    parent_id: storyId, author: "commenter", text: `Comment ${id}`,
    points: 0, created_at: opts.created_at || now(),
  };
  const c = { ...defaults, ...opts, id, story_id: storyId };
  db.prepare(
    "INSERT OR REPLACE INTO comments (id, story_id, parent_id, author, text, points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(c.id, c.story_id, c.parent_id, c.author, c.text, c.points, c.created_at);
}

function seedAnalysisRun(db, type, opts = {}) {
  const defaults = {
    status: "done", period_from: now() - DAY, period_to: now(),
    result_summary: null, error: null, created_at: now(), completed_at: now(),
  };
  const r = { ...defaults, ...opts };
  const result = db.prepare(
    "INSERT INTO analysis_runs (analysis_type, status, period_from, period_to, result_summary, error, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(type, r.status, r.period_from, r.period_to, r.result_summary, r.error, r.created_at, r.completed_at);
  return result.lastInsertRowid;
}

module.exports = {
  createTestDb, now, DAY, HOUR,
  seedStory, seedAnalysis, seedSnapshot, seedRepo, seedStarSnapshot,
  seedPerson, seedComment, seedAnalysisRun,
};
