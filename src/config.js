const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const SECRETS_PATH = path.join(__dirname, "..", "secrets.json");

// Defaults for every field — config.json overrides these
const DEFAULTS = {
  startDate: null,
  hnUsername: null,
  ollama: { url: "http://localhost:11434", model: "qwen3.5:9b" },
  github: { pollMinutes: 60, topics: [], watchRepos: [] },
  reddit: { subreddits: [], pollMinutes: 10 },
  collector: { minPoints: 5, pollSeconds: 60, refreshRecentHours: 48 },
  analyzer: { conversationScoreThreshold: 0.4, maxCommentsPerStory: 15 },
  intelligence: {
    rising: { minGrowth: 20, windowHours: 6 },
    askHnAlert: { minPoints: 10 },
    competitive: { checkGithub: true },
    briefingHoursUTC: [8, 20],
  },
  delivery: "file",
  interests: [],
  tags: [],
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// Load config
let userConfig = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    userConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    console.error("Warning: config.json parse error:", err.message);
  }
}

let config = deepMerge(DEFAULTS, userConfig);

// Merge secrets
if (fs.existsSync(SECRETS_PATH)) {
  try {
    const secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf-8"));
    if (secrets.telegram) {
      config.telegram = { ...(config.telegram || {}), ...secrets.telegram };
    }
    if (secrets.github && secrets.github.token) {
      config.github.token = secrets.github.token;
    }
  } catch (err) {
    console.error("Warning: secrets.json parse error:", err.message);
  }
}

// Validate known keys
const KNOWN_KEYS = new Set([
  "startDate", "hnUsername", "ollama", "github", "reddit", "collector",
  "analyzer", "intelligence", "delivery", "interests", "tags", "telegram", "arxiv",
]);
for (const key of Object.keys(config)) {
  if (!KNOWN_KEYS.has(key)) {
    console.warn(`  Warning: Unknown config key "${key}". Typo?`);
  }
}

// Auto-adjust delivery mode
if (!config.telegram || !config.telegram.botToken) {
  if (config.delivery !== "file") {
    console.warn("  No Telegram token in secrets.json. Using file-only delivery.");
    config.delivery = "file";
  }
}

// Warn about empty interests
if (!config.interests || config.interests.length === 0) {
  console.warn("  No interests configured. All stories will be classified as irrelevant.");
}

module.exports = config;
