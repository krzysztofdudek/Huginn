// test/insights/ecosystem-map.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("ecosystem-map", () => {
  it("parses valid cluster response", () => {
    const raw = JSON.stringify({
      clusters: [
        { name: "Agent Reliability", stories: 8, repos: 3, description: "Tools for testing agents" },
        { name: "Context Management", stories: 12, repos: 5, description: "Memory and context solutions" },
      ],
      gaps: "No tools bridging reliability and context management.",
    });
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.clusters));
    assert.strictEqual(parsed.clusters.length, 2);
    assert.ok(parsed.gaps);
  });

  it("handles empty response", () => {
    const raw = "";
    const match = (raw || "").match(/\{[\s\S]*\}/);
    assert.strictEqual(match, null);
  });

  it("handles malformed JSON gracefully", () => {
    const raw = "Clusters include: agent tools, context management, etc.";
    const match = raw.match(/\{[\s\S]*\}/);
    assert.strictEqual(match, null);
    // Plugin returns null, no crash
  });

  it("returns null when connector returns null", async () => {
    const plugin = require("../../src/insights/ecosystem-map");

    const mockDb = {
      getRelevantStoriesInRange: () => Array.from({ length: 10 }, (_, i) => ({
        id: i, title: `Story ${i}`, tags: "test", points: 10,
      })),
      getAllGithubRepos: () => [],
      getGithubRepoAnalysis: () => null,
    };

    const mockConnector = { chat: async () => null };
    const result = await plugin.run(mockDb, mockConnector, { from: 0, to: Math.floor(Date.now() / 1000) });
    assert.strictEqual(result, null);
  });

  it("returns null when too few stories and repos", async () => {
    const plugin = require("../../src/insights/ecosystem-map");

    const mockDb = {
      getRelevantStoriesInRange: () => [
        { id: 1, title: "Single story", tags: "", points: 5 },
      ],
      getAllGithubRepos: () => [],
      getGithubRepoAnalysis: () => null,
    };

    const mockConnector = { chat: async () => '{"clusters":[]}' };
    const result = await plugin.run(mockDb, mockConnector, { from: 0, to: Math.floor(Date.now() / 1000) });
    assert.strictEqual(result, null);
  });

  it("parses clusters and builds message with week number", async () => {
    const plugin = require("../../src/insights/ecosystem-map");

    const clusterResponse = JSON.stringify({
      clusters: [
        { name: "Agent Reliability", stories: 8, repos: 3, description: "Tools for testing agents in production" },
        { name: "Context Management", stories: 12, repos: 5, description: "Memory and context windowing solutions" },
      ],
      connections: "Reliability tools feed context systems.",
      gaps: "No unified observability layer.",
    });

    const mockDb = {
      getRelevantStoriesInRange: () => Array.from({ length: 10 }, (_, i) => ({
        id: i, title: `AI Story ${i}`, tags: "ai,agents", points: 20,
      })),
      getAllGithubRepos: () => [
        { id: 1, full_name: "owner/agent-test", stars: 500, language: "Python", description: "Agent testing framework" },
        { id: 2, full_name: "owner/context-window", stars: 300, language: "TypeScript", description: "Context management" },
        { id: 3, full_name: "owner/memory-store", stars: 200, language: "Rust", description: "Fast memory store" },
      ],
      getGithubRepoAnalysis: () => ({ relevance: "relevant" }),
    };

    const mockConnector = { chat: async () => clusterResponse };
    const now = Math.floor(Date.now() / 1000);
    const result = await plugin.run(mockDb, mockConnector, { from: now - 7 * 86400, to: now });

    assert.ok(result !== null);
    assert.strictEqual(result.clusters.length, 2);
    assert.ok(result.message.includes("Agent Reliability"));
    assert.ok(result.message.includes("Context Management"));
    assert.ok(result.message.includes("Connections:"));
    assert.ok(result.message.includes("Gaps:"));
    assert.ok(result.message.includes("Week"));
    assert.strictEqual(result.summary, "2 clusters identified");
  });

  it("format produces HTML with expected emoji and structure", () => {
    const plugin = require("../../src/insights/ecosystem-map");
    const result = {
      clusters: [],
      message: "Week 2026-W15\n\n<b>Agent Tools</b> (5 stories, 2 repos)\nBuilding reliable agents",
    };
    const html = plugin.format(result);
    assert.ok(html.includes("🗺️"));
    assert.ok(html.includes("<b>Ecosystem Map</b>"));
    assert.ok(html.includes("Agent Tools"));
  });
});
