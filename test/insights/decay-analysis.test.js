// test/insights/decay-analysis.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createTestDb, now, HOUR, DAY, seedStory, seedAnalysis, seedSnapshot } = require("./fixtures");

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

describe("decay-analysis", () => {
  it("classifies spike — 80%+ points in first 6h", () => {
    const created = now() - 2 * DAY;
    const snaps = [
      { points: 0, checked_at: created },
      { points: 40, checked_at: created + 2 * HOUR },
      { points: 48, checked_at: created + 5 * HOUR },
      { points: 50, checked_at: created + DAY },
    ];
    assert.strictEqual(classifyGrowth(snaps, created), "spike");
  });

  it("classifies slow-burn — still growing after 48h", () => {
    const created = now() - 4 * DAY;
    const snaps = [
      { points: 0, checked_at: created },
      { points: 10, checked_at: created + 6 * HOUR },
      { points: 20, checked_at: created + DAY },
      { points: 30, checked_at: created + 2 * DAY },
      { points: 40, checked_at: created + 3 * DAY },
    ];
    assert.strictEqual(classifyGrowth(snaps, created), "slow-burn");
  });

  it("classifies flat — less than 5 points", () => {
    const created = now() - 2 * DAY;
    const snaps = [
      { points: 0, checked_at: created },
      { points: 1, checked_at: created + HOUR },
      { points: 2, checked_at: created + DAY },
    ];
    assert.strictEqual(classifyGrowth(snaps, created), "flat");
  });

  it("classifies steady — linear growth over 24h+", () => {
    const created = now() - 2 * DAY;
    const snaps = [
      { points: 0, checked_at: created },
      { points: 10, checked_at: created + 6 * HOUR },
      { points: 30, checked_at: created + 12 * HOUR },
      { points: 50, checked_at: created + DAY },
      { points: 50, checked_at: created + 2 * DAY },
    ];
    assert.strictEqual(classifyGrowth(snaps, created), "steady");
  });
});
