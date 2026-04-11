// src/insights/dead-zone.js
const DAY = 86400;
const WEEK = 7 * DAY;

module.exports = {
  id: "dead-zone",
  name: "Fading Topics",
  needsOllama: false,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < WEEK) return [];
    const from = lastRun ? lastRun.period_to : now - WEEK;
    return [{ from, to: now }];
  },

  async run(db, connector, period) {
    const now = period.to;
    const thisWeek = db.getTagCountsInRange(now - WEEK, now);
    const baselineStart = now - 5 * WEEK;
    const baseline = db.getTagCountsInRange(baselineStart, now - WEEK);
    const baselineWeeks = 4;

    const fading = [];
    for (const [tag, avg_raw] of Object.entries(baseline)) {
      const avg = avg_raw / baselineWeeks;
      if (avg < 2) continue; // ignore rare tags
      const current = thisWeek[tag] || 0;
      const drop = (avg - current) / avg;
      if (drop > 0.5) {
        fading.push({ tag, current, avg: Math.round(avg * 10) / 10, drop: Math.round(drop * 100) });
      }
    }

    if (fading.length === 0) return null;

    fading.sort((a, b) => b.drop - a.drop);
    const lines = fading.slice(0, 5).map((f) =>
      `"${f.tag}": ${f.current} this week (avg ${f.avg}/wk, -${f.drop}%)`
    );

    return {
      summary: `${fading.length} fading tags`,
      fading,
      message: lines.join("\n"),
    };
  },

  format(result) {
    return `📉 <b>Fading Topics</b>\n\n${result.message}`;
  },
};
