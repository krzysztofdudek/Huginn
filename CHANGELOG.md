# Changelog

## 1.2.0

Modular insights — 8 pluggable data analyses with intelligent scheduling.

**Insights framework**
- Registry-based plugin system: each analysis is a self-contained file in `src/insights/`
- Intelligent scheduler: plugins decide when to run based on data availability, not fixed timers
- Full run tracking in `analysis_runs` table — never lose an analysis to crashes or restarts
- Stuck run detection: recovers from mid-analysis process kills automatically
- Stampede protection: max 3 analyses per cycle after long downtime
- Per-plugin enable/disable in config, global kill switch
- `--test-insights` CLI command for dry-run verification

**8 analysis plugins**
- `competitive-velocity` — detects GitHub repos with accelerating star growth
- `signal-noise` — weekly report on relevance ratio per source (HN, Reddit, Arxiv)
- `dead-zone` — alerts when tracked topics fade (>50% drop vs 4-week baseline)
- `decay-analysis` — classifies story growth curves (spike/steady/slow-burn/flat)
- `people-radar` — weekly top contributors in your interest areas
- `pre-trend` — detects emerging topics before they trend (Ollama, every 6h)
- `community-pulse` — three-layer community reaction analysis: per-comment signal extraction, narrative discovery, week-over-week comparison (Ollama, weekly)
- `ecosystem-map` — maps topic clusters, connections, and gaps in the ecosystem (Ollama, weekly)

**Adaptive point tracking**
- Extended story tracking from 48h to 30 days with tiered snapshot frequency
- 0-6h: every cycle, 6-48h: every 15min, 2-7d: hourly, 7-30d: every 6h
- Dramatically reduces snapshot volume while preserving full growth curves

**Testing**
- 34 tests covering scheduler logic, all SQL plugins with fixture data, Ollama plugins with contract tests
- Test runner: `npm test` (Node built-in test runner, zero dependencies)

## 1.1.0

Reliable message delivery, rich logging, quiet hours fix.

**Reliable delivery**
- Every Telegram message is now saved to the database before sending
- Failed sends are retried automatically on the next cycle, in order
- Briefing story links are persisted alongside AI content — retries include full link lists
- All delivery types (briefing, weekly, rising, opportunity, reply, stars, release, competitive) now track individual message delivery status
- Parent delivery is only marked as "sent" when all its messages have been delivered

**Quiet hours unification**
- Removed dual queuing system (quiet_queue table + delivery_messages) — single source of truth
- Quiet hours now use local machine time instead of UTC (`quietHours` replaces `quietHoursUTC`)
- Messages during quiet hours stay as unsent in delivery_messages, sent automatically when quiet hours end

**Logging overhaul**
- New logger with levels (info/success/warn/error), colored icons, and structured log file
- Animated spinners show elapsed time on completion (e.g. "9 stories classified 5.6s")
- Ollama errors and timeouts are now logged with duration (previously silent)
- Analyzer, classifier, and comment analysis JSON parse failures are now logged (previously silent)
- Delivery flush reports sent/held/failed counts in terminal
- Log file uses clean format: `OK/INFO/WARN/ERROR` with ISO timestamps

**Bug fixes**
- Fixed infinite trend generation loop: delivery was created but never marked as sent, causing retry every cycle
- Increased Ollama timeouts for briefing (5 min) and trend (3 min) to prevent premature timeout on slower models

## 1.0.0

First release.

- 4 data sources: Hacker News (Algolia), GitHub (API), Reddit (RSS), Arxiv (API)
- 3-stage classification pipeline: loose filter, summarize, strict filter
- Comment analysis: flags insights, needs, and engagement opportunities
- People profiler: tracks frequent commenters in your topics
- Daily briefing with summary + full link list (must read + also relevant)
- Weekly trend report
- Real-time alerts: rising stories, engagement opportunities, thread replies
- GitHub watch: star changes and new releases on repos you follow
- Show HN competitive checks
- Telegram delivery + local markdown files
- Offline-safe: stop anytime, catches up on restart with retrospective daily briefings
- Graceful degradation: Ollama down, Telegram down, API down, nothing crashes
- Work queue with automatic retry for failed analysis tasks
- --test connectivity check, --status database stats, --backfill for older data
- Config validation with unknown key warnings
- File logging to data/huginn.log
- Local AI only (Ollama), no cloud, no subscriptions
