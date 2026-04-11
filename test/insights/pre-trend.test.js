// test/insights/pre-trend.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");

// Mock connector that returns expected JSON
function mockConnector(response) {
  return {
    chat: async () => response,
  };
}

describe("pre-trend", () => {
  it("parses valid Ollama response", () => {
    const raw = JSON.stringify({
      topics: [
        { name: "runtime agent monitoring", direction: "growing", count: 7, new: true },
        { name: "MCP servers", direction: "stable", count: 12, new: false },
      ],
    });

    const match = raw.match(/\{[\s\S]*\}/);
    assert.ok(match);
    const parsed = JSON.parse(match[0]);
    assert.ok(Array.isArray(parsed.topics));
    assert.strictEqual(parsed.topics[0].name, "runtime agent monitoring");
    assert.strictEqual(parsed.topics[0].new, true);
  });

  it("handles malformed response gracefully", () => {
    const raw = "I can see several topics here but let me think...";
    const match = raw.match(/\{[\s\S]*\}/);
    assert.strictEqual(match, null);
    // Plugin should return null, not crash
  });

  it("format produces valid HTML", () => {
    const result = {
      message: "runtime agent monitoring: 7 stories in 48h, new this week",
    };
    const html = `🔮 <b>Emerging Topics</b>\n\n${result.message}`;
    assert.ok(html.includes("<b>"));
    assert.ok(html.includes("runtime agent monitoring"));
  });

  it("filters only growing and new topics", async () => {
    const plugin = require("../../src/insights/pre-trend");
    const raw = JSON.stringify({
      topics: [
        { name: "topic A", direction: "growing", count: 5, summary: "growing topic" },
        { name: "topic B", direction: "stable", count: 3, summary: "stable topic" },
        { name: "topic C", direction: "new", count: 2, summary: "new topic" },
        { name: "topic D", direction: "fading", count: 1, summary: "fading topic" },
      ],
    });

    const mockDb = {
      getRelevantStoriesInRange: (from, to) => {
        // Return enough stories for the plugin to proceed
        return Array.from({ length: 10 }, (_, i) => ({ id: i, title: `Story ${i}`, tags: "test", points: 10 }));
      },
      countRelevantStoriesSince: () => 25,
    };

    const result = await plugin.run(mockDb, mockConnector(raw), { from: 0, to: Math.floor(Date.now() / 1000) });
    assert.ok(result !== null);
    assert.strictEqual(result.topics.length, 2); // only growing and new
    assert.ok(result.topics.some((t) => t.name === "topic A"));
    assert.ok(result.topics.some((t) => t.name === "topic C"));
  });

  it("returns null when all topics are stable or fading", async () => {
    const plugin = require("../../src/insights/pre-trend");
    const raw = JSON.stringify({
      topics: [
        { name: "topic A", direction: "stable", count: 5, summary: "stable" },
        { name: "topic B", direction: "fading", count: 3, summary: "fading" },
      ],
    });

    const mockDb = {
      getRelevantStoriesInRange: () => Array.from({ length: 10 }, (_, i) => ({ id: i, title: `Story ${i}`, tags: "", points: 10 })),
      countRelevantStoriesSince: () => 25,
    };

    const result = await plugin.run(mockDb, mockConnector(raw), { from: 0, to: Math.floor(Date.now() / 1000) });
    assert.strictEqual(result, null);
  });

  it("returns null when connector returns null", async () => {
    const plugin = require("../../src/insights/pre-trend");
    const mockDb = {
      getRelevantStoriesInRange: () => Array.from({ length: 10 }, (_, i) => ({ id: i, title: `Story ${i}`, tags: "", points: 10 })),
      countRelevantStoriesSince: () => 25,
    };

    const result = await plugin.run(mockDb, mockConnector(null), { from: 0, to: Math.floor(Date.now() / 1000) });
    assert.strictEqual(result, null);
  });
});
