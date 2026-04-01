const db = require("./db");
const config = require("./config");

const TOKEN = config.github && config.github.token;
const TOPICS = (config.github && config.github.topics) || [];
const WATCH_REPOS = (config.github && config.github.watchRepos) || [];

const HEADERS = {
  "Accept": "application/vnd.github+json",
  "User-Agent": "HNAssistant/1.0",
};
if (TOKEN) HEADERS["Authorization"] = `Bearer ${TOKEN}`;

async function ghFetch(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    if (res.status === 403 || res.status === 429) {
      const reset = res.headers.get("x-ratelimit-reset");
      const waitSec = reset ? Math.max(0, parseInt(reset) - Math.floor(Date.now() / 1000)) : 60;
      console.log(`  GitHub rate limited, waiting ${waitSec}s...`);
      await new Promise((r) => setTimeout(r, Math.min(waitSec, 120) * 1000));
      return ghFetch(url);
    }
    if (!res.ok) return null;

    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining && parseInt(remaining) < 10) {
      console.log(`  GitHub API: ${remaining} requests remaining`);
    }

    return res.json();
  } catch (err) {
    console.error(`  GitHub fetch error: ${err.message}`);
    return null;
  }
}

function normalizeRepo(item) {
  return {
    id: item.id,
    full_name: item.full_name,
    name: item.name,
    owner: item.owner && item.owner.login || "",
    description: item.description || "",
    url: item.html_url,
    stars: item.stargazers_count || 0,
    forks: item.forks_count || 0,
    language: item.language || "",
    topics: item.topics || [],
    created_at: Math.floor(new Date(item.created_at).getTime() / 1000),
    pushed_at: Math.floor(new Date(item.pushed_at).getTime() / 1000),
    license: item.license && item.license.spdx_id || "",
  };
}

// ── Discovery: search for new repos by topic ──

async function discoverByTopics() {
  if (TOPICS.length === 0) return 0;

  const lastDiscovery = db.getCursorInt("github_discovery") || 0;
  const sinceDate = lastDiscovery > 0
    ? new Date(lastDiscovery * 1000).toISOString().slice(0, 10)
    : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10); // Last 30 days on first run

  let total = 0;

  for (const topic of TOPICS) {
    const url = `https://api.github.com/search/repositories?q=topic:${encodeURIComponent(topic)}+created:>${sinceDate}&sort=stars&order=desc&per_page=30`;
    const data = await ghFetch(url);
    if (!data || !data.items) continue;

    const repos = data.items.map(normalizeRepo);
    for (const repo of repos) {
      db.upsertGithubRepo(repo);
      db.enqueue("classify_repo", repo.id);
    }
    db.snapshotGithubStars(repos);
    total += repos.length;

    await new Promise((r) => setTimeout(r, 500)); // Be nice to API
  }

  db.setCursor("github_discovery", Math.floor(Date.now() / 1000));
  return total;
}

// ── Watch: update watched repos (stars, releases) ──

async function updateWatchedRepos() {
  if (WATCH_REPOS.length === 0) return { updated: 0, releases: 0 };

  let updated = 0, releases = 0;

  for (const repoName of WATCH_REPOS) {
    // Repo info
    const data = await ghFetch(`https://api.github.com/repos/${repoName}`);
    if (!data) continue;

    const repo = normalizeRepo(data);
    db.upsertGithubRepo(repo);
    db.snapshotGithubStars([repo]);
    updated++;

    // Recent releases
    const relData = await ghFetch(`https://api.github.com/repos/${repoName}/releases?per_page=5`);
    if (relData && Array.isArray(relData)) {
      for (const rel of relData) {
        db.upsertGithubRelease({
          id: rel.id,
          repo_id: repo.id,
          tag_name: rel.tag_name,
          name: rel.name || rel.tag_name,
          body: (rel.body || "").slice(0, 2000),
          published_at: Math.floor(new Date(rel.published_at).getTime() / 1000),
        });
      }
      releases += relData.length;
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  db.setCursor("github_watched", Math.floor(Date.now() / 1000));
  return { updated, releases };
}

// ── Trending: GitHub trending (unofficial, scrape-free via search) ──

async function discoverTrending() {
  // Search for repos with many stars created or pushed recently
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const queries = [
    `q=stars:>50+pushed:>${weekAgo}+topic:ai-agents&sort=stars&order=desc&per_page=20`,
    `q=stars:>20+created:>${weekAgo}+language:typescript+topic:ai&sort=stars&order=desc&per_page=20`,
    `q=stars:>20+created:>${weekAgo}+language:python+topic:ai&sort=stars&order=desc&per_page=20`,
  ];

  let total = 0;

  for (const q of queries) {
    const data = await ghFetch(`https://api.github.com/search/repositories?${q}`);
    if (!data || !data.items) continue;

    const repos = data.items.map(normalizeRepo);
    for (const repo of repos) {
      const existing = db.getGithubRepoByName(repo.full_name);
      db.upsertGithubRepo(repo);
      if (!existing) {
        db.enqueue("classify_repo", repo.id);
        total++;
      }
    }
    db.snapshotGithubStars(repos);

    await new Promise((r) => setTimeout(r, 500));
  }

  db.setCursor("github_trending", Math.floor(Date.now() / 1000));
  return total;
}

// ── Full collect cycle ──

async function collect() {
  const results = { discovered: 0, trending: 0, watched: { updated: 0, releases: 0 } };

  try {
    // Check API availability
    const test = await ghFetch("https://api.github.com/rate_limit");
    if (!test) {
      console.log("  GitHub API unavailable");
      return results;
    }
    const remaining = test.resources && test.resources.search && test.resources.search.remaining;
    console.log(`  GitHub API: ${remaining} search requests remaining`);

    results.discovered = await discoverByTopics();
    results.trending = await discoverTrending();
    results.watched = await updateWatchedRepos();
  } catch (err) {
    console.error(`  GitHub collect error: ${err.message}`);
  }

  return results;
}

module.exports = { collect, discoverByTopics, discoverTrending, updateWatchedRepos };
