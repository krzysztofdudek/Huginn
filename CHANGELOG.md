# Changelog

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
