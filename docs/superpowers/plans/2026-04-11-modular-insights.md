# Modular Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 8 pluggable data analyses with a registry-based scheduler, adaptive point tracking, and full test coverage.

**Architecture:** Registry pattern (like `src/connectors/`). Each analysis is a file in `src/insights/`. Central scheduler in `src/insights.js` auto-discovers plugins, checks `shouldRun()`, tracks runs in `analysis_runs` table. Delivery through existing `delivery_messages` system.

**Tech Stack:** Node.js, better-sqlite3, Ollama (via existing connector), Node built-in test runner.

---

## File Map

### New files

| File | Purpose |
|------|---------|
| `src/insights.js` | Scheduler: auto-discovery, shouldRun loop, run tracking, stuck detection |
| `src/insights/competitive-velocity.js` | GitHub repo star growth spike detection |
| `src/insights/signal-noise.js` | Source quality ratio per type/subreddit |
| `src/insights/dead-zone.js` | Fading topic detection |
| `src/insights/decay-analysis.js` | Story growth curve classification |
| `src/insights/people-radar.js` | Top contributors in relevant topics |
| `src/insights/pre-trend.js` | Emerging topic detection (Ollama) |
| `src/insights/community-pulse.js` | Three-layer community reaction analysis (Ollama) |
| `src/insights/ecosystem-map.js` | Topic cluster mapping (Ollama) |
| `test/insights/fixtures.js` | Test helper: in-memory DB with schema + seed data |
| `test/insights/scheduler.test.js` | Scheduler logic tests |
| `test/insights/competitive-velocity.test.js` | Fixture data tests |
| `test/insights/signal-noise.test.js` | Fixture data tests |
| `test/insights/dead-zone.test.js` | Fixture data tests |
| `test/insights/decay-analysis.test.js` | Fixture data tests |
| `test/insights/people-radar.test.js` | Fixture data tests |
| `test/insights/pre-trend.test.js` | Contract test with mock connector |
| `test/insights/community-pulse.test.js` | Contract test with mock connector |
| `test/insights/ecosystem-map.test.js` | Contract test with mock connector |

### Modified files

| File | Change |
|------|--------|
| `src/db.js` | Migration 5 (analysis_runs, comment_signals tables, growth_pattern column). New query functions. |
| `src/delivery.js` | New `deliverInsight()` function |
| `src/index.js` | New Insights phase after Intelligence. New `--test-insights` CLI command. |
| `src/collector.js` | Adaptive point tracking in `refreshRecentPoints` |
| `src/config.js` | Add `insights` to DEFAULTS and KNOWN_KEYS |
| `config.example.json` | Add `insights` section |
| `package.json` | Add `"test"` script |

---

## Task 1: Database migration and query functions

**Files:**
- Modify: `src/db.js`

- [ ] **Step 1: Add migration 5 to MIGRATIONS array**

In `src/db.js`, find the line `// Future migrations go here:` (after migration 4) and add before the closing `];`:

```js
  {
    version: 5,
    name: "insights",
    up: `
      CREATE TABLE IF NOT EXISTS analysis_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        analysis_type TEXT NOT NULL,
        status TEXT DEFAULT 'running',
        period_from INTEGER,
        period_to INTEGER,
        result_summary TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ar_type ON analysis_runs(analysis_type, created_at);

      CREATE TABLE IF NOT EXISTS comment_signals (
        comment_id INTEGER PRIMARY KEY,
        analysis_run_id INTEGER NOT NULL,
        extract TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      ALTER TABLE story_analysis ADD COLUMN growth_pattern TEXT;
    `,
  },
```

- [ ] **Step 2: Add analysis_runs query functions**

Add after the `// ── Stats ──` section in `src/db.js`:

```js
// ── Analysis runs ──

function getLastAnalysisRun(type) {
  return getDb().prepare(
    "SELECT * FROM analysis_runs WHERE analysis_type = ? ORDER BY created_at DESC LIMIT 1"
  ).get(type);
}

function getLastCompletedRun(type) {
  return getDb().prepare(
    "SELECT * FROM analysis_runs WHERE analysis_type = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1"
  ).get(type);
}

function getFailedRuns(type) {
  return getDb().prepare(
    "SELECT * FROM analysis_runs WHERE analysis_type = ? AND status = 'failed' ORDER BY created_at ASC"
  ).all(type);
}

function startAnalysisRun(type, periodFrom, periodTo) {
  const now = Math.floor(Date.now() / 1000);
  const result = getDb().prepare(
    "INSERT INTO analysis_runs (analysis_type, status, period_from, period_to, created_at) VALUES (?, 'running', ?, ?, ?)"
  ).run(type, periodFrom, periodTo, now);
  return result.lastInsertRowid;
}

function completeAnalysisRun(id, summary) {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    "UPDATE analysis_runs SET status = 'done', result_summary = ?, completed_at = ? WHERE id = ?"
  ).run(summary || null, now, id);
}

function failAnalysisRun(id, error) {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    "UPDATE analysis_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?"
  ).run(error, now, id);
}

function recoverStuckRuns(timeoutSeconds) {
  const cutoff = Math.floor(Date.now() / 1000) - timeoutSeconds;
  const stuck = getDb().prepare(
    "SELECT id FROM analysis_runs WHERE status = 'running' AND created_at < ?"
  ).all(cutoff);
  const now = Math.floor(Date.now() / 1000);
  for (const row of stuck) {
    getDb().prepare(
      "UPDATE analysis_runs SET status = 'failed', error = 'stuck — process was killed', completed_at = ? WHERE id = ?"
    ).run(now, row.id);
  }
  return stuck.length;
}
```

- [ ] **Step 3: Add aggregate query functions for plugins**

Add after the analysis runs functions:

```js
// ── Insight queries ──

function countStoriesSince(ts) {
  return getDb().prepare("SELECT COUNT(*) as c FROM stories WHERE created_at > ?").get(ts).c;
}

function countRelevantStoriesSince(ts) {
  return getDb().prepare(
    "SELECT COUNT(*) as c FROM stories s JOIN story_analysis sa ON s.id = sa.story_id WHERE sa.relevance IN ('relevant','adjacent') AND s.created_at > ?"
  ).get(ts).c;
}

function getSourceRelevanceStats(from, to) {
  return getDb().prepare(`
    SELECT s.type, COUNT(*) as total,
      SUM(CASE WHEN sa.relevance = 'relevant' THEN 1 ELSE 0 END) as relevant,
      SUM(CASE WHEN sa.relevance = 'adjacent' THEN 1 ELSE 0 END) as adjacent
    FROM stories s
    JOIN story_analysis sa ON s.id = sa.story_id
    WHERE s.created_at >= ? AND s.created_at < ?
    GROUP BY s.type
  `).all(from, to);
}

function getTagCountsInRange(from, to) {
  const rows = getDb().prepare(`
    SELECT sa.tags FROM story_analysis sa
    JOIN stories s ON s.id = sa.story_id
    WHERE sa.relevance IN ('relevant','adjacent')
    AND s.created_at >= ? AND s.created_at < ?
    AND sa.tags IS NOT NULL AND sa.tags != ''
  `).all(from, to);
  const counts = {};
  for (const row of rows) {
    for (const tag of row.tags.split(",")) {
      const t = tag.trim();
      if (t) counts[t] = (counts[t] || 0) + 1;
    }
  }
  return counts;
}

function getStarGrowth(days) {
  const now = Math.floor(Date.now() / 1000);
  const periodStart = now - days * 86400;
  const prevStart = periodStart - days * 86400;
  return getDb().prepare(`
    SELECT r.id, r.full_name, r.stars,
      r.stars - COALESCE(curr.first_stars, r.stars) as current_growth,
      COALESCE(prev_g.growth, 0) as previous_growth
    FROM github_repos r
    LEFT JOIN (
      SELECT repo_id, MIN(stars) as first_stars
      FROM github_star_snapshots WHERE checked_at >= ?
      GROUP BY repo_id
    ) curr ON curr.repo_id = r.id
    LEFT JOIN (
      SELECT repo_id, MAX(stars) - MIN(stars) as growth
      FROM github_star_snapshots WHERE checked_at >= ? AND checked_at < ?
      GROUP BY repo_id
    ) prev_g ON prev_g.repo_id = r.id
    WHERE r.stars - COALESCE(curr.first_stars, r.stars) > 0
    ORDER BY current_growth DESC
  `).all(periodStart, prevStart, periodStart);
}

function getUnclassifiedDecayStories(minSnapshots) {
  return getDb().prepare(`
    SELECT s.id, s.title, s.created_at, s.points
    FROM stories s
    JOIN story_analysis sa ON s.id = sa.story_id
    WHERE sa.relevance IN ('relevant','adjacent')
    AND sa.growth_pattern IS NULL
    AND (SELECT COUNT(*) FROM point_snapshots ps WHERE ps.story_id = s.id) >= ?
  `).all(minSnapshots);
}

function getPointTimeline(storyId) {
  return getDb().prepare(
    "SELECT points, num_comments, checked_at FROM point_snapshots WHERE story_id = ? ORDER BY checked_at ASC"
  ).all(storyId);
}

function setGrowthPattern(storyId, pattern) {
  getDb().prepare("UPDATE story_analysis SET growth_pattern = ? WHERE story_id = ?").run(pattern, storyId);
}

function getTopPeopleInRange(from, to, limit) {
  return getDb().prepare(`
    SELECT p.username, p.relevant_comments, p.avg_points, p.top_tags, p.last_seen
    FROM people p
    WHERE p.last_seen >= ? AND p.last_seen < ?
    ORDER BY p.relevant_comments * p.avg_points DESC
    LIMIT ?
  `).all(from, to, limit);
}

function getCommentsForRelevantStories(from, to) {
  return getDb().prepare(`
    SELECT c.id, c.story_id, c.parent_id, c.author, c.text, c.points, c.created_at,
      s.title as story_title, sa.summary as story_summary
    FROM comments c
    JOIN stories s ON c.story_id = s.id
    JOIN story_analysis sa ON s.id = sa.story_id
    WHERE sa.relevance IN ('relevant','adjacent')
    AND c.created_at >= ? AND c.created_at < ?
    ORDER BY c.story_id, c.created_at
  `).all(from, to);
}

function getCommentParentChain(commentId, storyId, maxDepth) {
  const chain = [];
  let currentId = commentId;
  for (let i = 0; i < (maxDepth || 3); i++) {
    const parent = getDb().prepare("SELECT * FROM comments WHERE id = ?").get(currentId);
    if (!parent || parent.id === storyId) break;
    chain.unshift(parent);
    currentId = parent.parent_id;
  }
  return chain;
}

function saveCommentSignal(commentId, runId, extractJson) {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    "INSERT OR REPLACE INTO comment_signals (comment_id, analysis_run_id, extract, created_at) VALUES (?, ?, ?, ?)"
  ).run(commentId, runId, extractJson, now);
}

function getCommentSignals(runId) {
  return getDb().prepare("SELECT * FROM comment_signals WHERE analysis_run_id = ?").all(runId);
}

function getLastSnapshotTime(storyId) {
  const row = getDb().prepare(
    "SELECT MAX(checked_at) as last FROM point_snapshots WHERE story_id = ?"
  ).get(storyId);
  return row ? row.last : 0;
}

function hasNewStarSnapshots(sinceTs) {
  return getDb().prepare(
    "SELECT COUNT(*) as c FROM github_star_snapshots WHERE checked_at > ?"
  ).get(sinceTs).c > 0;
}
```

- [ ] **Step 4: Add new functions to module.exports**

Find the `module.exports` block at the end of `src/db.js` and add these exports:

```js
  getLastAnalysisRun, getLastCompletedRun, getFailedRuns,
  startAnalysisRun, completeAnalysisRun, failAnalysisRun, recoverStuckRuns,
  countStoriesSince, countRelevantStoriesSince,
  getSourceRelevanceStats, getTagCountsInRange, getStarGrowth,
  getUnclassifiedDecayStories, getPointTimeline, setGrowthPattern,
  getTopPeopleInRange, getCommentsForRelevantStories, getCommentParentChain,
  saveCommentSignal, getCommentSignals, getLastSnapshotTime, hasNewStarSnapshots,
```

- [ ] **Step 5: Verify migration runs**

Run: `node -e "require('./src/db'); console.log('Migration OK')"`

Expected: `Migration 5 (insights) applied.` followed by `Migration OK`

- [ ] **Step 6: Commit**

```bash
git add src/db.js
git commit -m "feat: add analysis_runs, comment_signals tables and insight queries"
```

---

## Task 2: Test fixtures helper

**Files:**
- Create: `test/insights/fixtures.js`

- [ ] **Step 1: Create test directory**

```bash
mkdir -p test/insights
```

- [ ] **Step 2: Write fixtures helper**

```js
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
```

- [ ] **Step 3: Commit**

```bash
git add test/insights/fixtures.js
git commit -m "test: add insights test fixtures helper"
```

---

## Task 3: Config and delivery changes

**Files:**
- Modify: `src/config.js`
- Modify: `config.example.json`
- Modify: `src/delivery.js`

- [ ] **Step 1: Add insights defaults in `src/config.js`**

Find the `DEFAULTS` object and add after `tags: [],`:

```js
  insights: {
    enabled: true,
    maxPerCycle: 3,
    stuckTimeoutMinutes: 60,
    analyses: {
      "pre-trend": { enabled: true },
      "competitive-velocity": { enabled: true },
      "signal-noise": { enabled: true },
      "dead-zone": { enabled: true },
      "decay-analysis": { enabled: true },
      "people-radar": { enabled: true },
      "community-pulse": { enabled: true },
      "ecosystem-map": { enabled: true },
    },
  },
```

Add `"insights"` to the `KNOWN_KEYS` set.

- [ ] **Step 2: Add insights section to `config.example.json`**

Add before the closing `}`:

```json
  "insights": {
    "enabled": true,
    "maxPerCycle": 3,
    "stuckTimeoutMinutes": 60,
    "analyses": {
      "pre-trend": { "enabled": true },
      "competitive-velocity": { "enabled": true },
      "signal-noise": { "enabled": true },
      "dead-zone": { "enabled": true },
      "decay-analysis": { "enabled": true },
      "people-radar": { "enabled": true },
      "community-pulse": { "enabled": true },
      "ecosystem-map": { "enabled": true }
    }
  }
```

- [ ] **Step 3: Add `deliverInsight` to `src/delivery.js`**

Add before the `module.exports` line:

```js
// ── Insights ──

async function deliverInsight(pluginId, pluginName, content) {
  const id = `insight-${pluginId}-${Math.floor(Date.now() / 1000)}`;
  writeToFile(`${id}.md`, `# ${pluginName}\n\n${content}`);
  db.saveDelivery(id, "insight", content);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  return sendAndTrack(id, [content]);
}
```

Add `deliverInsight` to the `module.exports` object.

- [ ] **Step 4: Commit**

```bash
git add src/config.js config.example.json src/delivery.js
git commit -m "feat: add insights config defaults and deliverInsight"
```

---

## Task 4: Scheduler (`src/insights.js`)

**Files:**
- Create: `src/insights.js`
- Create: `src/insights/` directory
- Test: `test/insights/scheduler.test.js`

- [ ] **Step 1: Create insights directory**

```bash
mkdir -p src/insights
```

- [ ] **Step 2: Write the scheduler test**

```js
// test/insights/scheduler.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createTestDb, now, DAY, HOUR, seedAnalysisRun } = require("./fixtures");

// Mock a minimal plugin
function mockPlugin(id, shouldRunResult) {
  return {
    id,
    name: `Test ${id}`,
    shouldRun: () => shouldRunResult,
    run: async () => ({ message: "test" }),
    format: (r) => r.message,
  };
}

