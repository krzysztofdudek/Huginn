# Modular Insights — Design Spec

## Summary

Add 8 pluggable data analyses to Huginn that detect patterns in collected data and send alerts via Telegram. Each analysis is a self-contained plugin file with a uniform interface. A central scheduler decides when to run each one based on data availability — not fixed timers. All runs are tracked in the database for reliability: if a run fails or the app is killed mid-analysis, it retries automatically.

Also: extend point tracking from 48h to 30 days with adaptive frequency so decay curves and long-tail patterns are visible.

## Architecture

### Registry Pattern

Each analysis lives in its own file under `src/insights/`. A scheduler in `src/insights.js` auto-discovers them (same pattern as `src/connectors/`), checks which are enabled in config, and runs them when conditions are met.

```
src/
  insights.js              Scheduler: discovery, shouldRun, run, track
  insights/
    pre-trend.js
    competitive-velocity.js
    signal-noise.js
    dead-zone.js
    decay-analysis.js
    people-radar.js
    sentiment-drift.js
    ecosystem-map.js
```

### Plugin Interface

Every plugin exports:

```js
module.exports = {
  id: "pre-trend",
  name: "Emerging Topics",

  // When to run. Returns array of periods to process (empty = skip).
  // lastRun is the most recent analysis_runs row for this plugin, or null.
  shouldRun(db, lastRun) {
    // Example: run every 6h if 20+ new stories
    if (!lastRun) return [{ from: 0, to: now }];
    const elapsed = now - lastRun.completed_at;
    if (elapsed < 6 * 3600) return [];
    const newStories = db.countStoriesSince(lastRun.completed_at);
    if (newStories < 20) return [];
    return [{ from: lastRun.period_to, to: now }];
  },

  // Run the analysis. Returns result object or null (nothing interesting).
  async run(db, connector, period) {
    // ... analysis logic
    return { message: "...", data: {...} };
  },

  // Format result for Telegram. Returns HTML string.
  format(result) {
    return `🔮 <b>Emerging topic</b>\n\n${result.message}`;
  },
};
```

### Scheduler Flow

Called every cycle from `index.js`, after the Intelligence phase:

```
insights.runDue():
  // 1. Recover stuck runs (process killed mid-analysis)
  mark runs with status='running' and created_at > 1h ago as 'failed'

  // 2. For each enabled plugin:
  periods = plugin.shouldRun(db, lastRun)
  if periods empty → skip

  // 3. Process periods sequentially, oldest first, max 3 per cycle
  for period in periods (up to maxPerCycle):
    db.startAnalysisRun(plugin.id, period)     → status: running
    try:
      result = await plugin.run(db, connector, period)
      if result:
        db.completeAnalysisRun(id, summary)    → status: done
        delivery.deliverInsight(plugin, result) → into delivery_messages
      else:
        db.completeAnalysisRun(id, null)       → status: done, no alert
    catch error:
      db.failAnalysisRun(id, error.message)    → status: failed
      log.error(...)
```

### Resilience

**Kill mid-run:** On startup, scheduler finds `analysis_runs` with `status='running'` older than `stuckTimeoutMinutes` (default 60). Marks them `status='failed'`. Next `shouldRun()` cycle will include the failed period.

**Ollama down:** `run()` throws or returns null. Marked `failed`. No retry limit — plugin tries again at its natural interval (every 6h, every week, etc.). When Ollama comes back, it catches up.

**No abandoned state:** Failed runs are never abandoned. `shouldRun()` returns all periods that haven't completed successfully, including previously failed ones. Nothing is lost.

**Stampede protection:** After long downtime, multiple plugins may be due. Scheduler runs max `maxPerCycle` (default 3) analyses per cycle. Rest wait for next cycle. Analyses run sequentially, never in parallel.

**Delivery:** Insight messages go through the existing `delivery_messages` system — same quiet hours, retry on Telegram failure, flush on next cycle.

**Error isolation:** Each plugin wrapped in try/catch. One crashing plugin doesn't block others.

### Idempotency

Each run is tied to a period `(from, to)`. A completed run for period X will not be re-run — `shouldRun()` checks `analysis_runs` for completed periods and only returns gaps.

## Database Changes (Migration 5)

```sql
CREATE TABLE analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_type TEXT NOT NULL,
  status TEXT DEFAULT 'running',   -- running / done / failed
  period_from INTEGER,
  period_to INTEGER,
  result_summary TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_ar_type ON analysis_runs(analysis_type, created_at);

ALTER TABLE story_analysis ADD COLUMN growth_pattern TEXT;
```

## Adaptive Point Tracking

Extend `refreshRecentPoints` from a flat 48h window to tiered tracking:

| Story age | Snapshot interval | Purpose |
|-----------|------------------|---------|
| 0–6h | every cycle (~60s) | Rising detection, real-time |
| 6–48h | every 15 min | High-res decay curve |
| 2–7 days | every 1h | Slow burn detection |
| 7–30 days | every 6h | Long-tail / evergreen |
| 30+ days | stop | Enough data |

