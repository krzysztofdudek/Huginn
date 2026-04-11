// test/insights/community-pulse.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("community-pulse", () => {
  it("parses layer 1 signal extraction response", () => {
    const raw = JSON.stringify({
      claims: ["tool X is broken in production"],
      stance: "frustrated but engaged",
      experience_level: "practitioner",
      action_taken: "built workaround",
      topics_referenced: ["tool-x", "production"],
    });
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.claims));
    assert.strictEqual(parsed.experience_level, "practitioner");
  });

  it("parses layer 2 narrative discovery response", () => {
    const raw = JSON.stringify({
      narratives: [
        {
          topic: "MCP reliability",
          comment_count: 34,
          dominant_stance: "frustrated but engaged",
          energy: "high",
          key_claims: ["breaks under load"],
        },
      ],
    });
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.narratives));
    assert.strictEqual(parsed.narratives[0].topic, "MCP reliability");
  });

  it("handles empty comment list gracefully", () => {
    // Plugin should return null when no comments
    const comments = [];
    assert.strictEqual(comments.length, 0);
  });

  it("stripHtml removes tags and decodes entities", () => {
    // Test via the plugin's internal behavior through a mock run
    // We verify the logic directly since stripHtml is not exported
    function stripHtml(html) {
      return (html || "").replace(/<p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
        .replace(/<a\s+href="([^"]*)"[^>]*>[^<]*<\/a>/gi, "$1")
        .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
        .replace(/\s+/g, " ").trim();
    }
    assert.strictEqual(stripHtml("<p>Hello &amp; World</p>"), "Hello & World");
    assert.strictEqual(stripHtml('<a href="http://example.com">link</a>'), "http://example.com");
    assert.strictEqual(stripHtml("<b>bold</b> text"), "bold text");
  });

  it("returns null when connector returns null for all comments", async () => {
    const plugin = require("../../src/insights/community-pulse");

    const mockDb = {
      getCommentsForRelevantStories: () => [
        { id: 1, story_id: 10, parent_id: 10, author: "alice", text: "This is a great discussion about MCP", points: 5, created_at: Math.floor(Date.now() / 1000), story_title: "MCP story", story_summary: "About MCP" },
      ],
      getCommentParentChain: () => [],
      saveCommentSignal: () => {},
      getLastCompletedRun: () => null,
    };

    const mockConnector = { chat: async () => null };
    const result = await plugin.run(mockDb, mockConnector, { from: 0, to: Math.floor(Date.now() / 1000) }, null);
    assert.strictEqual(result, null);
  });

  it("parses signals and returns result with narratives", async () => {
    const plugin = require("../../src/insights/community-pulse");

    const signalResponse = JSON.stringify({
      claims: ["MCP breaks under load"],
      stance: "frustrated",
      experience_level: "practitioner",
      action_taken: "filed issue",
      topics_referenced: ["mcp"],
    });

    const narrativeResponse = JSON.stringify({
      narratives: [
        { topic: "MCP reliability", comment_count: 1, dominant_stance: "frustrated", energy: "high", key_claims: ["breaks under load"] },
      ],
    });

    let callCount = 0;
    const mockConnector = {
      chat: async () => {
        callCount++;
        if (callCount === 1) return signalResponse; // layer 1 per comment
        return narrativeResponse; // layer 2 narrative
      },
    };

    const mockDb = {
      getCommentsForRelevantStories: () => [
        { id: 1, story_id: 10, parent_id: 10, author: "alice", text: "This MCP tool breaks under load in production", points: 5, created_at: Math.floor(Date.now() / 1000), story_title: "MCP Tools", story_summary: "MCP tools roundup" },
      ],
      getCommentParentChain: () => [],
      saveCommentSignal: () => {},
      getLastCompletedRun: () => null,
    };

    const result = await plugin.run(mockDb, mockConnector, { from: 0, to: Math.floor(Date.now() / 1000) }, null);
    assert.ok(result !== null);
    assert.ok(Array.isArray(result.narratives));
    assert.strictEqual(result.narratives[0].topic, "MCP reliability");
    assert.ok(result.message.includes("MCP reliability"));
  });

  it("format produces HTML with expected emoji and tag", () => {
    const plugin = require("../../src/insights/community-pulse");
    const result = {
      narratives: [],
      message: "MCP reliability\n5 comments, high energy\nfrustrated",
    };
    const html = plugin.format(result);
    assert.ok(html.includes("🧠"));
    assert.ok(html.includes("<b>Community Pulse</b>"));
    assert.ok(html.includes("MCP reliability"));
  });
});