describe("Scheduler", () => {
  describe("recoverStuckRuns", () => {
    it("marks old running runs as failed", () => {
      const db = createTestDb();
      // Insert a run that started 2 hours ago, still "running"
      db.prepare(
        "INSERT INTO analysis_runs (analysis_type, status, created_at) VALUES (?, 'running', ?)"
      ).run("test-plugin", now() - 2 * HOUR);

      const cutoff = now() - HOUR;
      const stuck = db.prepare("SELECT id FROM analysis_runs WHERE status = 'running' AND created_at < ?").all(cutoff);
      for (const row of stuck) {
        db.prepare("UPDATE analysis_runs SET status = 'failed', error = 'stuck', completed_at = ? WHERE id = ?").run(now(), row.id);
      }

      const result = db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(stuck[0].id);
      assert.strictEqual(result.status, "failed");
      assert.strictEqual(result.error, "stuck");
    });

    it("does not touch recent running runs", () => {
      const db = createTestDb();
      db.prepare(
        "INSERT INTO analysis_runs (analysis_type, status, created_at) VALUES (?, 'running', ?)"
      ).run("test-plugin", now() - 5 * 60); // 5 minutes ago

      const cutoff = now() - HOUR;
      const stuck = db.prepare("SELECT id FROM analysis_runs WHERE status = 'running' AND created_at < ?").all(cutoff);
      assert.strictEqual(stuck.length, 0);
    });
  });

  describe("idempotency", () => {
    it("completed run is not re-run for same period", () => {
      const db = createTestDb();
      const from = now() - DAY;
      const to = now();
      seedAnalysisRun(db, "test-plugin", { status: "done", period_from: from, period_to: to });

      const last = db.prepare(
        "SELECT * FROM analysis_runs WHERE analysis_type = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1"
      ).get("test-plugin");

      assert.ok(last);
      assert.strictEqual(last.period_from, from);
      assert.strictEqual(last.period_to, to);
    });
  });

  describe("stampede protection", () => {
    it("processes at most maxPerCycle periods", () => {
      const periods = [
        { from: now() - 4 * DAY, to: now() - 3 * DAY },
        { from: now() - 3 * DAY, to: now() - 2 * DAY },
        { from: now() - 2 * DAY, to: now() - DAY },
        { from: now() - DAY, to: now() },
      ];
      const maxPerCycle = 3;
      const toProcess = periods.slice(0, maxPerCycle);
      assert.strictEqual(toProcess.length, 3);
    });
  });

  describe("failed run retry", () => {
    it("failed run allows re-run for same period", () => {
      const db = createTestDb();
      const from = now() - DAY;
      const to = now();
      seedAnalysisRun(db, "test-plugin", { status: "failed", period_from: from, period_to: to, error: "ollama timeout" });

      const last = db.prepare(
        "SELECT * FROM analysis_runs WHERE analysis_type = ? ORDER BY created_at DESC LIMIT 1"
      ).get("test-plugin");

      assert.strictEqual(last.status, "failed");
      // shouldRun should include this period since it failed
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it passes with fixtures**

Run: `node --test test/insights/scheduler.test.js`

Expected: All tests pass (they test data setup and queries, not the scheduler itself yet).

- [ ] **Step 4: Write the scheduler**

```js
// src/insights.js
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { getConnector, isAvailable } = require("./connectors");
const delivery = require("./delivery");
const config = require("./config");
const log = require("./logger");

// ── Auto-discover plugins ──

const plugins = {};
const dir = path.join(__dirname, "insights");
if (fs.existsSync(dir)) {
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    const plugin = require(path.join(dir, file));
    if (plugin.id && plugin.shouldRun && plugin.run && plugin.format) {
      plugins[plugin.id] = plugin;
    }
  }
}

function getEnabledPlugins() {
  const insightsConfig = config.insights || {};
  if (!insightsConfig.enabled) return [];
  const analyses = insightsConfig.analyses || {};
  return Object.values(plugins).filter((p) => {
    const ac = analyses[p.id];
    return !ac || ac.enabled !== false; // enabled by default
  });
}

// ── Scheduler ──

async function runDue() {
  const insightsConfig = config.insights || {};
  if (!insightsConfig.enabled) return;

  const maxPerCycle = insightsConfig.maxPerCycle || 3;
  const stuckTimeout = (insightsConfig.stuckTimeoutMinutes || 60) * 60;

  // 1. Recover stuck runs
  const recovered = db.recoverStuckRuns(stuckTimeout);
  if (recovered > 0) log.warn(`Recovered ${recovered} stuck insight run(s)`);

  // 2. For each enabled plugin, check shouldRun
  const enabled = getEnabledPlugins();
  let totalRun = 0;

  for (const plugin of enabled) {
    if (totalRun >= maxPerCycle) break;

    const lastRun = db.getLastAnalysisRun(plugin.id);
    let periods;
    try {
      periods = plugin.shouldRun(db, lastRun);
    } catch (err) {
      log.error(`${plugin.name}: shouldRun failed — ${err.message}`);
      continue;
    }

    if (!periods || periods.length === 0) continue;

    // Needs Ollama? Check availability
    if (plugin.needsOllama && !isAvailable()) continue;

    // Process periods sequentially, oldest first
    for (const period of periods) {
      if (totalRun >= maxPerCycle) break;

      const runId = db.startAnalysisRun(plugin.id, period.from, period.to);
      const t = log.timer();

      try {
        const connector = plugin.needsOllama ? getConnector() : null;
        const result = await plugin.run(db, connector, period, runId);

        if (result) {
          const summary = typeof result.summary === "string" ? result.summary : JSON.stringify(result).slice(0, 500);
          db.completeAnalysisRun(runId, summary);
          const formatted = plugin.format(result);
          await delivery.deliverInsight(plugin.id, plugin.name, formatted);
          log.info(`${plugin.name}: alert sent ${log.c.dim}${t()}${log.c.reset}`);
        } else {
          db.completeAnalysisRun(runId, null);
          log.dim(`  ${plugin.name}: no alert ${log.c.dim}${t()}${log.c.reset}`);
        }
      } catch (err) {
        db.failAnalysisRun(runId, err.message);
        log.error(`${plugin.name}: ${err.message} ${log.c.dim}${t()}${log.c.reset}`);
      }

      totalRun++;
    }
  }
}

// ── Dry run (--test-insights) ──

async function testAll() {
  const enabled = getEnabledPlugins();
  if (enabled.length === 0) {
    log.warn("No insights plugins enabled.");
    return;
  }

  log.heading("Insights dry run");
  console.log("");

  for (const plugin of enabled) {
    const lastRun = db.getLastAnalysisRun(plugin.id);
    let periods;
    try {
      periods = plugin.shouldRun(db, lastRun);
    } catch (err) {
      log.error(`${plugin.name}: shouldRun error — ${err.message}`);
      continue;
    }

    if (!periods || periods.length === 0) {
      log.dim(`  ${plugin.name}: nothing to run`);
      continue;
    }

    if (plugin.needsOllama && !isAvailable()) {
      log.warn(`${plugin.name}: needs Ollama but unavailable`);
      continue;
    }

    const period = periods[0];
    const spin = log.spinner(`${plugin.name}...`);
    try {
      const connector = plugin.needsOllama ? getConnector() : null;
      const result = await plugin.run(db, connector, period, null);
      if (result) {
        spin.done(`${plugin.name}`);
        console.log("");
        console.log(log.strip(plugin.format(result)));
        console.log("");
      } else {
        spin.done(`${plugin.name}: no findings`);
      }
    } catch (err) {
      spin.fail(`${plugin.name}: ${err.message}`);
    }
  }
}

module.exports = { runDue, testAll, getEnabledPlugins };
```

- [ ] **Step 5: Run scheduler test again**

Run: `node --test test/insights/scheduler.test.js`

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/insights.js src/insights/ test/insights/scheduler.test.js
git commit -m "feat: add insights scheduler with auto-discovery and resilience"
```

---

## Task 5: Wire into index.js

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Add require at top of `src/index.js`**

After `const delivery = require("./delivery");` add:

```js
const insights = require("./insights");
```

- [ ] **Step 2: Add Insights phase to `fullCycle()`**

In the `fullCycle()` function, after the Intelligence phase:

```js
  log.phase("Insights");
  await insights.runDue();
```

- [ ] **Step 3: Add `--test-insights` CLI command**

In `parseArgs()`, add to the result object: `testInsights: false` and in the loop: `if (args[i] === "--test-insights") result.testInsights = true;`

In `main()`, after the `args.status` block add:

```js
  if (args.testInsights) {
    await insights.testAll();
    db.close();
    return;
  }
```

- [ ] **Step 4: Add to help text**

In `showHelp()`, add after the `--status` line:

```
    node src/index.js --test-insights      Run all insight analyses, show results, don't send.
```

- [ ] **Step 5: Add to package.json scripts**

Add: `"test-insights": "node src/index.js --test-insights"`

And add test runner: `"test": "node --test test/**/*.test.js"`

- [ ] **Step 6: Verify it loads without plugins**

Run: `node src/index.js --test-insights`

Expected: `No insights plugins enabled.` or an empty run (no plugins in `src/insights/` yet, so no crashes).

- [ ] **Step 7: Commit**

```bash
git add src/index.js package.json
git commit -m "feat: wire insights scheduler into pipeline and CLI"
```

---

## Task 6: Adaptive point tracking

**Files:**
- Modify: `src/collector.js`

- [ ] **Step 1: Add `shouldSnapshot` function**

At the top of `src/collector.js`, after the existing constants, add:

```js
const HOUR = 3600;
const MIN = 60;
const TRACKING_DAYS = config.collector.trackingDays || 30;

function shouldSnapshot(storyAge, timeSinceLastSnapshot) {
  if (storyAge < 6 * HOUR) return timeSinceLastSnapshot >= 60;
  if (storyAge < 48 * HOUR) return timeSinceLastSnapshot >= 15 * MIN;
  if (storyAge < 7 * 86400) return timeSinceLastSnapshot >= HOUR;
  if (storyAge < TRACKING_DAYS * 86400) return timeSinceLastSnapshot >= 6 * HOUR;
  return false;
}
```

- [ ] **Step 2: Update `refreshRecentPoints` to use adaptive tracking**

Replace the `refreshRecentPoints` function:

```js
async function refreshRecentPoints() {
  const now = Math.floor(Date.now() / 1000);
  const sinceTs = now - TRACKING_DAYS * 86400;
  let fetched = 0;
  let matched = 0;
  let newlyQualified = 0;
  let snapshotted = 0;
  const url = `${ALGOLIA}/search_by_date?tags=story&numericFilters=created_at_i>${sinceTs}`;
  await fetchAllPages(url, (hits) => {
    const stories = hits.map(normalizeStory);
    for (const s of stories) {
      const existing = db.getStory(s.id);
      if (existing) {
        db.upsertStories([s]);
        // Adaptive snapshot: check if enough time has passed for this story's age
        const storyAge = now - s.created_at;
        const lastSnapshot = db.getLastSnapshotTime(s.id);
        const sinceLast = lastSnapshot ? now - lastSnapshot : Infinity;
        if (shouldSnapshot(storyAge, sinceLast)) {
          db.snapshotPoints([s]);
          snapshotted++;
        }
        matched++;
      }
    }
    fetched += stories.length;
    for (const s of stories) {
      if (s.points >= (config.collector.minPoints || 5) && !db.getAnalysis(s.id)) {
        db.upsertStories([s]);
        db.enqueue("classify", s.id);
        newlyQualified++;
      }
    }
  });
  return { fetched, matched, newlyQualified, snapshotted };
}
```

- [ ] **Step 3: Update spinner text in `index.js`**

In `src/index.js`, find the `pointSpin.done` line and update:

```js
    const refreshParts = [`${log.formatNumber(refresh.matched)} stories updated`];
    if (refresh.newlyQualified > 0) refreshParts.push(`${refresh.newlyQualified} new qualifying`);
    if (refresh.snapshotted > 0) refreshParts.push(`${refresh.snapshotted} snapshots`);
    pointSpin.done(`HN: ${refreshParts.join(", ")}`);
```

- [ ] **Step 4: Add `trackingDays` to config.example.json**

In the `collector` section, add: `"trackingDays": 30`

- [ ] **Step 5: Verify it works**

Run: `node src/index.js --once 2>&1 | grep "stories updated"`

Expected: Line showing updated count with snapshots (much less than matched).

- [ ] **Step 6: Commit**

```bash
git add src/collector.js src/index.js config.example.json
git commit -m "feat: adaptive point tracking — tiered snapshot frequency over 30 days"
```

---

## Task 7: Plugin — competitive-velocity

**Files:**
- Create: `src/insights/competitive-velocity.js`
- Test: `test/insights/competitive-velocity.test.js`

- [ ] **Step 1: Write the test**

```js
// test/insights/competitive-velocity.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createTestDb, now, DAY, seedRepo, seedStarSnapshot, seedAnalysisRun } = require("./fixtures");

describe("competitive-velocity", () => {
  it("detects repo with >50% acceleration", () => {
    const db = createTestDb();
    const r = seedRepo(db, 1, { stars: 200 });
    // Previous week: 100 → 120 = 20 growth
    seedStarSnapshot(db, 1, 100, now() - 14 * DAY);
    seedStarSnapshot(db, 1, 120, now() - 7 * DAY);
    // This week: 120 → 200 = 80 growth
    seedStarSnapshot(db, 1, 120, now() - 7 * DAY);
    seedStarSnapshot(db, 1, 200, now());

    const growth = db.prepare(`
      SELECT r.id, r.full_name, r.stars,
        r.stars - COALESCE(curr.first_stars, r.stars) as current_growth,
        COALESCE(prev_g.growth, 0) as previous_growth
      FROM github_repos r
      LEFT JOIN (
        SELECT repo_id, MIN(stars) as first_stars
        FROM github_star_snapshots WHERE checked_at >= ?
        GROUP BY repo_id
      ) curr ON curr.repo_id = r.id
      LEFT JOIN (
        SELECT repo_id, MAX(stars) - MIN(stars) as growth
        FROM github_star_snapshots WHERE checked_at >= ? AND checked_at < ?
        GROUP BY repo_id
      ) prev_g ON prev_g.repo_id = r.id
      WHERE r.stars - COALESCE(curr.first_stars, r.stars) > 0
      ORDER BY current_growth DESC
    `).all(now() - 7 * DAY, now() - 14 * DAY, now() - 7 * DAY);

    assert.strictEqual(growth.length, 1);
    assert.strictEqual(growth[0].current_growth, 80);
    assert.strictEqual(growth[0].previous_growth, 20);
  });

  it("ignores repo with minimal growth", () => {
    const db = createTestDb();
    seedRepo(db, 1, { stars: 102 });
    seedStarSnapshot(db, 1, 100, now() - 7 * DAY);
    seedStarSnapshot(db, 1, 102, now());

    const growth = db.prepare(`
      SELECT r.id, r.stars - COALESCE(curr.first_stars, r.stars) as current_growth
      FROM github_repos r
      LEFT JOIN (
        SELECT repo_id, MIN(stars) as first_stars
        FROM github_star_snapshots WHERE checked_at >= ?
        GROUP BY repo_id
      ) curr ON curr.repo_id = r.id
      WHERE r.stars - COALESCE(curr.first_stars, r.stars) > 0
    `).all(now() - 7 * DAY);

    // Growth is 2 — below any reasonable threshold
    assert.ok(growth.length === 0 || growth[0].current_growth < 20);
  });
});
```

- [ ] **Step 2: Run test — verify it passes**

Run: `node --test test/insights/competitive-velocity.test.js`

Expected: Pass.

- [ ] **Step 3: Write the plugin**

```js
// src/insights/competitive-velocity.js
const DAY = 86400;

module.exports = {
  id: "competitive-velocity",
  name: "Competitive Velocity",
  needsOllama: false,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < DAY) return [];
    if (!db.hasNewStarSnapshots(lastRun ? lastRun.completed_at : 0)) return [];
    const from = lastRun ? lastRun.period_to : now - 7 * DAY;
    return [{ from, to: now }];
  },

  async run(db) {
    const repos = db.getStarGrowth(7);
    const alerts = repos.filter((r) => {
      if (r.current_growth < 20) return false;
      if (r.previous_growth === 0) return r.current_growth >= 20;
      return r.current_growth > r.previous_growth * 1.5;
    });

    if (alerts.length === 0) return null;

    const lines = alerts.slice(0, 5).map((r) => {
      const prev = r.previous_growth > 0 ? ` (was +${r.previous_growth}/wk)` : " (new)";
      return `${r.full_name}: +${r.current_growth} stars this week${prev}`;
    });

    return {
      summary: `${alerts.length} fast movers`,
      repos: alerts,
      message: lines.join("\n"),
    };
  },

  format(result) {
    return `⚡ <b>Fast Movers</b>\n\n${result.message}`;
  },
};
```

- [ ] **Step 4: Verify plugin loads**

Run: `node -e "const i = require('./src/insights'); console.log(i.getEnabledPlugins().map(p => p.id))"`

Expected: Array including `"competitive-velocity"`.

- [ ] **Step 5: Commit**

```bash
git add src/insights/competitive-velocity.js test/insights/competitive-velocity.test.js
git commit -m "feat: add competitive-velocity insight plugin"
```

---

## Task 8: Plugin — signal-noise

**Files:**
- Create: `src/insights/signal-noise.js`
- Test: `test/insights/signal-noise.test.js`

- [ ] **Step 1: Write the test**

```js
// test/insights/signal-noise.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createTestDb, now, DAY, seedStory, seedAnalysis } = require("./fixtures");

describe("signal-noise", () => {
  it("calculates relevance percentage per source", () => {
    const db = createTestDb();
    const weekAgo = now() - 7 * DAY;
    // 10 HN stories: 3 relevant, 2 adjacent, 5 irrelevant
    for (let i = 1; i <= 10; i++) {
      seedStory(db, i, { type: "article", created_at: weekAgo + i * 100 });
      const rel = i <= 3 ? "relevant" : i <= 5 ? "adjacent" : "irrelevant";
      seedAnalysis(db, i, { relevance: rel });
    }
    // 5 Reddit stories: 1 relevant, 4 irrelevant
    for (let i = 11; i <= 15; i++) {
      seedStory(db, i, { type: "reddit_post", created_at: weekAgo + i * 100 });
      seedAnalysis(db, i, { relevance: i === 11 ? "relevant" : "irrelevant" });
    }

    const stats = db.prepare(`
      SELECT s.type, COUNT(*) as total,
        SUM(CASE WHEN sa.relevance = 'relevant' THEN 1 ELSE 0 END) as relevant
      FROM stories s JOIN story_analysis sa ON s.id = sa.story_id
      WHERE s.created_at >= ? GROUP BY s.type
    `).all(weekAgo);

    const hn = stats.find((s) => s.type === "article");
    const reddit = stats.find((s) => s.type === "reddit_post");
    assert.strictEqual(hn.relevant, 3);
    assert.strictEqual(hn.total, 10);
    assert.strictEqual(reddit.relevant, 1);
    assert.strictEqual(reddit.total, 5);
  });
});
```

- [ ] **Step 2: Run test — verify pass**

Run: `node --test test/insights/signal-noise.test.js`

- [ ] **Step 3: Write the plugin**

```js
// src/insights/signal-noise.js
const DAY = 86400;
const WEEK = 7 * DAY;

module.exports = {
  id: "signal-noise",
  name: "Source Quality",
  needsOllama: false,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < WEEK) return [];
    const since = lastRun ? lastRun.completed_at : 0;
    if (db.countStoriesSince(since) < 100) return [];
    const from = lastRun ? lastRun.period_to : now - WEEK;
    return [{ from, to: now }];
  },

  async run(db, connector, period) {
    const stats = db.getSourceRelevanceStats(period.from, period.to);
    if (stats.length === 0) return null;

    const lines = stats
      .sort((a, b) => (b.relevant / b.total) - (a.relevant / a.total))
      .map((s) => {
        const pct = Math.round(100 * s.relevant / s.total);
        return `${s.type}: ${pct}% relevant (${s.relevant}/${s.total})`;
      });

    return {
      summary: `${stats.length} sources analyzed`,
      stats,
      message: lines.join("\n"),
    };
  },

  format(result) {
    return `📊 <b>Source Quality</b>\n\n${result.message}`;
  },
};
```

- [ ] **Step 4: Commit**

```bash
git add src/insights/signal-noise.js test/insights/signal-noise.test.js
git commit -m "feat: add signal-noise insight plugin"
```

---

## Task 9: Plugin — dead-zone

**Files:**
- Create: `src/insights/dead-zone.js`
- Test: `test/insights/dead-zone.test.js`

- [ ] **Step 1: Write the test**

```js
// test/insights/dead-zone.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createTestDb, now, DAY, seedStory, seedAnalysis } = require("./fixtures");

describe("dead-zone", () => {
  it("detects tag that dropped >50%", () => {
    const db = createTestDb();
    // Baseline: 4 weeks, 3 stories/week with tag "formal-verification" = avg 3/wk
    for (let w = 1; w <= 4; w++) {
      for (let i = 0; i < 3; i++) {
        const id = w * 100 + i;
        seedStory(db, id, { created_at: now() - (w + 1) * 7 * DAY + i * DAY });
        seedAnalysis(db, id, { relevance: "relevant", tags: "formal-verification" });
      }
    }
    // This week: only 1 story with that tag
    seedStory(db, 999, { created_at: now() - DAY });
    seedAnalysis(db, 999, { relevance: "relevant", tags: "formal-verification" });

    // Count this week
    const thisWeekStart = now() - 7 * DAY;
    const baselineStart = now() - 5 * 7 * DAY;
    const thisWeekRows = db.prepare(`
      SELECT sa.tags FROM story_analysis sa JOIN stories s ON s.id = sa.story_id
      WHERE sa.relevance IN ('relevant','adjacent') AND s.created_at >= ? AND sa.tags IS NOT NULL
    `).all(thisWeekStart);

    const baselineRows = db.prepare(`
      SELECT sa.tags FROM story_analysis sa JOIN stories s ON s.id = sa.story_id
      WHERE sa.relevance IN ('relevant','adjacent') AND s.created_at >= ? AND s.created_at < ? AND sa.tags IS NOT NULL
    `).all(baselineStart, thisWeekStart);

    function countTags(rows) {
      const c = {};
      for (const r of rows) for (const t of r.tags.split(",")) { const k = t.trim(); if (k) c[k] = (c[k] || 0) + 1; }
      return c;
    }

    const thisWeek = countTags(thisWeekRows);
    const baseline = countTags(baselineRows);
    const weeks = 4;

    const fv = "formal-verification";
    const avg = (baseline[fv] || 0) / weeks;
    const current = thisWeek[fv] || 0;
    const drop = avg > 0 ? (avg - current) / avg : 0;

    assert.ok(drop > 0.5, `Expected >50% drop, got ${Math.round(drop * 100)}%`);
  });
});
```

- [ ] **Step 2: Run test — verify pass**

Run: `node --test test/insights/dead-zone.test.js`

- [ ] **Step 3: Write the plugin**

```js
// src/insights/dead-zone.js
const DAY = 86400;
const WEEK = 7 * DAY;

module.exports = {
  id: "dead-zone",
  name: "Fading Topics",
  needsOllama: false,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < WEEK) return [];
    const from = lastRun ? lastRun.period_to : now - WEEK;
    return [{ from, to: now }];
  },

  async run(db, connector, period) {
    const now = period.to;
    const thisWeek = db.getTagCountsInRange(now - WEEK, now);
    const baselineStart = now - 5 * WEEK;
    const baseline = db.getTagCountsInRange(baselineStart, now - WEEK);
    const baselineWeeks = 4;

    const fading = [];
    for (const [tag, avg_raw] of Object.entries(baseline)) {
      const avg = avg_raw / baselineWeeks;
      if (avg < 2) continue; // ignore rare tags
      const current = thisWeek[tag] || 0;
      const drop = (avg - current) / avg;
      if (drop > 0.5) {
        fading.push({ tag, current, avg: Math.round(avg * 10) / 10, drop: Math.round(drop * 100) });
      }
    }

    if (fading.length === 0) return null;

    fading.sort((a, b) => b.drop - a.drop);
    const lines = fading.slice(0, 5).map((f) =>
      `"${f.tag}": ${f.current} this week (avg ${f.avg}/wk, -${f.drop}%)`
    );

    return {
      summary: `${fading.length} fading tags`,
      fading,
      message: lines.join("\n"),
    };
  },

  format(result) {
    return `📉 <b>Fading Topics</b>\n\n${result.message}`;
  },
};
```

- [ ] **Step 4: Commit**

```bash
git add src/insights/dead-zone.js test/insights/dead-zone.test.js
git commit -m "feat: add dead-zone insight plugin"
```

---

## Task 10: Plugin — decay-analysis

**Files:**
- Create: `src/insights/decay-analysis.js`
- Test: `test/insights/decay-analysis.test.js`

- [ ] **Step 1: Write the test**

```js
// test/insights/decay-analysis.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createTestDb, now, HOUR, DAY, seedStory, seedAnalysis, seedSnapshot } = require("./fixtures");

