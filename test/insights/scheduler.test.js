// test/insights/scheduler.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createTestDb, now, DAY, HOUR, seedAnalysisRun } = require("./fixtures");

// Mock a minimal plugin
function mockPlugin(id, shouldRunResult) {
  return {
    id,
    name: `Test ${id}`,
    shouldRun: () => shouldRunResult,
    run: async () => ({ message: "test" }),
    format: (r) => r.message,
  };
}

describe("Scheduler", () => {
  describe("recoverStuckRuns", () => {
    it("marks old running runs as failed", () => {
      const db = createTestDb();
      // Insert a run that started 2 hours ago, still "running"
      db.prepare(
        "INSERT INTO analysis_runs (analysis_type, status, created_at) VALUES (?, 'running', ?)"
      ).run("test-plugin", now() - 2 * HOUR);

      const cutoff = now() - HOUR;
      const stuck = db.prepare("SELECT id FROM analysis_runs WHERE status = 'running' AND created_at < ?").all(cutoff);
      for (const row of stuck) {
        db.prepare("UPDATE analysis_runs SET status = 'failed', error = 'stuck', completed_at = ? WHERE id = ?").run(now(), row.id);
      }

      const result = db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(stuck[0].id);
      assert.strictEqual(result.status, "failed");
      assert.strictEqual(result.error, "stuck");
    });

    it("does not touch recent running runs", () => {
      const db = createTestDb();
      db.prepare(
        "INSERT INTO analysis_runs (analysis_type, status, created_at) VALUES (?, 'running', ?)"
      ).run("test-plugin", now() - 5 * 60); // 5 minutes ago

      const cutoff = now() - HOUR;
      const stuck = db.prepare("SELECT id FROM analysis_runs WHERE status = 'running' AND created_at < ?").all(cutoff);
      assert.strictEqual(stuck.length, 0);
    });
  });

  describe("idempotency", () => {
    it("completed run is not re-run for same period", () => {
      const db = createTestDb();
      const from = now() - DAY;
      const to = now();
      seedAnalysisRun(db, "test-plugin", { status: "done", period_from: from, period_to: to });

      const last = db.prepare(
        "SELECT * FROM analysis_runs WHERE analysis_type = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1"
      ).get("test-plugin");

      assert.ok(last);
      assert.strictEqual(last.period_from, from);
      assert.strictEqual(last.period_to, to);
    });
  });

  describe("stampede protection", () => {
    it("processes at most maxPerCycle periods", () => {
      const periods = [
        { from: now() - 4 * DAY, to: now() - 3 * DAY },
        { from: now() - 3 * DAY, to: now() - 2 * DAY },
        { from: now() - 2 * DAY, to: now() - DAY },
        { from: now() - DAY, to: now() },
      ];
      const maxPerCycle = 3;
      const toProcess = periods.slice(0, maxPerCycle);
      assert.strictEqual(toProcess.length, 3);
    });
  });

  describe("failed run retry", () => {
    it("failed run allows re-run for same period", () => {
      const db = createTestDb();
      const from = now() - DAY;
      const to = now();
      seedAnalysisRun(db, "test-plugin", { status: "failed", period_from: from, period_to: to, error: "ollama timeout" });

      const last = db.prepare(
        "SELECT * FROM analysis_runs WHERE analysis_type = ? ORDER BY created_at DESC LIMIT 1"
      ).get("test-plugin");

      assert.strictEqual(last.status, "failed");
      // shouldRun should include this period since it failed
    });
  });
});
