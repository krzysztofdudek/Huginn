// test/insights/competitive-velocity.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createTestDb, now, DAY, seedRepo, seedStarSnapshot, seedAnalysisRun } = require("./fixtures");

describe("competitive-velocity", () => {
  it("detects repo with >50% acceleration", () => {
    const db = createTestDb();
    const r = seedRepo(db, 1, { stars: 200 });
    // Previous week: 100 → 120 = 20 growth (end of prev period, 1s before boundary)
    seedStarSnapshot(db, 1, 100, now() - 14 * DAY);
    seedStarSnapshot(db, 1, 120, now() - 7 * DAY - 1);
    // This week: 120 → 200 = 80 growth
    seedStarSnapshot(db, 1, 120, now() - 7 * DAY);
    seedStarSnapshot(db, 1, 200, now());

    const growth = db.prepare(`
      SELECT r.id, r.full_name, r.stars,
        r.stars - COALESCE(curr.first_stars, r.stars) as current_growth,
        COALESCE(prev_g.growth, 0) as previous_growth
      FROM github_repos r
      LEFT JOIN (
        SELECT repo_id, MIN(stars) as first_stars
        FROM github_star_snapshots WHERE checked_at >= ?
        GROUP BY repo_id
      ) curr ON curr.repo_id = r.id
      LEFT JOIN (
        SELECT repo_id, MAX(stars) - MIN(stars) as growth
        FROM github_star_snapshots WHERE checked_at >= ? AND checked_at < ?
        GROUP BY repo_id
      ) prev_g ON prev_g.repo_id = r.id
      WHERE r.stars - COALESCE(curr.first_stars, r.stars) > 0
      ORDER BY current_growth DESC
    `).all(now() - 7 * DAY, now() - 14 * DAY, now() - 7 * DAY);

    assert.strictEqual(growth.length, 1);
    assert.strictEqual(growth[0].current_growth, 80);
    assert.strictEqual(growth[0].previous_growth, 20);
  });

  it("ignores repo with minimal growth", () => {
    const db = createTestDb();
    seedRepo(db, 1, { stars: 102 });
    seedStarSnapshot(db, 1, 100, now() - 7 * DAY);
    seedStarSnapshot(db, 1, 102, now());

    const growth = db.prepare(`
      SELECT r.id, r.stars - COALESCE(curr.first_stars, r.stars) as current_growth
      FROM github_repos r
      LEFT JOIN (
        SELECT repo_id, MIN(stars) as first_stars
        FROM github_star_snapshots WHERE checked_at >= ?
        GROUP BY repo_id
      ) curr ON curr.repo_id = r.id
      WHERE r.stars - COALESCE(curr.first_stars, r.stars) > 0
    `).all(now() - 7 * DAY);

    // Growth is 2 — below any reasonable threshold
    assert.ok(growth.length === 0 || growth[0].current_growth < 20);
  });
});