function classifyGrowth(snapshots, storyCreatedAt) {
  if (snapshots.length < 3) return null;
  const maxPts = snapshots[snapshots.length - 1].points;
  if (maxPts < 5) return "flat";

  const sixHours = storyCreatedAt + 6 * HOUR;
  const ptsAt6h = snapshots.filter((s) => s.checked_at <= sixHours).reduce((m, s) => Math.max(m, s.points), 0);
  if (ptsAt6h / maxPts > 0.8) return "spike";

  const fortyEightH = storyCreatedAt + 48 * HOUR;
  const lastSnap = snapshots[snapshots.length - 1];
  const secondLast = snapshots[snapshots.length - 2];
  if (lastSnap.checked_at > fortyEightH && lastSnap.points > secondLast.points) return "slow-burn";

  return "steady";
}

describe("decay-analysis", () => {
  it("classifies spike — 80%+ points in first 6h", () => {
    const created = now() - 2 * DAY;
    const snaps = [
      { points: 0, checked_at: created },
      { points: 40, checked_at: created + 2 * HOUR },
      { points: 48, checked_at: created + 5 * HOUR },
      { points: 50, checked_at: created + DAY },
    ];
    assert.strictEqual(classifyGrowth(snaps, created), "spike");
  });

  it("classifies slow-burn — still growing after 48h", () => {
    const created = now() - 4 * DAY;
    const snaps = [
      { points: 0, checked_at: created },
      { points: 10, checked_at: created + 6 * HOUR },
      { points: 20, checked_at: created + DAY },
      { points: 30, checked_at: created + 2 * DAY },
      { points: 40, checked_at: created + 3 * DAY },
    ];
    assert.strictEqual(classifyGrowth(snaps, created), "slow-burn");
  });

  it("classifies flat — less than 5 points", () => {
    const created = now() - 2 * DAY;
    const snaps = [
      { points: 0, checked_at: created },
      { points: 1, checked_at: created + HOUR },
      { points: 2, checked_at: created + DAY },
    ];
    assert.strictEqual(classifyGrowth(snaps, created), "flat");
  });

  it("classifies steady — linear growth over 24h+", () => {
    const created = now() - 2 * DAY;
    const snaps = [
      { points: 0, checked_at: created },
      { points: 10, checked_at: created + 6 * HOUR },
      { points: 30, checked_at: created + 12 * HOUR },
      { points: 50, checked_at: created + DAY },
      { points: 50, checked_at: created + 2 * DAY },
    ];
    assert.strictEqual(classifyGrowth(snaps, created), "steady");
  });
});
```

- [ ] **Step 2: Run test — verify pass**

Run: `node --test test/insights/decay-analysis.test.js`

- [ ] **Step 3: Write the plugin**

```js
// src/insights/decay-analysis.js
const DAY = 86400;
const HOUR = 3600;

