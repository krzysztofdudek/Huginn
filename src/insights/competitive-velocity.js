// src/insights/competitive-velocity.js
const DAY = 86400;
const HOUR = 3600;

module.exports = {
  id: "competitive-velocity",
  name: "Competitive Velocity",
  needsOllama: false,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < HOUR) return [];
    if (!db.hasNewStarSnapshots(lastRun ? lastRun.completed_at : 0)) return [];
    const from = lastRun ? lastRun.period_to : now - 7 * DAY;
    return [{ from, to: now }];
  },

  async run(db) {
    const repos = db.getStarGrowth(7);
    const alerts = repos.filter((r) => {
      if (r.current_growth < 20) return false;
      if (r.previous_growth === 0) return r.current_growth >= 20;
      return r.current_growth > r.previous_growth * 1.5;
    });

    if (alerts.length === 0) return null;

    const lines = alerts.slice(0, 5).map((r) => {
      const prev = r.previous_growth > 0 ? ` (was +${r.previous_growth}/wk)` : " (new)";
      return `${r.full_name}: +${r.current_growth} stars this week${prev}`;
    });

    return {
      summary: `${alerts.length} fast movers`,
      repos: alerts,
      message: lines.join("\n"),
    };
  },

  format(result) {
    return `⚡ <b>Fast Movers</b>\n\n${result.message}`;
  },
};
