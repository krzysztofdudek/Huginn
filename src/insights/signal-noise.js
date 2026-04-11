// src/insights/signal-noise.js
const DAY = 86400;
const WEEK = 7 * DAY;

module.exports = {
  id: "signal-noise",
  name: "Source Quality",
  needsOllama: false,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < WEEK) return [];
    const since = lastRun ? lastRun.completed_at : 0;
    if (db.countStoriesSince(since) < 100) return [];
    const from = lastRun ? lastRun.period_to : now - WEEK;
    return [{ from, to: now }];
  },

  async run(db, connector, period) {
    const stats = db.getSourceRelevanceStats(period.from, period.to);
    if (stats.length === 0) return null;

    const lines = stats
      .sort((a, b) => (b.relevant / b.total) - (a.relevant / a.total))
      .map((s) => {
        const pct = Math.round(100 * s.relevant / s.total);
        return `${s.type}: ${pct}% relevant (${s.relevant}/${s.total})`;
      });

    return {
      summary: `${stats.length} sources analyzed`,
      stats,
      message: lines.join("\n"),
    };
  },

  format(result) {
    return `📊 <b>Source Quality</b>\n\n${result.message}`;
  },
};