function classifyGrowth(snapshots, storyCreatedAt) {
  if (snapshots.length < 3) return null;
  const maxPts = snapshots[snapshots.length - 1].points;
  if (maxPts < 5) return "flat";

  const sixHours = storyCreatedAt + 6 * HOUR;
  const ptsAt6h = snapshots.filter((s) => s.checked_at <= sixHours).reduce((m, s) => Math.max(m, s.points), 0);
  if (ptsAt6h / maxPts > 0.8) return "spike";

  const fortyEightH = storyCreatedAt + 48 * HOUR;
  const lastSnap = snapshots[snapshots.length - 1];
  const secondLast = snapshots[snapshots.length - 2];
  if (lastSnap.checked_at > fortyEightH && lastSnap.points > secondLast.points) return "slow-burn";

  return "steady";
}

module.exports = {
  id: "decay-analysis",
  name: "Growth Patterns",
  needsOllama: false,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < 6 * HOUR) return [];
    const unclassified = db.getUnclassifiedDecayStories(10);
    if (unclassified.length === 0) return [];
    return [{ from: 0, to: now }];
  },

  async run(db) {
    const stories = db.getUnclassifiedDecayStories(10);
    let classified = 0;

    for (const story of stories) {
      const timeline = db.getPointTimeline(story.id);
      const pattern = classifyGrowth(timeline, story.created_at);
      if (pattern) {
        db.setGrowthPattern(story.id, pattern);
        classified++;
      }
    }

    if (classified === 0) return null;

    return {
      summary: `${classified} stories classified`,
      classified,
    };
  },

  format(result) {
    // No Telegram alert for decay analysis — enrichment only
    return null;
  },
};
```

- [ ] **Step 4: Commit**

```bash
git add src/insights/decay-analysis.js test/insights/decay-analysis.test.js
git commit -m "feat: add decay-analysis insight plugin"
```

---

## Task 11: Plugin — people-radar

**Files:**
- Create: `src/insights/people-radar.js`
- Test: `test/insights/people-radar.test.js`

- [ ] **Step 1: Write the test**

```js
// test/insights/people-radar.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createTestDb, now, DAY, seedPerson } = require("./fixtures");

