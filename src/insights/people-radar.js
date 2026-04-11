// src/insights/people-radar.js
const DAY = 86400;
const WEEK = 7 * DAY;

module.exports = {
  id: "people-radar",
  name: "People Radar",
  needsOllama: false,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < WEEK) return [];
    const from = lastRun ? lastRun.period_to : now - 30 * DAY;
    return [{ from, to: now }];
  },

  async run(db, connector, period) {
    const now = period.to;
    const current = db.getTopPeopleInRange(now - 30 * DAY, now, 10);
    const previous = db.getTopPeopleInRange(now - 60 * DAY, now - 30 * DAY, 10);

    if (current.length === 0) return null;

    const prevSet = new Set(previous.map((p) => p.username));
    const top5 = current.slice(0, 5);
    const newcomers = top5.filter((p) => !prevSet.has(p.username));

    const lines = top5.map((p) => {
      const score = Math.round(p.relevant_comments * p.avg_points);
      const isNew = newcomers.includes(p) ? " (new)" : "";
      return `${p.username}: ${p.relevant_comments} relevant comments, avg ${Math.round(p.avg_points)} pts${isNew}`;
    });

    return {
      summary: `Top ${top5.length}, ${newcomers.length} new`,
      people: top5,
      message: lines.join("\n"),
    };
  },

  format(result) {
    return `👤 <b>People Radar</b>\n\n${result.message}`;
  },
};
