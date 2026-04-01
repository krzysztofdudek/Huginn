# NewsVision

There's too much happening in tech to follow manually. Every day, hundreds of stories appear on Hacker News, new repositories pop up on GitHub, Reddit threads multiply across subreddits, and research papers drop on Arxiv. If you're working in a specific area, like AI coding tools, you can't read all of it. You miss relevant discussions, find competitors weeks late, and lose chances to join conversations while they're still active.

NewsVision solves this by reading everything for you. It collects posts from 4 sources, uses a local AI model to figure out what matters to your work, and sends you a summary on Telegram. One message per day with everything you need to know, plus real-time alerts when something important happens.

Everything runs on your machine. No cloud. No subscriptions. Your data stays local.

## What you get on Telegram

**Every morning, one message:** a summary of what happened yesterday in your areas of interest. What's important, what's gaining traction, and which discussions you might want to join. Below the summary, a full list of links to every relevant story, so you can click through to anything that catches your eye.

**Real-time alerts when:**
- A post in your topic area suddenly gets a lot of attention (gaining 20+ points in a few hours)
- Someone writes a comment that touches on a problem you could help with
- Someone replies to one of your Hacker News comments (HN doesn't notify you about this natively)
- A new project appears on "Show HN" that competes with or complements your work
- One of your GitHub repositories gets a new release or a jump in stars

**Once a week:** a short report on trends. Which topics came up more this week, which are fading, what new tools launched.

Everything is also saved as markdown files locally, so you have a searchable archive.

## What it monitors

| Source | What it collects | How |
|--------|-----------------|-----|
| Hacker News | Stories, comments, points | Algolia API (free, no auth) |
| GitHub | New repositories by topic, trending repos, releases on repos you follow | GitHub API (free, optional token for higher limits) |
| Reddit | Posts from subreddits you choose | RSS feeds (free, no auth) |
| Arxiv | Academic papers matching your search terms | Arxiv API (free, no auth) |

## How classification works

You describe what you care about in plain language (in `config.json`). For example:

```json
"interests": [
  "AI coding agents that verify generated code against specifications",
  "Tools that enforce developer workflows mechanically, not through instructions",
  "Supply chain attacks on npm packages"
]
```

When a new story or repo comes in, the local AI model reads the title and summary and decides: is this **relevant** (directly about your topics), **adjacent** (related, worth knowing), or **irrelevant** (skip it). Only relevant and adjacent items make it into your briefing. The model runs locally through [Ollama](https://ollama.com), so nothing leaves your machine.

## Quick setup

You need: **Node.js 18+** and **[Ollama](https://ollama.com)** with a model installed.

```bash
# 1. Clone and install
git clone https://github.com/krzysztofdudek/NewsVision.git
cd NewsVision
npm install

# 2. Install an AI model (runs locally)
ollama pull qwen3.5:9b    # recommended (needs ~7GB RAM)
# or: ollama pull qwen3.5:4b  # lighter alternative (~4GB RAM)

# 3. Configure
cp config.example.json config.json
cp secrets.example.json secrets.json
# Edit config.json — set your interests, tags, subreddits, GitHub topics
# Edit secrets.json — add your Telegram bot token and (optional) GitHub PAT

# 4. Test everything connects
node src/index.js --test

# 5. Run
node src/index.js            # collects data, processes it, then polls for new content
node src/index.js --once     # runs one cycle and exits (good for cron jobs or testing)
```

### How to get a Telegram bot token

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`, follow the prompts, copy the token it gives you
3. Start a chat with your new bot (just send it any message)
4. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser
5. Find `"chat":{"id": 123456}` in the response. That number is your chat ID.
6. Put both in `secrets.json`

### How to get a GitHub token (optional)

Without a token, GitHub allows 60 API requests per hour. With one, you get 5,000. For normal use, 60 is usually enough. If you want more:

1. Go to GitHub > Settings > Developer settings > Fine-grained personal access tokens
2. Create a token with "Public Repositories (read-only)" access, no extra permissions
3. Put it in `secrets.json`

## Configuration

All behavior is controlled by two files:

**`config.json`** — what to monitor and how (safe to commit, no secrets):

| Field | What it does | Default |
|-------|-------------|---------|
| `startDate` | How far back to collect on first run. Format: `"2026-03-20"`. | `null` (starts from today) |
| `interests` | Plain language descriptions of topics you care about. This is the most important setting. | `[]` |
| `tags` | A fixed list of labels the AI picks from when categorizing stories. | `[]` |
| `hnUsername` | Your Hacker News username. If set, monitors replies to your comments. | `null` |
| `ollama.model` | Which AI model to use. Bigger = better quality, slower. | `"qwen3.5:9b"` |
| `github.topics` | GitHub topics to search for new repositories. | `[]` |
| `github.watchRepos` | Repos to monitor for stars and releases (e.g., your own). | `[]` |
| `reddit.subreddits` | Which subreddits to scan. | `[]` |
| `delivery` | How to deliver results: `"both"`, `"telegram"`, or `"file"`. | `"file"` |

**`secrets.json`** — tokens and keys (gitignored, never committed):

```json
{
  "telegram": { "botToken": "...", "chatId": "..." },
  "github": { "token": "..." }
}
```

Every field in config.json is optional. If you leave `reddit.subreddits` empty, Reddit is simply skipped. If you don't set `hnUsername`, comment monitoring is skipped. Nothing crashes on missing configuration.

## All commands

```
node src/index.js              Collect, analyze, deliver, then keep polling for new content.
node src/index.js --once       Run one full cycle and exit. Good for cron or testing.
node src/index.js --test       Check that Ollama, Telegram, GitHub, Reddit, Arxiv are reachable.
node src/index.js --status     Show what's in the database without running a cycle.
node src/index.js --briefing   Force-generate today's daily briefing.
node src/index.js --trend      Force-generate this week's trend report.
node src/index.js --reset      Delete all analysis results. Raw collected data is kept.
node src/index.js --help       Show command help.
```

## How it works internally

```
  Collect                  Analyze                    Deliver
  ──────────              ──────────                 ─────────
  HN stories    ──┐       Classify (relevant?)  ──┐  Daily briefing + links
  HN comments   ──┤       Summarize articles    ──┤  Weekly trend report
  GitHub repos  ──┼──→    Classify repos        ──┼──→  Rising alerts
  Reddit posts  ──┤       Analyze comments      ──┤  Opportunity alerts
  Arxiv papers  ──┘       Profile people        ──┘  Reply notifications
                                                     Competitor checks
                                                     Star/release alerts
```

Data flows left to right. Each step saves results to a local SQLite database. If any step fails (Ollama is down, internet drops), the work queues up and processes when the service returns. You can stop the app anytime with Ctrl+C and restart it later. It picks up where it left off.

All logs are saved to `data/newsvision.log`.

## Stopping and restarting

The app is designed to be turned on and off freely. Everything is saved to the database.

- **Ctrl+C** stops the app. Next time you run it, it continues from where it stopped.
- **Offline for days?** On restart, it fetches everything it missed and generates separate daily briefings for each missed day (not one big summary).
- **Ollama crashes?** Data collection continues. Analysis queues up and runs when Ollama comes back.
- **Telegram is down?** Briefings generate as markdown files. They send to Telegram once it's reachable.

## License

MIT
