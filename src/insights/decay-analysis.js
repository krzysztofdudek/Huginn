// src/insights/decay-analysis.js
const DAY = 86400;
const HOUR = 3600;

function classifyGrowth(snapshots, storyCreatedAt) {
  if (snapshots.length < 3) return null;
  const maxPts = snapshots[snapshots.length - 1].points;
  if (maxPts < 5) return "flat";

  const sixHours = storyCreatedAt + 6 * HOUR;
  const ptsAt6h = snapshots.filter((s) => s.checked_at <= sixHours).reduce((m, s) => Math.max(m, s.points), 0);
  if (ptsAt6h / maxPts > 0.8) return "spike";

  const fortyEightH = storyCreatedAt + 48 * HOUR;
  const lastSnap = snapshots[snapshots.length - 1];
  const secondLast = snapshots[snapshots.length - 2];
  if (lastSnap.checked_at > fortyEightH && lastSnap.points > secondLast.points) return "slow-burn";

  return "steady";
}

module.exports = {
  id: "decay-analysis",
  name: "Growth Patterns",
  needsOllama: false,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < 6 * HOUR) return [];
    const unclassified = db.getUnclassifiedDecayStories(10);
    if (unclassified.length === 0) return [];
    return [{ from: 0, to: now }];
  },

  async run(db) {
    const stories = db.getUnclassifiedDecayStories(10);
    let classified = 0;

    for (const story of stories) {
      const timeline = db.getPointTimeline(story.id);
      const pattern = classifyGrowth(timeline, story.created_at);
      if (pattern) {
        db.setGrowthPattern(story.id, pattern);
        classified++;
      }
    }

    if (classified === 0) return null;

    return {
      summary: `${classified} stories classified`,
      classified,
    };
  },

  format(result) {
    // No Telegram alert for decay analysis — enrichment only
    return null;
  },
};
