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
