# Huginn

<p align="center">
  <img src="assets/demo.gif" alt="Huginn demo" width="800">
</p>

I got tired of checking Hacker News, Reddit, GitHub, and Arxiv every day just to see if someone posted something I should know about. 500+ posts a day, and maybe 10 of them actually matter to what I'm working on. I was either spending an hour scrolling or missing things that mattered.

So I built a thing that reads all of it for me, figures out what's relevant, and sends me a Telegram message with a summary and links. If something blows up during the day or someone writes a comment I should respond to, it tells me right away.

It runs on your machine with a local AI model. Nothing goes to the cloud. You tell it what you care about in plain English and it does the rest.

## What you get

**Briefings on a schedule you set.** You pick the hours (e.g. 8am and 8pm UTC). At each one, you get a summary of everything relevant since the last briefing, plus links to every story. If you weren't running the app when a briefing was due, you get it the moment you start it up.

**Real-time pings when:**
- A post in your area suddenly takes off
- A conversation develops under a relevant post that you could meaningfully contribute to (with thread context so you know what they're talking about)
- Someone replies to your HN comment (HN doesn't do notifications)
- A new project shows up that's in your space
- One of your GitHub repos gets a release or stars spike

**Weekly trend report.** What topics grew, what faded, what launched.

**Bot commands in Telegram.** You can talk to the bot directly:

| Command | What it does |
|---------|-------------|
| `/huginn_help` | List all commands |
| `/huginn_brief` | Generate a briefing right now |
| `/huginn_status` | Show what's in the database |
| `/huginn_links` | Resend links from the last briefing |
| `/huginn_rising` | What's gaining traction right now |

Commands register automatically when the app starts. Just type `/` in the chat to see them.

Everything also saves as markdown files locally if you want to search later.

## Where it looks

| Source | How |
|--------|-----|
| Hacker News | Algolia API (free, no auth needed) |
| GitHub | Search API (free, optional token for higher limits) |
| Reddit | RSS feeds (free, no auth needed) |
| Arxiv | Public API (free, no auth needed) |

## How it knows what you care about

You write your interests in plain language in `config.json`:

```json
"interests": [
  "Frontend performance optimization and Core Web Vitals",
  "New open source developer tools, especially CLI tools",
  "Security vulnerabilities in popular npm packages"
]
```

A local AI model (running on your machine through Ollama) reads each post and decides if it matches your interests. If yes, it summarizes the article and checks the comments for anything interesting.

## Setup

You need **Node.js 18+** and **[Ollama](https://ollama.com)**.

```bash
git clone https://github.com/krzysztofdudek/Huginn.git
cd Huginn
npm install
ollama pull qwen3.5:9b

cp config.example.json config.json
cp secrets.example.json secrets.json
```

Now edit two files:

1. **`config.json`** — write your interests. This is the most important part. Everything else has sensible defaults.
2. **`secrets.json`** — add your Telegram bot token so it can send you messages. (See below for how to get one. If you skip this, everything saves as local files instead.)

Then:

```bash
npm test    # checks that Ollama, Telegram, and all sources are reachable
npm start   # starts collecting, analyzing, and delivering
```

### Getting a Telegram bot token (2 minutes)

1. Open Telegram, find **@BotFather**, type `/newbot`, follow the steps. You'll get a token.
2. Start a chat with your new bot (send it any message).
3. Open `https://api.telegram.org/botYOUR_TOKEN/getUpdates` in your browser. Find `"chat":{"id": 123456}`. That number is your chat ID.
4. Put both in `secrets.json`.

No Telegram? No problem. Set `"delivery": "file"` in config.json and everything saves as markdown files in `output/`.

### Getting a GitHub token (optional)

Without a token: 60 API requests per hour. With one: 5,000. For most people 60 is enough.

Go to GitHub > Settings > Developer settings > Fine-grained tokens > create one with "Public Repositories (read-only)".

## Configuration

**`config.json`** controls what to watch and how:

| Setting | What it does | Default |
|---------|-------------|---------|
| `startDate` | How far back to look on first run. `"2026-03-20"` means go back to that date. | `null` (starts from right now) |
| `interests` | Plain language descriptions of what matters to you. The most important setting. | `[]` |
| `tags` | Labels the classifier picks from when categorizing stories. | `[]` |
| `hnUsername` | Your Hacker News username. Set it to get notified when someone replies to your comments. | `null` (skipped) |
| `ollama.connector` | Which model connector to use. Available: `"qwen-3.5-9b"`, `"gemma4-e4b"`. | `"qwen-3.5-9b"` |
| `github.topics` | GitHub topics to search for new repos. | `[]` (skipped) |
| `github.watchRepos` | Repos to monitor for new releases and star changes. | `[]` (skipped) |
| `reddit.subreddits` | Subreddits to read. | `[]` (skipped) |
| `intelligence.briefingHoursUTC` | Hours (in UTC) when briefings are generated. | `[8, 20]` |
| `quietHoursUTC` | No Telegram notifications during these hours. Queued and sent grouped when quiet hours end. `[start, end]` in UTC. | `[23, 7]` (11pm to 7am) |
| `liveComments` | Watch for new comments on relevant HN posts and alert when a conversation is worth joining. Uses more API calls and Ollama time. | `true` |
| `delivery` | How to send you results. | `"file"` |

The `insights` section in `config.json` turns on deeper analysis that runs in the background:

```json
"insights": {
  "enabled": true
}
```

When enabled, 8 analysis plugins run automatically after each collect-analyze cycle: Emerging Topics, Fading Topics, Community Pulse, Competitive Velocity, Ecosystem Map, Growth Patterns, People Radar, and Source Quality. Each plugin decides on its own schedule when it has enough data to run. Use `--test-insights` to run them manually and see what they would send.

**`secrets.json`** has your private tokens (never committed to git):

```json
{
  "telegram": { "botToken": "...", "chatId": "..." },
  "github": { "token": "..." }
}
```

Everything is optional. If you leave something out, that feature is simply skipped. Nothing crashes.

## Commands

```
npm start                                  Collect, analyze, deliver, then keep polling
npm run once                               One cycle, then stop
npm test                                   Check that all services are reachable
npm run status                             Show what's in the database
npm run briefing                           Generate a briefing for everything since the last one
npm run trend                              Generate this week's trend report
npm run reset                              Delete all analysis results (keeps downloaded data)
node src/index.js --backfill 2026-03-20    Go back and collect older data
node src/index.js --test-insights          Run all insight analyses, show results, don't send
node src/index.js --help                   Show all options
```

## Stopping and starting

Press Ctrl+C to stop. Start it again whenever. It picks up exactly where it left off.

If you don't run it for a few days, it catches up on the next start. Briefings are generated for the time you missed, covering everything from the last briefing to now.

If Ollama crashes while it's running, data collection keeps going. Analysis queues up and processes when Ollama comes back. If Telegram is down, briefings save as files and send when it's reachable again.

## Files

```
data/db              Database with everything collected and analyzed
data/huginn.log      Log of what the app did and when
output/              Briefings and alerts as readable markdown files
```

## License

MIT
