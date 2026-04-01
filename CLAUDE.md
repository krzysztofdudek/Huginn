# NewsVision

## What this project does

NewsVision is a command-line tool that monitors Hacker News, GitHub, Reddit, and Arxiv for topics the user cares about. It collects posts and articles from these sources, uses a local AI model (via Ollama) to figure out which ones are relevant, generates daily summaries and real-time alerts, and delivers them through Telegram messages and local markdown files.

The user configures their interests in plain language in `config.json`. The tool runs locally with no cloud dependencies beyond the source APIs.

## How the code is organized

```
src/
  index.js              Main entry point. Parses CLI args, runs the collect→analyze→deliver cycle.
  config.js             Loads config.json, merges secrets.json, applies defaults, validates.
  logger.js             Mirrors console output to data/newsvision.log.
  db.js                 SQLite database: creates tables, handles migrations, provides all queries.
  ollama.js             Talks to the local Ollama instance. Checks availability, sends prompts.

  collector.js          Fetches HN stories and comments from Algolia API.
  github-collector.js   Searches GitHub for repos by topic, checks trending, monitors watched repos.
  reddit-collector.js   Reads Reddit posts via RSS feeds (no authentication needed).
  arxiv-collector.js    Searches Arxiv for academic papers matching configured search terms.

  analyzer.js           Classifies HN/Reddit/Arxiv items as relevant/adjacent/irrelevant.
                        Summarizes articles by extracting content and sending to Ollama.
  github-analyzer.js    Classifies GitHub repos the same way.
  comments.js           Analyzes top comments on relevant stories. Flags insights, needs, opportunities.
  people.js             Builds profiles of frequent commenters (SQL aggregation, no AI).

  intelligence.js       Generates daily briefings, weekly trends, rising alerts, opportunity alerts,
                        thread reply monitoring, GitHub watch alerts, competitive checks.
  delivery.js           Formats and sends Telegram messages. Also writes markdown files to output/.
```

## Key files a developer would edit

- **`config.json`** — All user-configurable behavior. Interests, tags, sources, thresholds. This is the main file users customize.
- **`secrets.json`** — Telegram bot token and GitHub token. Not committed to git.
- **`src/analyzer.js`** — Contains the Ollama prompts for classifying stories. Edit these to change how strictly things are filtered.
- **`src/comments.js`** — Contains the prompt for analyzing comments. Controls what counts as an "insight" or "opportunity."
- **`src/intelligence.js`** — Contains the prompt for generating daily briefings. Controls the format and length of summaries.
- **`src/github-analyzer.js`** — Prompt for classifying GitHub repos.

## How to add a new data source

1. Create `src/new-collector.js` with a `collect()` function that fetches data and stores it using `db.upsertStories()` or a new table
2. Add any new tables to `src/db.js` in the `migrate()` function
3. Add the collector to the collect phase in `src/index.js`
4. Items stored as stories go through the existing classification pipeline automatically

## How to add a new type of alert

1. Add detection logic to `src/intelligence.js` (query the DB, check conditions)
2. Add a delivery format to `src/delivery.js` (Telegram message + markdown file)
3. Wire it into the intelligence phase in `src/index.js`

## Database

Single SQLite file at `data/db`. Main tables:

- `stories` — posts from HN, Reddit, Arxiv (unified, with a `type` column to distinguish)
- `comments` — HN comments
- `story_analysis` — classification results (relevance, summary, tags)
- `comment_analysis` — flagged comments (insight/need/opportunity)
- `github_repos` — discovered GitHub repositories
- `github_repo_analysis` — repo classification results
- `work_queue` — retry-able async work items (classify, summarize, analyze comments)
- `deliveries` — generated briefings and alerts, with sent/unsent tracking
- `cursors` — progress tracking (timestamps for each collector and intelligence product)
- `point_snapshots` — historical point values for rising detection
- `people` — commenter profiles (aggregated from comment data)

## Design principles

1. **Everything is resumable.** The app can be stopped and restarted at any time. Progress is tracked by cursors in the database.
2. **Everything degrades gracefully.** If Ollama is down, data still collects. If Telegram is down, briefings save to files. If GitHub API is exhausted, other sources keep working.
3. **Retrospective processing.** If the app was off for a week, it generates 7 separate daily briefings on restart, not one combined summary.
4. **Work queue with retry.** All AI processing (classification, summarization, comment analysis) goes through a queue. Failed items retry automatically on the next cycle.
5. **No secrets in committed files.** `config.json` is safe to commit. `secrets.json` is gitignored.
6. **Configuration is forgiving.** Missing fields get defaults. Empty arrays disable features. Nothing crashes on partial config.