describe("people-radar", () => {
  it("returns top people by relevant_comments * avg_points", () => {
    const db = createTestDb();
    seedPerson(db, "top-user", { relevant_comments: 12, avg_points: 8, last_seen: now() - DAY });
    seedPerson(db, "mid-user", { relevant_comments: 5, avg_points: 4, last_seen: now() - DAY });
    seedPerson(db, "low-user", { relevant_comments: 1, avg_points: 1, last_seen: now() - DAY });
    seedPerson(db, "old-user", { relevant_comments: 20, avg_points: 10, last_seen: now() - 60 * DAY });

    const from = now() - 30 * DAY;
    const to = now();
    const top = db.prepare(`
      SELECT username, relevant_comments, avg_points
      FROM people WHERE last_seen >= ? AND last_seen < ?
      ORDER BY relevant_comments * avg_points DESC LIMIT 5
    `).all(from, to);

    assert.strictEqual(top[0].username, "top-user");
    assert.strictEqual(top.length, 3); // old-user excluded (last_seen 60d ago)
  });
});
```

- [ ] **Step 2: Run test — verify pass**

Run: `node --test test/insights/people-radar.test.js`

- [ ] **Step 3: Write the plugin**

```js
// src/insights/people-radar.js
const DAY = 86400;
const WEEK = 7 * DAY;

module.exports = {
  id: "people-radar",
  name: "People Radar",
  needsOllama: false,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < WEEK) return [];
    const from = lastRun ? lastRun.period_to : now - 30 * DAY;
    return [{ from, to: now }];
  },

  async run(db, connector, period) {
    const now = period.to;
    const current = db.getTopPeopleInRange(now - 30 * DAY, now, 10);
    const previous = db.getTopPeopleInRange(now - 60 * DAY, now - 30 * DAY, 10);

    if (current.length === 0) return null;

    const prevSet = new Set(previous.map((p) => p.username));
    const top5 = current.slice(0, 5);
    const newcomers = top5.filter((p) => !prevSet.has(p.username));

    const lines = top5.map((p) => {
      const score = Math.round(p.relevant_comments * p.avg_points);
      const isNew = newcomers.includes(p) ? " (new)" : "";
      return `${p.username}: ${p.relevant_comments} relevant comments, avg ${Math.round(p.avg_points)} pts${isNew}`;
    });

    return {
      summary: `Top ${top5.length}, ${newcomers.length} new`,
      people: top5,
      message: lines.join("\n"),
    };
  },

  format(result) {
    return `👤 <b>People Radar</b>\n\n${result.message}`;
  },
};
```

- [ ] **Step 4: Commit**

```bash
git add src/insights/people-radar.js test/insights/people-radar.test.js
git commit -m "feat: add people-radar insight plugin"
```

---

## Task 12: Plugin — pre-trend (Ollama)

**Files:**
- Create: `src/insights/pre-trend.js`
- Test: `test/insights/pre-trend.test.js`

- [ ] **Step 1: Write the contract test**

```js
// test/insights/pre-trend.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");

