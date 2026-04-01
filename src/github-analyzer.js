const db = require("./db");
const ollama = require("./ollama");
const config = require("./config");

const INTERESTS = (config.interests || []).join("\n- ");
const TAGS = (config.tags || []).join(", ");

async function classifyRepo(repo) {
  const topicsStr = Array.isArray(repo.topics) ? repo.topics : (() => { try { return JSON.parse(repo.topics); } catch { return []; } })();

  const result = await ollama.chat(
    "You classify GitHub repositories. Output ONLY valid JSON, nothing else.",
    `Classify this GitHub repository. Be STRICT.

"relevant" = the repo IS a tool for: AI code verification, specification enforcement, drift detection, knowledge graphs for codebases, formal verification of code, supply chain security tooling. The repo must be a TOOL in these areas, not just an AI agent framework.
"adjacent" = the repo is about: Claude Code/Cursor/Copilot plugins, agent orchestration, MCP servers for coding, developer workflow with AI agents. Must be specifically about coding agents.
"irrelevant" = general AI agent frameworks, chatbots, browser automation, web scrapers, non-coding AI, generic RAG, vector databases, data science tools, anything not specifically about SOFTWARE CODING.

IMPORTANT: A general-purpose agent framework (like LangChain, CrewAI, AutoGen) is IRRELEVANT unless it specifically targets code verification or enforcement. A memory system for generic agents is IRRELEVANT. A web scraper that uses AI is IRRELEVANT. Only repos that a software engineer building code verification tools would USE or COMPETE with are relevant.

Tags from: ${TAGS}
Pick 1-4 tags. Empty array if irrelevant.

Repo: ${repo.full_name}
Description: ${repo.description || "(none)"}
Language: ${repo.language || "unknown"}
Topics: ${topicsStr.join(", ") || "none"}
Stars: ${repo.stars}

JSON: {"relevance":"relevant|adjacent|irrelevant","tags":[]}`,
    { temperature: 0, maxTokens: 100 }
  );

  if (!result) return null;

  try {
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!parsed.relevance) return null;
    const validTags = new Set(config.tags || []);
    parsed.tags = (parsed.tags || []).filter((t) => validTags.has(t));
    return parsed;
  } catch {
    return null;
  }
}

async function processClassifyRepoQueue(limit) {
  const items = db.dequeueBatch("classify_repo", limit || 50);
  if (items.length === 0) return 0;

  let done = 0;
  for (const item of items) {
    const repo = db.getGithubRepo(parseInt(item.target_id, 10));
    if (!repo) { db.completeWork(item.id); continue; }

    if (db.getGithubRepoAnalysis(repo.id)) { db.completeWork(item.id); continue; }

    const result = await classifyRepo(repo);
    if (!result) {
      if (item.attempts >= 2) db.failWorkPermanent(item.id, "classify failed 3 times");
      else db.failWork(item.id, "classify returned null");
      continue;
    }

    db.setGithubRepoAnalysis(repo.id, {
      relevance: result.relevance,
      summary: repo.description || "",
      tags: result.tags,
    });

    db.completeWork(item.id);
    done++;
  }
  return done;
}

module.exports = { processClassifyRepoQueue };
