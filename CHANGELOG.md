# Changelog

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