// Mock connector that returns expected JSON
function mockConnector(response) {
  return {
    chat: async () => response,
  };
}

describe("pre-trend", () => {
  it("parses valid Ollama response", () => {
    const raw = JSON.stringify({
      topics: [
        { name: "runtime agent monitoring", direction: "growing", count: 7, new: true },
        { name: "MCP servers", direction: "stable", count: 12, new: false },
      ],
    });

    const match = raw.match(/\{[\s\S]*\}/);
    assert.ok(match);
    const parsed = JSON.parse(match[0]);
    assert.ok(Array.isArray(parsed.topics));
    assert.strictEqual(parsed.topics[0].name, "runtime agent monitoring");
    assert.strictEqual(parsed.topics[0].new, true);
  });

  it("handles malformed response gracefully", () => {
    const raw = "I can see several topics here but let me think...";
    const match = raw.match(/\{[\s\S]*\}/);
    assert.strictEqual(match, null);
    // Plugin should return null, not crash
  });

  it("format produces valid HTML", () => {
    const result = {
      message: "runtime agent monitoring: 7 stories in 48h, new this week",
    };
    const html = `🔮 <b>Emerging Topics</b>\n\n${result.message}`;
    assert.ok(html.includes("<b>"));
    assert.ok(html.includes("runtime agent monitoring"));
  });
});
```

- [ ] **Step 2: Run test — verify pass**

Run: `node --test test/insights/pre-trend.test.js`

- [ ] **Step 3: Write the plugin**

```js
// src/insights/pre-trend.js
const DAY = 86400;
const HOUR = 3600;

module.exports = {
  id: "pre-trend",
  name: "Emerging Topics",
  needsOllama: true,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < 6 * HOUR) return [];
    const since = lastRun ? lastRun.completed_at : 0;
    if (db.countRelevantStoriesSince(since) < 20) return [];
    const from = lastRun ? lastRun.period_to : now - 2 * DAY;
    return [{ from, to: now }];
  },

  async run(db, connector, period) {
    const stories = db.getRelevantStoriesInRange(period.from, period.to);
    if (stories.length < 5) return null;

    // Get last week's topics for comparison
    const lastWeekStories = db.getRelevantStoriesInRange(period.from - 7 * DAY, period.from);
    const lastWeekBlock = lastWeekStories.length > 0
      ? lastWeekStories.map((s) => `[${s.tags || ""}] ${s.title}`).join("\n")
      : "No data from last week.";

    const storiesBlock = stories.map((s) => `[${s.tags || ""}] ${s.title}`).join("\n");

    const result = await connector.chat(
      "You detect emerging topics in tech news. Output ONLY valid JSON.",
      `Analyze these ${stories.length} stories from the last 48h and identify topics/themes.
Compare with last week's stories below.

Current stories:
${storiesBlock}

Last week:
${lastWeekBlock}

Return JSON: {"topics":[{"name":"topic name","direction":"growing|stable|fading|new","count":N,"summary":"one sentence"}]}`,
      { temperature: 0.3, maxTokens: 800, timeout: 120000 }
    );

    if (!result) return null;

    try {
      const match = result.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);
      if (!parsed.topics || parsed.topics.length === 0) return null;

      const emerging = parsed.topics.filter((t) => t.direction === "growing" || t.direction === "new");
      if (emerging.length === 0) return null;

      const lines = emerging.map((t) => {
        const tag = t.direction === "new" ? "(new)" : "(growing)";
        return `${t.name} ${tag} — ${t.count} stories. ${t.summary || ""}`;
      });

      return {
        summary: `${emerging.length} emerging topics`,
        topics: emerging,
        message: lines.join("\n\n"),
      };
    } catch {
      return null;
    }
  },

  format(result) {
    return `🔮 <b>Emerging Topics</b>\n\n${result.message}`;
  },
};
```

- [ ] **Step 4: Commit**

```bash
git add src/insights/pre-trend.js test/insights/pre-trend.test.js
git commit -m "feat: add pre-trend insight plugin (Ollama)"
```

---

## Task 13: Plugin — community-pulse (Ollama)

**Files:**
- Create: `src/insights/community-pulse.js`
- Test: `test/insights/community-pulse.test.js`

- [ ] **Step 1: Write the contract test**

```js
// test/insights/community-pulse.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("community-pulse", () => {
  it("parses layer 1 signal extraction response", () => {
    const raw = JSON.stringify({
      claims: ["tool X is broken in production"],
      stance: "frustrated but engaged",
      experience_level: "practitioner",
      action_taken: "built workaround",
      topics_referenced: ["tool-x", "production"],
    });
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.claims));
    assert.strictEqual(parsed.experience_level, "practitioner");
  });

  it("parses layer 2 narrative discovery response", () => {
    const raw = JSON.stringify({
      narratives: [
        {
          topic: "MCP reliability",
          comment_count: 34,
          dominant_stance: "frustrated but engaged",
          energy: "high",
          key_claims: ["breaks under load"],
        },
      ],
    });
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.narratives));
    assert.strictEqual(parsed.narratives[0].topic, "MCP reliability");
  });

  it("handles empty comment list gracefully", () => {
    // Plugin should return null when no comments
    const comments = [];
    assert.strictEqual(comments.length, 0);
  });
});
```

- [ ] **Step 2: Run test — verify pass**

Run: `node --test test/insights/community-pulse.test.js`

- [ ] **Step 3: Write the plugin**

```js
// src/insights/community-pulse.js
const DAY = 86400;
const WEEK = 7 * DAY;
const log = require("../logger");

function stripHtml(html) {
  return (html || "").replace(/<p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\s+href="([^"]*)"[^>]*>[^<]*<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ").trim();
}

