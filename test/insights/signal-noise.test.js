// test/insights/signal-noise.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createTestDb, now, DAY, seedStory, seedAnalysis } = require("./fixtures");

describe("signal-noise", () => {
  it("calculates relevance percentage per source", () => {
    const db = createTestDb();
    const weekAgo = now() - 7 * DAY;
    // 10 HN stories: 3 relevant, 2 adjacent, 5 irrelevant
    for (let i = 1; i <= 10; i++) {
      seedStory(db, i, { type: "article", created_at: weekAgo + i * 100 });
      const rel = i <= 3 ? "relevant" : i <= 5 ? "adjacent" : "irrelevant";
      seedAnalysis(db, i, { relevance: rel });
    }
    // 5 Reddit stories: 1 relevant, 4 irrelevant
    for (let i = 11; i <= 15; i++) {
      seedStory(db, i, { type: "reddit_post", created_at: weekAgo + i * 100 });
      seedAnalysis(db, i, { relevance: i === 11 ? "relevant" : "irrelevant" });
    }

    const stats = db.prepare(`
      SELECT s.type, COUNT(*) as total,
        SUM(CASE WHEN sa.relevance = 'relevant' THEN 1 ELSE 0 END) as relevant
      FROM stories s JOIN story_analysis sa ON s.id = sa.story_id
      WHERE s.created_at >= ? GROUP BY s.type
    `).all(weekAgo);

    const hn = stats.find((s) => s.type === "article");
    const reddit = stats.find((s) => s.type === "reddit_post");
    assert.strictEqual(hn.relevant, 3);
    assert.strictEqual(hn.total, 10);
    assert.strictEqual(reddit.relevant, 1);
    assert.strictEqual(reddit.total, 5);
  });
});
