// src/insights/pre-trend.js
const DAY = 86400;
const HOUR = 3600;

module.exports = {
  id: "pre-trend",
  name: "Emerging Topics",
  needsOllama: true,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < 6 * HOUR) return [];
    const since = lastRun ? lastRun.completed_at : 0;
    if (db.countRelevantStoriesSince(since) < 20) return [];
    const from = lastRun ? lastRun.period_to : now - 2 * DAY;
    return [{ from, to: now }];
  },

  async run(db, connector, period) {
    const stories = db.getRelevantStoriesInRange(period.from, period.to);
    if (stories.length < 5) return null;

    // Get last week's topics for comparison
    const lastWeekStories = db.getRelevantStoriesInRange(period.from - 7 * DAY, period.from);
    const lastWeekBlock = lastWeekStories.length > 0
      ? lastWeekStories.map((s) => `[${s.tags || ""}] ${s.title}`).join("\n")
      : "No data from last week.";

    const storiesBlock = stories.map((s) => `[${s.tags || ""}] ${s.title}`).join("\n");

    const result = await connector.chat(
      "You detect emerging topics in tech news. Output ONLY valid JSON.",
      `Analyze these ${stories.length} stories from the last 48h and identify topics/themes.
Compare with last week's stories below.

Current stories:
${storiesBlock}

Last week:
${lastWeekBlock}

Return JSON: {"topics":[{"name":"topic name","direction":"growing|stable|fading|new","count":N,"summary":"one sentence"}]}`,
      { temperature: 0.3, maxTokens: 800, timeout: 120000 }
    );

    if (!result) return null;

    try {
      const match = result.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);
      if (!parsed.topics || parsed.topics.length === 0) return null;

      const emerging = parsed.topics.filter((t) => t.direction === "growing" || t.direction === "new");
      if (emerging.length === 0) return null;

      const lines = emerging.map((t) => {
        const tag = t.direction === "new" ? "(new)" : "(growing)";
        return `${t.name} ${tag} — ${t.count} stories. ${t.summary || ""}`;
      });

      return {
        summary: `${emerging.length} emerging topics`,
        topics: emerging,
        message: lines.join("\n\n"),
      };
    } catch {
      return null;
    }
  },

  format(result) {
    return `🔮 <b>Emerging Topics</b>\n\n${result.message}`;
  },
};
