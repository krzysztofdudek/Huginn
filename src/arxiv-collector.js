const db = require("./db");
const config = require("./config");
const log = require("./logger");

// Arxiv categories relevant to AI coding
const CATEGORIES = (config.arxiv && config.arxiv.categories) || [
  "cs.SE",  // Software Engineering
  "cs.PL",  // Programming Languages
  "cs.AI",  // Artificial Intelligence
  "cs.CL",  // Computation and Language
];

const SEARCH_TERMS = (config.arxiv && config.arxiv.searchTerms) || [
  "formal verification AND LLM",
  "vericoding OR verified code generation",
  "AI agent reliability AND software",
  "specification driven development AND AI",
  "code review AND large language model",
  "knowledge graph AND source code AND repository",
  "AI coding agent AND verification",
  "Dafny OR Lean4 OR Verus AND LLM",
];

async function arxivFetch(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "HNAssistant/1.0" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    return res.text();
  } catch (err) {
    log.error(`Arxiv fetch: ${err.message}`);
    return null;
  }
}

function parseAtomFeed(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];

    const id = (entry.match(/<id>([^<]*)<\/id>/) || [])[1] || "";
    const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const summary = (entry.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "";
    const published = (entry.match(/<published>([^<]*)<\/published>/) || [])[1] || "";
    const updated = (entry.match(/<updated>([^<]*)<\/updated>/) || [])[1] || "";

    // Authors
    const authors = [];
    const authorRegex = /<author>\s*<name>([^<]*)<\/name>/g;
    let authorMatch;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1].trim());
    }

    // Categories
    const categories = [];
    const catRegex = /<category[^>]*term="([^"]*)"/g;
    let catMatch;
    while ((catMatch = catRegex.exec(entry)) !== null) {
      categories.push(catMatch[1]);
    }

    // PDF link
    const pdfLink = (entry.match(/<link[^>]*title="pdf"[^>]*href="([^"]*)"/) || [])[1] || "";
    const absLink = id; // Arxiv ID is the abstract URL

    // Extract arxiv ID (e.g., 2603.17150)
    const arxivIdMatch = id.match(/abs\/(\d+\.\d+)/);
    const arxivId = arxivIdMatch ? arxivIdMatch[1] : "";

    if (!arxivId || !title) continue;

    entries.push({
      arxivId,
      title: title.replace(/\s+/g, " ").trim(),
      abstract: summary.replace(/\s+/g, " ").trim(),
      authors: authors.slice(0, 5).join(", "),
      categories: categories.join(", "),
      url: absLink,
      pdfUrl: pdfLink,
      published: published ? Math.floor(new Date(published).getTime() / 1000) : 0,
      updated: updated ? Math.floor(new Date(updated).getTime() / 1000) : 0,
    });
  }

  return entries;
}

function hashStringToInt(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 2147483647;
}

async function searchArxiv(query, maxResults) {
  const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${maxResults || 20}&sortBy=submittedDate&sortOrder=descending`;
  const xml = await arxivFetch(url);
  if (!xml) return [];
  return parseAtomFeed(xml);
}

async function collect() {
  const lastCollect = db.getCursorInt("arxiv_last_collect") || 0;
  const interval = (config.arxiv && config.arxiv.pollHours || 24) * 3600;

  if (Math.floor(Date.now() / 1000) - lastCollect < interval) {
    return { papers: 0 };
  }

  let total = 0;

  // Search by terms
  for (const term of SEARCH_TERMS) {
    // Search in title + abstract, restricted to CS categories
    const query = `(ti:${term} OR abs:${term}) AND (cat:cs.SE OR cat:cs.PL OR cat:cs.AI OR cat:cs.CL)`;
    const entries = await searchArxiv(query, 10);

    for (const entry of entries) {
      const numericId = hashStringToInt("arxiv_" + entry.arxivId);
      const existing = db.getStory(numericId);
      if (existing) continue;

      db.upsertStories([{
        id: numericId,
        title: `[arxiv] ${entry.title}`,
        url: entry.url,
        author: entry.authors,
        points: 0,
        num_comments: 0,
        created_at: entry.published || entry.updated,
        story_text: entry.abstract.slice(0, 2000),
        type: "arxiv",
      }]);

      db.enqueue("classify", numericId);
      total++;
    }

    await new Promise((r) => setTimeout(r, 3000)); // Arxiv: be very nice
  }

  db.setCursor("arxiv_last_collect", Math.floor(Date.now() / 1000));
  return { papers: total };
}

module.exports = { collect };