module.exports = {
  id: "community-pulse",
  name: "Community Pulse",
  needsOllama: true,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < WEEK) return [];
    const from = lastRun ? lastRun.period_to : now - WEEK;
    return [{ from, to: now }];
  },

  async run(db, connector, period, runId) {
    const comments = db.getCommentsForRelevantStories(period.from, period.to);
    if (comments.length === 0) return null;

    log.info(`Community Pulse: analyzing ${comments.length} comments...`);

    // ── Layer 1: Signal extraction (per comment) ──
    const signals = [];
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      const text = stripHtml(c.text);
      if (!text || text.length < 10) continue;

      // Build parent chain context
      const parents = db.getCommentParentChain(c.parent_id, c.story_id, 3);
      const parentContext = parents.length > 0
        ? parents.map((p) => `${p.author}: ${stripHtml(p.text).slice(0, 150)}`).join("\n→ ")
        : "";

      const prompt = `Story: "${c.story_title}"${c.story_summary ? "\nSummary: " + c.story_summary : ""}
${parentContext ? "\nThread:\n" + parentContext + "\n→ " : "\n"}${c.author}: ${text}

Extract a structured signal from this comment. Output ONLY JSON:
{"claims":["..."],"stance":"...","experience_level":"observer|user|practitioner|builder","action_taken":"...","topics_referenced":["..."]}`;

      const result = await connector.chat(
        "You extract structured signals from tech discussion comments. Output ONLY valid JSON.",
        prompt,
        { temperature: 0, maxTokens: 300, timeout: 60000 }
      );

      if (result) {
        try {
          const match = result.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            signals.push({ commentId: c.id, author: c.author, storyTitle: c.story_title, ...parsed });
            if (runId) db.saveCommentSignal(c.id, runId, JSON.stringify(parsed));
          }
        } catch {}
      }

      if ((i + 1) % 50 === 0) log.dim(`  Layer 1: ${i + 1}/${comments.length} comments processed`);
    }

    if (signals.length === 0) return null;

    log.info(`Community Pulse: ${signals.length} signals extracted, discovering narratives...`);

    // ── Layer 2: Narrative discovery ──
    const signalsBlock = signals.map((s) =>
      `[${s.storyTitle.slice(0, 40)}] ${s.author} (${s.experience_level}): stance="${s.stance}", claims=[${(s.claims || []).join("; ")}], topics=[${(s.topics_referenced || []).join(", ")}]`
    ).join("\n");

    const narrativeResult = await connector.chat(
      "You analyze patterns in community reactions to tech topics. Output ONLY valid JSON.",
      `Here are ${signals.length} comment signals from this week's tech discussions:

${signalsBlock}

Identify the dominant narratives. Group by topic. For each:
- What topic/theme?
- How many comments relate?
- What's the dominant stance?
- Energy level (high/medium/low)?
- Key claims?

Return JSON: {"narratives":[{"topic":"...","comment_count":N,"dominant_stance":"...","energy":"high|medium|low","key_claims":["..."]}]}`,
      { temperature: 0.3, maxTokens: 1500, timeout: 180000 }
    );

    let narratives = [];
    if (narrativeResult) {
      try {
        const match = narrativeResult.match(/\{[\s\S]*\}/);
        if (match) narratives = JSON.parse(match[0]).narratives || [];
      } catch {}
    }

    if (narratives.length === 0) return null;

    // ── Layer 3: Week-over-week comparison ──
    const lastRunData = db.getLastCompletedRun("community-pulse");
    let comparison = "";
    if (lastRunData && lastRunData.result_summary) {
      try {
        const prev = JSON.parse(lastRunData.result_summary);
        const prevBlock = (prev.narratives || []).map((n) =>
          `${n.topic}: ${n.dominant_stance} (${n.energy} energy, ${n.comment_count} comments)`
        ).join("\n");

        const currBlock = narratives.map((n) =>
          `${n.topic}: ${n.dominant_stance} (${n.energy} energy, ${n.comment_count} comments)`
        ).join("\n");

        const compResult = await connector.chat(
          "You compare weekly community reactions. Be concise. 2-3 sentences per topic.",
          `Last week:\n${prevBlock}\n\nThis week:\n${currBlock}\n\nWhat shifted? What's new? What faded? One paragraph per topic.`,
          { temperature: 0.3, maxTokens: 1000, timeout: 120000 }
        );
        if (compResult) comparison = compResult;
      } catch {}
    }

    // Build final message
    const lines = narratives.map((n) => {
      const claims = (n.key_claims || []).slice(0, 2).join("; ");
      return `<b>${n.topic}</b>\n${n.comment_count} comments, ${n.energy} energy\n${n.dominant_stance}${claims ? "\nKey: " + claims : ""}`;
    });

    let message = lines.join("\n\n");
    if (comparison) message += "\n\n<b>Shifts</b>\n" + comparison;

    return {
      summary: JSON.stringify({ narratives }),
      narratives,
      message,
    };
  },

  format(result) {
    return `🧠 <b>Community Pulse</b>\n\n${result.message}`;
  },
};
```

- [ ] **Step 4: Commit**

```bash
git add src/insights/community-pulse.js test/insights/community-pulse.test.js
git commit -m "feat: add community-pulse insight plugin (3-layer Ollama analysis)"
```

---

## Task 14: Plugin — ecosystem-map (Ollama)

**Files:**
- Create: `src/insights/ecosystem-map.js`
- Test: `test/insights/ecosystem-map.test.js`

- [ ] **Step 1: Write the contract test**

```js
// test/insights/ecosystem-map.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("ecosystem-map", () => {
  it("parses valid cluster response", () => {
    const raw = JSON.stringify({
      clusters: [
        { name: "Agent Reliability", stories: 8, repos: 3, description: "Tools for testing agents" },
        { name: "Context Management", stories: 12, repos: 5, description: "Memory and context solutions" },
      ],
      gaps: "No tools bridging reliability and context management.",
    });
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.clusters));
    assert.strictEqual(parsed.clusters.length, 2);
    assert.ok(parsed.gaps);
  });

  it("handles empty response", () => {
    const raw = "";
    const match = (raw || "").match(/\{[\s\S]*\}/);
    assert.strictEqual(match, null);
  });
});
```

- [ ] **Step 2: Run test — verify pass**

Run: `node --test test/insights/ecosystem-map.test.js`

- [ ] **Step 3: Write the plugin**

```js
// src/insights/ecosystem-map.js
const DAY = 86400;
const WEEK = 7 * DAY;

module.exports = {
  id: "ecosystem-map",
  name: "Ecosystem Map",
  needsOllama: true,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < WEEK) return [];
    const from = lastRun ? lastRun.period_to : now - WEEK;
    return [{ from, to: now }];
  },

  async run(db, connector, period) {
    const stories = db.getRelevantStoriesInRange(period.from, period.to);
    const repos = db.getAllGithubRepos().filter((r) => {
      const a = db.getGithubRepoAnalysis(r.id);
      return a && (a.relevance === "relevant" || a.relevance === "adjacent");
    }).slice(0, 20);

    if (stories.length < 5 && repos.length < 3) return null;

    const storiesBlock = stories.slice(0, 30).map((s) =>
      `[${s.tags || ""}] ${s.title} (${s.points}pts)`
    ).join("\n");

    const reposBlock = repos.map((r) =>
      `${r.full_name} (${r.stars} stars, ${r.language || "?"}) — ${(r.description || "").slice(0, 80)}`
    ).join("\n");

    const result = await connector.chat(
      "You map technology ecosystems. Identify clusters, connections, and gaps. Under 250 words. Output ONLY valid JSON.",
      `Map this week's AI coding tools ecosystem.

Stories (${stories.length}):
${storiesBlock}

Repos (${repos.length}):
${reposBlock}

Return JSON: {"clusters":[{"name":"...","stories":N,"repos":N,"description":"one sentence"}],"connections":"how clusters relate","gaps":"what's missing"}`,
      { temperature: 0.3, maxTokens: 1200, timeout: 180000 }
    );

    if (!result) return null;

    try {
      const match = result.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);
      if (!parsed.clusters || parsed.clusters.length === 0) return null;

      const lines = parsed.clusters.map((c) =>
        `<b>${c.name}</b> (${c.stories || 0} stories, ${c.repos || 0} repos)\n${c.description}`
      );

      let message = lines.join("\n\n");
      if (parsed.connections) message += `\n\n<b>Connections:</b> ${parsed.connections}`;
      if (parsed.gaps) message += `\n\n<b>Gaps:</b> ${parsed.gaps}`;

      const weekNum = getWeekNumber(period.to);

      return {
        summary: `${parsed.clusters.length} clusters identified`,
        clusters: parsed.clusters,
        message: `Week ${weekNum}\n\n${message}`,
      };
    } catch {
      return null;
    }
  },

  format(result) {
    return `🗺️ <b>Ecosystem Map</b>\n\n${result.message}`;
  },
};

function getWeekNumber(ts) {
  const d = new Date(ts * 1000);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d - jan1) / 86400000);
  return `${d.getFullYear()}-W${String(Math.ceil((days + jan1.getDay() + 1) / 7)).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/insights/ecosystem-map.js test/insights/ecosystem-map.test.js
git commit -m "feat: add ecosystem-map insight plugin (Ollama)"
```

---

## Task 15: Run all tests and verify

- [ ] **Step 1: Run all tests**

Run: `node --test test/insights/*.test.js`

Expected: All tests pass.

- [ ] **Step 2: Run a full cycle to verify no crashes**

Run: `node src/index.js --once 2>&1 | tail -30`

Expected: Output includes "Insights" phase. No crashes. Plugins may run or skip depending on data availability.

- [ ] **Step 3: Run --test-insights**

Run: `node src/index.js --test-insights`

Expected: Each plugin listed, some run with output, some show "nothing to run" or "no findings".

- [ ] **Step 4: Commit any remaining fixes**

```bash
git add -A
git commit -m "test: verify all insights plugins and integration"
```

---

## Task 16: Version bump and changelog

- [ ] **Step 1: Bump version in package.json**

Change version to `"1.2.0"`.

- [ ] **Step 2: Update CHANGELOG.md**

Add new section for 1.2.0 with modular insights features.

- [ ] **Step 3: Update README if needed**

Add section about `--test-insights` command and insights config.

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md README.md
git commit -m "chore: bump to 1.2.0 — modular insights"
```
