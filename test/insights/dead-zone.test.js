// test/insights/dead-zone.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createTestDb, now, DAY, seedStory, seedAnalysis } = require("./fixtures");

describe("dead-zone", () => {
  it("detects tag that dropped >50%", () => {
    const db = createTestDb();
    // Baseline: 4 weeks, 3 stories/week with tag "formal-verification" = avg 3/wk
    for (let w = 1; w <= 4; w++) {
      for (let i = 0; i < 3; i++) {
        const id = w * 100 + i;
        seedStory(db, id, { created_at: now() - (w + 1) * 7 * DAY + i * DAY });
        seedAnalysis(db, id, { relevance: "relevant", tags: "formal-verification" });
      }
    }
    // This week: only 1 story with that tag
    seedStory(db, 999, { created_at: now() - DAY });
    seedAnalysis(db, 999, { relevance: "relevant", tags: "formal-verification" });

    // Count this week
    const thisWeekStart = now() - 7 * DAY;
    const baselineStart = now() - 5 * 7 * DAY;
    const thisWeekRows = db.prepare(`
      SELECT sa.tags FROM story_analysis sa JOIN stories s ON s.id = sa.story_id
      WHERE sa.relevance IN ('relevant','adjacent') AND s.created_at >= ? AND sa.tags IS NOT NULL
    `).all(thisWeekStart);

    const baselineRows = db.prepare(`
      SELECT sa.tags FROM story_analysis sa JOIN stories s ON s.id = sa.story_id
      WHERE sa.relevance IN ('relevant','adjacent') AND s.created_at >= ? AND s.created_at < ? AND sa.tags IS NOT NULL
    `).all(baselineStart, thisWeekStart);

    function countTags(rows) {
      const c = {};
      for (const r of rows) for (const t of r.tags.split(",")) { const k = t.trim(); if (k) c[k] = (c[k] || 0) + 1; }
      return c;
    }

    const thisWeek = countTags(thisWeekRows);
    const baseline = countTags(baselineRows);
    const weeks = 4;

    const fv = "formal-verification";
    const avg = (baseline[fv] || 0) / weeks;
    const current = thisWeek[fv] || 0;
    const drop = avg > 0 ? (avg - current) / avg : 0;

    assert.ok(drop > 0.5, `Expected >50% drop, got ${Math.round(drop * 100)}%`);
  });
});
