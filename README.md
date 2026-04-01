# NewsVision

You work in tech. You have specific topics you need to stay on top of. Maybe it's AI coding tools. Maybe it's security. Maybe it's frontend frameworks. Whatever it is, keeping up is a full-time job you don't have time for.

Every day, hundreds of posts appear on Hacker News. New projects pop up on GitHub. Reddit threads multiply. Research papers drop. You can't read all of it. So you miss things. A tool that solves your exact problem gets posted and you find it three weeks later. Someone asks a question you could have answered, but by the time you see it, the conversation is dead.

NewsVision fixes this. You tell it what you care about, in plain English. It reads everything, figures out what matters to you, and sends you one message a day with a summary and links. If something blows up or someone says something you should respond to, it tells you right away.

It runs on your computer. No cloud service. No subscription. No data leaves your machine except the Telegram messages it sends you.

## What you actually get

**One message every morning.** A summary of what happened yesterday in your areas. What's important, what's gaining traction, which conversations might be worth joining. Below that, links to every relevant story so you can click into anything that looks interesting.

**Instant alerts when something happens:**
- A post in your area suddenly takes off
- Someone writes a comment you'd want to respond to
- Someone replies to your Hacker News comment (HN doesn't tell you this on its own)
- A new project launches that does something similar to what you're building
- A GitHub repo you follow gets a new release or a spike in stars

**A weekly trend report.** What topics grew this week, what faded, what new tools appeared.

## Where it gets its information

It pulls from four places:

- **Hacker News** — stories, comments, and votes
- **GitHub** — new repositories matching your topics, trending repos, releases on repos you follow
- **Reddit** — posts from subreddits you pick
- **Arxiv** — academic papers matching your search terms

All of these are free public APIs. No accounts needed (except an optional GitHub token if you want faster API access).

## How it decides what's relevant

You write descriptions of your interests in plain language. For example:

```json
"interests": [
  "Tools that help verify AI-generated code actually does what it's supposed to",
  "Security problems with npm packages, especially ones AI tools install automatically",
  "How AI is changing the day-to-day work of software engineers"
]
```

When a new post or repo comes in, a local AI model (running on your machine through Ollama) reads the title and content, compares it to your interests, and decides: relevant, somewhat related, or skip. Only the relevant stuff reaches you.

## Setup (5 minutes)

You need two things installed: **Node.js** (version 18 or newer) and **Ollama** (a tool that runs AI models locally).

```bash
# Get the code
git clone https://github.com/krzysztofdudek/NewsVision.git
cd NewsVision
npm install

# Get an AI model (this downloads ~7GB, runs locally)
ollama pull qwen3.5:9b

# Create your config files from the templates
cp config.example.json config.json
cp secrets.example.json secrets.json

# Edit config.json — put in your interests (the most important part)
# Edit secrets.json — put in your Telegram bot token (see below)

# Check everything works
node src/index.js --test

# Start it
node src/index.js
```

That's it. It starts collecting, analyzing, and will send you your first briefing once it has a day's worth of data.

### Setting up Telegram (2 minutes)

This is how NewsVision sends you messages. You need a Telegram bot:

1. Open Telegram on your phone or computer
2. Search for **@BotFather** and start a chat
3. Type `/newbot` and follow the steps. It gives you a **token** (a long string of letters and numbers)
4. Now open a chat with your new bot and send it any message (like "hello")
5. Open this URL in a browser (replace YOUR_TOKEN with the actual token): `https://api.telegram.org/botYOUR_TOKEN/getUpdates`
6. In the response, find `"chat":{"id": 123456}`. That number is your **chat ID**.
7. Put the token and chat ID in `secrets.json`

If you skip this step, NewsVision still works. It just saves everything as local files instead of sending Telegram messages.

### Setting up GitHub (optional, 1 minute)

Without this, NewsVision can still search GitHub but is limited to 60 requests per hour. With a token, you get 5,000.

1. Go to GitHub > Settings > Developer settings > Fine-grained personal access tokens
2. Create one with "Public Repositories (read-only)", no extra permissions
3. Put it in `secrets.json`

## Configuration

Everything is in two files:

**`config.json`** — what to watch and how:

| Setting | What it does |
|---------|-------------|
| `startDate` | How far back to look on first run. `null` means start from today. `"2026-03-20"` means go back to March 20. |
| `interests` | **The most important setting.** Plain language descriptions of what matters to you. |
| `tags` | Labels the system uses to categorize stories. Customize to match your vocabulary. |
| `hnUsername` | Your Hacker News username. Set this to get notified when someone replies to your comments. |
| `github.topics` | GitHub topics to search. Like `["ai-agents", "react", "security"]`. |
| `github.watchRepos` | Repos you want to track. Like `["facebook/react", "your-name/your-project"]`. |
| `reddit.subreddits` | Which subreddits to read. Like `["programming", "typescript"]`. |
| `ollama.model` | Which AI model to use. `qwen3.5:9b` is recommended. `qwen3.5:4b` is faster but less accurate. |
| `delivery` | `"both"` (Telegram + files), `"telegram"` (Telegram only), or `"file"` (files only, good for testing). |

**`secrets.json`** — your private tokens (never shared, never committed to git):

```json
{
  "telegram": { "botToken": "your-token", "chatId": "your-chat-id" },
  "github": { "token": "your-github-token" }
}
```

Everything is optional. Leave out what you don't need. No subreddits? Reddit is skipped. No GitHub token? GitHub works with lower limits. No Telegram token? Everything saves to local files.

## Commands

```
node src/index.js                          Run normally (collect + analyze + deliver + keep polling)
node src/index.js --once                   Run one cycle and stop (good for testing or cron jobs)
node src/index.js --test                   Check if Ollama, Telegram, GitHub, Reddit, Arxiv are working
node src/index.js --status                 See what's in the database without running anything
node src/index.js --briefing               Generate today's briefing right now
node src/index.js --trend                  Generate this week's trend report right now
node src/index.js --backfill 2026-03-20    Go back and collect older data you missed
node src/index.js --reset                  Delete all analysis (keeps raw data, re-analyzes on next run)
node src/index.js --help                   Show all commands
```

## Stopping and restarting

Press **Ctrl+C** to stop. Run it again whenever you want. It remembers where it left off.

If you don't run it for a few days, it catches up automatically on the next start. You'll get separate daily briefings for each day you missed, not one big combined message.

If Ollama crashes while it's running, data collection continues. Analysis queues up and processes when Ollama comes back. If Telegram goes down, briefings save as files and send when Telegram returns. Nothing breaks, nothing is lost.

## Files it creates

```
data/db              The database. All collected stories, analysis results, everything.
data/newsvision.log  Log file. What the app did and when.
output/              Briefings and alerts as markdown files (searchable archive).
```

## How it works under the hood

For the curious: NewsVision runs a loop. Each cycle: fetch new content from all sources, classify each item as relevant or not (using Ollama), summarize the relevant ones, analyze their comments for interesting discussions, check for rising stories and engagement opportunities, generate any due briefings, and deliver everything. Progress is saved to a SQLite database after each step, so it can resume from any point.

## License

MIT — use it however you want.