Implementation: `refreshRecentPoints` already fetches stories from Algolia in bulk. For each story in the result, check when its last snapshot was taken. Only insert a new snapshot if the minimum interval for its age window has elapsed.

```js
function shouldSnapshot(storyAge, timeSinceLastSnapshot) {
  if (storyAge < 6 * HOUR) return timeSinceLastSnapshot >= 60;
  if (storyAge < 48 * HOUR) return timeSinceLastSnapshot >= 15 * MIN;
  if (storyAge < 7 * DAY) return timeSinceLastSnapshot >= HOUR;
  if (storyAge < 30 * DAY) return timeSinceLastSnapshot >= 6 * HOUR;
  return false;
}
```

The Algolia query window expands from 48h to 30 days. Configurable via `config.collector.trackingDays` (default 30).

## The 8 Plugins

### Without Ollama

**1. competitive-velocity**
- Trigger: after GitHub collect (~1h), if new star snapshots exist
- Logic: repos with largest star growth in 7 days vs prior 7 days. Alert if >50% acceleration or new repo with >20 stars/week.
- Alert: `⚡ Fast mover: owner/repo +83 stars this week (was +12/wk)`

**2. signal-noise**
- Trigger: weekly (Monday), if ≥100 new stories since last run
- Logic: `COUNT GROUP BY type` with relevance breakdown per source/subreddit.
- Alert: `📊 Source quality: r/LocalLLaMA 18% relevant, r/ClaudeAI 9%, HN 14%, arxiv 31%`

**3. dead-zone**
- Trigger: weekly, together with signal-noise
- Logic: stories per tag this week vs 4-week average. Alert if tag dropped >50%.
- Alert: `📉 Fading: "formal-verification" 3 stories this week (avg 12/wk)`

**4. decay-analysis**
- Trigger: every 6h, if stories exist with ≥10 point snapshots and no `growth_pattern` value yet. Unlike time-range analyses, this one looks for unclassified stories regardless of period — `shouldRun` returns a single synthetic period and the plugin queries for unclassified stories directly.
- Logic: classify point timeline into spike (>80% points in first 6h), steady (linear 24h+), slow-burn (still growing after 48h), flat (<5 points). Writes `growth_pattern` to `story_analysis`.
- Alert: none — enrichment data. Used by briefing/trend as context.

**5. people-radar**
- Trigger: weekly
- Logic: top 5 from `people` table by `relevant_comments × avg_points`, last 30 days. Compare with previous 30 days — who's new, who dropped.
- Alert: `👤 Worth following: user1 (12 relevant comments, avg 8pts), user2 (new this month)`

### With Ollama

**6. pre-trend**
- Trigger: every 6h, if ≥20 new relevant/adjacent stories since last run
- Logic: collect relevant stories from last 48h, send to Ollama: "What topics do you see? Compare with this list from last week. Which are growing, which are new?" Returns structured topics with direction.
- Alert: `🔮 Emerging: "runtime agent monitoring" — 7 stories in 48h, not seen last week`

**7. sentiment-drift**
- Trigger: weekly, if ≥30 comments on relevant stories
- Logic: top 20 comments (by points) from relevant stories this week → Ollama: "What's the sentiment around [top 3 tags]? Compare with these comments from last week."
- Alert: `🌡️ Sentiment shift: MCP servers — enthusiasm → frustration (complexity complaints dominate)`

**8. ecosystem-map**
- Trigger: weekly
- Logic: top 30 relevant stories + top 20 repos + tags → Ollama: "Group into thematic clusters. Dependencies between them? Gaps?"
- Alert: longer message, ~200 words. `🗺️ Ecosystem map — W16` with 3-4 clusters.

## Config

```json
{
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
      "sentiment-drift": { "enabled": true },
      "ecosystem-map": { "enabled": true }
    }
  }
}
```

Kill switch: `insights.enabled: false` disables all. Per-plugin: `"pre-trend": { "enabled": false }`. Individual plugins may accept additional parameters (e.g., `"pre-trend": { "enabled": true, "intervalHours": 12 }`).

## Changes to Existing Files

**db.js:** Migration 5 (analysis_runs table + growth_pattern column). New query functions for analysis tracking and aggregate stats.

**delivery.js:** New `deliverInsight(pluginId, content)` — creates delivery + messages, same pattern as `deliverRising`.

**index.js:** New phase after Intelligence: `log.phase("Insights"); await insights.runDue();`

**collector.js:** `refreshRecentPoints` — expand window to 30 days, add `shouldSnapshot` throttling.

**config.js:** Add `insights` to defaults and KNOWN_KEYS.

**config.example.json:** Add `insights` section.

**No changes:** intelligence.js, analyzer.js, comments.js, connectors/, ollama.js, logger.js.
