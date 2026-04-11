// test/insights/people-radar.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createTestDb, now, DAY, seedPerson } = require("./fixtures");

describe("people-radar", () => {
  it("returns top people by relevant_comments * avg_points", () => {
    const db = createTestDb();
    seedPerson(db, "top-user", { relevant_comments: 12, avg_points: 8, last_seen: now() - DAY });
    seedPerson(db, "mid-user", { relevant_comments: 5, avg_points: 4, last_seen: now() - DAY });
    seedPerson(db, "low-user", { relevant_comments: 1, avg_points: 1, last_seen: now() - DAY });
    seedPerson(db, "old-user", { relevant_comments: 20, avg_points: 10, last_seen: now() - 60 * DAY });

    const from = now() - 30 * DAY;
    const to = now();
    const top = db.prepare(`
      SELECT username, relevant_comments, avg_points
      FROM people WHERE last_seen >= ? AND last_seen < ?
      ORDER BY relevant_comments * avg_points DESC LIMIT 5
    `).all(from, to);

    assert.strictEqual(top[0].username, "top-user");
    assert.strictEqual(top.length, 3); // old-user excluded (last_seen 60d ago)
  });
});
